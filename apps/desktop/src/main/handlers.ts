import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type {
  BrowserProfile,
  ErrorPayload,
  FingerprintProfile,
  IpcApi,
  IpcEventName,
  IpcEvents,
  Logger,
  ProxyHealth,
  Result,
  Uuid,
} from '@shadowedge/core';
import { err, ok, ShadowEdgeError, toErrorPayload } from '@shadowedge/core';
import {
  auditFingerprint,
  CURRENT_CATALOG_VERSION,
  deriveGeoOverrides,
  generateFingerprint,
} from '@shadowedge/fingerprint';
import { BrowserKernel, ChromiumCdpDriver } from '@shadowedge/kernel';
import { ProxyManager } from '@shadowedge/proxy';
import { RpaEngine, validateGraph } from '@shadowedge/rpa';
import type { ProfileRepository } from './services/profile-repository.js';
import type { ProxyRepository } from './services/proxy-repository.js';
import type { AuditLog, SessionRepository } from './services/local-records.js';
import type { KernelRuntimeService } from './services/kernel-runtime.js';
import type { AccountRepository } from './services/account-repository.js';
import type { RpaRepository } from './services/rpa-repository.js';
import type { StorageStateRepository } from './services/storage-state-repository.js';
import { exportProfileBackup, importProfileBackup } from './services/profile-backup.js';
import { autofillAccount } from './services/account-autofill.js';
import { runLaunchGate } from './services/launch-gate.js';
import type { GroupRepository } from './services/group-repository.js';
import { deleteProfileWithDirectory, managedProfilePath, removeProfileDirectory } from './services/profile-directory.js';
import { normalizeCreateInput, normalizeUpdateInput } from './services/profile-input.js';
import { captureStorageState, openStartupPages, restoreOrCheckpointState, storageStateFailure } from './services/profile-state.js';

export interface HandlerDeps {
  logger: Logger;
  emit: <E extends IpcEventName>(event: E, payload: IpcEvents[E]) => void;
  profileRepo: ProfileRepository;
  groupRepo: GroupRepository;
  proxyRepo: ProxyRepository;
  accountRepo: AccountRepository;
  rpaRepo: RpaRepository;
  storageStateRepo: StorageStateRepository;
  audit: AuditLog;
  sessions: SessionRepository;
  kernelRuntime: KernelRuntimeService;
  /** 测试可注入确定性内核；生产缺省创建真实 Chromium 驱动。 */
  kernel?: BrowserKernel;
  /** 生产环境传 userData/rpa；测试缺省使用仓库已忽略的 data/rpa。 */
  rpaArtifactsDir?: string;
  /** 所有浏览器目录的唯一托管根；生产传 userData/profiles。 */
  profilesDir?: string;
  /** 生产由 Electron shell 打开；测试注入 spy，渲染层不接触本地路径。 */
  openArtifact?: (path: string) => Promise<void>;
  saveProfileBackup?: (fileName: string, contents: string) => Promise<string | undefined>;
  readProfileBackup?: () => Promise<string | undefined>;
}

/** 主进程 IPC 处理器集合。类型与 IpcApi 严格对齐，新增通道会立即产生编译错误。 */
export type Handlers = {
  [C in keyof IpcApi]: (input: Parameters<IpcApi[C]>[0]) => Promise<Awaited<ReturnType<IpcApi[C]>>>;
};

async function settleSequential<Input, Output>(
  items: Input[],
  operation: (item: Input) => Promise<Output>,
): Promise<Array<Result<Output, ErrorPayload>>> {
  const results: Array<Result<Output, ErrorPayload>> = [];
  // 串行执行避免批量启动时瞬时耗尽 16GB 开发机内存；各项独立捕获错误。
  for (const item of items) {
    try {
      results.push(ok(await operation(item)));
    } catch (error) {
      results.push(err(toErrorPayload(error)));
    }
  }
  return results;
}

