// 任务阶段、入口模式与能力门槛。名称与 docs/DEVELOPMENT.md §3 和实时同步设计 §7 保持一致。

/**
 * 操作（Operation）阶段。202 只代表 SAVED，不代表网络已生效。
 * NEEDS_CONFIRMATION 不是阶段：它是受理时的同步 409，不创建操作、不占用 request_id。
 */
export const OPERATION_PHASES = [
  'SAVED',
  'VALIDATING',
  'WAITING_DEPLOYMENT',
  'DEPLOYING',
  'DEPLOYED_UNVERIFIED',
  'PREFLIGHT_OK',
  'READY_FOR_NEXT_OPEN',
  'WAITING_ROUTE',
  'SAFARI_BLOCKED',
  'VERIFY_ONLY',
  'ACTIVE_VERIFIED',
  'NORMAL_RESTORED',
  'COMPLETED',
  'RECONCILING',
  'ROLLING_BACK',
  'FAILED',
  'SUPERSEDED',
  'BLOCKED_NEEDS_ATTENTION',
] as const;
export type OperationPhase = (typeof OPERATION_PHASES)[number];

/**
 * 终止阶段：执行器不再推进。WAITING_DEPLOYMENT 与 DEPLOYED_UNVERIFIED 是“停泊”终态，
 * 只有新的显式请求（发布待部署、激活）才会继续。WAITING_ROUTE 与 VERIFY_ONLY 不是终态：
 * 它们等待目标场景到达或 Safari 实测（status = waiting）。
 */
export const TERMINAL_PHASES: readonly OperationPhase[] = [
  'WAITING_DEPLOYMENT',
  'DEPLOYED_UNVERIFIED',
  'READY_FOR_NEXT_OPEN',
  'ACTIVE_VERIFIED',
  'NORMAL_RESTORED',
  'COMPLETED',
  'FAILED',
  'SUPERSEDED',
  'BLOCKED_NEEDS_ATTENTION',
];

export function isTerminalPhase(phase: OperationPhase): boolean {
  return TERMINAL_PHASES.includes(phase);
}

/** waiting：挂起等待外部事件（目标场景到达、Safari 实测），不占用执行器。 */
export type OperationStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'succeeded'
  | 'parked'
  | 'failed'
  | 'superseded'
  | 'needs_attention';

export const OPERATION_KINDS = [
  'environment.create',
  'environment.update',
  'environment.delete',
  'binding.bind',
  'binding.unbind',
  'import.batch',
  'deploy.publish',
  'front.replace',
  'front.verify',
  'route.activate',
  'route.normal',
  'probe.preflight',
  'probe.safari',
  'maintenance.init',
  'maintenance.remerge',
  'maintenance.reconcile',
] as const;
export type OperationKind = (typeof OPERATION_KINDS)[number];

/**
 * Safari 专用入口的四种逻辑模式（实时同步设计 §7）。UNKNOWN 表示读回失败、外部修改或
 * 规则优先级被其他规则抢先，不得当作 NORMAL 或 ACTIVE 使用。
 */
export const ENTRY_MODES = ['NORMAL', 'BLOCKED', 'VERIFY_ONLY', 'ACTIVE', 'UNKNOWN'] as const;
export type EntryMode = (typeof ENTRY_MODES)[number];
export type KnownEntryMode = Exclude<EntryMode, 'UNKNOWN'>;

/**
 * 入口由四个“位”组成，规则顺序 udp > verify > block > active > 用户规则：
 * udp    Safari 进程的 UDP（含 QUIC/H3）→ REJECT，避免 SOCKS5 链不支持 UDP 时回落直连；
 * verify Safari 进程且目标为检测域名 → SFE-ROUTE；
 * block  Safari 进程 → REJECT；
 * active Safari 进程 → SFE-ROUTE。
 */
export interface EntryBits {
  udp: boolean;
  verify: boolean;
  block: boolean;
  active: boolean;
}

export const ENTRY_MODE_BITS: Record<KnownEntryMode, EntryBits> = {
  NORMAL: { udp: false, verify: false, block: false, active: false },
  BLOCKED: { udp: true, verify: false, block: true, active: false },
  VERIFY_ONLY: { udp: true, verify: true, block: true, active: false },
  ACTIVE: { udp: true, verify: false, block: false, active: true },
};

