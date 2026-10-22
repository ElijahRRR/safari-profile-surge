// 对外（网页、插件、CLI）可见的脱敏视图模型。任何视图都不得包含代理密码、买家密码、
// Surge 管理密钥、会话令牌或基于秘密内容的无密钥摘要；用户名/密码只给出“是否已配置”。

import type {
  CapabilityContextField,
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
  /** null 表示使用当前默认前置；保存时解析成具体 id 存储，之后修改默认值不影响已有环境。 */
  frontProxyId: FrontProxyId | null;
  /**
   * 用户提供的预期出口 IP；代理连接地址不能自动当作预期出口。它不是 Surge 节点参数，存放在
   * 环境上：只改它不会产生新节点版本，也不触发发布或切换；对正在使用的环境会立即与最近一次
   * Safari 实测比较，不符则停止自动打开与填充并告警。
   */
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
  /** 首次关联向导中用户确认的步骤（纯数据修改）。 */
  bindingStage?: 'awaiting_profile' | 'awaiting_extension' | 'awaiting_association' | null;
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
  /** Surge 中的实际节点名，例如 SFE-N-E0001-US01-v003。 */
  nodeName: string;
  createdAt: IsoTime;
}

export type FrontProxyState = 'unverified' | 'ok' | 'missing' | 'failed';

/** 首版前置只允许用户已有、经核对的固定节点（不接受组、DIRECT/REJECT 等内置策略或 SFE- 节点）。 */
export interface FrontProxyView {
  id: FrontProxyId;
  surgeName: string;
  kind: 'node';
  state: FrontProxyState;
  isDefault: boolean;
  retired: boolean;
  dependentEnvironmentIds: EnvironmentId[];
  lastCheckedAt: IsoTime | null;
}

/**
 * 场景关联状态。bound_unverified_id：已绑定，但原生场景 ID 的稳定性尚未通过 P0。
 * 未绑定时 stage 记录首次关联向导进度（用户确认的步骤，不是系统事实）。
 */
export interface BindingView {
  state: 'unbound' | 'bound' | 'bound_unverified_id';
  stage: 'awaiting_profile' | 'awaiting_extension' | 'awaiting_association' | null;
  /** 原生 profile ID 只展示前 8 位，用于核对。 */
  profileIdShort: string | null;
  boundAt: IsoTime | null;
  /** 该场景最近一次上报的站点权限情况（提示性质）。 */
  sitePermissionGranted: boolean | null;
}

export interface AccountView {
  label: string | null;
  loginIdentifierMasked: string | null;
  hasLoginIdentifier: boolean;
  hasPassword: boolean;
  /**
   * 页面实际登录身份。首版没有可靠的页面证据来源，始终为 unverified；
   * 不能用填充成功或配置账号推断“已识别”。
   */
  pageIdentity: 'unverified';
  /** 配置账号在用户最近一次确认后被修改过：显示“配置账号已更换，网页登录状态未核对”。 */
  changedSincePageCheck: boolean;
}

export type ProbeKind = 'preflight' | 'safari';
export type ProbeOutcome = 'ok' | 'failed' | 'mismatch' | 'inconclusive';

export interface SurgeRequestEvidence {
  id: string;
  remoteHost: string | null;
  rule: string | null;
  policyName: string | null;
  startedAt: IsoTime | null;
  newConnection: boolean | null;
}

