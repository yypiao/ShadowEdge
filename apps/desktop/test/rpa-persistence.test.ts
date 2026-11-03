import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createConsoleLogger, type RpaRun } from '@shadowedge/core';
import { EnvelopeCrypto } from '@shadowedge/crypto';
import { createHandlers, type Handlers } from '../src/main/handlers.js';
import { AccountRepository } from '../src/main/services/account-repository.js';
import { openDatabase, type ShadowEdgeDb } from '../src/main/services/db.js';
import { KernelRuntimeService } from '../src/main/services/kernel-runtime.js';
import { AuditLog, SessionRepository } from '../src/main/services/local-records.js';
import { ProfileRepository } from '../src/main/services/profile-repository.js';
import { GroupRepository } from '../src/main/services/group-repository.js';
import { ProxyRepository } from '../src/main/services/proxy-repository.js';
import { RpaRepository } from '../src/main/services/rpa-repository.js';
import { StorageStateRepository } from '../src/main/services/storage-state-repository.js';

describe('RPA 工作流与运行历史持久化', () => {
  let dir: string;
  let handle: ShadowEdgeDb;
  let repository: RpaRepository;
  let handlers: Handlers;
  let opened: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'shadowedge-rpa-persistence-'));
    handle = openDatabase(':memory:');
    repository = new RpaRepository(handle);
    opened = [];
    handlers = createHandlers({
      logger: createConsoleLogger({ test: 'rpa-persistence' }),
      emit: () => undefined,
      profileRepo: new ProfileRepository(handle),
      groupRepo: new GroupRepository(handle),
      proxyRepo: new ProxyRepository(handle, new EnvelopeCrypto('00'.repeat(32))),
      accountRepo: new AccountRepository(handle, new EnvelopeCrypto('00'.repeat(32))),
      rpaRepo: repository,
      storageStateRepo: new StorageStateRepository(handle, new EnvelopeCrypto('00'.repeat(32))),
      audit: new AuditLog(handle),
      sessions: new SessionRepository(handle),
      kernelRuntime: new KernelRuntimeService(join(dir, 'config'), {}),
      rpaArtifactsDir: join(dir, 'artifacts'),
      profilesDir: join(dir, 'profiles'),
      openArtifact: async (path) => {
        opened.push(path);
      },
    });
  });

  afterEach(() => {
    handle.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('保存工作流并递增版本，删除后不再列出', async () => {
    const input = {
      name: '登录检查',
      graph: {
        entry: 'open',
        nodes: {
          open: { id: 'open', kind: 'navigate' as const, params: { url: 'https://example.com' } },
        },
      },
    };
    const created = await handlers['rpa:save'](input);
    expect(created.version).toBe(1);
    const updated = await handlers['rpa:save']({ ...input, id: created.id, name: '登录检查 v2' });
    expect(updated.version).toBe(2);
    expect(updated.id).toBe(created.id);
    expect(await handlers['rpa:list'](undefined)).toEqual([updated]);

    await handlers['rpa:delete'](created.id);
    expect(await handlers['rpa:list'](undefined)).toEqual([]);
    await expect(handlers['rpa:delete'](created.id)).rejects.toMatchObject({
      code: 'E_RPA_WORKFLOW_NOT_FOUND',
    });
  });

  it('运行历史可独立读取，产物打开限制在对应运行目录', async () => {
    const runId = 'persisted-run';
    const screenshot = join(dir, 'artifacts', runId, 'result.png');
    const run: RpaRun = {
      id: runId,
      workflowId: 'workflow-1',
      profileId: 'profile-1',
      status: 'succeeded',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      outputs: { greeting: 'Hello Ada' },
      artifacts: [
        { kind: 'screenshot', uri: screenshot },
        { kind: 'log', uri: join(dir, 'outside.log') },
      ],
    };
    repository.saveRun(run);

    expect(await handlers['rpa:get'](runId)).toEqual(run);
    expect(await handlers['rpa:listRuns']({ limit: 10 })).toEqual([run]);
    await handlers['rpa:openArtifact']({ runId, uri: screenshot });
    expect(opened).toEqual([screenshot]);
    await expect(
      handlers['rpa:openArtifact']({ runId, uri: join(dir, 'outside.log') }),
    ).rejects.toMatchObject({ code: 'E_PERMISSION_DENIED' });
    expect(opened).toEqual([screenshot]);
  });

  it('重启恢复只中断未完成的运行', () => {
    const base: RpaRun = {
      id: 'queued',
      workflowId: 'workflow-1',
      profileId: 'profile-1',
      status: 'queued',
      artifacts: [],
    };
    repository.saveRun(base);
    repository.saveRun({ ...base, id: 'running', status: 'running' });
    repository.saveRun({ ...base, id: 'done', status: 'succeeded' });

    expect(repository.recoverActiveRuns()).toBe(2);
    expect(repository.getRun('queued')).toMatchObject({ status: 'failed' });
    expect(repository.getRun('running')).toMatchObject({ status: 'failed' });
    expect(repository.getRun('done')?.status).toBe('succeeded');
    expect(repository.getRun('queued')?.finishedAt).toBeDefined();
    expect(repository.recoverActiveRuns()).toBe(0);
  });
});
