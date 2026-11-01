import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BrowserProfile } from '@shadowedge/core';
import { CURRENT_CATALOG_VERSION, generateFingerprint } from '@shadowedge/fingerprint';
import { BrowserKernel, ChromiumCdpDriver } from '@shadowedge/kernel';
import { checkProxyHealth } from '@shadowedge/proxy';
import { chromium, type Browser, type CDPSession, type Page } from 'patchright';

const executablePath = process.env.SHADOWEDGE_KERNEL_EXECUTABLE;
const SMOKE = process.env.SHADOWEDGE_SMOKE === '1' && executablePath !== undefined;
const PROXY_SMOKE = process.env.SHADOWEDGE_PROXY_SMOKE === '1';
const PROXY_IDS = (process.env.SHADOWEDGE_PROXY_IDS ?? 'os1,t1').split(',');

interface TestProxySecret {
  id: string;
  host: string;
  port: number;
  username: string;
  password: string;
}

function makeProfile(dir: string, id: string): BrowserProfile {
  const now = new Date().toISOString();
  return {
    id,
    orgId: 'local',
    name: id,
    kernel: 'chromium-patched',
    fingerprint: generateFingerprint({
      seed: `isolation-${id}`,
      platform: 'host',
      catalogVersion: CURRENT_CATALOG_VERSION,
    }),
    ownerId: 'local-user',
    sharedWith: [],
    storage: {
      userDataDir: join(dir, id),
      remoteRevision: 0,
      syncMode: 'local-only',
    },
    startupUrls: [],
    status: 'idle',
    createdAt: now,
    updatedAt: now,
  };
}

