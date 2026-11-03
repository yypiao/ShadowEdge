import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { _electron, type ElectronApplication, type Page } from 'patchright';

const executablePath = process.env.SHADOWEDGE_KERNEL_EXECUTABLE;
const SMOKE = process.env.SHADOWEDGE_SMOKE === '1' && executablePath !== undefined;
const electronBinary = createRequire(import.meta.url)('electron') as string;
const appRoot = fileURLToPath(new URL('..', import.meta.url));

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

describe.skipIf(!SMOKE)('Electron 退出与异常状态恢复', () => {
  it('退出回收真实 Chromium，重启清理假运行状态并可再次启动', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shadowedge-app-lifecycle-'));
    const dbPath = join(dir, 'electron-data', 'shadowedge.db');
    const browserPids: number[] = [];
    let electronApp: ElectronApplication | undefined;
    let page: Page;

    const launchApp = async () => {
      electronApp = await _electron.launch({
        executablePath: electronBinary,
        args: [appRoot, `--user-data-dir=${join(dir, 'electron-data')}`],
        cwd: dir,
        env: { ...process.env, SHADOWEDGE_KERNEL_EXECUTABLE: executablePath! },
      });
      page = await electronApp.firstWindow();
    };
    const readLatestPid = () => {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      const row = db
        .prepare('SELECT pid FROM sessions ORDER BY started_at DESC LIMIT 1')
        .get() as { pid: number };
      db.close();
      browserPids.push(row.pid);
      return row.pid;
    };

    try {
      await launchApp();
      await page.getByRole('button', { name: '+ 新建 / 批量创建' }).click();
      await page.getByPlaceholder('例如：美区亚马逊-01').fill('lifecycle-quit');
      await page.getByRole('button', { name: '创建环境', exact: true }).click();
      const card = page.locator('article').filter({ hasText: 'lifecycle-quit' });
      await card.waitFor();
      await card.getByRole('button', { name: '启动', exact: true }).click();
      await card.getByText('● 运行中', { exact: true }).waitFor();
      const firstPid = readLatestPid();

      await electronApp.close();
      electronApp = undefined;
      await expect.poll(() => isRunning(firstPid), { timeout: 15000 }).toBe(false);

      // 模拟上次崩溃留下的假运行状态，验证下次启动的恢复入口。
      const db = new DatabaseSync(dbPath);
      db.prepare("UPDATE profiles SET status = 'running'").run();
      db.prepare('UPDATE sessions SET ended_at = NULL WHERE ended_at IS NOT NULL').run();
      db.close();

      await launchApp();
      const restoredCard = page.locator('article').filter({ hasText: 'lifecycle-quit' });
      await restoredCard.getByText('● 空闲', { exact: true }).waitFor();
      await restoredCard.getByRole('button', { name: '启动', exact: true }).click();
      await restoredCard.getByText('● 运行中', { exact: true }).waitFor();
      const secondPid = readLatestPid();

      await electronApp.close();
      electronApp = undefined;
      await expect.poll(() => isRunning(secondPid), { timeout: 15000 }).toBe(false);
      const finalDb = new DatabaseSync(dbPath, { readOnly: true });
      const state = finalDb
        .prepare("SELECT status FROM profiles WHERE name = 'lifecycle-quit'")
        .get() as { status: string };
      const openSessions = finalDb
        .prepare('SELECT COUNT(*) AS count FROM sessions WHERE ended_at IS NULL')
        .get() as { count: number };
      finalDb.close();
      expect(state.status).toBe('idle');
      expect(openSessions.count).toBe(0);
    } finally {
      await electronApp?.close().catch(() => undefined);
      for (const pid of browserPids) {
        if (isRunning(pid)) process.kill(pid, 'SIGKILL');
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120000);
});
