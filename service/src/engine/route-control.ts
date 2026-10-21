// 路由操作并发矩阵与旧窗口确认（docs/ARCHITECTURE.md §6.1、§6.3 受理、§6.5）。按操作状态判断：
// queued/running → 新的路由操作返回 ROUTE_BUSY；等待中的激活/重测 → 新的激活或普通模式把它结束为
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

export function routeBusyError(action: string): SfeError {
  return new SfeError('ROUTE_BUSY', `${action}失败：正在切换出口或检测，请稍后再试`);
}

/** 新的激活或普通模式：在受理事务中结束等待中的路由操作。返回受影响的操作 id。 */
export function supersedeWaiting(engine: Engine, newOpId: string, state: RouteOpsState): string[] {
  const { repos } = engine;
  const touched: string[] = [];
  let bump = false;
  for (const op of state.waitingVerification) {
    repos.operations.update(op.id, {
      phase: 'SUPERSEDED',
      status: 'superseded',
      supersededBy: newOpId,
      error: { code: 'SUPERSEDED', message: '已被新的切换请求取代' },
    });
    repos.operations.appendStep(op.id, 'SUPERSEDED', '已被新的切换请求取代，检测编号作废');
    repos.outbox.cancelForOperation(op.id);
    touched.push(op.id);
    bump = true;
  }
  for (const op of state.waitingRoute) {
    repos.operations.update(op.id, { phase: 'READY_FOR_NEXT_OPEN', status: 'succeeded', supersededBy: newOpId });
    repos.operations.appendStep(op.id, 'READY_FOR_NEXT_OPEN', '新版本已部署，未切换：已有新的切换请求');
    repos.outbox.cancelForOperation(op.id);
    touched.push(op.id);
  }
  if (bump) {
    const route = repos.routeState.get();
    repos.routeState.update({ routeEpoch: route.routeEpoch + 1, operationId: newOpId, awaitingDeadline: null });
  }
  return touched;
}

export const OLD_SESSION_LIMITATION =
  '首请求与旧连接处理尚未通过实测：旧环境的长连接与后台请求可能继续一段时间，建议保存工作后退出并重开 Safari 再切换';

/** 有效期内上报“有打开的窗口”的场景（不含 exclude 中的场景）。 */
function openProfiles(engine: Engine, excludeProfileIds: readonly string[]): NeedsConfirmationDetails['otherProfilesOpen'] {
  const since = new Date(engine.now().getTime() - PROFILE_REPORT_FRESH_SEC * 1000);
  const out: NeedsConfirmationDetails['otherProfilesOpen'] = [];
  for (const r of engine.repos.profileReports.listSince(since)) {
    if (r.windowsOpen <= 0 || excludeProfileIds.includes(r.profileId)) continue;
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
