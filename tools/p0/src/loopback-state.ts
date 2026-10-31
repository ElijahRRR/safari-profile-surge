// 回环测试资源（D10）的运行目录文件：读取令牌、resource-server 提供的内容与故障场景（其他命令原子写入的状态文件）、
// resource-server 自己写的状态、请求记录与审计记录（产品 host.onServed 的序号、时间、代与是否完整写出）。
// 令牌只在 0600 的令牌文件中：从不作为命令行参数、从不进入日志或终端；请求记录只记名称、状态与原因代码。
// 故障场景是封闭的枚举；内容类场景（onlyBad、validAbBadC 等）由已提供的那一代内容按固定规则变换而来（纯函数），从不接受
// 任意内容或路径。

import { timingSafeEqual } from 'node:crypto';
import { EMPTY_PLACEHOLDER_LINE, RESOURCE_TOKEN_RE, nodeResourceUrl } from '@sfe/contract';
import { RESOURCE_SERVED_FILE, RESOURCE_SQUAT_STATUS_FILE, RESOURCE_STATUS_FILE, RESOURCE_TOKEN_FILE, SERVER_LOGS } from './constants.js';
import { parseProxyLine, type ResourceAuditRecord } from './deps.js';
import { refused } from './errors.js';
import type { RunDir } from './run-dir.js';
import { TEST_NODES, TEST_PROXIES } from './test-profile.js';

/**
 * resource-server 的场景（封闭集合，对应 2026-10-25 补测的矩阵）。除 ok、stop、restartUninitialized 外，都只在产品处理程序
 * （host.handle）已经接受了令牌正确的请求、准备答复 200 之后才改变答复；令牌、Host、请求头与方法的判断从不被绕过。
 * - ok：产品处理程序的原样答复；
 * - http401…http503：改答该状态码（空内容）；reset：不答复即断开；truncate：声明完整长度、只写出一半后断开；
 *   hang：写出响应头后不再发送数据，直到连接空闲上限（10 秒）由绑定方断开；
 * - empty200、onlyBad、validAbBadC、dupC、paramReplaceC、removeC、placeholderOnly：答复 200，内容按 scenarioBody 变换；
 * - stop：不监听（端口上无人，连接被拒绝）；restartUninitialized：不加载任何内容，令牌正确的请求由产品答复 503（服务刚启动、
 *   尚未初始化）。
 * 改变了答复的请求从不标记审计记录完成（finished 不调用）：之后的核对不会把它当作一次已提供的下载。
 */
export const RESOURCE_SCENARIOS = [
  'ok',
  'http401',
  'http403',
  'http404',
  'http500',
  'http503',
  'reset',
  'truncate',
  'hang',
  'empty200',
  'onlyBad',
  'validAbBadC',
  'dupC',
  'paramReplaceC',
  'removeC',
  'placeholderOnly',
  'stop',
  'restartUninitialized',
] as const;
export type ResourceScenario = (typeof RESOURCE_SCENARIOS)[number];

/**
 * 端口占用者的答复（loopback-auth 第 4、5 步）：squat200 伪造的列表；squat404 404；squatHang 收下请求（含读取令牌）后只写出
 * 响应头、不发送内容，Surge 等到请求超时（-1001，与 2026-10-25 矩阵「服务不发送响应」同一写法）。
 */
export const SQUAT_MODES = ['squat200', 'squat404', 'squatHang'] as const;
export type SquatMode = (typeof SQUAT_MODES)[number];

export function isResourceScenario(v: unknown): v is ResourceScenario {
  return typeof v === 'string' && (RESOURCE_SCENARIOS as readonly string[]).includes(v);
}

/** 只改状态码的场景。 */
export const STATUS_SCENARIOS: Readonly<Partial<Record<ResourceScenario, number>>> = Object.freeze({
  http401: 401,
  http403: 403,
  http404: 404,
  http500: 500,
  http503: 503,
});

/** 由产品处理程序原样答复（不经场景包装）的场景。 */
export function productHandled(scenario: ResourceScenario): boolean {
  return scenario === 'ok' || scenario === 'restartUninitialized' || scenario === 'stop';
}

// ---------- 读取令牌 ----------

