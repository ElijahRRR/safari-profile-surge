// 节点资源发布（docs/ARCHITECTURE.md §6.2，D10）。自动与手动发布要求完全相同的门槛；门槛不足停在 WAITING_DEPLOYMENT（没有任何
// “确认后强制发布”的开关）。从不重载配置、更新全部外部资源或切换配置。
//
// SFE-ROUTE 的节点列表由本机资源服务（engine/node-resource.ts、resource/host.ts）经
// http://127.0.0.1:<端口>/<读取令牌>/sfe-nodes.list 提供（固定工作配置设计第 83 行“受保护的回环资源服务”）。发布 =
//   1. 门槛：发布门槛的六项记录、loopback_resource_update 记录中实测时的自动重载条件、读回与更新所需的原语、资源服务存在且在
//      已设置的端口监听、令牌不可疑、受管理 group 段恰好是 loopbackGroupBlockLines(地址)（仍是本地 sfe-nodes.list 的旧定义时
//      停泊，需要重新合并）、资源 key 能经当前机制安全更新（CLI 不接受可能含令牌的 key）；
//   2. 找到本应用的资源（恰好一个 locationHash 等于地址摘要的配置内远端节点组资源），等 Surge 不再报告 updating，读更新之前的
//      状态（资源、组成员与选择）——这些都在“没有修改”的捷径之前；
//   3. 生成候选并严格校验（每一行恰好解析为它的清单条目、名称唯一且不是保留名、没有 '[' 开头的行、不超过 1 MiB、没有节点时
//      只含占位行），候选 --check 经 rewriteLoopbackForCheck（从不接触本机资源服务）；
//   4. 一个事务记下候选发布、候选指针与 needsRefresh，取审计序号 mark，资源服务暂存候选版本；
//   5. 只对本应用的 key 执行恰好一次 updateExternalResource（从不 all、从不重放结果不明的更新）；skipped、出错与超时都按更新
//      失败处理（仍读取状态，用于回滚判断）；
//   6. 有限等待 Surge 不再 updating → 稳定延迟 → 读回两次（加上可用时的逐节点参数）→ assessResourceReadback：结果必须对应一条
//      序号不小于 mark、候选代数的完整 200（退出码 0、success 与 ready=true 都不当作成功）；
//   7. 成功：一个事务提交发布记录、指针与审计状态（confirmNodeResource），之后资源服务才提交候选版本，再按原有方式结算；
//   8. 其他任何结局（含提交事务失败、意外异常）：回滚——先撤回候选指针与资源服务的候选版本，再按 Surge 是否可能已载入候选决定
//      是否单 key 更新一次并按已提交版本读回；无法确认时 BLOCKED_NEEDS_ATTENTION、路由需要处理、node_resource_unverified。
// 读回不完整时只有 P0 记录覆盖未核对字段才算可接受（verified），否则停在 published，needsRefresh 保留到下一次发布。
// 崩溃恢复从不重放：启动时撤回候选指针（needsRefresh 保留），recoverPublish 结束操作并按需排入一次系统强制刷新发布。
// 进入普通模式永远可用：第一次写入 Surge（暂存候选之后的单 key 更新）之前，有排队的普通模式时发布让出（操作放回排队，普通模式
// 先执行，之后重新发布；从不停泊或失败）。已发出更新之后不再让出：Surge 可能已载入候选，发布必须先回滚。TODO(P0)：写入之后的
// 最长耗时是一次更新加等待，失败时再加回滚的一次更新加等待（按 resourceUpdateWait 与适配器的更新超时），由 P0 实测计时。
// 令牌、地址与端口从不进入操作说明、错误或日志；资源 key 也不写进说明。

import { readFile } from 'node:fs/promises';
import {
  CAPABILITY_GATES,
  EMPTY_PLACEHOLDER_LINE,
  EMPTY_PLACEHOLDER_NODE,
  ENTRY_RULESET_FILES,
  ROUTE_GROUP_NAME,
  SfeError,
  type ApiErrorBody,
  type CapabilityKey,
  type OperationPhase,
  type OperationStatus,
} from '@sfe/contract';
import type { SurgeExternalResource } from '../../ports.js';
import type { DeploymentRecord, FrontProxyRecord, NodeManifestEntry, OperationRecord, ProxyRevisionRecord } from '../../db/index.js';
import { isPublishKind, isRouteOperation, payloadOf, routeTargetOf, type PublishTarget } from '../../domain/operations.js';
import type { PublishTargetOutcome, PublishTargetResult } from '../../domain/views.js';
import {
  RESOURCE_MAX_BYTES,
  assessResourceReadback,
  clearCandidatePointer,
  commitCandidatePointer,
  isConnectionRefusedOrTimeout,
  servedFailureCount,
  matchAuditRecord,
  readAuditState,
  readNeedsRefresh,
  readServedPointer,
  readTokenSuspect,
  setCandidatePointer,
  writeNeedsRefresh,
  type ResourceHost,
  type ResourceNeedsRefresh,
  type ResourceNodeDetail,
  type ResourceReadbackDetails,
  type ResourceSnapshot,
} from '../../resource/index.js';
import { resourceBody, rewriteLoopbackForCheck } from '../../surge/generate.js';
import { parseProxyLine } from '../../surge/proxy-line.js';
import { resourceUpdateRoute } from '../../surge/resource-key.js';
import { BUILTIN_POLICIES, isCommentLine } from '../../surge/rules.js';
import { describeOutsideChanges, entryBlockIsFirstRule, findForeignSfeObjects, foreignSfePolicyNames, parseProfile } from '../../surge/profile.js';
import { capabilityError, profileMatches, readRuntimeSample, surgeRestartedBetween, type Engine, type SurgeRuntimeSample } from '../context.js';
import { readbackCovered } from '../capabilities.js';
import { checkCandidate } from '../candidate.js';
import {
  NODE_RESOURCE_WARNING,
  applyNodeResourceConfirmation,
  auditForPublish,
  classifyGroupLine,
  committedNodeNames,
  confirmNodeResource,
  enqueueSystemRefreshAfterCrash,
  findOurResource,
  flagUnexplainedFetch,
  membersMatchCommitted,
  raiseNodeResourceWarning,
  type NodeResourceConfirmed,
} from '../node-resource.js';
import { checkSegments } from '../ownership.js';
import { entryKey, generateResource, manifestMatches, type ResourceEntry } from '../resource.js';
import { hmacHex } from '../../util/keyed-digest.js';
import { enterWaitingRoute, isActiveEnvironment } from './route.js';
import { recordPreflight } from './probes.js';

interface Unit {
  op: OperationRecord;
  target: PublishTarget;
  outcome: PublishTargetOutcome | null;
  error: ApiErrorBody | null;
}

interface Batch {
  primary: OperationRecord;
  ops: OperationRecord[];
  units: Unit[];
}

const UNCHECKED_DETAIL_FIELDS = ['server', 'port', 'underlying-proxy'];

/** 发布读回与单 key 更新必须映射的原语（执行器从不写入它无法读回的内容）。 */
export const PUBLISH_RESOURCE_PRIMITIVES = ['listExternalResources', 'updateExternalResource', 'getGroupMembers', 'getGroupSelection'] as const;

/** 节点资源中的节点名不能是这些（大小写不敏感）：Surge 的内置策略、本应用的组名与占位节点。 */
const RESERVED_NODE_NAMES: ReadonlySet<string> = new Set(['REJECT', 'DIRECT', ROUTE_GROUP_NAME.toUpperCase(), EMPTY_PLACEHOLDER_NODE.toUpperCase()]);

class PublishStop extends Error {
  constructor(
    readonly kind: 'park' | 'fail',
    readonly body: ApiErrorBody,
  ) {
    super(body.message);
  }
}

function park(body: ApiErrorBody): PublishStop {
  return new PublishStop('park', body);
}

function fail(err: SfeError | ApiErrorBody): PublishStop {
  return new PublishStop('fail', err instanceof SfeError ? err.toBody() : err);
}

/** 第一次写入 Surge 之前发现排队的普通模式：发布让出（操作放回排队，见 requeueForNormal）。 */
class PublishYield extends Error {
  constructor() {
    super('yield to a queued normal mode');
  }
}

/** 有排队（尚未执行）的进入普通模式请求。 */
function normalQueued(engine: Engine): boolean {
  return engine.repos.operations.listByStatus(['queued']).some((o) => o.kind === 'route.normal');
}

/**
 * 让给排队的普通模式（还没有写入 Surge）：批次内的操作放回排队（SAVED），普通模式按领取顺序先执行（executor claimPreference）。
 * 放回的批次自成一体：主操作与合并进来的操作各自重新排入（导入的逐行操作随其父操作收回），主操作上的 batchMembers 清除——之后
 * 无论哪一个发布先被领取，都按普通的合并收回其余操作，不会留下没有 outbox 行、永远排队的操作。从不停泊或失败：停泊是终态，
 * 系统刷新也会因此失去它的记录。
 */
function requeueForNormal(engine: Engine, batch: Batch): void {
  const { repos } = engine;
  repos.tx(() => {
    for (const op of batch.ops) {
      const cur = repos.operations.get(op.id);
      if (!cur || (cur.status !== 'queued' && cur.status !== 'running')) continue;
      const payload = payloadOf(cur);
      const update: Parameters<typeof repos.operations.update>[1] = { phase: 'SAVED', status: 'queued', error: null };
      if (op.id === batch.primary.id && payload.batchMembers !== undefined) {
        const { batchMembers: _members, ...rest } = payload;
        update.payload = rest;
      }
      repos.operations.update(op.id, update);
      repos.operations.appendStep(op.id, 'SAVED', '让给排队的普通模式（没有写入 Surge），稍后重新发布');
      if (!payload.parentOperationId) repos.outbox.enqueue(op.id, null, engine.now());
    }
  });
  engine.log('info', 'publish.yielded_to_normal', { operationId: batch.primary.id });
  emitBatch(engine, batch);
  engine.kick();
}

// ---------- 批次 ----------

/** 合并进主操作批次的其他发布类操作（记在主操作 payload 上，崩溃恢复据此找回它们）。 */
function batchMembersOf(op: Pick<OperationRecord, 'payload'>): string[] {
  const m = payloadOf(op).batchMembers;
  return Array.isArray(m) ? m.filter((x): x is string => typeof x === 'string') : [];
}

function pendingTargets(engine: Engine, environmentIds: readonly string[] | null | undefined): PublishTarget[] {
  const envs = engine.repos.environments.list().filter((e) => !environmentIds || environmentIds.includes(e.id));
  return envs
    .filter((e) => e.desiredProxyRevision !== null && e.desiredProxyRevision !== e.deployedProxyRevision)
    .map((e) => ({ environmentId: e.id, proxyRevision: e.desiredProxyRevision! }));
}

/**
 * 收集批次（调用方在同一事务内把全部操作标为 running）。崩溃后重新执行未开始写入的批次时，
 * 上次已被标为 running 的逐行操作与合并进来的操作按主操作上的记录重新纳入，不会被遗留。
 */
function collectBatch(engine: Engine, primary: OperationRecord): Batch {
  const { repos } = engine;
  const ops: OperationRecord[] = [];
  const units: Unit[] = [];
  const has = (id: string) => ops.some((o) => o.id === id);
  const open = (op: OperationRecord | null): op is OperationRecord => op !== null && (op.status === 'queued' || op.status === 'running');
  const addUnits = (op: OperationRecord, targets: readonly PublishTarget[]) => {
    for (const t of targets) units.push({ op, target: { environmentId: t.environmentId, proxyRevision: t.proxyRevision }, outcome: null, error: null });
  };
  const addOp = (op: OperationRecord) => {
    if (has(op.id)) return;
    const p = payloadOf(op);
    if (op.kind === 'import.batch') {
      ops.push(op);
      for (const childId of p.children ?? []) {
        const child = repos.operations.get(childId);
        if (!open(child) || has(child.id)) continue;
        ops.push(child);
        addUnits(child, payloadOf(child).targets ?? []);
      }
      return;
    }
    if (op.kind === 'deploy.publish') {
      const targets = pendingTargets(engine, p.environmentIds);
      const updated = { ...p, targets };
      repos.operations.update(op.id, { payload: updated });
      ops.push({ ...op, payload: updated });
      addUnits(op, targets);
      return;
    }
    ops.push(op);
    addUnits(op, p.targets ?? []);
  };
  addOp(primary);
  // 崩溃恢复：上次合并进来、仍未结束的操作
  const members = batchMembersOf(primary);
  for (const id of members) {
    const member = repos.operations.get(id);
    if (open(member)) addOp(member);
  }
  // 合并其他已排队、可领取的发布类操作：一次生成一份资源，每个操作保留自己的结果。
  const now = engine.now().toISOString();
  for (const other of repos.operations.listByStatus(['queued'])) {
    if (other.id === primary.id || has(other.id) || !isPublishKind(other.kind) || payloadOf(other).parentOperationId) continue;
    const rows = repos.outbox.pendingForOperation(other.id).filter((r) => r.claimedAt === null && r.availableAt <= now);
    if (rows.length === 0) continue;
    repos.outbox.cancelForOperation(other.id);
    addOp(other);
    if (!members.includes(other.id)) members.push(other.id);
  }
  if (members.length > 0) {
    const cur = repos.operations.get(primary.id)!;
    repos.operations.update(primary.id, { payload: { ...payloadOf(cur), batchMembers: members } });
  }
  return { primary, ops, units };
}

