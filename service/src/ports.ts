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

/** 钥匙串抽象。ref 是不透明引用（sec_…），从不复用；值只在内存中短暂存在。 */
export interface SecretStore {
  put(ref: string, value: string, kind: 'proxy' | 'account' | 'system'): Promise<void>;
  /** 账号密码（kind=account）不提供读取：由签名的原生桥自行读取钥匙串。 */
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

export interface SurgeVersion {
  version: string;
  build: string | null;
}

export interface SurgeProfileInfo {
  /** Surge 中显示的配置名（不含扩展名）。 */
  name: string;
  /** 能取得时的本地绝对路径。 */
  path: string | null;
}

export interface SurgePolicies {
  /** 代理节点（含外部资源导入的节点，若 6.5 能列出）。 */
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
  /** 资源类型：policy-path / ruleset / module / script 等，按 Surge 返回原样记录。 */
  type: string;
  /** 本地路径或 URL（URL 的用户信息与查询已遮盖）；只用于识别本应用资源。 */
  location: string;
  lastUpdatedAt: Date | null;
  error: string | null;
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
  /** Surge 进程/引擎启动时间（用于识别重启）；取不到为 null。 */
  startedAt: Date | null;
}

/**
 * Surge 低层原语。实现对不支持的原语抛 SfeError('CAPABILITY_UNVERIFIED')。
 * 刻意没有 switchProfile / updateAllResources / flushTempRules / 接管与出站模式写入 / 停止 Surge /
 * 重载配置（重载只在 MaintenanceSurge 上）。每个原语固定由一种实现（CLI 或 HTTP）提供。
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
  listActiveRequests(): Promise<SurgeRequestRecord[]>;
  listRecentRequests(): Promise<SurgeRequestRecord[]>;
  killRequest(id: string): Promise<void>;

  listExternalResources(): Promise<SurgeExternalResource[]>;
  updateExternalResource(key: string): Promise<void>;

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
