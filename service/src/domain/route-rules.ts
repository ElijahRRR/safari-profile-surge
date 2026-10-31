// 路由“受控”判定与警告分类（docs/ARCHITECTURE.md §6.3 第 1 步、§6.4、§6.6）。纯函数：只看数据库中的
// 路由状态与最近一次 Safari 实测；动作前的短超时对账在 engine/reconcile.ts 中先刷新这些状态。

import type { RouteWarning } from '@sfe/contract';
import type { ProbeRecord, RouteStateRecord } from '../db/index.js';

/** 激活复用被阻断（改为完整切换）。 */
export const REUSE_BLOCKING_WARNINGS: readonly RouteWarning[] = [
  'external_selection_change',
  'external_profile_change',
  'rollback_needs_reverify',
  'surge_unreachable',
  'surge_restarted',
  'entry_unverified',
  'takeover_lost',
  'outbound_mode_changed',
  'precedence_violation',
  'front_missing',
  'managed_segments_changed',
  'node_resource_unverified',
];

/**
 * 失控类警告：存在时不允许 Safari 重测（需要重新激活或进入普通模式）。受管理段被修改与节点资源未确认（D10）不在其中：
 * 它们不表示入口或 SFE-ROUTE 的选择失去控制，对账已把阶段改为 attention（ATTENTION_WARNINGS），重测只接受已验证的使用中
 * 路由；节点资源未确认只在确认过的发布或回滚读回之后清除，重测不能清除它。
 */
export const LOSS_OF_CONTROL_WARNINGS: readonly RouteWarning[] = [
  'surge_unreachable',
  'surge_restarted',
  'entry_unverified',
  'takeover_lost',
  'outbound_mode_changed',
  'external_selection_change',
  'external_profile_change',
  'precedence_violation',
];

/** “受控”定义中不允许出现的警告。 */
export const IN_CONTROL_BLOCKING_WARNINGS: readonly RouteWarning[] = [
  'takeover_lost',
  'outbound_mode_changed',
  'external_selection_change',
  'external_profile_change',
  'surge_unreachable',
  'surge_restarted',
  'precedence_violation',
  'entry_unverified',
  'front_missing',
  'managed_segments_changed',
  'probe_failed',
  'exit_ip_mismatch',
  'rollback_needs_reverify',
  'node_resource_unverified',
];

/** 对账把阶段设为 attention 的警告（external_* 设为 external_change）。 */
export const ATTENTION_WARNINGS: readonly RouteWarning[] = [
  'surge_unreachable',
  'surge_restarted',
  'entry_unverified',
  'takeover_lost',
  'outbound_mode_changed',
  'precedence_violation',
  'managed_segments_changed',
  'node_resource_unverified',
];

export function hasAny(warnings: readonly RouteWarning[], set: readonly RouteWarning[]): RouteWarning[] {
  return warnings.filter((w) => set.includes(w));
}

/** 最近 Safari 实测是否可用于“受控”：ok、当前 epoch、活动版本、未过期。 */
export function safariProbeCurrent(route: RouteStateRecord, probe: ProbeRecord | null, now: Date): boolean {
  if (!probe || probe.kind !== 'safari' || probe.outcome !== 'ok') return false;
  if (route.activeEnvironmentId === null || probe.environmentId !== route.activeEnvironmentId) return false;
  if (probe.routeEpoch !== route.routeEpoch) return false;
  if (probe.proxyRevision !== route.activeProxyRevision) return false;
  return Date.parse(probe.expiresAt) > now.getTime();
}

export interface ControlEvaluation {
  ok: boolean;
  reason: string | null;
}

/**
 * 动作前检查（engine/app-service.ts ensureInControl）的结果。checked 为 false：有效期内没有完成过对账（执行器正忙、读取 Surge
 * 超时或失败），路由记录可能还没有反映 Surge 的变化（例如 Surge 重启之后临时规则已丢弃），ok 一定为 false。
 */
export interface PrecheckEvaluation extends ControlEvaluation {
  checked: boolean;
}

/** 只按数据库状态判定“受控”（不读 Surge）。 */
export function evaluateControl(route: RouteStateRecord, probe: ProbeRecord | null, now: Date): ControlEvaluation {
  if (route.activeEnvironmentId === null) return { ok: false, reason: '当前没有使用中的环境' };
  if (route.phase !== 'active_verified') return { ok: false, reason: '路由不在已验证状态' };
  if (route.entryMode !== 'ACTIVE') return { ok: false, reason: 'Safari 入口不是使用中模式' };
  if (route.selectedNode === null) return { ok: false, reason: '没有读到 SFE-ROUTE 的选择' };
  const blocking = hasAny(route.warnings, IN_CONTROL_BLOCKING_WARNINGS);
  if (blocking.length > 0) return { ok: false, reason: `路由有需要处理的警告：${blocking.join('、')}` };
  if (!safariProbeCurrent(route, probe, now)) return { ok: false, reason: '实测出口已过期或未通过，请重新检测' };
  return { ok: true, reason: null };
}
