import { describe, expect, it } from 'vitest';
import { buildInjectionScript, generateFingerprint } from '../src/index.js';

describe('指纹注入脚本', () => {
  it('同一 seed 产出逐字节一致的脚本', () => {
    const fp1 = generateFingerprint({ seed: 'env-001' });
    const fp2 = generateFingerprint({ seed: 'env-001' });
    expect(buildInjectionScript(fp1)).toBe(buildInjectionScript(fp2));
  });

  it('不同 seed 产出不同脚本', () => {
    const a = buildInjectionScript(generateFingerprint({ seed: 'env-001' }));
    const b = buildInjectionScript(generateFingerprint({ seed: 'env-002' }));
    expect(a).not.toBe(b);
  });

  it('脚本包含画像关键字段且语法可被解析', () => {
    const fp = generateFingerprint({ seed: 'env-003' });
    const script = buildInjectionScript(fp);
    expect(script).toContain(fp.webgl.renderer);
    expect(script).toContain(String(fp.hardware.hardwareConcurrency));
    expect(script).toContain(String(fp.screen.width));
    // 语法有效性：能作为函数体被 new Function 接受
    expect(() => new Function(script)).not.toThrow();
  });

  it('禁用项 webdriver 时脚本包含隐藏逻辑', () => {
    const fp = generateFingerprint({ seed: 'env-004' });
    fp.disabledFeatures = [...fp.disabledFeatures, 'webdriver'];
    expect(buildInjectionScript(fp)).toContain("webdriver");
  });

  it('canvas=off 时不注入噪声逻辑', () => {
    const fp = { ...generateFingerprint({ seed: 'env-005' }), canvas: 'off' as const };
    expect(buildInjectionScript(fp)).not.toContain('_noiseCanvas');
  });
});
