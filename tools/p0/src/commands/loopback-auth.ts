// loopback-auth：回环资源服务认证与端口占用（loopback_resource_auth，D10）。全程经 resource-server 的产品处理程序（场景为 ok，
// 不经任何场景包装）：
// 1. 拒绝规则：工具自己向 127.0.0.1:<端口> 发出令牌错误或缺失、带浏览器请求头（Origin、Referer、Cookie、Sec-Fetch-*）、
//    Authorization、其他方法、带请求体、Host 不符、两个 Host、查询、结尾斜杠等请求，逐字节比较 404；令牌正确而没有加载内容
//    （restartUninitialized）时为 503。探测请求带 X-Sfe-P0-Probe 请求头（只用名称区分探测与 Surge 的下载）。
// 2. Surge 的下载：一次单 key 更新并读回；这一时段测试资源服务记下的每一次 Surge 下载都必须是产品处理程序答复的 200 并完整
//    写出；记录请求头名称与方法。发起连接的进程要在连接打开时用 lsof 读（经共用执行器异步运行；一次 200 的下载只持续几毫秒）：
//    这一步单独再做一次更新，让产品处理程序接受请求之后暂不发送内容（hang），读完即恢复已提交版本——这是本命令中唯一经场景
//    包装的一步，令牌与请求校验仍由产品处理程序完成；上面的“每次下载都是 200”只看未经改动的处理程序。
//    之后用 lsof 实测资源服务进程的监听地址（只应是 127.0.0.1:<端口>；读不到时为不完整）。
// 3. 同一用户的绑定：127.0.0.1:<端口>（必须失败）与同端口的 0.0.0.0、[::]、[::1]；绑定成功的保持监听，期间的探测与 Surge
//    下载必须到达本服务、不到达它们。
// 4. 另一系统用户（操作员）：运行 resource-server --squat squat404，记录 uid、绑定结果与是否收到连接。照抄的 uid 必须与本工具的
//    uid 不同，运行目录中也不能出现这一步期间启动的占用者记录（同一用户的占用者能写运行目录）。
// 5. 服务停止时被占用（操作员停止服务并运行占用者）：squat200（伪造的列表）、squat404（错误）、squatHang（收下令牌后不答复，
//    Surge 等到请求超时）。每一种先等待定时刷新（不执行更新，从占用之前的状态核对），观察到 Surge 自己的下载之后先恢复已提交
//    版本、再次占用；然后显式更新，从更新之前的状态核对。按产品的下载核对（auditResource，serving=false）伪造列表必须判为
//    unexplained_fetch、错误与请求超时必须判为 unexplained_error；之后重新启动服务、一次更新读回回到已提交版本。
// 6. Surge 资源缓存的位置与凭据保存方式（操作员记录，检查项名称注明）。
// 读取令牌只在内存中拼进探测请求，从不打印或写入记录。

import { randomBytes } from 'node:crypto';
import { connect, createServer, type Server } from 'node:net';
import { CAPABILITY_CRITERIA } from '@sfe/contract';
import { ACTIONS_LOG, RESOURCE_UPDATE_WAIT } from '../constants.js';
import { DEFAULT_RESOURCE_AUDIT_TOLERANCE_MS, auditResource, type ResourceAuditVerdict, type ResourceSnapshot } from '../deps.js';
import { refused, type ExitCode } from '../errors.js';
import {
  SQUAT_MODES,
  auditMarkOf,
  peersBetween,
  readAuditRecords,
  readServerStatus,
  requestsBetween,
  serverRunning,
  type ResourceRequestLogEntry,
  type SquatMode,
} from '../loopback-state.js';
import { redactSummary } from '../redact.js';
import { check, writeResult, type ActionEntry, type CheckItem } from '../results.js';
import type { ExecFn } from '../system.js';
import { confirmWrites, measureContext, printResult, printSnapshot, takeSnapshot, type Ctx } from './common.js';
import { errorClass, openLoopback, readbackText } from './loopback-ops.js';

/** 探测请求的标记头（名称出现在请求记录中；值不记录）。 */
export const PROBE_HEADER = 'X-Sfe-P0-Probe';

export interface RawProbe {
  id: string;
  /** 完整的请求字节（含令牌时只在内存中）。 */
  text: string;
  expect: 200 | 404 | 503;
}

