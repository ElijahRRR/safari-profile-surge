// 路由操作并发矩阵与旧窗口确认（docs/ARCHITECTURE.md §6.1、§6.3 受理、§6.5）。按操作状态判断：
// queued/running → 新的激活与重测返回 ROUTE_BUSY，新的普通模式排在其后（永远可用，见 accept.ts acceptNormal）；等待中的激活/重测 → 新的激活或普通模式把它结束为
// SUPERSEDED（epoch 递增使其 test_id 失效，不回滚）；WAITING_ROUTE → 结束为 READY_FOR_NEXT_OPEN。

import {
  PROFILE_REPORT_FRESH_SEC,
  SfeError,
  shortProfileId,
  type EnvironmentId,
  type NeedsConfirmationDetails,
  type NeedsConfirmationReason,
} from '@sfe/contract';
import type { OperationRecord } from '../db/index.js';
import { OPEN_STATUSES, isWaitingRoute, isWaitingVerification, payloadOf } from '../domain/operations.js';
import { labelOf } from '../domain/naming.js';
import type { Engine } from './context.js';

export interface RouteOpsState {
  /** 已排队或正在执行的路由操作（含已开始切换的活动环境发布）。 */
  busy: OperationRecord[];
  /** 等待场景到达或实测的激活/重测。 */
  waitingVerification: OperationRecord[];
  /** 停在 WAITING_ROUTE 的活动环境发布。 */
  waitingRoute: OperationRecord[];
}

export function routeOps(engine: Engine): RouteOpsState {
  const ops = engine.repos.operations.listByStatus([...OPEN_STATUSES]);
  const out: RouteOpsState = { busy: [], waitingVerification: [], waitingRoute: [] };
  for (const op of ops) {
    const route = payloadOf(op).route;
    const isRoute = op.kind === 'route.activate' || op.kind === 'route.normal' || op.kind === 'probe.safari' || route !== undefined;
    if (!isRoute) continue;
    if (op.status === 'queued' || op.status === 'running') out.busy.push(op);
    else if (isWaitingRoute(op)) out.waitingRoute.push(op);
    else if (isWaitingVerification(op)) out.waitingVerification.push(op);
    else out.waitingVerification.push(op);
  }
  return out;
}

/**
 * 环境正在使用或正在验证（删除与解除绑定拒绝，§6.7）：它是入口不为普通模式时的使用中环境、未结束的路由操作的目标，或 SFE-ROUTE
 * 记录的选择是它某一版本的节点而入口不是普通模式——例如交给普通模式、已写入 ACTIVE 而未提交的切换选着它的节点，普通模式失败；
 * 回滚无法确认、改选 REJECT 失败时选着本次切换写入的节点。这时路由记录的使用中环境是另一个，Safari 却可能经它的出口发出。
 */
export function environmentRouteBusy(engine: Engine, environmentId: string): boolean {
  const route = engine.repos.routeState.get();
  if (route.entryMode !== 'NORMAL') {
    if (route.activeEnvironmentId === environmentId) return true;
    if (route.selectedNode !== null && engine.repos.proxyRevisions.listByEnvironment(environmentId).some((r) => r.nodeName === route.selectedNode)) return true;
  }
  const ops = routeOps(engine);
  return [...ops.busy, ...ops.waitingVerification].some((o) => payloadOf(o).route?.targetEnvironmentId === environmentId);
}

export function routeBusyError(action: string): SfeError {
  return new SfeError('ROUTE_BUSY', `${action}失败：正在切换出口或检测，请稍后再试`);
}

/**
 * 入口设置（入口策略、Safari 进程路径、检测服务）只能在空闲的普通模式下修改，否则返回拒绝的错误（可以修改时为 null）。
 * 每个路由操作在开始时按当时的设置建立入口控制器并一直用它写入（激活从第 1–3 步的读取起直到阻断写入之后，路由记录才不再是
 * 普通模式），之后的回滚、取消与普通模式按新的设置另建控制器：新控制器看不到旧策略写入的入口（临时规则或入口规则集文件），
 * 普通模式会失败或误报已撤销，Safari 停在被拒绝或检测入口上（§5.2「进入普通模式永远可用」）。所以只看记录的入口模式不够：
 * 有任何路由操作未结束（排队、执行中、等待中，含排队的普通模式）或路由不是空闲的普通模式（有使用中的环境、激活快照、
 * 未结束的阶段）时一律拒绝。
 */
