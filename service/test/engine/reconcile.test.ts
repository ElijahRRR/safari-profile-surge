import { readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { SURGE_START_JITTER_MS, surgeRestartedBetween } from '../../src/engine/context.js';
import { PROFILE_A, PROFILE_B, PROFILE_C, WEB, activeEnv, bind, createEnv, createHarness, entryWrites, grantForCurrentHost, rid, verify, type Harness } from './harness.js';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

const WRITE_PRIMITIVES = ['updateExternalResource', 'selectGroupPolicy', 'addTempRule', 'removeTempRule', 'killRequest', 'reloadProfile'];
// 写原语的调用次数之外还看入口规则集文件（ruleset_resource 的入口写入是文件写入加文件监视，不经适配器写原语）
const writes = () => ({ ...Object.fromEntries(WRITE_PRIMITIVES.map((k) => [k, h.fake.calls[k] ?? 0])), ...entryWrites(h.fake) });
const reconcileOps = () => h.repos.operations.listRecent(500).filter((o) => o.kind === 'maintenance.reconcile');

async function until(cond: () => boolean): Promise<void> {
  const end = Date.now() + 5000;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 2));
  expect(cond()).toBe(true);
}

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

  test('a successful read clears the "not read yet" placeholder message', async () => {
    await activeHarness();
    await h.app.refreshSurge(WEB);
    const status = (await h.app.snapshot(WEB)).surge;
    expect(status.reachable).toBe(true);
    expect(status.message).toBeNull();
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
    // 引擎启动时间由运行时长换算到整秒：重启要让它向后移动超过容差（SURGE_START_JITTER_MS）
    h.clock.advance(5_000);
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
    // 激活后入口不是 NORMAL、本应用的临时规则在 Surge 中（停在 BLOCKED 或等待实测的 VERIFY_ONLY 都可以：
    // 这里只关心重启后临时规则消失时的对账，不关心入口策略走到哪一步）
    await h.app.activate(env, { request_id: rid() }, WEB);
    await h.idle();
    expect(['BLOCKED', 'VERIFY_ONLY']).toContain(h.repos.routeState.get().entryMode);
    expect(h.fake.tempRules.length).toBeGreaterThan(0);
    h.clock.advance(5_000);
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
    const text = readFileSync(h.profilePath, 'utf8').replace(/SFE-ROUTE = select, REJECT, /, 'SFE-ROUTE = select, REJECT, DIRECT, ');
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

  test('Safari updated while the service keeps running → activation capability stale → entry_unverified, never written', async () => {
    h = await createHarness();
    grantForCurrentHost(h, ['safari_process_attribution']);
    await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    await h.app.runPeriodicReconcile();
    expect(h.repos.routeState.get().warnings).not.toContain('entry_unverified');
    h.host.safariVersion = '19.1';
    const before = writes();
    await h.app.runPeriodicReconcile();
    const route = h.repos.routeState.get();
    expect(route.warnings).toContain('entry_unverified');
    expect(route.phase).toBe('attention');
    expect(writes()).toEqual(before);
    expect((await h.app.ensureInControl()).ok).toBe(false);
  });

  test('an orphaned switching/rolling_back phase (no running owner) → attention + entry_unverified, never written', async () => {
    const { opId } = await activeHarness();
    // 例如崩溃恢复失败后：路由停在切换中，负责它的操作已结束
    h.repos.routeState.update({ phase: 'switching', operationId: opId });
    const before = writes();
    await h.app.runPeriodicReconcile();
    let route = h.repos.routeState.get();
    expect(route.phase).toBe('attention');
    expect(route.warnings).toContain('entry_unverified');
    expect(route.entryMode).toBe('ACTIVE'); // 读回与记录一致
    expect(writes()).toEqual(before);
    expect((await h.app.ensureInControl()).ok).toBe(false);
    // 记录与读回不一致 → UNKNOWN
    h.repos.routeState.update({ phase: 'rolling_back', entryMode: 'BLOCKED', operationId: opId });
    await h.app.runPeriodicReconcile();
    route = h.repos.routeState.get();
    expect(route.phase).toBe('attention');
    expect(route.entryMode).toBe('UNKNOWN');
    expect(writes()).toEqual(before);
  });

  test('an orphaned awaiting_safari_verify (owner no longer running, queued or waiting) → attention + entry_unverified, never written', async () => {
    h = await createHarness();
    const { envId: a } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const b = (await createEnv(h, 'US-Buyer-B', '203.0.113.11')).environment_id!;
    await bind(h, PROFILE_B, b);
    const act = await h.app.activate(b, { request_id: rid(), old_session_policy: 'closed_confirmed', confirmed_environment_id: a }, WEB);
    await h.idle();
    const opId = act.operation_id;
    expect(h.repos.routeState.get()).toMatchObject({ phase: 'awaiting_safari_verify', entryMode: 'VERIFY_ONLY', operationId: opId });
    expect(h.repos.routeState.get().awaitingDeadline).not.toBeNull();
    // 负责的操作仍在等待 Safari 实测：不是中断
    await h.app.runPeriodicReconcile();
    expect(h.repos.routeState.get()).toMatchObject({ phase: 'awaiting_safari_verify', entryMode: 'VERIFY_ONLY' });
    expect(h.repos.routeState.get().warnings).not.toContain('entry_unverified');
    // 例如核对中的意外异常：执行器兜底只把操作标为失败，路由停在 VERIFY_ONLY 等待，计时器也不再处理它
    h.repos.operations.update(opId, { phase: 'FAILED', status: 'failed', error: { code: 'INTERNAL', message: '执行失败：内部错误' } });
    const before = writes();
    await h.app.runPeriodicReconcile();
    let route = h.repos.routeState.get();
    expect(route.phase).toBe('attention');
    expect(route.warnings).toContain('entry_unverified');
    expect(route.entryMode).toBe('VERIFY_ONLY'); // 读回与记录一致
    expect(route.awaitingDeadline).toBeNull();
    expect(writes()).toEqual(before);
    expect((await h.app.ensureInControl()).ok).toBe(false);
    const recorded = reconcileOps().find((o) => (o.payload as { added?: string[] }).added?.includes('entry_unverified'));
    expect(recorded).toBeDefined();
    // 截止时间过后也不会被计时器“恢复”，警告保持粘性
    h.clock.advance(3_600_000);
    await h.idle();
    await h.app.runPeriodicReconcile();
    expect(h.repos.routeState.get()).toMatchObject({ phase: 'attention', entryMode: 'VERIFY_ONLY' });
    // 记录与读回不一致 → UNKNOWN
    h.repos.routeState.update({ phase: 'awaiting_safari_verify', entryMode: 'BLOCKED', operationId: opId, warnings: [] });
    await h.app.runPeriodicReconcile();
    route = h.repos.routeState.get();
    expect(route.phase).toBe('attention');
    expect(route.entryMode).toBe('UNKNOWN');
    expect(route.warnings).toContain('entry_unverified');
    expect(writes()).toEqual(before);
  });

  test('a waiting activation superseded while reconcile reads Surge is not mistaken for an orphaned VERIFY_ONLY wait', async () => {
    h = await createHarness();
    const { envId: a } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const b = (await createEnv(h, 'US-Buyer-B', '203.0.113.11')).environment_id!;
    await bind(h, PROFILE_B, b);
    const c = (await createEnv(h, 'US-Buyer-C', '203.0.113.12')).environment_id!;
    await bind(h, PROFILE_C, c);
    const first = await h.app.activate(b, { request_id: rid(), old_session_policy: 'closed_confirmed', confirmed_environment_id: a }, WEB);
    await h.idle();
    expect(h.repos.routeState.get()).toMatchObject({ phase: 'awaiting_safari_verify', operationId: first.operation_id });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered = false;
    const orig = h.fake.listPolicies.bind(h.fake);
    h.fake.listPolicies = async () => {
      if (!entered) {
        entered = true;
        await gate;
      }
      return orig();
    };
    const run = h.app.refreshSurge(WEB);
    await until(() => entered);
    // 读取事实期间：新的激活取代等待中的激活（受理在执行器之外，同一事务里把路由交给新操作）
    const second = await h.app.activate(c, { request_id: rid(), old_session_policy: 'closed_confirmed', confirmed_environment_id: a }, WEB);
    expect(h.repos.operations.get(first.operation_id)!.status).toBe('superseded');
    expect(h.repos.routeState.get().operationId).toBe(second.operation_id);
    release();
    await run;
    expect(reconcileOps().some((o) => (o.payload as { added?: string[] }).added?.includes('entry_unverified'))).toBe(false);
    await h.idle();
    expect(h.repos.routeState.get()).toMatchObject({ phase: 'awaiting_safari_verify', entryMode: 'VERIFY_ONLY', operationId: second.operation_id });
    expect(h.repos.routeState.get().warnings).not.toContain('entry_unverified');
  });

  test('an unresolvable home or working-profile directory (e.g. a link loop) never breaks reading facts: risk unknown and warned, reconcile still runs', async () => {
    await activeHarness();
    const home = join(h.dir, 'home');
    symlinkSync(home, home); // realpath → ELOOP（不是“尚不存在”）
    const status = await h.app.refreshSurge(WEB);
    expect(status.reachable).toBe(true);
    expect(status.profileDirectoryRisk).toBeNull();
    expect(status.message).toContain('无法确认固定工作配置所在目录的真实位置');
    expect(status.message).not.toContain(h.dir);
    // 只做展示：不是激活门槛，也不让受控判定失败
    expect((await h.app.ensureInControl()).ok).toBe(true);
    // 周期对账照常运行（读取事实不抛出），实测过期照常发现
    h.clock.advance(901_000);
    await h.app.runPeriodicReconcile();
    expect(h.repos.routeState.get().warnings).toContain('probe_expired');
  });

  test('warnings written outside the executor while reconcile reads Surge are not lost', async () => {
    const { envId } = await activeHarness();
    expect((await h.app.ensureInControl()).ok).toBe(true);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered = false;
    const orig = h.fake.listPolicies.bind(h.fake);
    h.fake.listPolicies = async () => {
      if (!entered) {
        entered = true;
        await gate;
      }
      return orig();
    };
    const run = h.app.runPeriodicReconcile();
    await until(() => entered);
    // 读取事实期间：预期出口被改成与实测不符（受理处理器直接加 exit_ip_mismatch）
    const env = h.repos.environments.get(envId)!;
    await h.app.updateEnvironment(envId, { request_id: rid(), expected_revision: env.revision, changes: { proxy: { expectedExitIp: '198.51.100.99' } } }, WEB);
    expect(h.repos.routeState.get().warnings).toEqual(['exit_ip_mismatch']);
    release();
    await run;
    expect(h.repos.routeState.get().warnings).toEqual(['exit_ip_mismatch']);
    const control = await h.app.ensureInControl();
    expect(control.ok).toBe(false);
    expect(control.reason).toContain('exit_ip_mismatch');
  });

  test('acknowledgeWindows during a reconcile read is not undone', async () => {
    h = await createHarness();
    const { envId: a } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const b = (await createEnv(h, 'US-Buyer-B', '203.0.113.11')).environment_id!;
    await bind(h, 'profile-bbbb-0002', b);
    const act = await h.app.activate(b, { request_id: rid(), old_session_policy: 'keep_open_acknowledged', confirmed_environment_id: a }, WEB);
    await h.idle();
    await verify(h, 'profile-bbbb-0002', act.operation_id);
    expect(h.repos.routeState.get().warnings).toContain('old_windows_kept_open');
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered = false;
    const orig = h.fake.listPolicies.bind(h.fake);
    h.fake.listPolicies = async () => {
      if (!entered) {
        entered = true;
        await gate;
      }
      return orig();
    };
    const run = h.app.runPeriodicReconcile();
    await until(() => entered);
    await h.app.acknowledgeWindows({ request_id: rid() }, WEB);
    expect(h.repos.routeState.get().warnings).not.toContain('old_windows_kept_open');
    release();
    await run;
    expect(h.repos.routeState.get().warnings).not.toContain('old_windows_kept_open');
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

describe('engine restart detection from the engine uptime (getRuntimeInfo: dump performance uptime)', () => {
  test('surgeRestartedBetween: uptime falling or startedAt moving forward beyond the jitter; unreadable samples prove nothing', () => {
    const t = (ms: number) => new Date(Date.UTC(2026, 9, 21) + ms).toISOString();
    expect(surgeRestartedBetween({ startedAt: t(0), uptimeSeconds: 100 }, { startedAt: t(1_000), uptimeSeconds: 130 })).toBe(false);
    expect(surgeRestartedBetween({ startedAt: t(0), uptimeSeconds: null }, { startedAt: t(SURGE_START_JITTER_MS), uptimeSeconds: null })).toBe(false);
    expect(surgeRestartedBetween({ startedAt: t(0), uptimeSeconds: null }, { startedAt: t(SURGE_START_JITTER_MS + 1), uptimeSeconds: null })).toBe(true);
    expect(surgeRestartedBetween({ startedAt: t(0), uptimeSeconds: 100 }, { startedAt: t(500), uptimeSeconds: 3 })).toBe(true);
    // 启动时间向前移动（墙钟回拨）不是重启
    expect(surgeRestartedBetween({ startedAt: t(10_000), uptimeSeconds: null }, { startedAt: t(0), uptimeSeconds: null })).toBe(false);
    expect(surgeRestartedBetween(null, { startedAt: t(0), uptimeSeconds: 1 })).toBe(false);
    expect(surgeRestartedBetween({ startedAt: null, uptimeSeconds: null }, { startedAt: t(60_000), uptimeSeconds: 0 })).toBe(false);
  });

  /**
   * temp_rule 激活后的受管理状态（入口不是 NORMAL、本应用的临时规则在 Surge 中，对账检查重启）：停在 BLOCKED 或
   * 等待 Safari 实测的 VERIFY_ONLY 都可以——这里只关心重启检测，不关心入口策略走到哪一步。
   */
  async function managedTempRule(): Promise<void> {
    h = await createHarness({ entryStrategy: 'temp_rule' });
    const env = (await createEnv(h, 'US-Buyer-A', '203.0.113.10')).environment_id!;
    await bind(h, PROFILE_A, env);
    await h.app.activate(env, { request_id: rid() }, WEB);
    await h.idle();
    expect(['BLOCKED', 'VERIFY_ONLY']).toContain(h.repos.routeState.get().entryMode);
    expect(h.fake.tempRules.length).toBeGreaterThan(0);
  }

  test('startedAt jitter of one second from the whole-second conversion is not a restart', async () => {
    await managedTempRule();
    h.clock.advance(10_000);
    await h.app.runPeriodicReconcile();
    const startedAt = h.fake.startedAt.getTime();
    // 同一次引擎运行：运行时长继续增加，换算出的启动时间相差 1 秒
    h.fake.getRuntimeInfo = async () => ({ startedAt: new Date(startedAt + 1_000), uptimeSeconds: 11 });
    await h.app.runPeriodicReconcile();
    expect(h.repos.routeState.get().warnings).not.toContain('surge_restarted');
  });

  test('an engine-only restart (uptime falls, process unchanged) → surge_restarted', async () => {
    await managedTempRule();
    h.clock.advance(10_000);
    await h.app.runPeriodicReconcile();
    expect(h.app.engine.facts.uptimeSeconds).toBe(10);
    // restart-engine 或 6.9+ 的重载自动升级为完整重启：进程启动时间不变，引擎运行时长回落
    const startedAt = h.fake.startedAt.getTime();
    h.fake.getRuntimeInfo = async () => ({ startedAt: new Date(startedAt + 1_500), uptimeSeconds: 2 });
    const instanceBefore = await h.fake.runningInstance();
    await h.app.runPeriodicReconcile();
    expect(await h.fake.runningInstance()).toEqual(instanceBefore);
    expect(h.repos.routeState.get().warnings).toContain('surge_restarted');
  });

  test('an unreadable engine uptime never raises surge_restarted', async () => {
    await managedTempRule();
    h.fake.getRuntimeInfo = async () => {
      throw new Error('dump performance unavailable');
    };
    h.clock.advance(10_000);
    await h.app.runPeriodicReconcile();
    expect(h.app.engine.facts).toMatchObject({ startedAt: null, uptimeSeconds: null });
    expect(h.repos.routeState.get().warnings).not.toContain('surge_restarted');
  });
});
