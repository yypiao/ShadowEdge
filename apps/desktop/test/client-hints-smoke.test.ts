import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BrowserProfile } from '@shadowedge/core';
import { buildClientHintHeaders, generateFingerprint } from '@shadowedge/fingerprint';
import { BrowserKernel, ChromiumCdpDriver } from '@shadowedge/kernel';

const executablePath = process.env.SHADOWEDGE_KERNEL_EXECUTABLE;
const SMOKE = process.env.SHADOWEDGE_SMOKE === '1' && executablePath !== undefined;

describe.skipIf(!SMOKE)('Chromium 网络层 Client Hints', () => {
  let dir: string;
  let server: Server | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'shadowedge-client-hints-'));
  });

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  it('Accept-CH 协商后高低熵请求头均来自画像而非真实二进制', async () => {
    const requests: Record<string, IncomingHttpHeaders> = {};
    server = createServer((request, response) => {
      const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      requests[path] = request.headers;
      if (path === '/redirect') {
        response.writeHead(302, { location: '/redirect-target' });
        response.end();
        return;
      }
      if (path === '/worker.js') {
        response.writeHead(200, { 'content-type': 'text/javascript' });
        response.end("postMessage('worker-ok')");
        return;
      }
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'accept-ch': [
          'Sec-CH-UA-Full-Version',
          'Sec-CH-UA-Full-Version-List',
          'Sec-CH-UA-Platform-Version',
          'Sec-CH-UA-Arch',
          'Sec-CH-UA-Bitness',
          'Sec-CH-UA-Model',
          'Sec-CH-UA-WoW64',
          'Sec-CH-UA-Form-Factors',
        ].join(', '),
      });
      response.end('<!doctype html><title>client-hints</title>');
    });
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(0, '127.0.0.1', () => resolve());
    });
    const port = (server.address() as AddressInfo).port;
    const now = new Date().toISOString();
    const fingerprint = generateFingerprint({
      seed: 'network-client-hints',
      platform: 'host',
      catalogVersion: '131.0.6778.86',
    });
    const profile: BrowserProfile = {
      id: 'network-client-hints',
      orgId: 'local',
      name: 'network-client-hints',
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
      drivers: [
        new ChromiumCdpDriver({ executablePath, fallbackToPatchright: false }),
      ],
    });

    try {
      const launched = await kernel.launch(profile, { profileId: profile.id });
      expect(launched.kernelUsed).toBe('chromium-cdp');
      const context = kernel.getAutomationContext(profile.id);
      const page = context.pages()[0] ?? (await context.newPage());
      await page.goto(`http://127.0.0.1:${port}/first`);
      await page.goto(`http://127.0.0.1:${port}/second`);
      await page.goto(`http://127.0.0.1:${port}/redirect`);
      await page.goto(`http://127.0.0.1:${port}/page`);
      const workerResult = await page.evaluate(async () => {
        await fetch('/api');
        return new Promise<string>((resolve, reject) => {
          const worker = new Worker('/worker.js');
          worker.onmessage = (event) => {
            worker.terminate();
            resolve(String(event.data));
          };
          worker.onerror = (event) => reject(new Error(event.message));
        });
      });
      expect(workerResult).toBe('worker-ok');

      const low = buildClientHintHeaders(fingerprint);
      expect(requests['/first']?.['sec-ch-ua']).toBe(low['sec-ch-ua']);
      expect(requests['/first']).not.toHaveProperty('sec-ch-ua-full-version-list');
      const second = requests['/second']!;
      const ua = fingerprint.userAgentData;
      const fullMajor = ua.fullVersion.split('.')[0]!;
      const expectedFullVersionList = ua.brands
        .map(({ brand, version }) => {
          const fullVersion =
            version === fullMajor
              ? ua.fullVersion
              : version.includes('.')
                ? version
                : `${version}.0.0.0`;
          return `"${brand}";v="${fullVersion}"`;
        })
        .join(', ');
      expect(second['sec-ch-ua']).toBe(low['sec-ch-ua']);
      expect(second['sec-ch-ua-mobile']).toBe('?0');
      expect(second['sec-ch-ua-platform']).toBe(`"${ua.platform}"`);
      expect(second['sec-ch-ua-full-version']).toBe(`"${ua.fullVersion}"`);
      expect(second['sec-ch-ua-full-version-list']).toBe(expectedFullVersionList);
      expect(second['sec-ch-ua-platform-version']).toBe(`"${ua.platformVersion}"`);
      expect(second['sec-ch-ua-arch']).toBe(`"${ua.architecture}"`);
      expect(second['sec-ch-ua-bitness']).toBe(`"${ua.bitness}"`);
      expect(second['sec-ch-ua-model']).toBe(`"${ua.model}"`);
      expect(second['sec-ch-ua-wow64']).toBe('?0');
      expect(second['sec-ch-ua-form-factors']).toBe('"Desktop"');
      expect(second['sec-ch-ua-full-version-list']).not.toContain('156.0.8078.91');
      for (const path of ['/redirect-target', '/api']) {
        expect(requests[path]?.['sec-ch-ua'], path).toBe(low['sec-ch-ua']);
        expect(requests[path]?.['sec-ch-ua-full-version-list'], path).toBe(
          expectedFullVersionList,
        );
      }
      // Worker 脚本按 Chromium 原生 Client Hints 策略可以只带低熵头；
      // 关键是不得绕过画像源或泄露真实二进制版本。
      const workerHeaders = requests['/worker.js']!;
      expect(workerHeaders['sec-ch-ua']).toBe(low['sec-ch-ua']);
      expect(workerHeaders['sec-ch-ua-full-version-list'] ?? '').not.toContain(
        '156.0.8078.91',
      );
    } finally {
      await kernel.close(profile.id);
    }
  }, 90000);
});
