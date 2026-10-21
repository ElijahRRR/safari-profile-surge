// Surge 规则文本的解析与求值。假 Surge、优先级分类、入口读回与请求核对共用同一套解析，
// 避免各处对 AND/OR/NOT 嵌套的理解不一致。只覆盖本应用需要判断的规则类型：
// 未知类型在优先级分类中按“可能匹配”处理，在假 Surge 中按“不匹配”处理。

export interface RuleCondition {
  /** 大写规则类型，例如 PROCESS-NAME、AND、RULE-SET、FINAL。 */
  type: string;
  /** 叶子条件的值；逻辑条件与 FINAL 为 null。 */
  value: string | null;
  /** AND/OR/NOT 的子条件。 */
  operands: RuleCondition[] | null;
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
  // 规则集文件中的叶子行可以带选项（例如 no-resolve），只取值。
  if (parts.length < 2 || parts[1] === '') return null;
  return { type, value: parts[1]!, operands: null };
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

export function processNameMatches(value: string, processPath: string | null): boolean {
  if (!processPath) return false;
  return value.includes('/') ? value === processPath : value === basename(processPath);
}

function hostMatches(type: string, value: string, host: string): boolean {
  const h = host.toLowerCase();
  const v = value.toLowerCase();
  if (type === 'DOMAIN') return h === v;
  if (type === 'DOMAIN-SUFFIX') return h === v || h.endsWith(`.${v}`);
  if (type === 'DOMAIN-KEYWORD') return h.includes(v);
  return false;
}

export interface EvaluateContext {
  /** RULE-SET 的已加载内容（按规则中的路径/地址查找）；未加载返回 null。 */
  ruleSet?: (location: string) => RuleCondition[] | null;
}

/** 假 Surge 的求值：只判断已知类型，未知类型不匹配。 */
export function evaluateCondition(c: RuleCondition, facts: RequestFacts, ctx: EvaluateContext = {}): boolean {
  switch (c.type) {
    case 'FINAL':
      return true;
    case 'AND':
      return (c.operands ?? []).every((o) => evaluateCondition(o, facts, ctx));
    case 'OR':
      return (c.operands ?? []).some((o) => evaluateCondition(o, facts, ctx));
    case 'NOT':
      return !evaluateCondition(c.operands![0]!, facts, ctx);
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
      return loaded !== null && loaded.some((r) => evaluateCondition(r, facts, ctx));
    }
    default:
      return false;
  }
}

/**
 * 优先级分类用：条件是否“可能”匹配 Safari 发往给定主机的流量。只有能证明不相交时才返回 false
 * （域名规则不覆盖任何关心的主机、进程规则指向其他进程，以及由它们组成的 AND/OR）。
 */
export function mayMatchSafari(c: RuleCondition, ctx: { processPaths: readonly string[]; hosts: readonly string[] }): boolean {
  switch (c.type) {
    case 'PROCESS-NAME':
      return ctx.processPaths.some((p) => processNameMatches(c.value!, p));
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
