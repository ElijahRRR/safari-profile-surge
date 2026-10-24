import { describe, expect, test } from 'vitest';
import {
  ENTRY_PLACEHOLDER_PROCESS_PATH,
  ENTRY_PLACEHOLDER_RULE,
  ENTRY_PROBE_IPV4,
  ENTRY_WITNESS_PROCESS_PREFIX,
  LEGACY_ENTRY_PLACEHOLDER_RULE,
  LEGACY_ENTRY_WITNESS_PROCESS_PATH,
  PREVIOUS_ENTRY_PLACEHOLDER_RULE,
  SfeError,
} from '@sfe/contract';
import {
  entryRuleSetBlockLines,
  entryRuleSetFileContent,
  entryRules,
  entryWitnessProcessPath,
  entryWitnessRule,
  groupBlockLines,
  legacyTempRuleText,
  nodeLine,
  parseEntryRuleSetFile,
  resourceFile,
  tempEntryRuleTexts,
  tempRuleText,
  validateSafariProcessPaths,
} from '../../src/surge/generate.js';
import { evaluateCondition, parseCondition, parseRule, processNameMayMatch, type RuleCondition } from '../../src/surge/rules.js';

const SAFARI = '/Applications/Safari.app/Contents/MacOS/Safari';
const SAFARI_TP = '/Applications/Safari Technology Preview.app/Contents/MacOS/Safari Technology Preview';
/** 旧格式见证与占位规则限定的合成进程（只用于识别旧文件）。 */
const W = LEGACY_ENTRY_WITNESS_PROCESS_PATH;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const base = {
  name: 'SFE-N-E0001-US01-v003',
  host: '203.0.113.10',
  port: 1080,
  username: 'buyer01',
  password: 'examplePw_1',
  front: 'Front-A',
};

function catchErr(fn: () => unknown): SfeError {
  try {
    fn();
  } catch (e) {
    if (e instanceof SfeError) return e;
    throw e;
  }
  throw new Error('expected SfeError');
}

describe('nodeLine', () => {
  test('serializes a socks5 node with front', () => {
    expect(nodeLine(base)).toBe(
      'SFE-N-E0001-US01-v003 = socks5, 203.0.113.10, 1080, username=buyer01, password=examplePw_1, underlying-proxy=Front-A',
    );
  });

  test('omits username and password when null', () => {
    expect(nodeLine({ ...base, username: null, password: null })).toBe(
      'SFE-N-E0001-US01-v003 = socks5, 203.0.113.10, 1080, underlying-proxy=Front-A',
    );
  });

  test('accepts IPv6 and hostnames', () => {
    expect(nodeLine({ ...base, host: '2001:db8::10' })).toContain(', 2001:db8::10, 1080,');
    expect(nodeLine({ ...base, host: 'proxy.example.test' })).toContain(', proxy.example.test, 1080,');
  });

  const injections = [',', '\n', '\r', '=', ' ', '#', ';', '"', "'", '(', ')', '\u0000', ', underlying-proxy=DIRECT', '\nFINAL,DIRECT', '日'];
  for (const field of ['username', 'password'] as const) {
    for (const bad of injections) {
      test(`${field} with ${JSON.stringify(bad)} → UNSAFE_CREDENTIAL_CHARS without echo`, () => {
        const value = `secretVALUE${bad}tail`;
        const err = catchErr(() => nodeLine({ ...base, [field]: value }));
        expect(err.code).toBe('UNSAFE_CREDENTIAL_CHARS');
        const body = JSON.stringify(err.toBody());
        expect(body).not.toContain('secretVALUE');
        expect(err.fieldErrors?.[0]?.field).toBe(`proxy.${field}`);
      });
    }
  }

  test('front names may contain inner spaces like other Surge policy names', () => {
    expect(nodeLine({ ...base, front: 'Front A' })).toMatch(/underlying-proxy=Front A$/);
  });

  for (const bad of [',', '\n', '=', '"', '#', ';']) {
    test(`front with ${JSON.stringify(bad)} → VALIDATION_FAILED without echo`, () => {
      const err = catchErr(() => nodeLine({ ...base, front: `FrontX${bad}tail` }));
      expect(err.code).toBe('VALIDATION_FAILED');
      expect(JSON.stringify(err.toBody())).not.toContain('FrontX');
    });
  }

  test.each(['DIRECT', 'REJECT', 'reject-tinygif', 'SFE-ROUTE', 'SFE-N-E0002-US02-v001'])('front %s is refused', (front) => {
    expect(catchErr(() => nodeLine({ ...base, front })).code).toBe('VALIDATION_FAILED');
  });

  for (const host of ['203.0.113.10,1', '203.0.113.10\n', 'a=b.example.test', ' 203.0.113.10', '[2001:db8::1]', 'evil.example.test, 1, username=x']) {
    test(`host ${JSON.stringify(host)} → VALIDATION_FAILED without echo`, () => {
      const err = catchErr(() => nodeLine({ ...base, host }));
      expect(err.code).toBe('VALIDATION_FAILED');
      expect(JSON.stringify(err.toBody())).not.toContain(host.trim() || host);
    });
  }

  test.each([0, 65536, 1.5, Number.NaN])('port %s → VALIDATION_FAILED', (port) => {
    expect(catchErr(() => nodeLine({ ...base, port })).code).toBe('VALIDATION_FAILED');
  });

  test.each(['SFE-N-E0001 = x', 'Node-1', 'SFE-N,1', 'SFE-N\n'])('name %j → VALIDATION_FAILED', (name) => {
    expect(catchErr(() => nodeLine({ ...base, name })).code).toBe('VALIDATION_FAILED');
  });
});