// ---------- 状态更新 ----------

function markAll(engine: Engine, batch: Batch, phase: OperationPhase, status: OperationStatus, step: string, error: ApiErrorBody | null = null): void {
  engine.repos.tx(() => {
    for (const op of batch.ops) {
      const cur = engine.repos.operations.get(op.id);
      if (!cur || (cur.status !== 'queued' && cur.status !== 'running')) continue;
      engine.repos.operations.update(op.id, { phase, status, error });
      engine.repos.operations.appendStep(op.id, phase, step);
    }
  });
}

function emitBatch(engine: Engine, batch: Batch): void {
  engine.emit({ operations: batch.ops.map((o) => o.id), environments: new Set(batch.units.map((u) => u.target.environmentId)) });
}

function stepAll(engine: Engine, batch: Batch, message: string): void {
  for (const op of batch.ops) engine.step(op.id, message, false);
}

function unitResults(units: readonly Unit[], op: OperationRecord): PublishTargetResult[] {
  return units
    .filter((u) => u.op.id === op.id)
    .map((u) => ({ environmentId: u.target.environmentId, proxyRevision: u.target.proxyRevision, outcome: u.outcome ?? 'failed', error: u.error }));
}

/** 门槛不足或前提不满足：全部操作停泊在 WAITING_DEPLOYMENT（终态，需新的显式发布请求）。 */
function parkAll(engine: Engine, batch: Batch, body: ApiErrorBody): void {
  for (const u of batch.units) {
    if (u.outcome === null) {
      u.outcome = 'waiting_deployment';
      u.error = body;
    }
  }
  finishOps(engine, batch, { phase: 'WAITING_DEPLOYMENT', status: 'parked', error: body, step: body.message });
}

function failAll(engine: Engine, batch: Batch, body: ApiErrorBody): void {
  for (const u of batch.units) {
    if (u.outcome === null) {
      u.outcome = 'failed';
      u.error = body;
    }
  }
  finishOps(engine, batch, { phase: 'FAILED', status: 'failed', error: body, step: body.message });
}

function finishOps(
  engine: Engine,
  batch: Batch,
  fallback: { phase: OperationPhase; status: OperationStatus; error: ApiErrorBody | null; step: string },
): void {
  const envs = new Set(batch.units.map((u) => u.target.environmentId));
  engine.repos.tx(() => {
    for (const op of batch.ops) {
      const cur = engine.repos.operations.get(op.id);
      if (!cur || (cur.status !== 'queued' && cur.status !== 'running')) continue;
      const results = op.kind === 'import.batch' ? childSummary(engine, batch, op) : unitResults(batch.units, op);
      const result = { ...(cur.result ?? {}), targets: results };
      engine.repos.operations.update(op.id, { phase: fallback.phase, status: fallback.status, error: fallback.error, result });
      engine.repos.operations.appendStep(op.id, fallback.phase, fallback.step);
    }
  });
  engine.emit({ operations: batch.ops.map((o) => o.id), environments: envs });
}

function childSummary(engine: Engine, batch: Batch, parent: OperationRecord): PublishTargetResult[] {
  const children = new Set(payloadOf(parent).children ?? []);
  return batch.units
    .filter((u) => children.has(u.op.id))
    .map((u) => ({ environmentId: u.target.environmentId, proxyRevision: u.target.proxyRevision, outcome: u.outcome ?? 'failed', error: u.error }));
}

// ---------- 保留集 ----------

interface RetentionInput {
  units: readonly Unit[];
  /**
   * 可能仍在 Surge 中的节点名：已提交版本的清单与 Surge 读到的 SFE-ROUTE 成员（去掉 REJECT 与占位节点）的并集——下载失败时
   * Surge 保留更早的缓存，它加载着的节点可能不在已提交版本中。
   */
  currentNames: readonly string[];
  /** 发布前 Surge 中 SFE-ROUTE 的选择（null：没有）：选着的节点不移除。 */
  selection: string | null;
  activeRequests: Array<{ policyName: string | null; leafPolicyName: string | null }> | null;
  /** 组成员或已提交版本读不到：哪些节点仍在使用无法判断，currentNames 中的节点全部保留。 */
  membersUnknown: boolean;
}

function retentionEntries(engine: Engine, input: RetentionInput): { entries: ResourceEntry[]; removed: ProxyRevisionRecord[] } {
  const { repos } = engine;
  const keep = new Map<string, ResourceEntry>();
  const envs = repos.environments.list({ includeDeleted: true });
  const envById = new Map(envs.map((e) => [e.id, e]));
  const add = (environmentId: string, revision: number | null) => {
    if (revision === null) return;
    const rev = repos.proxyRevisions.get(environmentId, revision);
    if (!rev || rev.state === 'retired') return;
    keep.set(entryKey(environmentId, revision), { environmentId, proxyRevision: revision, revision: rev });
  };
  for (const e of envs) {
    if (e.deletedAt) continue;
    add(e.id, e.deployedProxyRevision);
    add(e.id, e.lastVerifiedProxyRevision);
    // 读回不完整而停在 published 的期望版本仍在资源中：保留，避免反复增删
    if (e.desiredProxyRevision !== null && repos.proxyRevisions.get(e.id, e.desiredProxyRevision)?.state === 'deployed') add(e.id, e.desiredProxyRevision);
  }
  const route = repos.routeState.get();
  if (route.activeEnvironmentId) add(route.activeEnvironmentId, route.activeProxyRevision);
  const selectedRev = route.selectedNode ? repos.proxyRevisions.byNodeName(route.selectedNode) : null;
  if (selectedRev) add(selectedRev.environmentId, selectedRev.revision);
  const referenced = new Set<string>();
  for (const op of repos.operations.listByStatus(['queued', 'running', 'waiting'])) {
    const r = payloadOf(op).route;
    if (r) {
      add(r.targetEnvironmentId, r.proxyRevision);
      referenced.add(r.nodeName);
    }
  }
  for (const u of input.units) if (u.outcome === null) add(u.target.environmentId, u.target.proxyRevision);
  // 被替换的旧版本：无选择、无进行中操作引用、无归属到它的活动请求时移除；无法判断时保留。
  const undeterminable =
    input.membersUnknown ||
    input.activeRequests === null ||
    input.activeRequests.some((r) => r.policyName === ROUTE_GROUP_NAME && r.leafPolicyName === null);
  const removed: ProxyRevisionRecord[] = [];
  for (const name of input.currentNames) {
    const rev = repos.proxyRevisions.byNodeName(name);
    if (!rev) continue;
    const key = entryKey(rev.environmentId, rev.revision);
    if (keep.has(key)) continue;
    const inUse =
      route.selectedNode === name ||
      input.selection === name ||
      referenced.has(name) ||
      undeterminable ||
      (input.activeRequests ?? []).some((r) => r.leafPolicyName === name || r.policyName === name);
    if (inUse && rev.state !== 'retired') keep.set(key, { environmentId: rev.environmentId, proxyRevision: rev.revision, revision: rev });
    else if (!removed.some((r) => r.environmentId === rev.environmentId && r.revision === rev.revision)) removed.push(rev);
  }
  const entries = [...keep.values()].sort((a, b) => {
    const sa = envById.get(a.environmentId)?.seq ?? 0;
    const sb = envById.get(b.environmentId)?.seq ?? 0;
    return sa - sb || a.proxyRevision - b.proxyRevision;
  });
  return { entries, removed };
}

/** 可能仍在 Surge 中的节点名（retentionEntries 的 currentNames）：已提交版本的清单在前，之后是只在 Surge 成员中的名称。 */
export function currentNodeNames(committed: readonly string[] | null, members: readonly string[] | null): string[] {
  const out: string[] = [...(committed ?? [])];
  for (const m of members ?? []) {
    if (m.toUpperCase() === 'REJECT' || m === EMPTY_PLACEHOLDER_NODE || out.includes(m)) continue;
    out.push(m);
  }
  return out;
}

// ---------- 本机资源服务的读取 ----------

/** 本次发布的资源目标：本机资源服务、地址（含令牌，只在内存中）与 Surge 中本应用资源的 key。 */
interface ResourceTarget {
  host: ResourceHost;
  url: string;
  key: string;
}

/** 一次读取：本应用的资源（找不到时为 null）、SFE-ROUTE 的成员与选择；读取失败的部分记在 failed 中。 */
interface Observed {
  resource: SurgeExternalResource | null;
  problem: 'resource_missing' | 'resource_ambiguous' | 'resource_foreign' | null;
  members: string[] | null;
  selection: string | null;
  failed: string[];
}

async function observe(engine: Engine, url: string): Promise<Observed> {
  const out: Observed = { resource: null, problem: null, members: null, selection: null, failed: [] };
  try {
    const found = findOurResource(await engine.surge.listExternalResources(), url);
    out.resource = found.resource;
    out.problem = found.problem;
  } catch {
    out.failed.push('resources');
  }
  try {
    out.members = await engine.surge.getGroupMembers(ROUTE_GROUP_NAME);
  } catch {
    out.failed.push('members');
  }
  try {
    out.selection = await engine.surge.getGroupSelection(ROUTE_GROUP_NAME);
  } catch {
    out.failed.push('selection');
  }
  return out;
}

/** 读到的状态作为读回快照（找不到本应用的资源时 key 为空、错误为 resource_missing：读回按资源标识与错误失败）。 */
function snapshotOf(o: Observed): ResourceSnapshot {
  const r = o.resource;
  return {
    key: r?.key ?? '',
    locationHash: r?.locationHash ?? null,
    updatedAt: r?.lastUpdatedAt ?? null,
    error: r ? r.error : (o.problem ?? 'resource_missing'),
    updating: r?.updating ?? null,
    members: o.members,
    selection: o.selection,
  };
}

/** 资源错误（从未下载成功、没有更新时间时为 not_ready）；null 为没有错误。 */
function resourceErrorOf(s: ResourceSnapshot): string | null {
  if (s.error !== null) return s.error;
  return s.updatedAt === null ? 'not_ready' : null;
}

function sameTime(a: Date | null, b: Date | null): boolean {
  if (a === null || b === null) return a === b;
  return a.getTime() === b.getTime();
}

function sleep(engine: Engine, ms: number): Promise<void> {
  if (!(ms > 0)) return Promise.resolve();
  return new Promise<void>((resolve) => {
    engine.clock.setTimeout(resolve, ms);
  });
}

type UpdateWait = { state: 'idle' | 'updating' | 'unknown' | 'yield'; waitedMs: number; polls: number };

/**
 * 有限等待 Surge 不再报告本应用的资源 updating（AppServiceDeps.resourceUpdateWait 的 timeoutMs/pollMs）：idle —— 不在更新
 * （或已找不到这一项，由读回判断）；updating —— 到时限仍在更新；unknown —— 到时限最后一次仍读不到；yield —— 只在
 * opts.yieldToNormal（暂存候选之前的等待）时：等待期间受理了普通模式，发布让出。只读，从不再次更新。
 */
async function waitWhileUpdating(engine: Engine, url: string, opts: { yieldToNormal?: boolean } = {}): Promise<UpdateWait> {
  const { timeoutMs, pollMs } = engine.resourceUpdateWait();
  const started = engine.now().getTime();
  let polls = 0;
  for (;;) {
    polls++;
    let state: UpdateWait['state'];
    try {
      const found = findOurResource(await engine.surge.listExternalResources(), url);
      state = found.resource?.updating === true ? 'updating' : 'idle';
    } catch {
      state = 'unknown';
    }
    const elapsed = engine.now().getTime() - started;
    if (state === 'idle' || elapsed >= timeoutMs) return { state, waitedMs: elapsed, polls };
    if (opts.yieldToNormal === true && normalQueued(engine)) return { state: 'yield', waitedMs: elapsed, polls };
    await sleep(engine, Math.max(1, Math.min(pollMs, timeoutMs - elapsed)));
  }
}

type UpdateOutcome =
  | { kind: 'downloaded' }
  | { kind: 'skipped' }
  | { kind: 'timeout'; error: ApiErrorBody }
  | { kind: 'failed'; error: ApiErrorBody };

/** 对本应用的 key 恰好执行一次单 key 更新（从不 all，结果不明时从不重放）。 */
async function updateOnce(engine: Engine, key: string): Promise<UpdateOutcome> {
  try {
    const r = await engine.surge.updateExternalResource(key);
    return r.outcome === 'downloaded' && r.refreshed ? { kind: 'downloaded' } : { kind: 'skipped' };
  } catch (err) {
    const body = engine.errorBody(err, '更新本机节点资源失败');
    if (err instanceof SfeError && err.code === 'SURGE_COMMAND_FAILED' && err.details?.reason === 'update_timeout') return { kind: 'timeout', error: body };
    return { kind: 'failed', error: body };
  }
}

