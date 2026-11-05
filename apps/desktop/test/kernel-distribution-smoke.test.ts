import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BrowserKernel, ChromiumCdpDriver } from '@shadowedge/kernel';
import { generateFingerprint } from '@shadowedge/fingerprint';
import { KernelDistributionService } from '../src/main/services/kernel-distribution.js';
import { KernelRuntimeService } from '../src/main/services/kernel-runtime.js';

const ENABLED = Boolean(
  process.env.SHADOWEDGE_TEST_KERNEL_PACKAGE &&
  process.env.SHADOWEDGE_TEST_KERNEL_DATA &&
  process.env.SHADOWEDGE_TEST_KERNEL_PUBLIC_KEY,
);

describe.skipIf(!ENABLED)('完整 Chromium 签名包真实安装', () => {
  it('验签后从离线缓存启动，禁止回退其他内核', async () => {
    const archivePath = process.env.SHADOWEDGE_TEST_KERNEL_PACKAGE!;
    const dataDir = process.env.SHADOWEDGE_TEST_KERNEL_DATA!;
    const publicKey = readFileSync(process.env.SHADOWEDGE_TEST_KERNEL_PUBLIC_KEY!, 'utf8');
    const distribution = new KernelDistributionService(dataDir, { publicKey });
    const started = Date.now();
    const mark = (stage: string) => console.log(`[kernel-package-smoke] ${stage}: ${Date.now() - started}ms`);
    distribution.install(archivePath);
    mark('install');
    const runtime = new KernelRuntimeService(dataDir, {}, () => distribution.verifyActive(), () => {
      const status = distribution.getStatus();
      return status.available ? status.executablePath : undefined;
    });
    runtime.configure({ fallbackPolicy: 'require-chromium-cdp' });
    const kernel = new BrowserKernel({ drivers: [new ChromiumCdpDriver(runtime.driverOptions())] });
    const id = 'signed-install-smoke';
    const now = new Date().toISOString();
    const profile = {
      id, orgId: 'local', name: id, kernel: 'chromium-cdp' as const,
      fingerprint: generateFingerprint({ seed: id, platform: 'host' }),
      kernelVersion: process.env.SHADOWEDGE_TEST_KERNEL_VERSION,
      ownerId: 'local', sharedWith: [],
      storage: { userDataDir: join(dataDir, 'profile'), remoteRevision: 0, syncMode: 'local-only' as const },
      startupUrls: [], status: 'idle' as const, createdAt: now, updatedAt: now,
    };
    try {
      const launched = await kernel.launch(profile, { profileId: id, headless: false });
      mark('launch');
      const context = kernel.getAutomationContext(id);
      const page = context.pages()[0] ?? await context.newPage();
      const webdriver = await page.evaluate(() => navigator.webdriver);
      expect(launched.kernelUsed).toBe('chromium-cdp');
      expect(webdriver).toBe(false);
      expect(runtime.getStatus().source).toBe('installed');
      expect(distribution.getStatus().activeVersion).toBe(process.env.SHADOWEDGE_TEST_KERNEL_VERSION);
      console.log(JSON.stringify({ activeVersion: distribution.getStatus().activeVersion, kernelUsed: launched.kernelUsed, webdriver }));
    } finally {
      await kernel.closeAll();
      mark('close');
    }
  }, 300000);
});
