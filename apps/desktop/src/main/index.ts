import { app, BrowserWindow, ipcMain, net, protocol, shell } from 'electron';
import { join, normalize, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createConsoleLogger, IPC_CHANNELS, isShadowEdgeError, ShadowEdgeError } from '@shadowedge/core';
import type { IpcChannel } from '@shadowedge/core';
import { createHandlers } from './handlers.js';
import { openDatabase } from './services/db.js';
import { loadKeyring } from './services/keyring.js';
import { ProfileRepository } from './services/profile-repository.js';
import { ProxyRepository } from './services/proxy-repository.js';
import { AuditLog, SessionRepository } from './services/local-records.js';

const logger = createConsoleLogger({ component: 'main' });

let mainWindow: BrowserWindow | null = null;

// file:// 下 ES module 受 CORS 限制无法加载，注册特权自定义协议作为渲染层 origin。
// 必须在 app ready 之前声明特权，之后才能 protocol.handle。
const RENDERER_SCHEME = 'seapp';
protocol.registerSchemesAsPrivileged([
  { scheme: RENDERER_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

function registerRendererProtocol(): void {
  const rendererDir = join(__dirname, '../renderer');
  protocol.handle(RENDERER_SCHEME, (request) => {
    const pathname = decodeURIComponent(new URL(request.url).pathname);
    const filePath = normalize(join(rendererDir, pathname));
    // 防目录穿越：协议根必须收敛在渲染层产物目录内。
    if (filePath !== rendererDir && !filePath.startsWith(rendererDir + sep)) {
      return new Response('forbidden', { status: 403 });
    }
    return net.fetch(pathToFileURL(filePath).toString());
  });
}

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
    void mainWindow.loadURL(`${RENDERER_SCHEME}://app/index.html`);
  }
}

function registerIpc(): void {
  const dataDir = app.getPath('userData');
  const handle = openDatabase(join(dataDir, 'shadowedge.db'));
  const keyring = loadKeyring(dataDir);
  const sessions = new SessionRepository(handle);
  // 上次异常退出留下的未关闭会话统一收口，避免状态假活。
  const orphans = sessions.sweepOrphans();
  if (orphans > 0) logger.info('清理异常退出会话', { count: orphans });

  const handlers = createHandlers({
    logger: logger.child({ component: 'handlers' }),
    emit: (event, payload) => mainWindow?.webContents.send(event, payload),
    profileRepo: new ProfileRepository(handle),
    proxyRepo: new ProxyRepository(handle, keyring),
    audit: new AuditLog(handle),
    sessions,
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
  registerRendererProtocol();
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
