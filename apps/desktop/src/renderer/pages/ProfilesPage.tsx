import { useEffect, useState } from 'react';
import { CreateProfileDialog } from '../components/CreateProfileDialog.js';
import { ProfileBackupDialog } from '../components/ProfileBackupDialog.js';
import { toastError, useStore } from '../store.js';

const STATUS_LABEL: Record<string, string> = {
  idle: '空闲', launching: '启动中', running: '运行中', syncing: '同步中', error: '异常',
};
const STATUS_COLOR: Record<string, string> = {
  idle: '#6b7280', launching: '#ed6c02', running: '#2e7d32', syncing: '#1976d2', error: '#d32f2f',
};

export function ProfilesPage() {
  const { profiles, proxies, setProfiles } = useStore();
  const [creating, setCreating] = useState(false);
  const [kernels, setKernels] = useState<Record<string, string | undefined>>({});
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchBusy, setBatchBusy] = useState<'launch' | 'close' | null>(null);
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

  const selectedProfiles = profiles.filter((profile) => selectedIds.has(profile.id));
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

      {profiles.length === 0 ? (
        <p style={{ color: '#888' }}>暂无环境。点击「新建 / 批量创建」创建第一个隔离环境。</p>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, padding: '10px 12px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', fontSize: 13 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input
                aria-label="全选环境"
                type="checkbox"
                checked={selectedProfiles.length === profiles.length}
                onChange={() => setSelectedIds(
                  selectedProfiles.length === profiles.length
                    ? new Set()
                    : new Set(profiles.map((profile) => profile.id)),
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
            {profiles.map((profile) => {
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
                    {profile.platformTag ?? '通用'} · {proxyLabel(profile.proxyId) ?? '直连'}
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
                    {profile.status === 'running' && (
                      <button type="button" disabled={batchBusy !== null} onClick={() => setBackup({ mode: 'export', profileId: profile.id })} style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid #d1d5db', color: '#444', background: '#fff', cursor: 'pointer', fontSize: 12 }}>加密备份</button>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
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
