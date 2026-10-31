// P0 使用的 Surge 访问：复用服务的 CLI/HTTP/组合适配器（同一受限原语集合与 CLI argv 允许清单，没有切换配置、重载、
// 重启引擎、flush、接管或出站写入），外加一层写入守卫与调用记录：
// - 组选择只允许 SFE-ROUTE，且必须确认当前是测试配置；
// - 外部资源更新只允许本工具登记过的单个 key（从不 update all）：本地测试文件的 key 只用来记录 Surge 跳过本地资源；
//   回环测试资源（D10）的 key 经产品的 key 安全检查（resourceUpdateRoute）之后才登记——key 可能含读取令牌时只能经 HTTP；
// - 调用记录与快照中，含读取令牌或回环地址路径的资源 key 一律遮盖（maskResourceKey）；
// - 临时规则的增删只允许运行状态中先登记过的精确规则；
// - 结束请求只允许最近一次列出的、进程路径属于已确认 Safari 路径的请求。

import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENTRY_PROBE_IPV4, SfeError } from '@sfe/contract';
import { RESOURCE_UPDATE_TIMEOUT_MS } from './constants.js';
import {
  INTERACTIVE_BANNER_RE,
  SURGE_PRIMITIVES,
  UNSUPPORTED_COMMAND_RE,
  cliArgvs,
  createCliAdapter,
  createCompositeAdapter,
  createHttpAdapter,
  isAllowedCliArgv,
  isUnsupportedCommandError,
  redactUrls,
  resourceLocationHash,
  type MechanismMap,
  type SurgeAdapter,
  type SurgeExternalResource,
  type SurgeRequestRecord,
  type SurgeVersion,
} from './deps.js';

export const READ_PRIMITIVES = [
  'getVersion',
  'getRuntimeInfo',
  'getCurrentProfile',
  'getTakeoverState',
  'getAutoReloadSetting',
  'checkProfile',
  'listPolicies',
  'getPolicyDetail',
  'getGroupMembers',
  'getGroupSelection',
  'listRules',
  'matchRule',
  'listActiveRequests',
  'listRecentRequests',
  'listExternalResources',
  'listTempRules',
] as const;

/** 会改变 Surge 运行状态或发起网络连接的原语：盘点时不调用，由各测试命令在写入守卫下证明。 */
export const ACTIVE_PRIMITIVES = ['selectGroupPolicy', 'testPolicy', 'killRequest', 'updateExternalResource', 'addTempRule', 'removeTempRule'] as const;

export type ReadPrimitive = (typeof READ_PRIMITIVES)[number];
export type ActivePrimitive = (typeof ACTIVE_PRIMITIVES)[number];
export type Primitive = ReadPrimitive | ActivePrimitive;

// 模块 B 的 HTTP 实现对这些原语不发请求、直接 CAPABILITY_UNVERIFIED：HTTP API 文档没有对应端点（临时规则、规则求值、
// 自动重载设置、配置校验），或端点给不出所需字段（版本：没有 Controller 协议号）。外部资源（Mac 6.10.0+）与引擎运行时长
// （/v1/metrics，Mac 6.9.0+）已实现。
export const HTTP_NOT_IMPLEMENTED: readonly Primitive[] = [
  'getVersion',
  'getAutoReloadSetting',
  'checkProfile',
  'matchRule',
  'listTempRules',
  'addTempRule',
  'removeTempRule',
];

// 示例参数只用来构造 argv 的形状（固定命令词与允许清单），从不执行。rule match 的目标仍用文档地址 ENTRY_PROBE_IPV4，与实际
// 执行的探测一致：合成域名在求值走到 IP 规则时会因 DNS 失败退出 1（docs/verification/2026-10-24-mac-p0-increment.md）。
const DUMMY_ARGS: Partial<Record<Primitive, unknown[]>> = {
  checkProfile: ['/p0-dummy.conf'],
  getGroupMembers: ['P0-DUMMY-GROUP'],
  getGroupSelection: ['P0-DUMMY-GROUP'],
  selectGroupPolicy: ['SFE-ROUTE', 'P0-DUMMY-POLICY'],
  matchRule: [{ host: ENTRY_PROBE_IPV4, processPath: '/var/empty/p0-dummy' }],
  killRequest: ['1'],
  updateExternalResource: ['p0-dummy-key'],
  addTempRule: ['P0-DUMMY-RULE'],
  removeTempRule: ['P0-DUMMY-RULE'],
};

