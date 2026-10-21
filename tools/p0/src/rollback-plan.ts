// 回退计划（纯函数）：只删除本工具在运行状态中登记过的精确临时规则（意图或已确认存在），从不触碰用户自己的
// 临时规则，也从不 flush。配置切换由用户在 Surge 中手动完成；测试文件在切回原配置后由用户移到废纸篓。

import { normalizeRuleText } from './deps.js';
import type { RunState } from './state.js';
import { TEST_PROFILE_NAME } from './test-profile.js';

export interface RollbackPlan {
  /** 需要删除的临时规则（本工具添加、当前仍存在或无法读取当前列表）。 */
  removeTempRules: string[];
  /** 本工具登记过、但当前已不存在的规则。 */
  alreadyAbsent: string[];
  /** 当前临时规则列表读不到。 */
  tempListUnknown: boolean;
  /** 本工具创建的文件（切回原配置后手动删除）。 */
  files: string[];
  manual: string[];
}

export function buildRollbackPlan(state: RunState, currentTempRules: readonly string[] | null): RollbackPlan {
  const latest = new Map<string, RunState['tempRules'][number]>();
  for (const r of state.tempRules) latest.set(r.rule, r);
  const ours = [...latest.values()].filter((r) => r.state !== 'removed').map((r) => r.rule);
  const current = currentTempRules === null ? null : new Set(currentTempRules.map(normalizeRuleText));
  const removeTempRules = current === null ? ours : ours.filter((r) => current.has(normalizeRuleText(r)));
  const alreadyAbsent = current === null ? [] : ours.filter((r) => !current.has(normalizeRuleText(r)));
  const original = state.sourceProfileName ?? '（盘点时记录的原配置）';
  const manual = [
    `在 Surge 菜单「配置」中手动切回原配置「${original}」（工具从不切换配置）。`,
    `确认 Surge 已不在「${TEST_PROFILE_NAME}」后，再把下列测试文件移到废纸篓；不要删除其他文件。`,
    '确认增强模式、系统代理与出站模式与盘点时一致（工具从不修改它们）。',
    '停止 test-servers（在其终端按 Ctrl+C）。',
  ];
  return { removeTempRules, alreadyAbsent, tempListUnknown: current === null, files: state.createdFiles.map((f) => f.path), manual };
}

export function formatRollbackPlan(plan: RollbackPlan): string[] {
  const lines: string[] = [];
  if (plan.removeTempRules.length === 0) lines.push('临时规则：没有需要删除的本工具规则。');
  else {
    lines.push(`临时规则：删除本工具添加的 ${plan.removeTempRules.length} 条（逐条按原文删除，不影响其他规则）：`);
    for (const r of plan.removeTempRules) lines.push(`  - ${r}`);
  }
  if (plan.tempListUnknown) lines.push('当前临时规则列表无法读取：执行时逐条尝试删除，并以删除结果为准。');
  if (plan.alreadyAbsent.length > 0) lines.push(`已不存在（无需处理）：${plan.alreadyAbsent.length} 条。`);
  lines.push('手动步骤：');
  plan.manual.forEach((m, i) => lines.push(`  ${i + 1}. ${m}`));
  if (plan.files.length > 0) {
    lines.push('本工具创建的文件：');
    for (const f of plan.files) lines.push(`  - ${f}`);
  }
  return lines;
}
