import type { FingerprintProfile, Platform } from '@shadowedge/core';
import { SeededRandom } from '@shadowedge/core';
import { checkFingerprintConsistency } from './consistency.js';

/* ------------------------------------------------------------------ */
/*  指纹画像生成器：基于 seed 确定性产出所有指纹维度。               */
/*  内部维护一份随时更新的真实浏览器指纹库作为素材池。               */
/* ------------------------------------------------------------------ */

export interface FingerprintDatabase {
  userAgents: Record<Platform, string[]>;
  uaDatas: Record<Platform, FingerprintProfile['userAgentData'][]>;
  screens: FingerprintProfile['screen'][];
  fonts: Record<Platform, string[]>;
  /** platforms 为「跟随宿主机」模式的平台约束标签；缺省表示全平台可用（保持旧行为）。 */
  webglVendors: Array<{ vendor: string; renderer: string; platforms?: Platform[] }>;
}

/** 嵌入式指纹素材库 —— 实际生产环境应定期从遥测集群拉取并编译。 */
const DEFAULT_DB: FingerprintDatabase = {
  userAgents: {
    windows: [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
    ],
    macos: [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    ],
    linux: [
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    ],
  },
  uaDatas: {
    windows: [
      {
        brands: [
          { brand: 'Chromium', version: '131' },
          { brand: 'Google Chrome', version: '131' },
          { brand: 'Not?A_Brand', version: '99' },
        ],
        platform: 'Windows',
        platformVersion: '15.0.0',
        architecture: 'x86',
        bitness: '64',
        model: '',
        fullVersion: '131.0.6778.86',
        mobile: false,
      },
    ],
    macos: [
      {
        brands: [
          { brand: 'Chromium', version: '131' },
          { brand: 'Google Chrome', version: '131' },
          { brand: 'Not?A_Brand', version: '99' },
        ],
        platform: 'macOS',
        platformVersion: '14_6',
        architecture: 'x86',
        bitness: '64',
        model: '',
        fullVersion: '131.0.6778.86',
        mobile: false,
      },
    ],
    linux: [
      {
        brands: [
          { brand: 'Chromium', version: '131' },
          { brand: 'Google Chrome', version: '131' },
          { brand: 'Not?A_Brand', version: '99' },
        ],
        platform: 'Linux',
        platformVersion: '',
        architecture: 'x86',
        bitness: '64',
        model: '',
        fullVersion: '131.0.6778.86',
        mobile: false,
      },
    ],
  },
  screens: [
    {
      width: 1920,
      height: 1080,
      availWidth: 1920,
      availHeight: 1040,
      colorDepth: 24,
      pixelRatio: 1,
    },
    {
      width: 1920,
      height: 1080,
      availWidth: 1920,
      availHeight: 1030,
      colorDepth: 24,
      pixelRatio: 1,
    },
    { width: 1440, height: 900, availWidth: 1440, availHeight: 860, colorDepth: 24, pixelRatio: 2 },
    {
      width: 2560,
      height: 1440,
      availWidth: 2560,
      availHeight: 1400,
      colorDepth: 30,
      pixelRatio: 1,
    },
    { width: 1366, height: 768, availWidth: 1366, availHeight: 730, colorDepth: 24, pixelRatio: 1 },
  ],
  fonts: {
    windows: [
      'Arial',
      'Calibri',
      'Cambria',
      'Courier New',
      'Georgia',
      'Segoe UI',
      'Tahoma',
      'Times New Roman',
      'Verdana',
      'Webdings',
    ],
    macos: [
      'Helvetica',
      'Arial',
      'Georgia',
      'Times New Roman',
      'Courier',
      'Verdana',
      'Trebuchet MS',
      'Lucida Grande',
      'Menlo',
      'Monaco',
    ],
    linux: [
      'DejaVu Sans',
      'DejaVu Serif',
      'Liberation Sans',
      'Liberation Serif',
      'Ubuntu',
      'Noto Sans',
      'Noto Serif',
      'Droid Sans',
      'Cantarell',
      'FreeSans',
    ],
  },
  webglVendors: [
    {
      vendor: 'Google Inc. (Intel)',
      renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      platforms: ['windows'],
    },
    {
      vendor: 'Google Inc. (Apple)',
      renderer: 'ANGLE (Apple, Apple M1 Pro, OpenGL 4.1)',
      platforms: ['macos'],
    },
    {
      vendor: 'Google Inc. (NVIDIA)',
      renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      platforms: ['windows'],
    },
    {
      vendor: 'Google Inc. (AMD)',
      renderer: 'ANGLE (AMD, AMD Radeon Pro 5500M, OpenGL 4.1)',
      platforms: ['macos'],
    },
  ],
};

