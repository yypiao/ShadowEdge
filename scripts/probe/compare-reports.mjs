import { isDeepStrictEqual } from 'node:util';

function stateOf(check) {
  if (!check) return 'missing';
  if (check.skipped) return 'skipped';
  return check.passed ? 'passed' : 'failed';
}

/**
 * 跨内核版本必须同时比较结果状态和详情；仅比较 pass/fail 会漏掉
 * “仍然通过但同一 seed 画像已经改变”的升级事故。
 */
export function compareProbeReports(baseline, candidate) {
  const baselineById = new Map(baseline.checks.map((check) => [check.id, check]));
  const candidateById = new Map(candidate.checks.map((check) => [check.id, check]));
  const ids = [...new Set([...baselineById.keys(), ...candidateById.keys()])].sort();
  const differences = [];
  for (const id of ids) {
    const before = baselineById.get(id);
    const after = candidateById.get(id);
    if (!before || !after) {
      differences.push({ id, kind: 'presence', baseline: stateOf(before), candidate: stateOf(after) });
      continue;
    }
    if (before.category !== after.category || stateOf(before) !== stateOf(after)) {
      differences.push({
        id, kind: 'status',
        baseline: { category: before.category, state: stateOf(before) },
        candidate: { category: after.category, state: stateOf(after) },
      });
    }
    if (!isDeepStrictEqual(before.details ?? null, after.details ?? null)) {
      differences.push({ id, kind: 'details', baseline: before.details ?? null, candidate: after.details ?? null });
    }
  }
  return {
    format: 'shadowedge-probe-comparison',
    version: 1,
    generatedAt: new Date().toISOString(),
    baseline: { startedAt: baseline.startedAt, finishedAt: baseline.finishedAt, summary: baseline.summary },
    candidate: { startedAt: candidate.startedAt, finishedAt: candidate.finishedAt, summary: candidate.summary },
    summary: {
      ok: baseline.summary.ok && candidate.summary.ok && differences.length === 0,
      total: ids.length,
      unchanged: ids.length - new Set(differences.map((difference) => difference.id)).size,
      changed: new Set(differences.map((difference) => difference.id)).size,
    },
    differences,
  };
}
