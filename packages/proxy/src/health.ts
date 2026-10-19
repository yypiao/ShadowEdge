import type { ProxyCredential, ProxyHealth } from '@shadowedge/core';
import { ShadowEdgeError } from '@shadowedge/core';
import { connectViaHttp, connectViaSocks5, httpGetOverSocket, type TunnelTarget } from './tunnel.js';

/**
 * 代理健康检查真实化（T3）：经代理隧道拉取出口 IP 与地理/风险画像。
 * 多端点回退——T3 实测发现不同出口对部分目标有拦截或超时，单端点不可靠。
 */

export interface HealthCheckOptions {
  timeoutMs?: number;
  /** 测试注入点：替换隧道请求实现，单测用。 */
  fetchJson?: (credential: ProxyCredential, password: string | undefined, target: Endpoint) => Promise<{ status: number; body: string }>;
}

interface Endpoint {
  host: string;
  port: number;
  tls: boolean;
  path: string;
  parse: (body: string) => Partial<Pick<ProxyHealth, 'exitIp' | 'geo' | 'risk'>>;
}

interface IpApiGeo {
  status: string;
  country?: string;
  regionName?: string;
  city?: string;
  timezone?: string;
  as?: string;
  proxy?: boolean;
  hosting?: boolean;
  query?: string;
}

const ENDPOINTS: Endpoint[] = [
  {
    // 地理 + 风险画像一体（免费版仅 http）
    host: 'ip-api.com',
    port: 80,
    tls: false,
    path: '/json/?fields=status,country,regionName,city,timezone,as,proxy,hosting,query',
    parse: (body) => {
      const data = JSON.parse(body) as IpApiGeo;
      if (data.status !== 'success') return {};
      return {
        exitIp: data.query,
        geo: { country: data.country ?? '', region: data.regionName, city: data.city, timezone: data.timezone, asn: data.as },
        risk: {
          score: data.hosting ? 0.7 : data.proxy ? 0.4 : 0.05,
          isDatacenter: data.hosting ?? false,
          isProxy: data.proxy ?? false,
          blacklisted: false,
        },
      };
    },
  },
  {
    host: 'httpbin.org',
    port: 443,
    tls: true,
    path: '/ip',
    parse: (body) => {
      const data = JSON.parse(body) as { origin?: string };
      return { exitIp: data.origin?.split(',')[0]?.trim() };
    },
  },
  {
    host: 'api.ip.sb',
    port: 443,
    tls: true,
    path: '/ip',
    parse: (body) => ({ exitIp: body.trim() }),
  },
];

async function defaultFetchJson(
  credential: ProxyCredential,
  password: string | undefined,
  endpoint: Endpoint,
  timeoutMs: number,
): Promise<{ status: number; body: string }> {
  const proxy = { host: credential.host, port: credential.port, username: credential.username, password };
  const target: TunnelTarget = { host: endpoint.host, port: endpoint.port };
  const socket =
    credential.protocol === 'socks5'
      ? await connectViaSocks5(proxy, target, { timeoutMs })
      : await connectViaHttp(proxy, target, { timeoutMs });
  return httpGetOverSocket(socket, { ...target, tls: endpoint.tls }, endpoint.path, {}, timeoutMs);
}

export async function checkProxyHealth(
  credential: ProxyCredential,
  password?: string,
  options: HealthCheckOptions = {},
): Promise<ProxyHealth> {
  const timeoutMs = options.timeoutMs ?? 12000;
  const started = Date.now();
  const errors: string[] = [];

  for (const endpoint of ENDPOINTS) {
    // 住宅代理晚高峰抖动明显（T3 实测 t2 曾整组超时、数秒后恢复），每端点重试一次再回退
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fetcher = options.fetchJson
          ? (ep: Endpoint) => options.fetchJson!(credential, password, ep)
          : (ep: Endpoint) => defaultFetchJson(credential, password, ep, timeoutMs);
        const { status, body } = await fetcher(endpoint);
        if (status < 200 || status >= 300) throw new Error(`HTTP ${status}`);
        const parsed = endpoint.parse(body);
        if (!parsed.exitIp) throw new Error('响应中无出口 IP');
        return {
          proxyId: credential.id,
          checkedAt: new Date().toISOString(),
          reachable: true,
          latencyMs: Date.now() - started,
          exitIp: parsed.exitIp,
          geo: parsed.geo,
          risk: parsed.risk,
        };
      } catch (error) {
        errors.push(`${endpoint.host}#${attempt + 1}: ${(error as Error).message}`);
      }
    }
  }

  throw new ShadowEdgeError('E_PROXY_UNREACHABLE', `代理 ${credential.host}:${credential.port} 全部探测端点失败`, {
    retryable: true,
    details: { attempts: errors },
  });
}
