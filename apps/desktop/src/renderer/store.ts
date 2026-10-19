import { create } from 'zustand';
import type { BrowserProfile, ProxyCredential, ProxyHealth, RpaRun } from '@shadowedge/core';

export interface Toast {
  id: number;
  level: 'info' | 'warn' | 'error';
  message: string;
}

interface AppState {
  version: string;
  profiles: BrowserProfile[];
  proxies: ProxyCredential[];
  proxyHealth: Record<string, ProxyHealth>;
  rpaRuns: RpaRun[];
  sidebar: 'profiles' | 'proxies' | 'rpa' | 'settings';
  toasts: Toast[];
  setSidebar: (tab: AppState['sidebar']) => void;
  setProfiles: (profiles: BrowserProfile[]) => void;
  setProxies: (proxies: ProxyCredential[]) => void;
  setProxyHealth: (health: ProxyHealth) => void;
  toast: (level: Toast['level'], message: string) => void;
  dismissToast: (id: number) => void;
  clearRpaRun: (id: string) => void;
}

let toastSeq = 0;

export const useStore = create<AppState>((set) => ({
  version: '0.1.0',
  profiles: [],
  proxies: [],
  proxyHealth: {},
  rpaRuns: [],
  sidebar: 'profiles',
  toasts: [],
  setSidebar: (sidebar) => set({ sidebar }),
  setProfiles: (profiles) => set({ profiles }),
  setProxies: (proxies) => set({ proxies }),
  setProxyHealth: (health) =>
    set((state) => ({ proxyHealth: { ...state.proxyHealth, [health.proxyId]: health } })),
  toast: (level, message) => {
    toastSeq += 1;
    const id = toastSeq;
    set((state) => ({ toasts: [...state.toasts, { id, level, message }] }));
    setTimeout(() => {
      useStore.getState().dismissToast(id);
    }, 5000);
  },
  dismissToast: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
  clearRpaRun: (id) =>
    set((state) => ({ rpaRuns: state.rpaRuns.filter((r) => r.id !== id) })),
}));

/** 统一把 IPC 错误转成 toast，避免每个页面各写一套 try/catch 样板。 */
export function toastError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  useStore.getState().toast('error', message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
}
