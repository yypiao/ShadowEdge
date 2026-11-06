import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
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

describe.skipIf(!SMOKE)('RPA 定位韧性真实 Chromium 链路', () => {
  it('DOM 重建后使用候选并等待可用，失败诊断安全且可打开', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shadowedge-rpa-resilience-'));
    const handle = openDatabase(':memory:');
    const crypto = new EnvelopeCrypto('00'.repeat(32));
    const rpaRepo = new RpaRepository(handle);
    const kernel = new BrowserKernel({
      drivers: [new ChromiumCdpDriver({ executablePath, fallbackToPatchright: false })],
    });
    const runtime = new KernelRuntimeService(join(dir, 'config'), {});
    runtime.configure({ executablePath, fallbackPolicy: 'require-chromium-cdp' });
    const openedArtifacts: string[] = [];
    const handlers = createHandlers({
      logger: createConsoleLogger({ test: 'rpa-resilience-smoke' }),
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
      openArtifact: async (path) => { openedArtifacts.push(path); },
    });
    const server: Server = createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      if (request.url === '/main?mode=replay') {
        response.end(`<!doctype html><body><script>
          setTimeout(() => {
            const input = document.createElement('input');
            input.setAttribute('aria-label', 'Display name');
            const button = document.createElement('button');
            button.setAttribute('aria-label', 'Save changes');
            button.textContent = 'Save changes';
            button.disabled = true;
            button.style.marginLeft = '40px';
            button.onclick = () => { document.body.dataset.clicked = 'yes'; };
            document.body.append(input, button);
            setTimeout(() => { button.disabled = false; button.style.marginLeft = '0'; }, 250);
          }, 200);
        </script></body>`);
      } else {
        response.end(`<!doctype html>
          <input id="dynamic-input" data-testid="display-name" aria-label="Display name" name="displayName">
          <button id="dynamic-button" data-testid="save-button" aria-label="Save changes"
            onclick="document.body.dataset.clicked='yes'">Save changes</button>`);
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const profile = await handlers['profile:create']({
      name: 'rpa-resilience', platform: 'host', fingerprintSeed: 'rpa-resilience',
    });
    let launched = false;
    try {
      await handlers['profile:launch']({ profileId: profile.id });
      launched = true;
      const startUrl = `${origin}/main?mode=record`;
      await handlers['rpa:startRecording']({ profileId: profile.id, startUrl });
      const context = kernel.getAutomationContext(profile.id);
      const page = context.pages().find((candidate) => candidate.url() === startUrl)!;
      await page.locator('#dynamic-button').click();
      await page.locator('#dynamic-input').fill('resilient-value');
      await page.waitForTimeout(150);
      const recorded = await handlers['rpa:stopRecording'](profile.id);
      expect(recorded.droppedActions).toBe(0);
      const nodes = Object.values(recorded.graph.nodes);
      expect(nodes.map((node) => node.kind)).toEqual(['navigate', 'click', 'type']);
      expect(nodes[1]?.params.selector).toBe('#dynamic-button');
      expect(nodes[1]?.params.selectors).toEqual(expect.arrayContaining([
        'role=button[name="Save changes"]', 'text="Save changes"',
      ]));
      expect(nodes[2]?.params.selector).toBe('#dynamic-input');
      expect(nodes[2]?.params.selectors).toEqual(expect.arrayContaining([
        'role=textbox[name="Display name"]',
      ]));
      nodes[0]!.params.url = `${origin}/main?mode=replay`;
      const saved = await handlers['rpa:save']({ name: '定位韧性', graph: recorded.graph });
      const runs = await handlers['rpa:run']({ workflow: saved, profileIds: [profile.id] });
      await expect.poll(async () => (await handlers['rpa:get'](runs[0]!.id)).status, {
        timeout: 60000,
      }).toBe('succeeded');
      await expect(page.locator('input[aria-label="Display name"]').inputValue())
        .resolves.toBe('resilient-value');
      await expect.poll(() => page.locator('body').getAttribute('data-clicked')).toBe('yes');

      const failureGraph = structuredClone(saved.graph);
      const failureNode = Object.values(failureGraph.nodes).find((node) => node.kind === 'type')!;
      failureNode.params.selector = '#missing-primary';
      failureNode.params.selectors = ['#missing-fallback'];
      failureNode.params.timeout = 50;
      failureNode.params.text = 'diagnostic-secret-value';
      const failureWorkflow = await handlers['rpa:save']({ name: '失败诊断', graph: failureGraph });
      const failedRuns = await handlers['rpa:run']({ workflow: failureWorkflow, profileIds: [profile.id] });
      await expect.poll(async () => (await handlers['rpa:get'](failedRuns[0]!.id)).status, {
        timeout: 60000,
      }).toBe('failed');
      const failed = await handlers['rpa:get'](failedRuns[0]!.id);
      expect(failed.failure).toMatchObject({
        nodeId: failureNode.id,
        nodeKind: 'type',
        errorCode: 'E_RPA_NODE_FAILED',
        pageUrl: `${origin}/main`,
      });
      expect(failed.failure?.screenshotUri).toBeDefined();
      expect(statSync(failed.failure!.screenshotUri!).mode & 0o777).toBe(0o600);
      const diagnosticPath = failed.artifacts.find((artifact) => artifact.uri.endsWith('failure.json'))!.uri;
      const diagnostic = readFileSync(diagnosticPath, 'utf8');
      expect(diagnostic).not.toContain('diagnostic-secret-value');
      expect(diagnostic).not.toContain('mode=replay');
      await handlers['rpa:openArtifact']({ runId: failed.id, uri: diagnosticPath });
      expect(openedArtifacts).toEqual([diagnosticPath]);
    } finally {
      if (launched) await handlers['profile:close'](profile.id);
      handle.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120000);
});
