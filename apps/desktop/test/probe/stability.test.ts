import { describe, expect, it } from 'vitest';
import { runProbeSuite } from '../../../../scripts/probe/harness.mjs';

const enabled = process.env.SHADOWEDGE_PROBE_SMOKE === '1' && Boolean(process.env.SHADOWEDGE_KERNEL_EXECUTABLE);

describe.skipIf(!enabled)('T32 指纹重启稳定性探针', () => {
  it('同一环境重启 20 次画像哈希零漂移', async () => {
    const report = await runProbeSuite({
      executablePath: process.env.SHADOWEDGE_KERNEL_EXECUTABLE,
      isolation: false,
      restarts: 20,
    });
    const stability = report.checks.find((check: { id: string }) => check.id === '20-restart-zero-drift');
    expect(stability?.details.requestedRestarts).toBe(20);
    expect(report.summary).toMatchObject({ ok: true, failed: 0 });
  }, 180000);
});
