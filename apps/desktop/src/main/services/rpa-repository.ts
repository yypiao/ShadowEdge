import type { RpaRun, RpaWorkflow, Uuid } from '@shadowedge/core';
import { allRows, getRow, type ShadowEdgeDb } from './db.js';

interface WorkflowRow {
  id: string;
  org_id: string;
  name: string;
  version: number;
  graph: string;
  inputs_schema: string | null;
  created_by: string;
  updated_at: string;
}

interface RunRow {
  id: string;
  workflow_id: string;
  profile_id: string;
  status: RpaRun['status'];
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
  outputs: string;
  artifacts: string;
}

function toWorkflow(row: WorkflowRow): RpaWorkflow {
  return {
    id: row.id,
    orgId: row.org_id,
    name: row.name,
    version: row.version,
    graph: JSON.parse(row.graph) as RpaWorkflow['graph'],
    inputsSchema: row.inputs_schema ? JSON.parse(row.inputs_schema) : undefined,
    createdBy: row.created_by,
    updatedAt: row.updated_at,
  };
}

function toRun(row: RunRow): RpaRun {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    profileId: row.profile_id,
    status: row.status,
    startedAt: row.started_at ?? undefined,
    finishedAt: row.finished_at ?? undefined,
    error: row.error ?? undefined,
    outputs: JSON.parse(row.outputs) as RpaRun['outputs'],
    artifacts: JSON.parse(row.artifacts) as RpaRun['artifacts'],
  };
}

export class RpaRepository {
  constructor(private readonly handle: ShadowEdgeDb) {}

  listWorkflows(): RpaWorkflow[] {
    return allRows<WorkflowRow>(
      this.handle.db,
      'SELECT * FROM rpa_workflows ORDER BY updated_at DESC',
    ).map(toWorkflow);
  }

  getWorkflow(id: Uuid): RpaWorkflow | undefined {
    const row = getRow<WorkflowRow>(
      this.handle.db,
      'SELECT * FROM rpa_workflows WHERE id = ?',
      id,
    );
    return row ? toWorkflow(row) : undefined;
  }

  saveWorkflow(workflow: RpaWorkflow): void {
    this.handle.db.prepare(
      `INSERT INTO rpa_workflows
        (id, org_id, name, version, graph, inputs_schema, created_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, version=excluded.version, graph=excluded.graph,
        inputs_schema=excluded.inputs_schema, updated_at=excluded.updated_at`,
    ).run(
      workflow.id,
      workflow.orgId,
      workflow.name,
      workflow.version,
      JSON.stringify(workflow.graph),
      workflow.inputsSchema === undefined ? null : JSON.stringify(workflow.inputsSchema),
      workflow.createdBy,
      workflow.updatedAt,
    );
  }

  deleteWorkflow(id: Uuid): void {
    this.handle.db.prepare('DELETE FROM rpa_workflows WHERE id = ?').run(id);
  }

  saveRun(run: RpaRun): void {
    const now = new Date().toISOString();
    this.handle.db.prepare(
      `INSERT INTO rpa_runs
        (id, workflow_id, profile_id, status, started_at, finished_at, error,
         outputs, artifacts, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
        status=excluded.status, started_at=excluded.started_at,
        finished_at=excluded.finished_at, error=excluded.error,
        outputs=excluded.outputs, artifacts=excluded.artifacts,
        updated_at=excluded.updated_at`,
    ).run(
      run.id,
      run.workflowId,
      run.profileId,
      run.status,
      run.startedAt ?? null,
      run.finishedAt ?? null,
      run.error ?? null,
      JSON.stringify(run.outputs ?? {}),
      JSON.stringify(run.artifacts),
      now,
      now,
    );
  }

  getRun(id: Uuid): RpaRun | undefined {
    const row = getRow<RunRow>(this.handle.db, 'SELECT * FROM rpa_runs WHERE id = ?', id);
    return row ? toRun(row) : undefined;
  }

  listRuns(limit = 100): RpaRun[] {
    return allRows<RunRow>(
      this.handle.db,
      'SELECT * FROM rpa_runs ORDER BY created_at DESC LIMIT ?',
      limit,
    ).map(toRun);
  }

  recoverActiveRuns(): number {
    const now = new Date().toISOString();
    const result = this.handle.db.prepare(
      `UPDATE rpa_runs SET status = 'failed', error = ?, finished_at = ?, updated_at = ?
       WHERE status IN ('queued', 'running')`,
    ).run('应用重启，本次 RPA 运行已中断', now, now);
    return Number(result.changes);
  }
}
