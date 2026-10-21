// 统一错误码。message 为面向用户的简体中文，按「动作 + 失败：原因」书写；details 不含任何凭据。

export const ERROR_CODES = [
  'VALIDATION_FAILED',
  'REVISION_CONFLICT',
  'NOT_FOUND',
  'DUPLICATE_REQUEST_MISMATCH',
  'PROFILE_UNBOUND',
  'PROFILE_ALREADY_BOUND',
  'ENVIRONMENT_ALREADY_BOUND',
  'BINDING_MISMATCH',
  'NEEDS_CONFIRMATION',
  'CAPABILITY_UNVERIFIED',
  'ROUTE_BUSY',
  'STALE_ROUTE_EPOCH',
  'NODE_NOT_DEPLOYED',
  'UNSAFE_CREDENTIAL_CHARS',
  'NAME_COLLISION',
  'FRONT_PROXY_MISSING',
  'FRONT_PROXY_CYCLE',
  'SURGE_UNREACHABLE',
  'TAKEOVER_LOST',
  'EXTERNAL_PROFILE',
  'PRECEDENCE_VIOLATION',
  'SURGE_CHECK_FAILED',
  'SURGE_COMMAND_FAILED',
  'BASELINE_CHANGED',
  'RESOURCE_MISSING',
  'READBACK_MISMATCH',
  'PREFLIGHT_FAILED',
  'SAFARI_VERIFY_FAILED',
  'SAFARI_VERIFY_TIMEOUT',
  'EXIT_IP_MISMATCH',
  'UNKNOWN_STATE',
  'SUPERSEDED',
  'EVIDENCE_REQUIRED',
  'UNSAFE_LOCATION',
  'IMPORT_REJECTED',
  'FILL_NOT_ALLOWED',
  'SECRET_STORE_FAILED',
  'AUTH_REQUIRED',
  'CSRF_FAILED',
  'FORBIDDEN_ORIGIN',
  'RATE_LIMITED',
  'BAD_REQUEST',
  'INTERNAL',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface FieldError {
  /** 字段路径，例如 proxy.port、rows[3].proxy.host */
  field: string;
  message: string;
}

export interface ApiErrorBody {
  code: ErrorCode;
  message: string;
  fieldErrors?: FieldError[];
  /** 冲突时返回当前版本与脱敏差异；能力不足时列出缺失能力等。仅含脱敏数据。 */
  details?: Record<string, unknown>;
}

export interface ApiErrorResponse {
  error: ApiErrorBody;
}

export const HTTP_STATUS_BY_CODE: Partial<Record<ErrorCode, number>> = {
  VALIDATION_FAILED: 422,
  UNSAFE_CREDENTIAL_CHARS: 422,
  IMPORT_REJECTED: 422,
  FRONT_PROXY_MISSING: 422,
  FRONT_PROXY_CYCLE: 422,
  EVIDENCE_REQUIRED: 422,
  UNSAFE_LOCATION: 422,
  REVISION_CONFLICT: 409,
  DUPLICATE_REQUEST_MISMATCH: 409,
  PROFILE_ALREADY_BOUND: 409,
  ENVIRONMENT_ALREADY_BOUND: 409,
  NEEDS_CONFIRMATION: 409,
  ROUTE_BUSY: 409,
  STALE_ROUTE_EPOCH: 409,
  SUPERSEDED: 409,
  BASELINE_CHANGED: 409,
  EXTERNAL_PROFILE: 409,
  NAME_COLLISION: 409,
  NOT_FOUND: 404,
  PROFILE_UNBOUND: 403,
  BINDING_MISMATCH: 403,
  FILL_NOT_ALLOWED: 403,
  CAPABILITY_UNVERIFIED: 412,
  NODE_NOT_DEPLOYED: 412,
  TAKEOVER_LOST: 412,
  PRECEDENCE_VIOLATION: 412,
  AUTH_REQUIRED: 401,
  CSRF_FAILED: 403,
  FORBIDDEN_ORIGIN: 403,
  RATE_LIMITED: 429,
  BAD_REQUEST: 400,
  SURGE_UNREACHABLE: 503,
  INTERNAL: 500,
};

export class SfeError extends Error {
  readonly code: ErrorCode;
  readonly fieldErrors: FieldError[] | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message: string, opts?: { fieldErrors?: FieldError[]; details?: Record<string, unknown>; cause?: unknown }) {
    super(message, opts?.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'SfeError';
    this.code = code;
    this.fieldErrors = opts?.fieldErrors;
    this.details = opts?.details;
  }

  toBody(): ApiErrorBody {
    const body: ApiErrorBody = { code: this.code, message: this.message };
    if (this.fieldErrors?.length) body.fieldErrors = this.fieldErrors;
    if (this.details) body.details = this.details;
    return body;
  }
}

export function httpStatusFor(code: ErrorCode): number {
  return HTTP_STATUS_BY_CODE[code] ?? 500;
}
