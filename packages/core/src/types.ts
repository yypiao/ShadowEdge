/** ShadowEdge 核心领域契约。所有跨包数据结构以此为唯一事实来源。 */

export type Uuid = string;
export type IsoDateTime = string;

/** 平台支持的桌面运行环境。 */
export type Platform = 'windows' | 'macos' | 'linux';

/** 浏览器内核类型。Chromium 为自研补丁内核，其余为兼容驱动。 */
export type KernelType = 'chromium-patched' | 'chromium-cdp' | 'firefox-gecko';

// ---------------------------------------------------------------------------
// 组织 / 权限
// ---------------------------------------------------------------------------

export type Role = 'owner' | 'admin' | 'leader' | 'operator' | 'auditor';

/** 细粒度权限点。RBAC 之上叠加资源级 ACL。 */
export type Permission =
  | 'profile:read'
  | 'profile:write'
  | 'profile:launch'
  | 'profile:transfer'
  | 'profile:export-cookie'
  | 'proxy:read'
  | 'proxy:write'
  | 'rpa:read'
  | 'rpa:run'
  | 'rpa:publish'
  | 'member:manage'
  | 'audit:read'
  | 'billing:manage';

export interface Organization {
  id: Uuid;
  name: string;
  /** 组织级主密钥的 KMS 引用，明文永不落库。 */
  masterKeyRef: string;
  createdAt: IsoDateTime;
}

export interface Member {
  id: Uuid;
  orgId: Uuid;
  email: string;
  displayName: string;
  role: Role;
  /** 显式授予或撤销的权限，覆盖角色默认值。 */
  permissionOverrides?: Partial<Record<Permission, boolean>>;
  teamIds: Uuid[];
  status: 'active' | 'suspended' | 'invited';
  createdAt: IsoDateTime;
}

// ---------------------------------------------------------------------------
// 指纹画像
// ---------------------------------------------------------------------------

export type NoiseMode = 'off' | 'noise' | 'block' | 'real';

export interface FingerprintProfile {
  /** 生成此画像的不可变 UA/UA-CH 素材快照版本，审计必须加载同一版本。 */
  catalogVersion: string;
  /** 画像种子。相同种子必须产出完全一致的指纹，保证环境可复现。 */
  seed: string;
  platform: Platform;
  userAgent: string;
  /** 与 UA 严格一致的 Client Hints，避免高低熵字段互相打脸。 */
  userAgentData: {
    brands: Array<{ brand: string; version: string }>;
    platform: string;
    platformVersion: string;
    architecture: string;
    bitness: string;
    model: string;
    fullVersion: string;
    mobile: boolean;
  };
  screen: {
    width: number;
    height: number;
    availWidth: number;
    availHeight: number;
    colorDepth: number;
    pixelRatio: number;
  };
  viewport: { width: number; height: number };
  languages: string[];
  timezone: string;
  /** 由代理出口 IP 推导，与 timezone/languages 必须自洽。 */
  geolocation?: { latitude: number; longitude: number; accuracy: number };
  hardware: {
    deviceMemoryGb: number;
    hardwareConcurrency: number;
    maxTouchPoints: number;
  };
  webgl: {
    vendor: string;
    renderer: string;
    /** GPU 参数噪声强度，0 表示直通真实值。 */
    noise: NoiseMode;
  };
  canvas: NoiseMode;
  audio: NoiseMode;
  clientRects: NoiseMode;
  fonts: { mode: 'whitelist' | 'real'; families: string[] };
  webrtc: { mode: 'replace' | 'disable' | 'real'; publicIp?: string };
  media: { audioInputs: number; videoInputs: number; audioOutputs: number };
  battery?: { charging: boolean; level: number };
  /** 需要屏蔽的浏览器特性，用于降低自动化痕迹。 */
  disabledFeatures: string[];
}

// ---------------------------------------------------------------------------
// 代理
// ---------------------------------------------------------------------------

export type ProxyProtocol = 'http' | 'https' | 'socks5' | 'ssh' | 'wireguard';

export interface ProxyCredential {
  id: Uuid;
  orgId: Uuid;
  label: string;
  protocol: ProxyProtocol;
  host: string;
  port: number;
  username?: string;
  /** 加密后的密码引用，明文只在内核进程内解封。 */
  secretRef?: string;
  /** 动态住宅代理的会话保持参数。 */
  stickySession?: { key: string; ttlSeconds: number };
  /** 上游代理链，用于住宅 + 中转的双跳出口。 */
  upstreamId?: Uuid;
  tags: string[];
}

