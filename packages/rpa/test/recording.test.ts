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


  it('保留框架、Shadow DOM、高级控件和标签页语义', () => {
    const graph = buildRecordedGraph([
      { kind: 'navigate', url: 'https://example.com/advanced' },
      { kind: 'select', selector: '#choice', value: 'b' },
      { kind: 'check', selector: '#agree', checked: true, frameSelector: '#child' },
      { kind: 'type', selector: '#host >> css=#editor', text: 'shadow' },
      { kind: 'click', selector: '#open' },
      { kind: 'switchTab', index: 1 },
      { kind: 'newTab' },
    ]);
    expect(graph.nodes['recorded-2']).toMatchObject({
      kind: 'select', params: { selector: '#choice', value: 'b', timeout: 10000 },
    });
    expect(graph.nodes['recorded-3']).toMatchObject({
      kind: 'check', params: { selector: '#agree', checked: true, frameSelector: '#child' },
    });
    expect(graph.nodes['recorded-4']).toMatchObject({
      kind: 'type', params: { selector: '#host >> css=#editor', text: 'shadow' },
    });
    expect(graph.nodes['recorded-6']).toMatchObject({
      kind: 'switchTab', params: { index: 1, timeout: 10000 },
    });
    expect(graph.nodes['recorded-7']).toMatchObject({ kind: 'newTab', params: {} });
    expect(validateGraph(graph).valid).toBe(true);
  });

  it('生成多选、嵌套框架和关闭标签页节点', () => {
    const graph = buildRecordedGraph([
      { kind: 'select', selector: '#regions', values: ['US', 'CA'] },
      { kind: 'type', selector: '#name', text: 'nested', frameSelectors: ['#outer', '#inner'] },
      { kind: 'closeTab', index: 1 },
    ]);
    expect(graph.nodes['recorded-1']).toMatchObject({
      kind: 'select', params: { selector: '#regions', values: ['US', 'CA'] },
    });
    expect(graph.nodes['recorded-2']).toMatchObject({
      kind: 'type', params: { selector: '#name', frameSelectors: ['#outer', '#inner'] },
    });
    expect(graph.nodes['recorded-3']).toMatchObject({ kind: 'closeTab', params: { index: 1 } });
    expect(validateGraph(graph).valid).toBe(true);
  });

  it('空录制不会产生伪入口', () => {
    expect(buildRecordedGraph([])).toMatchObject({ entry: '', nodes: {} });
  });
});
