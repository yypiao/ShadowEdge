import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { KeychainAdapter } from '../src/main/services/keyring.js';
import { loadKeyring } from '../src/main/services/keyring.js';

class MemoryKeychain implements KeychainAdapter {
  secret: string | undefined;
  failWrite = false;
  read(): string | undefined { return this.secret; }
  write(secret: string): void {
    if (this.failWrite) throw new Error('injected keychain failure');
    this.secret = secret;
  }
}

describe('本地 KEK 保管', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'shadowedge-keyring-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('macOS 迁移旧文件到 Keychain，密文可跨加载恢复且明文文件被删除', () => {
    const legacy = '11'.repeat(32);
    writeFileSync(join(dir, 'vault.key'), legacy);
    const keychain = new MemoryKeychain();
    const first = loadKeyring(dir, { platform: 'darwin', keychain, envKek: '' });
    expect(keychain.secret).toBe(legacy);
    expect(existsSync(join(dir, 'vault.key'))).toBe(false);
    const sealed = first.seal('cookie-secret', 'profile-cookie');
    const second = loadKeyring(dir, { platform: 'darwin', keychain, envKek: '' });
    expect(second.unseal(sealed.ciphertext, sealed.wrappedKey, sealed.iv, 'profile-cookie')).toBe('cookie-secret');
  });

  it('Keychain 写入失败保留旧密钥并明确拒止解锁', () => {
    const legacy = '22'.repeat(32);
    writeFileSync(join(dir, 'vault.key'), legacy);
    const keychain = new MemoryKeychain();
    keychain.failWrite = true;
    expect(() => loadKeyring(dir, { platform: 'darwin', keychain, envKek: '' })).toThrowError(
      expect.objectContaining({ code: 'E_KEYRING_UNAVAILABLE' }),
    );
    expect(readFileSync(join(dir, 'vault.key'), 'utf8')).toBe(legacy);
  });

  it('非 macOS 临时实现仍可持久化，测试环境变量优先且不触达 Keychain', () => {
    const keychain = new MemoryKeychain();
    const injected = loadKeyring(dir, { platform: 'darwin', keychain, envKek: '33'.repeat(32) });
    expect(keychain.secret).toBeUndefined();
    expect(injected.seal('ok', 'auth-token').ciphertext).toBeTruthy();
    const first = loadKeyring(dir, { platform: 'linux', envKek: '' });
    const sealed = first.seal('proxy-secret', 'proxy-secret');
    const second = loadKeyring(dir, { platform: 'linux', envKek: '' });
    expect(second.unseal(sealed.ciphertext, sealed.wrappedKey, sealed.iv, 'proxy-secret')).toBe('proxy-secret');
  });
});
