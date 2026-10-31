// 本机资源的审计与发布读回（纯函数，与 P0 共用）。Surge 不能与本服务互相认证：本服务停止期间占用端口的一方会拿到读取令牌、
// 并能让 Surge 载入它提供的列表。这里只做事后核对——Surge 报告的更新时间（updatedAt）必须对应本服务记下的一次完整的 200
// 响应，资源错误必须能由本服务在审计窗口内实际产生的失败答复或“连接被拒绝或超时”解释；否则按无法解释的下载或错误处理（引擎
// 据此设 tokenSuspect 与路由警告）。占用端口的一方让 Surge 等到超时同样无法被发现：只能事后发现，不能事先阻止。
// 退出码 0、success 与 ready=true 都不当作发布成功：读回逐项核对资源标识、地址摘要、错误、更新状态、组成员与选择。

import { createHash } from 'node:crypto';
import { EMPTY_PLACEHOLDER_NODE } from '@sfe/contract';
import type { ResourceAuditRecord } from './host.js';

/** 从 Surge 读到的本应用资源与 SFE-ROUTE 的状态。locationHash：parse-output 对 Surge 报告的原始地址计算的 SHA-256（十六进制）。 */
export interface ResourceSnapshot {
  key: string;
  locationHash: string | null;
  updatedAt: Date | null;
  error: string | null;
  updating: boolean | null;
  members: readonly string[] | null;
  selection: string | null;
}

/** 持久的审计状态（resource:auditState）：上次确认过的更新时间与资源错误，以及已核对到的审计记录序号。 */
export interface ResourceAuditState {
  verifiedUpdatedAt: string | null;
  verifiedError: string | null;
  /** 已与更新时间匹配到的记录序号：只在匹配时前移（尚未被匹配的完整 200 之后仍可以解释新的更新时间）。 */
  auditedSeq: number;
  /**
   * 审计窗口的起点：序号不大于它的记录不再解释资源错误。每次结论为 ok 的审计都前移到读快照之前已有的最后一条记录，所以
   * 一次没有写完的 200 最多解释它之后的一次审计（读快照期间产生的记录留到下一次），陈旧的记录不能解释之后的任何错误。
   */
  windowSeq: number;
}
export type AuditState = ResourceAuditState;

export type ResourceAuditVerdict = 'ok' | 'unexplained_fetch' | 'unexplained_error' | 'initialized';

/** 审计记录时间与 Surge 更新时间的缺省容差（毫秒）。TODO(P0)：实测；同时记录 updatedAt 的分辨率，以及重开 Surge 是否不下载也改写 updatedAt。 */
export const DEFAULT_RESOURCE_AUDIT_TOLERANCE_MS = 5000;
/** 记录时间最多可以比 updatedAt 晚这么多（两边时钟与分辨率）。 */
export const RESOURCE_AUDIT_LATE_SLACK_MS = 1000;

/** 资源地址的摘要：与 parse-output 的 locationHash 比较（不带密钥：地址中的令牌有 256 位，摘要不能用来猜测）。 */
export function resourceLocationHash(url: string): string {
  return createHash('sha256').update(url, 'utf8').digest('hex');
}

/**
 * 资源错误是否表示连接被拒绝或超时（服务未运行或没有答复时的预期结果）：NSURLErrorDomain -1004/-1001，以及系统的本地化
 * 文本（无法连接服务器、请求超时、could not connect to the server、timed out）。
 */
export function isConnectionRefusedOrTimeout(error: string): boolean {
  if (/NSURLErrorDomain/i.test(error) && /(^|[^0-9])-100[14]([^0-9]|$)/.test(error)) return true;
  return /无法连接(到)?服务器|请求超时|could not connect to the server|timed out/i.test(error);
}

function tolerance(ms: number): number {
  return Number.isFinite(ms) && ms >= 0 ? ms : DEFAULT_RESOURCE_AUDIT_TOLERANCE_MS;
}

