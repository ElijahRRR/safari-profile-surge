// 回环测试资源的纯函数：内容类场景、发布前严格校验、资源 key 的遮盖与 CLI 安全判定、测试资源的识别、测试配置中 SFE-ROUTE 一行的
// 改写、lsof 与启动时间的解析、矩阵与重启结论、结果的通过条件记录与已删除能力的忽略。

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CAPABILITY_CRITERIA, EMPTY_PLACEHOLDER_LINE, LEGACY_NODE_GROUP_LINE, SfeError, type CapabilityContext } from '@sfe/contract';
import { describe, expect, it } from 'vitest';
import { MATRIX, rowVerdict } from '../src/commands/loopback.js';
import { REQUIRED, restartChecks, type RestartObservation } from '../src/commands/loopback-restart.js';
import { describeKeyForm, discoverIn, errorClass, expectedNames, validateGenerationLines } from '../src/commands/loopback-ops.js';
import { FAKE_REMOTE_ERRORS, resourceBody, resourceLocationHash, type SurgeAdapter, type SurgeExternalResource } from '../src/deps.js';
import { RESOURCE_SCENARIOS, emptyServed, presentsToken, readServed, scenarioBody, testResourceUrl, updateServed } from '../src/loopback-state.js';
import { readResult, readResultHistory, writeResult, check, isCurrentCapabilityKey } from '../src/results.js';
import { RunDir, newRunId } from '../src/run-dir.js';
import { parseLsofPeers } from '../src/servers/resource.js';
import { createGuardedAdapter, emptyGuard, maskResourceKey, resourcesForUrl, type CallLogEntry } from '../src/surge-access.js';
import { parseBootTime } from '../src/system.js';
import { TEST_NODES, profileCanaryIndexOf, replaceRouteLine, routeLineState } from '../src/test-profile.js';

const TOKEN = 'a'.repeat(64);
const URL = testResourceUrl(18084, TOKEN);
const A = `${TEST_NODES.a} = socks5, 127.0.0.1, 18081, username=p0-a, password=x1, underlying-proxy=P0-Front`;
const B = `${TEST_NODES.b} = socks5, 127.0.0.1, 18081, username=p0-b, password=x1, underlying-proxy=P0-Front`;
const C = `${TEST_NODES.c} = socks5, 127.0.0.1, 18081, username=p0-c, password=x1, underlying-proxy=P0-Front`;
const ABC = resourceBody(3, [A, B, C]);

describe('scenarioBody', () => {
  it('derives each content scenario from the served generation with synthetic data only', () => {
    expect(scenarioBody('empty200', ABC)).toBe('');
    expect(scenarioBody('onlyBad', ABC)).not.toMatch(/SFE-N-P0-[ABC] =/);
    const bad = scenarioBody('validAbBadC', ABC);
    expect(bad).toContain(A);
    expect(bad).toContain(B);
    expect(bad).toContain(`${TEST_NODES.c} = socks5, 127.0.0.1\n`);
    const dup = scenarioBody('dupC', ABC).split('\n').filter((l) => l.startsWith(TEST_NODES.c));
    expect(dup).toEqual([C, C.replace('username=p0-c', 'username=p0-c-dup')]);
    expect(scenarioBody('paramReplaceC', ABC)).toContain(C.replace('underlying-proxy=P0-Front', 'underlying-proxy=P0-Front-Dead'));
    expect(scenarioBody('removeC', ABC)).not.toContain(TEST_NODES.c);
    expect(scenarioBody('placeholderOnly', ABC).split('\n').filter(Boolean)).toEqual(['# SFE managed resource · generation 3', EMPTY_PLACEHOLDER_LINE]);
    // 非内容场景原样返回
    expect(scenarioBody('ok', ABC)).toBe(ABC);
  });

  it('has a closed scenario set and the matrix covers every scenario plus the header-only content', () => {
    expect(new Set(MATRIX.map((r) => r.id))).toEqual(new Set([...RESOURCE_SCENARIOS, 'headerOnly']));
  });
});

