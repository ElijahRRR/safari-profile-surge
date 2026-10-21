import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { ENTRY_MODE_BITS, ENTRY_RULESET_FILES, SfeError, type EntryBits, type KnownEntryMode } from '@sfe/contract';
import type { EntryController, EntryStep } from '../../src/ports.js';
import { FAKE_CHROME_PATH, FAKE_SAFARI_PATH, FAKE_VERIFY_HOST, FakeSurge, createFakeSurgeEnvironment } from '../../src/surge/fake.js';
import { createProfileFiles, type ManagedProfileFiles } from '../../src/surge/files.js';
import { ENTRY_BITS_IN_ORDER, entryRuleSetFileContent, nodeLine, resourceFile, tempRuleText } from '../../src/surge/generate.js';
import { createMemoryEntryOwnership, type MemoryEntryOwnership } from '../../src/surge/entry/ownership.js';
import { createRulesetStrategy, ownedRulesetRecords, type AutoReloadCondition } from '../../src/surge/entry/ruleset-strategy.js';
import { createTempRuleStrategy, type TempRuleInsertion } from '../../src/surge/entry/temp-rule-strategy.js';
import { modeOfSemantic, type EntrySemantic, type Outcome } from '../../src/surge/entry/common.js';

const MODES: KnownEntryMode[] = ['NORMAL', 'BLOCKED', 'VERIFY_ONLY', 'ACTIVE'];
const NODE = 'SFE-N-E0001-US01-v001';
const SITE = 'www.example.test';
const CFG = { processPaths: [FAKE_SAFARI_PATH], verifyHost: FAKE_VERIFY_HOST, siteHosts: [SITE] };
// 只允许这些原语出现在入口切换中：从不重载、切换配置、flush 或改接管。
const ENTRY_PRIMITIVES = new Set([
  'listTempRules',
  'addTempRule',
  'removeTempRule',
  'listRules',
  'listExternalResources',
  'updateExternalResource',
  'getAutoReloadSetting',
]);

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sfe-entry-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 观察 Safari 四类流量与 Chrome 的实际结果（经假 Surge 的已加载规则求值）。 */
function observe(fake: FakeSurge): { semantic: EntrySemantic; mode: KnownEntryMode | null; chrome: string[] } {
  const outcome = (host: string, protocol: 'tcp' | 'udp'): Outcome => {
    const r = fake.simulateRequest({ processPath: FAKE_SAFARI_PATH, host, protocol });
    if (r.failed && r.policyName?.startsWith('REJECT')) return 'reject';
    if (r.policyName === 'SFE-ROUTE') {
      expect(r.leafPolicyName).toBe(NODE);
      return 'route';
    }
    return 'pass';
  };
  const semantic: EntrySemantic = {
    tcpVerify: outcome(FAKE_VERIFY_HOST, 'tcp'),
    tcpOther: outcome(SITE, 'tcp'),
    udpVerify: outcome(FAKE_VERIFY_HOST, 'udp'),
    udpOther: outcome(SITE, 'udp'),
  };
  const chrome = [
    fake.simulateRequest({ processPath: FAKE_CHROME_PATH, host: SITE, protocol: 'tcp' }).policyName!,
    fake.simulateRequest({ processPath: FAKE_CHROME_PATH, host: FAKE_VERIFY_HOST, protocol: 'udp' }).policyName!,
  ];
  return { semantic, mode: modeOfSemantic(semantic), chrome };
}

async function selectNode(fake: FakeSurge): Promise<void> {
  writeFileSync(
    join(dir, 'sfe-nodes.list'),
    resourceFile(1, [nodeLine({ name: NODE, host: '203.0.113.10', port: 1080, username: null, password: null, front: 'Front-A' })]),
  );
  await fake.updateExternalResource('policy-path:sfe-nodes.list');
  await fake.selectGroupPolicy('SFE-ROUTE', NODE);
}

function forbiddenCalls(fake: FakeSurge, baseline: Record<string, number>): string[] {
  return Object.keys(fake.calls).filter((k) => fake.calls[k] !== baseline[k] && !ENTRY_PRIMITIVES.has(k));
}

