import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createConsoleLogger,
  type BrowserProfile,
  type IpcEventName,
  type IpcEvents,
} from '@shadowedge/core';
import { EnvelopeCrypto } from '@shadowedge/crypto';
import { generateFingerprint } from '@shadowedge/fingerprint';
import { BrowserKernel, ChromiumCdpDriver } from '@shadowedge/kernel';
import { chromium } from 'patchright';
import { KernelRuntimeService } from '../src/main/services/kernel-runtime.js';
import { createHandlers } from '../src/main/handlers.js';
import { openDatabase } from '../src/main/services/db.js';
import { ProfileRepository } from '../src/main/services/profile-repository.js';
import { GroupRepository } from '../src/main/services/group-repository.js';
import { ProxyRepository } from '../src/main/services/proxy-repository.js';
import { AccountRepository } from '../src/main/services/account-repository.js';
import { RpaRepository } from '../src/main/services/rpa-repository.js';
import { StorageStateRepository } from '../src/main/services/storage-state-repository.js';
import { AuditLog, SessionRepository } from '../src/main/services/local-records.js';

const executablePath = process.env.SHADOWEDGE_KERNEL_EXECUTABLE;
const SMOKE = process.env.SHADOWEDGE_SMOKE === '1' && executablePath !== undefined;

describe.skipIf(!SMOKE)('桌面配置到自研内核的真实启动链路', () => {
  it('持久化严格配置后，BrowserKernel 使用 chromium-cdp 且带名原生串生效', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shadowedge-desktop-kernel-smoke-'));
    const runtime = new KernelRuntimeService(join(dir, 'config'), {});
    runtime.configure({ executablePath, fallbackPolicy: 'require-chromium-cdp' });
    const restored = new KernelRuntimeService(join(dir, 'config'), {});
    const kernel = new BrowserKernel({
      drivers: [new ChromiumCdpDriver(restored.driverOptions())],
    });
    const now = new Date().toISOString();
    const profile: BrowserProfile = {
      id: 'desktop-kernel-smoke',
      orgId: 'local',
      name: 'smoke',
      kernel: 'chromium-patched',
      fingerprint: generateFingerprint({ seed: 'desktop-kernel-smoke' }),
      ownerId: 'local-user',
      sharedWith: [],
      storage: { userDataDir: join(dir, 'profile'), remoteRevision: 0, syncMode: 'local-only' },
      startupUrls: [],
      status: 'idle',
      createdAt: now,
      updatedAt: now,
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
  it('手动关闭和异常退出都会回收状态，并能立即重启', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shadowedge-kernel-lifecycle-'));
    const handle = openDatabase(join(dir, 'lifecycle.db'));
    const profiles = new ProfileRepository(handle);
    const runtime = new KernelRuntimeService(join(dir, 'config'), {});
    runtime.configure({ executablePath, fallbackPolicy: 'require-chromium-cdp' });
    const events: Array<{ event: IpcEventName; payload: IpcEvents[IpcEventName] }> = [];
    const handlers = createHandlers({
      logger: createConsoleLogger({ test: 'kernel-lifecycle' }),
      emit: (event, payload) => events.push({ event, payload }),
      profileRepo: profiles,
      groupRepo: new GroupRepository(handle),
      proxyRepo: new ProxyRepository(handle, new EnvelopeCrypto('00'.repeat(32))),
      accountRepo: new AccountRepository(handle, new EnvelopeCrypto('00'.repeat(32))),
      rpaRepo: new RpaRepository(handle),
      storageStateRepo: new StorageStateRepository(handle, new EnvelopeCrypto('00'.repeat(32))),
      audit: new AuditLog(handle),
      sessions: new SessionRepository(handle),
      kernelRuntime: runtime,
    });
    let profileId: string | undefined;
    let cdp: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
    try {
      const profile = await handlers['profile:create']({
        name: 'lifecycle-smoke',
        platform: 'host',
        fingerprintSeed: 'lifecycle-smoke',
      });
      profileId = profile.id;
      const launched = await handlers['profile:launch']({
        profileId: profile.id,
        remoteDebugging: true,
      });
      expect(launched.kernelUsed).toBe('chromium-cdp');
      expect(launched.pid).toBeGreaterThan(0);
      expect(profiles.get(profile.id)?.status).toBe('running');

      cdp = await chromium.connectOverCDP(launched.wsEndpoint!);
      const browserSession = await cdp.newBrowserCDPSession();
      await browserSession.send('Browser.close');
      await cdp.close();
      cdp = undefined;
      await expect.poll(() => profiles.get(profile.id)?.status, { timeout: 10000 }).toBe('idle');
      expect(events).toContainEqual({
        event: 'profile:status',
        payload: { profileId: profile.id, status: 'idle' },
      });
      const session = handle.db
        .prepare(
          'SELECT ended_at FROM sessions WHERE profile_id = ? ORDER BY started_at DESC LIMIT 1',
        )
        .get(profile.id) as { ended_at: string | null };
      expect(session.ended_at).not.toBeNull();

      const restarted = await handlers['profile:launch']({ profileId: profile.id });
      expect(restarted.pid).toBeGreaterThan(0);
      expect(profiles.get(profile.id)?.status).toBe('running');
      process.kill(restarted.pid!, 'SIGKILL');
      await expect.poll(() => profiles.get(profile.id)?.status, { timeout: 10000 }).toBe('idle');

      const thirdLaunch = await handlers['profile:launch']({ profileId: profile.id });
      expect(thirdLaunch.pid).toBeGreaterThan(0);
      await handlers['profile:close'](profile.id);
      expect(profiles.get(profile.id)?.status).toBe('idle');
      const openSessions = handle.db
        .prepare('SELECT COUNT(*) AS count FROM sessions WHERE profile_id = ? AND ended_at IS NULL')
        .get(profile.id) as { count: number };
      expect(openSessions.count).toBe(0);
    } finally {
      await cdp?.close();
      if (profileId) await handlers['profile:close'](profileId);
      handle.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90000);
});
