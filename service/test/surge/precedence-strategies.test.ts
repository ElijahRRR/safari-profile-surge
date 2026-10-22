// 优先级检查与 temp_rule 策略：尾部插入时用户临时规则可能夹在本应用入口规则之间（udp 与 block、udp 与 active，
// 或撤销清理之前夹在旧规则与当前 block 之间）。读回必须把它列为优先级问题，不能宣称 BLOCKED/ACTIVE 受控；
// 会让 Safari 流量落到它的写入（激活、回滚的阻断与撤销清理）在写入之前按插入位置预测并拒绝；
// 普通模式（towardNormal）仍能撤销本应用入口（§5.2、§5.5）。只用合成数据。

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { ENTRY_MODE_BITS, SfeError, type KnownEntryMode } from '@sfe/contract';
import type { EntryController } from '../../src/ports.js';
import { FAKE_SAFARI_PATH, FAKE_VERIFY_HOST, FakeSurge, createFakeSurgeEnvironment } from '../../src/surge/fake.js';
import { ENTRY_BITS_IN_ORDER, nodeLine, resourceFile, tempRuleText } from '../../src/surge/generate.js';
import { createMemoryEntryOwnership, type MemoryEntryOwnership } from '../../src/surge/entry/ownership.js';
import { createTempRuleStrategy, type TempRuleInsertion } from '../../src/surge/entry/temp-rule-strategy.js';

const NODE = 'SFE-N-E0001-US01-v001';
const SITE = 'www.example.test';
const CFG = { processPaths: [FAKE_SAFARI_PATH], verifyHost: FAKE_VERIFY_HOST, siteHosts: [SITE] };
const PREVIEW_PATH = '/Applications/Safari Technology Preview.app/Contents/MacOS/Safari Technology Preview';
const NEW_CFG = { ...CFG, processPaths: [FAKE_SAFARI_PATH, PREVIEW_PATH] };
/** 旧版本格式、无法按结构识别的本应用规则：Safari 访问 example.test 经 SFE-ROUTE。 */
const LEGACY_ROUTE = `AND,((PROCESS-NAME,${FAKE_SAFARI_PATH}),(DOMAIN-SUFFIX,example.test)),SFE-ROUTE`;
/** 回滚：撤销入口，不标为普通模式的中间阻断。 */
const UNDO = { undo: true } as const;
/** 普通模式的中间阻断（route.ts blockForNormal）。 */
const TOWARD_NORMAL = { undo: true, towardNormal: true } as const;
const USER_DIRECT = 'DOMAIN-SUFFIX,example.test,DIRECT';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sfe-precedence-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface Setup {
  fake: FakeSurge;
  ownership: MemoryEntryOwnership;
  ctrl: EntryController;
  /** 起点之后的临时规则写入次数（加入与移除）。 */
  writes: () => number;
}

/**
 * 起点：按 CFG 以规范顺序建立 start 模式的本应用规则，再按顺序追加 extra（recorded 为本应用记录，否则是用户的规则）。
 * 假 Surge 按 fakeInsertion（默认尾部）插入；控制器按 strategyInsertion（默认尾部，null = 未知，两种位置都要安全）预测。
 */
async function setup(opts: {
  start: KnownEntryMode;
  config?: typeof CFG;
  extra?: Array<{ text: string; recorded: boolean }>;
  fakeInsertion?: TempRuleInsertion;
  strategyInsertion?: TempRuleInsertion | null;
}): Promise<Setup> {
  // 每次一个独立的配置目录（同一测试可以比较不同的插入位置）
  const surgeDir = mkdtempSync(join(dir, 'surge-'));
  createFakeSurgeEnvironment(surgeDir, { entryStrategy: 'temp_rule' });
  const fake = new FakeSurge({ directory: surgeDir, tempRuleInsertion: 'tail' });
  writeFileSync(
    join(surgeDir, 'sfe-nodes.list'),
    resourceFile(1, [nodeLine({ name: NODE, host: '203.0.113.10', port: 1080, username: null, password: null, front: 'Front-A' })]),
  );
  await fake.updateExternalResource('policy-path:sfe-nodes.list');
  await fake.selectGroupPolicy('SFE-ROUTE', NODE);
  const ownership = createMemoryEntryOwnership();
  const bits = ENTRY_MODE_BITS[opts.start];
  const add = async (text: string, recorded: boolean): Promise<void> => {
    await fake.addTempRule(text);
    if (recorded) await ownership.confirm('temp_rule', text, 'present');
  };
  for (const bit of ENTRY_BITS_IN_ORDER) if (bits[bit]) await add(tempRuleText(bit, CFG), true);
  for (const x of opts.extra ?? []) await add(x.text, x.recorded);
  fake.tempRuleInsertion = opts.fakeInsertion ?? 'tail';
  const config = opts.config ?? CFG;
  const insertion = opts.strategyInsertion === undefined ? 'tail' : opts.strategyInsertion;
  const ctrl = createTempRuleStrategy({ adapter: fake, ownership, config: () => config, operationId: () => 'op_test', ...(insertion ? { insertion } : {}) });
  const count = (): number => (fake.calls.addTempRule ?? 0) + (fake.calls.removeTempRule ?? 0);
  const base = count();
  return { fake, ownership, ctrl, writes: () => count() - base };
}

