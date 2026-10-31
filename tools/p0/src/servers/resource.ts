// P0 的测试资源服务（D10）：就是产品的处理程序——createResourceHost（令牌、Host、地址、请求头、方法与 503 的全部判断）加上
// 产品的绑定方（缺省 tcpBinder，只监听 127.0.0.1）。提供哪一代内容与故障场景由其他命令原子写入的状态文件决定（每个请求与
// 每 100 毫秒各读一次）；故障场景只是包在绑定方处理程序外面的一层，而且只在 host.handle() 已经接受了令牌正确的请求、准备
// 答复 200 之后才改变答复。ok、restartUninitialized（与 stop）由产品处理程序原样答复（loopback-auth 只用这条路径）。改变了
// 答复的请求从不调用 finished()：审计记录停在未完成，之后的核对不会把它当作一次已提供的下载。
// 请求记录只记时间、方法、状态、代、字节数、令牌是否正确、处理程序的原因代码、请求头名称、场景与发起连接的进程；从不记
// 令牌、路径、请求头的值或列表内容。审计记录（产品 onServed 的序号、时间、代、是否完整写出）写在 servers/resource-audit.jsonl，
// 重启后接着之前的序号。
// 占用者（--squat）不是产品处理程序：它用同一绑定方占用 127.0.0.1:<端口>（只在端口空闲时），对任何请求答复伪造的列表或 404。

import { watch, type FSWatcher } from 'node:fs';
import { createServer, type Server } from 'node:net';
import {
  RESOURCE_AUDIT_LIMIT,
  createResourceHost,
  type Clock,
  type Logger,
  type ResourceBinder,
  type ResourceHost,
  type ResourceRequest,
  type ResourceRequestHandler,
  type ResourceResponse,
} from '../deps.js';
import {
  STATUS_SCENARIOS,
  appendAuditRecord,
  presentsToken,
  productHandled,
  readAuditRecords,
  readServed,
  scenarioBody,
  updateServed,
  writeServerStatus,
  type PeerProcess,
  type ResourceLogEntry,
  type ResourceScenario,
  type ResourceServedFile,
  type ResourceServerStatus,
  type SquatMode,
} from '../loopback-state.js';
import { RESOURCE_SERVED_FILE, SERVER_LOGS } from '../constants.js';
import type { RunDir } from '../run-dir.js';
import type { ExecFn } from '../system.js';
import { TEST_NODES } from '../test-profile.js';

/** 按端口找到发起连接的进程（连接必须仍然打开：只在 hang 场景下、产品处理程序接受请求之后调用）；读不到为 null。 */
export type PeerProbe = (port: number) => Promise<PeerProcess[] | null>;

export interface ResourceServerOptions {
  dir: RunDir;
  port: number;
  token: string;
  binder: ResourceBinder;
  clock: Clock;
  logger: Logger;
  /** 启动时的场景（--scenario）；缺省 ok。 */
  scenario: ResourceScenario | null;
  /** 找发起连接的进程（缺省 macOS 上经共用执行器运行 lsof；其他平台为 null）。 */
  peerProbe?: PeerProbe;
  /** 共用的子进程执行器（缺省的 peerProbe 用它）。 */
  exec?: ExecFn;
  /** 读状态文件的间隔（缺省 100 毫秒）。 */
  pollMs?: number;
  /** 状态变化（应用新版本、开始或停止监听）时调用（终端提示）。 */
  onChange?: (status: ResourceServerStatus) => void;
}

export interface RunningResourceServer {
  host: ResourceHost;
  /** 立即读取并应用状态文件（含开始或停止监听）。 */
  sync(): Promise<void>;
  status(): ResourceServerStatus;
  close(): Promise<void>;
}

/** 记录一行（时间与角色由这里补上）。 */
type LogInput = ResourceLogEntry extends infer E ? (E extends ResourceLogEntry ? Omit<E, 'at' | 'role'> : never) : never;

/** 写出的响应（状态码不限于产品的 200/404/503：场景会改答 401、403、500）。 */
type WireResponse = Omit<ResourceResponse, 'status'> & { status: number };

/** 场景改答的状态码与 200 之外的空响应头（与产品一样关闭连接、不缓存）。 */
const EMPTY_SCENARIO_HEADERS: Readonly<Record<string, string>> = Object.freeze({ 'Content-Length': '0', 'Cache-Control': 'no-store', Connection: 'close' });

function headerNames(raw: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < raw.length; i += 2) out.push(String(raw[i]).toLowerCase().slice(0, 64));
  return out;
}

