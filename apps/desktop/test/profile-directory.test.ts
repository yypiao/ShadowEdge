import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserProfile } from '@shadowedge/core';
import { CURRENT_CATALOG_VERSION, generateFingerprint } from '@shadowedge/fingerprint';
import { EnvelopeCrypto } from '@shadowedge/crypto';
import { openDatabase, type ShadowEdgeDb } from '../src/main/services/db.js';
import { ProfileRepository } from '../src/main/services/profile-repository.js';
import { StorageStateRepository } from '../src/main/services/storage-state-repository.js';
import {
  deleteProfileWithDirectory,
  managedProfilePath,
  migrateProfileDirectories,
} from '../src/main/services/profile-directory.js';

describe('环境数据目录迁移与删除', () => {
  let dir: string;
  let handle: ShadowEdgeDb;
  let repository: ProfileRepository;
  let profile: BrowserProfile;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'shadowedge-profile-directory-'));
    handle = openDatabase(':memory:');
    repository = new ProfileRepository(handle);
    const now = new Date().toISOString();
    profile = {
      id: 'profile-one', orgId: 'local', name: 'one', kernel: 'chromium-patched',
      fingerprint: generateFingerprint({ seed: 'directory-test', catalogVersion: CURRENT_CATALOG_VERSION }),
      ownerId: 'local-user', sharedWith: [],
      storage: { userDataDir: 'profiles/profile-one', remoteRevision: 0, syncMode: 'auto' },
      startupUrls: [], status: 'idle', createdAt: now, updatedAt: now,
    };
    repository.save(profile);
  });

  afterEach(() => {
    handle.close();
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('只迁移精确旧布局并保留文件，新路径为绝对托管路径', () => {
    const legacy = join(dir, 'legacy', 'profiles', profile.id);
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'marker'), 'state');
    const root = join(dir, 'managed');
    migrateProfileDirectories(repository, root, join(dir, 'legacy'));
    const migrated = repository.get(profile.id)!;
    expect(migrated.storage.userDataDir).toBe(join(root, profile.id));
    expect(readFileSync(join(root, profile.id, 'marker'), 'utf8')).toBe('state');
    expect(existsSync(legacy)).toBe(false);
  });

  it('删除先隔离目录再提交数据库，级联快照且不留 Chromium 文件', () => {
    const root = join(dir, 'managed');
    migrateProfileDirectories(repository, root, dir);
    const target = managedProfilePath(root, profile.id);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'Cookies'), 'sensitive');
    const states = new StorageStateRepository(handle, new EnvelopeCrypto('44'.repeat(32)));
    states.save(profile.id, { cookies: [], origins: [] });
    deleteProfileWithDirectory(repository, root, repository.get(profile.id)!);
    expect(repository.get(profile.id)).toBeUndefined();
    expect(states.reveal(profile.id)).toBeUndefined();
    expect(existsSync(target)).toBe(false);
  });

  it('模拟崩溃在数据库删除前时，下次启动恢复隔离目录而不是清除状态', () => {
    const root = join(dir, 'managed');
    migrateProfileDirectories(repository, root, dir);
    const target = managedProfilePath(root, profile.id);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'marker'), 'recover');
    renameSync(target, join(root, `.deleting-${profile.id}`));
    migrateProfileDirectories(repository, root, dir);
    expect(readFileSync(join(target, 'marker'), 'utf8')).toBe('recover');
    expect(existsSync(join(root, `.deleting-${profile.id}`))).toBe(false);
  });

  it('快照提交后的关闭隔离残留可安全清理，不会生成半个环境目录', () => {
    const root = join(dir, 'managed');
    migrateProfileDirectories(repository, root, dir);
    const closed = join(root, `.closed-${profile.id}`);
    mkdirSync(closed, { recursive: true });
    writeFileSync(join(closed, 'partial'), 'old');
    migrateProfileDirectories(repository, root, dir);
    expect(existsSync(closed)).toBe(false);
    expect(existsSync(managedProfilePath(root, profile.id))).toBe(false);
  });

  it('数据库失败恢复隔离目录，路径穿越与非托管目录一律拒绝', () => {
    const root = join(dir, 'managed');
    migrateProfileDirectories(repository, root, dir);
    const target = managedProfilePath(root, profile.id);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'marker'), 'keep');
    vi.spyOn(repository, 'delete').mockImplementationOnce(() => { throw new Error('db failure'); });
    expect(() => deleteProfileWithDirectory(repository, root, repository.get(profile.id)!)).toThrow('db failure');
    expect(readFileSync(join(target, 'marker'), 'utf8')).toBe('keep');
    expect(() => managedProfilePath(root, '../outside')).toThrowError(
      expect.objectContaining({ code: 'E_PROFILE_INVALID' }),
    );
    expect(() => deleteProfileWithDirectory(repository, root, {
      ...repository.get(profile.id)!, storage: { ...profile.storage, userDataDir: '/tmp/outside' },
    })).toThrowError(expect.objectContaining({ code: 'E_PROFILE_INVALID' }));
  });
});