export interface ProxyHealth {
  proxyId: Uuid;
  checkedAt: IsoDateTime;
  reachable: boolean;
  latencyMs?: number;
  exitIp?: string;
  geo?: {
    country: string;
    countryCode?: string;
    region?: string;
    city?: string;
    timezone?: string;
    asn?: string;
    latitude?: number;
    longitude?: number;
  };
  /** IP 质量画像：是否被标记为数据中心、代理或高风险。 */
  risk?: { score: number; isDatacenter: boolean; isProxy: boolean; blacklisted: boolean };
  error?: string;
}

// ---------------------------------------------------------------------------
// 浏览器环境（Profile）
// ---------------------------------------------------------------------------

export interface BrowserProfile {
  id: Uuid;
  orgId: Uuid;
  name: string;
  /** 业务平台标识，如 amazon / shopee / tiktok，用于加载平台专用策略。 */
  platformTag?: string;
  groupId?: Uuid;
  kernel: KernelType;
  fingerprint: FingerprintProfile;
  proxyId?: Uuid;
  /** 环境归属人；转让需走审计流程。 */
  ownerId: Uuid;
  /** 被授权协作的成员，实现同环境多人接力而不共享密码。 */
  sharedWith: Array<{ memberId: Uuid; permissions: Permission[] }>;
  storage: {
    /** 本地用户数据目录，按环境隔离。 */
    userDataDir: string;
    /** 远端加密快照版本号，用于跨设备同步。 */
    remoteRevision: number;
    syncMode: 'auto' | 'manual' | 'local-only';
  };
  startupUrls: string[];
  notes?: string;
  status: 'idle' | 'launching' | 'running' | 'syncing' | 'error';
  lastUsedAt?: IsoDateTime;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface IndexedDbDatabaseSnapshot {
  name: string;
  version: number;
  stores: Array<{
    name: string;
    autoIncrement: boolean;
    keyPath?: string;
    keyPathArray?: string[];
    records: Array<{
      key?: unknown;
      keyEncoded?: unknown;
      value?: unknown;
      valueEncoded?: unknown;
    }>;
    indexes: Array<{
      name: string;
      keyPath?: string;
      keyPathArray?: string[];
      multiEntry: boolean;
      unique: boolean;
    }>;
  }>;
}

export interface BrowserStorageState {
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite: 'Strict' | 'Lax' | 'None';
  }>;
  origins: Array<{
    origin: string;
    localStorage: Array<{ name: string; value: string }>;
    indexedDB?: IndexedDbDatabaseSnapshot[];
  }>;
}

export interface ProfileBackupEnvelope {
  format: 'shadowedge-profile-backup';
  version: 1;
  kdf: { name: 'PBKDF2-SHA256'; iterations: number; salt: string };
  payload: { ciphertext: string; wrappedKey: string; iv: string };
}

export interface ProfileBackupExportResult {
  saved: boolean;
  path?: string;
  cookieCount: number;
  originCount: number;
  indexedDbCount: number;
}

export interface ProfileBackupImportResult {
  imported: boolean;
  profile?: BrowserProfile;
  cookieCount: number;
  originCount: number;
  indexedDbCount: number;
}

export interface ProfileCreateInput {
  name: string;
  platformTag?: string;
  groupId?: Uuid;
  proxyId?: Uuid;
  startupUrls?: string[];
  notes?: string;
  /** 画像平台；'host' 跟随宿主机（推荐），缺省由主进程按 'host' 处理。 */
  platform?: Platform | 'host';
  fingerprintSeed?: string;
  overrides?: Partial<FingerprintProfile>;
}

