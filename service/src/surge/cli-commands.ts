// Surge CLI 原语表（目标 Surge Mac 6.10.0；最低支持 6.10.0、构建 12500、Controller 协议 22，见 running-instance.ts）。
// 每个原语对应固定的 argv 与输出解析（只接受已知结构，无法识别即报错，见 parse-output.ts）。命令与参数以官方文档为准：
// 手册 https://manual.nssurge.com/tools/cli.html、随包技能 Skills/surge/references/command-reference.md、内置帮助
// （surge-cli help <command>）。文档没有定义的 --raw 输出键名在 parse-output.ts 中逐项标 TODO(P0)；evidence 为
// 'unverified' 的映射要在测试 Mac 上核对后才由 P0 写入原语清单（安装配置的 adapterMechanism）。
// 每条 argv 必须完全符合 CLI_ARGV_ALLOWLIST 中的一项（固定前缀 + 个数与校验都对的参数），cli-adapter 在执行前再查一次；
// 全局动作——reload、restart-engine、switch-profile / profile switch、mode set、global-policy set、feature set、module、
// set、stop、managed-profile update、update-profile、rule temp flush / flush-temp-rule、external-resource update all、
// flush dns 等——没有任何一项可达。
// 读命令用 --raw（手册：“use `--raw` for automation”）；写命令不加 --raw，保留命令行工具的命令校验（随包技能：不加时
// “the CLI rejects commands it does not know instead of passing them to the controller”），成功即退出 0（6.8.0 起
// “Command errors are now written to standard error and produce a non-zero exit status.”）。

import { ROUTE_GROUP_NAME, SfeError } from '@sfe/contract';
import type { SurgeAdapter, SurgeRuleMatchInput } from '../ports.js';
import {
  parseExternalResources,
  parseFeatureEnabled,
  parseJsonLoose,
  parseOutboundMode,
  parsePerformanceUptime,
  parsePolicyGroupGet,
  parsePolicyGroupList,
  parsePolicyNames,
  parseRequestRecords,
  parseResourceUpdateText,
  parseRuleList,
  parseRuleMatch,
  parseStatusProfile,
  parseSurgeVersion,
  parseTempRuleList,
  unrecognized,
} from './parse-output.js';
import type { SurgePrimitive } from './primitives.js';
import { truncate } from './primitives.js';

/**
 * documented：命令、参数与本表依赖的结果判断都写在官方文档中（写命令以退出 0 为成功，之后由调用方运行时读回）；
 * unverified：依赖文档没有定义的输出（--raw 的键名、渲染文字、连接 id 的来源等），需 P0 在测试 Mac 上核对。
 */
export type CliEvidence = 'documented' | 'unverified';

export interface CliOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface CliParseContext {
  /** 自由文本脱敏（按值 + 按行规则）。 */
  scrub: (text: string) => string;
  now: () => Date;
}

/** 一条命令。 */
export interface CliCommand<A extends unknown[], R> {
  evidence: CliEvidence;
  argv: (...args: A) => string[];
  parse: (out: CliOutput, ctx: CliParseContext, args: A) => R;
  /** 非零退出码是正常结果（--check 校验未通过），不是命令失败。 */
  nonZeroExitIsResult?: boolean;
}

/** 依次执行的几条只读命令（任一条失败即整体失败，从不部分返回）。 */
export interface CliSequence<A extends unknown[], R> {
  evidence: CliEvidence;
  argvs: (...args: A) => string[][];
  parseAll: (outs: CliOutput[], ctx: CliParseContext, args: A) => R;
}

type Args<P extends SurgePrimitive> = Parameters<SurgeAdapter[P]>;
type Result<P extends SurgePrimitive> = Awaited<ReturnType<SurgeAdapter[P]>>;
type CommandFor<P extends SurgePrimitive> = CliCommand<Args<P>, Result<P>> | CliSequence<Args<P>, Result<P>>;
export type CliCommandTable = { [P in SurgePrimitive]?: CommandFor<P> };

function isSafeArgValue(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\0\r\n]/.test(value) && !value.startsWith('-');
}

/** argv 只放路径、资源 key、规则文本、名称：拒绝空值、换行、NUL，以及会被当作选项的“-”开头值。 */
export function safeArg(value: unknown, label: string): string {
  if (!isSafeArgValue(value)) {
    throw new SfeError('VALIDATION_FAILED', `执行 Surge 命令失败：参数不合法（${label}）`);
  }
  return value;
}

