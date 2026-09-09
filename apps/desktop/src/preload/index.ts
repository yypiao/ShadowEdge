import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { IpcApi, IpcEventName, IpcEvents } from '@shadowedge/core';
import { IPC_CHANNELS, IPC_EVENTS } from '@shadowedge/core';

type InvokeMap = Record<string, (payload?: unknown) => Promise<unknown>>;
type SubscribeMap = Record<string, (handler: (...args: unknown[]) => void) => () => void>;

const invokers: InvokeMap = {};
for (const channel of IPC_CHANNELS) {
  invokers[channel] = (payload?: unknown) => ipcRenderer.invoke(channel, payload);
}

const subscribers: SubscribeMap = {};
for (const event of IPC_EVENTS) {
  subscribers[event] = (handler) => {
    const listener = (_event: IpcRendererEvent, ...args: unknown[]) => {
      handler(args[0]);
    };
    ipcRenderer.on(event, listener);
    return () => {
      ipcRenderer.removeListener(event, listener);
    };
  };
}

export interface ShadowEdgeBridge {
  api: {
    [C in keyof IpcApi]: (
      payload: Parameters<IpcApi[C]>[0],
    ) => Promise<Awaited<ReturnType<IpcApi[C]>>>;
  };
  on: {
    [E in IpcEventName]: (handler: (payload: IpcEvents[E]) => void) => () => void;
  };
}

const bridge = {
  api: invokers,
  on: subscribers,
} as unknown as ShadowEdgeBridge;

contextBridge.exposeInMainWorld('shadowedge', bridge);
