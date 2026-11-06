// sfe 子命令（docs/ARCHITECTURE.md §7.3）。默认走 agent.sock（受限）；`sfe admin …` 与 `sfe open` 走
// maintenance.sock。携带秘密的内容只从标准输入读 JSON；request_id 由 CLI 生成。

import { resolve } from 'node:path';
import {
  adminOpAllowed,
  isSiteCode,
  type Accepted,
  type AccountDetail,
  type AdminOp,
  type AdminRequestEnvelope,
  type AdminRole,
  type ApiErrorBody,
  type CapabilityView,
  type EnvironmentView,
  type FrontProxyView,
  type ImportCommitResult,
  type ImportFormat,
  type ImportPreview,
  type ImportPreviewRequest,
  SfeError,
  type LoginCodeResponse,
  type NeedsConfirmationDetails,
  type OperationView,
  type SettingsView,
  type Snapshot,
} from '@sfe/contract';
import {
  EXIT,
  UsageError,
  assertFlags,
  flag,
  multi,
  parsePositiveInt,
  single,
  socketPath,
  type ExitCode,
  type Flag,
  type ParsedArgs,
} from './args.js';
import {
  clean,
  formatAccepted,
  formatAccount,
  formatCapabilities,
  formatEnvironment,
  formatEnvironmentList,
  formatError,
  formatFrontProxies,
  formatFrontProxy,
  formatImportCommit,
  formatImportPreview,
  formatNeedsConfirmation,
  formatOperation,
  formatOperationProgress,
  formatSettings,
  formatStatus,
} from './format.js';
import { decodeUtf8Text } from '../importer/csv.js';
import { parseJsonText } from '../importer/json.js';
import { buildImportDecisions, describeUnresolved, parseResolves } from './import-decisions.js';
import { OPEN_BINARY, OpenError, WEBLOC_DELETE_AFTER_MS, assertPrivateDataDir, cleanupStaleWeblocs, safeUnlink, writeWebloc } from './open.js';

export const MAX_IMPORT_FILE_BYTES = 8 * 1024 * 1024;
export const OP_POLL_INTERVAL_MS = 1000;
export const OP_WAIT_DEFAULT_SEC = 600;
const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const FORBIDDEN_ON_CHANNEL = '该命令不允许在此通道使用';

export interface CliDeps {
  argv: string[];
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  homedir: string;
  cwd: string;
  uid: number | undefined;
  stdout(text: string): void;
  stderr(text: string): void;
  /** 读完整个标准输入；是终端时应抛 UsageError。 */
  readStdin(): Promise<string>;
  readFile(path: string): Promise<Buffer>;
  /** 向套接字发一条 NDJSON 请求并返回解析后的应答。 */
  request(socketPath: string, envelope: AdminRequestEnvelope): Promise<unknown>;
  /** 执行固定路径的程序（不经 shell）。 */
  exec(file: string, args: string[]): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
  newRequestId(): string;
  randomHex(bytes: number): string;
}

/** 服务返回的错误（或本地按通道权限拒绝）。 */
export class CliApiError extends Error {
  constructor(readonly body: ApiErrorBody) {
    super(body.message);
    this.name = 'CliApiError';
  }
}

export class CliConnectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliConnectError';
  }
}

export interface Ctx {
  deps: CliDeps;
  args: ParsedArgs;
  json: boolean;
  dataDir: string;
  role: AdminRole;
  /** 重新执行提示用的命令前缀，例如 ['sfe'] 或 ['sfe', 'admin']。 */
  prefix: string[];
}

function describeConnectError(err: unknown, path: string): string {
  const e = err as { kind?: string; errno?: string | null; code?: string };
  const errno = e.errno ?? e.code ?? null;
  if (e.kind === 'timeout') return '连接本机服务失败：等待应答超时';
  if (errno === 'ENOENT' || errno === 'ECONNREFUSED') return `连接本机服务失败：服务未运行（找不到 ${path}）`;
  if (errno === 'EACCES' || errno === 'EPERM') return `连接本机服务失败：没有权限访问 ${path}`;
  return '连接本机服务失败：通信中断';
}

