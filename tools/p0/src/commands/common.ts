// 各命令共用：运行目录、合成测试凭据、Surge 会话（固定原语映射 + 写入守卫 + 调用记录）、测试服务检查、
// 上下文测量（Surge 版本来自运行中的 Surge 实例，与服务同一读取器，并与 `surge-cli --raw version` 交叉核对）、
// 写入前快照与确认。

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { basename } from 'node:path';
import { CAPABILITY_CRITERIA, CAPABILITY_LABELS, ROUTE_GROUP_NAME, VERIFY_ENDPOINTS, type CapabilityContext, type EntryStrategy, type TakeoverState } from '@sfe/contract';
import { parseMechanismOverrides, type ParsedArgs } from '../args.js';
import { CALLS_LOG, DEFAULT_SURGE_PROXY, TEST_CREDENTIALS_FILE } from '../constants.js';
import { buildContext, type ContextOverrides } from '../context.js';
import {
  SURGE_PRIMITIVES,
  createDefaultSurgeInstanceReader,
  crossCheckSurgeVersion,
  parseHttpApiLine,
  serviceInstanceResult,
  verifyCliPath,
  type MechanismMap,
  type RunningInstanceReport,
  type RunningInstanceResult,
  type Logger,
  type ResourceBinder,
  type SurgeAdapter,
  type SurgeVersionCheck,
} from '../deps.js';
import { readResourceToken, type PeerProcess } from '../loopback-state.js';
import { refused } from '../errors.js';
import { directGet, parseProxyAddress, type ProxyAddress } from '../http-client.js';
import type { Output, Prompter } from '../io.js';
import { logAction, verdictLabel, type CapabilityResult } from '../results.js';
import { RunDir, assertSafeBaseDir, defaultBaseDir, newRunId } from '../run-dir.js';
import { emptyState, loadState, saveState, type RunState, type ServersInfo } from '../state.js';
import { DEFAULT_SURGE_CLI, SAFARI_APP, plistValue, restartPending, surgeStartFingerprint, swVers, type ExecFn } from '../system.js';
import { CANARY_FILE, TEST_NODES, TEST_PROFILE_NAME } from '../test-profile.js';
import { createGuardedAdapter, createP0Adapter, describeLocation, emptyGuard, maskResourceKey, readCliVersion, resourcesForPath, type WriteGuard } from '../surge-access.js';

export interface Deps {
  exec: ExecFn;
  now: () => Date;
  home: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  out: Output;
  prompt: Prompter;
  sleep: (ms: number) => Promise<void>;
  /** 只用于离线测试：替代真实 CLI/HTTP 适配器（仍套写入守卫与调用记录）。 */
  surgeOverride?: SurgeAdapter;
  /** 只用于离线测试：替代运行中 Surge 实例的读取（版本来源；例如 FakeSurge.runningInstance）。 */
  surgeInstance?: () => Promise<RunningInstanceResult | RunningInstanceReport>;
  /** 只用于离线测试：替代后台安全改进暂存位置的存在检查（缺省与服务同一 lstat 规则）。 */
  pathPresence?: (path: string) => Promise<'present' | 'absent' | 'unknown'>;
  /** 只用于离线测试：测试资源服务的绑定方（缺省产品的 tcpBinder，只监听 127.0.0.1）。 */
  resourceBinder?: (logger: Logger) => ResourceBinder;
  /** 只用于离线测试：找发起连接的进程（缺省 macOS 上经共用执行器运行 lsof）。 */
  resourcePeerProbe?: (port: number) => Promise<PeerProcess[] | null>;
  /** 只用于离线测试：读取令牌的随机来源（缺省 32 个随机字节）。 */
  random?: () => Buffer;
}

export interface Ctx {
  args: ParsedArgs;
  deps: Deps;
}

export function baseDirOf(ctx: Ctx): string {
  const base = ctx.args.strings['raw-dir'] ?? defaultBaseDir(ctx.deps.platform, ctx.deps.home, ctx.deps.env);
  assertSafeBaseDir(base, ctx.deps.home);
  return base;
}

export function openRun(ctx: Ctx): { dir: RunDir; state: RunState } {
  const dir = RunDir.open(baseDirOf(ctx), ctx.args.strings.run ?? null);
  return { dir, state: loadState(dir, ctx.deps.now()) };
}

export function createRun(ctx: Ctx): { dir: RunDir; state: RunState } {
  const dir = RunDir.create(baseDirOf(ctx), newRunId(ctx.deps.now()));
  const state = emptyState(dir.id, ctx.deps.now());
  saveState(dir, state);
  return { dir, state };
}

