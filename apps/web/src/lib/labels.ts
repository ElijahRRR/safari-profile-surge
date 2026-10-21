// 状态、阶段与警告的中文文案及徽章颜色。状态永远同时给文字与颜色；颜色与含义一致。

import type {
  BindingView,
  CapabilityContextField,
  CapabilityStatus,
  EntryMode,
  EntryStrategy,
  EnvironmentFacets,
  EnvironmentReadiness,
  FrontProxyState,
  ImportRowStatus,
  OperationKind,
  OperationPhase,
  OperationStatus,
  ProbeOutcome,
  ProtocolCoverageItem,
  RoutePhase,
  RouteWarning,
} from '@sfe/contract';
import type { BadgeVariant } from '@sfe/easyquick';

export interface StatusLabel {
  label: string;
  variant: BadgeVariant;
}

export const READINESS_LABELS: Record<EnvironmentReadiness, StatusLabel> = {
  invalid: { label: '数据有误', variant: 'danger' },
  needs_binding: { label: '待关联', variant: 'warning' },
  waiting_deployment: { label: '待部署', variant: 'warning' },
  deploying: { label: '同步中', variant: 'primary' },
  sync_failed: { label: '同步失败', variant: 'danger' },
  proxy_unavailable: { label: '代理不可用', variant: 'danger' },
  deployed_unverified: { label: '已部署，待实测', variant: 'primary' },
  ready: { label: '可使用', variant: 'success' },
  activating: { label: '切换中', variant: 'primary' },
  active: { label: '使用中', variant: 'success' },
  needs_reverify: { label: '需要重新核验', variant: 'warning' },
};

export type WarningSeverity = 'danger' | 'warning';

/** 路由警告：带警告时界面永不显示为无警告的绿色。 */
export const ROUTE_WARNING_TEXT: Record<RouteWarning, { text: string; severity: WarningSeverity }> = {
  old_windows_kept_open: { text: '旧环境窗口未关闭，其后续请求将使用当前出口', severity: 'warning' },
  managed_windows_on_original_rules: { text: '旧环境窗口未关闭，其后续请求将按 Surge 原规则发出（可能直连）', severity: 'warning' },
  old_session_unproven: { text: '旧环境的后台请求与长连接是否已停止尚未经实测证明', severity: 'warning' },
  launch_unverified: { text: '本次打开未经启动验证', severity: 'warning' },
  launch_order_unverified: { text: '启动顺序未经实测：首个业务请求是否已走新出口尚未证明', severity: 'warning' },
  external_selection_change: { text: 'SFE-ROUTE 的选择在 Surge 中被外部修改，当前未验证', severity: 'danger' },
  external_profile_change: { text: 'Surge 已切到其他配置，当前未验证', severity: 'danger' },
  surge_unreachable: { text: '无法连接 Surge，路由状态无法确认', severity: 'danger' },
  surge_restarted: { text: 'Surge 已重启，入口规则需要重新确认', severity: 'danger' },
  takeover_lost: { text: 'Surge 接管已关闭，Safari 请求不再经过 Surge', severity: 'danger' },
  takeover_unknown: { text: '接管状态无法读取', severity: 'warning' },
  outbound_mode_changed: { text: 'Surge 出站模式不是规则模式，本应用入口不生效', severity: 'danger' },
  entry_unverified: { text: '入口规则未能读回确认', severity: 'danger' },
  precedence_violation: { text: '有其他规则排在本应用入口之前，可能抢先匹配 Safari 请求', severity: 'danger' },
  front_missing: { text: '前置代理在 Surge 中已不存在', severity: 'danger' },
  managed_segments_changed: { text: '受管理段或本应用文件被外部修改，已停止同步', severity: 'danger' },
  rollback_needs_reverify: { text: '切换失败，已恢复原节点并保持阻断，需要重新核验', severity: 'warning' },
  probe_expired: { text: 'Safari 实测已过期，显示的是上次结果', severity: 'warning' },
  probe_failed: { text: '最近一次 Safari 实测失败，已停止自动打开订单与填充', severity: 'danger' },
  exit_ip_mismatch: { text: '实测出口与预期出口不一致，已停止自动打开订单与填充', severity: 'danger' },
};

export function warningText(w: RouteWarning): string {
  return ROUTE_WARNING_TEXT[w]?.text ?? `未知警告：${w}`;
}

