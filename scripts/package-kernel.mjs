#!/usr/bin/env node
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { chmodSync, closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readlinkSync, readdirSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

function argsOf(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key?.startsWith('--')) throw new Error(`未知参数: ${key}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${key} 缺少值`);
    result[key.slice(2)] = value;
    index += 1;
  }
  return result;
}

function hostPlatform() {
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'win32') return 'windows';
  return 'linux';
}

function defaultExecutable(platform) {
  if (platform === 'macos') return 'Chromium.app/Contents/MacOS/Chromium';
  return platform === 'windows' ? 'chrome.exe' : 'chrome';
}

function safePath(path) {
  return path.length > 0 && !path.startsWith('/') && !path.includes('\\') && !path.split('/').includes('..') && !path.includes('\0');
}

function walk(root, current = root) {
  const entries = [];
  for (const name of readdirSync(current).sort()) {
    const absolute = join(current, name);
    const stat = lstatSync(absolute);
    const path = relative(root, absolute).split(sep).join('/');
    if (!safePath(path)) throw new Error(`不安全的包路径: ${path}`);
    if (stat.isDirectory()) entries.push(...walk(root, absolute));
    else if (stat.isSymbolicLink()) {
      const target = readlinkSync(absolute);
      entries.push({ path, type: 'symlink', sha256: createHash('sha256').update(target).digest('hex'), size: Buffer.byteLength(target) });
    } else if (stat.isFile()) {
      const contents = readFileSync(absolute);
      entries.push({ path, type: 'file', sha256: createHash('sha256').update(contents).digest('hex'), size: contents.length });
    } else throw new Error(`不支持的文件类型: ${path}`);
  }
  return entries;
}

function machO(path) {
  const descriptor = openSync(path, 'r');
  try {
    const header = Buffer.alloc(4);
    if (readSync(descriptor, header, 0, 4, 0) !== 4) return false;
    return ['cffaedfe', 'cefaedfe', 'feedfacf', 'feedface', 'cafebabe', 'bebafeca'].includes(header.toString('hex'));
  } finally {
    closeSync(descriptor);
  }
}

function validateMacRuntime(root, files) {
  const packaged = files.map((file) => file.path);
  const missing = new Set();
  const inspectionDir = mkdtempSync(join(tmpdir(), 'shadowedge-otool-'));
  try {
    for (const file of files) {
      if (file.type !== 'file' || !machO(join(root, file.path))) continue;
      let inspected = join(root, file.path);
      // Apple otool 会把路径中的括号误认为 archive(member)，用安全临时名检查这类 Helper。
      if (/[()]/.test(inspected)) {
        inspected = join(inspectionDir, 'binary');
        copyFileSync(join(root, file.path), inspected);
      }
      const result = spawnSync('otool', ['-L', inspected], { encoding: 'utf8' });
      if (result.status !== 0) throw new Error(`无法检查 Mach-O 依赖: ${file.path}`);
      for (const line of result.stdout.split(/\r?\n/)) {
        const match = line.trim().match(/^(@rpath\/.+?) \(/);
        if (!match) continue;
        const dependency = match[1].slice('@rpath/'.length);
        if (!safePath(dependency)) throw new Error(`不安全的 @rpath 依赖: ${match[1]}`);
        if (!packaged.some((path) => path === dependency || path.endsWith(`/${dependency}`))) {
          missing.add(match[1]);
        }
      }
    }
  } finally {
    rmSync(inspectionDir, { recursive: true, force: true });
  }
  if (missing.size > 0) {
    throw new Error(`包内缺少 Mach-O @rpath 依赖: ${[...missing].sort().join(', ')}；请先使用 scripts/stage-kernel.mjs 暂存完整运行时`);
  }
}

const args = argsOf(process.argv.slice(2));
if (!args.root || !args['kernel-version'] || !args['private-key'] || !args.output) {
  throw new Error('用法: node scripts/package-kernel.mjs --root <目录> --kernel-version <版本> --private-key <Ed25519私钥PEM> --output <zip> [--platform macos] [--arch arm64] [--executable <相对路径>]');
}
const root = resolve(args.root);
const output = resolve(args.output);
const platform = args.platform ?? hostPlatform();
const arch = args.arch ?? process.arch;
const executable = args.executable ?? defaultExecutable(platform);
if (!['macos', 'windows', 'linux'].includes(platform)) throw new Error(`不支持的平台: ${platform}`);
if (!/^[\w.-]{1,80}$/.test(args['kernel-version'])) throw new Error('内核版本只能包含字母、数字、点、下划线和连字符');
if (!safePath(executable)) throw new Error('可执行文件路径不安全');
if (!statSync(root).isDirectory()) throw new Error('内核根目录不存在');
if (!statSync(join(root, executable)).isFile()) throw new Error(`可执行文件不存在: ${executable}`);
if (existsSync(output)) throw new Error(`输出已存在，拒绝覆盖: ${output}`);
const manifest = {
  format: 'shadowedge-kernel-package',
  version: 1,
  kernelVersion: args['kernel-version'],
  platform,
  arch,
  executable,
  createdAt: new Date().toISOString(),
  files: walk(root),
};
if (manifest.files.length === 0 || manifest.files.length > 50000) throw new Error('包文件数必须在 1..50000');
if (platform === 'macos' && process.platform === 'darwin') validateMacRuntime(root, manifest.files);
const privateKey = createPrivateKey(readFileSync(args['private-key'], 'utf8'));
if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('只支持 Ed25519 私钥');
const publicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' });
const publicKeyId = createHash('sha256').update(publicKey).digest('hex');
const signature = {
  algorithm: 'Ed25519',
  publicKeyId,
  signature: sign(null, Buffer.from(JSON.stringify(manifest)), privateKey).toString('base64'),
};
const staging = `${output}.staging-${process.pid}`;
mkdirSync(join(staging, 'payload'), { recursive: true });
try {
  // zip 从 staging 打包，payload 由硬链接/复制填充；符号链接必须保留 Chromium.framework 的内部结构。
  const copy = spawnSync('cp', ['-R', `${root}${sep}`, join(staging, 'payload')], { stdio: 'inherit' });
  if (copy.status !== 0) throw new Error('复制内核到打包暂存目录失败');
  writeFileSync(join(staging, 'kernel-manifest.json'), JSON.stringify(manifest), { mode: 0o600 });
  writeFileSync(join(staging, 'kernel-signature.json'), JSON.stringify(signature), { mode: 0o600 });
  mkdirSync(dirname(output), { recursive: true });
  const zip = spawnSync('zip', ['-q', '-X', '--symlinks', '-r', output, 'payload', 'kernel-manifest.json', 'kernel-signature.json'], { cwd: staging, stdio: 'inherit' });
  if (zip.status !== 0) throw new Error('zip 打包失败，请确认系统 zip 可用');
  chmodSync(output, 0o600);
  console.log(JSON.stringify({ output, kernelVersion: manifest.kernelVersion, platform, arch, files: manifest.files.length, publicKeyId, publicKey: basename(args['private-key']) }, null, 2));
} finally {
  rmSync(staging, { recursive: true, force: true });
}
