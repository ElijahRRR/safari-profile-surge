// 服务内部的依赖接口。实现放在各自目录；测试注入假的实现。见 docs/ARCHITECTURE.md §3、§5。

import type { CapabilityKey, EntryMode, ServiceEventPayload } from '@sfe/contract';

// ---------- 基础 ----------

export interface Clock {
  now(): Date;
  /** 测试可控的定时器；返回取消函数。 */
  setTimeout(fn: () => void, ms: number): () => void;
}

export interface IdGenerator {
  /** 前缀 + 时间有序随机串，例如 op_01J9Z…；不可预测。 */
  next(prefix: 'env' | 'op' | 'batch' | 'probe' | 'test' | 'front' | 'sec' | 'sess'): string;
  /** 高熵令牌（会话、CSRF、登录码、test_id）。 */
  token(bytes?: number): string;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** 只写脱敏后的结构化日志；实现必须对 fields 递归脱敏（见 util/redact.ts）。 */
export interface Logger {
  log(level: LogLevel, msg: string, fields?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

// ---------- 秘密 ----------

/** Keychain 抽象。ref 是不透明引用（sec_…），从不复用；值只在内存中短暂存在。 */
export interface SecretStore {
  put(ref: string, value: string): Promise<void>;
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
  /** 能取得时的本地路径。 */
  path: string | null;
  /** 配置文本的 sha256；取不到文本时为 null。 */
  digest: string | null;
}

export interface SurgePolicies {
  proxies: string[];
  groups: string[];
}

export interface SurgeRequestRecord {
  id: string;
  processPath: string | null;
  remoteHost: string | null;
  /** 最终策略名（组或节点）。 */
  policyName: string | null;
  /** 命中的规则文本，例如 RULE-SET,sfe-entry-verify.list,SFE-ROUTE。 */
  rule: string | null;
  startedAt: Date | null;
  completed: boolean;
  failed: boolean;
}

export interface SurgeExternalResource {
  key: string;
  /** 资源类型：policy-path / ruleset / module / script 等，按 Surge 返回原样记录。 */
  type: string;
  /** 本地路径或 URL；只用于识别本应用资源，不打印 URL 中的凭据。 */
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

/**
 * Surge 低层原语。实现对不支持的原语抛 SfeError('CAPABILITY_UNVERIFIED')。
 * 刻意没有 switchProfile / updateAllResources / flushTempRules / 出站模式 / 停止 Surge。
 */
export interface SurgeAdapter {
  getVersion(): Promise<SurgeVersion>;
  getCurrentProfile(): Promise<SurgeProfileInfo>;
  checkProfile(profilePath: string): Promise<SurgeCheckResult>;

  listPolicies(): Promise<SurgePolicies>;
  getGroupMembers(group: string): Promise<string[]>;
  getGroupSelection(group: string): Promise<string | null>;
  selectGroupPolicy(group: string, policy: string): Promise<void>;
  testPolicy(policy: string, url: string): Promise<SurgePolicyTestResult>;

  listRules(): Promise<string[]>;
  listActiveRequests(): Promise<SurgeRequestRecord[]>;
  listRecentRequests(): Promise<SurgeRequestRecord[]>;
  killRequest(id: string): Promise<void>;

  listExternalResources(): Promise<SurgeExternalResource[]>;
  updateExternalResource(key: string): Promise<void>;

  listTempRules(): Promise<string[]>;
  addTempRule(rule: string): Promise<void>;
  removeTempRule(rule: string): Promise<void>;

  /** 仅维护流程（maintenance.*）可调用；日常路径禁止。 */
  reloadProfile(): Promise<void>;
}

/** 本应用写入 Surge 配置目录的文件（工作配置、节点资源、入口规则集）。 */
export interface ProfileFiles {
  /** Surge 配置目录（工作配置所在目录）。 */
  readonly directory: string;
  read(fileName: string): Promise<string | null>;
  /** 同目录临时文件 + fsync + rename；权限 0600。 */
  writeAtomic(fileName: string, content: string): Promise<void>;
  digest(fileName: string): Promise<string | null>;
}

// ---------- 入口模式 ----------

export interface EntryBits {
  verify: boolean;
  block: boolean;
  active: boolean;
}

export interface EntryStep {
  /** 本步要设成的位（只列出变化的位）。 */
  set: Partial<EntryBits>;
  /** 本步完成后的有效模式（用于记录与断言）。 */
  effective: Exclude<EntryMode, 'UNKNOWN'>;
}

export interface EntryReadback {
  mode: EntryMode;
  bits: EntryBits | null;
  /** 读回依据（例如“规则集摘要一致 + 主配置 entry 段位于首位”）。 */
  evidence: string;
}

export interface EntryController {
  readonly strategy: 'ruleset_resource' | 'temp_rule';
  read(): Promise<EntryReadback>;
  /** 按 planEntryTransition 的顺序执行，每步写入后读回；任一步失败抛错并保留已确认的更严格状态。 */
  transition(to: Exclude<EntryMode, 'UNKNOWN'>, onStep?: (step: EntryStep) => void): Promise<EntryReadback>;
}

// ---------- 能力 ----------

export interface CapabilityGate {
  /** 全部为 supported 且版本匹配才返回；否则抛 CAPABILITY_UNVERIFIED，details.missing 列出缺失项。 */
  require(keys: readonly CapabilityKey[]): Promise<void>;
  missing(keys: readonly CapabilityKey[]): Promise<CapabilityKey[]>;
}
