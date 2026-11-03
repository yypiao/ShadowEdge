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

function makeDriver(profileId = 'lifecycle') {
  let exitListener: (() => void) | undefined;
  let closeCalls = 0;
  const instance: RunningInstance = {
    profileId,
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

  it('启动中拒绝重复启动，停止会等待启动收口后关闭实例', async () => {
    const profile = makeProfile();
    let launchCalls = 0;
    let closeCalls = 0;
    let release!: (instance: RunningInstance) => void;
    const pending = new Promise<RunningInstance>((resolve) => {
      release = resolve;
    });
    const driver: KernelDriver = {
      name: 'delayed-driver',
      launch: async () => {
        launchCalls += 1;
        return pending;
      },
    };
    const kernel = new BrowserKernel({ drivers: [driver] });
    const launching = kernel.launch(profile, { profileId: profile.id });
    await expect(kernel.launch(profile, { profileId: profile.id })).rejects.toMatchObject({
      code: 'E_PROFILE_BUSY',
    });
    expect(launchCalls).toBe(1);

    const closing = kernel.close(profile.id);
    release({
      profileId: profile.id,
      startedAt: new Date().toISOString(),
      onExit: () => undefined,
      close: async () => {
        closeCalls += 1;
      },
    });
    await launching;
    await closing;
    expect(closeCalls).toBe(1);
    expect(kernel.isActive(profile.id)).toBe(false);
  });

  it('closeAll 回收全部运行实例', async () => {
    const closed: string[] = [];
    const driver: KernelDriver = {
      name: 'multi-driver',
      launch: async ({ profile }) => ({
        profileId: profile.id,
        startedAt: new Date().toISOString(),
        onExit: () => undefined,
        close: async () => {
          closed.push(profile.id);
        },
      }),
    };
    const kernel = new BrowserKernel({ drivers: [driver] });
    const first = makeProfile('first');
    const second = makeProfile('second');
    await kernel.launch(first, { profileId: first.id });
    await kernel.launch(second, { profileId: second.id });

    await kernel.closeAll();
    expect(closed).toEqual([first.id, second.id]);
    expect(await kernel.listRunning()).toEqual([]);
  });
});
