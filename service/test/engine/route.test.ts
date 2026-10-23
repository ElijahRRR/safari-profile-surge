import { afterEach, describe, expect, test } from 'vitest';
import { SfeError, type ActivateRequest, type RollbackResult } from '@sfe/contract';
import type { SurgeAdapter } from '../../src/ports.js';
import { FAKE_CHROME_PATH, FAKE_SAFARI_PATH, FAKE_VERIFY_HOST } from '../../src/surge/fake.js';
import {
  ADMIN,
  PROFILE_A,
  PROFILE_B,
  PROFILE_C,
  WEB,
  activeEnv,
  bind,
  createEnv,
  createHarness,
  entryWrites,
  envInput,
  rid,
  safariOutcome,
  verify,
  type Harness,
} from './harness.js';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

async function expectError(p: Promise<unknown>, code: string): Promise<SfeError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(SfeError);
    expect((err as SfeError).code).toBe(code);
    return err as SfeError;
  }
  throw new Error(`expected ${code}`);
}

/** 引擎的 Surge 适配器：调用 name 之前先运行 hook() 返回的函数（为 null 时不做任何事），例如在切换进行中受理普通模式。 */
function beforeCall(adapter: object, name: string, hook: () => (() => Promise<void>) | null): SurgeAdapter {
  return new Proxy(adapter, {
    get(target, prop) {
      const v = Reflect.get(target, prop, target) as unknown;
      if (typeof v !== 'function') return v;
      const fn = v as (...args: unknown[]) => unknown;
      if (prop !== name) return fn.bind(target);
      return async (...args: unknown[]) => {
        const run = hook();
        if (run) await run();
        return fn.apply(target, args);
      };
    },
  }) as unknown as SurgeAdapter;
}

/** A 使用中，B 已部署、已关联（未激活）。 */
async function twoEnvs(): Promise<{ a: string; b: string }> {
  const { envId: a } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
  const created = await createEnv(h, 'US-Buyer-B', '203.0.113.11');
  await bind(h, PROFILE_B, created.environment_id!);
  return { a, b: created.environment_id! };
}

async function startSwitch(env: string, extra: Partial<ActivateRequest> = {}): Promise<string> {
  const route = h.repos.routeState.get();
  const req: ActivateRequest = { request_id: rid('act'), old_session_policy: 'closed_confirmed', confirmed_environment_id: route.activeEnvironmentId, ...extra };
  const a = await h.app.activate(env, req, WEB);
  await h.idle();
  return a.operation_id;
}

const writesCount = () => ({ select: h.fake.calls.selectGroupPolicy ?? 0, update: h.fake.calls.updateExternalResource ?? 0, kill: h.fake.calls.killRequest ?? 0 });

describe('controlled activation', () => {
  test('cross-environment switch: BLOCKED → kill Safari only → select → VERIFY_ONLY → verify → ACTIVE', async () => {
    h = await createHarness();
    const { a, b } = await twoEnvs();
    const oldSafari = h.fake.simulateRequest({ processPath: FAKE_SAFARI_PATH, host: 'www.example.test', protocol: 'tcp', longLived: true });
    const chrome = h.fake.simulateRequest({ processPath: FAKE_CHROME_PATH, host: 'www.example.test', protocol: 'tcp', longLived: true });
    const opId = await startSwitch(b);
    const op = h.repos.operations.get(opId)!;
    expect(op.phase).toBe('VERIFY_ONLY');
    expect(op.status).toBe('waiting');
    // VERIFY_ONLY：Amazon 等站点被拒绝，检测服务经 SFE-ROUTE；Chrome 不受影响
    expect(safariOutcome(h, 'www.amazon.example.test').failed).toBe(true);
    expect(safariOutcome(h, FAKE_VERIFY_HOST).policyName).toBe('SFE-ROUTE');
    expect(safariOutcome(h, FAKE_VERIFY_HOST, 'udp').failed).toBe(true);
    expect(h.fake.simulateRequest({ processPath: FAKE_CHROME_PATH, host: 'www.example.test', protocol: 'tcp' }).policyName).toBe('DIRECT');
    const kills = (op.result as { killResults: Array<{ surgeRequestId: string; ok: boolean }> }).killResults;
    expect(kills.map((k) => k.surgeRequestId)).toEqual([oldSafari.id]);
    const active = await h.fake.listActiveRequests();
    expect(active.map((r) => r.id)).toEqual([chrome.id]);
    const r = await verify(h, PROFILE_B, opId);
    expect(r.ok).toBe(true);
    const done = h.repos.operations.get(opId)!;
    expect(done.phase).toBe('ACTIVE_VERIFIED');
    const route = h.repos.routeState.get();
    expect(route.activeEnvironmentId).toBe(b);
    expect(route.routeEpoch).toBe(2);
    expect(route.entryMode).toBe('ACTIVE');
    expect(route.oldSessionPolicy).toBe('closed_confirmed');
    expect(h.repos.environments.get(b)!.lastVerifiedProxyRevision).toBe(1);
    expect(safariOutcome(h).leafPolicyName).toBe('SFE-N-E0002-US02-v001');
    const probe = h.repos.probes.latest(b, 'safari')!;
    expect(probe).toMatchObject({ outcome: 'ok', exitIp: '192.0.2.50', routeEpoch: 2, entryMode: 'VERIFY_ONLY', surgePolicy: 'SFE-ROUTE' });
    expect(probe.surgeRule).toContain('sfe-entry-verify.list');
    expect(h.fake.calls.reloadProfile ?? 0).toBe(0);
    void a;
  });

  test('NEEDS_CONFIRMATION creates no operation and does not consume the request_id', async () => {
    h = await createHarness();
    const { a, b } = await twoEnvs();
    const opsBefore = h.repos.operations.listRecent(500).length;
    const requestId = rid('act');
    const err = await expectError(h.app.activate(b, { request_id: requestId }, WEB), 'NEEDS_CONFIRMATION');
    expect(err.details).toMatchObject({ reason: 'other_environment_active', currentEnvironmentId: a, options: ['closed_confirmed', 'keep_open_acknowledged'] });
    expect(h.repos.operations.listRecent(500).length).toBe(opsBefore);
    // 确认时看到的“当前环境”与实际不符 → 仍需确认，也不创建操作
    await expectError(h.app.activate(b, { request_id: requestId, old_session_policy: 'closed_confirmed', confirmed_environment_id: null }, WEB), 'NEEDS_CONFIRMATION');
    expect(h.repos.operations.listRecent(500).length).toBe(opsBefore);
    // 同一 request_id 带上正确的确认重发
    const ok = await h.app.activate(b, { request_id: requestId, old_session_policy: 'closed_confirmed', confirmed_environment_id: a }, WEB);
    expect(ok.duplicate).toBe(false);
    const again = await h.app.activate(b, { request_id: requestId, old_session_policy: 'closed_confirmed', confirmed_environment_id: a }, WEB);
    expect(again).toMatchObject({ duplicate: true, operation_id: ok.operation_id });
  });

  test('other profiles with open windows require confirmation even for the same environment', async () => {
    h = await createHarness();
    const { a } = await twoEnvs();
    await h.native(PROFILE_B, { type: 'reportProfileState', windows_open: 2, amazon_tabs_open: false, site_permission_granted: true });
    const err = await expectError(h.app.activate(a, { request_id: rid() }, WEB), 'NEEDS_CONFIRMATION');
    expect(err.details).toMatchObject({ reason: 'other_profiles_open' });
    expect((err.details as { otherProfilesOpen: unknown[] }).otherProfilesOpen).toHaveLength(1);
    // 上报超过有效期后不再计入
    h.clock.advance(601_000);
    await h.app.activate(a, { request_id: rid() }, WEB);
  });

  test('a profile without a profile ID (e.g. the default profile) reporting open windows also requires confirmation; such reports share one record that a later report without windows does not clear before it expires', async () => {
    h = await createHarness();
    const a = (await createEnv(h, 'US-Buyer-A', '203.0.113.10')).environment_id!;
    await bind(h, PROFILE_A, a);
    const report = (windows: number) => h.native(null, { type: 'reportProfileState', windows_open: windows, amazon_tabs_open: false, site_permission_granted: true });
    const activate = () => h.native(PROFILE_A, { type: 'activateCurrentEnvironment', request_id: rid(), environment_id: a, amazon_tabs_open: false });
    const routeBefore = h.repos.routeState.get();
    expect((await report(2)).ok).toBe(true);
    // 只作提示，不改变路由
    expect({ ...h.repos.routeState.get(), updatedAt: '' }).toEqual({ ...routeBefore, updatedAt: '' });
    const first = await activate();
    expect(first.ok).toBe(false);
    const details = (first as unknown as { error: { code: string; details: { reason: string; otherProfilesOpen: unknown[] } } }).error;
    expect(details.code).toBe('NEEDS_CONFIRMATION');
    expect(details.details.reason).toBe('other_profiles_open');
    expect(details.details.otherProfilesOpen).toEqual([{ profileIdShort: '', environmentLabel: null, unidentified: true }]);
    // 另一个（或同一个）未识别场景随后上报没有窗口：有效期内不覆盖有窗口的上报
    h.clock.advance(300_000);
    expect((await report(0)).ok).toBe(true);
    expect(await activate()).toMatchObject({ ok: false, error: { code: 'NEEDS_CONFIRMATION' } });
    // 有窗口的上报刷新有效期；只有较小窗口数的上报也一样计入
    expect((await report(1)).ok).toBe(true);
    h.clock.advance(400_000);
    expect(await activate()).toMatchObject({ ok: false, error: { code: 'NEEDS_CONFIRMATION' } });
    // 最后一次有窗口的上报过期后不再计入
    h.clock.advance(201_000);
    const accepted = await activate();
    expect(accepted.ok).toBe(true);
  });

  test('preflight failure before any route write leaves route, selection and environment unchanged', async () => {
    h = await createHarness();
    const { a, b } = await twoEnvs();
    h.clock.advance(901_000); // 预检过期
    h.fake.setPolicyTestResult('SFE-N-E0002-US02-v001', { ok: false, latencyMs: null, error: 'front down' });
    const before = writesCount();
    const routeBefore = h.repos.routeState.get();
    const opId = await startSwitch(b);
    const op = h.repos.operations.get(opId)!;
    expect(op.phase).toBe('FAILED');
    expect(op.error?.code).toBe('PREFLIGHT_FAILED');
    expect(writesCount()).toEqual(before);
    const route = h.repos.routeState.get();
    expect(route.routeEpoch).toBe(routeBefore.routeEpoch);
    expect(route.entryMode).toBe('ACTIVE');
    expect(route.activeEnvironmentId).toBe(a);
  });

  test('deferred preflight goes through SFE-ROUTE after blocking when independent preflight is unsupported', async () => {
    h = await createHarness();
    const { b } = await twoEnvs();
    h.revoke(['independent_node_preflight']);
    const opId = await startSwitch(b);
    const steps = h.repos.operations.listSteps(opId).map((s) => s.message);
    expect(steps.some((m) => m.includes('推迟'))).toBe(true);
    expect(steps.some((m) => m.includes('经 SFE-ROUTE 的预检通过'))).toBe(true);
    const p = h.repos.probes.latest(b, 'preflight')!;
    expect(p.operationId).toBe(opId);
    expect(p.routeEpoch).toBe(2);
    expect(h.repos.operations.get(opId)!.phase).toBe('VERIFY_ONLY');
  });

  test('deferred preflight failure through SFE-ROUTE rolls back', async () => {
    h = await createHarness();
    const { a, b } = await twoEnvs();
    const prevNode = h.repos.routeState.get().selectedNode;
    h.revoke(['independent_node_preflight']);
    h.fake.setPolicyTestResult('SFE-ROUTE', { ok: false, latencyMs: null, error: 'front down' });
    const opId = await startSwitch(b);
    const op = h.repos.operations.get(opId)!;
    expect(op.phase).toBe('FAILED');
    expect(op.error?.code).toBe('PREFLIGHT_FAILED');
    const route = h.repos.routeState.get();
    expect(route.entryMode).toBe('BLOCKED');
    expect(route.activeEnvironmentId).toBe(a);
    expect(route.selectedNode).toBe(prevNode);
    expect(route.warnings).toContain('rollback_needs_reverify');
  });
});

