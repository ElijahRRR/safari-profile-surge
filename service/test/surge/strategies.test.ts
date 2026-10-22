import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { ENTRY_MODE_BITS, ENTRY_RULESET_FILES, SfeError, type EntryBits, type KnownEntryMode } from '@sfe/contract';
import type { EntryCleanupStep, EntryController, EntryStep, EntryTransitionOptions } from '../../src/ports.js';
import { FAKE_CHROME_PATH, FAKE_SAFARI_PATH, FAKE_VERIFY_HOST, FakeSurge, createFakeSurgeEnvironment } from '../../src/surge/fake.js';
import { createProfileFiles, type ManagedProfileFiles } from '../../src/surge/files.js';
import { ENTRY_BITS_IN_ORDER, entryRuleSetFileContent, nodeLine, resourceFile, tempRuleText } from '../../src/surge/generate.js';
import { createMemoryEntryOwnership, type MemoryEntryOwnership } from '../../src/surge/entry/ownership.js';
import { createRulesetStrategy, ownedRulesetRecords, type AutoReloadCondition } from '../../src/surge/entry/ruleset-strategy.js';
import { createTempRuleStrategy, type TempRuleInsertion } from '../../src/surge/entry/temp-rule-strategy.js';
import { modeOfSemantic, type EntrySemantic, type Outcome } from '../../src/surge/entry/common.js';
import { normalizeRuleText } from '../../src/surge/rules.js';

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

  test('an externally edited rule set file reads as UNKNOWN: VERIFY_ONLY/ACTIVE (and an activation blocking first) stop, undoing the entry overwrites it', async () => {
    const { ctrl, fake, files } = await setupRuleset();
    writeFileSync(join(dir, ENTRY_RULESET_FILES.block), entryRuleSetFileContent('block', true, CFG));
    expect((await ctrl.read()).mode).toBe('UNKNOWN');
    const adds = fake.calls.updateExternalResource;
    const err = (await ctrl.transition('ACTIVE').catch((e: unknown) => e)) as SfeError;
    expect(err.code).toBe('BASELINE_CHANGED');
    expect(err.details!.lastConfirmedBits).toBeNull();
    expect(fake.calls.updateExternalResource).toBe(adds);
    expect(observe(fake).mode).toBe('NORMAL');
    await expect(ctrl.transition('BLOCKED')).rejects.toMatchObject({ code: 'BASELINE_CHANGED' });
    expect(fake.calls.updateExternalResource).toBe(adds);
    // 撤销本应用入口（undo）不能被一个被编辑的本应用文件卡住：按载入时的摘要比较后改写。
    const rec = stepRecorder(fake);
    expect((await ctrl.transition('NORMAL', rec.onStep, { undo: true })).mode).toBe('NORMAL');
    assertNoWindow(rec.seen, 'NORMAL', 'NORMAL');
    expect(observe(fake).mode).toBe('NORMAL');
    expect(await files.digest(ENTRY_RULESET_FILES.block)).toBe(files.digestContent(entryRuleSetFileContent('block', false, CFG)));
    expect((await ctrl.read()).mode).toBe('NORMAL');
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

// ---------- temp_rule：撤销入口时清理无法确定的本应用规则 ----------

const UNDO = { undo: true } as const;
/** 配置变化后（例如 P0 更新后确认了新路径）：期望的规则文本随之改变，旧文本的记录仍在。合成路径。 */
const PREVIEW_PATH = '/Applications/Safari Technology Preview.app/Contents/MacOS/Safari Technology Preview';
const NEW_CFG = { ...CFG, processPaths: [FAKE_SAFARI_PATH, PREVIEW_PATH] };
/** 早先配置留下的另一条 block 文本（指向已不再使用的路径，不匹配当前 Safari）。 */
const STALE_BLOCK = 'PROCESS-NAME,/Applications/Safari Old.app/Contents/MacOS/Safari,REJECT';
/** 旧版本格式、无法按结构识别的本应用规则：Safari 访问 example.test 经 SFE-ROUTE。 */
const UNRECOGNIZED = `AND,((PROCESS-NAME,${FAKE_SAFARI_PATH}),(DOMAIN-SUFFIX,example.test)),SFE-ROUTE`;
const ALL_REJECT: EntrySemantic = { tcpVerify: 'reject', tcpOther: 'reject', udpVerify: 'reject', udpOther: 'reject' };
const ALL_PASS: EntrySemantic = { tcpVerify: 'pass', tcpOther: 'pass', udpVerify: 'pass', udpOther: 'pass' };

type Observation = ReturnType<typeof observe>;

/**
 * 包装假 Surge：每次增删临时规则之后（成功与否）观察 Safari 的实际结果——撤销清理的步骤不是单个位的变更、不经 onStep，
 * 所以按每次写入观察。hidden 中的规则不出现在有效规则列表里（模拟记录的规则不在有效规则中）。
 */
function watchWrites(fake: FakeSurge, hidden: readonly string[]): { adapter: FakeSurge; seen: Observation[]; removed: string[] } {
  const seen: Observation[] = [];
  const removed: string[] = [];
  const hiddenN = new Set(hidden.map(normalizeRuleText));
  const adapter = new Proxy(fake, {
    get(target, prop) {
      if (prop === 'addTempRule' || prop === 'removeTempRule') {
        return async (rule: string) => {
          if (prop === 'removeTempRule') removed.push(rule);
          try {
            await target[prop](rule);
          } finally {
            seen.push(observe(target));
          }
        };
      }
      if (prop === 'listRules') return async () => (await target.listRules()).filter((r) => !hiddenN.has(normalizeRuleText(r.text)));
      const v: unknown = Reflect.get(target, prop, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  return { adapter, seen, removed };
}

interface UndoSetup {
  fake: FakeSurge;
  ownership: MemoryEntryOwnership;
  ctrl: EntryController;
  /** 每次写入之后的观察。 */
  seen: Observation[];
  /** 传给 removeTempRule 的规则。 */
  removed: string[];
}

/** 起点：按 CFG 建立 start 模式的本应用规则，再按顺序追加 extra（recorded 为本应用记录，否则是用户的规则）；控制器使用 config。 */
async function setupUndo(opts: {
  start: KnownEntryMode;
  config: typeof CFG;
  extra?: Array<{ text: string; recorded: boolean; at?: TempRuleInsertion }>;
  hidden?: string[];
  fakeInsertion?: TempRuleInsertion;
  strategyInsertion?: TempRuleInsertion;
}): Promise<UndoSetup> {
  const { fake, ownership } = await setupTemp({ fakeInsertion: 'tail', start: opts.start });
  for (const x of opts.extra ?? []) {
    fake.tempRuleInsertion = x.at ?? 'tail';
    await fake.addTempRule(x.text);
    if (x.recorded) await ownership.confirm('temp_rule', x.text, 'present');
  }
  fake.tempRuleInsertion = opts.fakeInsertion ?? 'tail';
  const { adapter, seen, removed } = watchWrites(fake, opts.hidden ?? []);
  const ctrl = createTempRuleStrategy({
    adapter,
    ownership,
    config: () => opts.config,
    operationId: () => 'op_test',
    ...(opts.strategyInsertion ? { insertion: opts.strategyInsertion } : {}),
  });
  return { fake, ownership, ctrl, seen, removed };
}

/** 撤销到 BLOCKED 的每次写入之后：原来被拒绝的流量仍被拒绝，没有任何流量落到原规则；Chrome 不受影响。 */
function expectNeverLoosens(start: Observation, seen: readonly Observation[]): void {
  let prev = start;
  for (const o of seen) {
    for (const k of Object.keys(ALL_REJECT) as Array<keyof EntrySemantic>) {
      expect(o.semantic[k]).not.toBe('pass');
      if (prev.semantic[k] === 'reject') expect(o.semantic[k]).toBe('reject');
    }
    expect(o.chrome).toEqual(['DIRECT', 'DIRECT']);
    prev = o;
  }
}

function expectAllBlocked(seen: readonly Observation[]): void {
  for (const o of seen) {
    expect(o.semantic).toEqual(ALL_REJECT);
    expect(o.chrome).toEqual(['DIRECT', 'DIRECT']);
  }
}

describe('temp_rule strategy: undoing the entry with ambiguous app-owned rules', () => {
  for (const [target, rejectPolicy] of (['BLOCKED', 'NORMAL'] as const).flatMap((target) =>
    ['REJECT', 'REJECT-DROP', 'REJECT-NO-DROP', 'REJECT-TINYGIF'].map((policy) => [target, policy] as const),
  )) {
    test(`undo ${target} retains an unrecognised ${rejectPolicy} until the routing rule behind it is removed`, async () => {
      const reject = UNRECOGNIZED.replace(/SFE-ROUTE$/, rejectPolicy);
      const u = await setupUndo({
        start: 'NORMAL',
        config: CFG,
        extra: [reject, UNRECOGNIZED, tempRuleText('block', CFG)].map((text) => ({ text, recorded: true })),
        fakeInsertion: 'tail',
        strategyInsertion: 'tail',
      });
      expect(observe(u.fake).semantic).toEqual(ALL_REJECT);
      const result = await u.ctrl.transition(target, undefined, UNDO).catch((e: unknown) => e);
      if (target === 'BLOCKED') expectAllBlocked(u.seen);
      else {
        expectAllBlocked(u.seen.slice(0, -1));
        expect(u.seen.at(-1)!.semantic).toEqual(ALL_PASS);
      }
      expect(u.removed.indexOf(UNRECOGNIZED)).toBeLessThan(u.removed.indexOf(reject));
      expect(result).toMatchObject({ mode: target });
    });
  }

  for (const insertion of ['tail', 'head'] as const) {
    test(`[${insertion}] duplicate block records after a process path change: normal mode (undo BLOCKED → NORMAL) reaches NORMAL`, async () => {
      const blockNew = tempRuleText('block', NEW_CFG);
      const u = await setupUndo({ start: 'BLOCKED', config: NEW_CFG, extra: [{ text: blockNew, recorded: true }], fakeInsertion: insertion, strategyInsertion: insertion });
      const rb = await u.ctrl.read();
      expect(rb).toMatchObject({ mode: 'UNKNOWN', bits: null });
      expect(rb.evidence).toContain('异常：duplicate_block');
      const baseline = { ...u.fake.calls };
      const start = observe(u.fake);
      const blocked = await u.ctrl.transition('BLOCKED', undefined, UNDO);
      expect(blocked.mode).toBe('BLOCKED');
      const trail = blocked.evidence.find((e) => e.startsWith('撤销入口时逐条清理了本应用的临时规则：'))!;
      expect(trail).toContain(`移除 udp「${tempRuleText('udp', CFG)}」`);
      expect(trail).toContain(`移除 block「${tempRuleText('block', CFG)}」`);
      expect(trail).not.toContain(blockNew);
      expectNeverLoosens(start, u.seen);
      expectAllBlocked(u.seen);
      expect([...u.fake.tempRules].sort()).toEqual([tempRuleText('udp', NEW_CFG), blockNew].sort());
      // 旧文本的记录按事实确认为已移除，只保留当前配置的两条
      expect(u.ownership.records().filter((r) => r.state === 'present').map((r) => r.identity).sort()).toEqual([tempRuleText('udp', NEW_CFG), blockNew].sort());
      const n = u.seen.length;
      const normal = await u.ctrl.transition('NORMAL', undefined, UNDO);
      expect(normal.mode).toBe('NORMAL');
      expect(u.fake.tempRules).toEqual([]);
      expect(observe(u.fake).semantic).toEqual(ALL_PASS);
      expect(u.ownership.records().every((r) => r.state === 'removed')).toBe(true);
      for (const o of u.seen.slice(n)) expect(Object.values(o.semantic)).not.toContain('route');
      expect(forbiddenCalls(u.fake, baseline)).toEqual([]);
      expect(u.fake.calls.reloadProfile).toBeUndefined();
    });
  }

  test('a recorded rule missing from the effective rules: normal mode reaches NORMAL, Safari never falls to the original rules', async () => {
    const u = await setupUndo({ start: 'ACTIVE', config: CFG, hidden: [tempRuleText('active', CFG)], fakeInsertion: 'tail', strategyInsertion: 'tail' });
    const rb = await u.ctrl.read();
    expect(rb.mode).toBe('UNKNOWN');
    expect(rb.evidence).toContain('异常：not_in_effective_rules');
    const start = observe(u.fake);
    expect(start.mode).toBe('ACTIVE');
    const blocked = await u.ctrl.transition('BLOCKED', undefined, UNDO);
    expect(blocked.mode).toBe('BLOCKED');
    // 先加入 block（尾部：Safari 仍按起点 ACTIVE），再移除 active → 全部拒绝
    expectNeverLoosens(start, u.seen);
    expect(u.seen.map((o) => o.mode)).toEqual(['ACTIVE', 'BLOCKED', 'BLOCKED', 'BLOCKED']);
    expect(u.removed[0]).toBe(tempRuleText('active', CFG));
    const normal = await u.ctrl.transition('NORMAL', undefined, UNDO);
    expect(normal.mode).toBe('NORMAL');
    expect(u.fake.tempRules).toEqual([]);
    expect(u.ownership.records().every((r) => r.state === 'removed')).toBe(true);
  });

  test('when the block rule itself is not in the effective rules, undo BLOCKED removes nothing; undo NORMAL removes it last', async () => {
    const u = await setupUndo({ start: 'VERIFY_ONLY', config: CFG, hidden: [tempRuleText('block', CFG)], fakeInsertion: 'tail', strategyInsertion: 'tail' });
    const before = u.fake.tempRules;
    const err = (await u.ctrl.transition('BLOCKED', undefined, UNDO).catch((e: unknown) => e)) as SfeError;
    expect(err).toBeInstanceOf(SfeError);
    expect(err.code).toBe('UNKNOWN_STATE');
    expect(err.details!.lastConfirmedBits).toBeNull();
    expect(err.details!.undoCleanup).toEqual([]);
    expect(u.fake.tempRules).toEqual(before);
    expect(u.seen).toEqual([]);
    const normal = await u.ctrl.transition('NORMAL', undefined, UNDO);
    expect(normal.mode).toBe('NORMAL');
    // verify → udp → block：block 移除之前一直全部拒绝
    expect(u.removed).toEqual([tempRuleText('verify', CFG), tempRuleText('udp', CFG), tempRuleText('block', CFG)]);
    expectAllBlocked(u.seen.slice(0, -1));
    expect(u.seen.at(-1)!.semantic).toEqual(ALL_PASS);
  });

  test('an unrecognised recorded rule that is present is removed before any REJECT rule', async () => {
    // 无法识别的规则排在 udp 与 block 之间：若先移除 udp，Safari 的 UDP 会经它走 SFE-ROUTE
    const u = await setupUndo({
      start: 'NORMAL',
      config: CFG,
      extra: [
        { text: tempRuleText('udp', CFG), recorded: true },
        { text: UNRECOGNIZED, recorded: true },
        { text: tempRuleText('block', CFG), recorded: true },
      ],
      fakeInsertion: 'tail',
      strategyInsertion: 'tail',
    });
    const rb = await u.ctrl.read();
    expect(rb).toMatchObject({ mode: 'UNKNOWN', bits: null });
    expect(rb.evidence).toContain('异常：unrecognized_record');
    const start = observe(u.fake);
    expect(start.semantic).toMatchObject({ tcpVerify: 'route', tcpOther: 'route', udpVerify: 'reject' });
    const blocked = await u.ctrl.transition('BLOCKED', undefined, UNDO);
    expect(blocked.mode).toBe('BLOCKED');
    expect(blocked.evidence.join('\n')).toContain(`移除 无法识别「${UNRECOGNIZED}」`);
    expect(u.removed[0]).toBe(UNRECOGNIZED);
    expectNeverLoosens(start, u.seen);
    expectAllBlocked(u.seen);
    expect(u.fake.tempRules).not.toContain(UNRECOGNIZED);
    expect(u.ownership.records().find((r) => r.identity === UNRECOGNIZED)!.state).toBe('removed');
    expect((await u.ctrl.transition('NORMAL', undefined, UNDO)).mode).toBe('NORMAL');
    expect(u.fake.tempRules).toEqual([]);
  });

  for (const insertion of ['tail', 'head', 'unknown'] as const) {
    test(`[${insertion}] rollback (undo BLOCKED) with duplicate block records keeps Safari blocked after every write`, async () => {
      // 中断的旧操作留下：block 之后的 verify/active（被遮住）与两条旧 block 文本；当前配置的 block 不在
      const u = await setupUndo({
        start: 'NORMAL',
        config: NEW_CFG,
        extra: (['udp', 'block', 'verify', 'active'] as const).map((b) => ({ text: tempRuleText(b, CFG), recorded: true })).concat([{ text: STALE_BLOCK, recorded: true }]),
        fakeInsertion: insertion === 'unknown' ? 'tail' : insertion,
        ...(insertion === 'unknown' ? {} : { strategyInsertion: insertion }),
      });
      expect((await u.ctrl.read()).evidence).toContain('异常：duplicate_block');
      const start = observe(u.fake);
      expect(start.semantic).toEqual(ALL_REJECT);
      const baseline = { ...u.fake.calls };
      const blocked = await u.ctrl.transition('BLOCKED', undefined, UNDO);
      expect(blocked.mode).toBe('BLOCKED');
      // 每次写入之后：不经 SFE-ROUTE，也不落到原规则
      expectAllBlocked(u.seen);
      expect(u.seen.length).toBe(7); // 加入新 block，移除 active、verify、udp、两条旧 block，补上新 udp
      expect(u.removed).toEqual([
        tempRuleText('active', CFG),
        tempRuleText('verify', CFG),
        tempRuleText('udp', CFG),
        tempRuleText('block', CFG),
        STALE_BLOCK,
      ]);
      expect([...u.fake.tempRules].sort()).toEqual([tempRuleText('udp', NEW_CFG), tempRuleText('block', NEW_CFG)].sort());
      expect(blocked.evidence.join('\n')).toContain(`加入 block「${tempRuleText('block', NEW_CFG)}」`);
      expect(forbiddenCalls(u.fake, baseline)).toEqual([]);
    });
  }

  test('each confirmed cleanup step is reported through onCleanup in order; a later failure keeps the reported steps and Safari blocked', async () => {
    const u = await setupUndo({
      start: 'NORMAL',
      config: NEW_CFG,
      extra: (['udp', 'block', 'verify', 'active'] as const).map((b) => ({ text: tempRuleText(b, CFG), recorded: true })).concat([{ text: STALE_BLOCK, recorded: true }]),
      fakeInsertion: 'tail',
      strategyInsertion: 'tail',
    });
    const reported: EntryCleanupStep[] = [];
    const steps: EntryStep[] = [];
    // 第二步（移除 active）确认并报告之后，让下一次移除失败（规则仍在）
    const onCleanup = (c: EntryCleanupStep): void => {
      reported.push(c);
      if (reported.length === 2) u.fake.failNext('removeTempRule');
    };
    const err = (await u.ctrl.transition('BLOCKED', (st) => steps.push(st), { undo: true, onCleanup }).catch((e: unknown) => e)) as SfeError;
    expect(err).toBeInstanceOf(SfeError);
    expect(err.details!.lastConfirmedBits).toBeNull();
    expect(reported).toEqual([
      { action: 'add', kind: 'block', rule: tempRuleText('block', NEW_CFG) },
      { action: 'remove', kind: 'active', rule: tempRuleText('active', CFG) },
    ]);
    expect(err.details!.undoCleanup).toEqual(reported);
    expect(steps).toEqual([]);
    expectAllBlocked(u.seen);
    expect(u.fake.tempRules).toContain(tempRuleText('verify', CFG));
    // 再次撤销：从失败处继续，逐条报告其余各步；之后按常规计划补上 udp（单个位，经 onStep，不经 onCleanup）
    const rest: EntryCleanupStep[] = [];
    const blocked = await u.ctrl.transition('BLOCKED', (st) => steps.push(st), { undo: true, onCleanup: (c) => rest.push(c) });
    expect(blocked.mode).toBe('BLOCKED');
    expect(rest).toEqual([
      { action: 'remove', kind: 'verify', rule: tempRuleText('verify', CFG) },
      { action: 'remove', kind: 'udp', rule: tempRuleText('udp', CFG) },
      { action: 'remove', kind: 'block', rule: tempRuleText('block', CFG) },
      { action: 'remove', kind: 'block', rule: STALE_BLOCK },
    ]);
    expect(steps.map((st) => [st.bit, st.value])).toEqual([['udp', true]]);
    expectAllBlocked(u.seen);
    // 无歧义的状态走常规计划：不调用 onCleanup
    const none: EntryCleanupStep[] = [];
    expect((await u.ctrl.transition('NORMAL', undefined, { undo: true, onCleanup: (c) => none.push(c) })).mode).toBe('NORMAL');
    expect(none).toEqual([]);
    expect(u.fake.tempRules).toEqual([]);
  });

  test('undo NORMAL straight from an ambiguous state removes routing rules first and the block rules last', async () => {
    const blockNew = tempRuleText('block', NEW_CFG);
    const u = await setupUndo({
      start: 'NORMAL',
      config: NEW_CFG,
      extra: [
        { text: tempRuleText('udp', CFG), recorded: true },
        { text: tempRuleText('block', CFG), recorded: true },
        { text: tempRuleText('active', CFG), recorded: true },
        { text: blockNew, recorded: true },
      ],
    });
    expect(observe(u.fake).semantic).toEqual(ALL_REJECT);
    const normal = await u.ctrl.transition('NORMAL', undefined, UNDO);
    expect(normal.mode).toBe('NORMAL');
    expect(u.removed).toEqual([tempRuleText('active', CFG), tempRuleText('udp', CFG), tempRuleText('block', CFG), blockNew]);
    expectAllBlocked(u.seen.slice(0, -1));
    expect(u.seen.at(-1)!.semantic).toEqual(ALL_PASS);
    expect(u.fake.tempRules).toEqual([]);
  });

  test('foreign rules, including one identical to the expected block rule, are never removed by the undo cleanup', async () => {
    const userRule = 'DOMAIN,mine.example.test,DIRECT';
    const blockNew = tempRuleText('block', NEW_CFG);
    const u = await setupUndo({
      start: 'BLOCKED',
      config: NEW_CFG,
      extra: [
        { text: STALE_BLOCK, recorded: true },
        { text: blockNew, recorded: false },
        { text: userRule, recorded: false, at: 'head' },
      ],
    });
    const rb = await u.ctrl.read();
    expect(rb.evidence).toEqual(expect.arrayContaining(['异常：duplicate_block', '异常：foreign_block']));
    const before = u.fake.tempRules;
    const recordsBefore = u.ownership.records();
    // 回到 BLOCKED 需要的 block 规则已存在但不是本应用的：照旧 NAME_COLLISION，不写入
    const err = (await u.ctrl.transition('BLOCKED', undefined, UNDO).catch((e: unknown) => e)) as SfeError;
    expect(err.code).toBe('NAME_COLLISION');
    expect(err.details!.lastConfirmedBits).toBeNull();
    expect(u.fake.tempRules).toEqual(before);
    expect(u.ownership.records()).toEqual(recordsBefore);
    expect(u.seen).toEqual([]);
    // 撤销到 NORMAL：只移除本应用记录的规则；同文的用户规则仍在，所以不能宣称 NORMAL
    const err2 = (await u.ctrl.transition('NORMAL', undefined, UNDO).catch((e: unknown) => e)) as SfeError;
    expect(err2.code).toBe('READBACK_MISMATCH');
    expect(u.removed.sort()).toEqual([tempRuleText('udp', CFG), tempRuleText('block', CFG), STALE_BLOCK].sort());
    expect((err2.details!.undoCleanup as Array<{ rule: string }>).map((t) => t.rule).sort()).toEqual([...u.removed].sort());
    expect(u.fake.tempRules).toEqual([userRule, blockNew]);
    expect(u.ownership.records().every((r) => r.state === 'removed')).toBe(true);
  });

  test('a blocking module rule after the cleanup is still a PRECEDENCE_VIOLATION with BLOCKED confirmed (normal mode continues)', async () => {
    const u = await setupUndo({ start: 'BLOCKED', config: NEW_CFG, extra: [{ text: tempRuleText('block', NEW_CFG), recorded: true }] });
    u.fake.setModuleRules([{ text: 'PROCESS-NAME,Safari,DIRECT', moduleName: 'Mod' }]);
    const err = (await u.ctrl.transition('BLOCKED', undefined, UNDO).catch((e: unknown) => e)) as SfeError;
    expect(err.code).toBe('PRECEDENCE_VIOLATION');
    expect(err.details!.lastConfirmedBits).toEqual(ENTRY_MODE_BITS.BLOCKED);
    expect(err.details!.precedenceIssues).toEqual([expect.objectContaining({ source: 'module', severity: 'blocking' })]);
    expect((err.details!.undoCleanup as unknown[]).length).toBe(2);
    expect([...u.fake.tempRules].sort()).toEqual([tempRuleText('udp', NEW_CFG), tempRuleText('block', NEW_CFG)].sort());
    expect((await u.ctrl.transition('NORMAL', undefined, UNDO)).mode).toBe('NORMAL');
    expect(u.fake.tempRules).toEqual([]);
  });

  const AMBIGUOUS: Record<string, Parameters<typeof setupUndo>[0]> = {
    duplicate: { start: 'BLOCKED', config: NEW_CFG, extra: [{ text: tempRuleText('block', NEW_CFG), recorded: true }] },
    unrecognized: { start: 'BLOCKED', config: CFG, extra: [{ text: UNRECOGNIZED, recorded: true }] },
    not_in_effective_rules: { start: 'ACTIVE', config: CFG, hidden: [tempRuleText('active', CFG)] },
  };
  for (const [name, setup] of Object.entries(AMBIGUOUS)) {
    test(`${name}: transitions not marked undo, and undo toward VERIFY_ONLY/ACTIVE, still refuse before any write`, async () => {
      const u = await setupUndo(setup);
      const before = u.fake.tempRules;
      const reported: EntryCleanupStep[] = [];
      const onCleanup = (c: EntryCleanupStep): void => void reported.push(c);
      const attempts: Array<[KnownEntryMode, EntryTransitionOptions | undefined]> = [
        ...MODES.map((m): [KnownEntryMode, undefined] => [m, undefined]),
        ['BLOCKED', { undo: false, onCleanup }],
        ['NORMAL', { onCleanup }],
        ['VERIFY_ONLY', { ...UNDO, onCleanup }],
        ['ACTIVE', { ...UNDO, onCleanup }],
      ];
      for (const [to, opts] of attempts) {
        const err = (await u.ctrl.transition(to, undefined, opts).catch((e: unknown) => e)) as SfeError;
        expect(err).toBeInstanceOf(SfeError);
        expect(err.code).toBe('UNKNOWN_STATE');
        expect(err.details!.lastConfirmedBits).toBeNull();
      }
      expect(u.seen).toEqual([]);
      expect(reported).toEqual([]);
      expect(u.fake.tempRules).toEqual(before);
    });
  }
});