/** 记录每一步之后的实际效果，用于断言“无放行窗口”。 */
function stepRecorder(fake: FakeSurge) {
  const seen: Array<{ step: EntryStep; mode: KnownEntryMode | null; chrome: string[] }> = [];
  return {
    seen,
    onStep: (step: EntryStep) => {
      const o = observe(fake);
      seen.push({ step, mode: o.mode, chrome: o.chrome });
    },
  };
}

function assertNoWindow(seen: Array<{ mode: KnownEntryMode | null; chrome: string[] }>, from: KnownEntryMode, to: KnownEntryMode): void {
  const allowed = new Set<KnownEntryMode>(['BLOCKED', 'VERIFY_ONLY', from, to]);
  for (const s of seen) {
    expect(s.mode).not.toBeNull();
    expect(allowed.has(s.mode!)).toBe(true);
    expect(s.chrome).toEqual(['DIRECT', 'DIRECT']);
  }
}

// ---------- ruleset_resource ----------

interface RulesetSetup {
  fake: FakeSurge;
  files: ManagedProfileFiles;
  ownership: MemoryEntryOwnership;
  ctrl: EntryController;
  cond: { value: AutoReloadCondition };
}

async function setupRuleset(opts: { autoReload?: boolean; reported?: boolean | null; moduleRules?: Array<{ text: string; moduleName: string }> } = {}): Promise<RulesetSetup> {
  createFakeSurgeEnvironment(dir);
  const fake = new FakeSurge({ directory: dir, autoReload: opts.autoReload ?? false, reportedAutoReload: opts.reported });
  if (opts.moduleRules) fake.setModuleRules(opts.moduleRules);
  await selectNode(fake);
  const files = createProfileFiles({ directory: dir, hmacKey: 'example-hmac-key' });
  const ownership = createMemoryEntryOwnership(await ownedRulesetRecords(files));
  const cond = { value: (opts.autoReload ? 'on' : 'off') as AutoReloadCondition };
  const ctrl = createRulesetStrategy({ adapter: fake, files, ownership, config: () => CFG, operationId: () => 'op_test', autoReloadCondition: () => cond.value });
  return { fake, files, ownership, ctrl, cond };
}

