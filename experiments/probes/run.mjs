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
import { generateFingerprint, deriveGeoOverrides } from '/Users/mac/ShadowEdge/packages/fingerprint/dist/index.js';
import { buildInjectionScript } from '/Users/mac/ShadowEdge/packages/fingerprint/dist/inject.js';
import { startRelay, checkProxyHealth } from '/Users/mac/ShadowEdge/packages/proxy/dist/index.js';
import { chromium } from '/Users/mac/ShadowEdge/apps/desktop/node_modules/patchright/index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith('--') ? [a.slice(2), arr[i + 1]] : null).filter(Boolean));
const SEED = args.seed ?? 'probe-demo';
const LABEL = args.label ?? new Date().toISOString().slice(0, 10);
const PROXY_ID = args.proxy; // experiments/.secrets/test-proxies.json 里的 id
const CREEPJS = 'https://abrahamjuliot.github.io/creepjs/';

const log = (...a) => console.log('[probe]', ...a);

// ---- 1. 代理与中继（可选）----
let relay, expectedGeo;
if (PROXY_ID) {
  const secrets = JSON.parse(readFileSync('/Users/mac/ShadowEdge/experiments/.secrets/test-proxies.json', 'utf8'));
  const p = secrets.find((x) => x.id === PROXY_ID);
  if (!p) throw new Error(`代理 ${PROXY_ID} 不在 secrets 文件里`);
  const upstream = { protocol: 'http', host: '127.0.0.1', port: 7897 };
  const cred = { id: p.id, orgId: 'local', label: p.id, protocol: 'socks5', host: p.host, port: p.port, username: p.username, tags: [] };
  const health = await checkProxyHealth(cred, p.password, { timeoutMs: 45000, upstream });
  log('健康检查:', health.exitIp, health.geo?.country, health.geo?.timezone);
  expectedGeo = { exitIp: health.exitIp, timezone: health.geo?.timezone, countryCode: health.geo?.countryCode, latitude: health.geo?.latitude, longitude: health.geo?.longitude };
  relay = await startRelay({ protocol: 'socks5', host: p.host, port: p.port, username: p.username, password: p.password }, { upstream, timeoutMs: 60000 });
  log('中继:', relay.server);
}

// ---- 2. 指纹与启动（复刻内核配置）----
const overrides = expectedGeo ? deriveGeoOverrides(expectedGeo) : undefined;
const fp = generateFingerprint({ seed: SEED, overrides });
log('画像:', fp.platform, fp.timezone, fp.languages[0]);

const context = await chromium.launchPersistentContext(join(HERE, '.probe-profile'), {
  headless: false,
  args: ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--disable-quic', '--disable-blink-features=AutomationControlled'],
  userAgent: fp.userAgent,
  locale: fp.languages[0],
  timezoneId: fp.timezone,
  viewport: { width: fp.viewport.width, height: fp.viewport.height },
  deviceScaleFactor: fp.screen.pixelRatio,
  geolocation: fp.geolocation ? { latitude: fp.geolocation.latitude, longitude: fp.geolocation.longitude, accuracy: fp.geolocation.accuracy } : undefined,
  permissions: fp.geolocation ? ['geolocation'] : [],
  proxy: relay ? { server: relay.server } : undefined,
});
await context.addInitScript({ content: buildInjectionScript(fp) });
const page = context.pages()[0] ?? (await context.newPage());

// ---- 3. 本地采集（主世界，裸 CDP）----
const cdp = await context.newCDPSession(page);
const mainEval = async (expression) => {
  const res = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (res.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails).slice(0, 300));
  return res.result.value;
};
await page.goto('about:blank');
const collectorSrc = readFileSync('/Users/mac/ShadowEdge/experiments/t0-probe/scripts/collect.js', 'utf8');
await mainEval(collectorSrc);
const local = await mainEval('window.__collectFingerprint()');
log('本地采集完成, canvasHash=', local.canvasHash);

// WebRTC 泄漏检查
const webrtc = await mainEval(`(async () => {
  const ips = new Set();
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
    pc.close();
  } catch (e) { return { error: e.message }; }
  return { candidates: [...ips] };
})()`);
log('WebRTC candidates:', JSON.stringify(webrtc));

// ---- 4. CreepJS（需外网）----
let creep = null;
if (PROXY_ID) {
  try {
    await page.goto(CREEPJS, { timeout: 120000, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(45000); // CreepJS 计算量大，等它出分
    const text = await page.locator('body').innerText();
    const trust = text.match(/(\d+(?:\.\d+)?)%\s*(?:trust|信任)/i)?.[0] ?? text.match(/trust score[^\d]*(\d+(?:\.\d+)?)/i)?.[0] ?? null;
    const fpId = text.match(/\b([a-f0-9]{32,64})\b/)?.[1] ?? null;
    const lies = (text.match(/lies/gi) ?? []).length;
    creep = { trustScoreRaw: trust, fingerprintId: fpId, liesMentions: lies, bodySnippet: text.slice(0, 2000) };
    log('CreepJS: trust=', trust, 'fpId=', fpId?.slice(0, 12));
  } catch (e) {
    creep = { error: e.message.slice(0, 200) };
    log('CreepJS 失败:', e.message.slice(0, 120));
  }
}

// ---- 5. 期望比对矩阵 ----
const expectations = [
  ['userAgent 与画像一致', local.userAgent === fp.userAgent],
  ['timezone 与画像一致', local.timezone === fp.timezone],
  ['hardwareConcurrency 一致', local.hardwareConcurrency === fp.hardware.hardwareConcurrency],
  ['deviceMemory 一致', local.deviceMemory === fp.hardware.deviceMemoryGb],
  ['maxTouchPoints=0(桌面)', local.maxTouchPoints === fp.hardware.maxTouchPoints],
  ['webdriver 未暴露', local.webdriver === false],
  ['无 cdc_$cdc 变量', local.traps.hasCDC.length === 0],
  ['permissions.query 为原生', local.traps.fnToString === true],
  ['WebGL renderer 一致', local.webgl?.renderer === fp.webgl.renderer],
  ['WebRTC 无本机/真实出口 candidate', (webrtc.candidates ?? []).every((c) => c.startsWith('0.') || c.includes('mdns') || c.endsWith('.local:host')) || (webrtc.candidates ?? []).length === 0],
];
if (expectedGeo) expectations.push(['WebRTC 未泄漏（candidate 为空或仅 mDNS）', (webrtc.candidates ?? []).length === 0]);

const passed = expectations.filter(([, ok]) => ok).length;
const report = {
  label: LABEL, seed: SEED, proxy: PROXY_ID ?? null, at: new Date().toISOString(),
  fingerprint: fp, expectedGeo, local, webrtc, creep,
  expectations: expectations.map(([name, ok]) => ({ name, ok })),
  score: `${passed}/${expectations.length}`,
};
mkdirSync(join(HERE, 'results'), { recursive: true });
const outFile = join(HERE, 'results', `${LABEL}-${Date.now()}.json`);
writeFileSync(outFile, JSON.stringify(report, null, 2));

console.log('\n===== 探针回归摘要 =====');
for (const [name, ok] of expectations) console.log((ok ? '  ✓ ' : '  ✗ ') + name);
console.log(`得分: ${passed}/${expectations.length}  报告: ${outFile}`);

await context.close();
await relay?.close();
process.exit(0);