function safari(fake: FakeSurge, host: string, protocol: 'tcp' | 'udp' = 'tcp'): { rule: string | null; policy: string | null } {
  const r = fake.simulateRequest({ processPath: FAKE_SAFARI_PATH, host, protocol });
  return { rule: r.rule, policy: r.policyName };
}

async function failure(p: Promise<unknown>): Promise<SfeError> {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(SfeError);
  return e as SfeError;
}

describe('temp_rule: a user rule that tail insertion would put ahead of an app entry rule', () => {
  test('ACTIVE + a user rule at the tail → BLOCKED (activation or rollback) is refused before any write: Safari never falls to the user rule', async () => {
    const { fake, ctrl, writes } = await setup({ start: 'ACTIVE', extra: [{ text: USER_DIRECT, recorded: false }] });
    // ACTIVE：active 覆盖 Safari 全部流量，之后的用户规则到不了
    expect(await ctrl.read()).toMatchObject({ mode: 'ACTIVE', precedenceIssues: [] });
    const before = fake.tempRules;
    for (const opts of [undefined, UNDO]) {
      // 加入 block（尾部，排在用户规则之后）再移除 active，会让站点经用户规则直连：写入之前拒绝
      const err = await failure(ctrl.transition('BLOCKED', undefined, opts));
      expect(err.code).toBe('PRECEDENCE_VIOLATION');
      expect(err.details).toMatchObject({ lastConfirmedBits: ENTRY_MODE_BITS.ACTIVE, insertion: 'tail', to: 'BLOCKED' });
      expect(err.details!.precedenceIssues).toEqual([{ rule: USER_DIRECT, source: 'temp_rule', severity: 'blocking' }]);
    }
    expect(writes()).toBe(0);
    expect(fake.tempRules).toEqual(before);
    expect(safari(fake, SITE).policy).toBe('SFE-ROUTE');
    // 普通模式照常撤销本应用入口；用户规则不动
    expect((await ctrl.transition('NORMAL', undefined, UNDO)).mode).toBe('NORMAL');
    expect(fake.tempRules).toEqual([USER_DIRECT]);
  });

  test('normal mode’s intermediate block (towardNormal) still goes ahead: the readback reports the user rule between udp and block, then NORMAL', async () => {
    const { fake, ctrl } = await setup({ start: 'ACTIVE', extra: [{ text: USER_DIRECT, recorded: false }] });
    const err = await failure(ctrl.transition('BLOCKED', undefined, TOWARD_NORMAL));
    expect(fake.tempRules).toEqual([tempRuleText('udp', CFG), USER_DIRECT, tempRuleText('block', CFG)]);
    // 实际：Safari 访问站点经用户规则直连（NORMAL 同样如此），所以读回不能宣称 BLOCKED
    expect(safari(fake, SITE)).toEqual({ rule: USER_DIRECT, policy: 'DIRECT' });
    expect(err.code).toBe('PRECEDENCE_VIOLATION');
    expect(err.details!.lastConfirmedBits).toEqual(ENTRY_MODE_BITS.BLOCKED);
    expect(err.details!.precedenceIssues).toEqual([{ rule: USER_DIRECT, source: 'temp_rule', severity: 'blocking' }]);
    expect((await ctrl.read()).mode).toBe('UNKNOWN');
    expect((await ctrl.transition('NORMAL', undefined, UNDO)).mode).toBe('NORMAL');
    expect(fake.tempRules).toEqual([USER_DIRECT]);
  });

  test('BLOCKED + a user rule at the tail → ACTIVE is refused before any write (the plan would put the user rule ahead of active)', async () => {
    const user = `DOMAIN,${SITE},DIRECT`;
    const { fake, ctrl, writes } = await setup({ start: 'BLOCKED', extra: [{ text: user, recorded: false }] });
    // BLOCKED：block 覆盖 Safari 全部流量，当前的优先级检查看不到问题
    expect(await ctrl.read()).toMatchObject({ mode: 'BLOCKED', precedenceIssues: [] });
    const err = await failure(ctrl.transition('ACTIVE'));
    expect(err.code).toBe('PRECEDENCE_VIOLATION');
    expect(err.details).toMatchObject({ lastConfirmedBits: ENTRY_MODE_BITS.BLOCKED, insertion: 'tail', to: 'ACTIVE' });
    expect(err.details!.precedenceIssues).toEqual([{ rule: user, source: 'temp_rule', severity: 'blocking' }]);
    expect(writes()).toBe(0);
    expect(fake.tempRules).toEqual([tempRuleText('udp', CFG), tempRuleText('block', CFG), user]);
    // 检测主机与站点都仍被拒绝：不会出现“检测主机经 SFE-ROUTE、站点直连”的假通过
    expect(safari(fake, FAKE_VERIFY_HOST).policy).toBe('REJECT');
    expect(safari(fake, SITE).policy).toBe('REJECT');
    expect((await ctrl.transition('NORMAL')).mode).toBe('NORMAL');
    expect(fake.tempRules).toEqual([user]);
  });

  test('a user rule already between udp and active is reported by the readback (not ACTIVE)', async () => {
    const user = `DOMAIN,${SITE},DIRECT`;
    const { fake, ctrl } = await setup({
      start: 'NORMAL',
      extra: [
        { text: tempRuleText('udp', CFG), recorded: true },
        { text: user, recorded: false },
        { text: tempRuleText('active', CFG), recorded: true },
      ],
    });
    expect(safari(fake, FAKE_VERIFY_HOST).policy).toBe('SFE-ROUTE');
    expect(safari(fake, SITE)).toEqual({ rule: user, policy: 'DIRECT' });
    const rb = await ctrl.read();
    expect(rb.mode).toBe('UNKNOWN');
    expect(rb.precedenceIssues).toEqual([{ rule: user, source: 'temp_rule', severity: 'blocking' }]);
  });

  test('a user rule after the block (Safari never reaches it) is not an issue, even with app rules after it', async () => {
    const { fake, ctrl } = await setup({
      start: 'NORMAL',
      extra: [
        { text: tempRuleText('block', CFG), recorded: true },
        { text: USER_DIRECT, recorded: false },
        { text: tempRuleText('udp', CFG), recorded: true },
      ],
    });
    expect(safari(fake, SITE).policy).toBe('REJECT');
    expect(safari(fake, SITE, 'udp').policy).toBe('REJECT');
    expect(await ctrl.read()).toMatchObject({ mode: 'BLOCKED', precedenceIssues: [] });
  });
});

