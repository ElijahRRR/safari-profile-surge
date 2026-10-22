// 入口优先级检查：排在参与当前模式的最后一条本应用入口规则之前的其他规则（含夹在本应用入口规则之间的）。
// REJECT 类只提示；可能匹配 Safari 流量且路由到非 REJECT 策略的规则阻止激活；能证明不相交的规则忽略。
// 从不修改用户模块与临时规则。
// 见 docs/ARCHITECTURE.md §5.5「优先级检查」。

import type { PrecedenceIssue } from '@sfe/contract';
import type { SurgeRuleRecord } from '../ports.js';
import { REJECT_POLICIES, mayMatchSafari, parseRule, processNameMatches } from './rules.js';

export interface PrecedenceContext {
  isOurRule: (rule: SurgeRuleRecord) => boolean;
  processPaths: readonly string[];
  /** 需要保护的站点主机（订单页、登录页及其资源主机）。 */
  siteHosts: readonly string[];
  verifyHost: string;
}

/** 条件只由 PROCESS-NAME（或它们的 OR）组成、并覆盖全部 Safari 进程路径：能证明匹配 Safari 的全部流量（block/active）。 */
function catchesAllSafari(rule: SurgeRuleRecord, processPaths: readonly string[]): boolean {
  const c = parseRule(rule.text)?.condition;
  if (!c || processPaths.length === 0) return false;
  const names = c.type === 'PROCESS-NAME' ? [c] : c.type === 'OR' && (c.operands ?? []).length > 0 ? c.operands! : null;
  if (!names || !names.every((o) => o.type === 'PROCESS-NAME' && o.value !== null)) return false;
  return processPaths.every((p) => names.some((o) => processNameMatches(o.value!, p)));
}

/**
 * 检查边界：参与当前模式的最后一条本应用入口规则。决定某类 Safari 流量的入口规则不一定是第一条——例如 temp_rule
 * 尾部插入时，用户临时规则可能落在 udp 与 block、block 与 active 之间，或在撤销清理开始前夹在本应用的旧规则与当前
 * block 之间；它们同样先于决定这类流量的入口规则匹配。所以凡排在边界之前、不属于本应用的规则都要分类。
 * 参与当前模式：Safari 流量还能到达的本应用入口规则，即第一条能证明匹配 Safari 全部流量的本应用规则（catchesAllSafari）
 * 及其之前的本应用规则；之后的本应用规则与其他规则都到不了。无法证明的（ruleset_resource 的 RULE-SET、无法识别的
 * 规则）按参与处理：ruleset_resource 的四条 RULE-SET 固定在工作配置中，边界因此是最后一条（active）。
 * 本应用入口规则尚未出现在有效规则中时（例如 temp_rule 策略处于 NORMAL），按“临时规则排在全部
 * 配置规则之前”的已知行为，把第一条配置规则之前的模块与临时规则都视为可能抢先。
 */
function boundaryIndex(rules: readonly SurgeRuleRecord[], ctx: PrecedenceContext): number {
  let last = -1;
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i]!;
    if (!ctx.isOurRule(r)) continue;
    last = i;
    if (catchesAllSafari(r, ctx.processPaths)) break;
  }
  if (last >= 0) return last;
  const firstProfile = rules.findIndex((r) => r.source === 'profile');
  return firstProfile >= 0 ? firstProfile : rules.length;
}

/**
 * 与 classifyPrecedence 相同的分类，并给出每条问题规则在 rules 中的位置：按插入位置预测写入的策略用它比较写入前后
 * 同一条规则是否新落在了本应用规则移除之后（见 temp-rule-strategy 的 predictedPrecedence）。
 */
export function classifyPrecedenceAt(rules: readonly SurgeRuleRecord[], ctx: PrecedenceContext): Array<{ index: number; issue: PrecedenceIssue }> {
  const hosts = [...ctx.siteHosts, ctx.verifyHost].filter((h) => typeof h === 'string' && h.length > 0);
  const end = boundaryIndex(rules, ctx);
  const out: Array<{ index: number; issue: PrecedenceIssue }> = [];
  for (let index = 0; index < end; index++) {
    const r = rules[index]!;
    if (ctx.isOurRule(r)) continue;
    const parsed = parseRule(r.text);
    if (!parsed) {
      // 无法解析的规则按“可能匹配、可能放行”处理。
      out.push({ index, issue: { rule: r.text, source: r.source, severity: 'blocking' } });
      continue;
    }
    if (!mayMatchSafari(parsed.condition, { processPaths: ctx.processPaths, hosts })) continue;
    const policy = (parsed.policy ?? '').toUpperCase();
    out.push({ index, issue: { rule: r.text, source: r.source, severity: REJECT_POLICIES.has(policy) ? 'warning' : 'blocking' } });
  }
  return out;
}

export function classifyPrecedence(rules: readonly SurgeRuleRecord[], ctx: PrecedenceContext): PrecedenceIssue[] {
  return classifyPrecedenceAt(rules, ctx).map((x) => x.issue);
}

export function hasBlockingIssue(issues: readonly PrecedenceIssue[]): boolean {
  return issues.some((i) => i.severity === 'blocking');
}
