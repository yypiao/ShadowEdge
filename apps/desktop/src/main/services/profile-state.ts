import type { BrowserContext } from 'patchright';
import type { BrowserStorageState } from '@shadowedge/core';
import { ShadowEdgeError } from '@shadowedge/core';
import type { BrowserKernel } from '@shadowedge/kernel';

export async function captureStorageState(context: BrowserContext): Promise<BrowserStorageState> {
  return context.storageState({ indexedDB: true });
}

export function countIndexedDatabases(state: BrowserStorageState): number {
  return state.origins.reduce((count, origin) => count + (origin.indexedDB?.length ?? 0), 0);
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
