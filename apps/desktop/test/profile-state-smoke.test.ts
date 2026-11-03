import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConsoleLogger } from '@shadowedge/core';
import { EnvelopeCrypto } from '@shadowedge/crypto';
import { BrowserKernel, ChromiumCdpDriver } from '@shadowedge/kernel';
import { createHandlers, type Handlers } from '../src/main/handlers.js';
import { AccountRepository } from '../src/main/services/account-repository.js';
import { openDatabase, type ShadowEdgeDb } from '../src/main/services/db.js';
import { GroupRepository } from '../src/main/services/group-repository.js';
import { KernelRuntimeService } from '../src/main/services/kernel-runtime.js';
import { AuditLog, SessionRepository } from '../src/main/services/local-records.js';
import { ProfileRepository } from '../src/main/services/profile-repository.js';
import { ProxyRepository } from '../src/main/services/proxy-repository.js';
import { RpaRepository } from '../src/main/services/rpa-repository.js';
import { StorageStateRepository } from '../src/main/services/storage-state-repository.js';

const executablePath = process.env.SHADOWEDGE_KERNEL_EXECUTABLE;
const SMOKE = process.env.SHADOWEDGE_SMOKE === '1' && executablePath !== undefined;

async function writeState(values: { localValue: string; indexedValue: string }): Promise<void> {
  localStorage.setItem('login-state', values.localValue);
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('session-db', 1);
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore('sessions', { keyPath: 'id' });
      store.createIndex('token', 'token', { unique: false });
    };
    request.onsuccess = () => resolve(request.result);
  });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('sessions', 'readwrite');
    tx.objectStore('sessions').put({ id: 'current', token: values.indexedValue });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function readIndexedToken(): Promise<string | undefined> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('session-db', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
  const value = await new Promise<{ token: string } | undefined>((resolve, reject) => {
    const request = db.transaction('sessions', 'readonly').objectStore('sessions').get('current');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result as { token: string } | undefined);
  });
  db.close();
  return value?.token;
}

