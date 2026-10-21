// 路由操作（docs/ARCHITECTURE.md §6.3–§6.5）：激活（受控切换）、Safari 重测、普通模式、活动环境改代理后的
// WAITING_ROUTE，以及等待、核对、回滚。所有 Surge 写入在执行器内发生：入口经配置的 EntryController 逐位切换
// 并读回，结束 Safari 连接只按已确认的进程路径。失败、超时、取消一律回滚到切换前的已验证节点并保持阻断，
// 从不回退到 NORMAL、DIRECT 或其他买家出口；回滚无法确认 → BLOCKED_NEEDS_ATTENTION。

import {
  CAPABILITY_GATES,
  ROUTE_GROUP_NAME,
  SfeError,
  buildVerifyUrl,
  type ActivationSnapshot,
  type ApiErrorBody,
  type CapabilityKey,
  type EntryMode,
  type KillResult,
  type RollbackResult,
  type RouteWarning,
} from '@sfe/contract';
import { isIP } from 'node:net';
import type { OperationRecord, RouteStateRecord } from '../../db/index.js';
import { newRoutePayload, payloadOf, type RoutePayload } from '../../domain/operations.js';
import { LOSS_OF_CONTROL_WARNINGS, REUSE_BLOCKING_WARNINGS, hasAny, safariProbeCurrent } from '../../domain/route-rules.js';
import { probeView } from '../../domain/views.js';
import type { EntryController, EntryReadback, EntryTransitionOptions } from '../../ports.js';
import { findVerificationRequest } from '../../surge/correlate.js';
import { knownModeOfBits } from '../../surge/entry/plan.js';
import { killSafariConnections } from '../../surge/safari-connections.js';
import type { Engine } from '../context.js';
import { managedSegmentsChanged, reconcile } from '../reconcile.js';
import { confirmationNeeded, needsConfirmationError } from '../route-control.js';
import { currentPreflight, recordPreflight } from './probes.js';

// ---------- 小工具 ----------

/**
 * 撤销本应用入口（普通模式、回滚）的入口切换选项：只有这些方向可以改写被外部修改的本应用入口文件、逐条清理无法按位确定的
 * 本应用临时规则（§5.5）。清理的每一步（运行时读回确认之后）写入一条操作步骤，并累积到操作结果 entryCleanup（脱敏），
 * 之后失败也保留。
 */
function undoOptions(engine: Engine, opId: string): EntryTransitionOptions {
  return {
    undo: true,
    onCleanup: (c) => {
      const { repos } = engine;
      const safe = engine.scrubber.scrubDeep({ ...c });
      repos.tx(() => {
        const cur = repos.operations.get(opId)!;
        const prev = cur.result?.entryCleanup;
        repos.operations.update(opId, { result: { ...(cur.result ?? {}), entryCleanup: [...(Array.isArray(prev) ? prev : []), safe] } });
      });
      const kind = c.kind === 'unrecognized' ? '无法识别的规则' : c.kind;
      engine.step(opId, `撤销入口时逐条清理本应用的临时规则：${c.action === 'add' ? '加入' : '移除'} ${kind}「${c.rule}」（运行时读回确认）`);
    },
  };
}

function routePayload(op: OperationRecord): RoutePayload {
  const r = payloadOf(op).route;
  if (!r) throw new SfeError('INTERNAL', '路由操作缺少参数');
  return r;
}

function savePayload(engine: Engine, opId: string, patch: Partial<RoutePayload>): RoutePayload {
  const op = engine.repos.operations.get(opId)!;
  const next = { ...routePayload(op), ...patch };
  engine.repos.operations.update(opId, { payload: { ...payloadOf(op), route: next } });
  return next;
}

function addSeconds(engine: Engine, sec: number): string {
  return new Date(engine.now().getTime() + sec * 1000).toISOString();
}

/** 入口错误中的“最后确认状态”。 */
function confirmedModeFrom(err: unknown, fallback: EntryMode): EntryMode {
  if (err instanceof SfeError && err.details && 'lastConfirmedBits' in err.details) {
    const bits = err.details.lastConfirmedBits as Parameters<typeof knownModeOfBits>[0] | null;
    if (bits === null) return 'UNKNOWN';
    return knownModeOfBits(bits) ?? 'UNKNOWN';
  }
  return fallback;
}

export function isActiveEnvironment(engine: Engine, environmentId: string): boolean {
  const route = engine.repos.routeState.get();
  return route.activeEnvironmentId === environmentId && route.entryMode !== 'NORMAL';
}

function routeSnapshot(route: RouteStateRecord): ActivationSnapshot {
  // 切换进行中被取代时，沿用最初的切换前状态（最后一次已确认的路由）
  if ((route.phase === 'switching' || route.phase === 'awaiting_safari_verify' || route.phase === 'rolling_back') && route.activationSnapshot) {
    return { ...route.activationSnapshot, previousRouteEpoch: route.routeEpoch };
  }
  return {
    previousEnvironmentId: route.activeEnvironmentId,
    previousProxyRevision: route.activeProxyRevision,
    previousSelectedNode: route.selectedNode,
    previousEntryMode: route.entryMode,
    previousSafariProbeId: null,
    previousRouteEpoch: route.routeEpoch,
    previousPhase: route.phase,
  };
}

class RouteFailure extends Error {
  constructor(readonly body: ApiErrorBody) {
    super(body.message);
  }
}

function failBody(engine: Engine, err: unknown, fallback: string): ApiErrorBody {
  if (err instanceof RouteFailure) return err.body;
  return engine.errorBody(err, fallback);
}

/** 激活门槛缺失（details.missing 列出缺失项与过期原因）。 */
function capabilityFailure(engine: Engine, missing: readonly CapabilityKey[], prefix: string, suffix: string): ApiErrorBody {
  const views = engine.capabilityViews();
  return {
    code: 'CAPABILITY_UNVERIFIED',
    message: `${prefix}${views.filter((v) => missing.includes(v.key)).map((v) => v.label).join('、')}${suffix}`,
    details: { missing: missing.map((k) => ({ key: k, staleReasons: views.find((v) => v.key === k)?.staleReasons ?? [] })) },
  };
}

/** 本应用文件或受管理段是否被外部修改（撤销入口会改写被修改的入口文件，但保留 managed_segments_changed）。 */
async function segmentsChangedBefore(engine: Engine, route: RouteStateRecord): Promise<boolean> {
  if (route.warnings.includes('managed_segments_changed')) return true;
  try {
    return (await managedSegmentsChanged(engine)) === true;
  } catch {
    return false;
  }
}

/**
 * 写入之前失败（第 1–3 步）：本操作经 supersedeWaiting 接手了过渡中的路由（被取代的激活停在 VERIFY_ONLY 等待，
 * 切换中或回滚中）时，没有其他操作负责它——按激活快照回滚（阻断并恢复切换前节点）；否则只标为失败，不碰路由。
 */
async function failBeforeSwitch(engine: Engine, opId: string, body: ApiErrorBody): Promise<void> {
  const cur = engine.repos.operations.get(opId)!;
  if (cur.status !== 'running' && cur.status !== 'queued') return;
  const route = engine.repos.routeState.get();
  if (ownsTransition(route, opId)) {
    await rollbackActivation(engine, opId, body, engine.entryController(() => opId), route.entryMode);
    return;
  }
  engine.updateOp(opId, { phase: 'FAILED', status: 'failed', error: body }, body.message, { route: true });
}

