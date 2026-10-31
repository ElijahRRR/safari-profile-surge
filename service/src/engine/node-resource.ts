// 本机资源服务（D10）的引擎接线：启动顺序、审计、节点资源未确认警告、系统强制刷新与状态视图（loopback-spec §6）。
// - 启动（app.start，keys 之后）：惰性读取令牌并登记到脱敏器（读不到时资源服务为 null、服务照常运行）；建资源服务，每条审计记录
//   同步持久保存；首次启动选定端口（避开工作配置 [General] 中的端口，经绑定方试绑，最多 10 次）；初始化已提交/候选指针；撤回启动时
//   仍在的候选版本；加载已提交版本（代数 0 为占位内容，> 0 只在 resourceServe 门槛满足且重建内容与发布记录一致时提供，否则 503）；
//   令牌可疑时拒绝令牌；监听之前审计 Surge 报告的资源（本服务停止期间端口可能被他人占用）；最后监听。
// - 对账（每次）：重试监听、审计、组成员与已提交版本比较、使用中节点的参数核对。只设 node_resource_unverified，从不清除它；
//   只在经确认的发布或回滚读回之后由 confirmNodeResource 清除。
// - 系统强制刷新：工作配置的节点组定义恰好是本服务当前地址、需要刷新、没有进行中的发布、也没有尚未确认的系统刷新时排入一次
//   （门槛不满足时停泊，无害）；之后只有经确认的读回才重新允许自动排入，从不自动反复更新。
// 从不写 Surge：唯一的写入是排入的发布操作（由执行器按发布门槛执行）。令牌、地址与端口从不进入日志、错误、操作说明或视图。

import { randomInt } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  CAPABILITY_GATES,
  EMPTY_PLACEHOLDER_NODE,
  RESOURCE_PORT_MAX,
  RESOURCE_PORT_MIN,
  ROUTE_GROUP_NAME,
  SfeError,
  parseNodeResourceUrl,
  type ApiErrorBody,
  type NodeResourceStatusView,
  type RouteWarning,
} from '@sfe/contract';
import type { OperationRecord } from '../db/index.js';
import { OPEN_STATUSES, PUBLISH_KINDS } from '../domain/operations.js';
import {
  RESOURCE_KV_KEYS,
  auditResource,
  createResourceHost,
  loadResourceToken,
  readAuditLog,
  readAuditState,
  readNeedsRefresh,
  readServedPointer,
  readTokenSuspect,
  recordAuditEntry,
  resourceLocationHash,
  resourceTokenRefIndex,
  resourceTokenRefOf,
  servedFailureCount,
  tcpBinder,
  writeAuditState,
  writeNeedsRefresh,
  writeServedPointer,
  writeTokenSuspect,
  type ResourceBinder,
  type ResourceHost,
  type ResourceResponse,
  type ResourceServedPointer,
  type ResourceSnapshot,
} from '../resource/index.js';
import type { SurgeExternalResource } from '../ports.js';
import { isLegacyNodeGroupLine, loopbackGroupBlockLines, resourceBody } from '../surge/generate.js';
import { findManagedBlock, findSections, parseProfile } from '../surge/profile.js';
import type { Engine, NodeResourceLine } from './context.js';
import { regenerateResourceBody } from './resource.js';

export const NODE_RESOURCE_WARNING: RouteWarning = 'node_resource_unverified';

/** 首次选定端口时最多试这么多次（每次随机选一个范围内的端口）。 */
export const RESOURCE_PORT_PICK_TRIES = 10;

/** 工作配置 [General] 中占用本机端口的键：新选的资源服务端口避开它们的值。 */
export const GENERAL_PORT_KEYS: readonly string[] = ['http-api', 'http-listen', 'socks5-listen', 'external-controller-access', 'probe-bind'];

/**
 * 最近一次自动排入的系统强制刷新发布（engine.kv）：它存在（操作仍在）时不再自动排入，直到经确认的读回（confirmNodeResource）
 * 删除它——停泊、失败或需要处理的系统刷新不会被自动重试，由用户发布待部署或重新合并处理。
 */
export const SYSTEM_REFRESH_KEY = 'resource:systemRefresh';

/** 节点资源未确认的原因（日志与对账说明用的代码；不含令牌、地址或端口）。 */
export type NodeResourceReason =
  | 'token_unavailable'
  | 'not_listening'
  | 'token_suspect'
  | 'audit_state_unreadable'
  | 'unexplained_fetch'
  | 'unexplained_error'
  | 'resource_missing'
  | 'resource_ambiguous'
  | 'resource_foreign'
  | 'resource_url_changed'
  | 'members_mismatch'
  | 'node_detail_mismatch'
  | 'candidate_served'
  | 'readback_unconfirmed';

const REASON_TEXT: Record<NodeResourceReason, string> = {
  token_unavailable: '本机资源服务的读取令牌读不到',
  not_listening: '本机资源服务没有在已设置的端口监听',
  token_suspect: '读取令牌可能已泄露',
  audit_state_unreadable: '审计状态无法读取',
  unexplained_fetch: 'Surge 报告了本服务没有提供过的下载',
  unexplained_error: 'Surge 报告了本服务无法解释的资源错误',
  resource_missing: 'Surge 中找不到指向本机资源服务的节点资源',
  resource_ambiguous: 'Surge 中有多个指向本机资源服务地址的资源',
  resource_foreign: '指向本机资源服务地址的资源不是工作配置中的远端节点组资源',
  resource_url_changed: '工作配置中的本机资源地址不是本服务当前的地址',
  members_mismatch: 'SFE-ROUTE 的成员与已提交版本不同',
  node_detail_mismatch: '节点的服务器、端口或前置与其版本不同',
  candidate_served: '启动时撤回的候选版本可能已被 Surge 载入',
  readback_unconfirmed: '发布或回滚之后的读回无法确认',
};

/** 对账与失败说明中的原因文本（只含原因，不含令牌、地址或端口）。 */
export function nodeResourceReasonText(reasons: readonly NodeResourceReason[]): string {
  return [...new Set(reasons)].map((r) => REASON_TEXT[r]).join('、');
}

// ---------- 工作配置 ----------

const POLICY_PATH_RE = /\bpolicy-path\s*=\s*([^,\s]+)/gi;

/**
 * 受管理 group 段中的节点组定义（NodeResourceLine）。ours 要求段内容逐行等于 loopbackGroupBlockLines(url)（由本应用生成，
 * 任何改动都不算）；url 为 null（令牌读不到或尚未选定端口）时只可能是 loopback_other、legacy 或 none。
 */