describe.skipIf(!SMOKE)('真实 Chromium 加密快照与崩溃恢复', () => {
  let dir: string;
  let server: Server | undefined;
  let handle: ShadowEdgeDb | undefined;

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'shadowedge-profile-state-')); });
  afterEach(async () => {
    handle?.close();
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  it('启动 URL 生效，关闭加密并清理目录，异常退出优先恢复目录新状态', async () => {
    server = createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><title>${request.url === '/start' ? 'startup' : 'state'}</title>`);
    });
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(0, '127.0.0.1', () => resolve());
    });
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    handle = openDatabase(':memory:');
    const crypto = new EnvelopeCrypto('77'.repeat(32));
    const profiles = new ProfileRepository(handle);
    const states = new StorageStateRepository(handle, crypto);
    const kernel = new BrowserKernel({
      drivers: [new ChromiumCdpDriver({ executablePath, fallbackToPatchright: false })],
    });
    const handlers: Handlers = createHandlers({
      logger: createConsoleLogger({ test: 'profile-state-smoke' }), emit: () => undefined,
      profileRepo: profiles, groupRepo: new GroupRepository(handle),
      proxyRepo: new ProxyRepository(handle, crypto), accountRepo: new AccountRepository(handle, crypto),
      rpaRepo: new RpaRepository(handle), storageStateRepo: states,
      audit: new AuditLog(handle), sessions: new SessionRepository(handle),
      kernelRuntime: new KernelRuntimeService(join(dir, 'config'), {}), kernel,
      profilesDir: join(dir, 'profiles'), rpaArtifactsDir: join(dir, 'artifacts'),
    });
    const profile = await handlers['profile:create']({
      name: 'state-smoke', fingerprintSeed: 'state-smoke', startupUrls: [`${origin}/start`],
    });
    try {
      await handlers['profile:launch']({ profileId: profile.id });
      const context = kernel.getAutomationContext(profile.id);
      expect(context.pages().some((page) => page.url() === `${origin}/start`)).toBe(true);
      const page = context.pages().find((item) => item.url() === `${origin}/start`)!;
      await page.goto(origin);
      await page.evaluate(writeState, { localValue: 'local-before-close', indexedValue: 'indexed-before-close' });
      await context.addCookies([{
        name: 'session', value: 'cookie-before-close', domain: '127.0.0.1', path: '/',
        expires: Math.floor(Date.now() / 1000) + 3600, httpOnly: true, secure: false, sameSite: 'Lax',
      }]);

      vi.spyOn(states, 'save').mockImplementationOnce(() => { throw new Error('injected snapshot failure'); });
      await expect(handlers['profile:close'](profile.id)).rejects.toMatchObject({
        code: 'E_STORAGE_STATE_FAILED',
      });
      expect(existsSync(profile.storage.userDataDir)).toBe(true);
      expect(kernel.isActive(profile.id)).toBe(false);
      vi.restoreAllMocks();

      await handlers['profile:launch']({ profileId: profile.id });
      const retryContext = kernel.getAutomationContext(profile.id);
      const retryPage = retryContext.pages().find((item) => item.url() === `${origin}/start`)!;
      await retryPage.goto(origin);
      expect(await retryPage.evaluate(readIndexedToken)).toBe('indexed-before-close');
      await retryContext.addCookies([{
        name: 'session_only', value: 'session-cookie-before-close', domain: '127.0.0.1', path: '/',
        expires: -1, httpOnly: true, secure: false, sameSite: 'Lax',
      }]);
      await handlers['profile:close'](profile.id);
      expect(existsSync(profile.storage.userDataDir)).toBe(false);
      expect(states.reveal(profile.id)?.origins[0]?.indexedDB?.[0]?.name).toBe('session-db');
      const encryptedRow = handle.db.prepare(
        'SELECT state_ciphertext || state_wrapped_key || state_iv AS payload FROM profile_storage_states',
      ).get() as { payload: string };
      expect(encryptedRow.payload).not.toContain('indexed-before-close');
      expect(encryptedRow.payload).not.toContain('cookie-before-close');

      const secondLaunch = await handlers['profile:launch']({ profileId: profile.id });
      const restored = kernel.getAutomationContext(profile.id);
      const restoredPage = restored.pages().find((item) => item.url() === `${origin}/start`)!;
      await restoredPage.goto(origin);
      expect(await restoredPage.evaluate(() => localStorage.getItem('login-state'))).toBe('local-before-close');
      expect(await restoredPage.evaluate(readIndexedToken)).toBe('indexed-before-close');
      expect((await restored.cookies([origin])).find((cookie) => cookie.name === 'session')?.value).toBe('cookie-before-close');

      await restoredPage.evaluate(writeState, { localValue: 'local-after-crash', indexedValue: 'indexed-after-crash' });
      // LocalStorage 由 Chromium 异步批量提交；等待落盘后才能验证崩溃目录恢复。
      await restoredPage.waitForTimeout(6000);
      const running = await kernel.listRunning();
      expect(running).toEqual([profile.id]);
      expect(secondLaunch.pid).toBeGreaterThan(0);
      process.kill(secondLaunch.pid!, 'SIGKILL');
      await expect.poll(() => kernel.isActive(profile.id), { timeout: 15000 }).toBe(false);
      profiles.save({ ...profiles.get(profile.id)!, status: 'idle' });
      expect(existsSync(profile.storage.userDataDir)).toBe(true);

      await handlers['profile:launch']({ profileId: profile.id });
      const recovered = kernel.getAutomationContext(profile.id);
      const recoveredPage = recovered.pages().find((item) => item.url() === `${origin}/start`)!;
      await recoveredPage.goto(origin);
      expect(await recoveredPage.evaluate(() => localStorage.getItem('login-state'))).toBe('local-after-crash');
      expect(await recoveredPage.evaluate(readIndexedToken)).toBe('indexed-after-crash');
      expect((await recovered.cookies([origin])).find((cookie) => cookie.name === 'session')?.value).toBe('cookie-before-close');
      expect((await recovered.cookies([origin])).find((cookie) => cookie.name === 'session_only')?.value).toBe('session-cookie-before-close');
      await handlers['profile:close'](profile.id);
      expect(existsSync(profile.storage.userDataDir)).toBe(false);
    } finally {
      await kernel.closeAll().catch(() => undefined);
    }
  }, 120000);
});
