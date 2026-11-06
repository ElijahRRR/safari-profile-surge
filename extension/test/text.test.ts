import { describe, expect, it } from 'vitest';
import { OPERATION_PHASES } from '@sfe/contract';
import {
  DEPLOYMENT_TEXT,
  ENTRY_MODE_TEXT,
  PHASE_TEXT,
  POLICY_BUTTON,
  READINESS_BADGE,
  ROUTE_LEFT_WARNINGS,
  SAVED_NOTICE,
  WARNING_TEXT,
  confirmationReason,
  formatRelative,
  isExpired,
  policyConsequence,
  rejectHeldText,
  retestRouteLeftText,
  rollbackText,
} from '../src/shared/text';
import { NOW, iso } from './fixtures';

const ALL_TEXT = [
  ...Object.values(WARNING_TEXT),
  ...Object.values(PHASE_TEXT),
  ...Object.values(READINESS_BADGE).map((b) => b.label),
  ...Object.values(DEPLOYMENT_TEXT),
  ...Object.values(ENTRY_MODE_TEXT),
  ...Object.values(POLICY_BUTTON),
  SAVED_NOTICE,
  policyConsequence('activate', 'closed_confirmed'),
  policyConsequence('activate', 'keep_open_acknowledged'),
  policyConsequence('normal', 'keep_open_acknowledged'),
];

describe('interface text', () => {
  it('covers every operation phase', () => {
    for (const p of OPERATION_PHASES) expect(PHASE_TEXT[p]).toBeTruthy();
  });

  it('uses the EasyQuick voice: no exclamation marks or emoji', () => {
    for (const t of ALL_TEXT) {
      expect(t).not.toMatch(/[!！]/);
      expect(t).not.toMatch(/\p{Extended_Pictographic}/u);
    }
  });

  it('keeps a half-width space between Chinese and Latin text or numbers', () => {
    for (const t of ALL_TEXT) {
      expect(t).not.toMatch(/[一-鿿][A-Za-z0-9]/);
      expect(t).not.toMatch(/[A-Za-z0-9][一-鿿]/);
    }
  });

  it('names node_resource_unverified among the causes when a retest ends with the route no longer verified (D10)', () => {
    expect(ROUTE_LEFT_WARNINGS).toContain('node_resource_unverified');
    const text = retestRouteLeftText(['node_resource_unverified', 'probe_expired']);
    expect(text).toContain(WARNING_TEXT.node_resource_unverified);
    expect(text).toContain('自动打开订单与填充已停止');
    // 不是使路由离开已验证状态的警告不列为原因
    expect(text).not.toContain(WARNING_TEXT.probe_expired);
  });

  it('D11: node_resource_forged has text that does not claim the selection already changed, counts as route-left, and REJECT-hold texts by cause', () => {
    expect(WARNING_TEXT.node_resource_forged).toContain('Surge 中的节点可能是伪造的');
    expect(WARNING_TEXT.node_resource_forged).toContain('尝试把 SFE-ROUTE 改选 REJECT');
    expect(WARNING_TEXT.node_resource_forged).not.toContain('已把 SFE-ROUTE 改选');
    expect(ROUTE_LEFT_WARNINGS).toContain('node_resource_forged');
    const ok = rejectHeldText(true, 'node_resource_forged');
    expect(ok).toContain('服务已把 SFE-ROUTE 改选 REJECT');
    expect(ok).toContain('不会自动恢复');
    expect(ok).not.toContain('使用中环境已验证的出口');
    const fail = rejectHeldText(false, 'node_resource_forged');
    expect(fail).toContain('未能把 SFE-ROUTE 改选 REJECT');
    expect(fail).toContain('请立即进入普通模式');
    expect(rejectHeldText(true)).toContain('使用中环境已验证的出口');
    // 没有在固定工作配置上确认改选（result.rejectGuard）：按原因与阶段写明，不说「未能改选」以外的事实，补救是立即进入普通模式
    const skipped = rejectHeldText(false, undefined, { reason: 'external_profile', stage: 'not_attempted' });
    expect(skipped).toContain('Surge 当前配置不是固定工作配置，服务没有改选 SFE-ROUTE（不改动其他配置中的同名组）');
    expect(skipped).toContain('请立即进入普通模式（不必先切回固定工作配置）');
    expect(rejectHeldText(false, undefined, { reason: 'profile_unknown', stage: 'interrupted' })).toContain('无法确认服务中断之前是否已在固定工作配置上改选 REJECT');
    expect(rejectHeldText(false, 'node_resource_forged', { reason: 'external_profile', stage: 'profile_changed' })).toContain('Surge 中的节点可能是伪造的；改选 SFE-ROUTE 期间');
    // 无法连接 Surge 而没有改选：沿用未能改选的说法
    expect(rejectHeldText(false, undefined, { reason: 'surge_unreachable', stage: 'not_attempted' })).toBe(rejectHeldText(false));
    for (const t of [ok, fail, WARNING_TEXT.node_resource_forged]) {
      expect(t).not.toContain('用户决定');
      expect(t).not.toMatch(/[!！]/);
    }
  });

  it('PG-T9: rejectGuard texts do not assume a REJECT write or another profile: a profile_changed restore is not called 「不记为 REJECT」, selection_unreadable is not 「回到固定工作配置之后」', () => {
    const changed = rejectHeldText(false, undefined, { reason: 'external_profile', stage: 'profile_changed' });
    expect(changed).toContain('不能确认这次改选（REJECT 或恢复的节点）落在固定工作配置上，不记为路由的选择');
    expect(changed).not.toContain('不记为 REJECT');
    const unreadable = rejectHeldText(false, undefined, { reason: 'selection_unreadable', stage: 'interrupted' });
    expect(unreadable).toContain('之后读到 SFE-ROUTE 的对账会核对');
    expect(unreadable).not.toContain('回到固定工作配置之后');
    expect(rejectHeldText(false, undefined, { reason: 'external_profile', stage: 'interrupted' })).toContain('回到固定工作配置之后服务会核对');
  });

  it('T12 / PG-T12: external_profile_change states the shared-entry exposure as history plus a condition and offers normal mode on the loaded profile', () => {
    const t = WARNING_TEXT.external_profile_change;
    expect(t).toContain('可在当前配置上进入普通模式');
    expect(t).toContain('Safari 请求可能经它的同名 SFE-ROUTE 发出');
    expect(t).toContain('也含本应用入口');
    // 粘性警告：回到固定工作配置之后仍显示，不能用现在时声称当前配置不是固定工作配置
    expect(t).toContain('曾切到（或仍在）');
    expect(t).not.toContain('Surge 当前配置不是固定工作配置');
  });

  it('never claims a save is already syncing: publishing may stay pending', () => {
    expect(SAVED_NOTICE).not.toContain('正在同步');
    expect(SAVED_NOTICE).toContain('Surge 同步');
  });

  it('describes the keep-open consequences differently for activation and normal mode', () => {
    expect(policyConsequence('activate', 'keep_open_acknowledged')).toContain('新环境出口');
    expect(policyConsequence('normal', 'keep_open_acknowledged')).toContain('可能直连');
  });

  it('explains the confirmation reason with the current environment', () => {
    const details = {
      reason: 'managed_environment_active' as const,
      currentEnvironmentId: 'env_1',
      currentEnvironmentLabel: 'US-买家01 · E0001',
      otherProfilesOpen: [],
      options: ['closed_confirmed' as const],
      limitation: null,
    };
    expect(confirmationReason('normal', details)).toContain('Surge 原规则');
    expect(confirmationReason('normal', details)).toContain('US-买家01 · E0001');
  });
});

