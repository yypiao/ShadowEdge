import { describe, expect, it, afterEach } from 'vitest';
import { createServer, connect as netConnect, type Server, type Socket } from 'node:net';
import { connectViaSocks5, httpGetOverSocket, openTunnel } from '../src/tunnel.js';

/** 微型 HTTP CONNECT 上游：真实拨号到 CONNECT 目标并双向转发。 */
function fakeHttpUpstream(): { server: Server; port: () => number; targets: string[] } {
  const targets: string[] = [];
  const server = createServer((socket: Socket) => {
    let buf = '';
    const onData = (chunk: Buffer) => {
      buf += chunk.toString('latin1');
      if (buf.includes('\r\n\r\n')) {
        socket.off('data', onData);
        const targetLine = buf.split('\r\n')[0] ?? '';
        targets.push(targetLine);
        const [host, portStr] = (targetLine.split(' ')[1] ?? '').split(':');
        const onward = netConnect(Number(portStr), host!, () => {
          socket.write('HTTP/1.1 200 Connection established\r\n\r\n');
          socket.pipe(onward).pipe(socket);
        });
        onward.once('error', () => socket.destroy());
      }
    };
    socket.on('data', onData);
  });
  server.listen(0, '127.0.0.1');
  return { server, port: () => (server.address() as { port: number }).port, targets };
}

/** 微型 SOCKS5 服务端：校验握手与认证，然后把请求原样回显。 */
function fakeSocks5(expectAuth: { user: string; pass: string } | null): { server: Server; port: () => number } {
  const server = createServer((socket: Socket) => {
    let stage = 0;
    socket.on('data', (buf: Buffer) => {
      if (stage === 0) {
        stage = 1;
        socket.write(Buffer.from([0x05, expectAuth ? 0x02 : 0x00]));
      } else if (stage === 1 && expectAuth) {
        stage = 2;
        const userLen = buf[1]!;
        const user = buf.subarray(2, 2 + userLen).toString();
        const passLen = buf[2 + userLen]!;
        const pass = buf.subarray(3 + userLen, 3 + userLen + passLen).toString();
        socket.write(Buffer.from([0x01, user === expectAuth.user && pass === expectAuth.pass ? 0x00 : 0x01]));
      } else {
        const hostLen = buf[4]!;
        const host = buf.subarray(5, 5 + hostLen).toString();
        const port = buf.readUInt16BE(5 + hostLen);
        socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, port >> 8, port & 0xff]));
        socket.on('data', (req: Buffer) => {
          socket.write(
            'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n' +
              JSON.stringify({ host, received: req.toString().slice(0, 20) }),
          );
          socket.end();
        });
      }
    });
  });
  server.listen(0, '127.0.0.1');
  return { server, port: () => (server.address() as { port: number }).port };
}

let servers: Server[] = [];
afterEach(() => {
  servers.forEach((s) => s.close());
  servers = [];
});

describe('SOCKS5 隧道', () => {
  it('无认证握手并传输数据', async () => {
    const fake = fakeSocks5(null);
    servers.push(fake.server);
    await new Promise((r) => fake.server.once('listening', r));
    const socket = await connectViaSocks5({ host: '127.0.0.1', port: fake.port() }, { host: 'example.com', port: 80 });
    const resp = await httpGetOverSocket(socket, { host: 'example.com', port: 80, tls: false }, '/ip');
    expect(resp.status).toBe(200);
    expect(resp.body).toContain('example.com');
  });

  it('用户名密码认证成功', async () => {
    const fake = fakeSocks5({ user: 'yypiao', pass: 'piao121521@' });
    servers.push(fake.server);
    await new Promise((r) => fake.server.once('listening', r));
    const socket = await connectViaSocks5(
      { host: '127.0.0.1', port: fake.port(), username: 'yypiao', password: 'piao121521@' },
      { host: 'example.com', port: 80 },
    );
    socket.destroy();
  });

  it('密码错误时抛出可重试错误', async () => {
    const fake = fakeSocks5({ user: 'u', pass: 'right' });
    servers.push(fake.server);
    await new Promise((r) => fake.server.once('listening', r));
    await expect(
      connectViaSocks5({ host: '127.0.0.1', port: fake.port(), username: 'u', password: 'wrong' }, { host: 'x', port: 80 }),
    ).rejects.toThrowError(/认证失败/);
  });
});

describe('双跳链路（上游 → 第二跳代理）', () => {
  it('HTTP CONNECT 上游 → SOCKS5 第二跳：先 CONNECT 到第二跳端口，再完成 SOCKS5 握手', async () => {
    const upstream = fakeHttpUpstream();
    const secondHop = fakeSocks5({ user: 'beMBQkwJhdJP', pass: 'RBcbYC3B4G' });
    servers.push(upstream.server, secondHop.server);
    await Promise.all([
      new Promise((r) => upstream.server.once('listening', r)),
      new Promise((r) => secondHop.server.once('listening', r)),
    ]);

    const socket = await openTunnel(
      { host: '127.0.0.1', port: secondHop.port(), protocol: 'socks5', username: 'beMBQkwJhdJP', password: 'RBcbYC3B4G' },
      { host: 'api.ip.sb', port: 443 },
      { upstream: { protocol: 'http', host: '127.0.0.1', port: upstream.port() } },
    );
    const resp = await httpGetOverSocket(socket, { host: 'api.ip.sb', port: 443, tls: false }, '/ip');
    expect(resp.status).toBe(200);
    expect(resp.body).toContain('api.ip.sb');
    expect(upstream.targets[0]).toBe(`CONNECT 127.0.0.1:${secondHop.port()} HTTP/1.1`);
  });

  it('第二跳认证失败时链路整体失败', async () => {
    const upstream = fakeHttpUpstream();
    const secondHop = fakeSocks5({ user: 'right', pass: 'pass' });
    servers.push(upstream.server, secondHop.server);
    await Promise.all([
      new Promise((r) => upstream.server.once('listening', r)),
      new Promise((r) => secondHop.server.once('listening', r)),
    ]);

    await expect(
      openTunnel(
        { host: '127.0.0.1', port: secondHop.port(), protocol: 'socks5', username: 'wrong', password: 'pass' },
        { host: 'api.ip.sb', port: 443 },
        { upstream: { protocol: 'http', host: '127.0.0.1', port: upstream.port() } },
      ),
    ).rejects.toThrow('SOCKS5 认证失败');
  });
});
