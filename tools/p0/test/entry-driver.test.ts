// 入口驱动在 FakeSurge 上的离线验证：使用服务的入口策略，证明驱动的顺序、记录与优先级测试逻辑。
// 这只证明编排正确；真实 Surge 上的行为必须在测试 Mac 上实测。

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ENTRY_MODE_BITS } from '@sfe/contract';
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
import { INSERTION_PROBE_RULES, precedenceTest, probeTempInsertion, runEntrySequence } from '../src/entry-driver.js';
import { ECHO_HOST, TEST_NODES, TEST_PROFILE_FILE, buildTestProfile } from '../src/test-profile.js';

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
  return { surge, ruleset, temp, tick: (ms = 10) => (clock += ms), now: () => clock };
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
    surge.failNext('updateExternalResource');
    const run = await runEntrySequence({ controller: ruleset, now: () => Date.now() }, ['BLOCKED', 'ACTIVE']);
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
    it(`detects ${insertion} insertion and removes the probe rules`, async () => {
      const { surge } = await setup({ tempRuleInsertion: insertion });
      const registered: string[] = [];
      const removed: string[] = [];
      const r = await probeTempInsertion(surge, async (x) => void registered.push(x), async (x) => void removed.push(x));
      expect(r.insertion).toBe(insertion);
      expect(r.beforeProfileRules).toBe(true);
      expect(registered).toEqual([...INSERTION_PROBE_RULES]);
      expect(removed.sort()).toEqual([...INSERTION_PROBE_RULES].sort());
      expect(surge.tempRules).toEqual([]);
    });
  }

  it('the temp_rule strategy refuses transitions it cannot make safely', async () => {
    const { temp, surge } = await setup({ tempRuleInsertion: 'tail' });
    const run = await runEntrySequence({ controller: temp, now: () => Date.now() }, ['BLOCKED', 'VERIFY_ONLY']);
    expect(run.modes[0]!.ok).toBe(true);
    expect(run.stoppedEarly).toBe(true);
    expect(run.modes[1]!.error?.code).toBe('CAPABILITY_UNVERIFIED');
    // 拒绝发生在写入之前：仍是 BLOCKED
    expect((await temp.read()).mode).toBe('BLOCKED');
    expect(surge.calls.reloadProfile ?? 0).toBe(0);
  });
});