/** 更新没有成功时，操作的失败原因（从不含 key、地址或令牌）。 */
function updateFailure(u: Exclude<UpdateOutcome, { kind: 'downloaded' }>): ApiErrorBody {
  if (u.kind === 'skipped') {
    return { code: 'SURGE_COMMAND_FAILED', message: '发布失败：Surge 报告没有下载本应用的节点资源（skipped），新版本没有载入', details: { outcome: 'skipped' } };
  }
  if (u.kind === 'timeout') {
    return { code: 'SURGE_COMMAND_FAILED', message: '发布失败：更新本应用的节点资源超时，结果不明（从不重放）', details: { reason: 'update_timeout' } };
  }
  return { code: u.error.code, message: `发布失败：Surge 没有载入新版本（${u.error.message}）`, details: { reason: 'update_failed' } };
}

/** 逐节点参数读回（getPolicyDetail 已映射时）：期望值来自代理版本与前置；读不到的节点记为 null（读回最多是 partial）。 */
async function readDetails(
  engine: Engine,
  manifest: readonly NodeManifestEntry[],
  fronts: ReadonlyMap<string, FrontProxyRecord>,
): Promise<ResourceReadbackDetails | null> {
  const expected = new Map<string, ResourceNodeDetail>();
  const actual = new Map<string, ResourceNodeDetail | null>();
  // 只有占位节点：没有要核对的参数
  if (manifest.length === 0) return { expected, actual };
  const mech = engine.surge.mechanism();
  if (!mech.getPolicyDetail || mech.getPolicyDetail === 'unavailable') return null;
  for (const m of manifest) {
    const rev = engine.repos.proxyRevisions.get(m.environmentId, m.proxyRevision);
    if (!rev) continue;
    expected.set(m.nodeName, { server: rev.host, port: rev.port, underlyingProxy: fronts.get(rev.frontProxyId)?.surgeName ?? null });
    try {
      const d = await engine.surge.getPolicyDetail(m.nodeName);
      actual.set(m.nodeName, { server: d.server, port: d.port, underlyingProxy: d.underlyingProxy });
    } catch {
      actual.set(m.nodeName, null);
    }
  }
  return { expected, actual };
}

/**
 * Surge 报告的更新时间变了，却没有一条尚未被审计核对过的、本服务的完整 200 与它对应（与审计的“无法解释的下载”规则相同）：
 * Surge 载入的内容不是本服务提供的。没有审计状态时无从判断（false）。
 */
function fetchUnexplained(engine: Engine, host: ResourceHost, before: ResourceSnapshot, after: ResourceSnapshot): boolean {
  const u = after.updatedAt;
  if (u === null || sameTime(u, before.updatedAt)) return false;
  const state = readAuditState(engine.kv);
  if (state === null) return false;
  return matchAuditRecord(host.audit(), u, engine.resourceAuditToleranceMs(), state.auditedSeq + 1) === null;
}

/**
 * Surge 因选中的节点从成员中消失而回落到 REJECT 的证据（发布读回中看到）：原选择是一个节点（不是 REJECT），某次读到的成员中
 * 没有它而选择是 REJECT。只有这时回滚才改回原选择；其余的选择变化来自外部（例如用户在 Surge 中改选了 REJECT 以紧急停止），
 * 回滚从不覆盖它（与对账相同：外部修改只报告，从不抢回）。
 */
function fallbackToReject(selectionBefore: string | null, reads: ReadonlyArray<Observed | null>): boolean {
  if (selectionBefore === null || selectionBefore.toUpperCase() === 'REJECT') return false;
  return reads.some((o) => o !== null && o.members !== null && !o.members.includes(selectionBefore) && o.selection !== null && o.selection.toUpperCase() === 'REJECT');
}

/**
 * 回滚之后改回原选择：只在有回落证据（fallbackToReject）、原选择仍是成员、当前选择是 REJECT、且路由没有 node_resource_unverified
 * 时；从不改选别的买家出口。返回是否改回。
 */
async function reselectAfterFallback(engine: Engine, selectionBefore: string | null, evidence: boolean): Promise<boolean> {
  if (!evidence || selectionBefore === null) return false;
  if (engine.repos.routeState.get().warnings.includes(NODE_RESOURCE_WARNING)) return false;
  const sel = await engine.surge.getGroupSelection(ROUTE_GROUP_NAME);
  if (sel === selectionBefore || sel === null || sel.toUpperCase() !== 'REJECT') return false;
  const members = await engine.surge.getGroupMembers(ROUTE_GROUP_NAME);
  if (!members.includes(selectionBefore)) return false;
  await engine.surge.selectGroupPolicy(ROUTE_GROUP_NAME, selectionBefore);
  return true;
}

// ---------- 主流程 ----------