/** 按规则顺序求有效模式；不对应任何已知组合时返回其“最接近的效果”供断言使用。 */
export function effectiveEntryMode(bits: EntryBits): KnownEntryMode | 'ACTIVE_WITHOUT_UDP_BLOCK' | 'VERIFY_WITHOUT_BLOCK' {
  if (bits.block) return bits.verify ? 'VERIFY_ONLY' : 'BLOCKED';
  if (bits.verify) return 'VERIFY_WITHOUT_BLOCK';
  if (bits.active) return bits.udp ? 'ACTIVE' : 'ACTIVE_WITHOUT_UDP_BLOCK';
  return 'NORMAL';
}

/** 入口模式的“放行程度”，用于保证切换过程中每个中间状态都不比两端更宽松。 */
export const ENTRY_PERMISSIVENESS: Record<KnownEntryMode, number> = {
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

/** 入口模式的实现策略。按固定工作配置设计 §6，temp_rule 是首选候选；均需 P0 实测后才能启用。 */
export const ENTRY_STRATEGIES = ['temp_rule', 'ruleset_resource'] as const;
export type EntryStrategy = (typeof ENTRY_STRATEGIES)[number];

/**
 * P0 能力门槛。每项记录支持/不支持/待验证、实测依据与验证时的上下文；上下文中它依赖的
 * 任一字段变化（Surge 版本/构建、macOS、Safari、入口策略、进程路径、工作配置、自动重载设置、
 * 接管方式、签名身份）都会让它回到待验证。
 */
export const CAPABILITY_KEYS = [
  'safari_process_attribution',
  'native_profile_id',
  'native_bridge_ipc',
  'bridge_keychain_access',
  'extension_install_persistence',
  'fixed_profile_no_switch',
  'runtime_entry_modes',
  'entry_rules_after_restart',
  'safari_udp_quic_handling',
  'targeted_resource_refresh',
  'policy_path_reread',
  'external_node_underlying_proxy',
  'connection_continuity',
  'auto_reload_atomic_replace',
  'first_request_and_old_connections',
  'independent_node_preflight',
  'takeover_state_readable',
  'same_profile_reload_impact',
  'open_profile_by_id',
] as const;
export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];
export type CapabilityStatus = 'supported' | 'unsupported' | 'unverified';

export const CAPABILITY_LABELS: Record<CapabilityKey, string> = {
  safari_process_attribution: 'Safari 精确进程归属',
  native_profile_id: '原生场景 ID 稳定性',
  native_bridge_ipc: '扩展与本机服务通信',
  bridge_keychain_access: '原生桥读取钥匙串',
  extension_install_persistence: '扩展签名与启用持久性',
  fixed_profile_no_switch: '固定配置日常不切换',
  runtime_entry_modes: '运行时入口四种模式',
  entry_rules_after_restart: 'Surge 重启后入口规则生命周期',
  safari_udp_quic_handling: 'Safari UDP/QUIC 处理',
  targeted_resource_refresh: '节点资源定向刷新',
  policy_path_reread: '本地 policy-path 重新读取',
  external_node_underlying_proxy: '外部节点前置链路',
  connection_continuity: '其他应用连接连续性',
  auto_reload_atomic_replace: '自动重载与原子替换行为',
  first_request_and_old_connections: '首请求与旧连接处理',
  independent_node_preflight: '候选节点独立预检',
  takeover_state_readable: '接管与出站模式读取',
  same_profile_reload_impact: '同一配置维护重载影响',
  open_profile_by_id: '按场景 ID 打开 Safari',
};

/** 能力验证时记录的上下文字段。 */
export const CAPABILITY_CONTEXT_FIELDS = [
  'surgeVersion',
  'surgeBuild',
  'macosBuild',
  'safariVersion',
  'entryStrategy',
  'processPathsDigest',
  'workingProfileId',
  'autoReload',
  'takeoverMode',
  'signingIdentity',
  'adapterMechanism',
] as const;
export type CapabilityContextField = (typeof CAPABILITY_CONTEXT_FIELDS)[number];

