import type { FingerprintProfile, Platform } from '@shadowedge/core';

export interface ConsistencyOptions {
  /** 当前平台的合法字体池；未提供时跳过字体子集校验。 */
  allowedFonts?: readonly string[];
}

export interface ConsistencyResult {
  consistent: boolean;
  issues: string[];
}

const UA_DATA_PLATFORM: Record<Platform, string> = {
  windows: 'Windows',
  macos: 'macOS',
  linux: 'Linux',
};

const UA_OS_MARKERS: Array<{ platform: Platform; marker: RegExp }> = [
  { platform: 'windows', marker: /Windows NT/i },
  { platform: 'macos', marker: /Macintosh|Mac OS X/i },
  { platform: 'linux', marker: /Linux|X11/i },
];

export function detectUserAgentPlatform(ua: string): Platform | null {
  return UA_OS_MARKERS.find(({ marker }) => marker.test(ua))?.platform ?? null;
}

export function detectUserAgentVersion(ua: string): {
  major: string;
  browser: 'Microsoft Edge' | 'Google Chrome';
} | null {
  const edge = ua.match(/Edg\/(\d+)[\d.]*/);
  const chrome = ua.match(/Chrome\/(\d+)[\d.]*/);
  const major = edge?.[1] ?? chrome?.[1];
  if (!major) return null;
  return { major, browser: edge ? 'Microsoft Edge' : 'Google Chrome' };
}

function checkUserAgent(fp: FingerprintProfile, issues: string[]): void {
  const uaPlatform = detectUserAgentPlatform(fp.userAgent);
  if (!uaPlatform) {
    issues.push('userAgent 中缺少可识别的操作系统');
  } else if (uaPlatform !== fp.platform) {
    issues.push(`userAgent 操作系统（${uaPlatform}）与 platform（${fp.platform}）不一致`);
  }

  if (fp.userAgentData.platform !== UA_DATA_PLATFORM[fp.platform]) {
    issues.push(
      `userAgentData.platform（${fp.userAgentData.platform}）与 platform（${fp.platform}）不一致`,
    );
  }

  const version = detectUserAgentVersion(fp.userAgent);
  if (!version) {
    issues.push('userAgent 中缺少 Chrome/Edge 主版本');
    return;
  }

  const fullMajor = fp.userAgentData.fullVersion.split('.')[0];
  if (fullMajor !== version.major) {
    issues.push(
      `userAgentData.fullVersion（${fp.userAgentData.fullVersion}）与 UA 主版本（${version.major}）不一致`,
    );
  }

  const chromiumBrand = fp.userAgentData.brands.find(({ brand }) => brand === 'Chromium');
  if (!chromiumBrand || chromiumBrand.version !== version.major) {
    issues.push('userAgentData.brands 缺少与 UA 同主版本的 Chromium 品牌');
  }
  const browserBrand = fp.userAgentData.brands.find(({ brand }) => brand === version.browser);
  if (!browserBrand || browserBrand.version !== version.major) {
    issues.push(`userAgentData.brands 缺少与 UA 同主版本的 ${version.browser} 品牌`);
  }
}

function checkScreen(fp: FingerprintProfile, issues: string[]): void {
  const { width, height, availWidth, availHeight, pixelRatio } = fp.screen;
  if (availWidth > width) issues.push('screen.availWidth 不能大于 width');
  if (availWidth <= 0 || availHeight <= 0) issues.push('screen 可用区域必须为正数');
  if (availHeight >= height) issues.push('screen.availHeight 必须小于 height');
  const reserved = height - availHeight;
  if (reserved < 20 || reserved > 80) {
    issues.push(`screen.height 与 availHeight 差值 ${reserved}px 不在 20–80px 合理区间`);
  }
  if (!Number.isFinite(pixelRatio) || pixelRatio <= 0 || pixelRatio > 4) {
    issues.push(`screen.pixelRatio（${pixelRatio}）不在合理区间`);
  }
}

function checkHardware(fp: FingerprintProfile, issues: string[]): void {
  const memory = fp.hardware.deviceMemoryGb;
  const powerOfTwo =
    Number.isInteger(memory) && memory >= 2 && memory <= 64 && (memory & (memory - 1)) === 0;
  if (!powerOfTwo) issues.push(`deviceMemoryGb（${memory}）必须是 2–64 之间的 2 的幂`);
  if (fp.hardware.hardwareConcurrency <= 0) issues.push('hardwareConcurrency 必须为正数');
  if (fp.platform === 'macos' && fp.hardware.maxTouchPoints !== 0) {
    issues.push('macOS 的 maxTouchPoints 必须为 0');
  }
}

function checkWebGl(fp: FingerprintProfile, issues: string[]): void {
  const { vendor, renderer } = fp.webgl;
  if (/SwiftShader/i.test(`${vendor} ${renderer}`)) {
    issues.push('WebGL 使用 SwiftShader，暴露无 GPU/无头环境');
  }
  if (/Direct3D11|D3D11/i.test(renderer) && fp.platform !== 'windows') {
    issues.push('WebGL 为 D3D11 渲染器，但平台不是 Windows');
  }
  if (/Apple|\bMetal\b/i.test(`${vendor} ${renderer}`) && fp.platform !== 'macos') {
    issues.push('WebGL 为 Apple/Metal GPU，但平台不是 macOS');
  }
}

function checkFonts(
  fp: FingerprintProfile,
  issues: string[],
  allowedFonts?: readonly string[],
): void {
  if (fp.fonts.mode !== 'whitelist' || !allowedFonts) return;
  const allowed = new Set(allowedFonts);
  const invalid = fp.fonts.families.filter((family) => !allowed.has(family));
  if (invalid.length > 0) issues.push(`字体不在 ${fp.platform} 字体库中: ${invalid.join(', ')}`);
}

/**
 * 指纹维度交叉校验。只检查可证明的矛盾，不猜测“真实设备应该是什么”，
 * 避免把合法的用户覆写误判成伪造。
 */
export function checkFingerprintConsistency(
  fp: FingerprintProfile,
  options: ConsistencyOptions = {},
): ConsistencyResult {
  const issues: string[] = [];
  checkUserAgent(fp, issues);
  checkScreen(fp, issues);
  checkHardware(fp, issues);
  checkWebGl(fp, issues);
  checkFonts(fp, issues, options.allowedFonts);
  return { consistent: issues.length === 0, issues };
}