export interface TestCredentials {
  /** 合成测试密码，只对本机测试出口有效。 */
  password: string;
  /** 测试配置中回环 http-api 的随机密钥。 */
  httpApiKey: string;
}

function randomAlnum(n: number): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = randomBytes(n);
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
}

export function loadCredentials(dir: RunDir): TestCredentials | null {
  const c = dir.readJson<TestCredentials>(TEST_CREDENTIALS_FILE);
  return c && typeof c.password === 'string' && typeof c.httpApiKey === 'string' ? c : null;
}

export function ensureCredentials(dir: RunDir): TestCredentials {
  const existing = loadCredentials(dir);
  if (existing) return existing;
  const creds: TestCredentials = { password: randomAlnum(24), httpApiKey: randomBytes(16).toString('hex') };
  dir.writeNew(TEST_CREDENTIALS_FILE, `${JSON.stringify(creds)}\n`);
  return creds;
}

export function proxyOf(ctx: Ctx): ProxyAddress {
  return parseProxyAddress(ctx.args.strings.proxy ?? DEFAULT_SURGE_PROXY);
}

export function verifyHostOf(ctx: Ctx): string {
  const id = ctx.args.strings['verify-endpoint'] ?? 'ipify';
  const ep = VERIFY_ENDPOINTS.find((e) => e.id === id);
  if (!ep) throw refused(`检测服务 ${id.slice(0, 20)} 不存在：只能是 ${VERIFY_ENDPOINTS.map((e) => e.id).join('、')}`);
  return ep.host;
}

export async function resolveCli(ctx: Ctx, state: RunState): Promise<{ path: string; ok: boolean; reason: string }> {
  const path = ctx.args.strings['surge-cli'] ?? state.surgeCliPath ?? DEFAULT_SURGE_CLI;
  const result = await verifyCliPath(path, {
    realpath: (p) => realpath(p),
    runCodesign: async (args) => {
      const r = await ctx.deps.exec('/usr/bin/codesign', args, { timeoutMs: 30_000 });
      return { code: r.code, stderr: r.stderr };
    },
    teamId: ctx.args.strings['surge-team-id'] ?? null,
    platform: ctx.deps.platform,
  });
  return { path, ...result };
}

export interface HttpApiCandidate {
  source: 'test' | 'source';
  key: string;
  port: number;
}

export function httpApiCandidates(state: RunState, extraProfilePath?: string | null): HttpApiCandidate[] {
  const out: HttpApiCandidate[] = [];
  const seen = new Set<string>();
  const add = (path: string | null | undefined, source: 'test' | 'source'): void => {
    if (!path || !existsSync(path)) return;
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      return;
    }
    const api = parseHttpApiLine(text);
    if (!api || !api.loopbackOnly) return;
    const id = `${api.port}`;
    if (seen.has(id + api.key)) return;
    seen.add(id + api.key);
    out.push({ source, key: api.key, port: api.port });
  };
  add(state.testProfilePath, 'test');
  add(extraProfilePath ?? state.sourceProfilePath, 'source');
  return out;
}

export interface Session {
  adapter: SurgeAdapter;
  guard: WriteGuard;
  mechanism: MechanismMap;
  cliPath: string | null;
  httpSource: 'test' | 'source' | null;
  currentProfileName: string | null;
  onTestProfile: boolean | null;
}

export function mechanismOf(ctx: Ctx, state: RunState): MechanismMap {
  if (!state.mechanism) throw refused('打开 Surge 会话失败：本次运行还没有原语实现映射，请先运行 inventory');
  const overrides = parseMechanismOverrides(ctx.args.lists.mechanism ?? [], [...SURGE_PRIMITIVES]);
  const map: MechanismMap = {};
  for (const p of SURGE_PRIMITIVES) map[p] = overrides[p] ?? state.mechanism[p] ?? 'unavailable';
  return map;
}

/**
 * 打开 Surge 会话：校验 CLI 签名、选择能用的回环 http-api 密钥（测试配置优先），按固定映射组合实现，
 * 外面套写入守卫与调用记录。needTestProfile 时确认当前是测试配置（读不到配置名时由操作员确认）。
 */
