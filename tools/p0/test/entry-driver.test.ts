// 入口驱动在 FakeSurge 上的离线验证：使用服务的入口策略，证明驱动的顺序、记录与优先级测试逻辑。
// 这只证明编排正确；真实 Surge 上的行为必须在测试 Mac 上实测。

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ENTRY_MODE_BITS, ENTRY_PLACEHOLDER_PROCESS_PATH, ENTRY_PROBE_IPV4, SfeError } from '@sfe/contract';
import { describe, expect, it } from 'vitest';
import { analyzeEntryWindow, type ObservedRequest } from '../src/analysis/entry-window.js';
import {
  FAKE_CHROME_PATH,
  FAKE_SAFARI_PATH,
  FakeSurge,
  commandExitError,
  parseRule,
  processNameMatches,
  processNameMayMatch,
  createMemoryEntryOwnership,
  createProfileFiles,
  createRulesetStrategy,
  createTempRuleStrategy,
  ownedRulesetRecords,
} from '../src/deps.js';
import {
  INSERTION_PROBE_PROCESS_PATH,
  INSERTION_PROBE_RULES,
  describeWitnessForm,
  precedenceTest,
  probeTempInsertion,
  probeWitnessForm,
  profileBoundary,
  runEntrySequence,
  witnessFormRules,
} from '../src/entry-driver.js';
import type { SurgeAdapter, SurgeRuleRecord } from '../src/deps.js';
import { ECHO_HOST, TEST_NODES, TEST_PROFILE_FILE, buildTestProfile, profileRuleLines } from '../src/test-profile.js';

const VERIFY = 'api.ipify.org';
const PORTS = { echo: 18080, exit: 18081, front: 18082, deadFront: 18083 };
// 用户规则中有需要目标地址的 IP 规则（没有 no-resolve）：目标是域名的求值走到这里要先解析（rules/ip.html），合成域名解析失败时
// rule match 退出 1（2026-10-24 测试 Mac）。P0 的合成探测在这样的配置上也必须得到回答。
const IP_RULE = 'IP-CIDR,203.0.113.0/24,DIRECT';
const SOURCE = `[General]\nloglevel = notify\n\n[Proxy]\nFront-A = socks5, 192.0.2.10, 1080\n\n[Proxy Group]\nDaily = select, Front-A, DIRECT\n\n[Rule]\n${IP_RULE}\nFINAL,DIRECT\n`;

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

const NON_SAFARI_PATHS = [FAKE_SAFARI_PATH, '/Applications/Safari Technology Preview.app/Contents/MacOS/Safari Technology Preview', FAKE_CHROME_PATH, '/usr/bin/curl', '/usr/bin/true'];

