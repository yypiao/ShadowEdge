import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createConsoleLogger } from '@shadowedge/core';
import { EnvelopeCrypto } from '@shadowedge/crypto';
import { BrowserKernel, ChromiumCdpDriver } from '@shadowedge/kernel';
import type { BrowserContext, Page } from 'patchright';
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
const OWNERS = ['alpha', 'beta', 'gamma'] as const;

describe.skipIf(!SMOKE)('多 Chromium 实例 RPA 并行隔离', () => {
  it('三个环境的存储、录制事件、标签页和并发回放互不串台', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shadowedge-multi-instance-rpa-'));
    const handle = openDatabase(':memory:');
    const crypto = new EnvelopeCrypto('00'.repeat(32));
    const rpaRepo = new RpaRepository(handle);
    const kernel = new BrowserKernel({
      drivers: [new ChromiumCdpDriver({ executablePath, fallbackToPatchright: false })],
    });
    const runtime = new KernelRuntimeService(join(dir, 'config'), {});
    runtime.configure({ executablePath, fallbackPolicy: 'require-chromium-cdp' });
    const handlers = createHandlers({
      logger: createConsoleLogger({ test: 'multi-instance-rpa-isolation-smoke' }),
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
    const server: Server = createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      if (request.url?.startsWith('/nested')) {
        response.end('<!doctype html><input id="nested-input" aria-label="Nested">');
      } else if (request.url?.startsWith('/tab')) {
        response.end('<!doctype html><input id="shared-input" aria-label="Shared">');
      } else {
        response.end(`<!doctype html>
          <input id="shared-input" aria-label="Shared">
          <iframe id="nested" src="/nested"></iframe>`);
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const profiles = await Promise.all(OWNERS.map((owner) => handlers['profile:create']({
      name: `parallel-${owner}`,
      platform: 'host',
      fingerprintSeed: `parallel-${owner}`,
    })));
    const launched = new Set<string>();
    try {
      await Promise.all(profiles.map(async (profile) => {
        await handlers['profile:launch']({ profileId: profile.id });
        launched.add(profile.id);
      }));
      const contexts = new Map<string, BrowserContext>(profiles.map((profile) => [
        profile.id,
        kernel.getAutomationContext(profile.id),
      ]));
      expect(new Set(contexts.values()).size).toBe(OWNERS.length);
      await Promise.all(profiles.map((profile, index) => handlers['rpa:startRecording']({
        profileId: profile.id,
        startUrl: `${origin}/main?owner=${OWNERS[index]}`,
      })));
      const mainPages = new Map<string, Page>(profiles.map((profile, index) => [
        profile.id,
        contexts.get(profile.id)!.pages().find((page) =>
          page.url() === `${origin}/main?owner=${OWNERS[index]}`)!,
      ]));

      await Promise.all(profiles.map(async (profile, index) => {
        const owner = OWNERS[index]!;
        const page = mainPages.get(profile.id)!;
        await page.evaluate((value) => {
          localStorage.setItem('owner', value);
          sessionStorage.setItem('owner', value);
          document.cookie = `owner=${value}; path=/`;
        }, owner);
        await page.locator('#shared-input').fill(`main-${owner}`);
        await page.frameLocator('#nested').locator('#nested-input').fill(`nested-${owner}`);
      }));

      const tabs = new Map<string, Page>();
      await Promise.all(profiles.map(async (profile, index) => {
        const owner = OWNERS[index]!;
        const tab = await contexts.get(profile.id)!.newPage();
        tabs.set(profile.id, tab);
        await tab.goto(`${origin}/tab?owner=${owner}`);
        await tab.waitForFunction(() => Array.from(document.documentElement?.attributes ?? [])
          .some((attribute) => attribute.name.startsWith('__shadowedge_rpa_frame_')));
        await tab.locator('#shared-input').fill(`tab-${owner}`);
      }));
      await Promise.all(profiles.map(async (profile, index) => {
        await tabs.get(profile.id)!.close();
        await mainPages.get(profile.id)!.locator('#shared-input').fill(`final-${OWNERS[index]}`);
      }));
      // 等待 exposeBinding 已接收最后的页面事件；stop 本身会等待各环境自己的事件队列。
      await Promise.all(profiles.map((profile) => mainPages.get(profile.id)!.waitForTimeout(150)));
      const recorded = await Promise.all(profiles.map((profile) =>
        handlers['rpa:stopRecording'](profile.id)));

      for (const [index, result] of recorded.entries()) {
        const owner = OWNERS[index]!;
        expect(result.droppedActions).toBe(0);
        const nodes = Object.values(result.graph.nodes);
        const texts = nodes.filter((node) => node.kind === 'type')
          .map((node) => node.params.text).sort();
        expect(texts).toEqual([
          `final-${owner}`, `main-${owner}`, `nested-${owner}`, `tab-${owner}`,
        ].sort());
        expect(nodes.filter((node) => node.kind === 'closeTab')).toHaveLength(1);
        expect(nodes.find((node) => node.params.text === `nested-${owner}`)?.params)
          .toMatchObject({ frameSelectors: ['#nested'] });
        const serialized = JSON.stringify(result.graph);
        for (const foreign of OWNERS.filter((candidate) => candidate !== owner)) {
          expect(serialized).not.toContain(foreign);
        }
      }

      const workflows = await Promise.all(recorded.map((result, index) => handlers['rpa:save']({
        name: `parallel-${OWNERS[index]}`,
        graph: result.graph,
      })));
      const runGroups = await Promise.all(workflows.map((workflow, index) => handlers['rpa:run']({
        workflow,
        profileIds: [profiles[index]!.id],
      })));
      const runs = runGroups.map((group) => group[0]!);
      await Promise.all(runs.map((run) => expect.poll(async () =>
        (await handlers['rpa:get'](run.id)).status, { timeout: 60000 }).toBe('succeeded')));

      await Promise.all(profiles.map(async (profile, index) => {
        const owner = OWNERS[index]!;
        const page = mainPages.get(profile.id)!;
        await expect(page.locator('#shared-input').inputValue()).resolves.toBe(`final-${owner}`);
        await expect(page.frameLocator('#nested').locator('#nested-input').inputValue())
          .resolves.toBe(`nested-${owner}`);
        expect(await page.evaluate(() => ({
          local: localStorage.getItem('owner'),
          session: sessionStorage.getItem('owner'),
          cookie: document.cookie,
          userAgent: navigator.userAgent,
        }))).toEqual({
          local: owner,
          session: owner,
          cookie: `owner=${owner}`,
          userAgent: profile.fingerprint.userAgent,
        });
        expect(contexts.get(profile.id)!.pages()).toHaveLength(1);
      }));
      expect(new Set(profiles.map((profile) => JSON.stringify(profile.fingerprint))).size)
        .toBe(OWNERS.length);
      expect(new Set(profiles.map((profile) => profile.storage.userDataDir)).size)
        .toBe(OWNERS.length);
    } finally {
      await Promise.all(profiles.map(async (profile) => {
        if (launched.has(profile.id)) await handlers['profile:close'](profile.id);
      }));
      handle.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180000);
});
