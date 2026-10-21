// 本机管理服务的 HTTP 接口（网页后台使用）。这些是本项目自己的接口，不是 Surge 接口。
// 所有修改请求携带唯一 request_id；修改已有对象还需 expected_revision。
// 认证：每个 /api 请求（含 GET 与事件流）都带 `Authorization: Bearer <会话令牌>`；不用 Cookie，
// 因为浏览器对 127.0.0.1 的不同端口共享 Cookie。

import type { ApiErrorBody } from './errors.js';
import type {
  CapabilityContext,
  CapabilityView,
  EnvironmentChanges,
  EnvironmentId,
  EnvironmentInput,
  EnvironmentView,
  FrontProxyId,
  IsoTime,
  OperationId,
  OperationView,
  ProbeKind,
  ProtocolCoverage,
  RequestId,
  Snapshot,
  TakeoverState,
} from './models.js';
import type { CapabilityKey, CapabilityStatus, EntryStrategy, OldSessionPolicy } from './phases.js';
import type { SiteCode } from './sites.js';

export const API_PREFIX = '/api';
export const AUTH_HEADER = 'authorization';
export const AUTH_SCHEME = 'Bearer';
export const DEFAULT_HTTP_PORT = 61847;
/** 一次性登录页路径（GET，带一次性登录码）；服务返回 no-store 页面，由页面脚本取走令牌后替换地址。 */
export const AUTH_EXCHANGE_PATH = '/auth/exchange';

/** 202 受理：已保存期望版本并创建任务，不代表 Surge 或网络已生效。 */
export interface Accepted {
  operation_id: OperationId;
  environment_id: EnvironmentId | null;
  revision: number | null;
  probe_kind?: ProbeKind;
  /** 同一 request_id 重复提交时为 true，返回的是原任务。 */
  duplicate: boolean;
}

export interface SessionInfo {
  authenticated: true;
  serviceVersion: string;
  demoMode: boolean;
  expiresAt: IsoTime;
}

export interface CreateEnvironmentRequest {
  request_id: RequestId;
  environment: EnvironmentInput;
}

export interface UpdateEnvironmentRequest {
  request_id: RequestId;
  expected_revision: number;
  changes: EnvironmentChanges;
}

/** 删除、解除绑定：正在使用或正在验证的环境返回 409 ENVIRONMENT_ACTIVE（请先进入普通模式），没有请求内确认。 */
export interface DeleteEnvironmentRequest {
  request_id: RequestId;
  expected_revision: number;
}

export interface UnbindRequest {
  request_id: RequestId;
  expected_revision: number;
}

export interface ActivateRequest {
  request_id: RequestId;
  /** 有其他环境使用中或其他场景有打开的窗口时必须明确选择；缺省返回 409 NEEDS_CONFIRMATION。 */
  old_session_policy?: OldSessionPolicy;
  /** 用户确认时看到的“当前使用环境”；缺省等同 null（期望没有其他环境在用）。执行时不一致则失败并要求重新确认。 */
  confirmed_environment_id?: EnvironmentId | null;
  /** 目标版本：只能是该环境的 deployed 或 last_verified 版本，缺省为 deployed。 */
  proxy_revision?: number;
}

export interface NormalModeRequest {
  request_id: RequestId;
  /** 有托管环境使用中时必须明确选择如何处理其窗口；缺省返回 409 NEEDS_CONFIRMATION。 */
  old_session_policy?: OldSessionPolicy;
  confirmed_environment_id?: EnvironmentId | null;
}

export type NeedsConfirmationReason = 'other_environment_active' | 'managed_environment_active' | 'other_profiles_open';

export interface NeedsConfirmationDetails {
  reason: NeedsConfirmationReason;
  currentEnvironmentId: EnvironmentId | null;
  currentEnvironmentLabel: string | null;
  /** 最近上报有打开窗口的其他场景（提示性质，只覆盖已启用扩展并上报过的场景）。 */
  otherProfilesOpen: Array<{ profileIdShort: string; environmentLabel: string | null }>;
  options: OldSessionPolicy[];
  /** 首请求与旧连接能力未通过时的限制说明与建议（保存工作后退出并重开 Safari）。 */
  limitation: string | null;
}

export interface PublishPendingRequest {
  request_id: RequestId;
  /** 缺省发布所有待部署环境；也可只发布指定环境。 */
  environment_ids?: EnvironmentId[];
}

export interface ProbeRequest {
  request_id: RequestId;
  /** preflight：后台代理预检（非当前环境）；safari：当前使用环境的 Safari 实测重测，不切换、不断连。 */
  kind: ProbeKind;
}

