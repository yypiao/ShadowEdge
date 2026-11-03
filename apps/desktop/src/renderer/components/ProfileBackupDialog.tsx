import { useState } from 'react';
import { toastError, useStore } from '../store.js';

interface Props {
  mode: 'export' | 'import';
  profileId?: string;
  onClose: () => void;
  onImported: () => void;
}

export function ProfileBackupDialog({ mode, profileId, onClose, onImported }: Props) {
  const [passphrase, setPassphrase] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const exporting = mode === 'export';

  const submit = async () => {
    if (passphrase.length < 12) return;
    setBusy(true);
    try {
      if (exporting) {
        const result = await window.shadowedge.api['profile:export']({ profileId: profileId!, passphrase });
        useStore.getState().toast('info', result.saved
          ? `加密备份已保存：${result.cookieCount} 个 Cookie，${result.originCount} 个站点状态，${result.indexedDbCount} 个 IndexedDB 数据库`
          : '已取消保存备份');
      } else {
        const result = await window.shadowedge.api['profile:import']({ passphrase, name: name || undefined });
        if (result.imported) {
          useStore.getState().toast('info', `环境「${result.profile!.name}」已导入，首次启动时恢复浏览器状态`);
          onImported();
        }
      }
      onClose();
    } catch (error) {
      toastError(error);
      setBusy(false);
    }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }} onClick={onClose}>
      <form onSubmit={(event) => { event.preventDefault(); void submit(); }} onClick={(event) => event.stopPropagation()} style={{ width: 440, padding: 24, borderRadius: 12, background: '#fff' }}>
        <h3 style={{ marginTop: 0 }}>{exporting ? '导出加密环境备份' : '导入环境备份'}</h3>
        <p style={{ color: '#666', fontSize: 12, lineHeight: 1.6 }}>
          {exporting
            ? '环境画像、代理凭据、Cookie、LocalStorage 和 IndexedDB 将使用口令加密。请妥善保管口令，遗失后无法恢复。'
            : '选择 .sebackup 文件并输入原口令。导入会创建新环境，不会覆盖现有环境。'}
        </p>
        {!exporting && (
          <label style={{ display: 'block', fontSize: 12, marginBottom: 12 }}>新环境名称（可选）
            <input value={name} onChange={(event) => setName(event.target.value)} style={{ width: '100%', marginTop: 5, padding: 8, boxSizing: 'border-box' }} />
          </label>
        )}
        <label style={{ display: 'block', fontSize: 12 }}>备份口令（至少 12 个字符）
          <input aria-label="备份口令" type="password" required minLength={12} autoComplete="new-password" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} style={{ width: '100%', marginTop: 5, padding: 8, boxSizing: 'border-box' }} />
        </label>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
          <button type="button" disabled={busy} onClick={onClose}>取消</button>
          <button type="submit" disabled={busy || passphrase.length < 12}>
            {busy ? '处理中…' : exporting ? '选择保存位置' : '选择备份文件'}
          </button>
        </div>
      </form>
    </div>
  );
}