/** 示例参数中的字符串（对象参数取其字符串字段）：从 argv 中去掉它们，剩下的才是固定命令词。 */
function dummyStrings(args: readonly unknown[]): string[] {
  return args.flatMap((a) => (typeof a === 'string' ? [a] : typeof a === 'object' && a !== null ? Object.values(a).filter((v): v is string => typeof v === 'string') : []));
}

/**
 * 帮助文本中出现的命令词与选项（只用于判断原语对应的命令是否存在）。词后可以是空白、括号、逗号、竖线、等号、冒号、
 * 句点或斜杠：6.10 的帮助写作 `--check/-c <path>`（选项与短选项用斜杠连写）、`macOS also supports system-proxy and
 * enhanced-mode.`（句末句点）。
 */
export function helpWords(help: string): Set<string> {
  const words = new Set<string>();
  for (const m of help.matchAll(/(?:^|[\s[(|,<])(--?[A-Za-z][A-Za-z0-9-]*|[a-z][a-z0-9-]*)(?=$|[\s\]),|=:./>])/gm)) words.add(m[1]!);
  return words;
}

/**
 * inventory 逐条读取的命令帮助。6.9.0 起顶层帮助只列命令组（“Improved CLI help output with command categories and detailed
 * help for individual commands.”），子命令与 dump 类型要看 `help <command>`（手册：“`help <command>` for the detailed usage of
 * one command or command family, for example `help rule match` or `help dump`”；随包技能 §3.2：“`surge-cli -h` shows only a
 * subset.”）。每条都只是帮助文字，不连接控制器、不改变任何状态。
 */
export const CLI_HELP_TOPICS: readonly (readonly string[])[] = [
  ['dump'],
  ['rule', 'temp'],
  ['rule', 'match'],
  ['external-resource'],
  ['version'],
  ['status'],
  ['policy-group'],
  ['feature'],
  ['mode'],
  ['kill'],
];

export type HelpTopicStatus = 'ok' | 'interactive' | 'unsupported' | 'failed';

/**
 * 一条 `help <command>` 的输出是否可以并入帮助词：退出 0、不是交互模式提示、没有回答 Unknown command。
 * 不可用时这一条的词不并入（失败即关闭：只会让原语显示为 not_in_help，不会让它被探测）。
 */
export function classifyTopicHelp(r: { stdout: string; stderr: string; code: number }): HelpTopicStatus {
  const text = `${r.stdout}\n${r.stderr}`;
  if (INTERACTIVE_BANNER_RE.test(text)) return 'interactive';
  if (UNSUPPORTED_COMMAND_RE.test(text)) return 'unsupported';
  if (r.code !== 0 || r.stdout.trim() === '') return 'failed';
  return 'ok';
}

/** 帮助词的并集（顶层帮助加上每条可用的命令帮助）。 */
export function unionHelpWords(texts: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const t of texts) for (const w of helpWords(t)) out.add(w);
  return out;
}

/** 证据文件名：`help rule temp` → `rule-temp.txt`。 */
export function helpTopicFile(topic: readonly string[]): string {
  return `${topic.join('-')}.txt`;
}

/**
 * 解析 --help 的输出。输出是交互模式提示（帮助参数没有被识别）时命令词按空处理：不能从提示文字推断
 * 任何命令存在，也就不经 CLI 探测任何原语。只有匹配提示、且没有列出原语表中任何一条命令（没有原语的固定命令词
 * 全部出现）时才算提示：帮助正文常会说明交互模式（例如“不带命令运行进入交互模式”），这时仍按帮助解析。
 */