function parseResponse(raw: unknown): { ok: true; data: unknown } | { ok: false; error: ApiErrorBody } {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const r = raw as Record<string, unknown>;
    if (r.ok === true && 'data' in r) return { ok: true, data: r.data };
    const err = r.error as Record<string, unknown> | undefined;
    if (r.ok === false && err && typeof err.code === 'string' && typeof err.message === 'string') return { ok: false, error: err as unknown as ApiErrorBody };
  }
  return { ok: false, error: { code: 'INTERNAL', message: '读取应答失败：本机服务返回的内容格式不正确' } };
}

export async function call<T>(ctx: Ctx, op: AdminOp, args: Record<string, unknown> = {}): Promise<T> {
  if (!adminOpAllowed(op, ctx.role)) {
    throw new CliApiError({
      code: 'BAD_REQUEST',
      message: ctx.role === 'agent' ? `${FORBIDDEN_ON_CHANNEL}：需要维护通道，请改用 sfe admin …` : FORBIDDEN_ON_CHANNEL,
    });
  }
  const path = socketPath(ctx.dataDir, ctx.role);
  let raw: unknown;
  try {
    raw = await ctx.deps.request(path, { v: 1, op, args });
  } catch (err) {
    throw new CliConnectError(describeConnectError(err, path));
  }
  const res = parseResponse(raw);
  if (!res.ok) throw new CliApiError(res.error);
  return res.data as T;
}

function print(ctx: Ctx, value: unknown, human: () => string): void {
  ctx.deps.stdout(ctx.json ? `${JSON.stringify(value, null, 2)}\n` : human());
}

