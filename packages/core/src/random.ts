import { createHash } from 'node:crypto';

/**
 * 基于种子的确定性随机源。
 * 指纹生成必须完全可复现：同一 seed 在任何机器、任何版本都得到同一画像。
 */
export class SeededRandom {
  private state: number;

  constructor(seed: string) {
    const digest = createHash('sha256').update(seed).digest();
    this.state = digest.readUInt32BE(0) || 0x9e3779b9;
  }

  /** xorshift32：轻量、无依赖、跨平台位运算结果一致。 */
  next(): number {
    let x = this.state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x >>> 0;
    return this.state / 0xffffffff;
  }

  int(minInclusive: number, maxInclusive: number): number {
    return minInclusive + Math.floor(this.next() * (maxInclusive - minInclusive + 1));
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('SeededRandom.pick: 空集合');
    return items[this.int(0, items.length - 1)]!;
  }

  /** 在集合中取若干不重复元素，顺序稳定。 */
  sample<T>(items: readonly T[], count: number): T[] {
    const pool = [...items];
    const out: T[] = [];
    const n = Math.min(count, pool.length);
    for (let i = 0; i < n; i += 1) {
      out.push(pool.splice(this.int(0, pool.length - 1), 1)[0]!);
    }
    return out;
  }

  bool(trueProbability = 0.5): boolean {
    return this.next() < trueProbability;
  }
}
