import { useCallback, useEffect, useState } from 'react';
import type { FingerprintProfile } from '@shadowedge/core';
import { toastError, useStore } from '../store.js';

const PLATFORM_TAGS = ['通用', 'amazon', 'tiktok', 'shopee', 'facebook', 'google'] as const;
const FP_PLATFORMS = [
  { value: 'host', label: '跟随宿主机（推荐）' },
  { value: 'windows', label: 'Windows' },
  { value: 'macos', label: 'macOS' },
  { value: 'linux', label: 'Linux' },
] as const;

interface Props {
  onClose: () => void;
  onCreated: () => void;
}

export function CreateProfileDialog({ onClose, onCreated }: Props) {
  const { proxies } = useStore();
  const [name, setName] = useState('');
  const [platformTag, setPlatformTag] = useState<string>('通用');
  const [fpPlatform, setFpPlatform] = useState<string>('host');
  const [proxyId, setProxyId] = useState('');
  const [seed, setSeed] = useState<string>(() => crypto.randomUUID());
  const [preview, setPreview] = useState<FingerprintProfile | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // 种子/代理变化即实时预览画像；选代理时时区/语言/地理自动跟随出口
  useEffect(() => {
    let cancelled = false;
    setPreview(null);
    window.shadowedge.api['fingerprint:preview']({ seed, proxyId: proxyId || undefined, platform: fpPlatform as 'host' })
      .then((fp) => { if (!cancelled) setPreview(fp); })
      .catch(toastError);
    return () => { cancelled = true; };
  }, [seed, proxyId, fpPlatform]);

  const submit = useCallback(async () => {
    if (!name.trim()) {
      useStore.getState().toast('warn', '请填写环境名称');
      return;
    }
    setSubmitting(true);
    try {
      await window.shadowedge.api['profile:create']({
        name: name.trim(),
        platformTag: platformTag === '通用' ? undefined : platformTag,
        proxyId: proxyId || undefined,
        platform: fpPlatform as 'host',
        fingerprintSeed: seed,
      });
      useStore.getState().toast('info', `环境「${name.trim()}」已创建`);
      onCreated();
    } catch (error) {
      toastError(error);
      setSubmitting(false);
    }
  }, [name, platformTag, fpPlatform, proxyId, seed, onCreated]);

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

        <span style={label}>平台</span>
        <select style={input} value={platformTag} onChange={(e) => setPlatformTag(e.target.value)}>
          {PLATFORM_TAGS.map((tag) => <option key={tag} value={tag}>{tag}</option>)}
        </select>

        <span style={label}>画像系统</span>
        <select style={input} value={fpPlatform} onChange={(e) => setFpPlatform(e.target.value)}>
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
