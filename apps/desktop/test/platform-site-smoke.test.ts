import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createConsoleLogger, type RpaWorkflow } from '@shadowedge/core';
import { EnvelopeCrypto } from '@shadowedge/crypto';
import { BrowserKernel, ChromiumCdpDriver } from '@shadowedge/kernel';
import { createHandlers } from '../src/main/handlers.js';
import { AccountRepository } from '../src/main/services/account-repository.js';
import { openDatabase, type ShadowEdgeDb } from '../src/main/services/db.js';
import { GroupRepository } from '../src/main/services/group-repository.js';
import { KernelRuntimeService } from '../src/main/services/kernel-runtime.js';
import { AuditLog, SessionRepository } from '../src/main/services/local-records.js';
import { findPlatformSite } from '../src/main/services/platform-policies.js';
import { ProfileRepository } from '../src/main/services/profile-repository.js';
import { ProxyRepository } from '../src/main/services/proxy-repository.js';
import { RpaRepository } from '../src/main/services/rpa-repository.js';
import { StorageStateRepository } from '../src/main/services/storage-state-repository.js';

interface ProxySecret {
  id: string;
  protocol?: 'http' | 'socks5';
  host: string;
  port: number;
  username?: string;
  password?: string;
}

const executablePath = process.env.SHADOWEDGE_KERNEL_EXECUTABLE;
const siteId = process.env.SHADOWEDGE_SITE_ID;
const proxyId = process.env.SHADOWEDGE_PROXY_ID;
const SMOKE = process.env.SHADOWEDGE_SITE_SMOKE === '1'
  && executablePath !== undefined && siteId !== undefined && proxyId !== undefined;

// 默认只注册不执行。真实站点不得进入普通单测，也不使用账号或尝试通过验证码。
describe.skipIf(!SMOKE)('T40 真实代理与目标站点验收', () => {
  let dir: string;
  let handle: ShadowEdgeDb | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'shadowedge-site-smoke-'));
  });

  afterEach(() => {
    handle?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('Amazon 公开首页、搜索 RPA 与登录表单可用', async () => {
    const selected = findPlatformSite(siteId!);
    expect(selected.platformTag).toBe('amazon');
    const secrets = JSON.parse(readFileSync(
      process.env.SHADOWEDGE_PROXY_FILE ?? join(process.cwd(), 'experiments/.secrets/test-proxies.json'),
      'utf8',
    )) as ProxySecret[];
    const secret = secrets.find((item) => item.id === proxyId);
    if (!secret) throw new Error(`代理 ${proxyId} 不存在`);
    const upstream = new URL(process.env.SHADOWEDGE_PROBE_UPSTREAM ?? 'http://127.0.0.1:7897');
    expect(upstream.protocol).toBe('http:');

    handle = openDatabase(':memory:');
    const crypto = new EnvelopeCrypto('00'.repeat(32));
    const kernel = new BrowserKernel({
      drivers: [new ChromiumCdpDriver({ executablePath, fallbackToPatchright: false })],
    });
    const runtime = new KernelRuntimeService(join(dir, 'config'), {});
    runtime.configure({ executablePath, fallbackPolicy: 'require-chromium-cdp' });
    const handlers = createHandlers({
      logger: createConsoleLogger({ test: 'platform-site-smoke' }),
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
      kernel,
      rpaArtifactsDir: join(dir, 'artifacts'),
      profilesDir: join(dir, 'profiles'),
    });
    await handlers['proxy:upsert']({
      id: 'local-upstream', orgId: 'local', label: 'local-upstream', protocol: 'http',
      host: upstream.hostname, port: Number(upstream.port || 80), tags: [],
    });
    await handlers['proxy:upsert']({
      id: secret.id, orgId: 'local', label: secret.id, protocol: secret.protocol ?? 'socks5',
      host: secret.host, port: secret.port, username: secret.username, password: secret.password,
      upstreamId: 'local-upstream', tags: [],
    });
    const profile = await handlers['profile:create']({
      name: `site-${selected.id}`, platform: 'host', fingerprintSeed: `site-${selected.id}`,
      proxyId: secret.id, platformTag: selected.platformTag, platformSiteId: selected.id,
    });
    let launched = false;
    const evidence: Record<string, unknown> = { siteId: selected.id, proxyId: secret.id };
    try {
      await handlers['profile:launch']({ profileId: profile.id });
      launched = true;
      const context = kernel.getAutomationContext(profile.id);
      const page = context.pages().find((item) => item.url().startsWith(selected.url))
        ?? context.pages()[0]!;
      await page.goto(selected.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(2000);
      const home = await page.evaluate(() => ({
        url: location.href,
        title: document.title,
        text: document.body?.innerText.slice(0, 5000) ?? '',
      }));
      evidence.home = { url: home.url, title: home.title };
      expect(new URL(home.url).hostname).toBe(new URL(selected.url).hostname);
      expect(home.text).not.toMatch(/captcha|robot check|请输入验证码/i);
      expect(home.text.length).toBeGreaterThan(100);

      const workflow: RpaWorkflow = {
        id: 'workflow-amazon-public-search', orgId: 'local', name: 'Amazon 公开搜索', version: 1,
        graph: {
          entry: 'open', timeoutMs: 120000,
          nodes: {
            open: { id: 'open', kind: 'navigate', params: { url: selected.url, timeout: 45000 }, next: 'type' },
            type: {
              id: 'type', kind: 'type',
              params: { selector: '#twotabsearchtextbox', text: 'wireless mouse', timeout: 30000 },
              next: 'click',
            },
            click: {
              id: 'click', kind: 'click',
              params: { selector: '#nav-search-submit-button', timeout: 30000 }, next: 'wait',
            },
            wait: { id: 'wait', kind: 'wait', params: { ms: 2000 }, next: 'screenshot' },
            screenshot: {
              id: 'screenshot', kind: 'screenshot', params: { key: 'search-result', fullPage: false },
            },
          },
        },
        createdBy: 'local', updatedAt: new Date().toISOString(),
      };
      const [run] = await handlers['rpa:run']({ workflow, profileIds: [profile.id] });
      await expect.poll(async () => (await handlers['rpa:get'](run!.id)).status, { timeout: 120000 }).toBe('succeeded');
      Object.assign(run!, await handlers['rpa:get'](run!.id));
      evidence.search = { status: run!.status, error: run!.error, url: page.url() };
      expect(run!.status).toBe('succeeded');
      expect(decodeURIComponent(page.url())).toMatch(/[?&]k=wireless\+mouse/);

      await page.goto(selected.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.locator('#nav-link-accountList').click({ timeout: 30000 });
      await page.waitForLoadState('domcontentloaded', { timeout: 45000 });
      const login = page.locator('#ap_email');
      await login.waitFor({ state: 'visible', timeout: 30000 });
      evidence.loginForm = { visible: await login.isVisible(), url: page.url() };
      expect(await login.getAttribute('type')).toBe('email');
    } finally {
      if (process.env.SHADOWEDGE_SITE_REPORT) {
        writeFileSync(process.env.SHADOWEDGE_SITE_REPORT, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
      }
      if (launched || kernel.isActive(profile.id)) await handlers['profile:close'](profile.id);
    }
  }, 240000);
});
