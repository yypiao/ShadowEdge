import { ShadowEdgeError } from './errors.js';

/** 显式结果类型，用于不希望以异常控制流程的边界（IPC、调度器、批量操作）。 */
export type Result<T, E = ShadowEdgeError> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

export const unwrap = <T, E>(result: Result<T, E>): T => {
  if (result.ok) return result.value;
  throw result.error;
};
