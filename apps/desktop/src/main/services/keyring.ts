import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ShadowEdgeError } from '@shadowedge/core';
import { EnvelopeCrypto } from '@shadowedge/crypto';

export interface KeychainAdapter {
  read(): string | undefined;
  write(secret: string): void;
}

interface KeyringOptions {
  platform?: NodeJS.Platform;
  envKek?: string;
  keychain?: KeychainAdapter;
}

const KEYCHAIN_SERVICE = 'com.shadowedge.desktop.local-kek';
const KEYCHAIN_ACCOUNT = 'local-user';

class MacOsKeychain implements KeychainAdapter {
  read(): string | undefined {
    const result = spawnSync('/usr/bin/security', [
      'find-generic-password', '-a', KEYCHAIN_ACCOUNT, '-s', KEYCHAIN_SERVICE, '-w',
    ], { encoding: 'utf8' });
    if (result.error) throw result.error;
    if (result.status === 44) return undefined;
    if (result.status !== 0) throw new Error('macOS Keychain 读取失败');
    return result.stdout.trim();
  }

  write(secret: string): void {
    // -w 放在末尾让 security 从 stdin 读取，避免 KEK 出现在进程参数列表。
    const result = spawnSync('/usr/bin/security', [
      'add-generic-password', '-U', '-a', KEYCHAIN_ACCOUNT, '-s', KEYCHAIN_SERVICE, '-w',
    ], { input: `${secret}\n${secret}\n`, encoding: 'utf8' });
    if (result.error) throw result.error;
    if (result.status !== 0 || this.read() !== secret) {
      throw new Error('macOS Keychain 写入或读回校验失败');
    }
  }
}

/**
 * 生产 macOS 使用 Keychain；其他平台暂时保留 0600 文件并在文档中明确边界。
 * SHADOWEDGE_KEK 仅供测试/开发注入，避免自动化读写开发者真实 Keychain。
 */
export function loadKeyring(dataDir: string, options: KeyringOptions = {}): EnvelopeCrypto {
  const envKek = options.envKek ?? process.env.SHADOWEDGE_KEK;
  if (envKek) return new EnvelopeCrypto(validKek(envKek));
  mkdirSync(dataDir, { recursive: true });
  const keyPath = join(dataDir, 'vault.key');
  const platform = options.platform ?? process.platform;
  if (platform === 'darwin') {
    const keychain = options.keychain ?? new MacOsKeychain();
    try {
      const existing = keychain.read();
      if (existing !== undefined) {
        const kek = validKek(existing);
        rmSync(keyPath, { force: true });
        return new EnvelopeCrypto(kek);
      }
      const legacy = existsSync(keyPath) ? validKek(readFileSync(keyPath, 'utf8').trim()) : undefined;
      const kek = legacy ?? randomBytes(32).toString('hex');
      keychain.write(kek);
      // 只有 Keychain 写入成功后才删除旧明文密钥。
      rmSync(keyPath, { force: true });
      return new EnvelopeCrypto(kek);
    } catch (error) {
      throw new ShadowEdgeError('E_KEYRING_UNAVAILABLE', '无法访问 macOS Keychain，本地数据已停止解锁', {
        cause: error,
      });
    }
  }
  if (existsSync(keyPath)) return new EnvelopeCrypto(validKek(readFileSync(keyPath, 'utf8').trim()));
  const kek = randomBytes(32).toString('hex');
  writeFileSync(keyPath, kek, { mode: 0o600, flag: 'wx' });
  chmodSync(keyPath, 0o600);
  return new EnvelopeCrypto(kek);
}

function validKek(value: string): string {
  if (!/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new ShadowEdgeError('E_KEYRING_UNAVAILABLE', '本地 KEK 格式无效');
  }
  return value.toLowerCase();
}
