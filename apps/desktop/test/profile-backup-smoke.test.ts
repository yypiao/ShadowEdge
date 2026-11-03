import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createConsoleLogger, type ProfileBackupEnvelope } from '@shadowedge/core';
import { EnvelopeCrypto } from '@shadowedge/crypto';
import { BrowserKernel, ChromiumCdpDriver } from '@shadowedge/kernel';
import { createHandlers, type Handlers } from '../src/main/handlers.js';
import { AccountRepository } from '../src/main/services/account-repository.js';
import { openDatabase, type ShadowEdgeDb } from '../src/main/services/db.js';
import { KernelRuntimeService } from '../src/main/services/kernel-runtime.js';
import { AuditLog, SessionRepository } from '../src/main/services/local-records.js';
import { ProfileRepository } from '../src/main/services/profile-repository.js';
import { GroupRepository } from '../src/main/services/group-repository.js';
import { ProxyRepository } from '../src/main/services/proxy-repository.js';
import { RpaRepository } from '../src/main/services/rpa-repository.js';
import { StorageStateRepository } from '../src/main/services/storage-state-repository.js';

const executablePath = process.env.SHADOWEDGE_KERNEL_EXECUTABLE;
const SMOKE = process.env.SHADOWEDGE_SMOKE === '1' && executablePath !== undefined;
const PASSPHRASE = 'correct horse battery staple';

