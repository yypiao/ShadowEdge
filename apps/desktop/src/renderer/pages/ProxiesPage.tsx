import { useState } from 'react';
import { toastError, useStore } from '../store.js';

export function ProxiesPage() {
  const { proxies, proxyHealth, setProxies } = useStore();
  const [importText, setImportText] = useState('');
  const [importing, setImporting] = useState(false);
  const [checking, setChecking] = useState<Record<string, boolean>>({});

  const refresh = async () => {
    setProxies(await window.shadowedge.api['proxy:list'](undefined));
  };

  const importBulk = async () => {
    if (!importText.trim()) return;
    setImporting(true);
    try {
      const saved = await window.shadowedge.api['proxy:importBulk']({ text: importText, format: 'line' });
      useStore.getState().toast('info', `已导入 ${saved.length} 个代理`);
      setImportText('');
      await refresh();
    } catch (error) {
      toastError(error);
    } finally {
      setImporting(false);
    }
  };

  const check = async (id: string) => {
    setChecking((prev) => ({ ...prev, [id]: true }));
    try {
      await window.shadowedge.api['proxy:check'](id);
    } catch (error) {
      toastError(error);
    } finally {
      setChecking((prev) => ({ ...prev, [id]: false }));
    }
  };

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>代理管理</h2>

      <div style={{ marginBottom: 20, padding: 16, borderRadius: 8, border: '1px solid #e5e7eb', background: '#fff' }}>
        <strong style={{ fontSize: 13 }}>批量导入</strong>
        <div style={{ fontSize: 12, color: '#888', margin: '4px 0 8px' }}>
          每行一个，格式：<code>socks5://用户名:密码@主机:端口</code> 或 <code>http://主机:端口</code>
        </div>
        <textarea
          value={importText}
          onChange={(e) => setImportText(e.target.value)}
          rows={4}
          placeholder={'socks5://user:pass@1.2.3.4:1080\nhttp://5.6.7.8:8080'}
          style={{ width: '100%', padding: 8, borderRadius: 6, border: '1px solid #d1d5db', fontFamily: 'monospace', fontSize: 12, boxSizing: 'border-box' }}
        />
        <button
          type="button"
          onClick={() => void importBulk()}
          disabled={importing || !importText.trim()}
          style={{ marginTop: 8, padding: '6px 14px', borderRadius: 6, border: 'none', background: '#1976d2', color: '#fff', cursor: 'pointer', fontSize: 13, opacity: importing ? 0.6 : 1 }}
        >
          {importing ? '导入中…' : '导入'}
        </button>
      </div>

      {proxies.length === 0 ? (
        <p style={{ color: '#888' }}>暂无代理。批量导入后可在此处做健康检查。</p>
      ) : (
        <div style={{ display: 'grid', gap: 10 }}>
          {proxies.map((proxy) => {
            const health = proxyHealth[proxy.id];
            return (
              <div key={proxy.id} style={{ padding: 14, borderRadius: 8, border: '1px solid #e5e7eb', background: '#fff' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <strong>{proxy.label}</strong>
                    <span style={{ fontSize: 12, color: '#666', marginLeft: 8 }}>
                      {proxy.protocol}://{proxy.host}:{proxy.port}{proxy.username ? '（有认证）' : ''}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => void check(proxy.id)}
                    disabled={checking[proxy.id]}
                    style={{ padding: '5px 12px', borderRadius: 6, border: '1px solid #1976d2', color: '#1976d2', background: '#fff', cursor: 'pointer', fontSize: 12, opacity: checking[proxy.id] ? 0.5 : 1 }}
                  >
                    {checking[proxy.id] ? '检测中…' : '健康检查'}
                  </button>
                </div>
                {health && (
                  <div style={{ marginTop: 8, fontSize: 12, color: health.reachable ? '#2e7d32' : '#d32f2f' }}>
                    {health.reachable ? (
                      <>
                        ✓ 出口 {health.exitIp}
                        {health.geo && ` · ${health.geo.country} ${health.geo.city ?? ''} · ${health.geo.timezone ?? ''}`}
                        {health.latencyMs !== undefined && ` · ${health.latencyMs}ms`}
                        {health.risk && ` · 风险 ${health.risk.score}${health.risk.isDatacenter ? '（数据中心）' : ''}`}
                      </>
                    ) : (
                      <>✗ 不可达{health.error ? `：${health.error}` : ''}</>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
