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
    // Function.prototype.toString.call(fn) 会绕过 fn.toString 的自定义属性；Proxy 才能让
    // 包装后的函数在原生 toString 检查下仍返回 native code。
    // Proxy 的 Function.prototype.toString 只返回匿名的 "function () { [native code] }"（32 字符），
    // Pixelscan 会校验 toDataURL.toString() 必须是 38/42 字符的原生形态。用 get 陷阱返回
    // 带函数名的 toString，同时让 Function.prototype.toString.call 继续走 Proxy 内部、不泄漏源码。
    'const _proxy = (target, handler, name) => { try {',
    '  if (!name) return new Proxy(target, handler);',
    '  try { Object.defineProperty(target, "name", { value: name, configurable: true }); } catch (_) {}',
    '  let toStr = null;',
    '  const h = Object.assign({}, handler, { get(t, p, r) {',
    '    if (p === "toString") { if (!toStr) toStr = function () { return "function " + name + "() { [native code] }"; }; return toStr; }',
    '    if (p === "name") return name;',
    '    return Reflect.get(t, p, r);',
    '  } });',
    '  return new Proxy(target, h);',
    '} catch (_) { return target; } };',
    'const _def = (obj, key, get) => { try { const proxy = _proxy(get, { apply: (target, thisArg, args) => Reflect.apply(target, thisArg, args) }, "get " + key); Object.defineProperty(obj, key, { get: proxy, configurable: true, enumerable: true }); } catch (_) {} };',
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
  // navigator.userAgentData 的对象 identity 必须稳定，但 brands 在原生实现里
  // 每次读取都是新的冻结数组，不能在实例上缓存成自有属性。
  lines.push(
    'const _uaData = (() => {',
    '  let native = null;',
    '  try { native = navigator.userAgentData; } catch (_) {}',
    '  if (native) return native;',
    '  try { return Object.create(NavigatorUAData.prototype); } catch (_) { return {}; }',
    '})();',
    'const _uaBrands = () => Object.freeze(P.uaData.brands.map((b) => ({ brand: b.brand, version: b.version })));',
    'const _uaFullVersionBrands = () => Object.freeze(P.uaData.brands.map((b) => ({ brand: b.brand, version: b.version === "99" ? "99.0.0.0" : P.uaData.fullVersion })));',
    'if (typeof NavigatorUAData !== "undefined" && NavigatorUAData.prototype) {',
    '  const _uaProto = NavigatorUAData.prototype;',
    '  _def(_uaProto, "brands", _uaBrands);',
    '  _def(_uaProto, "mobile", () => P.uaData.mobile);',
    '  _def(_uaProto, "platform", () => P.uaData.platform);',
    '  const _getHighEntropyValues = async (hints) => {',
    '    const highEntropy = {',
    '      architecture: P.uaData.architecture,',
    '      bitness: P.uaData.bitness,',
    '      brands: _uaBrands(),',
    '      fullVersionList: _uaFullVersionBrands(),',
    '      mobile: P.uaData.mobile,',
    '      model: P.uaData.model,',
    '      platform: P.uaData.platform,',
    '      platformVersion: P.uaData.platformVersion,',
    '      uaFullVersion: P.uaData.fullVersion,',
    '      wow64: false,',
    '    };',
    '    const out = { brands: _uaBrands(), mobile: P.uaData.mobile, platform: P.uaData.platform };',
    '    for (const h of hints || []) if (h in highEntropy) out[h] = highEntropy[h];',
    '    return out;',
    '  };',
    '  const _patchedGetHighEntropy = _proxy(_getHighEntropyValues, { apply: (target, thisArg, args) => Reflect.apply(target, thisArg, args) }, "getHighEntropyValues");',
    '  Object.defineProperty(_uaProto, "getHighEntropyValues", { value: _patchedGetHighEntropy, writable: true, enumerable: true, configurable: true });',
    '  const _toJSON = _proxy(function toJSON() { return { brands: _uaBrands(), mobile: P.uaData.mobile, platform: P.uaData.platform }; }, { apply: (target, thisArg, args) => Reflect.apply(target, thisArg, args) }, "toJSON");',
    '  Object.defineProperty(_uaProto, "toJSON", { value: _toJSON, writable: true, enumerable: true, configurable: true });',
    '}',
    '_def(_navProto, "userAgentData", () => _uaData);',
  );

  // 屏幕与像素比（仅 Window 作用域存在）
  lines.push(
    // screen 的属性必须落在 Screen.prototype；挂到实例上会让
    // Object.getOwnPropertyNames(screen) 从 [] 变成伪造特征。
    'if (typeof Screen !== "undefined" && Screen.prototype) {',
    `_def(Screen.prototype, 'width', () => P.screen.width);`,
    `_def(Screen.prototype, 'height', () => P.screen.height);`,
    `_def(Screen.prototype, 'availWidth', () => P.screen.availWidth);`,
    `_def(Screen.prototype, 'availHeight', () => P.screen.availHeight);`,
    `_def(Screen.prototype, 'colorDepth', () => P.screen.colorDepth);`,
    // colorDepth 与 pixelDepth 在真实设备上通常相同；只改 colorDepth 会留下 24 vs 30 的矛盾。
    `_def(Screen.prototype, 'pixelDepth', () => P.screen.colorDepth);`,
    '}',
    'if (typeof window !== "undefined") {',
    // 原生的 window.devicePixelRatio 是自有 accessor 且带 setter；
    // 只定义 getter 会被 descriptor 对比抓到（set 从原生函数变成 undefined）。
    '  const _dprDesc = Object.getOwnPropertyDescriptor(window, "devicePixelRatio");',
    `  const _dprGet = _proxy(() => P.screen.pixelRatio, { apply: (target, thisArg, args) => Reflect.apply(target, thisArg, args) }, "get devicePixelRatio");`,
    '  Object.defineProperty(window, "devicePixelRatio", {',
    '    get: _dprGet,',
    '    set: _dprDesc && _dprDesc.set,',
    '    enumerable: true,',
    '    configurable: true,',
    '  });',
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
      '  proto.getParameter = _proxy(orig, { apply: (target, thisArg, args) => {',
      '    const p = args[0];',
      '    if (p === 37445) return P.webgl.vendor;',
      '    if (p === 37446) return P.webgl.renderer;',
      '    return Reflect.apply(target, thisArg, args);',
      '  } }, "getParameter");',
      '};',
      '_spoofGl(_w.WebGLRenderingContext && _w.WebGLRenderingContext.prototype);',
      '_spoofGl(_w.WebGL2RenderingContext && _w.WebGL2RenderingContext.prototype);',
      // Worker 里没有 WebGLRenderingContext 全局构造器，OffscreenCanvas 返回的上下文
      // 只能从实例原型拿到；Pixelscan 会用 Worker 复测 GPU，漏掉这里会跨世界矛盾。
      'if (_w.OffscreenCanvas && _w.OffscreenCanvas.prototype.getContext) {',
      '  const _origOffscreenContext = _w.OffscreenCanvas.prototype.getContext;',
      '  _w.OffscreenCanvas.prototype.getContext = _proxy(_origOffscreenContext, { apply: (target, thisArg, args) => {',
      '    const type = args[0];',
      '    const ctx = Reflect.apply(target, thisArg, args);',
      '    if (ctx && /webgl/i.test(String(type))) _spoofGl(Object.getPrototypeOf(ctx));',
      '    return ctx;',
      '  } }, "getContext");',
      '}',
    );
  }

  // Canvas 确定性微噪声：同一 seed 噪声图案恒定
  if (fp.canvas === 'noise') {
    lines.push(
      'const _origGetImageData = typeof CanvasRenderingContext2D !== "undefined" ? CanvasRenderingContext2D.prototype.getImageData : null;',
      'const _origToDataURL = typeof HTMLCanvasElement !== "undefined" ? HTMLCanvasElement.prototype.toDataURL : null;',
      // 当前 Chromium 对纹理画布的 getImageData 每次返回值不同；toDataURL 反而稳定。
      // 因此导出路径必须走原生编码，不能用 getImageData 作为噪声输入。
      'const _canvasVersion = new WeakMap();',
      'const _bumpCanvas = (ctx) => { const canvas = ctx && ctx.canvas; if (canvas) _canvasVersion.set(canvas, (_canvasVersion.get(canvas) || 0) + 1); };',
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
      'const _drawNoise = (ctx, canvas) => {',
      '  let s = _s, drew = false;',
      '  const count = Math.max(16, Math.min(64, ((canvas.width * canvas.height) / 1000) | 0));',
      // 噪声点只落在真正的纹理区域：纯色块、色块边界与文字留白必须逐字节保持原样，
      // 否则 Pixelscan 的纯色检测会看到“画布被无差别涂改”。
      '  const _isTextured = (x, y) => {',
      '    if (!_origGetImageData) return true;',
      '    try {',
      // 5x5 + >=5 种颜色：1px 抗锯齿边界最多只有 3 种颜色，
      // 而文字/纹理/照片区域会迅速超过 5 种，可避免噪声点落在色块上。
      '      const x0 = Math.max(0, x - 2), y0 = Math.max(0, y - 2);',
      '      const w = Math.min(5, canvas.width - x0), h = Math.min(5, canvas.height - y0);',
      '      const d = _origGetImageData.call(ctx, x0, y0, w, h).data;',
      '      const seen = new Set();',
      '      for (let i = 0; i < d.length; i += 4) {',
      '        const c = ((d[i] << 24) | (d[i + 1] << 16) | (d[i + 2] << 8) | d[i + 3]) >>> 0;',
      '        seen.add(c);',
      '        if (seen.size >= 5) return true;',
      '      }',
      '      return false;',
      '    } catch (_) { return true; }',
      '  };',
      '  for (let i = 0; i < count; i++) {',
      '    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;',
      '    const x = (s >>> 0) % canvas.width;',
      '    const y = ((s >>> 8) >>> 0) % canvas.height;',
      '    if (!_isTextured(x, y)) continue;',
      '    ctx.fillStyle = (s & 1) ? "rgba(255,255,255,0.01)" : "rgba(0,0,0,0.01)";',
      '    ctx.fillRect(x, y, 1, 1);',
      '    drew = true;',
      '  }',
      '  return drew;',
      '};',
      // 采样式纯色判断：不读取整张画布（Chromium 对纹理画布的 getImageData 不稳定），
      // 只在网格点上比对颜色，足以识别纯色测试块。
      'const _isSolidCanvas = (ctx, width, height) => {',
      '  if (!_origGetImageData) return false;',
      '  try {',
      '    const stepX = Math.max(1, (width / 8) | 0);',
      '    const stepY = Math.max(1, (height / 8) | 0);',
      '    let base = null;',
      '    for (let y = 0; y < height; y += stepY) {',
      '      for (let x = 0; x < width; x += stepX) {',
      '        const d = _origGetImageData.call(ctx, x, y, 1, 1).data;',
      '        if (!base) base = [d[0], d[1], d[2], d[3]];',
      '        else if (d[0] !== base[0] || d[1] !== base[1] || d[2] !== base[2] || d[3] !== base[3]) return false;',
      '      }',
      '    }',
      '    return true;',
      '  } catch (_) { return false; }',
      '};',
      'const _canvasUrlCache = new WeakMap();',
      'const _imageDataCache = new WeakMap();',
      'const _noisyDataUrl = (canvas, args) => {',
      '  if (!_origToDataURL) return "";',
      '  try {',
      '    const version = _canvasVersion.get(canvas) || 0;',
      '    const key = version + "|" + String(args);',
      '    const cached = _canvasUrlCache.get(canvas);',
      '    if (cached && cached.key === key) return cached.url;',
      '    const copy = document.createElement("canvas");',
      '    copy.width = canvas.width; copy.height = canvas.height;',
      '    const copyCtx = copy.getContext("2d");',
      '    if (!copyCtx) return _origToDataURL.apply(canvas, args);',
      '    copyCtx.drawImage(canvas, 0, 0);',
      '    let url;',
      '    if (_isSolidCanvas(copyCtx, copy.width, copy.height) || !_drawNoise(copyCtx, copy)) {',
      // 没有落点时直接编码原画布：连 drawImage 的一次像素复制都省掉，
      // 保证纯色块/色块检测图与未注入浏览器逐字节一致。
      '      url = _origToDataURL.apply(canvas, args);',
      '    } else {',
      '      url = _origToDataURL.apply(copy, args);',
      '    }',
      '    _canvasUrlCache.set(canvas, { key, url });',
      '    return url;',
      '  } catch (_) { return _origToDataURL.apply(canvas, args); }',
      '};',
      'if (_origToDataURL) {',
      'HTMLCanvasElement.prototype.toDataURL = _proxy(_origToDataURL, { apply: (target, thisArg, args) => _noisyDataUrl(thisArg, args) }, "toDataURL");',
      '}',
      'if (_origGetImageData) {',
      'CanvasRenderingContext2D.prototype.getImageData = _proxy(_origGetImageData, { apply: (target, thisArg, args) => {',
      '  const d = Reflect.apply(target, thisArg, args);',
      '  const canvas = thisArg && thisArg.canvas;',
      '  const version = canvas ? (_canvasVersion.get(canvas) || 0) : 0;',
      '  const key = version + "|" + String(args);',
      '  const cached = canvas ? _imageDataCache.get(canvas) : null;',
      '  if (cached && cached.key === key) return new ImageData(new Uint8ClampedArray(cached.data.data), cached.data.width, cached.data.height);',
      '  const out = new ImageData(new Uint8ClampedArray(d.data), d.width, d.height);',
      '  _noisePixels(out.data, out.width, out.height);',
      '  if (canvas) _imageDataCache.set(canvas, { key, data: out });',
      '  return new ImageData(new Uint8ClampedArray(out.data), out.width, out.height);',
      '} }, "getImageData");',
      '}',
      // Worker 里没有 CanvasRenderingContext2D；不守卫会让整段 Worker 注入抛错并静默超时。
      'if (typeof CanvasRenderingContext2D !== "undefined") {',
      '  for (const _name of ["fillRect","strokeRect","clearRect","fillText","strokeText","drawImage","putImageData","fill","stroke","reset"]) {',
      '    const _orig = CanvasRenderingContext2D.prototype[_name];',
      '    if (typeof _orig !== "function") continue;',
      '    CanvasRenderingContext2D.prototype[_name] = _proxy(_orig, { apply: (target, thisArg, args) => { _bumpCanvas(thisArg); return Reflect.apply(target, thisArg, args); } }, _name);',
      '  }',
      '}',
    );
  }

  // Audio 确定性微噪声
  if (fp.audio === 'noise') {
    lines.push(
      'if (typeof AudioBuffer === "undefined") { /* worker 无 AudioBuffer 跳过 */ } else {',
      'const _origGetChannelData = AudioBuffer.prototype.getChannelData;',
      'AudioBuffer.prototype.getChannelData = _proxy(_origGetChannelData, { apply: (target, thisArg, args) => {',
      '  const ch = args[0];',
      '  const data = Reflect.apply(target, thisArg, args);',
      '  let s = (_s + ch) >>> 0;',
      '  for (let i = 0; i < data.length; i += 499) {',
      '    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;',
      '    data[i] = data[i] + ((s >>> 8) % 1000 - 500) * 1e-8;',
      '  }',
      '  return data;',
      '} }, "getChannelData");',
      '}',
    );
  }

  // 电池画像
  if (fp.battery) {
    lines.push(
      'if (typeof Navigator !== "undefined" && Navigator.prototype.getBattery && typeof BatteryManager !== "undefined" && BatteryManager.prototype) {',
      // 与 Screen 同理：BatteryManager 的属性属于原型，挂到实例上会留下自有属性。
      "  _def(BatteryManager.prototype, 'charging', () => P.battery.charging);",
      "  _def(BatteryManager.prototype, 'level', () => P.battery.level);",
      '  const _origBattery = Navigator.prototype.getBattery;',
      '  const _patchedBattery = _proxy(_origBattery, { apply: (target, thisArg, args) => Reflect.apply(target, thisArg, args) }, "getBattery");',
      '  Object.defineProperty(Navigator.prototype, "getBattery", {',
      '    value: _patchedBattery, writable: true, enumerable: true, configurable: true,',
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
      // 地址不能限定为 IP 字符集：Chromium 默认给 host candidate 发 mDNS UUID（带连字符），
      // 旧正则匹配不到就会把 mDNS 主机名原样留在 SDP 里。
      '  const _candRe = /candidate:\\S+ \\d+ \\S+ \\d+ ([^\\s]+) \\d+ typ (host|srflx|relay)/;',
      '  const _sdpCandRe = /^a=candidate:\\S+ \\d+ \\S+ \\d+ ([^\\s]+) \\d+ typ (host|srflx|relay)/;',
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
      '  const _rtcProto = _OrigRTC.prototype;',
      // 只改原型、不改实例：实例自有属性是探针最容易抓到的伪造信号。
      // addEventListener 原生位于 EventTarget.prototype，这里按事件类型条件拦截，
      // 保持属性位置和 descriptor 不变。
      '  if (_w.EventTarget && _w.EventTarget.prototype.addEventListener) {',
      '    const _origAdd = _w.EventTarget.prototype.addEventListener;',
      '    _w.EventTarget.prototype.addEventListener = _proxy(_origAdd, { apply: (target, thisArg, args) => {',
      '      if (!(thisArg instanceof _OrigRTC) || args[0] !== "icecandidate" || typeof args[1] !== "function") return Reflect.apply(target, thisArg, args);',
      '      const listener = args[1];',
      '      const wrapped = (ev) => {',
      '        const c = _filterCand(ev.candidate);',
      '        if (c !== null || ev.candidate === null) listener.call(thisArg, ev.candidate === null ? ev : { ...ev, candidate: c });',
      '      };',
      '      return Reflect.apply(target, thisArg, [args[0], wrapped, ...args.slice(2)]);',
      '    } }, "addEventListener");',
      '  }',
      '  const _onDesc = Object.getOwnPropertyDescriptor(_rtcProto, "onicecandidate");',
      '  if (_onDesc && _onDesc.get && _onDesc.set) {',
      '    const _onice = new WeakMap();',
      '    Object.defineProperty(_rtcProto, "onicecandidate", {',
      '      get() { return _onice.has(this) ? _onice.get(this) : _onDesc.get.call(this); },',
      '      set(fn) {',
      '        if (typeof fn !== "function") { _onice.delete(this); _onDesc.set.call(this, fn); return; }',
      '        _onice.set(this, fn);',
      '        _onDesc.set.call(this, (ev) => {',
      '          const c = _filterCand(ev.candidate);',
      '          if (c !== null || ev.candidate === null) fn.call(this, ev.candidate === null ? ev : { ...ev, candidate: c });',
      '        });',
      '      },',
      '      enumerable: _onDesc.enumerable,',
      '      configurable: _onDesc.configurable,',
      '    });',
      '  }',
      '  for (const prop of ["localDescription", "currentLocalDescription", "pendingLocalDescription"]) {',
      '    const desc = Object.getOwnPropertyDescriptor(_rtcProto, prop);',
      '    if (!desc || !desc.get) continue;',
      '    Object.defineProperty(_rtcProto, prop, {',
      '      get: _proxy(function () { return _cleanDesc(desc.get.call(this)); }, { apply: (target, thisArg, args) => Reflect.apply(target, thisArg, args) }, "get " + prop),',
      '      set: desc.set,',
      '      enumerable: desc.enumerable,',
      '      configurable: desc.configurable,',
      '    });',
      '  }',
      '}',
    );
  }

  // 媒体设备数量画像（仅在明确配置时覆盖）
  if (fp.media && (fp.media.audioInputs || fp.media.videoInputs || fp.media.audioOutputs)) {
    lines.push(
      // 方法必须落在 MediaDevices.prototype；实例自有方法会让
      // Object.getOwnPropertyNames(navigator.mediaDevices) 非空，且 toString 暴露注入源码。
      'if (typeof MediaDevices !== "undefined" && MediaDevices.prototype && MediaDevices.prototype.enumerateDevices && navigator.mediaDevices) {',
      '  const _origEnum = MediaDevices.prototype.enumerateDevices;',
      '  const _enum = _proxy(_origEnum, {',
      '    apply: (target, thisArg, args) => Reflect.apply(target, thisArg, args).then((real) => {',
      '      const mk = (kind, n, label) => Array.from({ length: n }, (_, i) => ({',
      '        deviceId: `shadowedge-${kind}-${i}`, kind, label: `${label} ${i + 1}`, groupId: `shadowedge-group-${i}`,',
      '        toJSON() { return { deviceId: this.deviceId, kind: this.kind, label: this.label, groupId: this.groupId }; },',
      '      }));',
      '      return [',
      "        ...mk('audioinput', P.media.audioInputs, 'Microphone'),",
      "        ...mk('videoinput', P.media.videoInputs, 'Camera'),",
      "        ...mk('audiooutput', P.media.audioOutputs, 'Speaker'),",
      '        ...real.filter((d) => !["audioinput", "videoinput", "audiooutput"].includes(d.kind)),',
      '      ];',
      '    }),',
      '  }, "enumerateDevices");',
      '  Object.defineProperty(MediaDevices.prototype, "enumerateDevices", {',
      '    value: _enum, writable: true, enumerable: true, configurable: true,',
      '  });',
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
    '    const _patchedBlob = _proxy(_OrigBlob, { construct: (target, args) => {',
    '      const blob = Reflect.construct(target, args);',
    '      const parts = args[0];',
    '      try {',
    '        const chunks = [];',
    '        for (const part of (parts || [])) {',
    '          if (typeof part === "string") chunks.push(part);',
    '          else if (part && _blobSource.has(part)) chunks.push(_blobSource.get(part));',
    '        }',
    '        if (chunks.length) _blobSource.set(blob, chunks.join(""));',
    '      } catch (_) {}',
    '      return blob;',
    '    } }, "Blob");',
    '    _w.Blob = _patchedBlob;',
    '  }',
    '  if (_w.URL && _w.URL.createObjectURL) {',
    '    const _origCreateObjectURL = _w.URL.createObjectURL;',
    '    _w.URL.createObjectURL = _proxy(_origCreateObjectURL, { apply: (target, thisArg, args) => {',
    '      const blob = args[0];',
    '      const url = Reflect.apply(target, thisArg, args);',
    '      try { if (_blobSource.has(blob)) _blobUrlSource.set(url, _blobSource.get(blob)); } catch (_) {}',
    '      return url;',
    '    } }, "createObjectURL");',
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
    '  _w.Worker = _proxy(_OrigWorker, { construct: (target, args) => Reflect.construct(target, [_wrapUrl(args[0]), args[1]]) }, "Worker");',
    '  if (_w.SharedWorker) {',
    '    const _OrigShared = _w.SharedWorker;',
    '    _w.SharedWorker = _proxy(_OrigShared, { construct: (target, args) => Reflect.construct(target, [_wrapUrl(args[0]), args[1]]) }, "SharedWorker");',
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
