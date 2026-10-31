// 回环测试资源的纯函数：内容类场景、发布前严格校验、资源 key 的遮盖与 CLI 安全判定、测试资源的识别、测试配置中 SFE-ROUTE 一行的
// 改写、lsof 与启动时间的解析、矩阵与重启结论、结果的通过条件记录与已删除能力的忽略。

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CAPABILITY_CRITERIA, EMPTY_PLACEHOLDER_LINE, LEGACY_NODE_GROUP_LINE, SfeError, type CapabilityContext } from '@sfe/contract';
import { describe, expect, it } from 'vitest';
import { MATRIX, rowVerdict } from '../src/commands/loopback.js';
import { SQUAT_EXPECTED_VERDICT, parseLsofNames, parseUid, squatChecks, type SquatObservation, type SquatPhase } from '../src/commands/loopback-auth.js';
import { REQUIRED, changedContextFields, checkRestartVariant, classifyEmptyCache, restartChecks, restartComparability, type RestartObservation } from '../src/commands/loopback-restart.js';
import { buildContext } from '../src/context.js';
import { describeKeyForm, discoverIn, errorClass, expectedNames, validateGenerationLines } from '../src/commands/loopback-ops.js';
import { FAKE_REMOTE_ERRORS, resourceBody, resourceLocationHash, type SurgeAdapter, type SurgeExternalResource } from '../src/deps.js';
import { RESOURCE_SCENARIOS, emptyServed, paramReplacedC, presentsToken, readServed, scenarioBody, testResourceUrl, updateServed } from '../src/loopback-state.js';
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
    // 同名参数替换：服务器、端口与前置三项同时变化（其余参数不变）
    expect(scenarioBody('paramReplaceC', ABC)).toContain(`${TEST_NODES.c} = socks5, 192.0.2.33, 9, username=p0-c, password=x1, underlying-proxy=P0-Front-Dead`);
    expect(scenarioBody('paramReplaceC', ABC)).toContain(A);
    expect(paramReplacedC(ABC)).toEqual({ server: '192.0.2.33', port: 9, underlyingProxy: 'P0-Front-Dead' });
    const already = resourceBody(4, [C.replace('127.0.0.1, 18081', '192.0.2.33, 9')]);
    expect(paramReplacedC(already)).toEqual({ server: '192.0.2.34', port: 10, underlyingProxy: 'P0-Front-Dead' });
    expect(paramReplacedC(resourceBody(5, [A]))).toBeNull();
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
    const servedC = { server: '192.0.2.33', port: 9, underlyingProxy: 'P0-Front-Dead' };
    expect(rowVerdict({ expect: 'paramC', before, run: run(snap(), ['detail:SFE-N-P0-C']), chainVia: null, detailMapped: true, dupRefused: false, detailC: servedC, servedC }).ok).toBe(true);
    expect(rowVerdict({ expect: 'paramC', before, run: run(snap(), []), chainVia: null, detailMapped: false, dupRefused: false }).ok).toBeNull();
    expect(rowVerdict({ expect: 'paramC', before, run: run(snap(), []), chainVia: null, detailMapped: true, dupRefused: false, detailC: servedC, servedC }).ok).toBe(false);
    // 回归：只有前置是新读的、服务器或端口仍是旧值（按名称取了旧来源）：不算由读回证明
    expect(rowVerdict({ expect: 'paramC', before, run: run(snap(), ['detail:SFE-N-P0-C']), chainVia: null, detailMapped: true, dupRefused: false, detailC: { ...servedC, port: 18081 }, servedC }).ok).toBe(false);
    expect(rowVerdict({ expect: 'paramC', before, run: run(snap(), ['detail:SFE-N-P0-C']), chainVia: null, detailMapped: true, dupRefused: false, detailC: { ...servedC, server: '127.0.0.1' }, servedC }).ok).toBe(false);
    expect(rowVerdict({ expect: 'paramC', before, run: run(snap(), ['detail:SFE-N-P0-C']), chainVia: null, detailMapped: true, dupRefused: false, detailC: null, servedC }).ok).toBeNull();
    expect(rowVerdict({ expect: 'dupC', before, run: run(snap()), chainVia: null, detailMapped: true, dupRefused: true }).ok).toBe(true);
    expect(rowVerdict({ expect: 'placeholder', before, run: run(snap({ members: ['REJECT', 'SFE-EMPTY'] })), chainVia: null, detailMapped: true, dupRefused: false }).ok).toBe(true);
    expect(rowVerdict({ expect: 'ok', before, run: { ...run(snap()), stillUpdating: true, after: null }, chainVia: null, detailMapped: true, dupRefused: false }).ok).toBeNull();
  });
});

