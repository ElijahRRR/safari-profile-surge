// Surge 规则文本的解析与求值（PROCESS-NAME 按文档的三种模式与通配符）。假 Surge、优先级分类、入口读回与请求核对共用同一套解析，
// 避免各处对 AND/OR/NOT 嵌套的理解不一致。只覆盖本应用需要判断的规则类型：
// 未知类型在优先级分类中按“可能匹配”处理，在假 Surge 中按“不匹配”处理。IP 规则（IP-CIDR、IP-CIDR6、GEOIP、IP-ASN）按文档的
// DNS 行为求值（见 evaluateCondition），供假 Surge 复现“求值走到 IP 规则时域名解析失败”。

import { BlockList, isIP } from 'node:net';

export interface RuleCondition {
  /** 大写规则类型，例如 PROCESS-NAME、AND、RULE-SET、FINAL。 */
  type: string;
  /** 叶子条件的值；逻辑条件与 FINAL 为 null。 */
  value: string | null;
  /** AND/OR/NOT 的子条件。 */
  operands: RuleCondition[] | null;
  /** 叶子条件的选项（例如 no-resolve）；没有时省略。整条规则的选项在 ParsedRule.options。 */
  options?: string[];
}

export interface ParsedRule {
  condition: RuleCondition;
  policy: string | null;
  options: string[];
}

export interface RequestFacts {
  processPath: string | null;
  host: string | null;
  protocol: 'tcp' | 'udp';
}

const LOGICAL = new Set(['AND', 'OR', 'NOT']);
export const REJECT_POLICIES = new Set(['REJECT', 'REJECT-TINYGIF', 'REJECT-DROP', 'REJECT-NO-DROP']);
export const BUILTIN_POLICIES = new Set(['DIRECT', ...REJECT_POLICIES]);

export function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t === '' || t.startsWith('#') || t.startsWith('//') || t.startsWith(';');
}

/** 按顶层逗号切分（括号内的逗号不切）；括号不配对时返回 null。 */
export function splitTopLevel(text: string): string[] | null {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth < 0) return null;
    } else if (ch === ',' && depth === 0) {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  if (depth !== 0) return null;
  parts.push(text.slice(start).trim());
  return parts;
}

/** 整段被一对外层括号包住（而不是 "(a),(b)" 这种两段）。 */
function isWrapped(text: string): boolean {
  if (!text.startsWith('(') || !text.endsWith(')')) return false;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') {
      depth--;
      if (depth === 0 && i !== text.length - 1) return false;
    }
  }
  return depth === 0;
}

function parseOperandList(text: string): RuleCondition[] | null {
  if (!isWrapped(text)) return null;
  const items = splitTopLevel(text.slice(1, -1));
  if (!items || items.length === 0) return null;
  const out: RuleCondition[] = [];
  for (const item of items) {
    if (!isWrapped(item)) return null;
    const c = parseCondition(item.slice(1, -1));
    if (!c) return null;
    out.push(c);
  }
  return out;
}

/** 解析不带策略的条件：规则集文件中的一行，或逻辑规则中的一个子条件。 */
export function parseCondition(text: string): RuleCondition | null {
  const parts = splitTopLevel(text.trim());
  if (!parts || parts.length === 0 || parts[0] === '') return null;
  const type = parts[0]!.toUpperCase();
  if (LOGICAL.has(type)) {
    if (parts.length !== 2) return null;
    const operands = parseOperandList(parts[1]!);
    if (!operands) return null;
    if (type === 'NOT' && operands.length !== 1) return null;
    return { type, value: null, operands };
  }
  if (type === 'FINAL') return { type, value: null, operands: null };
  // 规则集文件中的叶子行可以带选项（例如 no-resolve；规则集文档：“Per-line options such as no-resolve and extended-matching
  // are allowed.”），保留在 options 中。
  if (parts.length < 2 || parts[1] === '') return null;
  const options = parts.slice(2).filter((o) => o !== '');
  return options.length > 0 ? { type, value: parts[1]!, operands: null, options } : { type, value: parts[1]!, operands: null };
}

