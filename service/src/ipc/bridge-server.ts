// 原生桥服务（docs/ARCHITECTURE.md §2、§7.2）。传输待 P0（native_bridge_ipc）定案：回环 TCP 或 Unix 套接字。
// 一个连接：hello → challenge → request → 一行应答，之后关闭；首字节不是 `{` 立即断开。传输令牌从不上线路：
// 服务先用 HMAC-SHA256 证明自己持有令牌，原生桥验证后才发送带证明的请求；证明用 timingSafeEqual 比较。
// 握手（含请求证明）任何一步失败都直接断开、不回应，也不说明是哪一项不符。只有证明正确时才采信 bridge.profileId。
// 从不记录消息内容、场景 ID、随机数、证明或令牌，只记类型、结果与错误码。

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { performance } from 'node:perf_hooks';
import {
  BRIDGE_CLIENT_PROOF_LABEL,
  BRIDGE_NONCE_BYTES,
  BRIDGE_SERVER_PROOF_LABEL,
  NATIVE_MAX_MESSAGE_BYTES,
  NATIVE_PERMISSIONS,
  NATIVE_PROTOCOL_VERSION,
  SfeError,
  type ApiErrorBody,
  type BridgeChallenge,
  type BridgeEnvelope,
  type NativeRequest,
  type NativeResponse,
} from '@sfe/contract';
import type { AppService } from '../app.js';
import { errorBodyFor, errorKind, type TransportLogger } from '../http/errors.js';
import { dropConnection, readLine, writeLineAndClose } from './ndjson.js';
import { listenUnixSocket, removeSocketFile } from './unix-socket.js';

export const BRIDGE_PROFILE_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
/** 可见 ASCII（0x21–0x7E，不含空格），≤ 64。原生桥发送 "<短版本>+<构建号>"，例如 "0.1.0+1"。 */
export const BRIDGE_VERSION_RE = /^[\x21-\x7e]{1,64}$/;
/** 从连接建立到收完 request 行的总时限：本机往返只需几毫秒，超时即断开。 */
export const BRIDGE_HANDSHAKE_TIMEOUT_MS = 3_000;
/** hello 行上限（正常约 100 字节）。 */
export const BRIDGE_HELLO_MAX_BYTES = 1024;
const HEX_64_RE = /^[0-9a-f]{64}$/;

export type BridgeTransport = { kind: 'tcp'; host: '127.0.0.1'; port: number } | { kind: 'unix'; path: string };
export type BridgeAddress = { kind: 'tcp'; host: '127.0.0.1'; port: number } | { kind: 'unix'; path: string };

export interface BridgeServerOptions {
  app: AppService;
  transport: BridgeTransport;
  /** 当前传输令牌（每次安装随机，由宿主 App 分发），每个连接读取一次；空串表示未配置，拒绝一切连接。 */
  token: () => string;
  logger: TransportLogger;
  handshakeTimeoutMs?: number;
  /** 服务随机数（32 字节十六进制）；只供测试替换。 */
  nonce?: () => string;
}

export interface BridgeServerHandle {
  listen(): Promise<BridgeAddress>;
  close(): Promise<void>;
  address(): BridgeAddress | null;
}

// —— 证明（与 apps/macos/Shared/BridgeHandshake.swift 一致；密钥是令牌的 UTF-8 字节） ——

const hmacHex = (token: string, text: string): string => createHmac('sha256', Buffer.from(token, 'utf8')).update(text, 'utf8').digest('hex');

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function bridgeServerProof(token: string, clientNonce: string, serverNonce: string): string {
  return hmacHex(token, `${BRIDGE_SERVER_PROOF_LABEL}\n${clientNonce}\n${serverNonce}`);
}

export function bridgeClientProof(token: string, serverNonce: string, clientNonce: string, payload: string): string {
  return hmacHex(token, `${BRIDGE_CLIENT_PROOF_LABEL}\n${serverNonce}\n${clientNonce}\n${sha256Hex(payload)}`);
}