/** 'host' → 宿主机平台。fingerprint 在 Node 主进程运行，process.platform 即宿主。 */
export function resolvePlatform(platform?: Platform | 'host'): Platform {
  if (platform && platform !== 'host') return platform;
  const nodePlatform = typeof process !== 'undefined' ? process.platform : 'win32';
  return nodePlatform === 'darwin' ? 'macos' : nodePlatform === 'win32' ? 'windows' : 'linux';
}

export interface FingerprintGeneratorOptions {
  seed: string;
  /** 传 'host' 跟随宿主机平台（推荐默认）；显式平台保持历史 pick 行为不变。 */
  platform?: Platform | 'host';
  overrides?: Partial<FingerprintProfile>;
  db?: Partial<FingerprintDatabase>;
}

export interface FingerprintAuditOptions {
  /** 与生成时相同的素材覆盖；使用版本化 catalog 的环境必须一并传入。 */
  db?: Partial<FingerprintDatabase>;
  /** 与生成时相同的显式覆写（平台/GPU 等）。 */
  overrides?: Partial<FingerprintProfile>;
}

export function generateFingerprint(options: FingerprintGeneratorOptions): FingerprintProfile {
  const { seed, overrides, db: dbOverrides } = options;
  const followHost = options.platform === 'host';
  const platform = resolvePlatform(options.platform ?? 'windows');
  const rng = new SeededRandom(seed);
  const db = mergeDb(dbOverrides);

  const ua = rng.pick(db.userAgents[platform]);
  // Client Hints 必须由 UA 派生：UA 与 UA-CH 互相打脸是最常见的判定点
  // （Pixelscan 实测：UA 说 Edge 130、CH 说 Chrome 131 时直接判 inconsistent）
  const uaData = syncUserAgentData(ua, rng.pick(db.uaDatas[platform]));
  const screen = rng.pick(db.screens);
  // 跟随宿主机时 GPU 限定同系（Mac 不出 NVIDIA D3D11）；显式平台维持旧候选集防历史环境漂移
  const webglPool = followHost
    ? db.webglVendors.filter((g) => !g.platforms || g.platforms.includes(platform))
    : db.webglVendors;
  // 平台素材缺失时（如 linux）回退全量，宁可跨系也不空集
  const webgl = rng.pick(webglPool.length > 0 ? webglPool : db.webglVendors);
  const fontPool = db.fonts[platform];

  const profile: FingerprintProfile = {
    seed,
    platform,
    userAgent: ua,
    userAgentData: uaData,
    screen: { ...screen },
    viewport: { width: screen.width, height: screen.availHeight },
    languages: rng.pick([
      ['en-US', 'en'],
      ['zh-CN', 'zh'],
      ['en-GB', 'en'],
      ['ja-JP', 'ja'],
      ['ko-KR', 'ko'],
    ]),
    timezone: rng.pick([
      'America/New_York',
      'America/Chicago',
      'America/Los_Angeles',
      'Asia/Shanghai',
      'Asia/Tokyo',
      'Asia/Seoul',
      'Asia/Singapore',
      'Europe/London',
      'Europe/Berlin',
      'Europe/Paris',
      'Australia/Sydney',
      'America/Sao_Paulo',
    ]),
    hardware: {
      deviceMemoryGb: rng.pick([4, 8, 16, 32]),
      hardwareConcurrency: rng.pick([4, 6, 8, 12, 16]),
      maxTouchPoints: platform === 'macos' ? 0 : rng.pick([0, 1, 5, 10]),
    },
    webgl: { vendor: webgl.vendor, renderer: webgl.renderer, noise: 'noise' },
    canvas: 'noise',
    audio: 'noise',
    clientRects: 'noise',
    fonts: { mode: 'whitelist', families: rng.sample(fontPool, 8) },
    webrtc: { mode: 'replace' },
    media: { audioInputs: 1, videoInputs: 1, audioOutputs: 1 },
    disabledFeatures: [],
  };

  return overrides ? applyOverrides(profile, overrides) : profile;
}

/**
 * 由 UA 解析品牌与大版本，校正 UA-CH，保证两者同源。
 * 数据库里的 CH 素材保留完整版本号等细节，只替换可能冲突的品牌/主版本。
 */
export function syncUserAgentData(
  ua: string,
  base: FingerprintProfile['userAgentData'],
): FingerprintProfile['userAgentData'] {
  const edge = ua.match(/Edg\/(\d+)[\d.]*/);
  const chrome = ua.match(/Chrome\/(\d+)[\d.]*/);
  const major = edge?.[1] ?? chrome?.[1];
  if (!major) return base;

  const brands: FingerprintProfile['userAgentData']['brands'] = [
    { brand: 'Chromium', version: major },
    edge ? { brand: 'Microsoft Edge', version: major } : { brand: 'Google Chrome', version: major },
    { brand: 'Not?A_Brand', version: '99' },
  ];
  return {
    ...base,
    brands,
    fullVersion: base.fullVersion.replace(/^\d+/, major),
  };
}