/** 取消等待中的路由操作：按 §6.3 回滚（恢复原选择并保持阻断），从不进入 NORMAL。 */
export interface CancelOperationRequest {
  request_id: RequestId;
}

/** 用户确认旧环境窗口已关闭：只清除 old_windows_kept_open / managed_windows_on_original_rules 警告并记录声明，不改变路由。 */
export interface AcknowledgeWindowsRequest {
  request_id: RequestId;
}

export interface VerifyFrontProxyRequest {
  request_id: RequestId;
}

export interface AccountDetail {
  environment_id: EnvironmentId;
  label: string | null;
  loginIdentifier: string | null;
  hasPassword: boolean;
}

export interface AcknowledgeAccountRequest {
  request_id: RequestId;
  expected_revision: number;
}

// ---------- 导入 ----------

export type ImportFormat = 'csv' | 'xlsx' | 'json';

/**
 * 导入统一记录。匹配规则：
 * - environment_id 存在且对应未删除的环境 → 更新（内容与秘密指纹都相同则为 unchanged）；
 * - environment_id 存在但不存在或已删除 → invalid；
 * - 没有 environment_id、但已有同名环境，或批次内同名 → conflict，必须逐行选择，从不按名称更新；
 * - 没有 environment_id 也没有同名 → create。
 * front_proxy 是已登记前置的 Surge 节点名或 id；未登记 → invalid（不隐式登记）；空则用请求的
 * default_front_proxy_id，再空用全局默认。更新时空的秘密字段表示保留；导入从不清除秘密。
 * 模板只含合成示例值。
 */
export interface ImportRecord {
  environment_id?: EnvironmentId | null;
  display_name: string;
  proxy_type?: 'socks5';
  proxy_host: string;
  proxy_port: number | string;
  proxy_username?: string | null;
  proxy_password?: string | null;
  front_proxy?: string | null;
  site?: SiteCode | string | null;
  account_label?: string | null;
  login_identifier?: string | null;
  login_password?: string | null;
  expected_exit_ip?: string | null;
  auto_open_orders?: boolean | string | null;
  auto_fill_login?: boolean | string | null;
}

export interface ImportPreviewRequest {
  format: ImportFormat;
  /** csv/xlsx 文件内容（base64）；json 用 records。文件不落盘、不上传。 */
  content_base64?: string;
  records?: unknown[];
  default_front_proxy_id?: FrontProxyId | null;
  /** 行内缺站点时使用；两者都没有则该行无效，不默认美国站。 */
  default_site?: SiteCode | null;
}

export type ImportRowStatus = 'create' | 'update' | 'unchanged' | 'conflict' | 'invalid';

export interface ImportRowPreview {
  row: number;
  status: ImportRowStatus;
  environment_id: EnvironmentId | null;
  /** 涉及已有环境时的当前版本，提交时作为 expected_revision 回传。 */
  current_revision: number | null;
  displayName: string | null;
  /** 脱敏差异：秘密字段只显示“已修改/未修改”，登录账号已打码。 */
  diff: Array<{ field: string; before: string | null; after: string | null }>;
  errors: Array<{ field: string; message: string }>;
  conflictCandidates: Array<{ environment_id: EnvironmentId; label: string; revision: number }>;
}

export interface ImportPreview {
  /** 对解析结果与选项的带密钥摘要（秘密值不参与无密钥哈希）。提交时必须原样回传。 */
  preview_digest: string;
  rows: ImportRowPreview[];
  totals: Record<ImportRowStatus, number>;
  fileErrors: Array<{ field: string; message: string }>;
}

export type ImportRowDecision =
  | { row: number; action: 'create' }
  | { row: number; action: 'update'; environment_id: EnvironmentId; expected_revision: number }
  | { row: number; action: 'skip' };

/** preview_digest 与重新解析的结果不一致时整体拒绝（409 PREVIEW_STALE），需要重新预览。 */
export interface ImportCommitRequest extends ImportPreviewRequest {
  request_id: RequestId;
  preview_digest: string;
  /** 每个 create/update/conflict 行的决定；update 必须带 expected_revision。 */
  decisions: ImportRowDecision[];
}

export interface ImportCommitResult {
  batch_id: string;
  operation_id: OperationId;
  items: Array<{
    row: number;
    environment_id: EnvironmentId | null;
    status: ImportRowStatus | 'skipped' | 'revision_conflict';
    operation_id: OperationId | null;
    error?: ApiErrorBody;
    /** 版本冲突时的脱敏差异。 */
    diff?: Array<{ field: string; before: string | null; after: string | null }>;
  }>;
}