/** 本操作负责一个过渡中的路由（切换中、VERIFY_ONLY 等待、回滚中，且有激活快照）：失败或中断都只能按快照回滚。 */
function ownsTransition(route: RouteStateRecord, opId: string): boolean {
  return (
    route.operationId === opId &&
    (route.phase === 'switching' || route.phase === 'awaiting_safari_verify' || route.phase === 'rolling_back') &&
    route.activationSnapshot !== null
  );
}

// ---------- 活动环境发布 → WAITING_ROUTE ----------

/** 活动环境的新版本已部署：同一操作停在 WAITING_ROUTE，等待绑定场景到达（不阻断 Safari）。 */
export function enterWaitingRoute(engine: Engine, opId: string, environmentId: string, proxyRevision: number): void {
  const { repos } = engine;
  const rev = repos.proxyRevisions.get(environmentId, proxyRevision)!;
  const route = repos.routeState.get();
  const deadline = addSeconds(engine, repos.settings.get('profileArrivalTimeoutSec'));
  const op = repos.operations.get(opId)!;
  const payload = newRoutePayload({
    targetEnvironmentId: environmentId,
    proxyRevision,
    nodeName: rev.nodeName,
    purpose: 'apply_new_revision',
    expectedActiveEnvironmentId: route.activeEnvironmentId,
    oldSessionPolicy: route.oldSessionPolicy,
    stage: 'waiting_route',
    arrivalDeadline: deadline,
  });
  repos.tx(() => {
    repos.operations.update(opId, {
      payload: { ...payloadOf(op), route: payload },
      phase: 'WAITING_ROUTE',
      status: 'waiting',
      environmentId: op.environmentId ?? environmentId,
    });
    repos.operations.appendStep(opId, 'WAITING_ROUTE', '新版本已部署：在绑定的 Safari 场景中打开扩展即可切换，期间旧版本继续使用');
    repos.outbox.enqueue(opId, 'arrival_timeout', deadline);
  });
  engine.emit({ operations: [opId], environments: [environmentId] });
}

// ---------- 执行入口 ----------

export async function runActivation(engine: Engine, op: OperationRecord): Promise<void> {
  const p = routePayload(op);
  engine.updateOp(op.id, { status: 'running', phase: 'VALIDATING' }, '开始检查激活条件');
  try {
    await prepareAndSwitch(engine, op.id, { allowReuse: p.flow === 'activate' });
  } catch (err) {
    await failBeforeSwitch(engine, op.id, failBody(engine, err, '激活失败：内部错误'));
  }
}

/** 第 1–3 步（复用、受控检查、预检）后进入切换；任何失败都不碰路由。 */
async function prepareAndSwitch(engine: Engine, opId: string, opts: { allowReuse: boolean }): Promise<void> {
  const { repos } = engine;
  let op = repos.operations.get(opId)!;
  let p = routePayload(op);
  const env = repos.environments.get(p.targetEnvironmentId);
  const rev = repos.proxyRevisions.get(p.targetEnvironmentId, p.proxyRevision);
  if (!env || env.deletedAt || !rev) throw new RouteFailure({ code: 'NOT_FOUND', message: '激活失败：环境或版本不存在' });
  await engine.readBasicFacts();
  const missing = engine.activationMissing();
  if (missing.length > 0) throw new RouteFailure(capabilityFailure(engine, missing, '激活失败：', '尚未通过实测'));
  const ctrl = engine.entryController(() => opId);
  if (!ctrl) throw new RouteFailure({ code: 'CAPABILITY_UNVERIFIED', message: '激活失败：入口策略或 Safari 进程路径尚未确认' });

  // 1. 复用（只读）
  if (opts.allowReuse) {
    const reused = await tryReuse(engine, opId, p, ctrl);
    if (reused) return;
    op = repos.operations.get(opId)!;
    p = routePayload(op);
    if (p.flow === 'probe') return;
  }

  // 2. 受控检查（写入之前）
  await checkSwitchPreconditions(engine, p, ctrl);

  // 3. 预检：independent_node_preflight 通过时在阻断之前；否则推迟到选择之后经 SFE-ROUTE
  const preflightOk = engine.missing(CAPABILITY_GATES.preflight).length === 0;
  if (preflightOk) {
    let probe = currentPreflight(engine, env.id, rev.revision);
    if (!probe) {
      probe = await recordPreflight(engine, { environmentId: env.id, revision: rev, operationId: opId, allowed: true, generation: repos.meta.configurationGeneration() });
      engine.emit({ environments: [env.id] });
      if (probe.outcome !== 'ok') throw new RouteFailure({ code: 'PREFLIGHT_FAILED', message: '代理预检失败：前置或 SOCKS5 不可用，路由未改变' });
    }
    engine.updateOp(opId, { phase: 'PREFLIGHT_OK' }, '代理预检通过');
  } else {
    p = savePayload(engine, opId, { preflightDeferred: true });
    engine.step(opId, '独立预检能力未通过：预检推迟到阻断 Safari 并选择节点之后经 SFE-ROUTE 执行');
  }
  await executeSwitch(engine, opId, ctrl);
}

/** 第 1 步复用：完全受控且实测有效 → 直接完成；实测过期或不是 ok → 改为 Safari 重测（不切换）。 */
async function tryReuse(engine: Engine, opId: string, p: RoutePayload, ctrl: EntryController): Promise<boolean> {
  const { repos } = engine;
  const route = repos.routeState.get();
  if (route.activeEnvironmentId !== p.targetEnvironmentId || route.activeProxyRevision !== p.proxyRevision || route.phase !== 'active_verified') return false;
  if (hasAny(route.warnings, REUSE_BLOCKING_WARNINGS).length > 0) return false;
  let mode: EntryMode = 'UNKNOWN';
  let selection: string | null = null;
  try {
    mode = (await ctrl.read()).mode;
    selection = await engine.surge.getGroupSelection(ROUTE_GROUP_NAME);
  } catch {
    return false;
  }
  if (mode !== 'ACTIVE' || selection !== p.nodeName) return false;
  const probe = repos.probes.latest(p.targetEnvironmentId, 'safari');
  const probeOk =
    safariProbeCurrent(route, probe, engine.now()) && !route.warnings.includes('probe_failed') && !route.warnings.includes('exit_ip_mismatch');
  if (probeOk) {
    engine.updateOp(opId, { phase: 'ACTIVE_VERIFIED', status: 'succeeded', resultRevision: p.proxyRevision, result: { reused: true }, routeEpoch: route.routeEpoch }, '环境已在使用中且实测有效：直接复用，未切换、未断连', { route: true });
    repos.outbox.cancelForOperation(opId);
    return true;
  }
  // 实测过期：改为当前环境的 Safari 重测（不递增 epoch、不阻断、不断连）
  savePayload(engine, opId, { flow: 'probe', purpose: 'probe_safari' });
  repos.operations.update(opId, { probeKind: 'safari' });
  engine.step(opId, '环境已在使用中，但实测已过期：改为 Safari 重测，不切换');
  await startProbeWaiting(engine, opId, ctrl);
  return true;
}

