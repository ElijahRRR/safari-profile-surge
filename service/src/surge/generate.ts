// 节点行、资源文件与入口规则的受控序列化。每个字段逐项校验后才拼接，永不拼接原始表格文本；
// 错误信息只给字段与原因，不回显值。见 docs/ARCHITECTURE.md §5.4、§5.5。

import { isIP } from 'node:net';
import {
  ENTRY_PLACEHOLDER_RULE,
  ENTRY_RULESET_FILES,
  ENTRY_WITNESS_PROCESS_PATH,
  NODE_RESOURCE_FILE,
  ROUTE_GROUP_NAME,
  SfeError,
  isSfeName,
  type EntryBits,
  type FieldError,
} from '@sfe/contract';
import { isSurgeReferenceName, isSurgeSafeCredential, validateHost, validatePort } from '../domain/validate.js';
import { BUILTIN_POLICIES, isCommentLine, normalizeRuleText } from './rules.js';

export type EntryBit = keyof EntryBits;

/** 规则顺序即主配置中 RULE-SET 的顺序：udp > verify > block > active。 */
export const ENTRY_BITS_IN_ORDER: readonly EntryBit[] = ['udp', 'verify', 'block', 'active'];

export const ENTRY_BIT_POLICY: Record<EntryBit, string> = {
  udp: 'REJECT',
  verify: ROUTE_GROUP_NAME,
  block: 'REJECT',
  active: ROUTE_GROUP_NAME,
};

export interface NodeLineInput {
  name: string;
  host: string;
  port: number;
  username: string | null;
  password: string | null;
  /** 前置节点名（用户已有的固定节点）。所有环境节点都必须经前置。 */
  front: string;
}

/** SFE-N-… = socks5, host, port, username=…, password=…, underlying-proxy=前置 */
export function nodeLine(input: NodeLineInput): string {
  if (typeof input.name !== 'string' || !isSfeName(input.name)) {
    throw new SfeError('VALIDATION_FAILED', '生成节点失败：节点名不合法', { fieldErrors: [{ field: 'name', message: '节点名不合法' }] });
  }
  const fieldErrors: FieldError[] = [...validateHost(input.host), ...validatePort(input.port)];
  const front = input.front;
  if (
    typeof front !== 'string' ||
    !isSurgeReferenceName(front) ||
    /^SFE-/i.test(front) ||
    BUILTIN_POLICIES.has(front.toUpperCase())
  ) {
    fieldErrors.push({ field: 'proxy.frontProxy', message: '前置必须是用户已有的固定节点' });
  }
  if (fieldErrors.length > 0) throw new SfeError('VALIDATION_FAILED', '生成节点失败：字段校验未通过', { fieldErrors });
  const credErrors: FieldError[] = [];
  for (const [field, value] of [
    ['proxy.username', input.username],
    ['proxy.password', input.password],
  ] as const) {
    if (value !== null && (typeof value !== 'string' || !isSurgeSafeCredential(value))) {
      credErrors.push({ field, message: '只能包含字母、数字和 . _ ~ -' });
    }
  }
  if (credErrors.length > 0) {
    throw new SfeError('UNSAFE_CREDENTIAL_CHARS', '生成节点失败：凭据含当前 Surge 语法中尚未证明安全的字符', { fieldErrors: credErrors });
  }
  const parts = [`${input.name} = socks5`, input.host, String(input.port)];
  if (input.username !== null) parts.push(`username=${input.username}`);
  if (input.password !== null) parts.push(`password=${input.password}`);
  parts.push(`underlying-proxy=${front}`);
  return parts.join(', ');
}

function assertSingleLines(lines: readonly string[], what: string): void {
  for (const l of lines) {
    if (typeof l !== 'string' || /[\r\n\0]/.test(l)) throw new SfeError('VALIDATION_FAILED', `生成${what}失败：内容含换行`);
  }
}

