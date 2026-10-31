// 本机套接字 agent.sock / maintenance.sock（docs/ARCHITECTURE.md §2、§7.3；contract/admin.ts）。
// 两个都是 0600 套接字，所在目录必须是 0700。命令按 ADMIN_OPS 的角色表放行；actor 由套接字角色决定，
// 不来自请求。一个连接一条请求；从不记录参数（其中可能有代理或账号密码），只记命令名、结果与错误码。

import { createServer, type Server, type Socket } from 'node:net';
import { performance } from 'node:perf_hooks';
import {
  ADMIN_OPS,
  adminOpAllowed,
  SfeError,
  type AdminOp,
  type AdminRequestEnvelope,
  type AdminRole,
  type ApiErrorBody,
} from '@sfe/contract';
import type { Actor, AppService } from '../app.js';
import { errorBodyFor, errorKind, type TransportLogger } from '../http/errors.js';
import { dropConnection, readLine, writeLineAndClose } from './ndjson.js';
import { listenUnixSocket, removeSocketFile } from './unix-socket.js';

/** 导入命令携带文件内容（base64），与 HTTP 的 8 MB 请求体上限对齐并留出 JSON 开销。 */
export const ADMIN_MAX_MESSAGE_BYTES = 12 * 1024 * 1024;
export const ADMIN_READ_TIMEOUT_MS = 30_000;
export const ADMIN_FORBIDDEN_MESSAGE = '该命令不允许在此通道使用';
export const DEFAULT_LIST_OPERATIONS_LIMIT = 50;

export type AdminResponse<T = unknown> = { ok: true; data: T } | { ok: false; error: ApiErrorBody };

export interface AdminServerOptions {
  app: AppService;
  path: string;
  role: AdminRole;
  logger: TransportLogger;
  readTimeoutMs?: number;
  maxMessageBytes?: number;
}

export interface AdminServerHandle {
  listen(): Promise<void>;
  close(): Promise<void>;
}

export function actorForRole(role: AdminRole): Actor {
  return role === 'agent' ? { kind: 'agent' } : { kind: 'admin' };
}

type Args = Record<string, unknown>;

function requireId(args: Args): { id: string; rest: Args } {
  const { id, ...rest } = args;
  if (typeof id !== 'string' || id.length === 0 || id.length > 128) throw new SfeError('BAD_REQUEST', '命令失败：缺少编号或编号格式不正确');
  return { id, rest };
}

function listLimit(args: Args): number {
  const v = args.limit;
  if (v === undefined || v === null) return DEFAULT_LIST_OPERATIONS_LIMIT;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 500) throw new SfeError('BAD_REQUEST', '读取操作记录失败：limit 必须是 1–500 的整数');
  return v;
}

const as = <T>(v: Args): T => v as unknown as T;

