import { randomBytes, randomUUID } from 'node:crypto';
import { EnvelopeCrypto } from '@shadowedge/crypto';

export const KERNEL_LAUNCH_KEK_ENV = 'SHADOWEDGE_LAUNCH_KEK';
const TOKEN_TTL_SECONDS = 30;

export interface KernelLaunchAuthorization {
  token: string;
  kekHex: string;
}

/**
 * 每次启动使用独立 KEK，避免把固定密钥编进应用或内核。
 * KEK 只通过子进程环境传递；信封密文通过命令行传递，内核校验后立即清除环境变量。
 */
export function createKernelLaunchAuthorization(
  profileId: string,
  issuedAtSeconds = Math.floor(Date.now() / 1000),
): KernelLaunchAuthorization {
  const kekHex = randomBytes(32).toString('hex');
  const envelope = new EnvelopeCrypto(kekHex).seal(
    JSON.stringify({
      v: 1,
      profileId,
      nonce: randomUUID(),
      iat: issuedAtSeconds,
      exp: issuedAtSeconds + TOKEN_TTL_SECONDS,
    }),
    'auth-token',
  );
  return {
    token: Buffer.from(JSON.stringify({ v: 1, ...envelope }), 'utf8').toString('base64'),
    kekHex,
  };
}
