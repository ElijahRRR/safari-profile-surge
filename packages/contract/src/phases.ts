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
  'profile_batch_create',
] as const;
export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];
export type CapabilityStatus = 'supported' | 'unsupported' | 'unverified';

export const CAPABILITY_LABELS: Record<CapabilityKey, string> = {
  safari_process_attribution: 'Safari 精确进程归属',
  native_profile_id: '原生场景 ID 稳定性',
  native_bridge_ipc: '扩展与本机服务通信',
  extension_install_persistence: '扩展签名与启用持久性',
  fixed_profile_no_switch: '固定配置日常不切换',
  runtime_entry_modes: '运行时入口四种模式',
  entry_rules_after_restart: 'Surge 重启后入口规则生命周期',
  safari_udp_quic_handling: 'Safari UDP/QUIC 处理',
  targeted_resource_refresh: '节点资源定向重新读取',
  policy_path_reread: '本地 policy-path 重新读取',
  external_node_underlying_proxy: '外部节点前置链路',
  connection_continuity: '其他应用连接连续性',
  auto_reload_atomic_replace: '自动重载与原子替换行为',
  first_request_and_old_connections: '首请求与旧连接处理',
  independent_node_preflight: '候选节点独立预检',
  takeover_state_readable: '接管与出站模式读取',
  same_profile_reload_impact: '同一配置维护重载影响',
  open_profile_by_id: '按场景 ID 打开 Safari',
  profile_batch_create: '批量创建 Safari 场景',
};

/** 能力验证时记录的上下文字段。 */
export const CAPABILITY_CONTEXT_FIELDS = [
  'surgeVersion',
  'surgeBuild',
  'macosBuild',
  'macosVersionExtra',
  'macosRestartPending',
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

/**
 * 每项能力依赖哪些上下文字段；依赖字段与当前值不一致即视为待验证。依赖 Safari 进程归属的能力（进程路径与 macOS 构建都在
 * 依赖中）另依赖后台安全改进的补充版本与“待重启”状态：装上后 Safari 重开即使用新加密卷宗中的 WebKit，系统其余部分要到
 * 重启后才用（Apple 平台安全指南），这期间测得的路径可能只是暂时只属于 Safari，基础构建号也可能不变。
 */
export const CAPABILITY_CONTEXT_DEPS: Record<CapabilityKey, readonly CapabilityContextField[]> = {
  safari_process_attribution: ['macosBuild', 'macosVersionExtra', 'macosRestartPending', 'safariVersion', 'processPathsDigest', 'surgeVersion', 'surgeBuild', 'takeoverMode'],
  native_profile_id: ['macosBuild', 'safariVersion', 'signingIdentity'],
  native_bridge_ipc: ['macosBuild', 'safariVersion', 'signingIdentity'],
  extension_install_persistence: ['macosBuild', 'safariVersion', 'signingIdentity'],
  fixed_profile_no_switch: ['surgeVersion', 'surgeBuild', 'workingProfileId', 'adapterMechanism'],
  runtime_entry_modes: ['surgeVersion', 'surgeBuild', 'entryStrategy', 'processPathsDigest', 'autoReload', 'adapterMechanism', 'takeoverMode'],
  entry_rules_after_restart: ['surgeVersion', 'surgeBuild', 'entryStrategy'],
  safari_udp_quic_handling: ['surgeVersion', 'surgeBuild', 'entryStrategy', 'processPathsDigest', 'macosBuild', 'macosVersionExtra', 'macosRestartPending', 'safariVersion', 'takeoverMode'],
  targeted_resource_refresh: ['surgeVersion', 'surgeBuild', 'workingProfileId', 'adapterMechanism', 'autoReload'],
  policy_path_reread: ['surgeVersion', 'surgeBuild', 'workingProfileId', 'adapterMechanism'],
  external_node_underlying_proxy: ['surgeVersion', 'surgeBuild'],
  connection_continuity: ['surgeVersion', 'surgeBuild', 'workingProfileId', 'adapterMechanism', 'autoReload', 'takeoverMode'],
  auto_reload_atomic_replace: ['surgeVersion', 'surgeBuild', 'workingProfileId', 'autoReload'],
  first_request_and_old_connections: ['macosBuild', 'macosVersionExtra', 'macosRestartPending', 'safariVersion', 'surgeVersion', 'surgeBuild', 'entryStrategy', 'processPathsDigest'],
  independent_node_preflight: ['surgeVersion', 'surgeBuild', 'adapterMechanism'],
  takeover_state_readable: ['surgeVersion', 'surgeBuild', 'adapterMechanism'],
  same_profile_reload_impact: ['surgeVersion', 'surgeBuild', 'workingProfileId', 'takeoverMode'],
  open_profile_by_id: ['macosBuild', 'safariVersion'],
  profile_batch_create: ['macosBuild', 'safariVersion'],
};

/**
 * Surge 版本号（例如 6.5.0）与构建号（例如 10960）的格式（服务、P0 与网页共用）：依赖版本的能力，其提议与确认都要求
 * 上下文带符合格式的具体值；不接受 CLI 交互模式输出中的地址（例如 127.0.0.1）。见 docs/ARCHITECTURE.md §5.2。
 */
export const SURGE_VERSION_RE = /^\d{1,3}\.\d{1,3}(\.\d{1,3})?$/;
export const SURGE_BUILD_RE = /^\d{1,10}$/;

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
    'external_node_underlying_proxy',
    'safari_process_attribution',
    'runtime_entry_modes',
    'entry_rules_after_restart',
    'safari_udp_quic_handling',
    'fixed_profile_no_switch',
  ],
  /**
   * ruleset_resource 策略额外要求。入口规则集文件由 Surge 的文件监视重新读取（从不调用 external-resource update：
   * 本地资源被跳过）、经见证规则的 rule match 确认已加载，由 runtime_entry_modes（策略为 ruleset_resource 时）本身证明；
   * 这里只追加自动重载设置下的原子替换行为。
   */
  activateRulesetStrategy: ['auto_reload_atomic_replace'],
  /** 结束 Safari 旧连接。普通模式下不满足时按“尽力而为”执行并报告。 */
  killSafariConnections: ['safari_process_attribution'],
  /** 场景绑定需要能收到原生桥消息。 */
  bind: ['native_bridge_ipc'],
  /** 登录页填充与自动打开订单（P4：绑定、出口和启动顺序均可验证后）。账号密码保存在本机后台资料中，不依赖钥匙串。 */
  fillAndAutoOpen: ['native_profile_id', 'first_request_and_old_connections'],
  preflight: ['independent_node_preflight'],
  /** 维护流程写入工作配置并重载同一配置（另需 CAPABILITY_MEASURED_GATES.maintenanceWrite）。 */
  maintenanceWrite: ['auto_reload_atomic_replace'],
} as const satisfies Record<string, readonly CapabilityKey[]>;

