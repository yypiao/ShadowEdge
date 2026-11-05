#!/usr/bin/env node
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
const outputPath = args.output ? resolve(args.output) : resolve(`experiments/probes/results/t32-${Date.now()}.json`);
const report = await runProbeSuite({
  executablePath: args.executable ?? process.env.SHADOWEDGE_KERNEL_EXECUTABLE,
  restarts: args.restarts === undefined ? 20 : Number(args.restarts),
  outputPath,
  expectedExitIp: args['expected-exit-ip'],
});
console.log(JSON.stringify({ outputPath, ...report.summary }, null, 2));
if (!report.summary.ok) process.exitCode = 1;