export function parseCliHelp(help: string): { words: Set<string>; interactive: boolean } {
  const words = helpWords(help);
  if (!INTERACTIVE_BANNER_RE.test(help)) return { words, interactive: false };
  const listsCommands = [...READ_PRIMITIVES, ...ACTIVE_PRIMITIVES].some((p) => cliAvailability(p, words) === 'in_help');
  return listsCommands ? { words, interactive: false } : { words: new Set(), interactive: true };
}

/** 原语按示例参数构造的全部 argv；表中没有时为 null。 */
export function cliSampleArgvs(primitive: Primitive): string[][] | null {
  return cliArgvs(primitive, DUMMY_ARGS[primitive] ?? []);
}

/**
 * CLI 原语表中该原语的固定命令词（去掉参数；key=value 选项只取 key，例如 rule match 的 process-path）；表中没有时为 null。
 */
export function cliLiteralWords(primitive: Primitive): string[] | null {
  const argvs = cliSampleArgvs(primitive);
  if (argvs === null) return null;
  const dummies = dummyStrings(DUMMY_ARGS[primitive] ?? []);
  const out: string[] = [];
  for (const w of argvs.flat()) {
    if (dummies.includes(w)) continue;
    const eq = w.indexOf('=');
    const word = eq > 0 && !w.startsWith('-') ? w.slice(0, eq) : w;
    if (!out.includes(word)) out.push(word);
  }
  return out;
}

/** 该原语的 argv 是否全部在服务的 CLI 允许清单中（不在时 cli-adapter 也不会执行）。 */
export function cliArgvsAllowed(primitive: Primitive): boolean {
  const argvs = cliSampleArgvs(primitive);
  return argvs !== null && argvs.length > 0 && argvs.every((argv) => isAllowedCliArgv(argv));
}

export type CliAvailability = 'not_in_table' | 'not_in_help' | 'in_help' | 'forbidden';

export function cliAvailability(primitive: Primitive, words: ReadonlySet<string>): CliAvailability {
  const lit = cliLiteralWords(primitive);
  if (lit === null) return 'not_in_table';
  if (!cliArgvsAllowed(primitive)) return 'forbidden';
  return lit.every((w) => words.has(w)) ? 'in_help' : 'not_in_help';
}

export type ProbeStatus = 'ok' | 'error' | 'not_in_table' | 'not_in_help' | 'not_implemented' | 'skipped' | 'unavailable';

export interface ProbeOutcome {
  status: ProbeStatus;
  code: string | null;
}

export interface MechanismProposal {
  mechanism: Record<Primitive | 'reloadProfile', 'cli' | 'http' | 'unavailable'>;
  /** 每个原语的依据（中文）。 */
  notes: Record<string, string>;
  /** 写/主动原语：选定了实现但尚未由测试命令证明。 */
  unproven: Primitive[];
}

/**
 * 原语实现建议（纯函数）：读原语取实测可用的实现（CLI 优先）；主动原语取“表中有且帮助中出现”的 CLI，
 * 或模块 B 已实现且 HTTP API 可用时的 HTTP；都不满足为 unavailable。重载只在维护端口上，P0 不设置。
 */
