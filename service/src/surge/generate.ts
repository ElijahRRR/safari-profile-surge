// 节点行、资源文件与入口规则的受控序列化。每个字段逐项校验后才拼接，永不拼接原始表格文本；
// 错误信息只给字段与原因，不回显值。见 docs/ARCHITECTURE.md §5.4、§5.5。

import { isIP } from 'node:net';
import {
  ENTRY_PLACEHOLDER_RULE,
  ENTRY_RULESET_FILES,
  NODE_RESOURCE_FILE,
  ROUTE_GROUP_NAME,
  SfeError,
  isSfeName,
  type EntryBits,
  type FieldError,
} from '@sfe/contract';
import { isSurgeReferenceName, isSurgeSafeCredential, validateHost, validatePort } from '../domain/validate.js';
import { BUILTIN_POLICIES } from './rules.js';

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

/** 入口规则集文件的完整内容。 */
export function entryRuleSetFileContent(bit: EntryBit, on: boolean, opts: EntryRuleOptions): string {
  return [`# SFE managed entry rule set · ${bit}`, ...entryRules(bit, on, opts), ''].join('\n');
}

/** 工作配置 [Rule] 中 entry 受管理段的四条 RULE-SET（ruleset_resource 策略）。 */
export function entryRuleSetBlockLines(): string[] {
  return ENTRY_BITS_IN_ORDER.map((bit) => `RULE-SET,${ENTRY_RULESET_FILES[bit]},${ENTRY_BIT_POLICY[bit]}`);
}

/** temp_rule 策略中某一位对应的唯一一条临时规则（正文 + 策略）。 */
export function tempRuleText(bit: EntryBit, opts: EntryRuleOptions): string {
  assertEntryOptions(opts);
  const body = bit === 'block' || bit === 'active' ? processExpr(opts.processPaths) : entryRules(bit, true, opts)[0]!;
  return `${body},${ENTRY_BIT_POLICY[bit]}`;
}
