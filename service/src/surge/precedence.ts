// 入口优先级检查：排在本应用第一条入口规则之前的规则。REJECT 类只提示；可能匹配 Safari 流量且
// 路由到非 REJECT 策略的规则阻止激活；能证明不相交的规则忽略。从不修改用户模块与临时规则。
// 见 docs/ARCHITECTURE.md §5.5「优先级检查」。

import type { PrecedenceIssue } from '@sfe/contract';
import type { SurgeRuleRecord } from '../ports.js';
import { REJECT_POLICIES, mayMatchSafari, parseRule } from './rules.js';

export interface PrecedenceContext {
  isOurRule: (rule: SurgeRuleRecord) => boolean;
  processPaths: readonly string[];
  /** 需要保护的站点主机（订单页、登录页及其资源主机）。 */
  siteHosts: readonly string[];
  verifyHost: string;
}

/**
 * 本应用入口规则尚未出现在有效规则中时（例如 temp_rule 策略处于 NORMAL），按“临时规则排在全部
 * 配置规则之前”的已知行为，把第一条配置规则之前的模块与临时规则都视为可能抢先。
 */
function boundaryIndex(rules: readonly SurgeRuleRecord[], ctx: PrecedenceContext): number {
  const ours = rules.findIndex((r) => ctx.isOurRule(r));
  if (ours >= 0) return ours;
  const firstProfile = rules.findIndex((r) => r.source === 'profile');
  return firstProfile >= 0 ? firstProfile : rules.length;
}

export function classifyPrecedence(rules: readonly SurgeRuleRecord[], ctx: PrecedenceContext): PrecedenceIssue[] {
  const hosts = [...ctx.siteHosts, ctx.verifyHost].filter((h) => typeof h === 'string' && h.length > 0);
  const end = boundaryIndex(rules, ctx);
  const issues: PrecedenceIssue[] = [];
  for (const r of rules.slice(0, end)) {
    if (ctx.isOurRule(r)) continue;
    const parsed = parseRule(r.text);
    if (!parsed) {
      // 无法解析的规则按“可能匹配、可能放行”处理。
      issues.push({ rule: r.text, source: r.source, severity: 'blocking' });
      continue;
    }
    if (!mayMatchSafari(parsed.condition, { processPaths: ctx.processPaths, hosts })) continue;
    const policy = (parsed.policy ?? '').toUpperCase();
    issues.push({ rule: r.text, source: r.source, severity: REJECT_POLICIES.has(policy) ? 'warning' : 'blocking' });
  }
  return issues;
}

export function hasBlockingIssue(issues: readonly PrecedenceIssue[]): boolean {
  return issues.some((i) => i.severity === 'blocking');
}
