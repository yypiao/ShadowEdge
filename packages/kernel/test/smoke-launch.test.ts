import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserProfile } from '@shadowedge/core';
import { generateFingerprint } from '@shadowedge/fingerprint';
import { chromium } from 'patchright';
import { PatchrightDriver } from '../src/drivers/patchright.js';

/**
 * 真机冒烟：真实启动 Patchright Chromium，经 CDP 在主世界回读注入的指纹。
 * 默认跳过（会打开有头窗口、依赖内核二进制），
 * 手动执行：SHADOWEDGE_SMOKE=1 pnpm --filter @shadowedge/kernel test
 */
const SMOKE = process.env.SHADOWEDGE_SMOKE === '1';

describe.skipIf(!SMOKE)('Patchright 真机冒烟', () => {
  it('启动持久化环境并回读主世界指纹', async () => {
    const now = new Date().toISOString();
    const dir = mkdtempSync(join(tmpdir(), 'se-smoke-'));
    const profile: BrowserProfile = {
      id: 'smoke-1', orgId: 'local', name: 'smoke', kernel: 'chromium-patched',
      fingerprint: generateFingerprint({ seed: 'smoke-seed-1' }),
      ownerId: 'local-user', sharedWith: [],
      storage: { userDataDir: join(dir, 'ud'), remoteRevision: 0, syncMode: 'local-only' },
      startupUrls: [], status: 'idle', createdAt: now, updatedAt: now,
    };

    const driver = new PatchrightDriver();
    const instance = await driver.launch({ profile, options: { profileId: profile.id, remoteDebugging: true } });
    expect(instance.wsEndpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const cdp = await chromium.connectOverCDP(instance.wsEndpoint!);
    const ctx = cdp.contexts()[0]!;
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto('about:blank');
    const session = await ctx.newCDPSession(page);
    const read = async (expr: string) =>
      (await session.send('Runtime.evaluate', { expression: expr, returnByValue: true })).result.value;

    const fp = profile.fingerprint;
    expect(await read('navigator.hardwareConcurrency')).toBe(fp.hardware.hardwareConcurrency);
    expect(await read('navigator.deviceMemory')).toBe(fp.hardware.deviceMemoryGb);
    expect(await read('screen.width')).toBe(fp.screen.width);
    expect(await read('navigator.webdriver')).toBe(false);
    const glRenderer = await read(`(() => {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl');
      const d = gl.getExtension('WEBGL_debug_renderer_info');
      return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    })()`);
    expect(glRenderer).toBe(fp.webgl.renderer);

    await cdp.close();
    await instance.close();
  }, 90000);
});
