// 本机资源服务的绑定方：tcpBinder 用 node:http 只监听 127.0.0.1（从不 0.0.0.0 或 IPv6）；virtualBinder 不开套接字，供测试、
// 演示与假 Surge 在进程内发请求。校验与记录全部在 host.ts 的 handle() 中，绑定方只负责收发与连接限制。
// 跨进程的端口独占只来自操作系统拒绝第二次绑定 127.0.0.1:<端口>（listen 的 exclusive 选项只影响 cluster，不提供这种保护）；
// 其他用户能否绑定 0.0.0.0/[::] 的同一端口、发往 127.0.0.1 的请求是否仍到达本服务，由 loopback_resource_auth 实测（TODO(P0)）。

import { STATUS_CODES, createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { NODE_RESOURCE_HOST, SfeError } from '@sfe/contract';
import type { Logger } from '../ports.js';
import type { ResourceRequest, ResourceResponse } from './host.js';

export interface BoundSocket {
  port: number;
  close(): Promise<void>;
}

/** 写出响应；只有第一次调用有效。onFinished 在响应完整写出之后调用（tcp：'finish' 事件；virtual：同步），中途断开时从不调用。 */
export type ResourceRespond = (r: ResourceResponse, onFinished?: () => void) => void;
/** 绑定方对每个请求调用一次；处理程序必须同步调用 respond，否则连接被断开。 */
export type ResourceRequestHandler = (req: ResourceRequest, respond: ResourceRespond) => void;

export interface ResourceBinder {
  /** 绑定 127.0.0.1:<port>；占用时抛 RESOURCE_SERVER_UNAVAILABLE（details.reason port_in_use），其他失败 reason other。从不改用其他端口。 */
  bind(port: number, handler: ResourceRequestHandler): Promise<BoundSocket>;
}

export interface VirtualResourceBinder extends ResourceBinder {
  /**
   * 进程内请求（localPort 取 port）：端口无人绑定时抛 code 为 ECONNREFUSED 的错误，处理程序没有同步答复时抛 ECONNRESET。
   * 响应“写出”是同步的：返回之前已调用 onFinished。
   */
  request(port: number, req: Omit<ResourceRequest, 'localPort'>): ResourceResponse;
}

/** tcpBinder 的连接限制。 */
export const RESOURCE_SERVER_LIMITS = Object.freeze({
  maxHeaderSize: 8192,
  headersTimeoutMs: 3000,
  requestTimeoutMs: 5000,
  keepAliveTimeoutMs: 0,
  maxConnections: 16,
  /** 超时检查的间隔（Node 缺省 30 秒，上面两个超时要按秒生效）。 */
  connectionsCheckingIntervalMs: 1000,
  /** 连接空闲（例如慢速读取响应）超过这么久即断开。 */
  socketIdleTimeoutMs: 10_000,
});

const CLIENT_ERROR_LOG_INTERVAL_MS = 60_000;

function assertPort(port: number): void {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new SfeError('RESOURCE_SERVER_UNAVAILABLE', '本机资源服务不可用：端口不正确', { details: { reason: 'other' } });
  }
}

function portInUse(): SfeError {
  return new SfeError('RESOURCE_SERVER_UNAVAILABLE', '本机资源服务不可用：端口已被其他程序占用', { details: { reason: 'port_in_use' } });
}

