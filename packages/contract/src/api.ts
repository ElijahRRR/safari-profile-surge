// 本机管理服务的 HTTP 接口（网页后台使用）。这些是本项目自己的接口，不是 Surge 接口。
// 所有修改请求携带唯一 request_id；修改已有对象还需 expected_revision。

import type {
  EnvironmentChanges,
  EnvironmentId,
  EnvironmentInput,
  EnvironmentView,
  FrontProxyId,
  OperationId,
  OperationView,
  RequestId,
  Snapshot,
} from './models.js';
import type { CapabilityKey, CapabilityStatus, EntryStrategy, OldSessionPolicy } from './phases.js';

export const API_PREFIX = '/api';
export const CSRF_HEADER = 'x-sfe-csrf';
export const SESSION_COOKIE = 'sfe_session';
export const DEFAULT_HTTP_PORT = 61847;

/** 202 受理：已保存期望版本并创建任务，不代表 Surge 或网络已生效。 */
export interface Accepted {
  operation_id: OperationId;
  environment_id: EnvironmentId | null;
  revision: number | null;
  /** 同一 request_id 重复提交时为 true，返回的是原任务。 */
  duplicate: boolean;
}

export interface SessionInfo {
  authenticated: true;
  csrfToken: string;
  serviceVersion: string;
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

export interface DeleteEnvironmentRequest {
  request_id: RequestId;
  expected_revision: number;
}

export interface ActivateRequest {
  request_id: RequestId;
  /** 有其他环境正在使用时必须明确选择；缺省时返回 409 NEEDS_CONFIRMATION。 */
  old_session_policy?: OldSessionPolicy;
}

export interface NeedsConfirmationDetails {
  reason: 'other_environment_active';
  currentEnvironmentId: EnvironmentId;
  currentEnvironmentLabel: string;
  options: OldSessionPolicy[];
}

export interface NormalModeRequest {
  request_id: RequestId;
}

export interface PublishPendingRequest {
  request_id: RequestId;
  /** 连接连续性尚未实测通过时，用户必须显式确认才允许手动发布。 */
  acknowledge_continuity_unverified?: boolean;
}

export interface ProbeRequest {
  request_id: RequestId;
}

export interface UnbindRequest {
  request_id: RequestId;
  expected_revision: number;
}

export interface AccountDetail {
  environment_id: EnvironmentId;
  label: string | null;
  loginIdentifier: string | null;
  hasPassword: boolean;
}

// ---------- 导入 ----------

export type ImportFormat = 'csv' | 'xlsx' | 'json';
export type ImportMode = 'preview' | 'commit';

/** 同名冲突时用户的选择：更新已有 / 新建；不猜测覆盖。 */
export type ConflictResolution = { row: number; action: 'update'; environment_id: EnvironmentId } | { row: number; action: 'create' } | { row: number; action: 'skip' };

export interface ImportRequest {
  request_id: RequestId;
  format: ImportFormat;
  mode: ImportMode;
  /** csv/xlsx 文件内容（base64）；json 可用 records。文件不落盘、不上传。 */
  content_base64?: string;
  records?: unknown[];
  /** 未在行内给出前置时使用的前置；仍须可解析。 */
  default_front_proxy_id?: FrontProxyId | null;
  resolutions?: ConflictResolution[];
}

export type ImportRowStatus =
  | 'create'
  | 'update'
  | 'unchanged'
  | 'conflict'
  | 'invalid'
  | 'skipped';

export interface ImportRowPreview {
  row: number;
  status: ImportRowStatus;
  environment_id: EnvironmentId | null;
  displayName: string | null;
  /** 脱敏差异：字段名 → 旧/新展示值；秘密字段只显示“已修改/未修改”。 */
  diff: Array<{ field: string; before: string | null; after: string | null }>;
  errors: Array<{ field: string; message: string }>;
  conflictCandidates: Array<{ environment_id: EnvironmentId; label: string }>;
}

export interface ImportPreview {
  batch_digest: string;
  rows: ImportRowPreview[];
  totals: Record<ImportRowStatus, number>;
}

export interface ImportCommitResult {
  batch_id: string;
  operation_id: OperationId;
  items: Array<{ row: number; environment_id: EnvironmentId | null; status: ImportRowStatus; operation_id: OperationId | null }>;
}

// ---------- 能力与设置 ----------

export interface RecordCapabilityRequest {
  request_id: RequestId;
  key: CapabilityKey;
  status: CapabilityStatus;
  evidence_ref: string | null;
  note: string | null;
}

export interface UpdateSettingsRequest {
  request_id: RequestId;
  surgeCliPath?: string;
  workingProfilePath?: string | null;
  entryStrategy?: EntryStrategy | null;
  safariProcessPaths?: string[];
  verifyEndpointUrl?: string;
  defaultFrontProxyId?: FrontProxyId | null;
  safariVerifyTimeoutSec?: number;
  probeTtlSec?: number;
}

export interface RegisterFrontProxyRequest {
  request_id: RequestId;
  /** 用户已有、经核对的 Surge 节点名。 */
  surgeName: string;
  makeDefault?: boolean;
}

// ---------- 维护：初始化固定工作配置 ----------

export interface InitPreviewResponse {
  sourceProfilePath: string;
  workingProfilePath: string;
  /** 只含本应用受管理段的差异，统一 diff 文本（不含凭据，节点资源单独存放）。 */
  managedDiff: string;
  checks: Array<{ name: string; ok: boolean; message: string }>;
  nameCollisions: string[];
}

export interface InitCommitRequest {
  request_id: RequestId;
  preview_digest: string;
}

// ---------- 路由表 ----------

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

/** 网页与 CLI 共用的路由清单，服务端按此注册，客户端按此调用。 */
export const API_ROUTES = {
  session: { method: 'GET', path: '/api/session' },
  snapshot: { method: 'GET', path: '/api/snapshot' },
  events: { method: 'GET', path: '/api/events' },
  listEnvironments: { method: 'GET', path: '/api/environments' },
  createEnvironment: { method: 'POST', path: '/api/environments' },
  updateEnvironment: { method: 'PATCH', path: '/api/environments/:id' },
  deleteEnvironment: { method: 'DELETE', path: '/api/environments/:id' },
  accountDetail: { method: 'GET', path: '/api/environments/:id/account' },
  activate: { method: 'POST', path: '/api/environments/:id/activate' },
  probe: { method: 'POST', path: '/api/environments/:id/probe' },
  unbind: { method: 'POST', path: '/api/environments/:id/unbind' },
  normal: { method: 'POST', path: '/api/routing/normal' },
  publishPending: { method: 'POST', path: '/api/deployments/publish' },
  getOperation: { method: 'GET', path: '/api/operations/:id' },
  listOperations: { method: 'GET', path: '/api/operations' },
  importFile: { method: 'POST', path: '/api/imports' },
  importTemplate: { method: 'GET', path: '/api/imports/template.csv' },
  listCapabilities: { method: 'GET', path: '/api/capabilities' },
  recordCapability: { method: 'POST', path: '/api/capabilities' },
  getSettings: { method: 'GET', path: '/api/settings' },
  updateSettings: { method: 'PATCH', path: '/api/settings' },
  listFrontProxies: { method: 'GET', path: '/api/front-proxies' },
  registerFrontProxy: { method: 'POST', path: '/api/front-proxies' },
  surgeCandidates: { method: 'GET', path: '/api/surge/policies' },
  refreshSurge: { method: 'POST', path: '/api/surge/refresh' },
  initPreview: { method: 'POST', path: '/api/maintenance/init/preview' },
  initCommit: { method: 'POST', path: '/api/maintenance/init/commit' },
  logout: { method: 'POST', path: '/api/session/logout' },
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
