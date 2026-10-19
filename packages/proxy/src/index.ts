import type { ProxyCredential, ProxyHealth, ProxyProtocol } from '@shadowedge/core';
import { checkProxyHealth, type HealthCheckOptions } from './health.js';

export { checkProxyHealth } from './health.js';
export { connectViaSocks5, connectViaHttp, connectViaUpstream, httpGetOverSocket, openTunnel } from './tunnel.js';
export type { UpstreamHop } from './tunnel.js';
export { startRelay } from './relay.js';
export type { RelayHandle, RelayProxy, RelayOptions } from './relay.js';

/** 代理池管理器：组合、健康检查、出口一致性与偏好路由。 */
export class ProxyManager {
  private proxies = new Map<string, ProxyCredential>();

  async upsert(credential: ProxyCredential & { password?: string }): Promise<ProxyCredential> {
    const entry: ProxyCredential = {
      ...credential,
      secretRef: credential.password
        ? `enc:${Buffer.from(credential.password).toString('base64')}`
        : credential.secretRef,
    };
    this.proxies.set(entry.id, entry);
    return entry;
  }

  async list(): Promise<ProxyCredential[]> {
    return Array.from(this.proxies.values());
  }

  async check(proxy: ProxyCredential, password?: string, options?: HealthCheckOptions): Promise<ProxyHealth> {
    return checkProxyHealth(proxy, password, options);
  }

  /** 批量导入代理文本。 */
  importBulk(text: string, format: 'line' | 'csv'): ProxyCredential[] {
    const lines = text.trim().split('\n').map((l) => l.trim()).filter(Boolean);
    const out: ProxyCredential[] = [];
    const idBase = crypto.randomUUID();
    for (let i = 0; i < lines.length; i += 1) {
      const parsed = format === 'line' ? parseLineFormat(lines[i]!) : parseCsvFormat(lines[i]!);
      if (parsed) {
        out.push({
          id: `${idBase}-${i}`,
          orgId: 'local',
          label: `imported-${i + 1}`,
          ...parsed,
          tags: [],
        });
      }
    }
    return out;
  }
}

function parseLineFormat(line: string): { protocol: ProxyProtocol; host: string; port: number; username?: string; secretRef?: string } | null {
  const url = line.match(/^(https?|socks5):\/\/(?:(.+):(.+)@)?([^:]+):(\d+)$/);
  if (!url) return null;
  const [, protocolRaw, user, pass, host, portStr] = url;
  const protocol = protocolRaw as ProxyProtocol;
  const port = parseInt(portStr!, 10);
  if (user && pass) {
    return { protocol, host: host!, port, username: user, secretRef: `enc:${Buffer.from(pass).toString('base64')}` };
  }
  return { protocol, host: host!, port };
}

function parseCsvFormat(line: string): ReturnType<typeof parseLineFormat> {
  const parts = line.split(',');
  if (parts.length < 3) return null;
  const [protocol, host, portStr, username, password] = parts.map((p) => p.trim());
  const port = parseInt(portStr!, 10);
  if (username && password) {
    return { protocol: protocol as ProxyProtocol, host: host!, port, username, secretRef: `enc:${Buffer.from(password).toString('base64')}` };
  }
  return { protocol: protocol as ProxyProtocol, host: host!, port };
}