export const ENTRY_MODE_LABELS: Record<EntryMode, StatusLabel> = {
  NORMAL: { label: '普通模式', variant: 'gray' },
  BLOCKED: { label: '已阻断', variant: 'warning' },
  VERIFY_ONLY: { label: '仅允许检测', variant: 'primary' },
  ACTIVE: { label: '受控', variant: 'success' },
  UNKNOWN: { label: '未知', variant: 'danger' },
};

export const ROUTE_PHASE_LABELS: Record<RoutePhase, StatusLabel> = {
  idle: { label: '空闲', variant: 'gray' },
  switching: { label: '切换中', variant: 'primary' },
  awaiting_safari_verify: { label: '等待 Safari 实测', variant: 'primary' },
  active_verified: { label: '已验证', variant: 'success' },
  rolling_back: { label: '回滚中', variant: 'warning' },
  failed: { label: '切换失败', variant: 'danger' },
  external_change: { label: '外部修改', variant: 'danger' },
  attention: { label: '需要处理', variant: 'danger' },
};

export const OPERATION_PHASE_LABELS: Record<OperationPhase, StatusLabel> = {
  SAVED: { label: '已保存', variant: 'gray' },
  VALIDATING: { label: '校验中', variant: 'primary' },
  WAITING_DEPLOYMENT: { label: '待部署', variant: 'warning' },
  DEPLOYING: { label: '部署中', variant: 'primary' },
  DEPLOYED_UNVERIFIED: { label: '已部署，未验证', variant: 'warning' },
  PREFLIGHT_OK: { label: '预检通过', variant: 'success' },
  READY_FOR_NEXT_OPEN: { label: '可供下次打开', variant: 'success' },
  WAITING_ROUTE: { label: '等待场景打开', variant: 'warning' },
  SAFARI_BLOCKED: { label: 'Safari 已阻断', variant: 'warning' },
  VERIFY_ONLY: { label: '等待 Safari 实测', variant: 'warning' },
  ACTIVE_VERIFIED: { label: '已生效', variant: 'success' },
  NORMAL_RESTORED: { label: '已恢复普通模式', variant: 'success' },
  COMPLETED: { label: '已完成', variant: 'success' },
  RECONCILING: { label: '核对中', variant: 'warning' },
  ROLLING_BACK: { label: '回滚中', variant: 'warning' },
  FAILED: { label: '失败', variant: 'danger' },
  SUPERSEDED: { label: '已被取代', variant: 'gray' },
  BLOCKED_NEEDS_ATTENTION: { label: '已阻断，需要处理', variant: 'danger' },
};

export const OPERATION_STATUS_LABELS: Record<OperationStatus, StatusLabel> = {
  queued: { label: '排队中', variant: 'gray' },
  running: { label: '执行中', variant: 'primary' },
  waiting: { label: '等待中', variant: 'warning' },
  succeeded: { label: '已完成', variant: 'success' },
  parked: { label: '待继续', variant: 'warning' },
  failed: { label: '失败', variant: 'danger' },
  superseded: { label: '已被取代', variant: 'gray' },
  needs_attention: { label: '需要处理', variant: 'danger' },
};

/** StatusBadge 的状态点颜色。 */
export function operationStatusDot(status: OperationStatus): string {
  switch (status) {
    case 'succeeded':
      return 'success';
    case 'failed':
    case 'needs_attention':
      return 'danger';
    case 'waiting':
    case 'parked':
      return 'warning';
    default:
      return 'unknown';
  }
}

export const OPERATION_KIND_LABELS: Record<OperationKind, string> = {
  'environment.create': '新建环境',
  'environment.update': '修改环境',
  'environment.delete': '删除环境',
  'binding.bind': '关联场景',
  'binding.unbind': '解除绑定',
  'import.batch': '导入',
  'deploy.publish': '发布节点',
  'front.replace': '更换前置',
  'front.verify': '核验前置',
  'route.activate': '切换环境',
  'route.normal': '进入普通模式',
  'probe.preflight': '代理预检',
  'probe.safari': 'Safari 重测',
  'maintenance.init': '初始化工作配置',
  'maintenance.remerge': '重新合并',
  'maintenance.reconcile': '对账',
};

export const CAPABILITY_STATUS_LABELS: Record<CapabilityStatus, StatusLabel> = {
  supported: { label: '已通过', variant: 'success' },
  unsupported: { label: '不支持', variant: 'danger' },
  unverified: { label: '待验证', variant: 'gray' },
};

