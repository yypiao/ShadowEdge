import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BrowserProfile } from '@shadowedge/core';
import { generateFingerprint } from '@shadowedge/fingerprint';
import { BrowserKernel, ChromiumCdpDriver } from '@shadowedge/kernel';

const executablePath = process.env.SHADOWEDGE_KERNEL_EXECUTABLE;
const SMOKE = process.env.SHADOWEDGE_SMOKE === '1' && executablePath !== undefined;

const SNAPSHOT = String.raw`
function snapshot() {
  return {
    ua: navigator.userAgent,
    platform: navigator.platform,
    languages: navigator.languages,
    hc: navigator.hardwareConcurrency,
    mem: navigator.deviceMemory,
    maxTouchPoints: navigator.maxTouchPoints,
    brands: navigator.userAgentData ? navigator.userAgentData.brands : null,
    navOwnProps: Object.getOwnPropertyNames(navigator),
  };
}`;

describe.skipIf(!SMOKE)('Chromium 全 Worker 作用域原生画像', () => {
  let dir: string;
  let server: Server | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'shadowedge-worker-scopes-'));
  });

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  it('classic/module/shared/service 与 Blob 嵌套 Worker 均和画像一致', async () => {
    server = createServer((request, response) => {
      const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      const scripts: Record<string, string> = {
        '/worker-classic.js': `${SNAPSHOT}; postMessage(snapshot());`,
        '/worker-leaf.js': `${SNAPSHOT}; postMessage(snapshot());`,
        '/worker-module.js': `${SNAPSHOT}; postMessage(snapshot()); export {};`,
        '/shared-worker.js': `${SNAPSHOT}; onconnect = (event) => {
          event.ports[0].postMessage(snapshot());
        };`,
        '/service-worker.js': `${SNAPSHOT};
          self.addEventListener('install', () => self.skipWaiting());
          self.addEventListener('activate', (event) => event.waitUntil(clients.claim()));
          self.addEventListener('message', (event) => {
            event.ports[0].postMessage(snapshot());
          });`,
      };
      if (scripts[path]) {
        response.writeHead(200, { 'content-type': 'text/javascript' });
        response.end(scripts[path]);
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><title>worker-scopes</title>');
    });
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(0, '127.0.0.1', () => resolve());
    });
    const port = (server.address() as AddressInfo).port;
    const now = new Date().toISOString();
    const fingerprint = generateFingerprint({
      seed: 'all-worker-scopes',
      platform: 'host',
      catalogVersion: '131.0.6778.86',
    });
    const profile: BrowserProfile = {
      id: 'all-worker-scopes',
      orgId: 'local',
      name: 'all-worker-scopes',
      kernel: 'chromium-patched',
      fingerprint,
      ownerId: 'local',
      sharedWith: [],
      storage: { userDataDir: join(dir, 'profile'), remoteRevision: 0, syncMode: 'local-only' },
      startupUrls: [],
      status: 'idle',
      createdAt: now,
      updatedAt: now,
    };
    const kernel = new BrowserKernel({
      drivers: [new ChromiumCdpDriver({ executablePath, fallbackToPatchright: false })],
    });

    try {
      await kernel.launch(profile, { profileId: profile.id });
      const context = kernel.getAutomationContext(profile.id);
      const page = context.pages()[0] ?? (await context.newPage());
      await page.goto(`http://127.0.0.1:${port}/`);
      const session = await context.newCDPSession(page);
      const evaluated = await session.send('Runtime.evaluate', {
        expression: `(async () => {
          const runWorker = (url, options) => new Promise((resolve, reject) => {
            const worker = new Worker(url, options);
            const timer = setTimeout(() => reject(new Error('Worker timeout')), 8000);
            worker.onmessage = (event) => {
              clearTimeout(timer);
              worker.terminate();
              resolve(event.data);
            };
            worker.onerror = (event) => {
              clearTimeout(timer);
              reject(new Error(event.message));
            };
          });
          const classic = await runWorker('/worker-classic.js');
          const module = await runWorker('/worker-module.js', { type: 'module' });
          const outerSource = ${JSON.stringify(`${SNAPSHOT};
            const leaf = new Worker('http://127.0.0.1:${port}/worker-leaf.js');
            leaf.onmessage = (event) => postMessage({ outer: snapshot(), nested: event.data });
          `)};
          const nested = await runWorker(URL.createObjectURL(
            new Blob([outerSource], { type: 'application/javascript' }),
          ));
          const sharedWorker = new SharedWorker('/shared-worker.js');
          sharedWorker.port.start();
          const shared = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('SharedWorker timeout')), 8000);
            sharedWorker.port.onmessage = (event) => {
              clearTimeout(timer);
              sharedWorker.port.close();
              resolve(event.data);
            };
          });
          const registration = await navigator.serviceWorker.register('/service-worker.js');
          await navigator.serviceWorker.ready;
          const serviceWorker = registration.active;
          if (!serviceWorker) throw new Error('ServiceWorker not active');
          const channel = new MessageChannel();
          const service = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('ServiceWorker timeout')), 8000);
            channel.port1.onmessage = (event) => {
              clearTimeout(timer);
              channel.port1.close();
              resolve(event.data);
            };
            serviceWorker.postMessage(null, [channel.port2]);
          });
          return {
            classic,
            module,
            nested,
            shared,
            service,
            nativeConstructors: [
              Function.prototype.toString.call(Worker),
              Function.prototype.toString.call(Blob),
            ],
          };
        })()`,
        awaitPromise: true,
        returnByValue: true,
      });
      if (evaluated.exceptionDetails) throw new Error(JSON.stringify(evaluated.exceptionDetails));
      const result = evaluated.result.value;
      const expected = {
        ua: fingerprint.userAgent,
        platform:
          fingerprint.platform === 'macos'
            ? 'MacIntel'
            : fingerprint.platform === 'windows'
              ? 'Win32'
              : 'Linux x86_64',
        languages: fingerprint.languages,
        hc: fingerprint.hardware.hardwareConcurrency,
        mem: fingerprint.hardware.deviceMemoryGb,
        maxTouchPoints: fingerprint.hardware.maxTouchPoints,
        brands: fingerprint.userAgentData.brands,
        navOwnProps: [],
      };
      expect(result.classic).toEqual(expected);
      expect(result.module).toEqual(expected);
      expect(result.nested).toEqual({ outer: expected, nested: expected });
      expect(result.shared).toEqual(expected);
      expect(result.service).toEqual(expected);
      expect(result.nativeConstructors).toEqual([
        'function Worker() { [native code] }',
        'function Blob() { [native code] }',
      ]);
      await session.detach();
    } finally {
      await kernel.close(profile.id);
    }
  }, 90000);
});