/** 两次 failureCounters() 之间增加的那一项（同步调用 handle 之间只会增加一项）。 */
function counterDelta(before: Readonly<Record<string, number>>, after: Readonly<Record<string, number>>): string | null {
  for (const [k, n] of Object.entries(after)) if (n > (before[k] ?? 0)) return k;
  return null;
}

/**
 * lsof 找发起连接的进程（macOS）：-iTCP@127.0.0.1:<端口> 的 ESTABLISHED 连接中，对端是本服务端口的一侧就是客户端。经共用的
 * 执行器（stdin 关闭、绝对路径、不经 shell）异步运行，所以连接必须仍然打开——只在 hang 场景下调用。路径取 ps comm（只作记录）。
 * 其他平台或读不到为 null。
 */
export function lsofPeerProbe(exec: ExecFn, platform: NodeJS.Platform = process.platform): PeerProbe {
  return async (port) => {
    if (platform !== 'darwin') return null;
    const r = await exec('/usr/sbin/lsof', ['-nP', `-iTCP@127.0.0.1:${port}`, '-sTCP:ESTABLISHED', '-Fpcn'], { timeoutMs: 3000 });
    if (r.stdout === '' && r.code !== 0) return null;
    const peers = parseLsofPeers(r.stdout, port, process.pid);
    const out: PeerProcess[] = [];
    for (const p of peers) {
      const ps = await exec('/bin/ps', ['-o', 'comm=', '-p', String(p.pid)], { timeoutMs: 3000 });
      out.push({ ...p, path: ps.code === 0 ? ps.stdout.trim() || null : null });
    }
    return out;
  };
}

/** 解析 `lsof -F pcn` 的输出：名称为 127.0.0.1:<任意>->127.0.0.1:<端口> 的一侧（客户端），排除本进程。 */
export function parseLsofPeers(text: string, port: number, selfPid: number): PeerProcess[] {
  const out = new Map<number, PeerProcess>();
  let pid: number | null = null;
  let command = '';
  for (const line of text.split('\n')) {
    const tag = line[0];
    const value = line.slice(1);
    if (tag === 'p') {
      pid = Number(value);
      command = '';
    } else if (tag === 'c') command = value.slice(0, 64);
    else if (tag === 'n' && pid !== null && Number.isSafeInteger(pid) && pid !== selfPid) {
      const m = /^127\.0\.0\.1:\d+->127\.0\.0\.1:(\d+)$/.exec(value);
      if (m && Number(m[1]) === port && !out.has(pid)) out.set(pid, { pid, command, path: null });
    }
  }
  return [...out.values()];
}

