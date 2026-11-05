import { createHash, createPublicKey, verify } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, posix, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  KernelDistributionStatus,
  KernelInstallation,
  KernelPackageFile,
  KernelPackageManifest,
  Platform,
} from '@shadowedge/core';
import { ShadowEdgeError } from '@shadowedge/core';

interface KernelDistributionOptions {
  /** 可信 Ed25519 公钥 PEM；不允许渲染进程在安装时临时指定。 */
  publicKey?: string;
}

interface KernelSignature {
  algorithm: 'Ed25519';
  publicKeyId: string;
  signature: string;
}

const MAX_PACKAGE_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_FILES = 50000;

export class KernelDistributionService {
  private readonly kernelsDir: string;
  private readonly publicKey?: string;
  private readonly publicKeyId?: string;

  constructor(dataDir: string, options: KernelDistributionOptions = {}) {
    this.kernelsDir = join(dataDir, 'kernels');
    if (options.publicKey) {
      const key = createPublicKey(options.publicKey);
      if (key.asymmetricKeyType !== 'ed25519') {
        throw new ShadowEdgeError('E_KERNEL_SIGNATURE_INVALID', '内核签名公钥必须是 Ed25519');
      }
      this.publicKey = key.export({ type: 'spki', format: 'pem' }).toString();
      this.publicKeyId = keyId(this.publicKey);
    }
  }

  getStatus(): KernelDistributionStatus {
    const activeVersion = this.activeVersion();
    const installations = this.listInstallations(activeVersion);
    const executablePath = activeVersion
      ? join(this.kernelsDir, 'current', this.manifest(activeVersion).executable)
      : undefined;
    return {
      available: Boolean(activeVersion && executablePath && usableExecutable(executablePath) && this.publicKey),
      trustedKeyConfigured: this.publicKey !== undefined,
      activeVersion,
      executablePath: executablePath && existsSync(executablePath) ? executablePath : undefined,
      installations,
    };
  }

  install(archivePath: string): KernelDistributionStatus {
    if (!this.publicKey || !this.publicKeyId) {
      throw new ShadowEdgeError('E_KERNEL_SIGNATURE_INVALID', '尚未配置受信任的内核签名公钥');
    }
    const archive = resolve(archivePath);
    if (!statSync(archive).isFile() || statSync(archive).size > MAX_PACKAGE_BYTES) {
      throw new ShadowEdgeError('E_KERNEL_PACKAGE_INVALID', '内核包不存在或超过 8GB 限制');
    }
    mkdirSync(this.kernelsDir, { recursive: true, mode: 0o700 });
    const staging = join(this.kernelsDir, `.installing-${randomUUID()}`);
    mkdirSync(staging, { mode: 0o700 });
    try {
      const entries = zipEntries(archive);
      unzip(archive, staging, ['kernel-manifest.json', 'kernel-signature.json']);
      const manifestPath = join(staging, 'kernel-manifest.json');
      const signaturePath = join(staging, 'kernel-signature.json');
      if (!lstatSync(manifestPath).isFile() || !lstatSync(signaturePath).isFile()) {
        throw invalid('内核清单和签名必须是普通文件');
      }
      const manifest = parseManifest(readJson(manifestPath));
      const signature = parseSignature(readJson(signaturePath));
      this.verifySignature(manifest, signature);
      validateArchiveEntries(entries, manifest);
      unzip(archive, staging, ['payload/*']);
      verifyPayload(staging, manifest);
      const destination = join(this.kernelsDir, 'versions', manifest.kernelVersion);
      if (existsSync(destination)) {
        throw new ShadowEdgeError('E_KERNEL_PACKAGE_INVALID', `内核版本 ${manifest.kernelVersion} 已安装`);
      }
      if (!usableExecutable(join(staging, 'payload', manifest.executable))) {
        throw invalid('内核包可执行文件不存在或不可执行');
      }
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      writeFileSync(join(staging, 'installed-at.json'), `${JSON.stringify({ installedAt: new Date().toISOString() })}\n`, { mode: 0o600 });
      renameSync(staging, destination);
      // 暂存目录刚完成同一套验签与哈希；原子改名后直接切换，避免外置盘再读一遍完整内核。
      this.switchActive(manifest.kernelVersion);
      return this.getStatus();
    } catch (error) {
      rmSync(staging, { recursive: true, force: true });
      if (error instanceof ShadowEdgeError) throw error;
      throw invalid(`内核包安装失败: ${error instanceof Error ? error.message : String(error)}`, error);
    }
  }

