import type { IsoDateTime, LaunchResult, Uuid } from '@shadowedge/core';
import type { ShadowEdgeDb } from './db.js';

/** 本地审计日志：谁在何时对什么资源做了什么。哈希链防篡改在 server 端实现，本地先保证完整性。 */
export class AuditLog {
  constructor(private readonly handle: ShadowEdgeDb) {}

  record(action: string, targetType: 'profile' | 'proxy' | 'session' | 'rpa' | 'sync', targetId?: string, detail?: unknown): void {
    this.handle.db
      .prepare('INSERT INTO audit_local (at, actor, action, target_type, target_id, detail) VALUES (?, ?, ?, ?, ?, ?)')
      .run(new Date().toISOString(), 'local-user', action, targetType, targetId ?? null, detail === undefined ? null : JSON.stringify(detail));
  }
}

/** 会话记录：每次环境启动/关闭留痕，用于崩溃恢复与操作时间线。 */
export class SessionRepository {
  constructor(private readonly handle: ShadowEdgeDb) {}

  start(result: LaunchResult): void {
    this.handle.db
      .prepare('INSERT INTO sessions (id, profile_id, pid, ws_endpoint, started_at) VALUES (?, ?, ?, ?, ?)')
      .run(result.sessionId, result.profileId, result.pid, result.wsEndpoint ?? null, result.startedAt);
  }

  end(profileId: Uuid, endedAt: IsoDateTime = new Date().toISOString()): void {
    this.handle.db
      .prepare('UPDATE sessions SET ended_at = ? WHERE profile_id = ? AND ended_at IS NULL')
      .run(endedAt, profileId);
  }

  /** 应用重启后调用：上次异常退出留下的未关闭会话统一标记结束。 */
  sweepOrphans(endedAt: IsoDateTime = new Date().toISOString()): number {
    const r = this.handle.db.prepare('UPDATE sessions SET ended_at = ? WHERE ended_at IS NULL').run(endedAt);
    return Number(r.changes);
  }
}
