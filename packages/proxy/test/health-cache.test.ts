import { describe, expect, it } from 'vitest';
import type { ProxyHealth } from '@shadowedge/core';
import { ProxyHealthCache } from '../src/health-cache.js';

function health(proxyId: string, exitIp = '1.1.1.1'): ProxyHealth {
  return { proxyId, checkedAt: new Date().toISOString(), reachable: true, exitIp };
}

describe('代理健康缓存', () => {
  it('同一代理并发去重，TTL 内命中且不同代理互不共享', async () => {
    let now = 1000;
    const cache = new ProxyHealthCache(100, () => now);
    let firstCalls = 0;
    let secondCalls = 0;
    const firstLoader = async () => {
      firstCalls += 1;
      await Promise.resolve();
      return health('first');
    };
    const [a, b] = await Promise.all([
      cache.get('first', firstLoader),
      cache.get('first', firstLoader),
    ]);
    expect(firstCalls).toBe(1);
    expect(a.cache?.hit).toBe(false);
    expect(b.cache?.hit).toBe(false);
    expect((await cache.get('first', firstLoader)).cache?.hit).toBe(true);
    expect(firstCalls).toBe(1);
    await cache.get('second', async () => {
      secondCalls += 1;
      return health('second', '2.2.2.2');
    });
    expect(secondCalls).toBe(1);
    now += 101;
    expect((await cache.get('first', firstLoader)).cache?.hit).toBe(false);
    expect(firstCalls).toBe(2);
  });

  it('强制刷新、主动失效和失败后的重试均不会返回过期数据', async () => {
    let now = 0;
    const cache = new ProxyHealthCache(10, () => now);
    let calls = 0;
    const loader = async () => health('first', `1.1.1.${++calls}`);
    await cache.get('first', loader);
    expect((await cache.get('first', loader, true)).exitIp).toBe('1.1.1.2');
    cache.invalidate('first');
    expect((await cache.get('first', loader)).exitIp).toBe('1.1.1.3');
    now = 100;
    await expect(cache.get('first', async () => { throw new Error('offline'); }))
      .rejects.toThrow('offline');
    expect((await cache.get('first', loader)).exitIp).toBe('1.1.1.4');
    expect(calls).toBe(4);
  });
});
