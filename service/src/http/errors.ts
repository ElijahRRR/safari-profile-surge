// HTTP 与本机套接字共用的错误映射。SfeError 原样给出脱敏的错误体；其他异常一律换成不含
// 栈、原文与细节的通用错误，避免把子进程输出或内部状态带给调用方。

import { SfeError, httpStatusFor, ERROR_CODES, type ApiErrorBody, type ErrorCode } from '@sfe/contract';
import type { Logger } from '../ports.js';

/** 传输层只需要 log；不要求 child()，便于测试注入。 */
export type TransportLogger = Pick<Logger, 'log'>;

export const INTERNAL_MESSAGE = '服务内部错误';

export function internalErrorBody(): ApiErrorBody {
  return { code: 'INTERNAL', message: INTERNAL_MESSAGE };
}

function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value);
}

/** 也接受另一份 contract 副本构造的 SfeError（instanceof 可能失效）。 */
export function isSfeError(err: unknown): err is SfeError {
  if (err instanceof SfeError) return true;
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: unknown; code?: unknown; message?: unknown; toBody?: unknown };
  return e.name === 'SfeError' && isErrorCode(e.code) && typeof e.message === 'string' && typeof e.toBody === 'function';
}

export function errorBodyFor(err: unknown): { status: number; body: ApiErrorBody } {
  if (isSfeError(err)) {
    let body: ApiErrorBody;
    try {
      body = err.toBody();
    } catch {
      body = { code: err.code, message: err.message };
    }
    return { status: httpStatusFor(body.code), body };
  }
  return { status: 500, body: internalErrorBody() };
}

export function errorBody(code: ErrorCode, message: string): ApiErrorBody {
  return { code, message };
}

/** 记录用的错误名：只取类名，从不记录 message（可能夹带子进程输出）。 */
export function errorKind(err: unknown): string {
  if (isSfeError(err)) return err.code;
  if (err instanceof Error) return err.name.slice(0, 64);
  return typeof err;
}
