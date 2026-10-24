// 节点行变化判定（docs/ARCHITECTURE.md §4）：只有协议、地址、端口、用户名/密码指纹、解析后的前置 id
// 变化才产生新代理版本与新节点名。预期出口 IP 不是节点参数，修改它只是纯数据。

import type { ProxyProtocol } from '@sfe/contract';

/** 一个代理版本中决定 Surge 节点行的全部字段（秘密只以 HMAC 指纹出现）。 */
export interface NodeLineFields {
  protocol: ProxyProtocol;
  host: string;
  port: number;
  usernameFp: string | null;
  passwordFp: string | null;
  frontProxyId: string;
}

/** 比较两组节点行字段；任一字段不同即需要新版本。 */
export function nodeLineChanged(old: NodeLineFields | null, next: NodeLineFields): boolean {
  if (old === null) return true;
  return (
    old.protocol !== next.protocol ||
    old.host !== next.host ||
    old.port !== next.port ||
    (old.usernameFp ?? null) !== (next.usernameFp ?? null) ||
    (old.passwordFp ?? null) !== (next.passwordFp ?? null) ||
    old.frontProxyId !== next.frontProxyId
  );
}

/** 只列出发生变化的节点行字段名（用于步骤记录，不含值）。 */
export function changedNodeLineFields(old: NodeLineFields | null, next: NodeLineFields): string[] {
  if (old === null) return ['protocol', 'host', 'port', 'username', 'password', 'frontProxyId'];
  const out: string[] = [];
  if (old.protocol !== next.protocol) out.push('protocol');
  if (old.host !== next.host) out.push('host');
  if (old.port !== next.port) out.push('port');
  if ((old.usernameFp ?? null) !== (next.usernameFp ?? null)) out.push('username');
  if ((old.passwordFp ?? null) !== (next.passwordFp ?? null)) out.push('password');
  if (old.frontProxyId !== next.frontProxyId) out.push('frontProxyId');
  return out;
}
