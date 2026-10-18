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

  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  const applied = new Set(allRows<{ id: number }>(db, 'SELECT id FROM schema_migrations').map((r) => r.id));
  const insert = db.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)');
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    tx(db, () => {
      db.exec(m.sql);
      insert.run(m.id, m.name, new Date().toISOString());
    });
  }

  return { db, close: () => db.close() };
}
