import { useEffect, useState } from 'react';
import type { BrowserProfile } from '@shadowedge/core';
import { CreateProfileDialog } from '../components/CreateProfileDialog.js';
import { EditProfileDialog } from '../components/EditProfileDialog.js';
import { ProfileBackupDialog } from '../components/ProfileBackupDialog.js';
import { toastError, useStore } from '../store.js';

const STATUS_LABEL: Record<string, string> = {
  idle: '空闲', launching: '启动中', running: '运行中', syncing: '同步中', error: '异常',
};
const STATUS_COLOR: Record<string, string> = {
  idle: '#6b7280', launching: '#ed6c02', running: '#2e7d32', syncing: '#1976d2', error: '#d32f2f',
};

export function ProfilesPage() {
  const { profiles, groups, proxies, setProfiles, setGroups } = useStore();
  const [creating, setCreating] = useState(false);
  const [kernels, setKernels] = useState<Record<string, string | undefined>>({});
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchBusy, setBatchBusy] = useState<'launch' | 'close' | null>(null);
  const [editing, setEditing] = useState<BrowserProfile | null>(null);
  const [keyword, setKeyword] = useState('');
  const [groupFilter, setGroupFilter] = useState('');
  const [newGroupName, setNewGroupName] = useState('');
  const [backup, setBackup] = useState<{ mode: 'export' | 'import'; profileId?: string } | null>(null);

  useEffect(() => {
    setSelectedIds((current) => {
      const next = new Set(
        [...current].filter((id) => profiles.some((profile) => profile.id === id)),
      );
      return next.size === current.size ? current : next;
    });
  }, [profiles]);

  const refresh = async () => {
    setProfiles(await window.shadowedge.api['profile:list'](undefined));
  };

  const createGroup = async () => {
    if (!newGroupName.trim()) return;
    try {
      await window.shadowedge.api['profileGroup:save']({ name: newGroupName });
      setGroups(await window.shadowedge.api['profileGroup:list'](undefined));
      setNewGroupName('');
      useStore.getState().toast('info', '环境分组已创建');
    } catch (error) {
      toastError(error);
    }
  };

  const deleteGroup = async () => {
    if (!groupFilter || !window.confirm('删除分组不会删除环境，组内环境将变为未分组。是否继续？')) return;
    try {
      await window.shadowedge.api['profileGroup:delete'](groupFilter);
      setGroups(await window.shadowedge.api['profileGroup:list'](undefined));
      setProfiles(await window.shadowedge.api['profile:list'](undefined));
      setGroupFilter('');
    } catch (error) {
      toastError(error);
    }
  };

  const remove = async (profile: BrowserProfile) => {
    if (!window.confirm(`确定删除环境「${profile.name}」吗？本地浏览器数据、账号凭据和待恢复快照将一并删除，此操作不可撤销。`)) return;
    try {
      await window.shadowedge.api['profile:delete'](profile.id);
      setSelectedIds((current) => {
        const next = new Set(current);
        next.delete(profile.id);
        return next;
      });
      await refresh();
      useStore.getState().toast('info', `环境「${profile.name}」及其本地数据已删除`);
    } catch (error) {
      toastError(error);
    }
  };

  const launch = async (profileId: string) => {
    try {
      const result = await window.shadowedge.api['profile:launch']({ profileId });
      setKernels((current) => ({ ...current, [profileId]: result.kernelUsed }));
      if (result.kernelUsed === 'patchright-chromium') {
        useStore.getState().toast('warn', '自研内核不可用，本次已明确回退 Patchright');
      }
    } catch (error) {
      toastError(error);
    }
  };

  const close = async (profileId: string) => {
    try {
      await window.shadowedge.api['profile:close'](profileId);
    } catch (error) {
      toastError(error);
    }
  };

  const visibleProfiles = profiles.filter((profile) =>
    (!groupFilter || profile.groupId === groupFilter) &&
    (!keyword.trim() || profile.name.toLowerCase().includes(keyword.trim().toLowerCase())),
  );
  const selectedProfiles = visibleProfiles.filter((profile) => selectedIds.has(profile.id));
  const launchTargets = selectedProfiles.filter(
    (profile) => profile.status !== 'running' && profile.status !== 'launching',
  );
  const closeTargets = selectedProfiles.filter(
    (profile) => profile.status === 'running' || profile.status === 'launching',
  );

  const launchSelected = async () => {
    if (launchTargets.length === 0 || batchBusy) return;
    setBatchBusy('launch');
    try {
      const results = await window.shadowedge.api['profile:launchMany']({
        items: launchTargets.map((profile) => ({ profileId: profile.id })),
      });
      let fallbackCount = 0;
      for (const result of results) {
        if (!result.ok) continue;
        setKernels((current) => ({
          ...current,
          [result.value.profileId]: result.value.kernelUsed,
        }));
        if (result.value.kernelUsed === 'patchright-chromium') fallbackCount += 1;
      }
      const failed = results.length - results.filter((result) => result.ok).length;
      const firstError = results.find((result) => !result.ok);
      useStore.getState().toast(
        failed > 0 || fallbackCount > 0 ? 'warn' : 'info',
        `批量启动：成功 ${results.length - failed} 个，失败 ${failed} 个` +
          `${fallbackCount > 0 ? `，${fallbackCount} 个回退 Patchright` : ''}` +
          `${firstError && !firstError.ok ? `；${firstError.error.message}` : ''}`,
      );
      await refresh();
    } catch (error) {
      toastError(error);
    } finally {
      setBatchBusy(null);
    }
  };

  const closeSelected = async () => {
    if (closeTargets.length === 0 || batchBusy) return;
    setBatchBusy('close');
    try {
      const results = await window.shadowedge.api['profile:closeMany']({
        profileIds: closeTargets.map((profile) => profile.id),
      });
      const failed = results.length - results.filter((result) => result.ok).length;
      const firstError = results.find((result) => !result.ok);
      useStore.getState().toast(
        failed > 0 ? 'warn' : 'info',
        `批量停止：成功 ${results.length - failed} 个，失败 ${failed} 个` +
          `${firstError && !firstError.ok ? `；${firstError.error.message}` : ''}`,
      );
      await refresh();
    } catch (error) {
      toastError(error);
    } finally {
      setBatchBusy(null);
    }
  };

  const toggleSelected = (profileId: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(profileId)) next.delete(profileId);
      else next.add(profileId);
      return next;
    });
  };

  const proxyLabel = (proxyId?: string) => proxies.find((p) => p.id === proxyId)?.label;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>环境列表</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" onClick={() => setBackup({ mode: 'import' })} style={{ padding: '8px 16px', borderRadius: 6, border: '1px solid #1976d2', background: '#fff', color: '#1976d2', cursor: 'pointer', fontSize: 13 }}>导入环境</button>
          <button
            type="button"
            onClick={() => setCreating(true)}
            style={{ padding: '8px 16px', borderRadius: 6, border: 'none', background: '#1976d2', color: '#fff', cursor: 'pointer', fontSize: 13 }}
          >+ 新建 / 批量创建</button>
        </div>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 12, padding: 12, border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff' }}>
        <input aria-label="搜索环境" placeholder="搜索环境名称" value={keyword} onChange={(event) => setKeyword(event.target.value)} style={{ padding: 8, minWidth: 180, flex: 1 }} />
        <select aria-label="按分组筛选" value={groupFilter} onChange={(event) => setGroupFilter(event.target.value)} style={{ padding: 8 }}>
          <option value="">全部分组</option>
          {groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
        </select>
        {groupFilter && <button type="button" onClick={() => void deleteGroup()}>删除当前分组</button>}
        <input aria-label="新分组名称" placeholder="新分组名称" value={newGroupName} onChange={(event) => setNewGroupName(event.target.value)} style={{ padding: 8, width: 140 }} />
        <button type="button" disabled={!newGroupName.trim()} onClick={() => void createGroup()}>创建分组</button>
      </div>
      {profiles.length === 0 ? (
        <p style={{ color: '#888' }}>暂无环境。点击「新建 / 批量创建」创建第一个隔离环境。</p>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, padding: '10px 12px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', fontSize: 13 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input
                aria-label="全选环境"
                type="checkbox"
                checked={visibleProfiles.length > 0 && selectedProfiles.length === visibleProfiles.length}
                onChange={() => setSelectedIds(
                  selectedProfiles.length === visibleProfiles.length
                    ? new Set()
                    : new Set(visibleProfiles.map((profile) => profile.id)),
                )}
              />
              全选
            </label>
            <span style={{ color: '#666' }}>已选 {selectedProfiles.length} 项</span>
            <button
              type="button"
              disabled={launchTargets.length === 0 || batchBusy !== null}
              onClick={() => void launchSelected()}
              style={{ padding: '6px 12px', borderRadius: 6, border: 'none', background: '#2e7d32', color: '#fff', cursor: 'pointer', opacity: launchTargets.length === 0 || batchBusy !== null ? 0.5 : 1 }}
            >
              {batchBusy === 'launch' ? '批量启动中…' : `批量启动${launchTargets.length > 0 ? ` (${launchTargets.length})` : ''}`}
            </button>
            <button
              type="button"
              disabled={closeTargets.length === 0 || batchBusy !== null}
              onClick={() => void closeSelected()}
              style={{ padding: '6px 12px', borderRadius: 6, border: '1px solid #d32f2f', background: '#fff', color: '#d32f2f', cursor: 'pointer', opacity: closeTargets.length === 0 || batchBusy !== null ? 0.5 : 1 }}
            >
              {batchBusy === 'close' ? '批量停止中…' : `批量停止${closeTargets.length > 0 ? ` (${closeTargets.length})` : ''}`}
            </button>
          </div>
          <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>
            {visibleProfiles.map((profile) => {
              const selected = selectedIds.has(profile.id);
              return (
                <article key={profile.id} style={{ padding: 16, borderRadius: 8, border: `1px solid ${selected ? '#1976d2' : '#e5e7eb'}`, background: selected ? '#f5f9ff' : '#fff' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
                      <input
                        aria-label={`选择环境 ${profile.name}`}
                        type="checkbox"
                        checked={selected}
                        onChange={() => toggleSelected(profile.id)}
                      />
                      <strong style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{profile.name}</strong>
                    </label>
                    <span style={{ fontSize: 12, color: STATUS_COLOR[profile.status], flexShrink: 0 }}>
                      ● {STATUS_LABEL[profile.status] ?? profile.status}
                    </span>
                  </div>
                  <div style={{ fontSize: 12, color: '#666', marginTop: 4 }}>
                    {profile.platformTag ?? '通用'} · {groups.find((group) => group.id === profile.groupId)?.name ?? '未分组'} · {proxyLabel(profile.proxyId) ?? '直连'}
                    {kernels[profile.id] && <span> · 内核：{kernels[profile.id]}</span>}
                  </div>
                  <div style={{ fontSize: 11, color: '#999', marginTop: 6, wordBreak: 'break-all' }}>
                    {profile.fingerprint.userAgent}
                  </div>
                  <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                    {profile.status === 'running' || profile.status === 'launching' ? (
                      <button
                        type="button"
                        disabled={batchBusy !== null}
                        onClick={() => void close(profile.id)}
                        style={{ flex: 1, padding: '6px 0', borderRadius: 6, border: '1px solid #d32f2f', color: '#d32f2f', background: '#fff', cursor: 'pointer', fontSize: 12 }}
                      >
                        停止
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={batchBusy !== null}
                        onClick={() => void launch(profile.id)}
                        style={{ flex: 1, padding: '6px 0', borderRadius: 6, border: 'none', background: '#2e7d32', color: '#fff', cursor: 'pointer', fontSize: 12 }}
                      >
                        启动
                      </button>
                    )}
                    <button type="button" disabled={batchBusy !== null} onClick={() => setEditing(profile)} style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid #d1d5db', color: '#444', background: '#fff', cursor: 'pointer', fontSize: 12 }}>编辑</button>
                    {profile.status === 'running' && (
                      <button type="button" disabled={batchBusy !== null} onClick={() => setBackup({ mode: 'export', profileId: profile.id })} style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid #d1d5db', color: '#444', background: '#fff', cursor: 'pointer', fontSize: 12 }}>加密备份</button>
                    )}
                    {profile.status !== 'running' && profile.status !== 'launching' && (
                      <button type="button" disabled={batchBusy !== null} onClick={() => void remove(profile)} style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid #d32f2f', color: '#d32f2f', background: '#fff', cursor: 'pointer', fontSize: 12 }}>删除</button>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
          {visibleProfiles.length === 0 && <p style={{ color: '#888' }}>没有符合当前搜索或分组条件的环境。</p>}
        </>
      )}

      {creating && (
        <CreateProfileDialog
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            void refresh();
          }}
        />
      )}

      {editing && (
        <EditProfileDialog profile={editing} onClose={() => setEditing(null)} onSaved={() => void refresh()} />
      )}

      {backup && (
        <ProfileBackupDialog
          mode={backup.mode}
          profileId={backup.profileId}
          onClose={() => setBackup(null)}
          onImported={() => void refresh()}
        />
      )}
    </div>
  );
}