export function classifyGroupLine(text: string, url: string | null): NodeResourceLine {
  const block = findManagedBlock(parseProfile(text), 'group');
  if (typeof block !== 'object') return 'none';
  if (url !== null) {
    let expected: string[] | null = null;
    try {
      expected = loopbackGroupBlockLines(url);
    } catch {
      expected = null;
    }
    if (expected !== null && block.lines.length === expected.length && block.lines.every((l, i) => l === expected![i])) return 'ours';
  }
  if (block.lines.some((l) => isLegacyNodeGroupLine(l))) return 'legacy';
  for (const l of block.lines) {
    for (const m of l.matchAll(POLICY_PATH_RE)) if (parseNodeResourceUrl(m[1]!) !== null) return 'loopback_other';
  }
  return 'none';
}

/** 工作配置引用了本机资源服务形式的地址（本服务当前地址，或令牌、端口已不同的旧地址）。 */
export function referencesLoopback(line: NodeResourceLine | null): boolean {
  return line === 'ours' || line === 'loopback_other';
}

/** 重读工作配置并更新 resourceRuntime.line；没有工作配置时为 null，读不到时沿用上一次的结论。 */
export async function readGroupLine(engine: Engine): Promise<NodeResourceLine | null> {
  const wp = engine.workingProfile();
  if (!wp) {
    engine.resourceRuntime.line = null;
    return null;
  }
  let text: string;
  try {
    text = await readFile(wp.path, 'utf8');
  } catch {
    return engine.resourceRuntime.line;
  }
  const line = classifyGroupLine(text, engine.resourceUrl());
  engine.resourceRuntime.line = line;
  return line;
}

/** 工作配置 [General] 中 GENERAL_PORT_KEYS 的值里出现的端口（`主机:端口`、`密码@主机:端口` 或单独的端口号）。 */
export function generalPorts(text: string): Set<number> {
  const parsed = parseProfile(text);
  const out = new Set<number>();
  for (const section of findSections(parsed, 'General')) {
    for (let i = section.start; i < section.end; i++) {
      const m = /^\s*([A-Za-z0-9-]+)\s*=\s*(.*?)\s*$/.exec(parsed.lines[i]!.text);
      if (!m || !GENERAL_PORT_KEYS.includes(m[1]!.toLowerCase())) continue;
      for (const token of m[2]!.split(/[\s,]+/)) {
        const pm = /(?:^|:)(\d{1,5})$/.exec(token);
        if (!pm) continue;
        const port = Number(pm[1]);
        if (port >= 1 && port <= 65535) out.add(port);
      }
    }
  }
  return out;
}

// ---------- 端口 ----------

const PROBE_RESPONSE: ResourceResponse = { status: 404, headers: { 'Content-Length': '0', Connection: 'close' }, body: Buffer.alloc(0) };

/** 经绑定方试绑一个端口并立即关闭（只回答统一的空 404，从不提供内容）。 */
async function probeBind(binder: ResourceBinder, port: number): Promise<boolean> {
  try {
    const socket = await binder.bind(port, (_req, respond) => respond(PROBE_RESPONSE));
    await socket.close();
    return true;
  } catch {
    return false;
  }
}

/**
 * 在 [RESOURCE_PORT_MIN, RESOURCE_PORT_MAX) 中随机选端口：跳过 excluded 与已试过的，能绑定（tryBind）即返回；tries 次都不行时
 * 为 null（每次选取都计一次，含被跳过的）。
 */
export async function pickResourcePort(opts: {
  excluded: ReadonlySet<number>;
  tryBind: (port: number) => Promise<boolean>;
  random?: () => number;
  tries?: number;
}): Promise<number | null> {
  const random = opts.random ?? (() => randomInt(RESOURCE_PORT_MIN, RESOURCE_PORT_MAX));
  const tries = opts.tries ?? RESOURCE_PORT_PICK_TRIES;
  const tried = new Set<number>();
  for (let i = 0; i < tries; i++) {
    const port = random();
    if (!Number.isSafeInteger(port) || port < RESOURCE_PORT_MIN || port >= RESOURCE_PORT_MAX) continue;
    if (opts.excluded.has(port) || tried.has(port)) continue;
    tried.add(port);
    if (await opts.tryBind(port)) return port;
  }
  return null;
}

/** 回环主机加端口（127.0.0.0/8、localhost、[::1]）：配置文本中出现的这些端口不作为新的资源服务端口。 */
const LOOPBACK_HOST_PORT_RE = /(?<![0-9A-Za-z.-])(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|localhost|\[::1\]):(\d{1,5})(?!\d)/gi;

/** 配置文本中任何位置（含注释）出现的回环端口（`127.0.0.1:端口`、`localhost:端口`、`[::1]:端口`）。 */
export function loopbackPortsIn(text: string): Set<number> {
  const out = new Set<number>();
  for (const m of text.matchAll(LOOPBACK_HOST_PORT_RE)) {
    const port = Number(m[2]);
    if (port >= 1 && port <= 65535) out.add(port);
  }
  return out;
}

/**
 * 外部资源位置（Surge 报告、已脱敏的地址，例如 `http://127.0.0.1:<端口>/***`）中的回环端口；不是回环主机的 http(s) 地址时为
 * null（本地文件、其他主机）。没有写端口时按协议的缺省端口。
 */
