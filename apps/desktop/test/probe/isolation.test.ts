import { describe, expect, it } from 'vitest';
import { runProbeSuite } from '../../../../scripts/probe/harness.mjs';

const enabled = process.env.SHADOWEDGE_PROBE_SMOKE === '1' && Boolean(process.env.SHADOWEDGE_KERNEL_EXECUTABLE);

describe.skipIf(!enabled)('T32 双环境真实隔离探针', () => {
  it('Cookie、LocalStorage、IndexedDB、指纹和 Worker 相互隔离', async () => {
    const report = await runProbeSuite({
      executablePath: process.env.SHADOWEDGE_KERNEL_EXECUTABLE,
      restarts: 0,
      stability: false,
    });
    expect(report.checks.filter((check: { category: string }) => check.category === 'isolation')).toHaveLength(5);
    expect(report.summary).toMatchObject({ ok: true, failed: 0 });
  }, 90000);
});
