// 弹窗与准备页的界面文字（EasyQuick 语气：短句、先说结果；失败写「动作 + 失败：原因」）。

import type {
  EntryMode,
  EnvironmentFacets,
  EnvironmentReadiness,
  NeedsConfirmationDetails,
  OldSessionPolicy,
  OperationPhase,
  OperationStatus,
  RollbackResult,
  RouteSummaryView,
  RouteWarning,
} from '@sfe/contract';

export const WARNING_TEXT: Record<RouteWarning, string> = {
  old_windows_kept_open: '旧环境窗口未关闭，其后续请求会经过当前环境出口',
  managed_windows_on_original_rules: '旧环境窗口未关闭，其后续请求将按 Surge 原规则发出（可能直连）',
  old_session_unproven: '旧环境的连接与后台请求是否已停止尚未经过实测',
  launch_unverified: '本次打开时场景中已有 Amazon 页面，未经启动验证',
  launch_order_unverified: '首请求与旧连接处理尚未通过实测，启动顺序未经验证',
  external_selection_change: 'SFE-ROUTE 的选择在 Surge 中被外部修改，当前未验证',
  external_profile_change: 'Surge 当前配置不是固定工作配置，当前未验证',
  surge_unreachable: '无法连接 Surge，出口状态未知',
  surge_restarted: 'Surge 已重启，入口规则需要重新确认',
  takeover_lost: 'Surge 接管已关闭，Safari 请求可能不经过 Surge',
  takeover_unknown: '无法读取 Surge 接管状态，需要新的 Safari 实测',
  outbound_mode_changed: 'Surge 出站模式不是规则模式',
  entry_unverified: 'Safari 入口规则未能确认',
  precedence_violation: '有其他规则排在本应用入口之前，可能抢先匹配 Safari 流量',
  front_missing: '前置代理在 Surge 中已不存在',
  managed_segments_changed: '本应用管理的配置段被外部修改，已停止同步',
  rollback_needs_reverify: '切换失败，已恢复原节点并保持阻断，需要重新核验',
  probe_expired: '实测出口已过期，请重新检测',
  probe_failed: 'Safari 实测失败，已停止自动打开与填充',
  exit_ip_mismatch: '实测出口与预期出口不一致，已停止自动打开与填充',
  buyer_exit_connections_unconfirmed: '未能确认 Safari 已没有经买家出口的连接，请再次进入普通模式（只结束可能经买家出口的连接）',
};

export const PHASE_TEXT: Record<OperationPhase, string> = {
  SAVED: '已保存',
  VALIDATING: '正在校验',
  WAITING_DEPLOYMENT: '已保存，待部署',
  DEPLOYING: '正在同步到 Surge',
  DEPLOYED_UNVERIFIED: '已部署，未预检',
  PREFLIGHT_OK: '代理预检通过',
  READY_FOR_NEXT_OPEN: '已部署，下次打开时生效',
  WAITING_ROUTE: '等待在绑定场景中切换',
  SAFARI_BLOCKED: 'Safari 已暂时阻断',
  VERIFY_ONLY: '等待 Safari 出口检测',
  ACTIVE_VERIFIED: '已切换并通过检测',
  NORMAL_RESTORED: '已进入普通模式',
  COMPLETED: '已完成',
  RECONCILING: '正在核对 Surge 状态',
  ROLLING_BACK: '正在回滚',
  FAILED: '失败',
  SUPERSEDED: '已被新的操作取代',
  BLOCKED_NEEDS_ATTENTION: 'Safari 保持阻断，需要处理',
};

export type BadgeStatus = 'success' | 'warning' | 'error' | 'info';

export const READINESS_BADGE: Record<EnvironmentReadiness, { status: BadgeStatus; label: string }> = {
  invalid: { status: 'error', label: '数据无效' },
  needs_binding: { status: 'info', label: '待关联' },
  waiting_deployment: { status: 'warning', label: '待部署' },
  deploying: { status: 'info', label: '同步中' },
  sync_failed: { status: 'error', label: '同步失败' },
  proxy_unavailable: { status: 'error', label: '代理不可用' },
  deployed_unverified: { status: 'info', label: '已部署，未预检' },
  ready: { status: 'success', label: '就绪' },
  activating: { status: 'warning', label: '切换中' },
  active: { status: 'success', label: '使用中' },
  needs_reverify: { status: 'warning', label: '需要重新核验' },
};

export const DEPLOYMENT_TEXT: Record<EnvironmentFacets['deployment'], string> = {
  none: '未同步',
  pending: '已保存，待部署',
  blocked_by_capability: '待部署：发布能力尚未通过实测',
  deploying: '正在同步',
  deployed: '已同步',
  readback_partial: '已部署，读回不完整',
  failed: '同步失败',
};

export const ENTRY_MODE_TEXT: Record<EntryMode, string> = {
  NORMAL: '普通模式',
  BLOCKED: 'Safari 已阻断',
  VERIFY_ONLY: '仅允许出口检测',
  ACTIVE: '托管中',
  UNKNOWN: '入口状态未知',
};

/**
 * 路由摘要是否提供「进入普通模式」（§6.5）：服务端判定的 normalModeOffered；其余几项是同一判断中摘要看得到的部分。
 * 只看入口模式不够：回滚失败可能把入口记为 NORMAL（阶段 attention），普通模式结束连接失败之后读回也可能失败，路由记录
 * 看起来已是普通模式，而 Safari 仍有经买家出口的连接。
 */
