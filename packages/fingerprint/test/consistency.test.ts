import { describe, expect, it } from 'vitest';
import {
  checkFingerprintConsistency,
  generateFingerprint,
  detectUserAgentPlatform,
  detectUserAgentVersion,
} from '../src/index.js';

const base = () =>
  generateFingerprint({
    seed: 'consistency-base',
    platform: 'macos',
    overrides: {
      webgl: {
        vendor: 'Google Inc. (Apple)',
        renderer: 'ANGLE (Apple, Apple M1 Pro, OpenGL 4.1)',
        noise: 'noise',
      },
    },
  });

describe('consistency: UA 与 UA-CH', () => {
  it('正例：生成画像应通过', () => {
    expect(checkFingerprintConsistency(base()).issues).toEqual([]);
  });

  it('反例：UA 操作系统与 platform 不一致', () => {
    const result = checkFingerprintConsistency({
      ...base(),
      userAgent: base().userAgent.replace(
        'Macintosh; Intel Mac OS X 14_6',
        'Windows NT 10.0; Win64; x64',
      ),
    });
    expect(result.consistent).toBe(false);
    expect(result.issues.join()).toContain('操作系统');
  });

  it('反例：UA-CH platform 与 platform 不一致', () => {
    const result = checkFingerprintConsistency({
      ...base(),
      userAgentData: { ...base().userAgentData, platform: 'Windows' },
    });
    expect(result.consistent).toBe(false);
    expect(result.issues.join()).toContain('userAgentData.platform');
  });

  it('反例：fullVersion 与 UA 主版本不一致', () => {
    const fp = base();
    const result = checkFingerprintConsistency({
      ...fp,
      userAgentData: { ...fp.userAgentData, fullVersion: '999.0.0.0' },
    });
    expect(result.consistent).toBe(false);
    expect(result.issues.join()).toContain('fullVersion');
  });

  it('反例：brands 缺少同主版本 Chrome 品牌', () => {
    const fp = base();
    const result = checkFingerprintConsistency({
      ...fp,
      userAgentData: { ...fp.userAgentData, brands: [{ brand: 'Chromium', version: '999' }] },
    });
    expect(result.consistent).toBe(false);
    expect(result.issues.join()).toContain('Chromium');
  });
});

describe('consistency: 屏幕 / 硬件 / GPU / 字体', () => {
  it('反例：availHeight 与 height 差值过小', () => {
    const fp = base();
    const result = checkFingerprintConsistency({
      ...fp,
      screen: { ...fp.screen, availHeight: fp.screen.height - 5 },
    });
    expect(result.consistent).toBe(false);
    expect(result.issues.join()).toContain('20–80px');
  });

  it('反例：availWidth 大于 width', () => {
    const fp = base();
    const result = checkFingerprintConsistency({
      ...fp,
      screen: { ...fp.screen, availWidth: fp.screen.width + 1 },
    });
    expect(result.consistent).toBe(false);
    expect(result.issues.join()).toContain('availWidth');
  });

  it('反例：macOS 出现触摸点', () => {
    const fp = base();
    const result = checkFingerprintConsistency({
      ...fp,
      hardware: { ...fp.hardware, maxTouchPoints: 5 },
    });
    expect(result.consistent).toBe(false);
    expect(result.issues.join()).toContain('maxTouchPoints');
  });

  it('反例：deviceMemory 不是 2 的幂', () => {
    const fp = base();
    const result = checkFingerprintConsistency({
      ...fp,
      hardware: { ...fp.hardware, deviceMemoryGb: 12 },
    });
    expect(result.consistent).toBe(false);
    expect(result.issues.join()).toContain('deviceMemoryGb');
  });

  it('反例：Windows 平台出现 Apple GPU', () => {
    const fp = base();
    const result = checkFingerprintConsistency({
      ...fp,
      platform: 'windows',
      userAgent: generateFingerprint({ seed: 'win', platform: 'windows' }).userAgent,
      userAgentData: generateFingerprint({ seed: 'win', platform: 'windows' }).userAgentData,
      webgl: {
        ...fp.webgl,
        vendor: 'Google Inc. (Apple)',
        renderer: 'ANGLE (Apple, Apple M1 Pro, OpenGL 4.1)',
      },
    });
    expect(result.consistent).toBe(false);
    expect(result.issues.join()).toContain('Apple/Metal');
  });

  it('反例：白名单字体不属于当前平台', () => {
    const fp = base();
    const result = checkFingerprintConsistency(
      { ...fp, fonts: { mode: 'whitelist', families: ['Segoe UI'] } },
      { allowedFonts: ['Helvetica', 'Arial'] },
    );
    expect(result.consistent).toBe(false);
    expect(result.issues.join()).toContain('字体');
  });
});

describe('UA 解析', () => {
  it('识别 Windows / macOS / Linux', () => {
    expect(detectUserAgentPlatform('Windows NT 10.0')).toBe('windows');
    expect(detectUserAgentPlatform('Macintosh; Intel Mac OS X 14_6')).toBe('macos');
    expect(detectUserAgentPlatform('X11; Linux x86_64')).toBe('linux');
    expect(detectUserAgentPlatform('tampered')).toBeNull();
  });

  it('Edge UA 优先取 Edg 主版本', () => {
    const ua =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/131.0.0.0';
    expect(detectUserAgentVersion(ua)).toEqual({ major: '131', browser: 'Microsoft Edge' });
  });
});