export async function runPublish(engine: Engine, primary: OperationRecord): Promise<void> {
  // 收集（取消被合并操作的 outbox 行、记录成员）与标记 running 在同一事务内：崩溃不会留下无人领取的操作
  const batch = engine.repos.tx(() => {
    const b = collectBatch(engine, primary);
    markAll(engine, b, 'VALIDATING', 'running', '开始校验并生成节点资源');
    return b;
  });
  emitBatch(engine, batch);
  try {
    await publishBatch(engine, batch);
  } catch (err) {
    if (err instanceof PublishYield) {
      requeueForNormal(engine, batch);
      return;
    }
    if (err instanceof PublishStop) {
      if (err.kind === 'park') parkAll(engine, batch, err.body);
      else failAll(engine, batch, err.body);
      return;
    }
    failAll(engine, batch, engine.errorBody(err, '发布失败：内部错误'));
  }
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * 门槛之后的本机资源服务前提（停泊或失败，按序）：资源服务存在（读取令牌读得到）、端口已选定、在已设置的端口监听、令牌不可疑，
 * 受管理 group 段恰好是指向本服务当前地址的定义。受管理段被改过时按原有基线检查失败（BASELINE_CHANGED）。
 */
async function resourceHostGate(engine: Engine, files: NonNullable<ReturnType<Engine['profileFiles']>>): Promise<{ host: ResourceHost; url: string }> {
  const host = engine.resource;
  if (host === null) {
    throw park({ code: 'SECRET_STORE_FAILED', message: '发布暂停：本机资源服务的读取令牌读不到，无法提供节点资源；新版本保持待部署', details: { reason: 'token_unavailable' } });
  }
  const url = engine.resourceUrl();
  if (url === null) {
    throw park({ code: 'RESOURCE_SERVER_UNAVAILABLE', message: '发布暂停：本机资源服务尚未选定端口；新版本保持待部署', details: { reason: 'no_port' } });
  }
  if (!host.listening()) {
    throw park({ code: 'RESOURCE_SERVER_UNAVAILABLE', message: '发布暂停：本机资源服务没有在已设置的端口监听（端口可能被占用）；新版本保持待部署', details: { reason: 'not_listening' } });
  }
  if (readTokenSuspect(engine.kv) !== null) {
    throw park({
      code: 'RESOURCE_SERVER_UNAVAILABLE',
      message: '发布暂停：本机资源服务的读取令牌可能已泄露，需要在维护中重新合并并轮换资源地址；新版本保持待部署',
      details: { reason: 'token_suspect' },
    });
  }
  const wp = engine.workingProfile()!;
  const text = await readText(wp.path);
  if (text === null) throw fail({ code: 'EXTERNAL_PROFILE', message: '发布失败：读取工作配置失败' });
  const line = classifyGroupLine(text, url);
  engine.resourceRuntime.line = line;
  if (line === 'ours') return { host, url };
  if (line === 'legacy') {
    throw park({ code: 'RESOURCE_MISSING', message: '发布暂停：工作配置仍引用本地节点文件，需要重新合并以改用本机资源服务；新版本保持待部署', details: { reason: 'legacy_line' } });
  }
  // 不是本服务当前的定义：受管理段被改过是外部修改（与之后的基线检查相同的失败）；否则（令牌或端口已不同、定义缺失）需要重新合并
  const bad = checkSegments(engine.repos, parseProfile(text), files.digestContent).filter((s) => s.state !== 'ok');
  if (bad.length > 0) {
    throw fail({ code: 'BASELINE_CHANGED', message: '发布失败：受管理段被修改、缺失或边界不明确，已停止同步', details: { segments: bad.map((s) => ({ name: s.name, state: s.state })) } });
  }
  throw park({
    code: 'RESOURCE_MISSING',
    message: '发布暂停：工作配置的节点组定义没有指向本机资源服务当前的地址，需要重新合并；新版本保持待部署',
    details: { reason: line === 'loopback_other' ? 'resource_url_changed' : 'not_installed' },
  });
}

/**
 * Surge 中本应用的资源（恰好一个），key 能经当前机制安全更新；等它不再 updating，读更新之前的状态并审计一次。找不到时在
 * resourceUpdateWait 的时限内等 Surge 登记它（同一配置重载之后新地址的资源不会立即出现：2026-10-25 回环矩阵，P0 的
 * REGISTRATION_WAIT_MS），到时限才停泊。等待期间受理了普通模式时让出（PublishYield）。
 */
async function discover(engine: Engine, host: ResourceHost, url: string): Promise<{ target: ResourceTarget; before: Observed }> {
  const { timeoutMs, pollMs } = engine.resourceUpdateWait();
  const started = engine.now().getTime();
  let found: ReturnType<typeof findOurResource>;
  for (;;) {
    let list: SurgeExternalResource[];
    try {
      list = await engine.surge.listExternalResources();
    } catch (err) {
      throw fail(engine.errorBody(err, '发布失败：读取外部资源失败'));
    }
    found = findOurResource(list, url);
    const elapsed = engine.now().getTime() - started;
    if (found.problem !== 'resource_missing' || elapsed >= timeoutMs) break;
    if (normalQueued(engine)) throw new PublishYield();
    await sleep(engine, Math.max(1, Math.min(pollMs, timeoutMs - elapsed)));
  }
  if (found.problem === 'resource_missing') {
    throw park({
      code: 'RESOURCE_MISSING',
      message: '发布暂停：等待时限内 Surge 中找不到指向本机资源服务的节点资源（工作配置可能尚未加载），需要重新合并；新版本保持待部署',
      details: { reason: 'resource_missing' },
    });
  }
  if (found.problem === 'resource_ambiguous') throw fail({ code: 'NAME_COLLISION', message: '发布失败：Surge 中有多个指向本机资源服务地址的外部资源，未提供新版本' });
  if (found.problem === 'resource_foreign' || found.resource === null) {
    throw fail({ code: 'NAME_COLLISION', message: '发布失败：指向本机资源服务地址的外部资源不是工作配置中的远端节点组资源（来自模块、本地文件或类型不符），未提供新版本' });
  }
  const key = found.resource.key;
  // key 可能含读取令牌时只能经 HTTP API 更新（CLI 会把它放进命令行参数）
  const route = resourceUpdateRoute(engine.surge.mechanism(), key, host.token);
  if (route.kind === 'park') {
    throw park({ code: 'CAPABILITY_UNVERIFIED', message: `发布暂停：${route.message}；新版本保持待部署`, details: { reason: route.reason } });
  }
  // 之前的更新（Surge 自己的定时刷新、上一次中断的发布）仍在进行：不在它之上提供新版本；等待期间受理了普通模式时让出
  const wait = await waitWhileUpdating(engine, url, { yieldToNormal: true });
  if (wait.state === 'yield') throw new PublishYield();
  if (wait.state === 'updating') {
    throw park({ code: 'SURGE_COMMAND_FAILED', message: '发布暂停：Surge 仍在更新本应用的节点资源（等待超时），未提供新版本；新版本保持待部署', details: { reason: 'resource_updating' } });
  }
  if (wait.state === 'unknown') throw fail({ code: 'SURGE_UNREACHABLE', message: '发布失败：读取外部资源失败，未提供新版本' });
  // 审计点在读取之前取：读取期间本服务的下载与失败答复都留给之后的审计
  const mark = host.auditMark();
  const failuresBefore = servedFailureCount(host.failureCounters());
  const before = await observe(engine, url);
  if (before.failed.includes('resources')) throw fail({ code: 'SURGE_UNREACHABLE', message: '发布失败：读取外部资源失败，未提供新版本' });
  if (before.failed.includes('selection')) throw fail({ code: 'SURGE_UNREACHABLE', message: '发布失败：读取 SFE-ROUTE 选择失败，未提供新版本' });
  if (before.resource === null || before.resource.key !== key) {
    throw fail({ code: 'BASELINE_CHANGED', message: '发布失败：Surge 中本应用的节点资源在读取期间变化，未提供新版本' });
  }
  // 审计“更新之前”的状态（与对账相同的规则）：发布的确认会把审计基线前移到这次发布的下载，基线之前留下的、本服务无法解释的
  // 下载或资源错误必须在这里发现（例如本服务停止期间端口被他人占用、Surge 下载了它提供的列表），不能被确认覆盖
  const verdict = auditForPublish(engine, host, before.resource, { mark, failuresBefore });
  if (verdict === 'unexplained_fetch' || verdict === 'unexplained_error') {
    raiseNodeResourceWarning(engine, [verdict]);
    throw park({
      code: 'RESOURCE_SERVER_UNAVAILABLE',
      message: '发布暂停：Surge 报告了本机资源服务无法解释的下载或资源错误，读取令牌可能已泄露，需要在维护中重新合并并轮换资源地址；新版本保持待部署',
      details: { reason: 'token_suspect' },
    });
  }
  return { target: { host, url, key }, before };
}

async function publishBatch(engine: Engine, batch: Batch): Promise<void> {
  const { repos } = engine;
  // 0. 目标是否仍是期望版本（之后的修改会取代它）
  for (const u of batch.units) {
    const env = repos.environments.get(u.target.environmentId);
    const rev = repos.proxyRevisions.get(u.target.environmentId, u.target.proxyRevision);
    if (!env || env.deletedAt || !rev) {
      u.outcome = 'superseded';
      u.error = { code: 'NOT_FOUND', message: '发布跳过：环境已删除' };
    } else if (env.desiredProxyRevision !== u.target.proxyRevision) {
      u.outcome = 'superseded';
      u.error = { code: 'SUPERSEDED', message: '发布跳过：已有更新的版本' };
    } else if (env.deployedProxyRevision === u.target.proxyRevision) {
      u.outcome = 'deployed';
    }
  }

  // 1. 门槛（自动与手动完全相同）
  const wp = engine.workingProfile();
  if (!wp) throw park({ code: 'RESOURCE_MISSING', message: '发布暂停：尚未初始化固定工作配置' });
  await engine.readBasicFacts();
  const views = engine.capabilityViews();
  const missing = engine.missing(CAPABILITY_GATES.publish);
  if (missing.length > 0) throw park(publishGateBody(engine, views, missing));
  try {
    await engine.keys();
  } catch (err) {
    throw fail(engine.errorBody(err));
  }
  const files = engine.profileFiles();
  if (!files) throw fail({ code: 'INTERNAL', message: '发布失败：无法访问工作配置目录' });

  // 前提：Surge 可达、当前配置是工作配置、自动重载设置与回环资源更新实测时的条件一致
  if (!engine.facts.reachable) throw fail({ code: 'SURGE_UNREACHABLE', message: '发布失败：无法连接 Surge' });
  if (engine.facts.onWorkingProfile !== true) throw fail({ code: 'EXTERNAL_PROFILE', message: '发布失败：Surge 当前配置不是固定工作配置，未提供任何内容' });
  const cond = engine.resourceAutoReloadCondition();
  const setting = engine.facts.autoReload;
  const autoOk = cond === 'any' || (setting !== null && cond !== null && cond === (setting ? 'on' : 'off'));
  if (!autoOk) {
    throw park({
      code: 'CAPABILITY_UNVERIFIED',
      message: '发布暂停：Surge 自动重载设置与回环资源单 key 更新实测时的条件不一致或无法读取',
      details: { autoReload: setting, verifiedCondition: cond },
    });
  }
  // 执行器从不写入它无法读回的内容
  const mech = engine.surge.mechanism();
  const unreadable = PUBLISH_RESOURCE_PRIMITIVES.filter((p) => !mech[p] || mech[p] === 'unavailable');
  if (unreadable.length > 0) {
    throw park({ code: 'CAPABILITY_UNVERIFIED', message: '发布暂停：单 key 更新与读回所需的 Surge 原语不可用', details: { primitives: unreadable } });
  }
  const { host, url } = await resourceHostGate(engine, files);

  // 2. 本应用的资源与更新之前的状态（在“没有修改”的捷径之前：捷径要求 Surge 中已是已提交版本）
  const { target, before } = await discover(engine, host, url);
  const runtimeBefore = await readRuntimeSample(engine.surge);

  // 3. 前置存在于 listPolicies 且是固定节点
  const fronts = new Map<string, FrontProxyRecord>(repos.frontProxies.list().map((f) => [f.id, f]));
  let policies;
  try {
    policies = await engine.surge.listPolicies();
  } catch (err) {
    throw fail(engine.errorBody(err, '发布失败：读取 Surge 策略失败'));
  }
  const proxySet = new Set(policies.proxies);
  const groupSet = new Set(policies.groups);
  for (const u of batch.units) {
    if (u.outcome !== null) continue;
    const rev = repos.proxyRevisions.get(u.target.environmentId, u.target.proxyRevision)!;
    const front = fronts.get(rev.frontProxyId);
    if (!front || front.retired) {
      u.outcome = 'invalid';
      u.error = { code: 'FRONT_PROXY_MISSING', message: '发布失败：前置代理未登记或已停用', fieldErrors: [{ field: 'proxy.frontProxyId', message: '前置代理未登记或已停用' }] };
    } else if (!proxySet.has(front.surgeName) || groupSet.has(front.surgeName) || /^SFE-/i.test(front.surgeName) || BUILTIN_POLICIES.has(front.surgeName.toUpperCase())) {
      u.outcome = 'failed';
      u.error = { code: 'FRONT_PROXY_MISSING', message: '发布失败：前置节点不在 Surge 中或不是固定节点' };
    }
  }

  // 4. 生成候选、严格校验、--check、基线检查（基线在暂存前变化时从头重来，有限次数）
  const maxAttempts = engine.deps.baselineRetries ?? 3;
  let plan: Plan | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    plan = await buildPlan(engine, batch, files, policies, { url, before });
    const profileAfter = await readText(wp.path);
    const pointer = readServedPointer(engine.kv);
    if (profileAfter !== null && files.digestContent(profileAfter) === plan.profileDigest && pointer?.candidate === null && pointer.committed.generation === plan.committedGeneration) break;
    stepAll(engine, batch, '工作配置在生成期间被修改，重新生成');
    plan = null;
  }
  if (!plan) throw fail({ code: 'BASELINE_CHANGED', message: '发布失败：工作配置在生成期间多次被修改' });

  // 5. 没有修改的捷径：没有待发布与待移除、清单与已提交版本相同、Surge 中正是已提交版本且没有资源错误、没有刷新要求
  const pending = batch.units.filter((u) => u.outcome === null);
  const needsRefreshBefore = readNeedsRefresh(engine.kv);
  // 节点资源未确认的警告只由经确认的读回清除：警告在时不走捷径（门槛已保证工作配置指向本服务当前地址、令牌不可疑）
  const forced =
    needsRefreshBefore !== null || batch.ops.some((o) => payloadOf(o).forceRefresh === true) || repos.routeState.get().warnings.includes(NODE_RESOURCE_WARNING);
  const beforeSnap = snapshotOf(before);
  const surgeClean = resourceErrorOf(beforeSnap) === null && membersMatchCommitted(before.members ?? [], plan.committedNames);
  if (pending.length === 0 && plan.removed.length === 0 && plan.unchanged && surgeClean && !forced) {
    await settle(engine, batch, null);
    return;
  }
  if (forced) stepAll(engine, batch, '需要与已提交版本重新核对：提供节点资源，对本应用的资源单 key 更新一次并逐项读回');
  else if (!surgeClean) stepAll(engine, batch, 'Surge 中的节点资源与已提交版本不一致（资源错误或成员不同）：重新提供并单 key 更新一次');

  // 6. 事务 T1：候选发布记录、候选指针与 needsRefresh（之后任何中断都要求下一次发布重新更新并读回），操作进入 DEPLOYING
  const generation = plan.generation;
  const selectionBefore = before.selection;
  // 第一次写入 Surge 之前的最后一个停止点（T1 与暂存、单 key 更新之间没有等待）：有排队的普通模式时让出
  if (normalQueued(engine)) throw new PublishYield();
  const deployment = repos.tx(() => {
    const gen = repos.meta.bumpConfigurationGeneration();
    if (gen !== generation) throw new SfeError('INTERNAL', '发布失败：配置代数已变化');
    const d = repos.deployments.insert({
      generation: gen,
      // 不保存工作配置的 pepper 派生摘要，只保存进程内随机密钥下的核对值（profileCheckOf）
      workingProfileDigest: profileCheckOf(engine, plan!.profileDigest),
      resourceDigest: plan!.newDigest,
      nodeManifest: plan!.manifest,
      selectionBefore,
      state: 'candidate',
      operationId: batch.primary.id,
    });
    // 每个操作一行（一个发布操作可以有多个目标；逐目标结果在操作的 result.targets 中）
    for (const [opId, targets] of unitsByOp(batch.units)) {
      const only = targets.length === 1 ? targets[0]! : null;
      repos.deployments.addOperation({ generation: gen, operationId: opId, environmentId: only?.environmentId ?? null, proxyRevision: only?.proxyRevision ?? null });
    }
    setCandidatePointer(engine.kv, gen, 'publish');
    markAll(engine, batch, 'DEPLOYING', 'running', `发布节点资源（配置代数 ${gen}）：本机资源服务提供候选版本，对本应用的资源单 key 更新一次`);
    return d;
  });
  emitBatch(engine, batch);
  await deploy(engine, { batch, plan, deployment, target, before, selectionBefore, runtimeBefore, fronts, workingProfile: wp, needsRefreshBefore });
}

function unitsByOp(units: readonly Unit[]): Map<string, PublishTarget[]> {
  const out = new Map<string, PublishTarget[]>();
  for (const u of units) {
    const list = out.get(u.op.id) ?? [];
    list.push(u.target);
    out.set(u.op.id, list);
  }
  return out;
}

/** 操作在本代数中的结果：各目标一致时为该结果，否则为 mixed（逐目标结果见 result.targets）。 */
function opOutcome(units: readonly Unit[], opId: string): string | null {
  const outcomes = new Set(units.filter((u) => u.op.id === opId).map((u) => u.outcome));
  if (outcomes.size === 0) return null;
  if (outcomes.size > 1) return 'mixed';
  return [...outcomes][0] ?? null;
}

interface Plan {
  generation: number;
  /** 本机资源服务提供的内容（resourceBody：没有节点时只含占位行）。 */
  content: string;
  /** 内容在工作配置目录文件密钥下的摘要（deployments.resource_digest；启动时重建内容与它核对）。 */
  newDigest: string;
  manifest: NodeManifestEntry[];
  removed: ProxyRevisionRecord[];
  profileDigest: string;
  committedGeneration: number;
  /** 已提交版本的节点名；发布记录不在时为 null。 */
  committedNames: string[] | null;
  /** 清单中的节点名与已提交版本相同。 */
  unchanged: boolean;
}

/**
 * 发布记录中工作配置的核对值（deployments.working_profile_digest，docs/ARCHITECTURE.md §0「秘密的存放」）。工作配置含用户自己的
 * 节点凭据、http-api 密钥与 MITM 证书口令；按 pepper 派生密钥计算的摘要（files.digestContent）与 backups/ 中的工作配置副本一起，
 * 能让拿到数据目录副本的人离线核对猜测的这些凭据（之后改过的也一样），而发布记录没有期限。所以只保存它在本进程随机密钥下的
 * HMAC 与进程标记（engine.requestEphemeral，从不持久保存，与维护提交的 previewCheck 相同）：进程结束之后任何人都无法再用它核对。
 * 迁移 6 清除升级前保存的摘要。
 */
const PROFILE_CHECK_TAG = 'eph1:';

function profileCheckOf(engine: Engine, profileDigest: string): string {
  const { key, epoch } = engine.requestEphemeral;
  return `${PROFILE_CHECK_TAG}${epoch}:${hmacHex(key, `profile-check\0${profileDigest}`)}`;
}

/** 上一次发布记下的核对值由本进程计算、且与当前工作配置不同。之前的进程记下的（或迁移 6 清除的）无从比较：不说明有修改。 */
function profileChangedSince(engine: Engine, recorded: string | null, profileDigest: string): boolean {
  if (recorded === null || !recorded.startsWith(`${PROFILE_CHECK_TAG}${engine.requestEphemeral.epoch}:`)) return false;
  return recorded !== profileCheckOf(engine, profileDigest);
}

/**
 * 提供之前对节点列表的严格校验（Surge 静默跳过坏行与重名、仍报告成功：读回之外再在提供之前拒绝）：不超过 1 MiB；没有 '['
 * 开头的行；每一个非注释行恰好解析为它的清单条目（名称、socks5、服务器、端口、前置）；名称唯一（大小写不敏感）且不是 REJECT、
 * DIRECT、SFE-ROUTE、SFE-EMPTY 或其他内置策略；没有节点时只有占位行。通过时为 null，否则为原因代码（不含内容）。
 */
