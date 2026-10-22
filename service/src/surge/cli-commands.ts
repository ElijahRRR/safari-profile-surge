// Surge CLI 原语表：每个原语对应固定的 argv 构造与输出解析（只接受已知 JSON 结构，无法识别即报错，见 parse-output.ts）。
// 只有 external-resource list/update、--check、dump temp-rule 在 6.5 帮助中出现过（设计文档 §3）；
// 其余标为 unverified，需在 P0 用随包技能与本机帮助核对后才能在原语清单中启用（TODO(P0)）。
// 表中永远不能出现 switch-profile、reload、flush、stop、set-outbound/enhanced/system-proxy 等全局动作；
// 也不提供 kill（新版 CLI 中它与停止 Surge 同组，含义未核实），结束请求只走 HTTP。

import { SfeError } from '@sfe/contract';
import type { SurgeAdapter } from '../ports.js';
import {
  parseExternalResources,
  parseJsonLoose,
  parsePolicyNames,
  parseRequestRecords,
  parseRuleList,
  parseTempRuleList,
  unrecognized,
} from './parse-output.js';
import type { SurgePrimitive } from './primitives.js';
import { truncate } from './primitives.js';

export type CliEvidence = 'seen_in_6.5_help' | 'unverified';

export interface CliOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface CliParseContext {
  /** 自由文本脱敏（按值 + 按行规则）。 */
  scrub: (text: string) => string;
}

export interface CliCommand<A extends unknown[], R> {
  evidence: CliEvidence;
  argv: (...args: A) => string[];
  parse: (out: CliOutput, ctx: CliParseContext) => R;
  /** 非零退出码是正常结果（--check 校验未通过），不是命令失败。 */
  nonZeroExitIsResult?: boolean;
}

type CommandFor<P extends SurgePrimitive> = CliCommand<Parameters<SurgeAdapter[P]>, Awaited<ReturnType<SurgeAdapter[P]>>>;
export type CliCommandTable = { [P in SurgePrimitive]?: CommandFor<P> };

/** argv 只放路径、资源 key、规则文本：拒绝空值、换行、NUL，以及会被当作选项的“-”开头值。 */
export function safeArg(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || /[\0\r\n]/.test(value) || value.startsWith('-')) {
    throw new SfeError('VALIDATION_FAILED', `执行 Surge 命令失败：参数不合法（${label}）`);
  }
  return value;
}

/** 资源 key 另外不能是 all/* 等可能被解释为“全部”的值。 */
export function safeResourceKey(key: unknown): string {
  const k = safeArg(key, '资源 key');
  if (/^(all|\*|everything)$/i.test(k.trim())) throw new SfeError('VALIDATION_FAILED', '执行 Surge 命令失败：只能按单个资源 key 更新');
  return k;
}

function jsonOrThrow(text: string, what: string): unknown {
  const json = parseJsonLoose(text);
  if (json === undefined) throw unrecognized(what);
  return json;
}

// JSON reads require --raw; the default CLI renderer is intended for humans.
export const CLI_COMMANDS: CliCommandTable = {
  checkProfile: {
    evidence: 'seen_in_6.5_help',
    argv: (path) => ['--check', safeArg(path, '配置路径')],
    nonZeroExitIsResult: true,
    parse: (out, ctx) => ({ ok: out.exitCode === 0, message: truncate(ctx.scrub(`${out.stdout}\n${out.stderr}`), 2000) }),
  },
  listExternalResources: {
    evidence: 'seen_in_6.5_help',
    argv: () => ['--raw', 'external-resource', 'list'],
    parse: (out) => parseExternalResources(jsonOrThrow(out.stdout, '外部资源')),
  },
  updateExternalResource: {
    evidence: 'seen_in_6.5_help',
    argv: (key) => ['external-resource', 'update', safeResourceKey(key)],
    parse: () => undefined,
  },
  listTempRules: {
    evidence: 'seen_in_6.5_help',
    argv: () => ['--raw', 'dump', 'temp-rule'],
    parse: (out) => parseTempRuleList(out.stdout),
  },
  // TODO(P0)：旧式临时规则的新增/删除动词以随包技能列出的命令为准；6.9+ 的 rule temp 形式不能用于 6.5。
  addTempRule: {
    evidence: 'unverified',
    argv: (rule) => ['temp-rule', 'add', safeArg(rule, '规则')],
    parse: () => undefined,
  },
  removeTempRule: {
    evidence: 'unverified',
    argv: (rule) => ['temp-rule', 'remove', safeArg(rule, '规则')],
    parse: () => undefined,
  },
  // TODO(P0)：以下读取命令与输出格式均未在 6.5 上核对。
  getVersion: {
    evidence: 'unverified',
    argv: () => ['--version'],
    parse: (out) => {
      const text = `${out.stdout}\n${out.stderr}`;
      const full = /(\d+\.\d+(?:\.\d+)*)\s*\(\s*(\d+)\s*\)/.exec(text);
      if (full) return { version: full[1]!, build: full[2]! };
      const short = /(\d+\.\d+(?:\.\d+)*)/.exec(text);
      if (short) return { version: short[1]!, build: null };
      throw unrecognized('版本信息');
    },
  },
  listRules: {
    evidence: 'unverified',
    argv: () => ['--raw', 'dump', 'rule'],
    parse: (out, ctx) => parseRuleList(out.stdout, ctx.scrub),
  },
  listActiveRequests: {
    evidence: 'unverified',
    argv: () => ['--raw', 'dump', 'active'],
    parse: (out) => parseRequestRecords(jsonOrThrow(out.stdout, '活动请求')),
  },
  listRecentRequests: {
    evidence: 'unverified',
    argv: () => ['--raw', 'dump', 'request'],
    parse: (out) => parseRequestRecords(jsonOrThrow(out.stdout, '最近请求')),
  },
  listPolicies: {
    evidence: 'unverified',
    argv: () => ['--raw', 'dump', 'policy'],
    // 只取名称；输出中可能出现的节点参数不保留。
    parse: (out) => parsePolicyNames(jsonOrThrow(out.stdout, '策略列表')),
  },
};

/** 永远不能出现在 argv 中的全局动作（测试逐个构造 argv 断言）。 */
export const FORBIDDEN_CLI_WORDS = [
  'switch-profile',
  'reload',
  'flush',
  'stop',
  'kill',
  'set-outbound',
  'set-enhanced',
  'set-system-proxy',
  'outbound',
  'enhanced',
  'system-proxy',
  'mode',
  'update-all',
] as const;