/** 运行目录中的读取令牌；不存在为 null，格式不对时拒绝（从不静默重新生成：测试配置中的地址含旧令牌）。 */
export function readResourceToken(dir: RunDir): string | null {
  const text = dir.readText(RESOURCE_TOKEN_FILE);
  if (text === null) return null;
  const token = text.trim();
  if (!RESOURCE_TOKEN_RE.test(token)) throw refused('读取测试资源令牌失败：运行目录中的令牌文件格式不正确（不会重新生成；请换用新的运行）');
  return token;
}

/** 读取或创建读取令牌（32 个随机字节的十六进制，O_EXCL 0600）。 */
export function ensureResourceToken(dir: RunDir, random: () => Buffer): string {
  const existing = readResourceToken(dir);
  if (existing !== null) return existing;
  const token = random().toString('hex');
  if (!RESOURCE_TOKEN_RE.test(token)) throw new RangeError('resource token must be 32 random bytes');
  dir.writeNew(RESOURCE_TOKEN_FILE, `${token}\n`);
  return token;
}

/** 路径是否恰好是 `/<令牌>/sfe-nodes.list`（定长比较；只用于请求记录的 tokenOk，接受与否由产品处理程序决定）。 */
export function presentsToken(rawPath: string, token: string): boolean {
  const m = /^\/([0-9a-f]{64})\/sfe-nodes\.list$/.exec(rawPath);
  if (!m) return false;
  return timingSafeEqual(Buffer.from(m[1]!, 'hex'), Buffer.from(token, 'hex'));
}

/** 测试资源地址（含令牌：只写入测试配置，从不打印或写日志）。 */
export function testResourceUrl(port: number, token: string): string {
  return nodeResourceUrl(port, token);
}

// ---------- 提供的内容与场景（状态文件） ----------

export interface ServedGeneration {
  generation: number;
  content: string;
}

export interface ResourceServedFile {
  version: 1;
  /** 每次写入加一；resource-server 在状态文件中报告已应用到的版本。 */
  revision: number;
  /** 用过的最大代数：新的候选从它加一开始，同一代数从不对应两份内容（审计记录按代数核对）。 */
  lastGeneration: number;
  committed: ServedGeneration | null;
  candidate: ServedGeneration | null;
  scenario: ResourceScenario;
  /** hang 场景下（连接保持打开）用 lsof 记录发起连接的进程（loopback-auth 打开）。 */
  probePeers: boolean;
  writtenAt: string;
  writer: string;
}

export function emptyServed(now: Date): ResourceServedFile {
  return { version: 1, revision: 0, lastGeneration: 0, committed: null, candidate: null, scenario: 'ok', probePeers: false, writtenAt: now.toISOString(), writer: '' };
}

function validGeneration(g: unknown): g is ServedGeneration {
  const x = g as Partial<ServedGeneration> | null;
  return typeof x === 'object' && x !== null && Number.isSafeInteger(x.generation) && (x.generation ?? -1) >= 0 && typeof x.content === 'string';
}

/** 读取状态文件；不存在为 null。结构不对时拒绝（失败即关闭：不猜测要提供什么）。 */
export function readServed(dir: RunDir): ResourceServedFile | null {
  if (dir.readText(RESOURCE_SERVED_FILE) === null) return null;
  const s = dir.readJson<ResourceServedFile>(RESOURCE_SERVED_FILE);
  if (
    !s ||
    s.version !== 1 ||
    !Number.isSafeInteger(s.revision) ||
    !Number.isSafeInteger(s.lastGeneration) ||
    !(s.committed === null || validGeneration(s.committed)) ||
    !(s.candidate === null || validGeneration(s.candidate)) ||
    !isResourceScenario(s.scenario)
  ) {
    throw refused('读取测试资源状态失败：运行目录中的状态文件结构不正确');
  }
  return { ...s, probePeers: s.probePeers === true };
}

/** 读-改-写状态文件（原子替换，版本加一）。返回写入的内容。 */
export function updateServed(dir: RunDir, now: Date, writer: string, change: (s: ResourceServedFile) => Omit<Partial<ResourceServedFile>, 'version' | 'revision'>): ResourceServedFile {
  const current = readServed(dir) ?? emptyServed(now);
  const patch = change(current);
  const next: ResourceServedFile = { ...current, ...patch, version: 1, revision: current.revision + 1, writtenAt: now.toISOString(), writer };
  const gens = [next.committed?.generation ?? 0, next.candidate?.generation ?? 0, current.lastGeneration, patch.lastGeneration ?? 0];
  next.lastGeneration = Math.max(...gens);
  if (next.committed !== null && next.candidate !== null && next.committed.generation === next.candidate.generation) {
    throw refused('写入测试资源状态失败：候选与已提交版本的代数相同');
  }
  dir.writeJson(RESOURCE_SERVED_FILE, next);
  return next;
}

