import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
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

describe.skipIf(!SMOKE)('Electron RPA 工作流闭环', () => {
  it('通过界面编排、保存、运行并查看真实输出与产物', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shadowedge-rpa-ui-'));
    let server: Server | undefined;
    let electronApp: ElectronApplication | undefined;
    let page: Page;
    try {
      server = createServer((_request, response) => {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(`<!doctype html>
          <input id="name">
          <button id="submit" onclick="document.querySelector('#result').textContent = 'Hello ' + document.querySelector('#name').value">Submit</button>
          <output id="result"></output>`);
      });
      await new Promise<void>((resolve, reject) => {
        server!.once('error', reject);
        server!.listen(0, '127.0.0.1', () => resolve());
      });
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

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
      await page.getByPlaceholder('例如：美区亚马逊-01').fill('rpa-ui');
      await page.getByRole('button', { name: '创建环境', exact: true }).click();
      const profileCard = page.locator('article').filter({ hasText: 'rpa-ui' });
      await profileCard.waitFor();
      await profileCard.getByRole('button', { name: '启动', exact: true }).click();
      await profileCard.getByText('● 运行中', { exact: true }).waitFor();

      await page.getByRole('button', { name: '自动化', exact: true }).click();
      await page.getByLabel('录制环境').selectOption({ label: 'rpa-ui' });
      await page.getByLabel('录制起始 URL').fill(origin);
      await page.getByRole('button', { name: '开始录制', exact: true }).click();
      await page.getByRole('button', { name: '停止并生成工作流', exact: true }).click();
      await page.getByText('录制已生成，可编辑、保存并回放', { exact: true }).waitFor();
      expect(await page.locator('[data-node-kind]').count()).toBe(1);
      await page.getByRole('button', { name: '新建工作流', exact: true }).click();
      const addNode = async (label: string) => {
        await page.getByLabel('待添加节点类型').selectOption({ label });
        await page.getByRole('button', { name: '添加节点', exact: true }).click();
      };
      for (const label of ['选择下拉项', '设置复选框', '上传文件', '点击并下载', '新建标签页', '切换标签页']) {
        await addNode(label);
      }
      expect(await page.locator('[data-node-kind]').count()).toBe(7);
      await page.locator('[data-node-kind="select"] input').first().waitFor();
      await page.locator('[data-node-kind="upload"] input').first().waitFor();
      await page.locator('[data-node-kind="newTab"] input').first().waitFor();
      expect(await page.locator('[data-node-kind="switchTab"] input[type="number"]').inputValue()).toBe('0');

      // 高级节点只验证编辑器；随后另建可实际运行的导航/输入/点击工作流。
      await page.getByRole('button', { name: '新建工作流', exact: true }).click();
      await expect.poll(() => page.locator('[data-node-kind]').count()).toBe(1);
      await page.getByLabel('工作流名称').fill('UI RPA');
      await page.getByLabel('页面 URL').fill(origin);
      await addNode('输入文本');
      await addNode('点击元素');
      await addNode('提取文本');
      await addNode('截图');
      await addNode('条件分支');
      await addNode('等待');
      await addNode('计数循环');
      await page.locator('[data-node-kind="loop"] input[type="number"]').fill('2');
      expect(await page.locator('[data-node-kind]').count()).toBe(8);
      await page.getByRole('button', { name: '保存工作流', exact: true }).click();
      await page.getByText('工作流「UI RPA」已保存', { exact: true }).waitFor();
      await page.getByLabel('定时环境', { exact: true }).selectOption({ label: 'rpa-ui' });
      await page.getByLabel('定时间隔', { exact: true }).fill('5');
      await page.getByRole('button', { name: '启用定时', exact: true }).click();
      await page.getByText('定时任务已启用', { exact: true }).waitFor();
      await page.getByRole('button', { name: '停用定时', exact: true }).click();
      await page.getByText('定时任务已停用', { exact: true }).waitFor();

      await page.getByLabel('运行环境 rpa-ui').check();
      await page.getByRole('button', { name: '运行工作流', exact: true }).click();
      await page.getByText('"result": "Hello Ada"', { exact: false }).waitFor({ timeout: 30000 });
      await page.getByRole('button', { name: '打开 result.png', exact: true }).waitFor();
      await page.getByRole('button', { name: '打开 outputs.json', exact: true }).waitFor();

      const dbPath = join(dir, 'electron-data', 'shadowedge.db');
      const db = new DatabaseSync(dbPath, { readOnly: true });
      const workflow = db.prepare('SELECT name, version, graph FROM rpa_workflows').get() as {
        name: string;
        version: number;
        graph: string;
      };
      const run = db.prepare('SELECT status, outputs, artifacts FROM rpa_runs').get() as {
        status: string;
        outputs: string;
        artifacts: string;
      };
      db.close();
      expect(workflow).toMatchObject({ name: 'UI RPA', version: 1 });
      const graph = JSON.parse(workflow.graph) as { nodes: Record<string, { kind: string }> };
      expect(Object.values(graph.nodes).map((node) => node.kind)).toEqual(
        expect.arrayContaining(['condition', 'loop']),
      );
      expect(run.status).toBe('succeeded');
      expect(JSON.parse(run.outputs)).toEqual({ result: 'Hello Ada' });
      const artifacts = JSON.parse(run.artifacts) as Array<{ uri: string }>;
      expect(artifacts).toHaveLength(2);
      for (const artifact of artifacts) expect(statSync(artifact.uri).size).toBeGreaterThan(0);

      await page.getByRole('button', { name: '环境管理', exact: true }).click();
      await page.getByRole('button', { name: '自动化', exact: true }).click();
      await page.getByRole('button', { name: /UI RPA/ }).click();
      await expect.poll(() => page.getByLabel('工作流名称').inputValue()).toBe('UI RPA');
      await page.getByText('"result": "Hello Ada"', { exact: false }).waitFor();
    } finally {
      await electronApp?.close().catch(() => undefined);
      if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120000);
});
