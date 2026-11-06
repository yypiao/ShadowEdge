import { describe, expect, it } from 'vitest';
import { inspectIpBlacklist } from '../src/risk.js';

function dnsError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

describe('DNSBL 风险来源', () => {
  it('使用反向 IPv4 查询两个来源，并区分未命中与命中', async () => {
    const queries: string[] = [];
    const sources = await inspectIpBlacklist('1.2.3.4', {
      resolve4: async (hostname) => {
        queries.push(hostname);
        if (hostname.endsWith('spamcop.net')) return ['127.0.0.2'];
        throw dnsError('ENOTFOUND');
      },
    });
    expect(queries).toEqual(['4.3.2.1.zen.spamhaus.org', '4.3.2.1.bl.spamcop.net']);
    expect(sources).toEqual([
      { id: 'spamhaus-zen', status: 'clear' },
      { id: 'spamcop', status: 'listed', detail: 'DNSBL 返回名单记录' },
    ]);
  });

  it('查询错误和未识别响应不会被当成真实名单命中', async () => {
    const sources = await inspectIpBlacklist('1.2.3.4', {
      resolve4: async (hostname) =>
        hostname.endsWith('spamhaus.org') ? ['127.255.255.254'] : ['127.0.0.1'],
    });
    expect(sources.map((source) => source.status)).toEqual(['unknown', 'unknown']);
    expect(sources.every((source) => source.detail === 'DNSBL 返回查询错误或未识别记录')).toBe(
      true,
    );
  });

  it('超时和服务失败只返回 unknown，不误判为 clear', async () => {
    const sources = await inspectIpBlacklist('1.2.3.4', {
      timeoutMs: 5,
      resolve4: async (hostname) =>
        hostname.endsWith('spamcop.net')
          ? new Promise<readonly string[]>(() => undefined)
          : Promise.reject(dnsError('SERVFAIL')),
    });
    expect(sources.map((source) => source.status)).toEqual(['unknown', 'unknown']);
  });

  it('非 IPv4 不发起 DNS 查询', async () => {
    let calls = 0;
    const sources = await inspectIpBlacklist('2001:db8::1', {
      resolve4: async () => {
        calls += 1;
        return [];
      },
    });
    expect(calls).toBe(0);
    expect(sources.every((source) => source.status === 'unknown')).toBe(true);
  });
});
