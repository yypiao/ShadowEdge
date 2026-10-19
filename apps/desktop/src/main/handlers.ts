import { randomUUID } from 'node:crypto';
import type {
  BrowserProfile,
  FingerprintProfile,
  IpcApi,
  IpcEventName,
  IpcEvents,
  Logger,
  ProxyHealth,
  Uuid,
} from '@shadowedge/core';
import { ShadowEdgeError } from '@shadowedge/core';
import { auditFingerprint, deriveGeoOverrides, generateFingerprint } from '@shadowedge/fingerprint';
import { BrowserKernel } from '@shadowedge/kernel';
import { ProxyManager } from '@shadowedge/proxy';
import { RpaEngine } from '@shadowedge/rpa';
import type { ProfileRepository } from './services/profile-repository.js';
import type { ProxyRepository } from './services/proxy-repository.js';
import type { AuditLog, SessionRepository } from './services/local-records.js';
import { runLaunchGate } from './services/launch-gate.js';

export interface HandlerDeps {
  logger: Logger;
  emit: <E extends IpcEventName>(event: E, payload: IpcEvents[E]) => void;
  profileRepo: ProfileRepository;
  proxyRepo: ProxyRepository;
  audit: AuditLog;
  sessions: SessionRepository;
}

/** 主进程 IPC 处理器集合。类型与 IpcApi 严格对齐，新增通道会立即产生编译错误。 */
export type Handlers = {
  [C in keyof IpcApi]: (input: Parameters<IpcApi[C]>[0]) => Promise<Awaited<ReturnType<IpcApi[C]>>>;
};

