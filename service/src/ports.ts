// 服务内部的依赖接口。实现放在各自目录；测试注入假的实现。见 docs/ARCHITECTURE.md §3、§5。

import type { CapabilityKey, EntryBits, EntryMode, KnownEntryMode, ServiceEventPayload, TakeoverState } from '@sfe/contract';

// ---------- 基础 ----------

export interface Clock {
  now(): Date;
  /** 测试可控的定时器；返回取消函数。 */
  setTimeout(fn: () => void, ms: number): () => void;
}

export interface IdGenerator {
  /** 前缀 + 时间有序随机串，例如 op_01J9Z…；不可预测。 */
  next(prefix: 'env' | 'op' | 'batch' | 'probe' | 'test' | 'front' | 'sec' | 'sess' | 'prop' | 'mo' | 'bak'): string;
  /** 高熵令牌（会话、登录码、test_id、传输令牌），至少 16 字节随机。 */
  token(bytes?: number): string;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** 只写脱敏后的结构化日志；从不记录请求/响应体。fields 经 Scrubber 处理。 */
export interface Logger {
  log(level: LogLevel, msg: string, fields?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

/**
 * 按值脱敏：登记本次操作中读到或收到的每个秘密值，再对任何来自 Surge、子进程或错误的
 * 自由文本做替换；另外按规则遮盖节点行参数、http-api、URL 用户信息与查询、长 base64。
 */
export interface Scrubber {
  register(secret: string): void;
  scrub(text: string): string;
  scrubDeep<T>(value: T): T;
}

// ---------- 秘密 ----------

/** 秘密存储（本机后台资料，见 secrets/local-store.ts；不使用钥匙串）。ref 是不透明引用（sec_…），从不复用。 */
export interface SecretStore {
  put(ref: string, value: string, kind: 'proxy' | 'account' | 'system'): Promise<void>;
  /** 任何种类都可读取（账号密码只在登录填充按 §6.10 把关通过后读出）；读到的值由调用方登记到脱敏器。 */
  get(ref: string): Promise<string | null>;
  delete(ref: string): Promise<void>;
}

// ---------- 事件 ----------

export interface EventBus {
  publish(event: ServiceEventPayload): number;
  /** 从 sinceSequence 之后补读；超出缓冲返回 null（客户端需读快照）。 */
  since(sinceSequence: number): Array<ServiceEventPayload & { sequence: number }> | null;
  subscribe(listener: (event: ServiceEventPayload & { sequence: number }) => void): () => void;
  currentSequence(): number;
}

// ---------- Surge ----------

/**
 * `surge-cli --raw version`（Mac 6.8.0+，手册：“Show Surge, Core, Controller protocol, operating-system, and device versions.”）。
 * 只保留 App 版本、构建号、Core 版本与 Controller 协议号；系统版本、设备名与设备标识从不读取、记录或保存。
 * 它只是旁证：版本与构建号必须与运行实例读取（surge/running-instance.ts）一致才接受（crossCheckSurgeVersion）。
 */
export interface SurgeVersion {
  version: string;
  build: string;
  /** Core 版本（6.8.0 起由 Mac 版本派生；原始输出中为数字）。 */
  coreVersion: number;
  /** Controller 协议号：随包技能按它门控命令（rule ≥20；dump performance ≥22）。 */
  controllerProtocol: number;
}

export interface SurgeProfileInfo {
  /** Surge 中显示的配置名（不含扩展名）。 */
  name: string;
  /** 能取得时的本地绝对路径。 */
  path: string | null;
}

export interface SurgePolicies {
  /** 代理节点（含外部资源导入的节点，若能列出；TODO(P0)：6.10 的 dump policy 是否列出 policy-path 节点）。 */
  proxies: string[];
  groups: string[];
}

export interface SurgePolicyDetail {
  name: string;
  type: string | null;
  server: string | null;
  port: number | null;
  underlyingProxy: string | null;
  /** 原始详情已在适配层内存中脱敏（用户名/密码等参数值被遮盖）。 */
  redactedRaw: string | null;
}

export interface SurgeRuleRecord {
  /** 已脱敏的规则文本。 */
  text: string;
  source: 'module' | 'temp_rule' | 'profile' | 'unknown';
  /** 来源为模块时的模块名。 */
  moduleName: string | null;
}

export interface SurgeRequestRecord {
  id: string;
  processPath: string | null;
  remoteHost: string | null;
  /** 最终策略名（组或节点）；能读到组后面的叶节点时填 leafPolicyName。 */
  policyName: string | null;
  leafPolicyName: string | null;
  /** 命中的规则文本，例如 RULE-SET,sfe-entry-verify.list,SFE-ROUTE。 */
  rule: string | null;
  protocol: 'tcp' | 'udp' | null;
  startedAt: Date | null;
  completed: boolean;
  failed: boolean;
}

export interface SurgeExternalResource {
  key: string;
  /** 资源类型，按 Surge 返回原样记录（HTTP API 文档，Mac 6.10.0+：ruleset、domainset、script、policy-group、data）。 */
  type: string;
  /** 本地路径或 URL（URL 的用户信息与查询已遮盖）；只用于识别本应用资源。 */
  location: string;
  /** 远端资源的上次下载时间；本地资源没有（文档：“Local resources have no `updatedAt` field.”），从未下载过为 null。 */
  lastUpdatedAt: Date | null;
  error: string | null;
  /** 是否本地文件；没有该字段（旧输出）为 null。本地资源不会被 updateExternalResource 刷新（文档：“Local resources are skipped.”）。 */
  local: boolean | null;
  /** 是否正在更新（未结束前不能据它判断刷新结果）；没有该字段为 null。 */
  updating: boolean | null;
  /** 引用该资源的模块名；来自配置为 null（文档：“or null if it's from the profile”）。 */
  fromModule: string | null;
}

/**
 * 单个外部资源的更新结果。refreshed 为 true 只表示 Surge 对该 key 报告了 success（远端资源已重新下载）；
 * 本地资源被跳过、或 Surge 说明没有需要更新的远端资源时为 false——这从不算作刷新（文档：“Local resources are skipped.”）。
 */
export interface SurgeResourceUpdateResult {
  key: string;
  refreshed: boolean;
  /** refreshed 的依据：downloaded —— 该 key 报告 success；skipped —— 没有更新任何远端资源（本地资源或无需更新）。 */
  outcome: 'downloaded' | 'skipped';
}

export interface SurgeCheckResult {
  ok: boolean;
  /** 已脱敏的校验输出摘要。 */
  message: string;
}

export interface SurgePolicyTestResult {
  ok: boolean;
  latencyMs: number | null;
  error: string | null;
}

export interface SurgeRuntimeInfo {
  /**
   * 引擎启动时间（用于识别重启）；取不到为 null。由“读取时刻 − 引擎运行时长”换算到整秒，两次读取之间可能相差 1 秒：
   * 判断重启应比较 uptimeSeconds 是否变小，或对 startedAt 留出容差。
   */
  startedAt: Date | null;
  /** 引擎运行时长（秒）：`dump performance` 的 uptime（Mac 6.9.0+，协议 ≥22）或 /v1/metrics 的 surge_uptime_seconds；取不到为 null。 */
  uptimeSeconds: number | null;
}

/**
 * `rule match` 的输入（Mac 6.9.0+，协议 ≥20）：在当前有效规则上求值，不建立连接。
 * 文档：“A hostname defaults to TCP port 443”；process-path “affects PROCESS-NAME rules”。
 */
export interface SurgeRuleMatchInput {
  /** 目标主机名（不是 URL）。 */
  host: string;
  /** 来源进程的绝对路径。 */
  processPath: string;
  /** 协议覆盖（文档列出 TCP、UDP、HTTP、HTTPS、QUIC、STUN）；缺省按主机名的缺省（TCP）。 */
  protocol?: 'TCP' | 'UDP' | 'HTTP' | 'HTTPS' | 'QUIC';
  /** 目标端口覆盖；缺省 443。 */
  port?: number;
}

export interface SurgeRuleMatchResult {
  /** 命中的规则文本（已脱敏）。 */
  rule: string;
  /** 最终策略名。 */
  policy: string;
}

/**
 * Surge 低层原语。实现对不支持的原语抛 SfeError('CAPABILITY_UNVERIFIED')。
 * 刻意没有 switchProfile / updateAllResources / flushTempRules / 接管与出站模式写入 / 停止 Surge / 重启引擎 /
 * 重载配置（重载只在 MaintenanceSurge 上）。每个原语固定由一种实现（CLI 或 HTTP）提供。
 * 写原语只有：SFE-ROUTE 的选择、结束单个连接、按单个 key 更新外部资源、增删单条临时规则。
 */
export interface SurgeAdapter {
  /** 当前配置下每个原语使用的实现，例如 { selectGroupPolicy: 'http', updateExternalResource: 'cli' }。 */
  mechanism(): Record<string, 'cli' | 'http' | 'fake' | 'unavailable'>;

  getVersion(): Promise<SurgeVersion>;
  getRuntimeInfo(): Promise<SurgeRuntimeInfo>;
  getCurrentProfile(): Promise<SurgeProfileInfo>;
  getTakeoverState(): Promise<TakeoverState>;
  getAutoReloadSetting(): Promise<boolean | null>;
  checkProfile(profilePath: string): Promise<SurgeCheckResult>;

  listPolicies(): Promise<SurgePolicies>;
  getPolicyDetail(name: string): Promise<SurgePolicyDetail>;
  getGroupMembers(group: string): Promise<string[]>;
  getGroupSelection(group: string): Promise<string | null>;
  selectGroupPolicy(group: string, policy: string): Promise<void>;
  testPolicy(policy: string, url: string): Promise<SurgePolicyTestResult>;

  /** 有效规则列表（含模块规则与临时规则），按 Surge 实际匹配顺序。 */
  listRules(): Promise<SurgeRuleRecord[]>;
  /** 只读：按当前有效规则求值一次（不建立连接），返回命中的规则与最终策略。 */
  matchRule(input: SurgeRuleMatchInput): Promise<SurgeRuleMatchResult>;
  listActiveRequests(): Promise<SurgeRequestRecord[]>;
  listRecentRequests(): Promise<SurgeRequestRecord[]>;
  killRequest(id: string): Promise<void>;

  listExternalResources(): Promise<SurgeExternalResource[]>;
  /** 只按单个 key（从不 all）；结果区分“已重新下载”与“被跳过”（本地资源总是被跳过）。 */
  updateExternalResource(key: string): Promise<SurgeResourceUpdateResult>;

  listTempRules(): Promise<string[]>;
  addTempRule(rule: string): Promise<void>;
  removeTempRule(rule: string): Promise<void>;
}

/** 只注入维护处理器（init/remerge）；发布、路由、回滚、恢复处理器拿不到它。 */
export interface MaintenanceSurge {
  /** 重载同一工作配置。调用方必须已通过维护写门槛、入口为 NORMAL、用户已确认。 */
  reloadProfile(): Promise<void>;
}

/** 本应用写入 Surge 配置目录或数据目录的文件。 */
export interface ProfileFiles {
  /** Surge 配置目录（工作配置所在目录）。 */
  readonly directory: string;
  read(fileName: string): Promise<string | null>;
  exists(fileName: string): Promise<boolean>;
  /**
   * 同目录 O_EXCL 0600 临时文件 + fsync + rename + 目录 fsync。
   * 调用方必须事先完成：自动重载设置检查、--check、差异、确认（维护写）以及归属检查
   * （本应用文件的当前摘要必须等于 managed_objects 记录的上次摘要；初始化时文件必须不存在）。
   */
  writeAtomic(fileName: string, content: string, expectedPreviousDigest: string | null): Promise<void>;
  /** 带密钥摘要（HMAC），用于变化检测；从不对外发出。 */
  digest(fileName: string): Promise<string | null>;
}

// ---------- 入口模式 ----------

export interface EntryStep {
  /** 本步改变的单个位。 */
  bit: keyof EntryBits;
  value: boolean;
  /** 本步完成后的位组合与有效模式（用于记录与断言）。 */
  bits: EntryBits;
  effective: KnownEntryMode;
}

export interface EntryReadback {
  mode: EntryMode;
  bits: EntryBits | null;
  /** 运行时读回依据（有效规则顺序、临时规则列表/资源状态、未重载信号）；文件摘要只是次要证据。 */
  evidence: string[];
  /** 排在本应用入口之前、可能抢先匹配 Safari 流量的规则。 */
  precedenceIssues: Array<{ rule: string; source: SurgeRuleRecord['source']; severity: 'blocking' | 'warning' }>;
  /** 本应用记录拥有、但被外部修改、无法识别或缺失的入口文件（只有撤销入口的方向会改写，§5.5）。 */
  changedOwnedFiles?: string[];
  /**
   * false：撤销本应用入口（普通模式、回滚）时 rule match 读不到或不可用，读回只按结构（temp_rule：临时规则列表与有效规则
   * 顺序）或按写入与等待（ruleset_resource：文件已写入、按文件监视上限等待）完成，未经运行时求值确认；evidence 写明原因。
   * 只出现在目标为 BLOCKED/NORMAL 的撤销切换结果中，从不用于 VERIFY_ONLY/ACTIVE。缺省（undefined）为已确认。
   */
  runtimeConfirmed?: boolean;
  /**
   * ruleset_resource：false 表示有入口文件没有见证规则（旧格式），这些位的已加载内容只由 Safari 与对照的运行时探测核对
   * （NORMAL 时），未经见证确认 Surge 已加载的是文件中的这一版；evidence 逐位写明。缺省（undefined）为全部由见证确认或不适用
   * （temp_rule）。
   */
  witnessConfirmed?: boolean;
  /**
   * 普通模式的中间阻断（EntryTransitionOptions.towardNormal）不写入而返回 BLOCKED 时：上一次普通模式在 NORMAL 一段写入、
   * 超时后保留的关闭（ruleset_resource 的 udp/block，走向 NORMAL）尚未由见证确认加载的位。不重新收紧，由 NORMAL 一段再写入。
   * 含 block 时 Surge 已加载的是写前的阻断或已是这次的关闭：verify/active 已由见证确认关闭，Safari 新请求不会经 SFE-ROUTE，
   * 但不能宣称已阻断——mode 为 BLOCKED 只表示中间阻断这一段已满足。
   */
  keptTowardNormal?: Array<'udp' | 'block'>;
}

/** 撤销清理的一步：temp_rule 撤销入口时逐条加入或移除的一整条本应用临时规则（不是单个位的变更，§5.5）。 */
export interface EntryCleanupStep {
  action: 'add' | 'remove';
  /** 规则所属的位；本应用记录但无法识别的规则为 unrecognized。 */
  kind: keyof EntryBits | 'unrecognized';
  rule: string;
}

export interface EntryTransitionOptions {
  /** 撤销本应用入口（普通模式、回滚；目标 BLOCKED/NORMAL）：允许改写 changedOwnedFiles。激活中的阻断步骤不设置。 */
  undo?: boolean;
  /**
   * 本次 BLOCKED 是普通模式的中间阻断（与 undo 一起使用）：之后撤销全部本应用入口，NORMAL 本来就把 Safari 流量交给原规则。
   * temp_rule 因此不在写入前拒绝“移除本应用规则会让 Safari 流量落到排在其后、可能放行的其他规则”的阻断；回滚与激活中的
   * 阻断不设置，照常拒绝（§5.5「优先级检查」）。
   * 起点已经是 NORMAL（例如 Surge 重启或降级时丢弃了本应用的临时规则，或它们在 Surge 运行中被移除；ruleset_resource 在
   * rule match 不可用时文件已全部为占位规则）时不写入，直接返回 mode 为 NORMAL 的读回：没有需要阻断的本应用入口，调用方
   * 跳过阻断，但仍结束 Safari 可能经买家出口的旧连接（没有本应用规则不能证明 Surge 重启过、旧连接已不在买家出口上）。
   * ruleset_resource 的阻断已经成立而 udp 已关（上一次普通模式失败在 NORMAL 一段）时同样不写入，返回 mode 为 BLOCKED 的读回
   * （bits 如实报告，有规则排在入口之前时随附 precedenceIssues）；NORMAL 一段超时保留的 udp/block 关闭尚未加载时也是如此
   * （EntryReadback.keptTowardNormal），否则比时限慢的文件监视会让每次重试在两段之间来回写入。
   */
  towardNormal?: boolean;
  /** 撤销清理的每一步运行时读回并确认归属之后调用（写入操作步骤与结果）；只有 undo 时可能调用。 */
  onCleanup?: (step: EntryCleanupStep) => void;
}

export interface EntryController {
  readonly strategy: 'temp_rule' | 'ruleset_resource';
  read(): Promise<EntryReadback>;
  /** 按 planEntryTransition 的顺序执行，每步写入后运行时读回；任一步失败抛错并保留已确认的更严格状态。 */
  transition(to: KnownEntryMode, onStep?: (step: EntryStep) => void, opts?: EntryTransitionOptions): Promise<EntryReadback>;
}

// ---------- 能力 ----------

export interface CapabilityGate {
  /** 全部有效状态为 supported 才返回；否则抛 CAPABILITY_UNVERIFIED，details.missing 列出缺失项与过期原因。 */
  require(keys: readonly CapabilityKey[]): Promise<void>;
  missing(keys: readonly CapabilityKey[]): Promise<CapabilityKey[]>;
}
