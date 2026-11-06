import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LEGACY_PLATFORM_POLICY_CATALOG_VERSION,
  type BrowserProfile,
} from '@shadowedge/core';
import { generateFingerprint } from '@shadowedge/fingerprint';
import { openDatabase } from '../src/main/services/db.js';
import { ProfileRepository } from '../src/main/services/profile-repository.js';

function profile(): BrowserProfile {
  const now = new Date().toISOString();
  return {
    id: 'policy-migration', orgId: 'local', name: '历史 Amazon', platformTag: 'amazon',
    platformSiteId: 'amazon-us', platformPolicyVersion: '2026-11-06.1', kernel: 'chromium-cdp',
    fingerprint: generateFingerprint({ seed: 'policy-migration', platform: 'host' }),
    ownerId: 'local-user', sharedWith: [],
    storage: { userDataDir: 'profiles/policy-migration', remoteRevision: 0, syncMode: 'local-only' },
    startupUrls: ['https://www.amazon.com/'], status: 'idle', createdAt: now, updatedAt: now,
  };
}

describe('平台策略版本 SQLite 迁移', () => {
  it('历史环境只回填原始快照一次并写审计', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shadowedge-policy-migration-'));
    const path = join(dir, 'test.sqlite');
    try {
      const current = openDatabase(path);
      new ProfileRepository(current).save(profile());
      current.close();

      // 模拟 T45 前的数据库：已有环境，但没有 platform_policy_version 列和 migration 11。
      const legacy = new DatabaseSync(path);
      legacy.exec('ALTER TABLE profiles DROP COLUMN platform_policy_version');
      legacy.prepare('DELETE FROM schema_migrations WHERE id = 11').run();
      legacy.close();

      const migrated = openDatabase(path);
      const restored = new ProfileRepository(migrated).get('policy-migration');
      expect(restored?.platformPolicyVersion).toBe(LEGACY_PLATFORM_POLICY_CATALOG_VERSION);
      const audits = migrated.db.prepare(
        "SELECT detail FROM audit_local WHERE action = 'migration:platform-policy-version' AND target_id = 'policy-migration'",
      ).all();
      expect(audits).toHaveLength(1);
      migrated.close();

      const reopened = openDatabase(path);
      expect(new ProfileRepository(reopened).get('policy-migration')?.platformPolicyVersion)
        .toBe(LEGACY_PLATFORM_POLICY_CATALOG_VERSION);
      const auditCount = reopened.db.prepare(
        "SELECT COUNT(*) AS count FROM audit_local WHERE action = 'migration:platform-policy-version'",
      ).get();
      expect(auditCount).toMatchObject({ count: 1 });
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
