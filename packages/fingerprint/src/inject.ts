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
    'const _def = (obj, key, get) => { try { Object.defineProperty(obj, key, { get, configurable: true, enumerable: true }); } catch (_) {} };',
    'const _nativeFn = (name, fn) => { try { Object.defineProperty(fn, "toString", { value: () => `function ${name}() { [native code] }`, configurable: true }); } catch (_) {} return fn; };',
    // 兼容 Window 与 Worker 两种全局作用域（Worker 穿透注入时无 window/screen/document）
    'const _w = typeof window !== "undefined" ? window : self;',
    // 真浏览器的 navigator 属性都在 Navigator.prototype 上；挂到实例上会被
    // Pixelscan 的 Object.getOwnPropertyNames(navigator) 直接判定为伪造对象。
    'const _navProto = (typeof Navigator !== "undefined" && Navigator.prototype) ||',
    '  (typeof WorkerNavigator !== "undefined" && WorkerNavigator.prototype) || navigator;',
  ];

  // navigator 基础属性
  lines.push(
    // UA 在 Worker 里不吃上下文的 UA 覆盖（Chromium 行为），必须逐世界注入
    `_def(_navProto, 'userAgent', () => P.navigator.userAgent);`,
    `_def(_navProto, 'platform', () => P.navigator.platform);`,
    `_def(_navProto, 'languages', () => Object.freeze(P.navigator.languages.slice()));`,
    `_def(_navProto, 'hardwareConcurrency', () => P.navigator.hardwareConcurrency);`,
    `_def(_navProto, 'deviceMemory', () => P.navigator.deviceMemory);`,
    `_def(_navProto, 'maxTouchPoints', () => P.navigator.maxTouchPoints);`,
  );
  if (fp.disabledFeatures.includes('webdriver')) {
    lines.push(`_def(_navProto, 'webdriver', () => false);`);
  }

  // Client Hints：UA 已注入但 UA-CH 仍是真实值 = 最容易被交叉判定的矛盾点。
  // 品牌/主版本由 fingerprint 生成时与 UA 同源派生；这里补齐高熵接口。
  // 真浏览器返回稳定对象，不能每次 getter 都新建，否则 identity 检查直接暴露。
  lines.push(
    'const _uaData = (() => {',
    '  const brands = P.uaData.brands.map((b) => ({ brand: b.brand, version: b.version }));',
    '  const data = { brands, mobile: P.uaData.mobile, platform: P.uaData.platform };',
    '  const highEntropy = {',
    '    architecture: P.uaData.architecture,',
    '    bitness: P.uaData.bitness,',
    '    brands,',
    '    fullVersionList: P.uaData.brands.map((b) => ({ brand: b.brand, version: b.version === "99" ? "99.0.0.0" : P.uaData.fullVersion })),',
    '    mobile: P.uaData.mobile,',
    '    model: P.uaData.model,',
    '    platform: P.uaData.platform,',
    '    platformVersion: P.uaData.platformVersion,',
    '    uaFullVersion: P.uaData.fullVersion,',
    '    wow64: false,',
    '  };',
    '  data.getHighEntropyValues = async (hints) => {',
    '    const out = { brands, mobile: data.mobile, platform: data.platform };',
    '    for (const h of hints || []) if (h in highEntropy) out[h] = highEntropy[h];',
    '    return out;',
    '  };',
    '  if (typeof NavigatorUAData !== "undefined") {',
    '    try { Object.setPrototypeOf(data, NavigatorUAData.prototype); } catch (_) {}',
    '  }',
    '  return data;',
    '})();',
    '_def(_navProto, "userAgentData", () => _uaData);',
  );

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
      'const _spoofedGlProtos = new WeakSet();',
      'const _spoofGl = (proto) => {',
      '  if (!proto || _spoofedGlProtos.has(proto)) return;',
      '  _spoofedGlProtos.add(proto);',
      '  const orig = proto.getParameter;',
      '  const spoofed = function (p) {',
      '    if (p === 37445) return P.webgl.vendor;',
      '    if (p === 37446) return P.webgl.renderer;',
      '    return orig.call(this, p);',
      '  };',
      '  try { Object.defineProperty(spoofed, "toString", { value: () => "function getParameter() { [native code] }", configurable: true }); } catch (_) {}',
      '  proto.getParameter = spoofed;',
      '};',
      '_spoofGl(_w.WebGLRenderingContext && _w.WebGLRenderingContext.prototype);',
      '_spoofGl(_w.WebGL2RenderingContext && _w.WebGL2RenderingContext.prototype);',
      // Worker 里没有 WebGLRenderingContext 全局构造器，OffscreenCanvas 返回的上下文
      // 只能从实例原型拿到；Pixelscan 会用 Worker 复测 GPU，漏掉这里会跨世界矛盾。
      'if (_w.OffscreenCanvas && _w.OffscreenCanvas.prototype.getContext) {',
      '  const _origOffscreenContext = _w.OffscreenCanvas.prototype.getContext;',
      '  const _offscreenContext = function (type, ...args) {',
      '    const ctx = _origOffscreenContext.call(this, type, ...args);',
      '    if (ctx && /webgl/i.test(String(type))) _spoofGl(Object.getPrototypeOf(ctx));',
      '    return ctx;',
      '  };',
      '  try { Object.defineProperty(_offscreenContext, "toString", { value: () => "function getContext() { [native code] }", configurable: true }); } catch (_) {}',
      '  _w.OffscreenCanvas.prototype.getContext = _offscreenContext;',
      '}',
    );
  }

  // Canvas 确定性微噪声：同一 seed 噪声图案恒定
  if (fp.canvas === 'noise') {
    lines.push(
      // 注意：_noiseCanvas 必须读原始像素（_origGetImageData），
      // 走 hook 版会双重 XOR 相互抵消（探针实测 canvas 哈希与真实值相同而暴露）。
      'const _origGetImageData = typeof CanvasRenderingContext2D !== "undefined" ? CanvasRenderingContext2D.prototype.getImageData : null;',
      'const _origToDataURL = typeof HTMLCanvasElement !== "undefined" ? HTMLCanvasElement.prototype.toDataURL : null;',
      // 只扰动局部颜色种类 >= 3 的像素：纯色块边界只有两种颜色，必须保持原样。
      // Pixelscan 会用纯色矩形检测“是否无差别涂改画布”，直线边界不能被视为纹理。
      'const _noisePixels = (data, width, height) => {',
      '  let s = _s; // 以注入 seed 为基，逐像素推进，结果与调用次序无关',
      '  const colorAt = (p) => { const i = p * 4; return ((data[i] << 24) | (data[i + 1] << 16) | (data[i + 2] << 8) | data[i + 3]) >>> 0; };',
      '  for (let p = 0; p < width * height; p++) {',
      '    const x = p % width;',
      '    const y = (p / width) | 0;',
      '    const c0 = colorAt(p);',
      '    let c1 = -1;',
      '    let textured = false;',
      '    for (let dy = -1; dy <= 1 && !textured; dy++) {',
      '      const ny = y + dy;',
      '      if (ny < 0 || ny >= height) continue;',
      '      for (let dx = -1; dx <= 1; dx++) {',
      '        const nx = x + dx;',
      '        if ((dx === 0 && dy === 0) || nx < 0 || nx >= width) continue;',
      '        const c = colorAt(ny * width + nx);',
      '        if (c !== c0 && c !== c1) {',
      '          if (c1 < 0) c1 = c;',
      '          else { textured = true; break; }',
      '        }',
      '      }',
      '    }',
      '    if (!textured) continue;',
      '    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;',
      '    const i = p * 4;',
      '    const c = i + ((s >>> 0) % 3);',
      '    data[c] = Math.max(0, Math.min(255, data[c] + ((s & 1) ? 1 : -1)));',
      '  }',
      '};',
      'const _noisyDataUrl = (canvas, args) => {',
      '  const ctx = canvas.getContext && canvas.getContext("2d");',
      '  if (!_origToDataURL || !ctx || !canvas.width || !canvas.height || !_origGetImageData) return _origToDataURL ? _origToDataURL.apply(canvas, args) : "";',
      '  const d = _origGetImageData.call(ctx, 0, 0, canvas.width, canvas.height);',
      '  _noisePixels(d.data, d.width, d.height);',
      // 不修改原画布：复制到临时画布后读取，避免重复 toDataURL 累积漂移或被站点回读发现。
      '  const copy = document.createElement("canvas");',
      '  copy.width = canvas.width; copy.height = canvas.height;',
      '  const copyCtx = copy.getContext("2d");',
      '  if (!copyCtx) return _origToDataURL.apply(canvas, args);',
      '  copyCtx.putImageData(d, 0, 0);',
      '  return _origToDataURL.apply(copy, args);',
      '};',
      'if (_origToDataURL) {',
      'HTMLCanvasElement.prototype.toDataURL = _nativeFn("toDataURL", function (...args) { return _noisyDataUrl(this, args); });',
      '}',
      'if (_origGetImageData) {',
      'CanvasRenderingContext2D.prototype.getImageData = _nativeFn("getImageData", function (...args) {',
      '  const d = _origGetImageData.apply(this, args);',
      '  _noisePixels(d.data, d.width, d.height);',
      '  return d;',
      '});',
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
      '  const _candRe = /candidate:\\S+ \\d+ \\S+ \\d+ ([0-9a-fA-F:.]+) \\d+ typ (host|srflx|relay)/;',
      '  const _sdpCandRe = /^a=candidate:\\S+ \\d+ \\S+ \\d+ ([0-9a-fA-F:.]+) \\d+ typ (host|srflx|relay)/;',
      '  const _filterCand = (cand) => {',
      '    if (!cand || !cand.candidate) return cand;',
      '    const m = cand.candidate.match(_candRe);',
      '    if (!m) return cand;',
      '    if (P.webrtc.mode === "replace" && P.webrtc.publicIp && m[2] !== "relay") {',
      '      return new RTCIceCandidate({',
      '        candidate: cand.candidate.replace(m[1], P.webrtc.publicIp),',
      '        sdpMid: cand.sdpMid, sdpMLineIndex: cand.sdpMLineIndex, usernameFragment: cand.usernameFragment,',
      '      });',
      '    }',
      '    return null;',
      '  };',
      // BrowserLeaks 从 localDescription.sdp 直接抓候选，必须同步过滤 SDP 文本。
      '  const _filterSdp = (sdp) => {',
      '    if (!sdp) return sdp;',
      '    const eol = sdp.includes("\\r\\n") ? "\\r\\n" : "\\n";',
      '    return sdp.split(/\\r?\\n/).map((line) => {',
      '      const conn = line.match(/^c=IN (IP4|IP6) ([0-9a-fA-F:.]+)$/);',
      '      if (conn) {',
      '        if (P.webrtc.mode === "replace" && P.webrtc.publicIp) return `c=IN ${conn[1]} ${P.webrtc.publicIp}`;',
      '        return conn[1] === "IP4" ? "c=IN IP4 0.0.0.0" : "c=IN IP6 ::";',
      '      }',
      '      const m = line.match(_sdpCandRe);',
      '      if (!m) return line;',
      '      if (P.webrtc.mode === "replace" && P.webrtc.publicIp && m[2] !== "relay") return line.replace(m[1], P.webrtc.publicIp);',
      '      return null;',
      '    }).filter((line) => line !== null).join(eol);',
      '  };',
      '  const _cleanDesc = (desc) => {',
      '    if (!desc || !desc.sdp) return desc;',
      '    const sdp = _filterSdp(desc.sdp);',
      '    if (sdp === desc.sdp) return desc;',
      '    try { return new RTCSessionDescription({ type: desc.type, sdp }); } catch (_) { return { ...desc, sdp }; }',
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
      '    for (const prop of ["localDescription", "currentLocalDescription", "pendingLocalDescription"]) {',
      '      const desc = Object.getOwnPropertyDescriptor(_OrigRTC.prototype, prop);',
      '      if (!desc || !desc.get) continue;',
      '      Object.defineProperty(pc, prop, { get() { return _cleanDesc(desc.get.call(pc)); }, configurable: true });',
      '    }',
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
  lines.push(`_def(_navProto, 'serviceWorker', () => undefined);`);
  lines.push(
    'if (_w.Worker) {',
    // Pixelscan 等站点会禁用同步 XHR 读取 blob: URL，导致源码拉取失败、Worker 裸奔。
    // 在 Blob 创建和 createObjectURL 时登记源码，Worker 构造时直接取用，不发起任何请求。
    '  const _blobSource = new WeakMap();',
    '  const _blobUrlSource = new Map();',
    '  if (_w.Blob) {',
    '    const _OrigBlob = _w.Blob;',
    '    const _patchedBlob = _nativeFn("Blob", function (parts, opts) {',
    '      const blob = new _OrigBlob(parts, opts);',
    '      try {',
    '        const chunks = [];',
    '        for (const part of (parts || [])) {',
    '          if (typeof part === "string") chunks.push(part);',
    '          else if (part && _blobSource.has(part)) chunks.push(_blobSource.get(part));',
    '        }',
    '        if (chunks.length) _blobSource.set(blob, chunks.join(""));',
    '      } catch (_) {}',
    '      return blob;',
    '    });',
    '    _patchedBlob.prototype = _OrigBlob.prototype;',
    '    _w.Blob = _patchedBlob;',
    '  }',
    '  if (_w.URL && _w.URL.createObjectURL) {',
    '    const _origCreateObjectURL = _w.URL.createObjectURL;',
    '    _w.URL.createObjectURL = _nativeFn("createObjectURL", function (blob) {',
    '      const url = _origCreateObjectURL.call(this, blob);',
    '      try { if (_blobSource.has(blob)) _blobUrlSource.set(url, _blobSource.get(blob)); } catch (_) {}',
    '      return url;',
    '    });',
    '  }',
    '  const _OrigWorker = _w.Worker;',
    '  const _wrapUrl = (url) => {',
    '    try {',
    '      const s = String(url);',
    '      const same = s.startsWith("blob:") || s.startsWith("data:") || new URL(s, location.href).origin === location.origin;',
    '      if (!same || !P.__injectSrc) return url;',
    '      const mapped = _blobUrlSource.get(s);',
    '      if (mapped) return URL.createObjectURL(new Blob([P.__injectSrc, "\\n", mapped], { type: "application/javascript" }));',
    '      if (s.startsWith("data:")) {',
    '        const comma = s.indexOf(",");',
    '        if (comma < 0) return url;',
    '        const meta = s.slice(5, comma);',
    '        const body = s.slice(comma + 1);',
    '        const source = meta.includes(";base64") ? atob(body) : decodeURIComponent(body);',
    '        return URL.createObjectURL(new Blob([P.__injectSrc, "\\n", source], { type: "application/javascript" }));',
    '      }',
    '      const xhr = new XMLHttpRequest();',
    '      xhr.open("GET", s, false);',
    '      xhr.send(null);',
    '      if (xhr.status >= 400) return url;',
    '      return URL.createObjectURL(new Blob([P.__injectSrc, "\\n", xhr.responseText], { type: "application/javascript" }));',
    '    } catch (_) { return url; }',
    '  };',
    '  _w.Worker = _nativeFn("Worker", function (url, opts) { return new _OrigWorker(_wrapUrl(url), opts); });',
    '  _w.Worker.prototype = _OrigWorker.prototype;',
    '  if (_w.SharedWorker) {',
    '    const _OrigShared = _w.SharedWorker;',
    '    _w.SharedWorker = _nativeFn("SharedWorker", function (url, opts) { return new _OrigShared(_wrapUrl(url), opts); });',
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
      platform:
        fp.platform === 'macos' ? 'MacIntel' : fp.platform === 'windows' ? 'Win32' : 'Linux x86_64',
      languages: fp.languages,
      hardwareConcurrency: fp.hardware.hardwareConcurrency,
      deviceMemory: fp.hardware.deviceMemoryGb,
      maxTouchPoints: fp.hardware.maxTouchPoints,
    },
    uaData: fp.userAgentData,
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
    media: {
      audioInputs: fp.media.audioInputs,
      videoInputs: fp.media.videoInputs,
      audioOutputs: fp.media.audioOutputs,
    },
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
