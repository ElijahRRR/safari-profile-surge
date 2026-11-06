// 本机资源服务（D10，固定工作配置设计第 83 行“受保护的回环资源服务”）：把 SFE-ROUTE 的节点列表经
// http://127.0.0.1:<端口>/<读取令牌>/sfe-nodes.list 提供给 Surge。设计不允许无需认证的 localhost 地址，也不能假定 Surge 支持
// 自定义认证请求头，所以读取令牌放在路径中：它随每次下载以明文发给占用该端口的一方（Surge 不能与本服务互相认证），本服务
// 停止期间端口被他人占用只能由审计事后发现（audit.ts），不能事先阻止。
// handle() 是校验并记录请求的唯一位置：只接受恰好 `GET /<令牌>/sfe-nodes.list`、唯一的 Host 等于 127.0.0.1:<绑定端口>、
// 两端都是回环地址、不带浏览器请求头与请求体的请求；其余一律返回同样的 404（空响应体，响应头与原因无关；原因只计数，并按
// 原因每分钟最多记一行日志）。令牌正确而当前没有可提供的版本时返回 503。日志从不包含令牌、路径、请求头的值或响应内容。
// 200 的审计记录在响应完整写出之后才标记完成：经绑定方答复时由 ResourceRespond 的 onFinished 完成；直接调用 handle() 的一方
// （例如 P0 在接受请求之后包一层故障场景）在自己完整写出之后调用返回的 finished()。

import { timingSafeEqual } from 'node:crypto';
import { NODE_RESOURCE_FILE, NODE_RESOURCE_HOST, RESOURCE_TOKEN_RE, SfeError, nodeResourceUrl } from '@sfe/contract';
import type { Clock, LogLevel, Logger } from '../ports.js';
import type { BoundSocket, ResourceBinder, ResourceConnectionFailure, ResourceRequestHandler } from './binder.js';

/** 资源内容上限（UTF-8 字节）：超过时拒绝加载或暂存，从不截断。 */
export const RESOURCE_MAX_BYTES = 1024 * 1024;
/** 内存与持久的审计记录只保留最近这么多条（令牌正确的 200 响应）。 */
export const RESOURCE_AUDIT_LIMIT = 64;
/** 同一原因的拒绝日志（以及 200/503 日志）每分钟最多一行，其余只计数并在下一行中带出。 */
export const RESOURCE_LOG_INTERVAL_MS = 60_000;

/** 绑定方交给 handle() 的请求：原始请求行目标与原始请求头（Node 会合并或丢弃重复的 Host，只能看 rawHeaders）。 */
export interface ResourceRequest {
  method: string;
  rawPath: string;
  rawHeaders: readonly string[];
  remoteAddress: string | null;
  localAddress: string | null;
  localPort: number;
}

export interface ResourceResponse {
  status: 200 | 404 | 503;
  headers: Record<string, string>;
  body: Buffer;
}

export interface ServedState {
  generation: number;
  state: 'committed' | 'candidate';
  bytes: number;
}

/** 令牌正确的 200 响应：写出响应体之前记一次（complete=false），完整写出之后再记一次（complete=true）。 */
export interface ResourceAuditRecord {
  seq: number;
  at: Date;
  generation: number;
  complete: boolean;
}

/**
 * handle() 的结果。自己写出响应的调用方（例如 P0 在 handle() 接受请求之后包一层故障场景）必须在响应完整写出之后调用
 * finished()，200 的审计记录才标记完成；中途断开、截断或没有写出时不要调用（记录保持 complete=false，读回不会把它当作
 * 一次下载）。非 200 时 finished 什么也不做；重复调用无效。
 */
export interface ResourceHandled {
  response: ResourceResponse;
  finished(): void;
}

/**
 * 拒绝原因（只用于计数与日志，响应完全相同）。token_refused：令牌可能已泄露（tokenSuspect），令牌正确的请求也返回 404。
 */
export type ResourceRejectReason =
  | 'method'
  | 'target'
  | 'query'
  | 'percent_escape'
  | 'path'
  | 'token_format'
  | 'token_mismatch'
  | 'host'
  | 'local_port'
  | 'remote_address'
  | 'local_address'
  | 'malformed_headers'
  | 'forbidden_header'
  | 'content_length'
  | 'token_refused';