describe('time helpers', () => {
  it('formats relative times', () => {
    expect(formatRelative(iso(-2), NOW)).toBe('刚刚');
    expect(formatRelative(iso(-12), NOW)).toBe('12 秒前');
    expect(formatRelative(iso(-180), NOW)).toBe('3 分钟前');
    expect(formatRelative(iso(-7200), NOW)).toBe('2 小时前');
    expect(formatRelative(iso(-86400 * 3), NOW)).toBe('3 天前');
    expect(formatRelative(null, NOW)).toBe('未知时间');
    expect(formatRelative('garbage', NOW)).toBe('未知时间');
  });

  it('treats missing or past expiry as expired', () => {
    expect(isExpired(iso(10), NOW)).toBe(false);
    expect(isExpired(iso(-1), NOW)).toBe(true);
    expect(isExpired(null, NOW)).toBe(true);
  });
});

describe('rollbackText', () => {
  it('states the restored node, blocked entry and re-verification', () => {
    const text = rollbackText({
      previousEnvironmentId: 'env_9',
      previousProxyRevision: 2,
      previousProbe: null,
      restoredSelection: 'SFE-N-E0009-US09-v002',
      entryModeAfter: 'BLOCKED',
      failedProxyRevision: 3,
      failureError: { code: 'SAFARI_VERIFY_FAILED', message: 'x' },
      needsReverify: true,
    });
    expect(text).toBe('已恢复原节点 SFE-N-E0009-US09-v002，Safari 保持阻断，需要重新核验原环境。');
  });

  it('says no node was restored when there was no verified route before the switch, even if an older service names the failed node', () => {
    for (const restoredSelection of [null, 'SFE-N-E0001-US01-v001']) {
      const text = rollbackText({
        previousEnvironmentId: null,
        previousProxyRevision: null,
        previousProbe: null,
        restoredSelection,
        entryModeAfter: 'BLOCKED',
        failedProxyRevision: 3,
        failureError: { code: 'SAFARI_VERIFY_FAILED', message: 'x' },
        needsReverify: false,
      });
      expect(text).toBe('切换前没有已验证的路由，未恢复节点，Safari 保持阻断。');
      expect(text).not.toContain('已恢复原节点');
      expect(text).not.toContain('普通模式');
    }
  });

  it('says SFE-ROUTE was already held at REJECT before the switch and no buyer node was restored (rejectKept), never "restored the original node"', () => {
    const text = rollbackText({
      previousEnvironmentId: null,
      previousProxyRevision: null,
      previousProbe: null,
      restoredSelection: null,
      entryModeAfter: 'BLOCKED',
      failedProxyRevision: 1,
      failureError: { code: 'SUPERSEDED', message: '已取消切换' },
      needsReverify: false,
      rejectKept: true,
    });
    expect(text).toBe('切换前 SFE-ROUTE 已改选 REJECT（没有已验证的路由可恢复），未恢复买家节点，SFE-ROUTE 保持 REJECT，Safari 保持阻断，路由需要处理：重新使用此环境或进入普通模式。');
    expect(text).not.toContain('已恢复原节点');
    expect(text).not.toContain('上次结果');
  });

  it('says when the previous node could not be restored', () => {
    const text = rollbackText({
      previousEnvironmentId: 'env_9',
      previousProxyRevision: 2,
      previousProbe: null,
      restoredSelection: null,
      entryModeAfter: 'BLOCKED',
      failedProxyRevision: 3,
      failureError: { code: 'SAFARI_VERIFY_FAILED', message: 'x' },
      needsReverify: true,
    });
    expect(text).toContain('未能恢复原节点');
  });
});
