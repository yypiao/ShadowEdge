import type { ProxyHealth, Uuid } from '@shadowedge/core';

interface CacheEntry {
  health: ProxyHealth;
  cachedAt: number;
  expiresAt: number;
}

/** 按代理隔离 TTL 与在途请求；失败不会复活过期缓存，也不会污染其他代理。 */
export class ProxyHealthCache {
  private readonly entries = new Map<Uuid, CacheEntry>();
  private readonly pending = new Map<Uuid, Promise<ProxyHealth>>();

  constructor(
    private readonly ttlMs = 5 * 60 * 1000,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error('健康缓存 TTL 必须为正数');
  }

  invalidate(proxyId: Uuid): void {
    this.entries.delete(proxyId);
  }

  async get(
    proxyId: Uuid,
    loader: () => Promise<ProxyHealth>,
    forceRefresh = false,
  ): Promise<ProxyHealth> {
    const at = this.now();
    const cached = this.entries.get(proxyId);
    if (!forceRefresh && cached && at < cached.expiresAt) {
      return this.decorate(cached, true);
    }
    const existing = this.pending.get(proxyId);
    if (existing) return existing;
    const request = (async () => {
      const health = await loader();
      const cachedAt = this.now();
      const entry = {
        health: { ...health, cache: undefined },
        cachedAt,
        expiresAt: cachedAt + this.ttlMs,
      };
      this.entries.set(proxyId, entry);
      return this.decorate(entry, false);
    })();
    this.pending.set(proxyId, request);
    try {
      return await request;
    } finally {
      if (this.pending.get(proxyId) === request) this.pending.delete(proxyId);
    }
  }

  private decorate(entry: CacheEntry, hit: boolean): ProxyHealth {
    return {
      ...entry.health,
      cache: {
        hit,
        cachedAt: new Date(entry.cachedAt).toISOString(),
        expiresAt: new Date(entry.expiresAt).toISOString(),
      },
    };
  }
}