/** 第 2 步受控检查：任一不满足 → 失败且不碰路由。 */
async function checkSwitchPreconditions(engine: Engine, p: RoutePayload, ctrl: EntryController): Promise<void> {
  const { repos } = engine;
  const route = repos.routeState.get();
  if ((route.activeEnvironmentId ?? null) !== (p.expectedActiveEnvironmentId ?? null)) {
    const details = confirmationNeeded(engine, p.targetEnvironmentId) ?? {
      reason: 'other_environment_active' as const,
      currentEnvironmentId: route.activeEnvironmentId,
      currentEnvironmentLabel: null,
      otherProfilesOpen: [],
      options: ['closed_confirmed', 'keep_open_acknowledged'] as const,
      limitation: null,
    };
    throw new RouteFailure(needsConfirmationError('激活', { ...details, options: [...details.options] }).toBody());
  }
  const f = engine.facts;
  if (!f.reachable) throw new RouteFailure({ code: 'SURGE_UNREACHABLE', message: '激活失败：无法连接 Surge，路由未改变' });
  if (f.onWorkingProfile !== true) throw new RouteFailure({ code: 'EXTERNAL_PROFILE', message: '激活失败：Surge 当前配置不是固定工作配置，路由未改变' });
  if (f.takeover.enhancedMode === false && f.takeover.systemProxy === false) {
    throw new RouteFailure({ code: 'TAKEOVER_LOST', message: '激活失败：Surge 增强模式与系统代理都已关闭，路由未改变' });
  }
  if (f.takeover.outboundMode !== null && f.takeover.outboundMode !== 'rule') {
    throw new RouteFailure({ code: 'TAKEOVER_LOST', message: '激活失败：Surge 出站模式不是规则模式，路由未改变' });
  }
  const readback = await ctrl.read();
  if (readback.precedenceIssues.some((i) => i.severity === 'blocking')) {
    throw new RouteFailure({
      code: 'PRECEDENCE_VIOLATION',
      message: '激活失败：有规则排在本应用入口之前，可能抢先匹配 Safari 流量',
      details: { precedenceIssues: readback.precedenceIssues },
    });
  }
  // 被外部修改的本应用入口文件从不被激活采纳或悄悄改写（§5.5）：写入之前停止，由普通模式（会改写它们）或维护流程恢复
  if (readback.changedOwnedFiles && readback.changedOwnedFiles.length > 0) {
    throw new RouteFailure({
      code: 'BASELINE_CHANGED',
      message: '激活失败：本应用的入口文件已被外部修改，路由未改变；进入普通模式会改写这些文件',
      details: { files: readback.changedOwnedFiles },
    });
  }
  const rev = repos.proxyRevisions.get(p.targetEnvironmentId, p.proxyRevision)!;
  const front = repos.frontProxies.get(rev.frontProxyId);
  const policies = await engine.surge.listPolicies();
  if (!front || front.retired || !policies.proxies.includes(front.surgeName)) {
    throw new RouteFailure({ code: 'FRONT_PROXY_MISSING', message: '激活失败：前置节点不在 Surge 中，路由未改变' });
  }
  const members = await engine.surge.getGroupMembers(ROUTE_GROUP_NAME);
  if (!members.includes(p.nodeName)) throw new RouteFailure({ code: 'NODE_NOT_DEPLOYED', message: '激活失败：目标节点不在 SFE-ROUTE 中，路由未改变' });
}

/** 第 5–9 步：epoch 递增与快照 → BLOCKED → 结束 Safari 连接 → 选择并读回 →（推迟的预检）→ VERIFY_ONLY 等待。 */
async function executeSwitch(engine: Engine, opId: string, ctrl: EntryController): Promise<void> {
  const { repos } = engine;
  const before = repos.routeState.get();
  const snapshot = routeSnapshot(before);
  snapshot.previousSafariProbeId =
    snapshot.previousEnvironmentId !== null ? (repos.probes.latest(snapshot.previousEnvironmentId, 'safari')?.id ?? null) : null;
  const epoch = before.routeEpoch + 1;
  repos.tx(() => {
    repos.routeState.update({ routeEpoch: epoch, phase: 'switching', operationId: opId, activationSnapshot: snapshot, awaitingDeadline: null });
    const op = repos.operations.get(opId)!;
    repos.operations.update(opId, { routeEpoch: epoch, payload: { ...payloadOf(op), route: { ...routePayload(op), stage: 'switching' } } });
  });
  engine.emit({ route: true, operations: [opId] });
  let confirmed: EntryMode = before.entryMode;
  let killResults: KillResult[] = [];
  try {
    // 6. 阻断
    await ctrl.transition('BLOCKED');
    confirmed = 'BLOCKED';
    repos.routeState.update({ entryMode: 'BLOCKED', entryModeVerifiedAt: engine.nowIso() });
    engine.updateOp(opId, { phase: 'SAFARI_BLOCKED' }, '已阻断 Safari 新请求（读回确认），暂停自动打开订单与填充', { route: true });
    // 7. 结束 Safari 连接（只按已确认的进程路径）
    const cfg = engine.entryConfig();
    try {
      killResults = await killSafariConnections(engine.surge, { processPaths: cfg.processPaths, verifyHost: cfg.verifyHost, now: () => engine.now(), bestEffort: false });
    } catch (err) {
      if (err instanceof SfeError && Array.isArray(err.details?.killResults)) killResults = err.details.killResults as KillResult[];
      throw err;
    } finally {
      const cur = repos.operations.get(opId)!;
      repos.operations.update(opId, { result: { ...(cur.result ?? {}), killResults } });
    }
    engine.step(opId, `已结束 Safari 连接 ${killResults.filter((k) => k.ok).length} 条`);
    // 8. 选择目标节点并读回
    const p = routePayload(repos.operations.get(opId)!);
    await engine.surge.selectGroupPolicy(ROUTE_GROUP_NAME, p.nodeName);
    const sel = await engine.surge.getGroupSelection(ROUTE_GROUP_NAME);
    if (sel !== p.nodeName) throw new SfeError('READBACK_MISMATCH', '切换失败：SFE-ROUTE 选择读回与目标不一致');
    repos.routeState.update({ selectedNode: sel });
    engine.step(opId, '已选择目标节点（读回确认）');
    if (p.preflightDeferred) {
      const rev = repos.proxyRevisions.get(p.targetEnvironmentId, p.proxyRevision)!;
      const probe = await recordPreflight(engine, {
        environmentId: p.targetEnvironmentId,
        revision: rev,
        operationId: opId,
        allowed: true,
        generation: repos.meta.configurationGeneration(),
        viaRoute: { group: ROUTE_GROUP_NAME, routeEpoch: epoch },
      });
      if (probe.outcome !== 'ok') throw new SfeError('PREFLIGHT_FAILED', '代理预检失败：经 SFE-ROUTE 测试不通过');
      engine.updateOp(opId, { phase: 'PREFLIGHT_OK' }, '经 SFE-ROUTE 的预检通过（Safari 已阻断，Chrome 不命中 SFE-ROUTE）', { environments: [p.targetEnvironmentId] });
    }
    // 9. 只开放检测服务
    await ctrl.transition('VERIFY_ONLY');
    confirmed = 'VERIFY_ONLY';
    const deadline = addSeconds(engine, repos.settings.get('profileArrivalTimeoutSec'));
    repos.tx(() => {
      repos.routeState.update({ entryMode: 'VERIFY_ONLY', entryModeVerifiedAt: engine.nowIso(), phase: 'awaiting_safari_verify', awaitingDeadline: deadline });
      const op = repos.operations.get(opId)!;
      repos.operations.update(opId, {
        phase: 'VERIFY_ONLY',
        status: 'waiting',
        payload: { ...payloadOf(op), route: { ...routePayload(op), stage: 'verify_only', arrivalDeadline: deadline } },
      });
      repos.operations.appendStep(opId, 'VERIFY_ONLY', '只开放检测服务：请在绑定的 Safari 场景中打开扩展完成出口检测');
      repos.outbox.enqueue(opId, 'arrival_timeout', deadline);
    });
    engine.emit({ route: true, operations: [opId], environments: [p.targetEnvironmentId] });
  } catch (err) {
    const mode = confirmedModeFrom(err, confirmed);
    await rollbackActivation(engine, opId, engine.errorBody(err, '切换失败：内部错误'), ctrl, mode);
  }
}

