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

describe.skipIf(!SMOKE)('RPA 高级录制真实 Chromium 链路', () => {
  it('录制并回放高级控件、Iframe、Shadow DOM 和弹窗切换，文件路径不落图', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shadowedge-rpa-advanced-recording-'));
    const handle = openDatabase(':memory:');
    const crypto = new EnvelopeCrypto('00'.repeat(32));
    const rpaRepo = new RpaRepository(handle);
    const kernel = new BrowserKernel({
      drivers: [new ChromiumCdpDriver({ executablePath, fallbackToPatchright: false })],
    });
    const runtime = new KernelRuntimeService(join(dir, 'config'), {});
    runtime.configure({ executablePath, fallbackPolicy: 'require-chromium-cdp' });
    const handlers = createHandlers({
      logger: createConsoleLogger({ test: 'rpa-advanced-recording-smoke' }),
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
      if (request.url === '/frame') {
        response.end('<!doctype html><input id="frame-text" aria-label="Frame text">');
      } else if (request.url === '/popup') {
        response.end('<!doctype html><input id="popup-text" aria-label="Popup text">');
      } else {
        response.end(`<!doctype html>
          <select id="choice"><option value="a">A</option><option value="b">B</option></select>
          <input id="agree" type="checkbox">
          <div id="editable" contenteditable="true"></div>
          <div id="shadow-host"></div>
          <iframe id="child" src="/frame"></iframe>
          <input id="file" type="file">
          <button id="open" onclick="window.open('/popup', '_blank')">Open</button>
          <input id="after" aria-label="After">
          <script>
            const root = document.querySelector('#shadow-host').attachShadow({ mode: 'open' });
            root.innerHTML = '<input id="shadow-text" aria-label="Shadow text">';
          </script>`);
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const profile = await handlers['profile:create']({
      name: 'rpa-advanced-recording', platform: 'host', fingerprintSeed: 'rpa-advanced-recording',
    });
    let launched = false;
    try {
      await handlers['profile:launch']({ profileId: profile.id });
      launched = true;
      await handlers['rpa:startRecording']({ profileId: profile.id, startUrl: `${origin}/advanced` });
      const page = kernel.getAutomationContext(profile.id).pages()
        .find((candidate) => candidate.url() === `${origin}/advanced`)!;
      await page.locator('#choice').focus();
      await page.locator('#choice').press('b');
      await expect(page.locator('#choice').inputValue()).resolves.toBe('b');
      await page.locator('#agree').setChecked(true);
      await page.locator('#editable').fill('editable-text');
      await page.locator('#shadow-host >> css=#shadow-text').fill('shadow-text');
      await page.frameLocator('#child').locator('#frame-text').fill('frame-text');
      await page.locator('#file').setInputFiles({
        name: 'private.txt', mimeType: 'text/plain', buffer: Buffer.from('not-recorded'),
      });
      const manual = await kernel.getAutomationContext(profile.id).newPage();
      await manual.goto(`${origin}/popup`);
      await manual.locator('#popup-text').fill('manual-text');
      await page.bringToFront();
      const popupPromise = page.waitForEvent('popup');
      await page.locator('#open').click();
      const popup = await popupPromise;
      await popup.waitForLoadState('domcontentloaded');
      await popup.waitForTimeout(100);
      await popup.locator('#popup-text').fill('popup-text');
      await page.bringToFront();
      await page.locator('#after').fill('back-to-main');
      await page.waitForTimeout(150);
      const recorded = await handlers['rpa:stopRecording'](profile.id);
      expect(recorded.droppedActions).toBe(0);
      expect(JSON.stringify(recorded)).not.toContain('private.txt');
      expect(JSON.stringify(recorded)).not.toContain('not-recorded');
      const nodes = Object.values(recorded.graph.nodes);
      expect(nodes.map((node) => node.kind)).toEqual([
        'navigate', 'select', 'check', 'type', 'type', 'type',
        'newTab', 'navigate', 'type', 'switchTab', 'click', 'switchTab',
        'navigate', 'type', 'switchTab', 'type',
      ]);
      expect(nodes[3]?.params).toMatchObject({ selector: '#editable', text: 'editable-text' });
      expect(nodes[4]?.params).toMatchObject({
        selector: '#shadow-host >> css=#shadow-text', text: 'shadow-text',
      });
      expect(nodes[5]?.params).toMatchObject({
        selector: '#frame-text', frameSelectors: ['#child'], text: 'frame-text',
      });
      expect(nodes[6]).toMatchObject({ kind: 'newTab', params: {} });
      expect(nodes[9]?.params).toMatchObject({ index: 0, timeout: 10000 });
      expect(nodes[11]?.params).toMatchObject({ index: 2, timeout: 10000 });
      expect(nodes[14]?.params).toMatchObject({ index: 0, timeout: 10000 });
      const saved = await handlers['rpa:save']({ name: '高级录制', graph: recorded.graph });
      await manual.close();
      await popup.close();
      const runs = await handlers['rpa:run']({ workflow: saved, profileIds: [profile.id] });
      await expect.poll(async () => (await handlers['rpa:get'](runs[0]!.id)).status, {
        timeout: 60000,
      }).toBe('succeeded');
      const replayPopups = kernel.getAutomationContext(profile.id).pages()
        .filter((candidate) => candidate.url() === `${origin}/popup`);
      const replayManual = replayPopups[0]!;
      const replayPopup = replayPopups[1]!;
      await expect.poll(() => page.locator('#choice').inputValue()).toBe('b');
      await expect(page.locator('#agree').isChecked()).resolves.toBe(true);
      await expect(page.locator('#editable').textContent()).resolves.toBe('editable-text');
      await expect(page.locator('#shadow-host >> css=#shadow-text').inputValue()).resolves.toBe('shadow-text');
      await expect(page.frameLocator('#child').locator('#frame-text').inputValue()).resolves.toBe('frame-text');
      await expect(replayManual.locator('#popup-text').inputValue()).resolves.toBe('manual-text');
      await expect(replayPopup.locator('#popup-text').inputValue()).resolves.toBe('popup-text');
      await expect(page.locator('#after').inputValue()).resolves.toBe('back-to-main');
    } finally {
      if (launched) await handlers['profile:close'](profile.id);
      handle.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120000);
});
