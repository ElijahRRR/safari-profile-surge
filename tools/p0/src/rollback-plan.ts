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
  /** 当前临时规则列表读不到，或不能作为“已不存在”的证据（未经正向确认或被确认不可用）。 */
  tempListUnknown: boolean;
  /** listTempRules 曾被确认不可用（有效规则中能看到、列表却没有列出本工具刚添加的探测规则）。 */
  tempListUntrusted: boolean;
  /** listTempRules 没有经过插入探测的正向确认（运行状态中为 null）。 */
  tempListUnconfirmed: boolean;
  /** 本工具创建的文件（切回原配置后手动删除）。 */
  files: string[];
  manual: string[];
}

export function buildRollbackPlan(state: RunState, currentTempRules: readonly string[] | null): RollbackPlan {
  const latest = new Map<string, RunState['tempRules'][number]>();
  for (const r of state.tempRules) latest.set(r.rule, r);
  const ours = [...latest.values()].filter((r) => r.state !== 'removed').map((r) => r.rule);
  // 只有经过插入探测正向确认（列出了刚添加的探测规则）的列表，其中“没有”才能当作已删除；未确认与确认不可用
  // 都按无法读取处理（例如空白输出被读成空列表时，不能把仍在 Surge 中的规则判为已不存在）。
  const current = currentTempRules === null || state.tempListConfirmed !== true ? null : new Set(currentTempRules.map(normalizeRuleText));
  const removeTempRules = current === null ? ours : ours.filter((r) => current.has(normalizeRuleText(r)));
  const alreadyAbsent = current === null ? [] : ours.filter((r) => !current.has(normalizeRuleText(r)));
  const original = state.sourceProfileName ?? '（盘点时记录的原配置）';
  const manual = [
    // 回环测试资源接入过（D10）：先改回 SFE-ROUTE 的原行并手动重新加载，再停止资源服务
    ...(state.loopback?.setupAt
      ? [`运行 loopback --rollback 把测试配置的 SFE-ROUTE 改回本地文件引用，并在 Surge 中手动重新加载一次；之后在 resource-server 终端按 Ctrl+C，用 lsof -nP -iTCP:${state.loopback.port} -sTCP:LISTEN 确认资源端口已空闲。`]
      : state.loopback
        ? [`在 resource-server 终端按 Ctrl+C，用 lsof -nP -iTCP:${state.loopback.port} -sTCP:LISTEN 确认资源端口已空闲。`]
        : []),
    `在 Surge 菜单「配置」中手动切回原配置「${original}」（工具从不切换配置）。`,
    `确认 Surge 已不在「${TEST_PROFILE_NAME}」后，再把下列测试文件移到废纸篓；不要删除其他文件。`,
    '确认增强模式、系统代理与出站模式与盘点时一致（工具从不修改它们）。',
    '停止 test-servers（在其终端按 Ctrl+C）。',
  ];
  return { removeTempRules, alreadyAbsent, tempListUnknown: current === null, tempListUntrusted: state.tempListConfirmed === false, tempListUnconfirmed: state.tempListConfirmed === null, files: state.createdFiles.map((f) => f.path), manual };
}

export function formatRollbackPlan(plan: RollbackPlan): string[] {
  const lines: string[] = [];
  if (plan.removeTempRules.length === 0) lines.push('临时规则：没有需要删除的本工具规则。');
  else {
    lines.push(`临时规则：删除本工具添加的 ${plan.removeTempRules.length} 条（逐条按原文删除，不影响其他规则）：`);
    for (const r of plan.removeTempRules) lines.push(`  - ${r}`);
  }
  if (plan.tempListUntrusted) lines.push('当前临时规则列表不可信（listTempRules 没有列出本工具添加的探测规则）：执行时逐条尝试删除，删除后无法读回确认，请在 Surge 中手动核对。');
  else if (plan.tempListUnconfirmed) {
    if (plan.removeTempRules.length > 0) lines.push('当前临时规则列表没有经过正向确认（entry 的插入探测）：不据它判断“已不存在”，执行时逐条尝试删除，删除后无法读回确认，请在 Surge 中手动核对。');
  } else if (plan.tempListUnknown) lines.push('当前临时规则列表无法读取：执行时逐条尝试删除，并以删除结果为准。');
  if (plan.alreadyAbsent.length > 0) lines.push(`已不存在（无需处理）：${plan.alreadyAbsent.length} 条。`);
  lines.push('手动步骤：');
  plan.manual.forEach((m, i) => lines.push(`  ${i + 1}. ${m}`));
  if (plan.files.length > 0) {
    lines.push('本工具创建的文件：');
    for (const f of plan.files) lines.push(`  - ${f}`);
  }
  return lines;
}
