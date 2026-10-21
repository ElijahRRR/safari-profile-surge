// /api 路由：按 contract 的 API_ROUTES 注册，逐个映射到 AppService。返回 Accepted 的接口用 202
// （只表示已受理，不代表 Surge 或网络已生效），其余 200。请求体由服务端业务层校验，这里只做形状与类型转换。

import {
  API_ROUTES,
  SfeError,
  type Accepted,
  type AcknowledgeAccountRequest,
  type AcknowledgeWindowsRequest,
  type ActivateRequest,
  type ApiRouteName,
  type CancelOperationRequest,
  type ConfirmCapabilityRequest,
  type CreateEnvironmentRequest,
  type DeleteEnvironmentRequest,
  type HttpMethod,
  type ImportCommitRequest,
  type ImportPreviewRequest,
  type InitCommitRequest,
  type InitPreviewRequest,
  type NormalModeRequest,
  type ProbeRequest,
  type PublishPendingRequest,
  type RegisterFrontProxyRequest,
  type RemergeCommitRequest,
  type ReplaceFrontCommitRequest,
  type ReplaceFrontPreviewRequest,
  type SessionInfo,
  type UnbindRequest,
  type UpdateEnvironmentRequest,
  type UpdateFrontProxyRequest,
  type UpdateSettingsRequest,
  type VerifyFrontProxyRequest,
} from '@sfe/contract';
import type { Actor, AppService } from '../app.js';

export const DEFAULT_OPERATIONS_LIMIT = 50;
export const MAX_OPERATIONS_LIMIT = 500;

export interface RouteContext {
  app: AppService;
  params: Record<string, string>;
  query: URLSearchParams;
  body: Record<string, unknown>;
  actor: Actor & { kind: 'web' };
  session: { info: () => SessionInfo; logout: () => void };
}

export type RouteResult =
  | { kind: 'json'; status: number; data: unknown }
  | { kind: 'text'; status: number; contentType: string; body: string; headers?: Record<string, string> }
  | { kind: 'empty'; status: 204 };

export type RouteHandler = (ctx: RouteContext) => Promise<RouteResult>;

/** 事件流不走这张表（见 sse.ts）。 */
export type JsonRouteName = Exclude<ApiRouteName, 'events'>;

const json = async (p: Promise<unknown> | unknown, status = 200): Promise<RouteResult> => ({ kind: 'json', status, data: await p });
const accepted = async (p: Promise<Accepted>): Promise<RouteResult> => ({ kind: 'json', status: 202, data: await p });

// 请求体只在业务层校验；这里按契约类型转交
const as = <T>(body: Record<string, unknown>): T => body as unknown as T;

function id(ctx: RouteContext): string {
  const v = ctx.params.id;
  if (v === undefined || v === '') throw new SfeError('BAD_REQUEST', '请求失败：缺少编号');
  return v;
}

export function parseOperationsLimit(raw: string | null): number {
  if (raw === null || raw === '') return DEFAULT_OPERATIONS_LIMIT;
  if (!/^\d{1,4}$/.test(raw)) throw new SfeError('BAD_REQUEST', `读取操作记录失败：limit 必须是 1–${MAX_OPERATIONS_LIMIT} 的整数`);
  const n = Number(raw);
  if (n < 1 || n > MAX_OPERATIONS_LIMIT) throw new SfeError('BAD_REQUEST', `读取操作记录失败：limit 必须是 1–${MAX_OPERATIONS_LIMIT} 的整数`);
  return n;
}

export const IMPORT_TEMPLATE_FILENAME = 'sfe-import-template.csv';

