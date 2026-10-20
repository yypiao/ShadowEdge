import { describe, expect, it } from 'vitest';
import { auditFingerprint, generateFingerprint, syncUserAgentData } from '../src/index.js';

describe('generateFingerprint', () => {
  it('同一 seed 必须产出完全相同的画像', () => {
    const a = generateFingerprint({ seed: 'seed-alpha' });
    const b = generateFingerprint({ seed: 'seed-alpha' });
    expect(a).toEqual(b);
  });

  it('不同 seed 产出不同画像', () => {
    const seeds = Array.from({ length: 50 }, (_, i) => `seed-${i}`);
    const signatures = seeds.map((seed) => {
      const fp = generateFingerprint({ seed });
      return JSON.stringify([fp.userAgent, fp.screen, fp.webgl, fp.timezone, fp.fonts]);
    });
    expect(new Set(signatures).size).toBeGreaterThan(30);
  });

  it('macOS 平台不应出现触摸点', () => {
    for (let i = 0; i < 20; i += 1) {
      const fp = generateFingerprint({ seed: `mac-${i}`, platform: 'macos' });
      expect(fp.hardware.maxTouchPoints).toBe(0);
    }
  });

  it('screen.availHeight 应小于 height（留出任务栏）', () => {
    for (let i = 0; i < 20; i += 1) {
      const fp = generateFingerprint({ seed: `screen-${i}` });
      expect(fp.screen.availHeight).toBeLessThan(fp.screen.height);
    }
  });

  it('overrides 应覆盖生成值', () => {
    const fp = generateFingerprint({ seed: 'x', overrides: { timezone: 'Asia/Singapore' } });
    expect(fp.timezone).toBe('Asia/Singapore');
  });
});

describe('auditFingerprint', () => {
  it('未篡改的画像应通过审计', () => {
    expect(auditFingerprint(generateFingerprint({ seed: 'audit-ok' })).consistent).toBe(true);
  });

  it('被篡改的 userAgent 应被检出', () => {
    const fp = generateFingerprint({ seed: 'audit-bad' });
    const result = auditFingerprint({ ...fp, userAgent: 'tampered' });
    expect(result.consistent).toBe(false);
    expect(result.issues.join()).toContain('userAgent');
  });

  it('被篡改的 UA-CH 品牌应被检出', () => {
    const fp = generateFingerprint({ seed: 'audit-ua-ch' });
    const result = auditFingerprint({
      ...fp,
      userAgentData: { ...fp.userAgentData, brands: [{ brand: 'Google Chrome', version: '99' }] },
    });
    expect(result.consistent).toBe(false);
    expect(result.issues.join()).toContain('userAgentData');
  });
});

describe('syncUserAgentData', () => {
  const base = generateFingerprint({ seed: 'ua-ch-base', platform: 'windows' }).userAgentData;

  it('Edge UA 应产出 Microsoft Edge 品牌与同主版本', () => {
    const ua =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0';
    const result = syncUserAgentData(ua, base);
    expect(result.brands).toEqual([
      { brand: 'Chromium', version: '130' },
      { brand: 'Microsoft Edge', version: '130' },
      { brand: 'Not?A_Brand', version: '99' },
    ]);
    expect(result.fullVersion.startsWith('130.')).toBe(true);
  });

  it('Chrome UA 应产出 Google Chrome 品牌与同主版本', () => {
    const ua =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
    const result = syncUserAgentData(ua, base);
    expect(result.brands).toEqual([
      { brand: 'Chromium', version: '131' },
      { brand: 'Google Chrome', version: '131' },
      { brand: 'Not?A_Brand', version: '99' },
    ]);
    expect(result.fullVersion.startsWith('131.')).toBe(true);
  });

  it('无法解析版本的 UA 应保留素材库默认值', () => {
    expect(syncUserAgentData('tampered', base)).toBe(base);
  });
});