/** 可能被解释为“全部”的资源 key（文档：“Use "all" as the key to update all remote resources.”）。 */
const ALL_RESOURCES_RE = /^(all|\*|everything)$/i;

/** 资源 key 另外不能是 all/* 等可能被解释为“全部”的值。 */
export function safeResourceKey(key: unknown): string {
  const k = safeArg(key, '资源 key');
  if (ALL_RESOURCES_RE.test(k.trim())) throw new SfeError('VALIDATION_FAILED', '执行 Surge 命令失败：只能按单个资源 key 更新');
  return k;
}

/**
 * 像是含 URL 或本机资源服务读取令牌（64 位十六进制，D10）的资源 key：不能放进 surge-cli 的 argv（CLAUDE.md：凭据不进命令行参数）。
 * 纵深防御：发布先按 resource-key.ts resourceUpdateRoute 选择实现，这里在执行前再拒绝一次。
 */
const CLI_TOKEN_LIKE_KEY_RE = /:\/\/|[0-9a-f]{64}/i;

/** 经 CLI 更新的资源 key：safeResourceKey 之外不能像是含 URL 或读取令牌（错误信息不回显 key）。 */
export function safeCliResourceKey(key: unknown): string {
  const k = safeResourceKey(key);
  if (CLI_TOKEN_LIKE_KEY_RE.test(k)) {
    throw new SfeError('VALIDATION_FAILED', '执行 Surge 命令失败：资源 key 可能含读取令牌，不能作为命令行参数');
  }
  return k;
}

/** `policy-group set` 只用于 SFE-ROUTE，且选项不能是 auto（它清除自动组覆盖，不是选择一个策略）。 */
export function safeRouteSelection(group: unknown, policy: unknown): [string, string] {
  if (group !== ROUTE_GROUP_NAME) throw new SfeError('VALIDATION_FAILED', `执行 Surge 命令失败：只能选择 ${ROUTE_GROUP_NAME}`);
  const p = safeArg(policy, '策略名');
  if (p.trim().toLowerCase() === 'auto') throw new SfeError('VALIDATION_FAILED', '执行 Surge 命令失败：不能用 auto 作为选择');
  return [group, p];
}

const CONNECTION_ID_RE = /^\d{1,19}$/;

/** `kill <connection-id>`（“Terminate an active connection.”）只接受数字 id：一次只结束一个连接。 */
export function safeConnectionId(id: unknown): string {
  if (typeof id !== 'string' || !CONNECTION_ID_RE.test(id)) throw new SfeError('VALIDATION_FAILED', '执行 Surge 命令失败：连接编号不合法');
  return id;
}

