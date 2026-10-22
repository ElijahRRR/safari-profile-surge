import { describe, expect, it } from 'vitest';
import { buildRollbackPlan, formatRollbackPlan } from '../src/rollback-plan.js';
import { emptyState, markTempRule, recordTempRuleIntent, upsertCreatedFile, type RunState } from '../src/state.js';

const T = new Date('2026-10-21T10:00:00Z');
const R1 = 'AND,((PROCESS-NAME,/Applications/Safari.app/Contents/MacOS/Safari),(PROTOCOL,UDP)),REJECT';
const R2 = 'PROCESS-NAME,/Applications/Safari.app/Contents/MacOS/Safari,REJECT';
const R3 = 'DOMAIN,p0-insert-1.invalid,REJECT';
const USER = 'DOMAIN-SUFFIX,user.example.test,DIRECT';

/** 默认为 listTempRules 已由插入探测正向确认的运行状态（其他取值见下面的专门测试）。 */
function state(tempListConfirmed: boolean | null = true): RunState {
  let s = emptyState('20261021-100000-aaaaaa', T);
  s = { ...s, sourceProfileName: '我的配置', tempListConfirmed };
  s = recordTempRuleIntent(s, R1, 'entry', T);
  s = markTempRule(s, R1, 'present', T);
  s = recordTempRuleIntent(s, R2, 'entry', T);
  s = recordTempRuleIntent(s, R3, 'insertion-probe', T);
  s = markTempRule(s, R3, 'removed', T);
  s = upsertCreatedFile(s, { path: '/x/SFE-P0-测试.conf', digest: 'd', kind: 'test_profile', createdAt: T.toISOString() });
  return s;
}

describe('buildRollbackPlan', () => {
  it('removes only recorded, not-yet-removed rules that are still present', () => {
    const plan = buildRollbackPlan(state(), [USER, R1]);
    expect(plan.removeTempRules).toEqual([R1]);
    expect(plan.alreadyAbsent).toEqual([R2]);
    expect(plan.removeTempRules).not.toContain(USER);
    expect(plan.tempListUnknown).toBe(false);
  });

  it('matches rules regardless of whitespace around separators', () => {
    const plan = buildRollbackPlan(state(), [R1.replace(/,/g, ', ')]);
    expect(plan.removeTempRules).toEqual([R1]);
  });

  it('attempts every recorded rule when the current list is unreadable', () => {
    const plan = buildRollbackPlan(state(), null);
    expect(plan.removeTempRules.sort()).toEqual([R1, R2].sort());
    expect(plan.tempListUnknown).toBe(true);
  });

  it('does not treat rules as gone when listTempRules was confirmed unusable by the insertion probe', () => {
    // 列表格式可以识别但不含本工具添加的规则：不能据此判定“已不存在”，否则 rollback --execute 会留下规则。
    const plan = buildRollbackPlan(state(false), [USER]);
    expect(plan.removeTempRules.sort()).toEqual([R1, R2].sort());
    expect(plan.alreadyAbsent).toEqual([]);
    expect(plan.tempListUnknown).toBe(true);
    expect(plan.tempListUntrusted).toBe(true);
    expect(formatRollbackPlan(plan).join('\n')).toContain('当前临时规则列表不可信');
    expect(buildRollbackPlan(state(true), [USER]).alreadyAbsent.sort()).toEqual([R1, R2].sort());
  });

  it('does not treat rules as gone when listTempRules was never positively confirmed', () => {
    // 未经插入探测确认的列表（例如 --raw dump temp-rule 输出空白被读成空列表）中“没有”不是已删除的证据：
    // 否则 rollback --execute 会打印“没有需要删除的临时规则”而把阻断规则留在 Surge 中。
    const plan = buildRollbackPlan(state(null), []);
    expect(plan.removeTempRules.sort()).toEqual([R1, R2].sort());
    expect(plan.alreadyAbsent).toEqual([]);
    expect(plan.tempListUnknown).toBe(true);
    expect(plan.tempListUntrusted).toBe(false);
    expect(plan.tempListUnconfirmed).toBe(true);
    const text = formatRollbackPlan(plan).join('\n');
    expect(text).toContain('没有经过正向确认');
    expect(text).not.toContain('没有需要删除的本工具规则');
    // 没有需要处理的规则时不提示列表状态。
    expect(formatRollbackPlan(buildRollbackPlan(emptyState('20261021-100000-dddddd', T), [])).join('\n')).not.toContain('正向确认');
  });

  it('uses the latest record for each rule', () => {
    let s = state();
    s = markTempRule(s, R1, 'removed', T);
    expect(buildRollbackPlan(s, [R1]).removeTempRules).toEqual([]);
    s = recordTempRuleIntent(s, R1, 'entry', T);
    expect(buildRollbackPlan(s, [R1]).removeTempRules).toEqual([R1]);
  });

  it('never includes switching or reload steps, only manual instructions', () => {
    const plan = buildRollbackPlan(state(), []);
    const text = formatRollbackPlan(plan).join('\n');
    expect(text).toContain('手动切回原配置「我的配置」');
    expect(text).toContain('/x/SFE-P0-测试.conf');
    expect(text).not.toMatch(/switch-profile|reload|flush/);
    expect(plan.files).toEqual(['/x/SFE-P0-测试.conf']);
  });

  it('formats an empty plan', () => {
    const text = formatRollbackPlan(buildRollbackPlan(emptyState('20261021-100000-bbbbbb', T), [])).join('\n');
    expect(text).toContain('没有需要删除的本工具规则');
  });
});

describe('temp rule state helpers', () => {
  it('marks only the latest matching record', () => {
    let s = emptyState('20261021-100000-cccccc', T);
    s = recordTempRuleIntent(s, R1, 'a', T);
    s = markTempRule(s, R1, 'removed', T);
    s = recordTempRuleIntent(s, R1, 'b', T);
    s = markTempRule(s, R1, 'present', T);
    expect(s.tempRules.map((r) => r.state)).toEqual(['removed', 'present']);
  });
});
