// 脱敏差异（导入预览、版本冲突、前置更换）：秘密字段只显示“已设置/已修改/已清除”，登录账号打码，
// 从不出现秘密原文或其无密钥哈希。字段名与 EnvironmentInput 的路径一致。

import { maskLoginIdentifier } from '@sfe/contract';

/** 用于比较的环境状态；秘密只以指纹出现（指纹本身也不进入差异输出）。 */
export interface EnvironmentDiffState {
  displayName: string;
  site: string;
  autoOpenOrders: boolean;
  autoFillLogin: boolean;
  protocol: string;
  host: string;
  port: number;
  usernameFp: string | null;
  passwordFp: string | null;
  frontProxyName: string | null;
  expectedExitIp: string | null;
  accountLabel: string | null;
  loginIdentifier: string | null;
  accountPasswordFp: string | null;
}

export interface DiffEntry {
  field: string;
  before: string | null;
  after: string | null;
}

const onOff = (v: boolean): string => (v ? '开' : '关');

function secretDiff(field: string, before: string | null | undefined, after: string | null | undefined, out: DiffEntry[]): void {
  const b = before ?? null;
  const a = after ?? null;
  if (b === a) return;
  out.push({ field, before: b === null ? '未设置' : '已设置', after: a === null ? '已清除' : '已修改' });
}

function plain(field: string, before: string | null, after: string | null, out: DiffEntry[]): void {
  if (before === after) return;
  out.push({ field, before, after });
}

/** before 为 null 表示新建（全部字段都列出）。 */
export function environmentDiff(before: EnvironmentDiffState | null, after: EnvironmentDiffState): DiffEntry[] {
  const out: DiffEntry[] = [];
  const b = before;
  plain('displayName', b?.displayName ?? null, after.displayName, out);
  plain('site', b?.site ?? null, after.site, out);
  plain('autoOpenOrders', b ? onOff(b.autoOpenOrders) : null, onOff(after.autoOpenOrders), out);
  plain('autoFillLogin', b ? onOff(b.autoFillLogin) : null, onOff(after.autoFillLogin), out);
  plain('proxy.protocol', b?.protocol ?? null, after.protocol, out);
  plain('proxy.host', b?.host ?? null, after.host, out);
  plain('proxy.port', b ? String(b.port) : null, String(after.port), out);
  if (b) {
    secretDiff('proxy.username', b.usernameFp, after.usernameFp, out);
    secretDiff('proxy.password', b.passwordFp, after.passwordFp, out);
  } else {
    if (after.usernameFp !== null) out.push({ field: 'proxy.username', before: null, after: '已设置' });
    if (after.passwordFp !== null) out.push({ field: 'proxy.password', before: null, after: '已设置' });
  }
  plain('proxy.frontProxy', b?.frontProxyName ?? null, after.frontProxyName, out);
  plain('proxy.expectedExitIp', b?.expectedExitIp ?? null, after.expectedExitIp, out);
  plain('account.label', b?.accountLabel ?? null, after.accountLabel, out);
  const bi = b ? maskLoginIdentifier(b.loginIdentifier) : null;
  const ai = maskLoginIdentifier(after.loginIdentifier);
  if ((b?.loginIdentifier ?? null) !== after.loginIdentifier) {
    // 打码后可能相同（例如只改了中间字符）：仍然记录为变化。
    out.push({ field: 'account.loginIdentifier', before: bi, after: ai });
  }
  if (b) secretDiff('account.password', b.accountPasswordFp, after.accountPasswordFp, out);
  else if (after.accountPasswordFp !== null) out.push({ field: 'account.password', before: null, after: '已设置' });
  return out;
}

/** 差异只用于展示；判断“未变化”时比较全部字段（含指纹）。 */
export function sameEnvironmentState(a: EnvironmentDiffState, b: EnvironmentDiffState): boolean {
  return environmentDiff(a, b).length === 0;
}
