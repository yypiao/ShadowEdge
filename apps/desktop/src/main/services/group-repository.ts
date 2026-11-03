import type { ProfileGroup, ProfileGroupInput, Uuid } from '@shadowedge/core';
import { ShadowEdgeError } from '@shadowedge/core';
import { allRows, getRow, type ShadowEdgeDb } from './db.js';

interface GroupRow {
  id: string;
  org_id: string;
  name: string;
  color: string | null;
  created_at: string;
  updated_at: string;
}

function toGroup(row: GroupRow): ProfileGroup {
  return {
    id: row.id,
    orgId: row.org_id,
    name: row.name,
    color: row.color ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class GroupRepository {
  constructor(private readonly handle: ShadowEdgeDb) {}

  list(): ProfileGroup[] {
    return allRows<GroupRow>(this.handle.db, 'SELECT * FROM profile_groups ORDER BY name').map(toGroup);
  }

  get(id: Uuid): ProfileGroup | undefined {
    const row = getRow<GroupRow>(this.handle.db, 'SELECT * FROM profile_groups WHERE id = ?', id);
    return row ? toGroup(row) : undefined;
  }

  save(input: ProfileGroupInput, id: Uuid): ProfileGroup {
    const name = input.name.trim();
    if (!name || name.length > 80) {
      throw new ShadowEdgeError('E_PROFILE_INVALID', '分组名称长度必须为 1–80 个字符');
    }
    if (input.color !== undefined && !/^#[0-9a-fA-F]{6}$/.test(input.color)) {
      throw new ShadowEdgeError('E_PROFILE_INVALID', '分组颜色必须是 #RRGGBB 格式');
    }
    const existing = this.get(id);
    const now = new Date().toISOString();
    const group: ProfileGroup = {
      id,
      orgId: 'local',
      name,
      color: input.color,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    try {
      this.handle.db.prepare(
        `INSERT INTO profile_groups (id, org_id, name, color, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, color=excluded.color,
           updated_at=excluded.updated_at`,
      ).run(group.id, group.orgId, group.name, group.color ?? null, group.createdAt, group.updatedAt);
    } catch (error) {
      throw new ShadowEdgeError('E_PROFILE_INVALID', '分组名称已存在或无法保存', { cause: error });
    }
    return group;
  }

  delete(id: Uuid): void {
    this.handle.db.prepare('DELETE FROM profile_groups WHERE id = ?').run(id);
  }
}
