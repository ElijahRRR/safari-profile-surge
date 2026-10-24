// 脱敏器（docs/ARCHITECTURE.md §3、§5.1）。两层：
// 1. 按值：登记本次读到或收到的每个秘密值，在任何自由文本中替换（压缩前缀树上的字面匹配：登记是一次插入，
//    从不重新编译；每个位置的匹配代价只取决于匹配到的长度，与登记数量无关；登记表有容量上限）；
// 2. 按规则：Surge 节点行参数（含位置参数形式的用户名/密码）、http-api、X-Key/Authorization/Cookie、
//    `<密钥>@127.0.0.1:端口`、URL 用户信息与查询值、Bearer、JSON 中的敏感键、≥40 字符的 base64 串。
// 规则层是兜底，宁可多遮；任何来自 Surge、子进程或错误的文本都先经过这里再进入日志、步骤、错误或事件。

import type { Scrubber } from '../ports.js';

export const SCRUB_MASK = '‹已隐藏›';
const TRUNCATED = '‹已截断›';
const CIRCULAR = '‹循环引用›';

/**
 * 短于 3 个字符的值不做按值替换：替换 1–2 个字符会把大量正常文本打碎，而这么短的值本身也
 * 不构成有效秘密（代理凭据、密钥、口令都由校验规则保证更长或由规则层兜底）。
 */
export const MIN_REGISTERED_SECRET_LENGTH = 3;

/**
 * 按值登记的长度上限（原始值的 UTF-16 码元数）。合法秘密远短于此：代理凭据 ≤128、账号密码 ≤256 个字符
 * （其 URL 编码与 JSON 转义形式由原始值派生，不受此限）。更长的值只可能来自会被校验拒绝的请求，
 * 登记它们只会无界占用内存，因此直接忽略；规则层仍会遮盖参数、JSON 敏感键与长 base64 串。
 */
export const MAX_REGISTERED_SECRET_LENGTH = 1024;

/**
 * 登记表容量上限（按登记的形式计：原值、URL 编码、JSON 转义各算一条）。超出任一上限时淘汰最久未登记的条目；
 * 同一值再次登记（每次从秘密存储读取或随请求收到时都会登记）会把它移到最新，仍在使用的秘密不会被淘汰。
 * 合法规模远低于此（2000 行导入约 6000 个秘密）；上限只防止被拒绝的请求反复登记垃圾值让内存无界增长。
 */
export const MAX_REGISTERED_VALUES = 50_000;
export const MAX_REGISTERED_CHARS = 4_000_000;

/** scrubDeep 中按键名遮盖的字段（值为字符串、数字或对象时遮盖；布尔与 null 不携带秘密，保留）。 */
export const SENSITIVE_KEY_RE = /pass|secret|token|authorization|cookie|content_base64|login_code|api_?key|private_?key|^code$|auth$/i;

const MAX_DEPTH = 32;
/**
 * `code` 键下允许保留的非秘密值：数字（退出码）、全大写标识（统一错误码、ENOENT 等系统错误码）
 * 与环境编号（E0001）。登录码是 ≥128 位的 base64url 随机串，不会落入这些形状，一律遮盖。
 */
function isPublicCodeValue(value: unknown): boolean {
  if (typeof value === 'number') return true;
  return typeof value === 'string' && (/^[A-Z][A-Z0-9_]{0,47}$/.test(value) || /^E\d{4,}$/.test(value));
}

// ---------- 规则 ----------

