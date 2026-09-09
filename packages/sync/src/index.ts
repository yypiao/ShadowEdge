import type { Uuid } from '@shadowedge/core';
import { EnvelopeCrypto } from '@shadowedge/crypto';

export interface SyncSnapshot {
  profileId: Uuid;
  revision: number;
  /** 加密后的 Cookie / LocalStorage / IndexedDB 数据包。 */
  payload: { ciphertext: string; wrappedKey: string; iv: string };
  checksum: string;
  createdAt: string;
}

/** 环境数据同步管理器：处理增量推拉与冲突消解。 */
export class SyncManager {
  constructor(private crypto: EnvelopeCrypto) {}

  async push(profileId: Uuid, data: unknown, currentRevision: number): Promise<SyncSnapshot> {
    const json = JSON.stringify(data);
    const sealed = this.crypto.seal(json, 'sync-payload');
    return {
      profileId,
      revision: currentRevision + 1,
      payload: sealed,
      checksum: '',
      createdAt: new Date().toISOString(),
    };
  }

  async pull(snapshot: SyncSnapshot): Promise<unknown> {
    const json = this.crypto.unseal(
      snapshot.payload.ciphertext,
      snapshot.payload.wrappedKey,
      snapshot.payload.iv,
      'sync-payload',
    );
    return JSON.parse(json);
  }
}