const HOSTNAME_RE = /^(?=.{1,253}$)([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
export const RULE_MATCH_PROTOCOLS = ['TCP', 'UDP', 'HTTP', 'HTTPS', 'QUIC'] as const;

/**
 * `rule match <host> process-path=<path> protocol=<name> dest-port=<port>` 的参数（内置帮助 `help rule match`：
 * process-path “Source process path; affects PROCESS-NAME rules”；protocol “such as TCP, UDP, HTTP, HTTPS, QUIC, or STUN”；
 * dest-port “Destination port (alias: port)”；“A hostname defaults to TCP port 443”）。协议与端口总是显式给出（缺省值与
 * 文档的缺省相同），argv 的形状因此固定。TODO(P0)：含空格的进程路径作为单个 argv 元素是否被完整接受。
 */
export function ruleMatchArgs(input: SurgeRuleMatchInput): string[] {
  if (typeof input !== 'object' || input === null) throw new SfeError('VALIDATION_FAILED', '执行 Surge 命令失败：规则求值参数不合法');
  const host = safeArg(input.host, '主机名');
  if (!HOSTNAME_RE.test(host)) throw new SfeError('VALIDATION_FAILED', '执行 Surge 命令失败：参数不合法（主机名）');
  const path = safeArg(input.processPath, '进程路径');
  if (!path.startsWith('/')) throw new SfeError('VALIDATION_FAILED', '执行 Surge 命令失败：参数不合法（进程路径）');
  const protocol = input.protocol ?? 'TCP';
  if (!(RULE_MATCH_PROTOCOLS as readonly string[]).includes(protocol)) throw new SfeError('VALIDATION_FAILED', '执行 Surge 命令失败：参数不合法（协议）');
  const port = input.port ?? 443;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new SfeError('VALIDATION_FAILED', '执行 Surge 命令失败：参数不合法（端口）');
  return [host, `process-path=${path}`, `protocol=${protocol}`, `dest-port=${port}`];
}

// ---------- 允许清单 ----------

type ArgCheck = (v: string) => boolean;

export interface CliArgvRule {
  /** 必须逐项相等的固定前缀。 */
  prefix: readonly string[];
  /** 前缀之后的参数：个数必须相等，每个都要通过对应的校验。 */
  args: readonly ArgCheck[];
}

const anyArg: ArgCheck = (v) => isSafeArgValue(v);
const absolutePath: ArgCheck = (v) => isSafeArgValue(v) && v.startsWith('/');
const singleResourceKey: ArgCheck = (v) => isSafeArgValue(v) && !ALL_RESOURCES_RE.test(v.trim()) && !CLI_TOKEN_LIKE_KEY_RE.test(v);
const routeOption: ArgCheck = (v) => isSafeArgValue(v) && v.trim().toLowerCase() !== 'auto';
const connectionId: ArgCheck = (v) => CONNECTION_ID_RE.test(v);
const hostname: ArgCheck = (v) => HOSTNAME_RE.test(v);
const option =
  (key: string, check: (value: string) => boolean): ArgCheck =>
  (v) =>
    v.startsWith(`${key}=`) && check(v.slice(key.length + 1));

/**
 * 允许执行的全部 argv。只读命令带 --raw；写命令只有四种，且参数都被限制在单个对象上：SFE-ROUTE 的选择（不能是 auto）、
 * 单个数字连接 id、单个资源 key（不能是 all，也不能像是含 URL 或读取令牌）、单条临时规则。
 */
export const CLI_ARGV_ALLOWLIST: readonly CliArgvRule[] = [
  { prefix: ['--check'], args: [absolutePath] },
  { prefix: ['--raw', 'version'], args: [] },
  { prefix: ['--raw', 'status'], args: [] },
  { prefix: ['--raw', 'feature', 'get', 'enhanced-mode'], args: [] },
  { prefix: ['--raw', 'feature', 'get', 'system-proxy'], args: [] },
  { prefix: ['--raw', 'mode', 'get'], args: [] },
  { prefix: ['--raw', 'dump', 'performance'], args: [] },
  { prefix: ['--raw', 'dump', 'policy'], args: [] },
  { prefix: ['--raw', 'dump', 'rule'], args: [] },
  { prefix: ['--raw', 'dump', 'active'], args: [] },
  { prefix: ['--raw', 'dump', 'recent'], args: [] },
  { prefix: ['--raw', 'dump', 'temp-rule'], args: [] },
  { prefix: ['--raw', 'policy-group', 'get'], args: [anyArg] },
  { prefix: ['--raw', 'policy-group', 'list'], args: [] },
  { prefix: ['--raw', 'external-resource', 'list'], args: [] },
  {
    prefix: ['--raw', 'rule', 'match'],
    args: [
      hostname,
      option('process-path', (p) => p.startsWith('/') && isSafeArgValue(p)),
      option('protocol', (p) => (RULE_MATCH_PROTOCOLS as readonly string[]).includes(p)),
      option('dest-port', (p) => /^\d{1,5}$/.test(p) && Number(p) <= 65535),
    ],
  },
  { prefix: ['external-resource', 'update'], args: [singleResourceKey] },
  { prefix: ['rule', 'temp', 'add'], args: [anyArg] },
  { prefix: ['rule', 'temp', 'remove'], args: [anyArg] },
  { prefix: ['policy-group', 'set', ROUTE_GROUP_NAME], args: [routeOption] },
  { prefix: ['kill'], args: [connectionId] },
];

/** argv 是否完全符合允许清单中的一项（逐项精确比较，大小写敏感）。 */
export function isAllowedCliArgv(argv: readonly string[]): boolean {
  return CLI_ARGV_ALLOWLIST.some(
    (rule) =>
      argv.length === rule.prefix.length + rule.args.length &&
      rule.prefix.every((w, i) => argv[i] === w) &&
      rule.args.every((check, i) => {
        const v = argv[rule.prefix.length + i];
        return typeof v === 'string' && check(v);
      }),
  );
}

function jsonOrThrow(text: string, what: string): unknown {
  const json = parseJsonLoose(text);
  if (json === undefined) throw unrecognized(what);
  return json;
}

/** 引擎启动时间：读取时刻减去运行时长，取整到秒（两次读取之间可能相差 1 秒，见 SurgeRuntimeInfo）。 */
function startedAtFromUptime(now: Date, uptimeSeconds: number): Date {
  return new Date(Math.floor((now.getTime() - uptimeSeconds * 1000) / 1000) * 1000);
}

export const CLI_COMMANDS: CliCommandTable = {
  // TODO(P0)：`--check` 对无效配置的退出码（文档只有 6.8.0 的通用说明：命令错误退出非零）。
  checkProfile: {
    evidence: 'unverified',
    argv: (path) => ['--check', safeArg(path, '配置路径')],
    nonZeroExitIsResult: true,
    parse: (out, ctx) => ({ ok: out.exitCode === 0, message: truncate(ctx.scrub(`${out.stdout}\n${out.stderr}`), 2000) }),
  },
  // Mac 6.8.0+：“version | Show Surge, Core, Controller protocol, operating-system, and device versions.”
  getVersion: {
    evidence: 'unverified',
    argv: () => ['--raw', 'version'],
    parse: (out) => parseSurgeVersion(jsonOrThrow(out.stdout, 'Surge 版本')),
  },
  // Mac 6.9.0+、协议 ≥22：“dump performance | Show engine memory usage, uptime, …”。
  getRuntimeInfo: {
    evidence: 'unverified',
    argv: () => ['--raw', 'dump', 'performance'],
    parse: (out, ctx) => {
      const uptimeSeconds = parsePerformanceUptime(jsonOrThrow(out.stdout, '引擎运行时长'));
      return { uptimeSeconds, startedAt: startedAtFromUptime(ctx.now(), uptimeSeconds) };
    },
  },
  // Mac 6.8.0+：随包技能 §3.14 “`status` displays the active profile's absolute path in `profile-path`”。
  getCurrentProfile: {
    evidence: 'unverified',
    argv: () => ['--raw', 'status'],
    parse: (out) => parseStatusProfile(jsonOrThrow(out.stdout, '当前配置')),
  },
  // Mac 6.8.0+：只读的 `feature get <name>`（“macOS also supports system-proxy and enhanced-mode”）与 `mode get`；
  // 从不使用 feature set / mode set。
  getTakeoverState: {
    evidence: 'unverified',
    argvs: () => [
      ['--raw', 'feature', 'get', 'enhanced-mode'],
      ['--raw', 'feature', 'get', 'system-proxy'],
      ['--raw', 'mode', 'get'],
    ],
    parseAll: ([enhanced, system, mode], ctx) => ({
      enhancedMode: parseFeatureEnabled(jsonOrThrow(enhanced!.stdout, '功能状态'), 'enhanced-mode'),
      systemProxy: parseFeatureEnabled(jsonOrThrow(system!.stdout, '功能状态'), 'system-proxy'),
      outboundMode: parseOutboundMode(jsonOrThrow(mode!.stdout, '出站模式')),
      checkedAt: ctx.now().toISOString(),
    }),
  },
  listPolicies: {
    evidence: 'unverified',
    argv: () => ['--raw', 'dump', 'policy'],
    // 只取名称；输出中可能出现的节点参数不保留。
    parse: (out) => parsePolicyNames(jsonOrThrow(out.stdout, '策略列表')),
  },
  // Mac 6.8.0+：“policy-group list | get <group> | set <group> <policy|auto>”。
  getGroupMembers: {
    evidence: 'unverified',
    argv: () => ['--raw', 'policy-group', 'list'],
    parse: (out, _ctx, [group]) => {
      const found = parsePolicyGroupList(jsonOrThrow(out.stdout, '策略组')).filter((g) => g.name === group);
      if (found.length === 0) throw new SfeError('SURGE_COMMAND_FAILED', '读取策略组失败：组不存在', { details: { group } });
      if (found.length > 1) throw unrecognized('策略组');
      return found[0]!.options;
    },
  },
  getGroupSelection: {
    evidence: 'unverified',
    argv: (group) => ['--raw', 'policy-group', 'get', safeArg(group, '策略组名')],
    parse: (out, _ctx, [group]) => parsePolicyGroupGet(jsonOrThrow(out.stdout, '策略组'), group).selected,
  },
  // 写：只选择 SFE-ROUTE（随包技能：`surge-cli policy-group set "Proxy" "HK"  # select-group choice`）；结果由调用方读回确认。
  selectGroupPolicy: {
    evidence: 'documented',
    argv: (group, policy) => ['policy-group', 'set', ...safeRouteSelection(group, policy)],
    parse: () => undefined,
  },
  listRules: {
    evidence: 'unverified',
    argv: () => ['--raw', 'dump', 'rule'],
    parse: (out, ctx) => parseRuleList(out.stdout, ctx.scrub),
  },
  // Mac 6.9.0+、协议 ≥20：“Evaluate the active rule set without creating a connection, then show the matched rule and final policy.”
  matchRule: {
    evidence: 'unverified',
    argv: (input) => ['--raw', 'rule', 'match', ...ruleMatchArgs(input)],
    parse: (out, ctx) => parseRuleMatch(jsonOrThrow(out.stdout, '规则求值'), ctx.scrub),
  },
  listActiveRequests: {
    evidence: 'unverified',
    argv: () => ['--raw', 'dump', 'active'],
    parse: (out) => parseRequestRecords(jsonOrThrow(out.stdout, '活动请求')),
  },
  listRecentRequests: {
    evidence: 'unverified',
    // `dump recent` 返回 { requests: [...] }（随包技能 §1.2 的 requests 载荷）；`dump request` 是 active/recent 的组合，
    // 不是最近请求列表。--raw 的记录字段未写入文档（TODO(P0)）。
    argv: () => ['--raw', 'dump', 'recent'],
    parse: (out) => parseRequestRecords(jsonOrThrow(out.stdout, '最近请求')),
  },
  // 写：“Usage: kill <connection-id> / Terminate an active connection.”——只结束一个连接。
  // TODO(P0)：请求记录中哪个字段是这里的 connection-id（P0 只允许结束已确认 Safari 进程的连接）。
  killRequest: {
    evidence: 'unverified',
    argv: (id) => ['kill', safeConnectionId(id)],
    parse: () => undefined,
  },
  listExternalResources: {
    evidence: 'unverified',
    argv: () => ['--raw', 'external-resource', 'list'],
    parse: (out) => parseExternalResources(jsonOrThrow(out.stdout, '外部资源')),
  },
  // 写：单个 key（从不 all）。本地资源被跳过（HTTP API 文档：“Local resources are skipped.”），结果从不算作刷新。
  // 像是含 URL 或读取令牌的 key 不进 argv（本机节点资源的 key 先经 resource-key.ts 检查，见 safeCliResourceKey）。
  updateExternalResource: {
    evidence: 'unverified',
    argv: (key) => ['external-resource', 'update', safeCliResourceKey(key)],
    parse: (out, ctx, [key]) => parseResourceUpdateText(out.stdout, key, ctx.scrub),
  },
  // 随包技能 §3.9：`rule temp <list|add|remove|…>` 对应控制器命令 `dump temp-rule`、`add-temp-rule`、`del-temp-rule`。
  listTempRules: {
    evidence: 'unverified',
    argv: () => ['--raw', 'dump', 'temp-rule'],
    parse: (out) => parseTempRuleList(out.stdout),
  },
  // 写（Mac 6.9.0+、协议 ≥20）：“rule temp add <rule> Add a temporary rule with the highest priority”。
  // 多条临时规则之间的顺序没有写入文档：插入位置（TempRuleStrategyDeps.insertion）由 P0 实测后才固定。
  addTempRule: {
    evidence: 'documented',
    argv: (rule) => ['rule', 'temp', 'add', safeArg(rule, '规则')],
    parse: () => undefined,
  },
  // 写：“rule temp remove <rule> Remove one temporary rule by its exact text”。
  removeTempRule: {
    evidence: 'documented',
    argv: (rule) => ['rule', 'temp', 'remove', safeArg(rule, '规则')],
    parse: () => undefined,
  },
};

/** 原语在表中对应的全部 argv（单条命令为一项）；表中没有时为 null。参数不合法时抛 VALIDATION_FAILED。 */
export function cliArgvs(primitive: SurgePrimitive, args: readonly unknown[]): string[][] | null {
  const cmd = CLI_COMMANDS[primitive] as CliCommand<unknown[], unknown> | CliSequence<unknown[], unknown> | undefined;
  if (!cmd) return null;
  return 'argvs' in cmd ? cmd.argvs(...args) : [cmd.argv(...args)];
}
