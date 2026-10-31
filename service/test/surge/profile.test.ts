import { describe, expect, test } from 'vitest';
import { SfeError, nodeResourceUrl } from '@sfe/contract';
import {
  describeOutsideChanges,
  detectManagedConfigHeader,
  entryBlockIsFirstRule,
  findForeignSfeObjects,
  findManagedBlock,
  foreignSfePolicyNames,
  insertInitialBlocks,
  listRelativeReferences,
  listRemoteSourceHosts,
  parseProfile,
  replaceManagedBlock,
  serializeProfile,
  stripManagedConfigHeader,
  unifiedDiff,
  type OwnedSfeObjects,
} from '../../src/surge/profile.js';
import { entryRuleSetBlockLines, groupBlockLines, loopbackGroupBlockLines } from '../../src/surge/generate.js';

const BASE = [
  '#!MANAGED-CONFIG https://user:pw@sub.example.test/path/conf?token=abc interval=86400 strict=true',
  '[General]',
  'loglevel = notify',
  '',
  '[Proxy]',
  'Front-A = socks5, 192.0.2.10, 1080, username=example-user, password=example-pass',
  '',
  '[Proxy Group]',
  'Daily = select, Front-A, DIRECT',
  '',
  '[Rule]',
  'DOMAIN-SUFFIX,daily.example.test,Daily',
  'FINAL,DIRECT',
  '',
].join('\n');

const MANAGED = [
  '[Proxy Group]',
  'Daily = select, Front-A, DIRECT',
  '# SFE-BEGIN group v2',
  'SFE-ROUTE = select, REJECT, policy-path=sfe-nodes.list',
  '# SFE-END group',
  '',
  '[Rule]',
  '# SFE-BEGIN entry v1',
  'RULE-SET,sfe-entry-udp.list,REJECT',
  '# SFE-END entry',
  'FINAL,DIRECT',
  '',
].join('\n');

describe('parseProfile round trip', () => {
  test.each([
    ['LF', BASE],
    ['CRLF', BASE.replace(/\n/g, '\r\n')],
    ['CR only', BASE.replace(/\n/g, '\r')],
    ['mixed and no final newline', 'a\r\nb\nc\rd'],
    ['empty', ''],
    ['blank lines only', '\n\n\n'],
    ['unicode', '[General]\n# 日常-Safari环境\n'],
  ])('%s preserves every byte', (_n, text) => {
    expect(serializeProfile(parseProfile(text))).toBe(text);
  });

  test('sections with line ranges', () => {
    const p = parseProfile(BASE);
    expect(p.sections.map((s) => s.name)).toEqual([null, 'General', 'Proxy', 'Proxy Group', 'Rule']);
    const rule = p.sections.find((s) => s.name === 'Rule')!;
    expect(p.lines[rule.header!]!.text).toBe('[Rule]');
  });
});

describe('findManagedBlock', () => {
  test('finds a well-formed block with version and section', () => {
    const b = findManagedBlock(parseProfile(MANAGED), 'group');
    expect(b).toMatchObject({ start: 2, end: 4, version: 2, section: 'Proxy Group', lines: ['SFE-ROUTE = select, REJECT, policy-path=sfe-nodes.list'] });
  });

  test('missing when absent', () => {
    expect(findManagedBlock(parseProfile(BASE), 'group')).toBe('missing');
  });

  test.each([
    ['duplicate begin', MANAGED.replace('# SFE-END group', '# SFE-BEGIN group v3\n# SFE-END group')],
    ['unclosed', MANAGED.replace('# SFE-END group\n', '')],
    ['end before begin', '# SFE-END group\n# SFE-BEGIN group v1\n'],
    ['missing version', MANAGED.replace('# SFE-BEGIN group v2', '# SFE-BEGIN group')],
    ['sloppy marker', MANAGED.replace('# SFE-BEGIN group v2', '#SFE-BEGIN group v2')],
    ['nested other block', MANAGED.replace('SFE-ROUTE =', '# SFE-BEGIN entry v1\nSFE-ROUTE =')],
    ['spans sections', '[Proxy Group]\n# SFE-BEGIN group v1\n[Rule]\n# SFE-END group\n'],
    ['mismatched end name', MANAGED.replace('# SFE-END group', '# SFE-END groups')],
  ])('%s → ambiguous', (_n, text) => {
    expect(findManagedBlock(parseProfile(text), 'group')).toBe('ambiguous');
  });
});