/**
 * “已测量”门槛：有效状态必须不是 unverified（supported，或带影响记录的 unsupported 均可），
 * 用于需要展示实测影响、由用户选择时机的维护动作。
 */
export const CAPABILITY_MEASURED_GATES = {
  maintenanceWrite: ['same_profile_reload_impact'],
} as const satisfies Record<string, readonly CapabilityKey[]>;

/**
 * 每项能力依赖的 Surge 原语；验证上下文中的 adapterMechanism 记录这些原语当时由哪种实现提供
 * （规范 JSON：{"原语":"cli|http"}），比较时只比较这些原语——映射变化（例如 install.json 中 matchRule 改为 unavailable）
 * 让相应记录过期、门槛在任何写入之前拒绝。只列产品实际调用的原语：外部资源更新跳过本地资源（HTTP API 文档：“Local
 * resources are skipped.”），发布与入口从不调用 updateExternalResource，所以它不在任何一项中；入口的每一步与读回都用
 * rule match（Mac 6.9.0+）确认运行时求值，ruleset_resource 每步写入前读取自动重载设置。
 */
export const CAPABILITY_PRIMITIVES: Partial<Record<CapabilityKey, readonly string[]>> = {
  fixed_profile_no_switch: ['selectGroupPolicy', 'getGroupSelection', 'getCurrentProfile'],
  runtime_entry_modes: ['listRules', 'matchRule', 'listTempRules', 'addTempRule', 'removeTempRule', 'listExternalResources'],
  targeted_resource_refresh: ['listExternalResources', 'getGroupMembers', 'getGroupSelection'],
  policy_path_reread: ['listExternalResources', 'getGroupMembers'],
  connection_continuity: ['selectGroupPolicy', 'getGroupMembers'],
  auto_reload_atomic_replace: ['getAutoReloadSetting', 'matchRule'],
  independent_node_preflight: ['testPolicy'],
  takeover_state_readable: ['getTakeoverState'],
};

