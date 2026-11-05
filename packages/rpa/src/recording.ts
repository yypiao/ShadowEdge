import type { RpaGraph, RpaNode, RpaRecordedAction } from '@shadowedge/core';

/** 将录制事件固化为线性图；节点 ID 不依赖时间或随机数，便于测试与审阅差异。 */
export function buildRecordedGraph(actions: RpaRecordedAction[]): RpaGraph {
  const nodes = actions.map((action, index): RpaNode => {
    const id = `recorded-${index + 1}`;
    const base = { id, next: index + 1 < actions.length ? `recorded-${index + 2}` : undefined };
    switch (action.kind) {
      case 'navigate':
        return { ...base, kind: 'navigate', params: { url: action.url, waitUntil: 'domcontentloaded' } };
      case 'click':
        return { ...base, kind: 'click', params: { selector: action.selector, timeout: 10000 } };
      case 'type':
        return {
          ...base,
          kind: 'type',
          params: { selector: action.selector, text: action.text, clear: true, timeout: 10000 },
        };
    }
  });
  return {
    entry: nodes[0]?.id ?? '',
    nodes: Object.fromEntries(nodes.map((node) => [node.id, node])),
    maxSteps: Math.max(100, actions.length + 10),
    timeoutMs: 300000,
  };
}
