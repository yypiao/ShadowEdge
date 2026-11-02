import type {
  AccountAutofillResult,
  AccountCredential,
  AccountCredentialInput,
  BrowserProfile,
  FingerprintProfile,
  KernelRuntimeConfig,
  KernelRuntimeStatus,
  LaunchOptions,
  LaunchResult,
  ProfileCreateInput,
  Platform,
  ProxyCredential,
  ProxyHealth,
  RpaRun,
  RpaWorkflow,
  Uuid,
} from './types.js';
import type { ErrorPayload } from './errors.js';
import type { Result } from './result.js';

/**
 * 渲染进程 ↔ 主进程 的唯一 IPC 契约。
 * 渲染层不得直接触达文件系统、网络或子进程，全部经由此处的白名单通道。
 */
export interface IpcApi {
  'profile:list': (query?: { groupId?: Uuid; keyword?: string }) => BrowserProfile[];
  'profile:get': (id: Uuid) => BrowserProfile;
  'profile:create': (input: ProfileCreateInput) => BrowserProfile;
  /** 批量操作按输入顺序返回独立结果，单个失败不中断整批。 */
  'profile:createMany': (input: {
    items: ProfileCreateInput[];
  }) => Array<Result<BrowserProfile, ErrorPayload>>;
  'profile:update': (input: { id: Uuid; patch: Partial<BrowserProfile> }) => BrowserProfile;
  'profile:delete': (id: Uuid) => void;
  'profile:launch': (options: LaunchOptions) => LaunchResult;
  'profile:launchMany': (input: {
    items: LaunchOptions[];
  }) => Array<Result<LaunchResult, ErrorPayload>>;
  'profile:close': (id: Uuid) => void;
  'profile:closeMany': (input: {
    profileIds: Uuid[];
  }) => Array<Result<{ profileId: Uuid }, ErrorPayload>>;

  /** 预览画像；传 proxyId 时时区/语言/地理自动跟随代理出口（T9），显式 overrides 优先。 */
  'fingerprint:preview': (input: {
    seed: string;
    proxyId?: Uuid;
    platform?: Platform | 'host';
    overrides?: Partial<FingerprintProfile>;
  }) => FingerprintProfile;
  'fingerprint:audit': (id: Uuid) => { consistent: boolean; issues: string[] };

  'kernel:getStatus': () => KernelRuntimeStatus;
  'kernel:configure': (input: KernelRuntimeConfig) => KernelRuntimeStatus;

  'proxy:list': () => ProxyCredential[];
  'proxy:upsert': (input: ProxyCredential & { password?: string }) => ProxyCredential;
  'proxy:check': (id: Uuid) => ProxyHealth;
  'proxy:importBulk': (input: { text: string; format: 'line' | 'csv' }) => ProxyCredential[];

  'account:list': (profileId: Uuid) => AccountCredential[];
  'account:upsert': (input: AccountCredentialInput) => AccountCredential;
  'account:delete': (id: Uuid) => void;
  /** 仅主进程短暂解密并填充；返回值不包含用户名或密码。 */
  'account:autofill': (input: { id: Uuid; submit?: boolean }) => AccountAutofillResult;

  'rpa:list': () => RpaWorkflow[];
  'rpa:run': (input: { workflow: RpaWorkflow; profileIds: Uuid[]; inputs?: unknown }) => RpaRun[];
  'rpa:get': (runId: Uuid) => RpaRun;
  'rpa:cancel': (runId: Uuid) => void;

  'sync:push': (profileId: Uuid) => { revision: number };
  'sync:pull': (profileId: Uuid) => { revision: number; applied: boolean };

  'app:info': () => { version: string; kernelVersion?: string; platform: string };
}

export type IpcChannel = keyof IpcApi;
export type IpcRequest<C extends IpcChannel> = Parameters<IpcApi[C]>[0];
export type IpcResponse<C extends IpcChannel> = ReturnType<IpcApi[C]>;

/** 主进程 → 渲染进程 的单向事件推送。 */
export interface IpcEvents {
  'profile:status': { profileId: Uuid; status: BrowserProfile['status']; detail?: string };
  'proxy:health': ProxyHealth;
  'rpa:progress': { runId: Uuid; step: string; percent: number };
  'sync:progress': { profileId: Uuid; percent: number };
  'app:toast': { level: 'info' | 'warn' | 'error'; message: string };
}

export type IpcEventName = keyof IpcEvents;

export const IPC_CHANNELS: IpcChannel[] = [
  'profile:list',
  'profile:get',
  'profile:create',
  'profile:createMany',
  'profile:update',
  'profile:delete',
  'profile:launch',
  'profile:launchMany',
  'profile:close',
  'profile:closeMany',
  'fingerprint:preview',
  'fingerprint:audit',
  'kernel:getStatus',
  'kernel:configure',
  'proxy:list',
  'proxy:upsert',
  'proxy:check',
  'proxy:importBulk',
  'account:list',
  'account:upsert',
  'account:delete',
  'account:autofill',
  'rpa:list',
  'rpa:run',
  'rpa:get',
  'rpa:cancel',
  'sync:push',
  'sync:pull',
  'app:info',
];

export const IPC_EVENTS: IpcEventName[] = [
  'profile:status',
  'proxy:health',
  'rpa:progress',
  'sync:progress',
  'app:toast',
];
