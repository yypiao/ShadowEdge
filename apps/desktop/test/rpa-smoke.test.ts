import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createConsoleLogger, type IpcEvents, type RpaWorkflow } from '@shadowedge/core';
import { EnvelopeCrypto } from '@shadowedge/crypto';
import { createHandlers } from '../src/main/handlers.js';
import { openDatabase, type ShadowEdgeDb } from '../src/main/services/db.js';
import { KernelRuntimeService } from '../src/main/services/kernel-runtime.js';
import { AuditLog, SessionRepository } from '../src/main/services/local-records.js';
import { ProfileRepository } from '../src/main/services/profile-repository.js';
import { ProxyRepository } from '../src/main/services/proxy-repository.js';

const executablePath = process.env.SHADOWEDGE_KERNEL_EXECUTABLE;
const SMOKE = process.env.SHADOWEDGE_SMOKE === '1' && executablePath !== undefined;

describe.skipIf(!SMOKE)('RPA 真实 Chromium 端到端', () => {
  let dir: string;
  let handle: ShadowEdgeDb | undefined;
  let server: Server | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'shadowedge-rpa-smoke-'));
  });

  afterEach(async () => {
    handle?.close();
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  it('不开放 CDP 端口也能输入、点击、提取并截图', async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html>
        <input id="name" value="">
        <button id="submit" onclick="document.querySelector('#result').textContent = 'Hello ' + document.querySelector('#name').value">Submit</button>
        <output id="result"></output>`);
    });
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(0, '127.0.0.1', () => resolve());
    });
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    handle = openDatabase(':memory:');
    const profiles = new ProfileRepository(handle);
    const runtime = new KernelRuntimeService(join(dir, 'config'), {});
    runtime.configure({ executablePath, fallbackPolicy: 'require-chromium-cdp' });
    const progress: IpcEvents['rpa:progress'][] = [];
    const handlers = createHandlers({
      logger: createConsoleLogger({ test: 'rpa-smoke' }),
      emit: (event, payload) => {
        if (event === 'rpa:progress') progress.push(payload);
      },
      profileRepo: profiles,
      proxyRepo: new ProxyRepository(handle, new EnvelopeCrypto('00'.repeat(32))),
      audit: new AuditLog(handle),
      sessions: new SessionRepository(handle),
      kernelRuntime: runtime,
      rpaArtifactsDir: join(dir, 'artifacts'),
    });
    const profile = await handlers['profile:create']({
      name: 'rpa-smoke',
      platform: 'host',
      fingerprintSeed: 'rpa-smoke',
    });
    let launched = false;
    try {
      const launch = await handlers['profile:launch']({ profileId: profile.id });
      launched = true;
      expect(launch.wsEndpoint).toBeUndefined();
      const workflow: RpaWorkflow = {
        id: 'workflow-rpa-smoke',
        orgId: 'local',
        name: '真实输入点击截图',
        version: 1,
        graph: {
          entry: 'open',
          nodes: {
            open: { id: 'open', kind: 'navigate', params: { url: origin }, next: 'type' },
            type: {
              id: 'type',
              kind: 'type',
              params: { selector: '#name', text: '{{inputs.name}}' },
              next: 'click',
            },
            click: { id: 'click', kind: 'click', params: { selector: '#submit' }, next: 'wait' },
            wait: { id: 'wait', kind: 'wait', params: { ms: 50 }, next: 'extract' },
            extract: {
              id: 'extract',
              kind: 'extract',
              params: { selector: '#result', key: 'greeting' },
              next: 'screenshot',
            },
            screenshot: {
              id: 'screenshot',
              kind: 'screenshot',
              params: { key: 'result', fullPage: true },
            },
          },
        },
        createdBy: 'local-user',
        updatedAt: new Date().toISOString(),
      };
      const runs = await handlers['rpa:run']({
        workflow,
        profileIds: [profile.id],
        inputs: { name: 'Ada' },
      });
      expect(runs).toHaveLength(1);
      const runId = runs[0]!.id;
      await expect
        .poll(async () => (await handlers['rpa:get'](runId)).status, {
          timeout: 30000,
        })
        .toBe('succeeded');
      const finished = await handlers['rpa:get'](runId);
      expect(finished.outputs).toEqual({ greeting: 'Hello Ada' });
      expect(finished.error).toBeUndefined();
      expect(finished.artifacts.map((artifact) => artifact.kind)).toEqual(['screenshot', 'json']);
      const screenshot = finished.artifacts.find((artifact) => artifact.kind === 'screenshot')!;
      expect(statSync(screenshot.uri).size).toBeGreaterThan(1000);
      expect(statSync(screenshot.uri).mode & 0o777).toBe(0o600);
      expect(readFileSync(screenshot.uri).subarray(1, 4).toString()).toBe('PNG');
      expect(progress.map((event) => event.step)).toEqual(
        expect.arrayContaining([
          'open',
          'type',
          'click',
          'wait',
          'extract',
          'screenshot',
          'succeeded',
        ]),
      );
    } finally {
      if (launched) await handlers['profile:close'](profile.id);
    }
  }, 90000);
});