function validTime(d: Date | null): d is Date {
  return d instanceof Date && Number.isFinite(d.getTime());
}

/** 更新时间的持久写法；无法解析的时间写作 'invalid'（与任何确认过的时间都不相等）。 */
function isoOf(d: Date | null): string | null {
  if (d === null) return null;
  return validTime(d) ? d.toISOString() : 'invalid';
}

/**
 * 与更新时间 U 对应的完整 200：序号不小于 minSeq、（给定时）代数相同、写出时间在 [U − tolerance, U + 1 秒] 内；多条时取序号
 * 最大的（Surge 重试时最后一次下载决定 U）。
 */
export function matchAuditRecord(
  records: readonly ResourceAuditRecord[],
  updatedAt: Date,
  toleranceMs: number,
  minSeq: number,
  generation: number | null = null,
): ResourceAuditRecord | null {
  if (!validTime(updatedAt)) return null;
  const u = updatedAt.getTime();
  const lo = u - tolerance(toleranceMs);
  const hi = u + RESOURCE_AUDIT_LATE_SLACK_MS;
  let best: ResourceAuditRecord | null = null;
  for (const r of records) {
    if (!r.complete || r.seq < minSeq) continue;
    if (generation !== null && r.generation !== generation) continue;
    const t = r.at instanceof Date ? r.at.getTime() : Number.NaN;
    if (!Number.isFinite(t) || t < lo || t > hi) continue;
    if (best === null || r.seq > best.seq) best = r;
  }
  return best;
}

export interface AuditResourceInput {
  snapshot: ResourceSnapshot;
  state: ResourceAuditState | null;
  /** host.audit()：在读取快照之后取（读快照期间完成的下载也要能与更新时间匹配）。 */
  records: readonly ResourceAuditRecord[];
  toleranceMs: number;
  /**
   * 本服务自上次审计以来一直在已配置端口监听：期间 Surge 的每次下载只可能由本服务答复，资源错误只能来自本服务的失败答复
   * （servedFailures，或窗口内没有写完的 200）。启动时（监听之前）或监听失败过时为 false：端口可能被他人占用，这时只有
   * “连接被拒绝或超时”能解释，没有写完的 200 与失败计数一律不算。
   */
  serving: boolean;
  /**
   * 自上次审计以来本服务答复的 404 与 503 次数（引擎按 host.failureCounters() 的增量得出，见 servedFailureCount）。只在
   * serving 为 true 时使用；不是有限的非负整数时按 0 处理。
   */
  servedFailures: number;
  /**
   * 读取快照之前取的 host.auditMark()：结论为 ok 时窗口起点前移到 mark − 1（读快照之前已有的记录不再解释之后的错误）。
   * 不是正整数时按全部记录处理（fail closed：之后的错误不再由这些记录解释）。
   */
  mark: number;
}

/** failureCounters() 中不是一次答复的计数（200 完整写出之后记录失败：内容已经送出）。 */
const NON_RESPONSE_COUNTERS: ReadonlySet<string> = new Set(['audit_complete_failed']);

/** host.failureCounters() 中 404 与 503 答复的总数（引擎在两次审计之间取差，作为 servedFailures）。 */
export function servedFailureCount(counters: Readonly<Record<string, number>>): number {
  let total = 0;
  for (const [key, n] of Object.entries(counters)) {
    if (NON_RESPONSE_COUNTERS.has(key) || !Number.isSafeInteger(n) || n < 0) continue;
    total += n;
  }
  return total;
}

export interface AuditResourceResult {
  verdict: ResourceAuditVerdict;
  matchedSeq: number | null;
  /** 调用方持久保存（resource:auditState）。无法解释时不前移：同一下载或错误在之后的审计中仍会报告，直到轮换或确认的读回重置。 */
  nextState: ResourceAuditState;
}

/**
 * 新的资源错误能否由本服务解释：连接被拒绝或超时总能解释；其余只在本服务一直监听（serving）时，由窗口内本服务实际答复过的
 * 404/503 或没有写完的 200（序号大于 windowSeq）解释。本服务没有一直监听时，任何其他错误（HTTP 状态、空内容、无法解析、
 * 连接中断）都可能来自占用端口的一方。
 */
