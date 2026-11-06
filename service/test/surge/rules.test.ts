import { describe, expect, test } from 'vitest';
import {
  evaluateCondition,
  mayMatchSafari,
  normalizeRuleText,
  parseCondition,
  parseRule,
  processNameMatches,
  processNameMayMatch,
  processNameMode,
  splitTopLevel,
} from '../../src/surge/rules.js';

const SAFARI = '/Applications/Safari.app/Contents/MacOS/Safari';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const WEBKIT = '/System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.Networking.xpc/Contents/MacOS/com.apple.WebKit.Networking';

// https://manual.nssurge.com/rules/process.html：filename / full path（都支持 * 与 ?）/ App Bundle 前缀（Mac 6.0.0+），大小写敏感。
describe('PROCESS-NAME documented modes', () => {
  test('mode is decided by the leading and trailing slash', () => {
    expect(processNameMode('Safari')).toBe('filename');
    expect(processNameMode('Safari.app/Contents/MacOS/Safari')).toBe('filename');
    expect(processNameMode(SAFARI)).toBe('full_path');
    expect(processNameMode('/Applications/Safari.app/')).toBe('app_bundle');
  });

  test.each([
    ['Safari', SAFARI, true],
    ['Safari*', SAFARI, true],
    ['Saf?ri', SAFARI, true],
    ['*', CHROME, true],
    ['safari', SAFARI, false],
    ['Safari?', SAFARI, false],
    ['Google Chrome', CHROME, true],
    ['Google*', SAFARI, false],
    // filename 模式只看文件名：带 “/” 但不以 “/” 开头的值不可能匹配
    ['MacOS/Safari', SAFARI, false],
    [SAFARI, SAFARI, true],
    ['/Applications/SAFARI.app/Contents/MacOS/Safari', SAFARI, false],
    ['/Applications/Safari.app/Contents/MacOS/Saf*', SAFARI, true],
    ['/Applications/*.app/Contents/MacOS/Safari', SAFARI, true],
    ['/Applications/Safari.app/', SAFARI, true],
    ['/Applications/', CHROME, true],
    ['/Applications/Safari.app/', CHROME, false],
    ['/Applications/Safari.ap/', SAFARI, false],
    ['com.apple.WebKit.*', WEBKIT, true],
  ] as const)('%s vs %s → %s (definite and possible agree)', (value, path, expected) => {
    expect(processNameMatches(value, path)).toBe(expected);
    expect(processNameMayMatch(value, path)).toBe(expected);
  });

  test('details the docs leave open: definite takes the narrowest reading, possible the widest', () => {
    // 完整路径中的 “*” 能否跨过 “/” 没有写入文档
    expect(processNameMatches('/Applications/*/Safari', SAFARI)).toBe(false);
    expect(processNameMayMatch('/Applications/*/Safari', SAFARI)).toBe(true);
    // App Bundle 前缀模式中的通配符没有写入文档
    expect(processNameMatches('/Applications/Saf*.app/', SAFARI)).toBe(false);
    expect(processNameMayMatch('/Applications/Saf*.app/', SAFARI)).toBe(true);
    expect(processNameMayMatch('/Applications/Chrome*/', SAFARI)).toBe(false);
  });

  test('regex metacharacters in the value are literal', () => {
    expect(processNameMatches('Safari.', '/x/Safarix')).toBe(false);
    expect(processNameMatches('a+b(c)', '/x/a+b(c)')).toBe(true);
    expect(processNameMayMatch('/x/[a]*', '/x/a')).toBe(false);
  });
});

describe('splitTopLevel', () => {
  test('ignores commas inside parentheses', () => {
    expect(splitTopLevel('AND,((A,1),(B,2)),REJECT')).toEqual(['AND', '((A,1),(B,2))', 'REJECT']);
  });
  test('returns null for unbalanced input', () => {
    expect(splitTopLevel('AND,((A,1),REJECT')).toBeNull();
    expect(splitTopLevel('A,1),REJECT')).toBeNull();
  });
});

describe('parseRule', () => {
  test('leaf rule with options', () => {
    expect(parseRule('IP-CIDR,192.0.2.0/24,DIRECT,no-resolve')).toEqual({
      condition: { type: 'IP-CIDR', value: '192.0.2.0/24', operands: null },
      policy: 'DIRECT',
      options: ['no-resolve'],
    });
  });
  test('nested logical rule', () => {
    const r = parseRule(`AND,((OR,((PROCESS-NAME,${SAFARI}),(PROCESS-NAME,/x/y))),(PROTOCOL,UDP)),REJECT`)!;
    expect(r.policy).toBe('REJECT');
    expect(r.condition.type).toBe('AND');
    expect(r.condition.operands![0]!.type).toBe('OR');
    expect(r.condition.operands![0]!.operands).toHaveLength(2);
  });
  test('FINAL and comments', () => {
    expect(parseRule('FINAL,DIRECT,dns-failed')?.policy).toBe('DIRECT');
    expect(parseRule('# comment')).toBeNull();
    expect(parseRule('   ')).toBeNull();
  });
  test.each(['AND,(A,1),REJECT', 'NOT,((A,1),(B,2)),DIRECT', 'DOMAIN,,DIRECT', 'DOMAIN,x'])('rejects malformed %j', (t) => {
    expect(parseRule(t)).toBeNull();
  });
});

