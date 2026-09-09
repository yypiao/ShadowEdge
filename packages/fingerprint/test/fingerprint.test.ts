import { describe, expect, it } from 'vitest';
import { auditFingerprint, generateFingerprint } from '../src/index.js';

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
});
