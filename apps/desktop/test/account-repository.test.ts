import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BrowserProfile } from '@shadowedge/core';
import { EnvelopeCrypto } from '@shadowedge/crypto';
import { generateFingerprint } from '@shadowedge/fingerprint';
import {
  AccountRepository,
  normalizeAccountOrigin,
} from '../src/main/services/account-repository.js';
import { openDatabase, type ShadowEdgeDb } from '../src/main/services/db.js';
import { ProfileRepository } from '../src/main/services/profile-repository.js';

const KEK = '11'.repeat(32);
const PASSWORD = 'account-secret-must-not-leak';

function makeProfile(): BrowserProfile {
  const now = new Date().toISOString();
  return {
    id: 'account-profile',
    orgId: 'local',
    name: 'account-profile',
    kernel: 'chromium-patched',
    fingerprint: generateFingerprint({ seed: 'account-profile' }),
    ownerId: 'local',
    sharedWith: [],
    storage: { userDataDir: 'profiles/account', remoteRevision: 0, syncMode: 'local-only' },
    startupUrls: [],
    status: 'idle',
    createdAt: now,
    updatedAt: now,
  };
}

describe('账号凭据加密仓储', () => {
  let dir: string;
  let handle: ShadowEdgeDb | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'shadowedge-account-repo-'));
    handle = openDatabase(':memory:');
    new ProfileRepository(handle).save(makeProfile());
  });

  afterEach(() => {
    handle?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('密码以信封密文落库，列表与返回值不包含 password', () => {
    const accounts = new AccountRepository(handle!, new EnvelopeCrypto(KEK));
    const saved = accounts.upsert({
      profileId: 'account-profile',
      label: 'Shop',
      origin: 'https://example.com',
      username: 'alice',
      usernameSelector: '#email',
      passwordSelector: '#password',
      submitSelector: '#submit',
      password: PASSWORD,
    });
    expect(saved.id).toBeTruthy();
    expect(saved).not.toHaveProperty('password');
    expect(accounts.list('account-profile')).toEqual([saved]);
    expect(accounts.reveal(saved.id)).toEqual({ credential: saved, password: PASSWORD });

    const raw = handle!.db.prepare('SELECT * FROM account_credentials WHERE id = ?').get(saved.id);
    expect(JSON.stringify(raw)).not.toContain(PASSWORD);
    expect(raw).toMatchObject({ secret_ciphertext: expect.any(String) });
  });

  it('更新时省略密码会保留原密文，删除环境会级联删除凭据', () => {
    const accounts = new AccountRepository(handle!, new EnvelopeCrypto(KEK));
    const saved = accounts.upsert({
      profileId: 'account-profile',
      label: 'Old',
      origin: 'https://example.com',
      username: 'alice',
      usernameSelector: '#email',
      passwordSelector: '#password',
      password: PASSWORD,
    });
    const updated = accounts.upsert({
      id: saved.id,
      profileId: 'account-profile',
      label: 'New',
      origin: 'https://example.com',
      username: 'alice',
      usernameSelector: '#email',
      passwordSelector: '#password',
    });
    expect(updated.label).toBe('New');
    expect(updated.createdAt).toBe(saved.createdAt);
    expect(accounts.reveal(saved.id).password).toBe(PASSWORD);

    new ProfileRepository(handle!).delete('account-profile');
    expect(accounts.list('account-profile')).toEqual([]);
  });

  it('使用相同 KEK 重启数据库后仍可解密', () => {
    const path = join(dir, 'accounts.db');
    handle!.close();
    handle = openDatabase(path);
    new ProfileRepository(handle).save(makeProfile());
    const saved = new AccountRepository(handle, new EnvelopeCrypto(KEK)).upsert({
      profileId: 'account-profile',
      label: 'Persistent',
      origin: 'https://example.com',
      username: 'alice',
      usernameSelector: '#email',
      passwordSelector: '#password',
      password: PASSWORD,
    });
    handle.close();
    expect(readFileSync(path, 'utf8')).not.toContain(PASSWORD);

    handle = openDatabase(path);
    expect(new AccountRepository(handle, new EnvelopeCrypto(KEK)).reveal(saved.id).password).toBe(
      PASSWORD,
    );
  });

  it('新建必须提供密码，origin 只允许 HTTPS 或本机 HTTP', () => {
    const accounts = new AccountRepository(handle!, new EnvelopeCrypto(KEK));
    const base = {
      profileId: 'account-profile',
      label: 'Shop',
      username: 'alice',
      usernameSelector: '#email',
      passwordSelector: '#password',
    };
    expect(() => accounts.upsert({ ...base, origin: 'https://example.com' })).toThrowError(
      expect.objectContaining({ code: 'E_ACCOUNT_PASSWORD_REQUIRED' }),
    );
    for (const origin of [
      'http://example.com',
      'https://example.com/login',
      'https://user@example.com',
      'https://example.com/?next=1',
    ]) {
      expect(() => normalizeAccountOrigin(origin)).toThrowError(
        expect.objectContaining({ code: 'E_ACCOUNT_ORIGIN_MISMATCH' }),
      );
    }
    try {
      normalizeAccountOrigin(`https://alice:${PASSWORD}@example.com`);
      expect.unreachable('带用户信息的 origin 必须被拒绝');
    } catch (error) {
      expect(error).toMatchObject({ code: 'E_ACCOUNT_ORIGIN_MISMATCH' });
      expect(String(error)).not.toContain('alice');
      expect(String(error)).not.toContain(PASSWORD);
    }
    expect(normalizeAccountOrigin('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080');
    expect(normalizeAccountOrigin('https://example.com/')).toBe('https://example.com');
  });
});