const URL_RE = /\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s"'<>`]+/g;
const HEADER_LINE_RE = /\b(authorization|proxy-authorization|cookie|set-cookie|x-api-key)(\s*:\s*)([^\r\n]+)/gi;
const X_KEY_RE = /\b(x-key)(\s*:\s*)(\S+)/gi;
const BEARER_RE = /\b(bearer)(\s+)([^\s,;"']+)/gi;
const HTTP_API_RE = /\b(http-api[\w-]*)(\s*=\s*)(\S+)/gi;
/** `<密钥>@<地址>:<端口>`：Surge http-api 写法，地址为回环、通配或 IP。 */
const API_ADDR_RE = /([^\s@,=:;/"'<>()[\]{}]+)@((?:localhost|\*|(?:\d{1,3}\.){3}\d{1,3}|\[[0-9A-Fa-f:.]+\]):\d{1,5})/g;
/** 节点行与 key=value 形式的敏感参数；值可以带引号。 */
const PARAM_RE =
  /(?<![A-Za-z0-9_-])((?:[A-Za-z0-9]+[-_])*(?:username|password|passwd|passphrase|psk|secret|token|key)|obfs-[a-z-]+|ca-p12)(\s*=\s*)("[^"\r\n]*"|[^,\s]+)/gi;
/**
 * 位置参数形式的代理凭据：`名称 = socks5, 地址, 端口, 用户名, 密码`（http/https/socks5/socks5-tls）。
 * 端口之后不含 `=` 的前两个字段按用户名、密码遮盖。
 */
const POSITIONAL_CRED_RE =
  /^([^\S\r\n]*[^=\r\n#;]+?=[^\S\r\n]*(?:socks5-tls|socks5|https|http)[^\S\r\n]*,[^,\r\n]+,[^\S\r\n]*\d+[^\S\r\n]*,[^\S\r\n]*)([^,=\r\n]+?)(?:([^\S\r\n]*,[^\S\r\n]*)([^,=\r\n]+?))?(?=[^\S\r\n]*(?:,|$))/gim;
/** JSON 文本中的敏感键：只遮盖字符串与数字值。 */
const JSON_KEY_RE =
  /("[^"\\\r\n]*?(?:pass|secret|token|authorization|cookie|content_base64|login_code|api_?key|private_?key)[^"\\\r\n]*"\s*:\s*)("(?:[^"\\]|\\.)*"|-?\d[\d.eE+-]*)/gi;
const BASE64_RUN_RE = /(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{40,}={0,2}/g;

function maskUrl(url: string): string {
  const schemeEnd = url.indexOf('://') + 3;
  let rest = url.slice(schemeEnd);
  // 用户信息：权限部分（第一个 / ? # 之前）中的最后一个 @ 之前
  const authorityEnd = rest.search(/[/?#]/);
  const authority = authorityEnd === -1 ? rest : rest.slice(0, authorityEnd);
  const at = authority.lastIndexOf('@');
  if (at !== -1) rest = `${SCRUB_MASK}${rest.slice(at)}`;
  const q = rest.search(/[?#]/);
  if (q === -1) return url.slice(0, schemeEnd) + rest;
  const head = rest.slice(0, q);
  const tail = rest.slice(q).replace(/=([^&#;]*)/g, (m, v: string) => (v.length === 0 ? m : `=${SCRUB_MASK}`));
  return url.slice(0, schemeEnd) + head + tail;
}

function hasDigit(s: string): boolean {
  return /\d/.test(s);
}

function maskBase64Run(run: string): string {
  const letters = /[A-Za-z]/.test(run);
  if (!letters) return run;
  if (hasDigit(run)) return SCRUB_MASK;
  // 不含数字的长串：含 / 的多半是路径（例如 Safari 在 Cryptexes 下的进程路径），保留；
  // 不含 / 且大小写混合的视为 base64url 随机串，遮盖。
  if (!run.includes('/') && /[A-Z]/.test(run) && /[a-z]/.test(run)) return SCRUB_MASK;
  return run;
}

/** 只按规则脱敏（不含按值登记），供没有 Scrubber 实例的模块级代码使用。 */
export function scrubText(text: string): string {
  let out = typeof text === 'string' ? text : String(text);
  out = out.replace(URL_RE, maskUrl);
  out = out.replace(HEADER_LINE_RE, (_m, name: string, sep: string) => `${name}${sep}${SCRUB_MASK}`);
  out = out.replace(X_KEY_RE, (_m, name: string, sep: string) => `${name}${sep}${SCRUB_MASK}`);
  out = out.replace(BEARER_RE, (_m, name: string, sep: string) => `${name}${sep}${SCRUB_MASK}`);
  out = out.replace(HTTP_API_RE, (_m, name: string, sep: string) => `${name}${sep}${SCRUB_MASK}`);
  out = out.replace(API_ADDR_RE, (_m, _key: string, addr: string) => `${SCRUB_MASK}@${addr}`);
  out = out.replace(POSITIONAL_CRED_RE, (_m, head: string, _user: string, sep: string | undefined, pass: string | undefined) =>
    pass === undefined ? `${head}${SCRUB_MASK}` : `${head}${SCRUB_MASK}${sep ?? ','}${SCRUB_MASK}`,
  );
  out = out.replace(PARAM_RE, (_m, name: string, sep: string) => `${name}${sep}${SCRUB_MASK}`);
  out = out.replace(JSON_KEY_RE, (_m, head: string) => `${head}"${SCRUB_MASK}"`);
  out = out.replace(BASE64_RUN_RE, maskBase64Run);
  return out;
}

// ---------- 按值登记：压缩前缀树（radix tree） ----------
// 边按首个 UTF-16 码元索引，非根的非终止节点至少有两条出边。插入、删除与单个位置的最长匹配都只与值的长度
// 有关，与登记数量无关；同一前缀下有多少个值都不会让匹配变慢。

interface TrieNode {
  edges: Map<number, TrieEdge> | null;
  /** 某个登记值在此结束。 */
  terminal: boolean;
}

interface TrieEdge {
  label: string;
  node: TrieNode;
}

function trieInsert(root: TrieNode, value: string): void {
  let node = root;
  let i = 0;
  for (;;) {
    if (i === value.length) {
      node.terminal = true;
      return;
    }
    const first = value.charCodeAt(i);
    const edge = node.edges?.get(first);
    if (!edge) {
      (node.edges ??= new Map()).set(first, { label: value.slice(i), node: { edges: null, terminal: true } });
      return;
    }
    const label = edge.label;
    const max = Math.min(label.length, value.length - i);
    let k = 1;
    while (k < max && label.charCodeAt(k) === value.charCodeAt(i + k)) k++;
    if (k < label.length) {
      // 在公共前缀处拆分这条边
      const mid: TrieNode = { edges: new Map([[label.charCodeAt(k), { label: label.slice(k), node: edge.node }]]), terminal: false };
      edge.label = label.slice(0, k);
      edge.node = mid;
    }
    node = edge.node;
    i += k;
  }
}

/** 把只剩一条出边的非终止节点并入指向它的边。 */
function mergeDown(edge: TrieEdge): void {
  const node = edge.node;
  if (node.terminal || node.edges?.size !== 1) return;
  const [child] = node.edges.values();
  edge.label += child!.label;
  edge.node = child!.node;
}

function trieRemove(root: TrieNode, value: string): void {
  const path: Array<{ parent: TrieNode; key: number; edge: TrieEdge }> = [];
  let node = root;
  let i = 0;
  while (i < value.length) {
    const key = value.charCodeAt(i);
    const edge = node.edges?.get(key);
    if (!edge || !value.startsWith(edge.label, i)) return;
    path.push({ parent: node, key, edge });
    i += edge.label.length;
    node = edge.node;
  }
  if (!node.terminal) return;
  node.terminal = false;
  const last = path[path.length - 1];
  if (!last) return;
  if (node.edges === null || node.edges.size === 0) {
    // 叶子：去掉这条边；父节点若因此只剩一条出边（且不是根、不是终止）则并入上一条边
    last.parent.edges!.delete(last.key);
    if (last.parent.edges!.size === 0) last.parent.edges = null;
    const up = path[path.length - 2];
    if (up) mergeDown(up.edge);
  } else {
    mergeDown(last.edge);
  }
}

/** 位置 start 起最长的登记值的结束位置；没有则为 -1。 */
function trieLongestMatch(root: TrieNode, text: string, start: number): number {
  let node = root;
  let j = start;
  let end = -1;
  while (j < text.length && node.edges !== null) {
    const edge = node.edges.get(text.charCodeAt(j));
    if (!edge || !text.startsWith(edge.label, j)) break;
    j += edge.label.length;
    node = edge.node;
    if (node.terminal) end = j;
  }
  return end;
}

export interface ScrubberOptions {
  /** 测试用：覆盖登记表容量上限。 */
  maxValues?: number;
  maxChars?: number;
}

/** 按值 + 按规则的脱敏器。登记的值只保存在内存中，从不输出。 */
export function createScrubber(opts: ScrubberOptions = {}): Scrubber & { registeredCount(): number } {
  const maxValues = opts.maxValues ?? MAX_REGISTERED_VALUES;
  const maxChars = opts.maxChars ?? MAX_REGISTERED_CHARS;
  // 最近登记顺序：队列条目带登记序号，值再次登记时追加新条目，旧条目随之过期（淘汰时跳过）。
  // 淘汰与再次登记都是均摊常数时间，不随登记表大小变慢。
  const latest = new Map<string, number>();
  let queue: Array<{ value: string; seq: number }> = [];
  let head = 0;
  let seq = 0;
  let chars = 0;
  const root: TrieNode = { edges: null, terminal: false };

  function addValue(v: string): void {
    if (v.length < MIN_REGISTERED_SECRET_LENGTH) return;
    const known = latest.has(v);
    latest.set(v, ++seq);
    queue.push({ value: v, seq });
    if (!known) {
      chars += v.length;
      trieInsert(root, v);
    }
    while (latest.size > maxValues || chars > maxChars) {
      const e = queue[head++]!;
      if (latest.get(e.value) !== e.seq) continue;
      latest.delete(e.value);
      chars -= e.value.length;
      trieRemove(root, e.value);
    }
    // 已出队或过期的条目过多时压缩队列
    if ((head > 1024 && head * 2 > queue.length) || queue.length - head > 2 * latest.size + 1024) {
      queue = queue.slice(head).filter((e) => latest.get(e.value) === e.seq);
      head = 0;
    }
  }

  function replaceRegistered(text: string): string {
    if (latest.size === 0) return text;
    let out = '';
    let last = 0;
    let i = 0;
    while (i + MIN_REGISTERED_SECRET_LENGTH <= text.length) {
      const end = trieLongestMatch(root, text, i);
      if (end < 0) {
        i++;
        continue;
      }
      out += text.slice(last, i) + SCRUB_MASK;
      i = end;
      last = end;
    }
    return last === 0 ? text : out + text.slice(last);
  }

  function scrub(text: string): string {
    try {
      const out = typeof text === 'string' ? text : String(text);
      return scrubText(replaceRegistered(out));
    } catch {
      // 失败时整体遮盖（fail closed）：脱敏器从不抛异常，也从不放过未脱敏的文本
      return SCRUB_MASK;
    }
  }

  function walk(value: unknown, depth: number, seen: WeakSet<object>): unknown {
    if (typeof value === 'string') return scrub(value);
    if (value === null || value === undefined) return value;
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return value;
    if (typeof value === 'symbol') return scrub(value.toString());
    if (typeof value === 'function') return '[Function]';
    if (typeof value !== 'object') return scrub(String(value));
    if (value instanceof Date) return value;
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return SCRUB_MASK;
    if (depth >= MAX_DEPTH) return TRUNCATED;
    if (seen.has(value)) return CIRCULAR;
    seen.add(value);
    try {
      if (Array.isArray(value)) return value.map((v) => walk(v, depth + 1, seen));
      if (value instanceof Map) return [...value.entries()].map(([k, v]) => [walk(k, depth + 1, seen), walk(v, depth + 1, seen)]);
      if (value instanceof Set) return [...value].map((v) => walk(v, depth + 1, seen));
      if (value instanceof Error) {
        const plain: Record<string, unknown> = { name: value.name, message: scrub(value.message) };
        const extra = value as Error & { code?: unknown; details?: unknown };
        if (extra.code !== undefined) plain.code = walkValueForKey('code', extra.code, depth, seen);
        if (extra.details !== undefined) plain.details = walk(extra.details, depth + 1, seen);
        return plain;
      }
      const src = value as Record<string, unknown>;
      // SecretChange 的替换值：保留形状，只遮盖值
      if (src.action === 'replace' && 'value' in src) {
        const copy: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(src)) copy[k] = k === 'value' ? SCRUB_MASK : walkValueForKey(k, v, depth, seen);
        return copy;
      }
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(src)) out[k] = walkValueForKey(k, v, depth, seen);
      return out;
    } finally {
      seen.delete(value);
    }
  }

  function walkValueForKey(key: string, v: unknown, depth: number, seen: WeakSet<object>): unknown {
    if (SENSITIVE_KEY_RE.test(key)) {
      if (v === null || v === undefined || typeof v === 'boolean') return v;
      if (key.toLowerCase() === 'code' && isPublicCodeValue(v)) return v;
      return SCRUB_MASK;
    }
    return walk(v, depth + 1, seen);
  }

  return {
    register(secret: string): void {
      if (typeof secret !== 'string' || secret.length < MIN_REGISTERED_SECRET_LENGTH || secret.length > MAX_REGISTERED_SECRET_LENGTH) return;
      let encoded: string;
      try {
        encoded = encodeURIComponent(secret);
      } catch {
        // 孤立代理项无法 URL 编码：只登记原值与 JSON 转义形式
        encoded = secret;
      }
      for (const v of new Set([secret, encoded, JSON.stringify(secret).slice(1, -1)])) addValue(v);
    },
    scrub,
    scrubDeep<T>(value: T): T {
      return walk(value, 0, new WeakSet()) as T;
    },
    registeredCount(): number {
      return latest.size;
    },
  };
}
