// 节点资源发布（docs/ARCHITECTURE.md §6.2）。自动与手动发布要求完全相同的门槛；门槛不足停在
// WAITING_DEPLOYMENT（没有任何“确认后强制发布”的开关）。写入前完成：工作配置身份、自动重载条件、
// 读回原语可用、前置存在、候选 --check、三项基线检查、唯一资源 key；写入后读回，不一致按同一路径回滚。
// 从不重载配置、更新全部或切换配置；读回不完整时只有 P0 记录覆盖未核对字段才算可接受。

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  CAPABILITY_GATES,
  ENTRY_RULESET_FILES,
  NODE_RESOURCE_FILE,
  ROUTE_GROUP_NAME,
  SfeError,
  type ApiErrorBody,
  type OperationPhase,
  type OperationStatus,
} from '@sfe/contract';
import type { SurgeExternalResource } from '../../ports.js';
import type { DeploymentRecord, FrontProxyRecord, NodeManifestEntry, OperationRecord, ProxyRevisionRecord } from '../../db/index.js';
import { isPublishKind, isRouteOperation, payloadOf, routeTargetOf, type PublishTarget } from '../../domain/operations.js';
import type { PublishTargetOutcome, PublishTargetResult } from '../../domain/views.js';
import { resourceFile } from '../../surge/generate.js';
import { BUILTIN_POLICIES } from '../../surge/rules.js';
import { describeOutsideChanges, entryBlockIsFirstRule, findForeignSfeObjects, parseProfile } from '../../surge/profile.js';
import { capabilityError, type Engine } from '../context.js';
import { readbackCovered } from '../capabilities.js';
import { checkCandidate } from '../candidate.js';
import { checkSegments, confirmResource, recordResourceIntent, resourcePreviousDigest } from '../ownership.js';
import { entryKey, generateResource, manifestMatches, resourceNodeNames, type ResourceEntry } from '../resource.js';
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

// ---------- 批次 ----------

/** 合并进主操作批次的其他发布类操作（记在主操作 payload 上，崩溃恢复据此找回它们）。 */
function batchMembersOf(op: Pick<OperationRecord, 'payload'>): string[] {
  const m = payloadOf(op).batchMembers;
  return Array.isArray(m) ? m.filter((x): x is string => typeof x === 'string') : [];
}

/**
 * 重新合并恢复节点资源后的刷新要求，持久记在引擎键值中：跟随的发布失败、停泊或服务重启后，下一次发布
 * （包括没有待部署修改的显式发布）仍会写入、定向刷新并读回；只有一次刷新与读回都成功的发布才清除它。
 */
const RESOURCE_REFRESH_KEY = 'resource:needsRefresh';

/** 重新合并在写入恢复的节点资源之前调用：之后任何一次发布都不能走“没有修改”的捷径，直到刷新并读回成功。 */
export function requireResourceRefresh(engine: Engine, operationId: string): void {
  engine.kv.set(RESOURCE_REFRESH_KEY, { operationId });
}

