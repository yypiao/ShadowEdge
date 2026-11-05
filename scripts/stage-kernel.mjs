#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

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

const args = argsOf(process.argv.slice(2));
if (process.platform !== 'darwin') throw new Error('当前暂存脚本仅验证 macOS；Windows/Linux 发布暂存尚未实现');
if (!args['build-dir'] || !args.output) {
  throw new Error('用法: node scripts/stage-kernel.mjs --build-dir <out/ShadowEdge> --output <空目录>');
}
const buildDir = resolve(args['build-dir']);
const output = resolve(args.output);
const appPath = join(buildDir, 'Chromium.app');
if (!statSync(appPath).isDirectory()) throw new Error(`未找到 ${appPath}`);
if (existsSync(output)) throw new Error(`输出已存在，拒绝覆盖: ${output}`);
const argsGn = readFileSync(join(buildDir, 'args.gn'), 'utf8');
if (/^\s*is_component_build\s*=\s*true\s*$/m.test(argsGn)) {
  throw new Error('component build 仅用于开发：数百个 dylib 的冷加载会超过启动授权有效期；请使用 scripts/build-chromium.sh --mode release 构建分发产物');
}
mkdirSync(output, { recursive: true, mode: 0o700 });
cpSync(appPath, join(output, 'Chromium.app'), { recursive: true, verbatimSymlinks: true });
console.log(JSON.stringify({
  output,
  application: basename(appPath),
  componentBuild: false,
}, null, 2));
