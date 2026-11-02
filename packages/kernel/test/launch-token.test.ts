import { EnvelopeCrypto } from '@shadowedge/crypto';
import { describe, expect, it } from 'vitest';
import { createKernelLaunchAuthorization } from '../src/launch-token.js';

describe('内核一次性启动令牌', () => {
  it('使用随机 KEK 与 nonce，payload 可解封且不在令牌中明文出现', () => {
    const first = createKernelLaunchAuthorization('profile-secret', 1_800_000_000);
    const second = createKernelLaunchAuthorization('profile-secret', 1_800_000_000);
    expect(first.kekHex).toMatch(/^[0-9a-f]{64}$/);
    expect(first.kekHex).not.toBe(second.kekHex);
    expect(first.token).not.toBe(second.token);
    expect(Buffer.from(first.token, 'base64').toString('utf8')).not.toContain('profile-secret');

    const envelope = JSON.parse(Buffer.from(first.token, 'base64').toString('utf8'));
    const payload = JSON.parse(
      new EnvelopeCrypto(first.kekHex).unseal(
        envelope.ciphertext,
        envelope.wrappedKey,
        envelope.iv,
        'auth-token',
      ),
    );
    expect(payload).toMatchObject({
      v: 1,
      profileId: 'profile-secret',
      iat: 1_800_000_000,
      exp: 1_800_000_030,
    });
    expect(payload.nonce).toMatch(/^[0-9a-f-]{36}$/);
  });
});
