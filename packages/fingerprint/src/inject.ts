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
    // 兼容 Window 与 Worker 两种全局作用域（Worker 穿透注入时无 window/screen/document）
    'const _w = typeof window !== "undefined" ? window : self;',
  ];

  // navigator 基础属性
  lines.push(
    // UA 在 Worker 里不吃上下文的 UA 覆盖（Chromium 行为），必须逐世界注入
    `_def(navigator, 'userAgent', () => P.navigator.userAgent);`,
    `_def(navigator, 'platform', () => P.navigator.platform);`,
    `_def(navigator, 'languages', () => Object.freeze(P.navigator.languages.slice()));`,
    `_def(navigator, 'hardwareConcurrency', () => P.navigator.hardwareConcurrency);`,
    `_def(navigator, 'deviceMemory', () => P.navigator.deviceMemory);`,
    `_def(navigator, 'maxTouchPoints', () => P.navigator.maxTouchPoints);`,
  );
  if (fp.disabledFeatures.includes('webdriver')) {
    lines.push(`_def(navigator, 'webdriver', () => false);`);
  }

  // 屏幕与像素比（仅 Window 作用域存在）
  lines.push(
    'if (typeof screen !== "undefined") {',
    `_def(screen, 'width', () => P.screen.width);`,
    `_def(screen, 'height', () => P.screen.height);`,
    `_def(screen, 'availWidth', () => P.screen.availWidth);`,
    `_def(screen, 'availHeight', () => P.screen.availHeight);`,
    `_def(screen, 'colorDepth', () => P.screen.colorDepth);`,
    '}',
    'if (typeof window !== "undefined") {',
    `_def(window, 'devicePixelRatio', () => P.screen.pixelRatio);`,
    '}',
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
      '_spoofGl(_w.WebGLRenderingContext && _w.WebGLRenderingContext.prototype);',
      '_spoofGl(_w.WebGL2RenderingContext && _w.WebGL2RenderingContext.prototype);',
    );
  }

  // Canvas 确定性微噪声：同一 seed 噪声图案恒定
  if (fp.canvas === 'noise') {
    lines.push(
      // 注意：_noiseCanvas 必须读原始像素（_origGetImageData），
      // 走 hook 版会双重 XOR 相互抵消（探针实测 canvas 哈希与真实值相同而暴露）。
      'const _origGetImageData = typeof CanvasRenderingContext2D !== "undefined" ? CanvasRenderingContext2D.prototype.getImageData : null;',
      'const _noisePixels = (data) => {',
      '  let s = _s; // 以注入 seed 为基，逐像素推进，结果与调用次序无关',
      '  for (let i = 0; i < data.length; i += 997) {',
      '    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;',
      '    data[i] = data[i] ^ (s & 1);',
      '  }',
      '};',
      'const _noiseCanvas = (canvas) => {',
      '  const ctx = canvas.getContext && canvas.getContext("2d");',
      '  if (!ctx || !canvas.width || !canvas.height || !_origGetImageData) return;',
      '  const d = _origGetImageData.call(ctx, 0, 0, canvas.width, canvas.height);',
      '  _noisePixels(d.data);',
      '  ctx.putImageData(d, 0, 0);',
      '};',
      'if (typeof HTMLCanvasElement !== "undefined") {',
      'const _origToDataURL = HTMLCanvasElement.prototype.toDataURL;',
      'HTMLCanvasElement.prototype.toDataURL = function (...args) { _noiseCanvas(this); return _origToDataURL.apply(this, args); };',
      '}',
      'if (_origGetImageData) {',
      'CanvasRenderingContext2D.prototype.getImageData = function (...args) {',
      '  const d = _origGetImageData.apply(this, args);',
      '  _noisePixels(d.data);',
      '  return d;',
      '};',
      '}',
    );
  }

  // Audio 确定性微噪声
  if (fp.audio === 'noise') {
    lines.push(
      'if (typeof AudioBuffer === "undefined") { /* worker 无 AudioBuffer 跳过 */ } else {',
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
      '}',
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

  // WebRTC 候选过滤：T0/探针回归实测 --force-webrtc-ip-handling-policy 在 Chromium 156
  // 不再可靠（srflx 仍泄漏真实出口）。注入层过滤 ice candidate：
  // replace 且有 publicIp → 改写为出口 IP；否则丢弃 host/srflx（等效 disable）。
  if (fp.webrtc.mode !== 'real') {
    lines.push(
      'if (_w.RTCPeerConnection) {',
      '  const _candRe = /candidate:\\S+ \\d+ \\S+ \\d+ ([0-9a-fA-F:.]+) \\d+ typ (host|srflx)/;',
      '  const _filterCand = (cand) => {',
      '    if (!cand || !cand.candidate) return cand;',
      '    const m = cand.candidate.match(_candRe);',
      '    if (!m) return cand;',
      '    if (P.webrtc.mode === "replace" && P.webrtc.publicIp) {',
      '      return new RTCIceCandidate({',
      '        candidate: cand.candidate.replace(m[1], P.webrtc.publicIp),',
      '        sdpMid: cand.sdpMid, sdpMLineIndex: cand.sdpMLineIndex, usernameFragment: cand.usernameFragment,',
      '      });',
      '    }',
      '    return null;',
      '  };',
      '  const _OrigRTC = _w.RTCPeerConnection;',
      '  const _wrap = (pc) => {',
      '    const _origAdd = pc.addEventListener.bind(pc);',
      '    pc.addEventListener = function (type, listener, ...rest) {',
      '      if (type !== "icecandidate" || !listener) return _origAdd(type, listener, ...rest);',
      '      return _origAdd(type, (ev) => {',
      '        const c = _filterCand(ev.candidate);',
      '        if (c !== null || ev.candidate === null) listener(ev.candidate === null ? ev : { ...ev, candidate: c });',
      '      }, ...rest);',
      '    };',
      '    let _onice = null;',
      '    Object.defineProperty(pc, "onicecandidate", {',
      '      set(fn) { _onice = fn; },',
      '      get() {',
      '        return (ev) => {',
      '          const c = _filterCand(ev.candidate);',
      '          if ((c !== null || ev.candidate === null) && _onice) _onice(ev.candidate === null ? ev : { ...ev, candidate: c });',
      '        };',
      '      },',
      '      configurable: true,',
      '    });',
      '    return pc;',
      '  };',
      '  _w.RTCPeerConnection = function (...args) { return _wrap(new _OrigRTC(...args)); };',
      '  _w.RTCPeerConnection.prototype = _OrigRTC.prototype;',
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

  // Worker 穿透（探针回归实测发现）：CreepJS 在 Worker 里读 WebGL/UA，
  // addInitScript 不覆盖 Worker 全局作用域，真实 GPU/UA 在那里裸奔形成跨世界矛盾。
  // 包装 Worker：同源脚本同步拉源码、前置本注入、转 blob 启动。
  // 另：CreepJS 优先选 ServiceWorker（register 直拉 URL 无法注入），屏蔽之迫使其
  // 回退到 Shared/Dedicated（均可包装）；这是反检测浏览器的通行做法。
  lines.push(
    `_def(navigator, 'serviceWorker', () => undefined);`,
  );
  lines.push(
    'if (_w.Worker) {',
    '  const _OrigWorker = _w.Worker;',
    '  const _wrapUrl = (url) => {',
    '    try {',
    '      const s = String(url);',
    '      const same = s.startsWith("blob:") || s.startsWith("data:") || new URL(s, location.href).origin === location.origin;',
    '      if (!same || !P.__injectSrc) return url;',
    '      const xhr = new XMLHttpRequest();',
    '      xhr.open("GET", s, false);',
    '      xhr.send(null);',
    '      if (xhr.status >= 400) return url;',
    '      return URL.createObjectURL(new Blob([P.__injectSrc, "\\n", xhr.responseText], { type: "application/javascript" }));',
    '    } catch (_) { return url; }',
    '  };',
    '  _w.Worker = function (url, opts) { return new _OrigWorker(_wrapUrl(url), opts); };',
    '  _w.Worker.prototype = _OrigWorker.prototype;',
    '  if (_w.SharedWorker) {',
    '    const _OrigShared = _w.SharedWorker;',
    '    _w.SharedWorker = function (url, opts) { return new _OrigShared(_wrapUrl(url), opts); };',
    '    _w.SharedWorker.prototype = _OrigShared.prototype;',
    '  }',
    '}',
  );

  lines.push('})();');

  // 注入源码自引用：Worker 包装需要把整段脚本带过去。嵌套 Worker（Worker 再生 Worker）不递归。
  const body = lines.join('\n'); // 末尾已是 IIFE 闭合 })();
  const assign = `try { P.__injectSrc = ${JSON.stringify(body)}; } catch (_) {}`;
  return body.replace(/\}\)\(\);\s*$/, assign + '\n})();');
}

/** 注入所需的最小画像子集（避免把无用字段带进页面世界）。 */
function serializeForInjection(fp: FingerprintProfile) {
  return {
    navigator: {
      userAgent: fp.userAgent,
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
    webrtc: { mode: fp.webrtc.mode, publicIp: fp.webrtc.publicIp },
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