describe('replaceManagedBlock', () => {
  test('replaces only the block content and keeps everything else byte-identical', () => {
    const crlf = MANAGED.replace(/\n/g, '\r\n');
    const out = replaceManagedBlock(crlf, 'entry', entryRuleSetBlockLines(), 2);
    expect(out).toContain('# SFE-BEGIN entry v2\r\nRULE-SET,sfe-entry-udp.list,REJECT\r\nRULE-SET,sfe-entry-verify.list,SFE-ROUTE');
    const before = crlf.slice(0, crlf.indexOf('# SFE-BEGIN entry'));
    const after = crlf.slice(crlf.indexOf('# SFE-END entry'));
    expect(out.startsWith(before)).toBe(true);
    expect(out.endsWith(after)).toBe(true);
  });

  test('refuses ambiguous or missing blocks', () => {
    expect(() => replaceManagedBlock(BASE, 'group', [])).toThrow(SfeError);
    expect(() => replaceManagedBlock(MANAGED.replace('# SFE-END group', ''), 'group', [])).toThrow(/段缺失或边界不明确/);
  });

  test('refuses content that contains markers or newlines', () => {
    expect(() => replaceManagedBlock(MANAGED, 'group', ['# SFE-END group'])).toThrow(SfeError);
    expect(() => replaceManagedBlock(MANAGED, 'group', ['a\nb'])).toThrow(SfeError);
  });
});

describe('insertInitialBlocks', () => {
  test('group at the end of [Proxy Group], entry as first lines of [Rule]', () => {
    const out = insertInitialBlocks(BASE, { group: groupBlockLines(), entry: entryRuleSetBlockLines(), general: null });
    const lines = out.split('\n');
    const pg = lines.indexOf('[Proxy Group]');
    expect(lines.slice(pg, pg + 5)).toEqual([
      '[Proxy Group]',
      'Daily = select, Front-A, DIRECT',
      '# SFE-BEGIN group v1',
      'SFE-ROUTE = select, REJECT, policy-path=sfe-nodes.list',
      '# SFE-END group',
    ]);
    const rule = lines.indexOf('[Rule]');
    expect(lines[rule + 1]).toBe('# SFE-BEGIN entry v1');
    expect(lines[rule + 6]).toBe('# SFE-END entry');
    expect(lines[rule + 7]).toBe('DOMAIN-SUFFIX,daily.example.test,Daily');
    expect(entryBlockIsFirstRule(parseProfile(out))).toBe(true);
    // 段外内容不变。
    expect(describeOutsideChanges(BASE, out)).toEqual([]);
  });

  test('creates [Proxy Group] before [Rule] when missing; temp_rule strategy writes no entry block', () => {
    const text = '[General]\nloglevel = notify\n\n[Rule]\nFINAL,DIRECT';
    const out = insertInitialBlocks(text, { group: groupBlockLines(), entry: null, general: null });
    expect(out).toBe(
      '[General]\nloglevel = notify\n\n[Proxy Group]\n# SFE-BEGIN group v1\nSFE-ROUTE = select, REJECT, policy-path=sfe-nodes.list\n# SFE-END group\n\n[Rule]\nFINAL,DIRECT',
    );
    expect(findManagedBlock(parseProfile(out), 'entry')).toBe('missing');
  });

  test('general block goes to the end of [General], or a new [General] before the first section', () => {
    const general = ['http-api = example-key@127.0.0.1:6171', 'http-api-tls = false', 'http-api-web-dashboard = false'];
    const out = insertInitialBlocks(BASE, { group: groupBlockLines(), entry: [], general });
    const lines = out.split('\n');
    expect(lines.slice(1, 4)).toEqual(['[General]', 'loglevel = notify', '# SFE-BEGIN general v1']);
    const noGeneral = insertInitialBlocks('[Rule]\nFINAL,DIRECT\n', { group: groupBlockLines(), entry: [], general });
    expect(noGeneral.startsWith('[General]\n# SFE-BEGIN general v1\n')).toBe(true);
  });

  test('keeps CRLF line endings and appends a line ending to an unterminated last line', () => {
    const text = '[Rule]\r\nFINAL,DIRECT\r\n[Proxy Group]\r\nDaily = select, DIRECT';
    const out = insertInitialBlocks(text, { group: groupBlockLines(), entry: ['RULE-SET,sfe-entry-udp.list,REJECT'], general: null });
    expect(out).toBe(
      '[Rule]\r\n# SFE-BEGIN entry v1\r\nRULE-SET,sfe-entry-udp.list,REJECT\r\n# SFE-END entry\r\nFINAL,DIRECT\r\n[Proxy Group]\r\nDaily = select, DIRECT\r\n# SFE-BEGIN group v1\r\nSFE-ROUTE = select, REJECT, policy-path=sfe-nodes.list\r\n# SFE-END group\r\n',
    );
  });

  test('refuses when [Rule] is missing, sections are duplicated, or SFE markers exist', () => {
    expect(() => insertInitialBlocks('[General]\n', { group: [], entry: [], general: null })).toThrow(/缺少 \[Rule\]/);
    expect(() => insertInitialBlocks('[Rule]\n[Rule]\n', { group: [], entry: [], general: null })).toThrow(/重复/);
    try {
      insertInitialBlocks(MANAGED, { group: [], entry: [], general: null });
      throw new Error('should refuse');
    } catch (e) {
      expect((e as SfeError).code).toBe('NAME_COLLISION');
    }
  });
});

