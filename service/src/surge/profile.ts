// 工作配置的解析与受管理段合并。解析保留每一个字节（含行尾），合并只改动受管理段或明确插入的位置；
// 受管理段的归属以 managed_objects 为准，这里的注释边界只用于定位与审阅。见 docs/ARCHITECTURE.md §5.3。

import { EMPTY_PLACEHOLDER_NODE, MANAGED_BEGIN, MANAGED_END, SfeError, parseNodeResourceUrl } from '@sfe/contract';
import { isCommentLine, splitTopLevel } from './rules.js';

export type Eol = '' | '\n' | '\r\n' | '\r';

export interface ProfileLine {
  text: string;
  eol: Eol;
}

export interface ProfileSection {
  /** 段名（不含方括号）；第一个段头之前的内容为 null。 */
  name: string | null;
  /** 段头所在行；前导部分为 null。 */
  header: number | null;
  /** [start, end) 行范围，含段头。 */
  start: number;
  end: number;
}

export interface ParsedProfile {
  lines: ProfileLine[];
  sections: ProfileSection[];
}

const SECTION_RE = /^\s*\[([^\]]+)\]\s*$/;

export function splitLines(text: string): ProfileLine[] {
  const lines: ProfileLine[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\n' || ch === '\r') {
      let eol: Eol = ch;
      if (ch === '\r' && text[i + 1] === '\n') {
        eol = '\r\n';
        i++;
      }
      lines.push({ text: text.slice(start, i + 1 - eol.length), eol });
      start = i + 1;
    }
  }
  if (start < text.length) lines.push({ text: text.slice(start), eol: '' });
  return lines;
}

export function parseProfile(text: string): ParsedProfile {
  const lines = splitLines(text);
  const sections: ProfileSection[] = [];
  let current: ProfileSection = { name: null, header: null, start: 0, end: 0 };
  lines.forEach((line, i) => {
    const m = SECTION_RE.exec(line.text);
    if (m) {
      current.end = i;
      sections.push(current);
      current = { name: m[1]!.trim(), header: i, start: i, end: i };
    }
  });
  current.end = lines.length;
  sections.push(current);
  return { lines, sections };
}

export function serializeProfile(parsed: ParsedProfile | ProfileLine[]): string {
  const lines = Array.isArray(parsed) ? parsed : parsed.lines;
  return lines.map((l) => l.text + l.eol).join('');
}

export function sectionAt(parsed: ParsedProfile, line: number): string | null {
  for (const s of parsed.sections) if (line >= s.start && line < s.end) return s.name;
  return null;
}

export function findSections(parsed: ParsedProfile, name: string): ProfileSection[] {
  return parsed.sections.filter((s) => s.name !== null && s.name.toLowerCase() === name.toLowerCase());
}

/** 文件主要使用的行尾；没有换行时为 \n。 */
export function dominantEol(parsed: ParsedProfile): Exclude<Eol, ''> {
  let crlf = 0;
  let lf = 0;
  for (const l of parsed.lines) {
    if (l.eol === '\r\n') crlf++;
    else if (l.eol === '\n') lf++;
  }
  return crlf > lf ? '\r\n' : '\n';
}

// ---------- 受管理段 ----------

export interface ManagedBlock {
  /** 开始与结束标记所在行（0 起）。 */
  start: number;
  end: number;
  version: number;
  /** 标记之间的行文本。 */
  lines: string[];
  section: string | null;
}

const LOOSE_MARKER_RE = /^\s*#\s*SFE-(BEGIN|END)\b\s*(\S*)/i;

interface MarkerLine {
  line: number;
  kind: 'BEGIN' | 'END';
  name: string;
  exact: boolean;
  version: number | null;
}

