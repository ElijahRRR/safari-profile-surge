import { describe, expect, test } from 'vitest';
import type { SurgeRequestRecord, SurgeRuleRecord } from '../../src/ports.js';
import { classifyPrecedence, classifyPrecedenceAt, hasBlockingIssue } from '../../src/surge/precedence.js';
import { findVerificationRequest } from '../../src/surge/correlate.js';
import { TEMP_ENTRY_KINDS, tempRuleText, type TempEntryKind } from '../../src/surge/generate.js';
import { TEMP_KIND_COVER } from '../../src/surge/entry/common.js';

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

  test('rules between our rule sets are classified up to the last entry rule set', () => {
    const rs = (bit: string, policy: string) => rule(`RULE-SET,sfe-entry-${bit}.list,${policy}`);
    const issues = classifyPrecedence(
      [
        rs('udp', 'REJECT'),
        rs('verify', 'SFE-ROUTE'),
        rule('DOMAIN-SUFFIX,example.test,DIRECT'),
        rs('block', 'REJECT'),
        rule('GEOIP,US,REJECT'),
        rule('DOMAIN,ads.example.invalid,DIRECT'),
        rs('active', 'SFE-ROUTE'),
        rule('FINAL,DIRECT'),
      ],
      ctx,
    );
    expect(issues).toEqual([
      { rule: 'DOMAIN-SUFFIX,example.test,DIRECT', source: 'profile', severity: 'blocking' },
      { rule: 'GEOIP,US,REJECT', source: 'profile', severity: 'warning' },
    ]);
  });
});

describe('classifyPrecedence: temp_rule entries with a user rule between them', () => {
  const cfg = { processPaths: [SAFARI], verifyHost: 'verify.example.test', siteHosts: ['www.example.test'] };
  const t = (kind: TempEntryKind) => rule(tempRuleText(kind, cfg), 'temp_rule');
  /** 与 temp_rule 策略相同：当前文本能证明覆盖的类别（条件互不相交，按累计覆盖找边界）。 */
  const coverageOf = (r: SurgeRuleRecord) => {
    const k = TEMP_ENTRY_KINDS.find((kind) => tempRuleText(kind, cfg) === r.text);
    return k ? TEMP_KIND_COVER[k].classes : null;
  };
  /** 旧版本格式的本应用规则：Safari 访问 example.test 经 SFE-ROUTE（不是覆盖 Safari 全部流量的规则）。 */
  const LEGACY = rule(`AND,((PROCESS-NAME,${SAFARI}),(DOMAIN-SUFFIX,example.test)),SFE-ROUTE`, 'temp_rule');
  const ours = (...rs: SurgeRuleRecord[]) => ({ ...ctx, isOurRule: (r: SurgeRuleRecord) => rs.some((o) => o.text === r.text) });
  const user = (text: string) => rule(text, 'temp_rule');

  test.each([
    ['udp > user > block (ACTIVE → BLOCKED with tail insertion)', [t('udp'), user('DOMAIN-SUFFIX,example.test,DIRECT'), t('block')]],
    ['udp > user > active (BLOCKED → ACTIVE with tail insertion)', [t('udp'), user('DOMAIN,www.example.test,DIRECT'), t('active')]],
    ['udp > legacy route > user > block (before the undo cleanup)', [t('udp'), LEGACY, user('DOMAIN-SUFFIX,example.test,DIRECT'), t('block')]],
  ])('%s: the user rule is blocking', (_name, rules) => {
    const user = rules.find((r) => r.text.endsWith(',DIRECT'))!;
    const issues = classifyPrecedence([...rules, rule('FINAL,DIRECT')], ours(...rules.filter((r) => r !== user)));
    expect(issues).toEqual([{ rule: user.text, source: 'temp_rule', severity: 'blocking' }]);
  });

  test('a REJECT-family user rule between our rules only warns', () => {
    const rules = [t('udp'), user('DOMAIN-SUFFIX,example.test,REJECT-DROP'), t('block')];
    expect(classifyPrecedence(rules, ours(t('udp'), t('block')))).toEqual([{ rule: 'DOMAIN-SUFFIX,example.test,REJECT-DROP', source: 'temp_rule', severity: 'warning' }]);
  });

  test('a duplicate block for other process paths keeps the rule before it in scope', () => {
    const preview = '/Applications/Safari Technology Preview.app/Contents/MacOS/Safari Technology Preview';
    const blockNew = rule(tempRuleText('block', { ...cfg, processPaths: [SAFARI, preview] }), 'temp_rule');
    const rules = [t('udp'), t('block'), user('DOMAIN-SUFFIX,example.test,DIRECT'), blockNew];
    const issues = classifyPrecedence(rules, { ...ours(t('udp'), t('block'), blockNew), processPaths: [SAFARI, preview] });
    expect(issues).toEqual([{ rule: 'DOMAIN-SUFFIX,example.test,DIRECT', source: 'temp_rule', severity: 'blocking' }]);
  });

  test('classifyPrecedenceAt gives the same issues with their positions', () => {
    const rules = [t('udp'), user('DOMAIN-SUFFIX,example.test,REJECT'), user('DOMAIN-SUFFIX,example.test,DIRECT'), t('block'), rule('FINAL,DIRECT')];
    const c = ours(t('udp'), t('block'));
    const at = classifyPrecedenceAt(rules, c);
    expect(at.map((x) => x.index)).toEqual([1, 2]);
    expect(at.map((x) => x.issue)).toEqual(classifyPrecedence(rules, c));
  });

  test('rules after the first of our rules that matches all Safari traffic are unreachable and ignored', () => {
    // block 覆盖 Safari 的全部流量：之后的用户规则与本应用规则都到不了
    const rules = [t('block'), user('DOMAIN-SUFFIX,example.test,DIRECT'), t('udp'), user('PROCESS-NAME,Safari,DIRECT')];
    expect(classifyPrecedence(rules, ours(t('block'), t('udp')))).toEqual([]);
  });

  test('…and after our rules that together cover all Safari traffic (udp + active, udp + verify + blockOther)', () => {
    const direct = user('DOMAIN-SUFFIX,example.test,DIRECT');
    const active = [t('udp'), t('active'), direct, t('block')];
    expect(classifyPrecedence(active, { ...ours(t('udp'), t('active'), t('block')), coverageOf })).toEqual([]);
    const verifyOnly = [t('verify'), t('udp'), t('blockOther'), direct, t('active')];
    expect(classifyPrecedence(verifyOnly, { ...ours(t('udp'), t('verify'), t('blockOther'), t('active')), coverageOf })).toEqual([]);
    // 还没有覆盖全部（缺 blockOther）：之后的用户规则仍可能被其他主机的 TCP 到达
    const partial = [t('udp'), t('verify'), direct, t('blockOther')];
    expect(classifyPrecedence(partial, { ...ours(t('udp'), t('verify'), t('blockOther')), coverageOf })).toEqual([
      { rule: direct.text, source: 'temp_rule', severity: 'blocking' },
    ]);
    // 没有覆盖信息时（例如 ruleset_resource 的 RULE-SET）只认匹配 Safari 全部流量的单条规则：保守地继续检查
    expect(classifyPrecedence(active, ours(t('udp'), t('active'), t('block')))).toEqual([{ rule: direct.text, source: 'temp_rule', severity: 'blocking' }]);
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