/** 每个命令到 AppService 的映射；Record 类型保证 ADMIN_OPS 中的每个命令都有处理。 */
const DISPATCH: Record<AdminOp, (app: AppService, args: Args, actor: Actor) => Promise<unknown>> = {
  status: (app, _a, actor) => app.snapshot(actor),
  listEnvironments: (app, _a, actor) => app.listEnvironments(actor),
  getEnvironment: (app, a, actor) => app.getEnvironment(requireId(a).id, actor),
  createEnvironment: (app, a, actor) => app.createEnvironment(as(a), actor),
  updateEnvironment: (app, a, actor) => {
    const { id, rest } = requireId(a);
    return app.updateEnvironment(id, as(rest), actor);
  },
  deleteEnvironment: (app, a, actor) => {
    const { id, rest } = requireId(a);
    return app.deleteEnvironment(id, as(rest), actor);
  },
  unbind: (app, a, actor) => {
    const { id, rest } = requireId(a);
    return app.unbind(id, as(rest), actor);
  },
  acknowledgeAccount: (app, a, actor) => {
    const { id, rest } = requireId(a);
    return app.acknowledgeAccount(id, as(rest), actor);
  },
  importPreview: (app, a, actor) => app.importPreview(as(a), actor),
  importCommit: (app, a, actor) => app.importCommit(as(a), actor),
  importTemplate: async (app) => ({ csv: app.importTemplateCsv() }),
  getOperation: (app, a, actor) => app.getOperation(requireId(a).id, actor),
  listOperations: (app, a, actor) => app.listOperations(listLimit(a), actor),
  cancelOperation: (app, a, actor) => {
    const { id, rest } = requireId(a);
    return app.cancelOperation(id, as(rest), actor);
  },
  acknowledgeWindows: (app, a, actor) => app.acknowledgeWindows(as(a), actor),
  activate: (app, a, actor) => {
    const { id, rest } = requireId(a);
    return app.activate(id, as(rest), actor);
  },
  normal: (app, a, actor) => app.enterNormal(as(a), actor),
  probe: (app, a, actor) => {
    const { id, rest } = requireId(a);
    return app.probe(id, as(rest), actor);
  },
  publishPending: (app, a, actor) => app.publishPending(as(a), actor),
  listCapabilities: (app) => app.listCapabilities(),
  proposeCapability: (app, a, actor) => app.proposeCapability(as(a), actor),
  listFrontProxies: (app) => app.listFrontProxies(),
  surgePolicies: (app) => app.surgePolicies(),
  issueLoginCode: (app, _a, actor) => {
    // ADMIN_OPS 已限定维护角色；这里再按 actor 兜底，避免角色表被误改时登录码外泄
    if (actor.kind !== 'admin') throw new SfeError('BAD_REQUEST', ADMIN_FORBIDDEN_MESSAGE);
    return app.issueLoginCode(actor);
  },
  accountDetail: (app, a, actor) => app.accountDetail(requireId(a).id, actor),
  registerFrontProxy: (app, a, actor) => app.registerFrontProxy(as(a), actor),
  updateFrontProxy: (app, a, actor) => {
    const { id, rest } = requireId(a);
    return app.updateFrontProxy(id, as(rest), actor);
  },
  verifyFrontProxy: (app, a, actor) => {
    const { id, rest } = requireId(a);
    return app.verifyFrontProxy(id, as(rest), actor);
  },
  replaceFrontPreview: (app, a, actor) => {
    const { id, rest } = requireId(a);
    return app.replaceFrontPreview(id, as(rest), actor);
  },
  replaceFrontCommit: (app, a, actor) => {
    const { id, rest } = requireId(a);
    return app.replaceFrontCommit(id, as(rest), actor);
  },
  getSettings: (app) => app.getSettings(),
  updateSettings: (app, a, actor) => app.updateSettings(as(a), actor),
  refreshSurge: (app, _a, actor) => app.refreshSurge(actor),
};

export type AdminEnvelopeValidation = { ok: true; op: AdminOp; args: Args } | { ok: false; error: ApiErrorBody; op: string | null };

export function validateAdminEnvelope(raw: unknown, role: AdminRole): AdminEnvelopeValidation {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, op: null, error: { code: 'BAD_REQUEST', message: '命令失败：格式不正确' } };
  const env = raw as Partial<AdminRequestEnvelope> & Record<string, unknown>;
  if (env.v !== 1) return { ok: false, op: null, error: { code: 'BAD_REQUEST', message: '命令失败：协议版本不受支持' } };
  const op = env.op;
  if (typeof op !== 'string' || !/^[A-Za-z]{1,64}$/.test(op)) return { ok: false, op: null, error: { code: 'BAD_REQUEST', message: '命令失败：缺少命令名' } };
  // 先确认是自有属性：adminOpAllowed 对 toString、constructor 等原型属性名会抛出 TypeError
  if (!Object.hasOwn(ADMIN_OPS, op) || !adminOpAllowed(op, role)) return { ok: false, op, error: { code: 'BAD_REQUEST', message: ADMIN_FORBIDDEN_MESSAGE } };
  const args = env.args ?? {};
  if (!args || typeof args !== 'object' || Array.isArray(args)) return { ok: false, op, error: { code: 'BAD_REQUEST', message: '命令失败：参数必须是 JSON 对象' } };
  return { ok: true, op, args: args as Args };
}