describe('reuse and Safari re-probe', () => {
  test('reuse: same env and revision, verified and fresh → completes without epoch bump, block, kill or selection', async () => {
    h = await createHarness();
    const { envId } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const before = writesCount();
    const epoch = h.repos.routeState.get().routeEpoch;
    const a = await h.app.activate(envId, { request_id: rid() }, WEB);
    await h.idle();
    const op = h.repos.operations.get(a.operation_id)!;
    expect(op.phase).toBe('ACTIVE_VERIFIED');
    expect(op.result).toMatchObject({ reused: true });
    expect(writesCount()).toEqual(before);
    expect(h.repos.routeState.get().routeEpoch).toBe(epoch);
  });

  test('reuse with an expired probe becomes a Safari re-probe (no switch)', async () => {
    h = await createHarness();
    const { envId } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    h.clock.advance(901_000);
    const before = writesCount();
    const a = await h.app.activate(envId, { request_id: rid() }, WEB);
    await h.idle();
    let op = h.repos.operations.get(a.operation_id)!;
    expect(op.status).toBe('waiting');
    expect(op.probeKind).toBe('safari');
    const r = await verify(h, PROFILE_A, a.operation_id);
    expect(r.ok).toBe(true);
    op = h.repos.operations.get(a.operation_id)!;
    expect(op.phase).toBe('ACTIVE_VERIFIED');
    expect(writesCount()).toEqual(before);
    expect(h.repos.routeState.get().routeEpoch).toBe(1);
    // 实测命中 active 规则
    expect(h.repos.probes.latest(envId, 'safari')!.surgeRule).toContain('sfe-entry-active.list');
  });

  test('probe.safari: success refreshes the probe; mismatch records exit_ip_mismatch and never switches', async () => {
    h = await createHarness();
    const { envId } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const before = writesCount();
    const p1 = await h.app.probe(envId, { request_id: rid(), kind: 'safari' }, WEB);
    await h.idle();
    expect((await verify(h, PROFILE_A, p1.operation_id)).ok).toBe(true);
    expect(h.repos.operations.get(p1.operation_id)!.phase).toBe('ACTIVE_VERIFIED');
    // 设定预期出口后重测不符
    const env = h.repos.environments.get(envId)!;
    await h.app.updateEnvironment(envId, { request_id: rid(), expected_revision: env.revision, changes: { proxy: { expectedExitIp: '192.0.2.50' } } }, WEB);
    const p2 = await h.app.probe(envId, { request_id: rid(), kind: 'safari' }, WEB);
    await h.idle();
    await verify(h, PROFILE_A, p2.operation_id, { observedIp: '192.0.2.77' });
    const op2 = h.repos.operations.get(p2.operation_id)!;
    expect(op2.phase).toBe('FAILED');
    expect(op2.error?.code).toBe('EXIT_IP_MISMATCH');
    const route = h.repos.routeState.get();
    expect(route.warnings).toContain('exit_ip_mismatch');
    expect(route.entryMode).toBe('ACTIVE');
    expect(route.activeEnvironmentId).toBe(envId);
    expect(writesCount()).toEqual(before);
    expect(h.repos.probes.latest(envId, 'safari')!.outcome).toBe('mismatch');
    expect((await h.app.ensureInControl()).ok).toBe(false);
  });

  test('probe.safari is refused for a non-active environment and while a switch is waiting', async () => {
    h = await createHarness();
    const { a, b } = await twoEnvs();
    await expectError(h.app.probe(b, { request_id: rid(), kind: 'safari' }, WEB), 'VALIDATION_FAILED');
    await startSwitch(b);
    await expectError(h.app.probe(a, { request_id: rid(), kind: 'safari' }, WEB), 'VALIDATION_FAILED');
  });
});