describe('resourceFile and group block', () => {
  test('header carries generation only', () => {
    const text = resourceFile(7, ['SFE-N-E0001-US01-v001 = socks5, 203.0.113.10, 1080, underlying-proxy=Front-A']);
    expect(text.split('\n')[0]).toBe('# SFE managed resource · generation 7');
    expect(text.endsWith('\n')).toBe(true);
    expect(text).not.toMatch(/digest|sha|hmac/i);
  });

  test('rejects multi-line entries and bad generations', () => {
    expect(() => resourceFile(1, ['a\nb'])).toThrow(SfeError);
    expect(() => resourceFile(-1, [])).toThrow(SfeError);
  });

  test('group block has REJECT as first member and the node resource', () => {
    expect(groupBlockLines()).toEqual(['SFE-ROUTE = select, REJECT, policy-path=sfe-nodes.list']);
  });
});

describe('validateSafariProcessPaths', () => {
  test('accepts real-looking absolute paths, including spaces', () => {
    expect(validateSafariProcessPaths([SAFARI, SAFARI_TP])).toEqual([]);
  });

  test.each([
    [[], 'safariProcessPaths'],
    [['Safari'], 'safariProcessPaths[0]'],
    [['/Applications/Safari.app/Contents/MacOS/*'], 'safariProcessPaths[0]'],
    [['/Applications/Safari.app,/x'], 'safariProcessPaths[0]'],
    [['/Applications/Safari.app/Contents/MacOS/Safari\n'], 'safariProcessPaths[0]'],
    [['/Applications/Safari.app/Contents/MacOS/(Safari)'], 'safariProcessPaths[0]'],
    [['/System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.Networking.xpc/Contents/MacOS/com.apple.WebKit.Networking'], 'safariProcessPaths[0]'],
    [['/System/Cryptexes/OS/System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/x'], 'safariProcessPaths[0]'],
    [['/Applications/../Safari'], 'safariProcessPaths[0]'],
    [[SAFARI, SAFARI], 'safariProcessPaths[1]'],
    [[' /Applications/Safari.app/Contents/MacOS/Safari'], 'safariProcessPaths[0]'],
    // 本应用见证与占位规则的合成进程目录（含规范路径 /private/var/empty）：入口规则行不能与见证行相同
    [['/var/empty/sfe-entry-witness-active-ab12'], 'safariProcessPaths[0]'],
    [['/var/empty/sfe-entry-disabled'], 'safariProcessPaths[0]'],
    [[SAFARI, '/private/var/empty/Safari'], 'safariProcessPaths[1]'],
  ])('rejects %j', (paths, field) => {
    const errors = validateSafariProcessPaths(paths);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]!.field).toBe(field);
  });

  test('allows a Safari-specific WebKit copy (decided by P0 evidence, not by the validator)', () => {
    const appCryptex =
      '/System/Volumes/Preboot/Cryptexes/App/System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.Networking.xpc/Contents/MacOS/com.apple.WebKit.Networking';
    expect(validateSafariProcessPaths([appCryptex])).toEqual([]);
    expect(validateSafariProcessPaths(['/System/Volumes/Preboot/Cryptexes/OS/System/Library/Frameworks/WebKit.framework/x'])).toHaveLength(1);
  });

  test('existence check is injectable', () => {
    expect(validateSafariProcessPaths([SAFARI], { exists: () => false })[0]!.message).toBe('进程路径不存在');
    expect(validateSafariProcessPaths([SAFARI], { exists: () => true })).toEqual([]);
  });
});

