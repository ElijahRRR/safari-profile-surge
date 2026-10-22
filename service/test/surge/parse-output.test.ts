// --raw 输出解析的失败即关闭：未知的外层结构与无法识别的项一律报错，从不静默跳过或按行拆分人类可读输出。
// 合成数据；Surge 6.5 真实的 dump temp-rule / dump rule 项格式尚未实测（P0 用 entry --probe-insertion 正向确认）。

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { ENTRY_MODE_BITS } from '@sfe/contract';
import type { SurgeAdapter } from '../../src/ports.js';
import { createCliAdapter, type ExecFn } from '../../src/surge/cli-adapter.js';
import { CLI_COMMANDS } from '../../src/surge/cli-commands.js';
import { FAKE_SAFARI_PATH, FAKE_VERIFY_HOST, FakeSurge, createFakeSurgeEnvironment } from '../../src/surge/fake.js';
import { ENTRY_BITS_IN_ORDER, nodeLine, resourceFile, tempRuleText } from '../../src/surge/generate.js';
import { createMemoryEntryOwnership } from '../../src/surge/entry/ownership.js';
import { createTempRuleStrategy } from '../../src/surge/entry/temp-rule-strategy.js';
import { parseExternalResources, parsePolicyNames, parseRequestRecords, parseRuleList, parseTempRuleList } from '../../src/surge/parse-output.js';

const CLI = '/Applications/Surge.app/Contents/Applications/surge-cli';
const SAFARI_REJECT = `PROCESS-NAME,${FAKE_SAFARI_PATH},REJECT`;
const id = (s: string): string => s;

describe('parseTempRuleList fails closed (--raw dump temp-rule)', () => {
  test('items that are neither non-empty strings nor objects with a rule field are refused, not dropped', () => {
    expect(() => parseTempRuleList(JSON.stringify({ rules: [{ ruleString: SAFARI_REJECT }] }))).toThrow(/读取临时规则失败：Surge 输出格式无法识别/);
    expect(() => parseTempRuleList(JSON.stringify(['DOMAIN,a.example.test,REJECT', { ruleString: SAFARI_REJECT }]))).toThrow(/无法识别/);
    expect(() => parseTempRuleList(JSON.stringify([42]))).toThrow(/无法识别/);
    expect(() => parseTempRuleList(JSON.stringify(['  ']))).toThrow(/无法识别/);
    expect(() => parseTempRuleList(JSON.stringify([{ rule: '' }]))).toThrow(/无法识别/);
    expect(() => parseTempRuleList(JSON.stringify([null]))).toThrow(/无法识别/);
  });

  test('human-readable (non-JSON) output is refused instead of split into junk rules', () => {
    expect(() => parseTempRuleList(`Temporary Rules (1):\n1. ${SAFARI_REJECT}\n`)).toThrow(/无法识别/);
    expect(() => parseTempRuleList('# temp rules\nDOMAIN,a.example.test,REJECT\n')).toThrow(/无法识别/);
  });

  test('unknown envelopes are refused', () => {
    expect(() => parseTempRuleList('{}')).toThrow(/无法识别/);
    expect(() => parseTempRuleList(JSON.stringify({ data: { rules: [SAFARI_REJECT] } }))).toThrow(/无法识别/);
  });

  test('whitespace-only output is an empty list; recognised shapes parse', () => {
    expect(parseTempRuleList('')).toEqual([]);
    expect(parseTempRuleList(' \n')).toEqual([]);
    expect(parseTempRuleList('[]')).toEqual([]);
    expect(parseTempRuleList(JSON.stringify({ rules: [] }))).toEqual([]);
    expect(parseTempRuleList(JSON.stringify([` ${SAFARI_REJECT} `]))).toEqual([SAFARI_REJECT]);
    expect(parseTempRuleList(JSON.stringify({ 'temp-rules': [{ rule: 'A' }, { content: 'B' }, { text: 'C' }] }))).toEqual(['A', 'B', 'C']);
  });
});