// ---------- resource-server 的状态 ----------

export interface ResourceServerStatus {
  version: 1;
  role: 'server' | 'squat';
  pid: number;
  port: number;
  /** server：产品处理程序；squat200/squat404/squatHang：端口占用者。 */
  mode: 'serve' | SquatMode;
  startedAt: string;
  /** 进程正常结束的时间；仍在运行为 null。 */
  stoppedAt: string | null;
  /** 是否在 127.0.0.1:<端口> 监听。 */
  listening: boolean;
  /** 已应用的状态文件版本（server）。 */
  appliedRevision: number;
  scenario: ResourceScenario | null;
  /** 当前提供的版本（server）。 */
  serving: { generation: number; state: 'committed' | 'candidate' } | null;
  updatedAt: string;
}

export function readServerStatus(dir: RunDir, role: 'server' | 'squat' = 'server'): ResourceServerStatus | null {
  const s = dir.readJson<ResourceServerStatus>(role === 'server' ? RESOURCE_STATUS_FILE : RESOURCE_SQUAT_STATUS_FILE);
  return s && s.version === 1 && s.role === role && Number.isSafeInteger(s.pid) && Number.isSafeInteger(s.port) ? s : null;
}

/** 进程是否还在（EPERM：在，但属于另一用户）。 */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** 状态文件说它在运行，而且进程还在（Mac 重启或被强制结束时状态文件没有 stoppedAt，进程却已不在）。 */
export function serverRunning(s: ResourceServerStatus | null): s is ResourceServerStatus {
  return s !== null && s.stoppedAt === null && pidAlive(s.pid);
}

export function writeServerStatus(dir: RunDir, status: ResourceServerStatus): void {
  dir.writeJson(status.role === 'server' ? RESOURCE_STATUS_FILE : RESOURCE_SQUAT_STATUS_FILE, status);
}

// ---------- 请求记录与审计记录 ----------

/** 发起连接的进程（lsof 按对端端口找到；路径来自 ps comm，只作记录）。 */
export interface PeerProcess {
  pid: number;
  command: string;
  path: string | null;
}

export interface ResourceRequestLogEntry {
  kind: 'request';
  at: string;
  role: 'server' | 'squat';
  method: string;
  /** 写出的状态码；不答复（reset）或只写响应头（hang）时为写出的状态或 null。 */
  status: number | null;
  /** 令牌正确时提供的代（产品处理程序记下的那一代）；其他为 null。 */
  generation: number | null;
  /** 写出的响应体字节数（不是内容）。 */
  bytes: number;
  /** 路径是否恰好带本次运行的读取令牌。 */
  tokenOk: boolean;
  /** 产品处理程序的原因代码（ok、unavailable、token_mismatch、forbidden_header…）；占用者为 null。 */
  reason: string | null;
  /** product：产品处理程序原样答复；scenario：处理程序接受之后由场景改变了答复；squat：占用者。 */
  handler: 'product' | 'scenario' | 'squat';
  scenario: ResourceScenario | SquatMode;
  /** 产品审计记录的序号（200 时）；没有为 null。 */
  seq: number | null;
  /** 请求头名称（小写，按出现顺序；不记值）。 */
  headers: string[];
}

/** hang 场景下（连接仍然打开）lsof 找到的发起连接的进程，按审计序号对应请求。 */
export interface ResourcePeerEntry {
  kind: 'peer';
  at: string;
  role: 'server';
  seq: number;
  peers: PeerProcess[] | null;
}

export interface ResourceLifecycleEntry {
  kind: 'lifecycle';
  at: string;
  role: 'server' | 'squat';
  event: 'started' | 'listening' | 'stopped_listening' | 'listen_failed' | 'state_applied' | 'state_rejected' | 'stopped';
  detail?: Record<string, unknown>;
}