export function startResourceServer(opts: ResourceServerOptions): Promise<RunningResourceServer> {
  const { dir, port, token, clock, logger } = opts;
  const probe: PeerProbe = opts.peerProbe ?? (opts.exec ? lsofPeerProbe(opts.exec) : async () => null);
  const log = (e: LogInput): void => {
    dir.appendJsonl(SERVER_LOGS.resource, { at: clock.now().toISOString(), role: 'server', ...e });
  };

  // 之前的审计记录：序号接着之前的继续（与引擎用 readAuditLog 恢复相同），否则新的记录会与旧记录同号
  const previous = readAuditRecords(dir);
  const nextSeq = previous.reduce((m, r) => Math.max(m, r.seq), 0) + 1;

  let applied: { revision: number; scenario: ResourceScenario; probePeers: boolean } = { revision: -1, scenario: 'ok', probePeers: false };
  let listenError: unknown = null;
  const startedAt = clock.now().toISOString();
  let listening = false;
  let closed = false;

  /** 场景包装：只在产品处理程序接受了令牌正确的请求之后改变答复。 */
  const wrap =
    (hostHandler: ResourceRequestHandler): ResourceRequestHandler =>
    (req: ResourceRequest, respond) => {
      try {
        syncContent();
      } catch {
        // 状态文件读不到或结构不对：保持上一次应用的内容（同时记一行），从不猜测
        log({ kind: 'lifecycle', event: 'state_rejected' });
      }
      const scenario = applied.scenario;
      const base = {
        kind: 'request' as const,
        method: String(req.method).slice(0, 16),
        tokenOk: presentsToken(req.rawPath, token),
        headers: headerNames(req.rawHeaders),
        scenario,
      };
      const before = host.failureCounters();
      const mark = host.auditMark();
      const generationOf = (status: number): number | null => (status === 200 ? (host.audit().find((r) => r.seq === mark)?.generation ?? null) : null);
      if (scenario === 'stop') {
        // 正在停止监听：不答复（连接被断开）
        log({ ...base, status: null, generation: null, bytes: 0, reason: 'stopping', handler: 'product', seq: null });
        return;
      }
      if (productHandled(scenario)) {
        // 产品处理程序原样答复：这里只观察写出的状态，响应与完成回调原样交给绑定方
        hostHandler(req, (r, onFinished) => {
          const reason = r.status === 200 ? 'ok' : counterDelta(before, host.failureCounters());
          log({ ...base, status: r.status, generation: generationOf(r.status), bytes: r.body.length, reason, handler: 'product', seq: r.status === 200 ? mark : null });
          respond(r, onFinished);
        });
        return;
      }
      const { response } = host.handle(req);
      if (response.status !== 200) {
        log({ ...base, status: response.status, generation: null, bytes: response.body.length, reason: counterDelta(before, host.failureCounters()), handler: 'product', seq: null });
        respond(response);
        return;
      }
      // 产品处理程序已经接受（令牌正确、已提供内容）：按场景改变答复，从不调用 finished
      const generation = generationOf(200);
      const entry = { ...base, generation, reason: 'ok', handler: 'scenario' as const, seq: mark };
      const send = (r: WireResponse): void => {
        log({ ...entry, status: r.status, bytes: r.body.length });
        // 绑定方按原样写出状态码（场景改答的 401/403/500 不在产品的类型中）
        respond(r as ResourceResponse);
      };
      const status = STATUS_SCENARIOS[scenario];
      if (status !== undefined) {
        send({ status, headers: { ...EMPTY_SCENARIO_HEADERS }, body: Buffer.alloc(0) });
      } else if (scenario === 'reset') {
        // 不答复：绑定方随即断开连接
        log({ ...entry, status: null, bytes: 0 });
      } else if (scenario === 'truncate') {
        // 响应头声明完整长度，只写出一半就结束（Connection: close 让连接随之关闭）
        send({ status: 200, headers: { ...response.headers }, body: response.body.subarray(0, Math.floor(response.body.length / 2)) });
      } else if (scenario === 'hang') {
        // 写出响应头后不再发送数据：保持连接，直到 Surge 超时或绑定方的空闲上限断开
        send({ status: 200, headers: { ...response.headers, Connection: 'keep-alive' }, body: Buffer.alloc(0) });
        // 连接仍然打开：这时才能用 lsof 找到发起连接的进程（loopback-auth 打开 probePeers）
        if (applied.probePeers) {
          void probe(port)
            .then((peers) => log({ kind: 'peer', seq: mark, peers }))
            .catch(() => log({ kind: 'peer', seq: mark, peers: null }));
        }
      } else {
        const body = Buffer.from(scenarioBody(scenario, response.body.toString('utf8')), 'utf8');
        send({ status: 200, headers: { ...response.headers, 'Content-Length': String(body.length) }, body });
      }
    };

  const binder: ResourceBinder = { bind: (p, handler) => opts.binder.bind(p, wrap(handler)) };
  const host = createResourceHost({ token, clock, logger, binder, audit: { records: previous.slice(-RESOURCE_AUDIT_LIMIT), nextSeq } });
  // 写出响应体之前与完整写出之后各记一次（同步追加：每次提供的内容都有记录）
  host.onServed((r) => appendAuditRecord(dir, r));
  host.configure(port);

  const status = (): ResourceServerStatus => {
    const served = host.served();
    return {
      version: 1,
      role: 'server',
      pid: process.pid,
      port,
      mode: 'serve',
      startedAt,
      stoppedAt: closed ? clock.now().toISOString() : null,
      listening,
      appliedRevision: applied.revision,
      scenario: applied.scenario,
      serving: served ? { generation: served.generation, state: served.state } : null,
      updatedAt: clock.now().toISOString(),
    };
  };
  const publishStatus = (): void => {
    const s = status();
    writeServerStatus(dir, s);
    opts.onChange?.(s);
  };

  /** 按状态文件装载内容（同步；开始或停止监听在 sync 中）。restartUninitialized 不装载任何内容（令牌正确时 503）。 */
  function applyContent(s: ResourceServedFile): void {
    host.revertToCommitted();
    host.unload();
    if (s.scenario !== 'restartUninitialized') {
      if (s.committed) host.loadCommitted(s.committed);
      if (s.candidate) host.stageCandidate(s.candidate);
    }
  }

  function syncContent(): boolean {
    const s = readServed(dir);
    if (s === null || s.revision === applied.revision) return false;
    try {
      applyContent(s);
      applied = { revision: s.revision, scenario: s.scenario, probePeers: s.probePeers };
      log({ kind: 'lifecycle', event: 'state_applied', detail: { revision: s.revision, scenario: s.scenario, committed: s.committed?.generation ?? null, candidate: s.candidate?.generation ?? null } });
    } catch {
      // 内容超过上限或代数冲突：不提供任何内容（503），记下这一版已处理
      host.unload();
      applied = { revision: s.revision, scenario: s.scenario, probePeers: s.probePeers };
      log({ kind: 'lifecycle', event: 'state_rejected', detail: { revision: s.revision } });
    }
    return true;
  }

  let syncing: Promise<void> | null = null;
  const sync = (): Promise<void> => {
    if (syncing) return syncing;
    syncing = (async () => {
      let changed = false;
      try {
        changed = syncContent();
      } catch {
        log({ kind: 'lifecycle', event: 'state_rejected' });
      }
      if (closed) return;
      if (applied.scenario === 'stop' && listening) {
        listening = false;
        await host.close();
        log({ kind: 'lifecycle', event: 'stopped_listening' });
        changed = true;
      } else if (applied.scenario !== 'stop' && !listening) {
        try {
          await host.listen();
          listening = true;
          listenError = null;
          log({ kind: 'lifecycle', event: 'listening', detail: { port } });
        } catch (e) {
          // 端口被占用时每次读状态文件都会重试：只在第一次失败时记一行并更新状态
          const first = listenError === null;
          listenError = e;
          if (first) log({ kind: 'lifecycle', event: 'listen_failed', detail: { reason: (e as { details?: { reason?: unknown } }).details?.reason ?? 'other' } });
          changed = changed || first;
        }
        if (listening) changed = true;
      }
      if (changed) publishStatus();
    })().finally(() => {
      syncing = null;
    });
    return syncing;
  };

  return (async () => {
    // 与产品启动顺序相同：重启后不再提供未提交的候选版本（只提供已提交的一代），场景回到 --scenario 或 ok
    updateServed(dir, clock.now(), 'resource-server', () => ({ candidate: null, scenario: opts.scenario ?? 'ok', probePeers: false }));
    log({ kind: 'lifecycle', event: 'started', detail: { port, scenario: opts.scenario ?? 'ok' } });
    await sync();
    // 启动时绑定失败（端口被占用）：不运行，从不改用其他端口
    if (listenError !== null) {
      await host.close();
      writeServerStatus(dir, { ...status(), listening: false, stoppedAt: clock.now().toISOString() });
      throw listenError;
    }
    const timer = setInterval(() => void sync().catch(() => undefined), opts.pollMs ?? 100);
    timer.unref?.();
    // 状态文件被原子替换时尽快应用（目录监视只是加速，读不到时仍按间隔读取）
    let watcher: FSWatcher | null = null;
    try {
      watcher = watch(dir.path, (_event, name) => {
        if (name === null || String(name) === RESOURCE_SERVED_FILE) void sync().catch(() => undefined);
      });
      watcher.on('error', () => undefined);
      watcher.unref?.();
    } catch {
      watcher = null;
    }
    return {
      host,
      sync,
      status,
      async close() {
        if (closed) return;
        clearInterval(timer);
        watcher?.close();
        if (syncing) await syncing.catch(() => undefined);
        closed = true;
        listening = false;
        await host.close();
        log({ kind: 'lifecycle', event: 'stopped' });
        publishStatus();
      },
    };
  })();
}

