import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { ENTRY_RULESET_FILES } from '@sfe/contract';
import { createMemoryEntryOwnership } from '../../src/surge/entry/ownership.js';
import { allowedModes, modeOfSemantic, semanticOfMode, semanticOfOrder } from '../../src/surge/entry/common.js';
import { classifyEntryTempRule } from '../../src/surge/entry/temp-rule-strategy.js';
import { createRulesetStrategy } from '../../src/surge/entry/ruleset-strategy.js';
import { tempRuleText } from '../../src/surge/generate.js';
import { parseExternalResources, parseRequestRecords, stripPort, toDate } from '../../src/surge/parse-output.js';
import { parseProxyLine } from '../../src/surge/proxy-line.js';
import { FAKE_SAFARI_PATH, FAKE_VERIFY_HOST, FakeSurge, createFakeSurgeEnvironment } from '../../src/surge/fake.js';
import { createProfileFiles } from '../../src/surge/files.js';

describe('entry semantics', () => {
  test('canonical order of each mode maps back to the mode', () => {
    for (const m of ['NORMAL', 'BLOCKED', 'VERIFY_ONLY', 'ACTIVE'] as const) expect(modeOfSemantic(semanticOfMode(m))).toBe(m);
  });
  test('misordered rules are recognised as leaks or as another mode', () => {
    expect(modeOfSemantic(semanticOfOrder(['verify', 'udp', 'block']))).toBeNull(); // UDP 到检测主机经 SFE-ROUTE
    expect(modeOfSemantic(semanticOfOrder(['active', 'udp', 'block']))).toBeNull();
    expect(modeOfSemantic(semanticOfOrder(['udp', 'block', 'verify']))).toBe('BLOCKED');
    expect(modeOfSemantic(semanticOfOrder(['udp', 'active', 'block']))).toBe('ACTIVE');
  });
  test('allowed modes during a transition', () => {
    expect([...allowedModes('ACTIVE', 'NORMAL')].sort()).toEqual(['ACTIVE', 'BLOCKED', 'NORMAL', 'VERIFY_ONLY']);
    expect([...allowedModes('UNKNOWN', 'BLOCKED')].sort()).toEqual(['BLOCKED', 'VERIFY_ONLY']);
  });
});

describe('classifyEntryTempRule', () => {
  const opts = { processPaths: [FAKE_SAFARI_PATH, '/Applications/Safari Technology Preview.app/Contents/MacOS/Safari Technology Preview'], verifyHost: FAKE_VERIFY_HOST };
  test.each(['udp', 'verify', 'block', 'active'] as const)('%s', (bit) => {
    expect(classifyEntryTempRule(tempRuleText(bit, opts))).toBe(bit);
  });
  test.each(['DOMAIN,a.example.test,REJECT', 'PROCESS-NAME,/x,DIRECT', 'AND,((PROCESS-NAME,/x),(GEOIP,US)),REJECT'])('foreign %s', (t) => {
    expect(classifyEntryTempRule(t)).toBeNull();
  });
});

describe('memory ownership', () => {
  test('intent then confirm, keeping the previous digest while pending', async () => {
    const o = createMemoryEntryOwnership([{ kind: 'entry_ruleset_file', identity: 'f', digest: 'd1', state: 'present', operationId: null }]);
    await o.recordIntent('entry_ruleset_file', 'f', 'd2', 'op_1');
    expect(await o.getRecord('entry_ruleset_file', 'f')).toEqual({ kind: 'entry_ruleset_file', identity: 'f', digest: 'd2', state: 'pending_add', operationId: 'op_1', previousDigest: 'd1' });
    await o.confirm('entry_ruleset_file', 'f', 'present', 'd2');
    expect((await o.getRecord('entry_ruleset_file', 'f'))!.state).toBe('present');
  });
  test('temp rule records exclude removed ones', async () => {
    const o = createMemoryEntryOwnership();
    await o.recordIntent('temp_rule', 'A', null, null, 'add');
    await o.confirm('temp_rule', 'A', 'present');
    await o.recordIntent('temp_rule', 'B', null, null, 'add');
    await o.confirm('temp_rule', 'B', 'removed');
    expect((await o.getRecordedTempRules()).map((r) => r.identity)).toEqual(['A']);
  });
});