function mergeDb(overrides?: Partial<FingerprintDatabase>): FingerprintDatabase {
  if (!overrides) return DEFAULT_DB;
  const merged: FingerprintDatabase = {
    userAgents: { ...DEFAULT_DB.userAgents },
    uaDatas: { ...DEFAULT_DB.uaDatas },
    screens: [...DEFAULT_DB.screens],
    fonts: { ...DEFAULT_DB.fonts },
    webglVendors: [...DEFAULT_DB.webglVendors],
  };
  if (overrides.userAgents) {
    for (const key of Object.keys(overrides.userAgents) as Platform[]) {
      merged.userAgents[key] = [...(merged.userAgents[key] ?? []), ...overrides.userAgents[key]!];
    }
  }
  if (overrides.uaDatas) {
    for (const key of Object.keys(overrides.uaDatas) as Platform[]) {
      merged.uaDatas[key] = [...(merged.uaDatas[key] ?? []), ...overrides.uaDatas[key]!];
    }
  }
  if (overrides.screens) merged.screens = [...merged.screens, ...overrides.screens];
  if (overrides.fonts) {
    for (const key of Object.keys(overrides.fonts) as Platform[]) {
      merged.fonts[key] = [...(merged.fonts[key] ?? []), ...overrides.fonts[key]!];
    }
  }
  if (overrides.webglVendors) {
    merged.webglVendors = [...merged.webglVendors, ...overrides.webglVendors];
  }
  return merged;
}

/**
 * 应用用户覆写。对象型字段做一层合并（例如只想改 screen.width 而保留其余字段），
 * 标量与数组直接替换。
 */
function applyOverrides(
  base: FingerprintProfile,
  overrides: Partial<FingerprintProfile>,
): FingerprintProfile {
  const result: FingerprintProfile = { ...base };
  for (const key of Object.keys(overrides) as Array<keyof FingerprintProfile>) {
    const value = overrides[key];
    if (value === undefined) continue;
    const current = result[key];
    if (isPlainObject(value) && isPlainObject(current)) {
      Object.assign(result, { [key]: { ...current, ...value } });
    } else {
      Object.assign(result, { [key]: value });
    }
  }
  return result;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** 一致性审计：检查指定种子是否可复现已有指纹。 */
export function auditFingerprint(
  current: FingerprintProfile,
  options: FingerprintAuditOptions = {},
): {
  consistent: boolean;
  issues: string[];
} {
  const issues: string[] = [];
  const regenerated = generateFingerprint({
    seed: current.seed,
    platform: current.platform,
    db: options.db,
    overrides: options.overrides,
  });
  if (regenerated.userAgent !== current.userAgent) issues.push('userAgent 与 seed 不匹配');
  const syncedUaData = syncUserAgentData(current.userAgent, current.userAgentData);
  if (JSON.stringify(syncedUaData) !== JSON.stringify(current.userAgentData)) {
    issues.push('userAgentData 品牌/版本与 userAgent 不一致');
  }
  if (regenerated.screen.width !== current.screen.width) issues.push('屏幕宽度与 seed 不匹配');
  if (regenerated.webgl.vendor !== current.webgl.vendor) issues.push('WebGL vendor 与 seed 不匹配');
  const crossCheck = checkFingerprintConsistency(current, {
    allowedFonts: options.db?.fonts?.[current.platform] ?? DEFAULT_DB.fonts[current.platform],
  });
  issues.push(...crossCheck.issues);
  return { consistent: issues.length === 0, issues };
}

export { buildInjectionScript } from './inject.js';
export { buildClientHintHeaders } from './client-hints.js';
export {
  checkFingerprintConsistency,
  detectUserAgentPlatform,
  detectUserAgentVersion,
} from './consistency.js';
export type { ConsistencyOptions, ConsistencyResult } from './consistency.js';
export {
  buildChromeCatalog,
  catalogPlatforms,
  catalogToGeneratorDb,
  parseChromeStableVersion,
  parseFingerprintCatalog,
} from './catalog.js';
export type {
  CatalogGeneratorDb,
  ChromeCatalogMeta,
  FingerprintCatalog,
  FingerprintCatalogEntry,
} from './catalog.js';
export { deriveGeoOverrides } from './geo-follow.js';
export type { GeoInput } from './geo-follow.js';