export interface ProbeView {
  id: string;
  kind: ProbeKind;
  outcome: ProbeOutcome;
  /** Safari 实测出口 IP。预检只证明代理可达时为 null（testPolicy 不返回出口）。 */
  exitIp: string | null;
  proxyRevision: number;
  nodeName: string;
  routeEpoch: number | null;
  configurationGeneration: number | null;
  /** 检测时读回的入口模式。 */
  entryMode: EntryMode | null;
  testId: string | null;
  /** Surge 侧核对到的对应请求（仅 Safari 实测）。 */
  surgeRequest: SurgeRequestEvidence | null;
  /** 前置链路证据说明；6.5 无法读出链路时说明依赖能力门槛，不把出口 IP 当作链路证明。 */
  chainEvidence: string | null;
  browser: { httpStatus: number | null; startedAt: IsoTime | null; finishedAt: IsoTime | null; error: string | null } | null;
  observedAt: IsoTime;
  /** 检测有效期，过期后显示“上次结果”，不得标为实时。 */
  expiresAt: IsoTime;
  message: string | null;
}

/** 环境各方面的独立状态；任何一面不满足都不能显示为可启动。 */
export interface EnvironmentFacets {
  input: 'valid' | 'invalid';
  binding: BindingView['state'];
  deployment: 'none' | 'pending' | 'blocked_by_capability' | 'deploying' | 'deployed' | 'readback_partial' | 'failed';
  preflight: 'none' | 'ok' | 'failed' | 'inconclusive' | 'expired';
  route: 'inactive' | 'waiting_route' | 'activating' | 'verifying' | 'active' | 'rolled_back';
}

/** 汇总状态，由 environmentReadiness() 从 facets 按固定优先级推导。 */
export type EnvironmentReadiness =
  | 'invalid'
  | 'needs_binding'
  | 'waiting_deployment'
  | 'deploying'
  | 'sync_failed'
  | 'proxy_unavailable'
  | 'deployed_unverified'
  | 'ready'
  | 'activating'
  | 'active'
  | 'needs_reverify';

export type NextActionKind =
  | 'fix_input'
  | 'bind_profile'
  | 'verify_capability'
  | 'publish_pending'
  | 'activate'
  | 'apply_new_revision'
  | 'safari_verify'
  | 'reverify'
  | 'probe_safari'
  | 'open_orders'
  | 'acknowledge_account_change'
  | 'none';

export interface NextAction {
  kind: NextActionKind;
  message: string;
  capabilities?: CapabilityKey[];
}

export interface EnvironmentView {
  id: EnvironmentId;
  code: string;
  nodeTag: string;
  displayName: string;
  site: SiteCode;
  autoOpenOrders: boolean;
  autoFillLogin: boolean;
  expectedExitIp: string | null;
  revision: number;
  binding: BindingView;
  proxy: {
    desired: ProxyRevisionView | null;
    deployed: ProxyRevisionView | null;
    active: ProxyRevisionView | null;
    /** 最近一次通过 Safari 实测的版本；回滚与“返回上一版本”使用。 */
    lastVerified: ProxyRevisionView | null;
  };
  account: AccountView;
  facets: EnvironmentFacets;
  readiness: EnvironmentReadiness;
  /** 第一项是主要下一步。 */
  nextActions: NextAction[];
  probes: {
    preflight: ProbeView | null;
    safari: ProbeView | null;
  };
  lastOperation: OperationSummary | null;
  lastError: ApiErrorBody | null;
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
  error: ApiErrorBody | null;
  updatedAt: IsoTime;
}

export interface KillResult {
  surgeRequestId: string;
  processPath: string | null;
  /** 只记录是否为检测域名连接，不持久化其他远端主机。 */
  toVerifyHost: boolean;
  ok: boolean;
  error: string | null;
  at: IsoTime;
}

export interface RollbackResult {
  previousEnvironmentId: EnvironmentId | null;
  previousProxyRevision: number | null;
  /** 显示为“上次结果”，从不当作实时状态。 */
  previousProbe: ProbeView | null;
  restoredSelection: string | null;
  entryModeAfter: EntryMode;
  failedProxyRevision: number | null;
  failureError: ApiErrorBody;
  needsReverify: boolean;
}

export interface OperationEffective {
  desiredProxyRevision: number | null;
  deployedProxyRevision: number | null;
  activeProxyRevision: number | null;
  configurationGeneration: number | null;
  routeEpoch: number | null;
}

