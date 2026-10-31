// Safari 实测核对：在 Surge 请求记录中找同一时间窗、Safari 进程路径、检测主机、命中本应用入口规则、
// 经 SFE-ROUTE（能读到叶节点时等于目标节点）的连接。不开 MITM 时 Surge 看不到测试编号，
// 因此只按连接元数据核对。见 docs/ARCHITECTURE.md §6.3 第 12 步。

import { ENTRY_RULESET_FILES } from '@sfe/contract';
import type { SurgeRequestRecord } from '../ports.js';
import { tempRuleText } from './generate.js';
import { normalizeRuleText } from './rules.js';

export interface VerificationQuery {
  processPaths: readonly string[];
  verifyHost: string;
  from: Date;
  to: Date;
  expectedRule: 'verify' | 'active';
  expectedPolicy: 'SFE-ROUTE';
  expectedLeaf: string | null;
  graceMs?: number;
}

function ruleReferencesEntry(rule: string | null, q: VerificationQuery): boolean {
  if (!rule) return false;
  const n = normalizeRuleText(rule);
  if (n.includes(ENTRY_RULESET_FILES[q.expectedRule])) return true;
  let temp: string;
  try {
    temp = normalizeRuleText(tempRuleText(q.expectedRule, { processPaths: q.processPaths, verifyHost: q.verifyHost }));
  } catch {
    return false;
  }
  const body = temp.slice(0, temp.lastIndexOf(','));
  return n === temp || n.startsWith(`${body},`) || n === body;
}

// 按核对顺序排列；没有找到时返回走得最远的候选未通过的原因。
const STAGES = [
  '没有找到 Safari 访问检测服务的请求',
  '检测请求不在本次实测的时间窗内',
  '检测请求未命中本应用入口规则',
  '检测请求未经 SFE-ROUTE',
  '检测请求的出口节点不是目标节点',
  '检测请求失败',
] as const;

export function findVerificationRequest(
  records: readonly SurgeRequestRecord[],
  q: VerificationQuery,
): { match: SurgeRequestRecord | null; reason: string } {
  const grace = q.graceMs ?? 2000;
  const lo = q.from.getTime() - grace;
  const hi = q.to.getTime() + grace;
  const host = q.verifyHost.toLowerCase();
  let furthest = -1;
  const matches: SurgeRequestRecord[] = [];
  for (const r of records) {
    let stage = 0;
    if (!r.processPath || !q.processPaths.includes(r.processPath)) continue;
    if ((r.remoteHost ?? '').toLowerCase() !== host || r.protocol === 'udp') continue;
    stage = 1;
    const t = r.startedAt?.getTime();
    if (t !== undefined && t >= lo && t <= hi) {
      stage = 2;
      if (ruleReferencesEntry(r.rule, q)) {
        stage = 3;
        if (r.policyName === q.expectedPolicy) {
          stage = 4;
          if (q.expectedLeaf === null || r.leafPolicyName === null || r.leafPolicyName === q.expectedLeaf) {
            stage = 5;
            if (!r.failed) {
              matches.push(r);
              continue;
            }
          }
        }
      }
    }
    furthest = Math.max(furthest, stage);
  }
  if (matches.length > 0) {
    matches.sort((a, b) => b.startedAt!.getTime() - a.startedAt!.getTime());
    return { match: matches[0]!, reason: '已找到对应的 Surge 请求' };
  }
  return { match: null, reason: STAGES[Math.max(0, furthest)]! };
}