export function createDesktopKernel(deps: HandlerDeps): BrowserKernel {
  return new BrowserKernel({
    drivers: [new ChromiumCdpDriver(deps.kernelRuntime.driverOptions())],
    onExit: (profileId) => {
      const profile = deps.profileRepo.get(profileId);
      if (!profile) return;
      deps.profileRepo.save({ ...profile, status: 'idle' });
      deps.sessions.end(profileId);
      deps.audit.record('profile:exit', 'profile', profileId);
      deps.emit('profile:status', { profileId, status: 'idle' });
    },
    resolveProxy: async (proxyId) => {
      const credential = deps.proxyRepo.get(proxyId);
      if (!credential) throw new ShadowEdgeError('E_PROXY_NOT_FOUND', `代理 ${proxyId} 不存在`);
      const password = deps.proxyRepo.reveal(proxyId);
      let upstream:
        | {
            protocol: 'http' | 'socks5';
            host: string;
            port: number;
            username?: string;
            password?: string;
          }
        | undefined;
      if (credential.upstreamId) {
        const upstreamCred = deps.proxyRepo.get(credential.upstreamId);
        if (!upstreamCred)
          throw new ShadowEdgeError(
            'E_PROXY_NOT_FOUND',
            `上游代理 ${credential.upstreamId} 不存在`,
          );
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
}

export function createHandlers(deps: HandlerDeps): Handlers {
  const kernel = deps.kernel ?? createDesktopKernel(deps);
  const proxyManager = new ProxyManager();
  const profilesDir = resolve(deps.profilesDir ?? join(process.cwd(), 'data', 'profiles'));
  const artifactsRoot = resolve(deps.rpaArtifactsDir ?? join(process.cwd(), 'data', 'rpa'));
  const rpaEngine = new RpaEngine({
    resolveContext: (profileId) => kernel.getAutomationContext(profileId),
    artifactsDir: artifactsRoot,
    emit: (progress) => deps.emit('rpa:progress', progress),
    onRunUpdate: (run) => deps.rpaRepo.saveRun(run),
  });

  // 健康检查缓存：住宅/双跳代理探测可达 30s+，建环境与预览不应每次重探
  const HEALTH_CACHE_TTL_MS = 5 * 60 * 1000;
  const healthCache = new Map<Uuid, { health: ProxyHealth; at: number }>();

  const resolveUpstream = (upstreamId: Uuid | undefined) => {
    if (!upstreamId) return undefined;
    const upstreamCred = deps.proxyRepo.get(upstreamId);
    if (!upstreamCred)
      throw new ShadowEdgeError('E_PROXY_NOT_FOUND', `上游代理 ${upstreamId} 不存在`);
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
  const geoFollowOverrides = async (
    proxyId: Uuid | undefined,
    overrides: Partial<FingerprintProfile> | undefined,
  ) => {
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

  const requireProfileProxy = (id: Uuid): void => {
    if (!deps.proxyRepo.get(id)) throw new ShadowEdgeError('E_PROXY_NOT_FOUND', `代理 ${id} 不存在`);
  };

  const requireGroup = (id: Uuid | undefined): void => {
    if (id && !deps.groupRepo.get(id)) {
      throw new ShadowEdgeError('E_PROFILE_GROUP_NOT_FOUND', `环境分组 ${id} 不存在`);
    }
  };

  const backupDeps = () => ({
    profileRepo: deps.profileRepo,
    proxyRepo: deps.proxyRepo,
    storageStateRepo: deps.storageStateRepo,
    kernel,
    profilesDir,
  });

  const handlers: Handlers = {
    'profile:list': async (query) => {
      return deps.profileRepo.list(query ?? undefined);
    },

    'profile:get': async (id) => requireProfile(id),

    'profileGroup:list': async () => deps.groupRepo.list(),

    'profileGroup:save': async (input) => {
      const id = input.id ?? randomUUID() as Uuid;
      const group = deps.groupRepo.save(input, id);
      deps.audit.record('profile-group:save', 'profile-group', id, { name: group.name });
      return group;
    },

    'profileGroup:delete': async (id) => {
      if (!deps.groupRepo.get(id)) {
        throw new ShadowEdgeError('E_PROFILE_GROUP_NOT_FOUND', `环境分组 ${id} 不存在`);
      }
      deps.profileRepo.transaction(() => {
        deps.profileRepo.clearGroup(id);
        deps.groupRepo.delete(id);
      });
      deps.audit.record('profile-group:delete', 'profile-group', id);
    },

    'profile:create': async (rawInput) => {
      const input = normalizeCreateInput(rawInput);
      requireGroup(input.groupId);
      const now = new Date().toISOString();
      const id = randomUUID() as Uuid;
      const seed = input.fingerprintSeed ?? randomUUID();
      const overrides = await geoFollowOverrides(input.proxyId, input.overrides);
      const profile: BrowserProfile = {
        id,
        orgId: 'local',
        name: input.name,
        platformTag: input.platformTag,
        groupId: input.groupId,
        kernel: 'chromium-patched',
        // 缺省跟随宿主机平台（紫鸟式同系微调哲学）；显式指定则尊重用户选择
        fingerprint: generateFingerprint({
          seed,
          platform: input.platform ?? 'host',
          overrides,
          catalogVersion: CURRENT_CATALOG_VERSION,
        }),
        proxyId: input.proxyId,
        ownerId: 'local-user',
        sharedWith: [],
        storage: { userDataDir: managedProfilePath(profilesDir, id), remoteRevision: 0, syncMode: 'auto' },
        startupUrls: input.startupUrls ?? [],
        notes: input.notes,
        status: 'idle',
        createdAt: now,
        updatedAt: now,
      };
      deps.profileRepo.save(profile);
      deps.audit.record('profile:create', 'profile', id, { name: input.name });
      deps.logger.info('创建环境', { profileId: id, name: input.name });
      return profile;
    },

    'profile:createMany': async ({ items }) =>
      settleSequential(items, (item) => handlers['profile:create'](item)),

    'profile:update': async ({ id, patch }) => {
      const profile = requireProfile(id);
      const normalized = normalizeUpdateInput(patch);
      requireGroup(normalized.groupId);
      if (normalized.proxyId) requireProfileProxy(normalized.proxyId);
      const updated: BrowserProfile = {
        ...profile,
        ...normalized,
        id,
        updatedAt: new Date().toISOString(),
      };
      deps.profileRepo.save(updated);
      deps.audit.record('profile:update', 'profile', id, { fields: Object.keys(normalized) });
      return updated;
    },

    'profile:delete': async (id) => {
      const profile = requireProfile(id);
      if (kernel.isActive(id)) {
        throw new ShadowEdgeError('E_PROFILE_BUSY', '环境仍在运行或启动中，请先停止后再删除');
      }
      deleteProfileWithDirectory(deps.profileRepo, profilesDir, profile);
      deps.audit.record('profile:delete', 'profile', id);
    },

    'profile:launch': async (options) => {
      const profile = requireProfile(options.profileId);
      if (kernel.isActive(profile.id)) {
        throw new ShadowEdgeError('E_PROFILE_BUSY', `环境 ${profile.id} 已在运行或启动中`);
      }
      await runLaunchGate(
        { profile, ignoreProxyCheck: options.ignoreProxyCheck },
        {
          // 走缓存 + 双跳解析（原实现漏了 upstream，双跳代理会被误判不可达）
          checkProxy: getProxyHealth,
        },
      );
      deps.profileRepo.save({ ...profile, status: 'launching' });
      deps.emit('profile:status', { profileId: profile.id, status: 'launching' });
      const hadExistingDirectory = existsSync(managedProfilePath(profilesDir, profile.id));
      try {
        const result = await kernel.launch(profile, options);
        // 同步检查避免在 await 间隙浏览器退出后，又被这里写回 running。
        if (!kernel.isActive(profile.id)) {
          throw new ShadowEdgeError('E_KERNEL_LAUNCH_FAILED', '浏览器在启动完成后立即退出', {
            retryable: true,
          });
        }
        if (kernel.supportsAutomationContext(profile.id)) {
          try {
            const pendingState = deps.storageStateRepo.reveal(profile.id);
            await restoreOrCheckpointState(
              kernel,
              profile.id,
              hadExistingDirectory,
              pendingState,
              (state) => deps.storageStateRepo.save(profile.id, state),
            );
            const startupFailures = await openStartupPages(
              kernel.getAutomationContext(profile.id),
              profile.startupUrls,
            );
            for (const failure of startupFailures) {
              deps.audit.record('profile:startup-url-failed', 'profile', profile.id, {
                url: failure.url,
              });
            }
            if (startupFailures.length > 0) {
              deps.emit('app:toast', {
                level: 'warn',
                message: `${startupFailures.length} 个启动页面未能加载，环境仍保持运行`,
              });
            }
          } catch (error) {
            await kernel.close(profile.id).catch(() => undefined);
            throw new ShadowEdgeError('E_KERNEL_LAUNCH_FAILED', '浏览器状态恢复或启动页面初始化失败，请重试', {
              retryable: true,
              cause: error,
            });
          }
        }
        deps.profileRepo.save({ ...profile, status: 'running', lastUsedAt: result.startedAt });
        deps.sessions.start(result);
        deps.audit.record('profile:launch', 'profile', profile.id, { sessionId: result.sessionId });
        deps.emit('profile:status', { profileId: profile.id, status: 'running' });
        return result;
      } catch (error) {
        // 并发请求失败不能把另一个已成功/正在启动的会话误标为 idle。
        if (!kernel.isActive(profile.id)) {
          deps.profileRepo.save({ ...profile, status: 'idle' });
          deps.emit('profile:status', { profileId: profile.id, status: 'idle' });
        }
        deps.audit.record('profile:launch-failed', 'profile', profile.id);
        throw error;
      }
    },

    'profile:launchMany': async ({ items }) =>
      settleSequential(items, (item) => handlers['profile:launch'](item)),

    'profile:close': async (id) => {
      const profile = requireProfile(id);
      try {
        let captured: Awaited<ReturnType<typeof captureStorageState>> | undefined;
        await kernel.close(id, {
          beforeClose: async (context) => {
            try {
              captured = await captureStorageState(context);
            } catch (error) {
              throw storageStateFailure('浏览器状态捕获失败，已保留原数据目录', error);
            }
          },
        });
        if (captured) {
          try {
            deps.storageStateRepo.save(id, captured);
            removeProfileDirectory(profilesDir, profile);
          } catch (error) {
            throw storageStateFailure('加密快照保存或原目录清理失败，请检查磁盘后重试', error);
          }
        }
      } finally {
        deps.profileRepo.save({ ...profile, status: 'idle' });
        deps.sessions.end(id);
        deps.audit.record('profile:close', 'profile', id);
        deps.emit('profile:status', { profileId: id, status: 'idle' });
      }
    },

    'profile:closeMany': async ({ profileIds }) =>
      settleSequential(profileIds, async (profileId) => {
        await handlers['profile:close'](profileId);
        return { profileId };
      }),

    'profile:export': async ({ profileId, passphrase }) => {
      const profile = requireProfile(profileId);
      const backup = await exportProfileBackup(
        backupDeps(),
        profileId,
        passphrase,
      );
      if (!deps.saveProfileBackup) {
        throw new ShadowEdgeError('E_INTERNAL', '当前环境不支持保存备份文件');
      }
      const safeName = profile.name.replace(/[\\/:*?"<>|]/g, '_');
      const path = await deps.saveProfileBackup(`${safeName}.sebackup`, backup.contents);
      deps.audit.record('profile:export', 'profile', profileId, {
        saved: path !== undefined,
        cookieCount: backup.cookieCount,
        originCount: backup.originCount,
        indexedDbCount: backup.indexedDbCount,
      });
      return {
        saved: path !== undefined,
        path,
        cookieCount: backup.cookieCount,
        originCount: backup.originCount,
        indexedDbCount: backup.indexedDbCount,
      };
    },

    'profile:import': async ({ passphrase, name, contents }) => {
      const source = contents ?? await deps.readProfileBackup?.();
      if (source === undefined) return { imported: false, cookieCount: 0, originCount: 0, indexedDbCount: 0 };
      const imported = importProfileBackup(
        backupDeps(),
        { contents: source, passphrase, name },
      );
      deps.audit.record('profile:import', 'profile', imported.profile.id, {
        cookieCount: imported.cookieCount,
        originCount: imported.originCount,
        indexedDbCount: imported.indexedDbCount,
      });
      return { imported: true, ...imported };
    },

    'fingerprint:preview': async ({ seed, proxyId, platform, overrides }) =>
      generateFingerprint({
        seed,
        platform: platform ?? 'host',
        overrides: await geoFollowOverrides(proxyId, overrides),
        catalogVersion: CURRENT_CATALOG_VERSION,
      }),

    'fingerprint:audit': async (id) => auditFingerprint(requireProfile(id).fingerprint),

    'kernel:getStatus': async () => deps.kernelRuntime.getStatus(),
    'kernel:configure': async (input) => {
      const status = deps.kernelRuntime.configure(input);
      deps.audit.record('kernel:configure', 'kernel', undefined, {
        source: status.source,
        available: status.available,
        fallbackPolicy: status.fallbackPolicy,
      });
      return status;
    },

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

    'account:list': async (profileId) => {
      requireProfile(profileId);
      return deps.accountRepo.list(profileId);
    },
    'account:upsert': async (input) => {
      requireProfile(input.profileId);
      const saved = deps.accountRepo.upsert(input);
      deps.audit.record('account:upsert', 'account', saved.id, {
        profileId: saved.profileId,
        origin: saved.origin,
      });
      return saved;
    },
    'account:delete': async (id) => {
      deps.accountRepo.delete(id);
      deps.audit.record('account:delete', 'account', id);
    },
    'account:autofill': async (input) => {
      const result = await autofillAccount({ accountRepo: deps.accountRepo, kernel }, input);
      deps.audit.record('account:autofill', 'account', result.credentialId, {
        profileId: result.profileId,
        origin: result.origin,
        submitted: result.submitted,
      });
      return result;
    },

    'rpa:list': async () => deps.rpaRepo.listWorkflows(),
    'rpa:save': async (input) => {
      if (!input.name.trim()) {
        throw new ShadowEdgeError('E_RPA_INVALID_INPUT', '工作流名称不能为空');
      }
      const validation = validateGraph(input.graph);
      if (!validation.valid) {
        throw new ShadowEdgeError('E_RPA_INVALID_GRAPH', 'RPA 工作流图无效', {
          details: { errors: validation.errors },
        });
      }
      const existing = input.id ? deps.rpaRepo.getWorkflow(input.id) : undefined;
      const workflow = {
        id: input.id ?? randomUUID() as Uuid,
        orgId: existing?.orgId ?? 'local',
        name: input.name.trim(),
        version: existing ? existing.version + 1 : 1,
        graph: input.graph,
        inputsSchema: input.inputsSchema,
        createdBy: existing?.createdBy ?? 'local-user',
        updatedAt: new Date().toISOString(),
      };
      deps.rpaRepo.saveWorkflow(workflow);
      deps.audit.record('rpa:save', 'rpa', workflow.id, { version: workflow.version });
      return workflow;
    },
    'rpa:delete': async (id) => {
      if (!deps.rpaRepo.getWorkflow(id)) {
        throw new ShadowEdgeError('E_RPA_WORKFLOW_NOT_FOUND', `RPA 工作流 ${id} 不存在`);
      }
      deps.rpaRepo.deleteWorkflow(id);
      deps.audit.record('rpa:delete', 'rpa', id);
    },
    'rpa:run': async ({ workflow, profileIds, inputs }) => {
      const runs = await rpaEngine.run(workflow, profileIds, inputs);
      for (const run of runs) {
        deps.audit.record('rpa:run', 'rpa', run.id, {
          workflowId: workflow.id,
          profileId: run.profileId,
        });
      }
      return runs;
    },
    'rpa:get': async (runId) => {
      const run = rpaEngine.getRun(runId) ?? deps.rpaRepo.getRun(runId);
      if (!run) throw new ShadowEdgeError('E_RPA_RUN_NOT_FOUND', `RPA 运行 ${runId} 不存在`);
      return run;
    },
    'rpa:listRuns': async (input) => {
      const limit = Math.max(1, Math.min(input?.limit ?? 100, 200));
      return deps.rpaRepo.listRuns(limit);
    },
    'rpa:cancel': async (runId) => rpaEngine.cancel(runId),
    'rpa:openArtifact': async ({ runId, uri }) => {
      const run = rpaEngine.getRun(runId) ?? deps.rpaRepo.getRun(runId);
      if (!run) throw new ShadowEdgeError('E_RPA_RUN_NOT_FOUND', `RPA 运行 ${runId} 不存在`);
      const path = resolve(uri);
      const runRoot = resolve(artifactsRoot, runId);
      const belongsToRun = run.artifacts.some((artifact) => resolve(artifact.uri) === path);
      if (!belongsToRun || !path.startsWith(runRoot + sep)) {
        throw new ShadowEdgeError('E_PERMISSION_DENIED', '产物路径不属于本次 RPA 运行');
      }
      if (!deps.openArtifact) {
        throw new ShadowEdgeError('E_INTERNAL', '当前环境不支持打开本地产物');
      }
      await deps.openArtifact(path);
    },

    'sync:push': async (profileId) => {
      const profile = requireProfile(profileId);
      const revision = profile.storage.remoteRevision + 1;
      deps.profileRepo.save({
        ...profile,
        storage: { ...profile.storage, remoteRevision: revision },
      });
      return { revision };
    },

    'sync:pull': async (profileId) => ({
      revision: requireProfile(profileId).storage.remoteRevision,
      applied: false,
    }),

    'app:info': async () => ({ version: '0.1.0', platform: process.platform }),
  };
  return handlers;
}