export interface OperationView extends OperationSummary {
  requestId: RequestId;
  environmentId: EnvironmentId | null;
  initiator: 'web' | 'agent' | 'admin' | 'bridge' | 'service';
  expectedRevision: number | null;
  resultRevision: number | null;
  routeEpoch: number | null;
  probeKind: ProbeKind | null;
  supersededBy: OperationId | null;
  steps: OperationStep[];
  effective: OperationEffective;
  /** 结构化结果（全部脱敏）：路由操作含 killResults / rollback；发布含 readbackLevel；导入含批次条目。 */
  result: {
    killResults?: KillResult[];
    rollback?: RollbackResult;
    readbackLevel?: 'full' | 'partial';
    uncheckedFields?: string[];
    [key: string]: unknown;
  } | null;
  createdAt: IsoTime;
}

export type RouteWarning =
  | 'old_windows_kept_open'
  | 'managed_windows_on_original_rules'
  | 'old_session_unproven'
  | 'launch_unverified'
  | 'launch_order_unverified'
  | 'external_selection_change'
  | 'external_profile_change'
  | 'surge_unreachable'
  | 'surge_restarted'
  | 'takeover_lost'
  | 'takeover_unknown'
  | 'outbound_mode_changed'
  | 'entry_unverified'
  | 'precedence_violation'
  | 'front_missing'
  | 'managed_segments_changed'
  | 'rollback_needs_reverify'
  | 'probe_expired'
  | 'probe_failed'
  | 'exit_ip_mismatch'
  /** 普通模式未能确认 Safari 已没有经买家出口的连接（结束连接失败，或入口未经运行时确认）：下一次普通模式再结束。 */
  | 'buyer_exit_connections_unconfirmed';

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
  /** 当前（或最近一次）路由操作。 */
  operationId: OperationId | null;
  /** 等待目标场景到达/实测的截止时间。 */
  awaitingDeadline: IsoTime | null;
  warnings: RouteWarning[];
  lastReconciledAt: IsoTime | null;
  updatedAt: IsoTime;
}

/** 激活前写入的切换前状态快照，崩溃后用于回滚。 */
export interface ActivationSnapshot {
  previousEnvironmentId: EnvironmentId | null;
  previousProxyRevision: number | null;
  previousSelectedNode: string | null;
  previousEntryMode: EntryMode;
  previousSafariProbeId: string | null;
  previousRouteEpoch: number;
  previousPhase: RoutePhase;
}

/** 对非当前环境绑定场景返回的受限路由信息。 */
export interface RouteSummaryView {
  routeEpoch: number;
  entryMode: EntryMode;
  phase: RoutePhase;
}

export interface CapabilityContext {
  surgeVersion: string | null;
  surgeBuild: string | null;
  macosBuild: string | null;
  safariVersion: string | null;
  entryStrategy: EntryStrategy | null;
  processPathsDigest: string | null;
  workingProfileId: string | null;
  autoReload: 'on' | 'off' | 'any' | null;
  takeoverMode: 'enhanced' | 'system_proxy' | 'both' | 'any' | null;
  signingIdentity: string | null;
  adapterMechanism: string | null;
}

export type ProtocolCoverageItem =
  | 'ipv4'
  | 'ipv6'
  | 'http1'
  | 'http2'
  | 'http3_quic'
  | 'websocket'
  | 'extension_page_fetch'
  | 'webrtc'
  | 'dns'
  | 'system_services';

/** 逐协议的实测覆盖。gating 项（除 webrtc/dns/system_services）必须 pass 或写明 limitation 才能确认 supported。 */
export type ProtocolCoverage = Partial<Record<ProtocolCoverageItem, { result: 'pass' | 'fail' | 'limitation' | 'not_tested'; note: string | null }>>;

