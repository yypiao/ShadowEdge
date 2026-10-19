import { useStore } from '../store.js';

const COLORS = { info: '#1976d2', warn: '#ed6c02', error: '#d32f2f' } as const;

export function Toasts() {
  const { toasts, dismissToast } = useStore();
  if (toasts.length === 0) return null;
  return (
    <div style={{ position: 'fixed', right: 16, bottom: 16, display: 'grid', gap: 8, zIndex: 1000, maxWidth: 420 }}>
      {toasts.map((toast) => (
        <div
          key={toast.id}
          onClick={() => dismissToast(toast.id)}
          style={{
            padding: '10px 14px',
            borderRadius: 8,
            background: COLORS[toast.level],
            color: '#fff',
            fontSize: 13,
            cursor: 'pointer',
            boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
            wordBreak: 'break-all',
          }}
        >
          {toast.message}
        </div>
      ))}
    </div>
  );
}
