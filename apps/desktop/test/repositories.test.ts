import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { EnvelopeCrypto } from '@shadowedge/crypto';
import type { BrowserProfile, ProxyCredential } from '@shadowedge/core';
import { generateFingerprint } from '@shadowedge/fingerprint';
import { openDatabase, type ShadowEdgeDb } from '../src/main/services/db.js';
import { ProfileRepository } from '../src/main/services/profile-repository.js';
import { ProxyRepository, VAULT_SECRET_REF } from '../src/main/services/proxy-repository.js';
import { AuditLog, SessionRepository } from '../src/main/services/local-records.js';

const KEK = '00'.repeat(32);

function makeProfile(id: string): BrowserProfile {
  const now = new Date().toISOString();
  return {
    id,
    orgId: 'local',
    name: `env-${id}`,
    kernel: 'chromium-patched',
    fingerprint: generateFingerprint({ seed: 'seed-' + id }),
    ownerId: 'local-user',
    sharedWith: [],
    storage: { userDataDir: `profiles/${id}`, remoteRevision: 0, syncMode: 'auto' },
    startupUrls: [],
    status: 'idle',
    createdAt: now,
    updatedAt: now,
  };
}

describe('本地持久层', () => {
  let handle: ShadowEdgeDb;
  let profiles: ProfileRepository;
  let proxies: ProxyRepository;

  beforeEach(() => {
    handle = openDatabase(':memory:');
    profiles = new ProfileRepository(handle);
    proxies = new ProxyRepository(handle, new EnvelopeCrypto(KEK));
  });

  afterEach(() => handle.close());

  it('环境保存后可读回，指纹逐字节一致', () => {
    const p = makeProfile('p1');
    profiles.save(p);
    const back = profiles.get('p1');
    expect(back).toBeDefined();
    expect(JSON.stringify(back!.fingerprint)).toBe(JSON.stringify(p.fingerprint));
    expect(back!.name).toBe('env-p1');
  });

  it('环境更新与删除', () => {
    profiles.save(makeProfile('p2'));
    const p = profiles.get('p2')!;
    profiles.save({ ...p, name: 'renamed', updatedAt: new Date().toISOString() });
    expect(profiles.get('p2')!.name).toBe('renamed');
    profiles.delete('p2');
    expect(profiles.get('p2')).toBeUndefined();
  });

  it('list 支持 groupId 与 keyword 过滤', () => {
    profiles.save({ ...makeProfile('g1'), groupId: 'grp-a', name: 'Amazon-US' });
    profiles.save({ ...makeProfile('g2'), groupId: 'grp-b', name: 'Shopee-SG' });
    expect(profiles.list({ groupId: 'grp-a' }).map((p) => p.id)).toEqual(['g1']);
    expect(profiles.list({ keyword: 'shopee' }).map((p) => p.id)).toEqual(['g2']);
  });

  it('代理密码以密文落库，reveal 可还原，列表不暴露明文', () => {
    const cred: ProxyCredential & { password?: string } = {
      id: 'x1', orgId: 'local', label: 'us-resi', protocol: 'socks5',
      host: '1.2.3.4', port: 1080, username: 'u1', password: 's3cret', tags: [],
    };
    const saved = proxies.upsert(cred);
    expect(saved.secretRef).toBe(VAULT_SECRET_REF);
    expect(saved.password).toBeUndefined();

    const raw = handle.db.prepare('SELECT * FROM proxies WHERE id = ?').get('x1') as Record<string, unknown>;
    expect(raw.secret_ciphertext).toBeTruthy();
    expect(JSON.stringify(raw)).not.toContain('s3cret');

    expect(proxies.reveal('x1')).toBe('s3cret');
    expect(proxies.get('x1')!.secretRef).toBe(VAULT_SECRET_REF);
  });

  it('兼容旧的 enc:base64 假加密输入，重存为真信封加密', () => {
    const legacy: ProxyCredential = {
      id: 'x2', orgId: 'local', label: 'legacy', protocol: 'http',
      host: '5.6.7.8', port: 8080, username: 'u',
      secretRef: `enc:${Buffer.from('oldpass').toString('base64')}`, tags: [],
    };
    proxies.upsert(legacy);
    expect(proxies.reveal('x2')).toBe('oldpass');
    const raw = handle.db.prepare('SELECT secret_ciphertext FROM proxies WHERE id = ?').get('x2') as { secret_ciphertext: string };
    expect(raw.secret_ciphertext).not.toContain('b2xkcGFzcw');
  });

  it('会话记录与孤儿清理', () => {
    const sessions = new SessionRepository(handle);
    profiles.save(makeProfile('s1'));
    sessions.start({ profileId: 's1', sessionId: 'sess-1', pid: 1234, startedAt: new Date().toISOString() });
    sessions.start({ profileId: 's1', sessionId: 'sess-2', pid: 1235, startedAt: new Date().toISOString() });
    sessions.end('s1');
    const open = handle.db.prepare('SELECT COUNT(*) AS c FROM sessions WHERE ended_at IS NULL').get() as { c: number };
    expect(open.c).toBe(0);

    sessions.start({ profileId: 's1', sessionId: 'sess-3', pid: 1236, startedAt: new Date().toISOString() });
    expect(sessions.sweepOrphans()).toBe(1);
  });

  it('审计日志落库', () => {
    const audit = new AuditLog(handle);
    audit.record('profile:create', 'profile', 'p9', { name: 'x' });
    const rows = handle.db.prepare('SELECT * FROM audit_local WHERE target_id = ?').all('p9') as Array<{ action: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe('profile:create');
  });
});
