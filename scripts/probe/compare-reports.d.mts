export interface ProbeCheck {
  id: string;
  category: string;
  passed?: boolean;
  skipped?: boolean;
  details?: unknown;
}
export interface ProbeReport {
  startedAt: string;
  finishedAt: string;
  summary: { ok: boolean };
  checks: ProbeCheck[];
}
export interface ProbeComparison {
  format: 'shadowedge-probe-comparison';
  version: 1;
  generatedAt: string;
  summary: { ok: boolean; total: number; unchanged: number; changed: number };
  differences: Array<{ id: string; kind: string; baseline: unknown; candidate: unknown }>;
}
export function compareProbeReports(baseline: ProbeReport, candidate: ProbeReport): ProbeComparison;