export function validateResourceBody(
  body: string,
  manifest: readonly NodeManifestEntry[],
  expected: (m: NodeManifestEntry) => { host: string; port: number; front: string | null } | null,
): string | null {
  if (Buffer.byteLength(body, 'utf8') > RESOURCE_MAX_BYTES) return 'too_large';
  const nodeLines: string[] = [];
  for (const raw of body.split('\n')) {
    if (/[\r\0]/.test(raw)) return 'control_character';
    if (raw.trimStart().startsWith('[')) return 'section_line';
    if (isCommentLine(raw)) continue;
    nodeLines.push(raw);
  }
  if (manifest.length === 0) return nodeLines.length === 1 && nodeLines[0] === EMPTY_PLACEHOLDER_LINE ? null : 'placeholder';
  if (nodeLines.length !== manifest.length) return 'count';
  const seen = new Set<string>();
  for (let i = 0; i < nodeLines.length; i++) {
    const p = parseProxyLine(nodeLines[i]!);
    const m = manifest[i]!;
    if (!p) return 'unparsable';
    const upper = p.name.toUpperCase();
    if (RESERVED_NODE_NAMES.has(upper) || BUILTIN_POLICIES.has(upper)) return 'reserved_name';
    if (seen.has(upper)) return 'duplicate_name';
    seen.add(upper);
    const want = expected(m);
    if (want === null || p.name !== m.nodeName || p.type !== 'socks5' || p.server !== want.host || p.port !== want.port || (p.params['underlying-proxy'] ?? null) !== want.front) return 'mismatch';
  }
  return null;
}

async function buildPlan(
  engine: Engine,
  batch: Batch,
  files: NonNullable<ReturnType<Engine['profileFiles']>>,
  policies: { proxies: string[]; groups: string[] },
  ctx: { url: string; before: Observed },
): Promise<Plan> {
  const { repos } = engine;
  const wp = engine.workingProfile()!;
  const profileText = await readText(wp.path);
  if (profileText === null) throw fail({ code: 'EXTERNAL_PROFILE', message: '发布失败：读取工作配置失败' });
  const profileDigest = files.digestContent(profileText);

  // 已提交版本（指针）：本次发布的基线、回滚目标与“可能仍在 Surge 中”的节点
  const pointer = readServedPointer(engine.kv);
  if (pointer === null || pointer.candidate !== null) throw fail({ code: 'INTERNAL', message: '发布失败：节点资源指针不正确（已有未提交的候选版本或尚未初始化）' });
  const committedNames = committedNodeNames(engine);
  const currentNames = currentNodeNames(committedNames, ctx.before.members);

  // 基线检查：受管理段内容与位置、非本应用 SFE- 对象（含受管理 group 段之外对本机资源服务端口的引用）
  const parsed = parseProfile(profileText);
  const segments = checkSegments(repos, parsed, files.digestContent);
  const bad = segments.filter((s) => s.state !== 'ok');
  if (bad.some((s) => s.state === 'unrecorded')) {
    throw fail({ code: 'NAME_COLLISION', message: '发布失败：工作配置中有不属于本应用记录的受管理段', details: { segments: bad.map((s) => ({ name: s.name, state: s.state })) } });
  }
  if (bad.length > 0) {
    throw fail({ code: 'BASELINE_CHANGED', message: '发布失败：受管理段被修改、缺失或边界不明确，已停止同步', details: { segments: bad.map((s) => ({ name: s.name, state: s.state })) } });
  }
  const strategy = repos.settings.get('entryStrategy');
  if (strategy === 'ruleset_resource' && repos.managedObjects.get('entry_segment', 'entry') && !entryBlockIsFirstRule(parsed)) {
    throw fail({ code: 'BASELINE_CHANGED', message: '发布失败：入口受管理段不在有效规则首位', details: { segments: [{ name: 'entry', state: 'not_first' }] } });
  }
  const foreign = findForeignSfeObjects(profileText, { names: [ROUTE_GROUP_NAME], files: Object.values(ENTRY_RULESET_FILES), resourceUrl: ctx.url });
  if (foreign.length > 0) {
    throw fail({ code: 'NAME_COLLISION', message: '发布失败：工作配置中有不属于本应用的 SFE- 对象', details: { objects: foreign.map((f) => ({ kind: f.kind, name: f.name, line: f.line })) } });
  }

  // 保留集与候选
  let activeRequests: Array<{ policyName: string | null; leafPolicyName: string | null }> | null;
  try {
    activeRequests = (await engine.surge.listActiveRequests()).map((r) => ({ policyName: r.policyName, leafPolicyName: r.leafPolicyName }));
  } catch {
    activeRequests = null;
  }
  const { entries, removed } = retentionEntries(engine, {
    units: batch.units,
    currentNames,
    selection: ctx.before.selection,
    activeRequests,
    membersUnknown: ctx.before.members === null || committedNames === null,
  });
  const fronts = new Map(repos.frontProxies.list().map((f) => [f.id, f]));
  const generation = repos.meta.configurationGeneration() + 1;
  const generated = await generateResource(engine, generation, entries, fronts);
  // 生成失败：目标条目单独排除；已部署条目失败意味着无法重建资源，整体失败
  for (const [k, body] of generated.errors) {
    const unit = batch.units.find((u) => u.outcome === null && entryKey(u.target.environmentId, u.target.proxyRevision) === k);
    if (unit) {
      unit.outcome = 'invalid';
      unit.error = body;
      continue;
    }
    throw fail(body);
  }
  if (generated.errors.size > 0) {
    // 排除失败目标后重新生成，保证清单与内容一致
    return buildPlan(engine, batch, files, policies, ctx);
  }
  if (!manifestMatches(generated.content, generated.manifest)) {
    throw fail({ code: 'VALIDATION_FAILED', message: '发布失败：生成的节点资源与预期清单不一致' });
  }
  const content = resourceBody(generation, generated.lines);
  const invalid = validateResourceBody(content, generated.manifest, (m) => {
    const rev = repos.proxyRevisions.get(m.environmentId, m.proxyRevision);
    if (!rev) return null;
    return { host: rev.host, port: rev.port, front: fronts.get(rev.frontProxyId)?.surgeName ?? null };
  });
  if (invalid !== null) {
    throw fail({ code: 'VALIDATION_FAILED', message: '发布失败：生成的节点资源没有通过提供前的严格校验，未提供', details: { reason: invalid } });
  }

  // 名称冲突：Surge 中非本应用的 SFE- 名称（占位节点 SFE-EMPTY 除外）；候选新节点名已被其他对象占用
  const ours = new Set<string>([ROUTE_GROUP_NAME, ...currentNames]);
  const foreignNames = foreignSfePolicyNames([...policies.proxies, ...policies.groups], ours);
  if (foreignNames.length > 0) {
    throw fail({ code: 'NAME_COLLISION', message: '发布失败：Surge 中有不属于本应用的 SFE- 名称', details: { names: foreignNames.slice(0, 20) } });
  }

  // 候选 --check：SFE-ROUTE 的 policy-path 改为相对的候选节点列表（从不接触本机资源服务），其余引用指向真实文件
  let check;
  try {
    const rewrite = rewriteLoopbackForCheck(profileText, content, ctx.url);
    const overrides = new Map<string, string>(rewrite.overrides);
    for (const name of Object.values(ENTRY_RULESET_FILES)) {
      const c = await files.read(name);
      if (c !== null) overrides.set(name, c);
    }
    check = await checkCandidate(engine, { profileText: rewrite.text, profileFileName: wp.path.slice(wp.directory.length + 1), sourceDirectory: wp.directory, overrides });
  } catch (err) {
    throw fail(engine.errorBody(err, '校验候选配置失败：内部错误'));
  }
  for (const r of check.resolved) stepAll(engine, batch, `候选引用 ${r.reference} → ${r.kind === 'candidate' ? '候选副本' : r.target}`);
  if (!check.ok) {
    throw fail({ code: 'SURGE_CHECK_FAILED', message: `校验候选配置失败：${check.message}` });
  }

  // 受管理段之外的用户修改直接成为新基线（只在上一次发布由本进程记下核对值时能说明这一点，profileChangedSince）
  const last = repos.deployments.latestWithState(['verified', 'published']);
  if (profileChangedSince(engine, last?.workingProfileDigest ?? null, profileDigest)) {
    stepAll(engine, batch, '工作配置在受管理段之外有修改，已作为新基线');
  }
  void describeOutsideChanges;

  const names = generated.manifest.map((m) => m.nodeName);
  const unchanged = committedNames !== null && names.length === committedNames.length && names.every((n) => committedNames.includes(n));
  return {
    generation,
    content,
    newDigest: files.digestContent(content),
    manifest: generated.manifest,
    removed,
    profileDigest,
    committedGeneration: pointer.committed.generation,
    committedNames,
    unchanged,
  };
}

// ---------- 提供、单 key 更新与读回 ----------

interface DeployContext {
  batch: Batch;
  plan: Plan;
  deployment: DeploymentRecord;
  target: ResourceTarget;
  before: Observed;
  selectionBefore: string | null;
  runtimeBefore: SurgeRuntimeSample | null;
  fronts: ReadonlyMap<string, FrontProxyRecord>;
  workingProfile: { path: string; name: string };
  /** T1 之前的 needsRefresh：Surge 从未载入候选时回滚恢复它。 */
  needsRefreshBefore: ResourceNeedsRefresh | null;
}

/** 回滚需要的、发布阶段已知的事实。 */
interface RollbackInput {
  failure: ApiErrorBody;
  /** 暂存候选之前取的审计序号；暂存之前就失败时为 null。 */
  mark: number | null;
  /** 单 key 更新的结果；没有执行时为 null。 */
  update: UpdateOutcome | null;
  /** 更新之后（等待与稳定延迟之后）读到的状态；没有读时为 null（回滚时再读）。 */
  after: Observed | null;
  /** 稳定延迟之后再读的一次；没有读时为 null。 */
  afterRepeat: Observed | null;
  /** 等待到时限 Surge 仍在更新：回滚不再更新，直接需要处理。 */
  stillUpdating: boolean;
}

/** 读回的额外失败（资源服务读回之外）：当前配置、读取失败与 Surge 载入了本服务没有提供的内容。 */
interface ExtraChecks {
  failed: string[];
  externalProfile: boolean;
  notes: string[];
}

async function profileAndRuntime(engine: Engine, ctx: DeployContext): Promise<ExtraChecks> {
  const out: ExtraChecks = { failed: [], externalProfile: false, notes: [] };
  try {
    const p = await engine.surge.getCurrentProfile();
    if (!profileMatches(p, ctx.workingProfile)) {
      out.failed.push('profile');
      out.externalProfile = true;
    }
  } catch {
    out.failed.push('profile');
  }
  const runtimeAfter = await readRuntimeSample(engine.surge);
  if (ctx.runtimeBefore === null || runtimeAfter === null) out.notes.push('读回：无法读取 Surge 引擎运行时长（未重启信号不可得）');
  else if (surgeRestartedBetween(ctx.runtimeBefore, runtimeAfter)) out.notes.push('读回提示：Surge 引擎在发布期间重启（运行时长回落或启动时间变化），临时规则与连接可能已被清空');
  else out.notes.push('读回：未观察到 Surge 引擎重启');
  return out;
}

/**
 * 暂存候选 → 一次单 key 更新 → 有限等待 → 稳定延迟 → 两次读回 → 严格核对 → 提交。从暂存开始，任何不是成功提交的结局（读回不一致、
 * 更新失败或结果不明、提交事务失败、意外异常）都进入回滚；资源服务只在提交事务完成之后才提交候选版本。
 */
