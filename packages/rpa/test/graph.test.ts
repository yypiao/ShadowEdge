import { describe, expect, it } from 'vitest';
import { validateGraph, type RpaGraph } from '../src/index.js';

describe('validateGraph', () => {
  it('合法图应通过', () => {
    const graph: RpaGraph = {
      entry: 'a',
      nodes: {
        a: { id: 'a', kind: 'navigate', params: { url: 'https://example.com' }, next: 'b' },
        b: { id: 'b', kind: 'screenshot', params: {} },
      },
    };
    expect(validateGraph(graph).valid).toBe(true);
  });

  it('入口不存在应报错', () => {
    const result = validateGraph({ entry: 'missing', nodes: {} });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('入口节点');
  });

  it('next 悬空指针应报错', () => {
    const result = validateGraph({
      entry: 'a',
      nodes: { a: { id: 'a', kind: 'click', params: {}, next: 'ghost' } },
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('ghost');
  });
});