describe('ruleset_resource strategy', () => {
  test('starts in NORMAL with placeholder rule sets', async () => {
    const { ctrl, fake } = await setupRuleset();
    const rb = await ctrl.read();
    expect(rb.mode).toBe('NORMAL');
    expect(rb.bits).toEqual(ENTRY_MODE_BITS.NORMAL);
    expect(rb.precedenceIssues).toEqual([]);
    expect(observe(fake).mode).toBe('NORMAL');
  });

  for (const from of MODES) {
    for (const to of MODES) {
      test(`${from} → ${to}: exact result, no permissive window, no reload`, async () => {
        const { ctrl, fake } = await setupRuleset();
        if (from !== 'NORMAL') await ctrl.transition(from);
        expect(observe(fake).mode).toBe(from);
        const baseline = { ...fake.calls };
        const rec = stepRecorder(fake);
        const rb = await ctrl.transition(to, rec.onStep);
        expect(rb.mode).toBe(to);
        expect(rb.bits).toEqual(ENTRY_MODE_BITS[to]);
        expect(observe(fake).mode).toBe(to);
        assertNoWindow(rec.seen, from, to);
        expect(forbiddenCalls(fake, baseline)).toEqual([]);
        expect(fake.reloadCount).toBe(0);
        expect(fake.calls.reloadProfile).toBeUndefined();
        // 每一步只刷新一个入口规则集资源。
        expect((fake.calls.updateExternalResource ?? 0) - (baseline.updateExternalResource ?? 0)).toBe(rec.seen.length);
      });
    }
  }

  test('a refresh failure mid-transition leaves the stricter confirmed state and restores the file', async () => {
    const { ctrl, fake } = await setupRuleset();
    const rec = stepRecorder(fake);
    const err = (await ctrl
      .transition('ACTIVE', (step) => {
        rec.onStep(step);
        if (rec.seen.length === 2) fake.failNext('updateExternalResource');
      })
      .catch((e: unknown) => e)) as SfeError;
    expect(err).toBeInstanceOf(SfeError);
    expect(err.code).toBe('SURGE_COMMAND_FAILED');
    expect(err.details!.lastConfirmedBits).toEqual(ENTRY_MODE_BITS.BLOCKED);
    assertNoWindow(rec.seen, 'NORMAL', 'ACTIVE');
    expect(observe(fake).mode).toBe('BLOCKED');
    const rb = await ctrl.read();
    expect(rb.mode).toBe('BLOCKED');
    // 之后可以继续完成切换。
    expect((await ctrl.transition('ACTIVE')).mode).toBe('ACTIVE');
    expect(observe(fake).mode).toBe('ACTIVE');
  });

  test('a refresh that reports success without effect is a READBACK_MISMATCH', async () => {
    const { ctrl, fake } = await setupRuleset();
    await ctrl.transition('BLOCKED');
    fake.lieOnNext('updateExternalResource');
    const err = (await ctrl.transition('VERIFY_ONLY').catch((e: unknown) => e)) as SfeError;
    expect(err.code).toBe('READBACK_MISMATCH');
    expect(err.details!.lastConfirmedBits).toEqual(ENTRY_MODE_BITS.BLOCKED);
    expect(observe(fake).mode).toBe('BLOCKED');
    expect((await ctrl.read()).mode).toBe('BLOCKED');
  });

  test('a timed-out refresh that did take effect is accepted after reading facts', async () => {
    const { ctrl, fake } = await setupRuleset();
    fake.failNext('updateExternalResource', new SfeError('SURGE_UNREACHABLE', '连接 Surge 失败：命令超时'), { afterEffect: true });
    expect((await ctrl.transition('BLOCKED')).mode).toBe('BLOCKED');
    expect(observe(fake).mode).toBe('BLOCKED');
  });

  test('refuses before writing when the auto-reload setting differs from the verified condition', async () => {
    const { ctrl, fake, files, cond } = await setupRuleset();
    const before = await files.digest(ENTRY_RULESET_FILES.block);
    cond.value = 'on';
    const err = (await ctrl.transition('BLOCKED').catch((e: unknown) => e)) as SfeError;
    expect(err.code).toBe('CAPABILITY_UNVERIFIED');
    expect(err.details).toMatchObject({ lastConfirmedBits: ENTRY_MODE_BITS.NORMAL, autoReload: false, verifiedCondition: 'on' });
    expect(await files.digest(ENTRY_RULESET_FILES.block)).toBe(before);
    expect(fake.calls.updateExternalResource).toBe(1); // 只有准备节点时的一次
  });

  test('refuses when no condition was recorded, and when the setting is unreadable unless recorded as any', async () => {
    const a = await setupRuleset({ reported: null });
    a.cond.value = null;
    await expect(a.ctrl.transition('BLOCKED')).rejects.toMatchObject({ code: 'CAPABILITY_UNVERIFIED' });
    a.cond.value = 'off';
    await expect(a.ctrl.transition('BLOCKED')).rejects.toMatchObject({ code: 'CAPABILITY_UNVERIFIED' });
    a.cond.value = 'any';
    expect((await a.ctrl.transition('BLOCKED')).mode).toBe('BLOCKED');
  });

  test('stays in the last confirmed stricter state when the setting changes mid-transition', async () => {
    const { ctrl, fake } = await setupRuleset();
    await ctrl.transition('VERIFY_ONLY');
    const err = (await ctrl
      .transition('ACTIVE', () => {
        fake.reportedAutoReload = true;
      })
      .catch((e: unknown) => e)) as SfeError;
    expect(err.code).toBe('CAPABILITY_UNVERIFIED');
    expect(err.details!.lastConfirmedBits).toEqual(ENTRY_MODE_BITS.BLOCKED);
    expect(observe(fake).mode).toBe('BLOCKED');
  });

  test('an externally edited rule set file stops the transition and reads as UNKNOWN', async () => {
    const { ctrl, fake } = await setupRuleset();
    writeFileSync(join(dir, ENTRY_RULESET_FILES.block), entryRuleSetFileContent('block', true, CFG));
    expect((await ctrl.read()).mode).toBe('UNKNOWN');
    const adds = fake.calls.updateExternalResource;
    const err = (await ctrl.transition('NORMAL').catch((e: unknown) => e)) as SfeError;
    expect(err.code).toBe('BASELINE_CHANGED');
    expect(err.details!.lastConfirmedBits).toBeNull();
    expect(fake.calls.updateExternalResource).toBe(adds);
    expect(observe(fake).mode).toBe('NORMAL');
  });

  test('a blocking module rule prevents VERIFY_ONLY/ACTIVE without writing, but NORMAL and BLOCKED still work', async () => {
    const { ctrl, fake } = await setupRuleset({ moduleRules: [{ text: 'PROCESS-NAME,Safari,DIRECT', moduleName: 'Mod' }] });
    const err = (await ctrl.transition('ACTIVE').catch((e: unknown) => e)) as SfeError;
    expect(err.code).toBe('PRECEDENCE_VIOLATION');
    expect(fake.calls.getAutoReloadSetting).toBeUndefined();
    const rb = await ctrl.read();
    expect(rb.mode).toBe('NORMAL');
    expect(rb.precedenceIssues).toEqual([{ rule: 'PROCESS-NAME,Safari,DIRECT', source: 'module', severity: 'blocking' }]);
    // BLOCKED 仍按计划写入，但最终读回不能宣称受控。
    await expect(ctrl.transition('BLOCKED')).rejects.toMatchObject({ code: 'PRECEDENCE_VIOLATION' });
    expect((await ctrl.read()).mode).toBe('UNKNOWN');
    expect((await ctrl.transition('NORMAL')).mode).toBe('NORMAL');
  });

  test('a REJECT module rule is only a warning', async () => {
    const { ctrl } = await setupRuleset({ moduleRules: [{ text: 'DOMAIN-SUFFIX,example.test,REJECT', moduleName: 'Ads' }] });
    const rb = await ctrl.transition('ACTIVE');
    expect(rb.mode).toBe('ACTIVE');
    expect(rb.precedenceIssues).toEqual([{ rule: 'DOMAIN-SUFFIX,example.test,REJECT', source: 'module', severity: 'warning' }]);
  });

  test('missing resource for a rule set → RESOURCE_MISSING before writing', async () => {
    const { ctrl, fake, files } = await setupRuleset();
    const before = await files.digest(ENTRY_RULESET_FILES.block);
    fake.lieOnNext('listExternalResources', []);
    fake.lieOnNext('listExternalResources', []);
    const err = (await ctrl.transition('BLOCKED').catch((e: unknown) => e)) as SfeError;
    expect(err.code).toBe('RESOURCE_MISSING');
    expect(err.details!.lastConfirmedBits).toEqual(ENTRY_MODE_BITS.NORMAL);
    expect(await files.digest(ENTRY_RULESET_FILES.block)).toBe(before);
  });

  test('rule set lines missing from the effective rules → UNKNOWN_STATE, nothing written', async () => {
    const { ctrl, fake } = await setupRuleset();
    fake.lieOnNext('listRules', [{ text: 'FINAL,DIRECT', source: 'profile', moduleName: null }]);
    await expect(ctrl.transition('BLOCKED')).rejects.toMatchObject({ code: 'UNKNOWN_STATE' });
    expect(fake.calls.getAutoReloadSetting).toBeUndefined();
  });

  test('two resources pointing to the same file → NAME_COLLISION, nothing written', async () => {
    const { ctrl, fake, files } = await setupRuleset();
    const list = await fake.listExternalResources();
    const dup = [...list, { ...list.find((r) => r.key === 'ruleset:sfe-entry-block.list')!, key: 'ruleset:./sfe-entry-block.list' }];
    const before = await files.digest(ENTRY_RULESET_FILES.block);
    fake.lieOnNext('listExternalResources', list);
    fake.lieOnNext('listExternalResources', dup);
    const err = (await ctrl.transition('BLOCKED').catch((e: unknown) => e)) as SfeError;
    expect(err.code).toBe('NAME_COLLISION');
    expect(await files.digest(ENTRY_RULESET_FILES.block)).toBe(before);
  });

  test('recovers from a crash between file write and refresh without a permissive window', async () => {
    const { ctrl, fake, ownership, files } = await setupRuleset();
    await ctrl.transition('BLOCKED');
    // 模拟崩溃：VERIFY_ONLY→… 中途写入了 active 文件但没有刷新，意图仍为 pending。
    const content = entryRuleSetFileContent('active', true, CFG);
    const prev = await files.digest(ENTRY_RULESET_FILES.active);
    await ownership.recordIntent('entry_ruleset_file', ENTRY_RULESET_FILES.active, files.digestContent(content), 'op_crash', 'add');
    await files.writeAtomic(ENTRY_RULESET_FILES.active, content, prev);
    expect((await ctrl.read()).mode).toBe('UNKNOWN');
    expect(observe(fake).mode).toBe('BLOCKED');
    const rec = stepRecorder(fake);
    expect((await ctrl.transition('BLOCKED', rec.onStep)).mode).toBe('BLOCKED');
    assertNoWindow(rec.seen, 'BLOCKED', 'BLOCKED');
    expect(observe(fake).mode).toBe('BLOCKED');
    expect((await ctrl.transition('ACTIVE')).mode).toBe('ACTIVE');
  });

  test('with auto reload on and a matching verified condition the transition works (reloads are counted for P0 evidence)', async () => {
    const { ctrl, fake } = await setupRuleset({ autoReload: true });
    expect((await ctrl.transition('ACTIVE')).mode).toBe('ACTIVE');
    expect(observe(fake).mode).toBe('ACTIVE');
    expect(fake.autoReloadCount).toBeGreaterThan(0);
    expect(fake.calls.reloadProfile).toBeUndefined();
  });
});

