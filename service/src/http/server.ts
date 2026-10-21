// 本机网页后台的 HTTP 服务（docs/ARCHITECTURE.md §7.1）。只监听 127.0.0.1；Host 必须是本机管理地址
// （防 DNS 重绑定）；有 Origin 时必须同源，拒绝 Origin: null；从不发送 CORS 头。/api 全部要求 Bearer 令牌
// （含 GET 与事件流），没有 Cookie。日志只记路由模板、状态、耗时与错误码，从不记请求/响应体、查询串或请求头。

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve as resolvePath } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  NATIVE_PERMISSIONS,
  NATIVE_PROTOCOL_VERSION,
  SfeError,
  type ApiErrorBody,
  type BridgeEnvelope,
  type ErrorCode,
  type NativeRequest,
  type NativeResponse,
  type SessionInfo,
} from '@sfe/contract';
import type { AppService } from '../app.js';
import {
  AUTH_EXCHANGE_SCRIPT,
  AUTH_EXCHANGE_SCRIPT_PATH,
  AUTH_CROSS_SITE_MESSAGE,
  AUTH_FAILED_MESSAGE,
  AUTH_RATE_LIMITED_MESSAGE,
  exchangeFailurePage,
  exchangeSuccessPage,
} from './auth-pages.js';
import { errorBodyFor, errorKind, internalErrorBody, isSfeError, type TransportLogger } from './errors.js';
import { applySecurityHeaders } from './headers.js';
import { API_HANDLERS, matchApiRoute, type JsonRouteName, type RouteResult } from './routes.js';
import type { SessionStore, SessionValidation } from './sessions.js';
import { openEventStream, type EventStreamHandle } from './sse.js';
import { sendPlain, serveStatic } from './static.js';

export const MAX_JSON_BODY_BYTES = 8 * 1024 * 1024;
export const DEMO_NATIVE_PATH = '/dev/native';
export const DEMO_EXTENSION_PREFIX = '/dev/extension';
/** 与原生桥相同的场景 ID 形状限制。 */
export const PROFILE_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const BEARER_RE = /^Bearer[ \t]+([^\s]+)[ \t]*$/i;
const JSON_CONTENT_TYPE_RE = /^application\/json[ \t]*(;.*)?$/i;

export interface HttpServerOptions {
  app: AppService;
  sessions: SessionStore;
  /** 0 由系统分配（测试用）。 */
  port: number;
  webRoot: string | null;
  demo: boolean;
  extensionHarnessRoot: string | null;
  logger: TransportLogger;
  /** GET /api/session 返回的服务版本。 */
  serviceVersion?: string;
  /** 测试用：事件流心跳间隔（默认 15 秒）。 */
  heartbeatMs?: number;
  /** 测试用：JSON 请求体上限（默认 8 MB）。 */
  maxBodyBytes?: number;
}

export interface HttpServerHandle {
  listen(): Promise<{ url: string }>;
  close(): Promise<void>;
  boundUrl(): string | null;
}

class HttpFailure extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiErrorBody,
    readonly closeConnection = false,
  ) {
    super(body.message);
  }
}

function fail(status: number, code: ErrorCode, message: string, closeConnection = false): HttpFailure {
  return new HttpFailure(status, { code, message }, closeConnection);
}

export interface RequestTarget {
  /** 仍是百分号编码形式，不做点段规范化（静态文件与路由各自校验）。 */
  pathname: string;
  searchParams: URLSearchParams;
}

/** 只接受 origin-form（以单个 / 开头）；不经 WHATWG URL 解析，避免 //host 被当作协议相对地址。 */
export function parseRequestTarget(raw: string): RequestTarget | null {
  if (!raw.startsWith('/')) return null;
  const hash = raw.indexOf('#');
  const target = hash === -1 ? raw : raw.slice(0, hash);
  const q = target.indexOf('?');
  const pathname = q === -1 ? target : target.slice(0, q);
  if (/[\s\x00-\x1f\x7f]/.test(pathname)) return null;
  return { pathname, searchParams: new URLSearchParams(q === -1 ? '' : target.slice(q + 1)) };
}

