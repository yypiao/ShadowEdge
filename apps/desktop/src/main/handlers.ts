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

export interface HandlerDeps {
  logger: Logger;
  emit: <E extends IpcEventName>(event: E, payload: IpcEvents[E]) => void;
}

/** 主进程 IPC 处理器集合。类型与 IpcApi 严格对齐，新增通道会立即产生编译错误。 */
export type Handlers = {
  [C in keyof IpcApi]: (input: Parameters<IpcApi[C]>[0]) => Promise<Awaited<ReturnType<IpcApi[C]>>>;
};

export function createHandlers(deps: HandlerDeps): Handlers {
  const kernel = new BrowserKernel();
  const proxyManager = new ProxyManager();
  const rpaEngine = new RpaEngine();
  // TODO(step-2): 换成 better-sqlite3 持久层，见 packages/core 的存储契约。
  const profiles = new Map<Uuid, BrowserProfile>();

  const requireProfile = (id: Uuid): BrowserProfile => {
    const profile = profiles.get(id);
    if (!profile) throw new ShadowEdgeError('E_PROFILE_NOT_FOUND', `环境 ${id} 不存在`);
    return profile;
  };

  return {
    'profile:list': async (query) => {
      const all = Array.from(profiles.values());
      if (!query) return all;
      return all.filter(
        (p) =>
          (!query.groupId || p.groupId === query.groupId) &&
          (!query.keyword || p.name.toLowerCase().includes(query.keyword.toLowerCase())),
      );
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
      profiles.set(id, profile);
      deps.logger.info('创建环境', { profileId: id, name: input.name });
      return profile;
    },

    'profile:update': async ({ id, patch }) => {
      const profile = requireProfile(id);
      const updated: BrowserProfile = { ...profile, ...patch, id, updatedAt: new Date().toISOString() };
      profiles.set(id, updated);
      return updated;
    },

    'profile:delete': async (id) => {
      requireProfile(id);
      profiles.delete(id);
    },

    'profile:launch': async (options) => {
      const profile = requireProfile(options.profileId);
      deps.emit('profile:status', { profileId: profile.id, status: 'launching' });
      const result = await kernel.launch(profile, options);
      profiles.set(profile.id, { ...profile, status: 'running', lastUsedAt: result.startedAt });
      deps.emit('profile:status', { profileId: profile.id, status: 'running' });
      return result;
    },

    'profile:close': async (id) => {
      const profile = requireProfile(id);
      await kernel.close(id);
      profiles.set(id, { ...profile, status: 'idle' });
      deps.emit('profile:status', { profileId: id, status: 'idle' });
    },

    'fingerprint:preview': async ({ seed, overrides }) => generateFingerprint({ seed, overrides }),

    'fingerprint:audit': async (id) => auditFingerprint(requireProfile(id).fingerprint),

    'proxy:list': async () => proxyManager.list(),
    'proxy:upsert': async (input) => proxyManager.upsert(input),
    'proxy:check': async (id) => {
      const health = await proxyManager.check(id);
      deps.emit('proxy:health', health);
      return health;
    },
    'proxy:importBulk': async ({ text, format }) => proxyManager.importBulk(text, format),

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
      profiles.set(profileId, { ...profile, storage: { ...profile.storage, remoteRevision: revision } });
      return { revision };
    },

    'sync:pull': async (profileId) => ({ revision: requireProfile(profileId).storage.remoteRevision, applied: false }),

    'app:info': async () => ({ version: '0.1.0', platform: process.platform }),
  };
}
