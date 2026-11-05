import { ShadowEdgeError } from '@shadowedge/core';
import type { RpaRun, RpaSchedule, RpaScheduleInput, RpaWorkflow } from '@shadowedge/core';
import type { RpaRepository } from './rpa-repository.js';

export interface RpaSchedulerDeps {
  repository: RpaRepository;
  runAndWait: (
    workflow: RpaWorkflow,
    profileIds: RpaSchedule['profileIds'],
    inputs?: Record<string, unknown>,
  ) => Promise<RpaRun[]>;
  onRun?: (schedule: RpaSchedule, runs: RpaRun[]) => void;
  now?: () => number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class RpaScheduler {
  private readonly now: () => number;
  private timer?: NodeJS.Timeout;
  private ticking?: Promise<void>;

  constructor(private readonly deps: RpaSchedulerDeps) {
    this.now = deps.now ?? Date.now;
  }

  configure(input: RpaScheduleInput): RpaSchedule {
    if (!Number.isInteger(input.intervalMinutes) || input.intervalMinutes < 1 ||
      input.intervalMinutes > 10080) {
      throw new ShadowEdgeError('E_RPA_INVALID_INPUT', '定时间隔必须是 1..10080 分钟的整数');
    }
    const profileIds = [...new Set(input.profileIds)];
    if (input.enabled && profileIds.length === 0) {
      throw new ShadowEdgeError('E_RPA_INVALID_INPUT', '启用定时任务至少需要一个环境');
    }
    const now = this.now();
    const previous = this.deps.repository.getSchedule(input.workflowId);
    const schedule: RpaSchedule = {
      workflowId: input.workflowId,
      profileIds,
      intervalMinutes: input.intervalMinutes,
      enabled: input.enabled,
      nextRunAt: new Date(now + input.intervalMinutes * 60000).toISOString(),
      lastRunAt: previous?.lastRunAt,
      lastError: previous?.lastError,
      updatedAt: new Date(now).toISOString(),
    };
    this.deps.repository.saveSchedule(schedule, input.inputs);
    return schedule;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, 5000);
    this.timer.unref();
    void this.tick();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.ticking;
  }

  tick(): Promise<void> {
    if (this.ticking) return this.ticking;
    const pending = this.runDue();
    this.ticking = pending;
    return pending.finally(() => {
      if (this.ticking === pending) this.ticking = undefined;
    });
  }

  private async runDue(): Promise<void> {
    const due = this.deps.repository.listDueSchedules(new Date(this.now()).toISOString());
    for (const scheduled of due) {
      const current = this.deps.repository.getSchedule(scheduled.workflowId);
      // 用户可能在 tick 排队期间修改或停用任务，不执行过期快照。
      if (!current?.enabled || current.nextRunAt !== scheduled.nextRunAt) continue;
      const startedAt = new Date(this.now()).toISOString();
      const nextRunAt = new Date(this.now() + current.intervalMinutes * 60000).toISOString();
      this.deps.repository.saveSchedule({
        ...current,
        nextRunAt,
        lastRunAt: startedAt,
        lastError: undefined,
        updatedAt: startedAt,
      });
      let lastError: string | undefined;
      try {
        const workflow = this.deps.repository.getWorkflow(current.workflowId);
        if (!workflow) {
          throw new ShadowEdgeError('E_RPA_WORKFLOW_NOT_FOUND', '定时工作流已不存在');
        }
        const runs = await this.deps.runAndWait(
          workflow,
          current.profileIds,
          this.deps.repository.getScheduleInputs(current.workflowId),
        );
        const failures = runs.filter((run) => run.status !== 'succeeded');
        if (failures.length > 0) {
          lastError = `${failures.length}/${runs.length} 个环境未成功：${failures[0]?.error ?? failures[0]?.status ?? '未知错误'}`;
        }
        this.deps.onRun?.(current, runs);
      } catch (error) {
        lastError = errorMessage(error);
      }
      const latest = this.deps.repository.getSchedule(current.workflowId);
      if (latest) {
        this.deps.repository.saveSchedule({
          ...latest,
          lastRunAt: startedAt,
          lastError,
          updatedAt: new Date(this.now()).toISOString(),
        });
      }
    }
  }
}
