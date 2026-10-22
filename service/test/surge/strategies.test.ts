import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { CAPABILITY_GATES, CAPABILITY_PRIMITIVES, ENTRY_MODE_BITS, ENTRY_PLACEHOLDER_RULE, ENTRY_RULESET_FILES, ENTRY_WITNESS_PROCESS_PATH, LEGACY_ENTRY_PLACEHOLDER_RULE, SfeError, type EntryBits, type KnownEntryMode } from '@sfe/contract';
import type { EntryCleanupStep, EntryController, EntryStep, EntryTransitionOptions, SurgeAdapter, SurgeRuleMatchInput } from '../../src/ports.js';
import { FAKE_CHROME_PATH, FAKE_SAFARI_PATH, FAKE_VERIFY_HOST, FakeSurge, createFakeSurgeEnvironment } from '../../src/surge/fake.js';
import { createProfileFiles, type ManagedProfileFiles } from '../../src/surge/files.js';
import {
  TEMP_ENTRY_MODE_KINDS,
  entryRuleSetFileContent,
  entryRules,
  entryWitnessHost,
  legacyTempRuleText,
  nodeLine,
  parseEntryRuleSetFile,
  resourceFile,
  tempRuleText,
  type TempEntryKind,
} from '../../src/surge/generate.js';
import { createMemoryEntryOwnership, type MemoryEntryOwnership } from '../../src/surge/entry/ownership.js';
import { createRulesetStrategy, ownedRulesetRecords, type AutoReloadCondition } from '../../src/surge/entry/ruleset-strategy.js';
import { createTempRuleStrategy, type TempRuleInsertion } from '../../src/surge/entry/temp-rule-strategy.js';
import { modeOfSemantic, type EntrySemantic, type Outcome } from '../../src/surge/entry/common.js';
import { normalizeRuleText } from '../../src/surge/rules.js';

const MODES: KnownEntryMode[] = ['NORMAL', 'BLOCKED', 'VERIFY_ONLY', 'ACTIVE'];
const NODE = 'SFE-N-E0001-US01-v001';
const SITE = 'www.example.test';
const CFG = { processPaths: [FAKE_SAFARI_PATH], verifyHost: FAKE_VERIFY_HOST, siteHosts: [SITE] };
// 只允许这些原语出现在入口切换中：从不重载、切换配置、flush、改接管，也从不更新外部资源（本地文件被跳过）。
const ENTRY_PRIMITIVES = new Set(['listTempRules', 'addTempRule', 'removeTempRule', 'listRules', 'listExternalResources', 'getAutoReloadSetting', 'matchRule']);

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sfe-entry-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 观察 Safari 四类流量与 Chrome 的实际结果（经假 Surge 的已加载规则求值；假 Surge 把 QUIC 当作 UDP）。 */
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

/** rule match 视角（与 Surge 的 `rule match … protocol=QUIC` 相同）：Safari 的 QUIC 在已知模式下从不经 SFE-ROUTE，也不放行。 */
async function quicPolicies(fake: FakeSurge): Promise<string[]> {
  const out: string[] = [];
  for (const host of [FAKE_VERIFY_HOST, SITE]) out.push((await fake.matchRule({ host, processPath: FAKE_SAFARI_PATH, protocol: 'QUIC' })).policy);
  return out;
}

/**
 * 测试准备：写入节点文件并选择节点。Surge 6.10 的 updateExternalResource 跳过本地资源，本地 policy-path 是否被监视
 * 没有写入文档，所以这里的假 Surge 打开 watchLocalPolicyPaths，让节点文件在下一次调用时载入（与入口策略无关）。
 */
