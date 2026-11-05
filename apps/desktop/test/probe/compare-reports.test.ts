import { describe, expect, it } from 'vitest';
import { compareProbeReports, type ProbeReport } from '../../../../scripts/probe/compare-reports.mjs';

function report(details: unknown, overrides: Partial<ProbeReport> = {}): ProbeReport {
  return {
    startedAt: '2026-11-05T00:00:00.000Z',
    finishedAt: '2026-11-05T00:01:00.000Z',
    summary: { ok: true },
    checks: [
      { id: 'worker-image', category: 'worker', passed: true, details },
      { id: 'proxy-exit-ip', category: 'network', skipped: true },
      { id: 'cookie-isolation', category: 'isolation', passed: true },
    ],
    ...overrides,
  };
}

describe('跨内核版本探针报告比较', () => {
  it('状态和逐字段详情相同则允许升级，包括一致的跳过项', () => {
    const result = compareProbeReports(report({ userAgent: 'same' }), report({ userAgent: 'same' }));
    expect(result.summary).toMatchObject({ ok: true, total: 3, unchanged: 3, changed: 0 });
    expect(result.differences).toEqual([]);
  });

  it('同一 seed 详情漂移、状态退化或检查缺失都会拒绝升级', () => {
    const candidate = report({ userAgent: 'changed' });
    candidate.checks = candidate.checks.filter((check) => check.id !== 'cookie-isolation');
    candidate.checks[1] = { id: 'proxy-exit-ip', category: 'network', passed: false };
    const result = compareProbeReports(report({ userAgent: 'original' }), candidate);
    expect(result.summary.ok).toBe(false);
    expect(result.summary.changed).toBe(3);
    expect(result.differences).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'worker-image', kind: 'details' }),
      expect.objectContaining({ id: 'proxy-exit-ip', kind: 'status' }),
      expect.objectContaining({ id: 'cookie-isolation', kind: 'presence' }),
    ]));
  });
});