describe('entry rules', () => {
  const one = { processPaths: [SAFARI], verifyHost: 'verify.example.test' };
  const two = { processPaths: [SAFARI, SAFARI_TP], verifyHost: 'verify.example.test' };

  test('single path bodies', () => {
    expect(entryRules('udp', true, one)).toEqual([`AND,((PROCESS-NAME,${SAFARI}),(PROTOCOL,UDP))`]);
    expect(entryRules('verify', true, one)).toEqual([`AND,((PROCESS-NAME,${SAFARI}),(DOMAIN,verify.example.test))`]);
    expect(entryRules('block', true, one)).toEqual([`PROCESS-NAME,${SAFARI}`]);
    expect(entryRules('active', true, one)).toEqual([`PROCESS-NAME,${SAFARI}`]);
  });

  test('multiple paths use OR for logical rules and one line each for process rules', () => {
    expect(entryRules('udp', true, two)).toEqual([`AND,((OR,((PROCESS-NAME,${SAFARI}),(PROCESS-NAME,${SAFARI_TP}))),(PROTOCOL,UDP))`]);
    expect(entryRules('block', true, two)).toEqual([`PROCESS-NAME,${SAFARI}`, `PROCESS-NAME,${SAFARI_TP}`]);
  });

  test('off bits write the placeholder rule', () => {
    for (const bit of ['udp', 'verify', 'block', 'active'] as const) expect(entryRules(bit, false, one)).toEqual([ENTRY_PLACEHOLDER_RULE]);
  });

  test('profile RULE-SET lines in order udp > verify > block > active', () => {
    expect(entryRuleSetBlockLines()).toEqual([
      'RULE-SET,sfe-entry-udp.list,REJECT',
      'RULE-SET,sfe-entry-verify.list,SFE-ROUTE',
      'RULE-SET,sfe-entry-block.list,REJECT',
      'RULE-SET,sfe-entry-active.list,SFE-ROUTE',
    ]);
  });

  test('temp rule texts: disjoint conditions with documented logical rules; multi-path uses OR', () => {
    expect(tempRuleText('block', one)).toBe(`PROCESS-NAME,${SAFARI},REJECT`);
    expect(tempRuleText('udp', one)).toBe(`AND,((PROCESS-NAME,${SAFARI}),(PROTOCOL,UDP)),REJECT`);
    expect(tempRuleText('verify', one)).toBe(`AND,((PROCESS-NAME,${SAFARI}),(NOT,((PROTOCOL,UDP))),(DOMAIN,verify.example.test)),SFE-ROUTE`);
    expect(tempRuleText('active', one)).toBe(`AND,((PROCESS-NAME,${SAFARI}),(NOT,((PROTOCOL,UDP)))),SFE-ROUTE`);
    expect(tempRuleText('blockOther', one)).toBe(`AND,((PROCESS-NAME,${SAFARI}),(NOT,((PROTOCOL,UDP))),(NOT,((DOMAIN,verify.example.test)))),REJECT`);
    expect(tempRuleText('block', two)).toBe(`OR,((PROCESS-NAME,${SAFARI}),(PROCESS-NAME,${SAFARI_TP})),REJECT`);
    expect(tempRuleText('active', two)).toBe(`AND,((OR,((PROCESS-NAME,${SAFARI}),(PROCESS-NAME,${SAFARI_TP}))),(NOT,((PROTOCOL,UDP)))),SFE-ROUTE`);
    expect(tempEntryRuleTexts(one)).toHaveLength(5);
    // 旧版本按顺序设计的文本只用于识别遗留规则
    expect(legacyTempRuleText('active', one)).toBe(`PROCESS-NAME,${SAFARI},SFE-ROUTE`);
    expect(legacyTempRuleText('verify', one)).toBe(`AND,((PROCESS-NAME,${SAFARI}),(DOMAIN,verify.example.test)),SFE-ROUTE`);
  });

  test('temp rule texts parse with the shared rule parser and evaluate as the coverage table says', () => {
    const facts = (protocol: 'tcp' | 'udp', host: string, processPath = SAFARI) => ({ processPath, host, protocol });
    const hit = (kind: Parameters<typeof tempRuleText>[0], f: ReturnType<typeof facts>): boolean => evaluateCondition(parseRule(tempRuleText(kind, one))!.condition, f);
    const V = 'verify.example.test';
    const O = 'www.example.test';
    expect([hit('udp', facts('udp', V)), hit('udp', facts('udp', O)), hit('udp', facts('tcp', V))]).toEqual([true, true, false]);
    expect([hit('verify', facts('tcp', V)), hit('verify', facts('udp', V)), hit('verify', facts('tcp', O))]).toEqual([true, false, false]);
    expect([hit('active', facts('tcp', V)), hit('active', facts('tcp', O)), hit('active', facts('udp', O))]).toEqual([true, true, false]);
    expect([hit('blockOther', facts('tcp', O)), hit('blockOther', facts('tcp', V)), hit('blockOther', facts('udp', O))]).toEqual([true, false, false]);
    expect(hit('block', facts('udp', O))).toBe(true);
    // Chrome 不会被任何一条命中
    for (const kind of ['block', 'udp', 'verify', 'active', 'blockOther'] as const) {
      for (const p of ['tcp', 'udp'] as const) expect(hit(kind, facts(p, V, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'))).toBe(false);
    }
  });

  test('rule set file content has a comment header and one rule per line; on files carry a witness only when given', () => {
    const text = entryRuleSetFileContent('block', true, two);
    expect(text.split('\n')).toEqual(['# SFE managed entry rule set · block', `PROCESS-NAME,${SAFARI}`, `PROCESS-NAME,${SAFARI_TP}`, '']);
    expect(entryRuleSetFileContent('block', true, two, 'a1b2c3d4').split('\n')).toEqual([
      '# SFE managed entry rule set · block',
      'PROCESS-NAME,/var/empty/sfe-entry-witness-block-a1b2c3d4',
      `PROCESS-NAME,${SAFARI}`,
      `PROCESS-NAME,${SAFARI_TP}`,
      '',
    ]);
  });

  test('off files carry the fixed off witness by default (initial files can be read back), or none when asked', () => {
    expect(entryRuleSetFileContent('udp', false, one).split('\n')).toEqual([
      '# SFE managed entry rule set · udp',
      'PROCESS-NAME,/var/empty/sfe-entry-witness-udp-off',
      'PROCESS-NAME,/var/empty/sfe-entry-disabled',
      '',
    ]);
    expect(entryRuleSetFileContent('udp', false, one, null).split('\n')).toEqual(['# SFE managed entry rule set · udp', ENTRY_PLACEHOLDER_RULE, '']);
    expect(entryWitnessProcessPath('verify', 'off')).toBe('/var/empty/sfe-entry-witness-verify-off');
    expect(catchErr(() => entryWitnessProcessPath('verify', 'Bad.Token')).code).toBe('VALIDATION_FAILED');
    expect(catchErr(() => entryWitnessProcessPath('verify', 'a')).code).toBe('VALIDATION_FAILED');
  });

  test('parseEntryRuleSetFile separates the witness from the rules (only the witness of this bit counts)', () => {
    expect(parseEntryRuleSetFile('active', entryRuleSetFileContent('active', true, one, 'ff00'))).toEqual({ witness: 'ff00', legacyWitness: false, bodies: [`PROCESS-NAME,${SAFARI}`] });
    expect(parseEntryRuleSetFile('active', entryRuleSetFileContent('active', true, one))).toEqual({ witness: null, legacyWitness: false, bodies: [`PROCESS-NAME,${SAFARI}`] });
    // 另一位的见证行不算本位的见证，也不是本位的规则；空白不同的写法规范化后照样识别
    expect(parseEntryRuleSetFile('active', `# x\n${entryWitnessRule('block', 'ab12')}\nPROCESS-NAME , ${ENTRY_WITNESS_PROCESS_PREFIX}active-cd34\n`)).toEqual({
      witness: 'cd34',
      legacyWitness: false,
      bodies: [],
    });
    // 两条见证：无法确定
    expect(parseEntryRuleSetFile('udp', `${entryWitnessRule('udp', 'ab12')}\n${entryWitnessRule('udp', 'cd34')}\n`).witness).toBeNull();
    // 大小写不同、带子目录或以 “/” 结尾（App Bundle 前缀模式）的写法不是见证：它是一条普通规则行（文件因此无法识别）
    for (const line of ['PROCESS-NAME,/VAR/empty/sfe-entry-witness-active-cd34', 'PROCESS-NAME,/var/empty/sfe-entry-witness-active-cd34/', 'PROCESS-NAME,/var/empty/sfe-entry-witness/active-cd34']) {
      expect(parseEntryRuleSetFile('active', `${line}\n`)).toEqual({ witness: null, legacyWitness: false, bodies: [line] });
    }
  });

  test('legacy witness lines (synthetic process + .invalid host) are recognised but never taken as the witness', () => {
    const legacy = (bit: string, token: string): string => `AND,((PROCESS-NAME,${W}),(DOMAIN,sfe-entry-${bit}-${token}.invalid))`;
    // 旧格式的整份文件：见证行去掉、按没有见证处理；三种占位规则都留在 bodies 中（由策略识别为关闭）
    expect(parseEntryRuleSetFile('udp', `# SFE managed entry rule set · udp\n${legacy('udp', 'off')}\n${PREVIOUS_ENTRY_PLACEHOLDER_RULE}\n`)).toEqual({
      witness: null,
      legacyWitness: true,
      bodies: [PREVIOUS_ENTRY_PLACEHOLDER_RULE],
    });
    expect(parseEntryRuleSetFile('active', `AND, ((PROCESS-NAME, ${W}), (DOMAIN, sfe-entry-active-cd34.invalid))\nPROCESS-NAME,${SAFARI}\n`)).toEqual({
      witness: null,
      legacyWitness: true,
      bodies: [`PROCESS-NAME,${SAFARI}`],
    });
    // 与当前格式混用、不止一条或属于其他位：旧行留在 bodies 中（文件无法识别），从不当作见证
    expect(parseEntryRuleSetFile('active', `${entryWitnessRule('active', 'ab12')}\n${legacy('active', 'cd34')}\n`)).toEqual({
      witness: 'ab12',
      legacyWitness: false,
      bodies: [legacy('active', 'cd34')],
    });
    expect(parseEntryRuleSetFile('active', `${legacy('active', 'ab12')}\n${legacy('active', 'cd34')}\n`)).toMatchObject({ witness: null, legacyWitness: false });
    expect(parseEntryRuleSetFile('active', `${legacy('block', 'ab12')}\n`)).toEqual({ witness: null, legacyWitness: false, bodies: [legacy('block', 'ab12')] });
    // 不限定合成进程的旧写法不是见证：普通规则行，任何进程请求这一主机都会命中
    expect(parseEntryRuleSetFile('active', 'DOMAIN,sfe-entry-active-cd34.invalid\n')).toEqual({ witness: null, legacyWitness: false, bodies: ['DOMAIN,sfe-entry-active-cd34.invalid'] });
    expect(parseEntryRuleSetFile('active', `AND,((PROCESS-NAME,${SAFARI}),(DOMAIN,sfe-entry-active-cd34.invalid))\n`)).toMatchObject({ witness: null, legacyWitness: false });
  });

  test('witness and placeholder rules are a full-path PROCESS-NAME of a synthetic process only (no host or IP condition)', () => {
    expect(entryWitnessRule('verify', 'off')).toBe('PROCESS-NAME,/var/empty/sfe-entry-witness-verify-off');
    expect(ENTRY_PLACEHOLDER_RULE).toBe(`PROCESS-NAME,${ENTRY_PLACEHOLDER_PROCESS_PATH}`);
    expect(ENTRY_PLACEHOLDER_PROCESS_PATH).toBe('/var/empty/sfe-entry-disabled');
    expect(PREVIOUS_ENTRY_PLACEHOLDER_RULE).toBe(`AND,((PROCESS-NAME,${W}),(DOMAIN,sfe-disabled.invalid))`);
    expect(LEGACY_ENTRY_PLACEHOLDER_RULE).toBe('DOMAIN,sfe-disabled.invalid');
    expect(ENTRY_PROBE_IPV4).toBe('192.0.2.1');
    const tokens = ['off', 'ab12', '0a1b2c3d', 'w000001'];
    const realPaths = [SAFARI, SAFARI_TP, CHROME, '/usr/bin/curl', '/usr/bin/true', '/private/var/empty/sfe-entry-disabled', '/private/var/empty/sfe-entry-witness-active-ab12'];
    const synthetic = [ENTRY_PLACEHOLDER_RULE, ...(['udp', 'verify', 'block', 'active'] as const).flatMap((b) => tokens.map((t) => entryWitnessRule(b, t)))];
    for (const text of synthetic) {
      const c = parseCondition(text)!;
      expect(c.type).toBe('PROCESS-NAME');
      // 完整路径模式：以 “/” 开头、不以 “/” 结尾，不含通配符
      expect(c.value!.startsWith('/var/empty/')).toBe(true);
      expect(c.value!.endsWith('/')).toBe(false);
      expect(c.value).not.toMatch(/[*?,]/);
      // “可能匹配”（文档没有说明的细节取最宽的解释）也不会匹配任何真实进程路径
      for (const p of realPaths) expect(processNameMayMatch(c.value!, p), `${text} ${p}`).toBe(false);
      for (const host of ['verify.example.test', ENTRY_PROBE_IPV4, 'sfe-disabled.invalid']) {
        for (const processPath of [...realPaths, null]) {
          for (const protocol of ['tcp', 'udp'] as const) expect(evaluateCondition(c, { processPath, host, protocol })).toBe(false);
        }
        expect(evaluateCondition(c, { processPath: c.value, host, protocol: 'tcp' })).toBe(true);
      }
    }
    // 每个见证路径只命中它自己：其他位、其他标记与占位规则都不命中
    for (const a of synthetic) {
      for (const b of synthetic) expect(evaluateCondition(parseCondition(a)!, { processPath: parseCondition(b)!.value, host: ENTRY_PROBE_IPV4, protocol: 'tcp' })).toBe(a === b);
    }
  });

  test('no generated entry rule set line or entry rule carries an IP condition (an IP sub-rule gives the set a DNS requirement)', () => {
    const IP_TYPES = new Set(['IP-CIDR', 'IP-CIDR6', 'GEOIP', 'IP-ASN', 'SRC-IP', 'IN-PORT', 'DEST-PORT', 'SRC-PORT']);
    const types = (c: RuleCondition): string[] => [c.type, ...(c.operands ?? []).flatMap(types)];
    for (const opts of [one, two]) {
      for (const bit of ['udp', 'verify', 'block', 'active'] as const) {
        for (const on of [true, false]) {
          for (const witness of [undefined, null, 'ab12', 'off']) {
            const lines = entryRuleSetFileContent(bit, on, opts, witness).split('\n').filter((l) => l !== '' && !l.startsWith('#'));
            for (const line of lines) {
              const c = parseCondition(line)!;
              expect(c, line).not.toBeNull();
              expect(types(c).filter((t) => IP_TYPES.has(t)), line).toEqual([]);
              expect(line).not.toContain('.invalid');
            }
          }
        }
      }
    }
  });

  test.each(['203.0.113.5', 'verify.example.test,DIRECT', 'bad host', ''])('verify host %j is refused', (verifyHost) => {
    expect(catchErr(() => entryRules('verify', true, { processPaths: [SAFARI], verifyHost })).code).toBe('VALIDATION_FAILED');
  });

  test('invalid process paths are refused before generating any rule', () => {
    expect(catchErr(() => tempRuleText('block', { processPaths: ['Safari'], verifyHost: 'verify.example.test' })).code).toBe('VALIDATION_FAILED');
  });
});