export function createHandlers(deps: HandlerDeps): Handlers {
  const kernel = new BrowserKernel({
    resolveProxy: async (proxyId) => {
      const credential = deps.proxyRepo.get(proxyId);
      if (!credential) throw new ShadowEdgeError('E_PROXY_NOT_FOUND', `代理 ${proxyId} 不存在`);
      const password = deps.proxyRepo.reveal(proxyId);
      let upstream: { protocol: 'http' | 'socks5'; host: string; port: number; username?: string; password?: string } | undefined;
      if (credential.upstreamId) {
        const upstreamCred = deps.proxyRepo.get(credential.upstreamId);
        if (!upstreamCred) throw new ShadowEdgeError('E_PROXY_NOT_FOUND', `上游代理 ${credential.upstreamId} 不存在`);
        upstream = {
          protocol: upstreamCred.protocol === 'socks5' ? 'socks5' : 'http',
          host: upstreamCred.host,
          port: upstreamCred.port,
          username: upstreamCred.username,
          password: deps.proxyRepo.reveal(upstreamCred.id),
        };
      }
      return {
        protocol: credential.protocol === 'socks5' ? ('socks5' as const) : ('http' as const),
        host: credential.host,
        port: credential.port,
        username: credential.username,
        password,
        upstream,
      };
    },
  });
  const proxyManager = new ProxyManager();
  const rpaEngine = new RpaEngine();

  // 健康检查缓存：住宅/双跳代理探测可达 30s+，建环境与预览不应每次重探
  const HEALTH_CACHE_TTL_MS = 5 * 60 * 1000;
  const healthCache = new Map<Uuid, { health: ProxyHealth; at: number }>();

  const resolveUpstream = (upstreamId: Uuid | undefined) => {
    if (!upstreamId) return undefined;
    const upstreamCred = deps.proxyRepo.get(upstreamId);
    if (!upstreamCred) throw new ShadowEdgeError('E_PROXY_NOT_FOUND', `上游代理 ${upstreamId} 不存在`);
    return {
      protocol: upstreamCred.protocol === 'socks5' ? ('socks5' as const) : ('http' as const),
      host: upstreamCred.host,
      port: upstreamCred.port,
      username: upstreamCred.username,
      password: deps.proxyRepo.reveal(upstreamCred.id),
    };
  };

  const getProxyHealth = async (proxyId: Uuid) => {
    const cached = healthCache.get(proxyId);
    if (cached && Date.now() - cached.at < HEALTH_CACHE_TTL_MS) return cached.health;
    const credential = deps.proxyRepo.get(proxyId);
    if (!credential) throw new ShadowEdgeError('E_PROXY_NOT_FOUND', `代理 ${proxyId} 不存在`);
    const health = await proxyManager.check(credential, deps.proxyRepo.reveal(proxyId), {
      upstream: resolveUpstream(credential.upstreamId),
    });
    healthCache.set(proxyId, { health, at: Date.now() });
    return health;
  };

  /** T9：显式 overrides 优先，缺省时由代理出口地理补齐时区/语言/坐标。 */
  const geoFollowOverrides = async (proxyId: Uuid | undefined, overrides: Partial<FingerprintProfile> | undefined) => {
    if (!proxyId) return overrides;
    const health = await getProxyHealth(proxyId);
    if (!health.geo) return overrides;
    return { ...deriveGeoOverrides(health.geo), ...overrides };
  };

  const requireProfile = (id: Uuid): BrowserProfile => {
    const profile = deps.profileRepo.get(id);
    if (!profile) throw new ShadowEdgeError('E_PROFILE_NOT_FOUND', `环境 ${id} 不存在`);
    return profile;
  };

  return {
    'profile:list': async (query) => {
      return deps.profileRepo.list(query ?? undefined);
    },

    'profile:get': async (id) => requireProfile(id),

    'profile:create': async (input) => {
      const now = new Date().toISOString();
      const id = randomUUID() as Uuid;
      const seed = input.fingerprintSeed ?? randomUUID();
      const overrides = await geoFollowOverrides(input.proxyId, input.overrides);
      const profile: BrowserProfile = {
        id,
        orgId: 'local',
        name: input.name,
        platformTag: input.platformTag,
        kernel: 'chromium-patched',
        // 缺省跟随宿主机平台（紫鸟式同系微调哲学）；显式指定则尊重用户选择
        fingerprint: generateFingerprint({ seed, platform: input.platform ?? 'host', overrides }),
        proxyId: input.proxyId,
        ownerId: 'local-user',
        sharedWith: [],
        storage: { userDataDir: `profiles/${id}`, remoteRevision: 0, syncMode: 'auto' },
        startupUrls: [],
        status: 'idle',
        createdAt: now,
        updatedAt: now,
      };
      deps.profileRepo.save(profile);
      deps.audit.record('profile:create', 'profile', id, { name: input.name });
      deps.logger.info('创建环境', { profileId: id, name: input.name });
      return profile;
    },

    'profile:update': async ({ id, patch }) => {
      const profile = requireProfile(id);
      const updated: BrowserProfile = { ...profile, ...patch, id, updatedAt: new Date().toISOString() };
      deps.profileRepo.save(updated);
      deps.audit.record('profile:update', 'profile', id, { fields: Object.keys(patch) });
      return updated;
    },

    'profile:delete': async (id) => {
      requireProfile(id);
      deps.profileRepo.delete(id);
      deps.audit.record('profile:delete', 'profile', id);
    },

    'profile:launch': async (options) => {
      const profile = requireProfile(options.profileId);
      await runLaunchGate(
        { profile, ignoreProxyCheck: options.ignoreProxyCheck },
        {
          // 走缓存 + 双跳解析（原实现漏了 upstream，双跳代理会被误判不可达）
          checkProxy: getProxyHealth,
        },
      );
      deps.emit('profile:status', { profileId: profile.id, status: 'launching' });
      const result = await kernel.launch(profile, options);
      deps.profileRepo.save({ ...profile, status: 'running', lastUsedAt: result.startedAt });
      deps.sessions.start(result);
      deps.audit.record('profile:launch', 'profile', profile.id, { sessionId: result.sessionId });
      deps.emit('profile:status', { profileId: profile.id, status: 'running' });
      return result;
    },

    'profile:close': async (id) => {
      const profile = requireProfile(id);
      await kernel.close(id);
      deps.profileRepo.save({ ...profile, status: 'idle' });
      deps.sessions.end(id);
      deps.audit.record('profile:close', 'profile', id);
      deps.emit('profile:status', { profileId: id, status: 'idle' });
    },

    'fingerprint:preview': async ({ seed, proxyId, platform, overrides }) =>
      generateFingerprint({ seed, platform: platform ?? 'host', overrides: await geoFollowOverrides(proxyId, overrides) }),

    'fingerprint:audit': async (id) => auditFingerprint(requireProfile(id).fingerprint),

    'proxy:list': async () => deps.proxyRepo.list(),
    'proxy:upsert': async (input) => {
      const saved = await deps.proxyRepo.upsert(input);
      deps.audit.record('proxy:upsert', 'proxy', input.id, { label: input.label });
      return saved;
    },
    'proxy:check': async (id) => {
      // 手动点检查视为强制刷新：清缓存重探
      healthCache.delete(id);
      const health = await getProxyHealth(id);
      deps.emit('proxy:health', health);
      return health;
    },
    'proxy:importBulk': async ({ text, format }) => {
      const parsed = proxyManager.importBulk(text, format);
      const saved: typeof parsed = [];
      for (const item of parsed) saved.push(await deps.proxyRepo.upsert(item));
      deps.audit.record('proxy:importBulk', 'proxy', undefined, { count: saved.length });
      return saved;
    },

    'rpa:list': async () => [],
    'rpa:run': async ({ workflowId, profileIds, inputs }) =>
      rpaEngine.run(
        { id: workflowId, orgId: 'local', name: '', version: 1, graph: {}, createdBy: 'local-user', updatedAt: new Date().toISOString() },
        profileIds,
        inputs,
      ),
    'rpa:cancel': async (runId) => rpaEngine.cancel(runId),

    'sync:push': async (profileId) => {
      const profile = requireProfile(profileId);
      const revision = profile.storage.remoteRevision + 1;
      deps.profileRepo.save({ ...profile, storage: { ...profile.storage, remoteRevision: revision } });
      return { revision };
    },

    'sync:pull': async (profileId) => ({ revision: requireProfile(profileId).storage.remoteRevision, applied: false }),

    'app:info': async () => ({ version: '0.1.0', platform: process.platform }),
  };
}