describe.skipIf(!SMOKE)('真实内核多环境隔离与重启稳定性', () => {
  let dir: string;
  let server: Server;
  let origin: string;
  let kernel: BrowserKernel;
  const connections = new Set<Browser>();

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'shadowedge-profile-isolation-'));
    kernel = new BrowserKernel({
      drivers: [new ChromiumCdpDriver({ executablePath, fallbackToPatchright: false })],
    });
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><title>isolation</title>');
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address() as AddressInfo;
    origin = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    for (const connection of connections) await connection.close().catch(() => undefined);
    const running = await kernel.listRunning();
    for (const id of running) await kernel.close(id);
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    rmSync(dir, { recursive: true, force: true });
  });

  async function openPage(
    profile: BrowserProfile,
    browserKernel: BrowserKernel = kernel,
  ): Promise<Page> {
    const result = await browserKernel.launch(profile, {
      profileId: profile.id,
      remoteDebugging: true,
    });
    expect(result.kernelUsed).toBe('chromium-cdp');
    const connection = await chromium.connectOverCDP(result.wsEndpoint!);
    connections.add(connection);
    const context = connection.contexts()[0]!;
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(origin);
    return page;
  }

  async function mainWorld<T>(session: CDPSession, expression: string): Promise<T> {
    const result = await session.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value as T;
  }

  async function closePage(
    profile: BrowserProfile,
    page: Page,
    browserKernel: BrowserKernel = kernel,
  ): Promise<void> {
    const browser = page.context().browser();
    await browser?.close();
    if (browser) connections.delete(browser);
    await browserKernel.close(profile.id);
  }

  it('并行环境的 Cookie、localStorage 和指纹完全隔离', async () => {
    const first = makeProfile(dir, 'parallel-a');
    const second = makeProfile(dir, 'parallel-b');
    const firstPage = await openPage(first);
    const secondPage = await openPage(second);
    try {
      await firstPage.evaluate(() => {
        localStorage.setItem('owner', 'first');
        document.cookie = 'owner=first; path=/';
      });
      await secondPage.evaluate(() => {
        localStorage.setItem('owner', 'second');
        document.cookie = 'owner=second; path=/';
      });
      await Promise.all([firstPage.reload(), secondPage.reload()]);

      expect(
        await firstPage.evaluate(() => ({
          storage: localStorage.getItem('owner'),
          cookie: document.cookie,
        })),
      ).toEqual({ storage: 'first', cookie: 'owner=first' });
      expect(
        await secondPage.evaluate(() => ({
          storage: localStorage.getItem('owner'),
          cookie: document.cookie,
        })),
      ).toEqual({ storage: 'second', cookie: 'owner=second' });
      expect(await firstPage.evaluate(() => navigator.userAgent)).toBe(first.fingerprint.userAgent);
      expect(await secondPage.evaluate(() => navigator.userAgent)).toBe(
        second.fingerprint.userAgent,
      );
      expect(first.fingerprint).not.toEqual(second.fingerprint);
      expect(first.storage.userDataDir).not.toBe(second.storage.userDataDir);
    } finally {
      await Promise.all([closePage(first, firstPage), closePage(second, secondPage)]);
    }
  }, 90000);

  it.skipIf(!PROXY_SMOKE)(
    '并行环境分别使用配置的代理出口 IP',
    async () => {
      const secretsPath = fileURLToPath(
        new URL('../../../experiments/.secrets/test-proxies.json', import.meta.url),
      );
      const secrets = JSON.parse(readFileSync(secretsPath, 'utf8')) as TestProxySecret[];
      if (PROXY_IDS.length !== 2) throw new Error('SHADOWEDGE_PROXY_IDS 必须包含两个代理 id');
      const selected = PROXY_IDS.map((id) => {
        const secret = secrets.find((item) => item.id === id);
        if (!secret) throw new Error(`缺少测试代理 ${id}`);
        return secret;
      });
      const upstream = { protocol: 'http' as const, host: '127.0.0.1', port: 7897 };
      const expectedIps = await Promise.all(
        selected.map(async (secret) => {
          const health = await checkProxyHealth(
            {
              id: secret.id,
              orgId: 'local',
              label: secret.id,
              protocol: 'socks5',
              host: secret.host,
              port: secret.port,
              username: secret.username,
              tags: [],
            },
            secret.password,
            { upstream, timeoutMs: 45000 },
          );
          expect(health.reachable).toBe(true);
          return health.exitIp;
        }),
      );
      const byId = new Map(selected.map((secret) => [secret.id, secret]));
      const proxyKernel = new BrowserKernel({
        drivers: [new ChromiumCdpDriver({ executablePath, fallbackToPatchright: false })],
        resolveProxy: async (proxyId) => {
          const secret = byId.get(proxyId);
          if (!secret) return undefined;
          return {
            protocol: 'socks5',
            host: secret.host,
            port: secret.port,
            username: secret.username,
            password: secret.password,
            upstream,
          };
        },
      });
      const profiles = selected.map((secret) => ({
        ...makeProfile(dir, `proxy-${secret.id}`),
        proxyId: secret.id,
      }));
      const pages = await Promise.all(profiles.map((profile) => openPage(profile, proxyKernel)));
      try {
        const actualIps = await Promise.all(
          pages.map(async (page) => {
            await page.goto('http://ip-api.com/json?fields=query', {
              waitUntil: 'domcontentloaded',
              timeout: 45000,
            });
            const body = await page.locator('body').innerText();
            return (JSON.parse(body) as { query: string }).query;
          }),
        );
        expect(actualIps).toEqual(expectedIps);
        expect(new Set(actualIps).size).toBe(2);
      } finally {
        await Promise.all(
          profiles.map((profile, index) => closePage(profile, pages[index]!, proxyKernel)),
        );
      }
    },
    120000,
  );

  it('同一环境连续重启 20 次，Cookie、Storage 与画像保持稳定', async () => {
    const profile = makeProfile(dir, 'restart-20');
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const page = await openPage(profile);
      try {
        if (attempt === 0) {
          await page.evaluate(() => {
            localStorage.setItem('restart', 'persisted');
            document.cookie = 'restart=persisted; path=/; max-age=3600';
          });
          await page.reload();
        }
        expect(
          await page.evaluate(() => ({
            storage: localStorage.getItem('restart'),
            cookie: document.cookie,
          })),
        ).toEqual({ storage: 'persisted', cookie: 'restart=persisted' });
        const cdp = await page.context().newCDPSession(page);
        expect(
          await mainWorld<{
            userAgent: string;
            hardwareConcurrency: number;
            webdriver: boolean;
          }>(
            cdp,
            `({
          userAgent: navigator.userAgent,
          hardwareConcurrency: navigator.hardwareConcurrency,
          webdriver: navigator.webdriver,
        })`,
          ),
        ).toEqual({
          userAgent: profile.fingerprint.userAgent,
          hardwareConcurrency: profile.fingerprint.hardware.hardwareConcurrency,
          webdriver: false,
        });
      } finally {
        await closePage(profile, page);
      }
    }
  }, 240000);
});
