import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createConsoleLogger, type BrowserProfile } from '@shadowedge/core';
import { EnvelopeCrypto } from '@shadowedge/crypto';
import { BrowserKernel, type KernelDriver } from '@shadowedge/kernel';
import { generateFingerprint } from '@shadowedge/fingerprint';
import { createHandlers, type Handlers } from '../src/main/handlers.js';
import { openDatabase, type ShadowEdgeDb } from '../src/main/services/db.js';
import { KernelDistributionService } from '../src/main/services/kernel-distribution.js';
import { KernelRuntimeService } from '../src/main/services/kernel-runtime.js';
import { AuditLog, SessionRepository } from '../src/main/services/local-records.js';
import { ProfileRepository } from '../src/main/services/profile-repository.js';
import { GroupRepository } from '../src/main/services/group-repository.js';
import { ProxyRepository } from '../src/main/services/proxy-repository.js';
import { AccountRepository } from '../src/main/services/account-repository.js';
import { RpaRepository } from '../src/main/services/rpa-repository.js';
import { StorageStateRepository } from '../src/main/services/storage-state-repository.js';

const ROOT = join(import.meta.dirname, '../../..');

describe('按环境固定内核版本与升级灰度', () => {
  let dir: string;
  let handle: ShadowEdgeDb;
  let profiles: ProfileRepository;
  let distribution: KernelDistributionService;
  let runtime: KernelRuntimeService;
  let states: StorageStateRepository;
  let handlers: Handlers;
  let kernel: BrowserKernel;
  let privateKey: string;
  let publicKey: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'shadowedge-kernel-upgrade-'));
    const pair = generateKeyPairSync('ed25519');
    privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    handle = openDatabase(':memory:');
    profiles = new ProfileRepository(handle);
    const crypto = new EnvelopeCrypto('55'.repeat(32));
    states = new StorageStateRepository(handle, crypto);
    distribution = new KernelDistributionService(join(dir, 'data'), { publicKey });
    const driver: KernelDriver = {
      name: 'test', launch: async ({ profile }) => ({
        profileId: profile.id, startedAt: new Date().toISOString(),
        onExit: () => undefined, close: async () => undefined,
      }),
    };
    kernel = new BrowserKernel({ drivers: [driver] });
    const dataDir = join(dir, 'data');
    runtime = new KernelRuntimeService(
      dataDir,
      {},
      (version) => version ? distribution.verifyVersion(version) : distribution.verifyActive(),
      (version) => version
        ? distribution.getExecutablePath(version)
        : distribution.getStatus().executablePath,
    );
    handlers = createHandlers({
      logger: createConsoleLogger({ test: 'kernel-upgrade' }), emit: () => undefined,
      profileRepo: profiles, groupRepo: new GroupRepository(handle),
      proxyRepo: new ProxyRepository(handle, crypto), accountRepo: new AccountRepository(handle, crypto),
      rpaRepo: new RpaRepository(handle), storageStateRepo: states,
      audit: new AuditLog(handle), sessions: new SessionRepository(handle),
      kernelRuntime: runtime, kernelDistribution: distribution, kernel,
      profilesDir: join(dir, 'profiles'),
    });
  });

  afterEach(async () => {
    await kernel.closeAll();
    handle.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function makePackage(version: string): string {
    const root = join(dir, `root-${version}`);
    const executable = process.platform === 'darwin'
      ? join(root, 'Chromium.app/Contents/MacOS/Chromium')
      : join(root, process.platform === 'win32' ? 'chrome.exe' : 'chrome');
    mkdirSync(join(executable, '..'), { recursive: true });
    writeFileSync(executable, '#!/bin/sh\n', { mode: 0o700 });
    chmodSync(executable, 0o700);
    const keyPath = join(dir, `${version}-private.pem`);
    const archive = join(dir, `${version}.zip`);
    writeFileSync(keyPath, privateKey, { mode: 0o600 });
    execFileSync(process.execPath, [
      join(ROOT, 'scripts/package-kernel.mjs'), '--root', root,
      '--kernel-version', version, '--private-key', keyPath, '--output', archive,
    ], { stdio: 'pipe' });
    return archive;
  }

  function resolveFor(runtime: KernelRuntimeService, profile: BrowserProfile): string | undefined {
    const executable = runtime.driverOptions().executablePath;
    if (typeof executable !== 'function') throw new Error('expected profile-aware resolver');
    return executable(profile);
  }

  it('全局激活新版不改变旧环境，灰度克隆确认前原环境不变', async () => {
    distribution.install(makePackage('1.0.0'));
    const source = await handlers['profile:create']({ name: 'pinned-source', fingerprintSeed: 'stable-upgrade' });
    expect(source.kernelVersion).toBe('1.0.0');
    states.save(source.id, {
      cookies: [{ name: 'session', value: 'encrypted-copy', domain: 'example.com', path: '/' }],
      origins: [],
    });

    const runtime = new KernelRuntimeService(
      join(dir, 'data'), {},
      (version) => version ? distribution.verifyVersion(version) : distribution.verifyActive(),
      (version) => version ? distribution.getExecutablePath(version) : distribution.getStatus().executablePath,
    );
    const oldExecutable = resolveFor(runtime, source);
    distribution.install(makePackage('2.0.0'));
    expect(distribution.getStatus().activeVersion).toBe('2.0.0');
    expect(profiles.get(source.id)?.kernelVersion).toBe('1.0.0');
    expect(resolveFor(runtime, profiles.get(source.id)!)).toBe(oldExecutable);
    expect(oldExecutable).toContain(join('versions', '1.0.0', 'payload'));
    const createdAfterUpgrade = await handlers['profile:create']({ name: 'new-profile' });
    expect(createdAfterUpgrade.kernelVersion).toBe('2.0.0');
    expect(resolveFor(runtime, createdAfterUpgrade)).toContain(join('versions', '2.0.0', 'payload'));

    const clone = await handlers['profile:prepareKernelUpgrade']({ profileId: source.id, targetVersion: '2.0.0' });
    expect(clone.kernelUpgradeSourceId).toBe(source.id);
    expect(clone.kernelVersion).toBe('2.0.0');
    expect(clone.fingerprint).toEqual(source.fingerprint);
    expect(clone.storage.syncMode).toBe('local-only');
    expect(states.reveal(clone.id)).toEqual(states.reveal(source.id));
    const before = profiles.get(source.id)!;
    await expect(handlers['profile:commitKernelUpgrade']({
      profileId: source.id, upgradeProfileId: clone.id, confirmed: false,
    })).rejects.toMatchObject({ code: 'E_KERNEL_UPGRADE_NOT_CONFIRMED' });
    expect(profiles.get(source.id)).toEqual(before);
    const upgraded = await handlers['profile:commitKernelUpgrade']({
      profileId: source.id, upgradeProfileId: clone.id, confirmed: true,
    });
    expect(upgraded.kernelVersion).toBe('2.0.0');
    expect(upgraded.fingerprint).toEqual(source.fingerprint);
    expect(profiles.get(clone.id)?.kernelVersion).toBe('2.0.0');
    expect(() => resolveFor(runtime, { ...source, kernelVersion: 'missing' }))
      .toThrowError(expect.objectContaining({ code: 'E_KERNEL_VERSION_NOT_FOUND' }));
    expect(() => resolveFor(runtime, { ...source, kernelVersion: undefined }))
      .toThrowError(expect.objectContaining({ code: 'E_KERNEL_VERSION_NOT_PINNED' }));
  });

  it('显式开发内核模式不自动固定安装版本', async () => {
    distribution.install(makePackage('1.0.0'));
    runtime.configure({ executablePath: '/bin/sh', fallbackPolicy: 'require-chromium-cdp' });
    const profile = await handlers['profile:create']({ name: 'development-profile' });
    expect(profile.kernelVersion).toBeUndefined();
    expect(resolveFor(runtime, profile)).toBe('/bin/sh');
  });

  it('历史环境只回填一次固定版本，未知目标版本拒绝克隆', async () => {
    const now = new Date().toISOString();
    const legacy: BrowserProfile = {
      id: 'legacy', orgId: 'local', name: 'legacy', kernel: 'chromium-patched',
      fingerprint: generateFingerprint({ seed: 'legacy-kernel' }), ownerId: 'local', sharedWith: [],
      storage: { userDataDir: join(dir, 'legacy'), remoteRevision: 0, syncMode: 'local-only' },
      startupUrls: [], status: 'idle', createdAt: now, updatedAt: now,
    };
    profiles.save(legacy);
    expect(profiles.pinMissingKernelVersions('1.0.0')).toBe(1);
    expect(profiles.pinMissingKernelVersions('2.0.0')).toBe(0);
    expect(profiles.get(legacy.id)?.kernelVersion).toBe('1.0.0');
    const audit = handle.db.prepare(
      "SELECT COUNT(*) AS count FROM audit_local WHERE action = 'migration:kernel-version'",
    ).get();
    expect(audit).toEqual({ count: 1 });
    await expect(handlers['profile:prepareKernelUpgrade']({ profileId: legacy.id, targetVersion: 'missing' }))
      .rejects.toMatchObject({ code: 'E_KERNEL_VERSION_NOT_FOUND' });
    expect(profiles.get(legacy.id)?.kernelVersion).toBe('1.0.0');
  });
});