/** 拒绝规则的探测请求（令牌只拼在内存中的请求文本里）。 */
export function rejectionProbes(port: number, token: string): RawProbe[] {
  const host = `127.0.0.1:${port}`;
  const path = `/${token}/sfe-nodes.list`;
  const wrong = `${token[0] === 'a' ? 'b' : 'a'}${token.slice(1)}`;
  const req = (p: string, opts: { method?: string; host?: string | null; extra?: string; body?: string } = {}): string => {
    const lines = [`${opts.method ?? 'GET'} ${p} HTTP/1.1`];
    if (opts.host !== null) lines.push(`Host: ${opts.host ?? host}`);
    lines.push(`${PROBE_HEADER}: 1`, 'Connection: close');
    if (opts.extra) lines.push(opts.extra);
    if (opts.body !== undefined) lines.push(`Content-Length: ${Buffer.byteLength(opts.body)}`);
    return `${lines.join('\r\n')}\r\n\r\n${opts.body ?? ''}`;
  };
  return [
    { id: 'valid', text: req(path), expect: 200 },
    { id: 'wrong_token', text: req(`/${wrong}/sfe-nodes.list`), expect: 404 },
    { id: 'missing_token', text: req('/sfe-nodes.list'), expect: 404 },
    { id: 'bad_token_format', text: req('/abc/sfe-nodes.list'), expect: 404 },
    { id: 'extra_segment', text: req(`/${token}/x/sfe-nodes.list`), expect: 404 },
    { id: 'other_basename', text: req(`/${token}/other.list`), expect: 404 },
    { id: 'query', text: req(`${path}?a=1`), expect: 404 },
    { id: 'trailing_slash', text: req(`${path}/`), expect: 404 },
    { id: 'percent_escape', text: req(`/${token}%2Fsfe-nodes.list`), expect: 404 },
    { id: 'origin', text: req(path, { extra: 'Origin: https://shop.example.test' }), expect: 404 },
    { id: 'referer', text: req(path, { extra: 'Referer: https://shop.example.test/' }), expect: 404 },
    { id: 'cookie', text: req(path, { extra: 'Cookie: a=b' }), expect: 404 },
    { id: 'sec_fetch', text: req(path, { extra: 'Sec-Fetch-Site: cross-site' }), expect: 404 },
    { id: 'authorization', text: req(path, { extra: 'Authorization: Basic cDA6cDA=' }), expect: 404 },
    { id: 'head', text: req(path, { method: 'HEAD' }), expect: 404 },
    { id: 'post_body', text: req(path, { method: 'POST', body: 'ab' }), expect: 404 },
    { id: 'put', text: req(path, { method: 'PUT' }), expect: 404 },
    { id: 'host_mismatch', text: req(path, { host: `localhost:${port}` }), expect: 404 },
    { id: 'two_hosts', text: req(path, { extra: `Host: ${host}` }), expect: 404 },
    { id: 'no_host', text: req(path, { host: null }), expect: 404 },
  ];
}

/** 原样发出请求，读到连接关闭（或时限）为止，返回全部响应字节。 */
export function rawHttp(port: number, text: string, timeoutMs = 3000): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const sock = connect(port, '127.0.0.1', () => sock.write(text));
    const done = (): void => resolve(Buffer.concat(chunks));
    sock.setTimeout(timeoutMs, () => sock.destroy());
    sock.on('data', (c: Buffer) => chunks.push(c));
    sock.on('error', () => undefined);
    sock.on('close', done);
  });
}

export function statusOf(bytes: Buffer): number | null {
  const m = /^HTTP\/1\.1 (\d{3}) /.exec(bytes.subarray(0, 32).toString('latin1'));
  return m ? Number(m[1]) : null;
}

interface AltBind {
  address: string;
  result: 'bound' | 'in_use' | 'unavailable' | 'error';
  connections: number;
}

function tryBind(address: string, port: number): Promise<{ result: AltBind['result']; server: Server | null; count: () => number }> {
  return new Promise((resolve) => {
    let n = 0;
    const server = createServer((s) => {
      n++;
      s.destroy();
    });
    server.once('error', (e: NodeJS.ErrnoException) =>
      resolve({ result: e.code === 'EADDRINUSE' ? 'in_use' : e.code === 'EADDRNOTAVAIL' || e.code === 'EAFNOSUPPORT' ? 'unavailable' : 'error', server: null, count: () => 0 }),
    );
    server.listen({ host: address, port }, () => resolve({ result: 'bound', server, count: () => n }));
  });
}

const BIND_TEXT: Record<AltBind['result'], string> = { bound: '绑定成功', in_use: '失败（已被占用）', unavailable: '失败（地址不可用）', error: '失败（其他错误）' };

function surgeRequests(entries: readonly ResourceRequestLogEntry[]): ResourceRequestLogEntry[] {
  return entries.filter((e) => !e.headers.includes(PROBE_HEADER.toLowerCase()) && !e.headers.some((h) => h.startsWith('x-sfe-p0-route-')));
}

/** 每种占用按产品的下载核对（serving=false）必须得到的结论。 */
export const SQUAT_EXPECTED_VERDICT: Readonly<Record<SquatMode, ResourceAuditVerdict>> = Object.freeze({
  squat200: 'unexplained_fetch',
  squat404: 'unexplained_error',
  squatHang: 'unexplained_error',
});