function markers(parsed: ParsedProfile): MarkerLine[] {
  const out: MarkerLine[] = [];
  parsed.lines.forEach((l, i) => {
    const m = LOOSE_MARKER_RE.exec(l.text);
    if (!m) return;
    const kind = m[1]!.toUpperCase() as 'BEGIN' | 'END';
    const name = m[2] ?? '';
    const t = l.text.trim();
    let exact = false;
    let version: number | null = null;
    if (kind === 'BEGIN') {
      const em = new RegExp(`^${MANAGED_BEGIN} ([A-Za-z0-9-]+) v([1-9]\\d{0,8})$`).exec(t);
      if (em && em[1] === name) {
        exact = true;
        version = Number(em[2]);
      }
    } else {
      exact = t === `${MANAGED_END} ${name}` && /^[A-Za-z0-9-]+$/.test(name);
    }
    out.push({ line: i, kind, name, exact, version });
  });
  return out;
}

/**
 * 查找 `# SFE-BEGIN <name> v<k>` … `# SFE-END <name>`。重复、未闭合、顺序颠倒、格式不规范、
 * 与其他段交叉都返回 'ambiguous'；完全没有标记返回 'missing'。
 */
export function findManagedBlock(parsed: ParsedProfile, name: string): ManagedBlock | 'missing' | 'ambiguous' {
  const all = markers(parsed);
  const mine = all.filter((m) => m.name === name);
  if (mine.length === 0) return 'missing';
  const begins = mine.filter((m) => m.kind === 'BEGIN');
  const ends = mine.filter((m) => m.kind === 'END');
  if (begins.length !== 1 || ends.length !== 1) return 'ambiguous';
  const b = begins[0]!;
  const e = ends[0]!;
  if (!b.exact || !e.exact || b.version === null || b.line >= e.line) return 'ambiguous';
  if (all.some((m) => m.line > b.line && m.line < e.line)) return 'ambiguous';
  // 段内不能跨越段头。
  if (sectionAt(parsed, b.line) !== sectionAt(parsed, e.line)) return 'ambiguous';
  return {
    start: b.line,
    end: e.line,
    version: b.version,
    lines: parsed.lines.slice(b.line + 1, e.line).map((l) => l.text),
    section: sectionAt(parsed, b.line),
  };
}

/** 所有格式规范、成对的受管理段的行范围（含标记），用于判断某行是否在受管理段之外。 */
export function managedRanges(parsed: ParsedProfile): Array<{ name: string; start: number; end: number }> {
  const names = new Set(markers(parsed).map((m) => m.name));
  const out: Array<{ name: string; start: number; end: number }> = [];
  for (const name of names) {
    const b = findManagedBlock(parsed, name);
    if (typeof b === 'object') out.push({ name, start: b.start, end: b.end });
  }
  return out;
}

function inRanges(line: number, ranges: Array<{ start: number; end: number }>): boolean {
  return ranges.some((r) => line >= r.start && line <= r.end);
}

function blockLines(name: string, version: number, inner: readonly string[], eol: Exclude<Eol, ''>): ProfileLine[] {
  for (const l of inner) {
    if (/[\r\n]/.test(l)) throw new SfeError('VALIDATION_FAILED', '生成受管理段失败：内容含换行');
    if (LOOSE_MARKER_RE.test(l)) throw new SfeError('VALIDATION_FAILED', '生成受管理段失败：内容含段标记');
  }
  return [
    { text: `${MANAGED_BEGIN} ${name} v${version}`, eol },
    ...inner.map((text) => ({ text, eol })),
    { text: `${MANAGED_END} ${name}`, eol },
  ];
}

/** 替换已有受管理段的内容（段缺失或边界不明确时拒绝）。version 缺省沿用原值。 */
export function replaceManagedBlock(text: string, name: string, inner: readonly string[], version?: number): string {
  const parsed = parseProfile(text);
  const block = findManagedBlock(parsed, name);
  if (typeof block !== 'object') {
    throw new SfeError('BASELINE_CHANGED', '更新受管理段失败：段缺失或边界不明确', { details: { block: name, state: block } });
  }
  const eol = parsed.lines[block.start]!.eol || dominantEol(parsed);
  const replacement = blockLines(name, version ?? block.version, inner, eol);
  // 结束标记保留原有行尾（可能是文件最后一行、无换行）。
  replacement[replacement.length - 1]!.eol = parsed.lines[block.end]!.eol;
  const lines = [...parsed.lines.slice(0, block.start), ...replacement, ...parsed.lines.slice(block.end + 1)];
  return serializeProfile(lines);
}

