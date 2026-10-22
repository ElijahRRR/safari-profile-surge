// P0 使用的 Surge 访问：复用服务的 CLI/HTTP/组合适配器（同一受限原语集合，没有切换配置、重载全部、
// flush、接管或出站写入），外加一层写入守卫与调用记录：
// - 组选择只允许 SFE-ROUTE，且必须确认当前是测试配置；
// - 资源刷新只允许本工具创建的测试文件对应的 key；
// - 临时规则的增删只允许运行状态中先登记过的精确规则；
// - 结束请求只允许最近一次列出的、进程路径属于已确认 Safari 路径的请求。

import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SfeError } from '@sfe/contract';
import {
  CLI_COMMANDS,
  FORBIDDEN_CLI_WORDS,
  INTERACTIVE_BANNER_RE,
  SURGE_PRIMITIVES,
  createCliAdapter,
  createCompositeAdapter,
  createHttpAdapter,
  type MechanismMap,
  type SurgeAdapter,
  type SurgeExternalResource,
  type SurgeRequestRecord,
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

// 模块 B 的 HTTP 实现对这些原语不发请求、直接 CAPABILITY_UNVERIFIED（6.5 上未核对或标注 6.9+/6.10+）。
export const HTTP_NOT_IMPLEMENTED: readonly Primitive[] = [
  'getVersion',
  'getRuntimeInfo',
  'getAutoReloadSetting',
  'checkProfile',
  'listExternalResources',
  'updateExternalResource',
  'listTempRules',
  'addTempRule',
  'removeTempRule',
];

const DUMMY_ARGS: Partial<Record<Primitive, unknown[]>> = {
  checkProfile: ['/p0-dummy.conf'],
  updateExternalResource: ['p0-dummy-key'],
  addTempRule: ['P0-DUMMY-RULE'],
  removeTempRule: ['P0-DUMMY-RULE'],
};

/** 帮助文本中出现的命令词与选项（只用于判断原语对应的命令是否存在）。 */
export function helpWords(help: string): Set<string> {
  const words = new Set<string>();
  for (const m of help.matchAll(/(?:^|[\s[(|,])(--?[A-Za-z][A-Za-z0-9-]*|[a-z][a-z0-9-]*)(?=$|[\s\]),|=:])/gm)) words.add(m[1]!);
  return words;
}

/**
 * 解析 --help 的输出。输出是交互模式提示（帮助参数没有被识别）时命令词按空处理：不能从提示文字推断
 * 任何命令存在，也就不经 CLI 探测任何原语。
 */
export function parseCliHelp(help: string): { words: Set<string>; interactive: boolean } {
  if (INTERACTIVE_BANNER_RE.test(help)) return { words: new Set(), interactive: true };
  return { words: helpWords(help), interactive: false };
}

/** CLI 原语表中该原语的固定命令词（去掉参数）；表中没有时为 null。 */
export function cliLiteralWords(primitive: Primitive): string[] | null {
  const cmd = (CLI_COMMANDS as Record<string, { argv: (...a: unknown[]) => string[] } | undefined>)[primitive];
  if (!cmd) return null;
  const dummies = DUMMY_ARGS[primitive] ?? [];
  const argv = cmd.argv(...dummies);
  return argv.filter((w) => !dummies.includes(w));
}

export function argvHasForbiddenWord(words: readonly string[]): boolean {
  return words.some((w) => (FORBIDDEN_CLI_WORDS as readonly string[]).includes(w.toLowerCase()));
}

export type CliAvailability = 'not_in_table' | 'not_in_help' | 'in_help' | 'forbidden';

export function cliAvailability(primitive: Primitive, words: ReadonlySet<string>): CliAvailability {
  const lit = cliLiteralWords(primitive);
  if (lit === null) return 'not_in_table';
  if (argvHasForbiddenWord(lit)) return 'forbidden';
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
}

export function emptyGuard(): WriteGuard {
  return { onTestProfile: false, refreshableKeys: new Set(), tempRules: new Set(), killablePaths: new Set(), testablePolicies: new Set() };
}

function guardReason(g: WriteGuard, primitive: string, args: unknown[], lastActive: Map<string, SurgeRequestRecord>): string | null {
  switch (primitive) {
    case 'selectGroupPolicy':
      if (!g.onTestProfile) return '当前不是 P0 测试配置';
      return args[0] === 'SFE-ROUTE' ? null : '只允许选择 SFE-ROUTE';
    case 'updateExternalResource':
      if (!g.onTestProfile) return '当前不是 P0 测试配置';
      return g.refreshableKeys.has(String(args[0])) ? null : '只允许刷新本工具创建的测试资源';
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

function argSummary(primitive: string, args: unknown[]): string[] {
  // 规则文本、资源 key、组与策略名、检测地址都不是秘密；配置路径只记文件名。
  if (primitive === 'checkProfile') return args.map((a) => String(a).slice(String(a).lastIndexOf('/') + 1));
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
        log({ at: now().toISOString(), primitive: p, args: argSummary(p, args), ms: 0, ok: false, code: 'P0_GUARD' });
        throw new SfeError('CAPABILITY_UNVERIFIED', `P0 写入守卫拒绝 ${p}：${reason}`);
      }
      try {
        const result = await (inner[p] as (...a: unknown[]) => Promise<unknown>).apply(inner, args);
        if (p === 'listActiveRequests' && Array.isArray(result)) {
          lastActive.clear();
          for (const r of result as SurgeRequestRecord[]) lastActive.set(r.id, r);
        }
        log({ at: now().toISOString(), primitive: p, args: argSummary(p, args), ms: Date.now() - started, ok: true, code: null });
        return result;
      } catch (e) {
        log({ at: now().toISOString(), primitive: p, args: argSummary(p, args), ms: Date.now() - started, ok: false, code: e instanceof SfeError ? e.code : 'ERROR' });
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

/** 按固定映射组合 CLI 与 HTTP 实现；不在运行时根据成败换用另一种。 */
export function createP0Adapter(parts: AdapterParts): SurgeAdapter {
  const scrub = parts.scrub ?? ((s: string) => s);
  const cli = parts.cliPath ? createCliAdapter({ cliPath: parts.cliPath, mechanism: parts.mechanism, scrub }) : undefined;
  const http = parts.httpApi
    ? createHttpAdapter({ baseUrl: `http://127.0.0.1:${parts.httpApi.port}`, getKey: async () => parts.httpApi!.key, mechanism: parts.mechanism, scrub })
    : undefined;
  return createCompositeAdapter({ cli, http, mechanism: parts.mechanism });
}

export function allMechanism(value: 'cli' | 'http'): MechanismMap {
  return Object.fromEntries(SURGE_PRIMITIVES.map((p) => [p, value]));
}

export function errorCode(e: unknown): string {
  return e instanceof SfeError ? e.code : 'ERROR';
}