/** 解析一条完整规则（带策略）。注释与空行返回 null。 */
export function parseRule(text: string): ParsedRule | null {
  if (isCommentLine(text)) return null;
  const parts = splitTopLevel(text.trim());
  if (!parts || parts.length === 0) return null;
  const type = parts[0]!.toUpperCase();
  if (type === 'FINAL') {
    return { condition: { type, value: null, operands: null }, policy: parts[1] || null, options: parts.slice(2) };
  }
  if (parts.length < 3) return null;
  if (LOGICAL.has(type)) {
    const operands = parseOperandList(parts[1]!);
    if (!operands) return null;
    if (type === 'NOT' && operands.length !== 1) return null;
    return { condition: { type, value: null, operands }, policy: parts[2] || null, options: parts.slice(3) };
  }
  if (parts[1] === '') return null;
  return { condition: { type, value: parts[1]!, operands: null }, policy: parts[2] || null, options: parts.slice(3) };
}

/** 去掉逗号与括号两侧的空白，用于比较 Surge 回显的规则文本（路径内部的空格保留）。 */
export function normalizeRuleText(text: string): string {
  return text.trim().replace(/\s*([,()])\s*/g, '$1');
}

function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.slice(i + 1) : path;
}

/**
 * PROCESS-NAME 的三种模式（https://manual.nssurge.com/rules/process.html）：
 * - filename：不以 “/” 开头，“matches only the executable file name, regardless of its path. Wildcards `*` and `?` are supported.”
 * - full_path：以 “/” 开头且不以 “/” 结尾，匹配完整绝对路径，“Wildcards `*` and `?` are supported in this mode as well.”
 * - app_bundle（Mac 6.0.0+）：以 “/” 开头并以 “/” 结尾，“the executable path is matched by prefix.”
 * “Matching is case-sensitive in all modes.”
 */
export type ProcessNameMode = 'filename' | 'full_path' | 'app_bundle';

export function processNameMode(value: string): ProcessNameMode {
  if (!value.startsWith('/')) return 'filename';
  return value.endsWith('/') ? 'app_bundle' : 'full_path';
}

export function hasProcessWildcard(value: string): boolean {
  return value.includes('*') || value.includes('?');
}

/**
 * 通配符转正则（大小写敏感）。文档没有说明完整路径模式中的 “*” 能否跨过 “/”：starCrossesSlash 为 true 时按能跨过
 * （匹配集合最大，用于“可能匹配”），false 时按不能跨过（匹配集合最小，用于“一定匹配”）。
 */
function globRegExp(glob: string, starCrossesSlash: boolean, anchoredEnd: boolean): RegExp {
  let re = '';
  for (const ch of glob) {
    if (ch === '*') re += starCrossesSlash ? '.*' : '[^/]*';
    else if (ch === '?') re += starCrossesSlash ? '.' : '[^/]';
    else re += ch.replace(/[\\^$.|+()[\]{}]/g, '\\$&');
  }
  return new RegExp(`^${re}${anchoredEnd ? '$' : ''}`, 'su');
}

function processNameTest(value: string, processPath: string | null, permissive: boolean): boolean {
  if (!processPath || value === '') return false;
  const mode = processNameMode(value);
  if (mode === 'filename') {
    const name = basename(processPath);
    return hasProcessWildcard(value) ? globRegExp(value, true, true).test(name) : value === name;
  }
  if (mode === 'full_path') return hasProcessWildcard(value) ? globRegExp(value, permissive, true).test(processPath) : value === processPath;
  // App Bundle 前缀模式：文档没有提到通配符。“一定匹配”只认不含通配符的字面前缀；“可能匹配”把通配符按最宽处理。
  if (!hasProcessWildcard(value)) return processPath.startsWith(value);
  return permissive && globRegExp(value, true, false).test(processPath);
}

/** 一定匹配（按文档三种模式；文档没有说明的通配符细节取最窄的解释）。假 Surge 求值与“能证明拦住 Safari”用它。 */
export function processNameMatches(value: string, processPath: string | null): boolean {
  return processNameTest(value, processPath, false);
}

