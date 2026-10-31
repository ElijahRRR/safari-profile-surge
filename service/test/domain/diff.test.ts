import { describe, expect, test } from 'vitest';
import { environmentDiff, sameEnvironmentState, type EnvironmentDiffState } from '../../src/domain/diff.js';

const state: EnvironmentDiffState = {
  displayName: 'US-Buyer-01',
  site: 'US',
  autoOpenOrders: true,
  autoFillLogin: false,
  protocol: 'socks5',
  host: '203.0.113.10',
  port: 1080,
  usernameFp: 'fp-user-a',
  passwordFp: 'fp-pass-a',
  frontProxyName: 'Front-A',
  expectedExitIp: null,
  accountLabel: 'buyer',
  loginIdentifier: 'buyer01@example.test',
  accountPasswordFp: 'fp-acct-a',
};

describe('environmentDiff', () => {
  test('no change → empty and same', () => {
    expect(environmentDiff(state, { ...state })).toEqual([]);
    expect(sameEnvironmentState(state, { ...state })).toBe(true);
  });

  test('secrets only show set/changed/cleared and never the fingerprint', () => {
    const d = environmentDiff(state, { ...state, passwordFp: 'fp-pass-b', usernameFp: null, accountPasswordFp: 'fp-acct-b' });
    expect(d).toEqual([
      { field: 'proxy.username', before: '已设置', after: '已清除' },
      { field: 'proxy.password', before: '已设置', after: '已修改' },
      { field: 'account.password', before: '已设置', after: '已修改' },
    ]);
    expect(JSON.stringify(d)).not.toContain('fp-');
  });

  test('login identifier is masked on both sides', () => {
    const d = environmentDiff(state, { ...state, loginIdentifier: 'buyer02@example.test' });
    expect(d).toHaveLength(1);
    expect(d[0]!.field).toBe('account.loginIdentifier');
    expect(d[0]!.before).toBe('b*****1@example.test');
    expect(d[0]!.after).toBe('b*****2@example.test');
    expect(JSON.stringify(d)).not.toContain('buyer0');
  });

  test('create lists every set field with before null', () => {
    const d = environmentDiff(null, state);
    expect(d.find((e) => e.field === 'proxy.host')).toEqual({ field: 'proxy.host', before: null, after: '203.0.113.10' });
    expect(d.find((e) => e.field === 'proxy.password')).toEqual({ field: 'proxy.password', before: null, after: '已设置' });
    expect(d.every((e) => e.before === null)).toBe(true);
  });

  test('plain fields show before and after', () => {
    const d = environmentDiff(state, { ...state, port: 1081, autoFillLogin: true, frontProxyName: 'Front-B', expectedExitIp: '192.0.2.9' });
    expect(d).toEqual([
      { field: 'autoFillLogin', before: '关', after: '开' },
      { field: 'proxy.port', before: '1080', after: '1081' },
      { field: 'proxy.frontProxy', before: 'Front-A', after: 'Front-B' },
      { field: 'proxy.expectedExitIp', before: null, after: '192.0.2.9' },
    ]);
  });
});
