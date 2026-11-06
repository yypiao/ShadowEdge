#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runProbeSuite } from './harness.mjs';

const args = {};
for (let index = 2; index < process.argv.length; index += 1) {
  const key = process.argv[index];
  if (!key?.startsWith('--')) throw new Error(`未知参数: ${key}`);
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${key} 缺少值`);
  args[key.slice(2)] = value;
  index += 1;
}
let proxy;
if (args.proxy) {
  if (!args['expected-exit-ip']) throw new Error('使用 --proxy 时必须同时提供健康检查得到的 --expected-exit-ip');
  const secretPath = resolve(args['proxy-file'] ?? 'experiments/.secrets/test-proxies.json');
  const secrets = JSON.parse(readFileSync(secretPath, 'utf8'));
  const credential = secrets.find((item) => item.id === args.proxy);
  if (!credential) throw new Error(`代理 ${args.proxy} 不在 secrets 文件里`);
  const upstreamUrl = new URL(args.upstream ?? process.env.SHADOWEDGE_PROBE_UPSTREAM ?? 'http://127.0.0.1:7897');
  if (upstreamUrl.protocol !== 'http:') throw new Error(`上游必须是 http://，收到 ${upstreamUrl.protocol}`);
  proxy = {
    protocol: credential.protocol ?? 'socks5',
    host: credential.host,
    port: credential.port,
    ...(credential.username ? { username: credential.username } : {}),
    ...(credential.password ? { password: credential.password } : {}),
    upstream: {
      protocol: 'http',
      host: upstreamUrl.hostname,
      port: Number(upstreamUrl.port || 80),
    },
  };
}
const outputPath = args.output ? resolve(args.output) : resolve(`experiments/probes/results/t32-${Date.now()}.json`);
const report = await runProbeSuite({
  executablePath: args.executable ?? process.env.SHADOWEDGE_KERNEL_EXECUTABLE,
  restarts: args.restarts === undefined ? 20 : Number(args.restarts),
  outputPath,
  expectedExitIp: args['expected-exit-ip'],
  proxy,
  catalogVersion: args['catalog-version'],
});
console.log(JSON.stringify({ outputPath, ...report.summary }, null, 2));
if (!report.summary.ok) process.exitCode = 1;