// ---------- Safari 重测 ----------

export async function runProbeSafari(engine: Engine, op: OperationRecord): Promise<void> {
  engine.updateOp(op.id, { status: 'running', phase: 'VALIDATING' }, '开始检查重测条件');
  try {
    await engine.readBasicFacts();
    const ctrl = engine.entryController(() => op.id);
    if (!ctrl) throw new RouteFailure({ code: 'CAPABILITY_UNVERIFIED', message: '重新检测失败：入口策略或 Safari 进程路径尚未确认' });
    await startProbeWaiting(engine, op.id, ctrl);
  } catch (err) {
    const body = failBody(engine, err, '重新检测失败：内部错误');
    engine.updateOp(op.id, { phase: 'FAILED', status: 'failed', error: body }, body.message);
  }
}

/** §6.4：只针对当前 epoch 中 ACTIVE_VERIFIED 的活动环境，读回入口为 ACTIVE、无失控类警告；不写入任何东西。 */
async function startProbeWaiting(engine: Engine, opId: string, ctrl: EntryController): Promise<void> {
  const { repos } = engine;
  const p = routePayload(repos.operations.get(opId)!);
  const route = repos.routeState.get();
  if (route.activeEnvironmentId !== p.targetEnvironmentId || route.phase !== 'active_verified') {
    throw new RouteFailure({ code: 'VALIDATION_FAILED', message: '重新检测失败：该环境不是当前使用中且已验证的环境' });
  }
  const lost = hasAny(route.warnings, LOSS_OF_CONTROL_WARNINGS);
  if (lost.length > 0) throw new RouteFailure({ code: 'UNKNOWN_STATE', message: '重新检测失败：路由已失去控制，请重新使用此环境或进入普通模式', details: { warnings: lost } });
  const readback = await ctrl.read();
  if (readback.mode !== 'ACTIVE') throw new RouteFailure({ code: 'UNKNOWN_STATE', message: '重新检测失败：Safari 入口读回不是使用中模式' });
  const sel = await engine.surge.getGroupSelection(ROUTE_GROUP_NAME);
  if (sel !== route.selectedNode || sel === null) throw new RouteFailure({ code: 'READBACK_MISMATCH', message: '重新检测失败：SFE-ROUTE 选择与记录不一致' });
  const deadline = addSeconds(engine, repos.settings.get('profileArrivalTimeoutSec'));
  repos.tx(() => {
    const op = repos.operations.get(opId)!;
    repos.operations.update(opId, {
      phase: 'VALIDATING',
      status: 'waiting',
      probeKind: 'safari',
      routeEpoch: route.routeEpoch,
      payload: {
        ...payloadOf(op),
        route: { ...routePayload(op), flow: 'probe', purpose: 'probe_safari', stage: 'probe_waiting', arrivalDeadline: deadline, nodeName: sel, proxyRevision: route.activeProxyRevision ?? p.proxyRevision },
      },
    });
    repos.operations.appendStep(opId, 'VALIDATING', '等待在绑定的 Safari 场景中完成出口检测（不切换、不断连）');
    repos.outbox.enqueue(opId, 'arrival_timeout', deadline);
  });
  engine.emit({ operations: [opId], environments: [p.targetEnvironmentId] });
}

// ---------- 恢复（原生桥消息、计时器、取消） ----------

export async function resumeRoute(engine: Engine, op: OperationRecord, reason: string): Promise<void> {
  if (op.status !== 'waiting') return;
  const p = payloadOf(op).route;
  if (!p) return;
  switch (reason) {
    case 'profile_arrived':
      if (op.phase === 'WAITING_ROUTE') await continueWaitingRoute(engine, op);
      return;
    case 'verify_submitted':
      await completeVerification(engine, op);
      return;
    case 'arrival_timeout':
    case 'verify_timeout':
      await handleTimeout(engine, op, reason);
      return;
    case 'cancel':
      await handleCancel(engine, op);
      return;
    default:
      return;
  }
}

async function continueWaitingRoute(engine: Engine, op: OperationRecord): Promise<void> {
  const { repos } = engine;
  // 路由忙（其他切换进行中或等待中）：继续等待，从不取代已开始的切换
  const others = repos.operations
    .listByStatus(['queued', 'running', 'waiting'])
    .filter((o) => o.id !== op.id && (o.kind === 'route.activate' || o.kind === 'route.normal' || o.kind === 'probe.safari' || (payloadOf(o).route && !(o.status === 'waiting' && o.phase === 'WAITING_ROUTE'))));
  if (others.length > 0) {
    engine.step(op.id, '场景已到达，等待当前切换完成后再切换到新版本');
    return;
  }
  const p = routePayload(op);
  const route = repos.routeState.get();
  savePayload(engine, op.id, { stage: 'arrived', expectedActiveEnvironmentId: route.activeEnvironmentId === p.targetEnvironmentId ? p.targetEnvironmentId : p.expectedActiveEnvironmentId });
  engine.updateOp(op.id, { status: 'running', phase: 'VALIDATING' }, '绑定场景已到达：重新检查后切换到新版本');
  try {
    await prepareAndSwitch(engine, op.id, { allowReuse: false });
  } catch (err) {
    await failBeforeSwitch(engine, op.id, failBody(engine, err, '切换到新版本失败：内部错误'));
  }
}

async function handleTimeout(engine: Engine, op: OperationRecord, reason: string): Promise<void> {
  const p = routePayload(op);
  const now = engine.now().getTime();
  if (reason === 'arrival_timeout') {
    if (p.arrivedAt !== null && op.phase !== 'WAITING_ROUTE') return;
    if (p.arrivalDeadline === null || Date.parse(p.arrivalDeadline) > now) return;
  } else {
    if (p.verifyDeadline === null || Date.parse(p.verifyDeadline) > now) return;
  }
  if (op.phase === 'WAITING_ROUTE') {
    engine.updateOp(op.id, { phase: 'READY_FOR_NEXT_OPEN', status: 'succeeded' }, '场景未在截止时间内到达：新版本已部署，路由未改变，下次打开时切换');
    return;
  }
  const body: ApiErrorBody = {
    code: 'SAFARI_VERIFY_TIMEOUT',
    message: reason === 'arrival_timeout' ? 'Safari 实测超时：绑定场景未在截止时间内到达' : 'Safari 实测超时：未在截止时间内完成出口检测',
  };
  if (p.flow === 'probe') {
    engine.updateOp(op.id, { phase: 'FAILED', status: 'failed', error: body }, body.message);
    return;
  }
  await rollbackFromWaiting(engine, op.id, body);
}

