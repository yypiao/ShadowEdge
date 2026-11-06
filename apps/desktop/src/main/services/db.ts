import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * 本地 SQLite 持久层，基于 Node 内置 node:sqlite（Electron 44 / Node 24+）。
 * 不引入原生编译依赖：本机无 Xcode CLT 也能开发与打包。
 * 迁移按序号递增，只追加不修改历史迁移。
 */

export interface ShadowEdgeDb {
  readonly db: DatabaseSync;
  transaction<T>(fn: () => T): T;
  close(): void;
}

type SqlParam = null | number | bigint | string | Uint8Array;

// SAFETY: node:sqlite 的 all/get 返回通用 Record 类型，行结构由调用点自己的 SQL 决定，
// 类型系统无法从 SQL 字符串推导行形状，统一在此做唯一的断言出口。
export function allRows<Row>(db: DatabaseSync, sql: string, ...params: SqlParam[]): Row[] {
  return db.prepare(sql).all(...params) as unknown as Row[];
}

// SAFETY: 同上，get 的单行版本。
export function getRow<Row>(db: DatabaseSync, sql: string, ...params: SqlParam[]): Row | undefined {
  return db.prepare(sql).get(...params) as unknown as Row | undefined;
}

interface Migration {
  id: number;
  name: string;
  sql: string;
  after?: (db: DatabaseSync) => void;
}

