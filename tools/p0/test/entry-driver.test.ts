// 入口驱动在 FakeSurge 上的离线验证：使用服务的入口策略，证明驱动的顺序、记录与优先级测试逻辑。
// 这只证明编排正确；真实 Surge 上的行为必须在测试 Mac 上实测。

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ENTRY_MODE_BITS, SfeError } from '@sfe/contract';
import { describe, expect, it } from 'vitest';
import { analyzeEntryWindow, type ObservedRequest } from '../src/analysis/entry-window.js';
import {
  FAKE_CHROME_PATH,
  FAKE_SAFARI_PATH,
  FakeSurge,
  createMemoryEntryOwnership,
  createProfileFiles,
  createRulesetStrategy,
  createTempRuleStrategy,
  ownedRulesetRecords,
} from '../src/deps.js';
import { INSERTION_PROBE_RULES, precedenceTest, probeTempInsertion, profileBoundary, runEntrySequence } from '../src/entry-driver.js';
import type { SurgeAdapter, SurgeRuleRecord } from '../src/deps.js';
import { ECHO_HOST, TEST_NODES, TEST_PROFILE_FILE, buildTestProfile, profileRuleLines } from '../src/test-profile.js';

const VERIFY = 'api.ipify.org';
const PORTS = { echo: 18080, exit: 18081, front: 18082, deadFront: 18083 };
const SOURCE = '[General]\nloglevel = notify\n\n[Proxy]\nFront-A = socks5, 192.0.2.10, 1080\n\n[Proxy Group]\nDaily = select, Front-A, DIRECT\n\n[Rule]\nFINAL,DIRECT\n';