// ---------- 端口占用者（--squat） ----------

/** 伪造的列表（squat200）：与测试节点同名的 C，换了用户、没有前置，端口是 discard（连接不会成功）。只有合成数据。 */
export const SQUAT_BODY = `# squatter\n${TEST_NODES.c} = socks5, 127.0.0.1, 9, username=p0-squat, password=example-p0-squat\n`;

export interface SquatBindResult {
  address: string;
  result: 'bound' | 'in_use' | 'unavailable' | 'error';
}

export interface SquatServerOptions {
  port: number;
  mode: SquatMode;
  binder: ResourceBinder;
  clock: Clock;
  /** 本次运行的令牌（同一用户可读时），只用来记录请求是否带了它；另一系统用户读不到为 null。 */
  token: string | null;
  /** 请求记录（写入运行目录；另一系统用户没有运行目录时只计数）。 */
  log: ((e: ResourceLogEntry) => void) | null;
  onRequest?: (address: string) => void;
}

export interface RunningSquatServer {
  /** 每个地址的绑定结果：127.0.0.1（经同一绑定方，只在端口空闲时）；被占用时另试 0.0.0.0、[::]、[::1]（记录路由）。 */
  binds: SquatBindResult[];
  /** 是否占用了 127.0.0.1:<端口>。 */
  holdsLoopback: boolean;
  requests(): number;
  close(): Promise<void>;
}

