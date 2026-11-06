import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isShadowEdgeError, ShadowEdgeError } from '@shadowedge/core';
import type { IpcEvents, RpaRun, RpaWorkflow, Uuid } from '@shadowedge/core';
import { validateGraph } from './graph.js';
import { loopCount, nextForCondition } from './control.js';
import { withHardCancellation } from './cancellation.js';
import { nodeExecutors, throwIfCancelled } from './executors.js';
import type { RpaBrowserContext, RpaNodeExecution, RpaNodeExecutor } from './session.js';

function diagnosticPageUrl(rawUrl: string): string | undefined {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    // query/hash 可能包含会话令牌；排障只需要 origin 和路径。
    return `${url.origin}${url.pathname}`;
  } catch {
    return undefined;
  }
}

export interface RpaEngineDeps {
  resolveContext: (profileId: Uuid) => RpaBrowserContext | Promise<RpaBrowserContext>;
  artifactsDir: string;
  emit?: (progress: IpcEvents['rpa:progress']) => void;
  onRunUpdate?: (run: RpaRun) => void;
  random?: () => number;
  /** 返回原因时仅让当前环境失败，不影响同批其他环境。 */
  profileUnavailable?: (profileId: Uuid) => string | undefined;
}

interface ActiveRun {
  run: RpaRun;
  controller: AbortController;
  completion: Promise<RpaRun>;
  timedOut?: boolean;
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
      const unavailable = this.deps.profileUnavailable?.(profileId);
      if (unavailable || this.profileOwners.has(profileId)) {
        run.status = 'failed';
        run.error = unavailable ?? `环境 ${profileId} 已有正在执行的 RPA 工作流`;
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

  isProfileActive(profileId: Uuid): boolean {
    return this.profileOwners.has(profileId);
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
    const runDir = join(this.deps.artifactsDir, run.id);
    const timeoutMs = workflow.graph.timeoutMs ?? 300000;
    const maxSteps = workflow.graph.maxSteps ?? 10000;
    const deadlineAt = Date.now() + timeoutMs;
    const timeout = setTimeout(() => {
      active.timedOut = true;
      controller.abort();
    }, timeoutMs);
    timeout.unref();
    let currentExecution: RpaNodeExecution | undefined;

    try {
      this.progress(run.id, 'started', 0);
      mkdirSync(runDir, { recursive: true, mode: 0o700 });
      const context = await this.deps.resolveContext(run.profileId);
      throwIfCancelled(controller.signal);
      let page = context.pages()[0] ?? (await context.newPage());
      const loopStates = new Map<string, { count: number; index: number }>();
      const loopIndices: Record<string, number> = {};
      const visited = new Set<string>();
      let id: string | undefined = workflow.graph.entry;
      let steps = 0;
      while (id) {
        throwIfCancelled(controller.signal);
        steps += 1;
        if (steps > maxSteps) {
          throw new ShadowEdgeError('E_RPA_STEP_LIMIT', `RPA 运行超过最大步数 ${maxSteps}`);
        }
        const node = workflow.graph.nodes[id];
        if (!node) throw new ShadowEdgeError('E_RPA_INVALID_GRAPH', `节点 ${id} 不存在`);
        visited.add(id);
        const percent = Math.min(99, Math.round((visited.size / Object.keys(workflow.graph.nodes).length) * 100));
        this.progress(run.id, node.id, percent);
        const execution: RpaNodeExecution = {
          run,
          node,
          page,
          inputs,
          signal: controller.signal,
          deadlineAt,
          closePage: () => execution.page.close(),
          createPage: () => context.newPage(),
          listPages: () => context.pages(),
          percent,
          random: this.random,
          outputs: run.outputs!,
          loopIndices,
          artifactPath: (fileName) => join(runDir, fileName),
        };
        currentExecution = execution;
        if (node.kind !== 'condition' && node.kind !== 'loop') await this.executeNode(node, execution);
        page = execution.page;
        if (node.kind === 'condition') {
          id = nextForCondition(node, execution);
        } else if (node.kind === 'loop') {
          let state = loopStates.get(node.id);
          if (!state) {
            state = { count: loopCount(node, execution), index: 0 };
            loopStates.set(node.id, state);
          } else {
            state.index += 1;
          }
          if (state.index < state.count) {
            loopIndices[node.id] = state.index;
            id = String(node.params.body);
          } else {
            loopStates.delete(node.id);
            delete loopIndices[node.id];
            id = node.next;
          }
        } else {
          id = node.next;
        }
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
      if (active.timedOut) {
        run.status = 'failed';
        run.error = `RPA 运行超过总超时 ${timeoutMs}ms`;
        this.progress(run.id, 'failed', 100);
      } else if (
        controller.signal.aborted ||
        (isShadowEdgeError(error) && error.code === 'E_RPA_CANCELLED')
      ) {
        run.status = 'cancelled';
        this.progress(run.id, 'cancelled', 100);
      } else {
        if (currentExecution && !run.failure) await this.captureFailure(currentExecution, error, 1);
        run.status = 'failed';
        run.error = error instanceof Error ? error.message : String(error);
        this.progress(run.id, 'failed', 100);
      }
    } finally {
      clearTimeout(timeout);
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
        await withHardCancellation(execution, () => executor(execution));
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
        await this.captureFailure(execution, error, attempt);
        if (isShadowEdgeError(error)) throw error;
        throw new ShadowEdgeError(
          'E_RPA_NODE_FAILED',
          `节点 ${node.id}: ${error instanceof Error ? error.message : String(error)}`,
          { details: { nodeId: node.id, kind: node.kind }, cause: error },
        );
      }
    }
  }

  private async captureFailure(
    execution: RpaNodeExecution,
    error: unknown,
    attempt: number,
  ): Promise<void> {
    if (execution.run.failure) return;
    const diagnostic: NonNullable<RpaRun['failure']> = {
      nodeId: execution.node.id,
      nodeKind: execution.node.kind,
      errorCode: isShadowEdgeError(error) ? error.code : 'E_RPA_NODE_FAILED',
      attempt,
    };
    try {
      const pageUrl = diagnosticPageUrl(execution.page.url());
      if (pageUrl) diagnostic.pageUrl = pageUrl;
    } catch {
      // 页面已经关闭时仍保留节点诊断。
    }
    try {
      const screenshotUri = execution.artifactPath('failure.png');
      await execution.page.screenshot({ path: screenshotUri, fullPage: true, type: 'png' });
      chmodSync(screenshotUri, 0o600);
      diagnostic.screenshotUri = screenshotUri;
      execution.run.artifacts.push({ kind: 'screenshot', uri: screenshotUri });
    } catch {
      // 诊断失败不能覆盖原始节点错误。
    }
    execution.run.failure = diagnostic;
    try {
      const path = execution.artifactPath('failure.json');
      writeFileSync(path, `${JSON.stringify(diagnostic, null, 2)}\n`, { mode: 0o600 });
      execution.run.artifacts.push({ kind: 'json', uri: path });
    } catch {
      // 磁盘诊断失败仍保留内存中的结构化结果。
    }
  }

  private progress(runId: Uuid, step: string, percent: number): void {
    this.deps.emit?.({ runId, step, percent });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
