// resource-server：在 127.0.0.1 启动测试资源服务（D10），保持运行（Ctrl+C 停止）。处理程序就是产品的 createResourceHost，
// 绑定方是产品的 tcpBinder；读取令牌由工具生成并只保存在运行目录的 0600 文件中（从不作为参数、从不打印）。提供哪一代内容与
// 故障场景由其他命令原子写入的状态文件决定；--scenario 只设启动时的场景（封闭集合）。
// --squat squat200|squat404：端口占用者（loopback-auth 第 4、5 步）。只在端口空闲时绑定 127.0.0.1，对任何请求答复伪造的列表
// 或 404；127.0.0.1 被占用时另试同端口的 0.0.0.0、[::]、[::1] 并计数收到的连接。另一系统用户运行时读不到本运行目录：只打印
// uid、绑定结果与收到的请求数。

import { randomBytes } from 'node:crypto';
import { DEFAULT_RESOURCE_PORT, SERVER_LOGS } from '../constants.js';
import { tcpBinder, type Logger, type LogLevel, type ResourceBinder } from '../deps.js';
import { refused, usage, type ExitCode } from '../errors.js';
import type { Output } from '../io.js';
import {
  SQUAT_MODES,
  ensureResourceToken,
  isResourceScenario,
  readResourceToken,
  readServerStatus,
  serverRunning,
  writeServerStatus,
  type ResourceLogEntry,
  type ResourceScenario,
  type SquatMode,
} from '../loopback-state.js';
import { logAction } from '../results.js';
import type { RunDir } from '../run-dir.js';
import { startResourceServer, startSquatServer, type PeerProbe, type SquatBindResult } from '../servers/resource.js';
import { loadState, saveState } from '../state.js';
import { openRun, type Ctx } from './common.js';

/** 产品宿主的日志：只有原因代码、代与字节数（从不含令牌、路径或内容）；警告与错误打印到终端。 */
function terminalLogger(out: Output): Logger {
  const logger: Logger = {
    log(level: LogLevel, msg: string, fields?: Record<string, unknown>) {
      if (level !== 'warn' && level !== 'error') return;
      const reason = typeof fields?.reason === 'string' ? `（${fields.reason}）` : '';
      out.line(`资源服务：${msg}${reason}`);
    },
    child: () => logger,
  };
  return logger;
}

export function resourcePortOf(ctx: Ctx, loopbackPort: number | null): number {
  const port = ctx.args.numbers.port ?? loopbackPort ?? DEFAULT_RESOURCE_PORT;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw usage('参数检查失败：--port 必须是 1–65535 的整数');
  return port;
}

export async function runResourceServer(ctx: Ctx, waitForStop: () => Promise<void>): Promise<ExitCode> {
  const squatFlag = ctx.args.strings.squat;
  const scenarioFlag = ctx.args.strings.scenario;
  if (squatFlag !== undefined && scenarioFlag !== undefined) throw usage('参数检查失败：--squat 与 --scenario 不能同时使用');
  if (squatFlag !== undefined) return runSquat(ctx, squatFlag as SquatMode, waitForStop);
  if (scenarioFlag !== undefined && !isResourceScenario(scenarioFlag)) throw usage('参数检查失败：--scenario 不是已知的场景');
  const scenario = (scenarioFlag ?? null) as ResourceScenario | null;

  const { out, now } = ctx.deps;
  const { dir, state } = openRun(ctx);
  const port = resourcePortOf(ctx, state.loopback?.port ?? null);
  if (state.loopback?.setupAt && state.loopback.port !== port) {
    throw refused(`前置条件不满足：测试配置中的测试资源地址使用端口 ${state.loopback.port}，资源服务必须在同一端口运行（或先 loopback --rollback）`);
  }
  const running = readServerStatus(dir);
  if (serverRunning(running) && running.pid !== process.pid) {
    throw refused(`前置条件不满足：本次运行已有资源服务在运行（进程 ${running.pid}，端口 ${running.port}）`);
  }
  const token = ensureResourceToken(dir, ctx.deps.random ?? (() => randomBytes(32)));
  const logger = terminalLogger(out);
  const binder: ResourceBinder = ctx.deps.resourceBinder?.(logger) ?? tcpBinder({ logger });
  const clock = { now, setTimeout: (fn: () => void, ms: number) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); } };
  let server;
  try {
    server = await startResourceServer({
      dir,
      port,
      token,
      binder,
      clock,
      logger,
      scenario,
      exec: ctx.deps.exec,
      ...(ctx.deps.resourcePeerProbe ? { peerProbe: ctx.deps.resourcePeerProbe as PeerProbe } : {}),
      onChange: (s) => out.line(`资源服务：${s.listening ? `监听 127.0.0.1:${s.port}` : '不监听'}，场景 ${s.scenario ?? '—'}，提供 ${s.serving ? `第 ${s.serving.generation} 代（${s.serving.state === 'committed' ? '已提交' : '候选'}）` : '无（令牌正确时 503）'}`),
    });
  } catch (e) {
    const reason = (e as { details?: { reason?: unknown } }).details?.reason;
    throw refused(reason === 'port_in_use' ? `启动资源服务失败：127.0.0.1:${port} 已被占用（从不改用其他端口；用 lsof -nP -iTCP:${port} -sTCP:LISTEN 查看占用者）` : '启动资源服务失败：无法监听本机端口');
  }
  // 端口记入运行状态（第一次启动时）：loopback --setup 用它生成测试配置中的地址
  const latest = loadState(dir, now());
  if (!latest.loopback) saveState(dir, { ...latest, loopback: { port, setupAt: null, loadedCanaryIndex: null } });
  logAction(dir, { at: now().toISOString(), command: 'resource-server', action: 'resource_server_started', detail: { port, scenario: scenario ?? 'ok' } });

  out.heading(`P0 测试资源服务已启动 · 运行 ${dir.id}`);
  out.table([
    ['项目', '值'],
    ['地址', `http://127.0.0.1:${port}/***（路径中的读取令牌只在运行目录的 0600 文件中）`],
    ['处理程序', '产品 createResourceHost（令牌、Host、请求头、方法与 503 的判断不经改动）'],
    ['启动场景', scenario ?? 'ok'],
  ]);
  out.line(`请求记录写入运行目录 ${SERVER_LOGS.resource}（不含令牌、路径或列表内容）。保持本终端运行；按 Ctrl+C 停止。`);

  await waitForStop();
  await server.close();
  logAction(dir, { at: now().toISOString(), command: 'resource-server', action: 'resource_server_stopped' });
  out.line('资源服务已停止。');
  return 0;
}