// ---------- temp_rule ----------

interface TempSetup {
  fake: FakeSurge;
  ownership: MemoryEntryOwnership;
  ctrl: EntryController;
}

async function setupTemp(opts: { fakeInsertion: TempRuleInsertion; strategyInsertion?: TempRuleInsertion; start?: KnownEntryMode; userTemp?: string[] } = { fakeInsertion: 'tail' }): Promise<TempSetup> {
  createFakeSurgeEnvironment(dir, { entryStrategy: 'temp_rule' });
  const fake = new FakeSurge({ directory: dir, tempRuleInsertion: 'tail' });
  await selectNode(fake);
  for (const t of opts.userTemp ?? []) await fake.addTempRule(t);
  const ownership = createMemoryEntryOwnership();
  // 按规范顺序直接建立起点（不依赖插入位置）。
  const bits = ENTRY_MODE_BITS[opts.start ?? 'NORMAL'];
  for (const bit of ENTRY_BITS_IN_ORDER) {
    if (!bits[bit]) continue;
    const text = tempRuleText(bit, CFG);
    await fake.addTempRule(text);
    await ownership.confirm('temp_rule', text, 'present');
  }
  fake.tempRuleInsertion = opts.fakeInsertion;
  const ctrl = createTempRuleStrategy({
    adapter: fake,
    ownership,
    config: () => CFG,
    operationId: () => 'op_test',
    ...(opts.strategyInsertion ? { insertion: opts.strategyInsertion } : {}),
  });
  return { fake, ownership, ctrl };
}

