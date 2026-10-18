import type { FingerprintProfile } from '@shadowedge/core';

/**
 * 由 FingerprintProfile 生成注入主世界的确定性 JS（方案 A：Patchright init script）。
 * 同一 profile（含 seed）必须产出逐字节一致的脚本 —— 这是指纹零漂移的根基，
 * 因此脚本内禁止出现 Math.random()/Date.now() 等非确定源。
 */
export function buildInjectionScript(fp: FingerprintProfile): string {
  const noiseSeed = fnv1a(fp.seed);
  const lines: string[] = [
    '/* shadowedge-fingerprint: deterministic injection, seed=' + fp.seed + ' */',
    '(() => {',
    '"use strict";',
    `const P = ${JSON.stringify(serializeForInjection(fp))};`,
    `let _s = ${noiseSeed} >>> 0;`,
    'const _rnd = () => { _s ^= _s << 13; _s ^= _s >>> 17; _s ^= _s << 5; return (_s >>> 0) / 4294967296; };',
    'const _def = (obj, key, get) => { try { Object.defineProperty(obj, key, { get, configurable: true }); } catch (_) {} };',
  ];

  // navigator 基础属性
  lines.push(
    `_def(navigator, 'platform', () => P.navigator.platform);`,
    `_def(navigator, 'languages', () => Object.freeze(P.navigator.languages.slice()));`,
    `_def(navigator, 'hardwareConcurrency', () => P.navigator.hardwareConcurrency);`,
    `_def(navigator, 'deviceMemory', () => P.navigator.deviceMemory);`,
    `_def(navigator, 'maxTouchPoints', () => P.navigator.maxTouchPoints);`,
  );
  if (fp.disabledFeatures.includes('webdriver')) {
    lines.push(`_def(navigator, 'webdriver', () => false);`);
  }

  // 屏幕与像素比
  lines.push(
    `_def(screen, 'width', () => P.screen.width);`,
    `_def(screen, 'height', () => P.screen.height);`,
    `_def(screen, 'availWidth', () => P.screen.availWidth);`,
    `_def(screen, 'availHeight', () => P.screen.availHeight);`,
    `_def(screen, 'colorDepth', () => P.screen.colorDepth);`,
    `_def(window, 'devicePixelRatio', () => P.screen.pixelRatio);`,
  );

  // WebGL vendor/renderer（WebGL1 + WebGL2 双上下文）
  if (fp.webgl.noise !== 'real') {
    lines.push(
      'const _spoofGl = (proto) => {',
      '  if (!proto) return;',
      '  const orig = proto.getParameter;',
      '  proto.getParameter = function (p) {',
      '    if (p === 37445) return P.webgl.vendor;',
      '    if (p === 37446) return P.webgl.renderer;',
      '    return orig.call(this, p);',
      '  };',
      '};',
      '_spoofGl(window.WebGLRenderingContext && WebGLRenderingContext.prototype);',
      '_spoofGl(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype);',
    );
  }

  // Canvas 确定性微噪声：同一 seed 噪声图案恒定
  if (fp.canvas === 'noise') {
    lines.push(
      'const _noiseCanvas = (canvas) => {',
      '  const ctx = canvas.getContext && canvas.getContext("2d");',
      '  if (!ctx || !canvas.width || !canvas.height) return;',
      '  let s = _s; // 以注入 seed 为基，逐像素推进，结果与调用次序无关',
      '  const d = ctx.getImageData(0, 0, canvas.width, canvas.height);',
      '  for (let i = 0; i < d.data.length; i += 997) {',
      '    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;',
      '    d.data[i] = d.data[i] ^ (s & 1);',
      '  }',
      '  ctx.putImageData(d, 0, 0);',
      '};',
      'const _origToDataURL = HTMLCanvasElement.prototype.toDataURL;',
      'HTMLCanvasElement.prototype.toDataURL = function (...args) { _noiseCanvas(this); return _origToDataURL.apply(this, args); };',
      'const _origGetImageData = CanvasRenderingContext2D.prototype.getImageData;',
      'CanvasRenderingContext2D.prototype.getImageData = function (...args) {',
      '  const d = _origGetImageData.apply(this, args);',
      '  let s = _s;',
      '  for (let i = 0; i < d.data.length; i += 997) { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; d.data[i] = d.data[i] ^ (s & 1); }',
      '  return d;',
      '};',
    );
  }

  // Audio 确定性微噪声
  if (fp.audio === 'noise') {
    lines.push(
      'const _origGetChannelData = AudioBuffer.prototype.getChannelData;',
      'AudioBuffer.prototype.getChannelData = function (ch) {',
      '  const data = _origGetChannelData.call(this, ch);',
      '  let s = (_s + ch) >>> 0;',
      '  for (let i = 0; i < data.length; i += 499) {',
      '    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;',
      '    data[i] = data[i] + ((s >>> 8) % 1000 - 500) * 1e-8;',
      '  }',
      '  return data;',
      '};',
    );
  }

  // 电池画像
  if (fp.battery) {
    lines.push(
      'if (navigator.getBattery) {',
      '  const _origBattery = navigator.getBattery.bind(navigator);',
      '  navigator.getBattery = () => _origBattery().then((b) => {',
      "    _def(b, 'charging', () => P.battery.charging);",
      "    _def(b, 'level', () => P.battery.level);",
      '    return b;',
      '  });',
      '}',
    );
  }

  // 媒体设备数量画像（仅在明确配置时覆盖）
  if (fp.media && (fp.media.audioInputs || fp.media.videoInputs || fp.media.audioOutputs)) {
    lines.push(
      'if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {',
      '  const _origEnum = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);',
      '  navigator.mediaDevices.enumerateDevices = async () => {',
      '    const real = await _origEnum();',
      '    const mk = (kind, n, label) => Array.from({ length: n }, (_, i) => ({',
      '      deviceId: `shadowedge-${kind}-${i}`, kind, label: `${label} ${i + 1}`, groupId: `shadowedge-group-${i}`,',
      '      toJSON() { return { deviceId: this.deviceId, kind: this.kind, label: this.label, groupId: this.groupId }; },',
      '    }));',
      '    return [',
      "      ...mk('audioinput', P.media.audioInputs, 'Microphone'),",
      "      ...mk('videoinput', P.media.videoInputs, 'Camera'),",
      "      ...mk('audiooutput', P.media.audioOutputs, 'Speaker'),",
      '      ...real.filter((d) => !["audioinput", "videoinput", "audiooutput"].includes(d.kind)),',
      '    ];',
      '  };',
      '}',
    );
  }

  lines.push('})();');
  return lines.join('\n');
}