export type ResourceLogEntry = ResourceRequestLogEntry | ResourceLifecycleEntry | ResourcePeerEntry;

export function readResourceLog(dir: RunDir): ResourceLogEntry[] {
  return dir.readJsonl<ResourceLogEntry>(SERVER_LOGS.resource).filter((e) => e && (e.kind === 'request' || e.kind === 'lifecycle' || e.kind === 'peer') && typeof e.at === 'string');
}

/** 时间窗内 lsof 记下的发起连接的进程。 */
export function peersBetween(dir: RunDir, from: number, to: number): ResourcePeerEntry[] {
  return readResourceLog(dir).filter((e): e is ResourcePeerEntry => {
    if (e.kind !== 'peer') return false;
    const t = Date.parse(e.at);
    return Number.isFinite(t) && t >= from && t <= to;
  });
}

/** 时间窗内（含两端）的请求记录。 */
export function requestsBetween(dir: RunDir, from: number, to: number, role: 'server' | 'squat' | null = null): ResourceRequestLogEntry[] {
  return readResourceLog(dir).filter((e): e is ResourceRequestLogEntry => {
    if (e.kind !== 'request') return false;
    const t = Date.parse(e.at);
    return Number.isFinite(t) && t >= from && t <= to && (role === null || e.role === role);
  });
}

interface StoredAuditRecord {
  seq: number;
  at: string;
  generation: number;
  complete: boolean;
}

/** 审计记录（同一序号先记未完成、写完再记完成：完成的那条为准），按序号排序。 */
export function readAuditRecords(dir: RunDir): ResourceAuditRecord[] {
  const bySeq = new Map<number, ResourceAuditRecord>();
  for (const r of dir.readJsonl<StoredAuditRecord>(SERVER_LOGS.resourceAudit)) {
    if (!r || !Number.isSafeInteger(r.seq) || r.seq < 1 || !Number.isSafeInteger(r.generation) || typeof r.complete !== 'boolean') continue;
    const at = new Date(r.at);
    if (!Number.isFinite(at.getTime())) continue;
    const prev = bySeq.get(r.seq);
    if (prev?.complete) continue;
    bySeq.set(r.seq, { seq: r.seq, at, generation: r.generation, complete: r.complete });
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

export function appendAuditRecord(dir: RunDir, r: ResourceAuditRecord): void {
  dir.appendJsonl(SERVER_LOGS.resourceAudit, { seq: r.seq, at: r.at.toISOString(), generation: r.generation, complete: r.complete });
}

/** 下一条审计记录的序号（与产品 host.auditMark() 相同的含义：之后的 200 序号都不小于它）。 */
export function auditMarkOf(dir: RunDir): number {
  return readAuditRecords(dir).reduce((m, r) => Math.max(m, r.seq), 0) + 1;
}

/** 时间窗内服务答复的 404/503 次数（auditResource 的 servedFailures；不含场景改变的答复与占用者）。 */
export function servedFailuresBetween(dir: RunDir, from: number, to: number): number {
  return requestsBetween(dir, from, to, 'server').filter((e) => e.handler === 'product' && (e.status === 404 || e.status === 503)).length;
}

// ---------- 内容类场景 ----------

/** paramReplaceC 对 C 行的改写：服务器、端口与前置三项同时变化（其余参数不变）。解析不了的行原样返回。 */
function paramReplacedLine(line: string): string {
  const p = parseProxyLine(line);
  if (!p || p.server === null || p.port === null) return line;
  const server = p.server === PARAM_REPLACE_C.server ? PARAM_REPLACE_C.altServer : PARAM_REPLACE_C.server;
  const port = p.port === PARAM_REPLACE_C.port ? PARAM_REPLACE_C.altPort : PARAM_REPLACE_C.port;
  const m = /^(\s*[^=]+?\s*=\s*[^,]+,\s*)([^,]+)(,\s*)([^,]+)(.*)$/.exec(line);
  if (!m) return line;
  const rest = /\bunderlying-proxy=/.test(m[5]!) ? m[5]!.replace(/\bunderlying-proxy=[^,]*/, `underlying-proxy=${TEST_PROXIES.deadFront}`) : `${m[5]!}, underlying-proxy=${TEST_PROXIES.deadFront}`;
  return `${m[1]}${server}${m[3]}${port}${rest}`;
}

/** paramReplaceC 提供的 C 的参数（读回必须逐项等于它们）；内容中没有 C 时为 null。 */
export function paramReplacedC(content: string): { server: string | null; port: number | null; underlyingProxy: string | null } | null {
  const line = scenarioBody('paramReplaceC', content)
    .split(/\r?\n/)
    .find((l) => parseProxyLine(l.trim())?.name === TEST_NODES.c);
  const p = line ? parseProxyLine(line.trim()) : null;
  return p ? { server: p.server, port: p.port, underlyingProxy: p.params['underlying-proxy'] ?? null } : null;
}

/** 坏行：Surge 应当跳过（缺少服务器与端口、不是节点行）。只用合成名称。 */
const BAD_LINES = ['SFE-N-P0-BAD = socks5', 'this is not a proxy line'];
/** dupC 中第二个 C 的用户名（只差用户名：读回无法区分）。 */
export const DUP_C_USERNAME = 'p0-c-dup';
/**
 * paramReplaceC 中同名 C 的新服务器与端口（RFC 5737 文档地址与 discard 端口：只用于读回，从不经它连接）；与原值相同时取备用值，
 * 保证服务器、端口与前置三项都变化。
 */
export const PARAM_REPLACE_C = { server: '192.0.2.33', altServer: '192.0.2.34', port: 9, altPort: 10 } as const;

function splitBody(content: string): { header: string[]; nodes: Array<{ name: string; line: string }> } {
  const header: string[] = [];
  const nodes: Array<{ name: string; line: string }> = [];
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '') continue;
    if (line.startsWith('#') || line.startsWith('//') || line.startsWith(';')) {
      if (nodes.length === 0) header.push(line);
      continue;
    }
    const p = parseProxyLine(line);
    nodes.push({ name: p?.name ?? '', line });
  }
  return { header, nodes };
}