async function selectNode(fake: FakeSurge): Promise<void> {
  writeFileSync(
    join(dir, 'sfe-nodes.list'),
    resourceFile(1, [nodeLine({ name: NODE, host: '203.0.113.10', port: 1080, username: null, password: null, front: 'Front-A' })]),
  );
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

/** 包装适配器：改写 rule match 对某些进程路径的结果（模拟运行时读回与本应用规则不一致）。 */
function rewriteMatch(fake: FakeSurge, rewrite: (input: SurgeRuleMatchInput, real: { rule: string; policy: string }) => { rule: string; policy: string }): SurgeAdapter {
  return new Proxy(fake, {
    get(target, prop) {
      if (prop === 'matchRule') return async (input: SurgeRuleMatchInput) => rewrite(input, await target.matchRule(input));
      const v: unknown = Reflect.get(target, prop, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  }) as unknown as SurgeAdapter;
}

// ---------- ruleset_resource ----------

interface RulesetSetup {
  fake: FakeSurge;
  files: ManagedProfileFiles;
  ownership: MemoryEntryOwnership;
  ctrl: EntryController;
  cond: { value: AutoReloadCondition };
  /** 假时钟（假 Surge 的监视延迟与策略的等待共用）。 */
  clock: { t: number };
  sleeps: number[];
}

async function setupRuleset(
  opts: {
    autoReload?: boolean;
    reported?: boolean | null;
    moduleRules?: Array<{ text: string; moduleName: string }>;
    latencyMs?: number;
    watch?: { timeoutMs?: number; pollMs?: number };
    adapter?: (fake: FakeSurge) => SurgeAdapter;
  } = {},
): Promise<RulesetSetup> {
  createFakeSurgeEnvironment(dir);
  const clock = { t: 1_700_000_000_000 };
  const fake = new FakeSurge({
    directory: dir,
    autoReload: opts.autoReload ?? false,
    reportedAutoReload: opts.reported,
    watchLocalPolicyPaths: true,
    now: () => new Date(clock.t),
  });
  if (opts.moduleRules) fake.setModuleRules(opts.moduleRules);
  await selectNode(fake);
  fake.localWatchLatencyMs = opts.latencyMs ?? 0;
  const files = createProfileFiles({ directory: dir, hmacKey: 'example-hmac-key' });
  const ownership = createMemoryEntryOwnership(await ownedRulesetRecords(files));
  const cond = { value: (opts.autoReload ? 'on' : 'off') as AutoReloadCondition };
  const sleeps: number[] = [];
  let n = 0;
  const ctrl = createRulesetStrategy({
    adapter: opts.adapter ? opts.adapter(fake) : fake,
    files,
    ownership,
    config: () => CFG,
    operationId: () => 'op_test',
    autoReloadCondition: () => cond.value,
    watch: opts.watch ?? { timeoutMs: 2000, pollMs: 100 },
    now: () => clock.t,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock.t += ms;
    },
    witnessToken: () => `w${(++n).toString(16).padStart(6, '0')}`,
  });
  return { fake, files, ownership, ctrl, cond, clock, sleeps };
}

describe('ruleset_resource strategy', () => {
  test('starts in NORMAL with placeholder rule sets (initial files carry the fixed off witness)', async () => {
    const { ctrl, fake } = await setupRuleset();
    const rb = await ctrl.read();
    expect(rb.mode).toBe('NORMAL');
    expect(rb.bits).toEqual(ENTRY_MODE_BITS.NORMAL);
    expect(rb.precedenceIssues).toEqual([]);
    expect(rb.evidence).toContain('规则集 block：已加载（见证一致）');
    expect(observe(fake).mode).toBe('NORMAL');
  });

  for (const from of MODES) {
    for (const to of MODES) {
      test(`${from} → ${to}: exact result, no permissive window, no reload, never updateExternalResource, each step loaded by the watcher`, async () => {
        const { ctrl, fake, files } = await setupRuleset();
        if (from !== 'NORMAL') await ctrl.transition(from);
        expect(observe(fake).mode).toBe(from);
        const baseline = { ...fake.calls };
        const reloadsBefore = fake.watcherReloads.length;
        const rec = stepRecorder(fake);
        const loadedAtStep: boolean[] = [];
        const rb = await ctrl.transition(to, (step) => {
          // 下一步写入之前，这一位的新内容已被 Surge 加载（见证一致）。
          const content = readFileSync(join(dir, ENTRY_RULESET_FILES[step.bit]), 'utf8');
          loadedAtStep.push(fake.loadedContent(`ruleset:${ENTRY_RULESET_FILES[step.bit]}`) === content);
          rec.onStep(step);
        });
        expect(rb.mode).toBe(to);
        expect(rb.bits).toEqual(ENTRY_MODE_BITS[to]);
        expect(observe(fake).mode).toBe(to);
        assertNoWindow(rec.seen, from, to);
        expect(loadedAtStep.every(Boolean)).toBe(true);
        expect(forbiddenCalls(fake, baseline)).toEqual([]);
        expect(fake.reloadCount).toBe(0);
        expect(fake.calls.reloadProfile).toBeUndefined();
        expect(fake.calls.updateExternalResource).toBeUndefined();
        // 每一步只改写一个入口规则集文件，由文件监视重新加载（不是配置重载）。
        expect(fake.watcherReloads.length - reloadsBefore).toBe(rec.seen.length);
        for (const bit of ['udp', 'verify', 'block', 'active'] as const) expect(parseEntryRuleSetFile(bit, (await files.read(ENTRY_RULESET_FILES[bit]))!).witness).not.toBeNull();
        // QUIC 与 UDP 一样：受控模式下拒绝（回落 TCP），NORMAL 时按原规则
        expect(await quicPolicies(fake)).toEqual(to === 'NORMAL' ? ['DIRECT', 'DIRECT'] : ['REJECT', 'REJECT']);
      });
    }
  }

  test('a write masked by block (active while block is on) is still confirmed by its witness before block comes off', async () => {
    const { ctrl, fake, sleeps } = await setupRuleset({ latencyMs: 450 });
    const rec = stepRecorder(fake);
    const order: string[] = [];
    const rb = await ctrl.transition('ACTIVE', (step) => {
      order.push(`${step.bit}${step.value ? '+' : '-'}`);
      // block 打开时 active 的新内容对 Safari 不可见；见证证明它已加载
      expect(fake.loadedContent(`ruleset:${ENTRY_RULESET_FILES[step.bit]}`)).toBe(readFileSync(join(dir, ENTRY_RULESET_FILES[step.bit]), 'utf8'));
      rec.onStep(step);
    });
    expect(order).toEqual(['block+', 'udp+', 'active+', 'block-']);
    expect(rb.mode).toBe('ACTIVE');
    assertNoWindow(rec.seen, 'NORMAL', 'ACTIVE');
    // 每一步都等到监视器重新加载（450 ms 的延迟，按 100 ms 轮询）
    expect(sleeps.length).toBeGreaterThanOrEqual(4 * 4);
  });

  test('a watcher that does not reload in time: READBACK_MISMATCH (watch_timeout), the file is restored and the stricter state stays confirmed', async () => {
    const { ctrl, fake, files, ownership } = await setupRuleset();
    const rec = stepRecorder(fake);
    const err = (await ctrl
      .transition('ACTIVE', (step) => {
        rec.onStep(step);
        // 第二步之后监视器变慢：被 block 遮住的 active 写入读不到见证
        if (rec.seen.length === 2) fake.localWatchLatencyMs = 60_000;
      })
      .catch((e: unknown) => e)) as SfeError;
    expect(err).toBeInstanceOf(SfeError);
    expect(err.code).toBe('READBACK_MISMATCH');
    expect(err.details).toMatchObject({ reason: 'watch_timeout', restored: true, lastConfirmedBits: ENTRY_MODE_BITS.BLOCKED, failedStep: { bit: 'active', value: true } });
    assertNoWindow(rec.seen, 'NORMAL', 'ACTIVE');
    expect(observe(fake).mode).toBe('BLOCKED');
    // 文件已改回写前内容，记录按写前摘要确认
    const active = (await files.read(ENTRY_RULESET_FILES.active))!;
    expect(parseEntryRuleSetFile('active', active)).toEqual({ witness: 'off', bodies: [ENTRY_PLACEHOLDER_RULE] });
    expect(ownership.records().find((r) => r.identity === ENTRY_RULESET_FILES.active)).toMatchObject({ state: 'present', digest: await files.digest(ENTRY_RULESET_FILES.active) });
    expect((await ctrl.read()).mode).toBe('BLOCKED');
    // 监视恢复后可以继续完成切换
    fake.localWatchLatencyMs = 0;
    expect((await ctrl.transition('ACTIVE')).mode).toBe('ACTIVE');
    expect(observe(fake).mode).toBe('ACTIVE');
  });

  test('a watcher slower than the limit on a tightening step (normal mode from ACTIVE): the stricter file stays written, Safari ends BLOCKED once the watcher catches up, the next attempt settles it from the witness', async () => {
    const { ctrl, fake, files, ownership, clock } = await setupRuleset({ watch: { timeoutMs: 5000, pollMs: 200 } });
    expect((await ctrl.transition('ACTIVE')).mode).toBe('ACTIVE');
    fake.localWatchLatencyMs = 6000;
    const undo = { undo: true, towardNormal: true } as const;
    const err = (await ctrl.transition('BLOCKED', undefined, undo).catch((e: unknown) => e)) as SfeError;
    expect(err.code).toBe('READBACK_MISMATCH');
    // 收紧的一步不改回：不声称任何已确认状态，意图保持 pending
    expect(err.details).toMatchObject({ reason: 'watch_timeout', restored: false, keptStricter: true, lastConfirmedBits: null, failedStep: { bit: 'block', value: true } });
    const blockFile = (await files.read(ENTRY_RULESET_FILES.block))!;
    expect(parseEntryRuleSetFile('block', blockFile).bodies).toEqual(entryRules('block', true, CFG));
    expect(ownership.records().find((r) => r.identity === ENTRY_RULESET_FILES.block)!.state).toBe('pending_add');
    // 监视赶上之前 Safari 仍是起点（从不更宽松），赶上之后是 BLOCKED
    expect(observe(fake).mode).toBe('ACTIVE');
    clock.t += 10_000;
    expect(observe(fake).mode).toBe('BLOCKED');
    // 下一次尝试：见证读到已加载的 block → 按事实确认归属、不再重写；下一步（active-，也是收紧）照样保留
    const err2 = (await ctrl.transition('BLOCKED', undefined, undo).catch((e: unknown) => e)) as SfeError;
    expect(err2.details).toMatchObject({ reason: 'watch_timeout', keptStricter: true, failedStep: { bit: 'active', value: false } });
    expect(await files.read(ENTRY_RULESET_FILES.block)).toBe(blockFile);
    expect(ownership.records().find((r) => r.identity === ENTRY_RULESET_FILES.block)!.state).toBe('present');
    expect(observe(fake).mode).toBe('BLOCKED');
    clock.t += 10_000;
    fake.localWatchLatencyMs = 0;
    const steps: string[] = [];
    expect((await ctrl.transition('BLOCKED', (st) => steps.push(`${st.bit}${st.value ? '+' : '-'}`), undo)).mode).toBe('BLOCKED');
    expect(steps).toEqual([]);
    expect(ownership.records().every((r) => r.state === 'present')).toBe(true);
    expect((await ctrl.transition('NORMAL', undefined, { undo: true })).mode).toBe('NORMAL');
    expect(observe(fake).mode).toBe('NORMAL');
  });

  test('a slow watcher on a tightening rollback step (VERIFY_ONLY → BLOCKED: verify off) keeps the stricter file', async () => {
    const { ctrl, fake, files, clock } = await setupRuleset({ watch: { timeoutMs: 5000, pollMs: 200 } });
    expect((await ctrl.transition('VERIFY_ONLY')).mode).toBe('VERIFY_ONLY');
    fake.localWatchLatencyMs = 6000;
    const err = (await ctrl.transition('BLOCKED', undefined, { undo: true }).catch((e: unknown) => e)) as SfeError;
    expect(err.details).toMatchObject({ reason: 'watch_timeout', restored: false, lastConfirmedBits: null, failedStep: { bit: 'verify', value: false } });
    expect(parseEntryRuleSetFile('verify', (await files.read(ENTRY_RULESET_FILES.verify))!).bodies).toEqual([ENTRY_PLACEHOLDER_RULE]);
    clock.t += 10_000;
    expect(observe(fake).mode).toBe('BLOCKED');
  });

  test('a watcher slower than the limit for the whole ACTIVE → NORMAL undo: the loosening NORMAL steps are kept too (not written back), retries finish NORMAL without re-opening udp', async () => {
    const { ctrl, fake, files, ownership, clock } = await setupRuleset({ watch: { timeoutMs: 5000, pollMs: 200 } });
    expect((await ctrl.transition('ACTIVE')).mode).toBe('ACTIVE');
    // 监视延迟一直高于上限（之前的测试在 NORMAL 一段之前把延迟改回 0，看不到撤销中放宽的一步被改回）
    fake.localWatchLatencyMs = 6000;
    // 记录每一次入口文件写入（超时的步骤不调用 onStep）：位与写入的取值
    const writes: string[] = [];
    const write = files.writeAtomic.bind(files);
    files.writeAtomic = async (name, content, expected) => {
      const bit = (['udp', 'verify', 'block', 'active'] as const).find((b) => ENTRY_RULESET_FILES[b] === name)!;
      const on = parseEntryRuleSetFile(bit, content).bodies[0] !== ENTRY_PLACEHOLDER_RULE;
      writes.push(`${bit}${on ? '+' : '-'}`);
      return write(name, content, expected);
    };
    const errors: Array<Record<string, unknown>> = [];
    const modes: Array<KnownEntryMode | null> = [];
    const onStep = (): void => undefined;
    // 与普通模式相同：每次尝试先中间阻断（towardNormal），再撤销入口到 NORMAL；任一段失败即结束这次尝试，下一次相隔 60 秒
    let done = false;
    for (let attempt = 0; attempt < 8 && !done; attempt++) {
      try {
        const blocked = await ctrl.transition('BLOCKED', onStep, { undo: true, towardNormal: true });
        if (blocked.mode !== 'NORMAL') expect(blocked.mode).toBe('BLOCKED');
        done = (await ctrl.transition('NORMAL', onStep, { undo: true })).mode === 'NORMAL';
      } catch (e) {
        expect(e).toBeInstanceOf(SfeError);
        errors.push((e as SfeError).details!);
      }
      clock.t += 60_000;
      const o = observe(fake);
      modes.push(o.mode);
      expect(o.chrome).toEqual(['DIRECT', 'DIRECT']);
    }
    expect(done).toBe(true);
    // 每一位只写入一次：udp- 之后从不重新打开 udp，也没有任何一步被改回再重写
    expect(writes).toEqual(['block+', 'active-', 'udp-', 'block-']);
    expect(errors).toEqual([
      expect.objectContaining({ reason: 'watch_timeout', restored: false, keptStricter: true, lastConfirmedBits: null, failedStep: { bit: 'block', value: true } }),
      expect.objectContaining({ reason: 'watch_timeout', restored: false, keptStricter: true, lastConfirmedBits: null, failedStep: { bit: 'active', value: false } }),
      expect.objectContaining({ reason: 'watch_timeout', restored: false, keptTowardTarget: true, lastConfirmedBits: null, failedStep: { bit: 'udp', value: false } }),
      expect.objectContaining({ reason: 'watch_timeout', restored: false, keptTowardTarget: true, lastConfirmedBits: null, failedStep: { bit: 'block', value: false } }),
    ]);
    // 监视赶上之后 Safari 一直是阻断（udp 关闭被 block 遮住），block- 被加载后是 NORMAL（第五次尝试按见证确认、不写入）；
    // 从不经过 VERIFY_ONLY/ACTIVE
    expect(modes).toEqual(['BLOCKED', 'BLOCKED', 'BLOCKED', 'NORMAL', 'NORMAL']);
    expect(observe(fake).mode).toBe('NORMAL');
    expect((await ctrl.read()).mode).toBe('NORMAL');
    for (const bit of ['udp', 'verify', 'block', 'active'] as const) expect(parseEntryRuleSetFile(bit, (await files.read(ENTRY_RULESET_FILES[bit]))!).bodies).toEqual([ENTRY_PLACEHOLDER_RULE]);
    expect(ownership.records().every((r) => r.state === 'present')).toBe(true);
    expect(fake.reloadCount).toBe(0);
    expect(fake.calls.updateExternalResource).toBeUndefined();
  });

  test('…retries spaced below the watcher latency: the intermediate block never re-tightens a kept udp-/block- that is not loaded yet, normal mode finishes', async () => {
    const { ctrl, fake, files, ownership, clock } = await setupRuleset({ watch: { timeoutMs: 5000, pollMs: 200 } });
    expect((await ctrl.transition('ACTIVE')).mode).toBe('ACTIVE');
    // 监视延迟 60 秒，重试相隔 30 秒：每次重试时上一次保留的写入都还没有加载
    fake.localWatchLatencyMs = 60_000;
    const writes: string[] = [];
    const write = files.writeAtomic.bind(files);
    files.writeAtomic = async (name, content, expected) => {
      const bit = (['udp', 'verify', 'block', 'active'] as const).find((b) => ENTRY_RULESET_FILES[b] === name)!;
      const on = parseEntryRuleSetFile(bit, content).bodies[0] !== ENTRY_PLACEHOLDER_RULE;
      writes.push(`${bit}${on ? '+' : '-'}`);
      return write(name, content, expected);
    };
    const kept: Array<Array<'udp' | 'block'> | undefined> = [];
    const errors: Array<{ message: string; details: Record<string, unknown> }> = [];
    let done = false;
    for (let attempt = 0; attempt < 12 && !done; attempt++) {
      try {
        const blocked = await ctrl.transition('BLOCKED', undefined, { undo: true, towardNormal: true });
        kept.push(blocked.keptTowardNormal);
        done = (await ctrl.transition('NORMAL', undefined, { undo: true })).mode === 'NORMAL';
      } catch (e) {
        expect(e).toBeInstanceOf(SfeError);
        errors.push({ message: (e as SfeError).message, details: (e as SfeError).details! });
      }
      clock.t += 30_000;
      const o = observe(fake);
      expect(['BLOCKED', 'NORMAL', 'ACTIVE']).toContain(o.mode);
      expect(o.chrome).toEqual(['DIRECT', 'DIRECT']);
    }
    expect(done).toBe(true);
    // 收紧的一步在加载之前重写同样的内容；udp-、block- 写入之后从不重新打开（不在两段之间来回写入）
    expect(writes).toEqual(['block+', 'block+', 'active-', 'active-', 'udp-', 'udp-', 'block-', 'block-']);
    expect(kept.filter((k) => k !== undefined)).toEqual([['udp'], ['block']]);
    expect(errors.map((e) => e.details.failedStep)).toEqual([
      { bit: 'block', value: true },
      { bit: 'block', value: true },
      { bit: 'active', value: false },
      { bit: 'active', value: false },
      { bit: 'udp', value: false },
      { bit: 'udp', value: false },
      { bit: 'block', value: false },
      { bit: 'block', value: false },
    ]);
    // 保留写入的超时提示等待文件监视，而不是立即重试
    for (const e of errors) expect(e.message).toContain('请等 Surge 的文件监视加载之后再重试');
    expect(observe(fake).mode).toBe('NORMAL');
    expect((await ctrl.read()).mode).toBe('NORMAL');
    expect(ownership.records().every((r) => r.state === 'present')).toBe(true);
    expect(fake.reloadCount).toBe(0);
  });

  test('normal mode’s intermediate block after udp was already turned off (block on, verify/active off, all witnessed) writes nothing and reports BLOCKED; a rollback still re-opens udp', async () => {
    const { ctrl, fake, files } = await setupRuleset();
    expect((await ctrl.transition('BLOCKED')).mode).toBe('BLOCKED');
    // 上一次普通模式在 NORMAL 一段关闭了 udp，之后失败（block- 之前）
    const err = (await ctrl
      .transition('NORMAL', (st) => {
        if (st.bit === 'udp') fake.failNext('listExternalResources', new SfeError('SURGE_UNREACHABLE', '连接 Surge 失败：命令超时'));
      }, { undo: true })
      .catch((e: unknown) => e)) as SfeError;
    expect(err.details).toMatchObject({ failedStep: { bit: 'block', value: false } });
    expect(observe(fake).mode).toBe('BLOCKED');
    const before = { udp: await files.read(ENTRY_RULESET_FILES.udp), reloads: fake.watcherReloads.length };
    const rb = await ctrl.transition('BLOCKED', undefined, { undo: true, towardNormal: true });
    expect(rb.mode).toBe('BLOCKED');
    expect(rb.bits).toEqual({ udp: false, verify: false, block: true, active: false });
    expect(rb.evidence.join(' ')).toContain('普通模式的中间阻断已成立');
    expect({ udp: await files.read(ENTRY_RULESET_FILES.udp), reloads: fake.watcherReloads.length }).toEqual(before);
    expect((await ctrl.transition('NORMAL', undefined, { undo: true })).mode).toBe('NORMAL');
    // 回滚（不是普通模式）照常回到 BLOCKED 的位组合
    expect((await ctrl.transition('BLOCKED')).mode).toBe('BLOCKED');
    await ctrl.transition('NORMAL', (st) => {
      if (st.bit === 'udp') fake.failNext('listExternalResources', new SfeError('SURGE_UNREACHABLE', '连接 Surge 失败：命令超时'));
    }, { undo: true }).catch(() => undefined);
    const steps: string[] = [];
    expect((await ctrl.transition('BLOCKED', (st) => steps.push(`${st.bit}${st.value ? '+' : '-'}`), { undo: true })).mode).toBe('BLOCKED');
    expect(steps).toEqual(['udp+']);
  });

  test('the same already-established intermediate block with a blocking module rule ahead: still no write, the issues come back with the BLOCKED readback', async () => {
    const { ctrl, fake, files } = await setupRuleset();
    expect((await ctrl.transition('BLOCKED')).mode).toBe('BLOCKED');
    await ctrl
      .transition('NORMAL', (st) => {
        if (st.bit === 'udp') fake.failNext('listExternalResources', new SfeError('SURGE_UNREACHABLE', '连接 Surge 失败：命令超时'));
      }, { undo: true })
      .catch(() => undefined);
    // 模块规则排在入口之前、会命中 Safari 访问站点的流量（可能放行）
    fake.setModuleRules([{ text: `DOMAIN,${SITE},DIRECT`, moduleName: 'user-module' }]);
    const udpBefore = await files.read(ENTRY_RULESET_FILES.udp);
    const rb = await ctrl.transition('BLOCKED', undefined, { undo: true, towardNormal: true });
    expect(rb.mode).toBe('BLOCKED');
    expect(rb.precedenceIssues).toContainEqual(expect.objectContaining({ rule: `DOMAIN,${SITE},DIRECT`, severity: 'blocking' }));
    expect(rb.evidence).toContain('有规则排在入口之前');
    expect(await files.read(ENTRY_RULESET_FILES.udp)).toBe(udpBefore);
    expect((await ctrl.transition('NORMAL', undefined, { undo: true })).mode).toBe('NORMAL');
  });

  test('a rule match read failing mid-wait leaves the outcome unknown (no claim); the next transition plans from the permissive side', async () => {
    const { ctrl, fake } = await setupRuleset();
    await ctrl.transition('BLOCKED');
    const rec = stepRecorder(fake);
    // BLOCKED → ACTIVE：active+、block-；第二步写入之后等待见证时读取失败
    const err = (await ctrl
      .transition('ACTIVE', (step) => {
        rec.onStep(step);
        fake.failNext('matchRule', new SfeError('SURGE_UNREACHABLE', '连接 Surge 失败：命令超时'));
      })
      .catch((e: unknown) => e)) as SfeError;
    expect(err).toBeInstanceOf(SfeError);
    expect(err.code).toBe('SURGE_UNREACHABLE');
    expect(rec.seen.length).toBe(1);
    expect(err.details).toMatchObject({ lastConfirmedBits: null, failedStep: { bit: 'block', value: false } });
    expect(['BLOCKED', 'ACTIVE']).toContain(observe(fake).mode);
    const rb = await ctrl.read();
    expect(rb.mode).toBe('UNKNOWN');
    expect(rb.evidence).toContain('异常：pending_block');
    const after = stepRecorder(fake);
    const steps: string[] = [];
    expect(
      (
        await ctrl.transition('BLOCKED', (st) => {
          steps.push(`${st.bit}${st.value ? '+' : '-'}`);
          after.onStep(st);
        })
      ).mode,
    ).toBe('BLOCKED');
    // block 的已加载内容未知：按关闭规划，第一步重新打开 block
    expect(steps[0]).toBe('block+');
    assertNoWindow(after.seen, 'ACTIVE', 'BLOCKED');
  });

  test('rule match that disagrees with the loaded rule sets (for example Safari probes not seeing them): read is UNKNOWN and every transition fails closed', async () => {
    const { ctrl, fake } = await setupRuleset({
      adapter: (f) => rewriteMatch(f, (input, real) => (input.processPath === FAKE_SAFARI_PATH ? { rule: 'FINAL,DIRECT', policy: 'DIRECT' } : real)),
    });
    // NORMAL：Safari 本来就不命中本应用规则，一致
    expect((await ctrl.read()).mode).toBe('NORMAL');
    const err = (await ctrl.transition('BLOCKED').catch((e: unknown) => e)) as SfeError;
    expect(err.code).toBe('READBACK_MISMATCH');
    expect(err.details!.lastConfirmedBits).toBeNull();
    expect((err.details!.runtime as string[]).join(' ')).toContain('没有命中本应用入口规则');
    const rb = await ctrl.read();
    expect(rb.mode).toBe('UNKNOWN');
    expect(observe(fake).mode).toBe('BLOCKED'); // 真实效果更严格；读回不宣称
  });

  for (const [label, echo] of [
    ['the RULE-SET line without its policy', (rule: string) => rule.replace(/,(REJECT|SFE-ROUTE)$/, '')],
    [
      'the matched sub-rule of the set (block and active share it: told apart by the policy)',
      (rule: string, host: string) => {
        const bit = /^RULE-SET,sfe-entry-(udp|verify|block|active)\.list,/.exec(rule)?.[1] as 'udp' | 'verify' | 'block' | 'active' | undefined;
        if (!bit) return rule;
        return host.startsWith('sfe-entry-') ? `AND,((PROCESS-NAME,${ENTRY_WITNESS_PROCESS_PATH}),(DOMAIN,${host}))` : entryRules(bit, true, CFG)[0]!;
      },
    ],
  ] as const) {
    test(`rule match echoing ${label} is still recognised (witness and Safari probes)`, async () => {
      const { ctrl, fake } = await setupRuleset({
        adapter: (f) => rewriteMatch(f, (input, real) => ({ rule: echo(real.rule, input.host), policy: real.policy })),
      });
      const rec = stepRecorder(fake);
      expect((await ctrl.transition('ACTIVE', rec.onStep)).mode).toBe('ACTIVE');
      assertNoWindow(rec.seen, 'NORMAL', 'ACTIVE');
      expect((await ctrl.read()).mode).toBe('ACTIVE');
    });
  }

  test('a Chrome (control) probe that hits an entry rule set is never accepted', async () => {
    const { ctrl } = await setupRuleset({
      adapter: (f) =>
        rewriteMatch(f, (input, real) => (input.processPath === FAKE_CHROME_PATH && input.protocol === 'TCP' ? { rule: 'RULE-SET,sfe-entry-active.list,SFE-ROUTE', policy: 'SFE-ROUTE' } : real)),
    });
    const rb = await ctrl.read();
    expect(rb.mode).toBe('UNKNOWN');
    expect(rb.evidence.join(' ')).toContain('对照进程');
    const err = (await ctrl.transition('BLOCKED').catch((e: unknown) => e)) as SfeError;
    expect(err.code).toBe('READBACK_MISMATCH');
    expect(err.details).toMatchObject({ controlHit: true, lastConfirmedBits: null });
  });

  test('refuses before writing when the auto-reload setting differs from the verified condition', async () => {
    const { ctrl, fake, files, cond } = await setupRuleset();
    const before = await files.digest(ENTRY_RULESET_FILES.block);
    cond.value = 'on';
    const err = (await ctrl.transition('BLOCKED').catch((e: unknown) => e)) as SfeError;
    expect(err.code).toBe('CAPABILITY_UNVERIFIED');
    expect(err.details).toMatchObject({ lastConfirmedBits: ENTRY_MODE_BITS.NORMAL, autoReload: false, verifiedCondition: 'on' });
    expect(await files.digest(ENTRY_RULESET_FILES.block)).toBe(before);
    expect(fake.calls.updateExternalResource).toBeUndefined();
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
    // 文件监视会加载外部修改（文档行为）：Safari 被用户的修改阻断，与本应用无关
    expect(observe(fake).mode).toBe('BLOCKED');
    const err = (await ctrl.transition('ACTIVE').catch((e: unknown) => e)) as SfeError;
    expect(err.code).toBe('BASELINE_CHANGED');
    expect(err.details!.lastConfirmedBits).toBeNull();
    await expect(ctrl.transition('BLOCKED')).rejects.toMatchObject({ code: 'BASELINE_CHANGED' });
    expect(readFileSync(join(dir, ENTRY_RULESET_FILES.block), 'utf8')).toBe(entryRuleSetFileContent('block', true, CFG));
    // 撤销本应用入口（undo）不能被一个被编辑的本应用文件卡住：按载入时的摘要比较后改写。
    const rec = stepRecorder(fake);
    expect((await ctrl.transition('NORMAL', rec.onStep, { undo: true })).mode).toBe('NORMAL');
    assertNoWindow(rec.seen, 'BLOCKED', 'NORMAL');
    expect(observe(fake).mode).toBe('NORMAL');
    expect(parseEntryRuleSetFile('block', (await files.read(ENTRY_RULESET_FILES.block))!).bodies).toEqual([ENTRY_PLACEHOLDER_RULE]);
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
    // BLOCKED 仍按计划写入（见证确认加载；Safari 的探测被模块规则遮住），但最终读回不能宣称受控。
    await expect(ctrl.transition('BLOCKED')).rejects.toMatchObject({ code: 'PRECEDENCE_VIOLATION', details: { lastConfirmedBits: ENTRY_MODE_BITS.BLOCKED } });
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

  test('recovers from a crash between file write and reload without a permissive window', async () => {
    const { ctrl, fake, ownership, files } = await setupRuleset();
    await ctrl.transition('BLOCKED');
    // 模拟崩溃：中途写入了 active 文件（没有见证），意图仍为 pending；监视器会加载它，但它被 block 遮住。
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

  test('legacy files without a witness: NORMAL is still read from the Safari probes; the first transition rewrites every file from the permissive side', async () => {
    const { ctrl, fake, files, ownership } = await setupRuleset();
    for (const bit of ['udp', 'verify', 'block', 'active'] as const) {
      const name = ENTRY_RULESET_FILES[bit];
      await files.writeAtomic(name, entryRuleSetFileContent(bit, false, CFG, null), await files.digest(name));
      await ownership.confirm('entry_ruleset_file', name, 'present', await files.digest(name));
    }
    const rb = await ctrl.read();
    expect(rb.mode).toBe('NORMAL');
    expect(rb.evidence).toContain('规则集 active：文件没有见证规则');
    const rec = stepRecorder(fake);
    const steps: string[] = [];
    expect(
      (
        await ctrl.transition('BLOCKED', (st) => {
          steps.push(`${st.bit}${st.value ? '+' : '-'}`);
          rec.onStep(st);
        })
      ).mode,
    ).toBe('BLOCKED');
    expect(steps).toEqual(['block+', 'udp+', 'verify-', 'active-']);
    assertNoWindow(rec.seen, 'NORMAL', 'BLOCKED');
    expect((await ctrl.read()).evidence.filter((e) => e.includes('见证一致'))).toHaveLength(4);
  });

  test('pre-witness files of the earlier format (bare DOMAIN placeholder that any process matches) are recognised as off, reported, and rewritten scoped by the next transition', async () => {
    const { ctrl, fake, files, ownership } = await setupRuleset();
    for (const bit of ['udp', 'verify', 'block', 'active'] as const) {
      const name = ENTRY_RULESET_FILES[bit];
      await files.writeAtomic(name, `# SFE managed entry rule set · ${bit}\n${LEGACY_ENTRY_PLACEHOLDER_RULE}\n`, await files.digest(name));
      await ownership.confirm('entry_ruleset_file', name, 'present', await files.digest(name));
    }
    // 旧占位规则不限定进程：Chrome 请求 sfe-disabled.invalid 命中 udp 规则集（REJECT）——读回写明，下一次切换改写
    expect(fake.simulateRequest({ processPath: FAKE_CHROME_PATH, host: 'sfe-disabled.invalid', protocol: 'tcp' }).rule).toBe('RULE-SET,sfe-entry-udp.list,REJECT');
    const rb = await ctrl.read();
    expect(rb.bits).toEqual(ENTRY_MODE_BITS.NORMAL);
    expect(rb.mode).toBe('NORMAL');
    expect(rb.evidence.join(' ')).toContain('旧格式占位规则');
    const rec = stepRecorder(fake);
    expect((await ctrl.transition('BLOCKED', rec.onStep)).mode).toBe('BLOCKED');
    assertNoWindow(rec.seen, 'NORMAL', 'BLOCKED');
    expect((await ctrl.transition('NORMAL', undefined, { undo: true })).mode).toBe('NORMAL');
    expect((await ctrl.read()).evidence.join(' ')).not.toContain('旧格式占位规则');
    for (const bit of ['udp', 'verify', 'block', 'active'] as const) {
      expect(parseEntryRuleSetFile(bit, (await files.read(ENTRY_RULESET_FILES[bit]))!)).toMatchObject({ bodies: [ENTRY_PLACEHOLDER_RULE] });
    }
    expect(fake.simulateRequest({ processPath: FAKE_CHROME_PATH, host: 'sfe-disabled.invalid', protocol: 'tcp' }).policyName).toBe('DIRECT');
  });

  test('witness and placeholder hosts never route Chrome (or any non-witness process): every bit, the public off token and random tokens, in every mode', async () => {
    const { ctrl, fake, files } = await setupRuleset();
    const otherApps = [FAKE_CHROME_PATH, '/usr/bin/curl', null];
    const check = async (label: string): Promise<void> => {
      const hosts = ['sfe-disabled.invalid'];
      for (const bit of ['udp', 'verify', 'block', 'active'] as const) {
        const witness = parseEntryRuleSetFile(bit, (await files.read(ENTRY_RULESET_FILES[bit]))!).witness;
        expect(witness, `${label} ${bit}`).not.toBeNull();
        hosts.push(entryWitnessHost(bit, witness!), entryWitnessHost(bit, 'off'));
        // 合成见证进程照样读回该位的见证（证明见证仍然有效）
        const w = await fake.matchRule({ host: entryWitnessHost(bit, witness!), processPath: ENTRY_WITNESS_PROCESS_PATH, protocol: 'TCP' });
        expect(w.rule, `${label} ${bit}`).toBe(`RULE-SET,${ENTRY_RULESET_FILES[bit]},${bit === 'udp' || bit === 'block' ? 'REJECT' : 'SFE-ROUTE'}`);
      }
      for (const host of hosts) {
        for (const processPath of otherApps) {
          for (const protocol of ['tcp', 'udp'] as const) {
            const r = fake.simulateRequest({ processPath, host, protocol });
            expect(r.rule, `${label} ${processPath} ${host} ${protocol}`).not.toMatch(/^RULE-SET,sfe-entry-/);
            expect(r.policyName, `${label} ${processPath} ${host} ${protocol}`).not.toBe('SFE-ROUTE');
            const m = await fake.matchRule({ host, processPath: processPath ?? '/usr/libexec/unknown', protocol: protocol === 'udp' ? 'UDP' : 'TCP' });
            expect(m.rule, `${label} match ${host}`).not.toMatch(/^RULE-SET,sfe-entry-/);
            expect(m.policy).not.toBe('SFE-ROUTE');
          }
        }
      }
    };
    await check('initial NORMAL');
    for (const to of ['BLOCKED', 'VERIFY_ONLY', 'ACTIVE', 'VERIFY_ONLY', 'NORMAL', 'ACTIVE', 'BLOCKED', 'NORMAL'] as const) {
      expect((await ctrl.transition(to, undefined, to === 'NORMAL' || to === 'BLOCKED' ? { undo: true } : undefined)).mode).toBe(to);
      await check(to);
    }
  });

  test('the readback probes the control process against every witness host and the placeholder host', async () => {
    const seen: string[] = [];
    const { ctrl } = await setupRuleset({
      adapter: (f) =>
        rewriteMatch(f, (input, real) => {
          if (input.processPath === FAKE_CHROME_PATH) seen.push(input.host);
          return real;
        }),
    });
    expect((await ctrl.read()).mode).toBe('NORMAL');
    expect(new Set(seen)).toEqual(new Set([FAKE_VERIFY_HOST, SITE, 'sfe-disabled.invalid', ...(['udp', 'verify', 'block', 'active'] as const).map((b) => entryWitnessHost(b, 'off'))]));
    // 对照进程命中某一位的见证（例如见证不限定进程的写法）：读回不宣称任何模式
    const { ctrl: leaky } = await setupRuleset({
      adapter: (f) =>
        rewriteMatch(f, (input, real) =>
          input.processPath === FAKE_CHROME_PATH && input.host === entryWitnessHost('active', 'off') ? { rule: 'RULE-SET,sfe-entry-active.list,SFE-ROUTE', policy: 'SFE-ROUTE' } : real,
        ),
    });
    const rb = await leaky.read();
    expect(rb.mode).toBe('UNKNOWN');
    expect(rb.evidence.join(' ')).toContain('对照进程');
  });

  test('with auto reload on and a matching verified condition the transition works (reloads are counted for P0 evidence)', async () => {
    const { ctrl, fake } = await setupRuleset({ autoReload: true });
    expect((await ctrl.transition('ACTIVE')).mode).toBe('ACTIVE');
    expect(observe(fake).mode).toBe('ACTIVE');
    expect(fake.autoReloadCount).toBeGreaterThan(0);
    expect(fake.calls.reloadProfile).toBeUndefined();
  });
});

// ---------- 能力指纹覆盖入口实际调用的原语 ----------

describe('capability fingerprints cover the primitives the entry strategies call', () => {
  for (const strategy of ['temp_rule', 'ruleset_resource'] as const) {
    test(`${strategy}: every primitive called across all transitions is fingerprinted by an activation-gate capability (a mapping change makes it stale)`, async () => {
      const { ctrl, fake } = strategy === 'temp_rule' ? await setupTemp({ fakeInsertion: 'head', strategyInsertion: 'head' }) : await setupRuleset();
      const baseline = { ...fake.calls };
      for (const to of ['BLOCKED', 'VERIFY_ONLY', 'ACTIVE', 'VERIFY_ONLY', 'BLOCKED', 'NORMAL'] as const) {
        expect((await ctrl.transition(to, undefined, to === 'BLOCKED' || to === 'NORMAL' ? { undo: true } : undefined)).mode).toBe(to);
      }
      await ctrl.read();
      const called = Object.keys(fake.calls).filter((k) => fake.calls[k] !== baseline[k]);
      const gates = strategy === 'ruleset_resource' ? [...CAPABILITY_GATES.activate, ...CAPABILITY_GATES.activateRulesetStrategy] : [...CAPABILITY_GATES.activate];
      const fingerprinted = new Set(gates.flatMap((k) => [...(CAPABILITY_PRIMITIVES[k] ?? [])]));
      expect(called).toContain('matchRule');
      expect(called.filter((p) => !fingerprinted.has(p))).toEqual([]);
    });
  }
});

// ---------- ruleset_resource：撤销入口时 rule match 不可用（降级、原语未映射） ----------

describe('ruleset_resource strategy: undo when rule match is unavailable', () => {
  const unmapped = (): Error => new SfeError('CAPABILITY_UNVERIFIED', '调用 Surge 失败：原语 matchRule 在当前实现中尚未通过实测', { details: { primitive: 'matchRule' } });

  for (const [label, makeUnavailable] of [
    ['Surge downgraded below 6.9 (rule match answers Unknown command)', (fake: FakeSurge) => fake.changeVersion({ version: '6.8.1', build: '12030', controllerProtocol: 18 })],
    ['matchRule not mapped (install.json older than the primitive)', null],
  ] as const) {
    test(`${label}: ACTIVE → BLOCKED → NORMAL completes in the planned order, waiting the full watch limit per step, reported as not runtime-confirmed`, async () => {
      const { ctrl, fake, files, sleeps, ownership } = await setupRuleset({
        watch: { timeoutMs: 3000, pollMs: 100 },
        ...(makeUnavailable === null ? { adapter: (f: FakeSurge) => throwingMatch(f, unmapped) } : {}),
      });
      if (makeUnavailable === null) {
        // 未映射：适配器在创建时注入，无法先用真实 rule match 激活；直接写入 ACTIVE 的文件并按已确认登记
        // （与带见证的写入结果相同）。
        await writeConfirmedMode(files, ownership, fake, 'ACTIVE');
      } else {
        expect((await ctrl.transition('ACTIVE')).mode).toBe('ACTIVE');
        makeUnavailable(fake);
      }
      expect(observe(fake).mode).toBe('ACTIVE');
      const rb = await ctrl.read();
      expect(rb.mode).toBe('UNKNOWN');
      expect(rb.evidence.join(' ')).toContain('规则求值不可用');
      const rec = stepRecorder(fake);
      const steps: string[] = [];
      const before = sleeps.length;
      const blocked = await ctrl.transition(
        'BLOCKED',
        (st) => {
          steps.push(`${st.bit}${st.value ? '+' : '-'}`);
          rec.onStep(st);
        },
        { undo: true, towardNormal: true },
      );
      expect(blocked).toMatchObject({ mode: 'BLOCKED', runtimeConfirmed: false });
      expect(blocked.evidence.join(' ')).toContain('未经见证与运行时求值确认');
      // 已确认的文件按文件内容规划：只写需要的位，顺序与带见证时相同（先开 block）
      expect(steps).toEqual(['block+', 'active-']);
      assertNoWindow(rec.seen, 'ACTIVE', 'BLOCKED');
      expect(sleeps.slice(before)).toEqual([3000, 3000]);
      expect(observe(fake).mode).toBe('BLOCKED');
      const normal = await ctrl.transition('NORMAL', rec.onStep, { undo: true });
      expect(normal).toMatchObject({ mode: 'NORMAL', runtimeConfirmed: false });
      assertNoWindow(rec.seen, 'ACTIVE', 'NORMAL');
      expect(observe(fake).mode).toBe('NORMAL');
      for (const bit of ['udp', 'verify', 'block', 'active'] as const) {
        expect(parseEntryRuleSetFile(bit, (await files.read(ENTRY_RULESET_FILES[bit]))!).bodies).toEqual([ENTRY_PLACEHOLDER_RULE]);
      }
      expect(fake.calls.updateExternalResource).toBeUndefined();
      expect(fake.calls.reloadProfile).toBeUndefined();
    });
  }

  test('fallback from placeholder files (already NORMAL): the normal-mode blocking step writes nothing', async () => {
    const { ctrl, fake, sleeps } = await setupRuleset({ adapter: (f) => throwingMatch(f, unmapped) });
    const rb = await ctrl.transition('BLOCKED', undefined, { undo: true, towardNormal: true });
    expect(rb).toMatchObject({ mode: 'NORMAL', runtimeConfirmed: false });
    expect(sleeps).toEqual([]);
    expect(fake.watcherReloads.filter((r) => r.key.startsWith('ruleset:sfe-entry-'))).toEqual([]);
    expect((await ctrl.transition('NORMAL', undefined, { undo: true })).mode).toBe('NORMAL');
    expect(sleeps).toEqual([]);
  });

  test('activation (not undo) never uses the fallback: VERIFY_ONLY/ACTIVE need rule match', async () => {
    const { ctrl, fake } = await setupRuleset({ adapter: (f) => throwingMatch(f, unmapped) });
    const err = (await ctrl.transition('ACTIVE').catch((e: unknown) => e)) as SfeError;
    expect(err.code).toBe('CAPABILITY_UNVERIFIED');
    expect(err.details!.lastConfirmedBits).toBeNull();
    expect(observe(fake).mode).toBe('BLOCKED'); // 第一步开 block 之后停止：从不更宽松
  });

  test('a rule match timeout (result unknown) during undo is not treated as unavailable: it still fails closed', async () => {
    const { ctrl, fake } = await setupRuleset();
    expect((await ctrl.transition('ACTIVE')).mode).toBe('ACTIVE');
    fake.failNext('matchRule', new SfeError('SURGE_UNREACHABLE', '连接 Surge 失败：命令超时'));
    fake.failNext('matchRule', new SfeError('SURGE_UNREACHABLE', '连接 Surge 失败：命令超时'));
    const rb = await ctrl.read();
    expect(rb.mode).toBe('UNKNOWN');
    for (let i = 0; i < 40; i++) fake.failNext('matchRule', new SfeError('SURGE_UNREACHABLE', '连接 Surge 失败：命令超时'));
    const err = (await ctrl.transition('BLOCKED', undefined, { undo: true, towardNormal: true }).catch((e: unknown) => e)) as SfeError;
    expect(err.code).toBe('SURGE_UNREACHABLE');
    expect(err.details!.lastConfirmedBits).toBeNull();
  });

  test('fallback: a pending (unconfirmed) intent is planned from the permissive side and rewritten', async () => {
    const { ctrl, fake, files, ownership } = await setupRuleset({ adapter: (f) => throwingMatch(f, unmapped) });
    await writeConfirmedMode(files, ownership, fake, 'ACTIVE');
    // block 的写入意图没有确认（例如崩溃在写入之后）：文件是写后内容，Surge 是否已加载未知
    const name = ENTRY_RULESET_FILES.block;
    const content = entryRuleSetFileContent('block', true, CFG, 'ab12');
    await ownership.recordIntent('entry_ruleset_file', name, files.digestContent(content), 'op_x', 'add');
    await files.writeAtomic(name, content, await files.digest(name));
    const steps: string[] = [];
    expect((await ctrl.transition('BLOCKED', (st) => steps.push(`${st.bit}${st.value ? '+' : '-'}`), { undo: true, towardNormal: true })).mode).toBe('BLOCKED');
    expect(steps[0]).toBe('block+');
    expect(observe(fake).mode).toBe('BLOCKED');
  });
});

/** 直接写入某一模式的入口文件（带见证）并按已确认登记，等监视器加载（测试准备，不经策略）。 */
async function writeConfirmedMode(files: ManagedProfileFiles, ownership: MemoryEntryOwnership, fake: FakeSurge, mode: KnownEntryMode): Promise<void> {
  for (const bit of ['udp', 'verify', 'block', 'active'] as const) {
    const name = ENTRY_RULESET_FILES[bit];
    await files.writeAtomic(name, entryRuleSetFileContent(bit, ENTRY_MODE_BITS[mode][bit], CFG, `pre${bit}`), await files.digest(name));
    await ownership.confirm('entry_ruleset_file', name, 'present', await files.digest(name));
  }
  fake.checkFileChanges();
}

// ---------- temp_rule ----------

interface TempSetup {
  fake: FakeSurge;
  ownership: MemoryEntryOwnership;
  ctrl: EntryController;
}

/** 按规范集合直接建立起点（假 Surge 按尾部插入，不依赖插入位置）。 */
async function establish(fake: FakeSurge, ownership: MemoryEntryOwnership, start: KnownEntryMode, cfg = CFG): Promise<void> {
  const insertion = fake.tempRuleInsertion;
  fake.tempRuleInsertion = 'tail';
  for (const kind of TEMP_ENTRY_MODE_KINDS[start]) {
    const text = tempRuleText(kind, cfg);
    await fake.addTempRule(text);
    await ownership.confirm('temp_rule', text, 'present');
  }
  fake.tempRuleInsertion = insertion;
}

async function setupTemp(
  opts: { fakeInsertion: TempRuleInsertion; strategyInsertion?: TempRuleInsertion; start?: KnownEntryMode; userTemp?: string[]; adapter?: (fake: FakeSurge) => SurgeAdapter } = {
    fakeInsertion: 'tail',
  },
): Promise<TempSetup> {
  createFakeSurgeEnvironment(dir, { entryStrategy: 'temp_rule' });
  const fake = new FakeSurge({ directory: dir, tempRuleInsertion: 'tail', watchLocalPolicyPaths: true });
  await selectNode(fake);
  for (const t of opts.userTemp ?? []) await fake.addTempRule(t);
  const ownership = createMemoryEntryOwnership();
  await establish(fake, ownership, opts.start ?? 'NORMAL');
  fake.tempRuleInsertion = opts.fakeInsertion;
  const ctrl = createTempRuleStrategy({
    adapter: opts.adapter ? opts.adapter(fake) : fake,
    ownership,
    config: () => CFG,
    operationId: () => 'op_test',
    ...(opts.strategyInsertion ? { insertion: opts.strategyInsertion } : {}),
  });
  return { fake, ownership, ctrl };
}

/** 每次加入临时规则时按 choices 决定排在最前或最后（穷举任意插入位置）；choices 用完后按 head。 */
function arbitraryInsertion(fake: FakeSurge, choices: readonly TempRuleInsertion[]): SurgeAdapter {
  let i = 0;
  return new Proxy(fake, {
    get(target, prop) {
      if (prop === 'addTempRule') {
        return async (rule: string) => {
          target.tempRuleInsertion = choices[i++] ?? 'head';
          return target.addTempRule(rule);
        };
      }
      const v: unknown = Reflect.get(target, prop, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  }) as unknown as SurgeAdapter;
}

describe('temp_rule strategy', () => {
  for (const insertion of ['head', 'tail', 'unknown'] as const) {
    for (const from of MODES) {
      for (const to of MODES) {
        test(`[${insertion}] ${from} → ${to}: reaches the target with no permissive window, Chrome untouched, UDP/QUIC never routed`, async () => {
          const fakeInsertion = insertion === 'unknown' ? 'head' : insertion;
          const { ctrl, fake } = await setupTemp({ fakeInsertion, strategyInsertion: insertion === 'unknown' ? undefined : insertion, start: from });
          expect(observe(fake).mode).toBe(from);
          expect((await ctrl.read()).mode).toBe(from);
          const baseline = { ...fake.calls };
          const rec = stepRecorder(fake);
          const result = await ctrl.transition(to, rec.onStep);
          expect(result.mode).toBe(to);
          expect(result.bits).toEqual(ENTRY_MODE_BITS[to]);
          expect(observe(fake).mode).toBe(to);
          expect((await ctrl.read()).mode).toBe(to);
          expect(fake.tempRules.map(normalizeRuleText).sort()).toEqual(TEMP_ENTRY_MODE_KINDS[to].map((k) => normalizeRuleText(tempRuleText(k, CFG))).sort());
          assertNoWindow(rec.seen, from, to);
          // 每一步报告的位组合就是读回确认的模式
          for (const s of rec.seen) expect(s.step.bits).toEqual(ENTRY_MODE_BITS[s.mode!]);
          expect(await quicPolicies(fake)).toEqual(to === 'NORMAL' ? ['DIRECT', 'DIRECT'] : ['REJECT', 'REJECT']);
          // 每次写入之后都用 rule match 读回（Safari 与对照路径），从不 flush、重载或切换配置
          if (rec.seen.length > 0 && to !== 'NORMAL') expect((fake.calls.matchRule ?? 0) - (baseline.matchRule ?? 0)).toBeGreaterThan(0);
          expect(forbiddenCalls(fake, baseline)).toEqual([]);
          expect(fake.calls.reloadProfile).toBeUndefined();
        });
      }
    }
  }

  test('any insertion position: every head/tail choice for every add reaches every target with no permissive window', async () => {
    let runs = 0;
    for (const from of MODES) {
      for (const to of MODES) {
        if (from === to) continue;
        for (let mask = 0; mask < 16; mask++) {
          const choices = [0, 1, 2, 3].map((i) => ((mask >> i) & 1 ? 'tail' : 'head') as TempRuleInsertion);
          rmSync(dir, { recursive: true, force: true });
          dir = mkdtempSync(join(tmpdir(), 'sfe-entry-'));
          const { ctrl, fake } = await setupTemp({ fakeInsertion: 'head', start: from, adapter: (f) => arbitraryInsertion(f, choices) });
          const rec = stepRecorder(fake);
          expect((await ctrl.transition(to, rec.onStep)).mode).toBe(to);
          assertNoWindow(rec.seen, from, to);
          expect(observe(fake).mode).toBe(to);
          runs++;
        }
      }
    }
    expect(runs).toBe(12 * 16);
  });

  test('rules are added and removed one at a time, exactly as recorded; the disjoint texts are what Surge receives', async () => {
    const { ctrl, fake, ownership } = await setupTemp({ fakeInsertion: 'head', strategyInsertion: 'head' });
    const steps: string[] = [];
    await ctrl.transition('ACTIVE', (st) => steps.push(`${st.bit}${st.value ? '+' : '-'}→${st.effective}`));
    expect(steps).toEqual(['block+→BLOCKED', 'udp+→BLOCKED', 'active+→ACTIVE', 'block-→ACTIVE']);
    expect(fake.tempRules).toEqual([tempRuleText('active', CFG), tempRuleText('udp', CFG)]);
    expect(tempRuleText('active', CFG)).toBe(`AND,((PROCESS-NAME,${FAKE_SAFARI_PATH}),(NOT,((PROTOCOL,UDP)))),SFE-ROUTE`);
    expect(ownership.records().filter((r) => r.state === 'present').map((r) => r.identity).sort()).toEqual([tempRuleText('udp', CFG), tempRuleText('active', CFG)].sort());
    const vo: string[] = [];
    await ctrl.transition('VERIFY_ONLY', (st) => vo.push(`${st.bit}${st.value ? '+' : '-'}→${st.effective}`));
    // blockOther 是 VERIFY_ONLY 中的“阻断”（报告为 block 位）
    // head：新加的 blockOther 排在 active 之前，加入后即为 VERIFY_ONLY 的效果（tail 时要到移除 active 才是）
    expect(vo).toEqual(['block+→VERIFY_ONLY', 'verify+→VERIFY_ONLY', 'active-→VERIFY_ONLY']);
    expect(fake.tempRules.map(normalizeRuleText).sort()).toEqual(['udp', 'verify', 'blockOther'].map((k) => normalizeRuleText(tempRuleText(k as TempEntryKind, CFG))).sort());
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
    const { ctrl, fake } = await setupTemp({ fakeInsertion: 'head', strategyInsertion: 'head' });
    const rec = stepRecorder(fake);
    const err = (await ctrl
      .transition('ACTIVE', (step) => {
        rec.onStep(step);
        if (rec.seen.length === 1) fake.failNext('addTempRule');
      })
      .catch((e: unknown) => e)) as SfeError;
    expect(err.code).toBe('SURGE_COMMAND_FAILED');
    expect(err.details!.lastConfirmedBits).toEqual(ENTRY_MODE_BITS.BLOCKED);
    assertNoWindow(rec.seen, 'NORMAL', 'ACTIVE');
    expect(observe(fake).mode).toBe('BLOCKED');
    expect((await ctrl.read()).mode).toBe('BLOCKED'); // 只有 block：就是 BLOCKED 的规范集合
    expect((await ctrl.transition('ACTIVE')).mode).toBe('ACTIVE');
  });

  test('an add that timed out but did take effect is accepted after reading facts', async () => {
    const { ctrl, fake } = await setupTemp({ fakeInsertion: 'head', strategyInsertion: 'head' });
    fake.failNext('addTempRule', new SfeError('SURGE_UNREACHABLE', '连接 Surge 失败：命令超时'), { afterEffect: true });
    expect((await ctrl.transition('ACTIVE')).mode).toBe('ACTIVE');
    expect(observe(fake).mode).toBe('ACTIVE');
  });

  test('an add that reports success without effect is a READBACK_MISMATCH', async () => {
    const { ctrl, fake } = await setupTemp({ fakeInsertion: 'head', strategyInsertion: 'head', start: 'BLOCKED' });
    fake.lieOnNext('addTempRule');
    const err = (await ctrl.transition('ACTIVE').catch((e: unknown) => e)) as SfeError;
    expect(err.code).toBe('READBACK_MISMATCH');
    expect(err.details!.lastConfirmedBits).toEqual(ENTRY_MODE_BITS.BLOCKED);
    expect(observe(fake).mode).toBe('BLOCKED');
  });

  test('the plan does not depend on the recorded insertion: Surge inserting at the other end still reaches the target', async () => {
    for (const [fakeInsertion, strategyInsertion] of [
      ['head', 'tail'],
      ['tail', 'head'],
    ] as const) {
      rmSync(dir, { recursive: true, force: true });
      dir = mkdtempSync(join(tmpdir(), 'sfe-entry-'));
      const { ctrl, fake } = await setupTemp({ fakeInsertion, strategyInsertion, start: 'BLOCKED' });
      const rec = stepRecorder(fake);
      expect((await ctrl.transition('VERIFY_ONLY', rec.onStep)).mode).toBe('VERIFY_ONLY');
      assertNoWindow(rec.seen, 'BLOCKED', 'VERIFY_ONLY');
      expect((await ctrl.transition('ACTIVE', rec.onStep)).mode).toBe('ACTIVE');
      assertNoWindow(rec.seen, 'BLOCKED', 'ACTIVE');
    }
  });

  test('a rule match readback that does not see the just-added rule: the rule is removed again and the previous state stays confirmed', async () => {
    const { ctrl, fake } = await setupTemp({
      fakeInsertion: 'head',
      strategyInsertion: 'head',
      adapter: (f) => rewriteMatch(f, (input, real) => (input.processPath === FAKE_SAFARI_PATH ? { rule: 'FINAL,DIRECT', policy: 'DIRECT' } : real)),
    });
    const err = (await ctrl.transition('BLOCKED').catch((e: unknown) => e)) as SfeError;
    expect(err.code).toBe('READBACK_MISMATCH');
    expect(err.details!.lastConfirmedBits).toEqual(ENTRY_MODE_BITS.NORMAL);
    expect((err.details!.runtime as string[]).join(' ')).toContain('没有命中本应用入口规则');
    expect(fake.tempRules).toEqual([]);
    expect((await ctrl.read()).mode).toBe('NORMAL');
  });

  test('rule match echoing the temp rule without its policy, and the group selection as the final policy, is still recognised', async () => {
    const { ctrl, fake } = await setupTemp({
      fakeInsertion: 'head',
      strategyInsertion: 'head',
      adapter: (f) =>
        rewriteMatch(f, (_input, real) => ({ rule: real.rule.replace(/,(REJECT|SFE-ROUTE)$/, ''), policy: real.policy === 'SFE-ROUTE' ? NODE : real.policy })),
    });
    const rec = stepRecorder(fake);
    expect((await ctrl.transition('VERIFY_ONLY', rec.onStep)).mode).toBe('VERIFY_ONLY');
    expect((await ctrl.transition('ACTIVE', rec.onStep)).mode).toBe('ACTIVE');
    assertNoWindow(rec.seen, 'NORMAL', 'ACTIVE');
  });

  test('a Chrome (control) probe that hits an app rule fails closed after the write', async () => {
    const { ctrl, fake } = await setupTemp({
      fakeInsertion: 'head',
      strategyInsertion: 'head',
      adapter: (f) =>
        rewriteMatch(f, (input, real) => (input.processPath === FAKE_CHROME_PATH && input.protocol === 'UDP' ? { rule: tempRuleText('block', CFG), policy: 'REJECT' } : real)),
    });
    const err = (await ctrl.transition('BLOCKED').catch((e: unknown) => e)) as SfeError;
    expect(err.code).toBe('READBACK_MISMATCH');
    expect(err.details).toMatchObject({ controlHit: true, lastConfirmedBits: ENTRY_MODE_BITS.NORMAL });
    expect(fake.tempRules).toEqual([]);
  });

  test('Surge restart drops the rules: read is UNKNOWN, and NORMAL is reached without writes', async () => {
    const { ctrl, fake, ownership } = await setupTemp({ fakeInsertion: 'head', strategyInsertion: 'head', start: 'ACTIVE' });
    fake.restart();
    const rb = await ctrl.read();
    expect(rb.mode).toBe('UNKNOWN');
    expect(rb.evidence.join(' ')).toMatch(/missing_/);
    const adds = fake.calls.addTempRule;
    expect((await ctrl.transition('NORMAL')).mode).toBe('NORMAL');
    expect(fake.calls.addTempRule).toBe(adds);
    expect(ownership.records().every((r) => r.state === 'removed')).toBe(true);
  });

  test('normal-mode blocking after a restart (rules already discarded) writes nothing and reports NORMAL; a rollback still blocks', async () => {
    const { ctrl, fake } = await setupTemp({ fakeInsertion: 'head', strategyInsertion: 'head', start: 'ACTIVE' });
    fake.restart();
    const adds = fake.calls.addTempRule ?? 0;
    const rb = await ctrl.transition('BLOCKED', undefined, { undo: true, towardNormal: true });
    expect(rb.mode).toBe('NORMAL');
    expect(rb.evidence.join(' ')).toContain('不需要阻断');
    expect(fake.calls.addTempRule ?? 0).toBe(adds);
    // 回滚（不是普通模式）从不走向 NORMAL：照常加入 block
    expect((await ctrl.transition('BLOCKED', undefined, { undo: true })).mode).toBe('BLOCKED');
    expect(observe(fake).mode).toBe('BLOCKED');
  });

  test('a blocking module rule prevents ACTIVE before any write', async () => {
    const { ctrl, fake } = await setupTemp({ fakeInsertion: 'head', strategyInsertion: 'head', start: 'BLOCKED' });
    fake.setModuleRules([{ text: 'PROCESS-NAME,Safari,DIRECT', moduleName: 'Mod' }]);
    const adds = fake.calls.addTempRule;
    await expect(ctrl.transition('ACTIVE')).rejects.toMatchObject({ code: 'PRECEDENCE_VIOLATION' });
    expect(fake.calls.addTempRule).toBe(adds);
    expect((await ctrl.transition('NORMAL')).mode).toBe('NORMAL');
  });

  test('read reports the logical bits and the actual order of the app rules', async () => {
    const { ctrl } = await setupTemp({ fakeInsertion: 'tail', strategyInsertion: 'tail', start: 'VERIFY_ONLY' });
    const rb = await ctrl.read();
    expect(rb).toMatchObject({ mode: 'VERIFY_ONLY', bits: ENTRY_MODE_BITS.VERIFY_ONLY, precedenceIssues: [] });
    expect(rb.evidence[1]).toBe('有效规则顺序：udp > verify > blockOther');
  });

  test('a non-canonical rule set left by an interrupted transition reads UNKNOWN (with its effect) and is planned from', async () => {
    const { ctrl, fake, ownership } = await setupTemp({ fakeInsertion: 'head', strategyInsertion: 'head', start: 'ACTIVE' });
    // ACTIVE → VERIFY_ONLY 在加入 blockOther 之后中断（head：blockOther 排在 active 之前 → VERIFY_ONLY 的效果）
    const text = tempRuleText('blockOther', CFG);
    await fake.addTempRule(text);
    await ownership.confirm('temp_rule', text, 'present');
    const rb = await ctrl.read();
    expect(rb.mode).toBe('UNKNOWN');
    expect(rb.bits).toEqual(ENTRY_MODE_BITS.VERIFY_ONLY);
    expect(rb.evidence.join(' ')).toContain('实际效果为 VERIFY_ONLY');
    const rec = stepRecorder(fake);
    expect((await ctrl.transition('NORMAL', rec.onStep, { undo: true })).mode).toBe('NORMAL');
    assertNoWindow(rec.seen, 'VERIFY_ONLY', 'NORMAL');
  });

  test('bits passed in transition errors are always a state at least as strict as the start', async () => {
    const strict = (b: EntryBits | null) => b === null || b.block || (!b.verify && !b.active);
    const { ctrl, fake } = await setupTemp({ fakeInsertion: 'tail', strategyInsertion: 'tail' });
    fake.failNext('addTempRule');
    const err = (await ctrl.transition('BLOCKED').catch((e: unknown) => e)) as SfeError;
    expect(strict(err.details!.lastConfirmedBits as EntryBits | null)).toBe(true);
  });
});

// ---------- temp_rule：撤销入口时 rule match 读不到或与预期不一致 ----------

/** 包装适配器：rule match 一律抛出 error（例如超时、原语未映射、旧版本的 Unknown command）。 */
function throwingMatch(fake: FakeSurge, error: () => Error): SurgeAdapter {
  return new Proxy(fake, {
    get(target, prop) {
      if (prop === 'matchRule') return async () => {
        throw error();
      };
      const v: unknown = Reflect.get(target, prop, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  }) as unknown as SurgeAdapter;
}

describe('temp_rule strategy: undo when rule match cannot be read or disagrees', () => {
  const unmapped = (): Error => new SfeError('CAPABILITY_UNVERIFIED', '调用 Surge 失败：原语 matchRule 在当前实现中尚未通过实测', { details: { primitive: 'matchRule' } });

  for (const insertion of ['head', 'tail'] as const) {
    test(`[${insertion}] ACTIVE → BLOCKED (normal mode) with rule match failing: the block rule stays, Safari ends BLOCKED, reported as not runtime-confirmed; NORMAL follows`, async () => {
      const { ctrl, fake } = await setupTemp({ fakeInsertion: insertion, start: 'ACTIVE', adapter: (f) => throwingMatch(f, unmapped) });
      expect(observe(fake).mode).toBe('ACTIVE');
      const rb = await ctrl.transition('BLOCKED', undefined, { undo: true, towardNormal: true });
      expect(rb.mode).toBe('BLOCKED');
      expect(rb.runtimeConfirmed).toBe(false);
      expect(rb.evidence.join(' ')).toContain('rule match 读不到');
      expect(fake.tempRules.map(normalizeRuleText)).toEqual([normalizeRuleText(tempRuleText('block', CFG))]);
      expect(observe(fake).mode).toBe('BLOCKED');
      const normal = await ctrl.transition('NORMAL', undefined, UNDO);
      // NORMAL 没有本应用规则，不需要 rule match：按临时规则列表与有效规则顺序确认
      expect(normal.mode).toBe('NORMAL');
      expect(normal.runtimeConfirmed).toBeUndefined();
      expect(fake.tempRules).toEqual([]);
      expect(observe(fake).mode).toBe('NORMAL');
    });
  }

  test('rollback (undo without towardNormal) from VERIFY_ONLY with rule match failing still reaches BLOCKED', async () => {
    const { ctrl, fake } = await setupTemp({ fakeInsertion: 'head', start: 'VERIFY_ONLY', adapter: (f) => throwingMatch(f, () => new SfeError('SURGE_UNREACHABLE', '连接 Surge 失败：命令超时')) });
    const rb = await ctrl.transition('BLOCKED', undefined, UNDO);
    expect(rb).toMatchObject({ mode: 'BLOCKED', runtimeConfirmed: false });
    expect(observe(fake).mode).toBe('BLOCKED');
  });

  test('activation (not undo) still fails closed when rule match cannot be read: the just-added rule is removed, NORMAL stays confirmed', async () => {
    const { ctrl, fake } = await setupTemp({ fakeInsertion: 'head', strategyInsertion: 'head', adapter: (f) => throwingMatch(f, unmapped) });
    const err = (await ctrl.transition('BLOCKED').catch((e: unknown) => e)) as SfeError;
    expect(err.code).toBe('READBACK_MISMATCH');
    expect(err.details!.lastConfirmedBits).toEqual(ENTRY_MODE_BITS.NORMAL);
    expect(fake.tempRules).toEqual([]);
  });

  for (const insertion of ['head', 'tail'] as const) {
    test(`[${insertion}] undo: a Safari-side disagreement after adding block keeps the block rule (never removes a REJECT rule), lastConfirmed is unknown`, async () => {
      const { ctrl, fake } = await setupTemp({
        fakeInsertion: insertion,
        start: 'ACTIVE',
        adapter: (f) => rewriteMatch(f, (input, real) => (input.processPath === FAKE_SAFARI_PATH ? { rule: 'FINAL,DIRECT', policy: 'DIRECT' } : real)),
      });
      const err = (await ctrl.transition('BLOCKED', undefined, { undo: true, towardNormal: true }).catch((e: unknown) => e)) as SfeError;
      expect(err.code).toBe('READBACK_MISMATCH');
      expect(err.details).toMatchObject({ keptRejectRule: true, lastConfirmedBits: null, failedStep: { kind: 'block', value: true } });
      expect(fake.tempRules.map(normalizeRuleText)).toContain(normalizeRuleText(tempRuleText('block', CFG)));
      // head：block 排在最前，Safari 已被阻断；tail：block 排在 active 之后，与起点相同（从不比起点宽松）
      expect(observe(fake).mode).toBe(insertion === 'head' ? 'BLOCKED' : 'ACTIVE');
    });
  }

  test('undo: a Chrome (control) probe that hits the just-added rule still removes it (Chrome must never match Safari rules)', async () => {
    const { ctrl, fake } = await setupTemp({
      fakeInsertion: 'head',
      start: 'ACTIVE',
      adapter: (f) =>
        rewriteMatch(f, (input, real) => (input.processPath === FAKE_CHROME_PATH && input.protocol === 'UDP' ? { rule: tempRuleText('block', CFG), policy: 'REJECT' } : real)),
    });
    const err = (await ctrl.transition('BLOCKED', undefined, { undo: true, towardNormal: true }).catch((e: unknown) => e)) as SfeError;
    expect(err.code).toBe('READBACK_MISMATCH');
    expect(err.details).toMatchObject({ controlHit: true, lastConfirmedBits: ENTRY_MODE_BITS.ACTIVE });
    expect(fake.tempRules.map(normalizeRuleText)).not.toContain(normalizeRuleText(tempRuleText('block', CFG)));
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
 * 包装假 Surge：每次增删临时规则之后（成功与否）观察 Safari 的实际结果——撤销清理的步骤不是按计划的变更、不经 onStep，
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
      expect(rb.evidence).toEqual(expect.arrayContaining(['异常：duplicate_block', '异常：stale_block']));
      const baseline = { ...u.fake.calls };
      const start = observe(u.fake);
      const blocked = await u.ctrl.transition('BLOCKED', undefined, UNDO);
      expect(blocked.mode).toBe('BLOCKED');
      const trail = blocked.evidence.find((e) => e.startsWith('撤销入口时逐条清理了本应用的临时规则：'))!;
      expect(trail).toContain(`移除 block「${tempRuleText('block', CFG)}」`);
      expect(trail).not.toContain(blockNew);
      expectNeverLoosens(start, u.seen);
      expectAllBlocked(u.seen);
      expect(u.fake.tempRules).toEqual([blockNew]);
      // 旧文本的记录按事实确认为已移除，只保留当前配置的 block
      expect(u.ownership.records().filter((r) => r.state === 'present').map((r) => r.identity)).toEqual([blockNew]);
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
    // 先加入 block（尾部：Safari 仍按起点 ACTIVE），再移除 active、udp → 全部拒绝
    expectNeverLoosens(start, u.seen);
    expect(u.seen.map((o) => o.mode)).toEqual(['ACTIVE', 'BLOCKED', 'BLOCKED']);
    expect(u.removed).toEqual([tempRuleText('active', CFG), tempRuleText('udp', CFG)]);
    const normal = await u.ctrl.transition('NORMAL', undefined, UNDO);
    expect(normal.mode).toBe('NORMAL');
    expect(u.fake.tempRules).toEqual([]);
    expect(u.ownership.records().every((r) => r.state === 'removed')).toBe(true);
  });

  test('when the block rule itself is not in the effective rules, undo BLOCKED removes nothing; undo NORMAL removes it last', async () => {
    const u = await setupUndo({
      start: 'NORMAL',
      config: CFG,
      extra: (['udp', 'verify', 'block'] as const).map((k) => ({ text: tempRuleText(k, CFG), recorded: true })),
      hidden: [tempRuleText('block', CFG)],
      fakeInsertion: 'tail',
      strategyInsertion: 'tail',
    });
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
    expect(u.fake.tempRules).toEqual([tempRuleText('block', CFG)]);
    expect(u.ownership.records().find((r) => r.identity === UNRECOGNIZED)!.state).toBe('removed');
    expect((await u.ctrl.transition('NORMAL', undefined, UNDO)).mode).toBe('NORMAL');
    expect(u.fake.tempRules).toEqual([]);
  });

  for (const insertion of ['tail', 'head', 'unknown'] as const) {
    for (const generation of ['current', 'legacy'] as const) {
      test(`[${insertion}] rollback (undo BLOCKED) with duplicate block records and ${generation} route rules keeps Safari blocked after every write`, async () => {
        // 中断的旧操作留下：block 之后的 verify/active（被遮住）与两条旧 block 文本；当前配置的 block 不在。
        // legacy：旧版本（6.5 时期按顺序设计）的 verify/active 文本——verify 不排除 UDP，active 匹配 Safari 全部流量。
        const route = (k: 'verify' | 'active'): string => (generation === 'legacy' ? legacyTempRuleText(k, CFG) : tempRuleText(k, CFG));
        const u = await setupUndo({
          start: 'NORMAL',
          config: NEW_CFG,
          extra: [tempRuleText('udp', CFG), tempRuleText('block', CFG), route('verify'), route('active'), STALE_BLOCK].map((text) => ({ text, recorded: true })),
          fakeInsertion: insertion === 'unknown' ? 'tail' : insertion,
          ...(insertion === 'unknown' ? {} : { strategyInsertion: insertion }),
        });
        const rb = await u.ctrl.read();
        expect(rb.evidence).toContain('异常：duplicate_block');
        if (generation === 'legacy') expect(rb.evidence).toEqual(expect.arrayContaining(['异常：legacy_verify', '异常：legacy_active']));
        // 激活方向照常拒绝
        await expect(u.ctrl.transition('ACTIVE')).rejects.toMatchObject({ code: 'UNKNOWN_STATE' });
        const start = observe(u.fake);
        expect(start.semantic).toEqual(ALL_REJECT);
        const baseline = { ...u.fake.calls };
        const blocked = await u.ctrl.transition('BLOCKED', undefined, UNDO);
        expect(blocked.mode).toBe('BLOCKED');
        // 每次写入之后：不经 SFE-ROUTE，也不落到原规则
        expectAllBlocked(u.seen);
        expect(u.seen.length).toBe(6); // 加入新 block，移除 active、verify、udp、两条旧 block
        expect(u.removed).toEqual([route('active'), route('verify'), tempRuleText('udp', CFG), tempRuleText('block', CFG), STALE_BLOCK]);
        expect(u.fake.tempRules).toEqual([tempRuleText('block', NEW_CFG)]);
        expect(blocked.evidence.join('\n')).toContain(`加入 block「${tempRuleText('block', NEW_CFG)}」`);
        expect(forbiddenCalls(u.fake, baseline)).toEqual([]);
      });
    }
  }

  test('legacy (6.5-era) app rules: activation refuses; normal mode removes the routing rules first, never routing Safari UDP', async () => {
    // 旧版本的 ACTIVE：udp > active（active 匹配 Safari 全部流量）
    const u = await setupUndo({
      start: 'NORMAL',
      config: CFG,
      extra: [tempRuleText('udp', CFG), legacyTempRuleText('active', CFG)].map((text) => ({ text, recorded: true })),
      fakeInsertion: 'head',
      strategyInsertion: 'head',
    });
    expect(observe(u.fake).mode).toBe('ACTIVE');
    const rb = await u.ctrl.read();
    expect(rb.mode).toBe('UNKNOWN');
    expect(rb.evidence).toContain('异常：legacy_active');
    for (const to of ['VERIFY_ONLY', 'ACTIVE'] as const) await expect(u.ctrl.transition(to)).rejects.toMatchObject({ code: 'UNKNOWN_STATE' });
    const blocked = await u.ctrl.transition('BLOCKED', undefined, { undo: true, towardNormal: true });
    expect(blocked.mode).toBe('BLOCKED');
    for (const o of u.seen) {
      expect(o.semantic.udpOther).toBe('reject');
      expect(o.semantic.udpVerify).toBe('reject');
    }
    expect(u.removed[0]).toBe(legacyTempRuleText('active', CFG));
    expect((await u.ctrl.transition('NORMAL', undefined, UNDO)).mode).toBe('NORMAL');
    expect(u.fake.tempRules).toEqual([]);
  });

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
    // 再次撤销：从失败处继续，逐条报告其余各步；之后的常规计划没有步骤（{block} 就是 BLOCKED），不经 onStep
    const rest: EntryCleanupStep[] = [];
    const blocked = await u.ctrl.transition('BLOCKED', (st) => steps.push(st), { undo: true, onCleanup: (c) => rest.push(c) });
    expect(blocked.mode).toBe('BLOCKED');
    expect(rest).toEqual([
      { action: 'remove', kind: 'verify', rule: tempRuleText('verify', CFG) },
      { action: 'remove', kind: 'udp', rule: tempRuleText('udp', CFG) },
      { action: 'remove', kind: 'block', rule: tempRuleText('block', CFG) },
      { action: 'remove', kind: 'block', rule: STALE_BLOCK },
    ]);
    expect(steps).toEqual([]);
    expectAllBlocked(u.seen);
    // 无歧义的状态走常规计划：不调用 onCleanup
    const none: EntryCleanupStep[] = [];
    expect((await u.ctrl.transition('NORMAL', (st) => steps.push(st), { undo: true, onCleanup: (c) => none.push(c) })).mode).toBe('NORMAL');
    expect(none).toEqual([]);
    expect(steps.map((st) => [st.bit, st.value])).toEqual([['block', false]]);
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
        { text: tempRuleText('blockOther', CFG), recorded: true },
        { text: blockNew, recorded: true },
      ],
    });
    expect(observe(u.fake).semantic).toEqual(ALL_REJECT);
    const normal = await u.ctrl.transition('NORMAL', undefined, UNDO);
    expect(normal.mode).toBe('NORMAL');
    expect(u.removed).toEqual([tempRuleText('active', CFG), tempRuleText('udp', CFG), tempRuleText('blockOther', CFG), tempRuleText('block', CFG), blockNew]);
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
    expect(u.removed.sort()).toEqual([tempRuleText('block', CFG), STALE_BLOCK].sort());
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
    expect((err.details!.undoCleanup as unknown[]).length).toBe(1);
    expect(u.fake.tempRules).toEqual([tempRuleText('block', NEW_CFG)]);
    expect((await u.ctrl.transition('NORMAL', undefined, UNDO)).mode).toBe('NORMAL');
    expect(u.fake.tempRules).toEqual([]);
  });

  const AMBIGUOUS: Record<string, Parameters<typeof setupUndo>[0]> = {
    duplicate: { start: 'BLOCKED', config: NEW_CFG, extra: [{ text: tempRuleText('block', NEW_CFG), recorded: true }] },
    unrecognized: { start: 'BLOCKED', config: CFG, extra: [{ text: UNRECOGNIZED, recorded: true }] },
    not_in_effective_rules: { start: 'ACTIVE', config: CFG, hidden: [tempRuleText('active', CFG)] },
    legacy: { start: 'NORMAL', config: CFG, extra: [tempRuleText('udp', CFG), legacyTempRuleText('active', CFG)].map((text) => ({ text, recorded: true })) },
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
