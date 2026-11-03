import { createRequire } from 'node:module';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
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

describe.skipIf(!SMOKE)('Electron 环境管理 UI', () => {
  it('分组、搜索、编辑、启动 URL 与安全删除形成完整闭环', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shadowedge-profile-management-ui-'));
    let electronApp: ElectronApplication | undefined;
    let page: Page;
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
      await page.getByLabel('新分组名称').fill('美区店铺');
      await page.getByRole('button', { name: '创建分组', exact: true }).click();
      await page.getByLabel('按分组筛选').locator('option', { hasText: '美区店铺' }).waitFor({ state: 'attached' });

      await page.getByRole('button', { name: '+ 新建 / 批量创建' }).click();
      await page.getByPlaceholder('例如：美区亚马逊-01').fill('management-ui');
      await page.getByLabel('环境分组', { exact: true }).selectOption({ label: '美区店铺' });
      await page.getByLabel('启动页面', { exact: true }).fill('http://127.0.0.1:8765/start');
      await page.getByLabel('环境备注', { exact: true }).fill('UI 管理测试');
      await page.getByRole('button', { name: '创建环境', exact: true }).click();
      await page.locator('article').filter({ hasText: 'management-ui' }).waitFor();

      await page.getByLabel('搜索环境').fill('no-such-profile');
      await page.getByText('没有符合当前搜索或分组条件的环境。').waitFor();
      expect(await page.locator('article').count()).toBe(0);
      await page.getByLabel('搜索环境').fill('management');
      expect(await page.locator('article').count()).toBe(1);
      await page.getByLabel('按分组筛选').selectOption({ label: '美区店铺' });
      expect(await page.locator('article').count()).toBe(1);

      await page.getByRole('button', { name: '编辑', exact: true }).click();
      await page.getByLabel('编辑环境名称').fill('management-renamed');
      await page.getByLabel('编辑启动页面').fill('https://example.com/dashboard\nhttp://127.0.0.1:8765/start');
      await page.getByLabel('编辑环境备注').fill('已编辑');
      await page.getByRole('button', { name: '保存修改', exact: true }).click();
      await page.locator('article').filter({ hasText: 'management-renamed' }).waitFor();

      page.once('dialog', (dialog) => dialog.accept());
      await page.getByRole('button', { name: '删除', exact: true }).click();
      await page.getByText('暂无环境。点击「新建 / 批量创建」创建第一个隔离环境。').waitFor();
      expect(readdirSync(join(dir, 'electron-data', 'profiles'))).toEqual([]);

      await electronApp.close();
      electronApp = undefined;
      const db = new DatabaseSync(join(dir, 'electron-data', 'shadowedge.db'), { readOnly: true });
      const profileCount = db.prepare('SELECT COUNT(*) AS count FROM profiles').get() as { count: number };
      const groupCount = db.prepare('SELECT COUNT(*) AS count FROM profile_groups').get() as { count: number };
      db.close();
      expect(profileCount.count).toBe(0);
      expect(groupCount.count).toBe(1);
    } finally {
      await electronApp?.close().catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120000);
});