/** 节点资源文件：文件头只含配置代数，不含摘要。 */
export function resourceFile(generation: number, lines: readonly string[]): string {
  if (!Number.isSafeInteger(generation) || generation < 0) throw new SfeError('VALIDATION_FAILED', '生成节点资源失败：配置代数不正确');
  assertSingleLines(lines, '节点资源');
  return [`# SFE managed resource · generation ${generation}`, ...lines, ''].join('\n');
}

/** [Proxy Group] 受管理段内容：首成员明确为 REJECT，选择失效时不会落到其他买家出口。 */
export function groupBlockLines(): string[] {
  return [`${ROUTE_GROUP_NAME} = select, REJECT, policy-path=${NODE_RESOURCE_FILE}`];
}

// 进程路径里出现这些字符会破坏规则语法或带来歧义。
// eslint-disable-next-line no-control-regex
const PATH_FORBIDDEN_RE = /[,()#;"'*?[\]{}=\u0000-\u001f\u007f]/;

/**
 * 所有 WebKit 应用共用的系统级位置。Safari 自带的 WebKit 副本（例如 App 加密卷宗中的路径）
 * 不在此列：它是否只属于 Safari 由 P0 证据（Chrome 与其他 WebKit 应用不命中）决定。
 */
const GENERIC_WEBKIT_PREFIXES = [
  '/System/Library/Frameworks/WebKit.framework/',
  '/System/Library/PrivateFrameworks/WebKit',
  '/System/Volumes/Preboot/Cryptexes/OS/System/Library/Frameworks/WebKit.framework/',
  // Surge request attribution can expose the staged OS cryptex path as well.
  '/System/Volumes/Preboot/Cryptexes/Incoming/OS/System/Library/Frameworks/WebKit.framework/',
  '/System/Cryptexes/OS/System/Library/Frameworks/WebKit.framework/',
];

/**
 * Safari 进程路径：绝对路径、不含通配与规则分隔符、不是裸进程名、不是系统级通用 WebKit 路径；
 * 存在性检查可注入（测试与非 macOS 环境）。
 */
export function validateSafariProcessPaths(paths: unknown, opts: { exists?: (path: string) => boolean } = {}): FieldError[] {
  if (!Array.isArray(paths) || paths.length === 0) return [{ field: 'safariProcessPaths', message: '至少需要一个 Safari 进程路径' }];
  const errors: FieldError[] = [];
  const seen = new Set<string>();
  paths.forEach((p, i) => {
    const field = `safariProcessPaths[${i}]`;
    if (typeof p !== 'string' || p.length === 0 || p.length > 1024) {
      errors.push({ field, message: '进程路径格式不正确' });
      return;
    }
    if (p.trim() !== p) errors.push({ field, message: '进程路径前后不能有空格' });
    else if (!p.startsWith('/')) errors.push({ field, message: '必须是完整的绝对路径，不能是进程名' });
    else if (PATH_FORBIDDEN_RE.test(p)) errors.push({ field, message: '不能包含通配符、逗号、括号或换行' });
    else if (p.endsWith('/') || p.split('/').some((seg, k) => k > 0 && (seg === '' || seg === '.' || seg === '..'))) {
      errors.push({ field, message: '路径不规范' });
    } else if (GENERIC_WEBKIT_PREFIXES.some((prefix) => p.toLowerCase().startsWith(prefix.toLowerCase()))) {
      errors.push({ field, message: '不能使用系统通用 WebKit 组件路径：其他 WebKit 应用也会命中' });
    } else if (seen.has(p)) errors.push({ field, message: '进程路径重复' });
    else if (opts.exists && !opts.exists(p)) errors.push({ field, message: '进程路径不存在' });
    seen.add(p);
  });
  return errors;
}

export interface EntryRuleOptions {
  processPaths: readonly string[];
  verifyHost: string;
}

function assertEntryOptions(opts: EntryRuleOptions): void {
  const errors = validateSafariProcessPaths([...opts.processPaths]);
  const host = opts.verifyHost;
  if (typeof host !== 'string' || validateHost(host, 'verifyHost').length > 0 || isIP(host) !== 0) {
    errors.push({ field: 'verifyHost', message: '检测主机必须是域名' });
  }
  if (errors.length > 0) throw new SfeError('VALIDATION_FAILED', '生成入口规则失败：进程路径或检测主机不合法', { fieldErrors: errors });
}

/** 单个路径为 PROCESS-NAME,p；多个路径用 OR 组合。 */
function processExpr(paths: readonly string[]): string {
  if (paths.length === 1) return `PROCESS-NAME,${paths[0]}`;
  return `OR,(${paths.map((p) => `(PROCESS-NAME,${p})`).join(',')})`;
}

/**
 * 规则集文件中某一位的规则正文（不带策略）。关闭的位写占位规则而不是空文件。
 * udp: AND,((进程),(PROTOCOL,UDP))；verify: AND,((进程),(DOMAIN,检测主机))；block/active: 每个路径一行 PROCESS-NAME。
 * 规则集的先后由工作配置中四条 RULE-SET 的顺序固定（udp > verify > block > active），所以这些条件可以相交。
 */
export function entryRules(bit: EntryBit, on: boolean, opts: EntryRuleOptions): string[] {
  assertEntryOptions(opts);
  if (!on) return [ENTRY_PLACEHOLDER_RULE];
  const proc = processExpr(opts.processPaths);
  switch (bit) {
    case 'udp':
      return [`AND,((${proc}),(PROTOCOL,UDP))`];
    case 'verify':
      return [`AND,((${proc}),(DOMAIN,${opts.verifyHost}))`];
    case 'block':
    case 'active':
      return opts.processPaths.map((p) => `PROCESS-NAME,${p}`);
  }
}

// ---------- 规则集文件的见证规则（ruleset_resource） ----------

/**
 * 见证规则：每个入口规则集文件带一条只匹配合成进程（ENTRY_WITNESS_PROCESS_PATH）请求合成主机
 * `sfe-entry-<位>-<标记>.invalid` 的规则 `AND,((PROCESS-NAME,<合成进程>),(DOMAIN,<见证主机>))`。必须限定进程：
 * 规则文档写明“Domain rules match the hostname of a request … never trigger a DNS lookup”（rules/domain.html），
 * “.invalid” 不解析并不妨碍按主机名匹配，而规则集文件继承 RULE-SET 行的策略（verify/active 为 SFE-ROUTE）——
 * 不限定进程时 Chrome 或任何网页请求这一主机都会经买家出口发出；初始化写入的固定标记 off 又是公开的。
 * 每次写入换一个随机标记；用 `rule match <见证主机> process-path=<合成进程>` 读回命中的是不是该位的 RULE-SET，就能证明
 * Surge 已加载的正是这一版内容——即使这一位被更前面的入口规则遮住、Safari 的探测看不出差别（例如 block 打开时的 active）。
 * 文档依据：本地规则集“Local files are watched and reloaded automatically when they change.”（规则集文档）；
 * `rule match`“Evaluate the active rule set without creating a connection”、“process-path=<path> Source process path;
 * affects PROCESS-NAME rules”（CLI 帮助，Mac 6.9.0+）；逻辑规则“AND,((Rule1),(Rule2),...),Policy”，规则集文件中的规则
 * 不带策略（规则文档）。
 */
export const ENTRY_WITNESS_OFF_TOKEN = 'off';
const WITNESS_TOKEN_RE = /^[0-9a-z]{2,32}$/;
const escapeRe = (t: string): string => t.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
/** 规范化之后（normalizeRuleText）的见证行。 */
const WITNESS_LINE_RE = new RegExp(
  `^AND,\\(\\(PROCESS-NAME,${escapeRe(ENTRY_WITNESS_PROCESS_PATH)}\\),\\(DOMAIN,sfe-entry-(udp|verify|block|active)-([0-9a-z]{2,32})\\.invalid\\)\\)$`,
);

export function entryWitnessHost(bit: EntryBit, token: string): string {
  if (!WITNESS_TOKEN_RE.test(token)) throw new SfeError('VALIDATION_FAILED', '生成入口规则失败：见证标记不合法');
  return `sfe-entry-${bit}-${token}.invalid`;
}

/** 某一位带 token 的见证规则（规则集文件中的一行，不带策略）。 */
export function entryWitnessRule(bit: EntryBit, token: string): string {
  return `AND,((PROCESS-NAME,${ENTRY_WITNESS_PROCESS_PATH}),(DOMAIN,${entryWitnessHost(bit, token)}))`;
}

/** 解析入口规则集文件：见证标记（没有或不止一条时为 null）与其余规则行（不含注释与见证行，已规范化空白）。 */
export function parseEntryRuleSetFile(bit: EntryBit, content: string): { witness: string | null; bodies: string[] } {
  const lines = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => !isCommentLine(l))
    .map(normalizeRuleText);
  const witnesses = lines.flatMap((l) => {
    const m = WITNESS_LINE_RE.exec(l);
    return m && m[1] === bit ? [m[2]!] : [];
  });
  return { witness: witnesses.length === 1 ? witnesses[0]! : null, bodies: lines.filter((l) => !WITNESS_LINE_RE.test(l)) };
}