export async function openSession(ctx: Ctx, dir: RunDir, state: RunState, opts: { needTestProfile: boolean }): Promise<Session> {
  const mechanism = mechanismOf(ctx, state);
  const cli = await resolveCli(ctx, state);
  const usesCli = Object.values(mechanism).includes('cli');
  if (usesCli && !cli.ok) ctx.deps.out.warn(`Surge CLI 未通过签名校验（${cli.reason}），CLI 原语不可用`);
  let httpApi: { key: string; port: number } | null = null;
  let httpSource: Session['httpSource'] = null;
  let currentProfileName: string | null = null;
  if (Object.values(mechanism).includes('http')) {
    for (const c of httpApiCandidates(state)) {
      const probe = createP0Adapter({ cliPath: null, httpApi: c, mechanism: { getCurrentProfile: 'http' } });
      try {
        currentProfileName = (await probe.getCurrentProfile()).name;
        httpApi = { key: c.key, port: c.port };
        httpSource = c.source;
        break;
      } catch {
        /* 下一个候选 */
      }
    }
  }
  const inner = ctx.deps.surgeOverride ?? createP0Adapter({ cliPath: cli.ok ? cli.path : null, httpApi, mechanism });
  if (ctx.deps.surgeOverride) currentProfileName = (await tryRead(() => inner.getCurrentProfile()))?.name ?? null;
  const guard = emptyGuard();
  guard.testablePolicies = new Set([...Object.values(TEST_NODES), ROUTE_GROUP_NAME]);
  guard.killablePaths = new Set(state.processPaths);
  // 回环测试资源的读取令牌（有时）：调用记录与快照中含它的资源 key 整体遮盖
  try {
    const token = readResourceToken(dir);
    if (token !== null) guard.secrets.add(token);
  } catch {
    /* 令牌文件损坏：使用它的命令自己拒绝 */
  }
  const adapter = createGuardedAdapter(inner, guard, (e) => dir.appendJsonl(CALLS_LOG, e), ctx.deps.now);

  let onTestProfile: boolean | null = currentProfileName === null ? null : currentProfileName === TEST_PROFILE_NAME;
  if (onTestProfile === null && state.testDirectory) {
    try {
      const res = await adapter.listExternalResources();
      onTestProfile = resourcesForPath(res, `${state.testDirectory}/${CANARY_FILE}`, state.testDirectory).length > 0 ? true : null;
    } catch {
      /* 读不到外部资源 */
    }
  }
  if (opts.needTestProfile) {
    if (onTestProfile === false) throw refused(`前置条件不满足：Surge 当前配置是「${currentProfileName ?? '未知'}」，不是「${TEST_PROFILE_NAME}」。请先在 Surge 菜单中手动切换`);
    if (onTestProfile === null) {
      // 事实确认不受 --yes 影响：必须由操作员亲自输入。
      const answer = await ctx.deps.prompt.ask(`无法读取 Surge 当前配置名。确认 Surge 当前是「${TEST_PROFILE_NAME}」请输入 yes：`);
      if (answer !== 'yes') throw refused('前置条件不满足：未确认 Surge 当前是测试配置');
      onTestProfile = true;
      logAction(dir, { at: ctx.deps.now().toISOString(), command: ctx.args.command, action: 'operator_confirmed_test_profile' });
    }
  }
  guard.onTestProfile = onTestProfile === true;
  return { adapter, guard, mechanism, cliPath: cli.ok ? cli.path : null, httpSource, currentProfileName, onTestProfile };
}

/** 允许刷新本工具创建的测试文件对应的资源 key；返回文件名 → key。 */
export async function allowRefreshFor(session: Session, state: RunState, fileNames: readonly string[]): Promise<Record<string, string>> {
  if (!state.testDirectory) throw refused('前置条件不满足：还没有测试配置，请先运行 make-test-profile');
  const resources = await session.adapter.listExternalResources();
  const out: Record<string, string> = {};
  for (const name of fileNames) {
    const found = resourcesForPath(resources, `${state.testDirectory}/${name}`, state.testDirectory);
    if (found.length === 1) {
      out[name] = found[0]!.key;
      session.guard.refreshableKeys.add(found[0]!.key);
    } else if (found.length > 1) {
      throw refused(`前置条件不满足：多个外部资源指向 ${name}，不能确定 key`);
    }
  }
  return out;
}

export async function requireServers(_ctx: Ctx, state: RunState): Promise<ServersInfo> {
  if (!state.servers) throw refused('前置条件不满足：本次运行还没有启动测试服务，请在另一个终端运行 test-servers');
  const health = await directGet(state.servers.echoPort, '/health');
  const ok = health.ok && (health.json as { service?: unknown } | null)?.service === 'sfe-p0-echo';
  if (!ok) throw refused('前置条件不满足：测试服务没有在运行（test-servers 需要保持运行）');
  return state.servers;
}