function squatResponse(mode: SquatMode): WireResponse {
  if (mode === 'squat404') return { status: 404, headers: { ...EMPTY_SCENARIO_HEADERS }, body: Buffer.alloc(0) };
  const body = Buffer.from(SQUAT_BODY, 'utf8');
  return { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': String(body.length), Connection: 'close' }, body };
}

function bindRaw(host: string, port: number, onRequest: () => void, mode: SquatMode): Promise<{ result: SquatBindResult['result']; server: Server | null }> {
  return new Promise((resolve) => {
    const server = createServer((socket) => {
      onRequest();
      const r = squatResponse(mode);
      let head = `HTTP/1.1 ${r.status} ${r.status === 200 ? 'OK' : 'Not Found'}\r\n`;
      for (const [k, v] of Object.entries(r.headers)) head += `${k}: ${v}\r\n`;
      socket.on('error', () => undefined);
      socket.once('data', () => socket.end(Buffer.concat([Buffer.from(`${head}\r\n`, 'latin1'), r.body])));
      socket.setTimeout(5000, () => socket.destroy());
    });
    server.once('error', (e: NodeJS.ErrnoException) => resolve({ result: e.code === 'EADDRINUSE' ? 'in_use' : e.code === 'EADDRNOTAVAIL' || e.code === 'EAFNOSUPPORT' ? 'unavailable' : 'error', server: null }));
    // 与占用者一样不设 ipv6Only：[::] 是双栈通配
    server.listen({ host, port }, () => resolve({ result: 'bound', server }));
  });
}

/**
 * 占用者：先经同一绑定方占用 127.0.0.1:<端口>（只在端口空闲时；被占用即失败，从不抢占）。127.0.0.1 被占用时（本服务在运行），
 * 另试同端口的 0.0.0.0、[::]、[::1]，绑定成功的保持监听并计数收到的连接——用来记录发往 127.0.0.1 的请求是否会到达它们。
 */
export async function startSquatServer(opts: SquatServerOptions): Promise<RunningSquatServer> {
  const { port, mode, clock } = opts;
  let count = 0;
  const binds: SquatBindResult[] = [];
  const raw: Server[] = [];
  let loopback: { close(): Promise<void> } | null = null;
  try {
    loopback = await opts.binder.bind(port, (req, respond) => {
      count++;
      opts.onRequest?.('127.0.0.1');
      const r = squatResponse(mode);
      opts.log?.({
        kind: 'request',
        at: clock.now().toISOString(),
        role: 'squat',
        method: String(req.method).slice(0, 16),
        status: r.status,
        generation: null,
        bytes: r.body.length,
        tokenOk: opts.token !== null && presentsToken(req.rawPath, opts.token),
        reason: null,
        handler: 'squat',
        scenario: mode,
        seq: null,
        headers: headerNames(req.rawHeaders),
      });
      respond(r as ResourceResponse);
    });
    binds.push({ address: '127.0.0.1', result: 'bound' });
  } catch (e) {
    const reason = (e as { details?: { reason?: unknown } }).details?.reason;
    binds.push({ address: '127.0.0.1', result: reason === 'port_in_use' ? 'in_use' : 'error' });
    for (const address of ['0.0.0.0', '::', '::1']) {
      const r = await bindRaw(address, port, () => {
        count++;
        opts.onRequest?.(address);
        opts.log?.({
          kind: 'request',
          at: clock.now().toISOString(),
          role: 'squat',
          method: '',
          status: null,
          generation: null,
          bytes: 0,
          tokenOk: false,
          reason: `connection:${address}`,
          handler: 'squat',
          scenario: mode,
          seq: null,
          headers: [],
        });
      }, mode);
      binds.push({ address, result: r.result });
      if (r.server) raw.push(r.server);
    }
  }
  return {
    binds,
    holdsLoopback: loopback !== null,
    requests: () => count,
    async close() {
      await loopback?.close();
      await Promise.all(raw.map((s) => new Promise<void>((r) => s.close(() => r()))));
    },
  };
}
