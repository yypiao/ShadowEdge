import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { ShadowEdgeError } from '@shadowedge/core';

/**
 * 最小隧道客户端：SOCKS5（RFC 1928 用户名密码认证）与 HTTP CONNECT。
 * 不引第三方依赖——健康检查与未来 Xray 网关拨测都建立在这 100 行上。
 */

export interface TunnelTarget {
  host: string;
  port: number;
}

export interface TunnelOptions {
  timeoutMs?: number;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new ShadowEdgeError('E_PROXY_UNREACHABLE', `${label} 超时（${ms}ms）`, { retryable: true })), ms),
    ),
  ]);
}

function connectTcp(target: TunnelTarget, timeoutMs: number, label: string): Promise<Socket> {
  return withTimeout(
    new Promise<Socket>((resolve, reject) => {
      const s = netConnect(target.port, target.host);
      s.once('connect', () => resolve(s));
      s.once('error', reject);
    }),
    timeoutMs,
    label,
  );
}

/** 在已建立的 socket 上完成 SOCKS5 握手 → 认证 → CONNECT。 */
async function socks5HandshakeOver(
  socket: Socket,
  auth: { username?: string; password?: string },
  target: TunnelTarget,
  timeoutMs: number,
): Promise<Socket> {
  const exchange = (payload: Buffer, expect: number, label: string): Promise<Buffer> =>
    withTimeout(
      new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        const onData = (chunk: Buffer) => {
          chunks.push(chunk);
          const buf = Buffer.concat(chunks);
          if (buf.length >= expect) {
            socket.off('data', onData);
            socket.off('error', onErr);
            resolve(buf);
          }
        };
        const onErr = (e: Error) => {
          socket.off('data', onData);
          reject(e);
        };
        socket.on('data', onData);
        socket.once('error', onErr);
        socket.write(payload);
      }),
      timeoutMs,
      label,
    );

  const fail = (msg: string): never => {
    socket.destroy();
    throw new ShadowEdgeError('E_PROXY_UNREACHABLE', msg, { retryable: true });
  };

  // greeting：支持无认证与用户名密码两种方式
  socket.write(Buffer.from([0x05, 0x02, 0x00, 0x02]));
  await new Promise<void>((r) => setImmediate(r));
  const hello = await exchange(Buffer.alloc(0), 2, 'SOCKS5 握手');
  if (hello[0] !== 0x05) fail('SOCKS5 握手失败：协议版本不符');
  if (hello[1] === 0x02) {
    const username = auth.username;
    if (!username) return fail('代理要求用户名密码认证，但未提供凭据');
    const user = Buffer.from(username, 'utf-8');
    const pass = Buffer.from(auth.password ?? '', 'utf-8');
    const authPayload = Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]);
    const authResp = await exchange(authPayload, 2, 'SOCKS5 认证');
    if (authResp[1] !== 0x00) fail('SOCKS5 认证失败：用户名或密码错误');
  } else if (hello[1] !== 0x00) {
    fail(`SOCKS5 无可用认证方式（server=0x${hello[1]?.toString(16)}）`);
  }

  const hostBuf = Buffer.from(target.host, 'utf-8');
  const req = Buffer.concat([
    Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
    hostBuf,
    Buffer.from([target.port >> 8, target.port & 0xff]),
  ]);
  const resp = await exchange(req, 10, 'SOCKS5 连接目标');
  if (resp[1] !== 0x00) fail(`SOCKS5 连接目标失败（code=0x${resp[1]?.toString(16)}）`);
  return socket;
}

/** SOCKS5 CONNECT：握手 → 用户名密码认证 → 连接目标。 */
export async function connectViaSocks5(
  proxy: TunnelTarget & { username?: string; password?: string },
  target: TunnelTarget,
  options: TunnelOptions = {},
): Promise<Socket> {
  const timeoutMs = options.timeoutMs ?? 10000;
  const socket = await connectTcp(proxy, timeoutMs, 'SOCKS5 代理连接');
  return socks5HandshakeOver(socket, proxy, target, timeoutMs);
}

/** 在已建立的 socket 上发出 HTTP CONNECT 并校验 2xx。 */
async function httpConnectOver(
  socket: Socket,
  auth: { username?: string; password?: string },
  target: TunnelTarget,
  timeoutMs: number,
): Promise<Socket> {
  const authHeader = auth.username
    ? `Proxy-Authorization: Basic ${Buffer.from(`${auth.username}:${auth.password ?? ''}`).toString('base64')}\r\n`
    : '';
  const request = `CONNECT ${target.host}:${target.port} HTTP/1.1\r\nHost: ${target.host}:${target.port}\r\n${authHeader}\r\n`;

  const response = await withTimeout(
    new Promise<string>((resolve, reject) => {
      let buf = '';
      const onData = (chunk: Buffer) => {
        buf += chunk.toString('latin1');
        if (buf.includes('\r\n\r\n')) {
          socket.off('data', onData);
          resolve(buf);
        }
      };
      socket.on('data', onData);
      socket.once('error', reject);
      socket.write(request);
    }),
    timeoutMs,
    'HTTP CONNECT',
  );

  const statusLine = response.split('\r\n')[0] ?? '';
  if (!/ 2\d\d /.test(statusLine)) {
    socket.destroy();
    throw new ShadowEdgeError('E_PROXY_UNREACHABLE', `HTTP CONNECT 被拒绝: ${statusLine}`, { retryable: true });
  }
  return socket;
}

