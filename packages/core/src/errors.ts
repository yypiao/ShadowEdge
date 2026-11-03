/** 统一错误模型：所有跨层错误必须携带稳定 code，便于 UI 与 SDK 精确处理。 */

export type ErrorCode =
  | 'E_AUTH_REQUIRED'
  | 'E_ACCOUNT_NOT_FOUND'
  | 'E_ACCOUNT_PASSWORD_REQUIRED'
  | 'E_ACCOUNT_ORIGIN_MISMATCH'
  | 'E_ACCOUNT_SELECTOR_UNSAFE'
  | 'E_PERMISSION_DENIED'
  | 'E_PROFILE_NOT_FOUND'
  | 'E_PROFILE_BUSY'
  | 'E_PROFILE_LOCKED'
  | 'E_PROFILE_NOT_RUNNING'
  | 'E_FINGERPRINT_INCONSISTENT'
  | 'E_CATALOG_SNAPSHOT_MISSING'
  | 'E_PROXY_NOT_FOUND'
  | 'E_PROXY_UNREACHABLE'
  | 'E_PROXY_GEO_MISMATCH'
  | 'E_KERNEL_LAUNCH_FAILED'
  | 'E_KERNEL_NOT_INSTALLED'
  | 'E_SYNC_CONFLICT'
  | 'E_RPA_INVALID_GRAPH'
  | 'E_RPA_INVALID_INPUT'
  | 'E_RPA_RUN_NOT_FOUND'
  | 'E_RPA_WORKFLOW_NOT_FOUND'
  | 'E_RPA_NODE_FAILED'
  | 'E_RPA_CANCELLED'
  | 'E_CRYPTO_UNSEAL_FAILED'
  | 'E_BACKUP_INVALID'
  | 'E_RPA_STEP_FAILED'
  | 'E_QUOTA_EXCEEDED'
  | 'E_INTERNAL';

export class ShadowEdgeError extends Error {
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;
  /** 是否可由调用方安全重试。 */
  readonly retryable: boolean;

  constructor(
    code: ErrorCode,
    message: string,
    options: { details?: Record<string, unknown>; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'ShadowEdgeError';
    this.code = code;
    this.details = options.details;
    this.retryable = options.retryable ?? false;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      details: this.details,
      retryable: this.retryable,
    };
  }
}

export const isShadowEdgeError = (value: unknown): value is ShadowEdgeError =>
  value instanceof ShadowEdgeError;

/** Electron IPC 可结构化克隆的错误载荷；批量 Result 不直接跨进程传 Error 实例。 */
export interface ErrorPayload {
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
  retryable: boolean;
}

export function toErrorPayload(error: unknown): ErrorPayload {
  if (isShadowEdgeError(error)) return error.toJSON();
  return {
    code: 'E_INTERNAL',
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
  };
}
