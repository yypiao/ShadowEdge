import { describe, expect, it } from 'vitest';
import type { BrowserProfile } from '@shadowedge/core';
import { generateFingerprint } from '@shadowedge/fingerprint';
import {
  ChromiumCdpDriver,
  encodeFingerprintPortrait,
  resolveKernelExecutable,
} from '../src/drivers/chromium-cdp.js';
import type { KernelDriver, RunningInstance } from '../src/driver.js';

function makeSpec(): Parameters<KernelDriver['launch']>[0] {
  const now = new Date().toISOString();
  const profile: BrowserProfile = {
    id: 'p1',
    orgId: 'local',
    name: 't',
    kernel: 'chromium-patched',
    fingerprint: generateFingerprint({ seed: 'chromium-cdp-test' }),
    ownerId: 'local-user',
    sharedWith: [],
    storage: { userDataDir: 'profiles/p1', remoteRevision: 0, syncMode: 'local-only' },
    startupUrls: [],
    status: 'idle',
    createdAt: now,
    updatedAt: now,
  };
  return { profile, options: { profileId: 'p1' } };
}

describe('chromium-cdp 驱动', () => {
  it('resolveKernelExecutable：路径不存在时返回 undefined 走回退', () => {
    expect(resolveKernelExecutable('/nonexistent/Chromium')).toBeUndefined();
    expect(resolveKernelExecutable()).toBeUndefined(); // 测试环境未设 env
    expect(resolveKernelExecutable('/bin/sh')).toBe('/bin/sh');
  });

  it('encodeFingerprintPortrait：base64-JSON 与内核 0001 校验口径一致', () => {
    const spec = makeSpec();
    const decoded = JSON.parse(
      Buffer.from(encodeFingerprintPortrait(spec), 'base64').toString('utf8'),
    );
    expect(decoded).toEqual(JSON.parse(JSON.stringify(spec.profile.fingerprint)));
  });

  it('内核缺失时回退并显式标记 kernelUsed', async () => {
    const stubInstance: RunningInstance = {
      profileId: 'p1',
      pid: 0,
      startedAt: new Date().toISOString(),
      onExit: () => undefined,
      close: async () => {},
    };
    const stubDriver: KernelDriver = {
      name: 'patchright-chromium',
      launch: async () => stubInstance,
    };
    const driver = new ChromiumCdpDriver({
      executablePath: '/nonexistent/Chromium',
      fallbackDriver: stubDriver,
    });
    const instance = await driver.launch(makeSpec());
    expect(instance.kernelUsed).toBe('patchright-chromium');
  });

  it('函数形式回退策略支持运行时切换', async () => {
    let allowFallback = true;
    const stubInstance: RunningInstance = {
      profileId: 'p1',
      pid: 0,
      startedAt: new Date().toISOString(),
      onExit: () => undefined,
      close: async () => {},
    };
    const fallbackDriver: KernelDriver = {
      name: 'patchright-chromium',
      launch: async () => stubInstance,
    };
    const driver = new ChromiumCdpDriver({
      executablePath: () => '/nonexistent/Chromium',
      fallbackToPatchright: () => allowFallback,
      fallbackDriver,
    });
    await expect(driver.launch(makeSpec())).resolves.toMatchObject({
      kernelUsed: 'patchright-chromium',
    });
    allowFallback = false;
    await expect(driver.launch(makeSpec())).rejects.toMatchObject({
      code: 'E_KERNEL_LAUNCH_FAILED',
    });
  });

  it('回退禁用且内核缺失时抛 E_KERNEL_LAUNCH_FAILED', async () => {
    const driver = new ChromiumCdpDriver({
      executablePath: '/nonexistent/Chromium',
      fallbackToPatchright: false,
    });
    await expect(driver.launch(makeSpec())).rejects.toMatchObject({
      code: 'E_KERNEL_LAUNCH_FAILED',
    });
  });
});
