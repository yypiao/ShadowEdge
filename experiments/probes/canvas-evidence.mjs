/**
 * Canvas JS 注入与原生行为对照；不访问外网，不读取代理凭据。
 *
 * 先运行 pnpm --filter @shadowedge/fingerprint build，再执行：
 *   SHADOWEDGE_KERNEL_EXECUTABLE=/path/to/Chromium node experiments/probes/canvas-evidence.mjs
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateFingerprint } from '/Users/mac/ShadowEdge/packages/fingerprint/dist/index.js';
import { buildInjectionScript } from '/Users/mac/ShadowEdge/packages/fingerprint/dist/inject.js';
import { chromium } from '/Users/mac/ShadowEdge/apps/desktop/node_modules/patchright/index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const executablePath = process.env.SHADOWEDGE_KERNEL_EXECUTABLE;
if (!executablePath) throw new Error('请通过 SHADOWEDGE_KERNEL_EXECUTABLE 指定 Chromium 156 内核');
const seed = 'kernel-check';
const fp = generateFingerprint({ seed, platform: 'host' });
const fingerprintArg = `--shadowedge-fingerprint=${Buffer.from(JSON.stringify(fp)).toString('base64')}`;
const injection = buildInjectionScript(fp, {
  serviceWorker: 'kernel',
  coveredByKernel: ['screen', 'webgl', 'audio'],
});

const collect = async (protectedByJs) => {
  const profile = mkdtempSync(join(tmpdir(), 'shadowedge-canvas-evidence-'));
  const context = await chromium.launchPersistentContext(profile, {
    executablePath,
    headless: false,
    args: ['--disable-blink-features=AutomationControlled', fingerprintArg],
  });
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto('about:blank');
    // 本项只验证函数与像素语义，直接注入主世界；导航前注入由全量外部探针另行覆盖。
    if (protectedByJs) await page.evaluate(injection);
    return await page.evaluate(() => {
      const describe = (fn) => {
        const d = Object.getOwnPropertyDescriptor(fn === HTMLCanvasElement.prototype.toDataURL
          ? HTMLCanvasElement.prototype : CanvasRenderingContext2D.prototype,
        fn === HTMLCanvasElement.prototype.toDataURL ? 'toDataURL' : 'getImageData');
        return {
          directToString: fn.toString(),
          functionToString: Function.prototype.toString.call(fn),
          name: fn.name,
          descriptor: d ? {
            writable: d.writable,
            enumerable: d.enumerable,
            configurable: d.configurable,
            hasGetter: typeof d.get === 'function',
          } : null,
          ownPropertyNames: Object.getOwnPropertyNames(fn),
          objectTag: Object.prototype.toString.call(fn),
          hasFunctionPrototype: Object.getPrototypeOf(fn) === Function.prototype,
        };
      };
      const makeCanvas = (textured) => {
        const canvas = document.createElement('canvas');
        canvas.width = 128;
        canvas.height = 96;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('2D context unavailable');
        if (textured) {
          const image = ctx.createImageData(128, 96);
          for (let y = 0; y < 96; y++) {
            for (let x = 0; x < 128; x++) {
              const i = (y * 128 + x) * 4;
              image.data[i] = (x * 17 + y * 31) & 255;
              image.data[i + 1] = (x * x + y * 13) & 255;
              image.data[i + 2] = (x * 7 + y * y) & 255;
              image.data[i + 3] = 255;
            }
          }
          ctx.putImageData(image, 0, 0);
        } else {
          ctx.fillStyle = '#3377bb';
          ctx.fillRect(0, 0, 128, 96);
        }
        return { canvas, ctx };
      };
      const solid = makeCanvas(false);
      const texture = makeCanvas(true);
      const firstUrl = texture.canvas.toDataURL();
      const firstPixels = Array.from(texture.ctx.getImageData(0, 0, 128, 96).data);
      const repeatedUrl = texture.canvas.toDataURL();
      const repeatedPixels = Array.from(texture.ctx.getImageData(0, 0, 128, 96).data);
      texture.ctx.fillStyle = 'rgba(240, 20, 80, 0.6)';
      texture.ctx.fillRect(8, 8, 24, 24);
      return {
        functions: {
          toDataURL: describe(HTMLCanvasElement.prototype.toDataURL),
          getImageData: describe(CanvasRenderingContext2D.prototype.getImageData),
        },
        instanceOwnProperties: {
          canvas: Object.getOwnPropertyNames(texture.canvas),
          context: Object.getOwnPropertyNames(texture.ctx),
        },
        solid: {
          url: solid.canvas.toDataURL(),
          pixels: Array.from(solid.ctx.getImageData(0, 0, 128, 96).data),
        },
        texture: {
          firstUrl,
          repeatedUrl,
          firstPixels,
          repeatedPixels,
          afterMutationUrl: texture.canvas.toDataURL(),
        },
      };
    });
  } finally {
    await context.close();
    rmSync(profile, { recursive: true, force: true });
  }
};

// 所有行为先采样，再一次性断言，便于失败时仍保留完整对照报告。
const native = await collect(false);
const injected = await collect(true);
const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) });
for (const method of ['toDataURL', 'getImageData']) {
  const original = native.functions[method];
  const wrapped = injected.functions[method];
  check(`${method} 直接 toString 与原生逐字一致`, wrapped.directToString === original.directToString, wrapped.directToString);
  check(`${method} Function.prototype.toString 不泄漏 JS 源码`, wrapped.functionToString.includes('[native code]') && !wrapped.functionToString.includes('shadowedge'), wrapped.functionToString);
  check(`${method} name 与原生一致`, wrapped.name === original.name, wrapped.name);
  check(`${method} descriptor 标志与原生一致`, JSON.stringify(wrapped.descriptor) === JSON.stringify(original.descriptor), wrapped.descriptor);
  check(`${method} 对象形态未改变`, wrapped.objectTag === original.objectTag && wrapped.hasFunctionPrototype === original.hasFunctionPrototype);
}
check('Canvas 实例无新增自有属性', injected.instanceOwnProperties.canvas.length === 0, injected.instanceOwnProperties.canvas);
check('2D context 实例无新增自有属性', injected.instanceOwnProperties.context.length === 0, injected.instanceOwnProperties.context);
check('纯色 dataURL 与原生逐字节一致', injected.solid.url === native.solid.url);
check('纯色像素与原生逐字节一致', JSON.stringify(injected.solid.pixels) === JSON.stringify(native.solid.pixels));
check('纹理 dataURL 与原生不同（确实施加噪声）', injected.texture.firstUrl !== native.texture.firstUrl);
check('纹理 dataURL 重读稳定', injected.texture.firstUrl === injected.texture.repeatedUrl);
check('纹理像素重读稳定', JSON.stringify(injected.texture.firstPixels) === JSON.stringify(injected.texture.repeatedPixels));
check('画布修改后缓存失效', injected.texture.afterMutationUrl !== injected.texture.repeatedUrl);
const changedChannels = injected.texture.firstPixels.reduce((count, value, index) => count + (value !== native.texture.firstPixels[index] ? 1 : 0), 0);
const maxChannelDelta = injected.texture.firstPixels.reduce((max, value, index) => Math.max(max, Math.abs(value - native.texture.firstPixels[index])), 0);
check('纹理像素确实变化', changedChannels > 0, { changedChannels, totalChannels: injected.texture.firstPixels.length });
check('纹理像素噪声幅度受限（最大通道差 ≤1）', maxChannelDelta <= 1, { changedChannels, totalChannels: injected.texture.firstPixels.length, maxChannelDelta });
const sha256 = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
// 断言使用完整原始像素；报告只保留哈希与差异统计，避免数十万行 JSON 污染仓库。
const compact = (sample) => ({
  ...sample,
  solid: { ...sample.solid, pixelsSha256: sha256(sample.solid.pixels), pixels: undefined },
  texture: {
    ...sample.texture,
    firstPixelsSha256: sha256(sample.texture.firstPixels),
    repeatedPixelsSha256: sha256(sample.texture.repeatedPixels),
    firstPixels: undefined,
    repeatedPixels: undefined,
  },
});
const report = {
  kind: 'canvas-js-retention-evidence',
  at: new Date().toISOString(),
  executablePath,
  seed,
  comparison: 'same Chromium 156 binary; native vs current JS injection',
  executionMode: 'direct main-world evaluation on about:blank; init/navigation behavior covered by full probes',
  score: `${checks.filter((item) => item.ok).length}/${checks.length}`,
  checks,
  native: compact(native),
  injected: compact(injected),
};
mkdirSync(join(HERE, 'results'), { recursive: true });
const output = join(HERE, 'results', `canvas-js-evidence-${Date.now()}.json`);
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ output, score: report.score, checks }, null, 2));
if (checks.some((item) => !item.ok)) process.exitCode = 1;
