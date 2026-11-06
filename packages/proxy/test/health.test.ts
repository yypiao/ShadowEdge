import { describe, expect, it } from 'vitest';
import type { ProxyCredential, ProxyHealth } from '@shadowedge/core';
import { checkProxyHealth, type HealthCheckOptions } from '../src/health.js';

const cred: ProxyCredential = {
  id: 'px1',
  orgId: 'local',
  label: 't',
  protocol: 'socks5',
  host: '1.2.3.4',
  port: 1080,
  tags: [],
};
const clearSources: NonNullable<ProxyHealth['risk']>['sources'] = [
  { id: 'spamhaus-zen', status: 'clear' },
  { id: 'spamcop', status: 'clear' },
];
const riskInspector: HealthCheckOptions['riskInspector'] = async () => clearSources;

describe('代理健康检查', () => {
  it('首选端点成功时返回完整地理、风险画像和真实名单状态', async () => {
    const health = await checkProxyHealth(cred, 'pw', {
      riskInspector,
      fetchJson: async () => ({
        status: 200,
        body: JSON.stringify({
          status: 'success',
          country: 'China',
          regionName: 'Liaoning',
          city: 'Shenyang',
          timezone: 'Asia/Shanghai',
          as: 'AS4134 CHINANET',
          proxy: false,
          hosting: false,
          query: '42.202.173.92',
        }),
      }),
    });
    expect(health.reachable).toBe(true);
    expect(health.exitIp).toBe('42.202.173.92');
    expect(health.geo?.timezone).toBe('Asia/Shanghai');
    expect(health.risk).toMatchObject({
      status: 'clear',
      score: 0.05,
      isDatacenter: false,
      isProxy: false,
      blacklistStatus: 'clear',
    });
    expect(health.risk).not.toHaveProperty('blacklisted');
  });

  it('首选端点失败时回退备用端点，缺少分类数据不会冒充低风险', async () => {
    let calls = 0;
    const health = await checkProxyHealth(cred, undefined, {
      riskInspector,
      fetchJson: async (_c, _p, ep) => {
        calls += 1;
        if (ep.host === 'ip-api.com') throw new Error('超时');
        return { status: 200, body: JSON.stringify({ origin: '9.9.9.9' }) };
      },
    });
    expect(health.exitIp).toBe('9.9.9.9');
    expect(calls).toBe(3);
    expect(health.risk).toMatchObject({ status: 'unknown', blacklistStatus: 'clear' });
    expect(health.risk?.score).toBeUndefined();
    expect(health.risk?.isDatacenter).toBeUndefined();
  });

  it('任一 DNSBL 命中即为高风险，不能被地理分类稀释', async () => {
    const health = await checkProxyHealth(cred, undefined, {
      riskInspector: async () => [
        { id: 'spamhaus-zen', status: 'clear' },
        { id: 'spamcop', status: 'listed' },
      ],
      fetchJson: async () => ({
        status: 200,
        body: JSON.stringify({
          status: 'success',
          query: '9.9.9.9',
          proxy: false,
          hosting: false,
        }),
      }),
    });
    expect(health.risk).toMatchObject({ status: 'high', score: 0.95, blacklistStatus: 'listed' });
  });

  it('部分风险来源失败时保留可达性并显式标记 unknown', async () => {
    const health = await checkProxyHealth(cred, undefined, {
      riskInspector: async () => {
        throw new Error('DNS unavailable');
      },
      fetchJson: async () => ({
        status: 200,
        body: JSON.stringify({
          status: 'success',
          query: '9.9.9.9',
          proxy: false,
          hosting: false,
        }),
      }),
    });
    expect(health.reachable).toBe(true);
    expect(health.risk?.status).toBe('unknown');
    expect(health.risk?.blacklistStatus).toBe('unknown');
    expect(health.risk?.score).toBeUndefined();
    expect(health.risk?.sources).toHaveLength(2);
  });

  it('全部端点失败时抛出 E_PROXY_UNREACHABLE（可重试）', async () => {
    await expect(
      checkProxyHealth(cred, undefined, {
        riskInspector,
        fetchJson: async () => {
          throw new Error('refused');
        },
      }),
    ).rejects.toMatchObject({ code: 'E_PROXY_UNREACHABLE', retryable: true });
  });
});