export interface InitialBlocks {
  group: readonly string[];
  /** temp_rule 策略为 null（配置中不写入口规则）。 */
  entry: readonly string[] | null;
  /** 需要受管理的 http-api 时为 [General] 段内容，否则 null。 */
  general: readonly string[] | null;
}

/**
 * 初始化时插入受管理段：group 段放在 [Proxy Group] 末尾（缺失时在 [Rule] 前新建该段）；
 * entry 段作为 [Rule] 的最前几行；general 段放在 [General] 末尾（缺失时在第一个段前新建）。
 * [Rule] 缺失、关键段重复或已有任何 SFE 段标记时拒绝。
 */
export function insertInitialBlocks(text: string, blocks: InitialBlocks): string {
  const parsed = parseProfile(text);
  if (markers(parsed).length > 0) {
    throw new SfeError('NAME_COLLISION', '初始化失败：配置中已有 SFE 受管理段标记');
  }
  for (const name of ['General', 'Proxy Group', 'Rule']) {
    if (findSections(parsed, name).length > 1) {
      throw new SfeError('VALIDATION_FAILED', `初始化失败：配置中有重复的 [${name}] 段`);
    }
  }
  const rule = findSections(parsed, 'Rule')[0];
  if (!rule) throw new SfeError('VALIDATION_FAILED', '初始化失败：配置缺少 [Rule] 段');
  const eol = dominantEol(parsed);
  // 每个插入点：在第 at 行之前插入 lines（at 为原文件行号）。
  const inserts: Array<{ at: number; lines: ProfileLine[] }> = [];

  const endOfSection = (s: ProfileSection): number => {
    let last = s.header ?? s.start;
    for (let i = s.start; i < s.end; i++) if (parsed.lines[i]!.text.trim() !== '') last = i;
    return last + 1;
  };

  if (blocks.general) {
    const general = findSections(parsed, 'General')[0];
    const lines = blockLines('general', 1, blocks.general, eol);
    if (general) inserts.push({ at: endOfSection(general), lines });
    else {
      const firstHeader = parsed.sections.find((s) => s.header !== null)!;
      inserts.push({ at: firstHeader.start, lines: [{ text: '[General]', eol }, ...lines, { text: '', eol }] });
    }
  }
  const groupLines = blockLines('group', 1, blocks.group, eol);
  const proxyGroup = findSections(parsed, 'Proxy Group')[0];
  if (proxyGroup) inserts.push({ at: endOfSection(proxyGroup), lines: groupLines });
  else inserts.push({ at: rule.start, lines: [{ text: '[Proxy Group]', eol }, ...groupLines, { text: '', eol }] });
  if (blocks.entry) inserts.push({ at: rule.header! + 1, lines: blockLines('entry', 1, blocks.entry, eol) });

  const out: ProfileLine[] = [];
  const src = parsed.lines.map((l) => ({ ...l }));
  for (let i = 0; i <= src.length; i++) {
    for (const ins of inserts.filter((x) => x.at === i)) {
      // 在无换行的最后一行之后插入时，先补上行尾。
      if (out.length > 0 && out[out.length - 1]!.eol === '') out[out.length - 1]!.eol = eol;
      out.push(...ins.lines.map((l) => ({ ...l })));
    }
    if (i < src.length) out.push(src[i]!);
  }
  return serializeProfile(out);
}

