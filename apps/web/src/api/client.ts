// 本机服务 HTTP 客户端（同源，base ''）。每个请求都带 Authorization: Bearer，从不带 Cookie
// （credentials: 'omit'：127.0.0.1 的其他端口可能写入 Cookie）。错误体 { error } 转成带错误码的 ApiError；
// 401 进入“会话已过期”状态。请求体与响应体从不写日志。

import {
  API_ROUTES,
  AUTH_SCHEME,
  ERROR_CODES,
  SfeError,
  buildPath,
  type AcknowledgeAccountRequest,
  type AcknowledgeWindowsRequest,
  type AccountDetail,
  type Accepted,
  type ActivateRequest,
  type ApiErrorBody,
  type ApiRouteName,
  type CancelOperationRequest,
  type CapabilityView,
  type ConfirmCapabilityRequest,
  type CreateEnvironmentRequest,
  type DeleteEnvironmentRequest,
  type EnvironmentView,
  type ErrorCode,
  type FrontProxyView,
  type ImportCommitRequest,
  type ImportCommitResult,
  type ImportPreview,
  type ImportPreviewRequest,
  type InitCommitRequest,
  type InitPreviewRequest,
  type InitPreviewResponse,
  type NormalModeRequest,
  type OperationView,
  type ProbeRequest,
  type PublishPendingRequest,
  type RegisterFrontProxyRequest,
  type RemergeCommitRequest,
  type RemergePreviewRequest,
  type RemergePreviewResponse,
  type ReplaceFrontCommitRequest,
  type ReplaceFrontPreview,
  type ReplaceFrontPreviewRequest,
  type SessionInfo,
  type SettingsView,
  type Snapshot,
  type SurgeStatusView,
  type UnbindRequest,
  type UpdateEnvironmentRequest,
  type UpdateFrontProxyRequest,
  type UpdateSettingsRequest,
  type VerifyFrontProxyRequest,
} from '@sfe/contract';
import type { TokenStore } from './session-token';

/** GET /api/surge/policies 的响应（服务端 SurgePolicyCandidates）。 */
export interface SurgePolicyCandidates {
  /** 可作为前置的用户代理节点名（不含 SFE- 节点、内置策略）。 */
  proxies: string[];
  /** 仅供展示：组不能作为前置。 */
  groups: string[];
}

export class ApiError extends SfeError {
  /** HTTP 状态；0 表示没有连上本机服务。 */
  readonly status: number;

  constructor(status: number, body: ApiErrorBody) {
    super(body.code, body.message, {
      ...(body.fieldErrors ? { fieldErrors: body.fieldErrors } : {}),
      ...(body.details ? { details: body.details } : {}),
    });
    this.name = 'ApiError';
    this.status = status;
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value);
}

/** 只接受形状正确的错误体；其他内容一律换成不回显原文的通用错误。 */
export function parseErrorBody(value: unknown): ApiErrorBody | null {
  if (!value || typeof value !== 'object') return null;
  const err = (value as { error?: unknown }).error;
  if (!err || typeof err !== 'object') return null;
  const { code, message, fieldErrors, details } = err as Record<string, unknown>;
  if (!isErrorCode(code) || typeof message !== 'string') return null;
  const body: ApiErrorBody = { code, message };
  if (Array.isArray(fieldErrors)) {
    body.fieldErrors = fieldErrors.filter(
      (f): f is { field: string; message: string } =>
        !!f && typeof f === 'object' && typeof (f as { field?: unknown }).field === 'string' && typeof (f as { message?: unknown }).message === 'string',
    );
  }
  if (details && typeof details === 'object' && !Array.isArray(details)) body.details = details as Record<string, unknown>;
  return body;
}

function fallbackCode(status: number): ErrorCode {
  if (status === 401) return 'AUTH_REQUIRED';
  if (status === 403) return 'FORBIDDEN_ORIGIN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 429) return 'RATE_LIMITED';
  if (status === 400 || status === 422) return 'BAD_REQUEST';
  return 'INTERNAL';
}