// ---------- 能力 ----------

/** P0 工具或 agent 提交的证据记录；只能“提议”，必须由用户在网页确认后才生效。 */
export interface ProposeCapabilityRequest {
  request_id: RequestId;
  key: CapabilityKey;
  proposed_status: Exclude<CapabilityStatus, 'unverified'>;
  context: CapabilityContext;
  /** 脱敏摘要（不含原始请求头、浏览记录、账号或出口 IP）。 */
  summary: string;
  /** 测试 Mac 上原始证据文件的摘要；原始证据不离开本机限权目录。 */
  evidence_digest: string;
  /** safari_process_attribution 与 safari_udp_quic_handling 的提议必须带逐协议覆盖。 */
  protocol_coverage?: ProtocolCoverage;
  /** safari_process_attribution 的提议必须携带经证据确认的进程完整路径。 */
  safari_process_paths?: string[];
  /** runtime_entry_modes 的提议必须携带所验证的入口策略；确认后成为设置中唯一的入口策略来源。 */
  entry_strategy?: EntryStrategy;
}

/** 只能由网页会话调用：确认一个提议，或把某项重置为待验证。 */
export type ConfirmCapabilityRequest =
  | { request_id: RequestId; action: 'confirm'; proposal_id: string }
  | { request_id: RequestId; action: 'reset'; key: CapabilityKey; note: string | null };

// ---------- 设置 ----------

/**
 * Surge CLI 路径、工作配置路径、Safari 进程路径与入口策略都不在此处：分别只来自安装配置、
 * 维护初始化、已确认的能力证据。
 */
export interface UpdateSettingsRequest {
  request_id: RequestId;
  /** 只在入口为 NORMAL 时允许修改；修改后 Safari 实测全部视为过期。 */
  verifyEndpointId?: string;
  defaultFrontProxyId?: FrontProxyId | null;
  profileArrivalTimeoutSec?: number;
  safariVerifyTimeoutSec?: number;
  probeTtlSec?: number;
  reconcileIntervalSec?: number;
}

// ---------- 前置代理 ----------

export interface RegisterFrontProxyRequest {
  request_id: RequestId;
  /** 用户已有、经核对的 Surge 代理节点名（不能是组、内置策略或 SFE- 节点）。 */
  surgeName: string;
  makeDefault?: boolean;
}

export interface UpdateFrontProxyRequest {
  request_id: RequestId;
  makeDefault?: boolean;
  /** 只有没有依赖环境时才能停用。 */
  retire?: boolean;
}

export interface ReplaceFrontPreviewRequest {
  to_front_id: FrontProxyId;
  environment_ids: EnvironmentId[];
}

export interface ReplaceFrontPreview {
  preview_digest: string;
  items: Array<{ environment_id: EnvironmentId; label: string; revision: number; currentFrontName: string; isActive: boolean }>;
}

export interface ReplaceFrontCommitRequest extends ReplaceFrontPreviewRequest {
  request_id: RequestId;
  preview_digest: string;
  expected_revisions: Record<EnvironmentId, number>;
}

// ---------- 维护：初始化固定工作配置、重新合并受管理段 ----------

export interface InitPreviewRequest {
  /** 缺省为当前活动配置所在目录。工作配置必须与源配置同目录，否则按 P0 结论解析相对引用。 */
  targetDirectory?: string | null;
}

export interface InitPreviewResponse {
  preview_digest: string;
  sourceProfileName: string;
  sourceProfilePath: string;
  workingProfilePath: string;
  backupDirectory: string;
  /** 只含本应用受管理段的差异与被移除的托管头（URL 已脱敏）；不含用户节点凭据。 */
  managedDiff: string;
  referencedFiles: Array<{ relativePath: string; present: boolean }>;
  managedConfigDetected: boolean;
  profileDirectoryRisk: 'none' | 'synced' | 'protected';
  autoReloadEnabled: boolean | null;
  takeover: TakeoverState;
  httpApi: { configured: boolean; loopbackOnly: boolean | null };
  /** 远端托管头之外的远端引用（#!include URL、远端规则集等），只给主机名。 */
  remoteSources: string[];
  /** 存在远端来源时的提示：源配置的远端更新不再自动应用，需要之后的重新合并。 */
  remoteUpdatesNotice: string | null;
  checks: Array<{ name: string; ok: boolean; message: string }>;
  nameCollisions: string[];
}