/** 每项能力依赖哪些上下文字段；依赖字段与当前值不一致即视为待验证。 */
export const CAPABILITY_CONTEXT_DEPS: Record<CapabilityKey, readonly CapabilityContextField[]> = {
  safari_process_attribution: ['macosBuild', 'safariVersion', 'processPathsDigest', 'surgeVersion', 'surgeBuild', 'takeoverMode'],
  native_profile_id: ['macosBuild', 'safariVersion', 'signingIdentity'],
  native_bridge_ipc: ['macosBuild', 'safariVersion', 'signingIdentity'],
  bridge_keychain_access: ['macosBuild', 'signingIdentity'],
  extension_install_persistence: ['macosBuild', 'safariVersion', 'signingIdentity'],
  fixed_profile_no_switch: ['surgeVersion', 'surgeBuild', 'workingProfileId', 'adapterMechanism'],
  runtime_entry_modes: ['surgeVersion', 'surgeBuild', 'entryStrategy', 'processPathsDigest', 'autoReload', 'adapterMechanism', 'takeoverMode'],
  entry_rules_after_restart: ['surgeVersion', 'surgeBuild', 'entryStrategy'],
  safari_udp_quic_handling: ['surgeVersion', 'surgeBuild', 'entryStrategy', 'processPathsDigest', 'macosBuild', 'safariVersion', 'takeoverMode'],
  targeted_resource_refresh: ['surgeVersion', 'surgeBuild', 'workingProfileId', 'adapterMechanism', 'autoReload'],
  policy_path_reread: ['surgeVersion', 'surgeBuild', 'workingProfileId', 'adapterMechanism'],
  external_node_underlying_proxy: ['surgeVersion', 'surgeBuild'],
  connection_continuity: ['surgeVersion', 'surgeBuild', 'workingProfileId', 'adapterMechanism', 'autoReload', 'takeoverMode'],
  auto_reload_atomic_replace: ['surgeVersion', 'surgeBuild', 'workingProfileId', 'autoReload'],
  first_request_and_old_connections: ['macosBuild', 'safariVersion', 'surgeVersion', 'surgeBuild', 'entryStrategy', 'processPathsDigest'],
  independent_node_preflight: ['surgeVersion', 'surgeBuild', 'adapterMechanism'],
  takeover_state_readable: ['surgeVersion', 'surgeBuild', 'adapterMechanism'],
  same_profile_reload_impact: ['surgeVersion', 'surgeBuild', 'workingProfileId', 'takeoverMode'],
  open_profile_by_id: ['macosBuild', 'safariVersion'],
};

/** 动作 → 必需能力（全部 supported 且上下文匹配）。见 docs/ARCHITECTURE.md §5.2。 */
export const CAPABILITY_GATES = {
  /** 任何节点资源发布，自动或用户手动发起，要求完全相同。 */
  publish: [
    'targeted_resource_refresh',
    'policy_path_reread',
    'external_node_underlying_proxy',
    'connection_continuity',
    'auto_reload_atomic_replace',
  ],
  /** 激活与活动环境切换（改变 SFE-ROUTE 选择与入口模式）。 */
  activate: [
    'native_bridge_ipc',
    'safari_process_attribution',
    'runtime_entry_modes',
    'entry_rules_after_restart',
    'safari_udp_quic_handling',
    'fixed_profile_no_switch',
  ],
  /** ruleset_resource 策略额外要求。 */
  activateRulesetStrategy: ['auto_reload_atomic_replace', 'targeted_resource_refresh'],
  /** 结束 Safari 旧连接。普通模式下不满足时按“尽力而为”执行并报告。 */
  killSafariConnections: ['safari_process_attribution'],
  /** 场景绑定需要能收到原生桥消息。 */
  bind: ['native_bridge_ipc'],
  /** 登录页填充与自动打开订单（P4：绑定、出口和启动顺序均可验证后）。 */
  fillAndAutoOpen: ['native_profile_id', 'first_request_and_old_connections', 'bridge_keychain_access'],
  preflight: ['independent_node_preflight'],
  /** 维护流程写入工作配置并重载同一配置；same_profile_reload_impact 需已测量（supported 或带影响记录的 unsupported）。 */
  maintenanceWrite: ['auto_reload_atomic_replace'],
} as const satisfies Record<string, readonly CapabilityKey[]>;