export function proposeMechanism(
  cli: Partial<Record<Primitive, ProbeOutcome>>,
  http: Partial<Record<Primitive, ProbeOutcome>>,
  cliHelp: Partial<Record<Primitive, CliAvailability>>,
  httpUsable: boolean,
): MechanismProposal {
  const mechanism = {} as MechanismProposal['mechanism'];
  const notes: Record<string, string> = {};
  const unproven: Primitive[] = [];
  for (const p of READ_PRIMITIVES) {
    if (cli[p]?.status === 'ok') {
      mechanism[p] = 'cli';
      notes[p] = 'CLI 实测可读';
    } else if (http[p]?.status === 'ok') {
      mechanism[p] = 'http';
      notes[p] = 'HTTP 实测可读';
    } else {
      mechanism[p] = 'unavailable';
      notes[p] = `CLI ${cli[p]?.status ?? '未测'}；HTTP ${http[p]?.status ?? '未测'}`;
    }
  }
  for (const p of ACTIVE_PRIMITIVES) {
    const viaCli = cliHelp[p] === 'in_help';
    const viaHttp = httpUsable && !HTTP_NOT_IMPLEMENTED.includes(p);
    if (viaCli) {
      mechanism[p] = 'cli';
      notes[p] = 'CLI 帮助中有对应命令（待测试命令证明）';
      unproven.push(p);
    } else if (viaHttp) {
      mechanism[p] = 'http';
      notes[p] = 'HTTP API 可用（待测试命令证明）';
      unproven.push(p);
    } else {
      mechanism[p] = 'unavailable';
      notes[p] = `CLI ${cliHelp[p] ?? '未测'}；HTTP ${httpUsable ? '未实现' : '不可用'}`;
    }
  }
  // 能读取只证明输出可以解析；临时规则列表的内容还要由 entry 的插入探测正向确认（刚添加的探测规则必须出现在列表中），
  // 之后 temp_rule 入口、临时规则同步与回退才会据它判断规则已不存在。
  if (mechanism.listTempRules !== 'unavailable') notes.listTempRules = `${notes.listTempRules}；内容需 entry 的插入探测正向确认（--probe-insertion）`;
  // HTTP API 文档（Mac 6.10.0+）：“Local resources are skipped.”。节点（D10）由本机回环资源服务提供，单 key 更新是发布原语
  // （loopback_resource_update 证明之前不算通过）；入口规则集仍是本地文件，更新从不作为入口的刷新机制。
  if (mechanism.updateExternalResource !== 'unavailable') {
    notes.updateExternalResource = `${notes.updateExternalResource}；回环节点资源的单 key 发布原语（loopback 系列命令证明；key 可能含读取令牌时只能经 HTTP），本地资源被跳过，从不作为入口的刷新机制`;
  }
  if (mechanism.getVersion !== 'unavailable') notes.getVersion = `${notes.getVersion}；只用于与运行实例交叉核对（版本、构建号一致且 Controller 协议 ≥ 22 才接受）`;
  mechanism.reloadProfile = 'unavailable';
  notes.reloadProfile = '只在维护端口上；P0 从不重载，由用户在 Surge 中手动触发并测量影响';
  return { mechanism, notes, unproven };
}

// ---------- 资源定位 ----------

/** 外部资源位置 → 绝对路径（URL 返回 null）。与服务入口策略的定位规则一致。 */
export function resolveLocation(location: string, dir: string): string | null {
  if (location.startsWith('file://')) {
    try {
      return fileURLToPath(location);
    } catch {
      return null;
    }
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(location)) return null;
  return isAbsolute(location) ? resolve(location) : resolve(dir, location);
}

export function resourcesForPath(resources: readonly SurgeExternalResource[], absPath: string, dir: string): SurgeExternalResource[] {
  const target = resolve(absPath);
  return resources.filter((r) => resolveLocation(r.location, dir) === target);
}

/** 位置摘要等于测试资源地址摘要的外部资源（locationHash 是 Surge 报告的原样位置的 SHA-256；地址含令牌，只在内存中计算）。 */
export function resourcesForUrl(resources: readonly SurgeExternalResource[], url: string): SurgeExternalResource[] {
  const hash = resourceLocationHash(url);
  return resources.filter((r) => r.locationHash === hash);
}

/** 盘点展示用：本地资源只给文件名，远端只给主机名。 */
export function describeLocation(location: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(location) && !location.startsWith('file://')) {
    try {
      return `远端 ${new URL(location).hostname}`;
    } catch {
      return '远端（地址无法解析）';
    }
  }
  const p = location.startsWith('file://') ? location.slice(7) : location;
  return `本地 ${p.slice(p.lastIndexOf('/') + 1)}`;
}

// ---------- 写入守卫与调用记录 ----------

export interface CallLogEntry {
  at: string;
  primitive: string;
  args: string[];
  ms: number;
  ok: boolean;
  code: string | null;
}

