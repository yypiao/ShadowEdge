import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createConsoleLogger, type RpaGraph, type RpaWorkflow } from '@shadowedge/core';
import { EnvelopeCrypto } from '@shadowedge/crypto';
import { createHandlers } from '../src/main/handlers.js';
import { AccountRepository } from '../src/main/services/account-repository.js';
import { RpaRepository } from '../src/main/services/rpa-repository.js';
import { StorageStateRepository } from '../src/main/services/storage-state-repository.js';
import { openDatabase, type ShadowEdgeDb } from '../src/main/services/db.js';
import { KernelRuntimeService } from '../src/main/services/kernel-runtime.js';
import { AuditLog, SessionRepository } from '../src/main/services/local-records.js';
import { ProfileRepository } from '../src/main/services/profile-repository.js';
import { GroupRepository } from '../src/main/services/group-repository.js';
import { ProxyRepository } from '../src/main/services/proxy-repository.js';

const executablePath = process.env.SHADOWEDGE_KERNEL_EXECUTABLE;
const SMOKE = process.env.SHADOWEDGE_SMOKE === '1' && executablePath !== undefined;
const PASSWORD = 'real-account-secret';

describe.skipIf(!SMOKE)('账号自动填充真实 Chromium 链路', () => {
  let dir: string;
  let handle: ShadowEdgeDb | undefined;
  let server: Server | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'shadowedge-account-autofill-'));
  });

  afterEach(async () => {
    handle?.close();
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  it('origin 与密码框校验通过后由主进程填充并提交', async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html>
        <input id="email" type="email">
        <input id="password" type="password">
        <button id="login" onclick="document.querySelector('#result').textContent =
          document.querySelector('#email').value + ':' +
          (document.querySelector('#password').value === '${PASSWORD}' ? 'ok' : 'bad')">Login</button>
        <output id="result"></output>`);
    });
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(0, '127.0.0.1', () => resolve());
    });
    const port = (server.address() as AddressInfo).port;
    const origin = `http://127.0.0.1:${port}`;

    handle = openDatabase(':memory:');
    const crypto = new EnvelopeCrypto('22'.repeat(32));
    const profiles = new ProfileRepository(handle);
    const runtime = new KernelRuntimeService(join(dir, 'config'), {});
    runtime.configure({ executablePath, fallbackPolicy: 'require-chromium-cdp' });
    const handlers = createHandlers({
      logger: createConsoleLogger({ test: 'account-autofill' }),
      emit: () => undefined,
      profileRepo: profiles,
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
      name: 'account-autofill',
      platform: 'host',
      fingerprintSeed: 'account-autofill',
    });
    const credential = await handlers['account:upsert']({
      profileId: profile.id,
      label: 'Local shop',
      origin,
      username: 'alice',
      usernameSelector: '#email',
      passwordSelector: '#password',
      submitSelector: '#login',
      password: PASSWORD,
    });
    expect(credential).not.toHaveProperty('password');
    expect(await handlers['account:list'](profile.id)).toEqual([credential]);

    const runGraph = async (graph: RpaGraph) => {
      const workflow: RpaWorkflow = {
        id: `workflow-${graph.entry}`,
        orgId: 'local',
        name: graph.entry,
        version: 1,
        graph,
        createdBy: 'local-user',
        updatedAt: new Date().toISOString(),
      };
      const run = (await handlers['rpa:run']({ workflow, profileIds: [profile.id] }))[0]!;
      await expect
        .poll(async () => (await handlers['rpa:get'](run.id)).status, {
          timeout: 15000,
        })
        .toBe('succeeded');
      return handlers['rpa:get'](run.id);
    };
    const navigate = (url: string, id: string) =>
      runGraph({
        entry: id,
        nodes: { [id]: { id, kind: 'navigate', params: { url } } },
      });

    let launched = false;
    try {
      await handlers['profile:launch']({ profileId: profile.id });
      launched = true;

      await navigate(`http://localhost:${port}`, 'wrong-origin');
      await expect(handlers['account:autofill']({ id: credential.id })).rejects.toMatchObject({
        code: 'E_ACCOUNT_ORIGIN_MISMATCH',
      });

      await navigate(origin, 'correct-origin');
      const unsafe = await handlers['account:upsert']({
        profileId: profile.id,
        label: 'Unsafe selector',
        origin,
        username: 'alice',
        usernameSelector: '#email',
        passwordSelector: '#email',
        password: PASSWORD,
      });
      await expect(handlers['account:autofill']({ id: unsafe.id })).rejects.toMatchObject({
        code: 'E_ACCOUNT_SELECTOR_UNSAFE',
      });

      const filled = await handlers['account:autofill']({ id: credential.id });
      expect(filled).toEqual({
        credentialId: credential.id,
        profileId: profile.id,
        origin,
        submitted: false,
      });
      const submitted = await handlers['account:autofill']({ id: credential.id, submit: true });
      expect(submitted.submitted).toBe(true);
      const extracted = await runGraph({
        entry: 'extract-result',
        nodes: {
          'extract-result': {
            id: 'extract-result',
            kind: 'extract',
            params: { selector: '#result', key: 'result' },
          },
        },
      });
      expect(extracted.outputs).toEqual({ result: 'alice:ok' });
      const audit = handle.db
        .prepare("SELECT detail FROM audit_local WHERE action LIKE 'account:%'")
        .all();
      expect(JSON.stringify(audit)).not.toContain(PASSWORD);
      expect(JSON.stringify(audit)).not.toContain('"username":"alice"');
    } finally {
      if (launched) await handlers['profile:close'](profile.id);
    }
  }, 90000);
});