describe('warnings on ACTIVE_VERIFIED', () => {
  test('keep-open, Amazon tabs at launch and unproven first request', async () => {
    h = await createHarness();
    const { a, b } = await twoEnvs();
    h.revoke(['first_request_and_old_connections']);
    const r = await h.native(PROFILE_B, { type: 'activateCurrentEnvironment', request_id: rid(), environment_id: b, old_session_policy: 'keep_open_acknowledged', confirmed_environment_id: a, amazon_tabs_open: true });
    expect(r.ok).toBe(true);
    const opId = (r as { data: { operation_id: string } }).data.operation_id;
    await h.idle();
    await verify(h, PROFILE_B, opId);
    const route = h.repos.routeState.get();
    expect(route.warnings).toEqual(expect.arrayContaining(['launch_unverified', 'launch_order_unverified', 'old_session_unproven', 'old_windows_kept_open']));
    // 下一次受控激活且上报无 Amazon 标签页 → 清除 launch_unverified；用户确认窗口已关闭 → 清除 old_windows_kept_open
    h.grant(['first_request_and_old_connections']);
    const back = await h.native(PROFILE_A, { type: 'activateCurrentEnvironment', request_id: rid(), environment_id: a, old_session_policy: 'closed_confirmed', confirmed_environment_id: b, amazon_tabs_open: false });
    const backId = (back as { data: { operation_id: string } }).data.operation_id;
    await h.idle();
    await verify(h, PROFILE_A, backId, { amazonTabs: false });
    expect(h.repos.routeState.get().warnings).toEqual([]);
  });

  test('acknowledgeWindows clears window warnings only', async () => {
    h = await createHarness();
    const { a, b } = await twoEnvs();
    const opId = await startSwitch(b, { old_session_policy: 'keep_open_acknowledged', confirmed_environment_id: a });
    await verify(h, PROFILE_B, opId);
    expect(h.repos.routeState.get().warnings).toContain('old_windows_kept_open');
    const epoch = h.repos.routeState.get().routeEpoch;
    const ack = await h.app.acknowledgeWindows({ request_id: rid() }, WEB);
    expect(h.repos.operations.get(ack.operation_id)!.phase).toBe('COMPLETED');
    const route = h.repos.routeState.get();
    expect(route.warnings).not.toContain('old_windows_kept_open');
    expect(route.routeEpoch).toBe(epoch);
    expect(route.activeEnvironmentId).toBe(b);
  });
});