/** HTTP CONNECT：建立到目标的 TCP 隧道。 */
export async function connectViaHttp(
  proxy: TunnelTarget & { username?: string; password?: string },
  target: TunnelTarget,
  options: TunnelOptions = {},
): Promise<Socket> {
  const timeoutMs = options.timeoutMs ?? 10000;
  const socket = await connectTcp(proxy, timeoutMs, 'HTTP 代理连接');
  return httpConnectOver(socket, proxy, target, timeoutMs);
}

/** 上游代理描述：用于「本地代理 → 海外静态」这类双跳链路的第一跳。 */
export interface UpstreamHop {
  protocol: 'http' | 'socks5';
  host: string;
  port: number;
  username?: string;
  password?: string;
}

/**
 * 经上游代理把 TCP 隧道打到第二跳代理的端口上。
 * 返回的 socket 已对准第二跳，调用方在其上继续跑第二跳自己的协议握手。
 */
export async function connectViaUpstream(
  upstream: UpstreamHop,
  nextHop: TunnelTarget,
  options: TunnelOptions = {},
): Promise<Socket> {
  return upstream.protocol === 'socks5'
    ? connectViaSocks5(upstream, nextHop, options)
    : connectViaHttp(upstream, nextHop, options);
}

/**
 * 统一隧道入口：可选上游一跳（本地翻墙代理），再跑目标代理自己的协议握手。
 * 覆盖「直连」「双跳（本地 → 海外静态）」两种拓扑。
 */
export async function openTunnel(
  proxy: TunnelTarget & { protocol: 'http' | 'socks5'; username?: string; password?: string },
  target: TunnelTarget,
  options: TunnelOptions & { upstream?: UpstreamHop } = {},
): Promise<Socket> {
  const timeoutMs = options.timeoutMs ?? 10000;
  if (!options.upstream) {
    return proxy.protocol === 'socks5'
      ? connectViaSocks5(proxy, target, { timeoutMs })
      : connectViaHttp(proxy, target, { timeoutMs });
  }
  const socket = await connectViaUpstream(options.upstream, { host: proxy.host, port: proxy.port }, { timeoutMs });
  try {
    return proxy.protocol === 'socks5'
      ? await socks5HandshakeOver(socket, proxy, target, timeoutMs)
      : await httpConnectOver(socket, proxy, target, timeoutMs);
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

/** 在隧道上发起一次 HTTP(S) GET，返回状态码与 body（Connection: close，支持 chunked）。 */
export async function httpGetOverSocket(
  socket: Socket,
  target: TunnelTarget & { tls: boolean },
  path: string,
  headers: Record<string, string> = {},
  timeoutMs = 12000,
): Promise<{ status: number; body: string }> {
  let stream: Socket | TLSSocket = socket;
  if (target.tls) {
    stream = await withTimeout(
      new Promise<TLSSocket>((resolve, reject) => {
        const t = tlsConnect({ socket, servername: target.host }, () => resolve(t));
        t.once('error', reject);
      }),
      timeoutMs,
      'TLS 握手',
    );
  }

  const headerLines = Object.entries({ Host: target.host, 'User-Agent': 'shadowedge-health/0.1', Connection: 'close', ...headers })
    .map(([k, v]) => `${k}: ${v}\r\n`)
    .join('');
  stream.write(`GET ${path} HTTP/1.1\r\n${headerLines}\r\n`);

  const raw = await withTimeout(
    new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.once('end', () => resolve(Buffer.concat(chunks)));
      stream.once('close', () => resolve(Buffer.concat(chunks)));
      stream.once('error', reject);
    }),
    timeoutMs,
    'HTTP 响应',
  );

  const text = raw.toString('latin1');
  const sep = text.indexOf('\r\n\r\n');
  if (sep === -1) throw new ShadowEdgeError('E_PROXY_UNREACHABLE', '代理隧道响应格式异常', { retryable: true });
  const head = text.slice(0, sep);
  let body = text.slice(sep + 4);
  const status = Number(head.split(' ')[1] ?? 0);

  if (/transfer-encoding:\s*chunked/i.test(head)) {
    body = decodeChunked(body);
  }
  stream.destroy();
  return { status, body };
}

function decodeChunked(input: string): string {
  let out = '';
  let rest = input;
  for (;;) {
    const lineEnd = rest.indexOf('\r\n');
    if (lineEnd === -1) break;
    const size = parseInt(rest.slice(0, lineEnd), 16);
    if (!Number.isFinite(size) || size <= 0) break;
    out += rest.slice(lineEnd + 2, lineEnd + 2 + size);
    rest = rest.slice(lineEnd + 2 + size + 2);
  }
  return out;
}
