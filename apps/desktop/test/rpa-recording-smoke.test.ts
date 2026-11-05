import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createConsoleLogger, type RpaWorkflow } from '@shadowedge/core';
import { EnvelopeCrypto } from '@shadowedge/crypto';
import { BrowserKernel, ChromiumCdpDriver } from '@shadowedge/kernel';
import { createHandlers } from '../src/main/handlers.js';
import { AccountRepository } from '../src/main/services/account-repository.js';
import { openDatabase } from '../src/main/services/db.js';
import { GroupRepository } from '../src/main/services/group-repository.js';
import { KernelRuntimeService } from '../src/main/services/kernel-runtime.js';
import { AuditLog, SessionRepository } from '../src/main/services/local-records.js';
import { ProfileRepository } from '../src/main/services/profile-repository.js';
import { ProxyRepository } from '../src/main/services/proxy-repository.js';
import { RpaRepository } from '../src/main/services/rpa-repository.js';
import { StorageStateRepository } from '../src/main/services/storage-state-repository.js';

const executablePath = process.env.SHADOWEDGE_KERNEL_EXECUTABLE;
const SMOKE = process.env.SHADOWEDGE_SMOKE === '1' && executablePath !== undefined;

describe.skipIf(!SMOKE)('RPA 录制回放真实 Chromium 链路', () => {
  it('录制导航、输入和点击，密码不落图，停止后可立即回放', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shadowedge-rpa-recording-'));
    const handle = openDatabase(':memory:');
    const crypto = new EnvelopeCrypto('00'.repeat(32));
    const rpaRepo = new RpaRepository(handle);
    const kernel = new BrowserKernel({
      drivers: [new ChromiumCdpDriver({ executablePath, fallbackToPatchright: false })],
    });
    const runtime = new KernelRuntimeService(join(dir, 'config'), {});
    runtime.configure({ executablePath, fallbackPolicy: 'require-chromium-cdp' });
    const handlers = createHandlers({
      logger: createConsoleLogger({ test: 'rpa-recording-smoke' }),
      emit: () => undefined,
      profileRepo: new ProfileRepository(handle),
      groupRepo: new GroupRepository(handle),
      proxyRepo: new ProxyRepository(handle, crypto),
      accountRepo: new AccountRepository(handle, crypto),
      rpaRepo,
      storageStateRepo: new StorageStateRepository(handle, crypto),
      audit: new AuditLog(handle),
      sessions: new SessionRepository(handle),
      kernelRuntime: runtime,
      kernel,
      rpaArtifactsDir: join(dir, 'artifacts'),
      profilesDir: join(dir, 'profiles'),
    });
    const server: Server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html>
        <input id="name" aria-label="Name">
        <input id="password" type="password">
        <button id="submit" onclick="document.querySelector('#result').textContent = 'Hello ' + document.querySelector('#name').value">Submit</button>
        <output id="result"></output>`);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const profile = await handlers['profile:create']({
      name: 'rpa-recording', platform: 'host', fingerprintSeed: 'rpa-recording',
    });
    let launched = false;
    try {
      await handlers['profile:launch']({ profileId: profile.id });
      launched = true;
      const state = await handlers['rpa:startRecording']({ profileId: profile.id, startUrl: origin });
      expect(state.profileId).toBe(profile.id);
      const page = kernel.getAutomationContext(profile.id).pages()
        .find((candidate) => candidate.url() === `${origin}/`)!;
      const placeholder: RpaWorkflow = {
        id: 'blocked-during-recording', orgId: 'local', name: 'blocked', version: 1,
        graph: { entry: 'wait', nodes: { wait: { id: 'wait', kind: 'wait', params: { ms: 0 } } } },
        createdBy: 'local-user', updatedAt: new Date().toISOString(),
      };
      const blocked = await handlers['rpa:run']({ workflow: placeholder, profileIds: [profile.id] });
      expect(blocked[0]).toMatchObject({ status: 'failed', error: expect.stringContaining('正在录制') });
      await page.locator('#name').fill('Ada');
      await page.locator('#password').fill('do-not-record-this-password');
      await page.getByRole('button', { name: 'Submit' }).click();
      await expect.poll(() => page.locator('#result').textContent()).toBe('Hello Ada');
      await page.waitForTimeout(50);
      const recorded = await handlers['rpa:stopRecording'](profile.id);
      expect(Object.values(recorded.graph.nodes).map((node) => node.kind)).toEqual([
        'navigate', 'type', 'click',
      ]);
      expect(recorded.ignoredPasswordFields).toBe(1);
      expect(recorded.droppedActions).toBe(0);
      expect(JSON.stringify(recorded)).not.toContain('do-not-record-this-password');
      const saved = await handlers['rpa:save']({ name: '录制问候', graph: recorded.graph });
      expect(JSON.stringify(saved)).not.toContain('do-not-record-this-password');

      const runs = await handlers['rpa:run']({ workflow: saved, profileIds: [profile.id] });
      await expect.poll(async () => (await handlers['rpa:get'](runs[0]!.id)).status, {
        timeout: 30000,
      }).toBe('succeeded');
      await expect.poll(() => page.locator('#result').textContent()).toBe('Hello Ada');
      await expect(handlers['rpa:stopRecording'](profile.id)).rejects.toMatchObject({
        code: 'E_RPA_RECORDING_NOT_FOUND',
      });
    } finally {
      if (launched) await handlers['profile:close'](profile.id);
      handle.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120000);
});
