// 对外（网页、插件、CLI）可见的脱敏视图模型。任何视图都不得包含代理密码、买家密码或
// Surge 管理密钥；用户名/密码只给出“是否已配置”。

import type {
  CapabilityKey,
  CapabilityStatus,
  EntryMode,
  EntryStrategy,
  OldSessionPolicy,
  OperationKind,
  OperationPhase,
  OperationStatus,
  RoutePhase,
} from './phases.js';
import type { ApiErrorBody } from './errors.js';
import type { SiteCode } from './sites.js';

export type IsoTime = string;
export type EnvironmentId = string;
export type OperationId = string;
export type RequestId = string;
export type FrontProxyId = string;

/** 秘密字段的三种修改语义：未改、明确替换、明确清除。缺省等同 keep。 */
export type SecretChange = { action: 'keep' } | { action: 'replace'; value: string } | { action: 'clear' };

export type ProxyProtocol = 'socks5';

export interface ProxyInput {
  protocol: ProxyProtocol;
  host: string;
  port: number;
  username?: SecretChange;
  password?: SecretChange;
  /** null 表示使用全局默认前置；所有代理都必须最终解析到一个前置。 */
  frontProxyId: FrontProxyId | null;
  /** 用户提供的预期出口 IP；代理连接地址不能自动当作预期出口。 */
  expectedExitIp?: string | null;
}

export interface AccountInput {
  /** 买家号标识/备注，用于展示和定位，不一定是登录账号。 */
  label?: string | null;
  /** 登录邮箱/手机号。 */
  loginIdentifier?: string | null;
  password?: SecretChange;
}

export interface EnvironmentInput {
  displayName: string;
  site: SiteCode;
  autoOpenOrders?: boolean;
  autoFillLogin?: boolean;
  proxy: ProxyInput;
  account?: AccountInput;
}

/** PATCH 语义：只携带修改了的字段。 */
export interface EnvironmentChanges {
  displayName?: string;
  site?: SiteCode;
  autoOpenOrders?: boolean;
  autoFillLogin?: boolean;
  proxy?: Partial<ProxyInput>;
  account?: AccountInput;
}

export interface ProxyRevisionView {
  revision: number;
  protocol: ProxyProtocol;
  host: string;
  port: number;
  hasUsername: boolean;
  hasPassword: boolean;
  frontProxyId: FrontProxyId;
  frontProxyName: string;
  expectedExitIp: string | null;
  /** Surge 中的实际节点名，例如 SFE-N-E0001-US01-v003。 */
  nodeName: string;
  createdAt: IsoTime;
}

export type FrontProxyOwnership = 'user_existing' | 'sfe_managed';
export type FrontProxyState = 'unverified' | 'ok' | 'missing' | 'failed';

export interface FrontProxyView {
  id: FrontProxyId;
  /** Surge 中被引用的节点名（用户已有节点或 SFE-F-*）。 */
  surgeName: string;
  ownership: FrontProxyOwnership;
  state: FrontProxyState;
  isDefault: boolean;
  dependentEnvironmentIds: EnvironmentId[];
  lastCheckedAt: IsoTime | null;
}

export type BindingState = 'unbound' | 'bound';

export interface BindingView {
  state: BindingState;
  /** 原生 profile ID 只展示前 8 位，用于核对，不作为可伪造的客户端输入。 */
  profileIdShort: string | null;
  boundAt: IsoTime | null;
}

export type PageIdentityState = 'unverified' | 'recognized' | 'mismatch';

export interface AccountView {
  label: string | null;
  loginIdentifierMasked: string | null;
  hasLoginIdentifier: boolean;
  hasPassword: boolean;
  /** 页面实际登录身份核验；编辑绑定账号不等于网页已切账号。 */
  pageIdentity: PageIdentityState;
  /** 配置账号在最近一次页面识别之后被修改过。 */
  changedSincePageCheck: boolean;
}

export type ProbeKind = 'preflight' | 'safari';
export type ProbeOutcome = 'ok' | 'failed' | 'mismatch' | 'inconclusive';

export interface ProbeView {
  kind: ProbeKind;
  outcome: ProbeOutcome;
  /** 实际出口 IP（Safari 实测或预检节点出口）；预检只证明代理可用时为 null。 */
  exitIp: string | null;
  proxyRevision: number;
  routeEpoch: number | null;
  /** Surge 侧核对到的策略与进程，仅 Safari 实测时有。 */
  surgePolicy: string | null;
  surgeProcessMatched: boolean | null;
  observedAt: IsoTime;
  /** 检测有效期，过期后显示“上次结果”，不得标为实时。 */
  expiresAt: IsoTime;
  message: string | null;
}

