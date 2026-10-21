import { describe, expect, it } from 'vitest';
import { OPERATION_PHASES } from '@sfe/contract';
import {
  DEPLOYMENT_TEXT,
  ENTRY_MODE_TEXT,
  PHASE_TEXT,
  POLICY_BUTTON,
  READINESS_BADGE,
  WARNING_TEXT,
  confirmationReason,
  formatRelative,
  isExpired,
  policyConsequence,
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

  it('says when the node could not be restored', () => {
    const text = rollbackText({
      previousEnvironmentId: null,
      previousProxyRevision: null,
      previousProbe: null,
      restoredSelection: null,
      entryModeAfter: 'BLOCKED',
      failedProxyRevision: 3,
      failureError: { code: 'SAFARI_VERIFY_FAILED', message: 'x' },
      needsReverify: false,
    });
    expect(text).toContain('未能恢复原节点');
    expect(text).not.toContain('普通模式');
  });
});
