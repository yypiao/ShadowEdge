import type {
  BrowserProfile,
  FingerprintProfile,
  LaunchOptions,
  LaunchResult,
  Platform,
  ProxyCredential,
  ProxyHealth,
  RpaRun,
  RpaWorkflow,
  Uuid,
} from './types.js';

/**
 * 渲染进程 ↔ 主进程 的唯一 IPC 契约。
 * 渲染层不得直接触达文件系统、网络或子进程，全部经由此处的白名单通道。
 */
export interface IpcApi {
  'profile:list': (query?: { groupId?: Uuid; keyword?: string }) => BrowserProfile[];
  'profile:get': (id: Uuid) => BrowserProfile;
  'profile:create': (input: {
    name: string;
    platformTag?: string;
    proxyId?: Uuid;
    /** 画像平台；'host' 跟随宿主机（推荐），缺省由主进程按 'host' 处理。 */
    platform?: Platform | 'host';
    fingerprintSeed?: string;
    overrides?: Partial<FingerprintProfile>;
  }) => BrowserProfile;
  'profile:update': (input: { id: Uuid; patch: Partial<BrowserProfile> }) => BrowserProfile;
  'profile:delete': (id: Uuid) => void;
  'profile:launch': (options: LaunchOptions) => LaunchResult;
  'profile:close': (id: Uuid) => void;

  /** 预览画像；传 proxyId 时时区/语言/地理自动跟随代理出口（T9），显式 overrides 优先。 */
  'fingerprint:preview': (input: { seed: string; proxyId?: Uuid; platform?: Platform | 'host'; overrides?: Partial<FingerprintProfile> }) => FingerprintProfile;
  'fingerprint:audit': (id: Uuid) => { consistent: boolean; issues: string[] };

  'proxy:list': () => ProxyCredential[];
  'proxy:upsert': (input: ProxyCredential & { password?: string }) => ProxyCredential;
  'proxy:check': (id: Uuid) => ProxyHealth;
  'proxy:importBulk': (input: { text: string; format: 'line' | 'csv' }) => ProxyCredential[];

  'rpa:list': () => RpaWorkflow[];
  'rpa:run': (input: { workflowId: Uuid; profileIds: Uuid[]; inputs?: unknown }) => RpaRun[];
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
  'profile:update',
  'profile:delete',
  'profile:launch',
  'profile:close',
  'fingerprint:preview',
  'fingerprint:audit',
  'proxy:list',
  'proxy:upsert',
  'proxy:check',
  'proxy:importBulk',
  'rpa:list',
  'rpa:run',
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