export const CONTEXT_FIELD_LABELS: Record<CapabilityContextField, string> = {
  surgeVersion: 'Surge 版本',
  surgeBuild: 'Surge 构建',
  macosBuild: 'macOS 构建',
  safariVersion: 'Safari 版本',
  entryStrategy: '入口策略',
  processPathsDigest: '进程路径摘要',
  workingProfileId: '工作配置',
  autoReload: '自动重载',
  takeoverMode: '接管方式',
  signingIdentity: '签名身份',
  adapterMechanism: '原语实现',
};

export const ENTRY_STRATEGY_LABELS: Record<EntryStrategy, string> = {
  temp_rule: '临时规则（temp_rule）',
  ruleset_resource: '规则集资源（ruleset_resource）',
};

export const COVERAGE_ITEM_LABELS: Record<ProtocolCoverageItem, string> = {
  ipv4: 'IPv4',
  ipv6: 'IPv6',
  http1: 'HTTP/1.1',
  http2: 'HTTP/2',
  http3_quic: 'HTTP/3（QUIC）',
  websocket: 'WebSocket',
  extension_page_fetch: '扩展页面请求',
  webrtc: 'WebRTC',
  dns: 'DNS',
  system_services: '系统服务',
};

export const COVERAGE_RESULT_LABELS: Record<'pass' | 'fail' | 'limitation' | 'not_tested', StatusLabel> = {
  pass: { label: '通过', variant: 'success' },
  fail: { label: '不通过', variant: 'danger' },
  limitation: { label: '有限制', variant: 'warning' },
  not_tested: { label: '未测试', variant: 'gray' },
};

export const BINDING_LABELS: Record<BindingView['state'], StatusLabel> = {
  unbound: { label: '未关联', variant: 'gray' },
  bound: { label: '已关联', variant: 'success' },
  bound_unverified_id: { label: '已关联，场景 ID 未验证', variant: 'warning' },
};

export const BINDING_STAGE_LABELS: Record<NonNullable<BindingView['stage']>, string> = {
  awaiting_profile: '等待创建 Safari 场景',
  awaiting_extension: '等待启用扩展并授权',
  awaiting_association: '等待在扩展中关联',
};

export const DEPLOYMENT_FACET_LABELS: Record<EnvironmentFacets['deployment'], StatusLabel> = {
  none: { label: '未部署', variant: 'gray' },
  pending: { label: '待部署', variant: 'warning' },
  blocked_by_capability: { label: '待部署：能力未通过', variant: 'warning' },
  deploying: { label: '部署中', variant: 'primary' },
  deployed: { label: '已部署', variant: 'success' },
  readback_partial: { label: '已部署，读回不完整', variant: 'warning' },
  failed: { label: '同步失败', variant: 'danger' },
};

export const FRONT_STATE_LABELS: Record<FrontProxyState, StatusLabel> = {
  unverified: { label: '待核验', variant: 'gray' },
  ok: { label: '正常', variant: 'success' },
  missing: { label: '已丢失', variant: 'danger' },
  failed: { label: '核验失败', variant: 'danger' },
};

export const PROBE_OUTCOME_LABELS: Record<ProbeOutcome, StatusLabel> = {
  ok: { label: '通过', variant: 'success' },
  failed: { label: '失败', variant: 'danger' },
  mismatch: { label: '出口不符', variant: 'danger' },
  inconclusive: { label: '无法判定', variant: 'warning' },
};

export const IMPORT_STATUS_LABELS: Record<ImportRowStatus | 'skipped' | 'revision_conflict', StatusLabel> = {
  create: { label: '新建', variant: 'primary' },
  update: { label: '更新', variant: 'purple' },
  unchanged: { label: '无变化', variant: 'gray' },
  conflict: { label: '同名冲突', variant: 'warning' },
  invalid: { label: '无效', variant: 'danger' },
  skipped: { label: '已跳过', variant: 'gray' },
  revision_conflict: { label: '版本冲突', variant: 'danger' },
};

export const TAKEOVER_OUTBOUND_LABELS: Record<'rule' | 'direct' | 'proxy', string> = {
  rule: '规则模式',
  direct: '直接连接',
  proxy: '全局代理',
};

export const DIRECTORY_RISK_LABELS: Record<'none' | 'synced' | 'protected', StatusLabel> = {
  none: { label: '无风险', variant: 'success' },
  synced: { label: '位于同步目录', variant: 'danger' },
  protected: { label: '位于受保护位置', variant: 'danger' },
};

export function boolLabel(value: boolean | null | undefined, yes = '开启', no = '关闭'): string {
  if (value === null || value === undefined) return '无法读取';
  return value ? yes : no;
}