/** 提交时重新计算摘要（源配置、引用文件、受管理差异、目标路径），不一致返回 409 PREVIEW_STALE。 */
export interface InitCommitRequest {
  request_id: RequestId;
  preview_digest: string;
}

export interface RemergePreviewResponse extends Omit<InitPreviewResponse, 'sourceProfileName' | 'sourceProfilePath' | 'managedConfigDetected'> {
  /** 本应用文件（sfe-nodes.list、入口规则集）与上次发布内容的脱敏差异；提交时恢复上次发布内容（受发布门槛约束）。 */
  managedFilesDiff: string;
  /** 写入工作配置后是否需要重载同一配置，以及 P0 测得的影响（用户据此选择维护时间）。 */
  requiresReload: boolean;
  measuredReloadImpact: string | null;
}

export interface RemergeCommitRequest {
  request_id: RequestId;
  preview_digest: string;
}

// ---------- 路由表 ----------

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

/** 网页使用的路由清单，服务端按此注册，客户端按此调用。 */
export const API_ROUTES = {
  session: { method: 'GET', path: '/api/session' },
  logout: { method: 'POST', path: '/api/session/logout' },
  snapshot: { method: 'GET', path: '/api/snapshot' },
  events: { method: 'GET', path: '/api/events' },
  listEnvironments: { method: 'GET', path: '/api/environments' },
  createEnvironment: { method: 'POST', path: '/api/environments' },
  updateEnvironment: { method: 'PATCH', path: '/api/environments/:id' },
  deleteEnvironment: { method: 'DELETE', path: '/api/environments/:id' },
  accountDetail: { method: 'GET', path: '/api/environments/:id/account' },
  acknowledgeAccount: { method: 'POST', path: '/api/environments/:id/account/acknowledge' },
  activate: { method: 'POST', path: '/api/environments/:id/activate' },
  probe: { method: 'POST', path: '/api/environments/:id/probe' },
  unbind: { method: 'POST', path: '/api/environments/:id/unbind' },
  normal: { method: 'POST', path: '/api/routing/normal' },
  publishPending: { method: 'POST', path: '/api/deployments/publish' },
  getOperation: { method: 'GET', path: '/api/operations/:id' },
  cancelOperation: { method: 'POST', path: '/api/operations/:id/cancel' },
  acknowledgeWindows: { method: 'POST', path: '/api/routing/acknowledge-windows' },
  listOperations: { method: 'GET', path: '/api/operations' },
  importPreview: { method: 'POST', path: '/api/imports/preview' },
  importCommit: { method: 'POST', path: '/api/imports/commit' },
  importTemplate: { method: 'GET', path: '/api/imports/template.csv' },
  listCapabilities: { method: 'GET', path: '/api/capabilities' },
  confirmCapability: { method: 'POST', path: '/api/capabilities' },
  getSettings: { method: 'GET', path: '/api/settings' },
  updateSettings: { method: 'PATCH', path: '/api/settings' },
  listFrontProxies: { method: 'GET', path: '/api/front-proxies' },
  registerFrontProxy: { method: 'POST', path: '/api/front-proxies' },
  updateFrontProxy: { method: 'PATCH', path: '/api/front-proxies/:id' },
  verifyFrontProxy: { method: 'POST', path: '/api/front-proxies/:id/verify' },
  replaceFrontPreview: { method: 'POST', path: '/api/front-proxies/:id/replace/preview' },
  replaceFrontCommit: { method: 'POST', path: '/api/front-proxies/:id/replace/commit' },
  surgeCandidates: { method: 'GET', path: '/api/surge/policies' },
  refreshSurge: { method: 'POST', path: '/api/surge/refresh' },
  initPreview: { method: 'POST', path: '/api/maintenance/init/preview' },
  initCommit: { method: 'POST', path: '/api/maintenance/init/commit' },
  remergePreview: { method: 'POST', path: '/api/maintenance/remerge/preview' },
  remergeCommit: { method: 'POST', path: '/api/maintenance/remerge/commit' },
} as const satisfies Record<string, { method: HttpMethod; path: string }>;

export type ApiRouteName = keyof typeof API_ROUTES;

export function buildPath(path: string, params: Record<string, string> = {}): string {
  return path.replace(/:([a-zA-Z_]+)/g, (_, k: string) => {
    const v = params[k];
    if (v === undefined) throw new Error(`missing path param ${k}`);
    return encodeURIComponent(v);
  });
}

export type ListEnvironmentsResponse = EnvironmentView[];
export type GetSnapshotResponse = Snapshot;
export type GetOperationResponse = OperationView;
export type ListCapabilitiesResponse = CapabilityView[];
