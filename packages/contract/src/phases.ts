// 任务阶段、入口模式与能力门槛。名称与 docs/DEVELOPMENT.md §3 和实时同步设计 §7 保持一致。

/** 操作（Operation）阶段。202 只代表 SAVED，不代表网络已生效。 */
export const OPERATION_PHASES = [
  'SAVED',
  'VALIDATING',
  'WAITING_DEPLOYMENT',
  'DEPLOYING',
  'DEPLOYED_UNVERIFIED',
  'PREFLIGHT_OK',
  'READY_FOR_NEXT_OPEN',
  'NEEDS_CONFIRMATION',
  'SAFARI_BLOCKED',
  'VERIFY_ONLY',
  'ACTIVE_VERIFIED',
  'NORMAL_RESTORED',
  'COMPLETED',
  'RECONCILING',
  'ROLLING_BACK',
  'FAILED',
  'BLOCKED_NEEDS_ATTENTION',
] as const;
export type OperationPhase = (typeof OPERATION_PHASES)[number];

/**
 * 终止阶段：执行器不再推进。WAITING_DEPLOYMENT 与 DEPLOYED_UNVERIFIED 是“停泊”终态，
 * 只有新的显式请求（发布待部署、激活）才会继续。
 */
export const TERMINAL_PHASES: readonly OperationPhase[] = [
  'WAITING_DEPLOYMENT',
  'DEPLOYED_UNVERIFIED',
  'READY_FOR_NEXT_OPEN',
  'NEEDS_CONFIRMATION',
  'ACTIVE_VERIFIED',
  'NORMAL_RESTORED',
  'COMPLETED',
  'FAILED',
  'BLOCKED_NEEDS_ATTENTION',
];

export function isTerminalPhase(phase: OperationPhase): boolean {
  return TERMINAL_PHASES.includes(phase);
}

export type OperationStatus = 'queued' | 'running' | 'succeeded' | 'parked' | 'failed' | 'needs_attention';

export const OPERATION_KINDS = [
  'environment.create',
  'environment.update',
  'environment.delete',
  'binding.bind',
  'binding.unbind',
  'import.batch',
  'deploy.publish',
  'route.activate',
  'route.normal',
  'probe.preflight',
  'maintenance.init',
  'maintenance.reconcile',
] as const;
export type OperationKind = (typeof OPERATION_KINDS)[number];

/**
 * Safari 专用入口的四种逻辑模式（实时同步设计 §7）。UNKNOWN 表示读回失败或外部修改，
 * 不得当作 NORMAL 或 ACTIVE 使用。
 */
export const ENTRY_MODES = ['NORMAL', 'BLOCKED', 'VERIFY_ONLY', 'ACTIVE', 'UNKNOWN'] as const;
export type EntryMode = (typeof ENTRY_MODES)[number];

/** 入口模式的“放行程度”，用于保证切换过程中的每个中间状态都不比两端更宽松。 */
export const ENTRY_PERMISSIVENESS: Record<Exclude<EntryMode, 'UNKNOWN'>, number> = {
  BLOCKED: 0,
  VERIFY_ONLY: 1,
  ACTIVE: 2,
  // NORMAL 让 Safari 走用户原规则，对托管环境来说是“完全不受控”，因此最宽松。
  NORMAL: 3,
};

export type RoutePhase =
  | 'idle'
  | 'switching'
  | 'awaiting_safari_verify'
  | 'active_verified'
  | 'rolling_back'
  | 'failed'
  | 'external_change'
  | 'attention';

/** 旧环境窗口处理方式（用户选择：提示手动关闭，也可选择不关闭直接切换）。 */
export type OldSessionPolicy = 'closed_confirmed' | 'keep_open_acknowledged';

/** P0 能力门槛。每项记录支持/不支持/待验证与实测依据；Surge 版本变化后自动回到待验证。 */
export const CAPABILITY_KEYS = [
  'safari_process_attribution',
  'native_profile_id',
  'fixed_profile_no_switch',
  'runtime_entry_modes',
  'targeted_resource_refresh',
  'policy_path_reread',
  'connection_continuity',
  'first_request_and_old_connections',
  'independent_node_preflight',
  'auto_reload_atomic_replace',
  'entry_rules_after_restart',
] as const;
export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];
export type CapabilityStatus = 'supported' | 'unsupported' | 'unverified';

export const CAPABILITY_LABELS: Record<CapabilityKey, string> = {
  safari_process_attribution: 'Safari 精确进程归属',
  native_profile_id: '原生场景 ID 稳定性',
  fixed_profile_no_switch: '固定配置日常不切换',
  runtime_entry_modes: '运行时入口四种模式',
  targeted_resource_refresh: '节点资源定向刷新',
  policy_path_reread: '本地 policy-path 重新读取',
  connection_continuity: '其他应用连接连续性',
  first_request_and_old_connections: '首请求与旧连接处理',
  independent_node_preflight: '候选节点独立预检',
  auto_reload_atomic_replace: '自动重载与原子替换行为',
  entry_rules_after_restart: 'Surge 重启后入口规则生命周期',
};

/** 入口模式的实现策略，均需 P0 实测后才能启用。 */
export type EntryStrategy = 'ruleset_resource' | 'temp_rule';
