import type { ProxyCredential, Uuid } from '@shadowedge/core';
import type { EnvelopeCrypto } from '@shadowedge/crypto';
import { allRows, getRow, type ShadowEdgeDb } from './db.js';

interface ProxyRow {
  id: string;
  org_id: string;
  label: string;
  protocol: string;
  host: string;
  port: number;
  username: string | null;
  secret_ciphertext: string | null;
  secret_wrapped_key: string | null;
  secret_iv: string | null;
  sticky_session: string | null;
  upstream_id: string | null;
  tags: string;
}

/** secretRef 指向本地加密保险箱的标记，真实密文在三列信封字段里。 */
export const VAULT_SECRET_REF = 'vault:proxy-secret';

function rowToCredential(row: ProxyRow): ProxyCredential {
  return {
    id: row.id,
    orgId: row.org_id,
    label: row.label,
    protocol: row.protocol as ProxyCredential['protocol'],
    host: row.host,
    port: row.port,
    username: row.username ?? undefined,
    secretRef: row.secret_ciphertext ? VAULT_SECRET_REF : undefined,
    stickySession: row.sticky_session ? (JSON.parse(row.sticky_session) as ProxyCredential['stickySession']) : undefined,
    upstreamId: row.upstream_id ?? undefined,
    tags: JSON.parse(row.tags) as string[],
  };
}

/**
 * 代理凭据仓储。密码一律经 EnvelopeCrypto（purpose=proxy-secret）加密落库，
 * 明文只存在于调用方内存中；reveal() 仅供内核启动代理链路时使用。
 */
export class ProxyRepository {
  constructor(
    private readonly handle: ShadowEdgeDb,
    private readonly crypto: EnvelopeCrypto,
  ) {}

  list(): ProxyCredential[] {
    const rows = allRows<ProxyRow>(this.handle.db, 'SELECT * FROM proxies ORDER BY label');
    return rows.map(rowToCredential);
  }

  get(id: Uuid): ProxyCredential | undefined {
    const row = getRow<ProxyRow>(this.handle.db, 'SELECT * FROM proxies WHERE id = ?', id);
    return row ? rowToCredential(row) : undefined;
  }

  upsert(credential: ProxyCredential & { password?: string }): ProxyCredential {
    let sealed: { ciphertext: string; wrappedKey: string; iv: string } | null = null;
    if (credential.password !== undefined && credential.password !== '') {
      sealed = this.crypto.seal(credential.password, 'proxy-secret');
    } else if (credential.secretRef?.startsWith('enc:')) {
      // 兼容旧的 base64 假加密输入：还原明文后立即用真信封加密重存。
      const plaintext = Buffer.from(credential.secretRef.slice(4), 'base64').toString('utf-8');
      sealed = this.crypto.seal(plaintext, 'proxy-secret');
    } else if (credential.secretRef === VAULT_SECRET_REF) {
      // 已存量的密文保持不变（仅更新其他字段）。
      const existing = getRow<Pick<ProxyRow, 'secret_ciphertext' | 'secret_wrapped_key' | 'secret_iv'>>(
        this.handle.db,
        'SELECT secret_ciphertext, secret_wrapped_key, secret_iv FROM proxies WHERE id = ?',
        credential.id,
      );
      if (existing?.secret_ciphertext && existing.secret_wrapped_key && existing.secret_iv) {
        sealed = {
          ciphertext: existing.secret_ciphertext,
          wrappedKey: existing.secret_wrapped_key,
          iv: existing.secret_iv,
        };
      }
    }

    this.handle.db
      .prepare(
        `INSERT INTO proxies (id, org_id, label, protocol, host, port, username,
           secret_ciphertext, secret_wrapped_key, secret_iv, sticky_session, upstream_id, tags)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           org_id=excluded.org_id, label=excluded.label, protocol=excluded.protocol, host=excluded.host,
           port=excluded.port, username=excluded.username,
           secret_ciphertext=excluded.secret_ciphertext, secret_wrapped_key=excluded.secret_wrapped_key,
           secret_iv=excluded.secret_iv, sticky_session=excluded.sticky_session,
           upstream_id=excluded.upstream_id, tags=excluded.tags`,
      )
      .run(
        credential.id,
        credential.orgId,
        credential.label,
        credential.protocol,
        credential.host,
        credential.port,
        credential.username ?? null,
        sealed?.ciphertext ?? null,
        sealed?.wrappedKey ?? null,
        sealed?.iv ?? null,
        credential.stickySession ? JSON.stringify(credential.stickySession) : null,
        credential.upstreamId ?? null,
        JSON.stringify(credential.tags),
      );

    const { password: _omitted, ...rest } = credential;
    return { ...rest, secretRef: sealed ? VAULT_SECRET_REF : undefined };
  }

  /** 解封代理密码。仅限内核启动链路调用，不得经 IPC 暴露给渲染层。 */
  reveal(id: Uuid): string | undefined {
    const row = getRow<Pick<ProxyRow, 'secret_ciphertext' | 'secret_wrapped_key' | 'secret_iv'>>(
      this.handle.db,
      'SELECT secret_ciphertext, secret_wrapped_key, secret_iv FROM proxies WHERE id = ?',
      id,
    );
    if (!row?.secret_ciphertext || !row.secret_wrapped_key || !row.secret_iv) return undefined;
    return this.crypto.unseal(row.secret_ciphertext, row.secret_wrapped_key, row.secret_iv, 'proxy-secret');
  }

  delete(id: Uuid): void {
    this.handle.db.prepare('DELETE FROM proxies WHERE id = ?').run(id);
  }
}