describe('validateGenerationLines (pre-publication strict validation)', () => {
  it('accepts the test nodes and the empty generation', () => {
    expect(validateGenerationLines([A, B, C])).toEqual([]);
    expect(validateGenerationLines([])).toEqual([]);
  });

  it.each([
    ['duplicate name differing only in the username (dupC)', [A, C, C.replace('p0-c', 'p0-c-dup')]],
    ['case-insensitive duplicate', [A, A.replace(TEST_NODES.a, TEST_NODES.a.toLowerCase())]],
    ['reserved name', ['REJECT = socks5, 127.0.0.1, 1, underlying-proxy=P0-Front']],
    ['placeholder name', ['SFE-EMPTY = socks5, 127.0.0.1, 1, underlying-proxy=P0-Front']],
    ['missing front', [`${TEST_NODES.c} = socks5, 127.0.0.1, 18081, username=p0-c, password=x1`]],
    ['missing port', [`${TEST_NODES.c} = socks5, 127.0.0.1`]],
    ['unparseable', ['not a proxy line']],
    ['section header', ['[Proxy]']],
  ])('refuses %s', (_name, lines) => {
    expect(validateGenerationLines(lines).length).toBeGreaterThan(0);
  });
});

describe('resource key masking and form', () => {
  it('masks a key that contains or is a piece of the token, loopback URL paths and 64-hex runs; keeps opaque keys', () => {
    expect(maskResourceKey(`policy-path:${URL}`, [TOKEN])).toBe('<resource-key:masked>');
    expect(maskResourceKey(TOKEN.slice(0, 32), [TOKEN])).toBe('<resource-key:masked>');
    expect(maskResourceKey(`policy-path:${URL}`)).toBe('policy-path:http://127.0.0.1:18084/***');
    expect(maskResourceKey(`k-${'b'.repeat(64)}`)).toBe('k-<token>');
    expect(maskResourceKey('0123456789abcdef0123456789abcdef', [TOKEN])).toBe('0123456789abcdef0123456789abcdef');
  });

  it('describes the key form with the product CLI guard', () => {
    expect(describeKeyForm('0123456789abcdef0123456789abcdef', TOKEN)).toMatchObject({ hex32: true, cliSafe: true, containsToken: false });
    expect(describeKeyForm(`policy-path:${URL}`, TOKEN)).toMatchObject({ hex32: false, hasColon: true, hasSlash: true, containsToken: true, cliSafe: false });
  });

  it('the guarded adapter records a masked key for updateExternalResource', async () => {
    const calls: CallLogEntry[] = [];
    const guard = emptyGuard();
    guard.onTestProfile = true;
    guard.secrets.add(TOKEN);
    const key = `policy-path:${URL}`;
    guard.refreshableKeys.add(key);
    const inner = { mechanism: () => ({}), updateExternalResource: async () => ({ key, refreshed: true, outcome: 'downloaded' }) } as unknown as SurgeAdapter;
    const adapter = createGuardedAdapter(inner, guard, (e) => calls.push(e));
    await adapter.updateExternalResource(key);
    await expect(adapter.updateExternalResource(`${key}x`)).rejects.toBeInstanceOf(SfeError);
    expect(JSON.stringify(calls)).not.toContain(TOKEN);
    expect(calls.map((c) => c.args[0])).toEqual(['<resource-key:masked>', '<resource-key:masked>']);
  });
});

