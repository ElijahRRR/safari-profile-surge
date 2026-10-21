import { describe, expect, test } from 'vitest';
import { ENTRY_PLACEHOLDER_RULE, SfeError } from '@sfe/contract';
import {
  entryRuleSetBlockLines,
  entryRuleSetFileContent,
  entryRules,
  groupBlockLines,
  nodeLine,
  resourceFile,
  tempRuleText,
  validateSafariProcessPaths,
} from '../../src/surge/generate.js';

const SAFARI = '/Applications/Safari.app/Contents/MacOS/Safari';
const SAFARI_TP = '/Applications/Safari Technology Preview.app/Contents/MacOS/Safari Technology Preview';
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

  test('temp rule text appends the policy; multi-path block uses OR', () => {
    expect(tempRuleText('udp', one)).toBe(`AND,((PROCESS-NAME,${SAFARI}),(PROTOCOL,UDP)),REJECT`);
    expect(tempRuleText('verify', one)).toBe(`AND,((PROCESS-NAME,${SAFARI}),(DOMAIN,verify.example.test)),SFE-ROUTE`);
    expect(tempRuleText('block', one)).toBe(`PROCESS-NAME,${SAFARI},REJECT`);
    expect(tempRuleText('active', two)).toBe(`OR,((PROCESS-NAME,${SAFARI}),(PROCESS-NAME,${SAFARI_TP})),SFE-ROUTE`);
  });

  test('rule set file content has a comment header and one rule per line', () => {
    const text = entryRuleSetFileContent('block', true, two);
    expect(text.split('\n')).toEqual(['# SFE managed entry rule set · block', `PROCESS-NAME,${SAFARI}`, `PROCESS-NAME,${SAFARI_TP}`, '']);
  });

  test.each(['203.0.113.5', 'verify.example.test,DIRECT', 'bad host', ''])('verify host %j is refused', (verifyHost) => {
    expect(catchErr(() => entryRules('verify', true, { processPaths: [SAFARI], verifyHost })).code).toBe('VALIDATION_FAILED');
  });

  test('invalid process paths are refused before generating any rule', () => {
    expect(catchErr(() => tempRuleText('block', { processPaths: ['Safari'], verifyHost: 'verify.example.test' })).code).toBe('VALIDATION_FAILED');
  });
});
