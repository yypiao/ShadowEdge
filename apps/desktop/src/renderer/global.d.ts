import type { ShadowEdgeBridge } from '../preload/index.js';

declare global {
  interface Window {
    /** 由 preload 通过 contextBridge 注入。 */
    shadowedge: ShadowEdgeBridge;
  }
}

export {};