export interface ResourceHost {
  readonly token: string;
  /** 由已配置端口与令牌得出，与是否已绑定无关；未配置端口为 null。地址含读取令牌：不写入日志、命令行参数或界面。 */
  url(): string | null;
  /** 设置已配置的端口（来自设置）；不绑定。 */
  configure(port: number | null): void;
  /** 实际绑定的端口。 */
  port(): number | null;
  /** 是否绑定在已配置的端口上。 */
  listening(): boolean;
  /**
   * 经绑定方绑定已配置端口；失败抛 RESOURCE_SERVER_UNAVAILABLE（details.reason port_in_use | other），从不改用其他端口。
   * 并发调用共用进行中的绑定；绑定进行中端口被 configure 改过时，等它结束再按当时的已配置端口判断（返回时 listening() 为真）。
   */
  listen(): Promise<void>;
  close(): Promise<void>;
  /** 当前提供的版本；null 时令牌正确的请求得到 503。 */
  served(): ServedState | null;
  loadCommitted(g: { generation: number; content: string }): void;
  stageCandidate(g: { generation: number; content: string }): void;
  commitCandidate(): void;
  revertToCommitted(): void;
  unload(): void;
  /** tokenSuspect：令牌正确的请求也得到统一的 404（从不 200/503）。 */
  setRefuseToken(refuse: boolean): void;
  /**
   * 校验并记录一个请求（绑定方的处理程序也经它答复，写出完毕时由 ResourceRespond 的 onFinished 调用 finished）。直接调用的
   * 一方自己写出响应，并且只在完整写出之后调用返回的 finished()；不调用时 200 的审计记录停在 complete=false。
   */
  handle(req: ResourceRequest): ResourceHandled;
  /** 下一条审计记录的序号：之后的 200 响应序号都不小于它。 */
  auditMark(): number;
  audit(): readonly ResourceAuditRecord[];
  /**
   * 200 响应写出之前（complete=false）与完整写出之后（complete=true）各调用一次；引擎同步持久保存。写出前的回调抛错时不提供
   * 内容（改为 503），保证每次提供的内容都有持久记录。返回取消订阅函数。
   */
  onServed(cb: (r: ResourceAuditRecord) => void): () => void;
  /**
   * 按原因累计的拒绝次数（404），另有 unavailable（503）、audit_failed（写出前记录失败、改答 503）、绑定方报告的连接层面失败
   * conn_<原因>（超过连接数上限被断开、无法解析或超时、流水线上的后续请求、没有答复、空闲超时，binder.ts
   * ResourceConnectionFailure）与 audit_complete_failed（完整写出之后记录完成失败；不是一次失败答复，见 audit.ts
   * servedFailureCount）。
   */
  failureCounters(): Readonly<Record<string, number>>;
}

export interface CreateResourceHostOptions {
  token: string;
  clock: Clock;
  logger: Logger;
  binder: ResourceBinder;
  /**
   * 之前持久保存的审计记录（resource:audit，state.ts readAuditLog）：重启后序号接着之前的继续，audit() 包含之前的记录，
   * 否则持久的 auditedSeq 会大于新记录的序号，之后的每次下载都无法解释。
   */
  audit?: { records: readonly ResourceAuditRecord[]; nextSeq: number };
}

interface Generation {
  generation: number;
  content: Buffer;
}

