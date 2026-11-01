import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createConsoleLogger,
  type BrowserProfile,
  type IpcEventName,
  type IpcEvents,
} from '@shadowedge/core';
import { EnvelopeCrypto } from '@shadowedge/crypto';
import { createHandlers } from '../src/main/handlers.js';
import { openDatabase, type ShadowEdgeDb } from '../src/main/services/db.js';
import { KernelRuntimeService } from '../src/main/services/kernel-runtime.js';
import { AuditLog, SessionRepository } from '../src/main/services/local-records.js';
import { ProfileRepository } from '../src/main/services/profile-repository.js';
import { ProxyRepository } from '../src/main/services/proxy-repository.js';

describe('桌面环境启动生命周期', () => {
  let dir: string;
  let handle: ShadowEdgeDb | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'shadowedge-profile-lifecycle-'));
  });

  afterEach(() => {
    handle?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('启动失败后数据库与事件都回滚为 idle，且不创建会话', async () => {
    handle = openDatabase(':memory:');
    const profiles = new ProfileRepository(handle);
    const runtime = new KernelRuntimeService(join(dir, 'config'), {});
    runtime.configure({ fallbackPolicy: 'require-chromium-cdp' });
    const statuses: Array<{ event: IpcEventName; payload: IpcEvents[IpcEventName] }> = [];
    const handlers = createHandlers({
      logger: createConsoleLogger({ test: 'launch-failure' }),
      emit: (event, payload) => statuses.push({ event, payload }),
      profileRepo: profiles,
      proxyRepo: new ProxyRepository(handle, new EnvelopeCrypto('00'.repeat(32))),
      audit: new AuditLog(handle),
      sessions: new SessionRepository(handle),
      kernelRuntime: runtime,
    });
    const profile = await handlers['profile:create']({
      name: 'launch-failure',
      platform: 'host',
      fingerprintSeed: 'launch-failure',
    });

    await expect(handlers['profile:launch']({ profileId: profile.id })).rejects.toMatchObject({
      code: 'E_KERNEL_LAUNCH_FAILED',
    });
    expect(profiles.get(profile.id)).toMatchObject({
      status: 'idle',
    } satisfies Partial<BrowserProfile>);
    expect(statuses).toEqual([
      { event: 'profile:status', payload: { profileId: profile.id, status: 'launching' } },
      { event: 'profile:status', payload: { profileId: profile.id, status: 'idle' } },
    ]);
    expect(handle.db.prepare('SELECT COUNT(*) AS count FROM sessions').get()).toEqual({ count: 0 });
    expect(
      handle.db
        .prepare("SELECT COUNT(*) AS count FROM audit_local WHERE action = 'profile:launch-failed'")
        .get(),
    ).toEqual({ count: 1 });
  });
});
