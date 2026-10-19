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
  geo?: { country: string; countryCode?: string; region?: string; city?: string; timezone?: string; asn?: string; latitude?: number; longitude?: number };
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

export interface LaunchOptions {
  profileId: Uuid;
  headless?: boolean;
  /** 开放 CDP 端口给 RPA / 外部自动化框架。 */
  remoteDebugging?: boolean;
  /** 忽略代理健康检查强制启动，仅用于排障。 */
  ignoreProxyCheck?: boolean;
  extraArgs?: string[];
}

export interface LaunchResult {
  profileId: Uuid;
  sessionId: Uuid;
  pid: number;
  wsEndpoint?: string;
  startedAt: IsoDateTime;
}

// ---------------------------------------------------------------------------
// RPA
// ---------------------------------------------------------------------------

export interface RpaWorkflow {
  id: Uuid;
  orgId: Uuid;
  name: string;
  version: number;
  /** 节点图定义，由 @shadowedge/rpa 的 DSL 校验。 */
  graph: unknown;
  inputsSchema?: unknown;
  createdBy: Uuid;
  updatedAt: IsoDateTime;
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
  artifacts: Array<{ kind: 'screenshot' | 'log' | 'json' | 'video'; uri: string }>;
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
