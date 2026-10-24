// --raw 输出解析的失败即关闭：未知的外层结构与无法识别的项一律报错，从不静默跳过或按行拆分人类可读输出。
// 合成数据；dump temp-rule / dump rule 的 --raw 项格式没有写入文档，尚未在 Surge Mac 6.10 上实测（P0 用 entry --probe-insertion 正向确认）。

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { ENTRY_MODE_BITS } from '@sfe/contract';
import type { SurgeAdapter } from '../../src/ports.js';
import { createCliAdapter, type ExecFn } from '../../src/surge/cli-adapter.js';
import { cliArgvs } from '../../src/surge/cli-commands.js';
import { FAKE_SAFARI_PATH, FAKE_VERIFY_HOST, FakeSurge, createFakeSurgeEnvironment } from '../../src/surge/fake.js';
import { ENTRY_BITS_IN_ORDER, nodeLine, resourceFile, tempRuleText } from '../../src/surge/generate.js';
import { createMemoryEntryOwnership } from '../../src/surge/entry/ownership.js';
import { createTempRuleStrategy } from '../../src/surge/entry/temp-rule-strategy.js';
import {
  NO_REMOTE_RESOURCE_UPDATED_TEXT,
  parseExternalResources,
  parseFeatureEnabled,
  parseMetricsUptime,
  parseOutboundMode,
  parsePolicyNames,
  parseRequestRecords,
  parseResourceUpdateMap,
  parseResourceUpdateText,
  parseRuleList,
  parseStatusProfile,
  parseSurgeVersion,
  parseTempRuleList,
} from '../../src/surge/parse-output.js';

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
      { key: 'k', type: 'ruleset', location: LOC, lastUpdatedAt: null, error: 'not_ready', local: true, updating: null, fromModule: null },
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

  test('Mac 6.10 fields: local, updating and fromModule are kept; a local resource never carries an update time; 0 means never downloaded', () => {
    // 文档的响应示例：{"path", "type": "ruleset", "key", "local": false, "ready": true, "updatedAt": 1759800000, "updating": false, "fromModule": null}
    expect(parseExternalResources({ defines: [{ path: 'https://rules.example.test/a.list', type: 'ruleset', key: 'r', local: false, ready: true, updatedAt: 1759800000, updating: false, fromModule: null }] })).toEqual([
      { key: 'r', type: 'ruleset', location: 'https://rules.example.test/a.list', lastUpdatedAt: new Date(1759800000 * 1000), error: null, local: false, updating: false, fromModule: null },
    ]);
    const local = parseExternalResources({ defines: [{ path: LOC, type: 'ruleset', key: 'l', local: true, ready: true, updatedAt: 1759800000, updating: true, fromModule: 'Mod' }] })[0]!;
    expect(local).toMatchObject({ lastUpdatedAt: null, local: true, updating: true, fromModule: 'Mod' });
    expect(parseExternalResources({ defines: [{ path: 'https://rules.example.test/a.list', key: 'r', local: false, updatedAt: 0 }] })[0]!.lastUpdatedAt).toBeNull();
  });

  test.each([
    ['local that is not a boolean', { local: 'yes' }],
    ['updating that is not a boolean', { updating: 1 }],
    ['fromModule that is not a string or null', { fromModule: { name: 'M' } }],
  ])('a resource with %s is refused', (_name, extra) => {
    expect(() => parseExternalResources({ defines: [{ key: 'k', path: LOC, ...extra }] })).toThrow(/无法识别/);
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
    // 节点文件在构造前写好：假 Surge 加载配置时读入（本地 policy-path 不经 updateExternalResource 刷新）。
    const node = 'SFE-N-E0001-US01-v001';
    writeFileSync(join(dir, 'sfe-nodes.list'), resourceFile(1, [nodeLine({ name: node, host: '203.0.113.10', port: 1080, username: null, password: null, front: 'Front-A' })]));
    const fake = new FakeSurge({ directory: dir, tempRuleInsertion: 'tail' });
    await fake.selectGroupPolicy('SFE-ROUTE', node);
    const ownership = createMemoryEntryOwnership();
    for (const bit of ENTRY_BITS_IN_ORDER) {
      if (!ENTRY_MODE_BITS[start][bit]) continue;
      const text = tempRuleText(bit, CFG);
      await fake.addTempRule(text);
      await ownership.confirm('temp_rule', text, 'present');
    }
    const exec: ExecFn = async (_file, args) => {
      expect([args]).toEqual(cliArgvs('listTempRules', []));
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

describe('Surge Mac 6.10 read parsers fail closed', () => {
  test('version: exactly four fields; system and device fields are never returned', () => {
    const raw = { version: '6.10.0', build: '12500', 'core-version': 6100, 'controller-protocol': 24, 'system-version': '26.0', 'device-name': 'Example Mac', 'device-identifier': 'X' };
    expect(parseSurgeVersion(raw)).toEqual({ version: '6.10.0', build: '12500', coreVersion: 6100, controllerProtocol: 24 });
    for (const bad of [null, [], { ...raw, 'controller-protocol': 2.5 }, { ...raw, 'controller-protocol': -1 }, { ...raw, 'core-version': 'x' }, { ...raw, build: '12500 (beta)' }, { ...raw, version: 6.1 }]) {
      expect(() => parseSurgeVersion(bad), JSON.stringify(bad)).toThrow(/读取Surge 版本失败/);
    }
  });

  test('status: profile name and absolute profile-path', () => {
    expect(parseStatusProfile({ profile: 'P', 'profile-path': '/a/P.conf' })).toEqual({ name: 'P', path: '/a/P.conf' });
    expect(parseStatusProfile({ profile: 'P', 'profile-path': null })).toEqual({ name: 'P', path: null });
    expect(() => parseStatusProfile({ name: 'P' })).toThrow(/读取当前配置失败/);
  });

  test('feature and mode reads', () => {
    expect(parseFeatureEnabled({ enabled: false }, 'system-proxy')).toBe(false);
    expect(() => parseFeatureEnabled({ enabled: 'on' }, 'system-proxy')).toThrow(/无法识别/);
    expect(() => parseFeatureEnabled({ feature: 'enhanced-mode', enabled: true }, 'system-proxy')).toThrow(/无法识别/);
    expect(parseOutboundMode({ mode: 'Rule' })).toBe('rule');
    expect(parseOutboundMode({ mode: 'other' })).toBeNull();
    expect(() => parseOutboundMode({ outbound: 'rule' })).toThrow(/无法识别/);
  });

  test('metrics uptime: one numeric surge_uptime_seconds line', () => {
    expect(parseMetricsUptime('surge_uptime_seconds 12.5\n')).toBe(12.5);
    expect(parseMetricsUptime('surge_uptime_seconds{instance="a"} 7')).toBe(7);
    expect(() => parseMetricsUptime('surge_uptime_seconds NaN')).toThrow(/无法识别/);
    expect(() => parseMetricsUptime('surge_uptime_seconds 1\nsurge_uptime_seconds 2')).toThrow(/无法识别/);
    expect(() => parseMetricsUptime('surge_memory_bytes 1')).toThrow(/无法识别/);
  });

  test('update results: only "<key>: success" is a refresh; the 6.10 "nothing updated" text and an empty HTTP map are skips', () => {
    expect(parseResourceUpdateText(`k: success`, 'k', id)).toEqual({ key: 'k', refreshed: true, outcome: 'downloaded' });
    expect(parseResourceUpdateText(`\n${NO_REMOTE_RESOURCE_UPDATED_TEXT}\n`, 'k', id)).toEqual({ key: 'k', refreshed: false, outcome: 'skipped' });
    expect(() => parseResourceUpdateText('k: timed out', 'k', id)).toThrow(/更新外部资源失败：timed out/);
    expect(() => parseResourceUpdateText('k: Success', 'k', id)).toThrow(/更新外部资源失败/);
    expect(parseResourceUpdateMap({}, 'k', id)).toEqual({ key: 'k', refreshed: false, outcome: 'skipped' });
    expect(parseResourceUpdateMap({ k: 'success' }, 'k', id)).toEqual({ key: 'k', refreshed: true, outcome: 'downloaded' });
    expect(() => parseResourceUpdateMap({ k: true }, 'k', id)).toThrow(/无法识别/);
    expect(() => parseResourceUpdateMap({ k: 'success', other: 'success' }, 'k', id)).toThrow(/无法识别/);
    expect(() => parseResourceUpdateMap('success', 'k', id)).toThrow(/无法识别/);
  });
});
