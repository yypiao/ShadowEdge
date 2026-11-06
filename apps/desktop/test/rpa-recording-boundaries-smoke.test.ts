import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
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
import { StorageStateRepository } from '../src/main/services/storage-state-repository.js';

const executablePath = process.env.SHADOWEDGE_KERNEL_EXECUTABLE;
const SMOKE = process.env.SHADOWEDGE_SMOKE === '1' && executablePath !== undefined;

describe.skipIf(!SMOKE)('RPA 录制边界真实 Chromium 链路', () => {
  it('多选、嵌套 Iframe 与关闭标签页可录制并完整回放', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shadowedge-rpa-recording-boundaries-'));
    const handle = openDatabase(':memory:');
    const crypto = new EnvelopeCrypto('00'.repeat(32));
    const rpaRepo = new RpaRepository(handle);
    const kernel = new BrowserKernel({
      drivers: [new ChromiumCdpDriver({ executablePath, fallbackToPatchright: false })],
    });
    const runtime = new KernelRuntimeService(join(dir, 'config'), {});
    runtime.configure({ executablePath, fallbackPolicy: 'require-chromium-cdp' });
    const handlers = createHandlers({
      logger: createConsoleLogger({ test: 'rpa-recording-boundaries-smoke' }),
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
      if (request.url === '/outer') {
        response.end('<!doctype html><iframe id="inner" src="/inner"></iframe>');
      } else if (request.url === '/inner') {
        response.end('<!doctype html><input id="nested-text" aria-label="Nested text">');
      } else if (request.url?.startsWith('/tab')) {
        response.end('<!doctype html><input id="tab-text" aria-label="Tab text">');
      } else {
        response.end(`<!doctype html>
          <select id="regions" multiple size="3">
            <option id="region-us" value="US">US</option>
            <option id="region-ca" value="CA">CA</option>
            <option id="region-gb" value="GB">GB</option>
          </select>
          <iframe id="outer" src="/outer"></iframe>
          <input id="after" aria-label="After">`);
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const profile = await handlers['profile:create']({
      name: 'rpa-recording-boundaries', platform: 'host', fingerprintSeed: 'rpa-recording-boundaries',
    });
    let launched = false;
    try {
      await handlers['profile:launch']({ profileId: profile.id });
      launched = true;
      await handlers['rpa:startRecording']({ profileId: profile.id, startUrl: `${origin}/main` });
      const context = kernel.getAutomationContext(profile.id);
      const page = context.pages().find((candidate) => candidate.url() === `${origin}/main`)!;
      await page.locator('#region-us').click();
      await page.locator('#region-ca').click({ modifiers: ['ControlOrMeta'] });
      await expect.poll(() => page.locator('#regions').evaluate((element) =>
        Array.from((element as HTMLSelectElement).selectedOptions).map((option) => option.value)))
        .toEqual(['US', 'CA']);
      await page.frameLocator('#outer').frameLocator('#inner').locator('#nested-text').fill('nested-text');

      const first = await context.newPage();
      await first.goto(`${origin}/tab?id=first`);
      await first.waitForFunction(() => Array.from(document.documentElement?.attributes ?? [])
        .some((attribute) => attribute.name.startsWith('__shadowedge_rpa_frame_')));
      await first.locator('#tab-text').fill('first-text');

      const second = await context.newPage();
      await second.goto(`${origin}/tab?id=second`);
      await second.waitForFunction(() => Array.from(document.documentElement?.attributes ?? [])
        .some((attribute) => attribute.name.startsWith('__shadowedge_rpa_frame_')));
      await second.locator('#tab-text').fill('second-text');
      await first.close();
      await page.bringToFront();
      await page.locator('#after').fill('main-between');
      await second.close();

      const third = await context.newPage();
      await third.goto(`${origin}/tab?id=third`);
      await third.waitForFunction(() => Array.from(document.documentElement?.attributes ?? [])
        .some((attribute) => attribute.name.startsWith('__shadowedge_rpa_frame_')));
      await third.locator('#tab-text').fill('third-text');
      await third.close();
      await page.locator('#after').fill('final-main');
      await page.waitForTimeout(150);
      const recorded = await handlers['rpa:stopRecording'](profile.id);
      expect(recorded.droppedActions).toBe(0);
      const nodes = Object.values(recorded.graph.nodes);
      expect(nodes.map((node) => node.kind)).toEqual([
        'navigate', 'select', 'type',
        'newTab', 'navigate', 'type',
        'newTab', 'navigate', 'type',
        'closeTab', 'switchTab', 'type', 'closeTab',
        'newTab', 'navigate', 'type', 'closeTab', 'type',
      ]);
      expect(nodes[1]?.params).toMatchObject({ selector: '#regions', values: ['US', 'CA'] });
      expect(nodes[2]?.params).toMatchObject({
        selector: '#nested-text', text: 'nested-text', frameSelectors: ['#outer', '#inner'],
      });
      for (const index of [9, 12, 16]) {
        expect(nodes[index]).toMatchObject({ kind: 'closeTab', params: { index: 1 } });
      }
      const saved = await handlers['rpa:save']({ name: '录制边界', graph: recorded.graph });
      const runs = await handlers['rpa:run']({ workflow: saved, profileIds: [profile.id] });
      await expect.poll(async () => (await handlers['rpa:get'](runs[0]!.id)).status, {
        timeout: 60000,
      }).toBe('succeeded');
      await expect.poll(() => page.locator('#regions').evaluate((element) =>
        Array.from((element as HTMLSelectElement).selectedOptions).map((option) => option.value)))
        .toEqual(['US', 'CA']);
      await expect(page.frameLocator('#outer').frameLocator('#inner').locator('#nested-text').inputValue())
        .resolves.toBe('nested-text');
      await expect(page.locator('#after').inputValue()).resolves.toBe('final-main');
      expect(context.pages()).toHaveLength(1);
    } finally {
      if (launched) await handlers['profile:close'](profile.id);
      handle.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120000);
});