async function execute(app: AppService, role: AdminRole, v: AdminEnvelopeValidation): Promise<{ response: AdminResponse; errorKind?: string }> {
  if (!v.ok) return { response: { ok: false, error: v.error } };
  try {
    const data = await DISPATCH[v.op](app, v.args, actorForRole(role));
    return { response: { ok: true, data: data === undefined ? null : data } };
  } catch (err) {
    return { response: { ok: false, error: errorBodyFor(err).body }, errorKind: errorKind(err) };
  }
}

/** 按角色执行一个命令（服务端与测试共用）。 */
export async function dispatchAdminRequest(app: AppService, role: AdminRole, raw: unknown): Promise<AdminResponse> {
  return (await execute(app, role, validateAdminEnvelope(raw, role))).response;
}

export function createAdminServer(opts: AdminServerOptions): AdminServerHandle {
  const maxBytes = opts.maxMessageBytes ?? ADMIN_MAX_MESSAGE_BYTES;
  const readTimeoutMs = opts.readTimeoutMs ?? ADMIN_READ_TIMEOUT_MS;
  let server: Server | null = null;
  const sockets = new Set<Socket>();

  async function handleConnection(socket: Socket): Promise<void> {
    const started = performance.now();
    const ms = (): number => Math.round(performance.now() - started);
    const r = await readLine(socket, { maxBytes, timeoutMs: readTimeoutMs, requireJsonObject: true });
    if (r.kind === 'bad_first_byte' || r.kind === 'timeout' || r.kind === 'closed') {
      dropConnection(socket);
      return;
    }
    if (r.kind !== 'line') {
      const message = r.kind === 'too_large' ? '命令失败：请求超过大小上限' : '命令失败：不是有效的 UTF-8';
      await writeLineAndClose(socket, { ok: false, error: { code: 'BAD_REQUEST', message } } satisfies AdminResponse);
      opts.logger.log('info', 'admin.request', { role: opts.role, result: r.kind, errorCode: 'BAD_REQUEST', durationMs: ms() });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(r.line);
    } catch {
      await writeLineAndClose(socket, { ok: false, error: { code: 'BAD_REQUEST', message: '命令失败：不是有效的 JSON' } } satisfies AdminResponse);
      opts.logger.log('info', 'admin.request', { role: opts.role, result: 'invalid_json', errorCode: 'BAD_REQUEST', durationMs: ms() });
      return;
    }
    const v = validateAdminEnvelope(parsed, opts.role);
    const { response, errorKind: kind } = await execute(opts.app, opts.role, v);
    await writeLineAndClose(socket, response);
    const fields: Record<string, unknown> = { role: opts.role, op: v.ok ? v.op : 'rejected', result: response.ok ? 'ok' : 'error', durationMs: ms() };
    if (!response.ok) fields.errorCode = response.error.code;
    if (kind !== undefined && kind !== fields.errorCode) fields.errorKind = kind;
    opts.logger.log(response.ok || response.error.code !== 'INTERNAL' ? 'info' : 'error', 'admin.request', fields);
  }

  return {
    async listen() {
      if (server) throw new SfeError('INTERNAL', '服务内部错误');
      const s = createServer({ allowHalfOpen: true, pauseOnConnect: true }, (socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        socket.on('error', () => undefined);
        void handleConnection(socket).catch(() => socket.destroy());
      });
      s.maxConnections = 32;
      server = s;
      try {
        await listenUnixSocket(s, opts.path, { requirePrivateParent: true });
      } catch (err) {
        server = null;
        throw err;
      }
    },
    async close() {
      const s = server;
      if (!s) return;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => s.close(() => resolve()));
      removeSocketFile(opts.path);
      server = null;
    },
  };
}