export const SESSION_EXPIRED_MESSAGE = '会话已过期：请从菜单栏 App 或 sfe open 重新打开管理后台';
export const SERVICE_UNREACHABLE_MESSAGE = '连接本机服务失败：服务未运行或已停止';

export interface ApiClientOptions {
  tokens: TokenStore;
  /** 同源部署，默认 ''。 */
  baseUrl?: string;
  fetch?: typeof fetch;
  /** 401 或没有令牌时调用（进入“会话已过期/未登录”状态）。 */
  onUnauthorized?: () => void;
}

interface CallOptions {
  params?: Record<string, string>;
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  accept?: 'json' | 'text';
}

export class ApiClient {
  private readonly tokens: TokenStore;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly onUnauthorized: (() => void) | undefined;

  constructor(opts: ApiClientOptions) {
    this.tokens = opts.tokens;
    this.baseUrl = opts.baseUrl ?? '';
    this.fetchImpl = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.onUnauthorized = opts.onUnauthorized;
  }

  hasToken(): boolean {
    return this.tokens.get() !== null;
  }

  async call<T>(route: ApiRouteName, opts: CallOptions = {}): Promise<T> {
    const def = API_ROUTES[route];
    let url = this.baseUrl + buildPath(def.path, opts.params ?? {});
    if (opts.query) {
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(opts.query)) if (v !== undefined) q.set(k, String(v));
      const s = q.toString();
      if (s) url += `?${s}`;
    }
    const token = this.tokens.get();
    if (!token) {
      this.onUnauthorized?.();
      throw new ApiError(401, { code: 'AUTH_REQUIRED', message: SESSION_EXPIRED_MESSAGE });
    }
    const headers: Record<string, string> = {
      Accept: opts.accept === 'text' ? 'text/csv, text/plain' : 'application/json',
      Authorization: `${AUTH_SCHEME} ${token}`,
    };
    const init: RequestInit = { method: def.method, headers, credentials: 'omit', cache: 'no-store' };
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }

    let res: Response;
    try {
      res = await this.fetchImpl(url, init);
    } catch {
      throw new ApiError(0, { code: 'INTERNAL', message: SERVICE_UNREACHABLE_MESSAGE });
    }

    if (res.status === 401) {
      this.onUnauthorized?.();
      const parsed = parseErrorBody(await readJson(res));
      throw new ApiError(401, parsed ?? { code: 'AUTH_REQUIRED', message: SESSION_EXPIRED_MESSAGE });
    }
    if (!res.ok) {
      const parsed = parseErrorBody(await readJson(res));
      throw new ApiError(res.status, parsed ?? { code: fallbackCode(res.status), message: `请求失败：本机服务返回 ${res.status}` });
    }
    if (res.status === 204) return undefined as T;
    if (opts.accept === 'text') return (await res.text()) as T;
    let text: string;
    try {
      text = await res.text();
    } catch {
      throw new ApiError(0, { code: 'INTERNAL', message: SERVICE_UNREACHABLE_MESSAGE });
    }
    if (text === '') return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ApiError(res.status, { code: 'INTERNAL', message: '读取响应失败：本机服务返回的内容不是 JSON' });
    }
  }

  // ---------- 会话与快照 ----------
  session = () => this.call<SessionInfo>('session');
  logout = () => this.call<void>('logout', { body: {} });
  snapshot = () => this.call<Snapshot>('snapshot');

  // ---------- 环境 ----------
  listEnvironments = () => this.call<EnvironmentView[]>('listEnvironments');
  createEnvironment = (req: CreateEnvironmentRequest) => this.call<Accepted>('createEnvironment', { body: req });
  updateEnvironment = (id: string, req: UpdateEnvironmentRequest) => this.call<Accepted>('updateEnvironment', { params: { id }, body: req });
  deleteEnvironment = (id: string, req: DeleteEnvironmentRequest) => this.call<Accepted>('deleteEnvironment', { params: { id }, body: req });
  accountDetail = (id: string) => this.call<AccountDetail>('accountDetail', { params: { id } });
  acknowledgeAccount = (id: string, req: AcknowledgeAccountRequest) => this.call<Accepted>('acknowledgeAccount', { params: { id }, body: req });
  activate = (id: string, req: ActivateRequest) => this.call<Accepted>('activate', { params: { id }, body: req });
  probe = (id: string, req: ProbeRequest) => this.call<Accepted>('probe', { params: { id }, body: req });
  unbind = (id: string, req: UnbindRequest) => this.call<Accepted>('unbind', { params: { id }, body: req });

  // ---------- 路由与发布 ----------
  normal = (req: NormalModeRequest) => this.call<Accepted>('normal', { body: req });
  publishPending = (req: PublishPendingRequest) => this.call<Accepted>('publishPending', { body: req });
  acknowledgeWindows = (req: AcknowledgeWindowsRequest) => this.call<Accepted>('acknowledgeWindows', { body: req });

  // ---------- 操作 ----------
  getOperation = (id: string) => this.call<OperationView>('getOperation', { params: { id } });
  cancelOperation = (id: string, req: CancelOperationRequest) => this.call<Accepted>('cancelOperation', { params: { id }, body: req });
  listOperations = (limit?: number) => this.call<OperationView[]>('listOperations', { query: { limit } });

  // ---------- 导入 ----------
  importPreview = (req: ImportPreviewRequest) => this.call<ImportPreview>('importPreview', { body: req });
  importCommit = (req: ImportCommitRequest) => this.call<ImportCommitResult>('importCommit', { body: req });
  importTemplate = () => this.call<string>('importTemplate', { accept: 'text' });

  // ---------- 能力 ----------
  listCapabilities = () => this.call<CapabilityView[]>('listCapabilities');
  confirmCapability = (req: ConfirmCapabilityRequest) => this.call<CapabilityView>('confirmCapability', { body: req });

  // ---------- 设置 ----------
  getSettings = () => this.call<SettingsView>('getSettings');
  updateSettings = (req: UpdateSettingsRequest) => this.call<SettingsView>('updateSettings', { body: req });

  // ---------- 前置代理 ----------
  listFrontProxies = () => this.call<FrontProxyView[]>('listFrontProxies');
  registerFrontProxy = (req: RegisterFrontProxyRequest) => this.call<FrontProxyView>('registerFrontProxy', { body: req });
  updateFrontProxy = (id: string, req: UpdateFrontProxyRequest) => this.call<FrontProxyView>('updateFrontProxy', { params: { id }, body: req });
  verifyFrontProxy = (id: string, req: VerifyFrontProxyRequest) => this.call<Accepted>('verifyFrontProxy', { params: { id }, body: req });
  replaceFrontPreview = (id: string, req: ReplaceFrontPreviewRequest) => this.call<ReplaceFrontPreview>('replaceFrontPreview', { params: { id }, body: req });
  replaceFrontCommit = (id: string, req: ReplaceFrontCommitRequest) => this.call<Accepted>('replaceFrontCommit', { params: { id }, body: req });

  // ---------- Surge 与维护 ----------
  surgeCandidates = () => this.call<SurgePolicyCandidates>('surgeCandidates');
  refreshSurge = () => this.call<SurgeStatusView>('refreshSurge', { body: {} });
  initPreview = (req: InitPreviewRequest) => this.call<InitPreviewResponse>('initPreview', { body: req });
  initCommit = (req: InitCommitRequest) => this.call<Accepted>('initCommit', { body: req });
  /** req：预览选项（更换本机资源地址 rotateResourceUrl）；提交时的选项必须与预览相同。 */
  remergePreview = (req: RemergePreviewRequest = {}) => this.call<RemergePreviewResponse>('remergePreview', { body: req });
  remergeCommit = (req: RemergeCommitRequest) => this.call<Accepted>('remergeCommit', { body: req });
}

async function readJson(res: Response): Promise<unknown> {
  try {
    const text = await res.text();
    return text ? (JSON.parse(text) as unknown) : undefined;
  } catch {
    return undefined;
  }
}
