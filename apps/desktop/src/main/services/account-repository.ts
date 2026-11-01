import { ShadowEdgeError } from '@shadowedge/core';
import type { AccountCredential, AccountCredentialInput, Uuid } from '@shadowedge/core';
import type { EnvelopeCrypto } from '@shadowedge/crypto';
import { allRows, getRow, type ShadowEdgeDb } from './db.js';

interface AccountRow {
  id: string;
  profile_id: string;
  label: string;
  origin: string;
  username: string;
  username_selector: string;
  password_selector: string;
  submit_selector: string | null;
  secret_ciphertext: string;
  secret_wrapped_key: string;
  secret_iv: string;
  created_at: string;
  updated_at: string;
}

function rowToAccount(row: AccountRow): AccountCredential {
  return {
    id: row.id,
    profileId: row.profile_id,
    label: row.label,
    origin: row.origin,
    username: row.username,
    usernameSelector: row.username_selector,
    passwordSelector: row.password_selector,
    submitSelector: row.submit_selector ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 只允许精确 origin；HTTP 仅用于本机开发/测试，业务站点必须 HTTPS。 */
export function normalizeAccountOrigin(value: string): string {
  try {
    const url = new URL(value);
    const loopback =
      url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
      throw new Error('业务站点必须使用 HTTPS');
    }
    if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
      throw new Error('origin 不能包含路径、query、hash 或用户信息');
    }
    return url.origin;
  } catch (error) {
    throw new ShadowEdgeError(
      'E_ACCOUNT_ORIGIN_MISMATCH',
      '无效的账号 origin：仅允许不含路径、查询参数、片段和用户信息的 HTTPS 地址（本机可使用 HTTP）',
      { cause: error },
    );
  }
}

/** 密码只在 reveal 中短暂返回给主进程自动填充服务，不得经 IPC 暴露。 */
export class AccountRepository {
  constructor(
    private readonly handle: ShadowEdgeDb,
    private readonly crypto: EnvelopeCrypto,
  ) {}

  list(profileId: Uuid): AccountCredential[] {
    return allRows<AccountRow>(
      this.handle.db,
      'SELECT * FROM account_credentials WHERE profile_id = ? ORDER BY label',
      profileId,
    ).map(rowToAccount);
  }

  get(id: Uuid): AccountCredential | undefined {
    const row = getRow<AccountRow>(
      this.handle.db,
      'SELECT * FROM account_credentials WHERE id = ?',
      id,
    );
    return row ? rowToAccount(row) : undefined;
  }

  upsert(input: AccountCredentialInput): AccountCredential {
    const existing = input.id ? this.getSecretRow(input.id) : undefined;
    if (!existing && !input.password) {
      throw new ShadowEdgeError('E_ACCOUNT_PASSWORD_REQUIRED', '新建账号凭据必须提供密码');
    }
    if (!input.usernameSelector || !input.passwordSelector) {
      throw new ShadowEdgeError('E_ACCOUNT_SELECTOR_UNSAFE', '用户名和密码选择器不能为空');
    }
    const now = new Date().toISOString();
    const id = input.id ?? crypto.randomUUID();
    const sealed = input.password
      ? this.crypto.seal(input.password, 'account-secret')
      : {
          ciphertext: existing!.secret_ciphertext,
          wrappedKey: existing!.secret_wrapped_key,
          iv: existing!.secret_iv,
        };
    this.handle.db
      .prepare(
        `INSERT INTO account_credentials (
        id, profile_id, label, origin, username, username_selector, password_selector,
        submit_selector, secret_ciphertext, secret_wrapped_key, secret_iv, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        profile_id=excluded.profile_id, label=excluded.label, origin=excluded.origin,
        username=excluded.username, username_selector=excluded.username_selector,
        password_selector=excluded.password_selector, submit_selector=excluded.submit_selector,
        secret_ciphertext=excluded.secret_ciphertext, secret_wrapped_key=excluded.secret_wrapped_key,
        secret_iv=excluded.secret_iv, updated_at=excluded.updated_at`,
      )
      .run(
        id,
        input.profileId,
        input.label,
        normalizeAccountOrigin(input.origin),
        input.username,
        input.usernameSelector,
        input.passwordSelector,
        input.submitSelector ?? null,
        sealed.ciphertext,
        sealed.wrappedKey,
        sealed.iv,
        existing?.created_at ?? now,
        now,
      );
    return this.get(id)!;
  }

  reveal(id: Uuid): { credential: AccountCredential; password: string } {
    const row = this.getSecretRow(id);
    if (!row) throw new ShadowEdgeError('E_ACCOUNT_NOT_FOUND', `账号凭据 ${id} 不存在`);
    return {
      credential: rowToAccount(row),
      password: this.crypto.unseal(
        row.secret_ciphertext,
        row.secret_wrapped_key,
        row.secret_iv,
        'account-secret',
      ),
    };
  }

  delete(id: Uuid): void {
    this.handle.db.prepare('DELETE FROM account_credentials WHERE id = ?').run(id);
  }

  private getSecretRow(id: Uuid): AccountRow | undefined {
    return getRow<AccountRow>(this.handle.db, 'SELECT * FROM account_credentials WHERE id = ?', id);
  }
}
