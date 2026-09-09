import { describe, expect, it } from 'vitest';
import { deriveKek, EnvelopeCrypto } from '../src/index.js';

describe('EnvelopeCrypto', () => {
  const { kek } = deriveKek('correct horse battery staple', 'fixed-salt');
  const envelope = new EnvelopeCrypto(kek);

  it('加密后可原样解密', () => {
    const plaintext = JSON.stringify({ cookie: 'session=abc', domain: '.amazon.com' });
    const sealed = envelope.seal(plaintext, 'sync-payload');
    expect(envelope.unseal(sealed.ciphertext, sealed.wrappedKey, sealed.iv, 'sync-payload')).toBe(plaintext);
  });

  it('每次加密应使用不同 DEK', () => {
    const a = envelope.seal('same', 'sync-payload');
    const b = envelope.seal('same', 'sync-payload');
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.wrappedKey).not.toBe(b.wrappedKey);
  });

  it('用途不匹配时解密必须失败（AAD 绑定）', () => {
    const sealed = envelope.seal('secret', 'proxy-secret');
    expect(() =>
      envelope.unseal(sealed.ciphertext, sealed.wrappedKey, sealed.iv, 'sync-payload'),
    ).toThrow();
  });

  it('KEK 长度非法时应拒绝构造', () => {
    expect(() => new EnvelopeCrypto('deadbeef')).toThrow();
  });
});
