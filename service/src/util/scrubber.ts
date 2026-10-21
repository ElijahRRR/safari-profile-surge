// 脱敏器（docs/ARCHITECTURE.md §3、§5.1）。两层：
// 1. 按值：登记本次读到或收到的每个秘密值，在任何自由文本中替换；
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

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 按值 + 按规则的脱敏器。登记的值只保存在内存中，从不输出。 */
export function createScrubber(): Scrubber & { registeredCount(): number } {
  const values = new Set<string>();
  let pattern: RegExp | null = null;

  function rebuild(): void {
    if (values.size === 0) {
      pattern = null;
      return;
    }
    const sorted = [...values].sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
    pattern = new RegExp(sorted.map(escapeRegExp).join('|'), 'g');
  }

  function scrub(text: string): string {
    let out = typeof text === 'string' ? text : String(text);
    if (pattern) out = out.replace(pattern, SCRUB_MASK);
    return scrubText(out);
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
      if (typeof secret !== 'string' || secret.length < MIN_REGISTERED_SECRET_LENGTH) return;
      const variants = new Set([secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)]);
      let changed = false;
      for (const v of variants) {
        if (v.length >= MIN_REGISTERED_SECRET_LENGTH && !values.has(v)) {
          values.add(v);
          changed = true;
        }
      }
      if (changed) rebuild();
    },
    scrub,
    scrubDeep<T>(value: T): T {
      return walk(value, 0, new WeakSet()) as T;
    },
    registeredCount(): number {
      return values.size;
    },
  };
}