async function deploy(engine: Engine, ctx: DeployContext): Promise<void> {
  const { batch, plan, target } = ctx;
  const { host, url, key } = target;
  const generation = plan.generation;
  const input: RollbackInput = { failure: { code: 'INTERNAL', message: '发布失败：内部错误' }, mark: null, update: null, after: null, afterRepeat: null, stillUpdating: false };
  let committed: CommitInput | null = null;
  try {
    input.mark = host.auditMark();
    host.stageCandidate({ generation, content: plan.content });
    stepAll(engine, batch, `本机资源服务已提供候选版本（配置代数 ${generation}）`);
    const update = await updateOnce(engine, key);
    input.update = update;
    stepAll(
      engine,
      batch,
      update.kind === 'downloaded'
        ? '已对本应用的节点资源单 key 更新一次（没有更新其他外部资源），Surge 报告已下载'
        : update.kind === 'skipped'
          ? '已对本应用的节点资源单 key 更新一次：Surge 报告没有下载（skipped）'
          : update.kind === 'timeout'
            ? '已对本应用的节点资源单 key 更新一次：等待结果超时，结果不明（不重放）'
            : `已对本应用的节点资源单 key 更新一次：更新失败（${update.error.message}）`,
    );
    const wait = await waitWhileUpdating(engine, url);
    if (wait.state === 'updating') {
      input.stillUpdating = true;
      input.failure = { code: 'READBACK_MISMATCH', message: '发布读回失败：等待时限内 Surge 仍在更新本应用的节点资源，不再更新，需要处理', details: { reason: 'resource_updating' } };
    } else {
      const { settleMs } = engine.resourceUpdateWait();
      await sleep(engine, settleMs);
      // 读回开始之前的失败答复计数：确认之后成为新审计点的基线（读回期间与之后本服务的失败答复都算进下一次审计）
      const failuresBaseline = servedFailureCount(host.failureCounters());
      const after = await observe(engine, url);
      input.after = after;
      await sleep(engine, settleMs);
      const afterRepeat = await observe(engine, url);
      input.afterRepeat = afterRepeat;
      const extra = await profileAndRuntime(engine, ctx);
      const details = await readDetails(engine, plan.manifest, ctx.fronts);
      const beforeSnap = snapshotOf(ctx.before);
      const afterSnap = snapshotOf(after);
      const assessment = assessResourceReadback({
        url,
        before: beforeSnap,
        after: afterSnap,
        afterRepeat: snapshotOf(afterRepeat),
        expectedMembers: plan.manifest.map((m) => m.nodeName),
        selectionBefore: ctx.selectionBefore,
        records: host.audit(),
        mark: input.mark,
        expectedGeneration: generation,
        toleranceMs: engine.resourceAuditToleranceMs(),
        details,
      });
      const failed = [...assessment.failed, ...extra.failed];
      for (const f of [...after.failed, ...afterRepeat.failed]) if (!failed.includes(f)) failed.push(f);
      // Surge 载入了本服务没有提供过的内容：读取令牌可能已泄露（与审计相同的处理）
      if (fetchUnexplained(engine, host, beforeSnap, afterSnap)) {
        if (!failed.includes('unexplained_fetch')) failed.push('unexplained_fetch');
        flagUnexplainedFetch(engine);
      }
      for (const n of extra.notes) stepAll(engine, batch, n);
      if (update.kind !== 'downloaded') {
        input.failure = { ...updateFailure(update), details: { ...(updateFailure(update).details ?? {}), checks: failed } };
      } else if (failed.length > 0) {
        input.failure = extra.externalProfile
          ? { code: 'EXTERNAL_PROFILE', message: '发布读回失败：Surge 当前配置不是固定工作配置', details: { checks: failed } }
          : { code: 'READBACK_MISMATCH', message: '发布读回不一致：Surge 载入的节点资源与本服务提供的候选版本不一致', details: { checks: failed } };
      } else {
        const unchecked = assessment.level === 'full' ? [] : [...UNCHECKED_DETAIL_FIELDS];
        const acceptable = assessment.level === 'full' || readbackCovered(engine.capabilityViews(), unchecked);
        const matched = matchAuditRecord(host.audit(), afterSnap.updatedAt!, engine.resourceAuditToleranceMs(), input.mark, generation)!;
        const commit: CommitInput = {
          deployment: ctx.deployment,
          plan,
          readback: { level: assessment.level, unchecked },
          acceptable,
          matchedSeq: matched.seq,
          snapshot: { updatedAt: afterSnap.updatedAt!, error: afterSnap.error },
          failuresBaseline,
        };
        // 事务 T2：发布记录、指针、审计状态、needsRefresh 与各目标的结算（失败按读回失败回滚；各目标在内存中的结果一并复原）
        const saved = batch.units.map((u) => ({ outcome: u.outcome, error: u.error }));
        try {
          commitDeployment(engine, batch, commit);
        } catch (err) {
          batch.units.forEach((u, i) => {
            u.outcome = saved[i]!.outcome;
            u.error = saved[i]!.error;
          });
          throw err;
        }
        committed = commit;
      }
    }
  } catch (err) {
    input.failure = engine.errorBody(err, '发布失败：内部错误');
  }
  if (committed === null) {
    await rollbackPublish(engine, ctx, input);
    return;
  }
  // T2 已提交：资源服务此时才把候选版本作为已提交版本提供
  try {
    host.commitCandidate();
  } catch {
    engine.log('error', 'resource.commit_candidate_failed', { generation });
    host.revertToCommitted();
    try {
      host.loadCommitted({ generation, content: plan.content });
    } catch {
      host.unload();
    }
  }
  if (!committed.acceptable) {
    stepAll(engine, batch, '读回不完整（没有逐节点参数读回，也没有实测记录覆盖未核对字段）：部署不标为已核对，读回要求保留到下一次发布');
  }
  await settle(engine, batch, committed);
}

// ---------- 回滚 ----------

/** 过渡中的路由阶段：由负责它的路由操作处理，回滚不改它（与对账的 IN_PROGRESS 相同）。 */
const ROUTE_IN_PROGRESS: ReadonlySet<string> = new Set(['switching', 'rolling_back']);

/**
 * 回滚确认时读到的 SFE-ROUTE 选择与路由记录的选择不同（发布期间被外部修改，例如用户在 Surge 中改选了 REJECT）：与对账相同地
 * 报告——托管中的路由加 external_selection_change、阶段改为 external_change（已是 attention 时不变），去掉
 * rollback_needs_reverify（「已恢复原节点」已不成立）。从不改回选择，也不因此设 node_resource_unverified。在调用方的事务中执行，
 * 返回是否记下。
 */
function noteExternalSelection(engine: Engine, selection: string | null | undefined): boolean {
  const { repos } = engine;
  const route = repos.routeState.get();
  const managed = route.phase !== 'idle' || route.entryMode !== 'NORMAL';
  if (!managed || selection === undefined || route.selectedNode === null || selection === route.selectedNode || ROUTE_IN_PROGRESS.has(route.phase)) return false;
  const warnings = new Set(route.warnings.filter((w) => w !== 'rollback_needs_reverify'));
  warnings.add('external_selection_change');
  repos.routeState.update({ warnings: [...warnings], phase: route.phase === 'attention' ? 'attention' : 'external_change' });
  return true;
}

/** 回滚的单 key 更新之前重读本应用的资源：idle 才更新；仍在更新、读不到或资源已变化（key 不同）时不再更新。 */
async function updatingBeforeRollback(engine: Engine, url: string, key: string): Promise<'idle' | 'updating' | 'unknown'> {
  try {
    const found = findOurResource(await engine.surge.listExternalResources(), url);
    if (found.resource === null || found.resource.key !== key) return 'unknown';
    return found.resource.updating === true ? 'updating' : 'idle';
  } catch {
    return 'unknown';
  }
}

/**
 * 回滚：资源服务先撤回候选版本（内存中，不会失败：之后 Surge 的任何下载都得到已提交版本，撤回指针的事务失败时也不再提供从未
 * 提交的候选）→ 一个事务撤回候选指针（needsRefresh 保留）→ 判断 Surge 是否可能已载入候选：更新报告已下载或结果不明、有候选
 * 代数的审计记录（序号不小于 mark，含没有写完的）、更新时间变化、成员与已提交版本不同。可能载入时：发布读回中 Surge 已报告
 * 在更新、或更新之前重读时仍在更新（或读不到、资源已变化）→ 不再更新；否则单 key 更新一次 → 有限等待 → 只在有“选中的节点从
 * 成员中消失而回落到 REJECT”的证据时改回原选择 → 按已提交版本严格读回（资源部分；选择只要求两次读取一致）；令牌可疑时不更新。
 * 没有载入 → 核对成员仍是已提交版本、更新时间不变、资源错误不变或只是连接被拒绝或超时。选择在发布期间被外部修改时从不改回：
 * 托管中的路由记 external_selection_change（noteExternalSelection）。确认 → 发布记录 rolled_back、操作按原因失败；无法确认 →
 * 发布记录 failed、BLOCKED_NEEDS_ATTENTION、路由需要处理、node_resource_unverified（从不改为 NORMAL、DIRECT 或其他出口），
 * needsRefresh 保留。
 */
async function rollbackPublish(engine: Engine, ctx: DeployContext, input: RollbackInput): Promise<void> {
  const { repos, kv } = engine;
  const { batch, target } = ctx;
  const { host, url, key } = target;
  const candidate = ctx.plan.generation;
  host.revertToCommitted();
  repos.tx(() => {
    clearCandidatePointer(kv);
    markAll(engine, batch, 'ROLLING_BACK', 'running', `${input.failure.message}：回滚到已提交的节点资源`);
  });
  emitBatch(engine, batch);
  let confirmed = false;
  let confirmation: { matchedSeq: number; snapshot: { updatedAt: Date; error: string | null }; clearNeedsRefresh: boolean; failuresBaseline: number } | null = null;
  let reason: string | null = null;
  let reselected = false;
  /** 确认读回中读到的 SFE-ROUTE 选择（没有确认时不用）。 */
  let observedSelection: string | null | undefined;
  try {
    const committedGeneration = readServedPointer(kv)?.committed.generation ?? null;
    const committedNames = committedNodeNames(engine);
    if (committedGeneration === null || committedNames === null) throw new SfeError('INTERNAL', '回滚失败：已提交版本无法确定');
    if (input.stillUpdating || input.after?.resource?.updating === true || input.afterRepeat?.resource?.updating === true) {
      reason = 'Surge 仍在更新本应用的节点资源，不再更新';
    } else if (readTokenSuspect(kv) !== null) {
      reason = '读取令牌可能已泄露：资源服务不再提供内容';
    } else {
      const after = input.after ?? (await observe(engine, url));
      const afterSnap = snapshotOf(after);
      const held =
        input.update?.kind === 'downloaded' ||
        input.update?.kind === 'timeout' ||
        (input.mark !== null && host.audit().some((r) => r.generation === candidate && r.seq >= input.mark!)) ||
        !sameTime(afterSnap.updatedAt, ctx.before.resource?.lastUpdatedAt ?? null) ||
        !membersMatchCommitted(after.members ?? [], committedNames);
      if (held) {
        const fresh = await updatingBeforeRollback(engine, url, key);
        if (fresh === 'updating') {
          reason = 'Surge 仍在更新本应用的节点资源，不再更新';
        } else if (fresh === 'unknown') {
          reason = '回滚之前读取本应用的节点资源失败或资源已变化，不再更新';
        } else {
          const fallback = fallbackToReject(ctx.selectionBefore, [input.after, input.afterRepeat]);
          const mark = host.auditMark();
          const update = await updateOnce(engine, key);
          stepAll(engine, batch, update.kind === 'downloaded' ? '回滚：已对本应用的节点资源单 key 更新一次，Surge 报告已下载' : '回滚：对本应用的节点资源单 key 更新一次没有成功');
          const wait = await waitWhileUpdating(engine, url);
          if (wait.state === 'updating') {
            reason = 'Surge 仍在更新本应用的节点资源';
          } else {
            const { settleMs } = engine.resourceUpdateWait();
            await sleep(engine, settleMs);
            reselected = await reselectAfterFallback(engine, ctx.selectionBefore, fallback);
            const failuresBaseline = servedFailureCount(host.failureCounters());
            const r1 = await observe(engine, url);
            await sleep(engine, settleMs);
            const r2 = await observe(engine, url);
            const committedDeployment = repos.deployments.get(committedGeneration);
            const details = await readDetails(engine, committedDeployment?.nodeManifest ?? [], ctx.fronts);
            // 资源部分按已提交版本严格核对；选择只要求两次读取一致（外部修改由 noteExternalSelection 报告，回滚从不改回）
            const assessment = assessResourceReadback({
              url,
              before: snapshotOf(ctx.before),
              after: snapshotOf(r1),
              afterRepeat: snapshotOf(r2),
              expectedMembers: committedNames,
              selectionBefore: r1.selection,
              records: host.audit(),
              mark,
              expectedGeneration: committedGeneration,
              toleranceMs: engine.resourceAuditToleranceMs(),
              details,
            });
            const readFailed = [...r1.failed, ...r2.failed];
            if (update.kind === 'downloaded' && assessment.ok && readFailed.length === 0) {
              const u = snapshotOf(r1).updatedAt!;
              const matched = matchAuditRecord(host.audit(), u, engine.resourceAuditToleranceMs(), mark, committedGeneration)!;
              const unchecked = assessment.level === 'full' ? [] : [...UNCHECKED_DETAIL_FIELDS];
              confirmation = {
                matchedSeq: matched.seq,
                snapshot: { updatedAt: u, error: snapshotOf(r1).error },
                clearNeedsRefresh: assessment.level === 'full' || readbackCovered(engine.capabilityViews(), unchecked),
                failuresBaseline,
              };
              observedSelection = r1.selection;
              confirmed = true;
            } else {
              reason = `读回不一致（${[...new Set([...assessment.failed, ...readFailed])].join('、')}）`;
            }
          }
        }
      } else {
        // Surge 没有载入候选：核对它仍是更新之前的已提交版本（选择的变化只可能来自外部，见 noteExternalSelection）
        const now = await observe(engine, url);
        const nowSnap = snapshotOf(now);
        const errorOk = nowSnap.error === afterSnap.error && (afterSnap.error === snapshotOf(ctx.before).error || (afterSnap.error !== null && isConnectionRefusedOrTimeout(afterSnap.error)));
        confirmed =
          now.failed.length === 0 &&
          membersMatchCommitted(now.members ?? [], committedNames) &&
          sameTime(nowSnap.updatedAt, ctx.before.resource?.lastUpdatedAt ?? null) &&
          errorOk;
        if (confirmed) observedSelection = now.selection;
        else reason = 'Surge 中的节点资源与更新之前的已提交版本不一致';
      }
    }
  } catch {
    confirmed = false;
    reason = reason ?? '读取或更新 Surge 失败';
  }

  let selectionNoted = false;
  if (confirmed) {
    // 确认的结果取自事务的返回值：事务（含提交）失败时没有确认，内存中的审计点、日志与事件都不发生
    let applied = null as NodeResourceConfirmed | null;
    try {
      applied = repos.tx(() => {
        repos.deployments.update(candidate, { state: 'rolled_back' });
        const pointer = readServedPointer(kv)!;
        let result: NodeResourceConfirmed | null = null;
        if (confirmation !== null) {
          result = confirmNodeResource(engine, { generation: pointer.committed.generation, ...confirmation });
        } else {
          // Surge 从未载入候选：刷新要求回到发布之前
          writeNeedsRefresh(kv, ctx.needsRefreshBefore);
        }
        selectionNoted = noteExternalSelection(engine, observedSelection);
        return result;
      });
    } catch {
      selectionNoted = false;
      confirmed = false;
      reason = '回滚结果无法记录';
    }
    if (applied !== null) applyNodeResourceConfirmation(engine, applied);
  }
  if (confirmed) {
    for (const u of batch.units) {
      if (u.outcome !== null) continue;
      u.outcome = 'failed';
      u.error = input.failure;
    }
    const selectionText = reselected
      ? '，原选择已恢复（选中的节点曾从成员中消失、回落到 REJECT）'
      : observedSelection === ctx.selectionBefore
        ? '，原选择未变'
        : `；SFE-ROUTE 的选择在发布期间被外部修改，回滚没有改动它${selectionNoted ? '（路由需要处理）' : ''}`;
    finishOps(engine, batch, {
      phase: 'FAILED',
      status: 'failed',
      error: input.failure,
      step: confirmation !== null ? `已回滚：Surge 重新载入已提交的节点资源并经读回确认${selectionText}` : `已回滚：Surge 没有载入候选版本，仍是已提交的节点资源${selectionText}`,
    });
    if (selectionNoted) {
      const route = repos.routeState.get();
      engine.emit({ route: true, environments: route.activeEnvironmentId ? [route.activeEnvironmentId] : [] });
    }
    return;
  }
  // 回滚无法确认：活动环境需要处理（从不改为 NORMAL、DIRECT 或其他出口）。之前一次成功回滚留下的 rollback_needs_reverify
  // （「已恢复原节点并保持阻断」）：SFE-ROUTE 的选择已无法确认，「已恢复原节点」不再成立——去掉，环境改显示路由需要处理（与对账
  // 发现选择被外部修改时相同，engine/reconcile.ts）。Surge 中的节点无法证明来自已提交版本：node_resource_unverified（只由经确认的
  // 读回清除；needsRefresh 保留，见 T1）。
  repos.deployments.update(candidate, { state: 'failed' });
  const route = repos.tx(() => {
    const r = repos.routeState.get();
    const kept = r.warnings.filter((w) => w !== 'rollback_needs_reverify');
    const warnings = new Set([...kept, NODE_RESOURCE_WARNING]);
    if (r.entryMode !== 'NORMAL') {
      warnings.add('external_selection_change');
      repos.routeState.update({ phase: 'attention', warnings: [...warnings] });
    } else {
      repos.routeState.update({ warnings: [...warnings] });
    }
    return r;
  });
  engine.log('warn', 'resource.unverified', { reasons: ['readback_unconfirmed'] });
  const body: ApiErrorBody = {
    code: 'READBACK_MISMATCH',
    message: `发布回滚失败：节点资源与选择无法确认（${reason ?? '原因不明'}），需要处理`,
    details: { cause: input.failure.code },
  };
  for (const u of batch.units) {
    if (u.outcome !== null) continue;
    u.outcome = 'failed';
    u.error = body;
  }
  finishOps(engine, batch, { phase: 'BLOCKED_NEEDS_ATTENTION', status: 'needs_attention', error: body, step: body.message });
  engine.emit({ route: true, surge: true, environments: route.activeEnvironmentId ? [route.activeEnvironmentId] : [] });
}