/** 一次占用下载的后果与核对结论（起点是占用者开始占用之前的状态）。 */
export interface SquatObservation {
  members: readonly string[] | null;
  error: string;
  updatedAtChanged: boolean;
  /** 这一次（定时刷新的等待或显式更新开始之后）这一种占用者收到的请求。 */
  squatRequests: number;
  /**
   * 结论不单独属于这一次的请求：显式更新开始之前（起点之后）这一种占用者已收到的请求（Surge 已自己下载过），以及起点之后
   * 其他种占用者收到的请求（例如操作员换占用者之前，上一种占用者答复了 Surge 的一次下载，Surge 的状态可能已因此改变）。
   */
  earlierRequests: number;
  tokenReceived: boolean;
  verdict: ResourceAuditVerdict;
  expected: ResourceAuditVerdict;
}

/** 服务停止时被占用的一种情况的记录。 */
export interface SquatPhase {
  mode: SquatMode;
  ran: boolean;
  /** 定时刷新（先于显式更新，从占用之前的状态核对）：没有等待为 null；result 只在观察到 Surge 自己的下载时有。 */
  scheduled: { minutes: number; observed: boolean; result: SquatObservation | null } | null;
  /** 观察到定时刷新之后、再次占用之前恢复已提交版本（读回一致才测显式更新）：没有需要为 null。 */
  between: { recovered: boolean } | null;
  explicit: SquatObservation | null;
}

/**
 * 一次观察是否符合：占用者没有收到请求、或显式更新之前 Surge 已自己下载过、或起点之后其他种占用者收到过请求（结论不单独属于
 * 这一次）时不算测过（null）；否则核对结论必须是这种占用预期的结论。
 */
function squatObservationOk(o: SquatObservation | null): boolean | null {
  if (o === null || o.squatRequests === 0 || o.earlierRequests > 0) return null;
  return o.verdict === o.expected;
}

/**
 * 占用检查的结论（纯函数）：显式更新与定时刷新分别看每一种占用的观察。任何一次观察的核对结论不是预期的结论即不通过；三种
 * 占用都观察到（且占用者收到了请求）才通过，否则不完整。定时刷新只“观察到下载”不够：核对必须发现它。
 */
export function squatChecks(phases: readonly SquatPhase[]): { explicit: boolean | null; scheduled: boolean | null } {
  const verdictOf = (pick: (p: SquatPhase) => SquatObservation | null): boolean | null => {
    if (phases.length === 0) return null;
    const results = SQUAT_MODES.map((mode) => {
      const p = phases.filter((x) => x.mode === mode).at(-1);
      return p ? squatObservationOk(pick(p)) : null;
    });
    return results.some((r) => r === false) ? false : results.every((r) => r === true) ? true : null;
  };
  return { explicit: verdictOf((p) => p.explicit), scheduled: verdictOf((p) => p.scheduled?.result ?? null) };
}

function squatObservationText(o: SquatObservation | null): string {
  if (o === null) return '未测';
  return `成员 ${o.members?.join('、') ?? '读不到'}，错误 ${o.error}，更新时间${o.updatedAtChanged ? '变了' : '没变'}，占用者收到 ${o.squatRequests} 个请求${o.tokenReceived ? '（带读取令牌）' : ''}${o.earlierRequests > 0 ? `（起点之后、这一次之前或其他种占用者已收到 ${o.earlierRequests} 个：不单独计入）` : ''}，核对 ${o.verdict}（预期 ${o.expected}）`;
}

/** 照抄的文字中的 uid（例如“uid 502”）；没有为 null。 */
export function parseUid(text: string): number | null {
  const m = /uid\D{0,3}(\d{1,10})/i.exec(text);
  return m ? Number(m[1]) : null;
}

/** `lsof -Fn` 输出中的名称（n 开头的行）。 */
export function parseLsofNames(text: string): string[] {
  return text
    .split('\n')
    .filter((l) => l.startsWith('n'))
    .map((l) => l.slice(1).trim())
    .filter((n) => n !== '');
}

/**
 * 资源服务进程在端口上的监听地址（lsof 实测，经共用执行器）：只应是 127.0.0.1:<端口>。读不到（不是 macOS、lsof 不可用或没有
 * 输出）为 null。
 */
export async function listenAddresses(exec: ExecFn, pid: number, port: number): Promise<string[] | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const r = await exec('/usr/sbin/lsof', ['-nP', '-a', '-p', String(pid), `-iTCP:${port}`, '-sTCP:LISTEN', '-Fn'], { timeoutMs: 3000 });
  if (r.code !== 0) return null;
  const names = parseLsofNames(r.stdout);
  return names.length > 0 ? names : null;
}

