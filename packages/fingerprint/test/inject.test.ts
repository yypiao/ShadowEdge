import { describe, expect, it } from 'vitest';
import { buildClientHintHeaders, buildInjectionScript, generateFingerprint } from '../src/index.js';

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
    expect(script).toContain('userAgentData');
    expect(script).toContain('getHighEntropyValues');
    expect(script).toContain('NavigatorUAData.prototype');
    expect(script).toContain('const _uaBrands = () => Object.freeze');
    expect(script).not.toContain('data.getHighEntropyValues =');
    expect(script).toContain(fp.userAgentData.fullVersion);
    expect(script).toContain('const _navProto');
    expect(script).toContain('WorkerNavigator.prototype');
    expect(script).toContain('OffscreenCanvas.prototype.getContext');
    expect(script).toContain('_blobUrlSource');
    expect(script).toContain('_proxy(_OrigWorker');
    expect(script).toContain('_proxy(_OrigBlob');
    expect(script).toContain('_proxy(_origCreateObjectURL');
    expect(script).toContain("_def(Screen.prototype, 'width'");
    expect(script).toContain("_def(Screen.prototype, 'pixelDepth'");
    expect(script).toContain('MediaDevices.prototype, "enumerateDevices"');
    expect(script).toContain('_dprDesc');
    expect(script).toContain('set: _dprDesc && _dprDesc.set');
    expect(script).toContain('EventTarget.prototype.addEventListener');
    expect(script).toContain('Object.getOwnPropertyDescriptor(_rtcProto, "onicecandidate")');
    expect(script).toContain('_drawNoise');
    expect(script).toContain('_isSolidCanvas');
    expect(script).toContain('_isTextured');
    expect(script).toContain('_canvasVersion');
    expect(script).toContain('_imageDataCache');
    expect(script).toContain('if (p === "toString")');
    expect(script).toContain('"toDataURL");');
    expect(script).toContain('"get " + key');
    expect(script).not.toContain('_nativeFn');
    expect(script).not.toContain('_def(navigator');
    expect(script).not.toContain('_def(screen,');
    expect(script).not.toContain('navigator.mediaDevices.enumerateDevices =');
    expect(script).not.toContain('pc.addEventListener =');
    expect(script).not.toContain('Object.defineProperty(pc');
    // 语法有效性：能作为函数体被 new Function 接受
    expect(() => new Function(script)).not.toThrow();
  });

  it('禁用项 webdriver 时脚本包含隐藏逻辑', () => {
    const fp = generateFingerprint({ seed: 'env-004' });
    fp.disabledFeatures = [...fp.disabledFeatures, 'webdriver'];
    expect(buildInjectionScript(fp)).toContain('webdriver');
  });

  it('canvas=off 时不注入噪声逻辑', () => {
    const fp = { ...generateFingerprint({ seed: 'env-005' }), canvas: 'off' as const };
    expect(buildInjectionScript(fp)).not.toContain('_noisyDataUrl');
  });

  it('battery 画像不挂到 navigator 或 BatteryManager 实例上', () => {
    const fp = {
      ...generateFingerprint({ seed: 'env-battery' }),
      battery: { charging: true, level: 0.8 },
    };
    const script = buildInjectionScript(fp);
    expect(script).toContain('BatteryManager.prototype');
    expect(script).toContain('Navigator.prototype.getBattery');
    expect(script).not.toContain('navigator.getBattery =');
    expect(script).not.toContain('_def(b,');
  });
});

describe('HTTP Client Hints', () => {
  it('请求头品牌顺序与 UA-CH 完全一致', () => {
    const fp = generateFingerprint({ seed: 'hints-001' });
    const headers = buildClientHintHeaders(fp);
    expect(headers['sec-ch-ua']).toBe(
      fp.userAgentData.brands.map(({ brand, version }) => `"${brand}";v="${version}"`).join(', '),
    );
    expect(headers['sec-ch-ua-mobile']).toBe('?0');
    expect(headers['sec-ch-ua-platform']).toBe(`"${fp.userAgentData.platform}"`);
  });
});
