// 页面内指纹采集器：三组实验共用，输出客观可 diff 的字段
window.__collectFingerprint = async function () {
  const nav = navigator;
  const out = {
    userAgent: nav.userAgent,
    webdriver: nav.webdriver,
    platform: nav.platform,
    languages: nav.languages,
    hardwareConcurrency: nav.hardwareConcurrency,
    deviceMemory: nav.deviceMemory,
    maxTouchPoints: nav.maxTouchPoints,
    vendor: nav.vendor,
    screen: {
      width: screen.width, height: screen.height,
      availWidth: screen.availWidth, availHeight: screen.availHeight,
      colorDepth: screen.colorDepth, pixelRatio: window.devicePixelRatio,
    },
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    tzOffset: new Date().getTimezoneOffset(),
    chromeObj: typeof window.chrome,
    permissions: null, plugins: nav.plugins.length, mimeTypes: nav.mimeTypes.length,
  };
  try {
    const r = await nav.permissions.query({ name: 'notifications' });
    out.permissions = r.state;
  } catch (e) { out.permissions = 'err:' + e.message; }
  // WebGL
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl');
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    out.webgl = {
      vendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
      renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      version: gl.getParameter(gl.VERSION),
    };
  } catch (e) { out.webgl = 'err:' + e.message; }
  // Canvas hash
  try {
    const c = document.createElement('canvas'); c.width = 240; c.height = 60;
    const ctx = c.getContext('2d');
    ctx.textBaseline = 'top'; ctx.font = "14px 'Arial'";
    ctx.fillStyle = '#f60'; ctx.fillRect(125, 1, 62, 20);
    ctx.fillStyle = '#069'; ctx.fillText('ShadowEdge,T0 \u{1F525}', 2, 15);
    ctx.fillStyle = 'rgba(102,204,0,0.7)'; ctx.fillText('ShadowEdge,T0 \u{1F525}', 4, 17);
    const data = c.toDataURL();
    let h = 0; for (let i = 0; i < data.length; i++) { h = ((h << 5) - h + data.charCodeAt(i)) | 0; }
    out.canvasHash = (h >>> 0).toString(16);
  } catch (e) { out.canvasHash = 'err:' + e.message; }
  // AudioContext fingerprint
  try {
    const ac = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 44100, 44100);
    const osc = ac.createOscillator(); osc.type = 'triangle'; osc.frequency.value = 10000;
    const comp = ac.createDynamicsCompressor();
    osc.connect(comp); comp.connect(ac.destination); osc.start(0);
    const buf = await ac.startRendering();
    const d = buf.getChannelData(0); let s = 0;
    for (let i = 4500; i < 5000; i++) s += Math.abs(d[i]);
    out.audioFp = s.toString();
  } catch (e) { out.audioFp = 'err:' + e.message; }
  // 注入痕迹检测（探针常用检查）
  out.traps = {
    fnToString: Function.prototype.toString.call(navigator.permissions.query).includes('[native code]'),
    errorStack: (() => { try { null.x } catch (e) { return (e.stack || '').split('\n').length } })(),
    navPropsCount: Object.getOwnPropertyNames(Navigator.prototype).length,
    hasCDC: Object.keys(window).filter(k => k.includes('cdc_') || k.includes('$cdc')),
  };
  return out;
};