function errorExplained(input: AuditResourceInput, error: string, state: ResourceAuditState): boolean {
  if (isConnectionRefusedOrTimeout(error)) return true;
  if (input.serving !== true) return false;
  const failures = input.servedFailures;
  if (Number.isSafeInteger(failures) && failures > 0) return true;
  return input.records.some((r) => !r.complete && r.seq > state.windowSeq);
}

/**
 * 审计一次资源状态：
 * - 没有审计状态：按快照初始化，结论 initialized（只记日志，从不报警）；
 * - updatedAt 与确认过的不同（且不为 null）：必须有序号大于 auditedSeq、写出时间在窗口内的完整 200，否则 unexplained_fetch；
 * - 资源错误变成新的非空值：除非是连接被拒绝或超时，或本服务一直在监听且窗口内答复过 404/503 或有没有写完的 200（中途
 *   断开），否则 unexplained_error。
 * 结论为 ok 时窗口起点前移（见 ResourceAuditState.windowSeq）；无法解释时状态不变。
 */
export function auditResource(input: AuditResourceInput): AuditResourceResult {
  const { snapshot, state, records } = input;
  const u = snapshot.updatedAt;
  const uIso = isoOf(u);
  const maxSeq = records.reduce((m, r) => Math.max(m, r.seq), 0);
  if (state === null) {
    return {
      verdict: 'initialized',
      matchedSeq: null,
      nextState: { verifiedUpdatedAt: uIso, verifiedError: snapshot.error, auditedSeq: maxSeq, windowSeq: maxSeq },
    };
  }
  let matched: ResourceAuditRecord | null = null;
  if (uIso !== state.verifiedUpdatedAt && u !== null) {
    matched = matchAuditRecord(records, u, input.toleranceMs, state.auditedSeq + 1);
    if (matched === null) return { verdict: 'unexplained_fetch', matchedSeq: null, nextState: state };
  }
  if (snapshot.error !== null && snapshot.error !== state.verifiedError && !errorExplained(input, snapshot.error, state)) {
    return { verdict: 'unexplained_error', matchedSeq: matched?.seq ?? null, nextState: state };
  }
  const windowEnd = Number.isSafeInteger(input.mark) && input.mark >= 1 ? input.mark - 1 : maxSeq;
  return {
    verdict: 'ok',
    matchedSeq: matched?.seq ?? null,
    nextState: {
      verifiedUpdatedAt: uIso,
      verifiedError: snapshot.error,
      auditedSeq: Math.max(state.auditedSeq, matched?.seq ?? 0),
      windowSeq: Math.max(state.windowSeq, windowEnd),
    },
  };
}

/** 单个节点的参数（getPolicyDetail 读回与按代理版本期望的值）。 */
export interface ResourceNodeDetail {
  server: string | null;
  port: number | null;
  underlyingProxy: string | null;
}

export interface ResourceReadbackDetails {
  /** 按节点名的期望参数（缺少某个节点的期望值时只能是 partial）。 */
  expected: ReadonlyMap<string, ResourceNodeDetail>;
  /** 按节点名读回的参数；读取失败为 null 或缺省（只能是 partial）。 */
  actual: ReadonlyMap<string, ResourceNodeDetail | null>;
}

export interface AssessResourceReadbackInput {
  /** 本服务的资源地址（含令牌，只在内存中用于计算摘要）。 */
  url: string;
  /** 更新之前读到的状态。 */
  before: ResourceSnapshot;
  /** 等 Surge 结束更新、稳定延时之后读到的状态。 */
  after: ResourceSnapshot;
  /** 稳定延时之后再读一次。 */
  afterRepeat: ResourceSnapshot;
  /** 期望的节点名（不含 REJECT）；为空时期望只含占位节点 SFE-EMPTY。 */
  expectedMembers: readonly string[];
  selectionBefore: string | null;
  records: readonly ResourceAuditRecord[];
  /** 暂存（或回滚重新提供）之前取的 auditMark()：只有序号不小于它的记录算作这一次的下载。 */
  mark: number;
  expectedGeneration: number;
  toleranceMs: number;
  /** 节点参数读回；没有（getPolicyDetail 不可用）时读回最多是 partial。 */
  details?: ResourceReadbackDetails | null;
}