describe('concurrency matrix', () => {
  test('queued route operation → ROUTE_BUSY for new activation and probe; normal mode is never refused: it is queued behind, the queued activation stops before its first Surge write and the normal mode restores the original rules', async () => {
    h = await createHarness();
    const { a, b } = await twoEnvs();
    const nodeA = h.repos.routeState.get().selectedNode;
    const epoch = h.repos.routeState.get().routeEpoch;
    await h.app.executor.stop();
    const act = await h.app.activate(b, { request_id: rid(), old_session_policy: 'closed_confirmed', confirmed_environment_id: a }, WEB);
    await expectError(h.app.activate(a, { request_id: rid() }, WEB), 'ROUTE_BUSY');
    await expectError(h.app.probe(a, { request_id: rid(), kind: 'safari' }, WEB), 'ROUTE_BUSY');
    expect(h.app.views.routeView().normalModeOffered).toBe(true);
    const n = await h.app.enterNormal({ request_id: rid(), old_session_policy: 'closed_confirmed', confirmed_environment_id: a }, WEB);
    expect(h.repos.operations.get(n.operation_id)).toMatchObject({ status: 'queued' });
    expect(h.repos.operations.listSteps(n.operation_id).map((st) => st.message)).toEqual(['已受理进入普通模式：正在进行的切换或检测停下（或完成）之后立即执行']);
    // 排队的普通模式之后，新的激活仍返回 ROUTE_BUSY
    await expectError(h.app.activate(a, { request_id: rid() }, WEB), 'ROUTE_BUSY');
    const selects = h.fake.calls.selectGroupPolicy ?? 0;
    h.app.executor.start();
    await h.idle();
    // 激活在第一次写入 Surge 之前停下（没有递增 epoch、阻断、结束连接或改选 B 的节点），路由交给普通模式
    expect(h.repos.operations.get(act.operation_id)).toMatchObject({ phase: 'SUPERSEDED', status: 'superseded', supersededBy: n.operation_id, routeEpoch: null });
    const phases = h.repos.operations.listSteps(act.operation_id).map((st) => st.phase);
    expect(phases).not.toContain('SAFARI_BLOCKED');
    expect(phases).not.toContain('VERIFY_ONLY');
    expect(h.repos.operations.listSteps(act.operation_id).at(-1)!.message).toBe(
      '已被进入普通模式取代：在第一次写入 Surge 之前停下（没有阻断 Safari、没有结束连接、没有改选节点），由普通模式从当前状态进入普通模式',
    );
    expect(h.fake.calls.selectGroupPolicy ?? 0).toBe(selects);
    expect(await h.fake.getGroupSelection('SFE-ROUTE')).toBe(nodeA);
    expect(h.repos.operations.get(n.operation_id)!.phase).toBe('NORMAL_RESTORED');
    expect(h.repos.routeState.get()).toMatchObject({ entryMode: 'NORMAL', phase: 'idle', activeEnvironmentId: null, activationSnapshot: null, routeEpoch: epoch });
    expect(safariOutcome(h).rule).toBe('FINAL,DIRECT');
    expect(h.fake.calls.reloadProfile ?? 0).toBe(0);
  });

  /** Surge 的写入痕迹：入口规则集文件与重新加载、临时规则、SFE-ROUTE 改选、结束连接。 */
  const surgeWrites = () => ({
    ...entryWrites(h.fake),
    tempRules: [...h.fake.tempRules],
    add: h.fake.calls.addTempRule ?? 0,
    remove: h.fake.calls.removeTempRule ?? 0,
    select: h.fake.calls.selectGroupPolicy ?? 0,
    selection: null as string | null,
    kill: h.fake.calls.killRequest ?? 0,
  });
  const writesNow = async () => ({ ...surgeWrites(), selection: await h.fake.getGroupSelection('SFE-ROUTE') });

  /** 第一次激活（从普通模式出发）：环境已部署、已关联；Safari 有一条按原规则发出的长连接。 */
  async function firstActivationSetup() {
    const env = (await createEnv(h, 'US-Buyer-A', '203.0.113.10')).environment_id!;
    await bind(h, PROFILE_A, env);
    const daily = h.fake.simulateRequest({ processPath: FAKE_SAFARI_PATH, host: 'www.example.test', protocol: 'tcp', longLived: true });
    expect(daily.rule).toBe('FINAL,DIRECT');
    return { env, daily };
  }

  /** 激活停在第一次写入之前、普通模式完成：两者都没有写入 Surge（从空闲的普通模式出发，普通模式也不需要写入），Safari 按原规则的连接仍在。 */
  async function expectStoppedBeforeFirstWrite(
    actId: string,
    normalId: string,
    before: Awaited<ReturnType<typeof writesNow>>,
    epoch: number,
    dailyId: string,
    opts: { checksSkipped: boolean },
  ) {
    const act = h.repos.operations.get(actId)!;
    expect(act).toMatchObject({ phase: 'SUPERSEDED', status: 'superseded', supersededBy: normalId, routeEpoch: null });
    expect(h.repos.operations.listSteps(actId).at(-1)!.message).toContain('在第一次写入 Surge 之前停下（没有阻断 Safari、没有结束连接、没有改选节点）');
    const phases = h.repos.operations.listSteps(actId).map((st) => st.phase);
    expect(phases).not.toContain('SAFARI_BLOCKED');
    // 仍在排队时受理：开始执行时就停下，连第 1–3 步的检查（预检）也不做
    if (opts.checksSkipped) expect(phases).not.toContain('PREFLIGHT_OK');
    expect(h.repos.operations.get(normalId)!.phase).toBe('NORMAL_RESTORED');
    expect(await writesNow()).toEqual(before);
    expect(h.repos.routeState.get()).toMatchObject({ entryMode: 'NORMAL', phase: 'idle', activeEnvironmentId: null, activationSnapshot: null, routeEpoch: epoch });
    expect((await h.fake.listActiveRequests()).map((r) => r.id)).toContain(dailyId);
    expect(safariOutcome(h).rule).toBe('FINAL,DIRECT');
    expect(h.fake.calls.reloadProfile ?? 0).toBe(0);
  }

  test.each(['ruleset_resource', 'temp_rule'] as const)(
    'normal mode accepted while the first activation is still queued: the activation stops before touching Surge (no block, no kill of Safari connections on the original rules, no node selected); the normal mode completes (%s)',
    async (entryStrategy) => {
      h = await createHarness({ entryStrategy });
      const { env, daily } = await firstActivationSetup();
      const before = await writesNow();
      const epoch = h.repos.routeState.get().routeEpoch;
      await h.app.executor.stop();
      const act = await h.app.activate(env, { request_id: rid() }, WEB);
      const n = await h.app.enterNormal({ request_id: rid() }, WEB);
      expect(h.repos.operations.get(n.operation_id)!.payload).toMatchObject({ normal: { queuedBehind: [act.operation_id] } });
      h.app.executor.start();
      await h.idle();
      await expectStoppedBeforeFirstWrite(act.operation_id, n.operation_id, before, epoch, daily.id, { checksSkipped: true });
    },
  );

  test('normal mode accepted while a crashed activation is re-run by crash recovery: the re-run stops before touching Surge', async () => {
    h = await createHarness({ dbFile: true });
    const { env, daily } = await firstActivationSetup();
    const before = await writesNow();
    const epoch = h.repos.routeState.get().routeEpoch;
    await h.app.executor.stop();
    const act = await h.app.activate(env, { request_id: rid() }, WEB);
    const n = await h.app.enterNormal({ request_id: rid() }, WEB);
    // 服务在激活开始检查条件时（第一次写入之前）崩溃：操作停在 running，重启后由崩溃恢复重新执行
    h.repos.operations.update(act.operation_id, { status: 'running', phase: 'VALIDATING' });
    await h.crash();
    await h.idle();
    await expectStoppedBeforeFirstWrite(act.operation_id, n.operation_id, before, epoch, daily.id, { checksSkipped: true });
  });

  test('normal mode accepted during the activation\'s pre-write checks (step 2 reads): the activation stops before its blocking step, without any Surge write', async () => {
    let hook: (() => Promise<void>) | null = null;
    h = await createHarness({ surge: (fake) => beforeCall(fake, 'getGroupMembers', () => hook) });
    const { env, daily } = await firstActivationSetup();
    const before = await writesNow();
    const epoch = h.repos.routeState.get().routeEpoch;
    let normalId: string | null = null;
    hook = async () => {
      const running = h.repos.operations.listByStatus(['running']).find((o) => o.kind === 'route.activate');
      if (!running) return;
      hook = null;
      normalId = (await h.app.enterNormal({ request_id: rid() }, WEB)).operation_id;
    };
    const act = await h.app.activate(env, { request_id: rid() }, WEB);
    await h.idle();
    expect(normalId).not.toBeNull();
    await expectStoppedBeforeFirstWrite(act.operation_id, normalId!, before, epoch, daily.id, { checksSkipped: false });
  });

  test('normal mode accepted while an active-environment publish switch runs its pre-write checks: the switch stops before blocking Safari; the normal mode completes', async () => {
    let hook: (() => Promise<void>) | null = null;
    h = await createHarness({ surge: (fake) => beforeCall(fake, 'getGroupMembers', () => hook) });
    const { envId } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const env = h.repos.environments.get(envId)!;
    const nodeV1 = h.repos.routeState.get().selectedNode;
    const epoch = h.repos.routeState.get().routeEpoch;
    const u = await h.app.updateEnvironment(envId, { request_id: rid(), expected_revision: env.revision, changes: { proxy: { host: '203.0.113.20' } } }, WEB);
    await h.idle();
    expect(h.repos.operations.get(u.operation_id)!.phase).toBe('WAITING_ROUTE');
    const selects = h.fake.calls.selectGroupPolicy ?? 0;
    let normalId: string | null = null;
    hook = async () => {
      if (h.repos.operations.get(u.operation_id)!.status !== 'running') return;
      hook = null;
      normalId = (await h.app.enterNormal({ request_id: rid(), old_session_policy: 'closed_confirmed', confirmed_environment_id: envId }, WEB)).operation_id;
    };
    await h.native(PROFILE_A, { type: 'beginSafariVerification', operation_id: u.operation_id, amazon_tabs_open: false });
    await h.idle();
    expect(normalId).not.toBeNull();
    const op = h.repos.operations.get(u.operation_id)!;
    // 新版本已部署、未切换：与停在 WAITING_ROUTE 时被普通模式结束一样记为 READY_FOR_NEXT_OPEN（不是被取代的失败）
    expect(op).toMatchObject({ phase: 'READY_FOR_NEXT_OPEN', status: 'succeeded', supersededBy: normalId, routeEpoch: null, error: null });
    expect(h.repos.operations.listSteps(u.operation_id).at(-1)!.message).toContain('新版本已部署，未切换：已有进入普通模式的请求');
    expect(h.repos.environments.get(envId)!.deployedProxyRevision).toBe(2);
    expect(h.repos.operations.listSteps(u.operation_id).map((st) => st.phase)).not.toContain('SAFARI_BLOCKED');
    // 没有改选新版本的节点；普通模式不改变 SFE-ROUTE 的选择
    expect(h.fake.calls.selectGroupPolicy ?? 0).toBe(selects);
    expect(await h.fake.getGroupSelection('SFE-ROUTE')).toBe(nodeV1);
    expect(h.repos.operations.get(normalId!)!.phase).toBe('NORMAL_RESTORED');
    expect(h.repos.routeState.get()).toMatchObject({ entryMode: 'NORMAL', phase: 'idle', activeEnvironmentId: null, routeEpoch: epoch });
    expect(safariOutcome(h).rule).toBe('FINAL,DIRECT');
  });

  test('normal mode accepted while the activation selects the node (after blocking): the activation still stops before VERIFY_ONLY with Safari confirmed blocked', async () => {
    let hook: (() => Promise<void>) | null = null;
    h = await createHarness({ surge: (fake) => beforeCall(fake, 'selectGroupPolicy', () => hook) });
    const { a, b } = await twoEnvs();
    let normalId: string | null = null;
    hook = async () => {
      hook = null;
      normalId = (await h.app.enterNormal({ request_id: rid(), old_session_policy: 'closed_confirmed', confirmed_environment_id: a }, WEB)).operation_id;
    };
    const opId = await startSwitch(b);
    expect(normalId).not.toBeNull();
    expect(h.repos.operations.get(opId)).toMatchObject({ phase: 'SUPERSEDED', status: 'superseded', supersededBy: normalId });
    expect(h.repos.operations.listSteps(opId).map((st) => st.phase)).toContain('SAFARI_BLOCKED');
    expect(h.repos.operations.listSteps(opId).map((st) => st.phase)).not.toContain('VERIFY_ONLY');
    expect(h.repos.operations.listSteps(opId).at(-1)!.message).toBe(
      '已被进入普通模式取代：在只开放检测服务（VERIFY_ONLY）之前停下，Safari 保持已确认的阻断，由普通模式撤销本应用入口并结束 Safari 连接',
    );
    expect(h.repos.operations.get(normalId!)!.phase).toBe('NORMAL_RESTORED');
    expect(h.repos.routeState.get()).toMatchObject({ entryMode: 'NORMAL', phase: 'idle', activeEnvironmentId: null, activationSnapshot: null });
    expect(safariOutcome(h).rule).toBe('FINAL,DIRECT');
  });

  test.each(['ruleset_resource', 'temp_rule'] as const)(
    'normal mode accepted while a passed verification is being checked: the activation does not write ACTIVE or commit, the normal mode runs right after and the earlier environment\'s confirmation still holds (%s)',
    async (entryStrategy) => {
      let hook: (() => Promise<void>) | null = null;
      h = await createHarness({ entryStrategy, surge: (fake) => beforeCall(fake, 'listRecentRequests', () => hook) });
      const { a, b } = await twoEnvs();
      const opId = await startSwitch(b);
      expect(h.repos.operations.get(opId)!.phase).toBe('VERIFY_ONLY');
      let normalId: string | null = null;
      hook = async () => {
        hook = null;
        const op = h.repos.operations.get(opId)!;
        expect(op.status).toBe('running');
        normalId = (await h.app.enterNormal({ request_id: rid(), old_session_policy: 'closed_confirmed', confirmed_environment_id: a }, WEB)).operation_id;
      };
      const r = await verify(h, PROFILE_B, opId);
      expect(r.ok).toBe(true);
      await h.idle();
      expect(normalId).not.toBeNull();
      expect(h.repos.operations.get(opId)).toMatchObject({ phase: 'SUPERSEDED', status: 'superseded', supersededBy: normalId });
      // 没有写入 ACTIVE、没有提交 B：B 没有实测记录，也没有成为使用中的环境
      expect(h.repos.operations.listSteps(opId).map((st) => st.phase)).not.toContain('ACTIVE_VERIFIED');
      expect(h.repos.operations.listSteps(opId).at(-1)!.message).toContain('在进入使用中模式（ACTIVE）之前停下，未提交');
      expect(h.repos.probes.latest(b, 'safari')).toBeNull();
      expect(h.repos.operations.get(normalId!)!.phase).toBe('NORMAL_RESTORED');
      expect(h.repos.routeState.get()).toMatchObject({ entryMode: 'NORMAL', phase: 'idle', activeEnvironmentId: null, activationSnapshot: null });
      expect(safariOutcome(h).rule).toBe('FINAL,DIRECT');
    },
  );

  test('normal mode accepted while ACTIVE is being written: the activation does not commit; the normal mode undoes the ACTIVE entry (temp_rule)', async () => {
    let afterCheck = false;
    let hook: (() => Promise<void>) | null = null;
    h = await createHarness({
      entryStrategy: 'temp_rule',
      surge: (fake) =>
        beforeCall(beforeCall(fake, 'listRecentRequests', () => (afterCheck = true, null)), 'addTempRule', () => (afterCheck ? hook : null)),
    });
    const { a, b } = await twoEnvs();
    afterCheck = false;
    const opId = await startSwitch(b);
    let normalId: string | null = null;
    hook = async () => {
      hook = null;
      normalId = (await h.app.enterNormal({ request_id: rid(), old_session_policy: 'closed_confirmed', confirmed_environment_id: a }, WEB)).operation_id;
    };
    expect((await verify(h, PROFILE_B, opId)).ok).toBe(true);
    await h.idle();
    expect(normalId).not.toBeNull();
    const stopped = h.repos.operations.get(opId)!;
    expect(stopped).toMatchObject({ phase: 'SUPERSEDED', supersededBy: normalId });
    expect(h.repos.operations.listSteps(opId).at(-1)!.message).toContain('入口已进入使用中模式（ACTIVE，读回确认），在提交之前停下，未提交');
    expect(h.repos.probes.latest(b, 'safari')).toBeNull();
    const n = h.repos.operations.get(normalId!)!;
    expect(n.phase).toBe('NORMAL_RESTORED');
    // 普通模式从读回的 ACTIVE 撤销本应用入口
    expect(h.repos.routeState.get()).toMatchObject({ entryMode: 'NORMAL', phase: 'idle', activeEnvironmentId: null });
    expect(h.fake.tempRules).toEqual([]);
    expect(safariOutcome(h).rule).toBe('FINAL,DIRECT');
  });

  test('normal mode accepted while a Safari re-test is starting: queued, then it ends the waiting re-test (test id invalid) and restores the original rules', async () => {
    let hook: (() => Promise<void>) | null = null;
    h = await createHarness({ surge: (fake) => beforeCall(fake, 'getGroupSelection', () => hook) });
    const { envId } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    let normalId: string | null = null;
    hook = async () => {
      hook = null;
      normalId = (await h.app.enterNormal({ request_id: rid(), old_session_policy: 'closed_confirmed', confirmed_environment_id: envId }, WEB)).operation_id;
    };
    const probe = await h.app.probe(envId, { request_id: rid(), kind: 'safari' }, WEB);
    await h.idle();
    expect(normalId).not.toBeNull();
    expect(h.repos.operations.get(probe.operation_id)).toMatchObject({ phase: 'SUPERSEDED', status: 'superseded', supersededBy: normalId });
    expect(h.repos.operations.get(normalId!)!.phase).toBe('NORMAL_RESTORED');
    expect(h.repos.routeState.get()).toMatchObject({ entryMode: 'NORMAL', phase: 'idle', activeEnvironmentId: null });
    const begin = await h.native(PROFILE_A, { type: 'beginSafariVerification', operation_id: probe.operation_id, amazon_tabs_open: false });
    expect(begin).toMatchObject({ ok: false, error: { code: 'SUPERSEDED' } });
  });

  test('a waiting activation is SUPERSEDED by a new activation; its test id becomes stale', async () => {
    h = await createHarness();
    const { a, b } = await twoEnvs();
    const c = (await createEnv(h, 'US-Buyer-C', '203.0.113.12')).environment_id!;
    await bind(h, PROFILE_C, c);
    const first = await startSwitch(b);
    const begin = await h.native(PROFILE_B, { type: 'beginSafariVerification', operation_id: first, amazon_tabs_open: false });
    const test1 = (begin as { data: { test_id: string; route_epoch: number } }).data;
    const second = await startSwitch(c, { confirmed_environment_id: a });
    const old = h.repos.operations.get(first)!;
    expect(old.phase).toBe('SUPERSEDED');
    expect(old.supersededBy).toBe(second);
    const stale = await h.native(PROFILE_B, {
      type: 'submitSafariVerification',
      operation_id: first,
      test_id: test1.test_id,
      route_epoch: test1.route_epoch,
      observed_ip: '192.0.2.1',
      http_status: 200,
      error: null,
      started_at: h.clock.now().toISOString(),
      finished_at: h.clock.now().toISOString(),
    });
    expect(stale.ok).toBe(false);
    expect(['SUPERSEDED', 'STALE_ROUTE_EPOCH']).toContain((stale as { error: { code: string } }).error.code);
    expect(h.repos.operations.get(second)!.phase).toBe('VERIFY_ONLY');
    // 新切换失败时回滚到最初的已验证路由（A），不是被取代的 B
    const nodeA = h.repos.proxyRevisions.get(a, 1)!.nodeName;
    await h.app.cancelOperation(second, { request_id: rid() }, WEB);
    await h.idle();
    const rb = (h.repos.operations.get(second)!.result as { rollback: RollbackResult }).rollback;
    expect(rb.previousEnvironmentId).toBe(a);
    expect(rb.restoredSelection).toBe(nodeA);
  });

  test('a verification begun while the selection is being read back, and superseded meanwhile by an accepted normal mode, issues no test id and writes nothing for the superseded switch', async () => {
    h = await createHarness();
    const { a, b } = await twoEnvs();
    const opB = await startSwitch(b);
    expect(h.repos.operations.get(opB)!.phase).toBe('VERIFY_ONLY');
    // 准备页到达：签发前重读 SFE-ROUTE 选择（一次 Surge 调用）挂起
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const select = h.fake.getGroupSelection.bind(h.fake);
    let held = false;
    h.fake.getGroupSelection = async (group: string) => {
      if (!held) {
        held = true;
        await gate;
      }
      return select(group);
    };
    const begin = h.native(PROFILE_B, { type: 'beginSafariVerification', operation_id: opB, amazon_tabs_open: false });
    for (let i = 0; i < 50 && !held; i++) await new Promise((r) => setTimeout(r, 0));
    expect(held).toBe(true);
    // 读取期间受理普通模式：取代等待中的切换（epoch 递增，路由交给普通模式）
    const n = await h.app.enterNormal({ request_id: rid(), old_session_policy: 'closed_confirmed', confirmed_environment_id: a }, WEB);
    expect(h.repos.operations.get(opB)!.status).toBe('superseded');
    const steps = h.repos.operations.listSteps(opB).length;
    release();
    const r = await begin;
    await h.idle();
    expect(r.ok).toBe(false);
    expect((r as { error: { code: string } }).error.code).toBe('SUPERSEDED');
    expect(h.repos.verificationTests.listForOperation(opB)).toEqual([]);
    expect(h.repos.operations.listSteps(opB).length).toBe(steps);
    expect(h.repos.outbox.pendingForOperation(opB)).toEqual([]);
    expect(h.repos.operations.get(n.operation_id)!.phase).toBe('NORMAL_RESTORED');
    expect(h.repos.routeState.get()).toMatchObject({ entryMode: 'NORMAL', phase: 'idle', awaitingDeadline: null });
  });

  test('a normal mode accepted while an activation runs is executed as soon as the activation hands it the route, before an operation accepted earlier that is not a route operation', async () => {
    let hook: (() => Promise<void>) | null = null;
    h = await createHarness({ surge: (fake) => beforeCall(fake, 'selectGroupPolicy', () => hook) });
    const { a, b } = await twoEnvs();
    let normalId: string | null = null;
    let createId: string | null = null;
    hook = async () => {
      hook = null;
      // 切换选择节点期间：先受理一次环境创建（发布，不是路由操作），再受理普通模式
      createId = (await h.app.createEnvironment({ request_id: rid('create'), environment: envInput('US-Buyer-C', '203.0.113.12') }, WEB)).operation_id;
      h.clock.advance(1_000);
      normalId = (await h.app.enterNormal({ request_id: rid(), old_session_policy: 'closed_confirmed', confirmed_environment_id: a }, WEB)).operation_id;
    };
    const mark = h.events.length;
    const opId = await startSwitch(b);
    expect(normalId).not.toBeNull();
    expect(createId).not.toBeNull();
    expect(h.repos.operations.get(opId)).toMatchObject({ phase: 'SUPERSEDED', supersededBy: normalId });
    // 执行顺序：普通模式开始执行（running）早于受理更早的发布
    const started = (id: string) =>
      h.events.findIndex((e, i) => i >= mark && e.type === 'operation.updated' && (e as { operation: { id: string; status: string } }).operation.id === id && (e as { operation: { status: string } }).operation.status === 'running');
    expect(started(normalId!)).toBeGreaterThan(-1);
    expect(started(createId!)).toBeGreaterThan(-1);
    expect(started(normalId!)).toBeLessThan(started(createId!));
    expect(h.repos.operations.get(normalId!)!.phase).toBe('NORMAL_RESTORED');
    expect(h.repos.operations.get(createId!)!.status).toBe('succeeded');
  });

  test('normal mode supersedes a waiting activation', async () => {
    h = await createHarness();
    const { a, b } = await twoEnvs();
    const first = await startSwitch(b);
    const n = await h.app.enterNormal({ request_id: rid(), old_session_policy: 'closed_confirmed', confirmed_environment_id: a }, WEB);
    await h.idle();
    expect(h.repos.operations.get(first)!.phase).toBe('SUPERSEDED');
    expect(h.repos.operations.get(n.operation_id)!.phase).toBe('NORMAL_RESTORED');
    expect(h.repos.routeState.get().entryMode).toBe('NORMAL');
  });

  /**
   * 网页后台只在 environment.updated 事件中更新环境：被普通模式结束（受理时取代、开始执行时取代、执行中让路）的激活，其目标
   * 环境的最后一个事件必须与服务端当前视图一致，否则网页一直显示它「切换中」、算作使用中（删除与解除关联在本地被拒绝）。
   */
  function lastEnvironmentEvent(id: string) {
    const last = h.events.filter((e) => e.type === 'environment.updated' && e.environment.id === id).at(-1);
    return last && last.type === 'environment.updated' ? last.environment : null;
  }
  function expectEventMatchesView(id: string): void {
    const ev = lastEnvironmentEvent(id)!;
    const fresh = h.app.views.environmentView(id)!;
    expect(fresh.facets.route).toBe('inactive');
    expect({ route: ev.facets.route, readiness: ev.readiness, lastOp: ev.lastOperation?.phase }).toEqual({
      route: fresh.facets.route,
      readiness: fresh.readiness,
      lastOp: fresh.lastOperation?.phase,
    });
  }

  test('a waiting activation superseded when the normal mode is accepted: its environment is re-sent', async () => {
    h = await createHarness();
    const { a, b } = await twoEnvs();
    const opId = await startSwitch(b);
    expect(h.repos.operations.get(opId)!.phase).toBe('VERIFY_ONLY');
    await h.app.enterNormal({ request_id: rid(), old_session_policy: 'closed_confirmed', confirmed_environment_id: a }, WEB);
    await h.idle();
    expect(h.repos.operations.get(opId)!.phase).toBe('SUPERSEDED');
    expectEventMatchesView(b);
  });

  test('a waiting activation superseded by a new activation of another environment: its environment is re-sent', async () => {
    h = await createHarness();
    const { b } = await twoEnvs();
    const c = (await createEnv(h, 'US-Buyer-C', '203.0.113.12')).environment_id!;
    await bind(h, PROFILE_C, c);
    const opB = await startSwitch(b);
    expect(h.repos.operations.get(opB)!.phase).toBe('VERIFY_ONLY');
    const opC = await startSwitch(c);
    expect(h.repos.operations.get(opB)!.phase).toBe('SUPERSEDED');
    expect(h.repos.operations.get(opC)!.phase).toBe('VERIFY_ONLY');
    expectEventMatchesView(b);
  });

  test('an activation that yields to a queued normal mode before writing ACTIVE: its environment is re-sent', async () => {
    let hook: (() => Promise<void>) | null = null;
    h = await createHarness({ surge: (fake) => beforeCall(fake, 'listRecentRequests', () => hook) });
    const { a, b } = await twoEnvs();
    const opId = await startSwitch(b);
    expect(h.repos.operations.get(opId)!.phase).toBe('VERIFY_ONLY');
    hook = async () => {
      hook = null;
      await h.app.enterNormal({ request_id: rid(), old_session_policy: 'closed_confirmed', confirmed_environment_id: a }, WEB);
    };
    expect((await verify(h, PROFILE_B, opId)).ok).toBe(true);
    await h.idle();
    expect(h.repos.operations.get(opId)!.phase).toBe('SUPERSEDED');
    expectEventMatchesView(b);
  });

  test('an activation that reached its VERIFY_ONLY wait after the normal mode was queued, superseded when the normal mode starts: its environment is re-sent', async () => {
    let selected = false;
    let hook: (() => Promise<void>) | null = null;
    h = await createHarness({
      entryStrategy: 'temp_rule',
      surge: (fake) => beforeCall(beforeCall(fake, 'selectGroupPolicy', () => ((selected = true), null)), 'addTempRule', () => (selected ? hook : null)),
    });
    const { a, b } = await twoEnvs();
    selected = false;
    hook = async () => {
      hook = null;
      await h.app.enterNormal({ request_id: rid(), old_session_policy: 'closed_confirmed', confirmed_environment_id: a }, WEB);
    };
    const opId = await startSwitch(b);
    expect(hook).toBeNull();
    expect(h.repos.operations.listSteps(opId).map((st) => st.phase)).toContain('VERIFY_ONLY');
    expect(h.repos.operations.get(opId)!.phase).toBe('SUPERSEDED');
    expectEventMatchesView(b);
  });
});