async function setup(opts: { tempRuleInsertion?: 'head' | 'tail' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sfe-p0-entry-'));
  const r = buildTestProfile(SOURCE, { ports: PORTS, password: 'SyntheticPass0', verifyHost: VERIFY, httpApi: null });
  writeFileSync(join(dir, TEST_PROFILE_FILE), r.profileText);
  for (const [n, c] of Object.entries(r.files)) writeFileSync(join(dir, n), c);
  let clock = 1_000_000;
  const now = () => new Date(clock);
  const surge = new FakeSurge({ directory: dir, profileFileName: TEST_PROFILE_FILE, now, tempRuleInsertion: opts.tempRuleInsertion });
  await surge.selectGroupPolicy('SFE-ROUTE', TEST_NODES.a);
  const files = createProfileFiles({ directory: dir, hmacKey: Buffer.alloc(32, 3) });
  const config = () => ({ processPaths: [FAKE_SAFARI_PATH], verifyHost: VERIFY, siteHosts: [ECHO_HOST] });
  const ruleset = createRulesetStrategy({
    adapter: surge,
    files,
    ownership: createMemoryEntryOwnership(await ownedRulesetRecords(files)),
    config,
    operationId: () => 'p0-test',
    autoReloadCondition: () => 'off',
  });
  const temp = createTempRuleStrategy({ adapter: surge, ownership: createMemoryEntryOwnership(), config, operationId: () => 'p0-test', insertion: opts.tempRuleInsertion });
  return { surge, ruleset, temp, profileRules: profileRuleLines(r.profileText), tick: (ms = 10) => (clock += ms), now: () => clock };
}

/** 真实适配器的视角：CLI/HTTP 解析不报告规则来源（source 只有 module/unknown）。可另外改写临时规则列表。 */
function realisticAdapter(surge: FakeSurge, opts: { listTempRules?: () => Promise<string[]> } = {}): SurgeAdapter {
  return new Proxy(surge, {
    get(target, prop, receiver) {
      if (prop === 'listRules') return async (): Promise<SurgeRuleRecord[]> => (await target.listRules()).map((r) => ({ text: r.text, source: r.source === 'module' ? 'module' : 'unknown', moduleName: r.moduleName }));
      if (prop === 'listTempRules' && opts.listTempRules) return opts.listTempRules;
      const v = Reflect.get(target, prop, receiver) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  }) as unknown as SurgeAdapter;
}

describe('runEntrySequence with the ruleset strategy on FakeSurge', () => {
  it('reaches every mode with readback, never reloads, and Safari/Chrome behave per mode', async () => {
    const { surge, ruleset, tick, now } = await setup();
    const observed: ObservedRequest[] = [];
    const sample = () => {
      for (const host of [ECHO_HOST, VERIFY]) {
        for (const protocol of ['tcp', 'udp'] as const) {
          const r = surge.simulateRequest({ processPath: FAKE_SAFARI_PATH, host, protocol });
          observed.push({ at: now(), processPath: r.processPath, host: r.remoteHost, protocol, policy: r.policyName });
        }
      }
    };
    const chromePolicies = new Set<string>();
    const run = await runEntrySequence(
      {
        controller: ruleset,
        now: () => tick(),
        onStep: () => sample(),
        afterMode: async (m) => {
          sample();
          chromePolicies.add(surge.simulateRequest({ processPath: FAKE_CHROME_PATH, host: ECHO_HOST, protocol: 'tcp' }).policyName ?? '');
          if (m.target === 'ACTIVE') expect(surge.simulateRequest({ processPath: FAKE_SAFARI_PATH, host: ECHO_HOST, protocol: 'tcp' }).leafPolicyName).toBe(TEST_NODES.a);
          if (m.target === 'VERIFY_ONLY') {
            expect(surge.simulateRequest({ processPath: FAKE_SAFARI_PATH, host: VERIFY, protocol: 'tcp' }).policyName).toBe('SFE-ROUTE');
            expect(surge.simulateRequest({ processPath: FAKE_SAFARI_PATH, host: ECHO_HOST, protocol: 'tcp' }).failed).toBe(true);
          }
        },
      },
      ['BLOCKED', 'VERIFY_ONLY', 'ACTIVE', 'NORMAL'],
    );
    expect(run.stoppedEarly).toBe(false);
    expect(run.modes.map((m) => [m.target, m.readbackMode, m.ok])).toEqual([
      ['BLOCKED', 'BLOCKED', true],
      ['VERIFY_ONLY', 'VERIFY_ONLY', true],
      ['ACTIVE', 'ACTIVE', true],
      ['NORMAL', 'NORMAL', true],
    ]);
    expect(run.timeline.steps.length).toBe(run.modes.reduce((n, m) => n + m.steps.length, 0));
    expect(run.timeline.steps.at(-1)!.after).toEqual(ENTRY_MODE_BITS.NORMAL);
    expect(surge.reloadCount).toBe(0);
    expect(surge.calls.reloadProfile ?? 0).toBe(0);
    expect([...chromePolicies]).toEqual(['P0-Plain']);
    const w = analyzeEntryWindow(run.timeline, observed, { processPaths: [FAKE_SAFARI_PATH], verifyHost: VERIFY, graceMs: 0, from: 0, to: Number.MAX_SAFE_INTEGER });
    expect(w.checked).toBeGreaterThan(0);
    expect(w.violations).toEqual([]);
  });

  it('stops at the failed step and reports the last confirmed bits', async () => {
    const { surge, ruleset } = await setup();
    // 第一步确认之后，下一步等待文件监视时的 rule match 读回失败（策略从不调用 updateExternalResource）
    const run = await runEntrySequence({ controller: ruleset, now: () => Date.now(), onStep: () => surge.failNext('matchRule') }, ['BLOCKED', 'ACTIVE']);
    expect(run.stoppedEarly).toBe(true);
    expect(run.modes).toHaveLength(1);
    expect(run.modes[0]!.error?.code).toBe('SURGE_COMMAND_FAILED');
    expect(run.modes[0]!.error).toHaveProperty('lastConfirmedBits');
  });
});

describe('precedenceTest', () => {
  it('a DIRECT temp rule for the verify host blocks VERIFY_ONLY and the entry stays NORMAL', async () => {
    const { surge, ruleset } = await setup();
    const rule = `DOMAIN,${VERIFY},DIRECT`;
    const r = await precedenceTest(ruleset, () => surge.addTempRule(rule), () => surge.removeTempRule(rule));
    expect(r).toMatchObject({ refused: true, code: 'PRECEDENCE_VIOLATION', modeAfter: 'NORMAL' });
    expect(r.blockingIssues).toBeGreaterThan(0);
    expect(surge.tempRules).toEqual([]);
  });

  it('a DIRECT module rule blocks VERIFY_ONLY', async () => {
    const { surge, ruleset } = await setup();
    const r = await precedenceTest(
      ruleset,
      async () => surge.setModuleRules([{ text: `DOMAIN,${VERIFY},DIRECT`, moduleName: 'SFE-P0 优先级测试' }]),
      async () => surge.setModuleRules([]),
    );
    expect(r.refused).toBe(true);
  });

  it('reports not refused when nothing competes, then returns to NORMAL', async () => {
    const { ruleset } = await setup();
    const r = await precedenceTest(ruleset, async () => undefined, async () => undefined);
    expect(r).toMatchObject({ refused: false, code: null, modeAfter: 'NORMAL' });
  });

  it('cleans up even when injection fails', async () => {
    const { ruleset } = await setup();
    let cleaned = false;
    await expect(
      precedenceTest(
        ruleset,
        async () => {
          throw new Error('inject failed');
        },
        async () => {
          cleaned = true;
        },
      ),
    ).rejects.toThrow('inject failed');
    expect(cleaned).toBe(true);
  });
});

describe('probeTempInsertion', () => {
  for (const insertion of ['head', 'tail'] as const) {
    it(`detects ${insertion} insertion and the profile boundary from the test profile's own rule texts (no rule source reported)`, async () => {
      const { surge, profileRules } = await setup({ tempRuleInsertion: insertion });
      const registered: string[] = [];
      const removed: string[] = [];
      const r = await probeTempInsertion(realisticAdapter(surge), async (x) => void registered.push(x), async (x) => void removed.push(x), { profileRules });
      expect(r.insertion).toBe(insertion);
      expect(r.beforeProfileRules).toBe(true);
      expect(r.boundaryNote).toBeNull();
      expect(r.tempListConfirmed).toBe(true);
      expect(registered).toEqual([...INSERTION_PROBE_RULES]);
      expect(removed.sort()).toEqual([...INSERTION_PROBE_RULES].sort());
      expect(surge.tempRules).toEqual([]);
    });
  }

  it('reports the profile boundary as undetermined (never as a result) without the test profile rule texts', async () => {
    const { surge } = await setup({ tempRuleInsertion: 'tail' });
    const r = await probeTempInsertion(realisticAdapter(surge), async () => undefined, async () => undefined);
    expect(r.insertion).toBe('tail');
    expect(r.beforeProfileRules).toBeNull();
    expect(r.boundaryNote).toContain('CLI 不报告规则来源');
    expect(surge.tempRules).toEqual([]);
  });

  it('reports listTempRules unusable only when the probe rules are visible in the effective rules but not in the temp list', async () => {
    const { surge, profileRules } = await setup({ tempRuleInsertion: 'tail' });
    const removed: string[] = [];
    // 格式可以识别、内容却不含本工具刚添加的规则（例如映射到了别的列表）；有效规则中能看到它们。
    const r = await probeTempInsertion(realisticAdapter(surge, { listTempRules: async () => [] }), async () => undefined, async (x) => void removed.push(x), { profileRules });
    expect(r.tempListConfirmed).toBe(false);
    expect(r.addConfirmed).toBe(true);
    expect(r.tempListNote).toContain('该原语映射不可用');
    expect(r.insertion).toBe('tail');
    expect(removed.sort()).toEqual([...INSERTION_PROBE_RULES].sort());
    expect(surge.tempRules).toEqual([]);
  });

  it('a failed temp-list read after the adds is a read failure, not an unusable mapping', async () => {
    const { surge, profileRules } = await setup({ tempRuleInsertion: 'tail' });
    let calls = 0;
    const failing = realisticAdapter(surge, {
      listTempRules: async () => {
        if (calls++ === 0) return [];
        throw new SfeError('SURGE_UNREACHABLE', '读取临时规则失败：Surge 没有响应');
      },
    });
    const r = await probeTempInsertion(failing, async () => undefined, async () => undefined, { profileRules });
    expect(r.tempListConfirmed).toBeNull();
    expect(r.tempListReadError).toBe('SURGE_UNREACHABLE');
    expect(r.tempListNote).toContain('添加后读取临时规则失败（SURGE_UNREACHABLE）');
    expect(r.tempListNote).toContain('不等于映射不可用');
    expect(r.addConfirmed).toBe(true);
    expect(surge.tempRules).toEqual([]);
  });

  it('an add that exits 0 but takes no effect is blamed on addTempRule, not on listTempRules', async () => {
    const { surge, profileRules } = await setup({ tempRuleInsertion: 'tail' });
    // 占位动词“成功”退出却什么都没做：临时规则列表与有效规则中都看不到探测规则。
    const noop = new Proxy(realisticAdapter(surge), {
      get(target, prop, receiver) {
        if (prop === 'addTempRule') return async () => undefined;
        return Reflect.get(target, prop, receiver) as unknown;
      },
    }) as SurgeAdapter;
    const r = await probeTempInsertion(noop, async () => undefined, async () => undefined, { profileRules });
    expect(r.tempListConfirmed).toBeNull();
    expect(r.addConfirmed).toBe(false);
    expect(r.tempListNote).toContain('addTempRule 可能没有生效');
    expect(r.insertion).toBeNull();
  });

  it('cannot tell the cause (and does not blame listTempRules) when the effective rules are unreadable', async () => {
    const { surge, profileRules } = await setup({ tempRuleInsertion: 'tail' });
    const blind = new Proxy(realisticAdapter(surge, { listTempRules: async () => [] }), {
      get(target, prop, receiver) {
        if (prop === 'listRules') return async () => Promise.reject(new SfeError('SURGE_COMMAND_FAILED', '读取规则失败'));
        return Reflect.get(target, prop, receiver) as unknown;
      },
    }) as SurgeAdapter;
    const r = await probeTempInsertion(blind, async () => undefined, async () => undefined, { profileRules });
    expect(r.tempListConfirmed).toBeNull();
    expect(r.addConfirmed).toBeNull();
    expect(r.tempListNote).toContain('无法区分');
    expect(r.boundaryNote).toContain('读不到有效规则列表');
    expect(surge.tempRules).toEqual([]);
  });

  it('does not probe (or remove) when the user already has an identical temp rule', async () => {
    const { surge } = await setup({ tempRuleInsertion: 'tail' });
    const userRule = INSERTION_PROBE_RULES[0].replace(',', ', ');
    await surge.addTempRule(userRule);
    const registered: string[] = [];
    const removed: string[] = [];
    const r = await probeTempInsertion(surge, async (x) => void registered.push(x), async (x) => void removed.push(x));
    expect(r.insertion).toBeNull();
    expect(r.skipped).toContain('已存在相同的临时规则');
    expect(registered).toEqual([]);
    expect(removed).toEqual([]);
    expect(surge.tempRules).toEqual([userRule]);
  });

  for (const insertion of ['head', 'tail'] as const) {
    it(`the temp_rule strategy reaches every mode with ${insertion} insertion (its rule conditions are disjoint, so order does not matter)`, async () => {
      const { temp, surge } = await setup({ tempRuleInsertion: insertion });
      const run = await runEntrySequence({ controller: temp, now: () => Date.now() }, ['BLOCKED', 'VERIFY_ONLY', 'ACTIVE', 'NORMAL']);
      expect(run.stoppedEarly).toBe(false);
      expect(run.modes.map((m) => [m.target, m.readbackMode, m.ok])).toEqual([
        ['BLOCKED', 'BLOCKED', true],
        ['VERIFY_ONLY', 'VERIFY_ONLY', true],
        ['ACTIVE', 'ACTIVE', true],
        ['NORMAL', 'NORMAL', true],
      ]);
      // 每一步记录的位组合都是读回确认的已知模式（放行窗口分析据此计算允许的结果）
      for (const st of run.timeline.steps) expect(Object.values(ENTRY_MODE_BITS)).toContainEqual(st.after);
      expect(surge.tempRules).toEqual([]);
      expect(surge.calls.reloadProfile ?? 0).toBe(0);
    });
  }
});

describe('profileBoundary', () => {
  const rec = (text: string): SurgeRuleRecord => ({ text, source: 'unknown', moduleName: null });
  const profile = ['RULE-SET,sfe-entry-udp.list,REJECT', 'DOMAIN,chain.p0.example.test,SFE-ROUTE', 'FINAL,DIRECT'];

  it('locates the first profile rule regardless of reported source, normalising spaces', () => {
    const rules = [rec('DOMAIN,m.example.test,DIRECT'), rec('DOMAIN,t.invalid,REJECT'), rec('RULE-SET, sfe-entry-udp.list, REJECT'), rec('DOMAIN,chain.p0.example.test,SFE-ROUTE'), rec('FINAL,DIRECT')];
    expect(profileBoundary(rules, profile)).toEqual({ index: 2, note: null });
  });

  it('is undetermined when the first profile rule is missing, ambiguous or out of order', () => {
    expect(profileBoundary([rec('FINAL,DIRECT')], profile).index).toBeNull();
    expect(profileBoundary([rec('RULE-SET,sfe-entry-udp.list,REJECT'), rec('RULE-SET,sfe-entry-udp.list,REJECT'), rec('FINAL,DIRECT')], profile).note).toContain('出现多次');
    expect(profileBoundary([rec('FINAL,DIRECT'), rec('RULE-SET,sfe-entry-udp.list,REJECT')], profile).note).toContain('顺序与配置文件不一致');
    expect(profileBoundary([rec('FINAL,DIRECT')], null).note).toContain('CLI 不报告规则来源');
    expect(profileBoundary([rec('FINAL,DIRECT')], []).index).toBeNull();
  });
});
