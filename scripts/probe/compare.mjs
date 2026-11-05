#!/usr/bin/env node
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { compareProbeReports } from './compare-reports.mjs';

const args = {};
for (let index = 2; index < process.argv.length; index += 1) {
  const key = process.argv[index];
  if (!key?.startsWith('--')) throw new Error(`未知参数: ${key}`);
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${key} 缺少值`);
  args[key.slice(2)] = value;
  index += 1;
}
if (!args.baseline || !args.candidate) {
  throw new Error('用法: node scripts/probe/compare.mjs --baseline <旧报告> --candidate <新报告> [--output <比较报告>]');
}
const baselinePath = resolve(args.baseline);
const candidatePath = resolve(args.candidate);
const report = compareProbeReports(
  JSON.parse(readFileSync(baselinePath, 'utf8')),
  JSON.parse(readFileSync(candidatePath, 'utf8')),
);
report.baseline.path = baselinePath;
report.candidate.path = candidatePath;
if (args.output) {
  const outputPath = resolve(args.output);
  mkdirSync(dirname(outputPath), { recursive: true });
  const temporary = `${outputPath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, outputPath);
  report.outputPath = outputPath;
}
console.log(JSON.stringify({ outputPath: report.outputPath, ...report.summary }, null, 2));
if (!report.summary.ok) process.exitCode = 1;
