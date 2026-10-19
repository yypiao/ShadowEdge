import { createServer, connect as netConnect, type Server, type Socket } from 'node:net';
import { ShadowEdgeError } from '@shadowedge/core';
import { openTunnel, type TunnelTarget, type UpstreamHop } from './tunnel.js';

/**
 * 本地代理中继网关（T8）。
 * Chromium 不支持 SOCKS5 认证、也不支持代理链；每个环境启动时在 127.0.0.1 起一个
 * 无认证的临时 HTTP 代理，把流量经 openTunnel（可双跳）转发到真实代理出口。
 */

export interface RelayProxy {
  protocol: 'http' | 'socks5';
  host: string;
  port: number;
  username?: string;
  password?: string;
}

export interface RelayOptions {
  upstream?: UpstreamHop;
  /** 隧道超时。浏览器并发建连多，给足余量避免慢出口误杀。 */
  timeoutMs?: number;
}

export interface RelayHandle {
  port: number;
  /** 给 Chromium 的 --proxy-server 值。 */
  server: string;
  close(): Promise<void>;
}

/** 环回与内网地址直连，不走隧道——否则浏览器访问本机服务会绕地球一圈。 */
function isDirectHost(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (/^127\./.test(host) || host === '::1') return true;
  if (/^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  return false;
}

interface ParsedHead {
  method: string;
  target: string;
  raw: string;
  rest: Buffer;
}

function readHead(socket: Socket): Promise<ParsedHead> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      const buf = Buffer.concat(chunks);
      const sep = buf.indexOf('\r\n\r\n');
      if (sep !== -1) {
        socket.off('data', onData);
        const raw = buf.subarray(0, sep + 4).toString('latin1');
        const [method = '', target = ''] = raw.split('\r\n')[0]!.split(' ');
        resolve({ method, target, raw, rest: buf.subarray(sep + 4) });
      } else if (Buffer.concat(chunks).length > 65536) {
        reject(new Error('请求头过大'));
      }
    };
    socket.on('data', onData);
    socket.once('error', reject);
  });
}

export async function startRelay(proxy: RelayProxy, options: RelayOptions = {}): Promise<RelayHandle> {
  const timeoutMs = options.timeoutMs ?? 30000;

  const openUpstream = (target: TunnelTarget): Promise<Socket> =>
    isDirectHost(target.host)
      ? new Promise((resolve, reject) => {
          const s = netConnect(target.port, target.host);
          s.once('connect', () => resolve(s));
          s.once('error', reject);
        })
      : openTunnel({ ...proxy }, target, { timeoutMs, upstream: options.upstream });

  const clients = new Set<Socket>();
  const server: Server = createServer((client: Socket) => {
    clients.add(client);
    client.once('close', () => clients.delete(client));
    void (async () => {
      try {
        const head = await readHead(client);

        if (head.method.toUpperCase() === 'CONNECT') {
          const [host = '', portStr = '443'] = head.target.split(':');
          const upstream = await openUpstream({ host, port: Number(portStr) });
          client.write('HTTP/1.1 200 Connection established\r\n\r\n');
          if (head.rest.length > 0) upstream.write(head.rest);
          client.pipe(upstream).pipe(client);
          upstream.once('error', () => client.destroy());
          client.once('error', () => upstream.destroy());
          return;
        }

        // 普通 HTTP 请求：request-line 是绝对 URI，转 origin-form 后转发到 80 端口
        const url = new URL(head.target);
        const port = Number(url.port || 80);
        const upstream = await openUpstream({ host: url.hostname, port });
        const originForm = url.pathname + url.search;
        const rewritten = head.raw
          .replace(`${head.method} ${head.target} `, `${head.method} ${originForm} `)
          .replace(/proxy-authorization:[^\r\n]*\r\n/i, '');
        upstream.write(rewritten);
        if (head.rest.length > 0) upstream.write(head.rest);
        client.pipe(upstream).pipe(client);
        upstream.once('error', () => client.destroy());
        client.once('error', () => upstream.destroy());
      } catch (error) {
        if (!client.destroyed) {
          client.write(`HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nrelay: ${(error as Error).message}`);
          client.end();
        }
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  if (!port) {
    server.close();
    throw new ShadowEdgeError('E_INTERNAL', '中继网关未能分配到本地端口');
  }

  return {
    port,
    server: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        // 主动断开存量连接，否则管道长连接会让 close 回调悬挂
        for (const client of clients) client.destroy();
        server.close(() => resolve());
      }),
  };
}
