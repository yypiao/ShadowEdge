import type {
  AccountAutofillResult,
  AccountCredential,
  AccountCredentialInput,
  BrowserProfile,
  FingerprintProfile,
  KernelDistributionStatus,
  KernelPackageInstallResult,
  KernelRuntimeConfig,
  KernelRuntimeStatus,
  LaunchOptions,
  LaunchResult,
  ProfileCreateInput,
  ProfileUpdateInput,
  ProfileGroupInput,
  ProfileGroup,
  ProfileBackupExportResult,
  ProfileBackupImportResult,
  Platform,
  PlatformPolicy,
  ProfileSiteSwitchResult,
  ProxyCredential,
  ProxyHealth,
  RpaRun,
  RpaSchedule,
  RpaScheduleInput,
  RpaRecordingResult,
  RpaRecordingState,
  RpaWorkflow,
  RpaWorkflowInput,
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
  'profileGroup:list': () => ProfileGroup[];
  'profileGroup:save': (input: ProfileGroupInput) => ProfileGroup;
  'profileGroup:delete': (id: Uuid) => void;
  /** 批量操作按输入顺序返回独立结果，单个失败不中断整批。 */
  'profile:createMany': (input: {
    items: ProfileCreateInput[];
  }) => Array<Result<BrowserProfile, ErrorPayload>>;
  'profile:update': (input: { id: Uuid; patch: ProfileUpdateInput }) => BrowserProfile;
  'profile:prepareKernelUpgrade': (input: { profileId: Uuid; targetVersion: string }) => BrowserProfile;
  'profile:commitKernelUpgrade': (input: { profileId: Uuid; upgradeProfileId: Uuid; confirmed: boolean }) => BrowserProfile;
  'profile:delete': (id: Uuid) => void;
  'platformPolicy:list': () => PlatformPolicy[];
  'profile:switchSite': (input: { profileId: Uuid; siteId: string }) => ProfileSiteSwitchResult;
  'profile:launch': (options: LaunchOptions) => LaunchResult;
  'profile:launchMany': (input: {
    items: LaunchOptions[];
  }) => Array<Result<LaunchResult, ErrorPayload>>;
  'profile:close': (id: Uuid) => void;
  'profile:closeMany': (input: {
    profileIds: Uuid[];
  }) => Array<Result<{ profileId: Uuid }, ErrorPayload>>;
  'profile:export': (input: {
    profileId: Uuid;
    passphrase: string;
  }) => ProfileBackupExportResult;
  'profile:import': (input: {
    passphrase: string;
    name?: string;
    /** 测试/ SDK 可传密文；桌面缺省经主进程原生文件选择器读取。 */
    contents?: string;
  }) => ProfileBackupImportResult;

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
  'kernelDistribution:status': () => KernelDistributionStatus;
  'kernelDistribution:install': () => KernelPackageInstallResult;
  'kernelDistribution:activate': (input: { version: string }) => KernelDistributionStatus;

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
  'rpa:save': (input: RpaWorkflowInput) => RpaWorkflow;
  'rpa:delete': (id: Uuid) => void;
  'rpa:run': (input: { workflow: RpaWorkflow; profileIds: Uuid[]; inputs?: unknown }) => RpaRun[];
  'rpa:startRecording': (input: { profileId: Uuid; startUrl: string }) => RpaRecordingState;
  'rpa:stopRecording': (profileId: Uuid) => RpaRecordingResult;
  'rpa:setSchedule': (input: RpaScheduleInput) => RpaSchedule;
  'rpa:listSchedules': () => RpaSchedule[];
  'rpa:get': (runId: Uuid) => RpaRun;
  'rpa:listRuns': (input?: { limit?: number }) => RpaRun[];
  'rpa:cancel': (runId: Uuid) => void;
  'rpa:openArtifact': (input: { runId: Uuid; uri: string }) => void;

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
  'profileGroup:list',
  'profileGroup:save',
  'profileGroup:delete',
  'profile:createMany',
  'profile:update',
  'profile:prepareKernelUpgrade',
  'profile:commitKernelUpgrade',
  'profile:delete',
  'platformPolicy:list',
  'profile:switchSite',
  'profile:launch',
  'profile:launchMany',
  'profile:close',
  'profile:closeMany',
  'profile:export',
  'profile:import',
  'fingerprint:preview',
  'fingerprint:audit',
  'kernel:getStatus',
  'kernel:configure',
  'kernelDistribution:status',
  'kernelDistribution:install',
  'kernelDistribution:activate',
  'proxy:list',
  'proxy:upsert',
  'proxy:check',
  'proxy:importBulk',
  'account:list',
  'account:upsert',
  'account:delete',
  'account:autofill',
  'rpa:list',
  'rpa:save',
  'rpa:delete',
  'rpa:run',
  'rpa:startRecording',
  'rpa:stopRecording',
  'rpa:setSchedule',
  'rpa:listSchedules',
  'rpa:get',
  'rpa:listRuns',
  'rpa:cancel',
  'rpa:openArtifact',
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
