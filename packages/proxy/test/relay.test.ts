import { describe, expect, it, afterEach } from 'vitest';
import { createServer, connect as netConnect, type Server, type Socket } from 'node:net';
import { startRelay, type RelayHandle } from '../src/relay.js';

/** 微型 SOCKS5 服务端：校验认证后直连目标并转发。 */
function fakeSocks5(expectAuth: { user: string; pass: string } | null, dial: (host: string, port: number) => Socket): Server {
  return createServer((socket: Socket) => {
    let stage = 0;
    const onData = (buf: Buffer) => {
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
      } else if (stage >= 1) {
        // 拨号前必须摘掉监听，否则后续管道数据会被当作 SOCKS5 报文解析
        socket.off('data', onData);
        const hostLen = buf[4]!;
        const host = buf.subarray(5, 5 + hostLen).toString();
        const port = buf.readUInt16BE(5 + hostLen);
        const onward = dial(host, port);
        onward.once('connect', () => {
          socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          socket.pipe(onward).pipe(socket);
        });
        onward.once('error', () => socket.destroy());
        stage = 99;
      }
    };
    socket.on('data', onData);
  });
}

/** 回显一个固定 JSON 的微型 HTTP 服务。 */
function fakeWebServer(body: string): Server {
  return createServer((socket: Socket) => {
    socket.once('data', () => {
      socket.end(`HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`);
    });
  });
}

/** 经中继发一次 CONNECT + 原始请求。 */
function relayRequest(relayPort: number, target: string, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = netConnect(relayPort, '127.0.0.1', () => {
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    });
    let buf = '';
    let tunneled = false;
    socket.on('data', (chunk: Buffer) => {
      buf += chunk.toString('latin1');
      if (!tunneled && buf.includes('\r\n\r\n')) {
        tunneled = true;
        buf = '';
        socket.write(request);
      } else if (tunneled && buf.includes('\r\n\r\n') && buf.includes('{')) {
        resolve(buf);
        socket.destroy();
      }
    });
    socket.once('error', reject);
    setTimeout(() => reject(new Error('relayRequest 超时')), 8000);
  });
}

let cleanup: Array<Server | RelayHandle> = [];
afterEach(async () => {
  for (const item of cleanup) {
    if ('close' in item && typeof item.close === 'function') await item.close();
  }
  cleanup = [];
});

const listen = (server: Server) => new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const portOf = (server: Server) => (server.address() as { port: number }).port;

describe('本地代理中继网关', () => {
  it('CONNECT 经带认证的 SOCKS5 第二跳转发，浏览器侧零配置', async () => {
    const web = fakeWebServer('{"ip":"9.9.9.9"}');
    const socks = fakeSocks5({ user: 'u', pass: 'p' }, () => netConnect(portOf(web), '127.0.0.1'));
    cleanup.push(web, socks);
    await Promise.all([listen(web), listen(socks)]);

    const relay = await startRelay({ protocol: 'socks5', host: '127.0.0.1', port: portOf(socks), username: 'u', password: 'p' });
    cleanup.push(relay);

    const resp = await relayRequest(relay.port, 'example.com:80', 'GET /ip HTTP/1.1\r\nHost: example.com\r\n\r\n');
    expect(resp).toContain('9.9.9.9');
  });

  it('环回地址直连，不触碰隧道', async () => {
    const web = fakeWebServer('{"direct":true}');
    cleanup.push(web);
    await listen(web);
    // 代理凭据故意给一个不存在的服务：若走了隧道必然失败
    const relay = await startRelay({ protocol: 'socks5', host: '127.0.0.1', port: 1 });
    cleanup.push(relay);

    const resp = await relayRequest(relay.port, `127.0.0.1:${portOf(web)}`, 'GET / HTTP/1.1\r\nHost: localhost\r\n\r\n');
    expect(resp).toContain('"direct":true');
  });

  it('第二跳不可达时返回 502 而不是挂起', async () => {
    const relay = await startRelay({ protocol: 'socks5', host: '127.0.0.1', port: 1 }, { timeoutMs: 500 });
    cleanup.push(relay);
    const resp = await new Promise<string>((resolve) => {
      const socket = netConnect(relay.port, '127.0.0.1', () => {
        socket.write('CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n');
      });
      let buf = '';
      socket.on('data', (c: Buffer) => {
        buf += c.toString();
        if (buf.includes('\r\n\r\n')) {
          resolve(buf);
          socket.destroy();
        }
      });
    });
    expect(resp).toContain('502');
  });
});
