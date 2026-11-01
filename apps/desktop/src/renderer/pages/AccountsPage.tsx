import { useEffect, useState } from 'react';
import type { AccountCredential } from '@shadowedge/core';
import { toastError, useStore } from '../store.js';

const INITIAL_FORM = {
  label: '',
  origin: 'https://',
  username: '',
  password: '',
  usernameSelector: '#email',
  passwordSelector: '#password',
  submitSelector: '',
};

const inputStyle = {
  boxSizing: 'border-box',
  width: '100%',
  padding: 8,
  border: '1px solid #d1d5db',
  borderRadius: 5,
} as const;

export function AccountsPage() {
  const { profiles, toast } = useStore();
  const [profileId, setProfileId] = useState('');
  const [accounts, setAccounts] = useState<AccountCredential[]>([]);
  const [form, setForm] = useState(INITIAL_FORM);
  const [saving, setSaving] = useState(false);
  const selectedProfile = profiles.find((profile) => profile.id === profileId);

  const refresh = async (id: string) => {
    if (!id) {
      setAccounts([]);
      return;
    }
    try {
      setAccounts(await window.shadowedge.api['account:list'](id));
    } catch (error) {
      toastError(error);
    }
  };

  useEffect(() => {
    if (!profileId && profiles[0]) setProfileId(profiles[0].id);
  }, [profiles, profileId]);

  useEffect(() => {
    void refresh(profileId);
  }, [profileId]);

  const update = (key: keyof typeof INITIAL_FORM, value: string) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const save = async () => {
    if (!profileId) return;
    setSaving(true);
    try {
      await window.shadowedge.api['account:upsert']({
        profileId,
        label: form.label.trim(),
        origin: form.origin.trim(),
        username: form.username,
        usernameSelector: form.usernameSelector.trim(),
        passwordSelector: form.passwordSelector.trim(),
        submitSelector: form.submitSelector.trim() || undefined,
        password: form.password,
      });
      setForm(INITIAL_FORM);
      await refresh(profileId);
      toast('info', '账号凭据已加密保存');
    } catch (error) {
      toastError(error);
    } finally {
      setSaving(false);
    }
  };

  const autofill = async (id: string, submit: boolean) => {
    try {
      await window.shadowedge.api['account:autofill']({ id, submit });
      toast('info', submit ? '已填充并点击提交' : '已在匹配页面完成填充');
    } catch (error) {
      toastError(error);
    }
  };

  const remove = async (id: string) => {
    try {
      await window.shadowedge.api['account:delete'](id);
      await refresh(profileId);
      toast('info', '凭据已删除');
    } catch (error) {
      toastError(error);
    }
  };

  return (
    <section style={{ maxWidth: 920 }}>
      <h2 style={{ marginTop: 0 }}>账号凭据</h2>
      <p style={{ color: '#666', fontSize: 13 }}>
        密码仅以信封密文保存。填充前会校验精确网站 origin 与密码框类型，界面不提供密码查看功能。
      </p>
      <label style={{ display: 'block', maxWidth: 420, fontSize: 13 }}>
        所属环境
        <select
          value={profileId}
          onChange={(event) => setProfileId(event.target.value)}
          style={{ ...inputStyle, marginTop: 6, background: '#fff' }}
        >
          {profiles.length === 0 && <option value="">请先创建环境</option>}
          {profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name}
            </option>
          ))}
        </select>
      </label>

      {profileId && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(300px, 1fr) minmax(300px, 1fr)',
            gap: 16,
            marginTop: 18,
          }}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
            style={{
              padding: 16,
              border: '1px solid #e5e7eb',
              borderRadius: 8,
              background: '#fff',
            }}
          >
            <h3 style={{ marginTop: 0, fontSize: 15 }}>新增凭据</h3>
            {(
              [
                ['label', '名称', 'Amazon 主账号', 'text'],
                ['origin', '网站 Origin', 'https://example.com', 'url'],
                ['username', '用户名', 'alice@example.com', 'text'],
                ['password', '密码', '保存后不可查看', 'password'],
                ['usernameSelector', '用户名选择器', '#email', 'text'],
                ['passwordSelector', '密码选择器', '#password', 'text'],
                ['submitSelector', '提交按钮选择器（可选）', '#login', 'text'],
              ] as const
            ).map(([key, label, placeholder, type]) => (
              <label key={key} style={{ display: 'block', marginBottom: 10, fontSize: 12 }}>
                {label}
                <input
                  required={key !== 'submitSelector'}
                  type={type}
                  value={form[key]}
                  autoComplete={key === 'password' ? 'new-password' : 'off'}
                  placeholder={placeholder}
                  onChange={(event) => update(key, event.target.value)}
                  style={{ ...inputStyle, marginTop: 4 }}
                />
              </label>
            ))}
            <button
              type="submit"
              disabled={saving}
              style={{
                padding: '8px 16px',
                border: 0,
                borderRadius: 5,
                background: '#1976d2',
                color: '#fff',
                cursor: 'pointer',
              }}
            >
              {saving ? '加密保存中…' : '加密保存'}
            </button>
          </form>

          <div>
            <h3 style={{ marginTop: 0, fontSize: 15 }}>已保存 {accounts.length} 个</h3>
            {selectedProfile?.status !== 'running' && accounts.length > 0 && (
              <p style={{ color: '#ed6c02', fontSize: 12 }}>启动环境并打开对应登录页后才能填充。</p>
            )}
            <div style={{ display: 'grid', gap: 10 }}>
              {accounts.map((account) => (
                <article
                  key={account.id}
                  style={{
                    padding: 12,
                    border: '1px solid #e5e7eb',
                    borderRadius: 8,
                    background: '#fff',
                  }}
                >
                  <strong style={{ fontSize: 13 }}>{account.label}</strong>
                  <div style={{ color: '#666', fontSize: 12, marginTop: 4 }}>
                    {account.username}
                  </div>
                  <div
                    style={{ color: '#888', fontSize: 11, marginTop: 4, wordBreak: 'break-all' }}
                  >
                    {account.origin}
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
                    <button
                      type="button"
                      disabled={selectedProfile?.status !== 'running'}
                      onClick={() => void autofill(account.id, false)}
                    >
                      填充
                    </button>
                    <button
                      type="button"
                      disabled={selectedProfile?.status !== 'running' || !account.submitSelector}
                      onClick={() => void autofill(account.id, true)}
                    >
                      填充并登录
                    </button>
                    <button
                      type="button"
                      onClick={() => void remove(account.id)}
                      style={{ color: '#d32f2f' }}
                    >
                      删除
                    </button>
                  </div>
                </article>
              ))}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
