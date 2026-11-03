import type { BrowserStorageState, Uuid } from '@shadowedge/core';
import { ShadowEdgeError } from '@shadowedge/core';
import type { EnvelopeCrypto } from '@shadowedge/crypto';
import { getRow, type ShadowEdgeDb } from './db.js';

interface StateRow {
  state_ciphertext: string;
  state_wrapped_key: string;
  state_iv: string;
}

/** 导入状态使用本机 KEK 再加密；仅在首次正常启动时短暂解封并恢复。 */
export class StorageStateRepository {
  constructor(
    private readonly handle: ShadowEdgeDb,
    private readonly crypto: EnvelopeCrypto,
  ) {}

  save(profileId: Uuid, state: BrowserStorageState): void {
    const sealed = this.crypto.seal(JSON.stringify(state), 'profile-cookie');
    this.handle.db.prepare(
      `INSERT INTO profile_storage_states
        (profile_id, state_ciphertext, state_wrapped_key, state_iv, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(profile_id) DO UPDATE SET
        state_ciphertext=excluded.state_ciphertext,
        state_wrapped_key=excluded.state_wrapped_key, state_iv=excluded.state_iv`,
    ).run(
      profileId,
      sealed.ciphertext,
      sealed.wrappedKey,
      sealed.iv,
      new Date().toISOString(),
    );
  }

  reveal(profileId: Uuid): BrowserStorageState | undefined {
    const row = getRow<StateRow>(
      this.handle.db,
      'SELECT * FROM profile_storage_states WHERE profile_id = ?',
      profileId,
    );
    if (!row) return undefined;
    try {
      return JSON.parse(this.crypto.unseal(
        row.state_ciphertext,
        row.state_wrapped_key,
        row.state_iv,
        'profile-cookie',
      )) as BrowserStorageState;
    } catch (error) {
      throw new ShadowEdgeError('E_CRYPTO_UNSEAL_FAILED', '待恢复浏览器状态无法解封', {
        cause: error,
      });
    }
  }

  delete(profileId: Uuid): void {
    this.handle.db.prepare('DELETE FROM profile_storage_states WHERE profile_id = ?').run(profileId);
  }
}