export function loopbackPortOfLocation(location: string): number | null {
  let u: URL;
  try {
    u = new URL(location);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase();
  if (host !== 'localhost' && host !== '[::1]' && !/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return null;
  return u.port === '' ? (u.protocol === 'https:' ? 443 : 80) : Number(u.port);
}

/**
 * 轮换资源地址（重新合并）：按首次选定端口的规则（范围内随机、避开 excluded、最多 10 次）为新的资源服务选端口，每次直接让它
 * 在该端口监听（绑定成功即选定，不另外试绑）。选不到时为 null，资源服务不在任何端口监听。
 */
export async function listenOnNewPort(engine: Engine, host: ResourceHost, excluded: ReadonlySet<number>): Promise<number | null> {
  const port = await pickResourcePort({
    excluded,
    tryBind: async (p) => {
      if (engine.resourceRuntime.stopped) return false;
      host.configure(p);
      try {
        await host.listen();
        return true;
      } catch {
        return false;
      }
    },
  });
  if (port === null) host.configure(null);
  return port;
}

/** 设置中的端口；还没有时选定并保存（启动第 2 步）。选不到时记日志并保持 null：之后的初始化、重新合并与发布停泊。 */
async function ensureResourcePort(engine: Engine, binder: ResourceBinder): Promise<number | null> {
  const current = engine.repos.settings.get('resourcePort');
  if (current !== null) return current;
  let excluded = new Set<number>();
  const wp = engine.workingProfile();
  if (wp) {
    try {
      excluded = generalPorts(await readFile(wp.path, 'utf8'));
    } catch {
      // 读不到工作配置：只靠试绑避开正在使用的端口
    }
  }
  const port = await pickResourcePort({ excluded, tryBind: (p) => probeBind(binder, p) });
  if (port === null) {
    engine.log('error', 'resource.port_unavailable', { tries: RESOURCE_PORT_PICK_TRIES });
    return null;
  }
  engine.repos.settings.setResourcePort(port);
  engine.log('info', 'resource.port_selected');
  return port;
}

// ---------- 资源服务 ----------

function reasonOf(err: unknown): string {
  return err instanceof SfeError && typeof err.details?.reason === 'string' ? err.details.reason : 'other';
}

/** 资源服务的绑定方：AppServiceDeps.resourceBinder（测试与演示为进程内的 virtualBinder），缺省经 127.0.0.1 套接字。 */
export function engineResourceBinder(engine: Engine): ResourceBinder {
  return engine.deps.resourceBinder ?? tcpBinder({ logger: engine.logger.child('resource') });
}

/**
 * 用给定令牌建资源服务：令牌登记到脱敏器（固定，不会被淘汰）；审计记录从持久状态恢复（序号接着之前的），之后每条同步持久保存。
 * 不配置端口、不监听、不替换 engine.resource。轮换资源地址（重新合并）用它建新令牌的资源服务：先让旧的不再答复 200（关闭或
 * setRefuseToken(true)）再建，否则两个资源服务会用同一个序号记录审计。
 */
export function createEngineResourceHost(engine: Engine, token: string, binder: ResourceBinder = engineResourceBinder(engine)): ResourceHost {
  engine.scrubber.register(token, { pinned: true });
  const host = createResourceHost({ token, clock: engine.clock, logger: engine.logger.child('resource'), binder, audit: readAuditLog(engine.kv) });
  // 写出响应体之前与完整写出之后各一次，同步写入数据库：写入失败时资源服务不提供内容（503），每次提供的内容都有持久记录
  host.onServed((r) => recordAuditEntry(engine.kv, r));
  return host;
}

/** 读取令牌（失败记 resource.token_unavailable 并返回 null）并建资源服务。 */
async function loadEngineResourceHost(engine: Engine, binder: ResourceBinder): Promise<ResourceHost | null> {
  let token: string;
  try {
    token = await loadResourceToken(engine.store, engine.repos.meta);
  } catch (err) {
    engine.log('error', 'resource.token_unavailable', { reason: reasonOf(err) });
    return null;
  }
  return createEngineResourceHost(engine, token, binder);
}

/**
 * 换上新的资源服务（轮换资源地址之后）：engine.resource 指向它，旧的关闭；之后的第一次审计不按“一直在监听”计。令牌可疑记录
 * 存在时新的同样拒绝令牌（清除 tokenSuspect 与 setRefuseToken(false) 由调用方在轮换提交之后进行）。
 */
export async function adoptResourceHost(engine: Engine, host: ResourceHost): Promise<void> {
  const old = engine.resource;
  engine.resource = host;
  engine.resourceRuntime.lastAudit = null;
  if (readTokenSuspect(engine.kv) !== null) host.setRefuseToken(true);
  if (old !== null && old !== host) await old.close().catch(() => undefined);
}

/** 启动时检查的轮换残留引用个数（与 resource/token.ts 轮换时最多跳过的已占用引用数相同）。 */
const STALE_TOKEN_REFS_AFTER = 16;

/**
 * 轮换资源地址（重新合并）中断留下的读取令牌值（只在本机资料中）：当前引用的前一个（轮换已提交、删除旧值之前中断）与之后的
 * 若干个（生成新令牌之后、提交之前中断；工作配置即使已写入新地址，本服务也不再提供它，由重新合并恢复）。启动时删除，
 * 失败只记日志。只记个数，从不记引用或值。
 */
async function sweepStaleResourceTokens(engine: Engine): Promise<void> {
  const ref = engine.repos.meta.resourceTokenRef();
  const n = ref === null ? null : resourceTokenRefIndex(ref);
  if (n === null) return;
  const stale = [...(n > 1 ? [n - 1] : []), ...Array.from({ length: STALE_TOKEN_REFS_AFTER }, (_, i) => n + 1 + i)];
  let removed = 0;
  try {
    for (const k of stale) {
      const r = resourceTokenRefOf(k);
      if ((await engine.store.get(r)) === null) continue;
      await engine.store.delete(r);
      removed++;
    }
  } catch {
    engine.log('warn', 'resource.stale_token_sweep_failed');
  }
  if (removed > 0) engine.log('warn', 'resource.stale_tokens_removed', { count: removed });
}

/** 需要刷新：已有记录时保留原来的（最早的原因）。 */
function requireRefresh(engine: Engine, generation: number, reason: string): void {
  if (readNeedsRefresh(engine.kv) === null) writeNeedsRefresh(engine.kv, { generation, reason });
}

/** 令牌可能已泄露：持久记录（已有时不改）、资源服务对令牌正确的请求也答 404。只能由重新合并的“轮换资源地址”清除。 */
function markTokenSuspect(engine: Engine, reason: string): void {
  if (readTokenSuspect(engine.kv) === null) {
    writeTokenSuspect(engine.kv, { since: engine.nowIso(), reason });
    engine.log('warn', 'resource.token_suspect', { reason });
  }
  engine.resource?.setRefuseToken(true);
}

/**
 * 发布读回发现 Surge 报告的更新时间没有对应本服务的任何一次完整 200（与审计的无法解释的下载相同，handlers/publish.ts）：
 * Surge 载入了不是本服务提供的内容——令牌可能已泄露（tokenSuspect，资源服务对令牌正确的请求也答 404）、需要刷新、设
 * node_resource_unverified。
 */
export function flagUnexplainedFetch(engine: Engine): void {
  engine.repos.tx(() => {
    markTokenSuspect(engine, 'unexplained_fetch');
    requireRefresh(engine, readServedPointer(engine.kv)?.committed.generation ?? 0, 'unexplained_fetch');
  });
  raiseNodeResourceWarning(engine, ['unexplained_fetch']);
}

/**
 * 首次启动初始化指针（resource:served）：已提交版本取最近一次 verified/published、重建内容与发布记录摘要一致的发布，没有时为
 * 代数 0。找到的不是最近一次 verified/published 的发布或没有找到时设 needsRefresh（pointer_init）。
 */
async function initServedPointer(engine: Engine): Promise<ResourceServedPointer> {
  const existing = readServedPointer(engine.kv);
  if (existing !== null) return existing;
  const published = engine.repos.deployments.list(-1).filter((d) => d.state === 'verified' || d.state === 'published');
  let committed = 0;
  let refresh = true;
  for (const [i, d] of published.entries()) {
    if ((await regenerateResourceBody(engine, d).catch(() => null)) === null) continue;
    committed = d.generation;
    refresh = i !== 0;
    break;
  }
  const pointer: ResourceServedPointer = { committed: { generation: committed }, candidate: null };
  engine.repos.tx(() => {
    if (readServedPointer(engine.kv) !== null) return;
    writeServedPointer(engine.kv, pointer);
    if (refresh) requireRefresh(engine, committed, 'pointer_init');
  });
  engine.log('info', 'resource.pointer_initialized', { generation: committed, refresh });
  return readServedPointer(engine.kv) ?? pointer;
}

/**
 * 提供已提交版本：代数 0 为只含占位行的内容；代数 > 0 只在 resourceServe 门槛满足、按发布清单重建的内容与发布记录摘要一致时
 * 提供，否则不提供（令牌正确的请求得到 503）并要求刷新——从不提供与记录不一致或门槛之外的凭据。
 */
async function serveCommitted(engine: Engine, host: ResourceHost, generation: number): Promise<boolean> {
  const runtime = engine.resourceRuntime;
  const notServed = (reason: 'serve_gated' | 'regenerate_failed', fields: Record<string, unknown>): false => {
    host.unload();
    // 同一代数、同一原因只记一次（对账每次都会重试）
    if (runtime.serveIssue !== `${generation}:${reason}`) engine.log(reason === 'serve_gated' ? 'warn' : 'error', `resource.${reason}`, { generation, ...fields });
    runtime.serveIssue = `${generation}:${reason}`;
    requireRefresh(engine, generation, reason);
    return false;
  };
  if (generation === 0) {
    host.loadCommitted({ generation: 0, content: resourceBody(0, []) });
    runtime.serveIssue = null;
    return true;
  }
  const missing = engine.missing(CAPABILITY_GATES.resourceServe);
  if (missing.length > 0) return notServed('serve_gated', { missing });
  const d = engine.repos.deployments.get(generation);
  const body = d ? await regenerateResourceBody(engine, d).catch(() => null) : null;
  try {
    if (body === null) throw new SfeError('VALIDATION_FAILED', 'regenerate failed');
    host.loadCommitted({ generation, content: body });
  } catch {
    return notServed('regenerate_failed', {});
  }
  runtime.serveIssue = null;
  return true;
}

/**
 * 对账时维护提供的内容：没有候选版本时，已提交版本没有在提供而门槛已满足（例如启动时 Surge 版本还读不到）则重新加载；提供着
 * 代数 > 0 而 resourceServe 门槛已不满足（记录过期、被撤销）则停止提供。读事实之后调用。
 */
async function maintainServed(engine: Engine, host: ResourceHost): Promise<void> {
  const pointer = readServedPointer(engine.kv);
  if (pointer === null || pointer.candidate !== null) return;
  const served = host.served();
  if (served?.state === 'candidate') return;
  const generation = pointer.committed.generation;
  const gated = generation > 0 && engine.missing(CAPABILITY_GATES.resourceServe).length > 0;
  // serveCommitted 在门槛不满足或重建失败时停止提供并要求刷新（同一原因只记一次日志）
  if (served === null || served.generation !== generation || gated) await serveCommitted(engine, host, generation);
}

/**
 * 重新提供指针中的已提交版本（重新合并恢复、轮换资源地址之后；门槛与摘要规则同启动第 4 步）。没有资源服务、指针或有候选版本时
 * 为 false。读事实之后调用（门槛按当前 Surge 版本判定）。
 */
export async function serveCommittedGeneration(engine: Engine): Promise<boolean> {
  const host = engine.resource;
  return host === null ? false : serveCommittedOn(engine, host);
}

/**
 * 让给定的资源服务提供指针中的已提交版本（规则同 serveCommittedGeneration）：轮换资源地址时新令牌的资源服务在监听之前加载。
 * 指针缺失、有候选版本或该资源服务暂存着候选版本时为 false。
 */
export async function serveCommittedOn(engine: Engine, host: ResourceHost): Promise<boolean> {
  const pointer = readServedPointer(engine.kv);
  if (pointer === null || pointer.candidate !== null || host.served()?.state === 'candidate') return false;
  return serveCommitted(engine, host, pointer.committed.generation);
}

/**
 * 监听已设置的端口（启动第 7 步与每次对账）：成功时 listenEpoch 加一；失败记 resource.listen_failed（原因变化时），端口被占用
 * 而工作配置指向本服务当前地址时设 tokenSuspect（占用者可能已收到读取令牌）。从不改用其他端口。
 */
export async function listenResourceHost(engine: Engine): Promise<boolean> {
  const host = engine.resource;
  const port = engine.repos.settings.get('resourcePort');
  if (!host || port === null) return false;
  // 服务停止之后不再监听（main.ts 在停止之后关闭资源服务）
  if (engine.resourceRuntime.stopped) return host.listening();
  const url = engine.resourceUrl();
  if (url === null) return false;
  if (host.url() !== url) host.configure(port);
  if (host.listening()) return true;
  const runtime = engine.resourceRuntime;
  try {
    await host.listen();
    // 绑定期间服务开始停止：立即放开端口
    if (runtime.stopped) {
      await host.close();
      return false;
    }
  } catch (err) {
    const reason = reasonOf(err) === 'port_in_use' ? 'port_in_use' : 'other';
    if (runtime.listenError !== reason) engine.log('warn', 'resource.listen_failed', { reason });
    runtime.listenError = reason;
    if (reason === 'port_in_use' && runtime.line === 'ours') markTokenSuspect(engine, 'port_in_use');
    return false;
  }
  runtime.listenEpoch++;
  if (runtime.listenError !== null) engine.log('info', 'resource.listen_restored');
  else engine.log('info', 'resource.listening');
  runtime.listenError = null;
  return true;
}

// ---------- 启动 ----------

/**
 * 启动顺序（loopback-spec §6 第 1–7 步，在 keys 之后、对账与执行器之前）。任何失败都不阻止服务启动：进入普通模式与 REJECT
 * 保持从不依赖本机资源服务。
 */
export async function startResourceService(engine: Engine): Promise<void> {
  const runtime = engine.resourceRuntime;
  runtime.lastAudit = null;
  runtime.stopped = false;
  runtime.listenDeferred = false;
  const binder = engineResourceBinder(engine);
  // 1. 令牌与资源服务（同一进程内重新 start 时沿用已有的资源服务）
  let host = engine.resource;
  if (host === null) {
    host = await loadEngineResourceHost(engine, binder);
    engine.resource = host;
  }
  if (host === null) {
    await readGroupLine(engine);
    return;
  }
  await sweepStaleResourceTokens(engine);
  // 2. 端口
  const port = await ensureResourcePort(engine, binder);
  host.configure(port);
  const line = await readGroupLine(engine);
  // 3. 指针：首次初始化；撤回启动时仍在的候选版本（同一事务记下 needsRefresh），从不重放
  const pointer = await initServedPointer(engine);
  if (pointer.candidate !== null) {
    const candidate = pointer.candidate.generation;
    engine.repos.tx(() => {
      writeServedPointer(engine.kv, { committed: pointer.committed, candidate: null });
      writeNeedsRefresh(engine.kv, { generation: candidate, reason: 'startup_candidate' });
    });
    engine.log('warn', 'resource.candidate_reverted', { generation: candidate });
    // 候选版本提供过（有它的审计记录）：Surge 可能载入了它，而它从未提交——节点资源未确认，直到经确认的读回
    if (referencesLoopback(line) && host.audit().some((r) => r.generation === candidate)) raiseNodeResourceWarning(engine, ['candidate_served']);
  }
  // 4. 已提交版本（代数 > 0 时门槛要按当前的 Surge 版本判定，先读一次事实）。同一进程内重新 start 时沿用的资源服务可能还暂存着
  // 候选版本：一并撤回
  host.revertToCommitted();
  const committed = pointer.committed.generation;
  if (committed > 0) await engine.readBasicFacts().catch(() => undefined);
  await serveCommitted(engine, host, committed).catch(() => {
    host!.unload();
    engine.log('error', 'resource.regenerate_failed', { generation: committed });
  });
  // 5. 令牌可疑：令牌正确的请求也答 404
  if (readTokenSuspect(engine.kv) !== null) host.setRefuseToken(true);
  // 6. 监听之前审计：本服务停止期间占用端口的一方可能已让 Surge 下载了它提供的列表，或留下了本服务无法解释的资源错误
  let audited = false;
  if (line === 'ours') audited = await startupAudit(engine, host);
  // 7. 监听。启动审计没能进行（Surge 不可达）而已提交版本不能提供时推迟到 Surge 可达的对账（见 ResourceRuntime.listenDeferred）
  runtime.listenDeferred = line === 'ours' && !audited && host.served() === null;
  if (runtime.listenDeferred) engine.log('info', 'resource.listen_deferred');
  const listening = runtime.listenDeferred ? false : await listenResourceHost(engine);
  // 启动审计与监听之间没有其他 Surge 读写，间隙极短：监听成功时从这里起按“一直在监听”计（之后的审计据此解释本服务的失败答复）
  if (audited && listening) runtime.lastAudit = { epoch: runtime.listenEpoch, port: host.port(), listening: true, failures: servedFailureCount(host.failureCounters()) };
}

/** 启动审计（serving=false：只有连接被拒绝或超时能解释新的资源错误）。返回是否读到了外部资源（读不到时没有审计点）。 */
async function startupAudit(engine: Engine, host: ResourceHost): Promise<boolean> {
  const url = engine.resourceUrl();
  if (url === null) return false;
  const mark = host.auditMark();
  let list: SurgeExternalResource[];
  try {
    list = await engine.surge.listExternalResources();
  } catch {
    engine.log('warn', 'resource.audit_skipped', { phase: 'startup' });
    return false;
  }
  const found = findOurResource(list, url);
  // Surge 没有报告本服务的资源（尚未载入工作配置等）：没有可审计的下载，记下审计点
  if (found.resource === null) markAuditPoint(engine, host);
  else runAudit(engine, host, found.resource, { mark, serving: false, servedFailures: 0 });
  return true;
}

// ---------- 审计与检查 ----------

interface OurResource {
  resource: SurgeExternalResource | null;
  problem: 'resource_missing' | 'resource_ambiguous' | 'resource_foreign' | null;
}

/** Surge 报告的外部资源中本服务的那一项：恰好一个 locationHash 等于 sha256(地址)、配置中的远端节点组资源。 */
export function findOurResource(list: readonly SurgeExternalResource[], url: string): OurResource {
  const hash = resourceLocationHash(url);
  const mine = list.filter((r) => r.locationHash === hash);
  if (mine.length === 0) return { resource: null, problem: 'resource_missing' };
  if (mine.length > 1) return { resource: null, problem: 'resource_ambiguous' };
  const r = mine[0]!;
  if (r.type !== 'policy-group' || r.local !== false || r.fromModule !== null) return { resource: null, problem: 'resource_foreign' };
  return { resource: r, problem: null };
}

/** 资源错误（从未下载成功、Surge 报告 not_ready 或没有更新时间时为 'not_ready'）。 */
export function resourceErrorOf(r: SurgeExternalResource): string | null {
  if (r.error !== null) return r.error;
  return r.lastUpdatedAt === null ? 'not_ready' : null;
}

function snapshotOf(r: SurgeExternalResource, members: readonly string[] | null, selection: string | null): ResourceSnapshot {
  return { key: r.key, locationHash: r.locationHash, updatedAt: r.lastUpdatedAt, error: r.error, updating: r.updating, members, selection };
}

/** 记下审计点：此刻的监听状态与 404/503 计数（下一次审计据此判断期间是否一直在监听、本服务答复过多少失败）。 */
function markAuditPoint(engine: Engine, host: ResourceHost): void {
  const runtime = engine.resourceRuntime;
  runtime.lastAudit = { epoch: runtime.listenEpoch, port: host.port(), listening: host.listening(), failures: servedFailureCount(host.failureCounters()) };
}

/**
 * 审计一次（auditResource）：审计状态这一行存在而无法读取（损坏或缺少 windowSeq）时不审计，按无法解释处理——设 needsRefresh、
 * 返回 audit_state_unreadable，但不设 tokenSuspect，状态只在经确认的读回之后重新初始化；没有这一行时按快照初始化（只记日志）。
 * 无法解释的下载或错误设 tokenSuspect 与 needsRefresh。之后记下本次审计时的监听状态与失败计数。
 */
function runAudit(
  engine: Engine,
  host: ResourceHost,
  resource: SurgeExternalResource,
  input: { mark: number; serving: boolean; servedFailures: number },
): NodeResourceReason | null {
  const { kv } = engine;
  const runtime = engine.resourceRuntime;
  const recordAuditPoint = (): void => markAuditPoint(engine, host);
  const noteIssue = (issue: string, log: () => void): void => {
    if (runtime.auditIssue !== issue) log();
    runtime.auditIssue = issue;
  };
  const state = readAuditState(kv);
  if (state === null && kv.has(RESOURCE_KV_KEYS.auditState)) {
    requireRefresh(engine, readServedPointer(kv)?.committed.generation ?? 0, 'audit_state_unreadable');
    noteIssue('audit_state_unreadable', () => engine.log('warn', 'resource.audit_state_unreadable'));
    recordAuditPoint();
    return 'audit_state_unreadable';
  }
  const result = auditResource({
    snapshot: snapshotOf(resource, null, null),
    state,
    records: host.audit(),
    toleranceMs: engine.resourceAuditToleranceMs(),
    serving: input.serving,
    servedFailures: input.servedFailures,
    mark: input.mark,
  });
  recordAuditPoint();
  if (result.verdict === 'unexplained_fetch' || result.verdict === 'unexplained_error') {
    engine.repos.tx(() => {
      markTokenSuspect(engine, result.verdict);
      requireRefresh(engine, readServedPointer(kv)?.committed.generation ?? 0, result.verdict);
    });
    noteIssue(result.verdict, () => engine.log('warn', 'resource.audit_unexplained', { verdict: result.verdict }));
    return result.verdict;
  }
  runtime.auditIssue = null;
  writeAuditState(kv, result.nextState);
  if (result.verdict === 'initialized') engine.log('info', 'resource.audit_initialized');
  return null;
}

/** 已提交版本的节点名（不含 REJECT 与占位节点）；发布记录不在时为 null（无法比较，按不一致处理）。 */
export function committedNodeNames(engine: Engine): string[] | null {
  const pointer = readServedPointer(engine.kv);
  if (pointer === null) return null;
  const generation = pointer.committed.generation;
  if (generation === 0) return [];
  const d = engine.repos.deployments.get(generation);
  return d ? d.nodeManifest.map((m) => m.nodeName) : null;
}

/** SFE-ROUTE 的成员恰好是首位 REJECT 加上已提交版本的节点（没有节点时是占位节点 SFE-EMPTY），不重复、无多余。 */
export function membersMatchCommitted(members: readonly string[], committed: readonly string[] | null): boolean {
  if (committed === null || members.length === 0 || members[0]!.toUpperCase() !== 'REJECT') return false;
  const expected = committed.length === 0 ? [EMPTY_PLACEHOLDER_NODE] : committed;
  const rest = members.slice(1);
  return rest.length === expected.length && new Set(rest).size === rest.length && expected.every((n) => rest.includes(n));
}

/** 有发布操作正在写入或回滚（DEPLOYING/ROLLING_BACK）：期间组成员可能是候选版本，不与已提交版本比较。 */
function publishWriting(engine: Engine): boolean {
  return engine.repos.operations
    .listByStatus(['running'], { kinds: [...PUBLISH_KINDS] })
    .some((op) => op.phase === 'DEPLOYING' || op.phase === 'ROLLING_BACK');
}

export interface NodeResourceCheck {
  /** 工作配置的节点组定义（检查时读到的）。 */
  line: NodeResourceLine | null;
  /** 需要设 node_resource_unverified 的原因；空数组表示这次检查没有发现问题。 */
  reasons: NodeResourceReason[];
  /** 本应用资源的资源错误（含 not_ready）；没有读到为 undefined。 */
  resourceError: string | null | undefined;
  /** 组成员与已提交版本是否一致；没有比较为 null。 */
  membersMatch: boolean | null;
}

export interface NodeResourceCheckOptions {
  /** Surge 可达、当前配置是工作配置时才读 Surge（审计、成员与节点参数）。 */
  reachable: boolean;
  onWorkingProfile: boolean | null;
  /** 要核对参数的节点（对账：路由不是普通模式时的 SFE-ROUTE 选择；切换前：目标节点）；null/undefined 不核对。 */
  detailNode?: string | null;
}

/**
 * 节点资源检查（只读 Surge，从不写）：只在工作配置引用本机资源服务形式的地址时检查。顺序：令牌（资源服务）→ 地址是否是本服务
 * 当前的 → 重试监听 → 令牌可疑 → 提供的内容（Surge 可达时）→ 审计 → 组成员与已提交版本（没有发布在写入或回滚时）→ 节点参数。
 * 对账与切换前检查共用；设警告由调用方负责。
 */
export async function checkNodeResource(engine: Engine, opts: NodeResourceCheckOptions): Promise<NodeResourceCheck> {
  const out: NodeResourceCheck = { line: null, reasons: [], resourceError: undefined, membersMatch: null };
  const line = await readGroupLine(engine);
  out.line = line;
  if (!referencesLoopback(line)) return out;
  const host = engine.resource;
  if (host === null) {
    out.reasons.push('token_unavailable');
    return out;
  }
  if (line !== 'ours') {
    out.reasons.push('resource_url_changed');
    return out;
  }
  const runtime = engine.resourceRuntime;
  // 门槛按刚读到的 Surge 版本判定：Surge 不可达（版本未知）时保持当前提供的内容，不据此停止或恢复提供
  if (opts.reachable) await maintainServed(engine, host).catch(() => undefined);
  // 启动时推迟的监听：Surge 可达时（门槛已按读到的版本重新判定）监听，随即在下面审计；Surge 仍不可达时继续推迟（不算未监听）
  const deferred = runtime.listenDeferred && !opts.reachable;
  if (!host.listening() && !deferred) await listenResourceHost(engine);
  if (host.listening()) runtime.listenDeferred = false;
  else if (!deferred) out.reasons.push('not_listening');
  if (readTokenSuspect(engine.kv) !== null) {
    host.setRefuseToken(true);
    out.reasons.push('token_suspect');
  }
  const url = engine.resourceUrl();
  if (!opts.reachable || opts.onWorkingProfile !== true || url === null) return out;
  // 审计：读快照之前取 mark；本服务自上次审计以来一直在已设置的端口监听时，期间的失败答复只可能来自本服务
  const last = runtime.lastAudit;
  const serving = last !== null && last.listening && host.listening() && last.epoch === runtime.listenEpoch && last.port === host.port();
  const failuresNow = servedFailureCount(host.failureCounters());
  const mark = host.auditMark();
  let list: SurgeExternalResource[];
  try {
    list = await engine.surge.listExternalResources();
  } catch {
    // 读不到外部资源：无法核对，这次不下结论（下一次对账再读）
    return out;
  }
  const found = findOurResource(list, url);
  if (found.resource === null) {
    out.reasons.push(found.problem!);
    markAuditPoint(engine, host);
  } else {
    out.resourceError = resourceErrorOf(found.resource);
    const verdict = runAudit(engine, host, found.resource, { mark, serving, servedFailures: serving ? failuresNow - last!.failures : 0 });
    if (verdict !== null) out.reasons.push(verdict);
  }
  if (!publishWriting(engine)) {
    try {
      const members = await engine.surge.getGroupMembers(ROUTE_GROUP_NAME);
      out.membersMatch = membersMatchCommitted(members, committedNodeNames(engine));
      if (!out.membersMatch) out.reasons.push('members_mismatch');
    } catch {
      // 读不到组成员：这次不比较
    }
  }
  const node = opts.detailNode;
  if (typeof node === 'string' && node.toUpperCase() !== 'REJECT' && node !== EMPTY_PLACEHOLDER_NODE && (await nodeDetailMismatch(engine, node))) {
    out.reasons.push('node_detail_mismatch');
  }
  return out;
}

/**
 * 节点参数核对（getPolicyDetail 已映射时）：Surge 读回的服务器、端口与前置和该节点名对应的代理版本不同时为 true。不是本应用的
 * 节点名、读取失败或原语不可用时为 false（不下结论；成员检查负责名称）。
 */
async function nodeDetailMismatch(engine: Engine, nodeName: string): Promise<boolean> {
  const mech = engine.surge.mechanism();
  if (!mech.getPolicyDetail || mech.getPolicyDetail === 'unavailable') return false;
  const rev = engine.repos.proxyRevisions.byNodeName(nodeName);
  if (!rev) return false;
  const front = engine.repos.frontProxies.get(rev.frontProxyId);
  let detail;
  try {
    detail = await engine.surge.getPolicyDetail(nodeName);
  } catch {
    return false;
  }
  return detail.server !== rev.host || detail.port !== rev.port || detail.underlyingProxy !== (front?.surgeName ?? null);
}

// ---------- 警告 ----------

/**
 * 在对账之外设 node_resource_unverified（切换前检查、启动时撤回的候选版本）：使用中的已验证路由改为 attention（与对账相同）；
 * 过渡中的路由由负责它的操作处理。返回是否新设。
 */
export function raiseNodeResourceWarning(engine: Engine, reasons: readonly NodeResourceReason[]): boolean {
  const { repos } = engine;
  const route = repos.tx(() => {
    const r = repos.routeState.get();
    if (r.warnings.includes(NODE_RESOURCE_WARNING)) return null;
    const toAttention = r.phase === 'active_verified' || r.phase === 'external_change';
    repos.routeState.update({ warnings: [...r.warnings, NODE_RESOURCE_WARNING], ...(toAttention ? { phase: 'attention' as const } : {}) });
    return r;
  });
  if (route === null) return false;
  engine.log('warn', 'resource.unverified', { reasons: [...new Set(reasons)] });
  engine.emit({ route: true, environments: route.activeEnvironmentId ? [route.activeEnvironmentId] : [] });
  return true;
}

/**
 * 切换前（激活与活动环境发布进入切换的第 2 步）：节点资源未确认的警告已设、或检查发现问题（含目标节点的参数核对）时返回
 * 失败（并设警告），路由未改变；否则 null。从不写 Surge。
 */
export async function nodeResourceSwitchFailure(engine: Engine, nodeName: string): Promise<ApiErrorBody | null> {
  const failure = (reasons: readonly NodeResourceReason[]): ApiErrorBody => ({
    code: 'NODE_NOT_DEPLOYED',
    message: `激活失败：节点资源未确认（Surge 中的节点无法证明来自本机资源服务的已提交版本${reasons.length > 0 ? `：${nodeResourceReasonText(reasons)}` : ''}），路由未改变；需要经确认的节点资源发布${reasons.includes('token_suspect') ? '（读取令牌可能已泄露时先在维护中重新合并并轮换资源地址）' : ''}，或进入普通模式`,
    details: { reason: NODE_RESOURCE_WARNING, causes: [...new Set(reasons)] },
  });
  if (engine.repos.routeState.get().warnings.includes(NODE_RESOURCE_WARNING)) return failure(readTokenSuspect(engine.kv) !== null ? ['token_suspect'] : []);
  const check = await checkNodeResource(engine, { reachable: engine.facts.reachable, onWorkingProfile: engine.facts.onWorkingProfile, detailNode: nodeName });
  if (check.reasons.length === 0) return null;
  raiseNodeResourceWarning(engine, check.reasons);
  maybeEnqueueSystemRefresh(engine, check);
  return failure(check.reasons);
}

// ---------- 系统强制刷新 ----------

/** 需要排入系统强制刷新的原因；不需要时为 null。只在工作配置恰好指向本服务当前地址、资源服务存在时。 */
function refreshReason(engine: Engine, check: Pick<NodeResourceCheck, 'resourceError' | 'membersMatch'> | null): string | null {
  if (engine.resource === null || engine.resourceRuntime.line !== 'ours') return null;
  if (readNeedsRefresh(engine.kv) !== null) return 'needs_refresh';
  if (check !== null && check.resourceError !== undefined && check.resourceError !== null) return 'resource_error';
  if (check !== null && check.membersMatch === false) return 'members_mismatch';
  return null;
}

/**
 * 需要时排入一次系统强制刷新发布（forceRefresh，发起方 service，没有目标环境：只重新提供并核对已部署的节点，从不顺带部署
 * 待部署的修改）：没有进行中（排队、执行或等待）的发布、也没有尚未经确认读回
 * 清除的系统刷新（SYSTEM_REFRESH_KEY 指向的操作仍在）时。返回排入的操作；不需要或已有时为 null。发布门槛不满足时它停泊。
 */
export function maybeEnqueueSystemRefresh(engine: Engine, check: Pick<NodeResourceCheck, 'resourceError' | 'membersMatch'> | null = null): OperationRecord | null {
  const reason = refreshReason(engine, check);
  if (reason === null) return null;
  const { repos } = engine;
  const op = repos.tx(() => {
    if (repos.operations.listByStatus([...OPEN_STATUSES], { kinds: [...PUBLISH_KINDS] }).length > 0) return null;
    const rec = engine.kv.get<{ operationId?: unknown }>(SYSTEM_REFRESH_KEY);
    if (rec !== null && typeof rec.operationId === 'string' && repos.operations.get(rec.operationId) !== null) return null;
    const inserted = repos.operations.insert({
      id: engine.ids.next('op'),
      requestId: `resource-refresh:${engine.ids.token(16)}`,
      requestDigest: 'service',
      kind: 'deploy.publish',
      initiatorKind: 'service',
      phase: 'SAVED',
      status: 'queued',
      // 没有目标环境（environmentIds 为空）：只重新提供并核对已部署的节点；待部署的修改仍需要显式的发布请求（停泊是终态）
      payload: { environmentIds: [], forceRefresh: true, systemRefresh: reason },
    });
    repos.operations.appendStep(
      inserted.id,
      'SAVED',
      '本机资源服务：Surge 中的节点资源需要与已提交版本重新核对，排入一次节点资源发布（只对本应用的资源单 key 更新并读回；发布门槛不满足时保持待部署）',
    );
    repos.outbox.enqueue(inserted.id, null, engine.now());
    engine.kv.set(SYSTEM_REFRESH_KEY, { operationId: inserted.id, reason, at: engine.nowIso() });
    return inserted;
  });
  if (op === null) return null;
  engine.log('info', 'resource.refresh_enqueued', { reason });
  engine.emit({ operations: [op.id] });
  engine.kick();
  return op;
}

// ---------- 确认（发布与回滚的读回之后） ----------

export interface NodeResourceConfirmation {
  /** 读回确认的、已提交的配置代数（指针的 committed 必须已是它）。 */
  generation: number;
  /** 与读回的更新时间匹配的完整 200 的序号（audit.ts matchAuditRecord）。 */
  matchedSeq: number;
  /** 读回（after）的快照：更新时间与资源错误成为新的审计基线。 */
  snapshot: Pick<ResourceSnapshot, 'updatedAt' | 'error'>;
  /** 读回完整（或被覆盖声明覆盖）时清除 needsRefresh 并重新允许系统刷新；读回不完整而未覆盖时两者都保留。 */
  clearNeedsRefresh: boolean;
}

/**
 * 经确认的读回之后（发布 T2、回滚确认，handlers/publish.ts）：在一个事务中前移审计状态（损坏的状态在这里重新初始化）、按需
 * 清除 needsRefresh 与系统刷新记录（重新允许自动排入），并清除 node_resource_unverified——令牌可疑或资源服务不在监听时保留（对账会
 * 重新设它）。可以在调用方的事务中调用（嵌套为 SAVEPOINT）。tokenSuspect 不变（只能由轮换资源地址清除）。路由仍需要现有的
 * 重新核验或检测流程才能回到已验证。返回警告是否被清除。
 */
export function confirmNodeResource(engine: Engine, c: NodeResourceConfirmation): { warningCleared: boolean } {
  const { repos, kv } = engine;
  if (!Number.isSafeInteger(c.matchedSeq) || c.matchedSeq < 1) throw new SfeError('INTERNAL', '服务内部错误：节点资源读回的审计记录不正确');
  const updatedAt = c.snapshot.updatedAt;
  if (!(updatedAt instanceof Date) || !Number.isFinite(updatedAt.getTime())) throw new SfeError('INTERNAL', '服务内部错误：节点资源读回的更新时间不正确');
  const host = engine.resource;
  const keepWarning = readTokenSuspect(kv) !== null || host === null || !host.listening();
  const result = repos.tx(() => {
    const pointer = readServedPointer(kv);
    if (pointer === null || pointer.committed.generation !== c.generation) throw new SfeError('INTERNAL', '服务内部错误：确认的节点资源代数不是已提交版本');
    const prev = readAuditState(kv);
    writeAuditState(kv, {
      verifiedUpdatedAt: updatedAt.toISOString(),
      verifiedError: c.snapshot.error,
      auditedSeq: Math.max(prev?.auditedSeq ?? 0, c.matchedSeq),
      windowSeq: Math.max(prev?.windowSeq ?? 0, c.matchedSeq),
    });
    // 只有清除了 needsRefresh（读回完整或被覆盖）才重新允许自动排入：读回不完整而保留刷新要求时，系统刷新不会被反复排入
    if (c.clearNeedsRefresh) {
      writeNeedsRefresh(kv, null);
      kv.delete(SYSTEM_REFRESH_KEY);
    }
    const route = repos.routeState.get();
    if (keepWarning || !route.warnings.includes(NODE_RESOURCE_WARNING)) return { warningCleared: false, route };
    repos.routeState.update({ warnings: route.warnings.filter((w) => w !== NODE_RESOURCE_WARNING) });
    return { warningCleared: true, route };
  });
  if (host !== null) markAuditPoint(engine, host);
  engine.log('info', 'resource.confirmed', { generation: c.generation, warningCleared: result.warningCleared });
  engine.emit({ route: result.warningCleared, surge: true, environments: result.warningCleared && result.route.activeEnvironmentId ? [result.route.activeEnvironmentId] : [] });
  return { warningCleared: result.warningCleared };
}

// ---------- 视图 ----------

/** 本机资源服务的状态视图（不含令牌、地址或端口）；尚未初始化固定工作配置时为 null。 */
export function nodeResourceStatus(engine: Engine): NodeResourceStatusView | null {
  if (!engine.workingProfile()) return null;
  const host = engine.resource;
  const line = engine.resourceRuntime.line;
  const state: NodeResourceStatusView['state'] =
    host === null ? 'token_unavailable' : line === 'legacy' ? 'legacy_line' : line !== 'ours' ? 'not_installed' : host.listening() ? 'serving' : 'not_listening';
  return { state, tokenSuspect: readTokenSuspect(engine.kv) !== null, needsRefresh: readNeedsRefresh(engine.kv) !== null };
}

/** 空闲且普通模式时周期对账是否仍要运行（工作配置引用本机资源服务：重试监听与审计）。 */
export function nodeResourceWatched(engine: Engine): boolean {
  return referencesLoopback(engine.resourceRuntime.line);
}