/** D10 的四项回环资源补测（发布门槛中这四项的说明合并为一句）。 */
const LOOPBACK_PUBLISH_KEYS: readonly CapabilityKey[] = ['loopback_resource_update', 'loopback_resource_auth', 'loopback_resource_restart', 'loopback_publish_crash'];

/**
 * 发布门槛不满足时停泊的说明。缺少回环资源补测中的任何一项时写明：这些补测通过并经确认前新版本保持待部署。缺少的记录含
 * resourceServe 门槛的任何一项（例如 Surge 版本变化让它们过期）时，本机资源服务也不再提供已提交的节点（503），不能说“已部署的
 * 节点不受影响”：Surge 已下载的节点是否保留（尤其在 Surge 重启之后）待 P0 loopback_resource_restart 实测。
 */
function publishGateBody(engine: Engine, views: ReturnType<Engine['capabilityViews']>, missing: CapabilityKey[]): ApiErrorBody {
  const base = capabilityError(views, missing, '发布', engine.versionGateNote(missing)).toBody();
  if (engine.versionGateNote(missing) !== null || !missing.some((k) => LOOPBACK_PUBLISH_KEYS.includes(k))) {
    const serveGated = missing.some((k) => (CAPABILITY_GATES.resourceServe as readonly CapabilityKey[]).includes(k));
    const tail = serveGated
      ? '；新版本保持待部署；这次停泊没有写入 Surge；这些实测记录在当前 Surge 版本下重新有效之前，本机资源服务不提供已提交的节点（Surge 已下载的节点是否保留，尤其在 Surge 重启之后，待 P0 loopback_resource_restart 实测）'
      : '；新版本保持待部署，已部署的节点不受影响';
    return { ...base, message: `${base.message.replace(/^发布失败：/, '发布暂停：')}${tail}` };
  }
  const others = views.filter((v) => missing.includes(v.key) && !LOOPBACK_PUBLISH_KEYS.includes(v.key)).map((v) => v.label);
  return {
    ...base,
    message:
      '发布暂停：回环资源单 key 更新、服务认证与端口占用、重启缓存、并发与崩溃补测尚未通过；新版本保持待部署' +
      (others.length > 0 ? `；另需实测：${others.join('、')}` : ''),
  };
}

// ---------- 结算 ----------

interface CommitInput {
  deployment: DeploymentRecord;
  plan: Plan;
  readback: { level: 'full' | 'partial'; unchecked: string[] };
  /** 读回完整，或读回不完整而未核对字段被 P0 记录覆盖：发布记录 verified、needsRefresh 清除。 */
  acceptable: boolean;
  /** 与读回的更新时间匹配的、候选代数的完整 200 的审计序号。 */
  matchedSeq: number;
  snapshot: { updatedAt: Date; error: string | null };
  /** 读回开始之前的失败答复计数（confirmNodeResource 的 failuresBaseline）。 */
  failuresBaseline: number;
  /** 本次标为已部署的目标（entryKey；commitDeployment 填写）。 */
  deployedNow?: Set<string>;
}

/**
 * 事务 T2：发布记录 verified/published、指针提交为本次代数（候选清空）、审计状态前移到匹配的记录并清除 node_resource_unverified
 * （confirmNodeResource；needsRefresh 只在可接受时清除，tokenSuspect 不变）、各目标的结算、移除与退役（保留已提交版本与最近一次
 * verified 发布的版本，retainedDeploymentKeys）。在一个事务中，抛错时全部不生效（调用方按读回失败回滚）。
 */
function commitDeployment(engine: Engine, batch: Batch, s: CommitInput): void {
  const { repos } = engine;
  const manifestKeys = new Set(s.plan.manifest.map((m) => entryKey(m.environmentId, m.proxyRevision)));
  const deployedNow = new Set<string>();
  const confirmed = repos.tx((): NodeResourceConfirmed => {
    repos.deployments.update(s.deployment.generation, {
      state: s.acceptable ? 'verified' : 'published',
      readbackLevel: s.readback.level,
      uncheckedFields: s.readback.unchecked,
    });
    const gen = commitCandidatePointer(engine.kv);
    if (gen !== s.deployment.generation) throw new SfeError('INTERNAL', '发布失败：提交的候选代数不一致');
    const result = confirmNodeResource(engine, { generation: gen, matchedSeq: s.matchedSeq, snapshot: s.snapshot, clearNeedsRefresh: s.acceptable, failuresBaseline: s.failuresBaseline });
    for (const u of batch.units) {
      if (u.outcome !== null) continue;
      const k = entryKey(u.target.environmentId, u.target.proxyRevision);
      if (!manifestKeys.has(k)) {
        u.outcome = 'failed';
        u.error = { code: 'INTERNAL', message: '发布失败：目标未进入节点资源' };
        continue;
      }
      repos.proxyRevisions.updateState(u.target.environmentId, u.target.proxyRevision, 'deployed');
      if (s.acceptable) {
        const env = repos.environments.get(u.target.environmentId)!;
        if (env.deployedProxyRevision !== null && env.deployedProxyRevision !== u.target.proxyRevision) {
          repos.proxyRevisions.updateState(env.id, env.deployedProxyRevision, 'superseded');
        }
        repos.environments.update(env.id, { deployedProxyRevision: u.target.proxyRevision });
        u.outcome = 'deployed';
        deployedNow.add(k);
      } else {
        u.outcome = 'partial';
        u.error = { code: 'READBACK_MISMATCH', message: '已部署，读回不完整：需要相应能力的实测记录覆盖未核对字段' };
      }
    }
    for (const opId of unitsByOp(batch.units).keys()) {
      repos.deployments.setOperationOutcome(s.deployment.generation, opId, opOutcome(batch.units, opId));
    }
    // 已移除的旧版本：retired，并回收不再被引用的代理秘密。仍被需要的版本不退役（revisionsStillNeeded：已提交版本或最近一次
    // verified 发布的清单——本次不可接受时最近一次 verified 是更早的那一次——环境的期望、已部署与已验证版本，进行中的操作）：只从
    // 资源中移除，已部署的记为 superseded，之后再由 retireStaleRevisions 退役。例如崩溃前 Surge 已载入、从未提交的候选中的期望
    // 版本：系统刷新把它从 Surge 中移除，但它仍是待部署的修改
    const needed = revisionsStillNeeded(engine, manifestKeys);
    const retiredNow = new Set<string>();
    for (const rev of s.plan.removed) {
      const k = entryKey(rev.environmentId, rev.revision);
      if (needed.has(k) && rev.state !== 'retired') {
        if (rev.state === 'deployed') repos.proxyRevisions.updateState(rev.environmentId, rev.revision, 'superseded');
        continue;
      }
      repos.proxyRevisions.updateState(rev.environmentId, rev.revision, 'retired');
      retiredNow.add(k);
      for (const ref of [rev.usernameRef, rev.passwordRef]) if (ref) engine.secrets.orphanIfUnreferenced(ref);
    }
    scrubRetiredDeploymentDigests(engine, retiredNow);
    retireStaleRevisions(engine, manifestKeys);
    return result;
  });
  // T2 已提交：审计点、日志与事件此时才生效（事务回滚时它们都不发生）
  applyNodeResourceConfirmation(engine, confirmed);
  s.deployedNow = deployedNow;
  if (s.plan.removed.length > 0) stepAll(engine, batch, `已移除不再使用的旧节点 ${s.plan.removed.length} 个`);
}

async function settle(engine: Engine, batch: Batch, s: CommitInput | null): Promise<void> {
  const { repos } = engine;
  const deployedNow = s?.deployedNow ?? new Set<string>();

  // 各目标：活动环境进入 WAITING_ROUTE（同一操作）；非活动环境预检或标记待实测
  const preflightAllowed = engine.missing(CAPABILITY_GATES.preflight).length === 0;
  const continuing = new Map<string, Unit>();
  for (const u of batch.units) {
    if (u.outcome !== 'deployed') continue;
    if (isActiveEnvironment(engine, u.target.environmentId)) {
      // 活动环境的新版本：同一操作进入 WAITING_ROUTE；活动版本已是目标时不需要切换
      if (repos.routeState.get().activeProxyRevision !== u.target.proxyRevision && !continuing.has(u.op.id)) continuing.set(u.op.id, u);
      continue;
    }
    const k = entryKey(u.target.environmentId, u.target.proxyRevision);
    if (s !== null && !deployedNow.has(k)) continue;
    // 没有提供新版本（目标此前已部署）：已有该版本的预检就不重复
    if (s === null && repos.probes.latest(u.target.environmentId, 'preflight')?.proxyRevision === u.target.proxyRevision) continue;
    const rev = repos.proxyRevisions.get(u.target.environmentId, u.target.proxyRevision)!;
    await recordPreflight(engine, { environmentId: u.target.environmentId, revision: rev, operationId: u.op.id, allowed: preflightAllowed, generation: repos.meta.configurationGeneration() });
  }

  // 结算每个操作
  const envs = new Set(batch.units.map((u) => u.target.environmentId));
  for (const op of batch.ops) {
    const cur = repos.operations.get(op.id);
    if (!cur || (cur.status !== 'queued' && cur.status !== 'running')) continue;
    const own = op.kind === 'import.batch' ? batch.units.filter((u) => (payloadOf(op).children ?? []).includes(u.op.id)) : batch.units.filter((u) => u.op.id === op.id);
    const results = op.kind === 'import.batch' ? childSummary(engine, batch, op) : unitResults(batch.units, op);
    const result = {
      ...(cur.result ?? {}),
      targets: results,
      ...(s ? { readbackLevel: s.readback.level, uncheckedFields: s.readback.unchecked, configurationGeneration: s.deployment.generation } : {}),
    };
    const cont = continuing.get(op.id);
    if (cont) {
      repos.operations.update(op.id, { result, resultRevision: cont.target.proxyRevision });
      enterWaitingRoute(engine, op.id, cont.target.environmentId, cont.target.proxyRevision);
      continue;
    }
    const final =
      own.length === 0 && s
        ? {
            phase: 'COMPLETED' as const,
            status: 'succeeded' as const,
            error: null,
            message: s.acceptable
              ? `已提供配置代数 ${s.deployment.generation} 并对本应用的节点资源单 key 更新一次，读回一致`
              : `已提供配置代数 ${s.deployment.generation} 并对本应用的节点资源单 key 更新一次，读回不完整（读回要求保留到下一次发布）`,
          }
        : finalPhase(engine, own);
    repos.tx(() => {
      repos.operations.update(op.id, { phase: final.phase, status: final.status, error: final.error, result });
      repos.operations.appendStep(op.id, final.phase, final.message);
    });
  }
  engine.emit({ operations: batch.ops.map((o) => o.id), environments: envs, route: continuing.size > 0, fronts: true, surge: s !== null });
}