describe('insertion probe rules never depend on DNS', () => {
  it('are two distinct REJECT rules with only a full-path PROCESS-NAME under /var/empty, both matching the synthetic request', () => {
    expect(new Set(INSERTION_PROBE_RULES).size).toBe(2);
    expect(INSERTION_PROBE_PROCESS_PATH.startsWith('/var/empty/')).toBe(true);
    for (const text of INSERTION_PROBE_RULES) {
      const r = parseRule(text)!;
      expect(r.policy).toBe('REJECT');
      expect(r.condition.type).toBe('PROCESS-NAME');
      // 完整路径模式（以 “/” 开头、不以 “/” 结尾），限定在 /var/empty 下；没有主机、IP 或 .invalid
      expect(r.condition.value!.startsWith('/var/empty/')).toBe(true);
      expect(r.condition.value!.endsWith('/')).toBe(false);
      expect(text).not.toMatch(/DOMAIN|IP-CIDR|GEOIP|IP-ASN|\.invalid/);
      expect(processNameMatches(r.condition.value!, INSERTION_PROBE_PROCESS_PATH)).toBe(true);
      // 真实进程（也包括规范化后的 /private/var 形式）不会命中
      for (const p of [...NON_SAFARI_PATHS, `/private${INSERTION_PROBE_PROCESS_PATH}`]) expect(processNameMayMatch(r.condition.value!, p)).toBe(false);
    }
  });

  for (const insertion of ['head', 'tail'] as const) {
    it(`sees the ${insertion} evaluation order with rule match on ${ENTRY_PROBE_IPV4} on a profile with an IP rule, without any DNS query`, async () => {
      const { surge, profileRules } = await setup({ tempRuleInsertion: insertion });
      const r = await probeTempInsertion(realisticAdapter(surge), async () => undefined, async () => undefined, { profileRules });
      expect(r.insertion).toBe(insertion);
      expect(r.matchInsertion).toBe(insertion);
      expect(r.matchNote).toBeNull();
      expect(r.matchObservations.map((o) => [o.host, o.processPath, o.error])).toEqual([
        [ENTRY_PROBE_IPV4, INSERTION_PROBE_PROCESS_PATH, null],
        [ENTRY_PROBE_IPV4, INSERTION_PROBE_PROCESS_PATH, null],
      ]);
      expect(r.matchObservations[0]!.rule).toBe(INSERTION_PROBE_RULES[insertion === 'head' ? 1 : 0]);
      // 删除之后求值走到用户规则：192.0.2.1 不在 203.0.113.0/24 内，到 FINAL；IP 字面量从不查询 DNS
      expect(r.matchObservations[1]!.rule).toBe('FINAL,DIRECT');
      expect(surge.dnsQueries).toEqual([]);
      expect(surge.tempRules).toEqual([]);
    });
  }

  it('does not conclude when the listed order and the evaluation order disagree', async () => {
    const { surge, profileRules } = await setup({ tempRuleInsertion: 'head' });
    // 有效规则列表把临时规则按添加顺序列出（像 tail），求值却是后添加的在前（head）
    const reordered = new Proxy(realisticAdapter(surge), {
      get(target, prop, receiver) {
        if (prop === 'listRules')
          return async (): Promise<SurgeRuleRecord[]> => {
            const rules = await surge.listRules();
            const temps = rules.filter((x) => x.source === 'temp_rule').reverse();
            return [...temps, ...rules.filter((x) => x.source !== 'temp_rule')].map((x) => ({ ...x, source: 'unknown' }));
          };
        return Reflect.get(target, prop, receiver) as unknown;
      },
    }) as SurgeAdapter;
    const r = await probeTempInsertion(reordered, async () => undefined, async () => undefined, { profileRules });
    expect(r.matchInsertion).toBe('head');
    expect(r.insertion).toBeNull();
    expect(r.matchNote).toContain('不一致：无法判断插入位置');
  });

  it('records a failed rule match (exit code and text) without blaming the temp list, and keeps the listed order', async () => {
    const { surge, profileRules } = await setup({ tempRuleInsertion: 'tail' });
    const failing = new Proxy(realisticAdapter(surge), {
      get(target, prop, receiver) {
        if (prop === 'matchRule') return async () => Promise.reject(commandExitError('matchRule', 1, 'DNS 查询失败（合成）'));
        return Reflect.get(target, prop, receiver) as unknown;
      },
    }) as SurgeAdapter;
    const r = await probeTempInsertion(failing, async () => undefined, async () => undefined, { profileRules });
    expect(r.insertion).toBe('tail');
    expect(r.matchInsertion).toBeNull();
    expect(r.tempListConfirmed).toBe(true);
    expect(r.matchObservations[0]).toMatchObject({ error: 'SURGE_COMMAND_FAILED', exitCode: 1 });
    expect(r.matchNote).toContain('读取失败 SURGE_COMMAND_FAILED（退出 1）');
  });

  it('reports a probe rule still evaluated after removal', async () => {
    const { surge, profileRules } = await setup({ tempRuleInsertion: 'tail' });
    const stuck = new Proxy(realisticAdapter(surge), {
      get(target, prop, receiver) {
        if (prop === 'removeTempRule') return async () => undefined;
        return Reflect.get(target, prop, receiver) as unknown;
      },
    }) as SurgeAdapter;
    const r = await probeTempInsertion(stuck, async () => undefined, async () => undefined, { profileRules });
    expect(r.matchNote).toContain('删除后 rule match 仍命中探测规则');
  });

  it('does not evaluate when matchRule has no implementation', async () => {
    const { surge, profileRules } = await setup({ tempRuleInsertion: 'tail' });
    const r = await probeTempInsertion(realisticAdapter(surge), async () => undefined, async () => undefined, { profileRules, ruleMatch: false });
    expect(r.insertion).toBe('tail');
    expect(r.matchObservations).toEqual([]);
    expect(r.matchNote).toContain('matchRule 没有可用实现');
  });
});

