import { useEffect, useState } from 'react';
import type { KernelRuntimeStatus } from '@shadowedge/core';
import { toastError, useStore } from '../store.js';

const SOURCE_LABEL = {
  configured: '用户配置',
  environment: '环境变量',
  installed: '标准安装目录',
  none: '未发现',
} as const;

export function SettingsPage() {
  const { toast } = useStore();
  const [status, setStatus] = useState<KernelRuntimeStatus>();
  const [path, setPath] = useState('');
  const [strict, setStrict] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    window.shadowedge.api['kernel:getStatus'](undefined)
      .then((current) => {
        setStatus(current);
        setPath(current.executablePath ?? '');
        setStrict(current.fallbackPolicy === 'require-chromium-cdp');
      })
      .catch(toastError);
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      const next = await window.shadowedge.api['kernel:configure']({
        executablePath: path.trim() || undefined,
        fallbackPolicy: strict ? 'require-chromium-cdp' : 'allow-patchright',
      });
      setStatus(next);
      setPath(next.executablePath ?? '');
      toast('info', next.available ? '内核配置已保存，下次启动环境生效' : '配置已保存，但当前未发现可用内核');
    } catch (error) {
      toastError(error);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section style={{ maxWidth: 760 }}>
      <h2 style={{ marginTop: 0 }}>浏览器内核</h2>
      <div style={{ padding: 16, border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff' }}>
        <div style={{ marginBottom: 12, fontSize: 13 }}>
          状态：<strong style={{ color: status?.available ? '#2e7d32' : '#d32f2f' }}>
            {status?.available ? '自研内核可用' : '未发现自研内核'}
          </strong>
          {status && <span style={{ color: '#666' }}> · 来源：{SOURCE_LABEL[status.source]}</span>}
        </div>
        <label style={{ display: 'block', fontSize: 13, marginBottom: 6 }}>Chromium 可执行文件绝对路径</label>
        <input
          value={path}
          onChange={(event) => setPath(event.target.value)}
          placeholder="留空则使用环境变量或标准安装目录"
          style={{ boxSizing: 'border-box', width: '100%', padding: 9, border: '1px solid #d1d5db', borderRadius: 5 }}
        />
        <div style={{ color: '#777', fontSize: 12, marginTop: 6, wordBreak: 'break-all' }}>
          实际解析：{status?.resolvedExecutablePath ?? '无'}
        </div>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 16, fontSize: 13 }}>
          <input type="checkbox" checked={strict} onChange={(event) => setStrict(event.target.checked)} />
          严格模式：自研内核不可用时拒绝启动，不回退 Patchright
        </label>
        <button
          type="button"
          disabled={saving}
          onClick={() => void save()}
          style={{ marginTop: 16, padding: '8px 18px', border: 0, borderRadius: 5, background: '#1976d2', color: '#fff', cursor: 'pointer' }}
        >
          {saving ? '保存中…' : '保存内核设置'}
        </button>
      </div>
    </section>
  );
}
