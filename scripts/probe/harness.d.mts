import type { ResolvedUpstreamProxy } from '../../packages/kernel/dist/index.js';

export interface ProbeCheck {
  id: string;
  category: string;
  passed?: boolean;
  skipped?: boolean;
  details?: unknown;
  reason?: string;
}

export interface ProbeReport {
  format: 'shadowedge-probe-report';
  version: 1;
  startedAt: string;
  finishedAt: string;
  config: Record<string, unknown>;
  summary: {
    ok: boolean;
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    passRate: number;
  };
  checks: ProbeCheck[];
}

export function runProbeSuite(options: {
  executablePath?: string;
  restarts?: number;
  outputPath?: string;
  expectedExitIp?: string;
  proxy?: ResolvedUpstreamProxy;
  catalogVersion?: string;
  isolation?: boolean;
  stability?: boolean;
}): Promise<ProbeReport>;
