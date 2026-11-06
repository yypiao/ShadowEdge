import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createConsoleLogger, type RpaWorkflow } from '@shadowedge/core';
import { EnvelopeCrypto } from '@shadowedge/crypto';
import { createHandlers } from '../src/main/handlers.js';
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

describe.skipIf(!SMOKE)('T42 RPA 复杂控件真实 Chromium 验收', () => {
  let dir: string;
  let handle: ShadowEdgeDb | undefined;
  let server: Server | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'shadowedge-rpa-controls-'));
  });

  afterEach(async () => {
    handle?.close();
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  it('Iframe、Shadow DOM、下拉框、复选框、多标签、上传下载均真实生效', async () => {
    server = createServer((request, response) => {
      const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      if (path === '/download') {
        response.writeHead(200, {
          'content-type': 'text/plain; charset=utf-8',
          'content-disposition': 'attachment; filename="report.txt"',
        });
        response.end('downloaded-by-shadowedge');
        return;
      }
      const body = path === '/frame' ? `<!doctype html>
          <input id="frame-name"><output id="frame-output"></output>
          <select id="country"><option value="DE">DE</option><option value="GB">GB</option></select>
          <output id="select-output"></output>
          <input id="enabled" type="checkbox"><output id="check-output"></output>
          <script>
            frameName = document.querySelector('#frame-name');
            frameName.oninput = () => document.querySelector('#frame-output').textContent = frameName.value;
            country.onchange = () => document.querySelector('#select-output').textContent = country.value;
            enabled.onchange = () => document.querySelector('#check-output').textContent = String(enabled.checked);
          </script>`
        : path === '/popup' ? '<!doctype html><output id="popup-result">popup-ok</output>'
          : path === '/new-tab' ? '<!doctype html><output id="new-tab-result">new-tab-ok</output>'
            : `<!doctype html>
              <div id="shadow-host"></div>
              <iframe id="business-frame" src="/frame"></iframe>
              <input id="upload" type="file"><output id="upload-output"></output>
              <a id="download" href="/download" download="report.txt">download</a>
              <a id="popup" href="/popup" target="_blank">popup</a>
              <script>
                const root = document.querySelector('#shadow-host').attachShadow({ mode: 'open' });
                root.innerHTML = '<input id="shadow-name"><output id="shadow-output"></output>';
                const shadowInput = root.querySelector('#shadow-name');
                shadowInput.oninput = () => root.querySelector('#shadow-output').textContent = shadowInput.value;
                document.querySelector('#upload').onchange = (event) => {
                  document.querySelector('#upload-output').textContent = event.target.files[0]?.name ?? '';
                };
              </script>`;
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(body);
    });
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(0, '127.0.0.1', () => resolve());
    });
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const uploadPath = join(dir, 'upload.txt');
    writeFileSync(uploadPath, 'upload-by-shadowedge');

    handle = openDatabase(':memory:');
    const crypto = new EnvelopeCrypto('00'.repeat(32));
    const runtime = new KernelRuntimeService(join(dir, 'config'), {});
    runtime.configure({ executablePath, fallbackPolicy: 'require-chromium-cdp' });
    const handlers = createHandlers({
      logger: createConsoleLogger({ test: 'rpa-controls-smoke' }),
      emit: () => undefined,
      profileRepo: new ProfileRepository(handle),
      groupRepo: new GroupRepository(handle),
      proxyRepo: new ProxyRepository(handle, crypto),
      accountRepo: new AccountRepository(handle, crypto),
      rpaRepo: new RpaRepository(handle),
      storageStateRepo: new StorageStateRepository(handle, crypto),
      audit: new AuditLog(handle),
      sessions: new SessionRepository(handle),
      kernelRuntime: runtime,
      rpaArtifactsDir: join(dir, 'artifacts'),
      profilesDir: join(dir, 'profiles'),
    });
    const profile = await handlers['profile:create']({
      name: 'rpa-controls', platform: 'host', fingerprintSeed: 'rpa-controls',
    });
    let launched = false;
    try {
      await handlers['profile:launch']({ profileId: profile.id });
      launched = true;
      const workflow: RpaWorkflow = {
        id: 'workflow-controls', orgId: 'local', name: '复杂控件', version: 1,
        graph: {
          entry: 'open', timeoutMs: 120000,
          nodes: {
            open: { id: 'open', kind: 'navigate', params: { url: origin }, next: 'shadow-type' },
            'shadow-type': {
              id: 'shadow-type', kind: 'type', params: { selector: '#shadow-name', text: 'Ada' }, next: 'shadow-read',
            },
            'shadow-read': {
              id: 'shadow-read', kind: 'extract', params: { selector: '#shadow-output', key: 'shadow' }, next: 'frame-type',
            },
            'frame-type': {
              id: 'frame-type', kind: 'type',
              params: { frameSelector: '#business-frame', selector: '#frame-name', text: 'Grace' }, next: 'select',
            },
            select: {
              id: 'select', kind: 'select',
              params: { frameSelector: '#business-frame', selector: '#country', value: 'GB' }, next: 'select-read',
            },
            'select-read': {
              id: 'select-read', kind: 'extract',
              params: { frameSelector: '#business-frame', selector: '#select-output', key: 'selected' }, next: 'check',
            },
            check: {
              id: 'check', kind: 'check',
              params: { frameSelector: '#business-frame', selector: '#enabled', checked: true }, next: 'check-read',
            },
            'check-read': {
              id: 'check-read', kind: 'extract',
              params: { frameSelector: '#business-frame', selector: '#check-output', key: 'checked' }, next: 'frame-read',
            },
            'frame-read': {
              id: 'frame-read', kind: 'extract',
              params: { frameSelector: '#business-frame', selector: '#frame-output', key: 'frame' }, next: 'upload',
            },
            upload: {
              id: 'upload', kind: 'upload', params: { selector: '#upload', path: uploadPath }, next: 'upload-read',
            },
            'upload-read': {
              id: 'upload-read', kind: 'extract', params: { selector: '#upload-output', key: 'uploaded' }, next: 'download',
            },
            download: {
              id: 'download', kind: 'download', params: { selector: '#download', key: 'file' }, next: 'popup',
            },
            popup: { id: 'popup', kind: 'click', params: { selector: '#popup' }, next: 'popup-wait' },
            'popup-wait': { id: 'popup-wait', kind: 'wait', params: { ms: 300 }, next: 'popup-tab' },
            'popup-tab': { id: 'popup-tab', kind: 'switchTab', params: { index: 1 }, next: 'popup-read' },
            'popup-read': {
              id: 'popup-read', kind: 'extract', params: { selector: '#popup-result', key: 'popup' }, next: 'new-tab',
            },
            'new-tab': {
              id: 'new-tab', kind: 'newTab', params: { url: `${origin}/new-tab` }, next: 'new-tab-read',
            },
            'new-tab-read': {
              id: 'new-tab-read', kind: 'extract', params: { selector: '#new-tab-result', key: 'newTab' }, next: 'main-tab',
            },
            'main-tab': { id: 'main-tab', kind: 'switchTab', params: { index: 0 }, next: 'main-read' },
            'main-read': {
              id: 'main-read', kind: 'extract', params: { selector: '#upload-output', key: 'backToMain' },
            },
          },
        },
        createdBy: 'local', updatedAt: new Date().toISOString(),
      };
      const [run] = await handlers['rpa:run']({ workflow, profileIds: [profile.id] });
      await expect.poll(async () => (await handlers['rpa:get'](run!.id)).status, { timeout: 120000 }).toBe('succeeded');
      Object.assign(run!, await handlers['rpa:get'](run!.id));
      expect(run!.status).toBe('succeeded');
      expect(run!.error).toBeUndefined();
      expect(run!.outputs).toMatchObject({
        shadow: 'Ada', frame: 'Grace', selected: 'GB', checked: 'true', uploaded: 'upload.txt',
        file: 'report.txt', popup: 'popup-ok', newTab: 'new-tab-ok', backToMain: 'upload.txt',
      });
      const downloaded = run!.artifacts.find((artifact) => artifact.kind === 'download');
      expect(downloaded).toBeDefined();
      expect(readFileSync(downloaded!.uri, 'utf8')).toBe('downloaded-by-shadowedge');
    } finally {
      if (launched) await handlers['profile:close'](profile.id);
    }
  }, 180000);
});
