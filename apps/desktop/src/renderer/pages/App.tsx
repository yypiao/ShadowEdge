import { useEffect } from 'react';
import { Toasts } from '../components/Toasts.js';
import { useStore } from '../store.js';
import { ProfilesPage } from './ProfilesPage.js';
import { ProxiesPage } from './ProxiesPage.js';

export function App() {
  const { sidebar, setSidebar, setProfiles, setProxies, setProxyHealth, toast } = useStore();

  useEffect(() => {
    void window.shadowedge.api['profile:list'](undefined).then(setProfiles);
    void window.shadowedge.api['proxy:list'](undefined).then(setProxies);

    const unsubscribers = [
      window.shadowedge.on['profile:status']((payload) => {
        useStore.setState((state) => ({
          profiles: state.profiles.map((p) =>
            p.id === payload.profileId ? { ...p, status: payload.status } : p,
          ),
        }));
      }),
      window.shadowedge.on['proxy:health'](setProxyHealth),
      window.shadowedge.on['app:toast']((payload) => toast(payload.level, payload.message)),
    ];
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }, [setProfiles, setProxies, setProxyHealth, toast]);

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
        {sidebar === 'profiles' && <ProfilesPage />}
        {sidebar === 'proxies' && <ProxiesPage />}
        {sidebar === 'rpa' && <p style={{ color: '#888' }}>自动化编排将在 T7 落地。</p>}
        {sidebar === 'settings' && <p style={{ color: '#888' }}>设置页开发中。</p>}
      </main>

      <Toasts />
    </div>
  );
}
