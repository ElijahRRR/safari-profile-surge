// 配置文本与 Surge 自由文本的按行规则脱敏（服务的按值脱敏器之外的第二道防线）。
// 遮盖：节点行凭据参数与位置式用户名/密码、http-api*、[MITM] ca-*、WireGuard 密钥、URL 用户信息与查询。

import { parseProfile, serializeProfile } from './profile.js';

// 受管理段之外改动的位置描述（只给段名与行号）与差异工具放在 profile.ts，这里一并导出。
export { describeOutsideChanges } from './profile.js';

export const MASK = '***';

const SECRET_PARAM_RE =
  /^(?:username|user|password|passwd|pass|psk|token|uuid|private-key|preshared-key|public-key|secret|auth|auth-str|args|ws-headers|obfs(?:-[a-z0-9-]+)?|ca-[a-z0-9-]+|http-api[a-z0-9-]*)$/i;

// 任意位置出现的 key=value 秘密参数（含 WireGuard peer = (public-key = …) 形式）。
const INLINE_SECRET_RE =
  /\b(password|passwd|psk|token|uuid|username|private-key|preshared-key|public-key|ca-passphrase|ca-p12|obfs-host|obfs-uri|obfs-password|auth-str)(\s*=\s*)("[^"]*"|[^,\s)]+)/gi;

const URL_RE = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/?#@,"']+@)?([^\s/?#,"']*)([^\s?#,"']*)(\?[^\s#,"']*)?(#[^\s,"']*)?/gi;

/** URL 用户信息、查询与片段替换为 ***；只保留协议、主机与路径。 */
export function redactUrls(text: string): string {
  return text.replace(URL_RE, (_m, scheme: string, userinfo: string | undefined, host: string, path: string, query?: string, frag?: string) => {
    return `${scheme}${userinfo ? `${MASK}@` : ''}${host}${path}${query ? `?${MASK}` : ''}${frag ? `#${MASK}` : ''}`;
  });
}

/** 节点行：host/port 之后的位置参数（http/socks5 的用户名、密码）与凭据类参数都遮盖。 */
export function redactProxyLine(line: string): string {
  const m = /^(\s*[^=#;][^=]*?\s*=\s*)(.*)$/.exec(line);
  if (!m) return redactFreeText(line);
  const parts = m[2]!.split(',');
  const out = parts.map((part, i) => {
    if (i === 0) return part;
    const eq = part.indexOf('=');
    if (eq > 0) {
      const key = part.slice(0, eq).trim();
      if (SECRET_PARAM_RE.test(key)) {
        const lead = /^\s*/.exec(part)![0];
        return `${lead}${key}=${MASK}`;
      }
      return redactUrls(part);
    }
    if (i >= 3 && part.trim() !== '') return ` ${MASK}`;
    return part;
  });
  return m[1]! + out.join(',');
}

/** 不分段的自由文本（Surge 输出、stderr、--check 输出）。 */
export function redactFreeText(text: string): string {
  return redactUrls(
    text
      .replace(/(http-api[a-z0-9-]*\s*=\s*)[^\r\n]*/gi, `$1${MASK}`)
      .replace(INLINE_SECRET_RE, (_m, key: string, sep: string) => `${key}${sep}${MASK}`),
  );
}

/** 按段的配置脱敏，保留行结构与行尾。 */
export function redactProfileText(text: string): string {
  const parsed = parseProfile(text);
  let section = '';
  const lines = parsed.lines.map((l) => {
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(l.text);
    if (header) {
      section = header[1]!.trim().toLowerCase();
      return l;
    }
    const t = l.text.trim();
    if (t === '' || t.startsWith('#') || t.startsWith('//') || t.startsWith(';')) {
      return { ...l, text: redactUrls(l.text) };
    }
    let text = l.text;
    if (section === 'proxy') {
      text = redactProxyLine(text);
    } else if (section === 'general' && /^\s*http-api/i.test(text)) {
      text = text.replace(/^(\s*[^=]+=\s*).*$/, `$1${MASK}`);
    } else if (section === 'mitm' && /^\s*ca-/i.test(text)) {
      text = text.replace(/^(\s*[^=]+=\s*).*$/, `$1${MASK}`);
    } else if (section.startsWith('wireguard')) {
      text = text.replace(/^(\s*(?:private-key|preshared-key)\s*=\s*).*$/i, `$1${MASK}`);
    }
    return { ...l, text: redactFreeText(text) };
  });
  return serializeProfile(lines);
}