export const GATING_COVERAGE_ITEMS: readonly ProtocolCoverageItem[] = ['ipv4', 'ipv6', 'http1', 'http2', 'http3_quic', 'websocket', 'extension_page_fetch'];

export interface CapabilityView {
  key: CapabilityKey;
  label: string;
  /** 记录的结论。 */
  status: CapabilityStatus;
  /** 与当前上下文比较后的有效结论；上下文不一致时为 unverified。 */
  effectiveStatus: CapabilityStatus;
  staleReasons: CapabilityContextField[];
  context: CapabilityContext | null;
  protocolCoverage: ProtocolCoverage | null;
  verifiedAt: IsoTime | null;
  proposalId: string | null;
  /** P0 记录的限制说明（例如“协议覆盖：H3 已拒绝并回落 TCP；IPv6 未验证”）。 */
  note: string | null;
}

export interface CapabilityProposalView {
  id: string;
  key: CapabilityKey;
  proposedStatus: Exclude<CapabilityStatus, 'unverified'>;
  context: CapabilityContext;
  protocolCoverage: ProtocolCoverage | null;
  summary: string;
  evidenceDigest: string;
  submittedAt: IsoTime;
  /** 提议只来自 P0 工具/agent 或维护通道；网页只确认。 */
  submittedBy: 'agent' | 'admin';
}

export interface TakeoverState {
  enhancedMode: boolean | null;
  systemProxy: boolean | null;
  outboundMode: 'rule' | 'direct' | 'proxy' | null;
  checkedAt: IsoTime | null;
}

export interface PrecedenceIssue {
  /** 已脱敏的规则文本与来源（模块名/临时规则/配置）。 */
  rule: string;
  source: 'module' | 'temp_rule' | 'profile' | 'unknown';
  severity: 'blocking' | 'warning';
}

export interface SurgeStatusView {
  reachable: boolean;
  version: string | null;
  build: string | null;
  currentProfileName: string | null;
  /** 当前活动配置是否是记录的固定工作配置。 */
  onWorkingProfile: boolean | null;
  managedSectionsIntact: boolean | null;
  configurationGeneration: number;
  takeover: TakeoverState;
  autoReload: boolean | null;
  httpApi: { configured: boolean; loopbackOnly: boolean | null };
  /** Surge 配置目录在 iCloud 或其他同步/受保护位置。 */
  profileDirectoryRisk: 'none' | 'synced' | 'protected' | null;
  precedenceIssues: PrecedenceIssue[];
  lastCheckedAt: IsoTime | null;
  message: string | null;
}

export interface VerifyEndpoint {
  id: string;
  url: string;
  host: string;
  label: string;
}

export interface SettingsView {
  /** 只读：来自安装时写入的 0600 配置文件，网页不能修改。 */
  surgeCliPath: string | null;
  /** 只读：只能由维护初始化设置。 */
  workingProfilePath: string | null;
  entryStrategy: EntryStrategy | null;
  /** 只读：随 safari_process_attribution 的实测证据确认。 */
  safariProcessPaths: string[];
  verifyEndpointId: string;
  defaultFrontProxyId: FrontProxyId | null;
  profileArrivalTimeoutSec: number;
  safariVerifyTimeoutSec: number;
  probeTtlSec: number;
  reconcileIntervalSec: number;
}

export interface Snapshot {
  sequence: number;
  serviceVersion: string;
  /** 演示模式：FakeSurge + 合成数据，界面必须显示常驻 DEMO 标识。 */
  demoMode: boolean;
  environments: EnvironmentView[];
  route: RouteStateView;
  capabilities: CapabilityView[];
  capabilityProposals: CapabilityProposalView[];
  surge: SurgeStatusView;
  frontProxies: FrontProxyView[];
  settings: SettingsView;
  pendingOperations: OperationView[];
}

export function capabilityStatusLabel(status: CapabilityStatus): string {
  return status === 'supported' ? '已通过' : status === 'unsupported' ? '不支持' : '待验证';
}