function errorWithCode(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

/** 请求是否带请求体（这类请求得到 404 后连接被断开，从不读取请求体）。 */
function hasRequestBody(req: IncomingMessage): boolean {
  const cl = req.headers['content-length'];
  return req.headers['transfer-encoding'] !== undefined || (cl !== undefined && cl.trim() !== '0');
}

function toResourceRequest(req: IncomingMessage): ResourceRequest {
  return {
    method: req.method ?? '',
    rawPath: req.url ?? '',
    rawHeaders: [...req.rawHeaders],
    remoteAddress: req.socket.remoteAddress ?? null,
    localAddress: req.socket.localAddress ?? null,
    localPort: req.socket.localPort ?? -1,
  };
}

/** 与 node:http 写出的响应相同的字节（sendDate 关闭、头按给出的顺序），用于 Node 不再按 HTTP 处理的 CONNECT 连接。 */
function rawResponseBytes(r: ResourceResponse): Buffer {
  let head = `HTTP/1.1 ${r.status} ${STATUS_CODES[r.status] ?? ''}\r\n`;
  for (const [name, value] of Object.entries(r.headers)) head += `${name}: ${value}\r\n`;
  return Buffer.concat([Buffer.from(`${head}\r\n`, 'latin1'), r.body]);
}

export function tcpBinder(opts: { logger: Logger }): ResourceBinder {
  const { logger } = opts;
  return {
    bind(port, handler) {
      try {
        assertPort(port);
      } catch (err) {
        return Promise.reject(err);
      }
      const sockets = new Set<Socket>();
      // 每条连接只处理一个请求：流水线上的后续请求不交给处理程序（不产生审计记录，也不答复）。第一个响应带 Connection: close，
      // 写完后 Node 关闭连接，排队的请求随之丢弃
      const handled = new WeakSet<object>();
      let clientErrors = 0;
      let clientErrorLoggedAt: number | null = null;

      const onRequest = (req: IncomingMessage, res: ServerResponse): void => {
        res.sendDate = false;
        if (handled.has(req.socket)) return;
        handled.add(req.socket);
        const withBody = hasRequestBody(req);
        let responded = false;
        const resourceReq = toResourceRequest(req);
        try {
          handler(resourceReq, (r, onFinished) => {
            if (responded) return;
            responded = true;
            res.once('finish', () => {
              // 带请求体的请求：不读取请求体，答复送出后直接断开
              if (withBody || !req.complete) req.socket.destroy();
              if (onFinished) {
                try {
                  onFinished();
                } catch {
                  // 完成回调的失败由 host 自己记录
                }
              }
            });
            res.writeHead(r.status, r.headers);
            res.end(r.body);
          });
        } catch {
          // 处理程序抛错：不答复，直接断开
        }
        if (!responded) req.socket.destroy();
      };

      const server = createServer(
        {
          maxHeaderSize: RESOURCE_SERVER_LIMITS.maxHeaderSize,
          headersTimeout: RESOURCE_SERVER_LIMITS.headersTimeoutMs,
          requestTimeout: RESOURCE_SERVER_LIMITS.requestTimeoutMs,
          keepAliveTimeout: RESOURCE_SERVER_LIMITS.keepAliveTimeoutMs,
          connectionsCheckingInterval: RESOURCE_SERVER_LIMITS.connectionsCheckingIntervalMs,
          // 缺少 Host 的请求也交给 handle()，得到统一的 404（而不是 Node 自动答复的 400）
          requireHostHeader: false,
        },
        onRequest,
      );
      server.maxConnections = RESOURCE_SERVER_LIMITS.maxConnections;
      // 带 Expect 的请求：不让 Node 自动答复 100 Continue 或 417，同样交给 handle()（拒绝为 404）
      server.on('checkContinue', onRequest);
      server.on('checkExpectation', onRequest);
      // CONNECT：没有监听时 Node 直接断开、不答复；这里同样交给处理程序（按方法拒绝并计数），原样写出它的统一 404 后断开。
      // 从不在这条路径上写出 200（不会发生：只接受 GET），也不读取 CONNECT 之后的数据
      server.on('connect', (req: IncomingMessage, socket: Duplex) => {
        if (handled.has(socket)) {
          socket.end();
          return;
        }
        handled.add(socket);
        const out: { response: ResourceResponse | null } = { response: null };
        try {
          handler(toResourceRequest(req), (r) => {
            out.response ??= r;
          });
        } catch {
          out.response = null;
        }
        const response = out.response;
        if (response === null || response.status === 200) {
          socket.destroy();
          return;
        }
        socket.end(rawResponseBytes(response), () => socket.destroy());
      });
      server.on('connection', (socket: Socket) => {
        sockets.add(socket);
        socket.setTimeout(RESOURCE_SERVER_LIMITS.socketIdleTimeoutMs, () => socket.destroy());
        socket.on('close', () => sockets.delete(socket));
        socket.on('error', () => undefined);
      });
      // 无法解析的请求（含请求头过大）：不答复（Node 缺省答复 400/431），直接断开；只按分钟汇总记一行，不记内容
      server.on('clientError', (_err: Error, socket: Socket) => {
        socket.destroy();
        clientErrors++;
        const now = Date.now();
        if (clientErrorLoggedAt === null || now - clientErrorLoggedAt >= CLIENT_ERROR_LOG_INTERVAL_MS || now < clientErrorLoggedAt) {
          logger.log('warn', 'resource.client_error', { count: clientErrors });
          clientErrors = 0;
          clientErrorLoggedAt = now;
        }
      });

      return new Promise<BoundSocket>((resolve, reject) => {
        const onError = (err: NodeJS.ErrnoException): void => {
          reject(
            err.code === 'EADDRINUSE'
              ? portInUse()
              : new SfeError('RESOURCE_SERVER_UNAVAILABLE', '本机资源服务不可用：无法监听本机端口', { details: { reason: 'other' } }),
          );
        };
        server.once('error', onError);
        server.listen({ host: NODE_RESOURCE_HOST, port }, () => {
          server.off('error', onError);
          server.on('error', (err: NodeJS.ErrnoException) => logger.log('warn', 'resource.server_error', { code: err.code ?? null }));
          let closed: Promise<void> | null = null;
          resolve({
            port,
            close() {
              closed ??= new Promise<void>((done) => {
                server.close(() => done());
                for (const s of sockets) s.destroy();
                server.closeAllConnections();
              });
              return closed;
            },
          });
        });
      });
    },
  };
}

const VIRTUAL_ENDPOINT = Symbol('sfe.virtualResourceEndpoint');

interface VirtualEndpoint {
  readonly [VIRTUAL_ENDPOINT]: true;
  readonly handler: ResourceRequestHandler;
}

function isVirtualEndpoint(v: unknown): v is VirtualEndpoint {
  return typeof v === 'object' && v !== null && (v as Partial<VirtualEndpoint>)[VIRTUAL_ENDPOINT] === true;
}

/**
 * 进程内绑定方：registry 记录被占用的端口（可在多个 virtualBinder 之间共享，例如模拟服务重启后新实例绑定同一端口；
 * 测试也可以预先放入任意值模拟端口被他人占用）。request 发给当前占用该端口的处理程序。
 */
export function virtualBinder(registry: Map<number, unknown> = new Map()): VirtualResourceBinder {
  return {
    async bind(port, handler) {
      assertPort(port);
      if (registry.has(port)) throw portInUse();
      const endpoint: VirtualEndpoint = { [VIRTUAL_ENDPOINT]: true, handler };
      registry.set(port, endpoint);
      let closed = false;
      return {
        port,
        async close() {
          if (closed) return;
          closed = true;
          if (registry.get(port) === endpoint) registry.delete(port);
        },
      };
    },
    request(port, req) {
      const endpoint = registry.get(port);
      if (!isVirtualEndpoint(endpoint)) throw errorWithCode(`connect ECONNREFUSED ${NODE_RESOURCE_HOST}:${port}`, 'ECONNREFUSED');
      let response: ResourceResponse | null = null;
      let finished: (() => void) | undefined;
      try {
        endpoint.handler({ ...req, rawHeaders: [...req.rawHeaders], localPort: port }, (r, onFinished) => {
          if (response !== null) return;
          response = r;
          finished = onFinished;
        });
      } catch {
        response = null;
      }
      if (response === null) throw errorWithCode('socket hang up', 'ECONNRESET');
      if (finished) {
        try {
          finished();
        } catch {
          // 同 tcpBinder：完成回调的失败由 host 自己记录
        }
      }
      return response;
    },
  };
}