describe('evaluateCondition', () => {
  const facts = (processPath: string | null, host: string, protocol: 'tcp' | 'udp' = 'tcp') => ({ processPath, host, protocol });
  test('process name by full path or basename', () => {
    expect(evaluateCondition(parseCondition(`PROCESS-NAME,${SAFARI}`)!, facts(SAFARI, 'a.example.test'))).toBe(true);
    expect(evaluateCondition(parseCondition('PROCESS-NAME,Safari')!, facts(SAFARI, 'a.example.test'))).toBe(true);
    expect(evaluateCondition(parseCondition(`PROCESS-NAME,${SAFARI}`)!, facts(CHROME, 'a.example.test'))).toBe(false);
  });
  test('domain types', () => {
    expect(evaluateCondition(parseCondition('DOMAIN-SUFFIX,example.test')!, facts(null, 'www.example.test'))).toBe(true);
    expect(evaluateCondition(parseCondition('DOMAIN-SUFFIX,example.test')!, facts(null, 'badexample.test'))).toBe(false);
    expect(evaluateCondition(parseCondition('DOMAIN-KEYWORD,shop')!, facts(null, 'myshop.example.test'))).toBe(true);
    expect(evaluateCondition(parseCondition('DOMAIN,Www.Example.Test')!, facts(null, 'www.example.test'))).toBe(true);
  });
  test('logical and protocol', () => {
    const c = parseCondition(`AND,((PROCESS-NAME,${SAFARI}),(PROTOCOL,UDP))`)!;
    expect(evaluateCondition(c, facts(SAFARI, 'a.example.test', 'udp'))).toBe(true);
    expect(evaluateCondition(c, facts(SAFARI, 'a.example.test', 'tcp'))).toBe(false);
    expect(evaluateCondition(parseCondition('NOT,((DOMAIN,a.example.test))')!, facts(null, 'b.example.test'))).toBe(true);
  });
  test('rule sets use the loaded content only', () => {
    const c = parseCondition('RULE-SET,x.list')!;
    const loaded = [parseCondition('DOMAIN,a.example.test')!];
    expect(evaluateCondition(c, facts(null, 'a.example.test'), { ruleSet: () => loaded })).toBe(true);
    expect(evaluateCondition(c, facts(null, 'a.example.test'), { ruleSet: () => null })).toBe(false);
  });
});

describe('mayMatchSafari', () => {
  const ctx = { processPaths: [SAFARI], hosts: ['www.example.test', 'verify.example.test'] };
  test.each([
    ['DOMAIN,other.example.invalid', false],
    ['DOMAIN-SUFFIX,example.test', true],
    [`PROCESS-NAME,${CHROME}`, false],
    ['PROCESS-NAME,Safari', true],
    // 模块可能插在最前面的通配符与 App Bundle 写法：可能匹配，从不按“不相交”忽略
    ['PROCESS-NAME,Safari*', true],
    ['PROCESS-NAME,S?fari', true],
    ['PROCESS-NAME,/Applications/Safari.app/', true],
    ['PROCESS-NAME,/Applications/*/Contents/MacOS/Safari', true],
    ['PROCESS-NAME,/Applications/', true],
    ['PROCESS-NAME,*', true],
    ['PROCESS-NAME,safari', false],
    ['PROCESS-NAME,Google*', false],
    ['PROCESS-NAME,/Applications/Google Chrome.app/', false],
    ['IP-CIDR,198.51.100.0/24', true],
    ['GEOIP,US', true],
    ['RULE-SET,user.list', true],
    ['UNKNOWN-TYPE,x', true],
    [`AND,((PROCESS-NAME,${CHROME}),(DOMAIN-SUFFIX,example.test))`, false],
    ['OR,((DOMAIN,a.invalid),(DOMAIN,b.invalid))', false],
    ['OR,((DOMAIN,a.invalid),(GEOIP,US))', true],
    [`NOT,((PROCESS-NAME,${CHROME}))`, true],
  ])('%s → %s', (text, expected) => {
    expect(mayMatchSafari(parseCondition(text)!, ctx)).toBe(expected);
  });
});

test('normalizeRuleText removes spaces around separators only', () => {
  expect(normalizeRuleText(' AND , ( (PROCESS-NAME, /A B/C) , (PROTOCOL,UDP) ) , REJECT ')).toBe('AND,((PROCESS-NAME,/A B/C),(PROTOCOL,UDP)),REJECT');
});
