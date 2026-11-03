import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isShadowEdgeError, ShadowEdgeError } from '@shadowedge/core';
import type { IpcEvents, RpaRun, RpaWorkflow, Uuid } from '@shadowedge/core';
import { linearNodes, validateGraph } from './graph.js';
import { nodeExecutors, throwIfCancelled } from './executors.js';
import type { RpaBrowserContext, RpaNodeExecutor } from './session.js';

export interface RpaEngineDeps {
  resolveContext: (profileId: Uuid) => RpaBrowserContext | Promise<RpaBrowserContext>;
  artifactsDir: string;
  emit?: (progress: IpcEvents['rpa:progress']) => void;
  onRunUpdate?: (run: RpaRun) => void;
  random?: () => number;
}

interface ActiveRun {
  run: RpaRun;
  controller: AbortController;
  completion: Promise<RpaRun>;
}

export class RpaEngine {
  private readonly runs = new Map<Uuid, ActiveRun>();
  private readonly profileOwners = new Map<Uuid, Uuid>();
  private readonly random: () => number;

  constructor(private readonly deps: RpaEngineDeps) {
    this.random = deps.random ?? Math.random;
  }

  async run(workflow: RpaWorkflow, profileIds: Uuid[], inputs?: unknown): Promise<RpaRun[]> {
    const validation = validateGraph(workflow.graph);
    if (!validation.valid) {
      throw new ShadowEdgeError('E_RPA_INVALID_GRAPH', 'RPA 工作流图无效', {
        details: { errors: validation.errors },
      });
    }
    if (inputs !== undefined && !isRecord(inputs)) {
      throw new ShadowEdgeError('E_RPA_INVALID_INPUT', 'RPA inputs 必须是对象');
    }
    const resolvedInputs = inputs ?? {};

    return Array.from(new Set(profileIds)).map((profileId) => {
      const run: RpaRun = {
        id: crypto.randomUUID() as Uuid,
        workflowId: workflow.id,
        profileId,
        status: 'queued',
        artifacts: [],
        outputs: {},
      };
      const controller = new AbortController();
      const active: ActiveRun = {
        run,
        controller,
        completion: Promise.resolve(run),
      };
      this.runs.set(run.id, active);
      this.deps.onRunUpdate?.(run);
      if (this.profileOwners.has(profileId)) {
        run.status = 'failed';
        run.error = `环境 ${profileId} 已有正在执行的 RPA 工作流`;
        run.finishedAt = new Date().toISOString();
        this.deps.onRunUpdate?.(run);
        return run;
      }
      this.profileOwners.set(profileId, run.id);
      active.completion = this.execute(workflow, active, resolvedInputs).finally(() => {
        if (this.profileOwners.get(profileId) === run.id) this.profileOwners.delete(profileId);
      });
      return run;
    });
  }

  async cancel(runId: Uuid): Promise<void> {
    const active = this.runs.get(runId);
    if (!active) throw new ShadowEdgeError('E_RPA_RUN_NOT_FOUND', `RPA 运行 ${runId} 不存在`);
    active.controller.abort();
    if (active.run.status === 'queued') {
      active.run.status = 'cancelled';
      active.run.finishedAt = new Date().toISOString();
    }
    await active.completion;
  }

  getRun(runId: Uuid): RpaRun | undefined {
    return this.runs.get(runId)?.run;
  }

  async wait(runId: Uuid): Promise<RpaRun> {
    const active = this.runs.get(runId);
    if (!active) throw new ShadowEdgeError('E_RPA_RUN_NOT_FOUND', `RPA 运行 ${runId} 不存在`);
    return active.completion;
  }

  private async execute(
    workflow: RpaWorkflow,
    active: ActiveRun,
    inputs: Record<string, unknown>,
  ): Promise<RpaRun> {
    const { run, controller } = active;
    run.status = 'running';
    run.startedAt = new Date().toISOString();
    this.deps.onRunUpdate?.(run);
    const nodes = linearNodes(workflow.graph);
    const runDir = join(this.deps.artifactsDir, run.id);

    try {
      this.progress(run.id, 'started', 0);
      mkdirSync(runDir, { recursive: true, mode: 0o700 });
      const context = await this.deps.resolveContext(run.profileId);
      throwIfCancelled(controller.signal);
      const page = context.pages()[0] ?? (await context.newPage());
      for (let index = 0; index < nodes.length; index += 1) {
        const node = nodes[index]!;
        throwIfCancelled(controller.signal);
        this.progress(run.id, node.id, Math.round((index / nodes.length) * 100));
        await this.executeNode(node, {
          run,
          node,
          page,
          inputs,
          signal: controller.signal,
          percent: Math.round((index / nodes.length) * 100),
          random: this.random,
          outputs: run.outputs!,
          artifactPath: (fileName) => join(runDir, fileName),
        });
        this.progress(run.id, node.id, Math.round(((index + 1) / nodes.length) * 100));
      }
      if (Object.keys(run.outputs!).length > 0) {
        const path = join(runDir, 'outputs.json');
        writeFileSync(path, `${JSON.stringify(run.outputs, null, 2)}\n`, { mode: 0o600 });
        run.artifacts.push({ kind: 'json', uri: path });
      }
      throwIfCancelled(controller.signal);
      run.status = 'succeeded';
      this.progress(run.id, 'succeeded', 100);
    } catch (error) {
      if (
        controller.signal.aborted ||
        (isShadowEdgeError(error) && error.code === 'E_RPA_CANCELLED')
      ) {
        run.status = 'cancelled';
        this.progress(run.id, 'cancelled', 100);
      } else {
        run.status = 'failed';
        run.error = error instanceof Error ? error.message : String(error);
        this.progress(run.id, 'failed', 100);
      }
    } finally {
      run.finishedAt = new Date().toISOString();
      this.deps.onRunUpdate?.(run);
    }
    return run;
  }

  private async executeNode(
    node: Parameters<RpaNodeExecutor>[0]['node'],
    execution: Parameters<RpaNodeExecutor>[0],
  ): Promise<void> {
    const executor = nodeExecutors.get(node.kind);
    if (!executor) {
      throw new ShadowEdgeError(
        'E_RPA_NODE_FAILED',
        `节点 ${node.id}: 类型 ${node.kind} 尚未实现`,
        {
          details: { nodeId: node.id, kind: node.kind },
        },
      );
    }
    const attempts = node.onError === 'retry' ? (node.retries ?? 1) + 1 : 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      throwIfCancelled(execution.signal);
      try {
        await executor(execution);
        return;
      } catch (error) {
        if (
          execution.signal.aborted ||
          (isShadowEdgeError(error) && error.code === 'E_RPA_CANCELLED')
        ) {
          throw error;
        }
        if (attempt < attempts) {
          this.progress(execution.run.id, `${node.id}:retry:${attempt}`, execution.percent);
          continue;
        }
        if (node.onError === 'continue') {
          this.progress(execution.run.id, `${node.id}:continued`, execution.percent);
          return;
        }
        if (isShadowEdgeError(error)) throw error;
        throw new ShadowEdgeError(
          'E_RPA_NODE_FAILED',
          `节点 ${node.id}: ${error instanceof Error ? error.message : String(error)}`,
          { details: { nodeId: node.id, kind: node.kind }, cause: error },
        );
      }
    }
  }

  private progress(runId: Uuid, step: string, percent: number): void {
    this.deps.emit?.({ runId, step, percent });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
