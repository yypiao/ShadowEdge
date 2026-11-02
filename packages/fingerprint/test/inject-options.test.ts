import { describe, expect, it } from 'vitest';
import { generateFingerprint } from '../src/index.js';
import { buildInjectionScript } from '../src/inject.js';

describe('注入脚本 ServiceWorker 策略', () => {
  const fp = generateFingerprint({ seed: 'sw-opt-test' });

  it('默认 shield：屏蔽 navigator.serviceWorker', () => {
    expect(buildInjectionScript(fp)).toContain(`'serviceWorker', () => undefined`);
  });

  it('kernel 模式：不屏蔽 ServiceWorker', () => {
    const script = buildInjectionScript(fp, { serviceWorker: 'kernel' });
    expect(script).not.toContain(`'serviceWorker', () => undefined`);
    expect(script).not.toContain('_proxy(_OrigWorker');
    expect(script).not.toContain('_patchedBlob');
    expect(script).not.toContain('__injectSrc');
  });

  it('shield 模式：保留 Worker 包装所需的源码载体', () => {
    const script = buildInjectionScript(fp);
    expect(script).toContain('_proxy(_OrigWorker');
    expect(script).toContain('_patchedBlob');
    expect(script).toContain('__injectSrc');
  });

  it('确定性：同 seed 同策略逐字节一致', () => {
    expect(buildInjectionScript(fp, { serviceWorker: 'kernel' })).toBe(
      buildInjectionScript(generateFingerprint({ seed: 'sw-opt-test' }), {
        serviceWorker: 'kernel',
      }),
    );
  });
});