  activate(version: string): KernelDistributionStatus {
    this.verifyVersion(version);
    this.switchActive(version);
    return this.getStatus();
  }

  /** 按环境固定版本解析，不经过 current 全局软链。 */
  getExecutablePath(version: string): string {
    assertVersion(version);
    const versionDir = join(this.kernelsDir, 'versions', version);
    if (!existsSync(versionDir)) {
      throw new ShadowEdgeError('E_KERNEL_VERSION_NOT_FOUND', `环境固定的内核版本 ${version} 未安装`);
    }
    return join(versionDir, 'payload', this.manifest(version).executable);
  }

  verifyVersion(version: string): void {
    assertVersion(version);
    const versionDir = join(this.kernelsDir, 'versions', version);
    if (!existsSync(versionDir)) {
      throw new ShadowEdgeError('E_KERNEL_VERSION_NOT_FOUND', `环境固定的内核版本 ${version} 未安装`);
    }
    const manifest = this.manifest(version);
    this.verifySignature(manifest, parseSignature(readJson(join(versionDir, 'kernel-signature.json'))));
    verifyPayload(versionDir, manifest);
    if (!usableExecutable(join(versionDir, 'payload', manifest.executable))) {
      throw invalid('缓存内核可执行文件不存在或不可执行');
    }
  }

  private switchActive(version: string): void {
    mkdirSync(this.kernelsDir, { recursive: true, mode: 0o700 });
    const current = join(this.kernelsDir, 'current');
    const next = join(this.kernelsDir, `.current-${randomUUID()}`);
    const target = join('versions', version, 'payload');
    symlinkSync(target, next, process.platform === 'win32' ? 'junction' : 'dir');
    try {
      renameSync(next, current);
    } catch (error) {
      rmSync(next, { force: true, recursive: true });
      throw error;
    }
  }

  /** 每次从缓存启动前重新验签和逐文件校验，手工改一个字节也必须拒启。 */
  verifyActive(): void {
    const version = this.activeVersion();
    if (!version) throw new ShadowEdgeError('E_KERNEL_NOT_INSTALLED', '没有已激活的缓存内核');
    this.verifyVersion(version);
  }

  private manifest(version: string): KernelPackageManifest {
    assertVersion(version);
    return parseManifest(readJson(join(this.kernelsDir, 'versions', version, 'kernel-manifest.json')));
  }

  private verifySignature(manifest: KernelPackageManifest, signature: KernelSignature): void {
    if (!this.publicKey || !this.publicKeyId) {
      throw new ShadowEdgeError('E_KERNEL_SIGNATURE_INVALID', '尚未配置受信任的内核签名公钥');
    }
    if (signature.publicKeyId !== this.publicKeyId ||
      !verify(null, Buffer.from(JSON.stringify(manifest)), this.publicKey, Buffer.from(signature.signature, 'base64'))) {
      throw new ShadowEdgeError('E_KERNEL_SIGNATURE_INVALID', '内核包签名不受信任或清单已被篡改');
    }
    if (manifest.platform !== hostPlatform() || manifest.arch !== process.arch) {
      throw invalid('内核包的平台或架构与本机不匹配');
    }
  }

  private activeVersion(): string | undefined {
    const current = join(this.kernelsDir, 'current');
    try {
      if (!lstatSync(current).isSymbolicLink()) return undefined;
      const match = readlinkSync(current).match(/^versions\/([\w.-]+)\/payload\/?$/);
      return match?.[1];
    } catch {
      return undefined;
    }
  }

