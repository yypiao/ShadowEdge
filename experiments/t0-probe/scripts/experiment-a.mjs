// 实验 A：Patchright + 确定性 JS 注入（方案 A 原型）
// seed 固定，验证可复现性 + 采集指纹 + CreepJS 信任分
import { chromium } from 'patchright';
import { readFileSync, writeFileSync } from 'node:fs';

const SEED = 424242;
function rng(seed) { // xorshift32，与 core 的 SeededRandom 同族
  let s = seed >>> 0;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; };
}
const r = rng(SEED);
const pick = (arr) => arr[Math.floor(r() * arr.length)];

// BrowserForge 正式接入前的确定性画像占位（实验用）
const profile = {
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  platform: 'MacIntel',
  languages: ['en-US', 'en'],
  hardwareConcurrency: pick([8, 10, 12]),
  deviceMemory: 8,
  screen: pick([{ w: 1920, h: 1080 }, { w: 2560, h: 1440 }, { w: 1512, h: 982 }]),
  webglVendor: 'Google Inc. (Apple)',
  webglRenderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)',
  canvasNoise: r() * 0.001,
  timezone: 'America/Los_Angeles',
  seed: SEED,
};

const inject = (p) => {
  const def = (obj, key, val) => Object.defineProperty(obj, key, { get: () => val, configurable: true });
  def(navigator, 'hardwareConcurrency', p.hardwareConcurrency);
  def(navigator, 'deviceMemory', p.deviceMemory);
  def(navigator, 'languages', Object.freeze([...p.languages]));
  def(navigator, 'platform', p.platform);
  def(screen, 'width', p.screen.w); def(screen, 'height', p.screen.h);
  def(screen, 'availWidth', p.screen.w); def(screen, 'availHeight', p.screen.h - 25);
  // WebGL
  const getParam = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function (param) {
    if (param === 37445) return p.webglVendor;
    if (param === 37446) return p.webglRenderer;
    return getParam.call(this, param);
  };
  // Canvas 确定性微噪声
  const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.toDataURL = function (...args) {
    const ctx = this.getContext('2d');
    if (ctx) {
      const d = ctx.getImageData(0, 0, this.width, this.height);
      let s = p.seed >>> 0;
      for (let i = 0; i < d.data.length; i += 997) {
        s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
        d.data[i] = d.data[i] ^ (s & 1);
      }
      ctx.putImageData(d, 0, 0);
    }
    return origToDataURL.apply(this, args);
  };
};

const collectJs = readFileSync(new URL('./collect.js', import.meta.url), 'utf8');
const run = async (tag) => {
  const browser = await chromium.launch({ headless: false, channel: undefined });
  const ctx = await browser.newContext({
    userAgent: profile.userAgent,
    locale: 'en-US',
    timezoneId: profile.timezone,
    viewport: { width: profile.screen.w, height: profile.screen.h },
  });
  await ctx.addInitScript({ content: collectJs });
  await ctx.addInitScript(inject, profile);
  const page = await ctx.newPage();

  for (let attempt = 0; attempt < 3; attempt++) {
    try { await page.goto('https://example.com', { waitUntil: 'domcontentloaded', timeout: 30000 }); break; }
    catch (e) { if (attempt === 2) throw e; await page.waitForTimeout(2000); }
  }
  // Patchright 的 page.evaluate 跑在隔离 world，主世界采集必须走裸 CDP
  const cdp = await ctx.newCDPSession(page);
  const r = await cdp.send('Runtime.evaluate', {
    expression: 'window.__collectFingerprint()',
    awaitPromise: true, returnByValue: true,
  });
  const fp = r.result.value;

  await page.goto('https://abrahamjuliot.github.io/creepjs/', { waitUntil: 'load', timeout: 90000 }).catch(() => {});
  await page.waitForTimeout(25000);
  const trust = await page.evaluate(() => {
    const text = document.body?.innerText || '';
    const m = text.match(/trust score[^\n]*/i);
    const m2 = text.match(/(\d+(?:\.\d+)?)\s*%\s*(?:bot|human)/i);
    return m ? m[0].slice(0, 120) : (m2 ? m2[0] : text.slice(0, 200).replace(/\n+/g, ' '));
  }).catch(() => 'n/a');

  await browser.close();
  const out = { tag, seed: SEED, profile, fingerprint: fp, creepTrust: trust, at: new Date().toISOString() };
  writeFileSync(new URL(`../results/a-${tag}.json`, import.meta.url), JSON.stringify(out, null, 2));
  console.log(`[A/${tag}] canvas=${fp.canvasHash} webgl=${fp.webgl?.renderer} trap.native=${fp.traps.fnToString} cdc=${fp.traps.hasCDC.length}`);
  console.log(`[A/${tag}] creep: ${trust}`);
  return out;
};

const a1 = await run('run1');
const a2 = await run('run2');
const same = JSON.stringify(a1.fingerprint) === JSON.stringify(a2.fingerprint);
console.log(`[A] 两次启动指纹完全一致: ${same}`);