export interface ProfileGroup {
  id: Uuid;
  orgId: Uuid;
  name: string;
  color?: string;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface ProfileGroupInput {
  id?: Uuid;
  name: string;
  color?: string;
}

/** 渲染层只能修改这些业务字段，画像、状态和本地路径由主进程独占。 */
export interface ProfileUpdateInput {
  name?: string;
  platformTag?: string;
  groupId?: Uuid;
  proxyId?: Uuid;
  startupUrls?: string[];
  notes?: string;
}

export interface LaunchOptions {
  profileId: Uuid;
  headless?: boolean;
  /** 开放 CDP 端口给 RPA / 外部自动化框架。 */
  remoteDebugging?: boolean;
  /** 忽略代理健康检查强制启动，仅用于排障。 */
  ignoreProxyCheck?: boolean;
  extraArgs?: string[];
}

export type KernelFallbackPolicy = 'allow-patchright' | 'require-chromium-cdp';

export interface KernelRuntimeConfig {
  /** 用户显式配置的自研内核可执行文件；缺省时使用环境变量或标准安装目录。 */
  executablePath?: string;
  fallbackPolicy: KernelFallbackPolicy;
}

export interface KernelRuntimeStatus extends KernelRuntimeConfig {
  /** 本次实际解析到的路径，与 configured executablePath 分开避免覆盖用户配置。 */
  resolvedExecutablePath?: string;
  source: 'configured' | 'environment' | 'installed' | 'none';
  available: boolean;
}

export interface LaunchResult {
  profileId: Uuid;
  sessionId: Uuid;
  /** 浏览器主进程 PID；驱动无法查询时省略，禁止用 0 冒充真实进程。 */
  pid?: number;
  wsEndpoint?: string;
  startedAt: IsoDateTime;
  /**
   * 实际承载本次会话的内核驱动名（如 chromium-cdp / patchright-chromium）。
   * 自研内核不可用时回退 Patchright 必须在此显式标记，不允许静默降级。
   */
  kernelUsed?: string;
}

// ---------------------------------------------------------------------------
// RPA
// ---------------------------------------------------------------------------

export type RpaNodeKind =
  | 'navigate'
  | 'click'
  | 'type'
  | 'wait'
  | 'extract'
  | 'screenshot'
  | 'condition'
  | 'loop'
  | 'script'
  | 'http';

export interface RpaNode {
  id: string;
  kind: RpaNodeKind;
  params: Record<string, unknown>;
  next?: string;
  onError?: 'stop' | 'continue' | 'retry';
  retries?: number;
}

export interface RpaGraph {
  entry: string;
  nodes: Record<string, RpaNode>;
}

export interface RpaWorkflow {
  id: Uuid;
  orgId: Uuid;
  name: string;
  version: number;
  graph: RpaGraph;
  inputsSchema?: unknown;
  createdBy: Uuid;
  updatedAt: IsoDateTime;
}

export interface RpaWorkflowInput {
  id?: Uuid;
  name: string;
  graph: RpaGraph;
  inputsSchema?: unknown;
}

export type RpaRunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface RpaRun {
  id: Uuid;
  workflowId: Uuid;
  profileId: Uuid;
  status: RpaRunStatus;
  startedAt?: IsoDateTime;
  finishedAt?: IsoDateTime;
  error?: string;
  /** extract 节点按 key 产生的文本结果。 */
  outputs?: Record<string, string | null>;
  artifacts: Array<{ kind: 'screenshot' | 'log' | 'json' | 'video'; uri: string }>;
}

// ---------------------------------------------------------------------------
// 账号凭据（密码明文永远不进入跨进程返回契约）
// ---------------------------------------------------------------------------

export interface AccountCredential {
  id: Uuid;
  profileId: Uuid;
  label: string;
  /** 精确协议 + 主机 + 端口，不允许路径、query 或 hash。 */
  origin: string;
  username: string;
  usernameSelector: string;
  passwordSelector: string;
  submitSelector?: string;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export type AccountCredentialInput = Omit<AccountCredential, 'id' | 'createdAt' | 'updatedAt'> & {
  id?: Uuid;
  /** 新建必填；更新省略时保留原密文。 */
  password?: string;
};

export interface AccountAutofillResult {
  credentialId: Uuid;
  profileId: Uuid;
  origin: string;
  submitted: boolean;
}

// ---------------------------------------------------------------------------
// 审计
// ---------------------------------------------------------------------------

export interface AuditEvent {
  id: Uuid;
  orgId: Uuid;
  actorId: Uuid;
  action: string;
  target: { kind: string; id: string };
  metadata?: Record<string, unknown>;
  ip?: string;
  /** 前序事件哈希，形成防篡改链。 */
  prevHash?: string;
  hash: string;
  createdAt: IsoDateTime;
}