/** 可能匹配（文档没有说明的细节取最宽的解释）：优先级分类用它，只有它为 false 时才能证明不相交。 */
export function processNameMayMatch(value: string, processPath: string | null): boolean {
  return processNameTest(value, processPath, true);
}

function hostMatches(type: string, value: string, host: string): boolean {
  const h = host.toLowerCase();
  const v = value.toLowerCase();
  if (type === 'DOMAIN') return h === v;
  if (type === 'DOMAIN-SUFFIX') return h === v || h.endsWith(`.${v}`);
  if (type === 'DOMAIN-KEYWORD') return h.includes(v);
  return false;
}

/** 目标域名的解析结果（第一条 A 与第一条 AAAA 记录）。 */
export interface ResolvedAddresses {
  v4: string | null;
  v6: string | null;
}

/** 求值中的 DNS 查询失败：IP 规则文档“If the DNS lookup fails, rule evaluation aborts and the request fails with a DNS error”。 */
export class DnsLookupFailure extends Error {
  constructor(readonly host: string) {
    super('DNS lookup failed');
    this.name = 'DnsLookupFailure';
  }
}

export interface EvaluateContext {
  /** RULE-SET 的已加载内容（按规则中的路径/地址查找）；未加载返回 null。 */
  ruleSet?: (location: string) => RuleCondition[] | null;
  /**
   * 目标是域名时 IP 规则所需的地址。resolve 为 true 时在本次求值中第一次需要时查询（之后的 IP 规则沿用同一结果，失败抛出
   * DnsLookupFailure）；为 false（no-resolve）时只返回本次求值中已有的结果，没有则为 null。没有提供时 IP 规则对域名不匹配。
   */
  lookup?: (host: string, resolve: boolean) => ResolvedAddresses | null;
}

const IP_RULE_TYPES = new Set(['IP-CIDR', 'IP-CIDR6', 'GEOIP', 'IP-ASN']);

function hasOption(c: RuleCondition, name: string): boolean {
  return (c.options ?? []).some((o) => o.trim().toLowerCase() === name);
}

function cidrMatches(value: string, address: string, family: 'ipv4' | 'ipv6'): boolean {
  const [net, bits, ...rest] = value.trim().split('/');
  if (rest.length > 0 || net === undefined || isIP(net) !== (family === 'ipv4' ? 4 : 6)) return false;
  const max = family === 'ipv4' ? 32 : 128;
  const prefix = bits === undefined ? max : Number(bits);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > max || (bits !== undefined && !/^\d+$/.test(bits))) return false;
  const list = new BlockList();
  list.addSubnet(net, prefix, family);
  return list.check(address, family);
}

/**
 * IP 规则（https://manual.nssurge.com/rules/ip.html）：
 * - “If the request targets an IP literal, the rule matches it directly; GEOIP and IP-ASN perform their database lookup without a DNS query.”
 * - “If the request targets a domain, Surge performs a DNS lookup when evaluation reaches the first IP-based rule, then resumes evaluation with
 *   the result. IP-CIDR and GEOIP/IP-ASN lookups test the first IPv4 record of the result (falling back to the IPv6 record for GEOIP/IP-ASN);
 *   IP-CIDR6 tests the first IPv6 record.”
 * - no-resolve：“the rule is skipped for requests targeting a domain whose address has not been resolved yet, instead of triggering a DNS
 *   lookup. The rule still matches requests that target IP literals.”；RULE-SET 行的 no-resolve “forces no-resolve on every sub-rule”
 *   （rules/ruleset.html，由 inheritedNoResolve 传入）。
 * 假 Surge 没有 GeoIP/ASN 数据库：任何地址的查询结果都为空，只有 UNKNOWN（“matches an empty country result”）匹配。
 */