describe('output parsing', () => {
  test('dates from seconds, milliseconds and ISO strings', () => {
    expect(toDate(1760000000)?.toISOString()).toBe('2025-10-09T08:53:20.000Z');
    expect(toDate(1760000000000)?.toISOString()).toBe('2025-10-09T08:53:20.000Z');
    expect(toDate('2026-10-21T00:00:00Z')?.toISOString()).toBe('2026-10-21T00:00:00.000Z');
    expect(toDate('nope')).toBeNull();
  });
  test('host ports are stripped', () => {
    expect(stripPort('a.example.test:443')).toBe('a.example.test');
    expect(stripPort('[2001:db8::1]:443')).toBe('2001:db8::1');
    expect(stripPort('2001:db8::1')).toBe('2001:db8::1');
  });
  test('resources as a key map, URL locations redacted', () => {
    expect(parseExternalResources({ 'k1': { type: 'policy-path', url: 'https://u:p@sub.example.test/x?token=1', error: 'timeout' } })).toEqual([
      { key: 'k1', type: 'policy-path', location: 'https://***@sub.example.test/x?***', lastUpdatedAt: null, error: 'timeout' },
    ]);
  });
  test('request leaf from notes when no leaf field exists', () => {
    const [r] = parseRequestRecords({ requests: [{ id: 3, notes: ['[Rule] Policy decision path: SFE-ROUTE -> SFE-N-E0001-US01-v001'], method: 'UDP' }] });
    expect(r).toMatchObject({ id: '3', leafPolicyName: 'SFE-N-E0001-US01-v001', protocol: 'udp' });
  });
  test('unrecognised shapes fail loudly', () => {
    expect(() => parseRequestRecords('x')).toThrow(/无法识别/);
  });
  test('proxy lines', () => {
    expect(parseProxyLine('N = socks5, 203.0.113.1, 1080, underlying-proxy=Front A')).toMatchObject({ name: 'N', type: 'socks5', server: '203.0.113.1', port: 1080, params: { 'underlying-proxy': 'Front A' } });
    expect(parseProxyLine('# comment')).toBeNull();
  });
});

describe('ruleset strategy ownership edge cases', () => {
  test('a pending intent whose file matches neither digest is treated as an external change', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sfe-misc-'));
    try {
      createFakeSurgeEnvironment(dir);
      const fake = new FakeSurge({ directory: dir });
      const files = createProfileFiles({ directory: dir, hmacKey: 'example-hmac-key' });
      const ownership = createMemoryEntryOwnership(
        await Promise.all(
          Object.values(ENTRY_RULESET_FILES).map(async (name) => ({ kind: 'entry_ruleset_file' as const, identity: name, digest: await files.digest(name), state: 'present' as const, operationId: null })),
        ),
      );
      await ownership.recordIntent('entry_ruleset_file', ENTRY_RULESET_FILES.block, 'not-a-real-digest', 'op_x');
      await files.writeAtomic(ENTRY_RULESET_FILES.block, '# edited\nDOMAIN,x.example.test\n', await files.digest(ENTRY_RULESET_FILES.block));
      const ctrl = createRulesetStrategy({
        adapter: fake,
        files,
        ownership,
        config: () => ({ processPaths: [FAKE_SAFARI_PATH], verifyHost: FAKE_VERIFY_HOST, siteHosts: [] }),
        operationId: () => 'op_y',
        autoReloadCondition: () => 'off',
      });
      expect((await ctrl.read()).mode).toBe('UNKNOWN');
      await expect(ctrl.transition('NORMAL')).rejects.toMatchObject({ code: 'UNKNOWN_STATE' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
