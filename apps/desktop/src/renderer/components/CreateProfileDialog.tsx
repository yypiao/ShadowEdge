import { useCallback, useEffect, useState } from 'react';
import type { FingerprintProfile, PlatformPolicy } from '@shadowedge/core';
import { toastError, useStore } from '../store.js';

const FP_PLATFORMS = [
  { value: 'host', label: '跟随宿主机（推荐）' },
  { value: 'windows', label: 'Windows' },
  { value: 'macos', label: 'macOS' },
  { value: 'linux', label: 'Linux' },
] as const;
type FpPlatform = (typeof FP_PLATFORMS)[number]['value'];

interface Props {
  onClose: () => void;
  onCreated: () => void;
}

export function CreateProfileDialog({ onClose, onCreated }: Props) {
  const { proxies, groups } = useStore();
  const [name, setName] = useState('');
  const [count, setCount] = useState(1);
  const [platformTag, setPlatformTag] = useState<string>('通用');
  const [policies, setPolicies] = useState<PlatformPolicy[]>([]);
  const [siteId, setSiteId] = useState('');
  const [fpPlatform, setFpPlatform] = useState<FpPlatform>('host');
  const [proxyId, setProxyId] = useState('');
  const [groupId, setGroupId] = useState('');
  const [startupUrls, setStartupUrls] = useState('');
  const [notes, setNotes] = useState('');
  const [seed, setSeed] = useState<string>(() => crypto.randomUUID());
  const [preview, setPreview] = useState<FingerprintProfile | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const selectedSite = policies.find((policy) => policy.tag === platformTag)?.sites.find((item) => item.id === siteId);

  useEffect(() => {
    window.shadowedge.api['platformPolicy:list'](undefined).then(setPolicies).catch(toastError);
  }, []);

  // 种子/代理变化即实时预览画像；选代理时时区/语言/地理自动跟随出口
  useEffect(() => {
    let cancelled = false;
    setPreview(null);
    window.shadowedge.api['fingerprint:preview']({
        seed,
        proxyId: proxyId || undefined,
        platform: fpPlatform,
        overrides: selectedSite && !proxyId
          ? { languages: [...selectedSite.languages], timezone: selectedSite.timezone }
          : undefined,
      })
      .then((fp) => { if (!cancelled) setPreview(fp); })
      .catch(toastError);
    return () => { cancelled = true; };
  }, [seed, proxyId, fpPlatform, selectedSite?.id]);

  const submit = useCallback(async () => {
    if (!name.trim()) {
      useStore.getState().toast('warn', '请填写环境名称');
      return;
    }
    if (!Number.isInteger(count) || count < 1 || count > 50) {
      useStore.getState().toast('warn', '创建数量必须是 1–50 的整数');
      return;
    }
    setSubmitting(true);
    try {
      const base = {
        platformTag: platformTag === '通用' ? undefined : platformTag,
        platformSiteId: selectedSite?.id,
        proxyId: proxyId || undefined,
        groupId: groupId || undefined,
        startupUrls: startupUrls.split('\n').map((url) => url.trim()).filter(Boolean),
        notes: notes.trim() || undefined,
        platform: fpPlatform,
        overrides: selectedSite && !proxyId
          ? { languages: [...selectedSite.languages], timezone: selectedSite.timezone }
          : undefined,
      };
      if (count === 1) {
        await window.shadowedge.api['profile:create']({
          ...base,
          name: name.trim(),
          fingerprintSeed: seed,
        });
        useStore.getState().toast('info', `环境「${name.trim()}」已创建`);
      } else {
        const results = await window.shadowedge.api['profile:createMany']({
          items: Array.from({ length: count }, (_, index) => ({
            ...base,
            name: `${name.trim()}-${String(index + 1).padStart(2, '0')}`,
            // 首个环境保持当前预览；后续 seed 派生且互不重复。
            fingerprintSeed: index === 0 ? seed : `${seed}:${index + 1}`,
          })),
        });
        const succeeded = results.filter((result) => result.ok).length;
        const failed = results.length - succeeded;
        if (succeeded === 0) {
          const firstError = results.find((result) => !result.ok);
          useStore.getState().toast(
            'error',
            `批量创建失败：${firstError && !firstError.ok ? firstError.error.message : '未知错误'}`,
          );
          setSubmitting(false);
          return;
        }
        useStore.getState().toast(
          failed > 0 ? 'warn' : 'info',
          `批量创建完成：成功 ${succeeded} 个${failed > 0 ? `，失败 ${failed} 个` : ''}`,
        );
      }
      onCreated();
    } catch (error) {
      toastError(error);
      setSubmitting(false);
    }
  }, [name, count, platformTag, fpPlatform, proxyId, groupId, startupUrls, notes, seed, selectedSite, onCreated]);

  const input: React.CSSProperties = {
    width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #d1d5db', fontSize: 13, boxSizing: 'border-box',
  };
  const label: React.CSSProperties = { display: 'block', fontSize: 12, color: '#555', marginBottom: 4, marginTop: 12 };

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}
      onClick={onClose}
    >
      <div
        style={{ width: 560, maxHeight: '85vh', overflow: 'auto', background: '#fff', borderRadius: 12, padding: 24 }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ marginTop: 0 }}>新建环境</h3>

        <span style={label}>环境名称</span>
        <input style={input} value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：美区亚马逊-01" autoFocus />

        <span style={label}>创建数量（1–50）</span>
        <input
          aria-label="创建数量"
          type="number"
          min={1}
          max={50}
          step={1}
          style={input}
          value={count}
          onChange={(e) => setCount(e.target.valueAsNumber)}
        />
        {count > 1 && (
          <div style={{ fontSize: 11, color: '#666', marginTop: 4 }}>
            将按「名称-01、名称-02…」命名，并为每个环境派生独立指纹。
          </div>
        )}

        <span style={label}>平台</span>
        <select aria-label="业务平台" style={input} value={platformTag} onChange={(event) => {
          const tag = event.target.value;
          const first = policies.find((policy) => policy.tag === tag)?.sites[0];
          setPlatformTag(tag);
          setSiteId(first?.id ?? '');
          if (first) setStartupUrls(first.url);
        }}>
          <option value="通用">通用</option>
          {policies.map((policy) => <option key={policy.tag} value={policy.tag}>{policy.label}</option>)}
          <option value="facebook">facebook</option><option value="google">google</option>
        </select>
        {selectedSite && (
          <>
            <span style={label}>平台站点</span>
            <select aria-label="平台站点" style={input} value={siteId} onChange={(event) => {
              setSiteId(event.target.value);
              const next = policies.flatMap((policy) => policy.sites).find((item) => item.id === event.target.value);
              if (next) setStartupUrls(next.url);
            }}>
              {policies.find((policy) => policy.tag === platformTag)?.sites.map((item) => (
                <option key={item.id} value={item.id}>{item.label} · {item.countryCodes.join('/')}</option>
              ))}
            </select>
            <div style={{ fontSize: 11, color: '#666', marginTop: 4 }}>
              {proxyId ? '代理出口将自动决定指纹地理，并在启动时校验站点区域' : `站点推荐：${selectedSite.timezone} · ${selectedSite.languages.join(', ')}`}
            </div>
          </>
        )}

        <span style={label}>分组（可选）</span>
        <select aria-label="环境分组" style={input} value={groupId} onChange={(e) => setGroupId(e.target.value)}>
          <option value="">未分组</option>
          {groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
        </select>

        <span style={label}>启动页面（每行一个 HTTP(S) URL）</span>
        <textarea aria-label="启动页面" style={{ ...input, minHeight: 64, resize: 'vertical' }} value={startupUrls} onChange={(e) => setStartupUrls(e.target.value)} placeholder="https://example.com/dashboard" />

        <span style={label}>备注（可选）</span>
        <textarea aria-label="环境备注" style={{ ...input, minHeight: 56, resize: 'vertical' }} value={notes} onChange={(e) => setNotes(e.target.value)} />

        <span style={label}>画像系统</span>
        <select style={input} value={fpPlatform} onChange={(e) => setFpPlatform(e.target.value as FpPlatform)}>
          {FP_PLATFORMS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
        </select>

        <span style={label}>代理（可选）</span>
        <select style={input} value={proxyId} onChange={(e) => setProxyId(e.target.value)}>
          <option value="">不使用代理（直连）</option>
          {proxies.map((proxy) => (
            <option key={proxy.id} value={proxy.id}>
              {proxy.label} · {proxy.protocol}://{proxy.host}:{proxy.port}
            </option>
          ))}
        </select>
        {proxyId && (
          <div style={{ fontSize: 11, color: '#1976d2', marginTop: 4 }}>
            已选择代理：指纹的时区 / 语言 / 地理坐标将自动跟随出口（预览加载约需数秒）
          </div>
        )}

        <span style={label}>指纹种子</span>
        <div style={{ display: 'flex', gap: 8 }}>
          <input style={{ ...input, flex: 1, fontFamily: 'monospace' }} value={seed} onChange={(e) => setSeed(e.target.value)} />
          <button type="button" onClick={() => setSeed(crypto.randomUUID())} style={{ padding: '0 12px', borderRadius: 6, border: '1px solid #d1d5db', background: '#fff', cursor: 'pointer' }}>
            随机
          </button>
        </div>

        {!preview && (
          <div style={{ marginTop: 16, padding: 12, borderRadius: 8, background: '#f8fafc', border: '1px solid #e5e7eb', fontSize: 12, color: '#888' }}>
            指纹预览加载中…
          </div>
        )}
        {preview && (
          <div style={{ marginTop: 16, padding: 12, borderRadius: 8, background: '#f8fafc', border: '1px solid #e5e7eb', fontSize: 12 }}>
            <strong>指纹预览</strong>
            <div style={{ marginTop: 6, display: 'grid', gap: 3, color: '#444' }}>
              <div>UA：{preview.userAgent}</div>
              <div>平台：{preview.platform} · 屏幕 {preview.screen.width}×{preview.screen.height}@{preview.screen.pixelRatio}x</div>
              <div>时区：{preview.timezone} · 语言：{preview.languages.join(', ')}</div>
              <div>CPU {preview.hardware.hardwareConcurrency} 核 · 内存 {preview.hardware.deviceMemoryGb}GB</div>
              <div>WebGL：{preview.webgl.vendor} / {preview.webgl.renderer}</div>
              {preview.geolocation && <div>地理：{preview.geolocation.latitude}, {preview.geolocation.longitude}</div>}
            </div>
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
          <button type="button" onClick={onClose} style={{ padding: '8px 16px', borderRadius: 6, border: '1px solid #d1d5db', background: '#fff', cursor: 'pointer' }}>
            取消
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={submitting}
            style={{ padding: '8px 16px', borderRadius: 6, border: 'none', background: '#1976d2', color: '#fff', cursor: 'pointer', opacity: submitting ? 0.6 : 1 }}
          >
            {submitting ? '创建中…' : '创建环境'}
          </button>
        </div>
      </div>
    </div>
  );
}