/** 即使节点清单没有变化，也要写入、定向刷新并读回（Surge 可能已加载被篡改的内容）。 */
function forcesRefresh(engine: Engine, batch: Batch): boolean {
  return engine.kv.get(RESOURCE_REFRESH_KEY) !== null || batch.ops.some((o) => payloadOf(o).forceRefresh === true);
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

function setAll(engine: Engine, batch: Batch, phase: OperationPhase, status: OperationStatus, step: string, error: ApiErrorBody | null = null): void {
  markAll(engine, batch, phase, status, step, error);
  emitBatch(engine, batch);
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
  currentNames: readonly string[];
  activeRequests: Array<{ policyName: string | null; leafPolicyName: string | null }> | null;
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
    input.activeRequests === null || input.activeRequests.some((r) => r.policyName === ROUTE_GROUP_NAME && r.leafPolicyName === null);
  const removed: ProxyRevisionRecord[] = [];
  for (const name of input.currentNames) {
    const rev = repos.proxyRevisions.byNodeName(name);
    if (!rev) continue;
    const key = entryKey(rev.environmentId, rev.revision);
    if (keep.has(key)) continue;
    const inUse =
      route.selectedNode === name ||
      referenced.has(name) ||
      undeterminable ||
      (input.activeRequests ?? []).some((r) => r.leafPolicyName === name || r.policyName === name);
    if (inUse && rev.state !== 'retired') keep.set(key, { environmentId: rev.environmentId, proxyRevision: rev.revision, revision: rev });
    else removed.push(rev);
  }
  const entries = [...keep.values()].sort((a, b) => {
    const sa = envById.get(a.environmentId)?.seq ?? 0;
    const sb = envById.get(b.environmentId)?.seq ?? 0;
    return sa - sb || a.proxyRevision - b.proxyRevision;
  });
  return { entries, removed };
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
    if (err instanceof PublishStop) {
      if (err.kind === 'park') parkAll(engine, batch, err.body);
      else failAll(engine, batch, err.body);
      return;
    }
    failAll(engine, batch, engine.errorBody(err, '发布失败：内部错误'));
  }
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
  if (missing.length > 0) throw park(capabilityError(views, missing, '发布').toBody());
  let keys;
  try {
    keys = await engine.keys();
  } catch (err) {
    throw fail(engine.errorBody(err));
  }
  void keys;
  const files = engine.profileFiles();
  if (!files) throw fail({ code: 'INTERNAL', message: '发布失败：无法访问工作配置目录' });

  // 前提：Surge 可达、当前配置是工作配置、自动重载设置与实测条件一致
  if (!engine.facts.reachable) throw fail({ code: 'SURGE_UNREACHABLE', message: '发布失败：无法连接 Surge' });
  if (engine.facts.onWorkingProfile !== true) throw fail({ code: 'EXTERNAL_PROFILE', message: '发布失败：Surge 当前配置不是固定工作配置，未写入任何内容' });
  const cond = engine.autoReloadCondition();
  const setting = engine.facts.autoReload;
  const autoOk = cond === 'any' || (setting !== null && cond !== null && cond === (setting ? 'on' : 'off'));
  if (!autoOk) {
    throw park({
      code: 'CAPABILITY_UNVERIFIED',
      message: '发布暂停：Surge 自动重载设置与实测条件不一致或无法读取',
      details: { autoReload: setting, verifiedCondition: cond },
    });
  }
  // 执行器从不写入它无法读回的内容
  const mech = engine.surge.mechanism();
  const unreadable = ['getGroupMembers', 'getGroupSelection', 'listExternalResources'].filter((p) => !mech[p] || mech[p] === 'unavailable');
  if (unreadable.length > 0) {
    throw park({ code: 'CAPABILITY_UNVERIFIED', message: '发布暂停：读回所需的 Surge 原语不可用', details: { primitives: unreadable } });
  }

  // 2. 前置存在于 listPolicies 且是固定节点
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

  // 3–4. 生成候选、--check、基线检查（基线在写入前变化时从头重来，有限次数）
  const maxAttempts = engine.deps.baselineRetries ?? 3;
  let plan: Awaited<ReturnType<typeof buildPlan>> | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    plan = await buildPlan(engine, batch, files, policies);
    const profileAfter = await readText(wp.path);
    const resourceAfter = await files.digest(NODE_RESOURCE_FILE);
    if (profileAfter !== null && files.digestContent(profileAfter) === plan.profileDigest && resourceAfter === plan.resourceDigestBefore) break;
    for (const op of batch.ops) engine.step(op.id, '工作配置或节点资源在生成期间被修改，重新生成', false);
    plan = null;
  }
  if (!plan) throw fail({ code: 'BASELINE_CHANGED', message: '发布失败：工作配置或节点资源在生成期间多次被修改' });

  const pending = batch.units.filter((u) => u.outcome === null);
  const forced = forcesRefresh(engine, batch);
  if (pending.length === 0 && plan.removed.length === 0 && plan.unchanged && !forced) {
    // 没有需要写入的内容：只结算各操作
    await settle(engine, batch, null);
    return;
  }
  if (forced) for (const op of batch.ops) engine.step(op.id, '重新合并后：写入并定向刷新节点资源，逐节点读回 Surge 已加载的内容', false);

  // 5. 资源 key（恰好一个）
  const resources = await engine.surge.listExternalResources().catch((err: unknown) => {
    throw fail(engine.errorBody(err, '发布失败：读取外部资源失败'));
  });
  const resourcePath = resolve(wp.directory, NODE_RESOURCE_FILE);
  const keysFor = (list: typeof resources) => list.filter((r) => locate(r.location, wp.directory) === resourcePath);
  const found = keysFor(resources);
  if (found.length === 0) throw fail({ code: 'RESOURCE_MISSING', message: '发布失败：Surge 中找不到指向节点资源文件的外部资源' });
  if (found.length > 1) throw fail({ code: 'NAME_COLLISION', message: '发布失败：多个外部资源指向节点资源文件' });
  const key = found[0]!.key;
  const before = found[0]!;
  const selectionBefore = await engine.surge.getGroupSelection(ROUTE_GROUP_NAME).catch((err: unknown) => {
    throw fail(engine.errorBody(err, '发布失败：读取 SFE-ROUTE 选择失败'));
  });
  let startedBefore: string | null = null;
  try {
    startedBefore = (await engine.surge.getRuntimeInfo()).startedAt?.toISOString() ?? null;
  } catch {
    startedBefore = null;
  }

  // 记录发布（代数）与各操作，再写入意图、原子替换、定向刷新
  const generation = plan.generation;
  const deployment = repos.tx(() => {
    const gen = repos.meta.bumpConfigurationGeneration();
    if (gen !== generation) throw new SfeError('INTERNAL', '发布失败：配置代数已变化');
    const d = repos.deployments.insert({
      generation: gen,
      workingProfileDigest: plan!.profileDigest,
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
    return d;
  });
  setAll(engine, batch, 'DEPLOYING', 'running', `发布节点资源（配置代数 ${generation}）`);
  recordResourceIntent(repos, engine.kv, plan.newDigest, batch.primary.id);
  try {
    await files.writeAtomic(NODE_RESOURCE_FILE, plan.content, plan.resourceDigestBefore);
  } catch (err) {
    // 原子替换失败时文件未变：意图回到写前状态
    if (plan.resourceDigestBefore !== null) confirmResource(repos, engine.kv, plan.resourceDigestBefore);
    repos.deployments.update(generation, { state: 'failed' });
    throw fail(engine.errorBody(err, '发布失败：写入节点资源失败'));
  }
  let refreshError: unknown = null;
  try {
    await engine.surge.updateExternalResource(key);
  } catch (err) {
    refreshError = err;
    setAll(engine, batch, 'RECONCILING', 'running', '定向刷新结果未知，先读取 Surge 事实再判断');
  }

  // 6. 读回
  const readback = await readBack(engine, {
    key,
    resourcePath,
    directory: wp.directory,
    before,
    manifest: plan.manifest,
    selectionBefore,
    startedBefore,
    workingProfile: wp,
    fronts,
  });
  if (!readback.ok) {
    const failure: ApiErrorBody = refreshError
      ? engine.errorBody(refreshError, '发布失败：定向刷新失败')
      : { code: readback.code, message: readback.message, details: { checks: readback.failed } };
    await rollbackPublish(engine, batch, { deployment, key, resourcePath, directory: wp.directory, failure, selectionBefore, fronts });
    return;
  }
  for (const n of readback.notes) for (const op of batch.ops) engine.step(op.id, n, false);

  const acceptable = readback.level === 'full' || readbackCovered(engine.capabilityViews(), readback.unchecked);
  await settle(engine, batch, { deployment, plan, readback, acceptable });
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
  content: string;
  newDigest: string;
  manifest: NodeManifestEntry[];
  removed: ProxyRevisionRecord[];
  profileDigest: string;
  resourceDigestBefore: string | null;
  unchanged: boolean;
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

function locate(location: string, directory: string): string {
  if (location.startsWith('file://')) return resolve(new URL(location).pathname);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(location)) return location;
  return resolve(directory, location);
}

async function buildPlan(
  engine: Engine,
  batch: Batch,
  files: NonNullable<ReturnType<Engine['profileFiles']>>,
  policies: { proxies: string[]; groups: string[] },
): Promise<Plan> {
  const { repos } = engine;
  const wp = engine.workingProfile()!;
  const profileText = await readText(wp.path);
  if (profileText === null) throw fail({ code: 'EXTERNAL_PROFILE', message: '发布失败：读取工作配置失败' });
  const profileDigest = files.digestContent(profileText);
  const resourceText = await files.read(NODE_RESOURCE_FILE);
  const resourceDigestBefore = await files.digest(NODE_RESOURCE_FILE);
  const currentNames = resourceNodeNames(resourceText);

  // 基线检查（3）：资源文件等于上次发布的摘要（或崩溃前意图的写前/写后摘要）
  const rec = repos.managedObjects.get('resource_file', NODE_RESOURCE_FILE);
  const resourceOk =
    rec !== null &&
    resourceDigestBefore !== null &&
    (rec.contentDigest === resourceDigestBefore ||
      (rec.state === 'pending_add' && resourcePreviousDigest(engine.kv) === resourceDigestBefore));
  if (!resourceOk) {
    throw fail({ code: 'BASELINE_CHANGED', message: '发布失败：节点资源文件已被外部修改或缺失，需要重新合并', details: { file: NODE_RESOURCE_FILE } });
  }

  // 基线检查（2）：受管理段内容与位置、非本应用 SFE- 对象
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
  const foreign = findForeignSfeObjects(profileText, { names: [ROUTE_GROUP_NAME], files: [NODE_RESOURCE_FILE, ...Object.values(ENTRY_RULESET_FILES)] });
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
  const { entries, removed } = retentionEntries(engine, { units: batch.units, currentNames, activeRequests });
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
    return buildPlan(engine, batch, files, policies);
  }
  if (!manifestMatches(generated.content, generated.manifest)) {
    throw fail({ code: 'VALIDATION_FAILED', message: '发布失败：生成的节点资源与预期清单不一致' });
  }

  // 名称冲突：Surge 中非本应用的 SFE- 名称；候选新节点名已被其他对象占用
  const ours = new Set<string>([ROUTE_GROUP_NAME, ...currentNames]);
  const foreignNames = [...policies.proxies, ...policies.groups].filter((n) => /^SFE-/i.test(n) && !ours.has(n));
  if (foreignNames.length > 0) {
    throw fail({ code: 'NAME_COLLISION', message: '发布失败：Surge 中有不属于本应用的 SFE- 名称', details: { names: foreignNames.slice(0, 20) } });
  }

  // 候选 --check：节点资源指向候选副本，其余引用指向真实文件
  const overrides = new Map<string, string>([[NODE_RESOURCE_FILE, generated.content]]);
  for (const name of Object.values(ENTRY_RULESET_FILES)) {
    const content = await files.read(name);
    if (content !== null) overrides.set(name, content);
  }
  let check;
  try {
    check = await checkCandidate(engine, { profileText, profileFileName: wp.path.slice(wp.directory.length + 1), sourceDirectory: wp.directory, overrides });
  } catch (err) {
    throw fail(engine.errorBody(err, '校验候选配置失败：内部错误'));
  }
  for (const op of batch.ops) {
    for (const r of check.resolved) engine.step(op.id, `候选引用 ${r.reference} → ${r.kind === 'candidate' ? '候选副本' : r.target}`, false);
  }
  if (!check.ok) {
    throw fail({ code: 'SURGE_CHECK_FAILED', message: `校验候选配置失败：${check.message}` });
  }

  // 受管理段之外的用户修改直接成为新基线
  const last = repos.deployments.latestWithState(['verified', 'published']);
  if (last?.workingProfileDigest && last.workingProfileDigest !== profileDigest) {
    for (const op of batch.ops) engine.step(op.id, '工作配置在受管理段之外有修改，已作为新基线', false);
  }
  void describeOutsideChanges;

  const newDigest = files.digestContent(generated.content);
  const unchanged = generated.manifest.length === currentNames.length && generated.manifest.every((m, i) => m.nodeName === currentNames[i]);
  return {
    generation,
    content: generated.content,
    newDigest,
    manifest: generated.manifest,
    removed,
    profileDigest,
    resourceDigestBefore,
    unchanged,
  };
}

