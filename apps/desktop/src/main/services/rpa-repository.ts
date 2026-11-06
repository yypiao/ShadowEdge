import type { RpaRun, RpaSchedule, RpaWorkflow, Uuid } from '@shadowedge/core';
import { ShadowEdgeError } from '@shadowedge/core';
import type { EnvelopeCrypto } from '@shadowedge/crypto';
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
  failure: string | null;
}

interface ScheduleRow {
  workflow_id: string;
  profile_ids: string;
  interval_minutes: number;
  enabled: number;
  next_run_at: string;
  last_run_at: string | null;
  last_error: string | null;
  updated_at: string;
  inputs_ciphertext: string | null;
  inputs_wrapped_key: string | null;
  inputs_iv: string | null;
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
    failure: row.failure ? JSON.parse(row.failure) as RpaRun['failure'] : undefined,
  };
}

function toSchedule(row: ScheduleRow): RpaSchedule {
  return {
    workflowId: row.workflow_id,
    profileIds: JSON.parse(row.profile_ids) as Uuid[],
    intervalMinutes: row.interval_minutes,
    enabled: row.enabled === 1,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at ?? undefined,
    lastError: row.last_error ?? undefined,
    updatedAt: row.updated_at,
  };
}

export class RpaRepository {
  constructor(
    private readonly handle: ShadowEdgeDb,
    private readonly crypto?: EnvelopeCrypto,
  ) {}

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

  saveSchedule(schedule: RpaSchedule, inputs?: Record<string, unknown>): void {
    if (inputs !== undefined && !this.crypto) {
      throw new ShadowEdgeError('E_INTERNAL', '定时输入参数需要配置本地加密密钥');
    }
    const sealed = inputs === undefined
      ? undefined
      : this.crypto!.seal(JSON.stringify(inputs), 'rpa-schedule-input');
    this.handle.db.prepare(
      `INSERT INTO rpa_schedules
        (workflow_id, profile_ids, interval_minutes, enabled, next_run_at,
        last_run_at, last_error, updated_at, inputs_ciphertext, inputs_wrapped_key, inputs_iv)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(workflow_id) DO UPDATE SET
        profile_ids=excluded.profile_ids, interval_minutes=excluded.interval_minutes,
        enabled=excluded.enabled, next_run_at=excluded.next_run_at,
        last_run_at=excluded.last_run_at, last_error=excluded.last_error,
        updated_at=excluded.updated_at,
        inputs_ciphertext=COALESCE(excluded.inputs_ciphertext, rpa_schedules.inputs_ciphertext),
        inputs_wrapped_key=COALESCE(excluded.inputs_wrapped_key, rpa_schedules.inputs_wrapped_key),
        inputs_iv=COALESCE(excluded.inputs_iv, rpa_schedules.inputs_iv)`,
    ).run(
      schedule.workflowId,
      JSON.stringify(schedule.profileIds),
      schedule.intervalMinutes,
      schedule.enabled ? 1 : 0,
      schedule.nextRunAt,
      schedule.lastRunAt ?? null,
      schedule.lastError ?? null,
      schedule.updatedAt,
      sealed?.ciphertext ?? null,
      sealed?.wrappedKey ?? null,
      sealed?.iv ?? null,
    );
  }

  getScheduleInputs(workflowId: Uuid): Record<string, unknown> | undefined {
    const row = getRow<Pick<ScheduleRow, 'inputs_ciphertext' | 'inputs_wrapped_key' | 'inputs_iv'>>(
      this.handle.db,
      `SELECT inputs_ciphertext, inputs_wrapped_key, inputs_iv
       FROM rpa_schedules WHERE workflow_id = ?`,
      workflowId,
    );
    if (!row?.inputs_ciphertext || !row.inputs_wrapped_key || !row.inputs_iv) return undefined;
    if (!this.crypto) {
      throw new ShadowEdgeError('E_INTERNAL', '定时输入参数需要配置本地加密密钥');
    }
    return JSON.parse(this.crypto.unseal(
      row.inputs_ciphertext,
      row.inputs_wrapped_key,
      row.inputs_iv,
      'rpa-schedule-input',
    )) as Record<string, unknown>;
  }

  getSchedule(workflowId: Uuid): RpaSchedule | undefined {
    const row = getRow<ScheduleRow>(
      this.handle.db,
      'SELECT * FROM rpa_schedules WHERE workflow_id = ?',
      workflowId,
    );
    return row ? toSchedule(row) : undefined;
  }

  listSchedules(): RpaSchedule[] {
    return allRows<ScheduleRow>(
      this.handle.db,
      'SELECT * FROM rpa_schedules ORDER BY updated_at DESC',
    ).map(toSchedule);
  }

  listDueSchedules(now: string): RpaSchedule[] {
    return allRows<ScheduleRow>(
      this.handle.db,
      'SELECT * FROM rpa_schedules WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at',
      now,
    ).map(toSchedule);
  }

  saveRun(run: RpaRun): void {
    const now = new Date().toISOString();
    this.handle.db.prepare(
      `INSERT INTO rpa_runs
        (id, workflow_id, profile_id, status, started_at, finished_at, error,
         outputs, artifacts, failure, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
        status=excluded.status, started_at=excluded.started_at,
        finished_at=excluded.finished_at, error=excluded.error,
        outputs=excluded.outputs, artifacts=excluded.artifacts, failure=excluded.failure,
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
      run.failure ? JSON.stringify(run.failure) : null,
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
