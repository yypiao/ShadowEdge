import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BrowserProfile } from '@shadowedge/core';
import { generateFingerprint } from '@shadowedge/fingerprint';
import { BrowserKernel, ChromiumCdpDriver } from '@shadowedge/kernel';
import { KernelDistributionService } from '../src/main/services/kernel-distribution.js';
import { KernelRuntimeService } from '../src/main/services/kernel-runtime.js';
import { commitKernelUpgrade, prepareKernelUpgrade } from '../src/main/services/kernel-upgrade.js';

const ENABLED = Boolean(
  process.env.SHADOWEDGE_TEST_KERNEL_OLD_PACKAGE &&
  process.env.SHADOWEDGE_TEST_KERNEL_NEW_PACKAGE &&
  process.env.SHADOWEDGE_TEST_KERNEL_DATA &&
  process.env.SHADOWEDGE_TEST_KERNEL_PUBLIC_KEY &&
  process.env.SHADOWEDGE_TEST_KERNEL_OLD_VERSION &&
  process.env.SHADOWEDGE_TEST_KERNEL_NEW_VERSION,
);

describe.skipIf(!ENABLED)('双真实 Release 内核灰度升级', () => {
  it('旧环境、验证克隆和迁移后重启的画像一致', async () => {
    const dataDir = process.env.SHADOWEDGE_TEST_KERNEL_DATA!;
    const oldVersion = process.env.SHADOWEDGE_TEST_KERNEL_OLD_VERSION!;
    const newVersion = process.env.SHADOWEDGE_TEST_KERNEL_NEW_VERSION!;
    const distribution = new KernelDistributionService(dataDir, {
      publicKey: readFileSync(process.env.SHADOWEDGE_TEST_KERNEL_PUBLIC_KEY!, 'utf8'),
    });
    const runtime = new KernelRuntimeService(
      dataDir, {},
      (version) => version ? distribution.verifyVersion(version) : distribution.verifyActive(),
      (version) => version ? distribution.getExecutablePath(version) : distribution.getStatus().executablePath,
    );
    runtime.configure({ fallbackPolicy: 'require-chromium-cdp' });
    const kernel = new BrowserKernel({ drivers: [new ChromiumCdpDriver(runtime.driverOptions())] });
    const now = new Date().toISOString();
    const source: BrowserProfile = {
      id: 't36-real-upgrade', orgId: 'local', name: 't36-real-upgrade', kernel: 'chromium-cdp',
      fingerprint: generateFingerprint({ seed: 't36-real-upgrade', platform: 'host', catalogVersion: '131.0.6778.86' }),
      kernelVersion: oldVersion, ownerId: 'local', sharedWith: [],
      storage: { userDataDir: join(dataDir, 'profiles', 't36-real-upgrade'), remoteRevision: 0, syncMode: 'local-only' },
      startupUrls: [], status: 'idle', createdAt: now, updatedAt: now,
    };
    const snapshot = async (profile: BrowserProfile) => {
      const launched = await kernel.launch(profile, { profileId: profile.id, headless: false });
      expect(launched.kernelUsed).toBe('chromium-cdp');
      const context = kernel.getAutomationContext(profile.id);
      const page = context.pages()[0] ?? await context.newPage();
      const result = await page.evaluate(async () => {
        const workerSource = 'onmessage=()=>postMessage({ua:navigator.userAgent,hc:navigator.hardwareConcurrency,webdriver:navigator.webdriver})';
        const worker = new Worker(URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' })));
        const workerResult = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('worker timeout')), 5000);
          worker.onmessage = (event) => { clearTimeout(timer); resolve(event.data); worker.terminate(); };
          worker.onerror = reject;
          worker.postMessage('collect');
        });
        return {
          ua: navigator.userAgent,
          hc: navigator.hardwareConcurrency,
          language: navigator.language,
          webdriver: navigator.webdriver,
          worker: workerResult,
        };
      });
      await kernel.close(profile.id);
      return result;
    };

    try {
      distribution.install(process.env.SHADOWEDGE_TEST_KERNEL_OLD_PACKAGE!);
      const before = await snapshot(source);
      distribution.install(process.env.SHADOWEDGE_TEST_KERNEL_NEW_PACKAGE!);
      expect(distribution.getStatus().activeVersion).toBe(newVersion);
      expect(source.kernelVersion).toBe(oldVersion);

      const clone = prepareKernelUpgrade(source, newVersion, distribution, join(dataDir, 'profiles'));
      const candidate = await snapshot(clone);
      expect(candidate).toEqual(before);
      expect(source.kernelVersion).toBe(oldVersion);
      expect(() => commitKernelUpgrade(source, clone, false, distribution)).toThrow();
      expect(source.kernelVersion).toBe(oldVersion);

      const upgraded = commitKernelUpgrade(source, clone, true, distribution);
      expect(upgraded.kernelVersion).toBe(newVersion);
      expect(upgraded.fingerprint).toEqual(source.fingerprint);
      const restarted = await snapshot(upgraded);
      expect(restarted).toEqual(before);
      console.log(JSON.stringify({ oldVersion, newVersion, imageStable: true, cloneStable: true, restartStable: true }));
    } finally {
      await kernel.closeAll();
    }
  }, 300000);
});
