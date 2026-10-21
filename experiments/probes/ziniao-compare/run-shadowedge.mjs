/**
 * 用与紫鸟完全相同的 probe-page.html 采集 ShadowEdge 侧数据。
 * 用法：node experiments/probes/ziniao-compare/run-shadowedge.mjs [seed]
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  buildClientHintHeaders,
  buildInjectionScript,
  generateFingerprint,
} from '../../../packages/fingerprint/dist/index.js';
import { chromium } from '../../../apps/desktop/node_modules/patchright/index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const seed = process.argv[2] ?? 'ziniao-compare';
const fp = generateFingerprint({ seed, platform: 'host' });
const profileDir = mkdtempSync(join(tmpdir(), 'shadowedge-ziniao-compare-'));
const started = Date.now();

const context = await chromium.launchPersistentContext(profileDir, {
  headless: false,
  args: [
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--disable-quic',
    '--disable-blink-features=AutomationControlled',
  ],
  userAgent: fp.userAgent,
  extraHTTPHeaders: buildClientHintHeaders(fp),
  locale: fp.languages[0],
  timezoneId: fp.timezone,
  viewport: { width: fp.viewport.width, height: fp.viewport.height },
  deviceScaleFactor: fp.screen.pixelRatio,
});
await context.addInitScript({ content: buildInjectionScript(fp) });
const page = context.pages()[0] ?? (await context.newPage());
await page.goto(pathToFileURL(join(HERE, 'probe-page.html')).href);
await page.waitForFunction(() => typeof collect === 'function');

// Patchright 的 page.evaluate 跑在隔离 world；collect() 必须走裸 CDP 主世界。
const cdp = await context.newCDPSession(page);
const evaluated = await cdp.send('Runtime.evaluate', {
  expression: 'collect()',
  awaitPromise: true,
  returnByValue: true,
});
if (evaluated.exceptionDetails) {
  throw new Error(evaluated.exceptionDetails.text);
}
const report = {
  at: new Date().toISOString(),
  capture: 'patchright-main-world',
  seed,
  fingerprint: fp,
  data: evaluated.result.value,
  elapsedMs: Date.now() - started,
};
const outFile = join(HERE, `shadowedge-result-${Date.now()}.json`);
writeFileSync(outFile, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report.data, null, 2));
console.log('ShadowEdge 对照结果:', outFile);

await context.close();
rmSync(profileDir, { recursive: true, force: true });
