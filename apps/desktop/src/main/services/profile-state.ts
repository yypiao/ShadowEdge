import type { BrowserContext } from 'patchright';
import type { BrowserStorageState } from '@shadowedge/core';
import { ShadowEdgeError } from '@shadowedge/core';
import type { BrowserKernel } from '@shadowedge/kernel';

const MAX_OPFS_FILES = 2000;
const MAX_OPFS_TOTAL_BYTES = 128 * 1024 * 1024;
const MAX_OPFS_ENTRIES = 4000;

export async function captureStorageState(context: BrowserContext): Promise<BrowserStorageState> {
  const state = await context.storageState({ indexedDB: true, opfs: true });
  if (!withinOpfsBudget(state)) {
    throw new ShadowEdgeError(
      'E_STORAGE_STATE_FAILED',
      `OPFS 超过安全上限（${MAX_OPFS_FILES} 个文件 / ${MAX_OPFS_TOTAL_BYTES / 1024 / 1024}MB）`,
    );
  }
  return state;
}

/** 限制必须跨 origin 汇总，否则拆到多个站点即可绕过备份内存与磁盘预算。 */
export function withinOpfsBudget(state: Pick<BrowserStorageState, 'origins'>): boolean {
  let entries = 0;
  let files = 0;
  let totalBytes = 0;
  for (const origin of state.origins) {
    entries += origin.opfs?.length ?? 0;
    if (entries > MAX_OPFS_ENTRIES) return false;
    for (const entry of origin.opfs ?? []) {
      if (entry.type !== 'file') continue;
      files += 1;
      totalBytes += Buffer.from(entry.base64, 'base64').length;
      if (files > MAX_OPFS_FILES || totalBytes > MAX_OPFS_TOTAL_BYTES) return false;
    }
  }
  return true;
}

export function countIndexedDatabases(state: BrowserStorageState): number {
  return state.origins.reduce((count, origin) => count + (origin.indexedDB?.length ?? 0), 0);
}

export function countOpfsFiles(state: BrowserStorageState): number {
  return state.origins.reduce((count, origin) => count +
    (origin.opfs?.filter((entry) => entry.type === 'file').length ?? 0), 0);
}

/** 有遗留目录时优先恢复崩溃前较新的 Chromium 状态，不能用旧快照覆盖它。 */
export async function restoreOrCheckpointState(
  kernel: BrowserKernel,
  profileId: string,
  hadExistingDirectory: boolean,
  pending: BrowserStorageState | undefined,
  save: (state: BrowserStorageState) => void,
): Promise<void> {
  const context = kernel.getAutomationContext(profileId);
  if (pending && !hadExistingDirectory) {
    await context.setStorageState(pending);
  } else if (pending) {
    // 会话 Cookie 及尚未刷盘的持久 Cookie 可能不在目录；同名同域路径以目录为准。
    const current = await context.cookies();
    const missing = pending.cookies.filter((cookie) => !current.some((item) =>
      item.name === cookie.name && item.domain === cookie.domain && item.path === cookie.path));
    if (missing.length > 0) await context.addCookies(missing);
  }
  // 新建环境也保存空基线；异常退出后可明确区分“有快照”与“从未初始化”。
  save(await captureStorageState(context));
}

export async function openStartupPages(
  context: BrowserContext,
  urls: string[],
): Promise<Array<{ url: string; error: string }>> {
  const failures: Array<{ url: string; error: string }> = [];
  if (urls.length === 0) return failures;
  const initial = context.pages()[0];
  for (const [index, url] of urls.entries()) {
    const page = index === 0 && initial && initial.url() === 'about:blank'
      ? initial
      : await context.newPage();
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (error) {
      failures.push({ url, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return failures;
}

export function storageStateFailure(message: string, cause: unknown): ShadowEdgeError {
  return new ShadowEdgeError('E_STORAGE_STATE_FAILED', message, { retryable: true, cause });
}