// ---------- 读回 ----------

interface ReadbackInput {
  key: string;
  resourcePath: string;
  directory: string;
  before: { lastUpdatedAt: Date | null };
  manifest: readonly NodeManifestEntry[];
  selectionBefore: string | null;
  startedBefore: string | null;
  workingProfile: { path: string; name: string };
  fronts: ReadonlyMap<string, FrontProxyRecord>;
}

type ReadbackResult =
  | { ok: true; level: 'full' | 'partial'; unchecked: string[]; notes: string[] }
  | { ok: false; code: 'READBACK_MISMATCH' | 'EXTERNAL_PROFILE'; message: string; failed: string[] };

async function readBack(engine: Engine, input: ReadbackInput): Promise<ReadbackResult> {
  const failed: string[] = [];
  const notes: string[] = [];
  const { repos } = engine;
  try {
    const p = await engine.surge.getCurrentProfile();
    const same = p.path ? resolve(p.path) === resolve(input.workingProfile.path) : p.name === input.workingProfile.name;
    if (!same) return { ok: false, code: 'EXTERNAL_PROFILE', message: '发布读回失败：Surge 当前配置不是固定工作配置', failed: ['profile'] };
  } catch {
    failed.push('profile');
  }
  try {
    const started = (await engine.surge.getRuntimeInfo()).startedAt?.toISOString() ?? null;
    if (input.startedBefore !== null && started !== null && started !== input.startedBefore) notes.push('读回提示：Surge 启动时间在发布期间变化，可能发生了重载或重启');
    else notes.push('读回：未观察到 Surge 重载信号');
  } catch {
    notes.push('读回：无法读取 Surge 启动时间（未重载信号不可得）');
  }
  let resources: SurgeExternalResource[];
  try {
    resources = await engine.surge.listExternalResources();
  } catch {
    resources = [];
    failed.push('resources');
  }
  const found = resources.filter((r) => locate(r.location, input.directory) === input.resourcePath);
  if (found.length !== 1 || found[0]!.key !== input.key) failed.push('resource_key');
  else {
    const r = found[0]!;
    if (r.error) failed.push('resource_error');
    if (r.lastUpdatedAt !== null) {
      if (input.before.lastUpdatedAt !== null && r.lastUpdatedAt.getTime() <= input.before.lastUpdatedAt.getTime()) failed.push('resource_not_refreshed');
    } else notes.push('读回：资源更新时间不可得');
  }
  try {
    const members = await engine.surge.getGroupMembers(ROUTE_GROUP_NAME);
    const expected = input.manifest.map((m) => m.nodeName);
    const rest = members.slice(1);
    if (members[0]?.toUpperCase() !== 'REJECT') failed.push('first_member');
    if (rest.length !== expected.length || new Set(rest).size !== rest.length || !expected.every((n) => rest.includes(n))) failed.push('members');
  } catch {
    failed.push('members');
  }
  try {
    const sel = await engine.surge.getGroupSelection(ROUTE_GROUP_NAME);
    if (sel !== input.selectionBefore) failed.push('selection');
  } catch {
    failed.push('selection');
  }
  let level: 'full' | 'partial' = 'partial';
  let unchecked = [...UNCHECKED_DETAIL_FIELDS];
  const mech = engine.surge.mechanism();
  if (mech.getPolicyDetail && mech.getPolicyDetail !== 'unavailable') {
    let detailOk = true;
    for (const m of input.manifest) {
      const rev = repos.proxyRevisions.get(m.environmentId, m.proxyRevision);
      if (!rev) continue;
      try {
        const d = await engine.surge.getPolicyDetail(m.nodeName);
        const frontName = input.fronts.get(rev.frontProxyId)?.surgeName ?? null;
        if (d.server !== rev.host || d.port !== rev.port || d.underlyingProxy !== frontName) {
          failed.push(`detail:${m.nodeName}`);
          detailOk = false;
        }
      } catch {
        detailOk = false;
        break;
      }
    }
    if (detailOk) {
      level = 'full';
      unchecked = [];
    }
  }
  if (failed.length > 0) return { ok: false, code: 'READBACK_MISMATCH', message: '发布读回不一致：已按同一路径回滚', failed };
  return { ok: true, level, unchecked, notes };
}