/** 恒定时间比较两个 64 位十六进制证明（格式不对直接不符；格式检查不依赖秘密）。 */
export function proofMatches(presented: unknown, expected: string): boolean {
  if (typeof presented !== 'string' || !HEX_64_RE.test(presented) || !HEX_64_RE.test(expected)) return false;
  return timingSafeEqual(Buffer.from(presented, 'hex'), Buffer.from(expected, 'hex'));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** hello：返回客户端随机数；形状不对返回 null。 */
export function parseBridgeHello(raw: unknown): string | null {
  if (!isObject(raw) || raw.v !== NATIVE_PROTOCOL_VERSION || raw.type !== 'hello') return null;
  return typeof raw.clientNonce === 'string' && HEX_64_RE.test(raw.clientNonce) ? raw.clientNonce : null;
}

export type BridgeRequestCheck = { ok: true; v: unknown; payload: string } | { ok: false };

/** request：先确认形状，再用恒定时间比较 clientProof（绑定本连接的两个随机数与 payload 的摘要）。 */
export function verifyBridgeRequest(raw: unknown, token: string, clientNonce: string, serverNonce: string): BridgeRequestCheck {
  if (token.length === 0 || !isObject(raw) || raw.type !== 'request' || typeof raw.payload !== 'string') return { ok: false };
  if (!proofMatches(raw.clientProof, bridgeClientProof(token, serverNonce, clientNonce, raw.payload))) return { ok: false };
  return { ok: true, v: raw.v, payload: raw.payload };
}

const BAD = (message: string): ApiErrorBody => ({ code: 'BAD_REQUEST', message });

export type BridgeValidation = { ok: true; envelope: BridgeEnvelope } | { ok: false; error: ApiErrorBody };

/** 证明通过之后的校验，顺序：形状 → 版本 → 场景 ID → 原生桥版本 → 消息类型。raw 为 { v, bridge, message }。 */
export function validateBridgeEnvelope(raw: unknown): BridgeValidation {
  if (!isObject(raw)) return { ok: false, error: BAD('原生消息无效：格式不正确') };
  if (raw.v !== NATIVE_PROTOCOL_VERSION) return { ok: false, error: BAD('原生消息无效：协议版本不受支持') };
  const bridge = raw.bridge;
  if (!isObject(bridge)) return { ok: false, error: BAD('原生消息无效：缺少原生桥信息') };
  const { profileId, bridgeVersion } = bridge;
  if (profileId !== null && (typeof profileId !== 'string' || !BRIDGE_PROFILE_ID_RE.test(profileId))) {
    return { ok: false, error: BAD('原生消息无效：场景编号格式不正确') };
  }
  if (typeof bridgeVersion !== 'string' || !BRIDGE_VERSION_RE.test(bridgeVersion)) return { ok: false, error: BAD('原生消息无效：原生桥版本格式不正确') };
  const message = raw.message;
  if (!isObject(message)) return { ok: false, error: BAD('原生消息无效：缺少消息') };
  const type = message.type;
  if (typeof type !== 'string' || !Object.hasOwn(NATIVE_PERMISSIONS, type)) return { ok: false, error: BAD('原生消息无效：消息类型不受支持') };
  return {
    ok: true,
    envelope: {
      v: NATIVE_PROTOCOL_VERSION,
      bridge: { profileId: profileId as string | null, bridgeVersion },
      message: message as unknown as NativeRequest,
    },
  };
}

function parseJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

export function createBridgeServer(opts: BridgeServerOptions): BridgeServerHandle {
  if (opts.transport.kind === 'tcp' && opts.transport.host !== '127.0.0.1') {
    throw new SfeError('UNSAFE_LOCATION', '启动原生桥失败：只能监听 127.0.0.1');
  }
  const handshakeTimeoutMs = opts.handshakeTimeoutMs ?? BRIDGE_HANDSHAKE_TIMEOUT_MS;
  const newNonce = opts.nonce ?? (() => randomBytes(BRIDGE_NONCE_BYTES).toString('hex'));
  let server: Server | null = null;
  let bound: BridgeAddress | null = null;
  const sockets = new Set<Socket>();

  const log = (fields: Record<string, unknown>): void => {
    opts.logger.log(fields.errorCode && fields.errorCode !== 'AUTH_REQUIRED' && fields.errorCode !== 'BAD_REQUEST' ? 'warn' : 'info', 'bridge.request', fields);
  };

  async function handleConnection(socket: Socket): Promise<void> {
    const started = performance.now();
    const ms = (): number => Math.round(performance.now() - started);
    const remaining = (): number => Math.max(1, Math.round(started + handshakeTimeoutMs - performance.now()));
    // 握手失败：直接断开，不回应、不区分原因（日志里只记阶段）。
    const reject = (stage: 'hello' | 'request', result: string): void => {
      dropConnection(socket);
      log({ result, stage, errorCode: 'AUTH_REQUIRED', durationMs: ms() });
    };

    // 1. hello
    const hello = await readLine(socket, { maxBytes: BRIDGE_HELLO_MAX_BYTES, timeoutMs: remaining(), requireJsonObject: true });
    if (hello.kind !== 'line') {
      dropConnection(socket);
      if (hello.kind !== 'closed') log({ result: hello.kind, stage: 'hello', durationMs: ms() });
      return;
    }
    const clientNonce = parseBridgeHello(parseJson(hello.line));
    if (!clientNonce) return reject('hello', 'handshake_failed');
    let token = '';
    try {
      token = opts.token();
    } catch {
      token = '';
    }
    // 未配置令牌时无法证明自己：不发出任何 challenge
    if (token.length === 0) return reject('hello', 'not_configured');
    const serverNonce = newNonce();
    // 同一连接内随机数不能重复（反射）
    if (!HEX_64_RE.test(serverNonce) || serverNonce === clientNonce) return reject('hello', 'handshake_failed');
    const challenge: BridgeChallenge = { v: NATIVE_PROTOCOL_VERSION, type: 'challenge', serverNonce, serverProof: bridgeServerProof(token, clientNonce, serverNonce) };
    socket.write(`${JSON.stringify(challenge)}\n`);

    // 2. request（再发 hello 或其他内容都按证明不符处理）
    const request = await readLine(socket, { maxBytes: NATIVE_MAX_MESSAGE_BYTES, timeoutMs: remaining(), requireJsonObject: true });
    if (request.kind !== 'line') {
      dropConnection(socket);
      if (request.kind !== 'closed') log({ result: request.kind, stage: 'request', durationMs: ms() });
      return;
    }
    const checked = verifyBridgeRequest(parseJson(request.line), token, clientNonce, serverNonce);
    if (!checked.ok) return reject('request', 'handshake_failed');

    // 3. 证明通过：按原有规则校验并回应
    const payload = parseJson(checked.payload);
    if (!isObject(payload)) {
      await writeLineAndClose(socket, { ok: false, error: BAD('原生消息无效：不是有效的 JSON') } satisfies NativeResponse);
      log({ result: 'invalid_json', errorCode: 'BAD_REQUEST', durationMs: ms() });
      return;
    }
    const v = validateBridgeEnvelope({ v: checked.v, bridge: payload.bridge, message: payload.message });
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