describe('temp_rule undo cleanup toward BLOCKED with a user rule between app rules', () => {
  test('rollback: a user rule between a legacy route rule and the block → refused before any write; normal mode still reaches NORMAL', async () => {
    const { fake, ctrl, writes } = await setup({
      start: 'NORMAL',
      extra: [
        { text: tempRuleText('udp', CFG), recorded: true },
        { text: LEGACY_ROUTE, recorded: true },
        { text: USER_DIRECT, recorded: false },
        { text: tempRuleText('block', CFG), recorded: true },
      ],
    });
    const rb = await ctrl.read();
    expect(rb.mode).toBe('UNKNOWN');
    expect(rb.precedenceIssues).toEqual([{ rule: USER_DIRECT, source: 'temp_rule', severity: 'blocking' }]);
    const before = fake.tempRules;
    expect(safari(fake, SITE)).toEqual({ rule: LEGACY_ROUTE, policy: 'SFE-ROUTE' });
    expect(safari(fake, SITE, 'udp').policy).toBe('REJECT');
    // 回滚：移除旧的路由规则与 udp 会让站点的 TCP 与 UDP 经用户规则直连 → 写入之前拒绝
    const err = await failure(ctrl.transition('BLOCKED', undefined, UNDO));
    expect(err.code).toBe('PRECEDENCE_VIOLATION');
    expect(err.details).toMatchObject({ lastConfirmedBits: null, undoCleanup: [], insertion: 'tail' });
    expect(err.details!.precedenceIssues).toEqual([{ rule: USER_DIRECT, source: 'temp_rule', severity: 'blocking' }]);
    expect(writes()).toBe(0);
    expect(fake.tempRules).toEqual(before);
    expect(safari(fake, SITE).policy).not.toBe('DIRECT');
    expect(safari(fake, SITE, 'udp').policy).toBe('REJECT');
    // 普通模式：中间阻断只因优先级不能确认（入口位已确认为 BLOCKED，普通模式据此继续），之后撤销全部本应用规则
    const blocked = await failure(ctrl.transition('BLOCKED', undefined, TOWARD_NORMAL));
    expect(blocked.code).toBe('PRECEDENCE_VIOLATION');
    expect(blocked.details!.lastConfirmedBits).toEqual(ENTRY_MODE_BITS.BLOCKED);
    expect((await ctrl.transition('NORMAL', undefined, UNDO)).mode).toBe('NORMAL');
    expect(fake.tempRules).toEqual([USER_DIRECT]);
  });

  for (const insertion of ['tail', null] as const) {
    test(`[${insertion ?? 'unknown'}] rollback: a user rule between the old block and a recorded block for the new process paths → refused before any write, Safari stays blocked`, async () => {
      const { fake, ctrl, writes } = await setup({
        start: 'BLOCKED',
        config: NEW_CFG,
        extra: [
          { text: USER_DIRECT, recorded: false },
          { text: tempRuleText('block', NEW_CFG), recorded: true },
        ],
        strategyInsertion: insertion,
      });
      const rb = await ctrl.read();
      expect(rb.mode).toBe('UNKNOWN');
      expect(rb.evidence).toContain('异常：duplicate_block');
      expect(rb.precedenceIssues).toEqual([{ rule: USER_DIRECT, source: 'temp_rule', severity: 'blocking' }]);
      const before = fake.tempRules;
      for (const protocol of ['tcp', 'udp'] as const) expect(safari(fake, SITE, protocol).policy).toBe('REJECT');
      const err = await failure(ctrl.transition('BLOCKED', undefined, UNDO));
      expect(err.code).toBe('PRECEDENCE_VIOLATION');
      expect(err.details).toMatchObject({ lastConfirmedBits: null, undoCleanup: [] });
      expect(err.details!.precedenceIssues).toEqual([{ rule: USER_DIRECT, source: 'temp_rule', severity: 'blocking' }]);
      expect(writes()).toBe(0);
      expect(fake.tempRules).toEqual(before);
      for (const protocol of ['tcp', 'udp'] as const) expect(safari(fake, SITE, protocol).policy).toBe('REJECT');
      // 普通模式照常完成
      await failure(ctrl.transition('BLOCKED', undefined, TOWARD_NORMAL));
      expect((await ctrl.transition('NORMAL', undefined, UNDO)).mode).toBe('NORMAL');
      expect(fake.tempRules).toEqual([USER_DIRECT]);
    });
  }

  test('the block to add decides it: with head insertion the new block shields the user rule and the rollback cleanup proceeds; tail or unknown insertion refuses', async () => {
    const extra = [
      { text: tempRuleText('udp', CFG), recorded: true },
      { text: LEGACY_ROUTE, recorded: true },
      { text: USER_DIRECT, recorded: false },
    ];
    for (const insertion of ['tail', null] as const) {
      // 尾部：新 block 排在用户规则之后，移除旧路由规则与 udp 会让站点经用户规则直连
      const { ctrl, writes } = await setup({ start: 'NORMAL', extra, strategyInsertion: insertion });
      const err = await failure(ctrl.transition('BLOCKED', undefined, UNDO));
      expect(err.code).toBe('PRECEDENCE_VIOLATION');
      expect(err.details!.insertion).toBe('tail');
      expect(writes()).toBe(0);
    }
    const { fake, ctrl } = await setup({ start: 'NORMAL', extra, fakeInsertion: 'head', strategyInsertion: 'head' });
    const blocked = await ctrl.transition('BLOCKED', undefined, UNDO);
    expect(blocked).toMatchObject({ mode: 'BLOCKED', precedenceIssues: [] });
    expect(fake.tempRules).toEqual([tempRuleText('udp', CFG), tempRuleText('block', CFG), USER_DIRECT]);
    for (const protocol of ['tcp', 'udp'] as const) expect(safari(fake, SITE, protocol).policy).toBe('REJECT');
  });
});
