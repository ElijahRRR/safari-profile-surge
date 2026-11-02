// 节点行、资源文件与入口规则的受控序列化。每个字段逐项校验后才拼接，永不拼接原始表格文本；
// 错误信息只给字段与原因，不回显值。见 docs/ARCHITECTURE.md §5.4、§5.5。

import { isIP } from 'node:net';
import {
  EMPTY_PLACEHOLDER_LINE,
  ENTRY_PLACEHOLDER_RULE,
  ENTRY_RULESET_FILES,
  ENTRY_WITNESS_PROCESS_PREFIX,
  LEGACY_ENTRY_WITNESS_PROCESS_PATH,
  LEGACY_NODE_GROUP_LINE,
  NODE_RESOURCE_FILE,
  ROUTE_GROUP_NAME,
  SfeError,
  isSfeName,
  parseNodeResourceUrl,
  type EntryBits,
  type FieldError,
} from '@sfe/contract';
import { isSurgeReferenceName, isSurgeSafeCredential, validateHost, validatePort } from '../domain/validate.js';
import { findManagedBlock, parseProfile, serializeProfile } from './profile.js';
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

/**
 * 本机资源服务提供的节点列表（D10）：没有节点时只含占位行 EMPTY_PLACEHOLDER_LINE——Surge 对空内容（“服务器未返回任何数据。”）
 * 与没有有效行的内容（“Failed to parse remote resource data”）都报错并保留旧资源（docs/verification/
 * 2026-10-25-loopback-main-witness-matrix.md）。占位行从不是清单条目、不计为买家节点。TODO(P0)：只含占位行的列表被接受。
 */
export function resourceBody(generation: number, lines: readonly string[]): string {
  return resourceFile(generation, lines.length > 0 ? lines : [EMPTY_PLACEHOLDER_LINE]);
}

/**
 * 旧版（D7）[Proxy Group] 受管理段内容：本地 policy-path 文件；首成员同样是 REJECT。D10 起服务从不写入它（初始化与重新合并
 * 写入 loopbackGroupBlockLines；仍引用本地文件而 resourceServe 门槛未满足时，重新合并保持 LEGACY_NODE_GROUP_LINE 原样），
 * 只用于识别（isLegacyNodeGroupLine）、旧版假环境与迁移测试，以及 P0 测试配置接入回环资源服务之前的起点（tools/p0）。
 */
export function groupBlockLines(): string[] {
  return [LEGACY_NODE_GROUP_LINE];
}

/** 受管理段中的这一行是旧版（D7）本地文件引用：需要重新合并才能改用本机资源服务。只按全文比较（段内容由本应用生成）。 */
export function isLegacyNodeGroupLine(line: string): boolean {
  return typeof line === 'string' && line.trim() === LEGACY_NODE_GROUP_LINE;
}

/**
 * [Proxy Group] 受管理段内容（D10）：SFE-ROUTE 的 policy-path 指向本机资源服务。首成员明确为 REJECT：选择失效或选中的节点被
 * 删除时落到 REJECT，不会落到其他买家出口（回环矩阵：删除选中成员后落到 REJECT 只因为它排在首位）。从不加组级
 * underlying-proxy、external-policy-modifier、policy-regex-filter、external-policy-name-prefix 或 update-interval：
 * 前四者会改名（“Name (via Relay)”）、覆盖每行的前置或过滤导入的节点（policy-groups/parameters.html、policy-including.html），
 * update-interval 对 policy-path 的取值范围没有写入文档。url 必须是 nodeResourceUrl 的结果；这一行含读取令牌，只写入工作配置，
 * 不进入日志、错误或界面（脱敏见 redact-profile.ts redactUrls）。
 */
export function loopbackGroupBlockLines(url: string): string[] {
  if (typeof url !== 'string' || parseNodeResourceUrl(url) === null) {
    throw new SfeError('VALIDATION_FAILED', '生成受管理段失败：本机资源服务地址不正确');
  }
  return [`${ROUTE_GROUP_NAME} = select, REJECT, policy-path=${url}`];
}

export interface LoopbackCheckRewrite {
  /** --check 用的候选配置全文：只有受管理 group 段中 SFE-ROUTE 的 policy-path 值换成相对的 sfe-nodes.list。 */
  text: string;
  /** 交给 checkCandidate 的 overrides（engine/candidate.ts CandidateInput.overrides）：sfe-nodes.list → 候选节点列表。 */
  overrides: Map<string, string>;
}

const ROUTE_DEFINITION_RE = new RegExp(`^\\s*${ROUTE_GROUP_NAME}\\s*=`);
const POLICY_PATH_PARAM_RE = /(\bpolicy-path\s*=\s*)([^,\s]+)/gi;

