// [Proxy] 行（以及 policy-path 资源文件中的节点行）的解析。只在内存中使用；
// 结果中的凭据参数从不外发，调用方展示前必须经 redactProxyLine。

export interface ParsedProxyLine {
  name: string;
  type: string;
  /** host/port 之后的位置参数（http/socks5 的位置式用户名、密码）。 */
  positional: string[];
  server: string | null;
  port: number | null;
  params: Record<string, string>;
}

const LINE_RE = /^\s*([^=#;][^=]*?)\s*=\s*(.+?)\s*$/;

/** 不带类型/主机/端口的策略（DIRECT、REJECT 等）也能解析；无法识别返回 null。 */
export function parseProxyLine(line: string): ParsedProxyLine | null {
  const m = LINE_RE.exec(line);
  if (!m) return null;
  const name = m[1]!.trim();
  const parts = m[2]!.split(',').map((p) => p.trim());
  const type = (parts[0] ?? '').toLowerCase();
  if (!type || type.includes('=')) return null;
  const params: Record<string, string> = {};
  const positional: string[] = [];
  let server: string | null = null;
  let port: number | null = null;
  parts.slice(1).forEach((part, i) => {
    const eq = part.indexOf('=');
    if (eq > 0) {
      params[part.slice(0, eq).trim().toLowerCase()] = part.slice(eq + 1).trim();
      return;
    }
    if (i === 0) server = part || null;
    else if (i === 1) {
      const n = Number(part);
      port = Number.isInteger(n) && n > 0 && n <= 65535 ? n : null;
    } else positional.push(part);
  });
  return { name, type, positional, server, port, params };
}
