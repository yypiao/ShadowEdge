import { describe, expect, it } from 'vitest';
import type { ProxyCredential } from '@shadowedge/core';
import { checkProxyHealth } from '../src/health.js';

const cred: ProxyCredential = {
  id: 'px1', orgId: 'local', label: 't', protocol: 'socks5', host: '1.2.3.4', port: 1080, tags: [],
};

describe('代理健康检查', () => {
  it('首选端点成功时返回完整地理与风险画像', async () => {
    const health = await checkProxyHealth(cred, 'pw', {
      fetchJson: async () => ({
        status: 200,
        body: JSON.stringify({
          status: 'success', country: 'China', regionName: 'Liaoning', city: 'Shenyang',
          timezone: 'Asia/Shanghai', as: 'AS4134 CHINANET', proxy: false, hosting: false, query: '42.202.173.92',
        }),
      }),
    });
    expect(health.reachable).toBe(true);
    expect(health.exitIp).toBe('42.202.173.92');
    expect(health.geo?.timezone).toBe('Asia/Shanghai');
    expect(health.risk?.isDatacenter).toBe(false);
  });

  it('首选端点失败时回退备用端点', async () => {
    let calls = 0;
    const health = await checkProxyHealth(cred, undefined, {
      fetchJson: async (_c, _p, ep) => {
        calls += 1;
        if (ep.host === 'ip-api.com') throw new Error('超时');
        return { status: 200, body: JSON.stringify({ origin: '9.9.9.9' }) };
      },
    });
    expect(health.exitIp).toBe('9.9.9.9');
    // 首选端点重试一次（2 次）后回退备用端点（1 次）
    expect(calls).toBe(3);
  });

  it('全部端点失败时抛出 E_PROXY_UNREACHABLE（可重试）', async () => {
    await expect(
      checkProxyHealth(cred, undefined, {
        fetchJson: async () => {
          throw new Error('refused');
        },
      }),
    ).rejects.toMatchObject({ code: 'E_PROXY_UNREACHABLE', retryable: true });
  });
});
