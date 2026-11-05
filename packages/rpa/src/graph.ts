import type { RpaGraph, RpaNode } from '@shadowedge/core';

export function validateGraph(graph: RpaGraph): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!graph.nodes[graph.entry]) errors.push(`入口节点 ${graph.entry} 不存在`);
  if (graph.maxSteps !== undefined && (!Number.isInteger(graph.maxSteps) || graph.maxSteps < 1 || graph.maxSteps > 100000)) {
    errors.push('maxSteps 必须是 1..100000 的整数');
  }
  if (graph.timeoutMs !== undefined && (!Number.isInteger(graph.timeoutMs) || graph.timeoutMs < 1 || graph.timeoutMs > 3600000)) {
    errors.push('timeoutMs 必须是 1..3600000 的整数');
  }
  for (const [id, node] of Object.entries(graph.nodes)) {
    if (node.id !== id) errors.push(`节点键 ${id} 与节点 id ${node.id} 不一致`);
    for (const target of references(node)) {
      if (!graph.nodes[target]) errors.push(`节点 ${id} 指向不存在的 ${target}`);
    }
    if (node.retries !== undefined && (!Number.isInteger(node.retries) || node.retries < 0 || node.retries > 20)) {
      errors.push(`节点 ${id} 的 retries 必须是 0..20 的整数`);
    }
    if (node.kind === 'loop') {
      const body = node.params.body;
      const count = node.params.count;
      if (typeof body !== 'string' || !body) errors.push(`循环节点 ${id} 缺少 body`);
      if (!(typeof count === 'number' && Number.isInteger(count) && count >= 0 && count <= 1000) &&
        !(typeof count === 'string' && count.length > 0)) {
        errors.push(`循环节点 ${id} 的 count 必须是 0..1000 的整数或变量表达式`);
      }
      if (typeof body === 'string' && graph.nodes[body] && !canReach(graph, body, id)) {
        errors.push(`循环节点 ${id} 的 body 必须能回到该循环节点`);
      }
    }
    if (node.kind === 'condition') {
      const operators = ['equals', 'notEquals', 'contains', 'notContains', 'exists', 'notExists', 'greaterThan', 'lessThan'];
      if (typeof node.params.left !== 'string' || !operators.includes(String(node.params.operator ?? 'equals'))) {
        errors.push(`条件节点 ${id} 的 left 或 operator 无效`);
      }
    }
  }
  const reachable = reachableNodes(graph);
  for (const id of Object.keys(graph.nodes)) {
    if (!reachable.has(id)) errors.push(`节点 ${id} 从入口不可达`);
  }
  for (const cycle of cyclesWithoutLoop(graph)) errors.push(`节点图存在无循环节点的回边: ${cycle.join(' -> ')}`);
  return { valid: errors.length === 0, errors };
}

export function references(node: RpaNode): string[] {
  return [
    node.next,
    node.elseNext,
    node.kind === 'loop' && typeof node.params.body === 'string' ? node.params.body : undefined,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
}

/** 兼容旧调用方：只展开无分支、无循环的线性图。 */
export function linearNodes(graph: RpaGraph): RpaNode[] {
  const ordered: RpaNode[] = [];
  const visited = new Set<string>();
  let id: string | undefined = graph.entry;
  while (id) {
    if (visited.has(id)) throw new Error(`节点图存在循环: ${id}`);
    visited.add(id);
    const node: RpaNode | undefined = graph.nodes[id];
    if (!node) throw new Error(`节点 ${id} 不存在`);
    if (node.kind === 'condition' || node.kind === 'loop') throw new Error('分支或循环图不能按线性节点展开');
    ordered.push(node);
    id = node.next;
  }
  return ordered;
}

function reachableNodes(graph: RpaGraph): Set<string> {
  const reachable = new Set<string>();
  const pending = [graph.entry];
  while (pending.length > 0) {
    const id = pending.pop()!;
    if (reachable.has(id) || !graph.nodes[id]) continue;
    reachable.add(id);
    pending.push(...references(graph.nodes[id]!));
  }
  return reachable;
}

function canReach(graph: RpaGraph, start: string, target: string): boolean {
  const visited = new Set<string>();
  const pending = [start];
  while (pending.length > 0) {
    const id = pending.pop()!;
    if (id === target) return true;
    if (visited.has(id)) continue;
    visited.add(id);
    const node = graph.nodes[id];
    if (node) pending.push(...references(node));
  }
  return false;
}

function cyclesWithoutLoop(graph: RpaGraph): string[][] {
  const cycles: string[][] = [];
  const completed = new Set<string>();
  const stack: string[] = [];
  const visiting = new Set<string>();
  const visit = (id: string): void => {
    if (completed.has(id)) return;
    if (visiting.has(id)) {
      const start = stack.indexOf(id);
      const cycle = [...stack.slice(start), id];
      if (!cycle.slice(0, -1).some((nodeId) => graph.nodes[nodeId]?.kind === 'loop')) cycles.push(cycle);
      return;
    }
    const node = graph.nodes[id];
    if (!node) return;
    visiting.add(id);
    stack.push(id);
    for (const target of references(node)) visit(target);
    stack.pop();
    visiting.delete(id);
    completed.add(id);
  };
  visit(graph.entry);
  return cycles;
}