async function handleCancel(engine: Engine, op: OperationRecord): Promise<void> {
  const p = routePayload(op);
  if (op.phase === 'WAITING_ROUTE') {
    engine.updateOp(op.id, { phase: 'READY_FOR_NEXT_OPEN', status: 'succeeded' }, '已取消切换：新版本已部署，路由未改变');
    engine.repos.outbox.cancelForOperation(op.id);
    return;
  }
  const body: ApiErrorBody = { code: 'SUPERSEDED', message: '已取消：切换未完成' };
  if (p.flow === 'probe') {
    engine.updateOp(op.id, { phase: 'FAILED', status: 'failed', error: { ...body, message: '已取消重新检测：路由未改变' } }, '已取消重新检测，路由未改变');
    engine.repos.outbox.cancelForOperation(op.id);
    return;
  }
  await rollbackFromWaiting(engine, op.id, { ...body, message: '已取消切换：恢复原节点并保持阻断' });
}

async function rollbackFromWaiting(engine: Engine, opId: string, failure: ApiErrorBody): Promise<void> {
  const ctrl = engine.entryController(() => opId);
  const route = engine.repos.routeState.get();
  engine.updateOp(opId, { status: 'running' });
  await rollbackActivation(engine, opId, failure, ctrl, route.entryMode);
}

// ---------- 实测 ----------

/** 签发检测编号前与提交后都要重读 SFE-ROUTE 选择。 */
export async function currentSelection(engine: Engine): Promise<string | null> {
  return engine.surge.getGroupSelection(ROUTE_GROUP_NAME);
}

function browserFailure(p: RoutePayload): string | null {
  const s = p.submission!;
  if (s.error) return `浏览器检测请求失败：${s.error}`;
  if (s.httpStatus === null || s.httpStatus < 200 || s.httpStatus > 299) return '浏览器检测请求失败：检测服务没有返回成功状态';
  if (s.observedIp === null || isIP(s.observedIp) === 0) return '浏览器检测请求失败：没有读到出口 IP';
  return null;
}

async function completeVerification(engine: Engine, op: OperationRecord): Promise<void> {
  const { repos } = engine;
  const p = routePayload(op);
  const sub = p.submission;
  if (!sub) return;
  engine.updateOp(op.id, { status: 'running' }, '收到出口检测结果，开始核对');
  const env = repos.environments.get(p.targetEnvironmentId);
  const cfg = engine.entryConfig();
  let failure: ApiErrorBody | null = null;
  let evidence: ReturnType<typeof findVerificationRequest>['match'] = null;
  try {
    const sel = await currentSelection(engine);
    if (sel !== p.nodeName) failure = { code: 'SAFARI_VERIFY_FAILED', message: 'Safari 实测失败：提交后 SFE-ROUTE 选择已不是目标节点' };
    if (!failure) {
      const bf = browserFailure(p);
      if (bf) failure = { code: 'SAFARI_VERIFY_FAILED', message: bf };
    }
    if (!failure) {
      await engine.deps.demoHooks?.beforeVerificationCheck?.({ verifyHost: cfg.verifyHost, processPaths: cfg.processPaths });
      const records = await engine.surge.listRecentRequests();
      const found = findVerificationRequest(records, {
        processPaths: cfg.processPaths,
        verifyHost: cfg.verifyHost,
        from: new Date(sub.startedAt),
        to: new Date(sub.finishedAt),
        expectedRule: p.flow === 'probe' ? 'active' : 'verify',
        expectedPolicy: 'SFE-ROUTE',
        expectedLeaf: p.nodeName,
      });
      evidence = found.match;
      if (!found.match) failure = { code: 'SAFARI_VERIFY_FAILED', message: `Safari 实测失败：${found.reason}` };
    }
    if (!failure && env?.expectedExitIp && sub.observedIp !== env.expectedExitIp) {
      failure = { code: 'EXIT_IP_MISMATCH', message: 'Safari 实测失败：实际出口与预期出口不一致' };
    }
  } catch (err) {
    failure = engine.errorBody(err, 'Safari 实测失败：读取 Surge 请求记录失败');
  }

  if (p.flow === 'probe') {
    finishProbe(engine, op.id, p, failure, evidence);
    return;
  }
  if (failure) {
    await rollbackFromWaitingRunning(engine, op.id, failure);
    return;
  }
  // 13. 入口 → ACTIVE（读回）→ 提交
  // 等待期间激活门槛可能已失效（能力被重置、Surge/Safari/macOS 更新使记录过期）：写入 ACTIVE 之前重新检查
  await engine.readBasicFacts();
  const missing = engine.activationMissing();
  if (missing.length > 0) {
    await rollbackFromWaitingRunning(engine, op.id, capabilityFailure(engine, missing, '切换失败：', '在等待期间已不再满足激活条件'));
    return;
  }
  const ctrl = engine.entryController(() => op.id);
  if (!ctrl) {
    await rollbackFromWaitingRunning(engine, op.id, { code: 'CAPABILITY_UNVERIFIED', message: '切换失败：入口策略已变化' });
    return;
  }
  try {
    await ctrl.transition('ACTIVE');
  } catch (err) {
    await rollbackActivation(engine, op.id, engine.errorBody(err, '切换失败：进入使用中模式失败'), ctrl, confirmedModeFrom(err, 'VERIFY_ONLY'));
    return;
  }
  commitActive(engine, op.id, p, evidence);
  // 提交清除了失控类警告（显式激活重新建立控制）：立即对账一次，让仍然成立的事实类警告马上重新出现
  try {
    await reconcile(engine, 'precheck');
  } catch (err) {
    engine.log('warn', 'reconcile.failed', { error: err instanceof Error ? err.name : 'unknown' });
  }
}

async function rollbackFromWaitingRunning(engine: Engine, opId: string, failure: ApiErrorBody): Promise<void> {
  const ctrl = engine.entryController(() => opId);
  await rollbackActivation(engine, opId, failure, ctrl, engine.repos.routeState.get().entryMode);
}

function probeEvidence(evidence: ReturnType<typeof findVerificationRequest>['match']) {
  if (!evidence) return {};
  return {
    surgeRequestId: evidence.id,
    surgeRemoteHost: evidence.remoteHost,
    surgeRule: evidence.rule,
    surgePolicy: evidence.policyName,
    surgeStartedAt: evidence.startedAt ? evidence.startedAt.toISOString() : null,
    // 6.5 能否区分新连接由 P0 确认；此处只记录未知
    surgeNewConnection: null,
  };
}