/** 注入所需的最小画像子集（避免把无用字段带进页面世界）。 */
function serializeForInjection(fp: FingerprintProfile) {
  return {
    navigator: {
      platform: fp.platform === 'macos' ? 'MacIntel' : fp.platform === 'windows' ? 'Win32' : 'Linux x86_64',
      languages: fp.languages,
      hardwareConcurrency: fp.hardware.hardwareConcurrency,
      deviceMemory: fp.hardware.deviceMemoryGb,
      maxTouchPoints: fp.hardware.maxTouchPoints,
    },
    screen: {
      width: fp.screen.width,
      height: fp.screen.height,
      availWidth: fp.screen.availWidth,
      availHeight: fp.screen.availHeight,
      colorDepth: fp.screen.colorDepth,
      pixelRatio: fp.screen.pixelRatio,
    },
    webgl: { vendor: fp.webgl.vendor, renderer: fp.webgl.renderer },
    battery: fp.battery ? { charging: fp.battery.charging, level: fp.battery.level } : undefined,
    media: { audioInputs: fp.media.audioInputs, videoInputs: fp.media.videoInputs, audioOutputs: fp.media.audioOutputs },
  };
}

/** FNV-1a 32 位字符串哈希：把 seed 字符串折叠为确定性数值噪声种子。 */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
