import { useState } from 'react';
import type { BrowserProfile } from '@shadowedge/core';
import { toastError, useStore } from '../store.js';

interface Props {
  profile: BrowserProfile;
  onClose: () => void;
  onSaved: () => void;
}

export function EditProfileDialog({ profile, onClose, onSaved }: Props) {
  const { proxies, groups } = useStore();
  const [name, setName] = useState(profile.name);
  const [platformTag, setPlatformTag] = useState(profile.platformTag ?? '');
  const [proxyId, setProxyId] = useState(profile.proxyId ?? '');
  const [groupId, setGroupId] = useState(profile.groupId ?? '');
  const [startupUrls, setStartupUrls] = useState(profile.startupUrls.join('\n'));
  const [notes, setNotes] = useState(profile.notes ?? '');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      await window.shadowedge.api['profile:update']({
        id: profile.id,
        patch: {
          name: name.trim(),
          platformTag: platformTag.trim() || undefined,
          proxyId: proxyId || undefined,
          groupId: groupId || undefined,
          startupUrls: startupUrls.split('\n').map((url) => url.trim()).filter(Boolean),
          notes: notes.trim() || undefined,
        },
      });
      useStore.getState().toast('info', `环境「${name.trim()}」已保存`);
      onSaved();
      onClose();
    } catch (error) {
      toastError(error);
      setBusy(false);
    }
  };

  const input: React.CSSProperties = {
    width: '100%', padding: 9, border: '1px solid #d1d5db', borderRadius: 6,
    boxSizing: 'border-box', marginTop: 5,
  };
  const label: React.CSSProperties = { display: 'block', fontSize: 12, marginTop: 14 };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }} onClick={onClose}>
      <form onSubmit={(event) => { event.preventDefault(); void submit(); }} onClick={(event) => event.stopPropagation()} style={{ width: 520, maxHeight: '85vh', overflow: 'auto', padding: 24, borderRadius: 12, background: '#fff' }}>
        <h3 style={{ marginTop: 0 }}>编辑环境</h3>
        <label style={label}>环境名称
          <input aria-label="编辑环境名称" required style={input} value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label style={label}>平台标识
          <input aria-label="编辑平台标识" style={input} value={platformTag} onChange={(event) => setPlatformTag(event.target.value)} placeholder="amazon / shopee / tiktok" />
        </label>
        <label style={label}>环境分组
          <select aria-label="编辑环境分组" style={input} value={groupId} onChange={(event) => setGroupId(event.target.value)}>
            <option value="">未分组</option>
            {groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
          </select>
        </label>
        <label style={label}>代理（下次启动生效）
          <select aria-label="编辑环境代理" style={input} value={proxyId} onChange={(event) => setProxyId(event.target.value)}>
            <option value="">不使用代理（直连）</option>
            {proxies.map((proxy) => <option key={proxy.id} value={proxy.id}>{proxy.label} · {proxy.host}:{proxy.port}</option>)}
          </select>
        </label>
        <label style={label}>启动页面（每行一个）
          <textarea aria-label="编辑启动页面" style={{ ...input, minHeight: 84, resize: 'vertical' }} value={startupUrls} onChange={(event) => setStartupUrls(event.target.value)} />
        </label>
        <label style={label}>备注
          <textarea aria-label="编辑环境备注" style={{ ...input, minHeight: 64, resize: 'vertical' }} value={notes} onChange={(event) => setNotes(event.target.value)} />
        </label>
        <p style={{ color: '#777', fontSize: 11 }}>指纹画像和本地存储路径不可编辑，避免已有环境发生身份漂移或数据错绑。</p>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
          <button type="button" disabled={busy} onClick={onClose}>取消</button>
          <button type="submit" disabled={busy || !name.trim()}>{busy ? '保存中…' : '保存修改'}</button>
        </div>
      </form>
    </div>
  );
}
