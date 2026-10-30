import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BrowserProfile } from '@shadowedge/core';
import { generateFingerprint } from '@shadowedge/fingerprint';
import { BrowserKernel, ChromiumCdpDriver } from '@shadowedge/kernel';
import { chromium } from 'patchright';
import { KernelRuntimeService } from '../src/main/services/kernel-runtime.js';

const executablePath = process.env.SHADOWEDGE_KERNEL_EXECUTABLE;
const SMOKE = process.env.SHADOWEDGE_SMOKE === '1' && executablePath !== undefined;

describe.skipIf(!SMOKE)('桌面配置到自研内核的真实启动链路', () => {
  it('持久化严格配置后，BrowserKernel 使用 chromium-cdp 且带名原生串生效', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shadowedge-desktop-kernel-smoke-'));
    const runtime = new KernelRuntimeService(join(dir, 'config'), {});
    runtime.configure({ executablePath, fallbackPolicy: 'require-chromium-cdp' });
    const restored = new KernelRuntimeService(join(dir, 'config'), {});
    const kernel = new BrowserKernel({ drivers: [new ChromiumCdpDriver(restored.driverOptions())] });
    const now = new Date().toISOString();
    const profile: BrowserProfile = {
      id: 'desktop-kernel-smoke', orgId: 'local', name: 'smoke', kernel: 'chromium-patched',
      fingerprint: generateFingerprint({ seed: 'desktop-kernel-smoke' }),
      ownerId: 'local-user', sharedWith: [],
      storage: { userDataDir: join(dir, 'profile'), remoteRevision: 0, syncMode: 'local-only' },
      startupUrls: [], status: 'idle', createdAt: now, updatedAt: now,
    };
    let cdp: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
    try {
      const result = await kernel.launch(profile, { profileId: profile.id, remoteDebugging: true });
      expect(result.kernelUsed).toBe('chromium-cdp');
      cdp = await chromium.connectOverCDP(result.wsEndpoint!);
      const context = cdp.contexts()[0]!;
      const page = context.pages()[0] ?? (await context.newPage());
      const session = await context.newCDPSession(page);
      const evaluated = await session.send('Runtime.evaluate', {
        expression: `({
          worker: Function.prototype.toString.call(Worker),
          webdriver: navigator.webdriver,
          width: screen.width,
        })`,
        returnByValue: true,
      });
      expect(evaluated.result.value).toEqual({
        worker: 'function Worker() { [native code] }',
        webdriver: false,
        width: profile.fingerprint.screen.width,
      });
    } finally {
      await cdp?.close();
      await kernel.close(profile.id);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90000);
});