describe.skipIf(!SMOKE)('真实 Chromium 环境加密迁移', () => {
  let dir: string;
  let server: Server | undefined;
  let handle: ShadowEdgeDb | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'shadowedge-profile-backup-'));
  });

  afterEach(async () => {
    handle?.close();
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  it('密文不泄密，错误口令与篡改拒绝，首次启动恢复 Cookie、LocalStorage 和 IndexedDB', async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><title>backup</title>');
    });
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(0, '127.0.0.1', () => resolve());
    });
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    handle = openDatabase(':memory:');
    const crypto = new EnvelopeCrypto('66'.repeat(32));
    const profiles = new ProfileRepository(handle);
    const proxies = new ProxyRepository(handle, crypto);
    const storageStates = new StorageStateRepository(handle, crypto);
    const runtime = new KernelRuntimeService(join(dir, 'config'), {});
    const kernel = new BrowserKernel({
      drivers: [new ChromiumCdpDriver({ executablePath, fallbackToPatchright: false })],
    });
    let contents = '';
    const handlers: Handlers = createHandlers({
      logger: createConsoleLogger({ test: 'profile-backup-smoke' }),
      emit: () => undefined,
      profileRepo: profiles,
      groupRepo: new GroupRepository(handle),
      proxyRepo: proxies,
      accountRepo: new AccountRepository(handle, crypto),
      rpaRepo: new RpaRepository(handle),
      storageStateRepo: storageStates,
      audit: new AuditLog(handle),
      sessions: new SessionRepository(handle),
      kernelRuntime: runtime,
      kernel,
      rpaArtifactsDir: join(dir, 'artifacts'),
      profilesDir: join(dir, 'profiles'),
      saveProfileBackup: async (_fileName, value) => {
        contents = value;
        return join(dir, 'backup.sebackup');
      },
    });
    const source = await handlers['profile:create']({
      name: 'backup-source',
      fingerprintSeed: 'backup-source-seed',
    });
    let importedId: string | undefined;
    try {
      await handlers['profile:launch']({ profileId: source.id });
      const sourceContext = kernel.getAutomationContext(source.id);
      const page = sourceContext.pages()[0] ?? await sourceContext.newPage();
      await page.goto(origin);
      await page.evaluate(() => localStorage.setItem('login-state', 'local-storage-secret'));
      await page.evaluate(async () => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open('auth-db', 1);
          request.onerror = () => reject(request.error);
          request.onupgradeneeded = () => {
            const store = request.result.createObjectStore('sessions', { keyPath: 'id' });
            store.createIndex('token', 'token', { unique: false });
          };
          request.onsuccess = () => resolve(request.result);
        });
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction('sessions', 'readwrite');
          tx.objectStore('sessions').put({ id: 'current', token: 'indexed-db-secret' });
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
        db.close();
      });
      await sourceContext.addCookies([{
        name: 'session', value: 'cookie-secret', domain: '127.0.0.1', path: '/',
        expires: -1, httpOnly: true, secure: false, sameSite: 'Lax',
      }]);
      const proxy = await handlers['proxy:upsert']({
        id: 'backup-proxy', orgId: 'local', label: 'backup-proxy', protocol: 'http',
        host: '127.0.0.1', port: 8899, username: 'proxy-user', password: 'proxy-secret', tags: [],
      });
      profiles.save({ ...source, proxyId: proxy.id });

      const exported = await handlers['profile:export']({
        profileId: source.id,
        passphrase: PASSPHRASE,
      });
      expect(exported.saved).toBe(true);
      expect(exported.cookieCount).toBe(1);
      expect(exported.originCount).toBe(1);
      expect(exported.indexedDbCount).toBe(1);
      expect(contents).not.toContain('cookie-secret');
      expect(contents).not.toContain('local-storage-secret');
      expect(contents).not.toContain('indexed-db-secret');
      expect(contents).not.toContain('proxy-secret');
      expect(contents).not.toContain('backup-source');

      await expect(handlers['profile:import']({
        contents,
        passphrase: 'definitely wrong passphrase',
      })).rejects.toMatchObject({ code: 'E_CRYPTO_UNSEAL_FAILED' });
      expect(await handlers['profile:list'](undefined)).toHaveLength(1);

      const imported = await handlers['profile:import']({
        contents,
        passphrase: PASSPHRASE,
        name: 'backup-imported',
      });
      expect(imported.imported).toBe(true);
      const importedProfile = imported.profile!;
      importedId = importedProfile.id;
      expect(importedProfile.id).not.toBe(source.id);
      expect(importedProfile.fingerprint).toEqual(source.fingerprint);
      expect(importedProfile.proxyId).not.toBe(proxy.id);
      expect(proxies.reveal(importedProfile.proxyId!)).toBe('proxy-secret');
      expect(storageStates.reveal(importedProfile.id)?.cookies[0]?.value).toBe('cookie-secret');

      // 本测试不经过代理联网，单独验证代理凭据迁移后改回直连以验证站点状态。
      profiles.save({ ...importedProfile, proxyId: undefined });
      await handlers['profile:launch']({ profileId: importedProfile.id });
      expect(storageStates.reveal(importedProfile.id)?.cookies[0]?.value).toBe('cookie-secret');
      const importedContext = kernel.getAutomationContext(importedProfile.id);
      const importedPage = importedContext.pages()[0] ?? await importedContext.newPage();
      await importedPage.goto(origin);
      expect(await importedPage.evaluate(() => localStorage.getItem('login-state'))).toBe(
        'local-storage-secret',
      );
      const cookies = await importedContext.cookies([origin]);
      expect(cookies.find((cookie) => cookie.name === 'session')?.value).toBe('cookie-secret');
      const indexedToken = await importedPage.evaluate(async () => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open('auth-db', 1);
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
      });
      expect(indexedToken).toBe('indexed-db-secret');

      const envelope = JSON.parse(contents) as ProfileBackupEnvelope;
      const ciphertext = Buffer.from(envelope.payload.ciphertext, 'base64');
      ciphertext[0]! ^= 1;
      envelope.payload.ciphertext = ciphertext.toString('base64');
      await expect(handlers['profile:import']({
        contents: JSON.stringify(envelope),
        passphrase: PASSPHRASE,
      })).rejects.toMatchObject({ code: 'E_CRYPTO_UNSEAL_FAILED' });
    } finally {
      await handlers['profile:close'](source.id);
      if (importedId) await handlers['profile:close'](importedId);
    }
  }, 120000);
});