export function entrySettingsChangeRefusal(engine: Engine, action: string, what: string): SfeError | null {
  const ops = routeOps(engine);
  if (ops.busy.length > 0 || ops.waitingVerification.length > 0 || ops.waitingRoute.length > 0) {
    return new SfeError('ROUTE_BUSY', `${action}失败：正在切换出口、检测或进入普通模式，请等它结束后再更改${what}`);
  }
  const route = engine.repos.routeState.get();
  if (route.entryMode !== 'NORMAL' || route.phase !== 'idle' || route.activeEnvironmentId !== null || route.activationSnapshot !== null) {
    return new SfeError('ENVIRONMENT_ACTIVE', `${action}失败：入口不是空闲的普通模式，请先进入普通模式再更改${what}`);
  }
  return null;
}

/**
 * 路由操作建立入口控制器时的入口设置（入口策略、Safari 进程路径、检测服务）：写入之前与它比较，变化了就不写（受理之外的
 * 第二道防线，见 entrySettingsChangeRefusal）。
 */
export function entrySettingsKey(engine: Engine): string {
  const s = engine.repos.settings;
  return JSON.stringify([s.get('entryStrategy'), [...s.get('safariProcessPaths')].sort(), s.get('verifyEndpointId')]);
}

/**
 * 将被 supersedeWaiting 结束的等待中路由操作的目标环境：它们的环境视图随之改变（切换中、检测中 → 未使用，发布等待切换 →
 * 下次打开时切换），调用方随操作一起发布这些环境（网页后台只在 environment.updated 事件中更新环境）。
 */
export function waitingEnvironments(state: Pick<RouteOpsState, 'waitingVerification' | 'waitingRoute'>): string[] {
  const ids = new Set<string>();
  for (const op of [...state.waitingVerification, ...state.waitingRoute]) {
    const id = payloadOf(op).route?.targetEnvironmentId ?? op.environmentId;
    if (id) ids.add(id);
  }
  return [...ids];
}

/** 新的激活或普通模式：在受理事务中结束等待中的路由操作。返回受影响的操作 id（目标环境见 waitingEnvironments）。 */
export function supersedeWaiting(engine: Engine, newOpId: string, state: RouteOpsState): string[] {
  const { repos } = engine;
  const touched: string[] = [];
  let bump = false;
  // 写明取代它的是什么：进入普通模式（Safari 随后按 Surge 原规则发出）或新的切换
  const byNormal = repos.operations.get(newOpId)?.kind === 'route.normal';
  const by = byNormal ? '已被进入普通模式取代' : '已被新的切换请求取代';
  for (const op of state.waitingVerification) {
    repos.operations.update(op.id, {
      phase: 'SUPERSEDED',
      status: 'superseded',
      supersededBy: newOpId,
      error: { code: 'SUPERSEDED', message: by },
    });
    repos.operations.appendStep(op.id, 'SUPERSEDED', `${by}，检测编号作废`);
    repos.outbox.cancelForOperation(op.id);
    touched.push(op.id);
    bump = true;
  }
  for (const op of state.waitingRoute) {
    repos.operations.update(op.id, { phase: 'READY_FOR_NEXT_OPEN', status: 'succeeded', supersededBy: newOpId });
    repos.operations.appendStep(op.id, 'READY_FOR_NEXT_OPEN', byNormal ? '新版本已部署，未切换：已有进入普通模式的请求' : '新版本已部署，未切换：已有新的切换请求');
    repos.outbox.cancelForOperation(op.id);
    touched.push(op.id);
  }
  if (bump) {
    const route = repos.routeState.get();
    repos.routeState.update({ routeEpoch: route.routeEpoch + 1, operationId: newOpId, awaitingDeadline: null });
  }
  return touched;
}