describe('probeWitnessForm (the witness form the service relies on)', () => {
  const TOKEN = 'p0ab12cd34';
  const run = (adapter: SurgeAdapter, registered: string[] = [], removed: string[] = []) =>
    probeWitnessForm(adapter, async (x) => void registered.push(x), async (x) => void removed.push(x), { token: TOKEN, safariPaths: [FAKE_SAFARI_PATH], controlPaths: [FAKE_CHROME_PATH] });

  it('uses the exact service witness and placeholder lines with a REJECT policy', () => {
    const r = witnessFormRules(TOKEN);
    expect(r.witnessPath).toBe(`/var/empty/sfe-entry-witness-active-${TOKEN}`);
    expect(r.witness).toBe(`PROCESS-NAME,/var/empty/sfe-entry-witness-active-${TOKEN},REJECT`);
    expect(r.placeholder).toBe(`PROCESS-NAME,${ENTRY_PLACEHOLDER_PROCESS_PATH},REJECT`);
  });

  it('holds on a profile with an IP rule: exact full-path match, no DNS query, cleaned up by exact text', async () => {
    const { surge } = await setup();
    const registered: string[] = [];
    const removed: string[] = [];
    const r = await run(realisticAdapter(surge), registered, removed);
    expect(r.ok).toBe(true);
    expect(r.skipped).toBeNull();
    const { witness, placeholder, witnessPath } = witnessFormRules(TOKEN);
    expect(registered).toEqual([witness, placeholder]);
    expect(removed).toEqual([placeholder, witness]);
    expect(r.leftInTempList).toBe(false);
    expect(surge.tempRules).toEqual([]);
    expect(surge.dnsQueries).toEqual([]);
    expect(r.probes.every((p) => p.host === ENTRY_PROBE_IPV4 && p.error === null)).toBe(true);
    // 添加前命中的 FINAL 排在入口段之后
    expect(r.beforeHit).toMatchObject({ beforeEntry: false, note: null });
    expect(r.beforeHit!.hitIndex!).toBeGreaterThan(r.beforeHit!.entryIndex!);
    // 添加前与删除后：见证路径走到用户规则（FINAL），不是本应用规则
    expect(r.probes.filter((p) => p.processPath === witnessPath && p.expect === 'clean').map((p) => [p.phase, p.rule])).toEqual([
      ['before', 'FINAL,DIRECT'],
      ['removed', 'FINAL,DIRECT'],
    ]);
    // 占位路径在 NORMAL 下经入口规则集命中：配置引用的本地规则集已加载（只记录）
    expect(r.probes.find((p) => p.phase === 'before' && p.expect === 'info')?.rule).toBe('RULE-SET,sfe-entry-udp.list,REJECT');
    // 负向：另一标记、前缀延长、/private/var、大写、Chrome、/usr/bin/true、Safari 都不命中测试规则
    const neither = r.probes.filter((p) => p.expect === 'neither');
    expect(neither.map((p) => p.processPath)).toEqual([
      `/var/empty/sfe-entry-witness-active-p0ab12cd30`,
      `${witnessPath}0`,
      `/private${witnessPath}`,
      `/VAR/empty/sfe-entry-witness-active-${TOKEN}`,
      `/private${ENTRY_PLACEHOLDER_PROCESS_PATH}`,
      FAKE_CHROME_PATH,
      '/usr/bin/true',
      FAKE_SAFARI_PATH,
    ]);
    expect(neither.every((p) => p.ok === true)).toBe(true);
    expect(describeWitnessForm(r)).toContain(`核对 12 次求值（目标 ${ENTRY_PROBE_IPV4}）`);
  });

  it('fails closed when rule match rejects a path that does not exist (non-zero exit is an answer)', async () => {
    const { surge } = await setup();
    const rejecting = new Proxy(realisticAdapter(surge), {
      get(target, prop, receiver) {
        if (prop === 'matchRule')
          return async (input: { processPath: string }) => {
            if (input.processPath.includes('/var/empty/')) throw commandExitError('matchRule', 1, '进程路径不存在（合成）');
            return surge.matchRule(input as never);
          };
        return Reflect.get(target, prop, receiver) as unknown;
      },
    }) as SurgeAdapter;
    const r = await run(rejecting);
    expect(r.ok).toBe(false);
    expect(r.probes[0]).toMatchObject({ phase: 'before', expect: 'clean', ok: false, error: 'SURGE_COMMAND_FAILED', exitCode: 1 });
    expect(surge.tempRules).toEqual([]);
    expect(describeWitnessForm(r)).toContain('退出 1');
  });

  it('fails closed when Surge canonicalises /var to /private/var (the witness would never be read)', async () => {
    const { surge } = await setup();
    const canonical = new Proxy(realisticAdapter(surge), {
      get(target, prop, receiver) {
        if (prop === 'matchRule') return async (input: { processPath: string }) => surge.matchRule({ ...input, processPath: input.processPath.replace(/^\/var\//, '/private/var/') } as never);
        return Reflect.get(target, prop, receiver) as unknown;
      },
    }) as SurgeAdapter;
    const r = await run(canonical);
    expect(r.ok).toBe(false);
    expect(r.probes.find((p) => p.expect === 'witness')?.ok).toBe(false);
  });

  it('fails closed when an earlier module rule shadows the documentation address', async () => {
    const { surge } = await setup();
    surge.setModuleRules([{ text: 'IP-CIDR,192.0.2.0/24,REJECT', moduleName: '合成模块' }]);
    const r = await run(realisticAdapter(surge));
    expect(r.ok).toBe(false);
    expect(describeWitnessForm(r)).toContain('命中「IP-CIDR,192.0.2.0/24,REJECT」');
    expect(surge.tempRules).toEqual([]);
    // 添加前的一次本身就判为不符（按有效规则列表的位置），不依赖假 Surge “模块先于临时规则”的求值顺序（TODO(P0)）
    expect(r.probes[0]).toMatchObject({ phase: 'before', expect: 'clean', ok: false });
    expect(r.beforeHit).toMatchObject({ beforeEntry: true, hitIndex: 0, source: 'module', moduleName: '合成模块' });
    expect(describeWitnessForm(r)).toContain('排在入口段之前');
  });

  it('fails closed when a user temp rule ahead of the entry shadows the documentation address, even if the test rules are evaluated first', async () => {
    // head 插入：测试临时规则排在用户临时规则之前，“添加后”的见证探测照样命中测试规则；服务的见证在入口规则集里，被用户规则挡住
    const { surge } = await setup({ tempRuleInsertion: 'head' });
    await surge.addTempRule('IP-CIDR,192.0.2.0/24,REJECT');
    const r = await run(realisticAdapter(surge));
    expect(r.probes.find((p) => p.expect === 'witness')?.ok).toBe(true);
    expect(r.probes[0]).toMatchObject({ phase: 'before', rule: 'IP-CIDR,192.0.2.0/24,REJECT', ok: false });
    expect(r.beforeHit?.beforeEntry).toBe(true);
    expect(r.ok).toBe(false);
    expect(surge.tempRules).toEqual(['IP-CIDR,192.0.2.0/24,REJECT']);
  });

  it('is inconclusive (never passes) when the position of the rule hit before adding cannot be determined', async () => {
    const { surge } = await setup();
    const unreadable = new Proxy(realisticAdapter(surge), {
      get(target, prop, receiver) {
        if (prop === 'listRules') return async () => Promise.reject(new SfeError('SURGE_UNREACHABLE', '连接 Surge 失败：命令超时'));
        return Reflect.get(target, prop, receiver) as unknown;
      },
    }) as SurgeAdapter;
    const r = await run(unreadable);
    expect(r.probes[0]).toMatchObject({ phase: 'before', rule: 'FINAL,DIRECT', ok: null });
    expect(r.beforeHit?.beforeEntry).toBeNull();
    expect(r.ok).toBeNull();
    expect(describeWitnessForm(r)).toContain('读不到有效规则列表');
  });

  it('does not add anything when the user already has an identical temp rule, and is inconclusive when Surge is unreachable', async () => {
    const { surge } = await setup();
    const userRule = witnessFormRules(TOKEN).placeholder.replace(',', ', ');
    await surge.addTempRule(userRule);
    const registered: string[] = [];
    const skipped = await run(surge, registered);
    expect(skipped).toMatchObject({ ok: null, skipped: '已存在相同的临时规则，未核对（不会删除它）' });
    expect(registered).toEqual([]);
    expect(surge.tempRules).toEqual([userRule]);
    await surge.removeTempRule(userRule);

    const unreachable = new Proxy(realisticAdapter(surge), {
      get(target, prop, receiver) {
        if (prop === 'matchRule') return async () => Promise.reject(new SfeError('SURGE_UNREACHABLE', '连接 Surge 失败：命令超时'));
        return Reflect.get(target, prop, receiver) as unknown;
      },
    }) as SurgeAdapter;
    const r = await run(unreachable);
    expect(r.ok).toBeNull();
    expect(surge.tempRules).toEqual([]);
  });
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
