import { describe, expect, test } from 'vitest';
import type { SurgeRequestRecord, SurgeRuleRecord } from '../../src/ports.js';
import { classifyPrecedence, hasBlockingIssue } from '../../src/surge/precedence.js';
import { findVerificationRequest } from '../../src/surge/correlate.js';
import { tempRuleText } from '../../src/surge/generate.js';

const SAFARI = '/Applications/Safari.app/Contents/MacOS/Safari';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ctx = {
  isOurRule: (r: SurgeRuleRecord) => r.text.startsWith('RULE-SET,sfe-entry-'),
  processPaths: [SAFARI],
  siteHosts: ['www.example.test'],
  verifyHost: 'verify.example.test',
};
const rule = (text: string, source: SurgeRuleRecord['source'] = 'profile', moduleName: string | null = null): SurgeRuleRecord => ({ text, source, moduleName });
const ENTRY = rule('RULE-SET,sfe-entry-udp.list,REJECT');

describe('classifyPrecedence', () => {
  test('rules after our entry are ignored', () => {
    expect(classifyPrecedence([ENTRY, rule('FINAL,DIRECT'), rule('PROCESS-NAME,Safari,DIRECT')], ctx)).toEqual([]);
  });

  test('module DIRECT for Safari before our entry is blocking', () => {
    const issues = classifyPrecedence([rule('PROCESS-NAME,Safari,DIRECT', 'module', 'Mod'), ENTRY], ctx);
    expect(issues).toEqual([{ rule: 'PROCESS-NAME,Safari,DIRECT', source: 'module', severity: 'blocking' }]);
    expect(hasBlockingIssue(issues)).toBe(true);
  });

  test('REJECT-family rules only warn', () => {
    const issues = classifyPrecedence([rule('DOMAIN-SUFFIX,example.test,REJECT-TINYGIF', 'module'), rule('GEOIP,US,REJECT', 'temp_rule'), ENTRY], ctx);
    expect(issues.map((i) => i.severity)).toEqual(['warning', 'warning']);
  });

  test.each([
    'DOMAIN,ads.example.invalid,DIRECT',
    'DOMAIN-SUFFIX,other.invalid,Proxy',
    'DOMAIN-KEYWORD,zzz,DIRECT',
    `PROCESS-NAME,${CHROME},DIRECT`,
    `AND,((PROCESS-NAME,${CHROME}),(DOMAIN-SUFFIX,example.test)),DIRECT`,
  ])('provably disjoint %s is ignored', (text) => {
    expect(classifyPrecedence([rule(text, 'temp_rule'), ENTRY], ctx)).toEqual([]);
  });

  test.each([
    'DOMAIN,www.example.test,DIRECT',
    'DOMAIN-SUFFIX,example.test,Proxy',
    'DOMAIN,verify.example.test,DIRECT',
    'IP-CIDR,198.51.100.0/24,DIRECT',
    'GEOIP,US,DIRECT',
    'RULE-SET,user.list,DIRECT',
    'DST-PORT,443,DIRECT',
    'SOME-NEW-TYPE,x,DIRECT',
    'not a rule at all',
    `NOT,((PROCESS-NAME,${CHROME})),DIRECT`,
  ])('possibly matching %s is blocking', (text) => {
    expect(classifyPrecedence([rule(text), ENTRY], ctx)).toEqual([{ rule: text, source: 'profile', severity: 'blocking' }]);
  });

  test('without our rule present, only non-profile rules before the first profile rule count', () => {
    const issues = classifyPrecedence([rule('GEOIP,US,DIRECT', 'module'), rule('DOMAIN-SUFFIX,example.test,DIRECT'), rule('FINAL,DIRECT')], ctx);
    expect(issues).toEqual([{ rule: 'GEOIP,US,DIRECT', source: 'module', severity: 'blocking' }]);
  });
});

describe('findVerificationRequest', () => {
  const t0 = new Date('2026-10-21T08:00:00Z');
  const at = (s: number) => new Date(t0.getTime() + s * 1000);
  const q = {
    processPaths: [SAFARI],
    verifyHost: 'verify.example.test',
    from: at(0),
    to: at(10),
    expectedRule: 'verify' as const,
    expectedPolicy: 'SFE-ROUTE' as const,
    expectedLeaf: 'SFE-N-E0001-US01-v001',
  };
  const req = (over: Partial<SurgeRequestRecord>): SurgeRequestRecord => ({
    id: '1',
    processPath: SAFARI,
    remoteHost: 'verify.example.test',
    policyName: 'SFE-ROUTE',
    leafPolicyName: 'SFE-N-E0001-US01-v001',
    rule: 'RULE-SET,sfe-entry-verify.list,SFE-ROUTE',
    protocol: 'tcp',
    startedAt: at(5),
    completed: true,
    failed: false,
    ...over,
  });

  test('matches the ruleset entry', () => {
    expect(findVerificationRequest([req({})], q).match?.id).toBe('1');
  });

  test('matches the temp rule entry', () => {
    const text = tempRuleText('verify', { processPaths: [SAFARI], verifyHost: 'verify.example.test' });
    expect(findVerificationRequest([req({ rule: text })], q).match?.id).toBe('1');
  });

  test('picks the newest of several matches', () => {
    const r = findVerificationRequest([req({ id: 'a', startedAt: at(2) }), req({ id: 'b', startedAt: at(8) })], q);
    expect(r.match?.id).toBe('b');
  });

  test('leaf is only checked when present', () => {
    expect(findVerificationRequest([req({ leafPolicyName: null })], q).match).not.toBeNull();
    expect(findVerificationRequest([req({ leafPolicyName: 'SFE-N-E0002-US02-v001' })], q)).toEqual({ match: null, reason: '检测请求的出口节点不是目标节点' });
  });

  test.each([
    [{ processPath: CHROME }, '没有找到 Safari 访问检测服务的请求'],
    [{ remoteHost: 'www.example.test' }, '没有找到 Safari 访问检测服务的请求'],
    [{ protocol: 'udp' as const }, '没有找到 Safari 访问检测服务的请求'],
    [{ startedAt: at(30) }, '检测请求不在本次实测的时间窗内'],
    [{ startedAt: null }, '检测请求不在本次实测的时间窗内'],
    [{ rule: 'FINAL,DIRECT' }, '检测请求未命中本应用入口规则'],
    [{ rule: 'RULE-SET,sfe-entry-active.list,SFE-ROUTE' }, '检测请求未命中本应用入口规则'],
    [{ policyName: 'DIRECT' }, '检测请求未经 SFE-ROUTE'],
    [{ failed: true }, '检测请求失败'],
  ])('rejects %j', (over, reason) => {
    expect(findVerificationRequest([req(over)], q)).toEqual({ match: null, reason });
  });

  test('grace window tolerates small clock skew', () => {
    expect(findVerificationRequest([req({ startedAt: at(11) })], q).match).not.toBeNull();
    expect(findVerificationRequest([req({ startedAt: at(11) })], { ...q, graceMs: 0 }).match).toBeNull();
  });

  test('active probes require the active rule', () => {
    const r = req({ rule: 'RULE-SET,sfe-entry-active.list,SFE-ROUTE' });
    expect(findVerificationRequest([r], { ...q, expectedRule: 'active' }).match).not.toBeNull();
  });
});