describe('rollback (§6.3 step 14)', () => {
  test('verify timeout → rollback restores the previous node, keeps Safari blocked, then user re-verifies', async () => {
    h = await createHarness();
    const { a, b } = await twoEnvs();
    const nodeA = h.repos.proxyRevisions.get(a, 1)!.nodeName;
    const opId = await startSwitch(b);
    const begin = await h.native(PROFILE_B, { type: 'beginSafariVerification', operation_id: opId, amazon_tabs_open: false });
    expect(begin.ok).toBe(true);
    await h.clock.advanceAsync(121_000);
    await h.idle();
    const op = h.repos.operations.get(opId)!;
    expect(op.phase).toBe('FAILED');
    expect(op.error?.code).toBe('SAFARI_VERIFY_TIMEOUT');
    const rb = (op.result as { rollback: RollbackResult }).rollback;
    expect(rb).toMatchObject({ previousEnvironmentId: a, previousProxyRevision: 1, restoredSelection: nodeA, entryModeAfter: 'BLOCKED', failedProxyRevision: 1, needsReverify: true });
    expect(rb.previousProbe?.outcome).toBe('ok');
    const route = h.repos.routeState.get();
    expect(route).toMatchObject({ phase: 'failed', entryMode: 'BLOCKED', activeEnvironmentId: a, activeProxyRevision: 1, selectedNode: nodeA });
    expect(route.warnings).toContain('rollback_needs_reverify');
    // 从不回退到 NORMAL/DIRECT：Safari 全部拒绝
    expect(safariOutcome(h).failed).toBe(true);
    const viewA = await h.app.getEnvironment(a, WEB);
    expect(viewA.facets.route).toBe('rolled_back');
    expect(viewA.readiness).toBe('needs_reverify');
    expect(viewA.nextActions[0]!.kind).toBe('reverify');
    // 重新核验：照常执行旧窗口确认（失败的目标场景有打开的窗口）
    await h.native(PROFILE_B, { type: 'reportProfileState', windows_open: 1, amazon_tabs_open: false, site_permission_granted: true });
    const err = await expectError(h.app.activate(a, { request_id: rid() }, WEB), 'NEEDS_CONFIRMATION');
    expect(err.details).toMatchObject({ reason: 'other_profiles_open' });
    const re = await h.app.activate(a, { request_id: rid(), old_session_policy: 'closed_confirmed', confirmed_environment_id: a }, WEB);
    await h.idle();
    expect(h.repos.operations.get(re.operation_id)!.phase).toBe('VERIFY_ONLY');
    await verify(h, PROFILE_A, re.operation_id);
    expect(h.repos.operations.get(re.operation_id)!.phase).toBe('ACTIVE_VERIFIED');
    expect(h.repos.routeState.get().warnings).not.toContain('rollback_needs_reverify');
  });

  test('arrival timeout (profile never arrives) → rollback', async () => {
    h = await createHarness();
    const { b } = await twoEnvs();
    const opId = await startSwitch(b);
    await h.clock.advanceAsync(601_000);
    await h.idle();
    expect(h.repos.operations.get(opId)!.error?.code).toBe('SAFARI_VERIFY_TIMEOUT');
    expect(h.repos.routeState.get().entryMode).toBe('BLOCKED');
  });

  test('verification without a matching Surge request fails and rolls back', async () => {
    h = await createHarness();
    const { a, b } = await twoEnvs();
    const opId = await startSwitch(b);
    await verify(h, PROFILE_B, opId, { simulate: false });
    const op = h.repos.operations.get(opId)!;
    expect(op.error?.code).toBe('SAFARI_VERIFY_FAILED');
    expect(h.repos.routeState.get().activeEnvironmentId).toBe(a);
  });

  test('expected exit IP mismatch at activation rolls back', async () => {
    h = await createHarness();
    const { b } = await twoEnvs();
    const env = h.repos.environments.get(b)!;
    await h.app.updateEnvironment(b, { request_id: rid(), expected_revision: env.revision, changes: { proxy: { expectedExitIp: '192.0.2.99' } } }, WEB);
    const opId = await startSwitch(b);
    await verify(h, PROFILE_B, opId, { observedIp: '192.0.2.50' });
    expect(h.repos.operations.get(opId)!.error?.code).toBe('EXIT_IP_MISMATCH');
    expect(h.repos.routeState.get().warnings).toContain('rollback_needs_reverify');
  });

  test('first activation (previously NORMAL) failing stays BLOCKED and fails', async () => {
    h = await createHarness();
    const created = await createEnv(h, 'US-Buyer-A', '203.0.113.10');
    await bind(h, PROFILE_A, created.environment_id!);
    const a = await h.app.activate(created.environment_id!, { request_id: rid() }, WEB);
    await h.idle();
    await h.app.cancelOperation(a.operation_id, { request_id: rid() }, WEB);
    await h.idle();
    const route = h.repos.routeState.get();
    expect(route).toMatchObject({ phase: 'failed', entryMode: 'BLOCKED', activeEnvironmentId: null });
    expect((h.repos.operations.get(a.operation_id)!.result as { rollback: RollbackResult }).rollback.needsReverify).toBe(false);
  });

  test('rollback write failure → BLOCKED_NEEDS_ATTENTION, Safari stays blocked', async () => {
    h = await createHarness();
    const { b } = await twoEnvs();
    const opId = await startSwitch(b);
    h.fake.failNext('selectGroupPolicy');
    await h.app.cancelOperation(opId, { request_id: rid() }, WEB);
    await h.idle();
    const op = h.repos.operations.get(opId)!;
    expect(op.phase).toBe('BLOCKED_NEEDS_ATTENTION');
    expect(op.status).toBe('needs_attention');
    const route = h.repos.routeState.get();
    expect(route.phase).toBe('attention');
    expect(route.entryMode).toBe('BLOCKED');
    expect(safariOutcome(h).failed).toBe(true);
  });

  test('cancel is only for waiting route operations', async () => {
    h = await createHarness();
    const created = await createEnv(h, 'US-Buyer-A', '203.0.113.10');
    await expectError(h.app.cancelOperation(created.operation_id, { request_id: rid() }, WEB), 'ROUTE_BUSY');
    await expectError(h.app.cancelOperation('op_missing', { request_id: rid() }, WEB), 'NOT_FOUND');
  });

  test('returning to the last verified revision via proxy_revision', async () => {
    h = await createHarness();
    const { a, b } = await twoEnvs();
    // B 改代理（r2 已部署），但切到 r2 失败；随后显式回到 r1
    const env = h.repos.environments.get(b)!;
    await h.app.updateEnvironment(b, { request_id: rid(), expected_revision: env.revision, changes: { proxy: { host: '203.0.113.21' } } }, WEB);
    await h.idle();
    expect(h.repos.environments.get(b)!.deployedProxyRevision).toBe(2);
    await expectError(h.app.activate(b, { request_id: rid(), proxy_revision: 1, old_session_policy: 'closed_confirmed', confirmed_environment_id: a }, WEB), 'NODE_NOT_DEPLOYED');
    const op = await startSwitch(b);
    await verify(h, PROFILE_B, op);
    expect(h.repos.environments.get(b)!.lastVerifiedProxyRevision).toBe(2);
  });
});

