// 原生桥服务（docs/ARCHITECTURE.md §2、§7.2）。传输待 P0（native_bridge_ipc）定案：回环 TCP 或 Unix 套接字。
// 一个连接一条 NDJSON 请求；首字节不是 `{` 立即断开。令牌用定长摘要做恒定时间比较；只有令牌正确时才采信
// bridge.profileId。从不记录消息内容、场景 ID 或令牌，只记类型、结果与错误码。

import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { performance } from 'node:perf_hooks';
import {
  NATIVE_MAX_MESSAGE_BYTES,
  NATIVE_PERMISSIONS,
  NATIVE_PROTOCOL_VERSION,
  SfeError,
  type ApiErrorBody,
  type BridgeEnvelope,
  type NativeRequest,
  type NativeResponse,
} from '@sfe/contract';
import type { AppService } from '../app.js';
import { errorBodyFor, errorKind, type TransportLogger } from '../http/errors.js';
import { dropConnection, readLine, writeLineAndClose } from './ndjson.js';
import { listenUnixSocket, removeSocketFile } from './unix-socket.js';

export const BRIDGE_PROFILE_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const BRIDGE_VERSION_RE = /^[\x21-\x7e]{1,64}$/;
export const BRIDGE_READ_TIMEOUT_MS = 10_000;

export type BridgeTransport = { kind: 'tcp'; host: '127.0.0.1'; port: number } | { kind: 'unix'; path: string };
export type BridgeAddress = { kind: 'tcp'; host: '127.0.0.1'; port: number } | { kind: 'unix'; path: string };

export interface BridgeServerOptions {
  app: AppService;
  transport: BridgeTransport;
  /** 当前传输令牌（每次安装随机，由宿主 App 分发）；空串表示未配置，拒绝一切请求。 */
  token: () => string;
  logger: TransportLogger;
  readTimeoutMs?: number;
}

export interface BridgeServerHandle {
  listen(): Promise<BridgeAddress>;
  close(): Promise<void>;
  address(): BridgeAddress | null;
}

const digest = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest();

/** 恒定时间比较：先取定长摘要，避免长度差异提前返回。 */
export function tokenMatches(presented: unknown, expected: string): boolean {
  if (typeof presented !== 'string' || presented.length === 0 || expected.length === 0) return false;
  return timingSafeEqual(digest(presented), digest(expected));
}

const BAD = (message: string): ApiErrorBody => ({ code: 'BAD_REQUEST', message });
const AUTH_FAILED: ApiErrorBody = { code: 'AUTH_REQUIRED', message: '连接本机服务失败：原生桥认证失败' };

export type BridgeValidation = { ok: true; envelope: BridgeEnvelope } | { ok: false; error: ApiErrorBody };

/** 校验顺序：形状 → 令牌 → 版本 → 场景 ID → 消息类型。令牌错误时不再给出其他细节。 */
export function validateBridgeEnvelope(raw: unknown, expectedToken: string): BridgeValidation {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: BAD('原生消息无效：格式不正确') };
  const env = raw as Record<string, unknown>;
  if (!tokenMatches(env.auth, expectedToken)) return { ok: false, error: AUTH_FAILED };
  if (env.v !== NATIVE_PROTOCOL_VERSION) return { ok: false, error: BAD('原生消息无效：协议版本不受支持') };
  const bridge = env.bridge;
  if (!bridge || typeof bridge !== 'object' || Array.isArray(bridge)) return { ok: false, error: BAD('原生消息无效：缺少原生桥信息') };
  const { profileId, bridgeVersion } = bridge as Record<string, unknown>;
  if (profileId !== null && (typeof profileId !== 'string' || !BRIDGE_PROFILE_ID_RE.test(profileId))) {
    return { ok: false, error: BAD('原生消息无效：场景编号格式不正确') };
  }
  if (typeof bridgeVersion !== 'string' || !BRIDGE_VERSION_RE.test(bridgeVersion)) return { ok: false, error: BAD('原生消息无效：原生桥版本格式不正确') };
  const message = env.message;
  if (!message || typeof message !== 'object' || Array.isArray(message)) return { ok: false, error: BAD('原生消息无效：缺少消息') };
  const type = (message as { type?: unknown }).type;
  if (typeof type !== 'string' || !Object.hasOwn(NATIVE_PERMISSIONS, type)) return { ok: false, error: BAD('原生消息无效：消息类型不受支持') };
  return {
    ok: true,
    envelope: {
      v: NATIVE_PROTOCOL_VERSION,
      auth: env.auth as string,
      bridge: { profileId: profileId as string | null, bridgeVersion },
      message: message as NativeRequest,
    },
  };
}

