import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createConsoleLogger,
  CURRENT_PLATFORM_POLICY_CATALOG_VERSION,
  LEGACY_PLATFORM_POLICY_CATALOG_VERSION,
  type BrowserProfile,
  type ProfileUpdateInput,
} from '@shadowedge/core';
import { EnvelopeCrypto } from '@shadowedge/crypto';
import { BrowserKernel, type KernelDriver } from '@shadowedge/kernel';
import { createHandlers, type Handlers } from '../src/main/handlers.js';
import { openDatabase, type ShadowEdgeDb } from '../src/main/services/db.js';
import { KernelRuntimeService } from '../src/main/services/kernel-runtime.js';
import { AuditLog, SessionRepository } from '../src/main/services/local-records.js';
import { ProfileRepository } from '../src/main/services/profile-repository.js';
import { GroupRepository } from '../src/main/services/group-repository.js';
import { ProxyRepository } from '../src/main/services/proxy-repository.js';
import { AccountRepository } from '../src/main/services/account-repository.js';
import { RpaRepository } from '../src/main/services/rpa-repository.js';
import { StorageStateRepository } from '../src/main/services/storage-state-repository.js';

describe('环境分组、编辑与删除', () => {
  let dir: string;
  let handle: ShadowEdgeDb;
  let profiles: ProfileRepository;
  let groups: GroupRepository;
  let handlers: Handlers;
  let kernel: BrowserKernel;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'shadowedge-profile-management-'));
    handle = openDatabase(':memory:');
    profiles = new ProfileRepository(handle);
    groups = new GroupRepository(handle);
    const crypto = new EnvelopeCrypto('55'.repeat(32));
    const driver: KernelDriver = {
      name: 'test', launch: async ({ profile }) => ({
        profileId: profile.id, startedAt: new Date().toISOString(),
        onExit: () => undefined, close: async () => undefined,
      }),
    };
    kernel = new BrowserKernel({ drivers: [driver] });
    handlers = createHandlers({
      logger: createConsoleLogger({ test: 'profile-management' }), emit: () => undefined,
      profileRepo: profiles, groupRepo: groups,
      proxyRepo: new ProxyRepository(handle, crypto), accountRepo: new AccountRepository(handle, crypto),
      rpaRepo: new RpaRepository(handle), storageStateRepo: new StorageStateRepository(handle, crypto),
      audit: new AuditLog(handle), sessions: new SessionRepository(handle),
      kernelRuntime: new KernelRuntimeService(join(dir, 'config'), {}), kernel,
      profilesDir: join(dir, 'profiles'),
    });
  });

  afterEach(async () => {
    await kernel.closeAll();
    handle.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('创建与编辑只修改白名单字段，启动 URL 规范化且路径绝对隔离', async () => {
    const group = await handlers['profileGroup:save']({ name: '美区店铺', color: '#1976d2' });
    const profile = await handlers['profile:create']({
      name: 'shop-one', groupId: group.id, notes: '主店',
      startupUrls: ['https://example.com/dashboard'], fingerprintSeed: 'management-one',
    });
    expect(isAbsolute(profile.storage.userDataDir)).toBe(true);
    expect(profile.groupId).toBe(group.id);
    expect(profile.startupUrls).toEqual(['https://example.com/dashboard']);
    const originalFingerprint = profile.fingerprint;
    const originalDirectory = profile.storage.userDataDir;
    const runtimePatch: ProfileUpdateInput & Record<string, unknown> = {
      name: 'shop-renamed', groupId: group.id, startupUrls: ['http://localhost:8080/start'],
      status: 'running', fingerprint: { seed: 'attacker' }, storage: { userDataDir: '/tmp/attacker' },
    };
    const updated = await handlers['profile:update']({ id: profile.id, patch: runtimePatch });
    expect(updated.name).toBe('shop-renamed');
    expect(updated.status).toBe('idle');
    expect(updated.fingerprint).toEqual(originalFingerprint);
    expect(updated.storage.userDataDir).toBe(originalDirectory);
    expect(updated.startupUrls).toEqual(['http://localhost:8080/start']);
    await expect(handlers['profile:update']({
      id: profile.id, patch: { startupUrls: ['file:///etc/passwd'] },
    })).rejects.toMatchObject({ code: 'E_PROFILE_INVALID' });
  });

  it('删除分组只解绑环境，删除环境同时清理账号、快照和目录', async () => {
    const group = await handlers['profileGroup:save']({ name: '待删除组' });
    const profile = await handlers['profile:create']({ name: 'delete-me', groupId: group.id });
    await handlers['profileGroup:delete'](group.id);
    expect(profiles.get(profile.id)?.groupId).toBeUndefined();
    const crypto = new EnvelopeCrypto('55'.repeat(32));
    await handlers['account:upsert']({
      profileId: profile.id, label: 'shop', origin: 'https://example.com', username: 'user',
      usernameSelector: '#user', passwordSelector: '#pass', password: 'secret',
    });
    new StorageStateRepository(handle, crypto).save(profile.id, { cookies: [], origins: [] });
    mkdirSync(profile.storage.userDataDir, { recursive: true });
    writeFileSync(join(profile.storage.userDataDir, 'marker'), 'delete');
    await handlers['profile:delete'](profile.id);
    expect(profiles.get(profile.id)).toBeUndefined();
    expect(existsSync(profile.storage.userDataDir)).toBe(false);
    expect(handle.db.prepare('SELECT COUNT(*) AS count FROM account_credentials').get()).toEqual({ count: 0 });
    expect(handle.db.prepare('SELECT COUNT(*) AS count FROM profile_storage_states').get()).toEqual({ count: 0 });
  });

  it('运行或启动中禁止删除', async () => {
    const profile: BrowserProfile = await handlers['profile:create']({ name: 'busy-delete' });
    await handlers['profile:launch']({ profileId: profile.id });
    await expect(handlers['profile:delete'](profile.id)).rejects.toMatchObject({ code: 'E_PROFILE_BUSY' });
    await handlers['profile:close'](profile.id);
    await handlers['profile:delete'](profile.id);
  });

  it('切换站点只更新平台与启动页，seed 画像保持逐字段不变', async () => {
    const profile = await handlers['profile:create']({
      name: 'site-switch', fingerprintSeed: 'stable-site-seed', platformTag: 'amazon',
      platformSiteId: 'amazon-us', startupUrls: ['https://example.com/custom'],
    });
    expect(profile.startupUrls).toEqual(['https://www.amazon.com/', 'https://example.com/custom']);
    expect(profile.platformPolicyVersion).toBe(CURRENT_PLATFORM_POLICY_CATALOG_VERSION);
    const before = structuredClone(profile.fingerprint);
    profiles.save({ ...profile, platformPolicyVersion: LEGACY_PLATFORM_POLICY_CATALOG_VERSION });
    const switched = await handlers['profile:switchSite']({ profileId: profile.id, siteId: 'amazon-de' });
    expect(switched.opened).toBe(false);
    expect(switched.profile.platformTag).toBe('amazon');
    expect(switched.profile.platformSiteId).toBe('amazon-de');
    expect(switched.profile.platformPolicyVersion).toBe(CURRENT_PLATFORM_POLICY_CATALOG_VERSION);
    expect(switched.profile.startupUrls).toEqual(['https://www.amazon.de/']);
    expect(switched.profile.fingerprint).toEqual(before);
    expect(switched.profile.fingerprint.seed).toBe('stable-site-seed');
    const audit = handle.db.prepare(
      "SELECT detail FROM audit_local WHERE action = 'profile:switch-site' AND target_id = ?",
    ).get(profile.id) as { detail: string };
    expect(JSON.parse(audit.detail)).toMatchObject({
      fromCatalogVersion: LEGACY_PLATFORM_POLICY_CATALOG_VERSION,
      catalogVersion: CURRENT_PLATFORM_POLICY_CATALOG_VERSION,
    });

    await expect(handlers['profile:switchSite']({ profileId: profile.id, siteId: 'missing-site' }))
      .rejects.toMatchObject({ code: 'E_PROFILE_INVALID' });
    expect(profiles.get(profile.id)?.startupUrls).toEqual(['https://www.amazon.de/']);

    const edited = await handlers['profile:update']({
      id: profile.id, patch: { startupUrls: ['https://example.com/custom'] },
    });
    expect(edited.platformSiteId).toBeUndefined();
    expect(edited.platformPolicyVersion).toBeUndefined();
    expect(edited.name).toBe('site-switch');
    expect(edited.platformTag).toBe('amazon');
    expect(edited.fingerprint).toEqual(before);
  });
});
