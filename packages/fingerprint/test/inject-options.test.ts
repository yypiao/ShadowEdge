import { describe, expect, it } from 'vitest';
import { generateFingerprint } from '../src/index.js';
import { buildInjectionScript } from '../src/inject.js';

describe('注入脚本 ServiceWorker 策略', () => {
  const fp = generateFingerprint({ seed: 'sw-opt-test' });

  it('默认 shield：屏蔽 navigator.serviceWorker', () => {
    expect(buildInjectionScript(fp)).toContain(`'serviceWorker', () => undefined`);
  });

  it('kernel 模式：不屏蔽 ServiceWorker', () => {
    expect(buildInjectionScript(fp, { serviceWorker: 'kernel' })).not.toContain(
      `'serviceWorker', () => undefined`,
    );
  });

  it('确定性：同 seed 同策略逐字节一致', () => {
    expect(buildInjectionScript(fp, { serviceWorker: 'kernel' })).toBe(
      buildInjectionScript(generateFingerprint({ seed: 'sw-opt-test' }), { serviceWorker: 'kernel' }),
    );
  });
});