/** entry 段位于 [Rule] 段最前（之前只有空行或注释）。 */
export function entryBlockIsFirstRule(parsed: ParsedProfile): boolean {
  const block = findManagedBlock(parsed, 'entry');
  if (typeof block !== 'object' || block.section?.toLowerCase() !== 'rule') return false;
  const rule = findSections(parsed, 'Rule');
  if (rule.length !== 1) return false;
  for (let i = rule[0]!.header! + 1; i < block.start; i++) {
    if (!isCommentLine(parsed.lines[i]!.text)) return false;
  }
  return true;
}

// ---------- 远端托管头与引用 ----------

const MANAGED_CONFIG_RE = /^\s*#!MANAGED-CONFIG\s+(\S+)/i;

function urlHost(raw: string): string | null {
  try {
    const u = new URL(raw);
    return u.hostname || null;
  } catch {
    return null;
  }
}

/** 检测 #!MANAGED-CONFIG 远端托管头；只返回 URL 的主机名（不含路径、查询与用户信息）。 */
export function detectManagedConfigHeader(text: string): { line: number; host: string | null } | null {
  const parsed = parseProfile(text);
  const pre = parsed.sections[0]!;
  const end = pre.name === null ? pre.end : 0;
  for (let i = 0; i < end; i++) {
    const m = MANAGED_CONFIG_RE.exec(parsed.lines[i]!.text);
    if (m) return { line: i + 1, host: urlHost(m[1]!) };
  }
  return null;
}

export function stripManagedConfigHeader(text: string): string {
  const found = detectManagedConfigHeader(text);
  if (!found) return text;
  const parsed = parseProfile(text);
  return serializeProfile(parsed.lines.filter((_, i) => i !== found.line - 1));
}

export interface ProfileReference {
  kind: 'policy-path' | 'rule-set' | 'domain-set' | 'script-path' | 'include';
  value: string;
  line: number;
}