/** 发布记录中清除后的资源摘要（不是任何内容的摘要，regenerate 从不与之相等）。 */
export const SCRUBBED_DIGEST = 'scrubbed';

/**
 * 含刚退役版本的旧发布记录：资源摘要按当时的节点资源内容计算，其中有这些版本的明文代理凭据；pepper 在同一个数据库中，留着就能
 * 从数据目录的副本离线核对猜测的旧凭据（§0「秘密的存放」）。这些发布已无法也不会再重建（重建只针对已提交版本，它与最近一次
 * verified 发布清单中的版本不退役——retainedDeploymentKeys；退役版本的凭据随后被回收），清除它们的摘要（工作配置一栏现在只有
 * 进程内的核对值 profileCheckOf，一并清除；升级前保存的 pepper 派生摘要由迁移 6 清除）。在调用方的结算事务中执行。
 */
export function scrubRetiredDeploymentDigests(engine: Engine, retired: ReadonlySet<string>): void {
  if (retired.size === 0) return;
  // LIMIT -1：全部发布记录（SQLite 的负数上限表示不限）
  for (const d of engine.repos.deployments.list(-1)) {
    if (d.resourceDigest === SCRUBBED_DIGEST && d.workingProfileDigest === null) continue;
    if (!d.nodeManifest.some((m) => retired.has(entryKey(m.environmentId, m.proxyRevision)))) continue;
    engine.repos.deployments.update(d.generation, { resourceDigest: SCRUBBED_DIGEST, workingProfileDigest: null });
  }
}

/**
 * 必须保留（不退役）的代理版本（entryKey）：指针中已提交版本的清单——启动、重新合并恢复与发布回滚都要重建并提供它，退役会回收
 * 它们的秘密（之后被清扫）并清除含它们的发布记录的摘要，之后只能 503 并要求刷新——以及最近一次 verified 发布的清单。发布结算、
 * retireStaleRevisions 与删除环境都按它保留。指针不存在时只有后者。
 */
export function retainedDeploymentKeys(engine: Engine): Set<string> {
  const out = new Set<string>();
  const add = (d: DeploymentRecord | null) => {
    for (const m of d?.nodeManifest ?? []) out.add(entryKey(m.environmentId, m.proxyRevision));
  };
  const pointer = readServedPointer(engine.kv);
  if (pointer !== null && pointer.committed.generation > 0) add(engine.repos.deployments.get(pointer.committed.generation));
  add(engine.repos.deployments.latestWithState(['verified']));
  return out;
}

/**
 * 仍被需要、不能退役的代理版本（entryKey）：本次资源清单、已提交版本与最近一次 verified 发布的清单（retainedDeploymentKeys）、
 * 未删除环境的期望、已部署与已验证版本、使用中的版本，以及进行中的操作引用的版本。
 */
function revisionsStillNeeded(engine: Engine, manifestKeys: ReadonlySet<string>): Set<string> {
  const { repos } = engine;
  const route = repos.routeState.get();
  const keep = new Set<string>(manifestKeys);
  for (const k of retainedDeploymentKeys(engine)) keep.add(k);
  for (const e of repos.environments.list()) {
    for (const n of [e.desiredProxyRevision, e.deployedProxyRevision, e.lastVerifiedProxyRevision]) if (n !== null) keep.add(entryKey(e.id, n));
  }
  if (route.activeEnvironmentId && route.activeProxyRevision !== null) keep.add(entryKey(route.activeEnvironmentId, route.activeProxyRevision));
  for (const op of repos.operations.listByStatus(['queued', 'running', 'waiting'])) {
    const p = payloadOf(op);
    if (p.route) keep.add(entryKey(p.route.targetEnvironmentId, p.route.proxyRevision));
    for (const t of p.targets ?? []) keep.add(entryKey(t.environmentId, t.proxyRevision));
  }
  return keep;
}

function retireStaleRevisions(engine: Engine, manifestKeys: ReadonlySet<string>): void {
  const { repos } = engine;
  const keep = revisionsStillNeeded(engine, manifestKeys);
  const retired = new Set<string>();
  for (const rev of repos.proxyRevisions.list({ state: ['desired', 'superseded'] })) {
    if (keep.has(entryKey(rev.environmentId, rev.revision))) continue;
    repos.proxyRevisions.updateState(rev.environmentId, rev.revision, 'retired');
    retired.add(entryKey(rev.environmentId, rev.revision));
    for (const ref of [rev.usernameRef, rev.passwordRef]) if (ref) engine.secrets.orphanIfUnreferenced(ref);
  }
  scrubRetiredDeploymentDigests(engine, retired);
}

function finalPhase(engine: Engine, units: readonly Unit[]): { phase: OperationPhase; status: OperationStatus; error: ApiErrorBody | null; message: string } {
  const { repos } = engine;
  if (units.length === 0) return { phase: 'COMPLETED', status: 'succeeded', error: null, message: '没有需要发布的修改' };
  const deployed = units.filter((u) => u.outcome === 'deployed');
  const partial = units.filter((u) => u.outcome === 'partial');
  const superseded = units.filter((u) => u.outcome === 'superseded');
  const failedUnits = units.filter((u) => u.outcome !== 'deployed' && u.outcome !== 'partial' && u.outcome !== 'superseded');
  if (deployed.length === 0 && partial.length === 0) {
    if (failedUnits.length === 0 && superseded.length > 0) return { phase: 'SUPERSEDED', status: 'superseded', error: null, message: '已被更新的版本取代' };
    const err = failedUnits[0]?.error ?? { code: 'INTERNAL', message: '发布失败' };
    return { phase: 'FAILED', status: 'failed', error: err, message: err.message };
  }
  if (deployed.length === 0) {
    return { phase: 'DEPLOYED_UNVERIFIED', status: 'parked', error: partial[0]!.error ?? null, message: '已部署，读回不完整' };
  }
  // 预检结果：全部 ok → READY_FOR_NEXT_OPEN；有失败 → FAILED（单目标）；其余 → DEPLOYED_UNVERIFIED
  const outcomes = deployed.map((u) => {
    const p = repos.probes.latest(u.target.environmentId, 'preflight');
    return p && p.proxyRevision === u.target.proxyRevision ? p.outcome : 'inconclusive';
  });
  if (outcomes.every((o) => o === 'ok')) {
    return { phase: 'READY_FOR_NEXT_OPEN', status: 'succeeded', error: null, message: '已部署并通过预检，可供下次使用' };
  }
  if (outcomes.some((o) => o === 'failed' || o === 'mismatch')) {
    if (units.length === 1) {
      return { phase: 'FAILED', status: 'failed', error: { code: 'PREFLIGHT_FAILED', message: '代理预检失败：前置或 SOCKS5 不可用' }, message: '已部署，代理预检失败' };
    }
  }
  return { phase: 'DEPLOYED_UNVERIFIED', status: 'succeeded', error: null, message: '已部署，待激活时由 Safari 实测' };
}

// ---------- 崩溃恢复 ----------

/**
 * 服务重启时仍处于 DEPLOYING / RECONCILING / ROLLING_BACK 的发布：从不重放。启动时（engine/node-resource.ts，执行器之前）
 * 已撤回候选指针并保留 needsRefresh；这里把仍为 candidate 的发布记录记为 failed，批次内全部操作记为 FAILED（UNKNOWN_STATE），
 * 之后按需排入一次系统强制刷新发布（单 key 更新并读回，使 Surge 回到已提交版本；门槛不满足时停泊）。中断的正是系统刷新本身时
 * 同一崩溃链最多自动重排一次（enqueueSystemRefreshAfterCrash）；重排的那次再中断时由用户重新同步（needsRefresh 保留）。
 */
export async function recoverPublish(engine: Engine, op: OperationRecord): Promise<void> {
  const { repos } = engine;
  for (const generation of batchGenerations(engine, op.id)) {
    const dep = repos.deployments.get(generation);
    if (dep && dep.state === 'candidate') repos.deployments.update(generation, { state: 'failed' });
  }
  const body: ApiErrorBody = { code: 'UNKNOWN_STATE', message: '发布中断：服务重启时发布未完成（不重放），请重新发布待部署的修改' };
  // 批次内全部操作：主操作、合并进来的操作、导入的逐行操作，以及该次发布记录中的操作
  for (const id of batchOperationIds(engine, op)) {
    const cur = repos.operations.get(id);
    if (!cur || (cur.status !== 'running' && cur.status !== 'queued')) continue;
    engine.updateOp(id, { phase: 'FAILED', status: 'failed', error: body }, body.message);
  }
  // 中断的正是系统刷新（且不是崩溃之后的那次重排）时同一崩溃链再自动排入一次，其余按需排入（node-resource.ts）
  enqueueSystemRefreshAfterCrash(engine, op.id);
}

/** 主操作发起的发布记录（代数）：发布记录的主操作，或发布包含的操作。 */
function batchGenerations(engine: Engine, primaryId: string): number[] {
  const { repos } = engine;
  const out = new Set<number>(repos.deployments.listByOperation(primaryId).map((d) => d.generation));
  for (const d of repos.deployments.list(200)) if (d.operationId === primaryId) out.add(d.generation);
  return [...out].sort((a, b) => a - b);
}

/** 一个发布批次涉及的全部操作编号（主操作在前）。 */
function batchOperationIds(engine: Engine, primary: OperationRecord): string[] {
  const { repos } = engine;
  const ids: string[] = [];
  const visit = (id: string): void => {
    if (ids.includes(id)) return;
    const op = id === primary.id ? primary : repos.operations.get(id);
    if (!op) return;
    ids.push(id);
    if (op.kind === 'import.batch') for (const child of payloadOf(op).children ?? []) visit(child);
  };
  visit(primary.id);
  for (const id of batchMembersOf(primary)) visit(id);
  for (const generation of batchGenerations(engine, primary.id)) {
    for (const row of repos.deployments.listOperations(generation)) visit(row.operationId);
  }
  return ids;
}

/**
 * 启动兜底（在执行器开始前调用）：仍为 running、却没有待处理 outbox 行、也不属于任何将被恢复的发布批次的
 * 非路由操作，再也不会被领取。记为 FAILED（UNKNOWN_STATE），不重放任何写入；待部署的修改由下一次发布收敛。
 */
export function failOrphanedOperations(engine: Engine): string[] {
  const { repos } = engine;
  const covered = new Set<string>();
  for (const op of repos.operations.listByStatus(['queued', 'running'])) {
    if (repos.outbox.pendingForOperation(op.id).length === 0) continue;
    // 将按发布路径执行或恢复的批次：其成员由主操作处理（已进入切换的发布按路由恢复，不再处理成员）
    if (isPublishKind(op.kind) && !payloadOf(op).route) for (const id of batchOperationIds(engine, op)) covered.add(id);
    else covered.add(op.id);
  }
  const body: ApiErrorBody = { code: 'UNKNOWN_STATE', message: '操作中断：服务重启时操作未完成且已无法继续，请检查后重试' };
  const failed: string[] = [];
  for (const op of repos.operations.listByStatus(['running'])) {
    if (covered.has(op.id) || isRouteOperation(op)) continue;
    engine.updateOp(op.id, { phase: 'FAILED', status: 'failed', error: body }, body.message);
    failed.push(op.id);
  }
  if (failed.length > 0) engine.log('warn', 'startup.orphaned_operations', { count: failed.length });
  return failed;
}

export { routeTargetOf };