function insertSafariProbe(
  engine: Engine,
  opId: string,
  p: RoutePayload,
  outcome: 'ok' | 'failed' | 'mismatch',
  entryMode: EntryMode,
  routeEpoch: number,
  evidence: ReturnType<typeof findVerificationRequest>['match'],
  message: string | null,
) {
  const now = engine.now();
  const sub = p.submission!;
  return engine.repos.probes.insert({
    id: engine.ids.next('probe'),
    environmentId: p.targetEnvironmentId,
    kind: 'safari',
    outcome,
    exitIp: sub.observedIp,
    proxyRevision: p.proxyRevision,
    nodeName: p.nodeName,
    routeEpoch,
    configurationGeneration: engine.repos.meta.configurationGeneration(),
    entryMode,
    testId: sub.testId,
    operationId: opId,
    ...probeEvidence(evidence),
    chainEvidence: '出口由 Safari 场景实测；前置链路依赖 external_node_underlying_proxy 实测，不以出口 IP 作为链路证明',
    browserHttpStatus: sub.httpStatus,
    browserStartedAt: sub.startedAt,
    browserFinishedAt: sub.finishedAt,
    browserError: sub.error,
    message,
    observedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + engine.repos.settings.get('probeTtlSec') * 1000).toISOString(),
  });
}

function finishProbe(
  engine: Engine,
  opId: string,
  p: RoutePayload,
  failure: ApiErrorBody | null,
  evidence: ReturnType<typeof findVerificationRequest>['match'],
): void {
  const { repos } = engine;
  const route = repos.routeState.get();
  if (!failure) {
    repos.tx(() => {
      insertSafariProbe(engine, opId, p, 'ok', 'ACTIVE', route.routeEpoch, evidence, 'Safari 重测通过');
      const warnings = route.warnings.filter((w) => w !== 'probe_expired' && w !== 'probe_failed' && w !== 'exit_ip_mismatch');
      repos.routeState.update({ warnings });
      repos.operations.update(opId, { phase: 'ACTIVE_VERIFIED', status: 'succeeded', resultRevision: p.proxyRevision });
      repos.operations.appendStep(opId, 'ACTIVE_VERIFIED', 'Safari 重测通过：实测已更新');
      repos.outbox.cancelForOperation(opId);
    });
    engine.emit({ operations: [opId], environments: [p.targetEnvironmentId], route: true });
    return;
  }
  // 失败或不符：记录、加警告、停止填充与自动打开；从不自动切换、阻断或进入 NORMAL
  const mismatch = failure.code === 'EXIT_IP_MISMATCH';
  repos.tx(() => {
    if (p.submission) insertSafariProbe(engine, opId, p, mismatch ? 'mismatch' : 'failed', 'ACTIVE', route.routeEpoch, evidence, failure.message);
    const w: RouteWarning = mismatch ? 'exit_ip_mismatch' : 'probe_failed';
    repos.routeState.update({ warnings: [...route.warnings, w] });
    repos.operations.update(opId, { phase: 'FAILED', status: 'failed', error: failure });
    repos.operations.appendStep(opId, 'FAILED', `${failure.message}；已停止自动打开订单与填充，路由未改变`);
    repos.outbox.cancelForOperation(opId);
  });
  engine.emit({ operations: [opId], environments: [p.targetEnvironmentId], route: true });
}

function commitActive(engine: Engine, opId: string, p: RoutePayload, evidence: ReturnType<typeof findVerificationRequest>['match']): void {
  const { repos } = engine;
  const route = repos.routeState.get();
  const firstRequestOk = engine.missing(['first_request_and_old_connections']).length === 0;
  const takeoverUnknown = engine.facts.takeover.enhancedMode === null && engine.facts.takeover.systemProxy === null;
  // 受控激活重新建立了控制：清除之前的失控、回滚与窗口类警告，再按本次情况重新附加
  const cleared: RouteWarning[] = route.warnings.filter((w) => w === 'launch_unverified');
  const warnings: RouteWarning[] = [];
  const amazon = p.amazonTabsAtLaunch === true || p.amazonTabsAtVerify === true;
  const reportedClean = p.amazonTabsAtLaunch === false || p.amazonTabsAtVerify === false;
  if (amazon || (cleared.includes('launch_unverified') && !reportedClean)) warnings.push('launch_unverified');
  if (!firstRequestOk) warnings.push('launch_order_unverified');
  if (p.crossEnvironment && !firstRequestOk) warnings.push('old_session_unproven');
  if (p.oldSessionPolicy === 'keep_open_acknowledged') warnings.push('old_windows_kept_open');
  if (takeoverUnknown) warnings.push('takeover_unknown');
  repos.tx(() => {
    repos.routeState.update({
      activeEnvironmentId: p.targetEnvironmentId,
      activeProxyRevision: p.proxyRevision,
      phase: 'active_verified',
      entryMode: 'ACTIVE',
      entryModeVerifiedAt: engine.nowIso(),
      selectedNode: p.nodeName,
      oldSessionPolicy: p.oldSessionPolicy,
      operationId: opId,
      awaitingDeadline: null,
      activationSnapshot: null,
      warnings,
    });
    const after = repos.routeState.get();
    insertSafariProbe(engine, opId, p, 'ok', 'VERIFY_ONLY', after.routeEpoch, evidence, 'Safari 实测通过');
    repos.environments.update(p.targetEnvironmentId, { lastVerifiedProxyRevision: p.proxyRevision });
    repos.operations.update(opId, { phase: 'ACTIVE_VERIFIED', status: 'succeeded', resultRevision: p.proxyRevision, payload: { ...payloadOf(repos.operations.get(opId)!), route: { ...p, stage: 'done' } } });
    repos.operations.appendStep(opId, 'ACTIVE_VERIFIED', `已切换并通过 Safari 实测${warnings.length ? `（警告：${warnings.join('、')}）` : ''}`);
    repos.outbox.cancelForOperation(opId);
  });
  const envs = [p.targetEnvironmentId];
  if (route.activeEnvironmentId && route.activeEnvironmentId !== p.targetEnvironmentId) envs.push(route.activeEnvironmentId);
  engine.emit({ operations: [opId], environments: envs, route: true });
}

// ---------- 回滚（§6.3 第 14 步） ----------

