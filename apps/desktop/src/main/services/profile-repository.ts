import type { BrowserProfile, Uuid } from '@shadowedge/core';
import { allRows, getRow, type ShadowEdgeDb } from './db.js';

interface ProfileRow {
  id: string;
  org_id: string;
  name: string;
  platform_tag: string | null;
  group_id: string | null;
  kernel: string;
  fingerprint: string;
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
    groupId: row.group_id ?? undefined,
    kernel: row.kernel as BrowserProfile['kernel'],
    fingerprint: JSON.parse(row.fingerprint) as BrowserProfile['fingerprint'],
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

/** 环境仓储：BrowserProfile 的 SQLite 持久化。fingerprint 整列 JSON 存储，保证逐字节可复现。 */
export class ProfileRepository {
  constructor(private readonly handle: ShadowEdgeDb) {}

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
        `INSERT INTO profiles (id, org_id, name, platform_tag, group_id, kernel, fingerprint, proxy_id,
           owner_id, shared_with, storage, startup_urls, notes, status, last_used_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           org_id=excluded.org_id, name=excluded.name, platform_tag=excluded.platform_tag,
           group_id=excluded.group_id, kernel=excluded.kernel, fingerprint=excluded.fingerprint,
           proxy_id=excluded.proxy_id, owner_id=excluded.owner_id, shared_with=excluded.shared_with,
           storage=excluded.storage, startup_urls=excluded.startup_urls, notes=excluded.notes,
           status=excluded.status, last_used_at=excluded.last_used_at, updated_at=excluded.updated_at`,
      )
      .run(
        profile.id,
        profile.orgId,
        profile.name,
        profile.platformTag ?? null,
        profile.groupId ?? null,
        profile.kernel,
        JSON.stringify(profile.fingerprint),
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

  delete(id: Uuid): void {
    this.handle.db.prepare('DELETE FROM profiles WHERE id = ?').run(id);
  }
}
