import { describe, expect, it } from 'vitest';
import type { BrowserProfile } from '@shadowedge/core';
import { generateFingerprint } from '@shadowedge/fingerprint';
import { BrowserKernel } from '../src/index.js';
import type { KernelDriver, RunningInstance } from '../src/driver.js';

function makeProfile(id = 'lifecycle'): BrowserProfile {
  const now = new Date().toISOString();
  return {
    id,
    orgId: 'local',
    name: id,
    kernel: 'chromium-patched',
    fingerprint: generateFingerprint({ seed: `lifecycle-${id}` }),
    ownerId: 'local',
    sharedWith: [],
    storage: { userDataDir: `profiles/${id}`, remoteRevision: 0, syncMode: 'local-only' },
    startupUrls: [],
    status: 'idle',
    createdAt: now,
    updatedAt: now,
  };
}

function makeDriver() {
  let exitListener: (() => void) | undefined;
  let closeCalls = 0;
  const instance: RunningInstance = {
    profileId: 'lifecycle',
    pid: 321,
    startedAt: new Date().toISOString(),
    onExit: (listener) => {
      exitListener = listener;
    },
    close: async () => {
      closeCalls += 1;
    },
  };
  const driver: KernelDriver = { name: 'test-driver', launch: async () => instance };
  return {
    driver,
    get closeCalls() {
      return closeCalls;
    },
    emitExit: () => exitListener?.(),
  };
}

describe('BrowserKernel 生命周期', () => {
  it('浏览器自行退出会清理运行记录并通知上层', async () => {
    const { driver, emitExit } = makeDriver();
    const exited: string[] = [];
    const kernel = new BrowserKernel({ drivers: [driver], onExit: (id) => exited.push(id) });
    const profile = makeProfile();
    const result = await kernel.launch(profile, { profileId: profile.id });
    expect(result.pid).toBe(321);
    expect(await kernel.listRunning()).toEqual([profile.id]);

    emitExit();
    expect(await kernel.listRunning()).toEqual([]);
    expect(exited).toEqual([profile.id]);

    await kernel.close(profile.id);
    expect(exited).toEqual([profile.id]);
  });

  it('显式关闭幂等且不会误报异常退出', async () => {
    const state = makeDriver();
    const { driver, emitExit } = state;
    const exited: string[] = [];
    const kernel = new BrowserKernel({ drivers: [driver], onExit: (id) => exited.push(id) });
    const profile = makeProfile();
    await kernel.launch(profile, { profileId: profile.id });

    await kernel.close(profile.id);
    emitExit();
    await kernel.close(profile.id);
    expect(state.closeCalls).toBe(1);
    expect(exited).toEqual([]);
    expect(await kernel.listRunning()).toEqual([]);
  });

  it('退出前拒绝重复启动，退出后可立即重启', async () => {
    const first = makeDriver();
    const kernel = new BrowserKernel({ drivers: [first.driver] });
    const profile = makeProfile();
    await kernel.launch(profile, { profileId: profile.id });
    await expect(kernel.launch(profile, { profileId: profile.id })).rejects.toMatchObject({
      code: 'E_PROFILE_BUSY',
    });

    first.emitExit();
    await expect(kernel.launch(profile, { profileId: profile.id })).resolves.toMatchObject({
      profileId: profile.id,
    });
    await kernel.close(profile.id);
  });

  it('驱动启动失败不会残留运行记录', async () => {
    const driver: KernelDriver = {
      name: 'broken-driver',
      launch: async () => {
        throw new Error('launch failed');
      },
    };
    const kernel = new BrowserKernel({ drivers: [driver] });
    const profile = makeProfile();
    await expect(kernel.launch(profile, { profileId: profile.id })).rejects.toThrow(
      'launch failed',
    );
    expect(await kernel.listRunning()).toEqual([]);
  });
});
