import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createConsoleLogger } from '@shadowedge/core';
import { EnvelopeCrypto } from '@shadowedge/crypto';
import { BrowserKernel, type KernelDriver } from '@shadowedge/kernel';
import { createHandlers, type Handlers } from '../src/main/handlers.js';
import { AccountRepository } from '../src/main/services/account-repository.js';
import { openDatabase, type ShadowEdgeDb } from '../src/main/services/db.js';
import { KernelRuntimeService } from '../src/main/services/kernel-runtime.js';
import { AuditLog, SessionRepository } from '../src/main/services/local-records.js';
import { ProfileRepository } from '../src/main/services/profile-repository.js';
import { ProxyRepository } from '../src/main/services/proxy-repository.js';

describe('批量环境生命周期', () => {
  let dir: string;
  let handle: ShadowEdgeDb;
  let profiles: ProfileRepository;
  let kernel: BrowserKernel;
  let handlers: Handlers;
  const closed: string[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'shadowedge-profile-batch-'));
    handle = openDatabase(':memory:');
    profiles = new ProfileRepository(handle);
    const driver: KernelDriver = {
      name: 'deterministic-test-kernel',
      launch: async ({ profile }) => ({
        profileId: profile.id,
        pid: 1000,
        startedAt: new Date().toISOString(),
        onExit: () => undefined,
        close: async () => {
          closed.push(profile.id);
        },
      }),
    };
    kernel = new BrowserKernel({ drivers: [driver] });
    const crypto = new EnvelopeCrypto('44'.repeat(32));
    handlers = createHandlers({
      logger: createConsoleLogger({ test: 'profile-batch' }),
      emit: () => undefined,
      profileRepo: profiles,
      proxyRepo: new ProxyRepository(handle, crypto),
      accountRepo: new AccountRepository(handle, crypto),
      audit: new AuditLog(handle),
      sessions: new SessionRepository(handle),
      kernelRuntime: new KernelRuntimeService(join(dir, 'config'), {}),
      kernel,
      rpaArtifactsDir: join(dir, 'artifacts'),
    });
  });

  afterEach(async () => {
    for (const id of await kernel.listRunning()) await kernel.close(id);
    handle.close();
    rmSync(dir, { recursive: true, force: true });
    closed.length = 0;
  });

  it('创建、启动、停止均保留输入顺序，单项失败不影响后续项', async () => {
    const created = await handlers['profile:createMany']({
      items: [
        { name: 'batch-a', fingerprintSeed: 'batch-a' },
        { name: 'bad-proxy', proxyId: 'missing-proxy' },
        { name: 'batch-b', fingerprintSeed: 'batch-b' },
      ],
    });
    expect(created.map((result) => result.ok)).toEqual([true, false, true]);
    expect(created[1]).toMatchObject({
      ok: false,
      error: { code: 'E_PROXY_NOT_FOUND', retryable: false },
    });
    const first = created[0]!;
    const second = created[2]!;
    if (!first.ok || !second.ok) throw new Error('有效环境应创建成功');
    expect(profiles.list().map((profile) => profile.id)).toEqual([
      second.value.id,
      first.value.id,
    ]);

    const launched = await handlers['profile:launchMany']({
      items: [
        { profileId: first.value.id },
        { profileId: 'missing-profile' },
        { profileId: second.value.id },
      ],
    });
    expect(launched.map((result) => result.ok)).toEqual([true, false, true]);
    expect(launched[1]).toMatchObject({
      ok: false,
      error: { code: 'E_PROFILE_NOT_FOUND' },
    });
    expect((await kernel.listRunning()).sort()).toEqual(
      [first.value.id, second.value.id].sort(),
    );
    expect(profiles.get(first.value.id)?.status).toBe('running');
    expect(profiles.get(second.value.id)?.status).toBe('running');

    const closeResults = await handlers['profile:closeMany']({
      profileIds: [first.value.id, 'missing-profile', second.value.id],
    });
    expect(closeResults.map((result) => result.ok)).toEqual([true, false, true]);
    expect(closeResults[1]).toMatchObject({
      ok: false,
      error: { code: 'E_PROFILE_NOT_FOUND' },
    });
    expect(closed).toEqual([first.value.id, second.value.id]);
    expect(await kernel.listRunning()).toEqual([]);
    expect(profiles.get(first.value.id)?.status).toBe('idle');
    expect(profiles.get(second.value.id)?.status).toBe('idle');
  });
});
