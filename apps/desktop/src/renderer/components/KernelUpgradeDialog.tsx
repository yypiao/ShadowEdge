import { useEffect, useState } from 'react';
import type { BrowserProfile, KernelDistributionStatus } from '@shadowedge/core';
import { toastError, useStore } from '../store.js';

interface Props {
  source: BrowserProfile;
  onClose: () => void;
  onChanged: () => void;
}

export function KernelUpgradeDialog({ source, onClose, onChanged }: Props) {
  const { profiles, toast } = useStore();
  const [distribution, setDistribution] = useState<KernelDistributionStatus>();
  const [targetVersion, setTargetVersion] = useState(source.kernelVersion ?? '');
  const [cloneId, setCloneId] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const clones = profiles.filter((profile) => profile.kernelUpgradeSourceId === source.id);

  useEffect(() => {
    window.shadowedge.api['kernelDistribution:status'](undefined)
      .then((status) => {
        setDistribution(status);
        const candidate = status.activeVersion && status.activeVersion !== source.kernelVersion
          ? status.activeVersion
          : status.installations.find((item) => item.version !== source.kernelVersion)?.version;
        if (candidate) setTargetVersion(candidate);
      })
      .catch(toastError);
  }, [source.kernelVersion]);

  useEffect(() => {
    if (!cloneId && clones[0]) setCloneId(clones[0].id);
  }, [cloneId, clones]);

  const prepare = async () => {
    if (!targetVersion) return;
    setBusy(true);
    try {
      await window.shadowedge.api['profile:prepareKernelUpgrade']({
        profileId: source.id,
        targetVersion,
      });
      toast('info', '验证克隆已创建；请启动克隆并完成探针对照，原环境尚未修改');
      onChanged();
      onClose();
    } catch (error) {
      toastError(error);
      setBusy(false);
    }
  };

  const commit = async () => {
    if (!cloneId || !confirmed) return;
    setBusy(true);
    try {
      await window.shadowedge.api['profile:commitKernelUpgrade']({
        profileId: source.id,
        upgradeProfileId: cloneId,
        confirmed: true,
      });
      toast('info', `原环境已升级到内核 ${targetVersion}，操作已写入审计`);
      onChanged();
      onClose();
    } catch (error) {
      toastError(error);
      setBusy(false);
    }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }} onClick={onClose}>
      <div onClick={(event) => event.stopPropagation()} style={{ width: 500, padding: 24, borderRadius: 12, background: '#fff' }}>
        <h3 style={{ marginTop: 0 }}>内核升级灰度 · {source.name}</h3>
        <p style={{ color: '#666', fontSize: 12, lineHeight: 1.6 }}>
          当前固定版本：<strong>{source.kernelVersion ?? '开发路径模式'}</strong>。安装或全局激活新版不会改变此环境。
        </p>
        <label style={{ display: 'block', fontSize: 12 }}>
          目标版本
          <select aria-label="目标内核版本" value={targetVersion} onChange={(event) => setTargetVersion(event.target.value)} style={{ width: '100%', marginTop: 6, padding: 8, boxSizing: 'border-box' }}>
            <option value="">请选择已安装版本</option>
            {distribution?.installations.map((item) => (
              <option key={item.version} value={item.version}>{item.version}{item.version === source.kernelVersion ? '（当前）' : ''}</option>
            ))}
          </select>
        </label>
        <button type="button" disabled={busy || !targetVersion || targetVersion === source.kernelVersion} onClick={() => void prepare()} style={{ marginTop: 12 }}>
          {busy ? '处理中…' : '创建验证克隆'}
        </button>

        {clones.length > 0 && (
          <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid #e5e7eb' }}>
            <label style={{ display: 'block', fontSize: 12 }}>
              选择已完成探针对照的克隆
              <select aria-label="验证克隆" value={cloneId} onChange={(event) => {
                setCloneId(event.target.value);
                const selected = clones.find((item) => item.id === event.target.value);
                if (selected?.kernelVersion) setTargetVersion(selected.kernelVersion);
              }} style={{ width: '100%', marginTop: 6, padding: 8, boxSizing: 'border-box' }}>
                {clones.map((clone) => <option key={clone.id} value={clone.id}>{clone.name} · {clone.kernelVersion}</option>)}
              </select>
            </label>
            <p style={{ color: '#777', fontSize: 11, lineHeight: 1.5 }}>
              请对原环境和克隆分别运行主世界、Worker、ServiceWorker、WebRTC 与网络层探针。只有差异均已审阅并接受后才继续。
            </p>
            <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12, lineHeight: 1.5 }}>
              <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
              我已完成克隆探针对照，确认将原环境升级到所选版本
            </label>
            <button type="button" disabled={busy || !cloneId || !confirmed} onClick={() => void commit()} style={{ marginTop: 12 }}>
              确认升级原环境
            </button>
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 20 }}>
          <button type="button" disabled={busy} onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}