export interface WriteGuard {
  /** 当前确认是测试配置（getCurrentProfile 或操作员确认）。 */
  onTestProfile: boolean;
  /** 允许刷新的资源 key。 */
  refreshableKeys: Set<string>;
  /** 允许增删的临时规则（已在运行状态登记意图）。 */
  tempRules: Set<string>;
  /** 允许结束的进程路径（已确认的 Safari 路径）。 */
  killablePaths: Set<string>;
  /** 允许 testPolicy 的策略名。 */
  testablePolicies: Set<string>;
  /** 调用记录中要遮盖的值（回环测试资源的读取令牌）：含它或是它一段的资源 key 整体遮盖。 */
  secrets: Set<string>;
}

export function emptyGuard(): WriteGuard {
  return { onTestProfile: false, refreshableKeys: new Set(), tempRules: new Set(), killablePaths: new Set(), testablePolicies: new Set(), secrets: new Set() };
}

/** 遮盖后的资源 key 中替代整个 key 的写法。 */
export const MASKED_RESOURCE_KEY = '<resource-key:masked>';

/**
 * 资源 key 写入调用记录、动作时间线与快照之前的遮盖：含已知秘密（读取令牌）或是它一段（≥ 8 个字符）的 key 整体遮盖；
 * 其余的回环 http(s) 地址遮盖整段路径（redactUrls），64 位以上的十六进制串遮盖为 <token>（读取令牌的形状，秘密未知时）。
 * 不透明的 32 位十六进制 key 原样保留（读回与排查需要它）。
 */
export function maskResourceKey(key: string, secrets: Iterable<string> = []): string {
  const k = String(key);
  for (const s of secrets) {
    if (s.length > 0 && (k.includes(s) || (k.length >= 8 && s.includes(k)))) return MASKED_RESOURCE_KEY;
  }
  return redactUrls(k).replace(/[0-9a-f]{64,}/gi, '<token>');
}

function guardReason(g: WriteGuard, primitive: string, args: unknown[], lastActive: Map<string, SurgeRequestRecord>): string | null {
  switch (primitive) {
    case 'selectGroupPolicy':
      if (!g.onTestProfile) return '当前不是 P0 测试配置';
      return args[0] === 'SFE-ROUTE' ? null : '只允许选择 SFE-ROUTE';
    case 'updateExternalResource':
      if (!g.onTestProfile) return '当前不是 P0 测试配置';
      return g.refreshableKeys.has(String(args[0])) ? null : '只允许对本工具登记过的单个测试资源 key 执行更新';
    case 'addTempRule':
      if (!g.onTestProfile) return '当前不是 P0 测试配置';
      return g.tempRules.has(String(args[0])) ? null : '临时规则未在运行状态中登记';
    case 'removeTempRule':
      // 删除本工具登记过的精确规则总是允许（回退可能在切回原配置之后进行）。
      return g.tempRules.has(String(args[0])) ? null : '临时规则未在运行状态中登记';
    case 'killRequest': {
      const r = lastActive.get(String(args[0]));
      return r && r.processPath !== null && g.killablePaths.has(r.processPath) ? null : '只允许结束已确认 Safari 进程的请求';
    }
    case 'testPolicy':
      return g.testablePolicies.has(String(args[0])) ? null : '只允许测试 P0 测试节点';
    default:
      return null;
  }
}

function argSummary(primitive: string, args: unknown[], secrets: ReadonlySet<string>): string[] {
  // 规则文本、组与策略名、检测地址、进程路径都不是秘密；配置路径只记文件名；资源 key 可能含读取令牌，按 maskResourceKey 遮盖。
  if (primitive === 'checkProfile') return args.map((a) => String(a).slice(String(a).lastIndexOf('/') + 1));
  if (primitive === 'updateExternalResource') return args.map((a) => maskResourceKey(String(a), secrets).slice(0, 300));
  if (primitive === 'matchRule') {
    const m = (typeof args[0] === 'object' && args[0] !== null ? args[0] : {}) as Record<string, unknown>;
    return [m.host, m.processPath, m.protocol ?? 'TCP', m.port ?? 443].map((v) => String(v).slice(0, 300));
  }
  return args.map((a) => String(a).slice(0, 300));
}

