import type { RpaGraph, RpaNode, RpaRecordedAction, RpaRecordedTarget } from '@shadowedge/core';

function targetParams(target: RpaRecordedTarget): Record<string, unknown> {
  return {
    selector: target.selector,
    frameSelector: target.frameSelector,
    frameSelectors: target.frameSelectors ? [...target.frameSelectors] : undefined,
    timeout: 10000,
  };
}

/** 将录制事件固化为线性图；节点 ID 不依赖时间或随机数，便于测试与审阅差异。 */
export function buildRecordedGraph(actions: RpaRecordedAction[]): RpaGraph {
  const nodes = actions.map((action, index): RpaNode => {
    const id = `recorded-${index + 1}`;
    const base = { id, next: index + 1 < actions.length ? `recorded-${index + 2}` : undefined };
    switch (action.kind) {
      case 'navigate':
        return { ...base, kind: 'navigate', params: { url: action.url, waitUntil: 'domcontentloaded' } };
      case 'click':
        return { ...base, kind: 'click', params: targetParams(action) };
      case 'type':
        return {
          ...base,
          kind: 'type',
          params: { ...targetParams(action), text: action.text, clear: true },
        };
      case 'select':
        return {
          ...base,
          kind: 'select',
          params: 'values' in action
            ? { ...targetParams(action), values: [...action.values] }
            : { ...targetParams(action), value: action.value },
        };
      case 'check':
        return { ...base, kind: 'check', params: { ...targetParams(action), checked: action.checked } };
      case 'newTab':
        return { ...base, kind: 'newTab', params: {} };
      case 'switchTab':
        // 用户点击弹窗链接后，新页面的创建可能晚于本节点，允许有界等待。
        return { ...base, kind: 'switchTab', params: { index: action.index, timeout: 10000 } };
      case 'closeTab':
        return { ...base, kind: 'closeTab', params: { index: action.index } };
    }
  });
  return {
    entry: nodes[0]?.id ?? '',
    nodes: Object.fromEntries(nodes.map((node) => [node.id, node])),
    maxSteps: Math.max(100, actions.length + 10),
    timeoutMs: 300000,
  };
}