describe('test resource discovery', () => {
  const res = (over: Partial<SurgeExternalResource>): SurgeExternalResource => ({
    key: '0123456789abcdef0123456789abcdef',
    type: 'policy-group',
    location: 'http://127.0.0.1:18084/***',
    locationHash: resourceLocationHash(URL),
    lastUpdatedAt: null,
    error: null,
    local: false,
    updating: false,
    fromModule: null,
    ...over,
  });

  it('finds exactly one remote policy-group from the profile by the location hash', () => {
    expect(resourcesForUrl([res({}), res({ locationHash: 'x' })], URL)).toHaveLength(1);
    expect(discoverIn([res({})], URL).kind).toBe('found');
    expect(discoverIn([], URL).kind).toBe('missing');
    expect(discoverIn([res({}), res({ key: 'k2' })], URL)).toEqual({ kind: 'ambiguous', count: 2 });
    expect(discoverIn([res({ local: true })], URL).kind).toBe('unexpected');
    expect(discoverIn([res({ fromModule: 'M' })], URL).kind).toBe('unexpected');
    expect(discoverIn([res({ type: 'ruleset' })], URL).kind).toBe('unexpected');
    expect(discoverIn(null, URL).kind).toBe('unreadable');
  });

  it('classifies Surge resource errors without echoing them', () => {
    expect(errorClass(FAKE_REMOTE_ERRORS.refused)).toBe('无法连接（-1004）');
    expect(errorClass(FAKE_REMOTE_ERRORS.timeout)).toBe('超时（-1001）');
    expect(errorClass(FAKE_REMOTE_ERRORS.interrupted)).toBe('连接中断（-1005）');
    expect(errorClass(FAKE_REMOTE_ERRORS.status(503))).toBe('HTTP 503');
    expect(errorClass(FAKE_REMOTE_ERRORS.empty)).toBe('空内容');
    expect(errorClass(FAKE_REMOTE_ERRORS.parse)).toBe('无法解析');
    expect(errorClass(null)).toBe('无错误');
  });

  it('expected members in subset mode allow skipped nodes but never extra ones', () => {
    const served = [TEST_NODES.a, TEST_NODES.b, TEST_NODES.dead, TEST_NODES.missing];
    expect(expectedNames(served, [TEST_NODES.a, TEST_NODES.b, TEST_NODES.dead], ['REJECT', TEST_NODES.a, TEST_NODES.b, TEST_NODES.dead])).toEqual([TEST_NODES.a, TEST_NODES.b, TEST_NODES.dead]);
    expect(expectedNames(served, [TEST_NODES.a, TEST_NODES.dead], ['REJECT', TEST_NODES.a])).toEqual(served);
    expect(expectedNames(served, [TEST_NODES.a], ['REJECT', TEST_NODES.a, 'OTHER'])).toEqual(served);
    expect(expectedNames(served, undefined, ['REJECT', TEST_NODES.a])).toEqual(served);
  });
});

describe('test profile SFE-ROUTE line', () => {
  const profile = ['[Proxy Group]', 'Daily = select, DIRECT', '# SFE-BEGIN group v1', LEGACY_NODE_GROUP_LINE, '# SFE-END group', '', '[Rule]', 'DOMAIN,p7.pcanary.p0.example.test,P0-Canary', 'FINAL,DIRECT', ''].join('\n');

  it('rewrites only the managed SFE-ROUTE line and recognises both forms', () => {
    expect(routeLineState(profile)).toEqual({ kind: 'legacy' });
    const line = `SFE-ROUTE = select, REJECT, policy-path=${URL}`;
    const next = replaceRouteLine(profile, line);
    expect(next).toBe(profile.replace(LEGACY_NODE_GROUP_LINE, line));
    expect(routeLineState(next)).toEqual({ kind: 'loopback', url: URL });
    expect(routeLineState(next.replace('select, REJECT', 'select, DIRECT')).kind).toBe('other');
    expect(replaceRouteLine(next, LEGACY_NODE_GROUP_LINE)).toBe(profile);
    expect(profileCanaryIndexOf(profile)).toBe(7);
  });

  it('refuses when the managed block or a unique SFE-ROUTE line is missing', () => {
    expect(() => routeLineState(profile.replace('# SFE-END group', ''))).toThrow();
    expect(() => replaceRouteLine(profile.replace(LEGACY_NODE_GROUP_LINE, `${LEGACY_NODE_GROUP_LINE}\n${LEGACY_NODE_GROUP_LINE}`), 'x')).toThrow();
  });
});

