import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkProxyHealth } from '../src/health.js';

const PROXY_SMOKE = process.env.SHADOWEDGE_PROXY_SMOKE === '1';
const PROXY_IDS = (process.env.SHADOWEDGE_PROXY_IDS ?? 'os1,t1').split(',');

interface TestProxySecret {
  id: string;
  host: string;
  port: number;
  username: string;
  password: string;
}

describe.skipIf(!PROXY_SMOKE)('真实代理风险画像', () => {
  it('并行返回各自出口与独立 DNSBL 来源状态', async () => {
    const secretsPath = fileURLToPath(
      new URL('../../../experiments/.secrets/test-proxies.json', import.meta.url),
    );
    const secrets = JSON.parse(readFileSync(secretsPath, 'utf8')) as TestProxySecret[];
    const selected = PROXY_IDS.map((id) => {
      const secret = secrets.find((item) => item.id === id);
      if (!secret) throw new Error(`缺少测试代理 ${id}`);
      return secret;
    });
    const results = await Promise.all(selected.map((secret) => checkProxyHealth({
      id: secret.id,
      orgId: 'local',
      label: secret.id,
      protocol: 'socks5',
      host: secret.host,
      port: secret.port,
      username: secret.username,
      tags: [],
    }, secret.password, {
      upstream: { protocol: 'http', host: '127.0.0.1', port: 7897 },
      timeoutMs: 45000,
    })));
    expect(results.map((health) => health.proxyId)).toEqual(PROXY_IDS);
    expect(new Set(results.map((health) => health.exitIp)).size).toBe(PROXY_IDS.length);
    for (const health of results) {
      expect(health.reachable).toBe(true);
      expect(health.risk?.sources.map((source) => source.id)).toEqual([
        'spamhaus-zen', 'spamcop',
      ]);
      expect(health.risk?.sources.every((source) =>
        ['clear', 'listed', 'unknown'].includes(source.status))).toBe(true);
      expect(['clear', 'caution', 'high', 'unknown']).toContain(health.risk?.status);
      expect(health.risk).not.toHaveProperty('blacklisted');
    }
  }, 120000);
});