describe('restart verdicts', () => {
  const ctxOf = (over: Partial<{ version: string; build: string; macosBuild: string }> = {}): CapabilityContext =>
    buildContext({
      surgeVersion: { version: over.version ?? '6.10.0', build: over.build ?? '12500' },
      macosBuild: over.macosBuild ?? '25A100',
      macosVersionExtra: null,
      macosRestartPending: 'no',
      safariVersion: '26.0',
      entryStrategy: null,
      processPaths: [],
      autoReloadSetting: false,
      takeover: null,
      signingIdentity: null,
      mechanism: null,
    });
  const CURRENT = ctxOf();
  const obs = (kind: 'surge' | 'mac', variant: RestartObservation['variant'], over: Partial<RestartObservation> = {}): RestartObservation => ({
    kind,
    variant,
    at: '2026-10-31T00:00:00.000Z',
    restarted: true,
    restartEvidence: kind === 'mac' ? 'boot_time' : 'process_start',
    context: CURRENT,
    contextChanged: [],
    variantCheck: { ok: true, note: '' },
    members: ['REJECT'],
    selection: 'REJECT',
    error: '无错误',
    updatedAtChanged: false,
    updating: false,
    downloads: { count: 0, generations: [], statuses: [] },
    fetchedAfterServerStart: null,
    loadedUncommitted: false,
    emptyCache: 'cached',
    recovered: true,
    note: '',
    ...over,
  });
  const all = REQUIRED.map((r) => obs(r.kind, r.variants[0]!));
  const uncommittedCheck = (checks: ReturnType<typeof restartChecks>) => checks.find((c) => c.name.startsWith('任何情况下都不会载入'))!;

  it('passes only with every required variant recorded, recovered and nothing uncommitted loaded', () => {
    expect(restartChecks(all, CURRENT).every((c) => c.ok === true)).toBe(true);
    expect(restartChecks(all.slice(1), CURRENT).some((c) => c.ok === null)).toBe(true);
    expect(restartChecks([...all, obs('surge', 'candidate', { loadedUncommitted: true })], CURRENT).some((c) => c.ok === false)).toBe(true);
    expect(restartChecks([...all.slice(0, -1), obs('mac', '503', { recovered: false })], CURRENT).some((c) => c.ok === false)).toBe(true);
  });

  it('regression: observations from another Surge or macOS version (or spanning an update) are not counted and show as needing a re-test', () => {
    // 前几轮在 Surge 12500 上测，最后一轮之前 Surge 自动更新到 12600：现在的上下文下，旧的观察都不计入
    const upgraded = ctxOf({ version: '6.10.1', build: '12600' });
    const checks = restartChecks(all, upgraded);
    expect(checks.filter((c) => c.name.includes('：成员、选择')).every((c) => c.ok === null)).toBe(true);
    expect(checks[0]!.note).toContain('需重测');
    expect(uncommittedCheck(checks).ok).toBeNull();
    // 跨了一次 macOS 更新的观察（准备在构建 A，观察在构建 B）不计入，即使它的上下文与当前一致
    const spanning = [...all.slice(0, -1), obs('mac', '503', { contextChanged: ['macosBuild'] })];
    const c2 = restartChecks(spanning, CURRENT);
    expect(c2.find((c) => c.name.startsWith('Mac 重启 · 服务只返回 503'))!.ok).toBeNull();
    expect(c2.find((c) => c.name.startsWith('Mac 重启 · 服务只返回 503'))!.note).toContain('重启前后上下文不同');
    // 没有记录上下文的旧观察不计入
    expect(restartComparability(obs('surge', 'down', { context: undefined }), CURRENT).counted).toBe(false);
    // 读不到 Surge 版本的观察永远不计入（依赖版本的能力不能提议）
    const unreadable = { ...CURRENT, surgeVersion: null, surgeBuild: null };
    expect(restartComparability(obs('surge', 'down', { context: unreadable }), unreadable).counted).toBe(false);
    expect(changedContextFields(CURRENT, upgraded)).toEqual(['surgeVersion', 'surgeBuild']);
    expect(changedContextFields(CURRENT, { ...CURRENT, safariVersion: '27.0' })).toEqual([]);
  });

  it('a loaded uncommitted version fails even when that observation is not counted', () => {
    const checks = restartChecks([...all, obs('surge', 'candidate', { loadedUncommitted: true, contextChanged: ['surgeBuild'] })], CURRENT);
    expect(uncommittedCheck(checks).ok).toBe(false);
    expect(uncommittedCheck(checks).note).toContain('不计入的观察');
  });

  it('regression: names the staged candidate only when a Surge-restart candidate observation was counted', () => {
    const without = uncommittedCheck(restartChecks(all, CURRENT));
    expect(without.ok).toBe(true);
    expect(without.name).toBe('任何情况下都不会载入本服务未提交的版本');
    expect(without.note).toContain('已暂存候选（可选）未测');
    // Mac 重启的 candidate 不算（重启后服务只提供已提交版本）
    expect(uncommittedCheck(restartChecks([...all, obs('mac', 'candidate')], CURRENT)).name).not.toContain('已暂存候选');
    const withCandidate = uncommittedCheck(restartChecks([...all, obs('surge', 'candidate')], CURRENT));
    expect(withCandidate.name).toBe('任何情况下都不会载入本服务未提交的版本（含已暂存候选）');
    expect(withCandidate.note).not.toContain('未测');
  });

  it('regression: operator-confirmed restarts and unverifiable start orders are labelled; a mismatching Mac variant is not counted', () => {
    const checks = restartChecks([...all.slice(0, 4), obs('mac', 'server-after', { restartEvidence: 'operator', variantCheck: { ok: null, note: '读不到 Surge 的启动时间，先后无法核对' } }), ...all.slice(5)], CURRENT);
    const mac = checks.find((c) => c.name.startsWith('Mac 重启 · 服务先于或晚于'))!;
    expect(mac.ok).toBe(true);
    expect(mac.note).toContain('重启由操作员确认');
    expect(mac.note).toContain('变体由操作员陈述');
    const mismatched = restartChecks([...all.slice(0, 5), obs('mac', 'down', { variantCheck: { ok: false, note: '重启后测试资源服务在运行（变体要求不运行）' } }), all[6]!], CURRENT);
    const down = mismatched.find((c) => c.name.startsWith('Mac 重启 · 服务不可用'))!;
    expect(down.ok).toBeNull();
    expect(down.note).toContain('变体与实际不符');
  });

  it('checks Mac variants against the run directory', () => {
    const surge = 1_800_000_000_000;
    const f = (variant: RestartObservation['variant'], over: Partial<Parameters<typeof checkRestartVariant>[0]> = {}) => checkRestartVariant({ kind: 'mac', variant, statuses: [], server: null, surgeStartedAt: surge, ...over }).ok;
    expect(checkRestartVariant({ kind: 'surge', variant: 'down', statuses: [200], server: { startedAt: 0, scenario: 'ok' }, surgeStartedAt: null }).ok).toBe(true);
    expect(f('down')).toBe(true);
    expect(f('down', { statuses: [200] })).toBe(false);
    expect(f('down', { server: { startedAt: surge + 5000, scenario: 'ok' } })).toBe(false);
    expect(f('503', { server: { startedAt: surge, scenario: 'restartUninitialized' } })).toBe(true);
    expect(f('503', { statuses: [503, 503], server: { startedAt: surge, scenario: 'restartUninitialized' } })).toBe(true);
    // 回归：只有 503 的请求而服务没有在运行（例如重启之前收到的 503、重启之后忘了启动服务）不算 503 变体
    expect(f('503', { statuses: [503, 503] })).toBe(false);
    expect(f('503', { statuses: [503], server: { startedAt: surge, scenario: 'ok' } })).toBe(false);
    // 读不到系统启动时间：重启前后的请求无法区分
    expect(f('503', { statuses: null, server: { startedAt: surge, scenario: 'restartUninitialized' } })).toBeNull();
    expect(f('down', { statuses: null })).toBeNull();
    expect(f('down', { statuses: null, server: { startedAt: surge, scenario: 'ok' } })).toBe(false);
    expect(f('503', { statuses: [503, 200], server: { startedAt: surge, scenario: 'restartUninitialized' } })).toBe(false);
    expect(f('503', { server: { startedAt: surge, scenario: 'ok' } })).toBe(false);
    expect(f('503')).toBe(false);
    expect(f('server-before', { server: { startedAt: surge - 10_000, scenario: 'ok' } })).toBe(true);
    expect(f('server-before', { server: { startedAt: surge + 10_000, scenario: 'ok' } })).toBe(false);
    expect(f('server-before', { server: { startedAt: surge + 300, scenario: 'ok' } })).toBeNull();
    expect(f('server-before')).toBe(false);
    expect(f('server-before', { server: { startedAt: 1, scenario: 'ok' }, surgeStartedAt: null })).toBeNull();
    expect(f('server-after')).toBe(true);
    expect(f('server-after', { server: { startedAt: surge + 10_000, scenario: 'ok' } })).toBe(true);
    expect(f('server-after', { server: { startedAt: surge - 10_000, scenario: 'ok' } })).toBe(false);
  });

  it('classifies the cache and error after a restart (premise of the audit\'s not_ready exemption)', () => {
    const snap = (over: Partial<{ updatedAt: Date | null; error: string | null; updating: boolean | null }> = {}) => ({ updatedAt: null, error: 'not_ready', updating: false, ...over });
    expect(classifyEmptyCache(snap({ updatedAt: new Date(1) }), 3)).toBe('cached');
    expect(classifyEmptyCache(snap({ error: '服务器返回了异常状态码：503。' }), 1)).toBe('visible');
    expect(classifyEmptyCache(snap(), 1)).toBe('hidden');
    expect(classifyEmptyCache(snap(), 0)).toBe('unknown');
    expect(classifyEmptyCache(snap({ updating: true }), 1)).toBe('unknown');
    expect(classifyEmptyCache(snap({ error: 'unreadable' }), 1)).toBe('unknown');
    expect(classifyEmptyCache(null, 1)).toBe('unknown');
  });

  it('regression: a failed download hidden behind not_ready on an empty cache fails the premise check, even in an observation that is not counted', () => {
    const premise = (list: RestartObservation[]) => restartChecks(list, CURRENT).find((c) => c.name.startsWith('重开后缓存不存在时'))!;
    const i503 = REQUIRED.findIndex((r) => r.kind === 'surge' && r.variants.includes('503'));
    const iDown = REQUIRED.findIndex((r) => r.kind === 'surge' && r.variants.includes('down'));
    const replace = (i: number, o: RestartObservation) => all.map((x, j) => (j === i ? o : x));
    expect(premise(all).ok).toBe(true);
    expect(premise(replace(i503, obs('surge', '503', { emptyCache: 'visible' }))).ok).toBe(true);
    const hidden = premise(replace(i503, obs('surge', '503', { emptyCache: 'hidden' })));
    expect(hidden.ok).toBe(false);
    expect(hidden.note).toContain('藏在未就绪之后');
    expect(premise([...all, obs('surge', '503', { emptyCache: 'hidden', contextChanged: ['surgeBuild'] })]).ok).toBe(false);
    // 缓存不存在而没有看到失败的下载（例如服务不可用）、或旧记录没有这一项：无法判断
    expect(premise(replace(iDown, obs('surge', 'down', { emptyCache: 'unknown' }))).ok).toBeNull();
    expect(premise(replace(iDown, obs('surge', 'down', { emptyCache: undefined }))).ok).toBeNull();
    expect(premise([]).ok).toBeNull();
  });
});