export const API_HANDLERS: Record<JsonRouteName, RouteHandler> = {
  session: async (ctx) => json(ctx.session.info()),
  logout: async (ctx) => {
    ctx.session.logout();
    return { kind: 'empty', status: 204 };
  },
  snapshot: (ctx) => json(ctx.app.snapshot(ctx.actor)),
  listEnvironments: (ctx) => json(ctx.app.listEnvironments(ctx.actor)),
  createEnvironment: (ctx) => accepted(ctx.app.createEnvironment(as<CreateEnvironmentRequest>(ctx.body), ctx.actor)),
  updateEnvironment: (ctx) => accepted(ctx.app.updateEnvironment(id(ctx), as<UpdateEnvironmentRequest>(ctx.body), ctx.actor)),
  deleteEnvironment: (ctx) => accepted(ctx.app.deleteEnvironment(id(ctx), as<DeleteEnvironmentRequest>(ctx.body), ctx.actor)),
  accountDetail: (ctx) => json(ctx.app.accountDetail(id(ctx), ctx.actor)),
  acknowledgeAccount: (ctx) => accepted(ctx.app.acknowledgeAccount(id(ctx), as<AcknowledgeAccountRequest>(ctx.body), ctx.actor)),
  activate: (ctx) => accepted(ctx.app.activate(id(ctx), as<ActivateRequest>(ctx.body), ctx.actor)),
  probe: (ctx) => accepted(ctx.app.probe(id(ctx), as<ProbeRequest>(ctx.body), ctx.actor)),
  unbind: (ctx) => accepted(ctx.app.unbind(id(ctx), as<UnbindRequest>(ctx.body), ctx.actor)),
  normal: (ctx) => accepted(ctx.app.enterNormal(as<NormalModeRequest>(ctx.body), ctx.actor)),
  publishPending: (ctx) => accepted(ctx.app.publishPending(as<PublishPendingRequest>(ctx.body), ctx.actor)),
  getOperation: (ctx) => json(ctx.app.getOperation(id(ctx), ctx.actor)),
  cancelOperation: (ctx) => accepted(ctx.app.cancelOperation(id(ctx), as<CancelOperationRequest>(ctx.body), ctx.actor)),
  acknowledgeWindows: (ctx) => accepted(ctx.app.acknowledgeWindows(as<AcknowledgeWindowsRequest>(ctx.body), ctx.actor)),
  listOperations: (ctx) => json(ctx.app.listOperations(parseOperationsLimit(ctx.query.get('limit')), ctx.actor)),
  importPreview: (ctx) => json(ctx.app.importPreview(as<ImportPreviewRequest>(ctx.body), ctx.actor)),
  importCommit: (ctx) => json(ctx.app.importCommit(as<ImportCommitRequest>(ctx.body), ctx.actor)),
  importTemplate: async (ctx) => ({
    kind: 'text',
    status: 200,
    contentType: 'text/csv; charset=utf-8',
    body: ctx.app.importTemplateCsv(),
    headers: { 'Content-Disposition': `attachment; filename="${IMPORT_TEMPLATE_FILENAME}"` },
  }),
  listCapabilities: (ctx) => json(ctx.app.listCapabilities()),
  confirmCapability: (ctx) => json(ctx.app.confirmCapability(as<ConfirmCapabilityRequest>(ctx.body), ctx.actor)),
  getSettings: (ctx) => json(ctx.app.getSettings()),
  updateSettings: (ctx) => json(ctx.app.updateSettings(as<UpdateSettingsRequest>(ctx.body), ctx.actor)),
  listFrontProxies: (ctx) => json(ctx.app.listFrontProxies()),
  registerFrontProxy: (ctx) => json(ctx.app.registerFrontProxy(as<RegisterFrontProxyRequest>(ctx.body), ctx.actor)),
  updateFrontProxy: (ctx) => json(ctx.app.updateFrontProxy(id(ctx), as<UpdateFrontProxyRequest>(ctx.body), ctx.actor)),
  verifyFrontProxy: (ctx) => accepted(ctx.app.verifyFrontProxy(id(ctx), as<VerifyFrontProxyRequest>(ctx.body), ctx.actor)),
  replaceFrontPreview: (ctx) => json(ctx.app.replaceFrontPreview(id(ctx), as<ReplaceFrontPreviewRequest>(ctx.body), ctx.actor)),
  replaceFrontCommit: (ctx) => accepted(ctx.app.replaceFrontCommit(id(ctx), as<ReplaceFrontCommitRequest>(ctx.body), ctx.actor)),
  surgeCandidates: (ctx) => json(ctx.app.surgePolicies()),
  refreshSurge: (ctx) => json(ctx.app.refreshSurge(ctx.actor)),
  initPreview: (ctx) => json(ctx.app.initPreview(as<InitPreviewRequest>(ctx.body), ctx.actor)),
  initCommit: (ctx) => accepted(ctx.app.initCommit(as<InitCommitRequest>(ctx.body), ctx.actor)),
  remergePreview: (ctx) => json(ctx.app.remergePreview(ctx.actor)),
  remergeCommit: (ctx) => accepted(ctx.app.remergeCommit(as<RemergeCommitRequest>(ctx.body), ctx.actor)),
};

// ---------- 路径匹配 ----------

type Segment = { literal: string } | { param: string };

interface CompiledRoute {
  name: ApiRouteName;
  method: HttpMethod;
  path: string;
  segments: Segment[];
}

const COMPILED: CompiledRoute[] = (Object.keys(API_ROUTES) as ApiRouteName[]).map((name) => {
  const def = API_ROUTES[name];
  const segments = def.path
    .split('/')
    .slice(1)
    .map((s): Segment => (s.startsWith(':') ? { param: s.slice(1) } : { literal: s }));
  return { name, method: def.method, path: def.path, segments };
});

export type RouteMatch =
  | { kind: 'match'; name: ApiRouteName; path: string; params: Record<string, string> }
  | { kind: 'method_not_allowed'; allow: HttpMethod[] }
  | { kind: 'bad_param' }
  | { kind: 'not_found' };

/** pathname 为百分号编码形式；字面段按编码形式精确比较，参数段解码后交给业务层。 */
export function matchApiRoute(method: string, pathname: string): RouteMatch {
  const parts = pathname.split('/').slice(1);
  const allow: HttpMethod[] = [];
  let badParam = false;
  for (const route of COMPILED) {
    if (route.segments.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < parts.length; i++) {
      const seg = route.segments[i]!;
      const part = parts[i]!;
      if ('literal' in seg) {
        if (seg.literal !== part) {
          ok = false;
          break;
        }
      } else {
        if (part === '') {
          ok = false;
          break;
        }
        let decoded: string;
        try {
          decoded = decodeURIComponent(part);
        } catch {
          badParam = true;
          ok = false;
          break;
        }
        if (decoded === '' || decoded.includes('\0')) {
          badParam = true;
          ok = false;
          break;
        }
        params[seg.param] = decoded;
      }
    }
    if (!ok) continue;
    if (route.method === method) return { kind: 'match', name: route.name, path: route.path, params };
    allow.push(route.method);
  }
  if (allow.length > 0) return { kind: 'method_not_allowed', allow };
  if (badParam) return { kind: 'bad_param' };
  return { kind: 'not_found' };
}