describe('entryBlockIsFirstRule', () => {
  test('false when a user rule precedes the entry block', () => {
    const text = MANAGED.replace('[Rule]\n', '[Rule]\nDOMAIN,a.example.test,DIRECT\n');
    expect(entryBlockIsFirstRule(parseProfile(text))).toBe(false);
  });
  test('comments and blank lines before the block are allowed', () => {
    const text = MANAGED.replace('[Rule]\n', '[Rule]\n# note\n\n');
    expect(entryBlockIsFirstRule(parseProfile(text))).toBe(true);
  });
  test('false when the block is missing', () => {
    expect(entryBlockIsFirstRule(parseProfile(BASE))).toBe(false);
  });
});

describe('managed config header', () => {
  test('detects and returns only the host', () => {
    expect(detectManagedConfigHeader(BASE)).toEqual({ line: 1, host: 'sub.example.test' });
    expect(detectManagedConfigHeader('[General]\n')).toBeNull();
  });
  test('strip removes only that line', () => {
    const out = stripManagedConfigHeader(BASE);
    expect(out).toBe(BASE.split('\n').slice(1).join('\n'));
    expect(stripManagedConfigHeader('[General]\n')).toBe('[General]\n');
  });
});

describe('references', () => {
  const text = [
    '#!include extra.dconf, https://inc.example.test/a.dconf',
    '[Proxy Group]',
    'Sub = select, policy-path=nodes/sub.list',
    'Remote = select, policy-path=https://nodes.example.test/x?token=1',
    '[Rule]',
    'RULE-SET,rules/local.list,DIRECT',
    'RULE-SET,SYSTEM,DIRECT',
    'RULE-SET,https://rules.example.test/r.list,REJECT',
    'DOMAIN-SET,/abs/set.txt,REJECT',
    'AND,((RULE-SET,inner.list),(PROTOCOL,UDP)),REJECT',
    '[Script]',
    'x = type=http-request,pattern=^https://a.example.test,script-path=scripts/x.js',
  ].join('\n');

  test('lists local relative references only', () => {
    expect(listRelativeReferences(text).map((r) => `${r.kind}:${r.value}`)).toEqual([
      'include:extra.dconf',
      'policy-path:nodes/sub.list',
      'rule-set:rules/local.list',
      'rule-set:inner.list',
      'script-path:scripts/x.js',
    ]);
  });

  test('remote hosts only, no paths or queries', () => {
    expect(listRemoteSourceHosts(text)).toEqual(['inc.example.test', 'nodes.example.test', 'rules.example.test']);
  });

  test('our own loopback resource URL is not a remote source; other loopback sources still are (D10)', () => {
    const url = nodeResourceUrl(20001, 'a'.repeat(64));
    const withOurs = [text, '[Proxy Group]', '# SFE-BEGIN group v1', ...loopbackGroupBlockLines(url), '# SFE-END group'].join('\n');
    expect(listRemoteSourceHosts(withOurs, url)).toEqual(['inc.example.test', 'nodes.example.test', 'rules.example.test']);
    // 调用方没有给出地址（旧调用）时照旧计入，主机名不含路径
    expect(listRemoteSourceHosts(withOurs)).toEqual(['127.0.0.1', 'inc.example.test', 'nodes.example.test', 'rules.example.test']);
    const converter = `${withOurs}\nConv = select, policy-path=http://127.0.0.1:25500/sub?target=surge`;
    expect(listRemoteSourceHosts(converter, url)).toEqual(['127.0.0.1', 'inc.example.test', 'nodes.example.test', 'rules.example.test']);
    expect(listRemoteSourceHosts(withOurs, nodeResourceUrl(20001, 'b'.repeat(64)))).toContain('127.0.0.1');
  });
});