export interface MeasureExtras {
  entryStrategy?: EntryStrategy | null;
  processPaths?: readonly string[];
  overrides?: ContextOverrides;
  signingIdentity?: string | null;
  /** 本次命令已经读过的运行实例（避免同一命令内读两次得到不同结论）。 */
  instance?: RunningInstanceReport;
}

export async function tryRead<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

/**
 * 读取运行中的 Surge 实例（只读）：与服务同一工厂（createDefaultSurgeInstanceReader）、同一常量与执行方式（P0 的
 * execFixed，stdin 关闭，ps 固定 C/UTC 环境）。--surge-team-id 只会让签名校验更严（失败即关闭，不会与服务结论相反地放宽）。
 * codesign 超时比服务长（记录真实耗时，V5）；服务的时限（codesign 15 秒、引擎总时限 8 秒）由 serviceLimitsExceeded
 * 核对，能力上下文只采用服务按同一时限也能读到的版本（serviceInstanceResult）。
 */
export async function readSurgeInstance(ctx: Ctx): Promise<RunningInstanceReport> {
  if (ctx.deps.surgeInstance) {
    try {
      const r = await ctx.deps.surgeInstance();
      return 'result' in r ? r : { result: r, steps: [], cached: false };
    } catch {
      return { result: { ok: false, reason: 'read_failed' }, steps: [], cached: false };
    }
  }
  const reader = createDefaultSurgeInstanceReader({
    platform: ctx.deps.platform,
    uid: process.getuid?.() ?? -1,
    exec: ctx.deps.exec,
    teamId: ctx.args.strings['surge-team-id'] ?? null,
  });
  return reader.inspect();
}

/** 按服务运行时的同一来源测量当前上下文（session 只需要固定映射下的适配器与映射）。 */
export async function measureContext(
  ctx: Ctx,
  session: { adapter: SurgeAdapter; mechanism: MechanismMap } | null,
  state: RunState,
  extras: MeasureExtras = {},
): Promise<CapabilityContext> {
  return (await measureContextWithInstance(ctx, session, state, extras)).context;
}

/**
 * 运行实例（服务时限内可读时）与 `surge-cli --raw version` 的交叉核对，与服务 engine/context.ts 的 readVersion 同一规则
 * （crossCheckSurgeVersion）：运行实例低于最低支持版本 6.10.0（12500）、CLI 不支持 version、两者版本或构建号不同、
 * Controller 协议 < 22、CLI 读不到——任一即失败。运行实例读不到时为 null（原因见运行实例的结果）。
 * 没有会话（没有原语映射）时 CLI 版本按读不到处理。
 */
export async function crossCheckVersion(
  session: { adapter: Pick<SurgeAdapter, 'getVersion'> } | null,
  instance: RunningInstanceReport,
): Promise<SurgeVersionCheck | null> {
  const svc = serviceInstanceResult(instance);
  if (!svc.ok) return null;
  return crossCheckSurgeVersion(svc.instance, session ? await readCliVersion(session.adapter) : null);
}

/**
 * 同 measureContext，另返回运行实例的读取结果与版本交叉核对（拒绝提议时说明原因）。上下文中的版本与构建号只在交叉
 * 核对通过时记录（与服务的 SurgeFacts 一致）；否则为 null，依赖版本的能力不能提议。
 */
export async function measureContextWithInstance(
  ctx: Ctx,
  session: { adapter: SurgeAdapter; mechanism: MechanismMap } | null,
  state: RunState,
  extras: MeasureExtras = {},
): Promise<{ context: CapabilityContext; instance: RunningInstanceReport; versionCheck: SurgeVersionCheck | null }> {
  const v = await swVers(ctx.deps.exec);
  // 与服务同一来源：已安装、要重启 Mac 才完全生效的后台安全改进（暂存位置存在为 'yes'，无法确认为 null）
  const pending = await restartPending(ctx.deps.pathPresence);
  const safari = await plistValue(ctx.deps.exec, SAFARI_APP, 'CFBundleShortVersionString');
  const instance = extras.instance ?? (await readSurgeInstance(ctx));
  // 服务的读取器在它的时限内读不到的版本（签名校验太慢、每次读取超过总时限）不进入上下文：这样的记录在服务中永远不会生效；
  // 运行实例与 CLI 报告的版本不一致、低于最低支持版本或协议过低时同样不进入。
  const versionCheck = await crossCheckVersion(session, instance);
  const version = versionCheck?.ok ? { version: versionCheck.version, build: versionCheck.build } : null;
  const autoReload = session ? await tryRead(() => session.adapter.getAutoReloadSetting()) : null;
  const takeover: TakeoverState | null = session ? await tryRead(() => session.adapter.getTakeoverState()) : null;
  const context = buildContext(
    {
      surgeVersion: version,
      macosBuild: v.buildVersion,
      macosVersionExtra: v.productVersionExtra,
      macosRestartPending: pending,
      safariVersion: safari,
      entryStrategy: extras.entryStrategy ?? null,
      processPaths: extras.processPaths ?? state.processPaths,
      autoReloadSetting: autoReload,
      takeover,
      signingIdentity: extras.signingIdentity ?? null,
      mechanism: session ? session.mechanism : state.mechanism,
    },
    extras.overrides,
  );
  return { context, instance, versionCheck };
}

