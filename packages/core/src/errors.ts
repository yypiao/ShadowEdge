/** 统一错误模型：所有跨层错误必须携带稳定 code，便于 UI 与 SDK 精确处理。 */

export type ErrorCode =
  | 'E_AUTH_REQUIRED'
  | 'E_PERMISSION_DENIED'
  | 'E_PROFILE_NOT_FOUND'
  | 'E_PROFILE_BUSY'
  | 'E_PROFILE_LOCKED'
  | 'E_FINGERPRINT_INCONSISTENT'
  | 'E_PROXY_UNREACHABLE'
  | 'E_PROXY_GEO_MISMATCH'
  | 'E_KERNEL_LAUNCH_FAILED'
  | 'E_KERNEL_NOT_INSTALLED'
  | 'E_SYNC_CONFLICT'
  | 'E_CRYPTO_UNSEAL_FAILED'
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
    return { code: this.code, message: this.message, details: this.details, retryable: this.retryable };
  }
}

export const isShadowEdgeError = (value: unknown): value is ShadowEdgeError =>
  value instanceof ShadowEdgeError;
