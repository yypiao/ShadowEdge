import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EnvelopeCrypto } from '@shadowedge/crypto';

/**
 * 本地主密钥（KEK）的加载与创建。
 * 当前实现：随机 KEK 存于用户数据目录 vault.key（0600）。
 * 后续接入 macOS Keychain / Windows DPAPI 时只需替换本文件的读写方式，
 * 上层 EnvelopeCrypto 用法不变。
 */
export function loadKeyring(dataDir: string): EnvelopeCrypto {
  const envKek = process.env.SHADOWEDGE_KEK;
  if (envKek) return new EnvelopeCrypto(envKek);

  const keyPath = join(dataDir, 'vault.key');
  if (existsSync(keyPath)) {
    const hex = readFileSync(keyPath, 'utf-8').trim();
    return new EnvelopeCrypto(hex);
  }
  const kek = randomBytes(32).toString('hex');
  writeFileSync(keyPath, kek, { mode: 0o600 });
  chmodSync(keyPath, 0o600);
  return new EnvelopeCrypto(kek);
}