const LOOPBACK_ADDRESSES: ReadonlySet<string> = new Set([NODE_RESOURCE_HOST, `::ffff:${NODE_RESOURCE_HOST}`]);
/** 浏览器或代理才会带的请求头：Surge 的下载不带（TODO(P0)：loopback_resource_auth 记录 Surge 实际发出的请求头名称）。 */
const FORBIDDEN_HEADERS: ReadonlySet<string> = new Set(['origin', 'referer', 'cookie', 'authorization', 'upgrade', 'expect', 'transfer-encoding']);
const PATH_RE = new RegExp(`^/([^/]+)/${NODE_RESOURCE_FILE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);

/** 404 与 503 共用的响应头：与原因无关，逐字相同。 */
const EMPTY_RESPONSE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Content-Length': '0',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'none'; sandbox",
  'Referrer-Policy': 'no-referrer',
  Connection: 'close',
});

function emptyResponse(status: 404 | 503): ResourceResponse {
  return { status, headers: { ...EMPTY_RESPONSE_HEADERS }, body: Buffer.alloc(0) };
}

/** 200 的响应头：没有 ETag、Last-Modified 或任何 CORS 头；条件请求头与 Accept-Encoding 一律忽略（总是完整的明文内容）。 */
function okResponse(content: Buffer): ResourceResponse {
  return {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': String(content.length),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Referrer-Policy': 'no-referrer',
      Connection: 'close',
    },
    body: Buffer.from(content),
  };
}

function isPort(port: number): boolean {
  return Number.isSafeInteger(port) && port >= 1 && port <= 65535;
}

function toGeneration(g: { generation: number; content: string }, what: string): Generation {
  if (!Number.isSafeInteger(g?.generation) || g.generation < 0) throw new SfeError('VALIDATION_FAILED', `${what}失败：配置代数不正确`);
  if (typeof g.content !== 'string') throw new SfeError('VALIDATION_FAILED', `${what}失败：节点资源内容不正确`);
  const content = Buffer.from(g.content, 'utf8');
  if (content.length > RESOURCE_MAX_BYTES) throw new SfeError('VALIDATION_FAILED', `${what}失败：节点资源超过 1 MiB`);
  return { generation: g.generation, content };
}

function unavailable(reason: 'port_in_use' | 'other', message: string): SfeError {
  return new SfeError('RESOURCE_SERVER_UNAVAILABLE', message, { details: { reason } });
}

export function createResourceHost(opts: CreateResourceHostOptions): ResourceHost {
  const { token, clock, logger, binder } = opts;
  // 错误信息中从不带出令牌
  if (typeof token !== 'string' || !RESOURCE_TOKEN_RE.test(token)) throw new RangeError('invalid resource token format');
  const tokenBytes = Buffer.from(token, 'hex');

  let configuredPort: number | null = null;
  let bound: BoundSocket | null = null;
  let pendingListen: Promise<void> | null = null;
  let pendingPort: number | null = null;
  let committed: Generation | null = null;
  let candidate: Generation | null = null;
  let refuseToken = false;

  let records: ResourceAuditRecord[] = [];
  let nextSeq = 1;
  for (const r of opts.audit?.records ?? []) {
    if (!Number.isSafeInteger(r.seq) || r.seq < 1 || !(r.at instanceof Date) || !Number.isFinite(r.at.getTime())) continue;
    if (!Number.isSafeInteger(r.generation) || r.generation < 0 || typeof r.complete !== 'boolean') continue;
    records.push({ seq: r.seq, at: new Date(r.at.getTime()), generation: r.generation, complete: r.complete });
    nextSeq = Math.max(nextSeq, r.seq + 1);
  }
  records.sort((a, b) => a.seq - b.seq);
  records = records.slice(-RESOURCE_AUDIT_LIMIT);
  const persistedNext = opts.audit?.nextSeq;
  if (persistedNext !== undefined && Number.isSafeInteger(persistedNext) && persistedNext > nextSeq) nextSeq = persistedNext;

  const listeners = new Set<(r: ResourceAuditRecord) => void>();
  const counters: Record<string, number> = {};
  const logState = new Map<string, { lastAt: number; suppressed: number }>();

  const count = (key: string): void => {
    counters[key] = (counters[key] ?? 0) + 1;
  };

  /** 同一 key 每分钟最多一行；其间被略过的次数在下一行的 count 中带出。fields 只含原因代码、代数与字节数。 */
  const rateLimitedLog = (key: string, level: LogLevel, msg: string, fields: Record<string, unknown>): void => {
    const now = clock.now().getTime();
    const s = logState.get(key);
    if (s && now - s.lastAt < RESOURCE_LOG_INTERVAL_MS && now >= s.lastAt) {
      s.suppressed++;
      return;
    }
    logger.log(level, msg, { ...fields, count: (s?.suppressed ?? 0) + 1 });
    logState.set(key, { lastAt: now, suppressed: 0 });
  };

  const reject = (reason: ResourceRejectReason): ResourceResponse => {
    count(reason);
    rateLimitedLog(`reject:${reason}`, 'warn', 'resource.request_rejected', { reason });
    return emptyResponse(404);
  };

  const current = (): { g: Generation; state: 'committed' | 'candidate' } | null =>
    candidate ? { g: candidate, state: 'candidate' } : committed ? { g: committed, state: 'committed' } : null;

  const pushRecord = (r: ResourceAuditRecord): void => {
    records.push(r);
    if (records.length > RESOURCE_AUDIT_LIMIT) records = records.slice(-RESOURCE_AUDIT_LIMIT);
  };

  const emit = (r: ResourceAuditRecord): void => {
    for (const cb of [...listeners]) cb({ ...r, at: new Date(r.at.getTime()) });
  };

  /** 响应完整写出：记录标记完成并通知（之后的失败只计数并记日志：内容已经送出）。 */
  const complete = (base: ResourceAuditRecord): void => {
    const done: ResourceAuditRecord = { ...base, at: new Date(base.at.getTime()), complete: true };
    const i = records.findIndex((r) => r.seq === base.seq);
    if (i >= 0) records[i] = done;
    try {
      emit(done);
    } catch {
      count('audit_complete_failed');
      rateLimitedLog('audit_complete_failed', 'error', 'resource.audit_failed', { phase: 'complete' });
    }
  };

  /** 本次请求的 finished()：只对 200 有效，只生效一次。 */
  const finisher = (record: ResourceAuditRecord | null): (() => void) => {
    let done = record === null;
    return () => {
      if (done) return;
      done = true;
      complete(record!);
    };
  };

  /** 拒绝原因；可以接受时为 null。令牌先查格式，再按解码后的字节做定长比较。 */
  const validate = (req: ResourceRequest): ResourceRejectReason | null => {
    // 只接受 GET（TODO(P0)：loopback_resource_auth 记录 Surge 是否发出 HEAD）
    if (req.method !== 'GET') return 'method';
    const target = typeof req.rawPath === 'string' ? req.rawPath : '';
    if (!target.startsWith('/')) return 'target';
    if (target.includes('?') || target.includes('#')) return 'query';
    if (target.includes('%')) return 'percent_escape';
    const m = PATH_RE.exec(target);
    if (!m) return 'path';
    const presented = m[1]!;
    if (!RESOURCE_TOKEN_RE.test(presented)) return 'token_format';
    if (!timingSafeEqual(Buffer.from(presented, 'hex'), tokenBytes)) return 'token_mismatch';
    const headers = req.rawHeaders;
    if (!Array.isArray(headers) || headers.length % 2 !== 0) return 'malformed_headers';
    const boundPort = bound?.port ?? null;
    let hosts = 0;
    let hostOk = false;
    for (let i = 0; i < headers.length; i += 2) {
      const name = String(headers[i]).toLowerCase();
      const value = String(headers[i + 1]);
      if (name === 'host') {
        hosts++;
        hostOk = boundPort !== null && value === `${NODE_RESOURCE_HOST}:${boundPort}`;
      }
    }
    if (hosts !== 1 || !hostOk) return 'host';
    if (boundPort === null || req.localPort !== boundPort) return 'local_port';
    if (req.remoteAddress === null || !LOOPBACK_ADDRESSES.has(req.remoteAddress)) return 'remote_address';
    if (req.localAddress === null || !LOOPBACK_ADDRESSES.has(req.localAddress)) return 'local_address';
    for (let i = 0; i < headers.length; i += 2) {
      const name = String(headers[i]).toLowerCase();
      if (FORBIDDEN_HEADERS.has(name) || name.startsWith('sec-fetch-')) return 'forbidden_header';
      if (name === 'content-length' && String(headers[i + 1]).trim() !== '0') return 'content_length';
    }
    return null;
  };

  /** 校验与记录；record 为本次 200 的审计记录（非 200 为 null）。 */
  const serve = (req: ResourceRequest): { response: ResourceResponse; record: ResourceAuditRecord | null } => {
    const rejected = validate(req);
    if (rejected !== null) return { response: reject(rejected), record: null };
    if (refuseToken) return { response: reject('token_refused'), record: null };
    const cur = current();
    if (cur === null) {
      count('unavailable');
      rateLimitedLog('unavailable', 'warn', 'resource.unavailable', {});
      return { response: emptyResponse(503), record: null };
    }
    const record: ResourceAuditRecord = { seq: nextSeq++, at: clock.now(), generation: cur.g.generation, complete: false };
    pushRecord(record);
    try {
      emit(record);
    } catch {
      // 没有持久记录的内容不提供：之后无法与 Surge 的更新时间核对
      records = records.filter((r) => r.seq !== record.seq);
      count('audit_failed');
      rateLimitedLog('audit_failed', 'error', 'resource.audit_failed', { phase: 'before_write' });
      return { response: emptyResponse(503), record: null };
    }
    rateLimitedLog('served', 'info', 'resource.served', { generation: cur.g.generation, state: cur.state, bytes: cur.g.content.length });
    return { response: okResponse(cur.g.content), record };
  };

  const handler: ResourceRequestHandler = (req, respond) => {
    const { response, record } = serve(req);
    respond(response, record === null ? undefined : finisher(record));
  };

  /** 绑定方报告的连接层面失败：计数（conn_<原因>）并按原因每分钟最多记一行。 */
  const onConnectionFailure = (reason: ResourceConnectionFailure): void => {
    count(`conn_${reason}`);
    rateLimitedLog(`conn:${reason}`, 'warn', 'resource.connection_failed', { reason });
  };

  const host: ResourceHost = {
    token,
    url() {
      return configuredPort === null ? null : nodeResourceUrl(configuredPort, token);
    },
    configure(port) {
      if (port !== null && !isPort(port)) throw new RangeError('invalid resource port');
      configuredPort = port;
    },
    port() {
      return bound?.port ?? null;
    },
    listening() {
      return bound !== null && configuredPort !== null && bound.port === configuredPort;
    },
    listen() {
      if (pendingListen) {
        // 同一端口的并发调用共用结果；端口在进行中的绑定之后改过（configure）：等它结束，再按当前端口重新判断
        if (pendingPort === configuredPort) return pendingListen;
        return pendingListen.then(
          () => host.listen(),
          () => host.listen(),
        );
      }
      const port = configuredPort;
      if (port === null) return Promise.reject(unavailable('other', '本机资源服务不可用：尚未选定端口'));
      if (bound !== null && bound.port === port) return Promise.resolve();
      pendingPort = port;
      pendingListen = (async () => {
        if (bound !== null) {
          const old = bound;
          bound = null;
          await old.close();
        }
        let socket: BoundSocket;
        try {
          socket = await binder.bind(port, handler, onConnectionFailure);
        } catch (err) {
          if (err instanceof SfeError && err.code === 'RESOURCE_SERVER_UNAVAILABLE') throw err;
          throw unavailable('other', '本机资源服务不可用：无法监听本机端口');
        }
        if (socket.port !== port) {
          await socket.close();
          throw unavailable('other', '本机资源服务不可用：绑定的端口与设置不一致');
        }
        bound = socket;
      })().finally(() => {
        pendingListen = null;
        pendingPort = null;
      });
      return pendingListen;
    },
    async close() {
      if (pendingListen) await pendingListen.catch(() => undefined);
      const b = bound;
      bound = null;
      if (b) await b.close();
    },
    served() {
      const cur = current();
      return cur === null ? null : { generation: cur.g.generation, state: cur.state, bytes: cur.g.content.length };
    },
    loadCommitted(g) {
      if (candidate !== null) throw new SfeError('INTERNAL', '服务内部错误：节点资源有未提交的候选版本');
      committed = toGeneration(g, '加载节点资源');
    },
    stageCandidate(g) {
      if (candidate !== null) throw new SfeError('INTERNAL', '服务内部错误：节点资源已有未提交的候选版本');
      const next = toGeneration(g, '暂存节点资源');
      // 审计记录按代数区分候选与已提交版本：同一代数不能有两份内容
      if (committed !== null && committed.generation === next.generation) throw new SfeError('INTERNAL', '服务内部错误：候选版本与已提交版本代数相同');
      candidate = next;
    },
    commitCandidate() {
      if (candidate === null) throw new SfeError('INTERNAL', '服务内部错误：没有可提交的候选版本');
      committed = candidate;
      candidate = null;
    },
    revertToCommitted() {
      candidate = null;
    },
    unload() {
      committed = null;
      candidate = null;
    },
    setRefuseToken(refuse) {
      refuseToken = refuse === true;
    },
    handle(req) {
      const { response, record } = serve(req);
      return { response, finished: finisher(record) };
    },
    auditMark() {
      return nextSeq;
    },
    audit() {
      return records.map((r) => Object.freeze({ ...r, at: new Date(r.at.getTime()) }));
    },
    onServed(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    failureCounters() {
      return Object.freeze({ ...counters });
    },
  };
  return host;
}
