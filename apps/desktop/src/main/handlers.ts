import { randomUUID } from 'node:crypto';
import type {
  BrowserProfile,
  IpcApi,
  IpcEventName,
  IpcEvents,
  Logger,
  Uuid,
} from '@shadowedge/core';
import { ShadowEdgeError } from '@shadowedge/core';
import { auditFingerprint, generateFingerprint } from '@shadowedge/fingerprint';
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
      return {
        server: `${credential.protocol}://${credential.host}:${credential.port}`,
        username: credential.username,
        password,
      };
    },
  });
  const proxyManager = new ProxyManager();
  const rpaEngine = new RpaEngine();

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
      const profile: BrowserProfile = {
        id,
        orgId: 'local',
        name: input.name,
        platformTag: input.platformTag,
        kernel: 'chromium-patched',
        fingerprint: generateFingerprint({ seed, overrides: input.overrides }),
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
          checkProxy: async (proxyId) => {
            const credential = deps.proxyRepo.get(proxyId);
            if (!credential) throw new ShadowEdgeError('E_PROXY_NOT_FOUND', `代理 ${proxyId} 不存在`);
            return proxyManager.check(credential, deps.proxyRepo.reveal(proxyId));
          },
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

    'fingerprint:preview': async ({ seed, overrides }) => generateFingerprint({ seed, overrides }),

    'fingerprint:audit': async (id) => auditFingerprint(requireProfile(id).fingerprint),

    'proxy:list': async () => deps.proxyRepo.list(),
    'proxy:upsert': async (input) => {
      const saved = await deps.proxyRepo.upsert(input);
      deps.audit.record('proxy:upsert', 'proxy', input.id, { label: input.label });
      return saved;
    },
    'proxy:check': async (id) => {
      const credential = deps.proxyRepo.get(id);
      if (!credential) throw new ShadowEdgeError('E_PROXY_NOT_FOUND', `代理 ${id} 不存在`);
      const health = await proxyManager.check(credential, deps.proxyRepo.reveal(id));
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