describe('served state file, tokens and parsers', () => {
  const dir = (): RunDir => RunDir.create(join(mkdtempSync(join(tmpdir(), 'sfe-p0-u-')), 'p0'), newRunId(new Date()));

  it('bumps the revision and never reuses a generation for two contents', () => {
    const d = dir();
    expect(readServed(d)).toBeNull();
    const a = updateServed(d, new Date(), 't', () => ({ committed: { generation: 1, content: 'x' } }));
    expect(a).toMatchObject({ revision: 1, lastGeneration: 1 });
    const b = updateServed(d, new Date(), 't', () => ({ committed: null }));
    expect(b.lastGeneration).toBe(1);
    expect(() => updateServed(d, new Date(), 't', () => ({ committed: { generation: 2, content: 'x' }, candidate: { generation: 2, content: 'y' } }))).toThrow(/代数相同/);
    d.writeJson('resource-served.json', { ...emptyServed(new Date()), scenario: 'whatever' });
    expect(() => readServed(d)).toThrow(/结构不正确/);
  });

  it('checks the token in constant time on the exact path only', () => {
    expect(presentsToken(`/${TOKEN}/sfe-nodes.list`, TOKEN)).toBe(true);
    expect(presentsToken(`/${'b'.repeat(64)}/sfe-nodes.list`, TOKEN)).toBe(false);
    expect(presentsToken(`/${TOKEN}/sfe-nodes.list?x`, TOKEN)).toBe(false);
  });

  it('parses lsof peers and the boot time', () => {
    const text = ['p100', 'cnode', 'n127.0.0.1:18084->127.0.0.1:50000', 'p200', 'cSurge', 'n127.0.0.1:50000->127.0.0.1:18084', 'p300', 'cother', 'n127.0.0.1:50001->127.0.0.1:9999'].join('\n');
    expect(parseLsofPeers(text, 18084, 100)).toEqual([{ pid: 200, command: 'Surge', path: null }]);
    expect(parseBootTime('{ sec = 1761900000, usec = 12 } Fri Oct 31 08:00:00 2026')).toBe(1761900000);
    expect(parseBootTime('garbage')).toBeNull();
  });
});

