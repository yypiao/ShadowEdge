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

  it('线性图存在循环应报错', () => {
    const result = validateGraph({
      entry: 'a',
      nodes: {
        a: { id: 'a', kind: 'wait', params: {}, next: 'b' },
        b: { id: 'b', kind: 'wait', params: {}, next: 'a' },
      },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toContain('循环');
  });

  it('入口不可达节点应报错', () => {
    const result = validateGraph({
      entry: 'a',
      nodes: {
        a: { id: 'a', kind: 'wait', params: {} },
        orphan: { id: 'orphan', kind: 'wait', params: {} },
      },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toContain('不可达');
  });
});

describe('条件与循环图校验', () => {
  it('条件双分支和有限循环回边合法', () => {
    const graph: RpaGraph = {
      entry: 'condition',
      maxSteps: 100,
      timeoutMs: 1000,
      nodes: {
        condition: {
          id: 'condition', kind: 'condition',
          params: { left: '{{outputs.result}}', operator: 'equals', right: 'yes' },
          next: 'loop', elseNext: 'fallback',
        },
        loop: { id: 'loop', kind: 'loop', params: { count: 3, body: 'body' }, next: 'fallback' },
        body: { id: 'body', kind: 'wait', params: { ms: 0 }, next: 'loop' },
        fallback: { id: 'fallback', kind: 'wait', params: { ms: 0 } },
      },
    };
    expect(validateGraph(graph)).toEqual({ valid: true, errors: [] });
  });

  it('循环体不能回到循环节点时拒绝', () => {
    const result = validateGraph({
      entry: 'loop',
      nodes: {
        loop: { id: 'loop', kind: 'loop', params: { count: 2, body: 'body' } },
        body: { id: 'body', kind: 'wait', params: {} },
      },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toContain('必须能回到');
  });

  it('循环次数、总步数和超时都有边界', () => {
    const result = validateGraph({
      entry: 'loop', maxSteps: 0, timeoutMs: 3600001,
      nodes: { loop: { id: 'loop', kind: 'loop', params: { count: 1001, body: 'loop' } } },
    });
    expect(result.errors.join('\n')).toContain('maxSteps');
    expect(result.errors.join('\n')).toContain('timeoutMs');
    expect(result.errors.join('\n')).toContain('count');
  });
});