const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: 'init',
    sql: `
      CREATE TABLE meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE profiles (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        name TEXT NOT NULL,
        platform_tag TEXT,
        group_id TEXT,
        kernel TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        proxy_id TEXT,
        owner_id TEXT NOT NULL,
        shared_with TEXT NOT NULL DEFAULT '[]',
        storage TEXT NOT NULL,
        startup_urls TEXT NOT NULL DEFAULT '[]',
        notes TEXT,
        status TEXT NOT NULL DEFAULT 'idle',
        last_used_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_profiles_group ON profiles(group_id);
      CREATE INDEX idx_profiles_updated ON profiles(updated_at);

      CREATE TABLE proxies (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        label TEXT NOT NULL,
        protocol TEXT NOT NULL,
        host TEXT NOT NULL,
        port INTEGER NOT NULL,
        username TEXT,
        secret_ciphertext TEXT,
        secret_wrapped_key TEXT,
        secret_iv TEXT,
        sticky_session TEXT,
        upstream_id TEXT,
        tags TEXT NOT NULL DEFAULT '[]'
      );

      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        pid INTEGER,
        ws_endpoint TEXT,
        started_at TEXT NOT NULL,
        ended_at TEXT
      );
      CREATE INDEX idx_sessions_profile ON sessions(profile_id);

      CREATE TABLE audit_local (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id TEXT,
        detail TEXT
      );
      CREATE INDEX idx_audit_target ON audit_local(target_type, target_id);
    `,
  },
  {
    id: 2,
    name: 'fingerprint_catalog_version',
    sql: `ALTER TABLE profiles ADD COLUMN catalog_version TEXT;`,
    after: (db) => {
      const rows = allRows<{ id: string; fingerprint: string }>(
        db,
        'SELECT id, fingerprint FROM profiles',
      );
      const update = db.prepare(
        'UPDATE profiles SET fingerprint = ?, catalog_version = ? WHERE id = ?',
      );
      const log = db.prepare(
        "INSERT INTO audit_local (at, actor, action, target_type, target_id, detail) VALUES (?, 'system', 'migration:catalog-version', 'profile', ?, ?)",
      );
      for (const row of rows) {
        const value: unknown = JSON.parse(row.fingerprint);
        if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
        const fingerprint = value as Record<string, unknown>;
        if (typeof fingerprint.catalogVersion === 'string') {
          update.run(row.fingerprint, fingerprint.catalogVersion, row.id);
          continue;
        }
        const catalogVersion = '131.0.6778.86';
        fingerprint.catalogVersion = catalogVersion;
        const serialized = JSON.stringify(fingerprint);
        update.run(serialized, catalogVersion, row.id);
        log.run(new Date().toISOString(), row.id, JSON.stringify({ catalogVersion }));
      }
    },
  },
  {
    id: 3,
    name: 'account_credentials',
    sql: `
      CREATE TABLE account_credentials (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        label TEXT NOT NULL,
        origin TEXT NOT NULL,
        username TEXT NOT NULL,
        username_selector TEXT NOT NULL,
        password_selector TEXT NOT NULL,
        submit_selector TEXT,
        secret_ciphertext TEXT NOT NULL,
        secret_wrapped_key TEXT NOT NULL,
        secret_iv TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_account_profile ON account_credentials(profile_id);
    `,
  },
  {
    id: 4,
    name: 'rpa_workflows_and_runs',
    sql: `
      CREATE TABLE rpa_workflows (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        name TEXT NOT NULL,
        version INTEGER NOT NULL,
        graph TEXT NOT NULL,
        inputs_schema TEXT,
        created_by TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_rpa_workflows_updated ON rpa_workflows(updated_at);

      CREATE TABLE rpa_runs (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        error TEXT,
        outputs TEXT NOT NULL,
        artifacts TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_rpa_runs_created ON rpa_runs(created_at);
      CREATE INDEX idx_rpa_runs_workflow ON rpa_runs(workflow_id);
    `,
  },
  {
    id: 5,
    name: 'profile_pending_storage_states',
    sql: `
      CREATE TABLE profile_storage_states (
        profile_id TEXT PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
        state_ciphertext TEXT NOT NULL,
        state_wrapped_key TEXT NOT NULL,
        state_iv TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `,
  },
  {
    id: 6,
    name: 'profile_groups',
    sql: `
      CREATE TABLE profile_groups (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        name TEXT NOT NULL,
        color TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_profile_groups_name ON profile_groups(org_id, name);
      CREATE INDEX idx_profiles_group_id ON profiles(group_id);
    `,
  },
  {
    id: 7,
    name: 'profile_platform_site',
    sql: 'ALTER TABLE profiles ADD COLUMN platform_site_id TEXT',
  },
  {
    id: 8,
    name: 'profile_kernel_version_pinning',
    sql: `
      ALTER TABLE profiles ADD COLUMN kernel_version TEXT;
      ALTER TABLE profiles ADD COLUMN kernel_upgrade_source_id TEXT;
    `,
  },
  {
    id: 9,
    name: 'rpa_schedules',
    sql: `
      CREATE TABLE rpa_schedules (
        workflow_id TEXT PRIMARY KEY REFERENCES rpa_workflows(id) ON DELETE CASCADE,
        profile_ids TEXT NOT NULL,
        interval_minutes INTEGER NOT NULL,
        enabled INTEGER NOT NULL,
        next_run_at TEXT NOT NULL,
        last_run_at TEXT,
        last_error TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_rpa_schedules_due ON rpa_schedules(enabled, next_run_at);
    `,
  },
  {
    id: 10,
    name: 'rpa_schedule_encrypted_inputs',
    sql: `
      ALTER TABLE rpa_schedules ADD COLUMN inputs_ciphertext TEXT;
      ALTER TABLE rpa_schedules ADD COLUMN inputs_wrapped_key TEXT;
      ALTER TABLE rpa_schedules ADD COLUMN inputs_iv TEXT;
    `,
  },
  {
    id: 11,
    name: 'profile_platform_policy_version',
    sql: 'ALTER TABLE profiles ADD COLUMN platform_policy_version TEXT',
    after: (db) => {
      const rows = allRows<{ id: string }>(
        db,
        'SELECT id FROM profiles WHERE (platform_tag IS NOT NULL OR platform_site_id IS NOT NULL) AND platform_policy_version IS NULL',
      );
      const update = db.prepare('UPDATE profiles SET platform_policy_version = ? WHERE id = ?');
      const audit = db.prepare(
        "INSERT INTO audit_local (at, actor, action, target_type, target_id, detail) VALUES (?, 'system', 'migration:platform-policy-version', 'profile', ?, ?)",
      );
      for (const row of rows) {
        const catalogVersion = '2026-11-04.1';
        update.run(catalogVersion, row.id);
        audit.run(new Date().toISOString(), row.id, JSON.stringify({ catalogVersion }));
      }
    },
  },
];

function tx(db: DatabaseSync, fn: () => void): void {
  db.exec('BEGIN');
  try {
    fn();
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function openDatabase(path: string): ShadowEdgeDb {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');

  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)',
  );
  const applied = new Set(
    allRows<{ id: number }>(db, 'SELECT id FROM schema_migrations').map((r) => r.id),
  );
  const insert = db.prepare(
    'INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)',
  );
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    tx(db, () => {
      db.exec(m.sql);
      m.after?.(db);
      insert.run(m.id, m.name, new Date().toISOString());
    });
  }

  let transactionDepth = 0;
  return {
    db,
    transaction: <T>(fn: () => T): T => {
      if (transactionDepth > 0) return fn();
      db.exec('BEGIN IMMEDIATE');
      transactionDepth += 1;
      try {
        const result = fn();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      } finally {
        transactionDepth -= 1;
      }
    },
    close: () => db.close(),
  };
}
