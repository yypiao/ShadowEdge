import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KernelDistributionService } from '../src/main/services/kernel-distribution.js';
import { KernelRuntimeService } from '../src/main/services/kernel-runtime.js';

const ROOT = join(import.meta.dirname, '../../..');

describe('签名内核离线分发与回滚', () => {
  let dir: string;
  let privateKey: string;
  let publicKey: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'shadowedge-kernel-distribution-'));
    const pair = generateKeyPairSync('ed25519');
    privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function makePackage(
    version: string,
    marker: string,
    signingKey = privateKey,
    executableRelative?: string,
  ): string {
    const root = join(dir, `root-${version}`);
    const defaultExecutable = process.platform === 'darwin'
      ? join(root, 'Chromium.app/Contents/MacOS/Chromium')
      : join(root, process.platform === 'win32' ? 'chrome.exe' : 'chrome');
    const executable = executableRelative ? join(root, executableRelative) : defaultExecutable;
    mkdirSync(join(executable, '..'), { recursive: true });
    writeFileSync(executable, `#!/bin/sh\necho '${marker}'\n`, { mode: 0o700 });
    chmodSync(executable, 0o700);
    writeFileSync(join(root, 'marker.txt'), marker);
    symlinkSync('marker.txt', join(root, 'marker-link'));
    const keyPath = join(dir, `${version}-private.pem`);
    const archive = join(dir, `${version}.zip`);
    writeFileSync(keyPath, signingKey, { mode: 0o600 });
    execFileSync(process.execPath, [
      join(ROOT, 'scripts/package-kernel.mjs'),
      '--root', root,
      '--kernel-version', version,
      '--private-key', keyPath,
      '--output', archive,
      ...(executableRelative ? ['--executable', executableRelative] : []),
    ], { stdio: 'pipe' });
    return archive;
  }

  it('验签、安装、原子切换、离线解析与回滚均生效', () => {
    const dataDir = join(dir, 'data');
    const service = new KernelDistributionService(dataDir, { publicKey });
    service.install(makePackage('1.0.0', 'version-one'));
    expect(service.getStatus()).toMatchObject({ activeVersion: '1.0.0', available: true });
    expect(readFileSync(join(dataDir, 'kernels/current/marker.txt'), 'utf8')).toBe('version-one');
    expect(readlinkSync(join(dataDir, 'kernels/current/marker-link'))).toBe('marker.txt');

    const runtime = new KernelRuntimeService(dataDir, {}, () => service.verifyActive());
    const resolveExecutable = runtime.driverOptions().executablePath;
    expect(typeof resolveExecutable).toBe('function');
    const installed = typeof resolveExecutable === 'function' ? resolveExecutable() : resolveExecutable;
    expect(installed).toContain('kernels/current');
    expect(runtime.getStatus()).toMatchObject({ source: 'installed', available: true });

    service.install(makePackage('2.0.0', 'version-two'));
    expect(service.getStatus().activeVersion).toBe('2.0.0');
    service.activate('1.0.0');
    expect(service.getStatus()).toMatchObject({ activeVersion: '1.0.0', available: true });
    expect(service.getStatus().installations).toHaveLength(2);
  });

  it('已安装内核被改一个字节时拒绝离线启动，当前版本不被破坏', () => {
    const dataDir = join(dir, 'data');
    const service = new KernelDistributionService(dataDir, { publicKey });
    service.install(makePackage('1.0.0', 'original'));
    writeFileSync(join(dataDir, 'kernels/versions/1.0.0/payload/marker.txt'), 'tampered');
    expect(() => service.verifyActive()).toThrowError(expect.objectContaining({
      code: 'E_KERNEL_PACKAGE_INVALID',
    }));
    expect(service.getStatus().activeVersion).toBe('1.0.0');
    const runtime = new KernelRuntimeService(dataDir, {}, () => service.verifyActive());
    const resolveExecutable = runtime.driverOptions().executablePath;
    expect(() => typeof resolveExecutable === 'function' ? resolveExecutable() : resolveExecutable)
      .toThrowError(expect.objectContaining({ code: 'E_KERNEL_PACKAGE_INVALID' }));
  });

  it('错误公钥和未知版本明确拒绝', () => {
    const other = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const archive = makePackage('1.0.0', 'untrusted', other);
    const service = new KernelDistributionService(join(dir, 'data'), { publicKey });
    expect(() => service.install(archive)).toThrowError(expect.objectContaining({
      code: 'E_KERNEL_SIGNATURE_INVALID',
    }));
    expect(service.getStatus().installations).toEqual([]);
    expect(() => service.activate('missing')).toThrowError(expect.objectContaining({
      code: 'E_KERNEL_VERSION_NOT_FOUND',
    }));
  });

  it('清单中的自定义可执行路径能传到运行时，不只支持默认 Chromium 路径', () => {
    const dataDir = join(dir, 'data');
    const service = new KernelDistributionService(dataDir, { publicKey });
    service.install(makePackage('custom-path', 'custom', privateKey, 'bundle/bin/browser'));
    const runtime = new KernelRuntimeService(
      dataDir,
      {},
      () => service.verifyActive(),
      () => service.getStatus().executablePath,
    );
    const resolved = runtime.driverOptions().executablePath;
    const executable = typeof resolved === 'function' ? resolved() : resolved;
    expect(executable).toBe(join(dataDir, 'kernels/current/bundle/bin/browser'));
    expect(runtime.getStatus()).toMatchObject({ source: 'installed', available: true });
  });

  it.skipIf(process.platform !== 'darwin')('macOS release 暂存只复制自包含应用', () => {
    const build = join(dir, 'build');
    const executable = join(build, 'Chromium.app/Contents/MacOS/Chromium');
    mkdirSync(join(executable, '..'), { recursive: true });
    writeFileSync(executable, '#!/bin/sh\n', { mode: 0o700 });
    writeFileSync(join(build, 'args.gn'), 'is_component_build = false\n');
    writeFileSync(join(build, 'ignored.dylib'), 'development library');
    const output = join(dir, 'staged');
    execFileSync(process.execPath, [
      join(ROOT, 'scripts/stage-kernel.mjs'), '--build-dir', build, '--output', output,
    ], { stdio: 'pipe' });
    expect(readFileSync(join(output, 'Chromium.app/Contents/MacOS/Chromium'), 'utf8')).toBe('#!/bin/sh\n');
    expect(existsSync(join(output, 'ignored.dylib'))).toBe(false);
  });

  it.skipIf(process.platform !== 'darwin')('macOS component build 在打包前明确拒绝', () => {
    const build = join(dir, 'component-build');
    const executable = join(build, 'Chromium.app/Contents/MacOS/Chromium');
    mkdirSync(join(executable, '..'), { recursive: true });
    writeFileSync(executable, '#!/bin/sh\n', { mode: 0o700 });
    writeFileSync(join(build, 'args.gn'), 'is_component_build = true\n');
    const output = join(dir, 'component-staged');
    expect(() => execFileSync(process.execPath, [
      join(ROOT, 'scripts/stage-kernel.mjs'), '--build-dir', build, '--output', output,
    ], { stdio: 'pipe' })).toThrow(/component build/);
    expect(existsSync(output)).toBe(false);
  });
});