export interface ResourceReadbackAssessment {
  ok: boolean;
  level: 'full' | 'partial';
  failed: string[];
}

function sameMembers(a: readonly string[] | null, b: readonly string[] | null): boolean {
  if (a === null || b === null) return a === b;
  return a.length === b.length && a.every((m, i) => m === b[i]);
}

function sameTime(a: Date | null, b: Date | null): boolean {
  return isoOf(a) === isoOf(b);
}

/**
 * 发布（或回滚）之后的严格读回，全部满足才算成功：资源标识不变；地址摘要等于本服务地址的摘要；没有资源错误；不在更新中；
 * 两次读取的成员与更新时间相同；更新时间不早于更新之前，且对应一条序号不小于 mark、期望代数的完整 200；成员恰好是首位 REJECT
 * 加上期望的节点（不重复、无多余）；选择不变；给出节点参数时逐个核对服务器、端口与前置。
 * failed 中的代码：resource_key、location、resource_error、resource_updating、unstable、updated_at、fetch、first_member、
 * members、selection、detail:<节点名>。
 */
export function assessResourceReadback(input: AssessResourceReadbackInput): ResourceReadbackAssessment {
  const failed: string[] = [];
  const fail = (code: string): void => {
    if (!failed.includes(code)) failed.push(code);
  };
  const { before, after, afterRepeat } = input;
  const hash = resourceLocationHash(input.url);
  for (const s of [after, afterRepeat]) {
    if (s.key !== before.key) fail('resource_key');
    if (s.locationHash !== hash) fail('location');
    if (s.error !== null) fail('resource_error');
    if (s.updating === true) fail('resource_updating');
  }
  if (!sameMembers(after.members, afterRepeat.members) || !sameTime(after.updatedAt, afterRepeat.updatedAt)) fail('unstable');
  const u = after.updatedAt;
  if (!validTime(u)) {
    fail('updated_at');
    fail('fetch');
  } else {
    if (before.updatedAt !== null && (!validTime(before.updatedAt) || u.getTime() < before.updatedAt.getTime())) fail('updated_at');
    if (matchAuditRecord(input.records, u, input.toleranceMs, input.mark, input.expectedGeneration) === null) fail('fetch');
  }
  const expected = input.expectedMembers.length === 0 ? [EMPTY_PLACEHOLDER_NODE] : [...input.expectedMembers];
  const members = after.members;
  if (members === null || members.length === 0) {
    fail('members');
  } else {
    if (members[0]!.toUpperCase() !== 'REJECT') fail('first_member');
    const rest = members.slice(1);
    if (rest.length !== expected.length || new Set(rest).size !== rest.length || !expected.every((n) => rest.includes(n))) fail('members');
  }
  if (after.selection !== input.selectionBefore || afterRepeat.selection !== input.selectionBefore) fail('selection');
  let level: 'full' | 'partial' = 'partial';
  const details = input.details ?? null;
  if (details !== null) {
    let complete = true;
    for (const name of expected) {
      // 占位节点没有服务器参数
      if (name === EMPTY_PLACEHOLDER_NODE) continue;
      const want = details.expected.get(name);
      const got = details.actual.get(name);
      if (want === undefined || got === undefined || got === null) {
        complete = false;
        continue;
      }
      if (got.server !== want.server || got.port !== want.port || got.underlyingProxy !== want.underlyingProxy) fail(`detail:${name}`);
    }
    if (complete) level = 'full';
  }
  return { ok: failed.length === 0, level, failed };
}
