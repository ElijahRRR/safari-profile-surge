// 终端输出与提议摘要的脱敏（原始证据另存限权目录，从不打印）。在服务的按行规则之外再遮盖：
// IP 地址（回环除外）、邮箱、用户主目录中的用户名、长令牌；去掉控制字符。
// 摘要因此不含出口 IP、账号、浏览记录或原始请求头。

import { isIP } from 'node:net';
import { redactFreeText } from './deps.js';

export interface SummaryRedactOptions {
  /** 当前用户主目录；出现时替换为 ~。 */
  home?: string | null;
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const IPV4_RE = /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?!\.?\d)/g;
// IPv6 候选：至少两个冒号的十六进制串（含 ::），再用 isIP 精确判断，避免误伤时间 12:30:45。
const IPV6_CANDIDATE_RE = /(?<![A-Za-z0-9:])(?:[0-9A-Fa-f]{0,4}:){2,7}[0-9A-Fa-f]{0,4}(?![A-Za-z0-9:])/g;
// 长令牌（hex/base64url；32 个字符以上且同时含字母与数字）。不含 /，避免把路径当成令牌；
// 带 sha256: 或 hmac-sha256: 前缀的摘要保留。
const TOKEN_RE = /(?<![A-Za-z0-9+_-])[A-Za-z0-9+_-]{32,}={0,2}(?![A-Za-z0-9+_-])/g;
const DIGEST_PREFIX_RE = /(?:sha256|hmac-sha256):$/;
const USERS_RE = /\/Users\/[^/\s"'`,)]+/g;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

function isLoopbackV4(ip: string): boolean {
  return ip.startsWith('127.') || ip === '0.0.0.0';
}

export function redactSummary(text: string, opts: SummaryRedactOptions = {}): string {
  let out = redactFreeText(String(text)).replace(CONTROL_RE, '');
  if (opts.home && opts.home.length > 1) out = out.split(opts.home).join('~');
  out = out.replace(USERS_RE, '/Users/<user>');
  out = out.replace(EMAIL_RE, '<email>');
  out = out.replace(IPV4_RE, (m) => (m.split('.').some((o) => Number(o) > 255) || isLoopbackV4(m) ? m : '<ip>'));
  out = out.replace(IPV6_CANDIDATE_RE, (m) => (isIP(m) === 6 && m !== '::1' ? '<ip>' : m));
  out = out.replace(TOKEN_RE, (m, offset: number, whole: string) => {
    if (!/\d/.test(m) || !/[A-Za-z]/.test(m)) return m;
    const before = whole.slice(Math.max(0, offset - 12), offset);
    return DIGEST_PREFIX_RE.test(before) ? m : '<token>';
  });
  return out;
}

/** 多行摘要逐行脱敏并限制总长度（提议摘要上限 8000 字符）。 */
export function redactSummaryLines(lines: readonly string[], opts: SummaryRedactOptions = {}, maxChars = 8000): string {
  const text = lines.map((l) => redactSummary(l, opts)).join('\n');
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}
