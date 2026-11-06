import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { _electron, type Page } from 'patchright';

const executablePath = process.env.SHADOWEDGE_KERNEL_EXECUTABLE;
const SMOKE = process.env.SHADOWEDGE_SMOKE === '1' && executablePath !== undefined;
const electronBinary = createRequire(import.meta.url)('electron') as string;
const appRoot = fileURLToPath(new URL('..', import.meta.url));

describe.skipIf(!SMOKE)('Electron 批量环境 UI', () => {
  it('批量创建两个环境，全选后启动并停止，画像保持独立', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shadowedge-profile-batch-ui-'));
    let electronApp: Awaited<ReturnType<typeof _electron.launch>> | undefined;
    let page: Page | undefined;
    try {
      electronApp = await _electron.launch({
        executablePath: electronBinary,
        args: [appRoot, `--user-data-dir=${join(dir, 'electron-data')}`],
        cwd: dir,
        env: {
          ...process.env,
          SHADOWEDGE_KERNEL_EXECUTABLE: executablePath!,
          SHADOWEDGE_KEK: '55'.repeat(32),
        },
      });
      page = await electronApp.firstWindow();
      await page.getByRole('button', { name: '+ 新建 / 批量创建' }).click();
      await page.getByPlaceholder('例如：美区亚马逊-01').fill('batch-ui');
      await page.getByLabel('创建数量').fill('2');
      await page.getByRole('button', { name: '创建环境', exact: true }).click();
      try {
        await page.getByText('batch-ui-01', { exact: true }).waitFor();
      } catch (error) {
        throw new Error(`批量创建后界面未出现环境：\n${await page.locator('body').innerText()}`, {
          cause: error,
        });
      }
      await page.getByText('batch-ui-02', { exact: true }).waitFor();
      expect(await page.locator('article').count()).toBe(2);

      await page.getByLabel('全选环境').check();
      expect(await page.locator('article input[type="checkbox"]:checked').count()).toBe(2);
      await page.getByRole('button', { name: '批量启动 (2)', exact: true }).click();
      await expect
        .poll(() => page!.getByText('● 运行中', { exact: true }).count(), { timeout: 45000 })
        .toBe(2);
      expect(await page.getByText('实际驱动：chromium-cdp', { exact: false }).count()).toBe(2);

      await page.getByRole('button', { name: '批量停止 (2)', exact: true }).click();
      await expect
        .poll(() => page!.getByText('● 空闲', { exact: true }).count(), { timeout: 30000 })
        .toBe(2);
      await electronApp.close();
      electronApp = undefined;

      const dbPath = join(dir, 'electron-data', 'shadowedge.db');
      const db = new DatabaseSync(dbPath, { readOnly: true });
      const rows = db.prepare('SELECT fingerprint FROM profiles').all() as Array<{
        fingerprint: string;
      }>;
      db.close();
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((row) => row.fingerprint)).size).toBe(2);
    } finally {
      if (page && electronApp) {
        const stop = page.getByRole('button', { name: /批量停止 \(\d+\)/ });
        if (await stop.isEnabled().catch(() => false)) {
          await stop.click().catch(() => undefined);
          await page.waitForTimeout(1000);
        }
      }
      await electronApp?.close().catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120000);
});
