// 代理凭据字符夹具：每个字符类别一个合成节点，用户名与密码在开头、中间、结尾都含该类字符。
// 出口测试服务对照期望值给出判定（只记长度与判定）。只有经 Surge 节点行 → 刷新 → 实际连接后
// 出口收到的值与期望完全一致的类别才算“已证明安全”。凭据全部是合成的，只写入测试资源。

import { TEST_PROXIES, type TestPorts } from './test-profile.js';

export interface CharsetClass {
  id: string;
  label: string;
  chars: string;
}

export const CHARSET_CLASSES: readonly CharsetClass[] = [
  { id: 'baseline', label: '字母、数字与 . _ ~ -（当前允许）', chars: 'Az9._~-' },
  { id: 'exclamation', label: '!', chars: '!' },
  { id: 'at', label: '@', chars: '@' },
  { id: 'hash', label: '#', chars: '#' },
  { id: 'dollar', label: '$', chars: '$' },
  { id: 'percent', label: '%', chars: '%' },
  { id: 'caret', label: '^', chars: '^' },
  { id: 'amp', label: '&', chars: '&' },
  { id: 'star', label: '*', chars: '*' },
  { id: 'paren', label: '( )', chars: '()' },
  { id: 'plus', label: '+', chars: '+' },
  { id: 'equals', label: '=', chars: '=' },
  { id: 'comma', label: ',', chars: ',' },
  { id: 'semicolon', label: ';', chars: ';' },
  { id: 'colon', label: ':', chars: ':' },
  { id: 'squote', label: "'", chars: "'" },
  { id: 'dquote', label: '"', chars: '"' },
  { id: 'slash', label: '/', chars: '/' },
  { id: 'backslash', label: '\\', chars: '\\' },
  { id: 'question', label: '?', chars: '?' },
  { id: 'bracket', label: '[ ]', chars: '[]' },
  { id: 'brace', label: '{ }', chars: '{}' },
  { id: 'pipe', label: '|', chars: '|' },
  { id: 'angle', label: '< >', chars: '<>' },
  { id: 'backtick', label: '`', chars: '`' },
  { id: 'space', label: '空格', chars: ' ' },
  { id: 'nonascii', label: '非 ASCII（é 中）', chars: 'é中' },
];

export interface CharsetExpectation {
  index: number;
  id: string;
  username: string;
  password: string;
  node: string;
}

export function charsetExpectation(index: number, cls: CharsetClass): CharsetExpectation {
  if (/[\r\n\0]/.test(cls.chars)) throw new RangeError('charset class cannot contain line breaks');
  const k = String(index).padStart(2, '0');
  return {
    index,
    id: cls.id,
    // 前缀 p0cs<序号>x 用于在出口服务中识别类别（即使后面的字符被截断）。
    username: `p0cs${k}x${cls.chars}y${cls.chars}`,
    password: `${cls.chars}q${k}${cls.chars}z${cls.chars}`,
    node: `SFE-N-P0-CS${k}`,
  };
}

export function selectClasses(ids: readonly string[] | undefined): Array<{ index: number; cls: CharsetClass }> {
  const all = CHARSET_CLASSES.map((cls, index) => ({ index, cls }));
  if (!ids || ids.length === 0) return all;
  const unknown = ids.filter((id) => !CHARSET_CLASSES.some((c) => c.id === id));
  if (unknown.length > 0) throw new RangeError(`unknown charset classes: ${unknown.join(',')}`);
  return all.filter((x) => ids.includes(x.cls.id));
}

/** 原样拼接合成凭据的测试节点行（刻意不经 nodeLine 的安全字符校验；只用于测试资源）。 */
export function charsetNodeLine(e: CharsetExpectation, ports: TestPorts): string {
  return `${e.node} = socks5, 127.0.0.1, ${ports.exit}, username=${e.username}, password=${e.password}, underlying-proxy=${TEST_PROXIES.front}`;
}

export type CharsetAuthVerdict = 'exact' | 'username_altered' | 'password_altered' | 'both_altered';

export function compareCredentials(e: CharsetExpectation, username: Buffer, password: Buffer): CharsetAuthVerdict {
  const u = username.equals(Buffer.from(e.username, 'utf8'));
  const p = password.equals(Buffer.from(e.password, 'utf8'));
  return u && p ? 'exact' : !u && !p ? 'both_altered' : !u ? 'username_altered' : 'password_altered';
}

export function charsetIndexOf(username: Buffer): number | null {
  const m = /^p0cs(\d{2})x/.exec(username.toString('latin1'));
  return m ? Number(m[1]) : null;
}

export type CharsetClassResult =
  | 'safe'
  | 'altered'
  | 'skipped_by_surge'
  | 'check_failed'
  | 'no_connection'
  | 'not_tested';

export interface CharsetObservation {
  index: number;
  inMembers: boolean;
  selected: boolean;
  requestOk: boolean;
  authVerdicts: CharsetAuthVerdict[];
}

export function classifyCharset(o: CharsetObservation, checkOk: boolean): CharsetClassResult {
  if (!checkOk) return 'check_failed';
  if (!o.inMembers) return 'skipped_by_surge';
  if (!o.selected) return 'not_tested';
  if (o.authVerdicts.length === 0) return 'no_connection';
  return o.authVerdicts.every((v) => v === 'exact') && o.requestOk ? 'safe' : 'altered';
}
