import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RpaRun, RpaWorkflow } from '@shadowedge/core';
import { EnvelopeCrypto } from '@shadowedge/crypto';
import { openDatabase, type ShadowEdgeDb } from '../src/main/services/db.js';
import { RpaRepository } from '../src/main/services/rpa-repository.js';
import { RpaScheduler } from '../src/main/services/rpa-scheduler.js';

const BASE = Date.parse('2026-11-04T00:00:00.000Z');
const workflow: RpaWorkflow = {
  id: 'scheduled-workflow', orgId: 'local', name: '定时检查', version: 1,
  graph: { entry: 'wait', nodes: { wait: { id: 'wait', kind: 'wait', params: { ms: 0 } } } },
  createdBy: 'local-user', updatedAt: new Date(BASE).toISOString(),
};

describe('RPA 持久化定时调度', () => {
  let handle: ShadowEdgeDb;
  let repository: RpaRepository;
  let now: number;
  let runs: string[][];
  let receivedInputs: Record<string, unknown> | undefined;
  let failNext: boolean;
  let scheduler: RpaScheduler;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'shadowedge-rpa-scheduler-'));
    handle = openDatabase(':memory:');
    repository = new RpaRepository(handle, new EnvelopeCrypto('11'.repeat(32)));
    repository.saveWorkflow(workflow);
    now = BASE;
    runs = [];
    receivedInputs = undefined;
    failNext = false;
    scheduler = new RpaScheduler({
      repository,
      now: () => now,
      runAndWait: async (_workflow, profileIds, inputs) => {
        runs.push(profileIds);
        receivedInputs = inputs;
        if (failNext) {
          failNext = false;
          throw new Error('scheduled failure');
        }
        return profileIds.map((profileId, index): RpaRun => ({
          id: `run-${runs.length}-${index}`,
          workflowId: workflow.id,
          profileId,
          status: 'succeeded',
          artifacts: [],
        }));
      },
    });
  });

  afterEach(async () => {
    await scheduler.stop();
    handle.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('到期才运行，使用去重环境并持久化下一周期', async () => {
    const schedule = scheduler.configure({
      workflowId: workflow.id,
      profileIds: ['profile-a', 'profile-a', 'profile-b'],
      intervalMinutes: 1,
      enabled: true,
      inputs: { name: 'Ada' },
    });
    expect(schedule.profileIds).toEqual(['profile-a', 'profile-b']);
    await scheduler.tick();
    expect(runs).toEqual([]);
    now += 61000;
    await scheduler.tick();
    expect(runs).toEqual([['profile-a', 'profile-b']]);
    expect(receivedInputs).toEqual({ name: 'Ada' });
    const stored = handle.db.prepare(
      'SELECT inputs_ciphertext FROM rpa_schedules WHERE workflow_id = ?',
    ).get(workflow.id) as { inputs_ciphertext: string };
    expect(stored.inputs_ciphertext).not.toContain('Ada');
    expect(JSON.stringify(repository.listSchedules())).not.toContain('Ada');
    expect(repository.getSchedule(workflow.id)).toMatchObject({
      lastRunAt: new Date(now).toISOString(),
      nextRunAt: new Date(now + 60000).toISOString(),
      lastError: undefined,
    });
  });

  it('长时间停机只补跑一次，失败后下一周期仍可运行', async () => {
    scheduler.configure({
      workflowId: workflow.id, profileIds: ['profile-a'], intervalMinutes: 1, enabled: true,
    });
    now += 10 * 60000;
    failNext = true;
    await scheduler.tick();
    expect(runs).toHaveLength(1);
    expect(repository.getSchedule(workflow.id)?.lastError).toBe('scheduled failure');
    await scheduler.tick();
    expect(runs).toHaveLength(1);
    now += 61000;
    await scheduler.tick();
    expect(runs).toHaveLength(2);
    expect(repository.getSchedule(workflow.id)?.lastError).toBeUndefined();
  });

  it('停用后不运行，非法配置不会写入', async () => {
    scheduler.configure({
      workflowId: workflow.id, profileIds: [], intervalMinutes: 5, enabled: false,
    });
    now += 60 * 60000;
    await scheduler.tick();
    expect(runs).toEqual([]);
    expect(() => scheduler.configure({
      workflowId: workflow.id, profileIds: [], intervalMinutes: 1, enabled: true,
    })).toThrow('至少需要一个环境');
    expect(() => scheduler.configure({
      workflowId: workflow.id, profileIds: ['profile-a'], intervalMinutes: 0, enabled: true,
    })).toThrow('1..10080');
  });
});