/**
 * 候选 --check（init、remerge、publish 共用）：checkCandidate 只为相对路径引用准备候选副本（listRelativeReferences 不计 URL），
 * 指向本机资源服务的 policy-path 会被忽略，--check 因此看不到候选节点，或者去下载正在提供的版本。这里把 SFE-ROUTE 的
 * policy-path 值换成相对的 sfe-nodes.list，并给出 { sfe-nodes.list → body } 的覆盖，--check 从不接触本机资源服务。
 * TODO(P0)：记录 `surge-cli --check` 是否下载远端 policy-path。
 * 受管理 group 段必须恰好有一条 SFE-ROUTE 定义、其中恰好一个 policy-path 且是本机资源服务地址（expectedUrl 给出时必须等于它），
 * 否则失败（失败即关闭，从不改写段外的内容）；改写后的全文仍含读取令牌（段外或其他位置也引用了该地址）时同样失败。
 * 错误信息不含地址或令牌。
 */
export function rewriteLoopbackForCheck(profileText: string, body: string, expectedUrl?: string): LoopbackCheckRewrite {
  if (typeof profileText !== 'string' || typeof body !== 'string') throw new SfeError('VALIDATION_FAILED', '校验候选配置失败：候选内容不正确');
  const parsed = parseProfile(profileText);
  const block = findManagedBlock(parsed, 'group');
  if (typeof block !== 'object') {
    throw new SfeError('BASELINE_CHANGED', '校验候选配置失败：节点组受管理段缺失或边界不明确', { details: { block: 'group', state: block } });
  }
  const notFound = (): SfeError =>
    new SfeError('VALIDATION_FAILED', '校验候选配置失败：节点组受管理段中没有恰好一条指向本机资源服务的 SFE-ROUTE 定义');
  const routeLines: number[] = [];
  for (let i = block.start + 1; i < block.end; i++) if (ROUTE_DEFINITION_RE.test(parsed.lines[i]!.text)) routeLines.push(i);
  if (routeLines.length !== 1) throw notFound();
  const at = routeLines[0]!;
  const lineText = parsed.lines[at]!.text;
  const params = [...lineText.matchAll(POLICY_PATH_PARAM_RE)];
  if (params.length !== 1) throw notFound();
  const m = params[0]!;
  const url = m[2]!;
  const target = parseNodeResourceUrl(url);
  if (target === null || (expectedUrl !== undefined && url !== expectedUrl)) throw notFound();
  const start = m.index + m[1]!.length;
  const lines = parsed.lines.map((l, i) => (i === at ? { ...l, text: lineText.slice(0, start) + NODE_RESOURCE_FILE + lineText.slice(start + url.length) } : l));
  const text = serializeProfile(lines);
  // 令牌出现在别处（段外的引用、注释或其他参数）：--check 仍可能接触本机资源服务，候选副本也会带出令牌。
  if (text.includes(target.token)) {
    throw new SfeError('VALIDATION_FAILED', '校验候选配置失败：工作配置在节点组受管理段之外也引用了本机资源服务地址');
  }
  return { text, overrides: new Map([[NODE_RESOURCE_FILE, body]]) };
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
 * 本应用见证与占位规则使用的合成进程目录（/var/empty 及其规范路径 /private/var/empty）。Safari 进程路径不能落在这里：
 * 否则入口规则行会与见证行相同，见证不再只由见证探测命中（纵深防御；真实可执行文件不会在这个空目录中）。
 */
const SYNTHETIC_PROCESS_DIRS = ['/var/empty/', '/private/var/empty/'];

/**
 * Safari 进程路径：绝对路径、不含通配与规则分隔符、不是裸进程名、不是系统级通用 WebKit 路径、不在合成进程目录中；
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
    } else if (SYNTHETIC_PROCESS_DIRS.some((dir) => p.toLowerCase().startsWith(dir))) {
      errors.push({ field, message: '不能使用本应用见证规则的合成进程目录' });
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
 * 见证规则：每个入口规则集文件带一条只由合成进程路径构成的规则 `PROCESS-NAME,/var/empty/sfe-entry-witness-<位>-<标记>`
 * （contract ENTRY_WITNESS_PROCESS_PREFIX；完整路径模式：“If the expression starts with `/` (and does not end with `/`), it
 * matches the executable's full absolute path.”，“Matching is case-sensitive in all modes.”，rules/process.html）。
 * 每次写入换一个随机标记；用 `rule match <ENTRY_PROBE_IPV4> process-path=<见证路径>` 读回命中的是不是该位的 RULE-SET，就能证明
 * Surge 已加载的正是这一版内容——即使这一位被更前面的入口规则遮住、Safari 的探测看不出差别（例如 block 打开时的 active）。
 * - 唯一性放在进程路径里，不放在主机里：规则集文件继承 RULE-SET 行的策略（verify/active 为 SFE-ROUTE），DOMAIN 规则对任何进程
 *   按主机名匹配（“Domain rules match the hostname of a request … never trigger a DNS lookup”，rules/domain.html）；而尚未加载的
 *   这一版见证不命中时，求值继续走到用户规则，探测合成域名会在第一条 IP 规则处触发 DNS 查询：“If the DNS lookup fails, rule
 *   evaluation aborts and the request fails with a DNS error”（rules/ip.html）——2026-10-24 测试 Mac 上 `.invalid` 主机的
 *   rule match 退出 1（DNS 空回答）。探测目标用文档地址 IP 字面量（“If the request targets an IP literal, the rule matches it
 *   directly”），没加载的版本因此得到正常回答（某条用户规则或 FINAL），而不是读取失败。
 * - 见证与占位规则不含任何主机或 IP 条件：入口规则集文件里的 IP 子规则会让整个规则集需要 DNS（规则集文档：RULE-SET 行的
 *   no-resolve “Removes the set's DNS requirement”），Safari 的真实域名请求就会在本应用入口段内先做本地 DNS 查询。
 * - 初始化写入的固定标记 off 是公开的，但只对应一个不可执行的路径；路径不含逗号，回显子规则时可按全文识别。
 * 其余文档依据：本地规则集“Local files are watched and reloaded automatically when they change.”（rules/ruleset.html）；
 * `rule match`“Evaluate the active rule set without creating a connection”、“process-path=<path> Source process path;
 * affects PROCESS-NAME rules”（CLI 帮助，Mac 6.9.0+）；规则集文件中的规则不带策略（rules/ruleset.html）。
 * TODO(P0)：rule match 接受不存在的 process-path、不把 /var 规范化为 /private/var（否则见证永远读不到：超时，失败即关闭）。
 */
export const ENTRY_WITNESS_OFF_TOKEN = 'off';
const WITNESS_TOKEN_RE = /^[0-9a-z]{2,32}$/;
const escapeRe = (t: string): string => t.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
/** 规范化之后（normalizeRuleText）的见证行。 */
const WITNESS_LINE_RE = new RegExp(`^PROCESS-NAME,${escapeRe(ENTRY_WITNESS_PROCESS_PREFIX)}(udp|verify|block|active)-([0-9a-z]{2,32})$`);
/** 旧格式见证行（合成进程 + `sfe-entry-<位>-<标记>.invalid` 主机）：只识别，从不当作已加载的证明，从不写入。 */
const LEGACY_WITNESS_LINE_RE = new RegExp(
  `^AND,\\(\\(PROCESS-NAME,${escapeRe(LEGACY_ENTRY_WITNESS_PROCESS_PATH)}\\),\\(DOMAIN,sfe-entry-(udp|verify|block|active)-([0-9a-z]{2,32})\\.invalid\\)\\)$`,
);

/** 某一位带 token 的见证进程路径（见证探测的 process-path）。 */
export function entryWitnessProcessPath(bit: EntryBit, token: string): string {
  if (!WITNESS_TOKEN_RE.test(token)) throw new SfeError('VALIDATION_FAILED', '生成入口规则失败：见证标记不合法');
  return `${ENTRY_WITNESS_PROCESS_PREFIX}${bit}-${token}`;
}

/** 某一位带 token 的见证规则（规则集文件中的一行，不带策略）。 */
export function entryWitnessRule(bit: EntryBit, token: string): string {
  return `PROCESS-NAME,${entryWitnessProcessPath(bit, token)}`;
}

export interface ParsedEntryRuleSetFile {
  /** 这一位的见证标记（当前格式恰好一条时）；没有、不止一条或只有旧格式见证时为 null。 */
  witness: string | null;
  /** 文件带一条这一位的旧格式见证（且没有当前格式的见证）：已从 bodies 去掉，按没有见证处理，下一次切换改写。 */
  legacyWitness: boolean;
  /** 其余规则行（不含注释与见证行，已规范化空白）。 */
  bodies: string[];
}

/**
 * 解析入口规则集文件。当前格式的见证行（任何位）都不算规则行；只有这一位恰好一条时给出标记。旧格式见证行只在“这一位恰好
 * 一条、文件没有当前格式见证”时去掉（legacyWitness）；与当前格式混用、不止一条或属于其他位时留在 bodies 中，文件因此无法识别。
 */
export function parseEntryRuleSetFile(bit: EntryBit, content: string): ParsedEntryRuleSetFile {
  const lines = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => !isCommentLine(l))
    .map(normalizeRuleText);
  const witnesses = lines.flatMap((l) => {
    const m = WITNESS_LINE_RE.exec(l);
    return m && m[1] === bit ? [m[2]!] : [];
  });
  const rest = lines.filter((l) => !WITNESS_LINE_RE.test(l));
  const legacy = rest.filter((l) => LEGACY_WITNESS_LINE_RE.test(l));
  const legacyWitness = lines.length === rest.length && legacy.length === 1 && LEGACY_WITNESS_LINE_RE.exec(legacy[0]!)![1] === bit;
  return {
    witness: witnesses.length === 1 ? witnesses[0]! : null,
    legacyWitness,
    bodies: legacyWitness ? rest.filter((l) => l !== legacy[0]) : rest,
  };
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
