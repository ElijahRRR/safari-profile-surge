// 原生消息客户端：只在后台脚本（以及演示模式下页面内的替身后台）中使用。
// 应答一律整理成 NativeResponse；传输失败不回显原始错误文本（可能带本机路径等细节）。

import {
  NATIVE_PROTOCOL_VERSION,
  type ApiErrorBody,
  type LoginFillResponse,
  type NativeEnvelope,
  type NativeRequest,
  type NativeRequestType,
  type NativeResponse,
  type NativeResponseMap,
} from '@sfe/contract';

/** 扩展看到的应答：requestLoginFill 由原生桥解析钥匙串引用后给值。 */
export type ExtensionResponseMap = Omit<NativeResponseMap, 'requestLoginFill'> & { requestLoginFill: LoginFillResponse };

export type RequestOf<K extends NativeRequestType> = Extract<NativeRequest, { type: K }>;

export interface NativeTransport {
  send(envelope: NativeEnvelope): Promise<unknown>;
}

export interface NativeClient {
  call<K extends NativeRequestType>(message: RequestOf<K>): Promise<NativeResponse<ExtensionResponseMap[K]>>;
}

/** 原生桥自身有 10 秒超时；这里略长，避免页面无限等待。 */
export const NATIVE_TIMEOUT_MS = 15000;

export const NATIVE_REQUEST_TYPES: readonly NativeRequestType[] = [
  'getCurrentState',
  'reportProfileState',
  'bindCurrentProfile',
  'createAndBindEnvironment',
  'updateCurrentEnvironment',
  'activateCurrentEnvironment',
  'enterNormalMode',
  'probeCurrentEnvironment',
  'acknowledgeAccountChange',
  'getOperation',
  'cancelOperation',
  'acknowledgeWindowsClosed',
  'beginSafariVerification',
  'submitSafariVerification',
  'requestLoginFill',
];

export function isNativeRequestType(value: unknown): value is NativeRequestType {
  return typeof value === 'string' && (NATIVE_REQUEST_TYPES as readonly string[]).includes(value);
}

export function failure(code: ApiErrorBody['code'], message: string, details?: Record<string, unknown>): { ok: false; error: ApiErrorBody } {
  const error: ApiErrorBody = { code, message };
  if (details) error.details = details;
  return { ok: false, error };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 把任意应答整理成 NativeResponse；格式不对时给出统一错误。 */
export function parseNativeResponse<T>(raw: unknown): NativeResponse<T> {
  if (isObject(raw)) {
    if (raw.ok === true && 'data' in raw) return { ok: true, data: raw.data as T };
    if (raw.ok === false && isObject(raw.error) && typeof raw.error.code === 'string' && typeof raw.error.message === 'string') {
      return { ok: false, error: raw.error as unknown as ApiErrorBody };
    }
    // HTTP 风格的错误体 { error: {...} }（演示端点可能这样返回）。
    if (!('ok' in raw) && isObject(raw.error) && typeof raw.error.code === 'string' && typeof raw.error.message === 'string') {
      return { ok: false, error: raw.error as unknown as ApiErrorBody };
    }
  }
  return failure('INTERNAL', '读取本机服务应答失败：格式不正确');
}

export function createNativeClient(transport: NativeTransport, opts: { timeoutMs?: number } = {}): NativeClient {
  const timeoutMs = opts.timeoutMs ?? NATIVE_TIMEOUT_MS;
  return {
    async call<K extends NativeRequestType>(message: RequestOf<K>): Promise<NativeResponse<ExtensionResponseMap[K]>> {
      const envelope: NativeEnvelope = { v: NATIVE_PROTOCOL_VERSION, message };
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs);
      });
      try {
        const raw = await Promise.race([transport.send(envelope), timeout]);
        if (raw === 'timeout') return failure('UNKNOWN_STATE', '连接本机服务失败：等待应答超时，结果未知');
        return parseNativeResponse<ExtensionResponseMap[K]>(raw);
      } catch {
        return failure('INTERNAL', '连接本机服务失败：原生桥不可用，请确认宿主 App 已安装并运行');
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
  };
}