describe('findForeignSfeObjects', () => {
  const owned = { names: ['SFE-ROUTE'], files: ['sfe-nodes.list', 'sfe-entry-udp.list'] };
  test('nothing foreign in a clean managed profile', () => {
    expect(findForeignSfeObjects(MANAGED, owned)).toEqual([]);
  });
  test('reports SFE- definitions and sfe-* references outside managed blocks', () => {
    const text = [
      '[Proxy]',
      'SFE-N-E0009-US09-v001 = socks5, 203.0.113.9, 1080',
      '[Proxy Group]',
      'SFE-OTHER = select, DIRECT',
      'User = select, policy-path=sfe-nodes.list',
      '# SFE-BEGIN group v1',
      'SFE-ROUTE = select, REJECT, policy-path=sfe-nodes.list',
      'SFE-EXTRA = select, REJECT',
      '# SFE-END group',
      '[Rule]',
      'RULE-SET,sfe-entry-active.list,DIRECT',
      'FINAL,DIRECT',
    ].join('\n');
    expect(findForeignSfeObjects(text, owned).map((o) => `${o.kind}:${o.name}@${o.line}`)).toEqual([
      'proxy:SFE-N-E0009-US09-v001@2',
      'group:SFE-OTHER@4',
      'file_reference:sfe-nodes.list@5',
      'group:SFE-EXTRA@8',
      'file_reference:sfe-entry-active.list@11',
    ]);
  });

  describe('loopback resource references (D10)', () => {
    // 合成令牌与端口
    const TOKEN = 'a'.repeat(64);
    const URL = nodeResourceUrl(20001, TOKEN);
    const ownedUrl = { ...owned, resourceUrl: URL };
    const managed = (groupLines: readonly string[], extra: readonly string[] = []): string =>
      [
        '[General]',
        'loglevel = notify',
        '[Proxy Group]',
        'Daily = select, Front-A, DIRECT',
        '# SFE-BEGIN group v1',
        ...groupLines,
        '# SFE-END group',
        ...extra,
        '[Rule]',
        '# SFE-BEGIN entry v1',
        'RULE-SET,sfe-entry-udp.list,REJECT',
        '# SFE-END entry',
        'FINAL,DIRECT',
      ].join('\n');
    const show = (text: string, o: OwnedSfeObjects = ownedUrl) => findForeignSfeObjects(text, o).map((x) => `${x.kind}:${x.name}@${x.line}`);

    test('our loopback group line is ours', () => {
      expect(show(managed(loopbackGroupBlockLines(URL)))).toEqual([]);
    });

    test('references to our port outside the group segment are foreign (names carry host and port only)', () => {
      const text = managed(loopbackGroupBlockLines(URL), [
        `Leech = select, policy-path=${URL}`,
        'Other = select, policy-path=http://localhost:20001/x/sfe-nodes.list',
        '# a comment about http://127.0.0.1:20001/ is ignored',
        'Conv = select, policy-path=http://127.0.0.1:25500/sub',
        'Near = select, policy-path=http://127.0.0.1:200010/x',
      ]);
      const found = findForeignSfeObjects(text, ownedUrl);
      expect(found.map((x) => `${x.kind}:${x.name}@${x.line}`)).toEqual(['resource_reference:127.0.0.1:20001@8', 'resource_reference:localhost:20001@9']);
      expect(JSON.stringify(found)).not.toContain(TOKEN);
      const general = managed(loopbackGroupBlockLines(URL)).replace('loglevel = notify', 'http-listen = 127.0.0.1:20001');
      expect(show(general)).toEqual(['resource_reference:127.0.0.1:20001@2']);
      const include = `#!include ${URL}\n${managed(loopbackGroupBlockLines(URL))}`;
      expect(show(include)).toEqual(['resource_reference:127.0.0.1:20001@1']);
    });

    test('remote policy-paths inside a managed segment that are not ours are foreign', () => {
      expect(show(managed(['SFE-ROUTE = select, REJECT, policy-path=https://nodes.example.test/a.list']))).toEqual(['resource_reference:nodes.example.test@6']);
      expect(show(managed(loopbackGroupBlockLines(nodeResourceUrl(20001, 'b'.repeat(64)))))).toEqual(['resource_reference:127.0.0.1:20001@6']);
      expect(show(managed(loopbackGroupBlockLines(nodeResourceUrl(20002, TOKEN))))).toEqual(['resource_reference:127.0.0.1:20002@6']);
      // 本应用地址出现在其他受管理段中也不属于本应用
      const inEntry = managed(loopbackGroupBlockLines(URL)).replace('RULE-SET,sfe-entry-udp.list,REJECT', `RULE-SET,${URL},REJECT`);
      expect(show(inEntry)).toEqual(['resource_reference:127.0.0.1:20001@10']);
      // 调用方没有给出地址时：受管理段内的任何远端引用都不属于本应用
      expect(show(managed(loopbackGroupBlockLines(URL)), owned)).toEqual(['resource_reference:127.0.0.1:20001@6']);
      // 旧版本地行与旧调用照旧
      expect(show(managed(groupBlockLines()), owned)).toEqual([]);
      expect(show(managed(groupBlockLines()))).toEqual([]);
    });

    test('a missing or ambiguous group segment leaves no place where our URL is ours', () => {
      const text = ['[Proxy Group]', ...loopbackGroupBlockLines(URL), '[Rule]', 'FINAL,DIRECT'].join('\n');
      expect(show(text)).toEqual(['group:SFE-ROUTE@2', 'resource_reference:127.0.0.1:20001@2']);
    });

    test('an invalid own URL is refused', () => {
      expect(() => findForeignSfeObjects(MANAGED, { ...owned, resourceUrl: 'http://127.0.0.1:20001/x' })).toThrow(/本机资源服务地址不正确/);
    });

    test('SFE-EMPTY is whitelisted only in the Surge policy-name check, never as a profile definition', () => {
      expect(foreignSfePolicyNames(['SFE-ROUTE', 'SFE-EMPTY', 'SFE-N-E0001-US01-v001', 'SFE-X', 'sfe-empty', 'Daily'], new Set(['SFE-ROUTE', 'SFE-N-E0001-US01-v001']))).toEqual([
        'SFE-X',
        'sfe-empty',
      ]);
      const defined = managed(loopbackGroupBlockLines(URL)).replace('[Proxy Group]', '[Proxy]\nSFE-EMPTY = direct\n[Proxy Group]');
      expect(show(defined)).toEqual(['proxy:SFE-EMPTY@4']);
    });
  });
});