describe('parseRuleList fails closed (--raw dump rule)', () => {
  test('an unrecognised item is refused instead of hiding a rule evaluated before the entry rules', () => {
    expect(() => parseRuleList(JSON.stringify({ rules: [{ ruleString: 'DOMAIN,verify.example.test,DIRECT' }, 'FINAL,DIRECT'] }), id)).toThrow(/读取规则列表失败：Surge 输出格式无法识别/);
    expect(() => parseRuleList(JSON.stringify([1, 'FINAL,DIRECT']), id)).toThrow(/无法识别/);
  });

  test('non-JSON output and an empty list are refused (an effective rule list always contains FINAL)', () => {
    expect(() => parseRuleList('Rules:\n1. FINAL,DIRECT\n', id)).toThrow(/无法识别/);
    expect(() => parseRuleList('', id)).toThrow(/无法识别/);
    expect(() => parseRuleList('[]', id)).toThrow(/无法识别/);
    expect(() => parseRuleList('{}', id)).toThrow(/无法识别/);
  });

  test('recognised items parse, module names kept, text scrubbed', () => {
    const scrub = (s: string): string => s.replace('secret', '***');
    expect(parseRuleList(JSON.stringify({ rules: ['DOMAIN,secret.example.test,DIRECT', { rule: 'DOMAIN,m.example.test,DIRECT', module: 'M' }, 'FINAL,DIRECT'] }), scrub)).toEqual([
      { text: 'DOMAIN,***.example.test,DIRECT', source: 'unknown', moduleName: null },
      { text: 'DOMAIN,m.example.test,DIRECT', source: 'module', moduleName: 'M' },
      { text: 'FINAL,DIRECT', source: 'unknown', moduleName: null },
    ]);
  });
});

describe('parseExternalResources', () => {
  const LOC = '/tmp/sfe-fixture/sfe-entry-block.list';

  test('a resource reported ready:false without error text is not healthy', () => {
    expect(parseExternalResources({ defines: [{ key: 'k', type: 'ruleset', path: LOC, local: true, ready: false }] })).toEqual([
      { key: 'k', type: 'ruleset', location: LOC, lastUpdatedAt: null, error: 'not_ready' },
    ]);
    expect(parseExternalResources({ defines: [{ key: 'k', type: 'ruleset', path: LOC, local: true, ready: true }] })[0]!.error).toBeNull();
    expect(parseExternalResources({ defines: [{ key: 'k', path: LOC, ready: 'no' }] })[0]!.error).toBe('not_ready');
    // 没有 ready 字段时按其他字段判断；错误文本优先，并去掉 URL 中的凭据与查询串。
    expect(parseExternalResources({ defines: [{ key: 'k', path: LOC }] })[0]!.error).toBeNull();
    expect(parseExternalResources({ defines: [{ key: 'k', path: LOC, ready: false, error: 'fetch https://u:p@x.example.test/a?token=1 failed' }] })[0]!.error).toBe(
      'fetch https://***@x.example.test/a?*** failed',
    );
  });

  test.each([
    ['empty object', {}],
    ['error reply', { error: 'not ready' }],
    ['defines as an object map', { defines: { k: { path: LOC } } }],
    ['nested envelope', { data: { defines: [{ key: 'k', path: LOC }] } }],
    ['key map with a value lacking a location', { k1: { path: LOC }, k2: { type: 'ruleset' } }],
    ['key map with a non-object value', { k1: { path: LOC }, status: 'ok' }],
    ['scalar', 'not json'],
  ])('unknown envelope (%s) is refused instead of read as no resources', (_name, json) => {
    expect(() => parseExternalResources(json)).toThrow(/读取外部资源失败：Surge 输出格式无法识别/);
  });

  test.each([
    ['missing key', { defines: [{ key: 'a', path: LOC }, { path: '/tmp/sfe-fixture/sfe-nodes.list' }] }],
    ['missing location', { defines: [{ key: 'a', path: LOC }, { key: 'b', type: 'ruleset' }] }],
    ['empty location', { defines: [{ key: 'a', path: '' }] }],
    ['non-object item', { defines: [{ key: 'a', path: LOC }, 'b'] }],
  ])('an item with %s is refused instead of skipped', (_name, json) => {
    expect(() => parseExternalResources(json)).toThrow(/无法识别/);
  });

  test('accepted shapes: known envelopes, a top-level array and a key map whose every value has a location', () => {
    expect(parseExternalResources({ defines: [] })).toEqual([]);
    expect(parseExternalResources([])).toEqual([]);
    expect(parseExternalResources([{ name: 'k', location: LOC }]).map((r) => r.key)).toEqual(['k']);
    expect(parseExternalResources({ k1: { path: LOC }, k2: { url: 'https://rules.example.test/x' } }).map((r) => r.key)).toEqual(['k1', 'k2']);
  });
});

