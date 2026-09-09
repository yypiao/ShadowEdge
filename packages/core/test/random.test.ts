import { describe, expect, it } from 'vitest';
import { SeededRandom } from '../src/random.js';

describe('SeededRandom', () => {
  it('同 seed 序列一致', () => {
    const a = new SeededRandom('s');
    const b = new SeededRandom('s');
    const seqA = Array.from({ length: 20 }, () => a.next());
    const seqB = Array.from({ length: 20 }, () => b.next());
    expect(seqA).toEqual(seqB);
  });

  it('输出落在 [0, 1]', () => {
    const rng = new SeededRandom('range');
    for (let i = 0; i < 500; i += 1) {
      const v = rng.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('int 落在闭区间内', () => {
    const rng = new SeededRandom('int');
    for (let i = 0; i < 300; i += 1) {
      const v = rng.int(3, 7);
      expect(v).toBeGreaterThanOrEqual(3);
      expect(v).toBeLessThanOrEqual(7);
    }
  });

  it('sample 不重复且长度受限', () => {
    const rng = new SeededRandom('sample');
    const out = rng.sample(['a', 'b', 'c'], 10);
    expect(out).toHaveLength(3);
    expect(new Set(out).size).toBe(3);
  });
});