export async function rollbackActivation(engine: Engine, opId: string, failure: ApiErrorBody, ctrl: EntryController | null, confirmed: EntryMode): Promise<void> {
  const { repos } = engine;
  const op = repos.operations.get(opId)!;
  const p = routePayload(op);
  const before = repos.routeState.get();
  const snapshot = before.activationSnapshot;
  // 回到阻断会改写被外部修改的本应用入口文件（§5.5），但不清除这一事实
  const segmentsChanged = await segmentsChangedBefore(engine, before);
  repos.routeState.update({ phase: 'rolling_back', entryMode: confirmed });
  engine.updateOp(opId, { phase: 'ROLLING_BACK', status: 'running' }, `${failure.message}；开始回滚：恢复切换前节点并保持阻断`, { route: true });
  try {
    if (!ctrl) throw new SfeError('UNKNOWN_STATE', '回滚失败：入口控制器不可用');
    let mode = confirmed;
    if (mode !== 'BLOCKED') {
      // 从 VERIFY_ONLY/未知状态回到阻断（撤销入口：可改写被外部修改的本应用入口文件）；绝不走向 NORMAL
      await ctrl.transition('BLOCKED', undefined, undoOptions(engine, opId));
      mode = 'BLOCKED';
    }
    repos.routeState.update({ entryMode: 'BLOCKED', entryModeVerifiedAt: engine.nowIso() });
    const hasPrevious = snapshot !== null && snapshot.previousEnvironmentId !== null && snapshot.previousSelectedNode !== null;
    let restored: string | null;
    if (hasPrevious) {
      const members = await engine.surge.getGroupMembers(ROUTE_GROUP_NAME);
      if (!members.includes(snapshot!.previousSelectedNode!)) throw new SfeError('READBACK_MISMATCH', '回滚失败：切换前的节点已不在 SFE-ROUTE 中');
      await engine.surge.selectGroupPolicy(ROUTE_GROUP_NAME, snapshot!.previousSelectedNode!);
      restored = await engine.surge.getGroupSelection(ROUTE_GROUP_NAME);
      if (restored !== snapshot!.previousSelectedNode) throw new SfeError('READBACK_MISMATCH', '回滚失败：恢复后的选择读回不一致');
    } else {
      restored = await engine.surge.getGroupSelection(ROUTE_GROUP_NAME);
    }
    const prevProbe = snapshot?.previousSafariProbeId ? repos.probes.get(snapshot.previousSafariProbeId) : null;
    const rollback: RollbackResult = {
      previousEnvironmentId: hasPrevious ? snapshot!.previousEnvironmentId : null,
      previousProxyRevision: hasPrevious ? snapshot!.previousProxyRevision : null,
      previousProbe: prevProbe ? probeView(prevProbe) : null,
      restoredSelection: restored,
      entryModeAfter: 'BLOCKED',
      failedProxyRevision: p.proxyRevision,
      failureError: failure,
      needsReverify: hasPrevious,
    };
    const keep: RouteWarning[] = before.warnings.filter((w) => w === 'managed_windows_on_original_rules' || w === 'takeover_unknown');
    if (segmentsChanged) keep.push('managed_segments_changed');
    repos.tx(() => {
      repos.routeState.update({
        phase: 'failed',
        entryMode: 'BLOCKED',
        activeEnvironmentId: hasPrevious ? snapshot!.previousEnvironmentId : null,
        activeProxyRevision: hasPrevious ? snapshot!.previousProxyRevision : null,
        selectedNode: restored,
        awaitingDeadline: null,
        operationId: opId,
        warnings: hasPrevious ? [...keep, 'rollback_needs_reverify'] : keep,
      });
      const cur = repos.operations.get(opId)!;
      repos.operations.update(opId, { phase: 'FAILED', status: 'failed', error: failure, result: { ...(cur.result ?? {}), rollback } });
      repos.operations.appendStep(
        opId,
        'FAILED',
        hasPrevious ? '已回滚：恢复切换前的节点，Safari 保持阻断，需要重新核验' : '切换失败：切换前没有已验证的路由，Safari 保持阻断',
      );
      repos.outbox.cancelForOperation(opId);
    });
    const envs = [p.targetEnvironmentId];
    if (hasPrevious) envs.push(snapshot!.previousEnvironmentId!);
    engine.emit({ operations: [opId], environments: envs, route: true });
  } catch (err) {
    const current = repos.routeState.get();
    const mode = confirmedModeFrom(err, current.entryMode === 'NORMAL' ? 'UNKNOWN' : current.entryMode);
    const body: ApiErrorBody = {
      code: 'UNKNOWN_STATE',
      message: '回滚无法确认：Safari 保持已确认的阻断状态（或状态未知），需要处理',
      details: { cause: failure.code },
    };
    repos.tx(() => {
      repos.routeState.update({
        phase: 'attention',
        entryMode: mode,
        awaitingDeadline: null,
        operationId: opId,
        warnings: [...current.warnings, 'entry_unverified'],
      });
      const cur = repos.operations.get(opId)!;
      repos.operations.update(opId, { phase: 'BLOCKED_NEEDS_ATTENTION', status: 'needs_attention', error: body, result: { ...(cur.result ?? {}), failure } });
      repos.operations.appendStep(opId, 'BLOCKED_NEEDS_ATTENTION', body.message);
      repos.outbox.cancelForOperation(opId);
    });
    engine.emit({ operations: [opId], environments: [p.targetEnvironmentId], route: true });
  }
}

// ---------- 普通模式（§6.5） ----------

export async function runNormal(engine: Engine, op: OperationRecord): Promise<void> {
  const { repos } = engine;
  const np = payloadOf(op).normal;
  engine.updateOp(op.id, { status: 'running', phase: 'VALIDATING' }, '开始进入普通模式');
  const route = repos.routeState.get();
  if ((route.activeEnvironmentId ?? null) !== (np?.expectedActiveEnvironmentId ?? null)) {
    const details = confirmationNeeded(engine, null);
    const body = details
      ? needsConfirmationError('进入普通模式', details).toBody()
      : { code: 'NEEDS_CONFIRMATION' as const, message: '进入普通模式需要重新确认：使用中的环境已变化' };
    engine.updateOp(op.id, { phase: 'FAILED', status: 'failed', error: body }, body.message);
    return;
  }
  const ctrl = engine.entryController(() => op.id);
  let confirmed: EntryMode = route.entryMode;
  // 撤销入口会改写被外部修改的本应用入口文件（§5.5），但保留 managed_segments_changed
  const segmentsChanged = await segmentsChangedBefore(engine, route);
  try {
    if (ctrl) {
      const readback = await ctrl.read();
      if (readback.mode !== 'NORMAL') {
        repos.routeState.update({ phase: 'switching', operationId: op.id });
        const changedFiles = readback.changedOwnedFiles ?? [];
        if (changedFiles.length > 0) {
          const cur = repos.operations.get(op.id)!;
          repos.operations.update(op.id, { result: { ...(cur.result ?? {}), changedEntryFiles: changedFiles } });
          engine.step(op.id, `本应用的入口文件已被外部修改（${changedFiles.join('、')}）：撤销入口时按读到的内容比较后改写`);
        }
        const precedenceIssues = await blockForNormal(ctrl, undoOptions(engine, op.id));
        confirmed = 'BLOCKED';
        repos.routeState.update({ entryMode: 'BLOCKED', entryModeVerifiedAt: engine.nowIso() });
        if (precedenceIssues) {
          const cur = repos.operations.get(op.id)!;
          repos.operations.update(op.id, { result: { ...(cur.result ?? {}), precedenceIssues: engine.scrubber.scrubDeep(precedenceIssues) } });
        }
        engine.updateOp(
          op.id,
          { phase: 'SAFARI_BLOCKED' },
          precedenceIssues
            ? `入口已切换到阻断，但有 ${precedenceIssues.filter((i) => i.severity === 'blocking').length} 条规则排在本应用入口之前、读回不能确认完全阻断：继续撤销本应用入口`
            : '已阻断 Safari 新请求（读回确认）',
          { route: true },
        );
        await killForNormal(engine, op.id);
        await ctrl.transition('NORMAL', undefined, undoOptions(engine, op.id));
        confirmed = 'NORMAL';
      }
    } else if (route.entryMode !== 'NORMAL') {
      throw new SfeError('CAPABILITY_UNVERIFIED', '进入普通模式失败：入口策略或 Safari 进程路径不可用，无法撤销入口');
    }
  } catch (err) {
    const mode = confirmedModeFrom(err, confirmed);
    const body = engine.errorBody(err, '进入普通模式失败：内部错误');
    repos.tx(() => {
      repos.routeState.update({ entryMode: mode, phase: mode === 'NORMAL' ? 'idle' : 'failed', operationId: op.id });
      repos.operations.update(op.id, { phase: 'FAILED', status: 'failed', error: body });
      repos.operations.appendStep(op.id, 'FAILED', `${body.message}；Safari 停在已确认的状态（${mode}），未回退到其他出口`);
    });
    engine.emit({ operations: [op.id], route: true, environments: route.activeEnvironmentId ? [route.activeEnvironmentId] : [] });
    return;
  }
  const keepOpen = np?.oldSessionPolicy === 'keep_open_acknowledged' && np.hadManagedEnvironment;
  const warnings: RouteWarning[] = [];
  if (keepOpen || route.warnings.includes('managed_windows_on_original_rules')) warnings.push('managed_windows_on_original_rules');
  if (segmentsChanged) warnings.push('managed_segments_changed');
  repos.tx(() => {
    repos.routeState.update({
      entryMode: 'NORMAL',
      entryModeVerifiedAt: engine.nowIso(),
      phase: 'idle',
      activeEnvironmentId: null,
      activeProxyRevision: null,
      oldSessionPolicy: np?.oldSessionPolicy ?? null,
      operationId: op.id,
      awaitingDeadline: null,
      activationSnapshot: null,
      warnings,
    });
    repos.operations.update(op.id, { phase: 'NORMAL_RESTORED', status: 'succeeded' });
    repos.operations.appendStep(
      op.id,
      'NORMAL_RESTORED',
      keepOpen ? '已进入普通模式：旧环境窗口未关闭，其后续请求将按 Surge 原规则发出（可能直连）' : '已进入普通模式：Safari 按 Surge 原规则发出请求',
    );
  });
  engine.emit({ operations: [op.id], route: true, environments: route.activeEnvironmentId ? [route.activeEnvironmentId] : [] });
}

