import type { FingerprintProfile, Platform } from '@shadowedge/core';

/**
 * UA/UA-CH 素材目录。版本化快照允许新环境使用新 Chrome 素材，
 * 同时不改动 DEFAULT_DB 的顺序，避免历史 seed 因候选池变化而漂移。
 */
export interface FingerprintCatalogEntry {
  userAgent: string;
  userAgentData: FingerprintProfile['userAgentData'];
}

export interface FingerprintCatalog {
  schemaVersion: 1;
  channel: 'stable';
  chromeVersion: string;
  generatedAt: string;
  source: string;
  platforms: Record<Platform, FingerprintCatalogEntry[]>;
}

export interface CatalogGeneratorDb {
  userAgents: Record<Platform, string[]>;
  uaDatas: Record<Platform, FingerprintProfile['userAgentData'][]>;
}

export interface ChromeCatalogMeta {
  generatedAt: string;
  source: string;
}

const PLATFORMS: Platform[] = ['windows', 'macos', 'linux'];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isPlatform = (value: string): value is Platform =>
  value === 'windows' || value === 'macos' || value === 'linux';

function isBrand(value: unknown): value is { brand: string; version: string } {
  return isRecord(value) && typeof value.brand === 'string' && typeof value.version === 'string';
}

function parseUserAgentData(value: unknown): FingerprintProfile['userAgentData'] {
  if (
    !isRecord(value) ||
    !Array.isArray(value.brands) ||
    !value.brands.every(isBrand) ||
    typeof value.platform !== 'string' ||
    typeof value.platformVersion !== 'string' ||
    typeof value.architecture !== 'string' ||
    typeof value.bitness !== 'string' ||
    typeof value.model !== 'string' ||
    typeof value.fullVersion !== 'string' ||
    typeof value.mobile !== 'boolean'
  ) {
    throw new Error('invalid fingerprint catalog: userAgentData');
  }
  return {
    brands: value.brands.map(({ brand, version }) => ({ brand, version })),
    platform: value.platform,
    platformVersion: value.platformVersion,
    architecture: value.architecture,
    bitness: value.bitness,
    model: value.model,
    fullVersion: value.fullVersion,
    mobile: value.mobile,
  };
}

export function parseFingerprintCatalog(value: unknown): FingerprintCatalog {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.channel !== 'stable' ||
    typeof value.chromeVersion !== 'string' ||
    typeof value.generatedAt !== 'string' ||
    typeof value.source !== 'string' ||
    !isRecord(value.platforms)
  ) {
    throw new Error('invalid fingerprint catalog: header');
  }

  const platforms = {} as Record<Platform, FingerprintCatalogEntry[]>;
  for (const platform of PLATFORMS) {
    const entries = value.platforms[platform];
    if (!Array.isArray(entries)) throw new Error(`invalid fingerprint catalog: ${platform}`);
    platforms[platform] = entries.map((entry) => {
      if (!isRecord(entry) || typeof entry.userAgent !== 'string') {
        throw new Error(`invalid fingerprint catalog entry: ${platform}`);
      }
      return {
        userAgent: entry.userAgent,
        userAgentData: parseUserAgentData(entry.userAgentData),
      };
    });
  }

  return {
    schemaVersion: 1,
    channel: 'stable',
    chromeVersion: value.chromeVersion,
    generatedAt: value.generatedAt,
    source: value.source,
    platforms,
  };
}

export function catalogToGeneratorDb(catalog: FingerprintCatalog): CatalogGeneratorDb {
  const userAgents = {} as Record<Platform, string[]>;
  const uaDatas = {} as Record<Platform, FingerprintProfile['userAgentData'][]>;
  for (const platform of PLATFORMS) {
    userAgents[platform] = catalog.platforms[platform].map(({ userAgent }) => userAgent);
    uaDatas[platform] = catalog.platforms[platform].map(({ userAgentData }) => userAgentData);
  }
  return { userAgents, uaDatas };
}

function platformUserAgent(platform: Platform, major: string): string {
  if (platform === 'windows') {
    return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
  }
  if (platform === 'macos') {
    return `Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
  }
  return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

function platformVersion(platform: Platform): string {
  if (platform === 'windows') return '15.0.0';
  if (platform === 'macos') return '14_6';
  return '';
}

/** 由 Chrome for Testing 的完整版本号构建三平台稳定版目录。 */
export function buildChromeCatalog(
  fullVersion: string,
  meta: ChromeCatalogMeta,
): FingerprintCatalog {
  const match = fullVersion.match(/^(\d+)\.\d+\.\d+\.\d+$/);
  if (!match) throw new Error(`invalid Chrome full version: ${fullVersion}`);
  const major = match[1]!;
  const brands: FingerprintProfile['userAgentData']['brands'] = [
    { brand: 'Chromium', version: major },
    { brand: 'Google Chrome', version: major },
    { brand: 'Not?A_Brand', version: '99' },
  ];
  const platforms = {} as Record<Platform, FingerprintCatalogEntry[]>;
  for (const platform of PLATFORMS) {
    platforms[platform] = [
      {
        userAgent: platformUserAgent(platform, major),
        userAgentData: {
          brands: brands.map((brand) => ({ ...brand })),
          platform: platform === 'windows' ? 'Windows' : platform === 'macos' ? 'macOS' : 'Linux',
          platformVersion: platformVersion(platform),
          architecture: 'x86',
          bitness: '64',
          model: '',
          fullVersion,
          mobile: false,
        },
      },
    ];
  }
  return {
    schemaVersion: 1,
    channel: 'stable',
    chromeVersion: fullVersion,
    generatedAt: meta.generatedAt,
    source: meta.source,
    platforms,
  };
}

/** 从 Chrome for Testing API 响应中提取 stable 完整版本。 */
export function parseChromeStableVersion(value: unknown): string {
  if (!isRecord(value) || !isRecord(value.channels) || !isRecord(value.channels.Stable)) {
    throw new Error('invalid Chrome for Testing response');
  }
  const version = value.channels.Stable.version;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+\.\d+$/.test(version)) {
    throw new Error('invalid Chrome stable version');
  }
  return version;
}

export function catalogPlatforms(): readonly Platform[] {
  return PLATFORMS;
}