  private listInstallations(activeVersion?: string): KernelInstallation[] {
    const root = join(this.kernelsDir, 'versions');
    if (!existsSync(root)) return [];
    return readdirSync(root).filter((name) => /^[\w.-]+$/.test(name)).sort().reverse().flatMap((version) => {
      try {
        const manifest = this.manifest(version);
        let installedAt = manifest.createdAt;
        try {
          const value: unknown = readJson(join(root, version, 'installed-at.json'));
          if (isRecord(value) && typeof value.installedAt === 'string') installedAt = value.installedAt;
        } catch { /* 老安装没有独立时间时使用包构建时间。 */ }
        return [{ version, platform: manifest.platform, arch: manifest.arch, installedAt, active: version === activeVersion }];
      } catch {
        return [];
      }
    });
  }
}

function verifyPayload(versionDir: string, manifest: KernelPackageManifest): void {
  const payload = join(versionDir, 'payload');
  if (!statSync(payload).isDirectory()) throw invalid('内核包缺少 payload 目录');
  const expected = new Map(manifest.files.map((file) => [file.path, file]));
  const actual = walk(payload);
  if (actual.length !== expected.size) throw invalid('内核包存在未登记或缺失的文件');
  for (const entry of actual) {
    const registered = expected.get(entry.path);
    if (!registered || registered.type !== entry.type || registered.size !== entry.size ||
      registered.sha256 !== entry.sha256) {
      throw invalid(`内核文件校验失败: ${entry.path}`);
    }
  }
}

function walk(root: string, current = root): KernelPackageFile[] {
  const result: KernelPackageFile[] = [];
  for (const name of readdirSync(current)) {
    const absolute = join(current, name);
    const stat = lstatSync(absolute);
    const path = relative(root, absolute).split(sep).join('/');
    if (!safeRelative(path)) throw invalid(`不安全的内核路径: ${path}`);
    if (stat.isDirectory()) result.push(...walk(root, absolute));
    else if (stat.isSymbolicLink()) {
      const target = readlinkSync(absolute);
      if (!safeSymlink(path, target)) throw invalid(`符号链接越界: ${path}`);
      result.push({ path, type: 'symlink', size: Buffer.byteLength(target), sha256: hash(Buffer.from(target)) });
    } else if (stat.isFile()) {
      const contents = readFileSync(absolute);
      result.push({ path, type: 'file', size: contents.length, sha256: hash(contents) });
    } else throw invalid(`不支持的内核文件类型: ${path}`);
  }
  return result;
}

function validateArchiveEntries(entries: string[], manifest: KernelPackageManifest): void {
  const required = new Set(['kernel-manifest.json', 'kernel-signature.json', 'payload/']);
  for (const file of manifest.files) {
    required.add(`payload/${file.path}`);
    const parts = file.path.split('/');
    for (let index = 1; index < parts.length; index += 1) required.add(`payload/${parts.slice(0, index).join('/')}/`);
  }
  for (const entry of entries) {
    if (!required.has(entry)) throw invalid(`内核 ZIP 包含未登记条目: ${entry}`);
  }
  for (const entry of required) {
    if (entry !== 'payload/' && !entries.includes(entry) && !entry.endsWith('/')) {
      throw invalid(`内核 ZIP 缺少条目: ${entry}`);
    }
  }
}