/** 环境整体就绪状态（导入批量结果也用它）。 */
export type EnvironmentReadiness =
  | 'needs_binding'
  | 'invalid'
  | 'waiting_deployment'
  | 'deploying'
  | 'deployed_unverified'
  | 'ready'
  | 'active'
  | 'activating'
  | 'failed';

export type NextAction =
  | { kind: 'bind_profile'; message: string }
  | { kind: 'publish_pending'; message: string }
  | { kind: 'verify_capability'; message: string; capabilities: CapabilityKey[] }
  | { kind: 'activate'; message: string }
  | { kind: 'safari_verify'; message: string }
  | { kind: 'fix_input'; message: string }
  | { kind: 'none'; message: string };

export interface EnvironmentView {
  id: EnvironmentId;
  code: string;
  nodeTag: string;
  displayName: string;
  site: SiteCode;
  autoOpenOrders: boolean;
  autoFillLogin: boolean;
  revision: number;
  binding: BindingView;
  proxy: {
    desired: ProxyRevisionView | null;
    deployed: ProxyRevisionView | null;
    active: ProxyRevisionView | null;
  };
  account: AccountView;
  readiness: EnvironmentReadiness;
  nextAction: NextAction;
  probes: {
    preflight: ProbeView | null;
    safari: ProbeView | null;
  };
  lastOperation: OperationSummary | null;
  createdAt: IsoTime;
  updatedAt: IsoTime;
}

export interface OperationStep {
  at: IsoTime;
  phase: OperationPhase;
  message: string;
}

export interface OperationSummary {
  id: OperationId;
  kind: OperationKind;
  phase: OperationPhase;
  status: OperationStatus;
  updatedAt: IsoTime;
}

export interface OperationView extends OperationSummary {
  requestId: RequestId;
  environmentId: EnvironmentId | null;
  expectedRevision: number | null;
  resultRevision: number | null;
  routeEpoch: number | null;
  steps: OperationStep[];
  error: ApiErrorBody | null;
  /** 部分操作的附加结果（例如回滚结论、导入批次），只含脱敏数据。 */
  result: Record<string, unknown> | null;
  createdAt: IsoTime;
}

export type RouteWarning =
  | 'old_windows_kept_open'
  | 'external_selection_change'
  | 'external_profile_change'
  | 'surge_unreachable'
  | 'entry_unverified'
  | 'rollback_needs_reverify'
  | 'probe_expired';

export interface RouteStateView {
  routeEpoch: number;
  entryMode: EntryMode;
  entryModeVerifiedAt: IsoTime | null;
  phase: RoutePhase;
  activeEnvironmentId: EnvironmentId | null;
  activeProxyRevision: number | null;
  /** SFE-ROUTE 读回的实际选择。 */
  selectedNode: string | null;
  oldSessionPolicy: OldSessionPolicy | null;
  lastSafariProbe: ProbeView | null;
  /** 当前（或最近一次）激活事务。 */
  operationId: OperationId | null;
  warnings: RouteWarning[];
  updatedAt: IsoTime;
}

export interface CapabilityView {
  key: CapabilityKey;
  label: string;
  status: CapabilityStatus;
  /** 实测时的 Surge 版本；与当前版本不同则视为待验证。 */
  surgeVersion: string | null;
  verifiedAt: IsoTime | null;
  /** 证据文件的脱敏引用（测试 Mac 本地路径或报告编号），不是原始证据。 */
  evidenceRef: string | null;
  note: string | null;
}

export interface SurgeStatusView {
  reachable: boolean;
  version: string | null;
  build: string | null;
  workingProfileName: string | null;
  /** 当前活动配置是否是固定工作配置。 */
  onWorkingProfile: boolean | null;
  managedSectionPresent: boolean | null;
  configurationGeneration: number;
  resourceDigest: string | null;
  lastCheckedAt: IsoTime | null;
  message: string | null;
}

export interface SettingsView {
  surgeCliPath: string;
  surgeHttpApiConfigured: boolean;
  workingProfilePath: string | null;
  entryStrategy: EntryStrategy | null;
  /** 经 P0 实测确认的 Safari 网络进程完整路径。为空时任何入口模式都不可用。 */
  safariProcessPaths: string[];
  verifyEndpointUrl: string;
  defaultFrontProxyId: FrontProxyId | null;
  safariVerifyTimeoutSec: number;
  probeTtlSec: number;
}

export interface Snapshot {
  sequence: number;
  serviceVersion: string;
  environments: EnvironmentView[];
  route: RouteStateView;
  capabilities: CapabilityView[];
  surge: SurgeStatusView;
  frontProxies: FrontProxyView[];
  settings: SettingsView;
  pendingOperations: OperationView[];
}

export function capabilityStatusLabel(status: CapabilityStatus): string {
  return status === 'supported' ? '已通过' : status === 'unsupported' ? '不支持' : '待验证';
}