// ---------- 回滚 ----------

async function rollbackPublish(
  engine: Engine,
  batch: Batch,
  ctx: {
    deployment: DeploymentRecord;
    key: string;
    resourcePath: string;
    directory: string;
    failure: ApiErrorBody;
    selectionBefore: string | null;
    fronts: ReadonlyMap<string, FrontProxyRecord>;
  },
): Promise<void> {
  const { repos } = engine;
  setAll(engine, batch, 'ROLLING_BACK', 'running', '读回不一致，回滚到上一份可接受的节点资源');
  const files = engine.profileFiles()!;
  const prev = repos.deployments
    .list(200)
    .find((d) => d.generation < ctx.deployment.generation && d.state === 'verified');
  let ok = false;
  try {
    const content = prev ? await regenerate(engine, prev, ctx.fronts) : resourceFile(0, []);
    if (content === null) throw new SfeError('READBACK_MISMATCH', '回滚失败：无法重建上一份节点资源');
    const currentDigest = await files.digest(NODE_RESOURCE_FILE);
    // 文件仍是本次发布刚写入的内容：先确认它属于本应用，回滚意图的写前摘要才是它；
    // 否则回滚写入失败或中途崩溃后，本应用自己的写入会被误报为外部修改（BASELINE_CHANGED）。
    const rec = repos.managedObjects.get('resource_file', NODE_RESOURCE_FILE);
    if (currentDigest !== null && rec?.state === 'pending_add' && rec.contentDigest === currentDigest) confirmResource(repos, engine.kv, currentDigest);
    const prevDigest = files.digestContent(content);
    recordResourceIntent(repos, engine.kv, prevDigest, batch.primary.id);
    try {
      await files.writeAtomic(NODE_RESOURCE_FILE, content, currentDigest);
    } catch (err) {
      // 原子替换失败时文件未变：意图回到写前状态
      if (currentDigest !== null && (await files.digest(NODE_RESOURCE_FILE)) === currentDigest) confirmResource(repos, engine.kv, currentDigest);
      throw err;
    }
    await engine.surge.updateExternalResource(ctx.key);
    const members = await engine.surge.getGroupMembers(ROUTE_GROUP_NAME);
    const expected = (prev?.nodeManifest ?? []).map((m) => m.nodeName);
    const rest = members.slice(1);
    const membersOk = members[0]?.toUpperCase() === 'REJECT' && rest.length === expected.length && expected.every((n) => rest.includes(n));
    let sel = await engine.surge.getGroupSelection(ROUTE_GROUP_NAME);
    if (sel !== ctx.selectionBefore && ctx.selectionBefore !== null && members.includes(ctx.selectionBefore)) {
      await engine.surge.selectGroupPolicy(ROUTE_GROUP_NAME, ctx.selectionBefore);
      sel = await engine.surge.getGroupSelection(ROUTE_GROUP_NAME);
    }
    ok = membersOk && sel === ctx.selectionBefore;
    if (ok) confirmResource(repos, engine.kv, prevDigest);
  } catch {
    ok = false;
  }
  repos.deployments.update(ctx.deployment.generation, { state: ok ? 'rolled_back' : 'failed' });
  if (ok) {
    for (const u of batch.units) {
      if (u.outcome !== null) continue;
      u.outcome = 'failed';
      u.error = ctx.failure;
    }
    finishOps(engine, batch, { phase: 'FAILED', status: 'failed', error: ctx.failure, step: '已回滚到上一份节点资源并恢复原选择' });
    return;
  }
  // 回滚无法确认：活动环境需要处理（从不改为 NORMAL、DIRECT 或其他出口）
  const route = repos.routeState.get();
  if (route.entryMode !== 'NORMAL') {
    repos.routeState.update({ phase: 'attention', warnings: [...route.warnings, 'external_selection_change'] });
  }
  const body: ApiErrorBody = { code: 'READBACK_MISMATCH', message: '发布回滚失败：节点资源与选择无法确认，需要处理', details: { cause: ctx.failure.code } };
  for (const u of batch.units) {
    if (u.outcome !== null) continue;
    u.outcome = 'failed';
    u.error = body;
  }
  finishOps(engine, batch, { phase: 'BLOCKED_NEEDS_ATTENTION', status: 'needs_attention', error: body, step: body.message });
  engine.emit({ route: true });
}

