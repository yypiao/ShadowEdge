/**
 * 探针回归网（阶段三）：用真实产品链路（fingerprint 生成 → 注入 → 中继 → Patchright）
 * 跑外部探针 + 本地采集，输出可 diff 的量化报告。
 *
 * 用法：
 *   node experiments/probes/run.mjs --seed demo-1 --proxy os1 --label baseline
 *   node experiments/probes/run.mjs --seed demo-1            # 直连（仅本地采集，跳过 CreepJS）
 *
 * 产出：experiments/probes/results/<label>-<ts>.json + 控制台摘要
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildClientHintHeaders,
  deriveGeoOverrides,
  generateFingerprint,
} from '/Users/mac/ShadowEdge/packages/fingerprint/dist/index.js';
import { buildInjectionScript } from '/Users/mac/ShadowEdge/packages/fingerprint/dist/inject.js';
import { startRelay, checkProxyHealth } from '/Users/mac/ShadowEdge/packages/proxy/dist/index.js';
import { chromium } from '/Users/mac/ShadowEdge/apps/desktop/node_modules/patchright/index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((a, i, arr) => (a.startsWith('--') ? [a.slice(2), arr[i + 1]] : null))
    .filter(Boolean),
);
const SEED = args.seed ?? 'probe-demo';
const LABEL = args.label ?? new Date().toISOString().slice(0, 10);
const PROXY_ID = args.proxy; // experiments/.secrets/test-proxies.json 里的 id
const UPSTREAM_RAW =
  args.upstream ?? process.env.SHADOWEDGE_PROBE_UPSTREAM ?? 'http://127.0.0.1:7897';
const FAIL_UNDER = Number(args['fail-under'] ?? (PROXY_ID ? 27 : 0));
if (!Number.isInteger(FAIL_UNDER) || FAIL_UNDER < 0) {
  throw new Error(`--fail-under 必须是非负整数，收到 ${args['fail-under']}`);
}
const CREEPJS = 'https://abrahamjuliot.github.io/creepjs/';
const BROWSERLEAKS = 'https://browserleaks.com/webrtc';
const PIXELSCAN = 'https://pixelscan.net/';

const log = (...a) => console.log('[probe]', ...a);
const firstMatch = (text, re) => text.match(re)?.[1]?.trim() ?? null;
const percentOf = (text) => {
  const m = text?.match(/(\d+(?:\.\d+)?)%/);
  return m ? Number(m[1]) : null;
};
const isPrivateIp = (ip) => {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255))
    return false;
  return (
    parts[0] === 10 ||
    parts[0] === 127 ||
    parts[0] === 0 ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127)
  );
};
const readSelectorText = async (page, selector) => {
  try {
    return (await page.locator(selector).first().innerText({ timeout: 1500 })).trim();
  } catch {
    return null;
  }
};

const parseUpstream = (value) => {
  const url = new URL(value);
  if (url.protocol !== 'http:') throw new Error(`上游必须是 http://，收到 ${url.protocol}`);
  return { protocol: 'http', host: url.hostname, port: Number(url.port || 80) };
};

// ---- 1. 代理与中继（可选）----
let relay, expectedGeo;
if (PROXY_ID) {
  const secrets = JSON.parse(
    readFileSync('/Users/mac/ShadowEdge/experiments/.secrets/test-proxies.json', 'utf8'),
  );
  const p = secrets.find((x) => x.id === PROXY_ID);
  if (!p) throw new Error(`代理 ${PROXY_ID} 不在 secrets 文件里`);
  const upstream = parseUpstream(UPSTREAM_RAW);
  const cred = {
    id: p.id,
    orgId: 'local',
    label: p.id,
    protocol: 'socks5',
    host: p.host,
    port: p.port,
    username: p.username,
    tags: [],
  };
  const health = await checkProxyHealth(cred, p.password, { timeoutMs: 45000, upstream });
  log('健康检查:', health.exitIp, health.geo?.country, health.geo?.timezone);
  expectedGeo = {
    exitIp: health.exitIp,
    timezone: health.geo?.timezone,
    countryCode: health.geo?.countryCode,
    latitude: health.geo?.latitude,
    longitude: health.geo?.longitude,
  };
  relay = await startRelay(
    { protocol: 'socks5', host: p.host, port: p.port, username: p.username, password: p.password },
    { upstream, timeoutMs: 60000 },
  );
  log('中继:', relay.server);
}

// ---- 2. 指纹与启动（复刻内核配置）----
const overrides = expectedGeo ? deriveGeoOverrides(expectedGeo) : undefined;
// 与新建环境默认值一致：跟随宿主机平台，避免探针自身制造跨平台矛盾。
const fp = generateFingerprint({ seed: SEED, platform: 'host', overrides });
const clientHints = buildClientHintHeaders(fp);
log('画像:', fp.platform, fp.timezone, fp.languages[0]);

const context = await chromium.launchPersistentContext(join(HERE, '.probe-profile'), {
  headless: false,
  args: [
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--disable-quic',
    '--disable-blink-features=AutomationControlled',
  ],
  userAgent: fp.userAgent,
  extraHTTPHeaders: clientHints,
  locale: fp.languages[0],
  timezoneId: fp.timezone,
  viewport: { width: fp.viewport.width, height: fp.viewport.height },
  deviceScaleFactor: fp.screen.pixelRatio,
  geolocation: fp.geolocation
    ? {
        latitude: fp.geolocation.latitude,
        longitude: fp.geolocation.longitude,
        accuracy: fp.geolocation.accuracy,
      }
    : undefined,
  permissions: fp.geolocation ? ['geolocation'] : [],
  proxy: relay ? { server: relay.server } : undefined,
});
await context.addInitScript({ content: buildInjectionScript(fp) });
const page = context.pages()[0] ?? (await context.newPage());

// ---- 3. 本地采集（主世界，裸 CDP）----
const cdp = await context.newCDPSession(page);
const mainEval = async (expression) => {
  const res = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (res.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails).slice(0, 300));
  return res.result.value;
};
await page.goto('about:blank');
const collectorSrc = readFileSync(
  '/Users/mac/ShadowEdge/experiments/t0-probe/scripts/collect.js',
  'utf8',
);
await mainEval(collectorSrc);
const local = await mainEval('window.__collectFingerprint()');
log('本地采集完成, canvasHash=', local.canvasHash);

// WebRTC 泄漏检查
const webrtc = await mainEval(`(async () => {
  const ips = new Set();
  let sdp = '';
  let sdpCandidates = [];
  try {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    pc.createDataChannel('x');
    pc.onicecandidate = (e) => {
      if (!e.candidate) return;
      const m = e.candidate.candidate.match(/([0-9a-f:.]+) \\d+ typ (host|srflx)/);
      if (m) ips.add(m[1] + ':' + m[2]);
    };
    await pc.createOffer().then((o) => pc.setLocalDescription(o));
    await new Promise((r) => setTimeout(r, 3000));
    sdp = pc.localDescription?.sdp ?? '';
    sdpCandidates = sdp.match(/a=candidate:[^\\r\\n]+/g) ?? [];
    pc.close();
  } catch (e) { return { error: e.message, candidates: [...ips], sdpCandidates }; }
  return { candidates: [...ips], sdpCandidates };
})()`);
log('WebRTC candidates:', JSON.stringify(webrtc));

// ---- 3b. Worker 穿透（Pixelscan 会用 blob: Worker 复测 UA/GPU）----
const workerGl = await mainEval(`(async () => {
  return await new Promise((resolve) => {
    const source = [
      'try {',
      '  const canvas = new OffscreenCanvas(16, 20);',
      '  const gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");',
      '  const ext = gl && gl.getExtension("WEBGL_debug_renderer_info");',
      '  postMessage({',
      '    ua: navigator.userAgent,',
      '    hc: navigator.hardwareConcurrency,',
      '    brands: navigator.userAgentData ? navigator.userAgentData.brands : null,',
      '    navOwnProps: Object.getOwnPropertyNames(navigator),',
      '    gpu: ext ? [gl.getParameter(ext.UNMASKED_VENDOR_WEBGL), gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)] : null,',
      '  });',
      '} catch (error) { postMessage({ error: String(error) }); }',
    ].join('\\n');
    const worker = new Worker(URL.createObjectURL(new Blob([source], { type: 'application/javascript' })));
    const timer = setTimeout(() => resolve({ timeout: true }), 5000);
    worker.onmessage = (event) => { clearTimeout(timer); resolve(event.data); worker.terminate(); };
  });
})()`);
log('Worker:', JSON.stringify(workerGl));

// ---- 4. CreepJS（需外网）----
let creep = null;
if (PROXY_ID) {
  const started = Date.now();
  try {
    await page.goto(CREEPJS, { timeout: 120000, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(45000); // CreepJS 计算量大，等它出分
    const text = await page.locator('body').innerText();
    // CreepJS 没有单一 trust score：headless/stealth 是判定项，like-headless 是相似度。
    // 精确选择器避免误抓正文里的其它百分比或 12 位 FP 片段。
    const headlessText =
      (await readSelectorText(page, '.headless-rating')) ??
      firstMatch(text, /([^\n]*\bheadless\b[^\n]*)/i);
    const likeHeadlessText =
      (await readSelectorText(page, '.like-headless-rating')) ??
      firstMatch(text, /([^\n]*like headless[^\n]*)/i);
    const stealthText =
      (await readSelectorText(page, '.stealth-rating')) ??
      firstMatch(text, /([^\n]*\bstealth\b[^\n]*)/i);
    const fpId = firstMatch(text, /FP ID:\s*([a-f0-9]{64})/i);
    const lies = (text.match(/lies/gi) ?? []).length;
    creep = {
      ratings: {
        headless: headlessText,
        headlessPercent: percentOf(headlessText),
        likeHeadless: likeHeadlessText,
        likeHeadlessPercent: percentOf(likeHeadlessText),
        stealth: stealthText,
        stealthPercent: percentOf(stealthText),
      },
      fingerprintId: fpId,
      liesMentions: lies,
      elapsedMs: Date.now() - started,
      bodySnippet: text.slice(0, 2000),
    };
    log('CreepJS:', JSON.stringify(creep.ratings), 'fpId=', fpId?.slice(0, 12));
  } catch (e) {
    creep = { error: e.message.slice(0, 300), elapsedMs: Date.now() - started };
    log('CreepJS 失败:', e.message.slice(0, 120));
  }
}

// ---- 5. BrowserLeaks WebRTC（需外网）----
let browserleaks = null;
if (PROXY_ID) {
  const started = Date.now();
  try {
    await page.goto(BROWSERLEAKS, { timeout: 120000, waitUntil: 'domcontentloaded' });
    await page
      .waitForFunction(() => document.body?.innerText.includes('Your Remote IP'), {
        timeout: 60000,
      })
      .catch(() => {});
    await page.waitForTimeout(22000); // WebRTC 探测需要等 STUN/候选收集结束
    const text = await page.locator('body').innerText();
    const remoteIp = firstMatch(text, /Your Remote IP[\s\S]{0,500}?IPv4 Address\s*([0-9.]+)/i);
    const webrtcStart = text.search(/Your WebRTC IP/i);
    const webrtcSection = webrtcStart >= 0 ? text.slice(webrtcStart, webrtcStart + 1500) : '';
    const webrtcIps = [
      ...new Set([...webrtcSection.matchAll(/\b((?:\d{1,3}\.){3}\d{1,3})\b/g)].map((m) => m[1])),
    ];
    const publicIps = webrtcIps.filter((ip) => !isPrivateIp(ip));
    const leakedPublicIps = publicIps.filter((ip) => ip !== expectedGeo?.exitIp);
    browserleaks = {
      remoteIp,
      webrtcIps,
      publicIps,
      leakedPublicIps,
      webrtcSection: webrtcSection.slice(0, 1000),
      elapsedMs: Date.now() - started,
      bodySnippet: text.slice(0, 1500),
    };
    log('BrowserLeaks: remote=', remoteIp, 'webrtcIps=', JSON.stringify(webrtcIps));
  } catch (e) {
    browserleaks = { error: e.message.slice(0, 300), elapsedMs: Date.now() - started };
    log('BrowserLeaks 失败:', e.message.slice(0, 120));
  }
}

// ---- 6. Pixelscan（需外网）----
let pixelscan = null;
if (PROXY_ID) {
  const started = Date.now();
  try {
    await page.goto(PIXELSCAN, { timeout: 120000, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    const scanButton = page.getByText(/scan my browser/i).first();
    if (await scanButton.count()) await scanButton.click({ timeout: 10000 }).catch(() => {});
    await page.waitForURL(/fingerprint-check/i, { timeout: 60000 }).catch(() => {});
    await page
      .waitForFunction(
        () => {
          const bar = document.querySelector('pxlscn-consistency-check .status-bar');
          const state = bar?.getAttribute('data-state');
          return state === 'success' || state === 'error';
        },
        { timeout: 120000 },
      )
      .catch(() => {});
    await page.waitForTimeout(2000);
    const snapshot = await page.evaluate(() => {
      const section = document.querySelector('pxlscn-consistency-check');
      const bar = section?.querySelector('.status-bar');
      const cards = [...(section?.querySelectorAll('.checker-card') ?? [])].map((card) => ({
        label: card.querySelector('.checker-card__label')?.textContent?.trim() ?? '',
        value: card.querySelector('[checkervalue]')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
        failed: card.classList.contains('checker-card--failed'),
      }));
      return {
        state: bar?.getAttribute('data-state') ?? null,
        text: section?.innerText ?? '',
        cards,
      };
    });
    const byLabel = Object.fromEntries(snapshot.cards.map((card) => [card.label, card]));
    const observedHeaders = await page.evaluate(async () => {
      try {
        const response = await fetch('/s/api/hh', { cache: 'no-store' });
        return await response.json();
      } catch (error) {
        return { error: String(error) };
      }
    });
    const headers = observedHeaders?.value ?? {};
    const verdict =
      snapshot.state === 'success'
        ? 'consistent'
        : snapshot.state === 'error'
          ? 'inconsistent'
          : null;
    pixelscan = {
      verdict,
      consistent: verdict === 'consistent',
      statusState: snapshot.state,
      cards: snapshot.cards,
      reportedBrowser: byLabel.Browser?.value ?? null,
      browserOk: byLabel.Browser ? !byLabel.Browser.failed : null,
      geoApi: byLabel.Location?.value ?? null,
      locationOk: byLabel.Location ? !byLabel.Location.failed : null,
      proxyDetected: byLabel.Proxy ? /proxy detected/i.test(byLabel.Proxy.value) : null,
      proxyOk: byLabel.Proxy ? !byLabel.Proxy.failed : null,
      maskingDetected: byLabel.Fingerprint
        ? /^masking detected/i.test(byLabel.Fingerprint.value.trim())
        : null,
      fingerprintOk: byLabel.Fingerprint ? !byLabel.Fingerprint.failed : null,
      automatedBehavior: byLabel['Bot check']
        ? /^automated behavior detected/i.test(byLabel['Bot check'].value.trim())
        : null,
      botCheckOk: byLabel['Bot check'] ? !byLabel['Bot check'].failed : null,
      observedHeaders: {
        userAgent: headers.userAgent ?? null,
        secUA: headers.secUA ?? null,
        secPlatform: headers.secPlatform ?? null,
        acceptLanguage: headers.acceptLanguage ?? null,
      },
      headerConsistent:
        headers.userAgent === fp.userAgent && headers.secUA === clientHints['sec-ch-ua'],
      elapsedMs: Date.now() - started,
      bodySnippet: snapshot.text.slice(0, 2500),
    };
    pixelscan.nonProxyConsistent =
      pixelscan.consistent ||
      (pixelscan.proxyDetected === true &&
        pixelscan.browserOk === true &&
        pixelscan.fingerprintOk === true &&
        pixelscan.locationOk === true &&
        pixelscan.botCheckOk === true);
    log(
      'Pixelscan:',
      verdict ?? '(未解析)',
      'browserOk=',
      pixelscan.browserOk,
      'masking=',
      pixelscan.maskingDetected,
    );
  } catch (e) {
    pixelscan = { error: e.message.slice(0, 300), elapsedMs: Date.now() - started };
    log('Pixelscan 失败:', e.message.slice(0, 120));
  }
}

// ---- 7. 期望比对矩阵 ----
const expectations = [
  ['userAgent 与画像一致', local.userAgent === fp.userAgent],
  [
    'UA-CH 品牌与画像一致',
    JSON.stringify(local.uaData?.brands ?? null) === JSON.stringify(fp.userAgentData.brands),
  ],
  [
    'UA-CH 高熵版本与画像一致',
    local.uaDataHighEntropy?.uaFullVersion === fp.userAgentData.fullVersion,
  ],
  ['timezone 与画像一致', local.timezone === fp.timezone],
  ['hardwareConcurrency 一致', local.hardwareConcurrency === fp.hardware.hardwareConcurrency],
  ['deviceMemory 一致', local.deviceMemory === fp.hardware.deviceMemoryGb],
  ['maxTouchPoints=0(桌面)', local.maxTouchPoints === fp.hardware.maxTouchPoints],
  ['webdriver 未暴露', local.webdriver === false],
  ['无 cdc_$cdc 变量', local.traps.hasCDC.length === 0],
  ['permissions.query 为原生', local.traps.fnToString === true],
  ['WebGL renderer 一致', local.webgl?.renderer === fp.webgl.renderer],
  ['navigator 无自有属性', (local.traps.navOwnProps ?? []).length === 0],
  [
    'WebRTC 无本机/真实出口 candidate',
    (webrtc.candidates ?? []).every(
      (c) => c.startsWith('0.') || c.includes('mdns') || c.endsWith('.local:host'),
    ) || (webrtc.candidates ?? []).length === 0,
  ],
  [
    'WebRTC SDP 无真实 host/srflx/relay IP',
    (webrtc.sdpCandidates ?? []).every(
      (c) => !/ typ (host|srflx|relay)/.test(c) || c.includes('.local'),
    ),
  ],
  ['Worker UA 与画像一致', workerGl?.ua === fp.userAgent],
  [
    'Worker UA-CH 与画像一致',
    JSON.stringify(workerGl?.brands ?? null) === JSON.stringify(fp.userAgentData.brands),
  ],
  ['Worker hardwareConcurrency 一致', workerGl?.hc === fp.hardware.hardwareConcurrency],
  [
    'Worker OffscreenCanvas GPU 与画像一致',
    workerGl?.gpu?.[0] === fp.webgl.vendor && workerGl?.gpu?.[1] === fp.webgl.renderer,
  ],
  [
    'Worker navigator 无自有属性',
    Array.isArray(workerGl?.navOwnProps) && workerGl.navOwnProps.length === 0,
  ],
];
if (expectedGeo)
  expectations.push([
    'WebRTC 未泄漏（candidate 为空或仅 mDNS）',
    (webrtc.candidates ?? []).length === 0,
  ]);
if (PROXY_ID) {
  expectations.push(['CreepJS headless 评级 = 0%', creep?.ratings?.headlessPercent === 0]);
  expectations.push(['CreepJS stealth 评级 = 0%', creep?.ratings?.stealthPercent === 0]);
  expectations.push([
    'BrowserLeaks 未泄漏非出口公网 IP',
    (browserleaks?.leakedPublicIps ?? []).length === 0 && !browserleaks?.error,
  ]);
  expectations.push(['Pixelscan 服务端 UA-CH 与画像一致', pixelscan?.headerConsistent === true]);
  expectations.push(['Pixelscan Browser 卡片通过', pixelscan?.browserOk === true]);
  expectations.push(['Pixelscan Fingerprint 卡片通过', pixelscan?.fingerprintOk === true]);
  expectations.push(['Pixelscan 非代理因素全部通过', pixelscan?.nonProxyConsistent === true]);
}

const passed = expectations.filter(([, ok]) => ok).length;
const report = {
  label: LABEL,
  seed: SEED,
  proxy: PROXY_ID ?? null,
  at: new Date().toISOString(),
  fingerprint: fp,
  expectedGeo,
  local,
  webrtc,
  workerGl,
  creep,
  browserleaks,
  pixelscan,
  expectations: expectations.map(([name, ok]) => ({ name, ok })),
  score: `${passed}/${expectations.length}`,
  failUnder: FAIL_UNDER,
};
mkdirSync(join(HERE, 'results'), { recursive: true });
const outFile = join(HERE, 'results', `${LABEL}-${Date.now()}.json`);
writeFileSync(outFile, JSON.stringify(report, null, 2));

console.log('\n===== 探针回归摘要 =====');
for (const [name, ok] of expectations) console.log((ok ? '  ✓ ' : '  ✗ ') + name);
console.log(`得分: ${passed}/${expectations.length}  报告: ${outFile}`);

await context.close();
await relay?.close();
if (passed < FAIL_UNDER) {
  console.error(`探针得分低于阈值: ${passed}/${expectations.length} < ${FAIL_UNDER}`);
  process.exit(1);
}
process.exit(0);
