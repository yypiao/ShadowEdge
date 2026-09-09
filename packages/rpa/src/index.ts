import type { RpaRun, RpaWorkflow, Uuid } from '@shadowedge/core';

/** RPA 节点类型枚举。 */
export type RpaNodeKind =
  | 'navigate' | 'click' | 'type' | 'wait' | 'extract'
  | 'screenshot' | 'condition' | 'loop' | 'script' | 'http';

export interface RpaNode {
  id: string;
  kind: RpaNodeKind;
  params: Record<string, unknown>;
  next?: string;
  onError?: 'stop' | 'continue' | 'retry';
  retries?: number;
}

export interface RpaGraph {
  entry: string;
  nodes: Record<string, RpaNode>;
}

/** 工作流执行引擎。 */
export class RpaEngine {
  private runs = new Map<Uuid, RpaRun>();

  async run(workflow: RpaWorkflow, profileIds: Uuid[], inputs?: unknown): Promise<RpaRun[]> {
    return profileIds.map((profileId) => {
      const run: RpaRun = {
        id: crypto.randomUUID() as Uuid,
        workflowId: workflow.id,
        profileId,
        status: 'queued',
        artifacts: [],
      };
      this.runs.set(run.id, run);
      return run;
    });
  }

  async cancel(runId: Uuid): Promise<void> {
    const run = this.runs.get(runId);
    if (run) run.status = 'cancelled';
  }

  getRun(runId: Uuid): RpaRun | undefined {
    return this.runs.get(runId);
  }
}

/** 校验图结构完整性。 */
export function validateGraph(graph: RpaGraph): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!graph.nodes[graph.entry]) errors.push(`入口节点 ${graph.entry} 不存在`);
  for (const [id, node] of Object.entries(graph.nodes)) {
    if (node.next && !graph.nodes[node.next]) {
      errors.push(`节点 ${id} 的 next 指向不存在的 ${node.next}`);
    }
  }
  return { valid: errors.length === 0, errors };
}