describe('server-down squatting verdicts', () => {
  const o = (mode: SquatPhase['mode'], over: Partial<SquatObservation> = {}): SquatObservation => ({
    members: ['REJECT'],
    error: '无错误',
    updatedAtChanged: false,
    squatRequests: 1,
    earlierRequests: 0,
    tokenReceived: true,
    verdict: SQUAT_EXPECTED_VERDICT[mode],
    expected: SQUAT_EXPECTED_VERDICT[mode],
    ...over,
  });
  const phase = (mode: SquatPhase['mode'], scheduled: SquatObservation | null, explicit: SquatObservation | null = o(mode)): SquatPhase => ({
    mode,
    ran: true,
    scheduled: scheduled === null ? null : { minutes: 1, observed: true, result: scheduled },
    between: scheduled === null ? null : { recovered: true },
    explicit,
  });
  const all = (['squat200', 'squat404', 'squatHang'] as const).map((m) => phase(m, o(m)));

  it('passes only when every squat mode was observed and detected by the audit, for both the explicit update and the scheduled refresh', () => {
    expect(squatChecks(all)).toEqual({ explicit: true, scheduled: true });
    expect(squatChecks([])).toEqual({ explicit: null, scheduled: null });
    // 不答复的占用者（请求超时）同样要被发现
    expect(SQUAT_EXPECTED_VERDICT.squatHang).toBe('unexplained_error');
    expect(squatChecks(all.slice(0, 2))).toEqual({ explicit: null, scheduled: null });
  });

  it('regression: observing a scheduled squat fetch is not enough; the audit verdict must match, and every mode must be observed', () => {
    // 定时刷新的下载被观察到，但核对没有发现（例如定时刷新不改写更新时间）：不通过
    const missed = [all[0]!, phase('squat404', o('squat404', { verdict: 'ok' })), all[2]!];
    expect(squatChecks(missed).scheduled).toBe(false);
    expect(squatChecks(missed).explicit).toBe(true);
    // 只有一种占用观察到定时刷新：不完整
    const one = [all[0]!, phase('squat404', null), phase('squatHang', null)];
    expect(squatChecks(one).scheduled).toBeNull();
  });

  it('an observation without squat requests, or an explicit update after Surge already fetched on its own, is not measured', () => {
    expect(squatChecks([all[0]!, all[1]!, phase('squatHang', o('squatHang'), o('squatHang', { squatRequests: 0, verdict: 'ok' }))]).explicit).toBeNull();
    expect(squatChecks([all[0]!, all[1]!, phase('squatHang', o('squatHang'), o('squatHang', { earlierRequests: 2 }))]).explicit).toBeNull();
  });

  it('parses the copied uid and lsof names', () => {
    expect(parseUid('uid 502：127.0.0.1 绑定失败')).toBe(502);
    expect(parseUid('UID=0')).toBe(0);
    expect(parseUid('没有照抄')).toBeNull();
    expect(parseLsofNames('p100\nf12\nn127.0.0.1:18084\nf13\nn*:18084\n')).toEqual(['127.0.0.1:18084', '*:18084']);
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
