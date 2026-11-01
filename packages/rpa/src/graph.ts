import type { RpaGraph, RpaNode } from '@shadowedge/core';

export function validateGraph(graph: RpaGraph): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!graph.nodes[graph.entry]) errors.push(`入口节点 ${graph.entry} 不存在`);
  for (const [id, node] of Object.entries(graph.nodes)) {
    if (node.id !== id) errors.push(`节点键 ${id} 与节点 id ${node.id} 不一致`);
    if (node.next && !graph.nodes[node.next]) {
      errors.push(`节点 ${id} 的 next 指向不存在的 ${node.next}`);
    }
    if (node.retries !== undefined && (!Number.isInteger(node.retries) || node.retries < 0)) {
      errors.push(`节点 ${id} 的 retries 必须是非负整数`);
    }
  }
  try {
    linearNodes(graph);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  for (const id of Object.keys(graph.nodes)) {
    if (!reachableNodes(graph).has(id)) errors.push(`节点 ${id} 从入口不可达`);
  }
  return { valid: errors.length === 0, errors };
}

/** 当前执行器支持单 next 的线性图；condition/loop 后续再扩展为分支调度。 */
export function linearNodes(graph: RpaGraph): RpaNode[] {
  const ordered: RpaNode[] = [];
  const visited = new Set<string>();
  let id: string | undefined = graph.entry;
  while (id) {
    if (visited.has(id)) throw new Error(`节点图存在循环: ${id}`);
    visited.add(id);
    const node: RpaNode | undefined = graph.nodes[id];
    if (!node) throw new Error(`节点 ${id} 不存在`);
    ordered.push(node);
    id = node.next;
  }
  return ordered;
}

function reachableNodes(graph: RpaGraph): Set<string> {
  const reachable = new Set<string>();
  let id: string | undefined = graph.entry;
  while (id && graph.nodes[id] && !reachable.has(id)) {
    reachable.add(id);
    id = graph.nodes[id]!.next;
  }
  return reachable;
}