describe('active environment proxy change → WAITING_ROUTE', () => {
  test('plugin edits the active environment: deploy, wait for arrival, switch to the new revision, verify', async () => {
    h = await createHarness();
    const { envId } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const env = h.repos.environments.get(envId)!;
    const r = await h.native(PROFILE_A, { type: 'updateCurrentEnvironment', request_id: rid(), environment_id: envId, expected_revision: env.revision, changes: { proxy: { host: '203.0.113.20' } } });
    expect(r.ok).toBe(true);
    const opId = (r as { data: { operation_id: string } }).data.operation_id;
    await h.idle();
    let op = h.repos.operations.get(opId)!;
    expect(op.phase).toBe('WAITING_ROUTE');
    // 等待期间旧版本继续使用、Safari 不被阻断
    expect(safariOutcome(h).leafPolicyName).toBe('SFE-N-E0001-US01-v001');
    type Pending = { data: { pendingVerification: { kind: string; waiting_route: boolean } } };
    const state = await h.native(PROFILE_A, { type: 'getCurrentState' });
    // 停在 WAITING_ROUTE：取消只结束等待（弹窗据此说「当前出口不变，下次打开时再切换」）
    expect((state as Pending).data.pendingVerification).toMatchObject({ kind: 'apply_new_revision', waiting_route: true });
    const first = await h.native(PROFILE_A, { type: 'beginSafariVerification', operation_id: opId, amazon_tabs_open: false });
    expect((first as { data: { status: string } }).data.status).toBe('pending');
    await h.idle();
    op = h.repos.operations.get(opId)!;
    expect(op.phase).toBe('VERIFY_ONLY');
    // 已进入切换（Safari 已阻断、已选择新节点）：取消按第 14 步回滚，不再是「当前出口不变」
    const switching = await h.native(PROFILE_A, { type: 'getCurrentState' });
    expect((switching as Pending).data.pendingVerification).toMatchObject({ kind: 'apply_new_revision', waiting_route: false });
    await verify(h, PROFILE_A, opId);
    op = h.repos.operations.get(opId)!;
    expect(op.phase).toBe('ACTIVE_VERIFIED');
    const route = h.repos.routeState.get();
    expect(route.activeProxyRevision).toBe(2);
    expect(h.repos.environments.get(envId)!.lastVerifiedProxyRevision).toBe(2);
    expect(safariOutcome(h).leafPolicyName).toBe('SFE-N-E0001-US01-v002');
  });

  test('WAITING_ROUTE deadline → READY_FOR_NEXT_OPEN, route unchanged', async () => {
    h = await createHarness();
    const { envId } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const env = h.repos.environments.get(envId)!;
    const u = await h.app.updateEnvironment(envId, { request_id: rid(), expected_revision: env.revision, changes: { proxy: { host: '203.0.113.20' } } }, WEB);
    await h.idle();
    await h.clock.advanceAsync(601_000);
    await h.idle();
    expect(h.repos.operations.get(u.operation_id)!.phase).toBe('READY_FOR_NEXT_OPEN');
    expect(h.repos.routeState.get().activeProxyRevision).toBe(1);
    expect(h.repos.routeState.get().entryMode).toBe('ACTIVE');
  });

  test('WAITING_ROUTE is ended as READY_FOR_NEXT_OPEN by a new activation (superseded_by)', async () => {
    h = await createHarness();
    const { a, b } = await twoEnvs();
    const env = h.repos.environments.get(a)!;
    const u = await h.app.updateEnvironment(a, { request_id: rid(), expected_revision: env.revision, changes: { proxy: { host: '203.0.113.20' } } }, WEB);
    await h.idle();
    expect(h.repos.operations.get(u.operation_id)!.phase).toBe('WAITING_ROUTE');
    const second = await startSwitch(b);
    const op = h.repos.operations.get(u.operation_id)!;
    expect(op.phase).toBe('READY_FOR_NEXT_OPEN');
    expect(op.supersededBy).toBe(second);
  });

  test('cancel WAITING_ROUTE → READY_FOR_NEXT_OPEN', async () => {
    h = await createHarness();
    const { envId } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const env = h.repos.environments.get(envId)!;
    const u = await h.app.updateEnvironment(envId, { request_id: rid(), expected_revision: env.revision, changes: { proxy: { port: 1081 } } }, WEB);
    await h.idle();
    await h.app.cancelOperation(u.operation_id, { request_id: rid() }, WEB);
    await h.idle();
    expect(h.repos.operations.get(u.operation_id)!.phase).toBe('READY_FOR_NEXT_OPEN');
    expect(h.repos.routeState.get().entryMode).toBe('ACTIVE');
  });
});

