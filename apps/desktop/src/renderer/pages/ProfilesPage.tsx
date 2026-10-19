import { useState } from 'react';
import { CreateProfileDialog } from '../components/CreateProfileDialog.js';
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

  const refresh = async () => {
    setProfiles(await window.shadowedge.api['profile:list'](undefined));
  };

  const launch = async (profileId: string) => {
    try {
      await window.shadowedge.api['profile:launch']({ profileId });
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

  const proxyLabel = (proxyId?: string) => proxies.find((p) => p.id === proxyId)?.label;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>环境列表</h2>
        <button
          type="button"
          onClick={() => setCreating(true)}
          style={{ padding: '8px 16px', borderRadius: 6, border: 'none', background: '#1976d2', color: '#fff', cursor: 'pointer', fontSize: 13 }}
        >
          + 新建环境
        </button>
      </div>

      {profiles.length === 0 ? (
        <p style={{ color: '#888' }}>暂无环境。点击「新建环境」创建第一个隔离环境。</p>
      ) : (
        <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>
          {profiles.map((profile) => (
            <article key={profile.id} style={{ padding: 16, borderRadius: 8, border: '1px solid #e5e7eb', background: '#fff' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <strong>{profile.name}</strong>
                <span style={{ fontSize: 12, color: STATUS_COLOR[profile.status] }}>
                  ● {STATUS_LABEL[profile.status] ?? profile.status}
                </span>
              </div>
              <div style={{ fontSize: 12, color: '#666', marginTop: 4 }}>
                {profile.platformTag ?? '通用'} · {proxyLabel(profile.proxyId) ?? '直连'}
              </div>
              <div style={{ fontSize: 11, color: '#999', marginTop: 6, wordBreak: 'break-all' }}>
                {profile.fingerprint.userAgent}
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                {profile.status === 'running' || profile.status === 'launching' ? (
                  <button
                    type="button"
                    onClick={() => void close(profile.id)}
                    style={{ flex: 1, padding: '6px 0', borderRadius: 6, border: '1px solid #d32f2f', color: '#d32f2f', background: '#fff', cursor: 'pointer', fontSize: 12 }}
                  >
                    停止
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => void launch(profile.id)}
                    style={{ flex: 1, padding: '6px 0', borderRadius: 6, border: 'none', background: '#2e7d32', color: '#fff', cursor: 'pointer', fontSize: 12 }}
                  >
                    启动
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
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
    </div>
  );
}