/**
 * 保存了环境的代理新版本（单项修改、导入、更换前置）：在保存事务中结束同一环境停在 WAITING_ROUTE 的活动环境发布。它的目标版本
 * 已被用户替换（§6.3 第 2 步：替换指之后保存了更新的版本，无论它是否已部署）——更新的版本的发布若失败、读回不完整或暂停待部署，
 * 旧的等待也不能再把 Safari 切到用户已替换的出口（可能正是被更正的、指向另一个买家代理的那一次修改），弹窗与网页也不再提示
 * 「切换到新版本」。结束为 READY_FOR_NEXT_OPEN（succeeded、没有错误、superseded_by 为保存操作），不碰 Surge，当前出口不变；
 * 更新的版本部署后由它自己的发布等待切换。已开始切换（排队、执行中）或停在 VERIFY_ONLY 的发布不在这里结束：切换在第一次写入
 * 之前与提交之前核对版本（replacedTarget），已替换时不切换或按第 14 步回滚。返回结束的操作 id（调用方随保存一起发布）。
 */
export function endWaitingRouteForNewRevision(engine: Engine, environmentId: string, newRevision: number, savedByOpId: string): string[] {
  const { repos } = engine;
  const label = `v${String(newRevision).padStart(3, '0')}`;
  const ended: string[] = [];
  for (const op of routeOps(engine).waitingRoute) {
    const p = payloadOf(op).route;
    if (!p || p.targetEnvironmentId !== environmentId || p.proxyRevision === newRevision) continue;
    repos.operations.update(op.id, { phase: 'READY_FOR_NEXT_OPEN', status: 'succeeded', supersededBy: savedByOpId });
    repos.operations.appendStep(op.id, 'READY_FOR_NEXT_OPEN', `新版本已部署，未切换：之后又修改了代理（已保存 ${label}），不切换到这一版本，路由未改变`);
    repos.outbox.cancelForOperation(op.id);
    ended.push(op.id);
  }
  return ended;
}

export const OLD_SESSION_LIMITATION =
  '首请求与旧连接处理尚未通过实测：旧环境的长连接与后台请求可能继续一段时间，建议保存工作后退出并重开 Safari 再切换';

/**
 * 未识别场景（原生桥拿不到 SFExtensionProfileKey；默认场景可能就是这样，docs/ARCHITECTURE.md §0.1 第 3 条）的上报记录键。
 * 不是合法的场景 ID（原生桥只接受 [A-Za-z0-9-]{8,64}），不会与已识别场景的记录冲突，也不会被绑定。
 */
export const UNIDENTIFIED_PROFILE_REPORT_KEY = '~unidentified';

/**
 * 记录未识别场景的上报。所有这样的场景共用一条记录，服务无法区分它们，按失败即关闭合并，使记录等于“有效期内是否有未识别
 * 场景上报过有打开的窗口”：本次有窗口时取本次与有效期内记录的较大值、上报时间为本次；本次没有窗口而有效期内的记录有窗口时
 * 原样保留（数值与上报时间：它可能来自另一个未识别场景，不能被覆盖，也不因此延长有效期）；否则以本次为准。代价是同一个场景
 * 关闭全部窗口之后，最长到它上一次有窗口的上报过期前仍计为有打开的窗口（激活时多一次旧窗口确认）。
 */
