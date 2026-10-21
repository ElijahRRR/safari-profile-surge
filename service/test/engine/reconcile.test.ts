import { readFileSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, test } from 'vitest';
import { PROFILE_A, WEB, activeEnv, bind, createEnv, createHarness, rid, verify, type Harness } from './harness.js';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

const WRITE_PRIMITIVES = ['updateExternalResource', 'selectGroupPolicy', 'addTempRule', 'removeTempRule', 'killRequest', 'reloadProfile'];
const writes = () => Object.fromEntries(WRITE_PRIMITIVES.map((k) => [k, h.fake.calls[k] ?? 0]));
const reconcileOps = () => h.repos.operations.listRecent(500).filter((o) => o.kind === 'maintenance.reconcile');

async function activeHarness(opts: Parameters<typeof createHarness>[0] = {}) {
  h = await createHarness(opts);
  return activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
}

describe('periodic reconcile is read-only and sticky', () => {
  test('external selection change → external_change, recorded once, never written back', async () => {
    await activeHarness();
    await h.fake.selectGroupPolicy('SFE-ROUTE', 'REJECT');
    const before = writes();
    await h.app.runPeriodicReconcile();
    const route = h.repos.routeState.get();
    expect(route.phase).toBe('external_change');
    expect(route.warnings).toContain('external_selection_change');
    expect(writes()).toEqual(before);
    expect(await h.fake.getGroupSelection('SFE-ROUTE')).toBe('REJECT');
    expect(reconcileOps()).toHaveLength(1);
    await h.app.runPeriodicReconcile();
    expect(reconcileOps()).toHaveLength(1);
    expect(h.events.some((e) => e.type === 'route.updated')).toBe(true);
    expect(h.events.some((e) => e.type === 'surge.status')).toBe(true);
  });

  test('nothing changed → no operation recorded', async () => {
    await activeHarness();
    await h.app.runPeriodicReconcile();
    await h.app.runPeriodicReconcile();
    expect(reconcileOps()).toHaveLength(0);
    expect(h.repos.routeState.get().lastReconciledAt).not.toBeNull();
  });

  test('idle route (NORMAL) → periodic reconcile skipped', async () => {
    h = await createHarness();
    await createEnv(h, 'US-Buyer-A', '203.0.113.10');
    h.fake.takeover = { enhancedMode: false, systemProxy: false, outboundMode: 'direct', checkedAt: null };
    await h.app.runPeriodicReconcile();
    expect(h.repos.routeState.get().warnings).toEqual([]);
    expect(reconcileOps()).toHaveLength(0);
  });

  test('runs on the clock every reconcileIntervalSec while managed', async () => {
    await activeHarness();
    await h.fake.selectGroupPolicy('SFE-ROUTE', 'REJECT');
    await h.clock.advanceAsync(30_000);
    await h.idle();
    expect(h.repos.routeState.get().warnings).toContain('external_selection_change');
  });

  test('Surge restart → surge_restarted, attention, Safari probe expired', async () => {
    const { envId } = await activeHarness();
    h.clock.advance(1000);
    h.fake.restart();
    await h.app.runPeriodicReconcile();
    const route = h.repos.routeState.get();
    expect(route.phase).toBe('attention');
    expect(route.warnings).toEqual(expect.arrayContaining(['surge_restarted', 'probe_expired']));
    expect(Date.parse(h.repos.probes.latest(envId, 'safari')!.expiresAt)).toBeLessThanOrEqual(h.clock.now().getTime());
    expect((await h.app.ensureInControl()).ok).toBe(false);
  });

  test('temp_rule strategy: Surge restart drops the temporary rules → entry UNKNOWN + entry_unverified', async () => {
    h = await createHarness({ entryStrategy: 'temp_rule' });
    const env = (await createEnv(h, 'US-Buyer-A', '203.0.113.10')).environment_id!;
    await bind(h, PROFILE_A, env);
    // temp_rule 在尾部插入时无法到达 VERIFY_ONLY（B 模块的结论）：激活回滚并停在 BLOCKED
    const a = await h.app.activate(env, { request_id: rid() }, WEB);
    await h.idle();
    expect(h.repos.operations.get(a.operation_id)!.phase).toBe('FAILED');
    expect(h.repos.routeState.get().entryMode).toBe('BLOCKED');
    expect(h.fake.tempRules.length).toBeGreaterThan(0);
    h.clock.advance(1000);
    h.fake.restart();
    expect(h.fake.tempRules).toEqual([]);
    const before = writes();
    await h.app.runPeriodicReconcile();
    const route = h.repos.routeState.get();
    expect(route.entryMode).toBe('UNKNOWN');
    expect(route.phase).toBe('attention');
    expect(route.warnings).toEqual(expect.arrayContaining(['entry_unverified', 'surge_restarted']));
    // 从不抢回控制：不会重新添加临时规则
    expect(writes()).toEqual(before);
  });

  test.each([
    ['takeover lost', { enhancedMode: false, systemProxy: false, outboundMode: 'rule' as const }, 'takeover_lost', 'attention'],
    ['outbound mode changed', { enhancedMode: true, systemProxy: true, outboundMode: 'direct' as const }, 'outbound_mode_changed', 'attention'],
    ['takeover unreadable', { enhancedMode: null, systemProxy: null, outboundMode: null }, 'takeover_unknown', 'active_verified'],
  ])('%s', async (_name, takeover, warning, phase) => {
    await activeHarness();
    h.fake.takeover = { ...takeover, checkedAt: null };
    const before = writes();
    await h.app.runPeriodicReconcile();
    const route = h.repos.routeState.get();
    expect(route.warnings).toContain(warning);
    expect(route.phase).toBe(phase);
    expect(writes()).toEqual(before);
  });

  test('takeover_unknown does not block but requires a fresh Safari probe', async () => {
    const { envId } = await activeHarness();
    h.fake.takeover = { enhancedMode: null, systemProxy: null, outboundMode: null, checkedAt: null };
    await h.app.runPeriodicReconcile();
    expect((await h.app.ensureInControl()).ok).toBe(false);
    const p = await h.app.probe(envId, { request_id: rid(), kind: 'safari' }, WEB);
    await h.idle();
    await verify(h, PROFILE_A, p.operation_id);
    expect(h.repos.operations.get(p.operation_id)!.phase).toBe('ACTIVE_VERIFIED');
    const c = await h.app.ensureInControl();
    expect(c.ok).toBe(true);
    expect(h.repos.routeState.get().warnings).toContain('takeover_unknown');
  });

  test('precedence violation (module DIRECT rule ahead of the entry) → precedence_violation', async () => {
    await activeHarness();
    h.fake.setModuleRules([{ text: 'DOMAIN-SUFFIX,amazon.com,DIRECT', moduleName: 'user-module' }]);
    await h.app.runPeriodicReconcile();
    const route = h.repos.routeState.get();
    expect(route.warnings).toContain('precedence_violation');
    expect(route.phase).toBe('attention');
    const status = await h.app.refreshSurge(WEB);
    expect(status.precedenceIssues.some((i) => i.severity === 'blocking' && i.source === 'module')).toBe(true);
  });

  test('managed segment edited → managed_segments_changed, never auto-repaired', async () => {
    await activeHarness();
    const text = readFileSync(h.profilePath, 'utf8').replace('SFE-ROUTE = select, REJECT, policy-path=sfe-nodes.list', 'SFE-ROUTE = select, REJECT, DIRECT, policy-path=sfe-nodes.list');
    writeFileSync(h.profilePath, text);
    await h.app.runPeriodicReconcile();
    expect(h.repos.routeState.get().warnings).toContain('managed_segments_changed');
    expect(readFileSync(h.profilePath, 'utf8')).toBe(text);
    expect((await h.app.refreshSurge(WEB)).managedSectionsIntact).toBe(false);
  });

  test('front proxy disappears → front_missing, front state missing, active probe expired', async () => {
    await activeHarness();
    const policies = await h.fake.listPolicies();
    h.fake.lieOnNext('listPolicies', { proxies: policies.proxies.filter((p) => p !== 'Front-A'), groups: policies.groups });
    await h.app.runPeriodicReconcile();
    const route = h.repos.routeState.get();
    expect(route.warnings).toEqual(expect.arrayContaining(['front_missing', 'probe_expired']));
    expect(h.repos.frontProxies.get(h.frontId)!.state).toBe('missing');
    const fronts = await h.app.listFrontProxies();
    expect(fronts[0]!.state).toBe('missing');
  });

  test('Surge unreachable → surge_unreachable', async () => {
    await activeHarness();
    h.fake.reachable = false;
    await h.app.runPeriodicReconcile();
    const route = h.repos.routeState.get();
    expect(route.warnings).toContain('surge_unreachable');
    expect(route.phase).toBe('attention');
    const status = await h.app.refreshSurge(WEB);
    expect(status.reachable).toBe(false);
  });

  test('recovery after loss of control needs an explicit activation (no reuse)', async () => {
    const { envId } = await activeHarness();
    await h.fake.selectGroupPolicy('SFE-ROUTE', 'REJECT');
    await h.app.runPeriodicReconcile();
    const before = h.repos.routeState.get().routeEpoch;
    const a = await h.app.activate(envId, { request_id: rid() }, WEB);
    await h.idle();
    expect(h.repos.operations.get(a.operation_id)!.phase).toBe('VERIFY_ONLY');
    await verify(h, PROFILE_A, a.operation_id);
    const route = h.repos.routeState.get();
    expect(route.routeEpoch).toBe(before + 1);
    expect(route.warnings).toEqual([]);
    expect(route.phase).toBe('active_verified');
  });

  test('probe TTL expiry → probe_expired (no phase change)', async () => {
    await activeHarness();
    h.clock.advance(901_000);
    await h.app.runPeriodicReconcile();
    const route = h.repos.routeState.get();
    expect(route.warnings).toContain('probe_expired');
    expect(route.phase).toBe('active_verified');
  });

  test('ensureInControl refuses while the executor is writing', async () => {
    await activeHarness();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const orig = h.fake.selectGroupPolicy.bind(h.fake);
    h.fake.selectGroupPolicy = async (g: string, p: string) => {
      await gate;
      return orig(g, p);
    };
    const b = (await createEnv(h, 'US-Buyer-B', '203.0.113.11')).environment_id!;
    await bind(h, 'profile-bbbb-0002', b);
    const route = h.repos.routeState.get();
    await h.app.activate(b, { request_id: rid(), old_session_policy: 'closed_confirmed', confirmed_environment_id: route.activeEnvironmentId }, WEB);
    for (let i = 0; i < 50 && !h.app.executor.isBusy(); i++) await new Promise((r) => setImmediate(r));
    const c = await h.app.ensureInControl();
    expect(c.ok).toBe(false);
    release();
    await h.idle();
  });
});
