import { ShadowEdgeError } from '@shadowedge/core';
import type { RpaNodeExecution } from './session.js';
import { throwIfCancelled } from './executors.js';

/**
 * CDP Promise 本身不接受 AbortSignal。关闭页面迫使挂起调用结束，并等待原调用落定，
 * 避免竞速返回后节点仍在后台修改页面或写入截图。
 */
export async function withHardCancellation<T>(
  execution: RpaNodeExecution,
  operation: () => Promise<T>,
): Promise<T> {
  throwIfCancelled(execution.signal);
  let rejectAbort!: (error: ShadowEdgeError) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(new ShadowEdgeError('E_RPA_CANCELLED', 'RPA 运行已取消'));
  execution.signal.addEventListener('abort', onAbort, { once: true });
  let pending: Promise<T> | undefined;
  try {
    pending = operation();
    return await Promise.race([pending, aborted]);
  } catch (error) {
    if (!execution.signal.aborted) throw error;
    await execution.closePage().catch(() => undefined);
    // 必须等节点原 Promise 落定，不能在关闭页面后立即释放环境互斥锁。
    await pending?.catch(() => undefined);
    throw error;
  } finally {
    execution.signal.removeEventListener('abort', onAbort);
  }
}