export function recordUnidentifiedProfileReport(
  engine: Engine,
  report: { windowsOpen: number; amazonTabsOpen: boolean; sitePermissionGranted: boolean },
): void {
  const { repos } = engine;
  const since = engine.now().getTime() - PROFILE_REPORT_FRESH_SEC * 1000;
  const prev = repos.profileReports.get(UNIDENTIFIED_PROFILE_REPORT_KEY);
  const prevOpen = prev !== null && Date.parse(prev.reportedAt) >= since && prev.windowsOpen > 0 ? prev : null;
  const rec = { profileId: UNIDENTIFIED_PROFILE_REPORT_KEY, ...report };
  if (report.windowsOpen > 0) repos.profileReports.upsert({ ...rec, windowsOpen: Math.max(report.windowsOpen, prevOpen?.windowsOpen ?? 0) });
  else if (prevOpen) repos.profileReports.upsert({ ...rec, windowsOpen: prevOpen.windowsOpen, reportedAt: prevOpen.reportedAt });
  else repos.profileReports.upsert(rec);
}

/** 有效期内上报“有打开的窗口”的场景（不含 exclude 中的场景；未识别场景作为一项计入，从不被排除）。 */
function openProfiles(engine: Engine, excludeProfileIds: readonly string[]): NeedsConfirmationDetails['otherProfilesOpen'] {
  const since = new Date(engine.now().getTime() - PROFILE_REPORT_FRESH_SEC * 1000);
  const out: NeedsConfirmationDetails['otherProfilesOpen'] = [];
  for (const r of engine.repos.profileReports.listSince(since)) {
    if (r.windowsOpen <= 0) continue;
    if (r.profileId === UNIDENTIFIED_PROFILE_REPORT_KEY) {
      out.push({ profileIdShort: '', environmentLabel: null, unidentified: true });
      continue;
    }
    if (excludeProfileIds.includes(r.profileId)) continue;
    const b = engine.repos.profileBindings.byProfile(r.profileId);
    const env = b ? engine.repos.environments.get(b.environmentId) : null;
    out.push({ profileIdShort: shortProfileId(r.profileId) ?? '', environmentLabel: env && !env.deletedAt ? labelOf(env) : null });
  }
  return out;
}

/**
 * 激活（target 非 null）或普通模式（target 为 null）是否需要旧窗口确认；不需要时返回 null。
 * 激活：目标与当前活动环境不同，或其他场景在有效期内上报有打开的窗口。普通模式：有托管环境使用中。
 */
export function confirmationNeeded(engine: Engine, target: EnvironmentId | null): NeedsConfirmationDetails | null {
  const route = engine.repos.routeState.get();
  const current = route.activeEnvironmentId;
  const currentEnv = current ? engine.repos.environments.get(current) : null;
  let reason: NeedsConfirmationReason | null = null;
  let others: NeedsConfirmationDetails['otherProfilesOpen'] = [];
  if (target !== null) {
    const targetBinding = engine.repos.profileBindings.byEnvironment(target);
    others = openProfiles(engine, targetBinding ? [targetBinding.profileId] : []);
    if (current !== null && current !== target) reason = 'other_environment_active';
    else if (others.length > 0) reason = 'other_profiles_open';
  } else if (current !== null) {
    reason = 'managed_environment_active';
    others = openProfiles(engine, []);
  }
  if (reason === null) return null;
  const firstRequestOk = engine.missing(['first_request_and_old_connections']).length === 0;
  return {
    reason,
    currentEnvironmentId: current,
    currentEnvironmentLabel: currentEnv ? labelOf(currentEnv) : null,
    otherProfilesOpen: others,
    options: ['closed_confirmed', 'keep_open_acknowledged'],
    limitation: firstRequestOk ? null : OLD_SESSION_LIMITATION,
  };
}

export function needsConfirmationError(action: string, details: NeedsConfirmationDetails): SfeError {
  const message =
    details.reason === 'managed_environment_active'
      ? `${action}需要确认：托管环境${details.currentEnvironmentLabel ? `「${details.currentEnvironmentLabel}」` : ''}正在使用，请选择如何处理其窗口`
      : details.reason === 'other_environment_active'
        ? `${action}需要确认：环境${details.currentEnvironmentLabel ? `「${details.currentEnvironmentLabel}」` : ''}正在使用，请选择如何处理其窗口`
        : `${action}需要确认：其他场景有打开的窗口，请选择如何处理`;
  return new SfeError('NEEDS_CONFIRMATION', message, { details: { ...details } });
}
