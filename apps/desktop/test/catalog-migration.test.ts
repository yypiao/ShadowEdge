import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createConsoleLogger } from '@shadowedge/core';
import { EnvelopeCrypto } from '@shadowedge/crypto';
import {
  auditFingerprint,
  CURRENT_CATALOG_VERSION,
  generateFingerprint,
} from '@shadowedge/fingerprint';
import { openDatabase, type ShadowEdgeDb } from '../src/main/services/db.js';
import { ProfileRepository } from '../src/main/services/profile-repository.js';
import { GroupRepository } from '../src/main/services/group-repository.js';
import { ProxyRepository } from '../src/main/services/proxy-repository.js';
import { AccountRepository } from '../src/main/services/account-repository.js';
import { RpaRepository } from '../src/main/services/rpa-repository.js';
import { StorageStateRepository } from '../src/main/services/storage-state-repository.js';
import { AuditLog, SessionRepository } from '../src/main/services/local-records.js';
import { KernelRuntimeService } from '../src/main/services/kernel-runtime.js';
import { createHandlers } from '../src/main/handlers.js';

describe('catalogVersion 数据库迁移', () => {
  let dir: string;
  let handle: ShadowEdgeDb | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'shadowedge-catalog-migration-'));
  });

  afterEach(() => {
    handle?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('旧画像回填 131、保留全部字段并写迁移审计', () => {
    const path = join(dir, 'legacy.db');
    handle = openDatabase(path);
    const profiles = new ProfileRepository(handle);
    const now = new Date().toISOString();
    const original = generateFingerprint({ seed: 'legacy-db', platform: 'macos' });
    profiles.save({
      id: 'legacy',
      orgId: 'local',
      name: 'legacy',
      kernel: 'chromium-patched',
      fingerprint: original,
      ownerId: 'local',
      sharedWith: [],
      storage: { userDataDir: 'profiles/legacy', remoteRevision: 0, syncMode: 'local-only' },
      startupUrls: [],
      status: 'idle',
      createdAt: now,
      updatedAt: now,
    });
    const legacyFingerprint = { ...original } as Record<string, unknown>;
    delete legacyFingerprint.catalogVersion;
    handle.db
      .prepare('UPDATE profiles SET fingerprint = ? WHERE id = ?')
      .run(JSON.stringify(legacyFingerprint), 'legacy');
    handle.db.exec('ALTER TABLE profiles DROP COLUMN catalog_version');
    handle.db.exec('DELETE FROM schema_migrations WHERE id = 2');
    handle.close();

    handle = openDatabase(path);
    const restored = new ProfileRepository(handle).get('legacy');
    expect(restored?.fingerprint.catalogVersion).toBe('131.0.6778.86');
    expect(restored?.fingerprint).toEqual(original);
    const audit = handle.db
      .prepare(
        "SELECT detail FROM audit_local WHERE action = 'migration:catalog-version' AND target_id = 'legacy'",
      )
      .get() as { detail: string };
    expect(JSON.parse(audit.detail)).toEqual({ catalogVersion: '131.0.6778.86' });
  });

  it('桌面创建的新环境落库为 156，重启后审计仍通过', async () => {
    const path = join(dir, 'current.db');
    handle = openDatabase(path);
    const profiles = new ProfileRepository(handle);
    const handlers = createHandlers({
      logger: createConsoleLogger({ test: 'catalog-create' }),
      emit: () => undefined,
      profileRepo: profiles,
      groupRepo: new GroupRepository(handle),
      proxyRepo: new ProxyRepository(handle, new EnvelopeCrypto('00'.repeat(32))),
      accountRepo: new AccountRepository(handle, new EnvelopeCrypto('00'.repeat(32))),
      rpaRepo: new RpaRepository(handle),
      storageStateRepo: new StorageStateRepository(handle, new EnvelopeCrypto('00'.repeat(32))),
      audit: new AuditLog(handle),
      sessions: new SessionRepository(handle),
      kernelRuntime: new KernelRuntimeService(join(dir, 'runtime'), {}),
    });
    const created = await handlers['profile:create']({
      name: 'current-156',
      platform: 'host',
      fingerprintSeed: 'current-db-156',
    });
    expect(created.fingerprint.catalogVersion).toBe(CURRENT_CATALOG_VERSION);
    expect(
      handle.db.prepare('SELECT catalog_version FROM profiles WHERE id = ?').get(created.id),
    ).toEqual({ catalog_version: CURRENT_CATALOG_VERSION });
    handle.close();

    handle = openDatabase(path);
    const restored = new ProfileRepository(handle).get(created.id);
    expect(restored?.fingerprint).toEqual(created.fingerprint);
    expect(auditFingerprint(restored!.fingerprint)).toEqual({ consistent: true, issues: [] });
  });
});