/** 按某次发布的清单重建其资源内容；摘要不一致（凭据已回收等）时返回 null。 */
async function regenerate(engine: Engine, d: DeploymentRecord, fronts: ReadonlyMap<string, FrontProxyRecord>): Promise<string | null> {
  const entries: ResourceEntry[] = [];
  for (const m of d.nodeManifest) {
    const rev = engine.repos.proxyRevisions.get(m.environmentId, m.proxyRevision);
    if (!rev) return null;
    entries.push({ environmentId: m.environmentId, proxyRevision: m.proxyRevision, revision: rev });
  }
  const g = await generateResource(engine, d.generation, entries, fronts);
  if (g.errors.size > 0) return null;
  const files = engine.profileFiles()!;
  return files.digestContent(g.content) === d.resourceDigest ? g.content : null;
}

// ---------- 结算 ----------

interface SettleInput {
  deployment: DeploymentRecord;
  plan: Plan;
  readback: { level: 'full' | 'partial'; unchecked: string[] };
  acceptable: boolean;
}

async function settle(engine: Engine, batch: Batch, s: SettleInput | null): Promise<void> {
  const { repos } = engine;
  const deployedNow = new Set<string>();
  if (s) {
    const manifestKeys = new Set(s.plan.manifest.map((m) => entryKey(m.environmentId, m.proxyRevision)));
    repos.tx(() => {
      repos.deployments.update(s.deployment.generation, {
        state: s.acceptable ? 'verified' : 'published',
        readbackLevel: s.readback.level,
        uncheckedFields: s.readback.unchecked,
      });
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
      // 已移除的旧版本：retired，并回收不再被引用的代理秘密
      for (const rev of s.plan.removed) {
        repos.proxyRevisions.updateState(rev.environmentId, rev.revision, 'retired');
        for (const ref of [rev.usernameRef, rev.passwordRef]) if (ref) engine.secrets.orphanIfUnreferenced(ref);
      }
      retireStaleRevisions(engine, manifestKeys);
    });
    confirmResource(repos, engine.kv, s.plan.newDigest);
    // 已写入、定向刷新且读回一致：重新合并留下的刷新要求已满足
    engine.kv.delete(RESOURCE_REFRESH_KEY);
    if (s.plan.removed.length > 0) {
      for (const op of batch.ops) engine.step(op.id, `已移除不再使用的旧节点 ${s.plan.removed.length} 个`, false);
    }
  }

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
    // 没有写入（目标此前已部署）：已有该版本的预检就不重复
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
        ? { phase: 'COMPLETED' as const, status: 'succeeded' as const, error: null, message: s.acceptable ? '已写入并定向刷新节点资源，读回一致' : '已写入并定向刷新节点资源，读回不完整' }
        : finalPhase(engine, own);
    repos.tx(() => {
      repos.operations.update(op.id, { phase: final.phase, status: final.status, error: final.error, result });
      repos.operations.appendStep(op.id, final.phase, final.message);
    });
  }
  engine.emit({ operations: batch.ops.map((o) => o.id), environments: envs, route: continuing.size > 0, fronts: true });
}

