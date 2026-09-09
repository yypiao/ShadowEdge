import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { join } from 'node:path';
import { createConsoleLogger, IPC_CHANNELS, isShadowEdgeError, ShadowEdgeError } from '@shadowedge/core';
import type { IpcChannel } from '@shadowedge/core';
import { createHandlers } from './handlers.js';

const logger = createConsoleLogger({ component: 'main' });

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 680,
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // 安全基线：渲染进程完全沙箱化，禁止 Node 集成。
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  mainWindow.on('ready-to-show', () => mainWindow?.show());

  // 外部链接一律交给系统浏览器，避免在应用内产生非受控会话。
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

function registerIpc(): void {
  const handlers = createHandlers({
    logger: logger.child({ component: 'handlers' }),
    emit: (event, payload) => mainWindow?.webContents.send(event, payload),
  });

  for (const channel of IPC_CHANNELS) {
    ipcMain.handle(channel, async (_event, payload: unknown) => {
      const handler = handlers[channel as IpcChannel];
      if (!handler) {
        throw new ShadowEdgeError('E_INTERNAL', `未实现的通道: ${channel}`);
      }
      try {
        return await (handler as (input: unknown) => unknown)(payload);
      } catch (error) {
        logger.error('IPC 调用失败', { channel, error: String(error) });
        if (isShadowEdgeError(error)) throw error;
        throw new ShadowEdgeError('E_INTERNAL', (error as Error).message ?? '未知错误', { cause: error });
      }
    });
  }
}

app.whenReady().then(() => {
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
