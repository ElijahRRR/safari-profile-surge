// 入口切换期间的“放行窗口”检查（纯函数）：把 Surge 记录中每条 Safari 请求映射到当时生效的入口位组合，
// 判断其结果（拒绝 / 经 SFE-ROUTE / 按用户原规则放行）是否属于该状态允许的结果。写入未确认的区间内
// 同时接受前后两个状态（规划保证两者都安全）；超出两者的结果即为放行窗口或误路由。

import { ROUTE_GROUP_NAME, type EntryBits } from '@sfe/contract';
import { ENTRY_BITS_IN_ORDER, REJECT_POLICIES, semanticOfOrder } from '../deps.js';

export type Outcome = 'pass' | 'reject' | 'route';

export interface EntryTimelineStep {
  /** 本步写入开始（上一步确认时间或切换开始时间）。 */
  from: number;
  /** 本步读回确认时间。 */
  to: number;
  before: EntryBits;
  after: EntryBits;
}

export interface EntryTimeline {
  initial: EntryBits;
  steps: EntryTimelineStep[];
}

export interface ObservedRequest {
  at: number;
  processPath: string | null;
  host: string | null;
  protocol: 'tcp' | 'udp' | null;
  policy: string | null;
}

export interface WindowViolation {
  at: number;
  target: 'verify' | 'other';
  protocol: 'tcp' | 'udp';
  outcome: Outcome;
  allowed: Outcome[];
}

export function outcomeOf(policy: string | null): Outcome | null {
  if (policy === null || policy === '') return null;
  if (REJECT_POLICIES.has(policy.toUpperCase())) return 'reject';
  if (policy === ROUTE_GROUP_NAME) return 'route';
  return 'pass';
}

export function expectedOutcome(bits: EntryBits, protocol: 'tcp' | 'udp', toVerifyHost: boolean): Outcome {
  const sem = semanticOfOrder(ENTRY_BITS_IN_ORDER.filter((b) => bits[b]));
  if (protocol === 'udp') return toVerifyHost ? sem.udpVerify : sem.udpOther;
  return toVerifyHost ? sem.tcpVerify : sem.tcpOther;
}

/** 某时刻可能生效的位组合（写入未确认区间加上时钟误差内为前后两者）。 */
export function candidateBits(timeline: EntryTimeline, at: number, graceMs: number): EntryBits[] {
  let current = timeline.initial;
  const out: EntryBits[] = [];
  for (const s of timeline.steps) {
    if (at < s.from - graceMs) break;
    if (at <= s.to + graceMs) {
      out.push(s.before, s.after);
      return out;
    }
    current = s.after;
  }
  out.push(current);
  return out;
}

export function analyzeEntryWindow(
  timeline: EntryTimeline,
  requests: readonly ObservedRequest[],
  opts: { processPaths: readonly string[]; verifyHost: string; graceMs?: number; from: number; to: number },
): { checked: number; unclassified: number; violations: WindowViolation[] } {
  const grace = opts.graceMs ?? 1500;
  const paths = new Set(opts.processPaths);
  const host = opts.verifyHost.toLowerCase();
  let checked = 0;
  let unclassified = 0;
  const violations: WindowViolation[] = [];
  for (const r of requests) {
    if (r.processPath === null || !paths.has(r.processPath)) continue;
    if (r.at < opts.from || r.at > opts.to) continue;
    const outcome = outcomeOf(r.policy);
    const protocol = r.protocol ?? 'tcp';
    if (outcome === null) {
      unclassified++;
      continue;
    }
    checked++;
    const toVerify = (r.host ?? '').toLowerCase() === host;
    const allowed = [...new Set(candidateBits(timeline, r.at, grace).map((b) => expectedOutcome(b, protocol, toVerify)))];
    if (!allowed.includes(outcome)) violations.push({ at: r.at, target: toVerify ? 'verify' : 'other', protocol, outcome, allowed });
  }
  return { checked, unclassified, violations };
}