describe('normal mode (§6.5)', () => {
  test('needs confirmation while a managed environment is active; then restores original rules', async () => {
    h = await createHarness();
    const { envId } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const node = h.repos.routeState.get().selectedNode;
    await expectError(h.app.enterNormal({ request_id: rid() }, WEB), 'NEEDS_CONFIRMATION');
    const profileBefore = await h.fake.getCurrentProfile();
    const n = await h.app.enterNormal({ request_id: rid(), old_session_policy: 'keep_open_acknowledged', confirmed_environment_id: envId }, WEB);
    await h.idle();
    const op = h.repos.operations.get(n.operation_id)!;
    expect(op.phase).toBe('NORMAL_RESTORED');
    const route = h.repos.routeState.get();
    expect(route).toMatchObject({ entryMode: 'NORMAL', phase: 'idle', activeEnvironmentId: null });
    expect(route.warnings).toEqual(['managed_windows_on_original_rules']);
    // 原规则：用户规则与 FINAL（这里是 DIRECT），不是本应用改成 DIRECT
    expect(safariOutcome(h, 'daily.example.test').policyName).toBe('Daily');
    expect(safariOutcome(h).rule).toBe('FINAL,DIRECT');
    // 普通模式不改变 SFE-ROUTE 的选择，不切换配置
    expect(await h.fake.getGroupSelection('SFE-ROUTE')).toBe(node);
    expect(await h.fake.getCurrentProfile()).toEqual(profileBefore);
    await h.app.acknowledgeWindows({ request_id: rid() }, WEB);
    expect(h.repos.routeState.get().warnings).toEqual([]);
  });

  test.each(['ruleset_resource', 'temp_rule'] as const)('%s: "I closed the old windows" accepted while a later normal mode runs is not undone by that normal mode\'s completion', async (strategy) => {
    h = await createHarness({ entryStrategy: strategy });
    const { envId } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    // 第一次普通模式选择「不关闭」：留下旧窗口警告；Safari 仍有经买家出口的长连接且结束失败 → 第二次普通模式还要结束它
    h.fake.simulateRequest({ processPath: FAKE_SAFARI_PATH, host: 'www.example.test', protocol: 'tcp', longLived: true });
    h.fake.failNext('killRequest');
    await h.app.enterNormal({ request_id: rid(), old_session_policy: 'keep_open_acknowledged', confirmed_environment_id: envId }, WEB);
    await h.idle();
    expect(h.repos.routeState.get().warnings).toEqual(expect.arrayContaining(['managed_windows_on_original_rules', 'buyer_exit_connections_unconfirmed']));
    // 第二次普通模式执行中（它的第一次 Surge 读取）用户点「我已关闭旧窗口」
    const listRules = h.fake.listRules.bind(h.fake);
    let acknowledged = false;
    h.fake.listRules = async () => {
      if (!acknowledged && h.repos.operations.listByStatus(['running']).some((o) => o.kind === 'route.normal')) {
        acknowledged = true;
        await h.app.acknowledgeWindows({ request_id: rid() }, WEB);
        expect(h.repos.routeState.get().warnings).not.toContain('managed_windows_on_original_rules');
      }
      return listRules();
    };
    const n = await h.app.enterNormal({ request_id: rid() }, WEB);
    await h.idle();
    expect(acknowledged).toBe(true);
    expect(h.repos.operations.get(n.operation_id)!.phase).toBe('NORMAL_RESTORED');
    expect(h.repos.routeState.get().warnings).not.toContain('managed_windows_on_original_rules');
  });

  test('always available even when capabilities are stale; kills are best-effort and reported', async () => {
    h = await createHarness();
    const { envId } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    h.revoke(['safari_process_attribution', 'runtime_entry_modes', 'native_bridge_ipc', 'fixed_profile_no_switch']);
    h.fake.simulateRequest({ processPath: FAKE_SAFARI_PATH, host: 'www.example.test', protocol: 'tcp', longLived: true });
    const n = await h.app.enterNormal({ request_id: rid(), old_session_policy: 'closed_confirmed', confirmed_environment_id: envId }, WEB);
    await h.idle();
    const op = h.repos.operations.get(n.operation_id)!;
    expect(op.phase).toBe('NORMAL_RESTORED');
    expect(op.result).toMatchObject({ killBestEffort: true });
    expect((op.result as { killResults: unknown[] }).killResults).toHaveLength(1);
  });

  test('normal mode from an unbound (identified) profile via the bridge', async () => {
    h = await createHarness();
    const { envId } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const r = await h.native(PROFILE_C, { type: 'enterNormalMode', request_id: rid(), old_session_policy: 'closed_confirmed', confirmed_environment_id: envId });
    expect(r.ok).toBe(true);
    await h.idle();
    expect(h.repos.routeState.get().entryMode).toBe('NORMAL');
  });
});

