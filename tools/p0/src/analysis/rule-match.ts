// 入口模式的 rule match 矩阵（纯函数）。每个模式读回确认后，对 Safari 的每个进程路径与对照（Chrome）进程路径，
// 分别以检测主机与其他主机、TCP / UDP / QUIC 调用 `rule match`（Mac 6.9.0+，协议 ≥20；内置帮助：“Evaluate the active
// rule set without creating a connection, then show the matched rule and final policy.”；protocol “such as TCP, UDP, HTTP,
// HTTPS, QUIC, or STUN”），与该模式的预期比较：
// - Safari：QUIC 与 UDP 同类（规则文档：“`PROTOCOL,UDP` also matches QUIC and STUN connections.”）；结果为 REJECT 或经
//   SFE-ROUTE 时，命中的必须是本应用入口规则；NORMAL（或该类流量放行）时不能命中本应用入口规则；
// - 对照：从不命中本应用入口规则，最终策略从不是 SFE-ROUTE 或本应用节点（Chrome 不应被 Safari 规则命中）。
// TODO(P0)：rule match 是否包含临时规则、命中规则集时 rule 是 RULE-SET 行还是子规则、“final policy” 是组名还是组内选择——
// 下面按“规则文本含 Safari 进程路径或 sfe-entry- 规则集文件名”识别本应用入口规则，对这些写法都接受。

import { ROUTE_GROUP_NAME, type KnownEntryMode } from '@sfe/contract';
import { REJECT_POLICIES, semanticOfMode, type EntryClass, type Outcome } from '../deps.js';

export type MatchProtocol = 'TCP' | 'UDP' | 'QUIC';
export const MATCH_PROTOCOLS: readonly MatchProtocol[] = ['TCP', 'UDP', 'QUIC'];

export interface MatchProbe {
  processPath: string;
  host: string;
  protocol: MatchProtocol;
  /** Safari 进程路径（false 为对照）。 */
  safari: boolean;
  /** 目标是检测主机。 */
  verify: boolean;
}

export interface MatchRecord extends MatchProbe {
  mode: KnownEntryMode;
  /** 命中的规则文本（已脱敏）；读取失败为 null。 */
  rule: string | null;
  policy: string | null;
  /** 读取失败时的错误码。 */
  error: string | null;
}

export function matchProbes(opts: { processPaths: readonly string[]; controlPaths: readonly string[]; verifyHost: string; otherHost: string }): MatchProbe[] {
  const out: MatchProbe[] = [];
  const add = (processPath: string, safari: boolean): void => {
    for (const [host, verify] of [
      [opts.verifyHost, true],
      [opts.otherHost, false],
    ] as const) {
      for (const protocol of MATCH_PROTOCOLS) out.push({ processPath, host, protocol, safari, verify });
    }
  };
  for (const p of opts.processPaths) add(p, true);
  for (const p of opts.controlPaths) if (!opts.processPaths.includes(p)) add(p, false);
  return out;
}

/** Safari 流量类别：QUIC 按 UDP。 */
export function classOf(p: Pick<MatchProbe, 'protocol' | 'verify'>): EntryClass {
  const udp = p.protocol !== 'TCP';
  return udp ? (p.verify ? 'udpVerify' : 'udpOther') : p.verify ? 'tcpVerify' : 'tcpOther';
}

/** 命中的规则是否本应用入口规则：规则文本含某个 Safari 进程路径（临时规则、规则集中的子规则），或指向 sfe-entry- 规则集。 */
export function isEntryRule(rule: string, processPaths: readonly string[]): boolean {
  return /sfe-entry-/i.test(rule) || processPaths.some((p) => rule.includes(p));
}

/** 最终策略的结果类别：REJECT 类为 reject；SFE-ROUTE 或本应用节点（SFE- 前缀）为 route；其他为 pass。 */
export function outcomeOfPolicy(policy: string): Outcome {
  const p = policy.trim();
  if (REJECT_POLICIES.has(p.toUpperCase())) return 'reject';
  if (p === ROUTE_GROUP_NAME || /^SFE-/.test(p)) return 'route';
  return 'pass';
}

export interface MatchJudgement {
  safari: { total: number; mismatches: string[] };
  control: { total: number; hits: string[] };
  /** 读取失败的探测数。 */
  errors: number;
}

const CLASS_LABEL: Record<EntryClass, string> = { tcpVerify: '检测主机 TCP', tcpOther: '其他主机 TCP', udpVerify: '检测主机 UDP', udpOther: '其他主机 UDP' };

export function judgeMatchMatrix(records: readonly MatchRecord[], processPaths: readonly string[]): MatchJudgement {
  const j: MatchJudgement = { safari: { total: 0, mismatches: [] }, control: { total: 0, hits: [] }, errors: 0 };
  for (const r of records) {
    if (r.error !== null || r.rule === null || r.policy === null) {
      j.errors++;
      continue;
    }
    const ours = isEntryRule(r.rule, processPaths);
    const actual = outcomeOfPolicy(r.policy);
    const label = `${r.mode} ${r.protocol} ${r.verify ? '检测主机' : '其他主机'}`;
    if (!r.safari) {
      j.control.total++;
      if (ours || actual === 'route') j.control.hits.push(`${label}：对照进程命中「${r.rule}」，策略 ${r.policy}`);
      continue;
    }
    j.safari.total++;
    const expected = semanticOfMode(r.mode)[classOf(r)];
    const fits = expected === 'pass' ? !ours && actual !== 'route' : ours && actual === expected;
    if (!fits) j.safari.mismatches.push(`${label}（${CLASS_LABEL[classOf(r)]}）：预期 ${expected}，命中「${r.rule}」，策略 ${r.policy}`);
  }
  return j;
}