export function createBridgeServer(opts: BridgeServerOptions): BridgeServerHandle {
  if (opts.transport.kind === 'tcp' && opts.transport.host !== '127.0.0.1') {
    throw new SfeError('UNSAFE_LOCATION', '启动原生桥失败：只能监听 127.0.0.1');
  }
  const readTimeoutMs = opts.readTimeoutMs ?? BRIDGE_READ_TIMEOUT_MS;
  let server: Server | null = null;
  let bound: BridgeAddress | null = null;
  const sockets = new Set<Socket>();

  const log = (fields: Record<string, unknown>): void => {
    opts.logger.log(fields.errorCode && fields.errorCode !== 'AUTH_REQUIRED' && fields.errorCode !== 'BAD_REQUEST' ? 'warn' : 'info', 'bridge.request', fields);
  };

  async function handleConnection(socket: Socket): Promise<void> {
    const started = performance.now();
    const ms = (): number => Math.round(performance.now() - started);
    const r = await readLine(socket, { maxBytes: NATIVE_MAX_MESSAGE_BYTES, timeoutMs: readTimeoutMs, requireJsonObject: true });
    if (r.kind === 'bad_first_byte' || r.kind === 'timeout' || r.kind === 'closed') {
      dropConnection(socket);
      if (r.kind !== 'closed') log({ result: r.kind, durationMs: ms() });
      return;
    }
    if (r.kind === 'too_large') {
      await writeLineAndClose(socket, { ok: false, error: BAD('原生消息无效：消息超过 256 KiB 上限') } satisfies NativeResponse);
      log({ result: 'too_large', errorCode: 'BAD_REQUEST', durationMs: ms() });
      return;
    }
    if (r.kind === 'invalid_utf8') {
      await writeLineAndClose(socket, { ok: false, error: BAD('原生消息无效：不是有效的 UTF-8') } satisfies NativeResponse);
      log({ result: 'invalid_utf8', errorCode: 'BAD_REQUEST', durationMs: ms() });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(r.line);
    } catch {
      await writeLineAndClose(socket, { ok: false, error: BAD('原生消息无效：不是有效的 JSON') } satisfies NativeResponse);
      log({ result: 'invalid_json', errorCode: 'BAD_REQUEST', durationMs: ms() });
      return;
    }
    let expected = '';
    try {
      expected = opts.token();
    } catch {
      expected = '';
    }
    const v = validateBridgeEnvelope(parsed, expected);
    if (!v.ok) {
      await writeLineAndClose(socket, { ok: false, error: v.error } satisfies NativeResponse);
      log({ result: 'rejected', errorCode: v.error.code, durationMs: ms() });
      return;
    }
    const type = v.envelope.message.type;
    let response: NativeResponse;
    try {
      response = await opts.app.handleNative(v.envelope);
    } catch (err) {
      response = { ok: false, error: errorBodyFor(err).body };
      log({ type, result: 'error', errorCode: response.error.code, errorKind: errorKind(err), durationMs: ms() });
      await writeLineAndClose(socket, response);
      return;
    }
    await writeLineAndClose(socket, response);
    log({ type, result: response.ok ? 'ok' : 'error', ...(response.ok ? {} : { errorCode: response.error.code }), durationMs: ms() });
  }

  return {
    async listen() {
      if (server) throw new SfeError('INTERNAL', '服务内部错误');
      const s = createServer({ allowHalfOpen: true, pauseOnConnect: true }, (socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        socket.on('error', () => undefined);
        void handleConnection(socket).catch(() => socket.destroy());
      });
      s.maxConnections = 64;
      server = s;
      try {
        if (opts.transport.kind === 'unix') {
          await listenUnixSocket(s, opts.transport.path, { requirePrivateParent: false });
          bound = { kind: 'unix', path: opts.transport.path };
        } else {
          const { port } = opts.transport;
          await new Promise<void>((resolve, reject) => {
            s.once('error', reject);
            s.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
              s.off('error', reject);
              resolve();
            });
          });
          bound = { kind: 'tcp', host: '127.0.0.1', port: (s.address() as AddressInfo).port };
        }
      } catch (err) {
        server = null;
        throw err;
      }
      return bound;
    },
    async close() {
      const s = server;
      if (!s) return;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => s.close(() => resolve()));
      if (opts.transport.kind === 'unix') removeSocketFile(opts.transport.path);
      server = null;
      bound = null;
    },
    address() {
      return bound;
    },
  };
}