/**
 * 单条增删 + Surge 决定插入位置时，按计划顺序无法在不放行的前提下到达所有模式：
 * tail 无法进入 VERIFY_ONLY（verify 落在 block 之后被遮住）；head 无法进入 VERIFY_ONLY 或 ACTIVE
 * （新规则落在 udp/block 之前造成 UDP 或全部放行）。策略在写入前拒绝这些切换。
 */
function tempExpectedOk(insertion: TempRuleInsertion | 'unknown', from: KnownEntryMode, to: KnownEntryMode): boolean {
  if (from === to) return true;
  const tail = !(to === 'VERIFY_ONLY');
  const head = !(to === 'VERIFY_ONLY' || to === 'ACTIVE');
  return insertion === 'tail' ? tail : insertion === 'head' ? head : tail && head;
}

describe('temp_rule strategy', () => {
  for (const insertion of ['tail', 'head', 'unknown'] as const) {
    for (const from of MODES) {
      for (const to of MODES) {
        const ok = tempExpectedOk(insertion, from, to);
        test(`[${insertion}] ${from} → ${to}: ${ok ? 'reaches target' : 'refused before writing'} with no permissive window`, async () => {
          const fakeInsertion = insertion === 'unknown' ? 'tail' : insertion;
          const { ctrl, fake } = await setupTemp({ fakeInsertion, strategyInsertion: insertion === 'unknown' ? undefined : insertion, start: from });
          expect(observe(fake).mode).toBe(from);
          expect((await ctrl.read()).mode).toBe(from);
          const baseline = { ...fake.calls };
          const before = fake.tempRules;
          const rec = stepRecorder(fake);
          const result = await ctrl.transition(to, rec.onStep).catch((e: unknown) => e);
          if (ok) {
            expect((result as { mode: string }).mode).toBe(to);
            expect(observe(fake).mode).toBe(to);
          } else {
            expect(result).toBeInstanceOf(SfeError);
            expect((result as SfeError).code).toBe('CAPABILITY_UNVERIFIED');
            expect((result as SfeError).details!.lastConfirmedBits).toEqual(ENTRY_MODE_BITS[from]);
            expect(fake.tempRules).toEqual(before);
            expect(fake.calls.addTempRule ?? 0).toBe(baseline.addTempRule ?? 0);
            expect(observe(fake).mode).toBe(from);
          }
          assertNoWindow(rec.seen, from, to);
          expect(forbiddenCalls(fake, baseline)).toEqual([]);
          expect(fake.calls.reloadProfile).toBeUndefined();
        });
      }
    }
  }

  test('rules are added and removed one at a time, exactly as recorded', async () => {
    const { ctrl, fake, ownership } = await setupTemp({ fakeInsertion: 'tail', strategyInsertion: 'tail' });
    await ctrl.transition('ACTIVE');
    expect(fake.tempRules).toEqual([tempRuleText('udp', CFG), tempRuleText('active', CFG)]);
    expect(ownership.records().filter((r) => r.state === 'present').map((r) => r.identity).sort()).toEqual([tempRuleText('udp', CFG), tempRuleText('active', CFG)].sort());
    await ctrl.transition('NORMAL');
    expect(fake.tempRules).toEqual([]);
    expect(ownership.records().every((r) => r.state === 'removed')).toBe(true);
  });

  test("user temp rules are never touched, and an identical unrecorded rule is a NAME_COLLISION", async () => {
    const userRule = 'DOMAIN,mine.example.test,DIRECT';
    const a = await setupTemp({ fakeInsertion: 'tail', strategyInsertion: 'tail', userTemp: [userRule] });
    await a.ctrl.transition('ACTIVE');
    await a.ctrl.transition('NORMAL');
    expect(a.fake.tempRules).toEqual([userRule]);
    rmSync(dir, { recursive: true, force: true });
    dir = mkdtempSync(join(tmpdir(), 'sfe-entry-'));
    const b = await setupTemp({ fakeInsertion: 'tail', strategyInsertion: 'tail', userTemp: [tempRuleText('block', CFG)] });
    expect((await b.ctrl.read()).mode).toBe('UNKNOWN');
    const err = (await b.ctrl.transition('BLOCKED').catch((e: unknown) => e)) as SfeError;
    expect(err.code).toBe('NAME_COLLISION');
    expect(b.fake.calls.addTempRule).toBe(1);
  });

  test('a failed add mid-transition keeps the stricter confirmed state; a later transition recovers', async () => {
    const { ctrl, fake } = await setupTemp({ fakeInsertion: 'tail', strategyInsertion: 'tail' });
    const rec = stepRecorder(fake);
    const err = (await ctrl
      .transition('ACTIVE', (step) => {
        rec.onStep(step);
        if (rec.seen.length === 1) fake.failNext('addTempRule');
      })
      .catch((e: unknown) => e)) as SfeError;
    expect(err.code).toBe('SURGE_COMMAND_FAILED');
    expect(err.details!.lastConfirmedBits).toEqual({ udp: false, verify: false, block: true, active: false });
    assertNoWindow(rec.seen, 'NORMAL', 'ACTIVE');
    expect(observe(fake).mode).toBe('BLOCKED');
    expect((await ctrl.read()).mode).toBe('UNKNOWN'); // 只有 block，不是四种模式之一
    expect((await ctrl.transition('ACTIVE')).mode).toBe('ACTIVE');
  });

  test('an add that timed out but did take effect is accepted after reading facts', async () => {
    const { ctrl, fake } = await setupTemp({ fakeInsertion: 'tail', strategyInsertion: 'tail' });
    fake.failNext('addTempRule', new SfeError('SURGE_UNREACHABLE', '连接 Surge 失败：命令超时'), { afterEffect: true });
    expect((await ctrl.transition('ACTIVE')).mode).toBe('ACTIVE');
    expect(observe(fake).mode).toBe('ACTIVE');
  });

  test('an add that reports success without effect is a READBACK_MISMATCH', async () => {
    const { ctrl, fake } = await setupTemp({ fakeInsertion: 'tail', strategyInsertion: 'tail', start: 'BLOCKED' });
    fake.lieOnNext('addTempRule');
    const err = (await ctrl.transition('ACTIVE').catch((e: unknown) => e)) as SfeError;
    expect(err.code).toBe('READBACK_MISMATCH');
    expect(err.details!.lastConfirmedBits).toEqual(ENTRY_MODE_BITS.BLOCKED);
    expect(observe(fake).mode).toBe('BLOCKED');
  });

  test('when Surge inserts differently than recorded, the offending rule is removed and the state stays BLOCKED', async () => {
    const { ctrl, fake } = await setupTemp({ fakeInsertion: 'head', strategyInsertion: 'tail', start: 'BLOCKED' });
    const err = (await ctrl.transition('ACTIVE').catch((e: unknown) => e)) as SfeError;
    expect(err.code).toBe('READBACK_MISMATCH');
    expect(err.details!.lastConfirmedBits).toEqual(ENTRY_MODE_BITS.BLOCKED);
    expect(fake.tempRules).toEqual([tempRuleText('udp', CFG), tempRuleText('block', CFG)]);
    expect(observe(fake).mode).toBe('BLOCKED');
  });

  test('Surge restart drops the rules: read is UNKNOWN, and NORMAL is reached without writes', async () => {
    const { ctrl, fake, ownership } = await setupTemp({ fakeInsertion: 'tail', strategyInsertion: 'tail', start: 'ACTIVE' });
    fake.restart();
    const rb = await ctrl.read();
    expect(rb.mode).toBe('UNKNOWN');
    expect(rb.evidence.join(' ')).toMatch(/missing_/);
    const adds = fake.calls.addTempRule;
    expect((await ctrl.transition('NORMAL')).mode).toBe('NORMAL');
    expect(fake.calls.addTempRule).toBe(adds);
    expect(ownership.records().every((r) => r.state === 'removed')).toBe(true);
  });

  test('a blocking module rule prevents ACTIVE before any write', async () => {
    const { ctrl, fake } = await setupTemp({ fakeInsertion: 'tail', strategyInsertion: 'tail', start: 'BLOCKED' });
    fake.setModuleRules([{ text: 'PROCESS-NAME,Safari,DIRECT', moduleName: 'Mod' }]);
    const adds = fake.calls.addTempRule;
    await expect(ctrl.transition('ACTIVE')).rejects.toMatchObject({ code: 'PRECEDENCE_VIOLATION' });
    expect(fake.calls.addTempRule).toBe(adds);
    expect((await ctrl.transition('NORMAL')).mode).toBe('NORMAL');
  });

  test('read reports bits from recorded rules and the actual order', async () => {
    const { ctrl } = await setupTemp({ fakeInsertion: 'tail', strategyInsertion: 'tail', start: 'VERIFY_ONLY' });
    const rb = await ctrl.read();
    expect(rb).toMatchObject({ mode: 'VERIFY_ONLY', bits: ENTRY_MODE_BITS.VERIFY_ONLY, precedenceIssues: [] });
    expect(rb.evidence[1]).toBe('有效规则顺序：udp > verify > block');
  });

  test('bits passed in transition errors are always a state at least as strict as the start', async () => {
    const strict = (b: EntryBits | null) => b === null || b.block || (!b.verify && !b.active);
    const { ctrl, fake } = await setupTemp({ fakeInsertion: 'tail', strategyInsertion: 'tail' });
    fake.failNext('addTempRule');
    const err = (await ctrl.transition('BLOCKED').catch((e: unknown) => e)) as SfeError;
    expect(strict(err.details!.lastConfirmedBits as EntryBits | null)).toBe(true);
  });
});