export function summaryOffersNormal(summary: RouteSummaryView): boolean {
  return (
    summary.normalModeOffered === true ||
    summary.entryMode !== 'NORMAL' ||
    summary.phase !== 'idle' ||
    summary.buyerExitConnectionsUnconfirmed === true
  );
}

/** 弹窗顶栏的入口状态：入口记为普通模式、但服务端仍提供「进入普通模式」时不显示成单纯的「普通模式」。 */
export function entryModeHeaderText(summary: RouteSummaryView): string {
  if (summary.entryMode === 'NORMAL' && summaryOffersNormal(summary)) return '普通模式（未确认）';
  return ENTRY_MODE_TEXT[summary.entryMode];
}

/**
 * 没有使用中的环境、但路由没有回到已确认的普通模式时的说明（不含 buyer_exit_connections_unconfirmed：那时显示
 * WARNING_TEXT 中的警告）。
 */
export function unsettledRouteText(summary: RouteSummaryView): string {
  if (summary.entryMode !== 'NORMAL') {
    return `当前没有使用中的环境，入口为「${ENTRY_MODE_TEXT[summary.entryMode]}」（上一次切换没有完成）：Safari 的请求可能被阻断，或仍有经买家出口的连接。进入普通模式会撤销本应用入口并结束这些连接。`;
  }
  return '上一次切换没有回到已确认的状态：Safari 可能仍有经买家出口的连接。进入普通模式会结束这些连接，之后按 Surge 原规则发出请求。';
}

export const PENDING_KIND_TEXT: Record<'activate' | 'apply_new_revision' | 'reverify' | 'probe_safari', string> = {
  activate: '切换到此环境',
  apply_new_revision: '切换到新版本',
  reverify: '重新核验',
  probe_safari: '重新检测出口',
};

export function statusIsTerminal(status: OperationStatus): boolean {
  return status !== 'queued' && status !== 'running' && status !== 'waiting';
}

export function isExpired(iso: string | null | undefined, now: Date): boolean {
  if (!iso) return true;
  const t = Date.parse(iso);
  return Number.isNaN(t) || t <= now.getTime();
}

/** 刚刚 / 12 秒前 / 3 分钟前 / 2 小时前 / 3 天前。 */
export function formatRelative(iso: string | null | undefined, now: Date): string {
  if (!iso) return '未知时间';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '未知时间';
  const sec = Math.max(0, Math.round((now.getTime() - t) / 1000));
  if (sec < 5) return '刚刚';
  if (sec < 60) return `${sec} 秒前`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hours = Math.floor(min / 60);
  if (hours < 48) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

export function rollbackText(rollback: RollbackResult): string {
  const parts: string[] = [];
  if (rollback.restoredSelection) {
    parts.push(`已恢复原节点 ${rollback.restoredSelection}`);
  } else {
    parts.push('未能恢复原节点');
  }
  parts.push(rollback.entryModeAfter === 'BLOCKED' ? 'Safari 保持阻断' : `入口为${ENTRY_MODE_TEXT[rollback.entryModeAfter]}`);
  if (rollback.needsReverify) parts.push('需要重新核验原环境');
  let text = `${parts.join('，')}。`;
  if (rollback.previousProbe?.exitIp) text += `上次结果：出口 ${rollback.previousProbe.exitIp}。`;
  return text;
}

export function confirmationTitle(kind: 'activate' | 'normal'): string {
  return kind === 'activate' ? '确定要切换到此环境吗？' : '确定要进入普通模式吗？';
}

export function confirmationReason(kind: 'activate' | 'normal', details: NeedsConfirmationDetails): string {
  const label = details.currentEnvironmentLabel ? `「${details.currentEnvironmentLabel}」` : '另一个环境';
  switch (details.reason) {
    case 'other_environment_active':
      return `当前正在使用${label}。切换会先阻断 Safari 并结束其旧连接，Chrome 不受影响。`;
    case 'managed_environment_active':
      return kind === 'normal'
        ? `当前正在使用${label}。进入普通模式后，Safari 将按 Surge 原规则访问网络。`
        : `当前正在使用${label}。`;
    case 'other_profiles_open':
      return '其他 Safari 场景有打开的窗口。整个 Safari 同一时刻只使用一个出口。';
  }
}

export const POLICY_BUTTON: Record<OldSessionPolicy, string> = {
  closed_confirmed: '已关闭，继续',
  keep_open_acknowledged: '不关闭，继续',
};

export function policyConsequence(kind: 'activate' | 'normal', policy: OldSessionPolicy): string {
  if (policy === 'closed_confirmed') {
    return '已关闭旧窗口：请先保存工作并关闭旧环境的 Safari 窗口再继续。Safari 的旧连接会被结束。';
  }
  return kind === 'activate'
    ? '不关闭旧窗口：旧窗口之后的请求会经过新环境出口（整个 Safari 同一时刻只用一个出口）。状态会持续显示警告，直到你确认已关闭。'
    : '不关闭旧窗口：旧窗口之后的请求将按 Surge 原规则发出（可能直连）。状态会持续显示警告，直到你确认已关闭。';
}
