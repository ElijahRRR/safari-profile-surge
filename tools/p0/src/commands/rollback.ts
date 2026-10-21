// rollback：打印回退计划；--execute 时确认后只删除本工具在运行状态中登记过的临时规则（逐条按原文、读回确认），
// 从不 flush、不删除用户自己的临时规则。切回原配置与删除测试文件由用户手动完成（打印具体步骤与文件清单）。

import type { ExitCode } from '../errors.js';
import { refused } from '../errors.js';
import { logAction } from '../results.js';
import { buildRollbackPlan, formatRollbackPlan } from '../rollback-plan.js';
import { markTempRule, saveState } from '../state.js';
import { openRun, openSession, tryRead, type Ctx } from './common.js';

export async function runRollback(ctx: Ctx): Promise<ExitCode> {
  const { out, prompt, now } = ctx.deps;
  const { dir, state: initial } = openRun(ctx);
  let state = initial;
  const session = state.mechanism ? await openSession(ctx, dir, state, { needTestProfile: false }).catch(() => null) : null;
  const current = session ? await tryRead(() => session.adapter.listTempRules()) : null;
  const plan = buildRollbackPlan(state, current);
  out.heading(`回退计划 · 运行 ${dir.id}`);
  for (const l of formatRollbackPlan(plan)) out.line(l);
  if (!ctx.args.booleans.execute) {
    out.line('只打印：加 --execute 并确认后才会删除上面列出的临时规则。');
    return 0;
  }
  if (plan.removeTempRules.length === 0) {
    out.line('没有需要删除的临时规则。');
    return 0;
  }
  if (!session) throw refused('执行回退失败：无法打开 Surge 会话（需要 removeTempRule 原语）');
  if (!(await prompt.confirm(`确定要删除本工具添加的 ${plan.removeTempRules.length} 条临时规则吗？`))) throw refused('已取消：没有删除任何规则');
  let failures = 0;
  for (const rule of plan.removeTempRules) {
    session.guard.tempRules.add(rule);
    try {
      await session.adapter.removeTempRule(rule);
    } catch (e) {
      out.warn(`删除临时规则失败：${(e as { code?: string }).code ?? 'ERROR'}`);
    }
    const after = await tryRead(() => session.adapter.listTempRules());
    if (after !== null && !after.includes(rule)) {
      state = markTempRule(state, rule, 'removed', now());
      out.line(`已删除：${rule}`);
    } else {
      failures++;
      out.warn(`读回仍存在或无法读取：${rule}`);
    }
    saveState(dir, state);
  }
  logAction(dir, { at: now().toISOString(), command: 'rollback', action: 'temp_rules_removed', detail: { failures } });
  out.line(failures === 0 ? '本工具添加的临时规则已全部删除。' : `有 ${failures} 条未能确认删除，请在 Surge 中手动检查（只删除上面列出的规则）。`);
  return failures === 0 ? 0 : 1;
}