export function parseBearer(header: string | string[] | undefined): string | null {
  if (typeof header !== 'string') return null;
  const m = BEARER_RE.exec(header);
  return m ? m[1]! : null;
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = Buffer.from(JSON.stringify(data), 'utf8');
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', String(body.length));
  res.end(body);
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  const body = Buffer.from(html, 'utf8');
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Length', String(body.length));
  res.end(body);
}

function sendResult(res: ServerResponse, result: RouteResult): void {
  if (result.kind === 'empty') {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (result.kind === 'json') {
    sendJson(res, result.status, result.data === undefined ? null : result.data);
    return;
  }
  const body = Buffer.from(result.body, 'utf8');
  res.statusCode = result.status;
  res.setHeader('Content-Type', result.contentType);
  for (const [k, v] of Object.entries(result.headers ?? {})) res.setHeader(k, v);
  res.setHeader('Content-Length', String(body.length));
  res.end(body);
}

/**
 * 读取 JSON 请求体：超过上限返回 413 并关闭连接；有内容时必须是 application/json；
 * 空请求体视为 {}；顶层必须是对象。
 */
export async function readJsonBody(req: IncomingMessage, limit: number): Promise<Record<string, unknown>> {
  const contentType = req.headers['content-type'];
  const declared = req.headers['content-length'];
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
    throw fail(413, 'BAD_REQUEST', '请求失败：请求体超过 8 MB 上限', true);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  await new Promise<void>((resolve, reject) => {
    const onData = (chunk: Buffer): void => {
      total += chunk.length;
      if (total > limit) {
        req.off('data', onData);
        req.off('end', onEnd);
        reject(fail(413, 'BAD_REQUEST', '请求失败：请求体超过 8 MB 上限', true));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => resolve();
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', () => reject(fail(400, 'BAD_REQUEST', '请求失败：读取请求体中断')));
  });
  if (contentType !== undefined && !JSON_CONTENT_TYPE_RE.test(contentType)) {
    throw fail(415, 'BAD_REQUEST', '请求失败：请求体必须是 application/json');
  }
  if (total === 0) return {};
  if (contentType === undefined) throw fail(415, 'BAD_REQUEST', '请求失败：请求体必须是 application/json');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total));
  } catch {
    throw fail(400, 'BAD_REQUEST', '请求失败：请求体不是有效的 UTF-8');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw fail(400, 'BAD_REQUEST', '请求失败：请求体不是有效的 JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw fail(400, 'BAD_REQUEST', '请求失败：请求体必须是 JSON 对象');
  }
  return parsed as Record<string, unknown>;
}

/** 演示端点的请求体：{ profileId, envelope: NativeEnvelope }。 */
export function parseDemoNativeBody(
  body: Record<string, unknown>,
): { ok: true; profileId: string | null; message: NativeRequest } | { ok: false; error: ApiErrorBody } {
  const bad = (message: string) => ({ ok: false as const, error: { code: 'BAD_REQUEST' as const, message } });
  const profileId = body.profileId;
  if (profileId !== null && (typeof profileId !== 'string' || !PROFILE_ID_RE.test(profileId))) return bad('演示请求失败：场景编号格式不正确');
  const envelope = body.envelope;
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return bad('演示请求失败：缺少消息');
  const env = envelope as Record<string, unknown>;
  if (env.v !== NATIVE_PROTOCOL_VERSION) return bad('演示请求失败：协议版本不受支持');
  const message = env.message;
  if (!message || typeof message !== 'object' || Array.isArray(message)) return bad('演示请求失败：缺少消息');
  const type = (message as { type?: unknown }).type;
  if (typeof type !== 'string' || !Object.hasOwn(NATIVE_PERMISSIONS, type)) return bad('演示请求失败：消息类型不受支持');
  return { ok: true, profileId: profileId as string | null, message: message as NativeRequest };
}

export function createHttpServer(opts: HttpServerOptions): HttpServerHandle {
  const webRoot = opts.webRoot ? resolvePath(opts.webRoot) : null;
  const harnessRoot = opts.demo && opts.extensionHarnessRoot ? resolvePath(opts.extensionHarnessRoot) : null;
  const maxBody = opts.maxBodyBytes ?? MAX_JSON_BODY_BYTES;
  const serviceVersion = opts.serviceVersion ?? '0.0.0-dev';
  const streams = new Map<string, Set<EventStreamHandle>>();
  let boundPort: number | null = null;
  let server: Server | null = null;

  const allowedHosts = (): Set<string> => new Set([`127.0.0.1:${boundPort}`, `localhost:${boundPort}`]);
  const allowedOrigins = (): Set<string> => new Set([`http://127.0.0.1:${boundPort}`, `http://localhost:${boundPort}`]);

  function closeSessionStreams(sessionId: string): void {
    const set = streams.get(sessionId);
    if (!set) return;
    for (const h of [...set]) h.close('session_ended');
    streams.delete(sessionId);
  }

  function authenticate(req: IncomingMessage): { token: string; session: SessionValidation } {
    const token = parseBearer(req.headers.authorization);
    const session = token ? opts.sessions.validate(token) : null;
    if (!token || !session) throw fail(401, 'AUTH_REQUIRED', '请求失败：未登录或会话已过期，请从菜单栏 App 或 sfe open 重新打开管理后台');
    return { token, session };
  }

  async function handleApi(req: IncomingMessage, res: ServerResponse, url: RequestTarget, setRoute: (r: string) => void): Promise<void> {
    const method = req.method ?? 'GET';
    const { token, session } = authenticate(req);
    const match = matchApiRoute(method, url.pathname);
    if (match.kind === 'not_found') throw fail(404, 'NOT_FOUND', '请求失败：接口不存在');
    if (match.kind === 'bad_param') throw fail(400, 'BAD_REQUEST', '请求失败：路径参数格式不正确');
    if (match.kind === 'method_not_allowed') {
      res.setHeader('Allow', match.allow.join(', '));
      throw fail(405, 'BAD_REQUEST', '请求失败：接口不支持该请求方法');
    }
    setRoute(`${method} ${match.path}`);
    const actor = { kind: 'web' as const, sessionId: session.sessionId };

    if (match.name === 'events') {
      const resumeHeader = req.headers['last-event-id'];
      const resumeFrom = typeof resumeHeader === 'string' && resumeHeader.trim() !== '' ? resumeHeader : url.searchParams.get('since');
      let set = streams.get(session.sessionId);
      if (!set) {
        set = new Set();
        streams.set(session.sessionId, set);
      }
      const owner = set;
      const handle = openEventStream(res, {
        events: opts.app.events,
        resumeFrom,
        ...(opts.heartbeatMs !== undefined ? { heartbeatMs: opts.heartbeatMs } : {}),
        isSessionValid: () => opts.sessions.validate(token, { touch: false }) !== null,
        onClose: () => {
          owner.delete(handle);
          if (owner.size === 0 && streams.get(session.sessionId) === owner) streams.delete(session.sessionId);
        },
      });
      owner.add(handle);
      return;
    }

    const body = method === 'GET' ? {} : await readJsonBody(req, maxBody);
    const sessionInfo = (): SessionInfo => ({ authenticated: true, serviceVersion, demoMode: opts.demo, expiresAt: session.expiresAt });
    const result = await API_HANDLERS[match.name as JsonRouteName]({
      app: opts.app,
      params: match.params,
      query: url.searchParams,
      body,
      actor,
      session: {
        info: sessionInfo,
        logout: () => {
          opts.sessions.revoke(token);
          closeSessionStreams(session.sessionId);
        },
      },
    });
    sendResult(res, result);
  }

  function handleExchange(req: IncomingMessage, res: ServerResponse, url: RequestTarget): void {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      sendPlain(res, 405, '请求失败：不支持该请求方法');
      return;
    }
    // 其他网页（含本机其他端口，属于 same-site）发起的跨站请求不计入限速，直接拒绝：
    // 否则恶意页面可以用无效登录码耗尽每分钟 10 次的额度。菜单栏 App 与 .webloc 打开时为 none。
    const fetchSite = req.headers['sec-fetch-site'];
    if (fetchSite !== undefined && fetchSite !== 'none' && fetchSite !== 'same-origin') {
      sendHtml(res, 403, exchangeFailurePage(AUTH_CROSS_SITE_MESSAGE));
      return;
    }
    let result: { token: string; expiresAt: string } | null;
    try {
      result = opts.sessions.exchange(url.searchParams.get('code') ?? '');
    } catch (err) {
      if (isSfeError(err) && err.code === 'RATE_LIMITED') {
        sendHtml(res, 429, exchangeFailurePage(AUTH_RATE_LIMITED_MESSAGE));
        return;
      }
      throw err;
    }
    if (!result) {
      sendHtml(res, 401, exchangeFailurePage(AUTH_FAILED_MESSAGE));
      return;
    }
    sendHtml(res, 200, exchangeSuccessPage(result.token));
  }

  async function handleDemoNative(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      throw fail(405, 'BAD_REQUEST', '请求失败：接口不支持该请求方法');
    }
    authenticate(req);
    const body = await readJsonBody(req, maxBody);
    const parsed = parseDemoNativeBody(body);
    if (!parsed.ok) {
      sendJson(res, 400, { ok: false, error: parsed.error } satisfies NativeResponse);
      return;
    }
    const envelope: BridgeEnvelope = {
      v: NATIVE_PROTOCOL_VERSION,
      auth: 'demo',
      bridge: { profileId: parsed.profileId, bridgeVersion: 'demo' },
      message: parsed.message,
    };
    let response: NativeResponse;
    try {
      response = await opts.app.handleNative(envelope);
    } catch (err) {
      response = { ok: false, error: errorBodyFor(err).body };
    }
    sendJson(res, 200, response);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = performance.now();
    let route = 'unmatched';
    let errorCode: string | undefined;
    applySecurityHeaders(res);
    res.on('close', () => {
      const fields: Record<string, unknown> = { route, status: res.statusCode, durationMs: Math.round(performance.now() - started) };
      if (errorCode !== undefined) fields.errorCode = errorCode;
      opts.logger.log(res.statusCode >= 500 ? 'error' : 'info', 'http.request', fields);
    });

    try {
      const host = req.headers.host?.toLowerCase();
      if (boundPort === null || host === undefined || !allowedHosts().has(host)) {
        route = 'host_check';
        throw fail(403, 'FORBIDDEN_ORIGIN', '请求被拒绝：主机名不是本机管理地址');
      }
      const url = parseRequestTarget(req.url ?? '');
      if (url === null) throw fail(400, 'BAD_REQUEST', '请求失败：地址格式不正确');
      const origin = req.headers.origin;
      if (origin !== undefined && !allowedOrigins().has(origin)) {
        route = 'origin_check';
        throw fail(403, 'FORBIDDEN_ORIGIN', '请求被拒绝：来源不是本机管理后台');
      }
      const pathname = url.pathname;

      if (pathname === '/api' || pathname.startsWith('/api/')) {
        route = 'api';
        await handleApi(req, res, url, (r) => {
          route = r;
        });
        return;
      }
      if (pathname === '/auth/exchange') {
        route = 'GET /auth/exchange';
        handleExchange(req, res, url);
        return;
      }
      if (pathname === AUTH_EXCHANGE_SCRIPT_PATH) {
        route = `GET ${AUTH_EXCHANGE_SCRIPT_PATH}`;
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.setHeader('Allow', 'GET, HEAD');
          sendPlain(res, 405, '请求失败：不支持该请求方法');
          return;
        }
        const body = Buffer.from(AUTH_EXCHANGE_SCRIPT, 'utf8');
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
        res.setHeader('Content-Length', String(body.length));
        res.end(req.method === 'HEAD' ? undefined : body);
        return;
      }
      if (pathname === '/dev' || pathname.startsWith('/dev/')) {
        // 非演示模式下这些路由根本不存在
        route = 'dev';
        if (!opts.demo) {
          sendPlain(res, 404, '未找到');
          return;
        }
        if (pathname === DEMO_NATIVE_PATH) {
          route = `POST ${DEMO_NATIVE_PATH}`;
          await handleDemoNative(req, res);
          return;
        }
        if (harnessRoot !== null && (pathname === DEMO_EXTENSION_PREFIX || pathname.startsWith(`${DEMO_EXTENSION_PREFIX}/`))) {
          route = `GET ${DEMO_EXTENSION_PREFIX}/*`;
          if (pathname === DEMO_EXTENSION_PREFIX) {
            res.statusCode = 308;
            res.setHeader('Location', `${DEMO_EXTENSION_PREFIX}/`);
            res.end();
            return;
          }
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.setHeader('Allow', 'GET, HEAD');
            sendPlain(res, 405, '请求失败：不支持该请求方法');
            return;
          }
          await serveStatic(req, res, harnessRoot, pathname.slice(DEMO_EXTENSION_PREFIX.length), null);
          return;
        }
        sendPlain(res, 404, '未找到');
        return;
      }

      route = 'static';
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.setHeader('Allow', 'GET, HEAD');
        sendPlain(res, 405, '请求失败：不支持该请求方法');
        return;
      }
      if (webRoot === null) {
        sendPlain(res, 404, '未找到');
        return;
      }
      await serveStatic(req, res, webRoot, pathname, pathname);
    } catch (err) {
      let status: number;
      let body: ApiErrorBody;
      let closeConnection = false;
      if (err instanceof HttpFailure) {
        status = err.status;
        body = err.body;
        closeConnection = err.closeConnection;
      } else {
        ({ status, body } = errorBodyFor(err));
      }
      errorCode = isSfeError(err) || err instanceof HttpFailure ? body.code : `INTERNAL:${errorKind(err)}`;
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (status === 401) res.setHeader('WWW-Authenticate', 'Bearer');
      if (closeConnection) {
        res.setHeader('Connection', 'close');
        // 未读完的请求体：响应送出后给客户端片刻读取，再断开，避免无限上传占住连接
        res.on('finish', () => setTimeout(() => req.socket.destroy(), 2000).unref());
      }
      sendJson(res, status, { error: body });
    }
  }

  return {
    listen() {
      if (server) return Promise.reject(new SfeError('INTERNAL', '服务内部错误'));
      const s = createServer((req, res) => {
        void handle(req, res).catch(() => {
          if (!res.headersSent) sendJson(res, 500, { error: internalErrorBody() });
          else res.destroy();
        });
      });
      server = s;
      return new Promise((resolve, reject) => {
        const onError = (err: Error): void => {
          server = null;
          reject(err);
        };
        s.once('error', onError);
        s.listen({ host: '127.0.0.1', port: opts.port, exclusive: true }, () => {
          s.off('error', onError);
          boundPort = (s.address() as AddressInfo).port;
          resolve({ url: `http://127.0.0.1:${boundPort}` });
        });
      });
    },
    async close() {
      const s = server;
      if (!s) return;
      for (const sessionId of [...streams.keys()]) {
        for (const h of [...(streams.get(sessionId) ?? [])]) h.close('server_closed');
      }
      streams.clear();
      await new Promise<void>((resolve) => {
        s.close(() => resolve());
        s.closeAllConnections();
      });
      server = null;
      boundPort = null;
    },
    boundUrl() {
      return boundPort === null ? null : `http://127.0.0.1:${boundPort}`;
    },
  };
}