describe('diff', () => {
  test('unified diff with context', () => {
    const a = ['1', '2', '3', '4', '5', '6', '7', '8'].join('\n');
    const b = ['1', '2', '3', 'four', '5', '6', '7', '8', '9'].join('\n');
    expect(unifiedDiff(a, b, 1)).toBe(['--- a', '+++ b', '@@ -3,3 +3,3 @@', ' 3', '-4', '+four', ' 5', '@@ -8,1 +8,2 @@', ' 8', '+9', ''].join('\n'));
  });
  test('identical texts give an empty diff; line ending changes are ignored', () => {
    expect(unifiedDiff('a\nb\n', 'a\r\nb\r\n')).toBe('');
  });
  test('pure insertion into an empty file', () => {
    expect(unifiedDiff('', 'x\n')).toBe('--- a\n+++ b\n@@ -0,0 +1,1 @@\n+x\n');
  });

  test('describeOutsideChanges reports sections and line numbers without content', () => {
    const next = MANAGED.replace('Daily = select, Front-A, DIRECT', 'Daily = select, Front-B, DIRECT')
      .replace('RULE-SET,sfe-entry-udp.list,REJECT', 'RULE-SET,sfe-entry-udp.list,DIRECT')
      .replace('FINAL,DIRECT', 'DOMAIN,new.example.test,DIRECT\nFINAL,DIRECT');
    const changes = describeOutsideChanges(MANAGED, next);
    expect(changes).toEqual([
      { section: 'Proxy Group', lines: [2] },
      { section: 'Rule', lines: [11] },
    ]);
    expect(JSON.stringify(changes)).not.toContain('example');
  });
});
