import type { BrowserProfile, Uuid } from '@shadowedge/core';
import { allRows, getRow, type ShadowEdgeDb } from './db.js';

interface ProfileRow {
  id: string;
  org_id: string;
  name: string;
  platform_tag: string | null;
  platform_site_id: string | null;
  kernel_version: string | null;
  kernel_upgrade_source_id: string | null;
  group_id: string | null;
  kernel: string;
  fingerprint: string;
  catalog_version: string | null;
  proxy_id: string | null;
  owner_id: string;
  shared_with: string;
  storage: string;
  startup_urls: string;
  notes: string | null;
  status: string;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

function rowToProfile(row: ProfileRow): BrowserProfile {
  return {
    id: row.id,
    orgId: row.org_id,
    name: row.name,
    platformTag: row.platform_tag ?? undefined,
    platformSiteId: row.platform_site_id ?? undefined,
    kernelVersion: row.kernel_version ?? undefined,
    kernelUpgradeSourceId: row.kernel_upgrade_source_id ?? undefined,
    groupId: row.group_id ?? undefined,
    kernel: row.kernel as BrowserProfile['kernel'],
    fingerprint: rowToFingerprint(row),
    proxyId: row.proxy_id ?? undefined,
    ownerId: row.owner_id,
    sharedWith: JSON.parse(row.shared_with) as BrowserProfile['sharedWith'],
    storage: JSON.parse(row.storage) as BrowserProfile['storage'],
    startupUrls: JSON.parse(row.startup_urls) as string[],
    notes: row.notes ?? undefined,
    status: row.status as BrowserProfile['status'],
    lastUsedAt: row.last_used_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToFingerprint(row: ProfileRow): BrowserProfile['fingerprint'] {
  const fingerprint = JSON.parse(row.fingerprint) as BrowserProfile['fingerprint'];
  // 迁移前的极端旧快照兜底；正常迁移已在 DB 层完成并记录日志。
  fingerprint.catalogVersion ??= row.catalog_version ?? '131.0.6778.86';
  return fingerprint;
}

/** 环境仓储：BrowserProfile 的 SQLite 持久化。fingerprint 整列 JSON 存储，保证逐字节可复现。 */
export class ProfileRepository {
  constructor(private readonly handle: ShadowEdgeDb) {}

  transaction<T>(fn: () => T): T {
    return this.handle.transaction(fn);
  }

  list(query?: { groupId?: Uuid; keyword?: string }): BrowserProfile[] {
    const rows = allRows<ProfileRow>(this.handle.db, 'SELECT * FROM profiles ORDER BY updated_at DESC');
    const all = rows.map(rowToProfile);
    if (!query) return all;
    return all.filter(
      (p) =>
        (!query.groupId || p.groupId === query.groupId) &&
        (!query.keyword || p.name.toLowerCase().includes(query.keyword.toLowerCase())),
    );
  }

  get(id: Uuid): BrowserProfile | undefined {
    const row = getRow<ProfileRow>(this.handle.db, 'SELECT * FROM profiles WHERE id = ?', id);
    return row ? rowToProfile(row) : undefined;
  }

  save(profile: BrowserProfile): void {
    this.handle.db
      .prepare(
        `INSERT INTO profiles (id, org_id, name, platform_tag, platform_site_id, kernel_version, kernel_upgrade_source_id, group_id, kernel, fingerprint, catalog_version, proxy_id,
           owner_id, shared_with, storage, startup_urls, notes, status, last_used_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           org_id=excluded.org_id, name=excluded.name, platform_tag=excluded.platform_tag,
           platform_site_id=excluded.platform_site_id, kernel_version=excluded.kernel_version,
           kernel_upgrade_source_id=excluded.kernel_upgrade_source_id,
           group_id=excluded.group_id, kernel=excluded.kernel, fingerprint=excluded.fingerprint,
           catalog_version=excluded.catalog_version, proxy_id=excluded.proxy_id, owner_id=excluded.owner_id, shared_with=excluded.shared_with,
           storage=excluded.storage, startup_urls=excluded.startup_urls, notes=excluded.notes,
           status=excluded.status, last_used_at=excluded.last_used_at, updated_at=excluded.updated_at`,
      )
      .run(
        profile.id,
        profile.orgId,
        profile.name,
        profile.platformTag ?? null,
        profile.platformSiteId ?? null,
        profile.kernelVersion ?? null,
        profile.kernelUpgradeSourceId ?? null,
        profile.groupId ?? null,
        profile.kernel,
        JSON.stringify(profile.fingerprint),
        profile.fingerprint.catalogVersion,
        profile.proxyId ?? null,
        profile.ownerId,
        JSON.stringify(profile.sharedWith),
        JSON.stringify(profile.storage),
        JSON.stringify(profile.startupUrls),
        profile.notes ?? null,
        profile.status,
        profile.lastUsedAt ?? null,
        profile.createdAt,
        profile.updatedAt,
      );
  }

  /** 仅在迁移或首次引入签名分发时回填；已有固定版本永不覆盖。 */
  pinMissingKernelVersions(version: string | undefined): number {
    if (!version) return 0;
    const missing = allRows<{ id: string }>(this.handle.db, 'SELECT id FROM profiles WHERE kernel_version IS NULL');
    if (missing.length === 0) return 0;
    return this.transaction(() => {
      const update = this.handle.db.prepare('UPDATE profiles SET kernel_version = ? WHERE id = ? AND kernel_version IS NULL');
      const audit = this.handle.db.prepare(
        "INSERT INTO audit_local (at, actor, action, target_type, target_id, detail) VALUES (?, 'system', 'migration:kernel-version', 'profile', ?, ?)",
      );
      let count = 0;
      for (const row of missing) {
        update.run(version, row.id);
        audit.run(new Date().toISOString(), row.id, JSON.stringify({ kernelVersion: version }));
        count += 1;
      }
      return count;
    });
  }

  delete(id: Uuid): void {
    this.handle.db.prepare('DELETE FROM profiles WHERE id = ?').run(id);
  }

  clearGroup(groupId: Uuid): void {
    this.handle.db.prepare('UPDATE profiles SET group_id = NULL WHERE group_id = ?').run(groupId);
  }

  /** 进程重启后没有可恢复的运行上下文，持久化的活跃状态必须统一归零。 */
  resetActiveStatuses(): number {
    const result = this.handle.db
      .prepare("UPDATE profiles SET status = 'idle' WHERE status IN ('running', 'launching')")
      .run();
    return Number(result.changes);
  }
}