describe('delete / unbind (§6.7)', () => {
  test('active environment: ENVIRONMENT_ACTIVE, no request-level confirmation', async () => {
    h = await createHarness();
    const { envId } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const env = h.repos.environments.get(envId)!;
    await expectError(h.app.deleteEnvironment(envId, { request_id: rid(), expected_revision: env.revision }, ADMIN), 'ENVIRONMENT_ACTIVE');
    await expectError(h.app.unbind(envId, { request_id: rid(), expected_revision: env.revision }, ADMIN), 'ENVIRONMENT_ACTIVE');
  });

  test('after normal mode: delete selects REJECT first when SFE-ROUTE still points at the env node', async () => {
    h = await createHarness();
    const { envId } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    await h.app.enterNormal({ request_id: rid(), old_session_policy: 'closed_confirmed', confirmed_environment_id: envId }, WEB);
    await h.idle();
    expect(await h.fake.getGroupSelection('SFE-ROUTE')).toBe('SFE-N-E0001-US01-v001');
    const env = h.repos.environments.get(envId)!;
    const d = await h.app.deleteEnvironment(envId, { request_id: rid(), expected_revision: env.revision }, ADMIN);
    await h.idle();
    expect(h.repos.operations.get(d.operation_id)!.phase).toBe('COMPLETED');
    expect(await h.fake.getGroupSelection('SFE-ROUTE')).toBe('REJECT');
    expect(h.repos.environments.get(envId)!.deletedAt).not.toBeNull();
    expect(h.repos.profileBindings.byEnvironment(envId)).toBeNull();
    expect(h.events.some((e) => e.type === 'environment.deleted' && e.environmentId === envId)).toBe(true);
  });

  test('unbind only removes the mapping', async () => {
    h = await createHarness();
    const created = await createEnv(h, 'US-Buyer-A', '203.0.113.10');
    await bind(h, PROFILE_A, created.environment_id!);
    const env = h.repos.environments.get(created.environment_id!)!;
    const u = await h.app.unbind(env.id, { request_id: rid(), expected_revision: env.revision }, ADMIN);
    await h.idle();
    expect(h.repos.operations.get(u.operation_id)!.phase).toBe('COMPLETED');
    expect(h.repos.profileBindings.byProfile(PROFILE_A)).toBeNull();
    expect(h.repos.environments.get(env.id)!.deletedAt).toBeNull();
  });
});