async function runSquat(ctx: Ctx, mode: SquatMode, waitForStop: () => Promise<void>): Promise<ExitCode> {
  const { out, now } = ctx.deps;
  if (!(SQUAT_MODES as readonly string[]).includes(mode)) throw usage('参数检查失败：--squat 只能是 squat200、squat404');
  // 另一系统用户读不到本次运行目录：只在终端报告（uid、绑定结果、收到的请求数）
  let dir: RunDir | null = null;
  let loopbackPort: number | null = null;
  try {
    const opened = openRun(ctx);
    dir = opened.dir;
    loopbackPort = opened.state.loopback?.port ?? null;
  } catch {
    dir = null;
  }
  const port = resourcePortOf(ctx, loopbackPort);
  let token: string | null = null;
  try {
    token = dir ? readResourceToken(dir) : null;
  } catch {
    token = null;
  }
  const logger = terminalLogger(out);
  const binder: ResourceBinder = ctx.deps.resourceBinder?.(logger) ?? tcpBinder({ logger });
  const clock = { now, setTimeout: (fn: () => void, ms: number) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); } };
  const uid = process.getuid?.() ?? -1;
  const log = dir ? (e: ResourceLogEntry) => dir!.appendJsonl(SERVER_LOGS.resource, e) : null;
  const squat = await startSquatServer({ port, mode, binder, clock, token, log, onRequest: (address) => out.line(`占用者收到一个连接：${address}:${port}`) });
  const startedAt = now().toISOString();
  const status = (stopped: boolean) => ({
    version: 1 as const,
    role: 'squat' as const,
    pid: process.pid,
    port,
    mode,
    startedAt,
    stoppedAt: stopped ? now().toISOString() : null,
    listening: squat.holdsLoopback && !stopped,
    appliedRevision: 0,
    scenario: null,
    serving: null,
    updatedAt: now().toISOString(),
  });
  if (dir) {
    writeServerStatus(dir, status(false));
    logAction(dir, { at: now().toISOString(), command: 'resource-server', action: 'squat_started', detail: { port, mode, uid, binds: squat.binds } });
  }
  out.heading(`端口占用者（${mode}）· uid ${uid}`);
  out.table([['地址', '绑定结果'], ...squat.binds.map((b) => [`${b.address.includes(':') ? `[${b.address}]` : b.address}:${port}`, BIND_TEXT[b.result]])]);
  if (!squat.holdsLoopback) out.line(`127.0.0.1:${port} 已被占用（预期：资源服务在运行）；其余地址中绑定成功的保持监听，收到的连接会在这里打印。`);
  else out.line(mode === 'squat200' ? '已占用端口：对任何请求答复伪造的节点列表（合成数据）。' : '已占用端口：对任何请求答复 404。');
  if (!dir) out.line('读不到本次运行目录（另一系统用户）：结束时把 uid、绑定结果与收到的连接数照抄到 loopback-auth 的提示中。');
  out.line('按 Ctrl+C 停止占用。');
  await waitForStop();
  await squat.close();
  if (dir) {
    writeServerStatus(dir, status(true));
    logAction(dir, { at: now().toISOString(), command: 'resource-server', action: 'squat_stopped', detail: { requests: squat.requests() } });
  }
  out.line(`占用者已停止：uid ${uid}，收到 ${squat.requests()} 个连接。`);
  return 0;
}

const BIND_TEXT: Record<SquatBindResult['result'], string> = {
  bound: '绑定成功',
  in_use: '失败：已被占用',
  unavailable: '失败：地址不可用',
  error: '失败：其他错误',
};
