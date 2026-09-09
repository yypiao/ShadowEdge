import { useEffect } from 'react';
import { useStore } from '../store.js';

export function App() {
  const { profiles, sidebar, setSidebar, setProfiles } = useStore();

  useEffect(() => {
    void window.shadowedge.api['profile:list'](undefined).then(setProfiles);

    return window.shadowedge.on['profile:status']((payload) => {
      useStore.setState((state) => ({
        profiles: state.profiles.map((p) =>
          p.id === payload.profileId ? { ...p, status: payload.status } : p,
        ),
      }));
    });
  }, [setProfiles]);

  const tabs = [
    { key: 'profiles', label: '环境管理' },
    { key: 'proxies', label: '代理' },
    { key: 'rpa', label: '自动化' },
    { key: 'settings', label: '设置' },
  ] as const;

  return (
    <div style={{ display: 'flex', height: '100vh', fontFamily: 'system-ui, sans-serif' }}>
      <nav style={{ width: 200, padding: 16, borderRight: '1px solid #e5e7eb', background: '#fafafa' }}>
        <h1 style={{ fontSize: 18, fontWeight: 700, marginBottom: 20 }}>ShadowEdge</h1>
        {tabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setSidebar(tab.key)}
            style={{
              display: 'block',
              width: '100%',
              padding: '8px 12px',
              marginBottom: 4,
              borderRadius: 6,
              border: 'none',
              cursor: 'pointer',
              background: sidebar === tab.key ? '#1976d2' : 'transparent',
              color: sidebar === tab.key ? '#fff' : '#333',
              fontSize: 14,
              textAlign: 'left',
            }}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      <main style={{ flex: 1, padding: 24, overflow: 'auto' }}>
        <h2 style={{ marginBottom: 16 }}>环境列表</h2>
        {profiles.length === 0 ? (
          <p style={{ color: '#888' }}>暂无环境。创建第一个隔离环境即可开始。</p>
        ) : (
          <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>
            {profiles.map((profile) => (
              <article
                key={profile.id}
                style={{ padding: 16, borderRadius: 8, border: '1px solid #e5e7eb', background: '#fff' }}
              >
                <strong>{profile.name}</strong>
                <div style={{ fontSize: 12, color: '#666', marginTop: 4 }}>
                  {profile.platformTag ?? '通用'} · {profile.status}
                </div>
                <div style={{ fontSize: 11, color: '#999', marginTop: 6, wordBreak: 'break-all' }}>
                  {profile.fingerprint.userAgent}
                </div>
              </article>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