function allReferences(parsed: ParsedProfile): ProfileReference[] {
  const out: ProfileReference[] = [];
  parsed.lines.forEach((l, i) => {
    const line = i + 1;
    const t = l.text.trim();
    const inc = /^#!include\s+(.+)$/i.exec(t);
    if (inc) {
      for (const v of inc[1]!.split(',')) if (v.trim()) out.push({ kind: 'include', value: v.trim(), line });
      return;
    }
    if (isCommentLine(t)) return;
    for (const m of t.matchAll(/\b(policy-path|script-path)\s*=\s*("[^"]*"|[^,\s]+)/gi)) {
      out.push({ kind: m[1]!.toLowerCase() as 'policy-path' | 'script-path', value: m[2]!.replace(/^"|"$/g, ''), line });
    }
    // RULE-SET / DOMAIN-SET 可能出现在逻辑规则内部，按顶层切分后逐个查看。
    const scan = (text: string): void => {
      const parts = splitTopLevel(text);
      if (!parts || parts.length < 2) return;
      const type = parts[0]!.toUpperCase();
      if (type === 'RULE-SET' || type === 'DOMAIN-SET') {
        out.push({ kind: type === 'RULE-SET' ? 'rule-set' : 'domain-set', value: parts[1]!, line });
      } else if (type === 'AND' || type === 'OR' || type === 'NOT') {
        const inner = parts[1]!;
        if (inner.startsWith('(') && inner.endsWith(')')) {
          for (const item of splitTopLevel(inner.slice(1, -1)) ?? []) {
            if (item.startsWith('(') && item.endsWith(')')) scan(item.slice(1, -1));
          }
        }
      }
    };
    if (sectionAt(parsed, i)?.toLowerCase() === 'rule') scan(t);
  });
  return out;
}

function isRemote(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
}

/** 本地相对路径引用（policy-path=、RULE-SET/DOMAIN-SET、script-path=、#!include）；URL、绝对路径与内置规则集不计。 */
export function listRelativeReferences(text: string): ProfileReference[] {
  return allReferences(parseProfile(text)).filter(
    (r) => !isRemote(r.value) && !r.value.startsWith('/') && !r.value.startsWith('~') && !/^[A-Z][A-Z0-9_-]*$/.test(r.value),
  );
}

/**
 * 远端来源（#!include URL、远端规则集/节点/脚本）的主机名，去重排序。ownResourceUrl：本应用本机资源服务的地址（D10）——
 * 与它完全相同的引用不是“源配置的远端来源”，不计入（也就不触发远端更新提示）；其他指向回环地址的引用照常计入。
 */
export function listRemoteSourceHosts(text: string, ownResourceUrl?: string | null): string[] {
  const hosts = new Set<string>();
  for (const r of allReferences(parseProfile(text))) {
    if (!isRemote(r.value)) continue;
    if (ownResourceUrl && r.value === ownResourceUrl) continue;
    const h = urlHost(r.value);
    if (h) hosts.add(h);
  }
  return [...hosts].sort();
}

// ---------- 非本应用的 SFE- 对象 ----------

export interface ForeignSfeObject {
  /** resource_reference：指向本机资源服务端口的引用（段外），或受管理段内不是本应用地址的远端引用。 */
  kind: 'proxy' | 'group' | 'file_reference' | 'resource_reference';
  /** 名称或文件名；resource_reference 只给主机与端口（从不含路径：本机资源服务地址的路径中有读取令牌）。 */
  name: string;
  section: string | null;
  line: number;
}

export interface OwnedSfeObjects {
  names: readonly string[];
  files: readonly string[];
  /**
   * 本应用本机资源服务的地址（D10，nodeResourceUrl 的结果）。给出时，受管理 group 段之外任何指向 `127.0.0.1:<该端口>`
   * （或 localhost、[::1] 的同一端口）的文字都报为 resource_reference（例如另一个组用 policy-path 导入了本应用的节点，
   * 或把令牌抄到了别处）。受管理段内的远端引用只有与它完全相同的才属于本应用；没有给出时受管理段内的任何远端引用都不属于本应用。
   */
  resourceUrl?: string | null;
}

/** 回环主机加端口（URL 的主机部分、`key@127.0.0.1:端口`、`127.0.0.1:端口` 等写法）。 */
const LOOPBACK_PORT_RE = /(?<![0-9A-Za-z.-])(127\.0\.0\.1|localhost|\[::1\]):(\d{1,5})(?!\d)/gi;

/** URL 的主机与端口（不含用户信息、路径与查询）；无法解析时为 null。 */
function urlHostPort(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (!u.hostname) return null;
    return u.port ? `${u.hostname}:${u.port}` : u.hostname;
  } catch {
    return null;
  }
}

/**
 * Surge 读到的策略名（listPolicies 的节点与组）中，属于“外来 SFE- 名称”的那些：以 SFE- 开头、不在 owned 中，且不是本机资源
 * 列表的占位节点 SFE-EMPTY（D10：没有节点时资源只含 `SFE-EMPTY = reject`，Surge 会把它列为策略）。只用于 Surge 的策略列表：
 * 配置文本中出现的 SFE-EMPTY 定义仍由 findForeignSfeObjects 报为外来对象（本应用从不把它写进配置；同名定义会让资源中的占位行
 * 作为重名被跳过）。
 */
export function foreignSfePolicyNames(names: readonly string[], owned: ReadonlySet<string>): string[] {
  return names.filter((n) => /^SFE-/i.test(n) && n !== EMPTY_PLACEHOLDER_NODE && !owned.has(n));
}

/**
 * 受管理段之外出现的 SFE- 节点/组定义与指向 sfe-* 文件的引用，以及受管理段内不在清单中的名称或文件；受管理段内不属于本应用的
 * 远端引用，以及（owned.resourceUrl 给出时）受管理 group 段之外指向本机资源服务端口的文字（见 OwnedSfeObjects.resourceUrl）。
 * 只返回名称、段与行号，不返回行内容。
 */
