import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserProfile, ProfileBackupEnvelope } from '@shadowedge/core';
import { deriveKek, EnvelopeCrypto } from '@shadowedge/crypto';
import { CURRENT_CATALOG_VERSION, generateFingerprint } from '@shadowedge/fingerprint';
import { BrowserKernel } from '@shadowedge/kernel';
import { importProfileBackup } from '../src/main/services/profile-backup.js';
import { openDatabase, type ShadowEdgeDb } from '../src/main/services/db.js';
import { ProfileRepository } from '../src/main/services/profile-repository.js';
import { ProxyRepository } from '../src/main/services/proxy-repository.js';
import { StorageStateRepository } from '../src/main/services/storage-state-repository.js';

const PASSPHRASE = 'correct horse battery staple';

describe('环境备份加密与导入', () => {
  let dir: string;
  let handle: ShadowEdgeDb;
  let profiles: ProfileRepository;
  let proxies: ProxyRepository;
  let states: StorageStateRepository;
  let contents: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'shadowedge-profile-backup-unit-'));
    handle = openDatabase(':memory:');
    const crypto = new EnvelopeCrypto('77'.repeat(32));
    profiles = new ProfileRepository(handle);
    proxies = new ProxyRepository(handle, crypto);
    states = new StorageStateRepository(handle, crypto);
    const now = new Date().toISOString();
    const profile: BrowserProfile = {
      id: 'source-profile', orgId: 'local', name: 'source', kernel: 'chromium-patched',
      fingerprint: generateFingerprint({
        seed: 'backup-unit', catalogVersion: CURRENT_CATALOG_VERSION,
      }),
      proxyId: 'source-proxy', ownerId: 'local-user', sharedWith: [],
      storage: { userDataDir: 'profiles/source-profile', remoteRevision: 3, syncMode: 'auto' },
      startupUrls: [], status: 'running', createdAt: now, updatedAt: now,
    };
    const payload = {
      profile,
      proxies: [{
        id: 'source-proxy', orgId: 'local', label: 'proxy', protocol: 'http',
        host: '127.0.0.1', port: 8080, username: 'user', password: 'proxy-secret', tags: [],
      }],
      storageState: {
        cookies: [{
          name: 'session', value: 'cookie-secret', domain: '127.0.0.1', path: '/',
          expires: -1, httpOnly: true, secure: false, sameSite: 'Lax',
        }],
        origins: [{
          origin: 'http://127.0.0.1',
          localStorage: [{ name: 'token', value: 'local-secret' }],
          indexedDB: [{
            name: 'auth-db', version: 1,
            stores: [{
              name: 'sessions', autoIncrement: false, keyPath: 'id',
              records: [{ key: 'current', value: { token: 'indexed-secret' } }], indexes: [],
            }],
          }],
          opfs: [{ path: 'nested', type: 'directory' }, { path: 'nested/state.bin', type: 'file', base64: Buffer.from([0, 255, 1, 2]).toString('base64') }],
        }],
      },
    };
    const { kek, salt } = deriveKek(PASSPHRASE, 'backup-unit-salt', 100000);
    const envelope: ProfileBackupEnvelope = {
      format: 'shadowedge-profile-backup', version: 1,
      kdf: { name: 'PBKDF2-SHA256', iterations: 100000, salt },
      payload: new EnvelopeCrypto(kek).seal(JSON.stringify(payload), 'profile-backup'),
    };
    contents = JSON.stringify(envelope);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    handle.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function deps() {
    return {
      profileRepo: profiles,
      proxyRepo: proxies,
      storageStateRepo: states,
      kernel: new BrowserKernel(),
      profilesDir: join(dir, 'profiles'),
    };
  }

  it('密文不含敏感值，导入生成新 ID 并重映射代理', () => {
    expect(contents).not.toContain('proxy-secret');
    expect(contents).not.toContain('cookie-secret');
    expect(contents).not.toContain('local-secret');
    expect(contents).not.toContain('indexed-secret');
    const result = importProfileBackup(
      { ...deps(), defaultKernelVersion: '156.0.0.0' },
      { contents, passphrase: PASSPHRASE, name: 'imported' },
    );

    expect(result.indexedDbCount).toBe(1);
    expect(result.opfsFileCount).toBe(1);
    expect(result.profile.id).not.toBe('source-profile');
    expect(result.profile.status).toBe('idle');
    expect(result.profile.kernelVersion).toBe('156.0.0.0');
    expect(result.profile.kernelUpgradeSourceId).toBeUndefined();
    expect(result.profile.storage.userDataDir).toBe(join(dir, 'profiles', result.profile.id));
    expect(result.profile.storage.remoteRevision).toBe(0);
    expect(result.profile.proxyId).not.toBe('source-proxy');
    expect(proxies.reveal(result.profile.proxyId!)).toBe('proxy-secret');
    expect(states.reveal(result.profile.id)?.origins[0]?.localStorage[0]?.value).toBe('local-secret');
  });

  it('拒绝路径穿越和非规范 base64 的 OPFS 载荷', () => {
    const envelope = JSON.parse(contents) as ProfileBackupEnvelope;
    const { kek } = deriveKek(PASSPHRASE, envelope.kdf.salt, envelope.kdf.iterations);
    const crypto = new EnvelopeCrypto(kek);
    const payload = JSON.parse(crypto.unseal(
      envelope.payload.ciphertext, envelope.payload.wrappedKey, envelope.payload.iv, 'profile-backup',
    )) as { storageState: { origins: Array<{ opfs?: unknown }> } };
    payload.storageState.origins[0]!.opfs = [{ path: '../escape', type: 'file', base64: 'AA==' }];
    const invalid = {
      ...envelope,
      payload: crypto.seal(JSON.stringify(payload), 'profile-backup'),
    };
    expect(() => importProfileBackup(deps(), { contents: JSON.stringify(invalid), passphrase: PASSPHRASE }))
      .toThrowError(expect.objectContaining({ code: 'E_BACKUP_INVALID' }));
    expect(profiles.list()).toEqual([]);
  });

  it('状态写入中途失败时环境、代理和快照全部回滚', () => {
    vi.spyOn(states, 'save').mockImplementationOnce(() => { throw new Error('injected write failure'); });
    expect(() => importProfileBackup(deps(), { contents, passphrase: PASSPHRASE })).toThrowError(
      expect.objectContaining({ code: 'E_STORAGE_STATE_FAILED' }),
    );
    expect(profiles.list()).toEqual([]);
    expect(proxies.list()).toEqual([]);
    expect(handle.db.prepare('SELECT COUNT(*) AS count FROM profile_storage_states').get()).toEqual({ count: 0 });
  });

  it('错误口令和密文篡改均拒绝且不创建环境', () => {
    expect(() => importProfileBackup(deps(), {
      contents,
      passphrase: 'definitely wrong passphrase',
    })).toThrowError(expect.objectContaining({ code: 'E_CRYPTO_UNSEAL_FAILED' }));
    const envelope = JSON.parse(contents) as ProfileBackupEnvelope;
    const ciphertext = Buffer.from(envelope.payload.ciphertext, 'base64');
    ciphertext[0]! ^= 1;
    envelope.payload.ciphertext = ciphertext.toString('base64');
    expect(() => importProfileBackup(deps(), {
      contents: JSON.stringify(envelope),
      passphrase: PASSPHRASE,
    })).toThrowError(expect.objectContaining({ code: 'E_CRYPTO_UNSEAL_FAILED' }));
    expect(profiles.list()).toEqual([]);
  });
});