function joinBody(header: readonly string[], lines: readonly string[]): string {
  return `${[...header, ...lines].join('\n')}\n`;
}

/**
 * 内容类场景的响应体：由当前提供的那一代内容按固定规则变换（纯函数）。只认识合成测试节点名；C 不存在时 dupC 与
 * paramReplaceC 原样返回（调用方先提供含 C 的一代）。
 * - empty200：空内容；onlyBad：只有文件头与坏行；validAbBadC：有效的 A、B 加坏的 C；
 * - dupC：在 C 之后再加一条只差用户名的 C；paramReplaceC：同名 C 的服务器、端口与前置同时改变（服务器改为 RFC 5737 文档地址、
 *   端口改为 discard、前置改为 P0-Front-Dead；读回必须逐项读到新值，证明三项都是新读的）；
 * - removeC：删除 C；placeholderOnly：只有文件头与占位行 SFE-EMPTY = reject。
 */
export function scenarioBody(scenario: ResourceScenario, content: string): string {
  const { header, nodes } = splitBody(content);
  const isC = (n: { name: string }): boolean => n.name === TEST_NODES.c;
  const c = nodes.find(isC);
  switch (scenario) {
    case 'empty200':
      return '';
    case 'onlyBad':
      return joinBody(header, BAD_LINES);
    case 'validAbBadC':
      return joinBody(header, [...nodes.filter((n) => n.name === TEST_NODES.a || n.name === TEST_NODES.b).map((n) => n.line), `${TEST_NODES.c} = socks5, 127.0.0.1`]);
    case 'dupC': {
      if (!c) return content;
      const dup = /\busername=/.test(c.line) ? c.line.replace(/\busername=[^,]*/, `username=${DUP_C_USERNAME}`) : `${c.line}, username=${DUP_C_USERNAME}`;
      const out: string[] = [];
      for (const n of nodes) {
        out.push(n.line);
        if (n === c) out.push(dup);
      }
      return joinBody(header, out);
    }
    case 'paramReplaceC': {
      if (!c) return content;
      return joinBody(header, nodes.map((n) => (n === c ? paramReplacedLine(c.line) : n.line)));
    }
    case 'removeC':
      return joinBody(header, nodes.filter((n) => !isC(n)).map((n) => n.line));
    case 'placeholderOnly':
      return joinBody(header, [EMPTY_PLACEHOLDER_LINE]);
    default:
      return content;
  }
}