export function createGuardedAdapter(
  inner: SurgeAdapter,
  guard: WriteGuard,
  log: (entry: CallLogEntry) => void,
  now: () => Date = () => new Date(),
): SurgeAdapter {
  const lastActive = new Map<string, SurgeRequestRecord>();
  const wrapped = { mechanism: () => inner.mechanism() } as Record<string, unknown>;
  for (const p of SURGE_PRIMITIVES) {
    wrapped[p] = async (...args: unknown[]) => {
      const started = Date.now();
      const reason = guardReason(guard, p, args, lastActive);
      if (reason !== null) {
        log({ at: now().toISOString(), primitive: p, args: argSummary(p, args, guard.secrets), ms: 0, ok: false, code: 'P0_GUARD' });
        throw new SfeError('CAPABILITY_UNVERIFIED', `P0 写入守卫拒绝 ${p}：${reason}`);
      }
      try {
        const result = await (inner[p] as (...a: unknown[]) => Promise<unknown>).apply(inner, args);
        if (p === 'listActiveRequests' && Array.isArray(result)) {
          lastActive.clear();
          for (const r of result as SurgeRequestRecord[]) lastActive.set(r.id, r);
        }
        log({ at: now().toISOString(), primitive: p, args: argSummary(p, args, guard.secrets), ms: Date.now() - started, ok: true, code: null });
        return result;
      } catch (e) {
        log({ at: now().toISOString(), primitive: p, args: argSummary(p, args, guard.secrets), ms: Date.now() - started, ok: false, code: e instanceof SfeError ? e.code : 'ERROR' });
        throw e;
      }
    };
  }
  return wrapped as unknown as SurgeAdapter;
}

export interface AdapterParts {
  cliPath: string | null;
  httpApi: { key: string; port: number } | null;
  mechanism: MechanismMap;
  scrub?: (s: string) => string;
}

/** 按固定映射组合 CLI 与 HTTP 实现；不在运行时根据成败换用另一种。单 key 更新的时限与服务相同（超时是结果不明，从不重放）。 */
export function createP0Adapter(parts: AdapterParts): SurgeAdapter {
  const scrub = parts.scrub ?? ((s: string) => s);
  const timeoutsMs = { updateExternalResource: RESOURCE_UPDATE_TIMEOUT_MS };
  const cli = parts.cliPath ? createCliAdapter({ cliPath: parts.cliPath, mechanism: parts.mechanism, scrub, timeoutsMs }) : undefined;
  const http = parts.httpApi
    ? createHttpAdapter({ baseUrl: `http://127.0.0.1:${parts.httpApi.port}`, getKey: async () => parts.httpApi!.key, mechanism: parts.mechanism, scrub, timeoutsMs })
    : undefined;
  return createCompositeAdapter({ cli, http, mechanism: parts.mechanism });
}

export function allMechanism(value: 'cli' | 'http'): MechanismMap {
  return Object.fromEntries(SURGE_PRIMITIVES.map((p) => [p, value]));
}

export function errorCode(e: unknown): string {
  return e instanceof SfeError ? e.code : 'ERROR';
}

/**
 * `surge-cli --raw version` 的结果，供与运行实例交叉核对（与服务 engine/context.ts 的 readCliVersion 同一规则）：
 * 'unsupported' = 命令不被支持（Unknown command 或交互模式提示；`version` 是 Mac 6.8.0 才有的命令）；读不到或结构不对为
 * null。只保留版本、构建号、Core 版本与 Controller 协议号（适配器已丢弃系统与设备字段）。
 */
export async function readCliVersion(adapter: Pick<SurgeAdapter, 'getVersion'>): Promise<SurgeVersion | 'unsupported' | null> {
  let v: unknown;
  try {
    v = await adapter.getVersion();
  } catch (e) {
    return isUnsupportedCommandError(e) ? 'unsupported' : null;
  }
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.version !== 'string' || typeof o.build !== 'string' || typeof o.controllerProtocol !== 'number' || typeof o.coreVersion !== 'number') return null;
  return { version: o.version, build: o.build, controllerProtocol: o.controllerProtocol, coreVersion: o.coreVersion };
}
