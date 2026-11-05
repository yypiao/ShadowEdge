import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createConsoleLogger } from '@shadowedge/core';
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
import type { RpaScheduler } from '../src/main/services/rpa-scheduler.js';
import { StorageStateRepository } from '../src/main/services/storage-state-repository.js';

const executablePath = process.env.SHADOWEDGE_KERNEL_EXECUTABLE;
const SMOKE = process.env.SHADOWEDGE_SMOKE === '1' && executablePath !== undefined;

describe.skipIf(!SMOKE)('RPA 定时任务真实 Chromium 链路', () => {
  it('自动启动并关闭空闲环境，但不关闭用户预先打开的环境', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shadowedge-rpa-scheduler-smoke-'));
    const handle = openDatabase(':memory:');
    const crypto = new EnvelopeCrypto('00'.repeat(32));
    const repository = new RpaRepository(handle);
    const kernel = new BrowserKernel({
      drivers: [new ChromiumCdpDriver({ executablePath, fallbackToPatchright: false })],
    });
    const runtime = new KernelRuntimeService(join(dir, 'config'), {});
    runtime.configure({ executablePath, fallbackPolicy: 'require-chromium-cdp' });
    let scheduler: RpaScheduler | undefined;
    const handlers = createHandlers({
      logger: createConsoleLogger({ test: 'rpa-scheduler-smoke' }),
      emit: () => undefined,
      profileRepo: new ProfileRepository(handle),
      groupRepo: new GroupRepository(handle),
      proxyRepo: new ProxyRepository(handle, crypto),
      accountRepo: new AccountRepository(handle, crypto),
      rpaRepo: repository,
      storageStateRepo: new StorageStateRepository(handle, crypto),
      audit: new AuditLog(handle),
      sessions: new SessionRepository(handle),
      kernelRuntime: runtime,
      kernel,
      rpaArtifactsDir: join(dir, 'artifacts'),
      profilesDir: join(dir, 'profiles'),
      onRpaScheduler: (created) => { scheduler = created; },
    });
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><output id="result">scheduled-ok</output>');
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const profile = await handlers['profile:create']({
      name: 'scheduled-smoke', platform: 'host', fingerprintSeed: 'scheduled-smoke',
    });
    const workflow = await handlers['rpa:save']({
      name: '真实定时工作流',
      graph: {
        entry: 'open',
        nodes: {
          open: { id: 'open', kind: 'navigate', params: { url: origin }, next: 'extract' },
          extract: { id: 'extract', kind: 'extract', params: { selector: '#result', key: 'result' } },
        },
      },
    });
    let manuallyLaunched = false;
    try {
      const schedule = await handlers['rpa:setSchedule']({
        workflowId: workflow.id, profileIds: [profile.id], intervalMinutes: 1, enabled: true,
      });
      repository.saveSchedule({ ...schedule, nextRunAt: new Date(Date.now() - 1000).toISOString() });
      await scheduler!.tick();
      expect((await handlers['profile:get'](profile.id)).status).toBe('idle');
      expect(kernel.isActive(profile.id)).toBe(false);
      const firstRuns = await handlers['rpa:listRuns']({ limit: 10 });
      expect(firstRuns).toHaveLength(1);
      expect(firstRuns[0]).toMatchObject({ status: 'succeeded', outputs: { result: 'scheduled-ok' } });

      await handlers['profile:launch']({ profileId: profile.id });
      manuallyLaunched = true;
      const second = repository.getSchedule(workflow.id)!;
      repository.saveSchedule({ ...second, nextRunAt: new Date(Date.now() - 1000).toISOString() });
      await scheduler!.tick();
      expect((await handlers['profile:get'](profile.id)).status).toBe('running');
      expect(kernel.isActive(profile.id)).toBe(true);
      const allRuns = await handlers['rpa:listRuns']({ limit: 10 });
      expect(allRuns).toHaveLength(2);
      expect(allRuns.every((run) => run.status === 'succeeded')).toBe(true);
      expect(repository.getSchedule(workflow.id)?.lastError).toBeUndefined();
    } finally {
      if (manuallyLaunched || kernel.isActive(profile.id)) {
        await handlers['profile:close'](profile.id);
      }
      await scheduler!.stop();
      handle.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120000);
});