/**
 * 不在新资源中、也不再被任何地方需要的旧版本（从未部署就被取代的期望版本等）：retired 并回收秘密。
 * 只在执行器中（发布结算时）进行，避免与进行中的发布竞争。
 */
function retireStaleRevisions(engine: Engine, manifestKeys: ReadonlySet<string>): void {
  const { repos } = engine;
  const route = repos.routeState.get();
  const keep = new Set<string>(manifestKeys);
  for (const e of repos.environments.list()) {
    for (const n of [e.desiredProxyRevision, e.deployedProxyRevision, e.lastVerifiedProxyRevision]) if (n !== null) keep.add(entryKey(e.id, n));
  }
  if (route.activeEnvironmentId && route.activeProxyRevision !== null) keep.add(entryKey(route.activeEnvironmentId, route.activeProxyRevision));
  for (const op of repos.operations.listByStatus(['queued', 'running', 'waiting'])) {
    const p = payloadOf(op);
    if (p.route) keep.add(entryKey(p.route.targetEnvironmentId, p.route.proxyRevision));
    for (const t of p.targets ?? []) keep.add(entryKey(t.environmentId, t.proxyRevision));
  }
  for (const rev of repos.proxyRevisions.list({ state: ['desired', 'superseded'] })) {
    if (keep.has(entryKey(rev.environmentId, rev.revision))) continue;
    repos.proxyRevisions.updateState(rev.environmentId, rev.revision, 'retired');
    for (const ref of [rev.usernameRef, rev.passwordRef]) if (ref) engine.secrets.orphanIfUnreferenced(ref);
  }
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
 * 服务重启时仍处于 DEPLOYING / RECONCILING / ROLLING_BACK 的发布：不重放写入。按事实整理资源文件的归属
 * （写前或写后内容都属于本应用），操作记为 FAILED（UNKNOWN_STATE），由下一次发布按当前事实收敛。
 */
export async function recoverPublish(engine: Engine, op: OperationRecord): Promise<void> {
  const { repos } = engine;
  const rec = repos.managedObjects.get('resource_file', NODE_RESOURCE_FILE);
  const files = engine.profileFiles();
  if (rec?.state === 'pending_add' && files) {
    const current = await files.digest(NODE_RESOURCE_FILE);
    const prev = resourcePreviousDigest(engine.kv);
    if (current !== null && (current === rec.contentDigest || current === prev)) confirmResource(repos, engine.kv, current);
  }
  for (const generation of batchGenerations(engine, op.id)) {
    const dep = repos.deployments.get(generation);
    if (dep && dep.state === 'candidate') repos.deployments.update(generation, { state: 'failed' });
  }
  const body: ApiErrorBody = { code: 'UNKNOWN_STATE', message: '发布中断：服务重启时发布未完成，请重新发布待部署的修改' };
  // 批次内全部操作：主操作、合并进来的操作、导入的逐行操作，以及该次发布记录中的操作
  for (const id of batchOperationIds(engine, op)) {
    const cur = repos.operations.get(id);
    if (!cur || (cur.status !== 'running' && cur.status !== 'queued')) continue;
    engine.updateOp(id, { phase: 'FAILED', status: 'failed', error: body }, body.message);
  }
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