function zipEntries(archive: string): string[] {
  const result = spawnSync('unzip', ['-Z1', archive], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw invalid('无法读取内核 ZIP，请确认系统 unzip 可用');
  const entries = result.stdout.split(/\r?\n/).filter(Boolean);
  if (entries.length === 0 || entries.length > MAX_FILES * 2) throw invalid('内核 ZIP 条目数无效');
  const unique = new Set<string>();
  for (let entry of entries) {
    if (entry.includes('\\') || entry.includes('\0') || entry.startsWith('/') || entry.split('/').includes('..')) {
      throw invalid(`内核 ZIP 路径不安全: ${entry}`);
    }
    entry = entry.replace(/^\.\//, '');
    if (unique.has(entry)) throw invalid(`内核 ZIP 包含重复条目: ${entry}`);
    unique.add(entry);
  }
  return [...unique];
}

function unzip(archive: string, destination: string, entries: string[]): void {
  const result = spawnSync('unzip', ['-qq', archive, ...entries, '-d', destination], { stdio: 'inherit' });
  if (result.status !== 0) throw invalid('内核 ZIP 解压失败');
}

function parseManifest(value: unknown): KernelPackageManifest {
  if (!isRecord(value) || value.format !== 'shadowedge-kernel-package' || value.version !== 1 ||
    typeof value.kernelVersion !== 'string' || !isPlatform(value.platform) || typeof value.arch !== 'string' ||
    typeof value.executable !== 'string' || !safeRelative(value.executable) || typeof value.createdAt !== 'string' ||
    !Array.isArray(value.files) || value.files.length === 0 || value.files.length > MAX_FILES ||
    !value.files.every(isPackageFile)) {
    throw invalid('内核清单结构无效');
  }
  assertVersion(value.kernelVersion);
  const paths = new Set(value.files.map((file) => file.path));
  if (paths.size !== value.files.length) throw invalid('内核清单包含重复文件路径');
  return {
    format: 'shadowedge-kernel-package', version: 1, kernelVersion: value.kernelVersion,
    platform: value.platform, arch: value.arch, executable: value.executable,
    createdAt: value.createdAt,
    files: value.files.map((file) => ({ path: file.path, type: file.type, sha256: file.sha256, size: file.size })),
  };
}

function isPackageFile(value: unknown): value is KernelPackageFile {
  return isRecord(value) && typeof value.path === 'string' && safeRelative(value.path) &&
    (value.type === 'file' || value.type === 'symlink') && typeof value.sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(value.sha256) && typeof value.size === 'number' &&
    Number.isSafeInteger(value.size) && value.size >= 0 && value.size <= MAX_PACKAGE_BYTES;
}

function parseSignature(value: unknown): KernelSignature {
  if (!isRecord(value) || value.algorithm !== 'Ed25519' || typeof value.publicKeyId !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.publicKeyId) || typeof value.signature !== 'string' ||
    !/^[A-Za-z0-9+/]{86}==$/.test(value.signature)) {
    throw new ShadowEdgeError('E_KERNEL_SIGNATURE_INVALID', '内核签名结构无效');
  }
  return { algorithm: 'Ed25519', publicKeyId: value.publicKeyId, signature: value.signature };
}

function safeRelative(path: string): boolean {
  return path.length > 0 && !path.startsWith('/') && !path.includes('\\') && !path.includes('\0') &&
    !path.split('/').includes('..') && !path.endsWith('/');
}

function safeSymlink(path: string, target: string): boolean {
  if (!target || target.includes('\0') || target.includes('\\') || posix.isAbsolute(target)) return false;
  const resolved = posix.normalize(posix.join(posix.dirname(path), target));
  return resolved !== '..' && !resolved.startsWith('../') && safeRelative(resolved);
}

function assertVersion(version: string): void {
  if (!/^[\w.-]{1,80}$/.test(version)) throw invalid('内核版本格式无效');
}

function hostPlatform(): Platform {
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'win32') return 'windows';
  return 'linux';
}

function usableExecutable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch { return false; }
}

function readJson(path: string): unknown {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { throw invalid(`无法读取内核元数据: ${basename(path)}`, error); }
}

function hash(contents: Buffer): string { return createHash('sha256').update(contents).digest('hex'); }
function keyId(publicKey: string): string { return hash(Buffer.from(publicKey)); }
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isPlatform(value: unknown): value is Platform {
  return value === 'macos' || value === 'windows' || value === 'linux';
}
function invalid(message: string, cause?: unknown): ShadowEdgeError {
  return new ShadowEdgeError('E_KERNEL_PACKAGE_INVALID', message, { cause });
}