describe('matrix and restart verdicts', () => {
  const snap = (over: Partial<import('../src/deps.js').ResourceSnapshot> = {}) => ({
    key: 'k',
    locationHash: resourceLocationHash(URL),
    updatedAt: new Date(1000),
    error: null as string | null,
    updating: false,
    members: ['REJECT', TEST_NODES.a, TEST_NODES.b, TEST_NODES.c] as readonly string[] | null,
    selection: TEST_NODES.c as string | null,
    ...over,
  });
  const run = (after: ReturnType<typeof snap>, failed: string[] = []) => ({
    update: { ok: true, ms: 1, code: null, result: null, reason: null },
    stillUpdating: false,
    before: snap(),
    after,
    afterRepeat: after,
    assessment: { ok: failed.length === 0, level: 'full' as const, failed },
    requests: 1,
  });

  it('a failed download must keep the old resource and the old node working', () => {
    const before = snap();
    expect(rowVerdict({ expect: 'kept', before, run: run(snap({ error: FAKE_REMOTE_ERRORS.status(503) })), chainVia: 'p0-c', detailMapped: true, dupRefused: false }).ok).toBe(true);
    expect(rowVerdict({ expect: 'kept', before, run: run(snap({ error: FAKE_REMOTE_ERRORS.status(503), members: ['REJECT'] })), chainVia: 'p0-c', detailMapped: true, dupRefused: false }).ok).toBe(false);
    expect(rowVerdict({ expect: 'kept', before, run: run(snap({ error: FAKE_REMOTE_ERRORS.status(503) })), chainVia: null, detailMapped: true, dupRefused: false }).ok).toBeNull();
    // 错误为空的“保留”不是保留（Surge 接受了失败的内容）
    expect(rowVerdict({ expect: 'kept', before, run: run(snap()), chainVia: 'p0-c', detailMapped: true, dupRefused: false }).ok).toBe(false);
  });

  it('a seemingly successful update must be caught by the readback; dupC only by pre-validation; a still-updating Surge is never decided', () => {
    const before = snap();
    expect(rowVerdict({ expect: 'dropC', before, run: run(snap({ members: ['REJECT', TEST_NODES.a, TEST_NODES.b], selection: 'REJECT' }), ['members', 'selection']), chainVia: null, detailMapped: true, dupRefused: false }).ok).toBe(true);
    expect(rowVerdict({ expect: 'dropC', before, run: run(snap(), []), chainVia: null, detailMapped: true, dupRefused: false }).ok).toBe(false);
    expect(rowVerdict({ expect: 'paramC', before, run: run(snap(), ['detail:SFE-N-P0-C']), chainVia: null, detailMapped: true, dupRefused: false }).ok).toBe(true);
    expect(rowVerdict({ expect: 'paramC', before, run: run(snap(), []), chainVia: null, detailMapped: false, dupRefused: false }).ok).toBeNull();
    expect(rowVerdict({ expect: 'dupC', before, run: run(snap()), chainVia: null, detailMapped: true, dupRefused: true }).ok).toBe(true);
    expect(rowVerdict({ expect: 'placeholder', before, run: run(snap({ members: ['REJECT', 'SFE-EMPTY'] })), chainVia: null, detailMapped: true, dupRefused: false }).ok).toBe(true);
    expect(rowVerdict({ expect: 'ok', before, run: { ...run(snap()), stillUpdating: true, after: null }, chainVia: null, detailMapped: true, dupRefused: false }).ok).toBeNull();
  });

  it('restart passes only with every required variant recorded, recovered and nothing uncommitted loaded', () => {
    const obs = (kind: 'surge' | 'mac', variant: RestartObservation['variant'], over: Partial<RestartObservation> = {}): RestartObservation => ({
      kind,
      variant,
      at: '',
      restarted: true,
      members: ['REJECT'],
      selection: 'REJECT',
      error: '无错误',
      updatedAtChanged: false,
      updating: false,
      downloads: { count: 0, generations: [], statuses: [] },
      fetchedAfterServerStart: null,
      loadedUncommitted: false,
      recovered: true,
      note: '',
      ...over,
    });
    const all = REQUIRED.map((r) => obs(r.kind, r.variants[0]!));
    expect(restartChecks(all).every((c) => c.ok === true)).toBe(true);
    expect(restartChecks(all.slice(1)).some((c) => c.ok === null)).toBe(true);
    expect(restartChecks([...all, obs('surge', 'candidate', { loadedUncommitted: true })]).some((c) => c.ok === false)).toBe(true);
    expect(restartChecks([...all.slice(0, -1), obs('mac', '503', { recovered: false })]).some((c) => c.ok === false)).toBe(true);
  });
});

describe('capability results record their criteria; removed keys are ignored', () => {
  const ctx = {} as CapabilityContext;
  it('writeResult stores the current criteria text and readResult ignores removed keys', () => {
    const d = RunDir.create(join(mkdtempSync(join(tmpdir(), 'sfe-p0-r-')), 'p0'), newRunId(new Date()));
    const r = writeResult(d, { key: 'loopback_resource_update', command: 'loopback', at: '2026-10-31T00:00:00.000Z', checks: [check('x', true)], summary: [], context: ctx });
    expect(r.criteria).toBe(CAPABILITY_CRITERIA.loopback_resource_update);
    expect(readResult(d, 'loopback_resource_update')?.criteria).toBe(CAPABILITY_CRITERIA.loopback_resource_update);
    // 已删除的能力（D10）：旧运行目录中的结果文件不再被读取
    d.writeJson('results/policy_path_reread.json', { ...r, key: 'policy_path_reread' });
    d.writeJson('results/history/policy_path_reread-1.json', { ...r, key: 'policy_path_reread' });
    expect(isCurrentCapabilityKey('policy_path_reread')).toBe(false);
    expect(readResult(d, 'policy_path_reread' as never)).toBeNull();
    expect(readResultHistory(d, 'policy_path_reread' as never)).toEqual([]);
  });
});