async function stdinJson(ctx: Ctx): Promise<Record<string, unknown>> {
  const text = await ctx.deps.readStdin();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // 不回显解析错误：V8 的错误信息会夹带输入片段（可能是密码）
    throw new UsageError('标准输入不是有效的 JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new UsageError('标准输入必须是 JSON 对象');
  return parsed as Record<string, unknown>;
}

function requireId(value: string | undefined, label: string, usage: string): string {
  if (value === undefined) throw new UsageError(`用法：${usage}`);
  if (!ID_RE.test(value)) throw new UsageError(`${label}格式不正确`);
  return value;
}

function oldWindowsPolicy(ctx: Ctx): 'closed_confirmed' | 'keep_open_acknowledged' | undefined {
  const v = single(ctx.args, 'old-windows');
  if (v === undefined) return undefined;
  if (v === 'closed') return 'closed_confirmed';
  if (v === 'keep') return 'keep_open_acknowledged';
  throw new UsageError('--old-windows 只能是 closed 或 keep');
}

function confirmedEnv(ctx: Ctx): { set: false } | { set: true; value: string | null } {
  const v = single(ctx.args, 'confirmed-env');
  if (v === undefined) return { set: false };
  if (v === 'none') return { set: true, value: null };
  if (!ID_RE.test(v)) throw new UsageError('--confirmed-env 必须是环境编号或 none');
  return { set: true, value: v };
}

/** 激活与普通模式共用：NEEDS_CONFIRMATION 时打印说明与可原样重跑的命令，退出码 3。 */
async function routeCommand(ctx: Ctx, op: 'activate' | 'normal', args: Record<string, unknown>, rerunBase: string[]): Promise<ExitCode> {
  try {
    const acc = await call<Accepted>(ctx, op, args);
    print(ctx, acc, () => formatAccepted(acc));
    return EXIT.OK;
  } catch (err) {
    if (err instanceof CliApiError && err.body.code === 'NEEDS_CONFIRMATION') {
      if (ctx.json) ctx.deps.stdout(`${JSON.stringify({ error: err.body }, null, 2)}\n`);
      else ctx.deps.stdout(formatNeedsConfirmation(err.body.details as Partial<NeedsConfirmationDetails> | undefined, rerunBase));
      return EXIT.NEEDS_CONFIRMATION;
    }
    throw err;
  }
}

// ---------- 各命令 ----------

type Handler = (ctx: Ctx, pos: string[]) => Promise<ExitCode>;

export interface CommandDef {
  path: string[];
  flags: Flag[];
  usage: string;
  summary: string;
  /** 只在 `sfe admin …` 下可用。 */
  adminOnly?: boolean;
  /** 总是走维护套接字。 */
  maintenance?: boolean;
  /** 位置参数个数（不含命令词）。 */
  positionals: number;
  run: Handler;
}

const status: Handler = async (ctx) => {
  const snap = await call<Snapshot>(ctx, 'status');
  print(ctx, snap, () => formatStatus(snap));
  return EXIT.OK;
};

const LOGIN_URL_RE = /^http:\/\/(127\.0\.0\.1|localhost):\d{1,5}\/auth\/exchange\?code=[A-Za-z0-9_-]+$/;

const open: Handler = async (ctx) => {
  const { deps } = ctx;
  assertPrivateDataDir(ctx.dataDir, deps.uid);
  cleanupStaleWeblocs(ctx.dataDir, deps.now());
  const res = await call<LoginCodeResponse>(ctx, 'issueLoginCode');
  if (!res || typeof res.url !== 'string' || !LOGIN_URL_RE.test(res.url)) throw new OpenError('打开管理后台失败：服务返回的登录地址不正确');
  const path = writeWebloc(ctx.dataDir, deps.randomHex(16), res.url);
  if (deps.platform !== 'darwin') {
    print(ctx, { opened: false, file: path, expiresAt: res.expiresAt }, () => `登录链接已写入 ${path}（权限 0600）：60 秒内有效，只能使用一次。请用浏览器打开其中的地址，用后删除该文件。\n`);
    return EXIT.OK;
  }
  try {
    await deps.exec(OPEN_BINARY, [path]);
  } catch {
    safeUnlink(path);
    throw new OpenError('打开管理后台失败：无法调用 /usr/bin/open');
  }
  print(ctx, { opened: true, expiresAt: res.expiresAt }, () => '已在浏览器中打开管理后台。登录链接 60 秒内有效，只能使用一次。\n');
  // 浏览器读取文件需要片刻；之后删除，不留含登录码的文件
  await deps.sleep(WEBLOC_DELETE_AFTER_MS);
  safeUnlink(path);
  return EXIT.OK;
};

const envList: Handler = async (ctx) => {
  const envs = await call<EnvironmentView[]>(ctx, 'listEnvironments');
  print(ctx, envs, () => formatEnvironmentList(envs));
  return EXIT.OK;
};

const envShow: Handler = async (ctx, pos) => {
  const id = requireId(pos[0], '环境编号', 'sfe env show <环境编号>');
  const env = await call<EnvironmentView>(ctx, 'getEnvironment', { id });
  print(ctx, env, () => formatEnvironment(env));
  return EXIT.OK;
};

const envCreate: Handler = async (ctx) => {
  const environment = await stdinJson(ctx);
  const acc = await call<Accepted>(ctx, 'createEnvironment', { request_id: ctx.deps.newRequestId(), environment });
  print(ctx, acc, () => formatAccepted(acc));
  return EXIT.OK;
};

const envUpdate: Handler = async (ctx, pos) => {
  const id = requireId(pos[0], '环境编号', 'sfe env update <环境编号> < changes.json');
  const input = await stdinJson(ctx);
  const rev = input.expected_revision;
  if (typeof rev !== 'number' || !Number.isInteger(rev) || rev < 1) throw new UsageError('标准输入需要 expected_revision（当前数据版本，正整数）');
  if (!input.changes || typeof input.changes !== 'object' || Array.isArray(input.changes)) throw new UsageError('标准输入需要 changes 对象');
  const acc = await call<Accepted>(ctx, 'updateEnvironment', { id, request_id: ctx.deps.newRequestId(), expected_revision: rev, changes: input.changes });
  print(ctx, acc, () => formatAccepted(acc));
  return EXIT.OK;
};

const envDelete: Handler = async (ctx, pos) => {
  const id = requireId(pos[0], '环境编号', 'sfe env delete <环境编号> --revision <版本>');
  const raw = single(ctx.args, 'revision');
  if (raw === undefined) throw new UsageError('删除需要 --revision <当前数据版本>');
  const acc = await call<Accepted>(ctx, 'deleteEnvironment', { id, request_id: ctx.deps.newRequestId(), expected_revision: parsePositiveInt(raw, '--revision') });
  print(ctx, acc, () => formatAccepted(acc));
  return EXIT.OK;
};

const envOpen: Handler = async (ctx, pos) => {
  const id = requireId(pos[0], '环境编号', 'sfe env open <环境编号> [--old-windows closed|keep] [--confirmed-env <编号|none>] [--revision N]');
  const args: Record<string, unknown> = { id, request_id: ctx.deps.newRequestId() };
  const policy = oldWindowsPolicy(ctx);
  if (policy) args.old_session_policy = policy;
  const confirmed = confirmedEnv(ctx);
  if (confirmed.set) args.confirmed_environment_id = confirmed.value;
  const rawRev = single(ctx.args, 'revision');
  const rerun = [...ctx.prefix, 'env', 'open', id];
  if (rawRev !== undefined) {
    args.proxy_revision = parsePositiveInt(rawRev, '--revision');
    rerun.push('--revision', String(args.proxy_revision));
  }
  return routeCommand(ctx, 'activate', args, rerun);
};

const normal: Handler = async (ctx) => {
  const args: Record<string, unknown> = { request_id: ctx.deps.newRequestId() };
  const policy = oldWindowsPolicy(ctx);
  if (policy) args.old_session_policy = policy;
  const confirmed = confirmedEnv(ctx);
  if (confirmed.set) args.confirmed_environment_id = confirmed.value;
  return routeCommand(ctx, 'normal', args, [...ctx.prefix, 'normal']);
};

const probe: Handler = async (ctx, pos) => {
  const id = requireId(pos[0], '环境编号', 'sfe probe <环境编号> --kind preflight|safari');
  const kind = single(ctx.args, 'kind');
  if (kind !== 'preflight' && kind !== 'safari') throw new UsageError('--kind 必须是 preflight 或 safari');
  const acc = await call<Accepted>(ctx, 'probe', { id, request_id: ctx.deps.newRequestId(), kind });
  print(ctx, acc, () => formatAccepted(acc));
  return EXIT.OK;
};

const publish: Handler = async (ctx) => {
  const ids = multi(ctx.args, 'env');
  for (const id of ids) if (!ID_RE.test(id)) throw new UsageError('--env 必须是环境编号');
  const args: Record<string, unknown> = { request_id: ctx.deps.newRequestId() };
  if (ids.length) args.environment_ids = ids;
  const acc = await call<Accepted>(ctx, 'publishPending', args);
  print(ctx, acc, () => formatAccepted(acc));
  return EXIT.OK;
};

function inferFormat(file: string, explicit: string | undefined): ImportFormat {
  const f = explicit ?? (/\.csv$/i.test(file) ? 'csv' : /\.xlsx$/i.test(file) ? 'xlsx' : /\.json$/i.test(file) ? 'json' : undefined);
  if (f !== 'csv' && f !== 'xlsx' && f !== 'json') throw new UsageError('无法判断文件格式：请用 --format csv|xlsx|json 指定');
  return f;
}

const importCmd: Handler = async (ctx, pos) => {
  const file = pos[0];
  if (file === undefined) throw new UsageError('用法：sfe import <文件> [--format csv|xlsx|json] [--commit] [--resolve <行>:create|skip|update:<环境编号> …]');
  const format = inferFormat(file, single(ctx.args, 'format'));
  const commit = flag(ctx.args, 'commit');
  const resolves = parseResolves(multi(ctx.args, 'resolve'));
  if (resolves.size > 0 && !commit) throw new UsageError('--resolve 只能与 --commit 一起使用');
  const site = single(ctx.args, 'default-site');
  if (site !== undefined && !isSiteCode(site)) throw new UsageError('--default-site 只支持 US');
  const front = single(ctx.args, 'default-front');
  if (front !== undefined && !ID_RE.test(front)) throw new UsageError('--default-front 必须是前置代理编号');

  let content: Buffer;
  try {
    content = await ctx.deps.readFile(resolve(ctx.deps.cwd, file));
  } catch (err) {
    if (err instanceof UsageError) throw err;
    throw new UsageError('读取导入文件失败：文件不存在或无法读取');
  }
  if (content.length > MAX_IMPORT_FILE_BYTES) throw new UsageError('导入失败：文件超过 8 MB 上限');

  const request: ImportPreviewRequest = { format };
  if (front !== undefined) request.default_front_proxy_id = front;
  if (site !== undefined) request.default_site = site;
  if (format === 'json') {
    // 先用服务导入器的同一解析函数在本地检查（UTF-8 BOM、记录数组或 { "environments": [...] }），
    // 不合格时直接报错、不回显内容；文件本身与 CSV/XLSX 一样原样上传，由服务统一解析。
    try {
      parseJsonText(decodeUtf8Text(content, 'JSON'));
    } catch (err) {
      if (err instanceof SfeError) throw new UsageError(err.message);
      throw err;
    }
  }
  request.content_base64 = content.toString('base64');

  const preview = await call<ImportPreview>(ctx, 'importPreview', request as unknown as Record<string, unknown>);
  if (!commit) {
    print(ctx, preview, () => `${formatImportPreview(preview)}预览完成，未提交。确认无误后加 --commit 提交。\n`);
    return preview.fileErrors?.length ? EXIT.ERROR : EXIT.OK;
  }
  if (preview.fileErrors?.length) {
    print(ctx, preview, () => `${formatImportPreview(preview)}文件有错误，未提交。\n`);
    return EXIT.ERROR;
  }
  const plan = buildImportDecisions(preview, resolves);
  if (plan.unresolved.length) {
    print(ctx, { preview, unresolvedRows: plan.unresolved.map((r) => r.row) }, () => `${formatImportPreview(preview)}${describeUnresolved(plan.unresolved)}`);
    return EXIT.NEEDS_CONFIRMATION;
  }
  if (plan.decisions.length === 0) {
    print(ctx, { preview, committed: false }, () => `${formatImportPreview(preview)}没有需要提交的行。\n`);
    return EXIT.OK;
  }
  const result = await call<ImportCommitResult>(ctx, 'importCommit', {
    ...(request as unknown as Record<string, unknown>),
    request_id: ctx.deps.newRequestId(),
    preview_digest: preview.preview_digest,
    decisions: plan.decisions,
  });
  print(ctx, result, () => formatImportCommit(result));
  const failed = (result.items ?? []).some((i) => i.error !== undefined || i.status === 'revision_conflict');
  return failed ? EXIT.ERROR : EXIT.OK;
};

const ACTIVE_STATUSES = new Set(['queued', 'running']);

const opCmd: Handler = async (ctx, pos) => {
  const id = requireId(pos[0], '操作编号', 'sfe op <操作编号> [--wait]');
  let op = await call<OperationView>(ctx, 'getOperation', { id });
  if (flag(ctx.args, 'wait')) {
    const rawTimeout = single(ctx.args, 'timeout');
    const timeoutMs = (rawTimeout === undefined ? OP_WAIT_DEFAULT_SEC : parsePositiveInt(rawTimeout, '--timeout')) * 1000;
    const deadline = ctx.deps.now() + timeoutMs;
    let last = '';
    while (ACTIVE_STATUSES.has(op.status)) {
      const key = `${op.phase}/${op.status}`;
      if (!ctx.json && key !== last) ctx.deps.stdout(formatOperationProgress(op));
      last = key;
      if (ctx.deps.now() >= deadline) {
        ctx.deps.stderr(`等待操作超时：操作仍在进行，可稍后用 sfe op ${clean(id)} 查看。\n`);
        return EXIT.ERROR;
      }
      await ctx.deps.sleep(OP_POLL_INTERVAL_MS);
      op = await call<OperationView>(ctx, 'getOperation', { id });
    }
  } else if (single(ctx.args, 'timeout') !== undefined) {
    throw new UsageError('--timeout 只能与 --wait 一起使用');
  }
  print(ctx, op, () => formatOperation(op));
  return op.status === 'failed' || op.status === 'needs_attention' ? EXIT.ERROR : EXIT.OK;
};

const capabilityList: Handler = async (ctx) => {
  const list = await call<CapabilityView[]>(ctx, 'listCapabilities');
  print(ctx, list, () => formatCapabilities(list));
  return EXIT.OK;
};

const capabilityPropose: Handler = async (ctx) => {
  const input = await stdinJson(ctx);
  const res = await call<{ proposal_id: string }>(ctx, 'proposeCapability', { ...input, request_id: ctx.deps.newRequestId() });
  print(ctx, res, () => `已提交能力提议 ${clean(res.proposal_id)}：需要在网页后台确认后才生效。\n`);
  return EXIT.OK;
};

const frontList: Handler = async (ctx) => {
  const list = await call<FrontProxyView[]>(ctx, 'listFrontProxies');
  print(ctx, list, () => formatFrontProxies(list));
  return EXIT.OK;
};

const frontAdd: Handler = async (ctx, pos) => {
  const surgeName = pos[0];
  if (surgeName === undefined || surgeName.length === 0 || surgeName.length > 128) throw new UsageError('用法：sfe admin front add <Surge 节点名> [--default]');
  const f = await call<FrontProxyView>(ctx, 'registerFrontProxy', { request_id: ctx.deps.newRequestId(), surgeName, makeDefault: flag(ctx.args, 'default') });
  print(ctx, f, () => formatFrontProxy(f));
  return EXIT.OK;
};

const settingsGet: Handler = async (ctx) => {
  const s = await call<SettingsView>(ctx, 'getSettings');
  print(ctx, s, () => formatSettings(s));
  return EXIT.OK;
};

const settingsSet: Handler = async (ctx) => {
  const input = await stdinJson(ctx);
  const s = await call<SettingsView>(ctx, 'updateSettings', { ...input, request_id: ctx.deps.newRequestId() });
  print(ctx, s, () => `已保存设置。\n${formatSettings(s)}`);
  return EXIT.OK;
};

const account: Handler = async (ctx, pos) => {
  const id = requireId(pos[0], '环境编号', 'sfe admin account <环境编号>');
  const a = await call<AccountDetail>(ctx, 'accountDetail', { id });
  print(ctx, a, () => formatAccount(a));
  return EXIT.OK;
};

export const COMMANDS: CommandDef[] = [
  { path: ['status'], flags: [], positionals: 0, usage: 'sfe status', summary: '查看服务、路由与 Surge 状态', run: status },
  { path: ['open'], flags: [], positionals: 0, maintenance: true, usage: 'sfe open', summary: '在浏览器中打开管理后台（一次性登录链接）', run: open },
  { path: ['env', 'list'], flags: [], positionals: 0, usage: 'sfe env list', summary: '列出环境', run: envList },
  { path: ['env', 'show'], flags: [], positionals: 1, usage: 'sfe env show <环境编号>', summary: '查看环境详情', run: envShow },
  { path: ['env', 'create'], flags: [], positionals: 0, usage: 'sfe env create < environment.json', summary: '新建环境（标准输入 EnvironmentInput JSON）', run: envCreate },
  { path: ['env', 'update'], flags: [], positionals: 1, usage: 'sfe env update <环境编号> < changes.json', summary: '修改环境（标准输入 { expected_revision, changes }）', run: envUpdate },
  { path: ['env', 'delete'], flags: ['revision'], positionals: 1, usage: 'sfe admin env delete <环境编号> --revision <版本>', summary: '删除环境（维护通道）', run: envDelete },
  {
    path: ['env', 'open'],
    flags: ['old-windows', 'confirmed-env', 'revision'],
    positionals: 1,
    usage: 'sfe env open <环境编号> [--old-windows closed|keep] [--confirmed-env <编号|none>] [--revision N]',
    summary: '打开环境（受控切换）',
    run: envOpen,
  },
  { path: ['normal'], flags: ['old-windows', 'confirmed-env'], positionals: 0, usage: 'sfe normal [--old-windows closed|keep] [--confirmed-env <编号|none>]', summary: '进入普通模式', run: normal },
  { path: ['probe'], flags: ['kind'], positionals: 1, usage: 'sfe probe <环境编号> --kind preflight|safari', summary: '代理预检或 Safari 重测', run: probe },
  { path: ['publish'], flags: ['env'], positionals: 0, usage: 'sfe publish [--env <环境编号> …]', summary: '发布待部署的节点', run: publish },
  {
    path: ['import'],
    flags: ['format', 'default-front', 'default-site', 'commit', 'resolve'],
    positionals: 1,
    usage: 'sfe import <文件> [--format csv|xlsx|json] [--default-front <编号>] [--default-site US] [--commit] [--resolve <行>:create|skip|update:<环境编号> …]',
    summary: '预览并提交导入',
    run: importCmd,
  },
  { path: ['op'], flags: ['wait', 'timeout'], positionals: 1, usage: 'sfe op <操作编号> [--wait] [--timeout 秒]', summary: '查看操作进度', run: opCmd },
  { path: ['capability', 'list'], flags: [], positionals: 0, usage: 'sfe capability list', summary: '查看能力门槛', run: capabilityList },
  { path: ['capability', 'propose'], flags: [], positionals: 0, usage: 'sfe capability propose < proposal.json', summary: '提交能力提议（需在网页确认）', run: capabilityPropose },
  { path: ['front', 'list'], flags: [], positionals: 0, usage: 'sfe front list', summary: '列出前置代理', run: frontList },
  { path: ['front', 'add'], flags: ['default'], positionals: 1, adminOnly: true, usage: 'sfe admin front add <Surge 节点名> [--default]', summary: '登记前置代理', run: frontAdd },
  { path: ['settings', 'get'], flags: [], positionals: 0, adminOnly: true, usage: 'sfe admin settings get', summary: '查看设置', run: settingsGet },
  { path: ['settings', 'set'], flags: [], positionals: 0, adminOnly: true, usage: 'sfe admin settings set < settings.json', summary: '修改设置', run: settingsSet },
  { path: ['account'], flags: [], positionals: 1, adminOnly: true, usage: 'sfe admin account <环境编号>', summary: '查看登录账号（明文）', run: account },
];

export function findCommand(words: readonly string[]): { def: CommandDef; rest: string[] } | null {
  let best: CommandDef | null = null;
  for (const def of COMMANDS) {
    if (def.path.length > words.length) continue;
    if (def.path.every((w, i) => words[i] === w) && (!best || def.path.length > best.path.length)) best = def;
  }
  return best ? { def: best, rest: words.slice(best.path.length) } : null;
}

export function usageText(): string {
  const lines = ['用法：sfe <命令> [参数]', '', '命令：'];
  for (const c of COMMANDS) lines.push(`  ${c.usage}`, `      ${c.summary}`);
  lines.push(
    '',
    '通用参数：--json 输出原始 JSON；--data-dir <目录> 指定数据目录（也可用 SFE_DATA_DIR）。',
    '默认经 agent.sock（受限）；sfe admin <命令> 与 sfe open 经 maintenance.sock。',
    '含密码等秘密的内容只能写成 JSON 从标准输入传入，不能出现在命令行参数中。',
    '退出码：0 成功，1 失败，2 用法错误，3 需要确认。',
  );
  return lines.join('\n') + '\n';
}

export async function runCommand(ctx: Omit<Ctx, 'role' | 'prefix'>, words: string[]): Promise<ExitCode> {
  let admin = false;
  let rest = words;
  if (rest[0] === 'admin') {
    admin = true;
    rest = rest.slice(1);
  }
  const found = findCommand(rest);
  if (!found) throw new UsageError(rest.length ? `未知命令：${clean(rest.join(' ').slice(0, 60))}` : '缺少命令');
  const { def } = found;
  if (def.adminOnly && !admin) throw new UsageError(`该命令需要维护通道：${def.usage}`);
  assertFlags(ctx.args, def.flags, `sfe ${admin ? 'admin ' : ''}${def.path.join(' ')}`);
  if (found.rest.length !== def.positionals) throw new UsageError(`用法：${def.usage}`);
  const role: AdminRole = admin || def.maintenance ? 'maintenance' : 'agent';
  return def.run({ ...ctx, role, prefix: admin ? ['sfe', 'admin'] : ['sfe'] }, found.rest);
}

export function renderError(err: CliApiError, json: boolean): { stdout: string | null; stderr: string | null } {
  return json ? { stdout: `${JSON.stringify({ error: err.body }, null, 2)}\n`, stderr: null } : { stdout: null, stderr: formatError(err.body) };
}