/**
 * 入口规则集文件的完整内容。witness：见证标记；省略时关闭的位用固定标记 off（初始化写入的占位文件因此也可读回），
 * 打开的位不带见证（之后的切换会带随机标记重写）；null 表示不写见证行（旧格式，测试用）。
 */
export function entryRuleSetFileContent(bit: EntryBit, on: boolean, opts: EntryRuleOptions, witness?: string | null): string {
  const token = witness === undefined ? (on ? null : ENTRY_WITNESS_OFF_TOKEN) : witness;
  const witnessLine = token === null ? [] : [entryWitnessRule(bit, token)];
  return [`# SFE managed entry rule set · ${bit}`, ...witnessLine, ...entryRules(bit, on, opts), ''].join('\n');
}

/** 工作配置 [Rule] 中 entry 受管理段的四条 RULE-SET（ruleset_resource 策略）。 */
export function entryRuleSetBlockLines(): string[] {
  return ENTRY_BITS_IN_ORDER.map((bit) => `RULE-SET,${ENTRY_RULESET_FILES[bit]},${ENTRY_BIT_POLICY[bit]}`);
}

// ---------- temp_rule：条件互不相交的临时规则 ----------

/**
 * temp_rule 的五种临时规则。文档：“rule temp add <rule> Add a temporary rule with the highest priority”——新规则排在最前，
 * 多条临时规则之间的顺序没有写入文档。所以这些规则的条件按 Safari 流量的四类（TCP/UDP × 检测主机/其他主机）划分：
 * 任一模式的规则集合里，条件相交的两条规则策略相同，模式只取决于存在哪些规则，与先后无关。
 *
 * | 种类 | 条件 | 策略 | 覆盖 |
 * |---|---|---|---|
 * | block | 进程 | REJECT | 全部 |
 * | udp | AND(进程, PROTOCOL,UDP) | REJECT | UDP（含 QUIC/STUN：“`PROTOCOL,UDP` also matches QUIC and STUN connections.”） |
 * | verify | AND(进程, NOT(PROTOCOL,UDP), DOMAIN,检测主机) | SFE-ROUTE | 检测主机的非 UDP |
 * | active | AND(进程, NOT(PROTOCOL,UDP)) | SFE-ROUTE | 全部非 UDP |
 * | blockOther | AND(进程, NOT(PROTOCOL,UDP), NOT(DOMAIN,检测主机)) | REJECT | 其他主机的非 UDP |
 *
 * 各模式的规则：NORMAL 无；BLOCKED {block}；VERIFY_ONLY {udp, verify, blockOther}；ACTIVE {udp, active}。
 * 逻辑规则语法见规则文档（“AND,((Rule1),(Rule2),...),Policy”、“NOT,((Rule1)),Policy”，NOT 只接受一个子规则，可以嵌套）；
 * PROCESS-NAME 以 “/” 开头为完整路径模式。
 * 切换中的单条增删可能短暂出现两条相交、策略不同的规则（先加后删）：规划保证任何先后下的结果都在允许的模式之内
 * （见 entry/plan.ts planTempKinds）。
 */