describe('request and policy lists fail closed', () => {
  test('a request item without an id or that is not an object is refused', () => {
    expect(() => parseRequestRecords({ requests: [{ id: 1 }, { processPath: FAKE_SAFARI_PATH }] })).toThrow(/读取请求列表失败/);
    expect(() => parseRequestRecords({ requests: [{ id: 1 }, 'x'] })).toThrow(/无法识别/);
    expect(parseRequestRecords({ requests: [] })).toEqual([]);
  });

  test('a policy without a name, or a groups field that is not a list, is refused', () => {
    expect(() => parsePolicyNames({ proxies: ['A', { type: 'socks5' }], 'policy-groups': [] })).toThrow(/读取策略列表失败/);
    expect(() => parsePolicyNames({ proxies: ['A'], 'policy-groups': [{ name: 'G' }, 3] })).toThrow(/无法识别/);
    expect(() => parsePolicyNames({ proxies: ['A'], 'policy-groups': 'G' })).toThrow(/无法识别/);
    expect(parsePolicyNames({ proxies: ['A', { name: 'B' }], 'policy-groups': [{ name: 'G' }] })).toEqual({ proxies: ['A', 'B'], groups: ['G'] });
    expect(parsePolicyNames({ proxies: ['A'] })).toEqual({ proxies: ['A'], groups: [] });
  });
});

describe('temp_rule strategy over the real CLI mapping with an unrecognised item shape', () => {
  const CFG = { processPaths: [FAKE_SAFARI_PATH], verifyHost: FAKE_VERIFY_HOST, siteHosts: ['www.example.test'] };
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sfe-parse-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** 假 Surge 的状态 + 真实的 CLI 原语表与解析：dump temp-rule 返回未实测过的项格式 { ruleString }。 */
  async function setup(start: 'NORMAL' | 'ACTIVE') {
    createFakeSurgeEnvironment(dir, { entryStrategy: 'temp_rule' });
    const fake = new FakeSurge({ directory: dir, tempRuleInsertion: 'tail' });
    const node = 'SFE-N-E0001-US01-v001';
    writeFileSync(join(dir, 'sfe-nodes.list'), resourceFile(1, [nodeLine({ name: node, host: '203.0.113.10', port: 1080, username: null, password: null, front: 'Front-A' })]));
    await fake.updateExternalResource('policy-path:sfe-nodes.list');
    await fake.selectGroupPolicy('SFE-ROUTE', node);
    const ownership = createMemoryEntryOwnership();
    for (const bit of ENTRY_BITS_IN_ORDER) {
      if (!ENTRY_MODE_BITS[start][bit]) continue;
      const text = tempRuleText(bit, CFG);
      await fake.addTempRule(text);
      await ownership.confirm('temp_rule', text, 'present');
    }
    const exec: ExecFn = async (_file, args) => {
      expect(args).toEqual(CLI_COMMANDS.listTempRules!.argv());
      return { stdout: JSON.stringify({ rules: fake.tempRules.map((r) => ({ ruleString: r })) }), stderr: '' };
    };
    const cli = createCliAdapter({ cliPath: CLI, mechanism: { listTempRules: 'cli' }, exec, scrub: id });
    const adapter = new Proxy(fake, {
      get(target, prop, receiver) {
        if (prop === 'listTempRules') return () => cli.listTempRules();
        const v = Reflect.get(target, prop, receiver) as unknown;
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    }) as unknown as SurgeAdapter;
    const ctrl = createTempRuleStrategy({ adapter, ownership, config: () => CFG, operationId: () => 'op_test', insertion: 'tail' });
    return { fake, ownership, ctrl };
  }

  test('undoing ACTIVE to NORMAL fails closed: no rule is treated as gone and ownership is kept', async () => {
    const { fake, ownership, ctrl } = await setup('ACTIVE');
    const before = fake.tempRules;
    expect(before.length).toBeGreaterThan(0);
    await expect(ctrl.transition('NORMAL', undefined, { undo: true })).rejects.toMatchObject({ code: 'SURGE_COMMAND_FAILED' });
    await expect(ctrl.read()).rejects.toMatchObject({ code: 'SURGE_COMMAND_FAILED' });
    expect(fake.tempRules).toEqual(before);
    expect(fake.calls.removeTempRule ?? 0).toBe(0);
    expect((await ownership.getRecordedTempRules()).map((r) => r.state)).toEqual(before.map(() => 'present'));
  });

  test('NORMAL to BLOCKED: the readback is a read failure, never "rule gone" with NORMAL confirmed', async () => {
    const { fake, ownership, ctrl } = await setup('NORMAL');
    // 空列表 { rules: [] } 可以识别；写入后的读回含无法识别的项，必须报读取失败。
    const err = await ctrl.transition('BLOCKED').catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'SURGE_COMMAND_FAILED' });
    expect(err).not.toMatchObject({ details: { lastConfirmedBits: ENTRY_MODE_BITS.NORMAL } });
    await expect(ctrl.read()).rejects.toMatchObject({ code: 'SURGE_COMMAND_FAILED' });
    const block = tempRuleText('block', CFG);
    expect(fake.tempRules).toEqual([block]);
    // 本应用记录仍认领这条规则（不是 removed），之后可以由撤销入口删除。
    expect((await ownership.getRecordedTempRules()).map((r) => r.identity)).toEqual([block]);
  });
});