/**
 * 普通模式的中间阻断。优先级问题只阻止 VERIFY_ONLY/ACTIVE（§5.2、§5.5）：入口位已全部确认为 BLOCKED、
 * 只因有规则排在入口之前而最终读回不能宣称受控时，返回这些规则并继续撤销入口；其他失败照常抛出。
 */
async function blockForNormal(ctrl: EntryController, undo: EntryTransitionOptions): Promise<EntryReadback['precedenceIssues'] | null> {
  try {
    await ctrl.transition('BLOCKED', undefined, undo);
    return null;
  } catch (err) {
    if (err instanceof SfeError && err.code === 'PRECEDENCE_VIOLATION' && confirmedModeFrom(err, 'UNKNOWN') === 'BLOCKED') {
      return Array.isArray(err.details?.precedenceIssues) ? (err.details.precedenceIssues as EntryReadback['precedenceIssues']) : [];
    }
    throw err;
  }
}

/**
 * 普通模式中结束 Safari 连接：门槛满足时严格核对，否则尽力而为；无论哪种，列出或结束连接失败都只记录并报告，
 * 不中止普通模式（它只依赖入口写入与读回，§5.2、§6.5）。
 */
async function killForNormal(engine: Engine, opId: string): Promise<void> {
  const { repos } = engine;
  const cfg = engine.entryConfig();
  const strict = engine.missing(CAPABILITY_GATES.killSafariConnections).length === 0;
  let killResults: KillResult[] = [];
  let killError: ApiErrorBody | null = null;
  try {
    killResults = await killSafariConnections(engine.surge, { processPaths: cfg.processPaths, verifyHost: cfg.verifyHost, now: () => engine.now(), bestEffort: !strict });
  } catch (err) {
    if (err instanceof SfeError && Array.isArray(err.details?.killResults)) killResults = err.details.killResults as KillResult[];
    const body = engine.errorBody(err, '结束 Safari 连接失败：内部错误');
    killError = { code: body.code, message: body.message };
  }
  const cur = repos.operations.get(opId)!;
  repos.operations.update(opId, { result: { ...(cur.result ?? {}), killResults, killBestEffort: !strict, ...(killError ? { killError } : {}) } });
  const ok = killResults.filter((k) => k.ok).length;
  if (killError) engine.step(opId, `未能确认结束 Safari 连接（${killError.message}，已结束 ${ok}/${killResults.length} 条）：继续撤销本应用入口`);
  else engine.step(opId, strict ? `已结束 Safari 连接 ${ok} 条` : `进程归属能力未通过：尽力结束 Safari 连接，结果 ${ok}/${killResults.length}`);
}

// ---------- 崩溃恢复 ----------

/**
 * 服务重启时仍在执行中的路由操作：按路由阶段与 epoch 判断（操作阶段在切换中可能仍是 VALIDATING/PREFLIGHT_OK，
 * 推迟的预检之后也会回到 PREFLIGHT_OK，不能用来判断）。尚未递增 epoch、也不负责过渡中路由的重新执行；其余按快照
 * 回滚（先读事实）。经 supersedeWaiting 接手了过渡中路由的激活（路由 epoch 已递增，但它自己的 routeEpoch 仍为空、
 * stage 仍是 pending）以及已开始回滚的操作也属于后者：从不把一次已开始的回滚重放成切换。
 */
export async function recoverRoute(engine: Engine, op: OperationRecord): Promise<void> {
  if (op.kind === 'route.normal') {
    await runNormal(engine, { ...op, status: 'queued' });
    return;
  }
  const p = routePayload(op);
  // Safari 重测从不写入：重新执行
  if (p.flow === 'probe') {
    await runProbeSafari(engine, op);
    return;
  }
  const owns = op.phase === 'ROLLING_BACK' || ownsTransition(engine.repos.routeState.get(), op.id);
  if (!owns && (p.stage === 'pending' || p.stage === 'arrived') && op.routeEpoch === null) {
    if (p.stage === 'arrived') await continueAfterCrash(engine, op);
    else await runActivation(engine, op);
    return;
  }
  // 已开始写入（epoch 已递增：切换中、VERIFY_ONLY 之后的核对或回滚）或负责过渡中的路由：按激活快照回滚，不重放写入
  const body: ApiErrorBody = { code: 'UNKNOWN_STATE', message: '切换中断：服务重启时切换未完成' };
  const ctrl = engine.entryController(() => op.id);
  let mode: EntryMode = 'UNKNOWN';
  try {
    mode = ctrl ? (await ctrl.read()).mode : 'UNKNOWN';
  } catch {
    mode = 'UNKNOWN';
  }
  await rollbackActivation(engine, op.id, body, ctrl, mode);
}

async function continueAfterCrash(engine: Engine, op: OperationRecord): Promise<void> {
  try {
    await prepareAndSwitch(engine, op.id, { allowReuse: false });
  } catch (err) {
    await failBeforeSwitch(engine, op.id, failBody(engine, err, '切换到新版本失败：内部错误'));
  }
}

export { buildVerifyUrl };