export type TempEntryKind = EntryBit | 'blockOther';

/** 规范顺序（证据、计划平局时的次序）；不是有效规则中的先后。 */
export const TEMP_ENTRY_KINDS: readonly TempEntryKind[] = ['block', 'udp', 'verify', 'active', 'blockOther'];

export const TEMP_ENTRY_KIND_POLICY: Record<TempEntryKind, string> = { ...ENTRY_BIT_POLICY, blockOther: 'REJECT' };

/** 每个已知模式对应的临时规则集合。 */
export const TEMP_ENTRY_MODE_KINDS: Record<'NORMAL' | 'BLOCKED' | 'VERIFY_ONLY' | 'ACTIVE', readonly TempEntryKind[]> = {
  NORMAL: [],
  BLOCKED: ['block'],
  VERIFY_ONLY: ['udp', 'verify', 'blockOther'],
  ACTIVE: ['udp', 'active'],
};

/** 种类在 EntryStep / 撤销清理报告中对应的位（blockOther 是 VERIFY_ONLY 中的“阻断”）。 */
export function entryBitOfTempKind(kind: TempEntryKind): EntryBit {
  return kind === 'blockOther' ? 'block' : kind;
}

const NOT_UDP = '(NOT,((PROTOCOL,UDP)))';

/** temp_rule 策略中某一种对应的唯一一条临时规则（正文 + 策略）。 */
export function tempRuleText(kind: TempEntryKind, opts: EntryRuleOptions): string {
  assertEntryOptions(opts);
  const proc = processExpr(opts.processPaths);
  let body: string;
  switch (kind) {
    case 'block':
      body = proc;
      break;
    case 'udp':
      body = `AND,((${proc}),(PROTOCOL,UDP))`;
      break;
    case 'verify':
      body = `AND,((${proc}),${NOT_UDP},(DOMAIN,${opts.verifyHost}))`;
      break;
    case 'active':
      body = `AND,((${proc}),${NOT_UDP})`;
      break;
    case 'blockOther':
      body = `AND,((${proc}),${NOT_UDP},(NOT,((DOMAIN,${opts.verifyHost}))))`;
      break;
  }
  return `${body},${TEMP_ENTRY_KIND_POLICY[kind]}`;
}

/** 本策略可能添加的全部临时规则（P0 工具据此登记意图）。 */
export function tempEntryRuleTexts(opts: EntryRuleOptions): string[] {
  return TEMP_ENTRY_KINDS.map((k) => tempRuleText(k, opts));
}

/**
 * 旧版本（6.5 时期、按顺序设计）的 verify/active 临时规则：verify 不排除 UDP，active 匹配 Safari 全部流量。
 * 只用于识别遗留规则（撤销入口时清理）与测试；从不写入。
 */
export function legacyTempRuleText(kind: 'verify' | 'active', opts: EntryRuleOptions): string {
  assertEntryOptions(opts);
  const proc = processExpr(opts.processPaths);
  const body = kind === 'verify' ? `AND,((${proc}),(DOMAIN,${opts.verifyHost}))` : proc;
  return `${body},${ENTRY_BIT_POLICY[kind]}`;
}