export function findForeignSfeObjects(text: string, owned: OwnedSfeObjects): ForeignSfeObject[] {
  const parsed = parseProfile(text);
  const ranges = managedRanges(parsed);
  const out: ForeignSfeObject[] = [];
  const ownedNames = new Set(owned.names);
  const ownedFiles = new Set(owned.files.map((f) => f.toLowerCase()));
  const ownUrl = owned.resourceUrl ?? null;
  const own = ownUrl === null ? null : parseNodeResourceUrl(ownUrl);
  if (ownUrl !== null && own === null) throw new SfeError('VALIDATION_FAILED', '检查配置失败：本机资源服务地址不正确');
  const groupBlock = findManagedBlock(parsed, 'group');
  const inGroupBlock = (i: number): boolean => typeof groupBlock === 'object' && i > groupBlock.start && i < groupBlock.end;
  parsed.lines.forEach((l, i) => {
    if (isCommentLine(l.text)) return;
    const section = sectionAt(parsed, i);
    const inside = inRanges(i, ranges);
    const lower = section?.toLowerCase();
    if (lower === 'proxy' || lower === 'proxy group') {
      const m = /^\s*([^=]+?)\s*=/.exec(l.text);
      const name = m?.[1];
      if (name && /^SFE-/i.test(name) && (!inside || !ownedNames.has(name))) {
        out.push({ kind: lower === 'proxy' ? 'proxy' : 'group', name, section, line: i + 1 });
      }
    }
  });
  // 受管理 group 段之外指向本机资源服务端口的文字（注释除外；#!include 照常检查）。每行最多报一次。
  if (own !== null) {
    parsed.lines.forEach((l, i) => {
      const t = l.text.trim();
      if (inGroupBlock(i) || (isCommentLine(t) && !/^#!/.test(t))) return;
      for (const m of l.text.matchAll(LOOPBACK_PORT_RE)) {
        if (Number(m[2]) !== own.port) continue;
        out.push({ kind: 'resource_reference', name: `${m[1]!.toLowerCase()}:${own.port}`, section: sectionAt(parsed, i), line: i + 1 });
        return;
      }
    });
  }
  for (const r of allReferences(parsed)) {
    // 受管理段内的远端引用：只有与本应用本机资源服务地址完全相同、且在 group 段内的才属于本应用。
    if (isRemote(r.value) && inRanges(r.line - 1, ranges) && !(ownUrl !== null && r.value === ownUrl && inGroupBlock(r.line - 1))) {
      if (!out.some((o) => o.kind === 'resource_reference' && o.line === r.line)) {
        out.push({ kind: 'resource_reference', name: urlHostPort(r.value) ?? 'URL', section: sectionAt(parsed, r.line - 1), line: r.line });
      }
      continue;
    }
    if (r.kind === 'include' || isRemote(r.value)) continue;
    const base = r.value.slice(r.value.lastIndexOf('/') + 1).toLowerCase();
    if (!base.startsWith('sfe-')) continue;
    const inside = inRanges(r.line - 1, ranges);
    if (!inside || !ownedFiles.has(base)) {
      out.push({ kind: 'file_reference', name: base, section: sectionAt(parsed, r.line - 1), line: r.line });
    }
  }
  return out.sort((a, b) => a.line - b.line);
}

// ---------- 差异 ----------

export type DiffOp = { type: 'eq' | 'del' | 'add'; a: number; b: number };

/** 行级 LCS 差异。先去掉公共前后缀；中间部分过大时退化为整体替换（仍正确，只是不最小）。 */
export function diffLines(a: readonly string[], b: readonly string[]): DiffOp[] {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const ops: DiffOp[] = [];
  for (let i = 0; i < pre; i++) ops.push({ type: 'eq', a: i, b: i });
  const n = a.length - pre - suf;
  const m = b.length - pre - suf;
  if (n * m > 16_000_000) {
    for (let i = 0; i < n; i++) ops.push({ type: 'del', a: pre + i, b: pre });
    for (let j = 0; j < m; j++) ops.push({ type: 'add', a: pre + n, b: pre + j });
  } else {
    const w = m + 1;
    const dp = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i * w + j] = a[pre + i] === b[pre + j] ? dp[(i + 1) * w + j + 1]! + 1 : Math.max(dp[(i + 1) * w + j]!, dp[i * w + j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a[pre + i] === b[pre + j]) {
        ops.push({ type: 'eq', a: pre + i, b: pre + j });
        i++;
        j++;
      } else if (i < n && (j >= m || dp[(i + 1) * w + j]! >= dp[i * w + j + 1]!)) {
        ops.push({ type: 'del', a: pre + i, b: pre + j });
        i++;
      } else {
        ops.push({ type: 'add', a: pre + i, b: pre + j });
        j++;
      }
    }
  }
  for (let k = 0; k < suf; k++) ops.push({ type: 'eq', a: a.length - suf + k, b: b.length - suf + k });
  return ops;
}

/** 统一差异格式（调用方负责先脱敏）。行尾差异不计。 */
export function unifiedDiff(a: string, b: string, context = 3, labels: [string, string] = ['a', 'b']): string {
  const al = splitLines(a).map((l) => l.text);
  const bl = splitLines(b).map((l) => l.text);
  const ops = diffLines(al, bl);
  const changed = ops.map((o, i) => (o.type === 'eq' ? -1 : i)).filter((i) => i >= 0);
  if (changed.length === 0) return '';
  const hunks: Array<[number, number]> = [];
  for (const idx of changed) {
    const lo = Math.max(0, idx - context);
    const hi = Math.min(ops.length - 1, idx + context);
    const last = hunks[hunks.length - 1];
    if (last && lo <= last[1] + 1) last[1] = Math.max(last[1], hi);
    else hunks.push([lo, hi]);
  }
  const out = [`--- ${labels[0]}`, `+++ ${labels[1]}`];
  for (const [lo, hi] of hunks) {
    const slice = ops.slice(lo, hi + 1);
    const aCount = slice.filter((o) => o.type !== 'add').length;
    const bCount = slice.filter((o) => o.type !== 'del').length;
    const aStart = aCount === 0 ? slice[0]!.a : slice.find((o) => o.type !== 'add')!.a + 1;
    const bStart = bCount === 0 ? slice[0]!.b : slice.find((o) => o.type !== 'del')!.b + 1;
    out.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`);
    for (const o of slice) {
      if (o.type === 'eq') out.push(` ${al[o.a]}`);
      else if (o.type === 'del') out.push(`-${al[o.a]}`);
      else out.push(`+${bl[o.b]}`);
    }
  }
  return `${out.join('\n')}\n`;
}

/**
 * 受管理段之外的改动位置：按段汇总新文本中的行号（删除的行记在删除发生的位置）。不含内容。
 */
export function describeOutsideChanges(oldText: string, newText: string): Array<{ section: string; lines: number[] }> {
  const oldP = parseProfile(oldText);
  const newP = parseProfile(newText);
  const oldRanges = managedRanges(oldP);
  const newRanges = managedRanges(newP);
  const ops = diffLines(
    oldP.lines.map((l) => l.text),
    newP.lines.map((l) => l.text),
  );
  const bySection = new Map<string, Set<number>>();
  const add = (section: string | null, line: number): void => {
    const key = section ?? '(前导)';
    if (!bySection.has(key)) bySection.set(key, new Set());
    bySection.get(key)!.add(line);
  };
  for (const o of ops) {
    if (o.type === 'add' && !inRanges(o.b, newRanges)) add(sectionAt(newP, o.b), o.b + 1);
    if (o.type === 'del' && !inRanges(o.a, oldRanges)) add(sectionAt(oldP, o.a), Math.max(1, Math.min(o.b + 1, newP.lines.length)));
  }
  return [...bySection.entries()].map(([section, set]) => ({ section, lines: [...set].sort((x, y) => x - y) }));
}
