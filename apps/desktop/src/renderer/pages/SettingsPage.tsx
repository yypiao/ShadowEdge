import { useEffect, useState } from 'react';
import type { KernelDistributionStatus, KernelRuntimeStatus } from '@shadowedge/core';
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
  const [distribution, setDistribution] = useState<KernelDistributionStatus>();
  const [path, setPath] = useState('');
  const [strict, setStrict] = useState(false);
  const [saving, setSaving] = useState(false);
  const [packageBusy, setPackageBusy] = useState(false);

  useEffect(() => {
    window.shadowedge.api['kernel:getStatus'](undefined)
      .then((current) => {
        setStatus(current);
        setPath(current.executablePath ?? '');
        setStrict(current.fallbackPolicy === 'require-chromium-cdp');
      })
      .catch(toastError);
    window.shadowedge.api['kernelDistribution:status'](undefined).then(setDistribution).catch(toastError);
  }, []);

  const installPackage = async () => {
    setPackageBusy(true);
    try {
      const result = await window.shadowedge.api['kernelDistribution:install'](undefined);
      setDistribution(result.status);
      await refreshRuntime();
      toast('info', result.installed ? `内核 ${result.status.activeVersion} 已验签并激活；已有环境仍使用各自固定版本` : '已取消安装');
    } catch (error) { toastError(error); }
    finally { setPackageBusy(false); }
  };

  const activate = async (version: string) => {
    setPackageBusy(true);
    try {
      const next = await window.shadowedge.api['kernelDistribution:activate']({ version });
      setDistribution(next);
      await refreshRuntime();
      toast('info', `全局默认版本已切换为 ${version}；已有固定版本环境不变`);
    } catch (error) { toastError(error); }
    finally { setPackageBusy(false); }
  };

  const refreshRuntime = async () => {
    const current = await window.shadowedge.api['kernel:getStatus'](undefined);
    setStatus(current);
  };

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

      <div style={{ marginTop: 18, padding: 16, border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff' }}>
        <h3 style={{ marginTop: 0 }}>离线签名内核包</h3>
        <p style={{ color: '#666', fontSize: 12 }}>
          当前版本：{distribution?.activeVersion ?? '未安装'} · 可信公钥：{distribution?.trustedKeyConfigured ? '已配置' : '未配置'}
        </p>
        <p style={{ color: '#777', fontSize: 11 }}>安装和切换前会重新验签并逐文件校验；请先停止所有环境。全局版本只影响新建环境，已有环境通过“内核升级”灰度迁移。</p>
        <button type="button" disabled={packageBusy} onClick={() => void installPackage()}>
          {packageBusy ? '处理中…' : '选择内核 ZIP 并安装'}
        </button>
        <div style={{ display: 'grid', gap: 8, marginTop: 12 }}>
          {distribution?.installations.map((installation) => (
            <div key={installation.version} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12 }}>
              <strong style={{ flex: 1 }}>{installation.version}{installation.active ? '（当前）' : ''}</strong>
              <span style={{ color: '#777' }}>{installation.platform}/{installation.arch}</span>
              <button type="button" disabled={packageBusy || installation.active} onClick={() => void activate(installation.version)}>回滚到此版本</button>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
