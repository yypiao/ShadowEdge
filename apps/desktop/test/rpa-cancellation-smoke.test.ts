import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BrowserProfile, IpcEvents, RpaWorkflow } from '@shadowedge/core';
import { generateFingerprint } from '@shadowedge/fingerprint';
import { BrowserKernel, ChromiumCdpDriver } from '@shadowedge/kernel';
import { RpaEngine } from '@shadowedge/rpa';

const executablePath = process.env.SHADOWEDGE_KERNEL_EXECUTABLE;
const SMOKE = process.env.SHADOWEDGE_SMOKE === '1' && executablePath !== undefined;

function hangingWorkflow(origin: string, timeoutMs?: number): RpaWorkflow {
  return {
    id: 'workflow-rpa-hard-cancellation',
    orgId: 'local',
    name: '挂起导航硬取消',
    version: 1,
    graph: {
      entry: 'open',
      timeoutMs,
      nodes: {
        open: {
          id: 'open',
          kind: 'navigate',
          params: { url: `${origin}/hang`, timeout: 60000 },
          next: 'shot',
        },
        shot: { id: 'shot', kind: 'screenshot', params: { key: 'must-not-exist' } },
      },
    },
    createdBy: 'local-user',
    updatedAt: new Date().toISOString(),
  };
}

async function closeServer(server: Server, sockets: Set<Socket>): Promise<void> {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe.skipIf(!SMOKE)('RPA 硬超时与取消真实 Chromium 链路', () => {
  it('挂起导航在超时和手动取消后均关闭页面、不执行后续节点并释放环境锁', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shadowedge-rpa-cancellation-'));
    const artifactsDir = join(dir, 'artifacts');
    const sockets = new Set<Socket>();
    let hangingRequests = 0;
    const server = createServer((request, response) => {
      if (request.url === '/hang') {
        hangingRequests += 1;
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.write('<!doctype html><title>pending</title>');
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><title>ready</title>');
    });
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const now = new Date().toISOString();
    const profile: BrowserProfile = {
      id: 'rpa-hard-cancellation-smoke',
      orgId: 'local',
      name: 'rpa-hard-cancellation-smoke',
      kernel: 'chromium-cdp',
      fingerprint: generateFingerprint({ seed: 'rpa-hard-cancellation-smoke', platform: 'host' }),
      ownerId: 'local',
      sharedWith: [],
      storage: {
        userDataDir: join(dir, 'profile'),
        remoteRevision: 0,
        syncMode: 'local-only',
      },
      startupUrls: [],
      status: 'idle',
      createdAt: now,
      updatedAt: now,
    };
    const kernel = new BrowserKernel({
      drivers: [new ChromiumCdpDriver({ executablePath, fallbackToPatchright: false })],
    });
    const progress: IpcEvents['rpa:progress'][] = [];
    const engine = new RpaEngine({
      resolveContext: () => kernel.getAutomationContext(profile.id),
      artifactsDir,
      emit: (event) => progress.push(event),
    });
    try {
      await kernel.launch(profile, { profileId: profile.id, headless: false });
      const context = kernel.getAutomationContext(profile.id);

      const timeoutPage = context.pages()[0] ?? await context.newPage();
      const timeoutRun = (await engine.run(hangingWorkflow(origin, 500), [profile.id]))[0]!;
      const timedOut = await engine.wait(timeoutRun.id);
      expect(timedOut.status).toBe('failed');
      expect(timedOut.error).toContain('总超时 500ms');
      expect(timedOut.artifacts).toEqual([]);
      expect(timeoutPage.isClosed()).toBe(true);
      expect(existsSync(join(artifactsDir, timedOut.id, 'must-not-exist.png'))).toBe(false);

      const cancelledPage = context.pages()[0] ?? await context.newPage();
      const cancelRun = (await engine.run(hangingWorkflow(origin), [profile.id]))[0]!;
      await expect.poll(() => hangingRequests, { timeout: 10000 }).toBe(2);
      await engine.cancel(cancelRun.id);
      const cancelled = await engine.wait(cancelRun.id);
      expect(cancelled.status).toBe('cancelled');
      expect(cancelled.artifacts).toEqual([]);
      expect(cancelledPage.isClosed()).toBe(true);
      expect(existsSync(join(artifactsDir, cancelled.id, 'must-not-exist.png'))).toBe(false);

      const recovery = (await engine.run({
        ...hangingWorkflow(origin),
        graph: { entry: 'wait', nodes: { wait: { id: 'wait', kind: 'wait', params: { ms: 0 } } } },
      }, [profile.id]))[0]!;
      expect((await engine.wait(recovery.id)).status).toBe('succeeded');
      expect(progress.some((event) => event.step === 'shot')).toBe(false);
    } finally {
      await kernel.closeAll();
      await closeServer(server, sockets);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 240000);
});
