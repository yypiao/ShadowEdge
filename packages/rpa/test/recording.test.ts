import { describe, expect, it } from 'vitest';
import { validateGraph } from '../src/graph.js';
import { buildRecordedGraph } from '../src/recording.js';

describe('RPA 录制图生成', () => {
  it('按操作顺序生成可执行线性图', () => {
    const graph = buildRecordedGraph([
      { kind: 'navigate', url: 'https://example.com' },
      { kind: 'type', selector: '#name', text: 'Ada' },
      { kind: 'click', selector: '#submit' },
    ]);
    expect(graph.entry).toBe('recorded-1');
    expect(graph.nodes['recorded-1']?.next).toBe('recorded-2');
    expect(graph.nodes['recorded-2']?.next).toBe('recorded-3');
    expect(graph.nodes['recorded-3']?.next).toBeUndefined();
    expect(graph.nodes['recorded-2']).toMatchObject({
      kind: 'type', params: { selector: '#name', text: 'Ada', clear: true },
    });
    expect(validateGraph(graph).valid).toBe(true);
  });

  it('空录制不会产生伪入口', () => {
    expect(buildRecordedGraph([])).toMatchObject({ entry: '', nodes: {} });
  });
});