function ipConditionMatches(c: RuleCondition, facts: RequestFacts, ctx: EvaluateContext, noResolve: boolean): boolean {
  const host = facts.host;
  if (host === null || host === '') return false;
  let addr: ResolvedAddresses | null;
  const literal = isIP(host);
  if (literal === 4) addr = { v4: host, v6: null };
  else if (literal === 6) addr = { v4: null, v6: host };
  else addr = ctx.lookup ? ctx.lookup(host, !noResolve) : null;
  if (addr === null) return false;
  switch (c.type) {
    case 'IP-CIDR':
      return addr.v4 !== null && cidrMatches(c.value!, addr.v4, 'ipv4');
    case 'IP-CIDR6':
      return addr.v6 !== null && cidrMatches(c.value!, addr.v6, 'ipv6');
    default:
      return (addr.v4 ?? addr.v6) !== null && c.value!.trim().toUpperCase() === 'UNKNOWN';
  }
}

/**
 * 假 Surge 的求值：只判断已知类型，未知类型不匹配。inheritedNoResolve：整条规则或 RULE-SET 行带 no-resolve（作用于其中的
 * IP 规则）。目标域名的 DNS 查询失败时抛出 DnsLookupFailure（调用方按 FINAL 的 dns-failed 或求值失败处理）。
 */
export function evaluateCondition(c: RuleCondition, facts: RequestFacts, ctx: EvaluateContext = {}, inheritedNoResolve = false): boolean {
  if (IP_RULE_TYPES.has(c.type)) return ipConditionMatches(c, facts, ctx, inheritedNoResolve || hasOption(c, 'no-resolve'));
  switch (c.type) {
    case 'FINAL':
      return true;
    case 'AND':
      return (c.operands ?? []).every((o) => evaluateCondition(o, facts, ctx, inheritedNoResolve));
    case 'OR':
      return (c.operands ?? []).some((o) => evaluateCondition(o, facts, ctx, inheritedNoResolve));
    case 'NOT':
      return !evaluateCondition(c.operands![0]!, facts, ctx, inheritedNoResolve);
    case 'PROCESS-NAME':
      return processNameMatches(c.value!, facts.processPath);
    case 'DOMAIN':
    case 'DOMAIN-SUFFIX':
    case 'DOMAIN-KEYWORD':
      return facts.host !== null && hostMatches(c.type, c.value!, facts.host);
    case 'PROTOCOL': {
      const v = c.value!.toUpperCase();
      if (facts.protocol === 'udp') return v === 'UDP' || v === 'QUIC';
      return v === 'TCP' || v === 'HTTP' || v === 'HTTPS';
    }
    case 'RULE-SET': {
      const loaded = ctx.ruleSet?.(c.value!) ?? null;
      return loaded !== null && loaded.some((r) => evaluateCondition(r, facts, ctx, inheritedNoResolve));
    }
    default:
      return false;
  }
}

/**
 * 优先级分类用：条件是否“可能”匹配 Safari 发往给定主机的流量。只有能证明不相交时才返回 false
 * （域名规则不覆盖任何关心的主机、进程规则按文档三种模式与通配符都不可能匹配任何 Safari 进程路径，以及由它们组成的 AND/OR）。
 * 模块可以把 DIRECT 规则插到规则列表顶部（“Rule lines may only be inserted at the top of the rule list”），
 * 所以 Safari*、/Applications/Safari.app/ 这类写法必须按可能匹配处理。
 */
export function mayMatchSafari(c: RuleCondition, ctx: { processPaths: readonly string[]; hosts: readonly string[] }): boolean {
  switch (c.type) {
    case 'PROCESS-NAME':
      return ctx.processPaths.some((p) => processNameMayMatch(c.value!, p));
    case 'DOMAIN':
    case 'DOMAIN-SUFFIX':
    case 'DOMAIN-KEYWORD':
      return ctx.hosts.some((h) => hostMatches(c.type, c.value!, h));
    case 'AND':
      return (c.operands ?? []).every((o) => mayMatchSafari(o, ctx));
    case 'OR':
      return (c.operands ?? []).some((o) => mayMatchSafari(o, ctx));
    default:
      // NOT、PROTOCOL、RULE-SET、IP/GEOIP/端口、FINAL 与未知类型都无法证明不相交。
      return true;
  }
}
