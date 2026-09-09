import { createCipheriv, createDecipheriv, createHash, randomBytes, createPrivateKey, createPublicKey, constants } from 'node:crypto';

/** 密钥用途标签，防止同一密钥被用于不同目的。 */
export type KeyPurpose = 'profile-cookie' | 'proxy-secret' | 'sync-payload' | 'auth-token';

/** 信封加密：用一个 KEK（密钥加密密钥）加密若干 DEK（数据加密密钥）。 */
export class EnvelopeCrypto {
  private kek: Buffer;

  constructor(kekHex: string) {
    this.kek = Buffer.from(kekHex, 'hex');
    if (this.kek.length !== 32) {
      throw new Error('KEK 必须为 256 位（64 hex 字符）');
    }
  }

  /** 生成随机 DEK & 加密明文。 */
  seal(plaintext: string, purpose: KeyPurpose): { ciphertext: string; wrappedKey: string; iv: string } {
    const dek = randomBytes(32);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', dek, iv);
    const aad = Buffer.from(purpose, 'utf-8');
    cipher.setAAD(aad);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    // 用 KEK 包裹 DEK
    const wrapIv = randomBytes(12);
    const wrapCipher = createCipheriv('aes-256-gcm', this.kek, wrapIv);
    const wrappedKey = Buffer.concat([wrapCipher.update(dek), wrapCipher.final()]);
    const wrapTag = wrapCipher.getAuthTag();

    return {
      ciphertext: Buffer.concat([encrypted, tag]).toString('base64'),
      wrappedKey: Buffer.concat([wrappedKey, wrapTag, wrapIv]).toString('base64'),
      iv: iv.toString('base64'),
    };
  }

  /** 解封。 */
  unseal(ciphertext: string, wrappedKey: string, iv: string, purpose: KeyPurpose): string {
    const wrapBuf = Buffer.from(wrappedKey, 'base64');
    const wrapTag = wrapBuf.subarray(-28, -12);
    const wrapIv = wrapBuf.subarray(-12);
    const wrappedDek = wrapBuf.subarray(0, wrapBuf.length - 28);
    const wrapDecipher = createDecipheriv('aes-256-gcm', this.kek, wrapIv);
    wrapDecipher.setAuthTag(wrapTag);
    const dek = Buffer.concat([wrapDecipher.update(wrappedDek), wrapDecipher.final()]);

    const buf = Buffer.from(ciphertext, 'base64');
    const tag = buf.subarray(-16);
    const enc = buf.subarray(0, buf.length - 16);
    const decipher = createDecipheriv('aes-256-gcm', dek, Buffer.from(iv, 'base64'));
    const aad = Buffer.from(purpose, 'utf-8');
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return decipher.update(enc, undefined, 'utf-8') + decipher.final('utf-8');
  }
}

/** 从口令短语派生 256 位 KEK（PBKDF2）。 */
export function deriveKek(passphrase: string, salt?: string): { kek: string; salt: string } {
  const s = salt ?? randomBytes(16).toString('hex');
  const key = createHash('sha256').update(passphrase).update(s).digest();
  return { kek: key.toString('hex'), salt: s };
}