/** P0 通过条件（网页能力页与 P0 手册共用的唯一文字来源）。 */
export const CAPABILITY_CRITERIA: Record<CapabilityKey, string> = {
  safari_process_attribution:
    'Safari 实际连接（含扩展页面请求）按完整进程路径命中，Chrome 与其他 WebKit 应用不命中；IPv4/IPv6、HTTP/1.1、HTTP/2、HTTP/3、WebSocket 逐项通过或写明限制；DNS、WebRTC、系统服务另列覆盖情况。',
  native_profile_id:
    '每个已命名场景都提供 SFExtensionProfileKey 且互不相同，Safari 退出重开、扩展重装、App 重签后保持不变或变化行为已记录；默认场景是否提供已记录（不提供时按未识别场景处理、不能关联；提供时也与各已命名场景不同）。',
  native_bridge_ipc:
    '扩展经原生桥与服务往返成功；Safari 重开、重启、服务重启、服务升级后仍成功；后台脚本休眠后被唤醒仍能完成往返；无 TCC 提示；macOS 26 或更高时，退出 App 出现的后台任务提示与选「允许」「不允许」后服务的状态已记录。',
  extension_install_persistence: '不开启“允许未签名扩展”，扩展在 Safari 退出重开、重启、8 天以上与重新构建后仍保持启用；证书有效期、App 与扩展是否嵌入描述文件及其有效期已记录。',
  fixed_profile_no_switch: '切换 SFE-ROUTE 选择时工作配置身份不变、不发生配置重载或引擎重启、Chrome 长连接与新请求不受影响。',
  runtime_entry_modes:
    '所选策略下四种模式精确生效，运行时读回包括 rule match：Safari 的 TCP、UDP、QUIC 对检测主机与其他主机都得到该模式预期的结果，Chrome 从不命中本应用入口规则或 SFE-ROUTE；每次切换不发生配置重载或引擎重启，其他应用长连接与新请求不受影响；中间状态无放行窗口；本应用入口优先于启用的模块 DIRECT 规则与用户临时规则；AND/NOT 组合（进程、协议、域名）的入口规则在该机制中可用；temp_rule 时新临时规则的插入位置已实测；ruleset_resource 时规则集文件原子替换后不调用 external-resource update，由 Surge 的文件监视在限定时间内重新读取并经见证规则读回。',
  entry_rules_after_restart: 'Surge 重启（退出重开；只重启引擎时按引擎运行时长回落识别）后入口规则的去留已记录，且控制器在一个对账周期内检测到丢失（入口记为 UNKNOWN 并暂停填充与自动打开）。',
  safari_udp_quic_handling: 'VERIFY_ONLY 与 ACTIVE 下 Safari 的 UDP/QUIC（H3 测试主机）被拒绝且从不直连，页面回落 TCP 经 SFE-ROUTE，出口一致。',
  targeted_resource_refresh: '本应用节点资源（本地 policy-path 文件）原子替换后不调用 external-resource update（本地资源被跳过），经固定原语能读回组成员、资源错误与选择；只有该资源变化，其他外部资源不受影响，不发生整份配置重载或引擎重启；执行器从不写入它无法读回的内容。',
  policy_path_reread: '本地 policy-path 文件原子替换后不调用 external-resource update，Surge 在限定时间内自动重新读取（延迟已记录）：新增成员可选且实际生效，旧成员与选择保留，选中节点被移除时回落到首成员 REJECT。',
  external_node_underlying_proxy: '外部资源中的节点经 underlying-proxy 引用主配置前置时确实经过前置；前置不可达时连接失败而非直连；前置名缺失时节点被跳过或失败而非直连。',
  connection_continuity: '发布节点资源期间（写入本地 policy-path 文件并等待 Surge 自动重新读取），其他应用的长连接保持、新请求正常、出口不变，并与未执行变更的对照比较。',
  auto_reload_atomic_replace: '在记录的自动重载设置（开/关）下，原子替换被引用的本地规则集后由 Surge 文件监视重新读取（延迟已记录），不触发整份配置重载或引擎重启，其他应用连接不受影响；主配置被原子替换后是否触发重载也已记录。',
  first_request_and_old_connections: '受控入口下首个业务请求已走新出口；旧环境的长连接、后台请求、恢复的标签页与扩展休眠场景不会继续使用旧出口；限制已写明。',
  independent_node_preflight: '不改变当前选择即可对未选中的候选节点做连通性测试。',
  takeover_state_readable: '能经固定原语只读获取增强模式、系统代理与出站模式。',
  same_profile_reload_impact: '同一配置维护重载对其他应用的影响（连接重置、恢复时间、接管与模式是否不变、是否升级为完整引擎重启并清空临时规则）已测量。',
  open_profile_by_id: '存在可用的公开方式按场景 ID 打开 Safari 指定场景。',
  profile_batch_create: '存在可用的公开方式批量创建 Safari 场景。',
};