/** 占用前的审计起点：与产品启动时一样，从当时的快照初始化（verdict initialized，从不报警）。 */
function initAudit(snapshot: ResourceSnapshot, dirRecords: ReturnType<typeof readAuditRecords>, mark: number) {
  return auditResource({ snapshot, state: null, records: dirRecords, toleranceMs: DEFAULT_RESOURCE_AUDIT_TOLERANCE_MS, serving: false, servedFailures: 0, mark }).nextState;
}

export async function runLoopbackAuth(ctx: Ctx): Promise<ExitCode> {
  const { out, now, prompt, sleep, home, exec } = ctx.deps;
  const { dir, session, ops, lb } = await openLoopback(ctx, { requireSetup: true });
  await lb.ensureKey();
  const snap = await takeSnapshot(ctx, session, dir, 'loopback-auth-before');
  printSnapshot(out, snap);
  const ok = await confirmWrites(
    ctx,
    '回环资源服务认证与端口占用测试',
    [
      `向 127.0.0.1:${lb.port} 发出约 20 个拒绝规则探测请求（经产品处理程序，不改动它）；短暂切到“未加载内容”测 503`,
      '对测试资源执行单 key 更新并读回（记录 Surge 下载的请求头名称）；再执行一次更新时让下载停住（hang），用 lsof 记录发起连接的进程，然后一次更新并读回恢复',
      `尝试再绑定 127.0.0.1、0.0.0.0、[::]、[::1] 的 ${lb.port} 端口（绑定成功的随即关闭）`,
      '可选：另一系统用户的占用；服务停止时的占用（需要你停止 resource-server 并运行占用者）；Surge 资源缓存位置（你来记录）',
      '最后重新提供已提交版本，一次单 key 更新并读回',
    ],
    ['停止所有占用进程，重新启动 resource-server（同一运行）；工具结束时一次单 key 更新并读回已提交版本', '本命令不改写测试配置，不添加临时规则，不重载配置'],
  );
  if (!ok) throw refused('已取消：没有写入任何东西');
  const t0 = now().getTime();
  await lb.setServed(() => ({ scenario: 'ok', candidate: null, probePeers: false }));

  // 1. 拒绝规则
  const probes = rejectionProbes(lb.port, lb.token);
  const results: Array<{ id: string; expect: number; status: number | null; bytes: Buffer }> = [];
  for (const p of probes) {
    const bytes = await rawHttp(lb.port, p.text);
    results.push({ id: p.id, expect: p.expect, status: statusOf(bytes), bytes });
  }
  const rejections = results.filter((r) => r.expect === 404);
  const reference = rejections[0]?.bytes ?? Buffer.alloc(0);
  const uniform404 = rejections.every((r) => r.status === 404 && r.bytes.equals(reference));
  const validOk = results.find((r) => r.id === 'valid')?.status === 200;
  await lb.setScenario('restartUninitialized');
  const unavailable = statusOf(await rawHttp(lb.port, probes[0]!.text));
  await lb.setScenario('ok');
  const badProbes = results.filter((r) => r.status !== r.expect || (r.expect === 404 && !r.bytes.equals(reference))).map((r) => r.id);

  // 1b. 监听地址：lsof 实测资源服务进程（第 3 步的同端口绑定之前）
  const serverPid = readServerStatus(dir)?.pid ?? -1;
  const listen = await listenAddresses(exec, serverPid, lb.port);
  const listenOnlyLoopback = listen === null ? null : listen.every((n) => n === `127.0.0.1:${lb.port}`);

  // 2. Surge 的下载（产品处理程序原样答复）
  const tS = now().getTime();
  const surgeRun = await lb.confirmCommitted('auth-surge-download');
  const fromSurge = surgeRequests(requestsBetween(dir, tS - 1000, now().getTime() + 1000, 'server'));
  const records = readAuditRecords(dir);
  const allProduct200 = fromSurge.length > 0 && fromSurge.every((e) => e.handler === 'product' && e.status === 200 && e.seq !== null && records.some((r) => r.seq === e.seq && r.complete));
  const headerNames = [...new Set(fromSurge.flatMap((e) => e.headers))];
  const methods = [...new Set(fromSurge.map((e) => e.method))];

  // 2b. 发起连接的进程：hang 让连接保持打开，lsof 在这期间读对端；读完恢复已提交版本
  const tP = now().getTime();
  await lb.setServed(() => ({ scenario: 'hang', probePeers: true }));
  await lb.update('auth-peer-probe');
  await lb.waitNotUpdating();
  let peerEntries = peersBetween(dir, tP - 1000, now().getTime() + 1000);
  for (let i = 0; i < 20 && peerEntries.length === 0; i++) {
    await sleep(250);
    peerEntries = peersBetween(dir, tP - 1000, now().getTime() + 1000);
  }
  await lb.setServed(() => ({ scenario: 'ok', probePeers: false }));
  const peerRecovery = await lb.confirmCommitted('auth-peer-recover');
  const peers = peerEntries.flatMap((e) => e.peers ?? []);
  const peerKnown = peerEntries.some((e) => e.peers !== null);
  const peerIsSurge = peers.some((p) => /\/Surge\.app\//.test(p.path ?? '') || /surge/i.test(p.command));

  // 3. 同一用户的绑定
  const binds: AltBind[] = [];
  const altRouting: Array<{ address: string; probeReachedUs: boolean; surgeReachedUs: boolean; altConnections: number }> = [];
  for (const address of ['127.0.0.1', '0.0.0.0', '::', '::1']) {
    const b = await tryBind(address, lb.port);
    binds.push({ address, result: b.result, connections: 0 });
    if (b.server === null) continue;
    // 绑定成功：发往 127.0.0.1 的探测与 Surge 的下载必须仍到达本服务
    const marker = `x-sfe-p0-route-${randomBytes(4).toString('hex')}`;
    const tB = now().getTime();
    await rawHttp(lb.port, `GET /sfe-nodes.list HTTP/1.1\r\nHost: 127.0.0.1:${lb.port}\r\n${marker}: 1\r\nConnection: close\r\n\r\n`);
    const probeReachedUs = requestsBetween(dir, tB - 1000, now().getTime() + 1000, 'server').some((e) => e.headers.includes(marker));
    const tU = now().getTime();
    await lb.confirmCommitted(`auth-bind-${address}`);
    const surgeReachedUs = surgeRequests(requestsBetween(dir, tU - 1000, now().getTime() + 1000, 'server')).length > 0;
    const altConnections = b.count();
    binds[binds.length - 1]!.connections = altConnections;
    altRouting.push({ address, probeReachedUs, surgeReachedUs, altConnections });
    await new Promise<void>((r) => b.server!.close(() => r()));
  }
  const loopbackRebind = binds.find((b) => b.address === '127.0.0.1')!;
  const altOk = altRouting.every((a) => a.probeReachedUs && a.surgeReachedUs && a.altConnections === 0);

  // 4. 另一系统用户（操作员）
  out.heading('另一系统用户的占用（手动）');
  out.line(`以另一个 macOS 用户登录（或在该用户的终端中），运行：npx tsx tools/p0/src/cli.ts resource-server --squat squat404 --port ${lb.port}`);
  out.line('它会打印 uid 与每个地址的绑定结果；保持它运行，回到这里继续（工具会发一次探测并执行一次单 key 更新）。');
  let otherUser: { bindFailed: boolean | null; received: boolean | null; note: string; reachedUs: boolean; uid: number | null; ownUid: number | null; sameUserSquatter: boolean } | null = null;
  const tStep4 = now().getTime();
  if ((await prompt.ask('另一系统用户的占用程序已在运行吗？输入 yes 继续，直接回车跳过：')) === 'yes') {
    const tO = now().getTime();
    await rawHttp(lb.port, `GET /sfe-nodes.list HTTP/1.1\r\nHost: 127.0.0.1:${lb.port}\r\n${PROBE_HEADER}: 1\r\nConnection: close\r\n\r\n`);
    await lb.confirmCommitted('auth-other-user');
    const reachedUs = surgeRequests(requestsBetween(dir, tO - 1000, now().getTime() + 1000, 'server')).length > 0;
    const yn = (a: string | null): boolean | null => (a === 'y' || a === 'yes' ? true : a === 'n' || a === 'no' ? false : null);
    const note = redactSummary(((await prompt.ask('照抄占用程序打印的 uid 与各地址的绑定结果（不要输入账号或密码）：')) ?? '').slice(0, 300), { home });
    const bindFailed = yn(await prompt.ask(`占用程序绑定 127.0.0.1:${lb.port} 是否失败？（y/n）`));
    const received = yn(await prompt.ask('占用程序是否收到了任何连接？（y/n）'));
    // 同一用户运行的占用者能写本运行目录（另一系统用户不能）：这一步期间出现的占用者记录说明它不是另一系统用户
    const sameUserSquatter =
      dir.readJsonl<ActionEntry>(ACTIONS_LOG).some((a) => a?.action === 'squat_started' && Date.parse(a.at) >= tStep4) ||
      Date.parse(readServerStatus(dir, 'squat')?.startedAt ?? '') >= tStep4;
    otherUser = { bindFailed, received, note, reachedUs, uid: parseUid(note), ownUid: process.getuid?.() ?? null, sameUserSquatter };
  }

  // 5. 服务停止时被占用（操作员停止服务并运行占用者）
  const phases: SquatPhase[] = [];
  let recovered: boolean | null = null;
  /** 占用者（这一种）正在占用 127.0.0.1:<端口>，资源服务已停止。 */
  const squatHolding = (mode: SquatMode): boolean => {
    const server = readServerStatus(dir);
    const squat = readServerStatus(dir, 'squat');
    return !serverRunning(server) && serverRunning(squat) && squat.mode === mode && squat.listening;
  };
  /** 一次占用下载之后等 Surge 写下结果（错误或更新时间变化，且不在更新中；squatHang 要等到 Surge 超时）。 */
  const settle = async (before: ResourceSnapshot): Promise<ResourceSnapshot> => {
    const changed = (x: ResourceSnapshot): boolean => x.updating !== true && (x.error !== before.error || (x.updatedAt?.getTime() ?? null) !== (before.updatedAt?.getTime() ?? null));
    const w = await ops.poll(() => lb.snapshot(), changed, RESOURCE_UPDATE_WAIT.timeoutMs * 2, RESOURCE_UPDATE_WAIT.pollMs);
    return w.value ?? (await lb.snapshot());
  };
  /** 起点：占用者开始占用之前的状态与审计序号（与产品启动时一样从快照初始化核对状态）。 */
  type Base = { before: ResourceSnapshot; mark: number; at: number };
  const baseNow = async (): Promise<Base> => ({ before: await lb.snapshot(), mark: auditMarkOf(dir), at: now().getTime() });
  /** 占用者收到的请求，按占用者的种类（日志的 scenario）分开：本种与其他种（例如还没停止的上一种占用者）。 */
  const squatRequestsOf = (mode: SquatMode, from: number, to: number) => {
    const all = requestsBetween(dir, from, to, 'squat');
    return { own: all.filter((e) => e.scenario === mode), other: all.filter((e) => e.scenario !== mode) };
  };
  /** 一次占用下载的后果，按产品的下载核对从起点判断；since：这一次（等待或更新）开始的时间。 */
  const observe = (mode: SquatMode, base: Base, since: number, after: ResourceSnapshot): SquatObservation => {
    const state0 = initAudit(base.before, readAuditRecords(dir), base.mark);
    const squatted = squatRequestsOf(mode, since - 1000, now().getTime() + 1000).own;
    // 起点之后其他种占用者收到的请求（上一种占用者答复了 Surge 的下载）：Surge 的状态可能已因它改变，这次结论不单独成立
    const foreign = squatRequestsOf(mode, base.at, now().getTime() + 1000).other.length;
    return {
      members: after.members,
      error: errorClass(after.error),
      updatedAtChanged: (after.updatedAt?.getTime() ?? null) !== (base.before.updatedAt?.getTime() ?? null),
      squatRequests: squatted.length,
      earlierRequests: (since > base.at ? squatRequestsOf(mode, base.at, since - 1).own.length : 0) + foreign,
      tokenReceived: squatted.some((e) => e.tokenOk),
      verdict: auditResource({ snapshot: after, state: state0, records: readAuditRecords(dir), toleranceMs: DEFAULT_RESOURCE_AUDIT_TOLERANCE_MS, serving: false, servedFailures: 0, mark: base.mark }).verdict,
      expected: SQUAT_EXPECTED_VERDICT[mode],
    };
  };
  if ((await prompt.ask('现在测试“服务停止时端口被占用”吗？需要你停止 resource-server 并运行占用者。输入 yes 继续，直接回车跳过：')) === 'yes') {
    for (const mode of SQUAT_MODES) {
      const phase: SquatPhase = { mode, ran: false, scheduled: null, between: null, explicit: null };
      phases.push(phase);
      // 起点在占用者开始之前读：占用者一开始，Surge 随时可能自己下载（每种占用单独核对，上一种留下的变化属于起点）
      let base = await baseNow();
      await prompt.pause(`在 resource-server 终端按 Ctrl+C 停止服务（或停止上一个占用者），然后在同一终端运行 resource-server --squat ${mode}（同一运行编号）`);
      if (!squatHolding(mode)) {
        out.warn(`没有看到资源服务已停止、占用者（${mode}）正在占用 127.0.0.1:${lb.port}：这一情况记为未测`);
        continue;
      }
      phase.ran = true;
      // 定时刷新（先于显式更新）：不执行更新，等待 Surge 自己的下载（间隔没有写入文档）；从占用之前的起点核对
      const minutes = Number((await prompt.ask('等待 Surge 定时刷新的分钟数（0–30，直接回车跳过）：')) ?? '0');
      if (Number.isFinite(minutes) && minutes > 0) {
        const waitMs = Math.min(minutes, 30) * 60_000;
        const deadline = now().getTime() + waitMs;
        let observed = false;
        for (let i = 0; i < Math.ceil(waitMs / 5000) && now().getTime() <= deadline; i++) {
          await lb.snapshot();
          // 只算这一种占用者收到的请求（上一种占用者在被停止之前收到的不是这一种的观察）
          if (squatRequestsOf(mode, base.at, now().getTime() + 1000).own.length > 0) {
            observed = true;
            break;
          }
          await sleep(5000);
        }
        phase.scheduled = { minutes: Math.min(minutes, 30), observed, result: observed ? observe(mode, base, base.at, await settle(base.before)) : null };
        if (observed) {
          // 显式更新要从已提交版本重新开始（定时刷新留下的变化不算显式更新的证据）：恢复，再次占用
          await prompt.pause('停止占用者（Ctrl+C），重新启动 resource-server（同一运行编号），它启动之后按回车');
          const server = readServerStatus(dir);
          const back = serverRunning(server) && server.listening ? await lb.confirmCommitted(`squat-${mode}-between`) : null;
          phase.between = { recovered: back?.assessment.ok === true };
          if (!phase.between.recovered) {
            out.warn(`${mode}：定时刷新之后没有恢复已提交版本（资源服务没有重新运行或读回不一致）：显式更新记为未测`);
            continue;
          }
          base = await baseNow();
          await prompt.pause(`在 resource-server 终端按 Ctrl+C 停止服务，然后再次运行 resource-server --squat ${mode}（同一运行编号）`);
          if (!squatHolding(mode)) {
            out.warn(`没有看到占用者（${mode}）再次占用 127.0.0.1:${lb.port}：显式更新记为未测`);
            continue;
          }
        }
      }
      // 显式更新：从占用之前的起点核对；更新之前占用者已收到请求（Surge 自己下载过）时这一次不单独计入
      const tE = now().getTime();
      await lb.update(`squat-${mode}`);
      await lb.waitNotUpdating();
      phase.explicit = observe(mode, base, tE, await settle(base.before));
    }
    await prompt.pause('停止占用者（Ctrl+C），重新启动 resource-server（同一运行编号）');
    const server = readServerStatus(dir);
    if (serverRunning(server) && server.listening) {
      const c = await lb.confirmCommitted('auth-recover');
      recovered = c.assessment.ok;
    } else {
      out.warn('资源服务没有重新运行：请重新启动 resource-server 后运行 loopback 恢复已提交版本');
      recovered = false;
    }
  }

  // 6. Surge 资源缓存（操作员）
  out.heading('Surge 资源缓存（手动记录）');
  out.line('在 Surge 的配置目录与 ~/Library 中查找含合成测试节点名的文件（例如 grep -rl SFE-N-P0-C <目录>），只记录位置、权限、是否明文、Surge 重开后是否仍在；不复制文件内容。');
  const cacheLocation = redactSummary(((await prompt.ask('缓存位置与权限（直接回车跳过）：')) ?? '').slice(0, 300), { home });
  const cachePlain = await prompt.ask('缓存中的凭据是否为明文？（y/n/回车 未知）');

  // 结束：恢复已提交版本（服务在运行时）
  if (recovered === null) {
    const c = await lb.confirmCommitted('auth-end');
    recovered = c.assessment.ok;
  }

  const squat = squatChecks(phases);
  const otherUserOk = ((): boolean | null => {
    if (otherUser === null) return null;
    if (otherUser.sameUserSquatter || (otherUser.uid !== null && otherUser.uid === otherUser.ownUid)) return false;
    if (otherUser.uid === null || otherUser.bindFailed === null || otherUser.received === null) return null;
    return otherUser.bindFailed === true && otherUser.received === false && otherUser.reachedUs;
  })();
  const checks: CheckItem[] = [
    check(
      '令牌错误或缺失、带浏览器请求头或使用其他方法时一律得到同样的 404（产品处理程序）',
      uniform404 && validOk,
      `${rejections.length} 种拒绝请求${uniform404 ? '字节相同' : '不一致'}；令牌正确的请求 ${validOk ? '得到 200' : '没有得到 200'}${badProbes.length > 0 ? `；不符：${badProbes.join('、')}` : ''}`,
    ),
    check('令牌正确而没有加载内容时得到 503', unavailable === 503, `得到 ${unavailable ?? '无响应'}`),
    check(
      'Surge 的每次下载都由产品处理程序答复 200 并完整写出（请求头名称已记录）',
      allProduct200,
      `${fromSurge.length} 次下载；方法 ${methods.join('、') || '无'}${methods.includes('HEAD') ? '（出现了 HEAD）' : ''}；请求头名称 ${headerNames.join('、') || '无'}；读回 ${readbackText(surgeRun.assessment)}`,
    ),
    check(
      '发起下载的进程已记录',
      !peerKnown ? null : peerIsSurge && peerRecovery.assessment.ok,
      `${!peerKnown ? 'lsof 读不到对端（只在 macOS 上记录）' : peers.map((p) => `${p.command}（${p.path ?? '路径读不到'}）`).join('、') || '没有找到对端进程'}；之后恢复 ${readbackText(peerRecovery.assessment)}`,
    ),
    check(
      '资源服务只监听 127.0.0.1（lsof 实测资源服务进程的监听地址）',
      listenOnlyLoopback,
      listen === null ? 'lsof 读不到资源服务进程的监听地址（只在 macOS 上记录）' : `监听 ${listen.join('、')}`,
    ),
    check('服务运行时同一用户第二次绑定 127.0.0.1:端口失败', loopbackRebind.result === 'in_use', `127.0.0.1：${BIND_TEXT[loopbackRebind.result]}`),
    check(
      '能绑定成功的 0.0.0.0、[::]、[::1] 同端口监听不影响发往 127.0.0.1 的请求（以本服务请求记录为证）',
      altOk,
      binds.filter((b) => b.address !== '127.0.0.1').map((b) => `${b.address.includes(':') ? `[${b.address}]` : b.address}：${BIND_TEXT[b.result]}${b.result === 'bound' ? `，收到 ${b.connections} 个连接` : ''}`).join('；'),
    ),
    check(
      '服务运行时另一系统用户第二次绑定 127.0.0.1:端口失败（操作员记录）',
      otherUserOk,
      otherUser === null
        ? '跳过（没有另一系统用户）'
        : [
            `操作员照抄：${otherUser.note || '没有照抄'}`,
            `uid ${otherUser.uid ?? '没有照抄'}${otherUser.uid !== null && otherUser.uid === otherUser.ownUid ? '（与本工具相同：不是另一系统用户）' : ''}`,
            ...(otherUser.sameUserSquatter ? ['运行目录中出现了这一步期间启动的占用者记录（同一用户）'] : []),
            `收到连接 ${otherUser.received === null ? '未知' : otherUser.received ? '是' : '否'}`,
            `Surge 的下载${otherUser.reachedUs ? '到达本服务' : '没有到达本服务'}`,
          ].join('；'),
    ),
    check(
      '服务停止时端口被占用（显式更新）：后果已记录，产品的下载核对发现伪造列表、占用者的错误与不答复（请求超时）',
      squat.explicit,
      phases.length === 0 ? '跳过' : phases.map((p) => `${p.mode}：${squatObservationText(p.explicit)}`).join('；'),
    ),
    check(
      '服务停止时端口被占用（定时刷新）：后果已记录，产品的下载核对发现伪造列表、占用者的错误与不答复（请求超时）',
      squat.scheduled,
      phases.length === 0
        ? '跳过'
        : phases.map((p) => `${p.mode}：${p.scheduled === null ? '没有等待' : p.scheduled.observed ? `观察到 Surge 自己的下载，${squatObservationText(p.scheduled.result)}` : `等待 ${p.scheduled.minutes} 分钟没有下载`}`).join('；'),
    ),
    check(
      'Surge 资源缓存的位置及其中凭据的保存方式已记录（操作员记录）',
      cacheLocation !== '' && (cachePlain === 'y' || cachePlain === 'n') ? true : null,
      cacheLocation ? `操作员记录：${cacheLocation}；明文 ${cachePlain === 'y' ? '是' : cachePlain === 'n' ? '否' : '未知'}` : '没有记录',
    ),
    check('之后重新提供已提交版本，一次单 key 更新并读回一致', recovered, recovered === null ? '没有运行' : recovered ? '读回一致' : '读回不一致或服务没有重新运行'),
  ];
  dir.writeJson(`loopback-auth/${t0}.json`, {
    probes: results.map((r) => ({ id: r.id, expect: r.expect, status: r.status, length: r.bytes.length, sameAsReference: r.expect === 404 ? r.bytes.equals(reference) : null })),
    unavailable,
    surge: { downloads: fromSurge.length, methods, headerNames, peers },
    listen,
    binds,
    altRouting,
    otherUser,
    phases,
    cache: { location: cacheLocation, plaintext: cachePlain },
  });
  const context = await measureContext(ctx, session, ops.state);
  const result = writeResult(dir, {
    key: 'loopback_resource_auth',
    command: 'loopback-auth',
    at: now().toISOString(),
    checks,
    summary: [
      `通过条件：${CAPABILITY_CRITERIA.loopback_resource_auth}`,
      `资源服务的监听地址（lsof 实测）：${listen === null ? '读不到' : listen.join('、')}；端口 ${lb.port}`,
      '另一系统用户的绑定结果与 Surge 资源缓存的位置由操作员照抄或记录（检查项已注明）',
    ],
    context,
  });
  printResult(out, result);
  return 0;
}