export interface Snapshot {
  at: string;
  label: string;
  profileName: string | null;
  takeover: TakeoverState | null;
  tempRules: string[] | null;
  routeSelection: string | null;
  routeMembers: string[] | null;
  resources: Array<{ key: string; type: string; location: string; lastUpdatedAt: string | null; error: boolean }> | null;
  surgeStart: string | null;
}

/** 写入前快照（原始数据存运行目录，摘要打印）。 */
export async function takeSnapshot(ctx: Ctx, session: Session, dir: RunDir, label: string): Promise<Snapshot> {
  const a = session.adapter;
  const profile = await tryRead(() => a.getCurrentProfile());
  const resources = await tryRead(() => a.listExternalResources());
  const snap: Snapshot = {
    at: ctx.deps.now().toISOString(),
    label,
    profileName: profile?.name ?? session.currentProfileName,
    takeover: await tryRead(() => a.getTakeoverState()),
    tempRules: await tryRead(() => a.listTempRules()),
    routeSelection: await tryRead(() => a.getGroupSelection(ROUTE_GROUP_NAME)),
    routeMembers: await tryRead(() => a.getGroupMembers(ROUTE_GROUP_NAME)),
    resources: resources
      ? resources.map((r) => ({ key: maskResourceKey(r.key, session.guard.secrets), type: r.type, location: describeLocation(r.location), lastUpdatedAt: r.lastUpdatedAt?.toISOString() ?? null, error: r.error !== null }))
      : null,
    surgeStart: await surgeStartFingerprint(ctx.deps.exec),
  };
  dir.writeJson(`snapshots/${label}-${snap.at.replace(/[:.]/g, '')}.json`, snap);
  return snap;
}

export function printSnapshot(out: Output, s: Snapshot): void {
  out.line(`快照（${s.label}）：配置「${s.profileName ?? '读不到'}」；增强模式 ${fmtBool(s.takeover?.enhancedMode)}，系统代理 ${fmtBool(s.takeover?.systemProxy)}，出站模式 ${s.takeover?.outboundMode ?? '读不到'}`);
  out.line(`  临时规则 ${s.tempRules === null ? '读不到' : `${s.tempRules.length} 条`}；SFE-ROUTE 选择 ${s.routeSelection ?? '读不到'}；外部资源 ${s.resources === null ? '读不到' : `${s.resources.length} 个`}`);
}

export function fmtBool(v: boolean | null | undefined): string {
  return v === true ? '开' : v === false ? '关' : '读不到';
}

/** 打印将要执行的写入与精确回退，确认后才继续。 */
export async function confirmWrites(ctx: Ctx, title: string, steps: readonly string[], rollback: readonly string[]): Promise<boolean> {
  const { out, prompt } = ctx.deps;
  out.heading(title);
  out.line('将要执行：');
  steps.forEach((s, i) => out.line(`  ${i + 1}. ${s}`));
  out.line('回退方式（任何一步失败时按此恢复）：');
  rollback.forEach((s, i) => out.line(`  ${i + 1}. ${s}`));
  return prompt.confirm('确定要执行以上写入吗？');
}

export function profileNameOf(path: string): string {
  return basename(path).replace(/\.conf$/i, '');
}

export function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 打印一项能力的结论：名称、通过条件（与网页能力页同一文字来源）与逐项检查。 */
export function printResult(out: Output, r: CapabilityResult): void {
  out.line(`${r.key}（${CAPABILITY_LABELS[r.key]}）：${verdictLabel(r.verdict)}`);
  out.line(`  通过条件：${CAPABILITY_CRITERIA[r.key]}`);
  for (const c of r.checks) out.line(`  ${c.ok === true ? '通过' : c.ok === false ? '不通过' : '未完成'} · ${c.name}${c.note ? `：${c.note}` : ''}`);
}
