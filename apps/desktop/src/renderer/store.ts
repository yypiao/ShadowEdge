import { create } from 'zustand';
import type { BrowserProfile, ProxyCredential, RpaRun } from '@shadowedge/core';

interface AppState {
  version: string;
  profiles: BrowserProfile[];
  proxies: ProxyCredential[];
  rpaRuns: RpaRun[];
  sidebar: 'profiles' | 'proxies' | 'rpa' | 'settings';
  setSidebar: (tab: AppState['sidebar']) => void;
  setProfiles: (profiles: BrowserProfile[]) => void;
  setProxies: (proxies: ProxyCredential[]) => void;
  clearRpaRun: (id: string) => void;
}

export const useStore = create<AppState>((set) => ({
  version: '0.1.0',
  profiles: [],
  proxies: [],
  rpaRuns: [],
  sidebar: 'profiles',
  setSidebar: (sidebar) => set({ sidebar }),
  setProfiles: (profiles) => set({ profiles }),
  setProxies: (proxies) => set({ proxies }),
  clearRpaRun: (id) =>
    set((state) => ({ rpaRuns: state.rpaRuns.filter((r) => r.id !== id) })),
}));
