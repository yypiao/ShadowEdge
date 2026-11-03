import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createConsoleLogger } from '@shadowedge/core';
import { EnvelopeCrypto } from '@shadowedge/crypto';
import { createHandlers } from '../src/main/handlers.js';
import { AccountRepository } from '../src/main/services/account-repository.js';
import { RpaRepository } from '../src/main/services/rpa-repository.js';
import { StorageStateRepository } from '../src/main/services/storage-state-repository.js';
import { openDatabase } from '../src/main/services/db.js';
import { KernelRuntimeService } from '../src/main/services/kernel-runtime.js';
import { AuditLog, SessionRepository } from '../src/main/services/local-records.js';
import { ProfileRepository } from '../src/main/services/profile-repository.js';
import { ProxyRepository } from '../src/main/services/proxy-repository.js';

const executablePath = process.env.SHADOWEDGE_KERNEL_EXECUTABLE;
const SMOKE = process.env.SHADOWEDGE_SMOKE === '1' && executablePath !== undefined;

describe.skipIf(!SMOKE)('真实 Chromium 批量环境生命周期', () => {
  it('两个环境独立启动，中间失败不阻断，最后批量回收', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shadowedge-profile-batch-smoke-'));
    const handle = openDatabase(':memory:');
    const crypto = new EnvelopeCrypto('55'.repeat(32));
    const profiles = new ProfileRepository(handle);
    const runtime = new KernelRuntimeService(join(dir, 'config'), {});
    runtime.configure({ executablePath, fallbackPolicy: 'require-chromium-cdp' });
    const handlers = createHandlers({
      logger: createConsoleLogger({ test: 'profile-batch-smoke' }),
      emit: () => undefined,
      profileRepo: profiles,
      proxyRepo: new ProxyRepository(handle, crypto),
      accountRepo: new AccountRepository(handle, crypto),
      rpaRepo: new RpaRepository(handle),
      storageStateRepo: new StorageStateRepository(handle, crypto),
      audit: new AuditLog(handle),
      sessions: new SessionRepository(handle),
      kernelRuntime: runtime,
      rpaArtifactsDir: join(dir, 'artifacts'),
    });
    const profileIds: string[] = [];
    try {
      const created = await handlers['profile:createMany']({
        items: [
          { name: 'batch-real-a', fingerprintSeed: 'batch-real-a' },
          { name: 'batch-real-b', fingerprintSeed: 'batch-real-b' },
        ],
      });
      for (const result of created) {
        expect(result.ok).toBe(true);
        if (result.ok) profileIds.push(result.value.id);
      }
      const launched = await handlers['profile:launchMany']({
        items: [
          { profileId: profileIds[0]! },
          { profileId: 'missing-profile' },
          { profileId: profileIds[1]! },
        ],
      });
      expect(launched.map((result) => result.ok)).toEqual([true, false, true]);
      expect(launched[1]).toMatchObject({
        ok: false,
        error: { code: 'E_PROFILE_NOT_FOUND' },
      });
      for (const index of [0, 2]) {
        const result = launched[index]!;
        expect(result).toMatchObject({ ok: true });
        if (result.ok) expect(result.value.kernelUsed).toBe('chromium-cdp');
      }
      expect(profileIds.map((id) => profiles.get(id)?.status)).toEqual([
        'running',
        'running',
      ]);

      const closed = await handlers['profile:closeMany']({ profileIds });
      expect(closed.map((result) => result.ok)).toEqual([true, true]);
      expect(profileIds.map((id) => profiles.get(id)?.status)).toEqual(['idle', 'idle']);
    } finally {
      if (profileIds.length > 0) await handlers['profile:closeMany']({ profileIds });
      for (const id of profileIds) rmSync(join('profiles', id), { recursive: true, force: true });
      handle.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90000);
});
