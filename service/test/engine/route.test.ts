import { afterEach, describe, expect, test } from 'vitest';
import { ROUTE_GROUP_NAME, SfeError, type ActivateRequest, type RollbackResult } from '@sfe/contract';
import { payloadOf } from '../../src/domain/operations.js';
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

  test('reuse reconciles first (§6.6): Surge switched to Direct outbound right after a popup reconcile → no reuse claim; the activation is refused before any write and orders stay blocked', async () => {
    h = await createHarness();
    const { envId } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    h.clock.advance(6_000);
    const state = async () => ((await h.native(PROFILE_A, { type: 'getCurrentState' })) as { ok: true; data: { ordersAllowed: boolean; ordersBlockedReason: string | null } }).data;
    expect((await state()).ordersAllowed).toBe(true);
    // 弹窗对账之后几秒内，用户在 Surge 菜单中把出站模式改为直连
    h.fake.takeover = { ...h.fake.takeover, outboundMode: 'direct' };
    h.clock.advance(1_000);
    const before = writesCount();
    const epoch = h.repos.routeState.get().routeEpoch;
    const a = await h.native(PROFILE_A, { type: 'activateCurrentEnvironment', request_id: rid('act'), environment_id: envId, amazon_tabs_open: false });
    expect(a.ok).toBe(true);
    await h.idle();
    const op = h.repos.operations.get((a as { data: { operation_id: string } }).data.operation_id)!;
    expect(op.result).not.toMatchObject({ reused: true });
    expect(op).toMatchObject({ phase: 'FAILED', status: 'failed' });
    expect(op.error?.code).toBe('TAKEOVER_LOST');
    expect(writesCount()).toEqual(before);
    const route = h.repos.routeState.get();
    expect(route.routeEpoch).toBe(epoch);
    expect(route.warnings).toContain('outbound_mode_changed');
    // 准备页在 5 秒内读取状态：不允许打开订单页
    h.clock.advance(1_000);
    const d = await state();
    expect(d.ordersAllowed).toBe(false);
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
    // 准备页据此才说「已停止自动打开订单与填充」
    expect(op2.result).toMatchObject({ probeWarning: 'exit_ip_mismatch' });
    expect((await h.app.ensureInControl()).ok).toBe(false);
  });

  test('probe.safari cancelled or timed out ends only the re-test: no warning is added, the earlier probe stays current, orders and fill stay allowed (no probeWarning for the prepare page)', async () => {
    h = await createHarness();
    const { envId } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const env = h.repos.environments.get(envId)!;
    await h.app.updateEnvironment(envId, { request_id: rid(), expected_revision: env.revision, changes: { autoFillLogin: true } }, WEB);
    const probeBefore = h.repos.probes.latest(envId, 'safari')!.id;
    type State = { data: { ordersAllowed: boolean } };
    // 取消
    const p1 = await h.app.probe(envId, { request_id: rid(), kind: 'safari' }, WEB);
    await h.idle();
    await h.app.cancelOperation(p1.operation_id, { request_id: rid() }, WEB);
    await h.idle();
    const op1 = h.repos.operations.get(p1.operation_id)!;
    expect(op1).toMatchObject({ phase: 'FAILED', status: 'failed' });
    expect(op1.error?.code).toBe('SUPERSEDED');
    expect(op1.result?.probeWarning).toBeUndefined();
    // 超时（签发检测编号之后）
    const p2 = await h.app.probe(envId, { request_id: rid(), kind: 'safari' }, WEB);
    await h.idle();
    const begin = await h.native(PROFILE_A, { type: 'beginSafariVerification', operation_id: p2.operation_id, amazon_tabs_open: false });
    expect((begin as { data: { status: string } }).data.status).toBe('ready');
    await h.clock.advanceAsync(121_000);
    await h.idle();
    const op2 = h.repos.operations.get(p2.operation_id)!;
    expect(op2.error?.code).toBe('SAFARI_VERIFY_TIMEOUT');
    expect(op2.result?.probeWarning).toBeUndefined();
    expect(op1.result?.routeLeftVerified).toBeUndefined();
    expect(op2.result?.routeLeftVerified).toBeUndefined();
    expect(h.repos.routeState.get().warnings).toEqual([]);
    expect(h.repos.probes.latest(envId, 'safari')!.id).toBe(probeBefore);
    const state = await h.native(PROFILE_A, { type: 'getCurrentState' });
    expect((state as State).data.ordersAllowed).toBe(true);
  });

  describe('a retest that itself read SFE-ROUTE on another buyer\'s node is held at REJECT even when the end point\'s re-read fails (§6.3 step 14)', () => {
    /** 本次重测（opId）第 failAt 次读 SFE-ROUTE 选择时失败（模拟 surge-cli 超时）；其余调用照常。 */
    let failRead: { opId: string; failAt: number; seen: number; hit: boolean } | null = null;
    afterEach(() => {
      failRead = null;
    });
    function selectionReadFails(adapter: object): SurgeAdapter {
      return beforeCall(adapter, 'getGroupSelection', () => {
        const f = failRead;
        if (!f || h.app.executor.currentOperationId !== f.opId) return null;
        f.seen += 1;
        if (f.seen !== f.failAt) return null;
        f.hit = true;
        return async () => {
          throw new Error('模拟：surge-cli 超时');
        };
      });
    }

    async function expectHeld(p: string, code: string): Promise<void> {
      expect(failRead?.hit).toBe(true);
      const op = h.repos.operations.get(p)!;
      expect(op).toMatchObject({ phase: 'BLOCKED_NEEDS_ATTENTION', status: 'needs_attention' });
      expect(op.error?.code).toBe(code);
      expect(op.result?.rejectSelected).toBe(true);
      expect(h.repos.operations.listSteps(p).at(-1)!.message).not.toContain('路由未改变');
      const route = h.repos.routeState.get();
      expect(route).toMatchObject({ phase: 'attention', selectedNode: 'REJECT', operationId: p });
      expect(route.warnings).toEqual(expect.arrayContaining(['entry_unverified', 'buyer_exit_connections_unconfirmed']));
      expect(await h.fake.getGroupSelection(ROUTE_GROUP_NAME)).toBe('REJECT');
      // Safari 的站点新连接不再经另一个买家的出口；订单与填充停止
      expect(safariOutcome(h, 'www.amazon.com').leafPolicyName).toBe('REJECT');
      const st = (await h.native(PROFILE_A, { type: 'getCurrentState' })) as { ok: true; data: { ordersAllowed: boolean } };
      expect(st.data.ordersAllowed).toBe(false);
    }

    async function issueTest(p: string): Promise<{ testId: string; epoch: number; started: string }> {
      const begin = await h.native(PROFILE_A, { type: 'beginSafariVerification', operation_id: p, amazon_tabs_open: false });
      const data = (begin as { ok: true; data: { status: string; test_id: string; route_epoch: number } }).data;
      expect(data.status).toBe('ready');
      const started = h.clock.now().toISOString();
      h.fake.simulateRequest({ processPath: FAKE_SAFARI_PATH, host: FAKE_VERIFY_HOST, protocol: 'tcp' });
      return { testId: data.test_id, epoch: data.route_epoch, started };
    }

    async function submit(p: string, t: { testId: string; epoch: number; started: string }, httpStatus = 200): Promise<void> {
      const r = await h.native(PROFILE_A, {
        type: 'submitSafariVerification',
        operation_id: p,
        test_id: t.testId,
        route_epoch: t.epoch,
        observed_ip: '192.0.2.50',
        http_status: httpStatus,
        error: null,
        started_at: t.started,
        finished_at: h.clock.now().toISOString(),
      });
      expect(r.ok).toBe(true);
      await h.idle();
    }

    test('the check read B\'s node (moved in Surge after the test id was issued) and the end point\'s re-read fails → BLOCKED_NEEDS_ATTENTION, SFE-ROUTE on REJECT', async () => {
      h = await createHarness({ surge: (fake) => selectionReadFails(fake) });
      const { a, b } = await twoEnvs();
      const p = (await h.app.probe(a, { request_id: rid(), kind: 'safari' }, WEB)).operation_id;
      await h.idle();
      const t = await issueTest(p);
      // 用户在 Surge 菜单中把 SFE-ROUTE 改选到 B 的节点；核对读到它（第 1 次），结束点重读失败（第 2 次）
      await h.fake.selectGroupPolicy(ROUTE_GROUP_NAME, h.repos.proxyRevisions.get(b, 1)!.nodeName);
      failRead = { opId: p, failAt: 2, seen: 0, hit: false };
      await submit(p, t);
      await expectHeld(p, 'SAFARI_VERIFY_FAILED');
      expect(h.repos.operations.get(p)!.result?.probeWarning).toBe('probe_failed');
    });

    test('starting the retest read B\'s node (READBACK_MISMATCH) and the end point\'s re-read fails → BLOCKED_NEEDS_ATTENTION, SFE-ROUTE on REJECT', async () => {
      h = await createHarness({ surge: (fake) => selectionReadFails(fake) });
      const { a, b } = await twoEnvs();
      await h.fake.selectGroupPolicy(ROUTE_GROUP_NAME, h.repos.proxyRevisions.get(b, 1)!.nodeName);
      const p = (await h.app.probe(a, { request_id: rid(), kind: 'safari' }, WEB)).operation_id;
      failRead = { opId: p, failAt: 2, seen: 0, hit: false };
      await h.idle();
      await expectHeld(p, 'READBACK_MISMATCH');
    });

    test('control: the check read the verified node (the retest failed for another reason) and the re-read fails → no hold; the route stays verified, only probe_failed is added', async () => {
      h = await createHarness({ surge: (fake) => selectionReadFails(fake) });
      const { a } = await twoEnvs();
      const nodeA = h.repos.routeState.get().selectedNode;
      const p = (await h.app.probe(a, { request_id: rid(), kind: 'safari' }, WEB)).operation_id;
      await h.idle();
      const t = await issueTest(p);
      failRead = { opId: p, failAt: 2, seen: 0, hit: false };
      await submit(p, t, 500);
      expect(failRead.hit).toBe(true);
      const op = h.repos.operations.get(p)!;
      expect(op).toMatchObject({ phase: 'FAILED', status: 'failed' });
      expect(op.result?.rejectSelected).toBeUndefined();
      const route = h.repos.routeState.get();
      expect(route).toMatchObject({ phase: 'active_verified', selectedNode: nodeA });
      expect(route.warnings).toEqual(['probe_failed']);
      expect(await h.fake.getGroupSelection(ROUTE_GROUP_NAME)).toBe(nodeA);
    });
  });

  describe('a retest whose route stops being verified while it waits (Surge restart, outbound mode changed) never claims the route and the earlier check are unchanged (§6.4)', () => {
    for (const entryStrategy of ['ruleset_resource', 'temp_rule'] as const) {
      test(`[${entryStrategy}] Surge restarts while the retest waits; the scene then arrives → the retest ends at once, saying the scene arrived and why the route is no longer verified`, async () => {
        h = await createHarness({ entryStrategy });
        const { envId: a } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
        const p = (await h.app.probe(a, { request_id: rid(), kind: 'safari' }, WEB)).operation_id;
        await h.idle();
        expect(h.repos.operations.get(p)!.status).toBe('waiting');
        h.clock.advance(10_000);
        h.fake.restart();
        h.clock.advance(1_000);
        await h.app.refreshSurge(WEB);
        await h.idle();
        expect(h.repos.routeState.get().phase).toBe('attention');
        const before = writesCount();
        const begin = await h.native(PROFILE_A, { type: 'beginSafariVerification', operation_id: p, amazon_tabs_open: false });
        const data = (begin as { ok: true; data: { status: string; message: string; switching: boolean } }).data;
        // 不说「等待路由恢复」：路由只有经新的激活才回到已验证状态，而新的激活会取代这次重测
        expect(data).toMatchObject({ status: 'pending', switching: false });
        expect(data.message).not.toContain('等待路由恢复');
        expect(data.message).toContain('正在结束本次重新检测');
        await h.idle();
        const op = h.repos.operations.get(p)!;
        expect(op).toMatchObject({ phase: 'FAILED', status: 'failed' });
        expect(op.error?.message).toContain('绑定场景已到达');
        expect(op.error?.message).toContain('Surge 已重启');
        expect(op.error?.message).not.toContain('未在截止时间内到达');
        expect(op.error?.message).not.toContain('路由未改变');
        expect(op.result?.routeLeftVerified).toEqual(expect.arrayContaining(['surge_restarted']));
        expect(op.result?.rejectSelected).toBeUndefined();
        expect(h.repos.operations.listSteps(p).at(-1)!.message).toContain('不是这次重新检测改变的');
        // 没有等到到达截止时间；重测从不写 Surge
        expect(h.repos.outbox.pendingForOperation(p)).toEqual([]);
        expect(writesCount()).toEqual(before);
        const st = (await h.native(PROFILE_A, { type: 'getCurrentState' })) as { ok: true; data: { ordersAllowed: boolean } };
        expect(st.data.ordersAllowed).toBe(false);
      });
    }

    test('the outbound mode changes while the retest waits and the scene never arrives → the arrival timeout says the scene did not arrive and that the route stopped being verified meanwhile', async () => {
      h = await createHarness();
      const { envId: a } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
      const p = (await h.app.probe(a, { request_id: rid(), kind: 'safari' }, WEB)).operation_id;
      await h.idle();
      h.fake.takeover = { ...h.fake.takeover, outboundMode: 'direct' };
      h.clock.advance(1_000);
      await h.app.refreshSurge(WEB);
      await h.idle();
      expect(h.repos.routeState.get().phase).toBe('attention');
      await h.clock.advanceAsync((h.repos.settings.get('profileArrivalTimeoutSec') + 1) * 1000);
      await h.idle();
      const op = h.repos.operations.get(p)!;
      expect(op).toMatchObject({ phase: 'FAILED', status: 'failed' });
      expect(op.error?.code).toBe('SAFARI_VERIFY_TIMEOUT');
      expect(op.error?.message).toContain('绑定场景未在截止时间内到达');
      expect(op.error?.message).toContain('Surge 出站模式不是规则模式');
      expect(op.result?.routeLeftVerified).toEqual(expect.arrayContaining(['outbound_mode_changed']));
    });
  });

  test('a waiting retest or WAITING_ROUTE shows its own deadline (waitDeadline), and every retest ending clears the deadline it wrote into the route record', async () => {
    h = await createHarness();
    const { envId } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    expect(h.repos.routeState.get().awaitingDeadline).toBeNull();
    type Ready = { data: { status: string; deadline: string } };
    const begin = async (opId: string): Promise<string> => {
      const r = (await h.native(PROFILE_A, { type: 'beginSafariVerification', operation_id: opId, amazon_tabs_open: false })) as Ready;
      expect(r.data.status).toBe('ready');
      expect(h.repos.routeState.get().awaitingDeadline).toBe(r.data.deadline);
      expect((await h.app.getOperation(opId, WEB)).waitDeadline).toBe(r.data.deadline);
      return r.data.deadline;
    };
    // 通过
    const p1 = await h.app.probe(envId, { request_id: rid(), kind: 'safari' }, WEB);
    await h.idle();
    await begin(p1.operation_id);
    expect((await verify(h, PROFILE_A, p1.operation_id)).ok).toBe(true);
    expect(h.repos.operations.get(p1.operation_id)!.phase).toBe('ACTIVE_VERIFIED');
    expect(h.repos.routeState.get().awaitingDeadline).toBeNull();
    expect((await h.app.getOperation(p1.operation_id, WEB)).waitDeadline).toBeNull();
    // 失败（浏览器检测请求没有成功）
    const p2 = await h.app.probe(envId, { request_id: rid(), kind: 'safari' }, WEB);
    await h.idle();
    await begin(p2.operation_id);
    await verify(h, PROFILE_A, p2.operation_id, { httpStatus: 502 });
    expect(h.repos.operations.get(p2.operation_id)!.phase).toBe('FAILED');
    expect(h.repos.routeState.get().awaitingDeadline).toBeNull();
    // 取消
    const p3 = await h.app.probe(envId, { request_id: rid(), kind: 'safari' }, WEB);
    await h.idle();
    await begin(p3.operation_id);
    await h.app.cancelOperation(p3.operation_id, { request_id: rid() }, WEB);
    await h.idle();
    expect(h.repos.operations.get(p3.operation_id)!.status).toBe('failed');
    expect(h.repos.routeState.get().awaitingDeadline).toBeNull();
    // 超时
    const p4 = await h.app.probe(envId, { request_id: rid(), kind: 'safari' }, WEB);
    await h.idle();
    await begin(p4.operation_id);
    await h.clock.advanceAsync(121_000);
    await h.idle();
    expect(h.repos.operations.get(p4.operation_id)!.error?.code).toBe('SAFARI_VERIFY_TIMEOUT');
    expect(h.repos.routeState.get().awaitingDeadline).toBeNull();
    // 三小时后再次重新检测（尚未到达）：网页显示的是本次的到达截止时间，不是之前留下的时间
    await h.clock.advanceAsync(3 * 3600_000);
    await h.idle();
    const p5 = await h.app.probe(envId, { request_id: rid(), kind: 'safari' }, WEB);
    await h.idle();
    const view5 = await h.app.getOperation(p5.operation_id, WEB);
    expect(view5.status).toBe('waiting');
    expect(view5.waitDeadline).toBe(payloadOf(h.repos.operations.get(p5.operation_id)!).route!.arrivalDeadline);
    expect(Date.parse(view5.waitDeadline!)).toBeGreaterThan(h.clock.now().getTime());
    await h.app.cancelOperation(p5.operation_id, { request_id: rid() }, WEB);
    await h.idle();
    // 活动环境改代理停在 WAITING_ROUTE：等待场景打开的截止时间
    const env = h.repos.environments.get(envId)!;
    const u = await h.app.updateEnvironment(envId, { request_id: rid(), expected_revision: env.revision, changes: { proxy: { host: '203.0.113.20' } } }, WEB);
    await h.idle();
    const viewU = await h.app.getOperation(u.operation_id, WEB);
    expect(viewU.phase).toBe('WAITING_ROUTE');
    expect(viewU.waitDeadline).toBe(payloadOf(h.repos.operations.get(u.operation_id)!).route!.arrivalDeadline);
    expect(Date.parse(viewU.waitDeadline!)).toBeGreaterThan(h.clock.now().getTime());
    expect(h.repos.routeState.get().awaitingDeadline).toBeNull();
  });

  test('the prepare page\'s pending reply says whether the operation is a switch: a queued retest and a cancelled wait never claim switching or blocking', async () => {
    h = await createHarness();
    const { a, b } = await twoEnvs();
    const hold = async (): Promise<{ release: () => Promise<void> }> => {
      let open!: () => void;
      const gate = new Promise<void>((r) => (open = r));
      let entered!: () => void;
      const enteredP = new Promise<void>((r) => (entered = r));
      const held = h.app.executor.runInternal('hold', async () => {
        entered();
        await gate;
      });
      await enteredP;
      return {
        release: async () => {
          open();
          await held;
          await h.idle();
        },
      };
    };
    type Pending = { data: { status: string; message: string; switching?: boolean } };
    const begin = async (profile: string, opId: string) =>
      ((await h.native(profile, { type: 'beginSafariVerification', operation_id: opId, amazon_tabs_open: false })) as Pending).data;
    const before = writesCount();
    // 排队中的重新检测（执行器忙）：不说正在切换，也不声称阻断
    let held = await hold();
    const probe = await h.app.probe(a, { request_id: rid(), kind: 'safari' }, WEB);
    expect(h.repos.operations.get(probe.operation_id)!.status).toBe('queued');
    expect(await begin(PROFILE_A, probe.operation_id)).toEqual({ status: 'pending', phase: 'SAVED', message: '正在开始重新检测，请稍候（不切换、不阻断 Safari）', switching: false });
    await held.release();
    await h.app.cancelOperation(probe.operation_id, { request_id: rid() }, WEB);
    await h.idle();
    expect(writesCount()).toEqual(before);
    // 活动环境改代理：到达后是切换；之后受理的取消不切换、不阻断
    const env = h.repos.environments.get(a)!;
    const u = await h.app.updateEnvironment(a, { request_id: rid(), expected_revision: env.revision, changes: { proxy: { host: '203.0.113.20' } } }, WEB);
    await h.idle();
    held = await hold();
    expect(await begin(PROFILE_A, u.operation_id)).toMatchObject({ status: 'pending', message: '已到达，正在切换到新版本', switching: true });
    await h.native(PROFILE_A, { type: 'cancelOperation', request_id: rid('cancel'), operation_id: u.operation_id });
    expect(await begin(PROFILE_A, u.operation_id)).toMatchObject({ status: 'pending', message: '已请求取消，正在处理', switching: false });
    await held.release();
    expect(h.repos.operations.get(u.operation_id)!.phase).toBe('READY_FOR_NEXT_OPEN');
    // 排队中的激活：是切换
    held = await hold();
    const act = await h.app.activate(b, { request_id: rid('act'), old_session_policy: 'closed_confirmed', confirmed_environment_id: a }, WEB);
    expect(await begin(PROFILE_B, act.operation_id)).toMatchObject({ status: 'pending', message: '正在切换出口，请稍候', switching: true });
    await held.release();
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

  test.each([
    ['temp_rule', true],
    ['temp_rule', false],
    ['ruleset_resource', true],
    ['ruleset_resource', false],
  ] as const)(
    'normal mode accepted while ACTIVE is being written (%s, earlier environment active: %s): the activation does not commit; the normal mode undoes the ACTIVE entry, and since Safari (including the target profile\'s windows) already went through the target\'s exit and the confirmation did not cover it, the route carries the window warning',
    async (entryStrategy, withA) => {
      let afterCheck = false;
      let hook: (() => Promise<void>) | null = null;
      h = await createHarness({
        entryStrategy,
        surge: (fake) => beforeCall(beforeCall(fake, 'listRecentRequests', () => (afterCheck = true, null)), 'matchRule', () => (afterCheck ? hook : null)),
      });
      let a: string | null = null;
      let b: string;
      if (withA) {
        ({ a, b } = await twoEnvs());
      } else {
        b = (await createEnv(h, 'US-Buyer-B', '203.0.113.11')).environment_id!;
        await bind(h, PROFILE_B, b);
      }
      afterCheck = false;
      const opId = await startSwitch(b);
      let normalId: string | null = null;
      hook = async () => {
        hook = null;
        normalId = (await h.app.enterNormal(withA ? { request_id: rid(), old_session_policy: 'closed_confirmed', confirmed_environment_id: a } : { request_id: rid() }, WEB)).operation_id;
      };
      expect((await verify(h, PROFILE_B, opId)).ok).toBe(true);
      await h.idle();
      expect(normalId).not.toBeNull();
      const stopped = h.repos.operations.get(opId)!;
      expect(stopped).toMatchObject({ phase: 'SUPERSEDED', supersededBy: normalId });
      expect(h.repos.operations.listSteps(opId).at(-1)!.message).toContain('入口已进入使用中模式（ACTIVE，读回确认），在提交之前停下，未提交');
      expect(h.repos.operations.listSteps(opId).at(-1)!.message).toContain('目标环境的窗口已经过它的出口');
      expect(h.repos.probes.latest(b, 'safari')).toBeNull();
      const n = h.repos.operations.get(normalId!)!;
      expect(n.phase).toBe('NORMAL_RESTORED');
      expect((n.payload as { normal: { handedOverActiveTarget?: string } }).normal.handedOverActiveTarget).toBe(b);
      expect(h.repos.operations.listSteps(normalId!).at(-1)!.message).toMatch(/^已进入普通模式：切换目标环境「US-Buyer-B · E000\d」的入口已写入使用中模式.*后续请求将按 Surge 原规则发出（可能直连）$/);
      // 普通模式从读回的 ACTIVE 撤销本应用入口；B 的窗口未经确认，路由带旧窗口警告（与选择不关闭旧窗口相同）
      const route = h.repos.routeState.get();
      expect(route).toMatchObject({ entryMode: 'NORMAL', phase: 'idle', activeEnvironmentId: null });
      expect(route.warnings).toContain('managed_windows_on_original_rules');
      expect(h.fake.tempRules).toEqual([]);
      expect(safariOutcome(h).rule).toBe('FINAL,DIRECT');
    },
  );

  test.each(['temp_rule', 'ruleset_resource'] as const)(
    'normal mode handed an ACTIVE-written switch fails (%s, Surge unreachable): the route needs attention instead of showing the old environment as managed, the target cannot be deleted while SFE-ROUTE selects its node, and the window warning survives to the next normal mode',
    async (entryStrategy) => {
      let afterCheck = false;
      let hook: (() => Promise<void>) | null = null;
      let opId = '';
      let normalId: string | null = null;
      let broke = false;
      // 切换已交给普通模式（SUPERSEDED）且普通模式开始执行之后，Surge 变得不可达
      const breakWhenNormalRuns = (adapter: object): SurgeAdapter =>
        new Proxy(adapter, {
          get(target, prop) {
            const v = Reflect.get(target, prop, target) as unknown;
            if (typeof v !== 'function') return v;
            const fn = v as (...args: unknown[]) => unknown;
            return (...args: unknown[]) => {
              if (!broke && normalId !== null && h.repos.operations.get(opId)?.status === 'superseded' && h.repos.operations.get(normalId)?.status === 'running') {
                broke = true;
                h.fake.reachable = false;
              }
              return fn.apply(target, args);
            };
          },
        }) as unknown as SurgeAdapter;
      h = await createHarness({
        entryStrategy,
        surge: (fake) => breakWhenNormalRuns(beforeCall(beforeCall(fake, 'listRecentRequests', () => (afterCheck = true, null)), 'matchRule', () => (afterCheck ? hook : null))),
      });
      const { a, b } = await twoEnvs();
      const nodeB = h.repos.proxyRevisions.get(b, 1)!.nodeName;
      afterCheck = false;
      opId = await startSwitch(b);
      hook = async () => {
        hook = null;
        normalId = (await h.app.enterNormal({ request_id: rid(), old_session_policy: 'closed_confirmed', confirmed_environment_id: a }, WEB)).operation_id;
      };
      expect((await verify(h, PROFILE_B, opId)).ok).toBe(true);
      await h.idle();
      expect(broke).toBe(true);
      expect(h.repos.operations.get(opId)).toMatchObject({ phase: 'SUPERSEDED', supersededBy: normalId });
      const n1 = h.repos.operations.get(normalId!)!;
      expect(n1).toMatchObject({ phase: 'FAILED', status: 'failed' });
      expect(h.repos.operations.listSteps(normalId!).at(-1)!.message).toContain('切换目标环境「US-Buyer-B · E0002」的入口已写入使用中模式');
      // SFE-ROUTE 选着 B 的节点（REJECT 改选失败），路由记录的使用中环境仍是 A：需要处理，入口未经确认，带 B 的窗口警告
      const route = h.repos.routeState.get();
      expect(route).toMatchObject({ phase: 'attention', entryMode: 'ACTIVE', activeEnvironmentId: a, selectedNode: nodeB });
      expect(route.warnings).toEqual(expect.arrayContaining(['entry_unverified', 'buyer_exit_connections_unconfirmed', 'managed_windows_on_original_rules']));
      h.fake.reachable = true;
      await h.app.runPeriodicReconcile();
      await h.idle();
      const state = await h.native(PROFILE_A, { type: 'getCurrentState' });
      const d = (state as { data: { relation: string; routeSummary: { entryUnconfirmed: boolean; phase: string }; environment: { nextActions: Array<{ message: string }> }; ordersAllowed: boolean } }).data;
      expect(d.relation).toBe('this_active');
      expect(d.routeSummary).toMatchObject({ phase: 'attention', entryUnconfirmed: true });
      expect(d.environment.nextActions[0]!.message).toContain('路由状态需要处理');
      expect(d.ordersAllowed).toBe(false);
      // SFE-ROUTE 仍选着 B 的节点、入口不是普通模式：B 不能删除或解除绑定
      const envB = h.repos.environments.get(b)!;
      await expectError(h.app.deleteEnvironment(b, { request_id: rid(), expected_revision: envB.revision }, WEB), 'ENVIRONMENT_ACTIVE');
      await expectError(h.app.unbind(b, { request_id: rid(), expected_revision: envB.revision }, WEB), 'ENVIRONMENT_ACTIVE');
      // 再次进入普通模式：完成，B 的窗口警告保留并写明
      const n2 = await h.app.enterNormal({ request_id: rid(), old_session_policy: 'closed_confirmed', confirmed_environment_id: a }, WEB);
      await h.idle();
      expect(h.repos.operations.get(n2.operation_id)!.phase).toBe('NORMAL_RESTORED');
      expect(h.repos.operations.listSteps(n2.operation_id).at(-1)!.message).toContain('旧环境窗口未关闭');
      expect(h.repos.routeState.get()).toMatchObject({ entryMode: 'NORMAL', phase: 'idle' });
      expect(h.repos.routeState.get().warnings).toContain('managed_windows_on_original_rules');
      // 普通模式之后可以删除（删除先把仍选着 B 节点的 SFE-ROUTE 改选 REJECT）
      const del = await h.app.deleteEnvironment(b, { request_id: rid(), expected_revision: h.repos.environments.get(b)!.revision }, WEB);
      await h.idle();
      expect(h.repos.operations.get(del.operation_id)!.phase).toBe('COMPLETED');
      expect(await h.fake.getGroupSelection('SFE-ROUTE')).not.toBe(nodeB);
    },
  );

  test.each(['temp_rule', 'ruleset_resource'] as const)(
    'normal mode handed an ACTIVE-written switch aborts on an unexpected database error in its completion transaction (%s): the executor guard keeps the target\'s window warning and names it, so the next normal mode does not claim Safari is fully on the original rules',
    async (entryStrategy) => {
      let afterCheck = false;
      let hook: (() => Promise<void>) | null = null;
      h = await createHarness({
        entryStrategy,
        surge: (fake) => beforeCall(beforeCall(fake, 'listRecentRequests', () => (afterCheck = true, null)), 'matchRule', () => (afterCheck ? hook : null)),
      });
      const { a, b } = await twoEnvs();
      afterCheck = false;
      const opId = await startSwitch(b);
      let normalId: string | null = null;
      hook = async () => {
        hook = null;
        normalId = (await h.app.enterNormal({ request_id: rid(), old_session_policy: 'closed_confirmed', confirmed_environment_id: a }, WEB)).operation_id;
      };
      // 普通模式完成事务中的一次意外数据库错误（NORMAL_RESTORED 一步）：越过 runNormal 自己的失败处理，由执行器兜底结算
      let thrown = false;
      const orig = h.repos.operations.appendStep.bind(h.repos.operations);
      (h.repos.operations as { appendStep: typeof orig }).appendStep = ((id: string, phase: string, msg: string) => {
        if (!thrown && id === normalId && phase === 'NORMAL_RESTORED') {
          thrown = true;
          throw new Error('SQLITE_IOERR');
        }
        return orig(id as never, phase as never, msg as never);
      }) as typeof orig;
      expect((await verify(h, PROFILE_B, opId)).ok).toBe(true);
      await h.idle();
      expect(thrown).toBe(true);
      expect(h.repos.operations.get(opId)).toMatchObject({ phase: 'SUPERSEDED', supersededBy: normalId });
      const n1 = h.repos.operations.get(normalId!)!;
      expect(n1).toMatchObject({ phase: 'BLOCKED_NEEDS_ATTENTION', status: 'needs_attention' });
      expect(n1.error!.message).toContain('切换目标环境「US-Buyer-B · E0002」的入口已写入使用中模式');
      expect(h.repos.operations.listSteps(normalId!).at(-1)!.message).toContain('切换目标环境「US-Buyer-B · E0002」的入口已写入使用中模式');
      expect(h.repos.routeState.get()).toMatchObject({ phase: 'attention', entryMode: 'UNKNOWN' });
      expect(h.repos.routeState.get().warnings).toEqual(expect.arrayContaining(['entry_unverified', 'managed_windows_on_original_rules']));
      // 再次进入普通模式：完成，B 的窗口警告保留并写明
      const n2 = await h.app.enterNormal({ request_id: rid(), old_session_policy: 'closed_confirmed', confirmed_environment_id: a }, WEB);
      await h.idle();
      expect(h.repos.operations.get(n2.operation_id)!.phase).toBe('NORMAL_RESTORED');
      expect(h.repos.operations.listSteps(n2.operation_id).at(-1)!.message).toContain('旧环境窗口未关闭');
      expect(h.repos.routeState.get().warnings).toContain('managed_windows_on_original_rules');
    },
  );

  test.each(['temp_rule', 'ruleset_resource'] as const)(
    '…and when the handed-over switch was a re-activation of the environment whose windows the normal mode was confirmed for (active environment\'s publish, %s): the executor guard adds no window warning, and the next normal mode says Safari is on the original rules',
    async (entryStrategy) => {
      let afterCheck = false;
      let hook: (() => Promise<void>) | null = null;
      h = await createHarness({
        entryStrategy,
        surge: (fake) => beforeCall(beforeCall(fake, 'listRecentRequests', () => (afterCheck = true, null)), 'matchRule', () => (afterCheck ? hook : null)),
      });
      const { envId: a } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
      // 插件修改使用中环境 A 的代理：新版本部署后停在 WAITING_ROUTE，场景到达后切换到 A 的新版本（同一环境的重新激活）
      const env = h.repos.environments.get(a)!;
      const r = await h.native(PROFILE_A, { type: 'updateCurrentEnvironment', request_id: rid(), environment_id: a, expected_revision: env.revision, changes: { proxy: { host: '203.0.113.20' } } });
      expect(r.ok).toBe(true);
      const opId = (r as { data: { operation_id: string } }).data.operation_id;
      await h.idle();
      expect(h.repos.operations.get(opId)!.phase).toBe('WAITING_ROUTE');
      await h.native(PROFILE_A, { type: 'beginSafariVerification', operation_id: opId, amazon_tabs_open: false });
      await h.idle();
      expect(h.repos.operations.get(opId)!.phase).toBe('VERIFY_ONLY');
      afterCheck = false;
      // 写入 ACTIVE 期间用户确认 A 的窗口已关闭，进入普通模式：切换交给它（目标就是受理时确认的环境 A）
      let normalId: string | null = null;
      hook = async () => {
        hook = null;
        normalId = (await h.app.enterNormal({ request_id: rid(), old_session_policy: 'closed_confirmed', confirmed_environment_id: a }, WEB)).operation_id;
      };
      // 普通模式完成事务中的一次意外数据库错误：越过 runNormal 自己的失败处理，由执行器兜底结算（路由仍在切换中）
      let thrown = false;
      const orig = h.repos.operations.appendStep.bind(h.repos.operations);
      (h.repos.operations as { appendStep: typeof orig }).appendStep = ((id: string, phase: string, msg: string) => {
        if (!thrown && id === normalId && phase === 'NORMAL_RESTORED') {
          thrown = true;
          throw new Error('SQLITE_IOERR');
        }
        return orig(id as never, phase as never, msg as never);
      }) as typeof orig;
      expect((await verify(h, PROFILE_A, opId)).ok).toBe(true);
      await h.idle();
      expect(thrown).toBe(true);
      expect(h.repos.operations.get(opId)).toMatchObject({ phase: 'SUPERSEDED', supersededBy: normalId });
      const n1 = h.repos.operations.get(normalId!)!;
      expect((n1.payload as { normal: { handedOverActiveTarget?: string; expectedActiveEnvironmentId: string | null } }).normal).toMatchObject({ handedOverActiveTarget: a, expectedActiveEnvironmentId: a });
      expect(n1).toMatchObject({ phase: 'BLOCKED_NEEDS_ATTENTION', status: 'needs_attention' });
      expect(n1.error!.message).not.toContain('切换目标环境');
      expect(h.repos.routeState.get()).toMatchObject({ phase: 'attention', entryMode: 'UNKNOWN' });
      // 用户已确认 A 的窗口关闭：兜底不带旧窗口警告（与 runNormal 自己的成功与失败路径相同）
      expect(h.repos.routeState.get().warnings).toContain('entry_unverified');
      expect(h.repos.routeState.get().warnings).not.toContain('managed_windows_on_original_rules');
      const n2 = await h.app.enterNormal({ request_id: rid(), old_session_policy: 'closed_confirmed', confirmed_environment_id: a }, WEB);
      await h.idle();
      expect(h.repos.operations.get(n2.operation_id)!.phase).toBe('NORMAL_RESTORED');
      expect(h.repos.operations.listSteps(n2.operation_id).at(-1)!.message).toBe('已进入普通模式：Safari 按 Surge 原规则发出请求');
      expect(h.repos.routeState.get().warnings).not.toContain('managed_windows_on_original_rules');
      expect(safariOutcome(h).rule).toBe('FINAL,DIRECT');
    },
  );

  describe.each([
    ['temp_rule', true],
    ['temp_rule', false],
    ['ruleset_resource', true],
    ['ruleset_resource', false],
  ] as const)('the ACTIVE write took effect, then a readback fails or the service dies (%s, earlier environment active: %s)', (entryStrategy, withA) => {
    const READBACKS = new Set(['listTempRules', 'matchRule', 'listRules']);
    /**
     * 激活核对之后（listRecentRequests 已调用）：写入 ACTIVE 的第一次 rule match 之前受理普通模式；Safari 的请求已经经 SFE-ROUTE 到
     * 目标节点（ACTIVE 已生效）之后的第一次读回失败（fail）或挂起（hang，之后服务崩溃）。
     */
    async function run(mode: 'fail' | 'hang', queueNormal: boolean) {
      const ctl = { armed: false, afterCheck: false, done: false, normalId: null as string | null, a: null as string | null, nodeB: '' };
      const wrap = (adapter: object): SurgeAdapter =>
        new Proxy(adapter, {
          get(target, prop) {
            const v = Reflect.get(target, prop, target) as unknown;
            if (typeof v !== 'function') return v;
            const fn = v as (...args: unknown[]) => unknown;
            return (...args: unknown[]) => {
              if (ctl.armed && prop === 'listRecentRequests') ctl.afterCheck = true;
              if (!ctl.afterCheck || ctl.done) return fn.apply(target, args);
              return (async () => {
                if (queueNormal && ctl.normalId === null && prop === 'matchRule') {
                  const req = ctl.a ? { request_id: rid(), old_session_policy: 'closed_confirmed' as const, confirmed_environment_id: ctl.a } : { request_id: rid() };
                  ctl.normalId = (await h.app.enterNormal(req, WEB)).operation_id;
                }
                const o = h.fake.simulateRequest({ processPath: FAKE_SAFARI_PATH, host: 'www.amazon.example.test', protocol: 'tcp' });
                if (READBACKS.has(String(prop)) && o.policyName === 'SFE-ROUTE' && o.leafPolicyName === ctl.nodeB) {
                  ctl.done = true;
                  if (mode === 'fail') throw new SfeError('SURGE_UNREACHABLE', '连接 Surge 失败：命令超时（模拟）');
                  return new Promise(() => undefined);
                }
                return fn.apply(target, args);
              })();
            };
          },
        }) as unknown as SurgeAdapter;
      h = await createHarness({ entryStrategy, dbFile: mode === 'hang', surge: (fake) => wrap(fake) });
      let b: string;
      if (withA) {
        ({ a: ctl.a, b } = await twoEnvs());
      } else {
        b = (await createEnv(h, 'US-Buyer-B', '203.0.113.11')).environment_id!;
        await bind(h, PROFILE_B, b);
      }
      ctl.nodeB = h.repos.proxyRevisions.get(b, 1)!.nodeName;
      const opId = await startSwitch(b);
      expect(h.repos.operations.get(opId)!.phase).toBe('VERIFY_ONLY');
      ctl.armed = true;
      const r = verify(h, PROFILE_B, opId, { amazonTabs: true });
      if (mode === 'fail') {
        expect((await r).ok).toBe(true);
      } else {
        const end = Date.now() + 5000;
        while (!ctl.done && Date.now() < end) await new Promise((res) => setTimeout(res, 2));
        expect(ctl.done).toBe(true);
        await h.crash();
      }
      await h.idle();
      expect(ctl.done).toBe(true);
      return { opId, b, normalId: ctl.normalId, a: ctl.a };
    }

    const label = /切换目标环境「US-Buyer-B · E000\d」的入口已开始写入使用中模式，其窗口可能已经过它的出口、未经确认/;

    test.each(['fail', 'hang'] as const)('%s with a normal mode accepted during the write: the rollback keeps the target\'s window warning and the queued normal mode completes with it (never "Safari 按 Surge 原规则发出请求" alone)', async (mode) => {
      const { opId, normalId } = await run(mode, true);
      expect(normalId).not.toBeNull();
      const act = h.repos.operations.get(opId)!;
      expect(['failed', 'needs_attention']).toContain(act.status);
      expect(h.repos.operations.listSteps(opId).at(-1)!.message).toMatch(label);
      const n = h.repos.operations.get(normalId!)!;
      expect(n.phase).toBe('NORMAL_RESTORED');
      const done = h.repos.operations.listSteps(normalId!).at(-1)!.message;
      expect(done).not.toBe('已进入普通模式：Safari 按 Surge 原规则发出请求');
      expect(done).toContain('旧环境窗口未关闭，其后续请求将按 Surge 原规则发出（可能直连）');
      expect(h.repos.routeState.get()).toMatchObject({ entryMode: 'NORMAL', phase: 'idle' });
      expect(h.repos.routeState.get().warnings).toContain('managed_windows_on_original_rules');
    });

    test('fail without a queued normal mode: the rollback records the window warning; a later normal mode keeps it', async () => {
      const { opId, a } = await run('fail', false);
      expect(h.repos.operations.listSteps(opId).at(-1)!.message).toMatch(label);
      expect(h.repos.routeState.get().warnings).toContain('managed_windows_on_original_rules');
      const route = h.repos.routeState.get();
      const req = route.activeEnvironmentId ? { request_id: rid(), old_session_policy: 'closed_confirmed' as const, confirmed_environment_id: a } : { request_id: rid() };
      const n = await h.app.enterNormal(req, WEB);
      await h.idle();
      expect(h.repos.operations.get(n.operation_id)!.phase).toBe('NORMAL_RESTORED');
      expect(h.repos.operations.listSteps(n.operation_id).at(-1)!.message).toContain('旧环境窗口未关闭');
      expect(h.repos.routeState.get().warnings).toContain('managed_windows_on_original_rules');
    });
  });

  test('a rollback before the ACTIVE write (the check itself fails) adds no window warning', async () => {
    h = await createHarness({ entryStrategy: 'temp_rule' });
    const b = (await createEnv(h, 'US-Buyer-B', '203.0.113.11')).environment_id!;
    await bind(h, PROFILE_B, b);
    const opId = await startSwitch(b);
    h.fake.failNext('listRecentRequests');
    expect((await verify(h, PROFILE_B, opId, { amazonTabs: true })).ok).toBe(true);
    await h.idle();
    expect(h.repos.operations.get(opId)!.phase).toBe('FAILED');
    expect(h.repos.routeState.get().warnings).not.toContain('managed_windows_on_original_rules');
    expect(h.repos.operations.listSteps(opId).at(-1)!.message).toBe('切换失败：切换前没有已验证的路由，Safari 保持阻断');
  });

  test('a normal mode whose confirmation named the handed-over target (re-verify of the active environment) adds no extra window warning', async () => {
    let afterCheck = false;
    let hook: (() => Promise<void>) | null = null;
    h = await createHarness({
      entryStrategy: 'temp_rule',
      surge: (fake) => beforeCall(beforeCall(fake, 'listRecentRequests', () => (afterCheck = true, null)), 'matchRule', () => (afterCheck ? hook : null)),
    });
    const { envId: a } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    // A 的回滚需要重新核验：再次使用 A 是一次完整切换（目标就是使用中的环境）
    h.repos.routeState.update({ warnings: ['rollback_needs_reverify'] });
    afterCheck = false;
    const opId = await startSwitch(a);
    expect(h.repos.operations.get(opId)!.phase).toBe('VERIFY_ONLY');
    let normalId: string | null = null;
    hook = async () => {
      hook = null;
      normalId = (await h.app.enterNormal({ request_id: rid(), old_session_policy: 'closed_confirmed', confirmed_environment_id: a }, WEB)).operation_id;
    };
    expect((await verify(h, PROFILE_A, opId)).ok).toBe(true);
    await h.idle();
    expect(h.repos.operations.get(opId)).toMatchObject({ phase: 'SUPERSEDED', supersededBy: normalId });
    expect(h.repos.operations.get(normalId!)!.phase).toBe('NORMAL_RESTORED');
    expect(h.repos.routeState.get().warnings).not.toContain('managed_windows_on_original_rules');
    expect(h.repos.operations.listSteps(normalId!).at(-1)!.message).toBe('已进入普通模式：Safari 按 Surge 原规则发出请求');
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
  test.each(['temp_rule', 'ruleset_resource'] as const)('%s: a failed switch with no verified route before it (first activation, or from normal mode) restores no node: the rollback result has no restored selection, the route records the actual selection', async (entryStrategy) => {
    h = await createHarness({ entryStrategy });
    const a = (await createEnv(h, 'US-Buyer-A', '203.0.113.10')).environment_id!;
    await bind(h, PROFILE_A, a);
    const nodeA = h.repos.proxyRevisions.get(a, 1)!.nodeName;
    const opId = await startSwitch(a);
    expect(h.repos.operations.get(opId)!.phase).toBe('VERIFY_ONLY');
    await verify(h, PROFILE_A, opId, { httpStatus: 503 });
    await h.idle();
    const op = h.repos.operations.get(opId)!;
    expect(op).toMatchObject({ phase: 'FAILED', status: 'failed' });
    const rb = (op.result as { rollback: RollbackResult }).rollback;
    expect(rb).toMatchObject({ previousEnvironmentId: null, previousProxyRevision: null, restoredSelection: null, entryModeAfter: 'BLOCKED', needsReverify: false });
    expect(h.repos.operations.listSteps(opId).at(-1)!.message).toBe('切换失败：切换前没有已验证的路由，Safari 保持阻断');
    // 路由记下实际的选择（刚失败的目标节点；入口已确认阻断，Safari 不经它）
    expect(await h.fake.getGroupSelection(ROUTE_GROUP_NAME)).toBe(nodeA);
    expect(h.repos.routeState.get()).toMatchObject({ phase: 'failed', entryMode: 'BLOCKED', activeEnvironmentId: null, selectedNode: nodeA });
    expect(h.repos.routeState.get().warnings).not.toContain('rollback_needs_reverify');
    expect(safariOutcome(h).failed).toBe(true);
  });

  describe.each([
    ['temp_rule', 'cancel'],
    ['temp_rule', 'timeout'],
    ['ruleset_resource', 'cancel'],
    ['ruleset_resource', 'timeout'],
  ] as const)('%s: a retest end point held SFE-ROUTE at REJECT, then re-using the environment fails (%s)', (entryStrategy, how) => {
    test('the rollback does not "restore" the REJECT as the original node: it keeps REJECT, restores no buyer node, shows no earlier exit and the route still needs attention (§6.3 step 14)', async () => {
      h = await createHarness({ entryStrategy });
      const { a, b } = await twoEnvs();
      const nodeA = h.repos.proxyRevisions.get(a, 1)!.nodeName;
      const nodeB = h.repos.proxyRevisions.get(b, 1)!.nodeName;
      // 用户在 Surge 中把 SFE-ROUTE 改选到 B 的节点，然后重新检测 A：开始等待时读到的选择与记录不一致，结束点改选 REJECT
      await h.fake.selectGroupPolicy(ROUTE_GROUP_NAME, nodeB);
      const p = (await h.app.probe(a, { request_id: rid(), kind: 'safari' }, WEB)).operation_id;
      await h.idle();
      expect(h.repos.operations.get(p)!.result?.rejectSelected).toBe(true);
      expect(h.repos.routeState.get()).toMatchObject({ phase: 'attention', activeEnvironmentId: a, selectedNode: 'REJECT', activationSnapshot: null });
      // 按结束说明重新使用 A：完整切换，切换前的选择是 REJECT
      const act = await startSwitch(a);
      expect(h.repos.operations.get(act)!.phase).toBe('VERIFY_ONLY');
      expect(h.repos.routeState.get().activationSnapshot).toMatchObject({ previousEnvironmentId: a, previousSelectedNode: 'REJECT' });
      if (how === 'cancel') await h.app.cancelOperation(act, { request_id: rid('cancel') }, WEB);
      else await h.clock.advanceAsync((h.repos.settings.get('profileArrivalTimeoutSec') + 1) * 1000);
      await h.idle();
      const op = h.repos.operations.get(act)!;
      expect(op).toMatchObject({ phase: 'FAILED', status: 'failed' });
      const rb = (op.result as { rollback: RollbackResult }).rollback;
      expect(rb).toMatchObject({ previousEnvironmentId: null, previousProxyRevision: null, previousProbe: null, restoredSelection: null, entryModeAfter: 'BLOCKED', needsReverify: false, rejectKept: true });
      const step = h.repos.operations.listSteps(act).at(-1)!.message;
      expect(step).not.toContain('恢复切换前的节点');
      expect(step).toContain('切换前 SFE-ROUTE 已失败即关闭改选 REJECT');
      expect(step).toContain('未恢复任何买家节点');
      // SFE-ROUTE 改回 REJECT（不是本次切换写入的 A 节点，也不是 B），入口已确认阻断；使用中的环境仍是 A，路由需要处理
      expect(await h.fake.getGroupSelection(ROUTE_GROUP_NAME)).toBe('REJECT');
      const route = h.repos.routeState.get();
      expect(route).toMatchObject({ phase: 'attention', entryMode: 'BLOCKED', activeEnvironmentId: a, selectedNode: 'REJECT', activationSnapshot: null });
      expect(route.warnings).not.toContain('rollback_needs_reverify');
      const viewA = await h.app.getEnvironment(a, WEB);
      expect(viewA.facets.route).toBe('active');
      expect(viewA.readiness).not.toBe('needs_reverify');
      expect(viewA.nextActions[0]!.message).toContain('路由状态需要处理');
      expect(viewA.nextActions.map((x) => x.message).join('；')).not.toContain('已恢复原节点');
      expect(safariOutcome(h).failed).toBe(true);
      expect(safariOutcome(h).leafPolicyName).not.toBe(nodeA);
      expect(h.fake.simulateRequest({ processPath: FAKE_CHROME_PATH, host: 'www.example.test', protocol: 'tcp' }).rule).toBe('FINAL,DIRECT');
      // 再次重新使用 A（这次核对通过）：照常切换并提交
      const again = await startSwitch(a);
      expect((await verify(h, PROFILE_A, again)).ok).toBe(true);
      await h.idle();
      expect(h.repos.operations.get(again)!.phase).toBe('ACTIVE_VERIFIED');
      expect(h.repos.routeState.get()).toMatchObject({ phase: 'active_verified', entryMode: 'ACTIVE', activeEnvironmentId: a, selectedNode: nodeA });
    });
  });

  test.each(['verify_only', 'before_verify_only'] as const)('temp_rule: after a successful rollback, a new switch that normal mode takes over (%s) and whose NORMAL step fails no longer claims the original node was restored (rollback_needs_reverify dropped when the switch started)', async (where) => {
    h = await createHarness({ entryStrategy: 'temp_rule' });
    const { a, b } = await twoEnvs();
    const nodeA = h.repos.proxyRevisions.get(a, 1)!.nodeName;
    const nodeB = h.repos.proxyRevisions.get(b, 1)!.nodeName;
    // 第一次切换到 B：等待超时 → 回滚成功（恢复 A 的节点并保持阻断）
    const act1 = await startSwitch(b);
    await h.clock.advanceAsync((h.repos.settings.get('profileArrivalTimeoutSec') + 1) * 1000);
    await h.idle();
    expect(h.repos.operations.get(act1)!.phase).toBe('FAILED');
    expect(h.repos.routeState.get()).toMatchObject({ phase: 'failed', entryMode: 'BLOCKED', activeEnvironmentId: a, selectedNode: nodeA });
    expect(h.repos.routeState.get().warnings).toContain('rollback_needs_reverify');
    // 再次切换到 B；普通模式接手它，而普通模式撤销入口的 NORMAL 一步失败（入口停在确认的阻断）
    let normalId: string | null = null;
    if (where === 'before_verify_only') {
      const sel = h.fake.selectGroupPolicy.bind(h.fake);
      let fired = false;
      h.fake.selectGroupPolicy = async (g: string, pol: string) => {
        const r = await sel(g, pol);
        if (!fired && pol === nodeB) {
          fired = true;
          normalId = (await h.app.enterNormal({ request_id: rid('normal'), old_session_policy: 'closed_confirmed', confirmed_environment_id: a }, WEB)).operation_id;
        }
        return r;
      };
    }
    let armed = false;
    const list = h.fake.listActiveRequests.bind(h.fake);
    h.fake.listActiveRequests = async () => {
      if (!armed && h.repos.operations.listByStatus(['running']).some((o) => o.kind === 'route.normal')) {
        armed = true;
        h.fake.failNext('removeTempRule');
      }
      return list();
    };
    const act2 = await startSwitch(b);
    if (where === 'verify_only') {
      expect(h.repos.operations.get(act2)!.phase).toBe('VERIFY_ONLY');
      expect(h.repos.routeState.get().selectedNode).toBe(nodeB);
      // 切换已开始：「已恢复原节点并保持阻断」不再成立
      expect(h.repos.routeState.get().warnings).not.toContain('rollback_needs_reverify');
      normalId = (await h.app.enterNormal({ request_id: rid('normal'), old_session_policy: 'closed_confirmed', confirmed_environment_id: a }, WEB)).operation_id;
      await h.idle();
    }
    expect(normalId).not.toBeNull();
    expect(armed).toBe(true);
    expect(h.repos.operations.get(act2)!.phase).toBe('SUPERSEDED');
    expect(h.repos.operations.get(normalId!)!).toMatchObject({ phase: 'FAILED', status: 'failed' });
    const route = h.repos.routeState.get();
    expect(route).toMatchObject({ entryMode: 'BLOCKED', activeEnvironmentId: a, selectedNode: nodeB });
    expect(await h.fake.getGroupSelection(ROUTE_GROUP_NAME)).toBe(nodeB);
    expect(route.warnings).not.toContain('rollback_needs_reverify');
    const viewA = await h.app.getEnvironment(a, WEB);
    expect(viewA.facets.route).not.toBe('rolled_back');
    expect(viewA.nextActions.map((x) => x.message).join('\n')).not.toContain('已恢复原节点并保持阻断');
    expect(safariOutcome(h).failed).toBe(true);
  });

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

  /** 切换到 B 等待超时 → 回滚成功（恢复 A 的节点并保持阻断，rollback_needs_reverify）。 */
  async function rolledBackToA(): Promise<{ a: string; b: string; nodeA: string; nodeB: string }> {
    const { a, b } = await twoEnvs();
    const nodeA = h.repos.proxyRevisions.get(a, 1)!.nodeName;
    const nodeB = h.repos.proxyRevisions.get(b, 1)!.nodeName;
    const act = await startSwitch(b);
    await h.clock.advanceAsync((h.repos.settings.get('profileArrivalTimeoutSec') + 1) * 1000);
    await h.idle();
    expect(h.repos.operations.get(act)!.phase).toBe('FAILED');
    expect(h.repos.routeState.get()).toMatchObject({ phase: 'failed', entryMode: 'BLOCKED', activeEnvironmentId: a, selectedNode: nodeA });
    expect(h.repos.routeState.get().warnings).toContain('rollback_needs_reverify');
    expect((await h.app.getEnvironment(a, WEB)).facets.route).toBe('rolled_back');
    return { a, b, nodeA, nodeB };
  }

  async function expectNoRestoredClaim(a: string): Promise<void> {
    expect(h.repos.routeState.get().warnings).not.toContain('rollback_needs_reverify');
    const viewA = await h.app.getEnvironment(a, WEB);
    expect(viewA.facets.route).not.toBe('rolled_back');
    const messages = viewA.nextActions.map((x) => x.message).join('\n');
    expect(messages).not.toContain('已恢复原节点');
    expect(messages).toContain('路由状态需要处理');
    // Safari 仍被阻断：从不写回选择、从不放行
    expect(safariOutcome(h).failed).toBe(true);
  }

  test.each(['temp_rule', 'ruleset_resource'] as const)('%s: after a successful rollback, SFE-ROUTE re-selected in Surge to another buyer\'s node → the periodic reconcile drops rollback_needs_reverify; the environment no longer claims the original node was restored', async (entryStrategy) => {
    h = await createHarness({ entryStrategy });
    const { a, nodeB } = await rolledBackToA();
    // 用户在 Surge 中给 SFE-ROUTE 选了 B 的节点
    await h.fake.selectGroupPolicy(ROUTE_GROUP_NAME, nodeB);
    await h.app.runPeriodicReconcile();
    const route = h.repos.routeState.get();
    expect(route).toMatchObject({ phase: 'external_change', entryMode: 'BLOCKED', activeEnvironmentId: a });
    expect(route.warnings).toContain('external_selection_change');
    expect(await h.fake.getGroupSelection(ROUTE_GROUP_NAME)).toBe(nodeB);
    await expectNoRestoredClaim(a);
  });

  test('after a successful rollback, a publish whose own rollback cannot confirm the SFE-ROUTE selection drops rollback_needs_reverify', async () => {
    h = await createHarness();
    const { a } = await rolledBackToA();
    // 发布写入之后 Surge 重新读取节点资源时选择回落到 REJECT（读回不一致），回滚恢复选择的那一次写入失败
    const orig = h.fake.getGroupMembers.bind(h.fake);
    let first = true;
    h.fake.getGroupMembers = async (group: string) => {
      const r = await orig(group);
      if (first) {
        first = false;
        await h.fake.selectGroupPolicy(ROUTE_GROUP_NAME, 'REJECT');
        h.fake.failNext('selectGroupPolicy');
      }
      return r;
    };
    const c = await createEnv(h, 'US-Buyer-C', '203.0.113.12');
    expect(first).toBe(false);
    expect(h.repos.operations.get(c.operation_id)!).toMatchObject({ phase: 'BLOCKED_NEEDS_ATTENTION', status: 'needs_attention' });
    expect(h.repos.deployments.latest()!.state).toBe('failed');
    const route = h.repos.routeState.get();
    expect(route).toMatchObject({ phase: 'attention', entryMode: 'BLOCKED', activeEnvironmentId: a });
    expect(route.warnings).toContain('external_selection_change');
    await expectNoRestoredClaim(a);
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

  test('a cancel accepted while a submitted verification is still queued (executor busy) wins: the switch rolls back instead of committing', async () => {
    h = await createHarness();
    const { a, b } = await twoEnvs();
    const nodeA = h.repos.proxyRevisions.get(a, 1)!.nodeName;
    const opId = await startSwitch(b);
    const begin = await h.native(PROFILE_B, { type: 'beginSafariVerification', operation_id: opId, amazon_tabs_open: false });
    const d = (begin as { data: { status: string; test_id: string; route_epoch: number } }).data;
    expect(d.status).toBe('ready');
    // 执行器忙（周期对账、其他操作）：提交只排入结果，操作仍在等待中
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const enteredP = new Promise<void>((r) => (entered = r));
    const held = h.app.executor.runInternal('hold', async () => {
      entered();
      await gate;
    });
    await enteredP;
    const started = h.clock.now().toISOString();
    h.fake.simulateRequest({ processPath: FAKE_SAFARI_PATH, host: FAKE_VERIFY_HOST, protocol: 'tcp' });
    const sub = await h.native(PROFILE_B, {
      type: 'submitSafariVerification',
      operation_id: opId,
      test_id: d.test_id,
      route_epoch: d.route_epoch,
      observed_ip: '192.0.2.50',
      http_status: 200,
      error: null,
      started_at: started,
      finished_at: h.clock.now().toISOString(),
    });
    expect(sub.ok).toBe(true);
    expect(h.repos.operations.get(opId)!.status).toBe('waiting');
    // 取消照常受理（202）：排在已排入的结果之后
    const acc = await h.app.cancelOperation(opId, { request_id: rid('cancel') }, WEB);
    expect(acc.duplicate).toBe(false);
    // 已受理取消之后不再签发检测编号
    const again = await h.native(PROFILE_B, { type: 'beginSafariVerification', operation_id: opId, amazon_tabs_open: false });
    expect((again as { data: { status: string } }).data.status).toBe('pending');
    release();
    await held;
    await h.idle();
    const op = h.repos.operations.get(opId)!;
    expect(op).toMatchObject({ phase: 'FAILED', status: 'failed' });
    expect(op.error?.message).toBe('已取消切换');
    expect((op.result as { rollback: RollbackResult }).rollback).toMatchObject({ previousEnvironmentId: a, restoredSelection: nodeA, entryModeAfter: 'BLOCKED' });
    expect(h.repos.routeState.get()).toMatchObject({ phase: 'failed', entryMode: 'BLOCKED', activeEnvironmentId: a, selectedNode: nodeA });
    expect(h.repos.probes.latest(b, 'safari')).toBeNull();
    expect(safariOutcome(h).failed).toBe(true);
  });

  test('a cancel accepted while a submitted Safari re-test result is still queued ends the re-test without recording a probe', async () => {
    h = await createHarness();
    const { envId: a } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const probeBefore = h.repos.probes.latest(a, 'safari')!.id;
    const r = await h.app.probe(a, { request_id: rid('probe'), kind: 'safari' }, WEB);
    await h.idle();
    const opId = r.operation_id;
    expect(h.repos.operations.get(opId)).toMatchObject({ status: 'waiting', probeKind: 'safari' });
    const begin = await h.native(PROFILE_A, { type: 'beginSafariVerification', operation_id: opId, amazon_tabs_open: false });
    const d = (begin as { data: { status: string; test_id: string; route_epoch: number } }).data;
    expect(d.status).toBe('ready');
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    let entered!: () => void;
    const enteredP = new Promise<void>((res) => (entered = res));
    const held = h.app.executor.runInternal('hold', async () => {
      entered();
      await gate;
    });
    await enteredP;
    const started = h.clock.now().toISOString();
    h.fake.simulateRequest({ processPath: FAKE_SAFARI_PATH, host: FAKE_VERIFY_HOST, protocol: 'tcp' });
    const sub = await h.native(PROFILE_A, {
      type: 'submitSafariVerification',
      operation_id: opId,
      test_id: d.test_id,
      route_epoch: d.route_epoch,
      observed_ip: '192.0.2.50',
      http_status: 200,
      error: null,
      started_at: started,
      finished_at: h.clock.now().toISOString(),
    });
    expect(sub.ok).toBe(true);
    await h.app.cancelOperation(opId, { request_id: rid('cancel') }, WEB);
    release();
    await held;
    await h.idle();
    const op = h.repos.operations.get(opId)!;
    expect(op).toMatchObject({ phase: 'FAILED', status: 'failed' });
    expect(op.error?.message).toBe('已取消重新检测：路由未改变');
    expect(h.repos.probes.latest(a, 'safari')!.id).toBe(probeBefore);
    expect(h.repos.routeState.get()).toMatchObject({ phase: 'active_verified', entryMode: 'ACTIVE', activeEnvironmentId: a });
  });

  test('…and when the submitted exit IP differs from the expected exit, the cancel still records the mismatch the service can judge without Surge: exit_ip_mismatch, orders and fill stop', async () => {
    h = await createHarness();
    const { envId: a } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const expected = ['192', '0', '2', '50'].join('.');
    const observed = ['192', '0', '2', '77'].join('.');
    const env = h.repos.environments.get(a)!;
    await h.app.updateEnvironment(a, { request_id: rid(), expected_revision: env.revision, changes: { proxy: { expectedExitIp: expected } } }, WEB);
    await h.idle();
    expect(h.repos.routeState.get().warnings).not.toContain('exit_ip_mismatch');
    const r = await h.app.probe(a, { request_id: rid('probe'), kind: 'safari' }, WEB);
    await h.idle();
    const opId = r.operation_id;
    const begin = await h.native(PROFILE_A, { type: 'beginSafariVerification', operation_id: opId, amazon_tabs_open: false });
    const d = (begin as { data: { status: string; test_id: string; route_epoch: number } }).data;
    expect(d.status).toBe('ready');
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    let entered!: () => void;
    const enteredP = new Promise<void>((res) => (entered = res));
    const held = h.app.executor.runInternal('hold', async () => {
      entered();
      await gate;
    });
    await enteredP;
    const started = h.clock.now().toISOString();
    h.fake.simulateRequest({ processPath: FAKE_SAFARI_PATH, host: FAKE_VERIFY_HOST, protocol: 'tcp' });
    const sub = await h.native(PROFILE_A, {
      type: 'submitSafariVerification',
      operation_id: opId,
      test_id: d.test_id,
      route_epoch: d.route_epoch,
      observed_ip: observed,
      http_status: 200,
      error: null,
      started_at: started,
      finished_at: h.clock.now().toISOString(),
    });
    expect(sub.ok).toBe(true);
    await h.app.cancelOperation(opId, { request_id: rid('cancel') }, WEB);
    release();
    await held;
    await h.idle();
    const op = h.repos.operations.get(opId)!;
    expect(op).toMatchObject({ phase: 'FAILED', status: 'failed' });
    expect(op.error?.code).toBe('SUPERSEDED');
    expect(op.error?.message).toContain('已取消重新检测');
    expect(op.error?.message).toContain('已记下出口不符');
    expect(op.result?.probeWarning).toBe('exit_ip_mismatch');
    expect(h.repos.probes.latest(a, 'safari')).toMatchObject({ outcome: 'mismatch', exitIp: observed });
    expect(h.repos.routeState.get()).toMatchObject({ phase: 'active_verified', entryMode: 'ACTIVE', activeEnvironmentId: a });
    expect(h.repos.routeState.get().warnings).toContain('exit_ip_mismatch');
    const state = (await h.native(PROFILE_A, { type: 'getCurrentState' })) as { data: { ordersAllowed: boolean } };
    expect(state.data.ordersAllowed).toBe(false);
    expect((await h.app.ensureInControl()).ok).toBe(false);
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

  test('arrived in WAITING_ROUTE, switched to VERIFY_ONLY, but no test issued (prepare page closed): the new arrival deadline still rolls back per step 14', async () => {
    h = await createHarness();
    const { envId } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const nodeV1 = h.repos.proxyRevisions.get(envId, 1)!.nodeName;
    const env = h.repos.environments.get(envId)!;
    const u = await h.app.updateEnvironment(envId, { request_id: rid(), expected_revision: env.revision, changes: { proxy: { host: '203.0.113.20' } } }, WEB);
    await h.idle();
    expect(h.repos.operations.get(u.operation_id)!.phase).toBe('WAITING_ROUTE');
    // 准备页只在 WAITING_ROUTE 调用一次（写入到达），之后在切换期间被关闭：VERIFY_ONLY 等待中没有签发检测编号
    const first = await h.native(PROFILE_A, { type: 'beginSafariVerification', operation_id: u.operation_id, amazon_tabs_open: false });
    expect((first as { data: { status: string } }).data.status).toBe('pending');
    await h.idle();
    const waiting = h.repos.operations.get(u.operation_id)!;
    expect(waiting.phase).toBe('VERIFY_ONLY');
    expect((waiting.payload as { route: { verifyDeadline: string | null } }).route.verifyDeadline).toBeNull();
    const deadline = h.repos.routeState.get().awaitingDeadline;
    expect(deadline).not.toBeNull();
    // 网页与弹窗显示的截止时间（awaitingDeadline / arrivalDeadline）到达时照常按第 14 步回滚
    await h.clock.advanceAsync(601_000);
    await h.idle();
    const op = h.repos.operations.get(u.operation_id)!;
    expect(op).toMatchObject({ phase: 'FAILED', status: 'failed' });
    expect(op.error?.code).toBe('SAFARI_VERIFY_TIMEOUT');
    expect(h.repos.routeState.get()).toMatchObject({ phase: 'failed', entryMode: 'BLOCKED', activeProxyRevision: 1, selectedNode: nodeV1, awaitingDeadline: null });
    expect(await h.fake.getGroupSelection('SFE-ROUTE')).toBe(nodeV1);
    expect(safariOutcome(h, FAKE_VERIFY_HOST).failed).toBe(true);
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

  test.each(['ruleset_resource', 'temp_rule'] as const)(
    '[%s] a cancel accepted after the bound profile arrived (executor busy, profile_arrived still queued) wins: WAITING_ROUTE ends READY_FOR_NEXT_OPEN without touching Surge',
    async (entryStrategy) => {
      h = await createHarness({ entryStrategy });
      const { envId } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
      const nodeV1 = h.repos.proxyRevisions.get(envId, 1)!.nodeName;
      const env = h.repos.environments.get(envId)!;
      const u = await h.app.updateEnvironment(envId, { request_id: rid(), expected_revision: env.revision, changes: { proxy: { host: '203.0.113.20' } } }, WEB);
      await h.idle();
      expect(h.repos.operations.get(u.operation_id)!.phase).toBe('WAITING_ROUTE');
      const oldSafari = h.fake.simulateRequest({ processPath: FAKE_SAFARI_PATH, host: 'www.example.test', protocol: 'tcp', longLived: true });
      // 执行器忙（周期对账、其他环境的发布或预检）：到达只排入 profile_arrived，操作仍停在 WAITING_ROUTE
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let entered!: () => void;
      const enteredP = new Promise<void>((r) => (entered = r));
      const held = h.app.executor.runInternal('hold', async () => {
        entered();
        await gate;
      });
      await enteredP;
      const arrived = await h.native(PROFILE_A, { type: 'beginSafariVerification', operation_id: u.operation_id, amazon_tabs_open: false });
      expect((arrived as { data: { status: string } }).data.status).toBe('pending');
      expect(h.repos.outbox.pendingForOperation(u.operation_id).map((r) => r.resumeReason)).toContain('profile_arrived');
      type Pending = { data: { pendingVerification: { waiting_route: boolean } } };
      const state = await h.native(PROFILE_A, { type: 'getCurrentState' });
      expect((state as Pending).data.pendingVerification.waiting_route).toBe(true);
      const before = writesCount();
      // 弹窗「取消等待」照常受理，排在已排入的到达之后
      const cancel = await h.native(PROFILE_A, { type: 'cancelOperation', request_id: rid('cancel'), operation_id: u.operation_id });
      expect(cancel.ok).toBe(true);
      // 已受理取消之后的到达不再排入切换
      const again = await h.native(PROFILE_A, { type: 'beginSafariVerification', operation_id: u.operation_id, amazon_tabs_open: false });
      expect((again as { data: { status: string; message: string } }).data).toMatchObject({ status: 'pending', message: '已请求取消，正在处理' });
      release();
      await held;
      await h.idle();
      const op = h.repos.operations.get(u.operation_id)!;
      expect(op).toMatchObject({ phase: 'READY_FOR_NEXT_OPEN', status: 'succeeded', error: null });
      expect(h.repos.routeState.get()).toMatchObject({ phase: 'active_verified', entryMode: 'ACTIVE', activeProxyRevision: 1, selectedNode: nodeV1, warnings: [] });
      // 没有阻断、没有结束连接、没有改选节点：当前出口不变（弹窗与网页的取消说明）
      expect(writesCount()).toEqual(before);
      expect((await h.fake.listActiveRequests()).map((r) => r.id)).toContain(oldSafari.id);
      expect(safariOutcome(h).leafPolicyName).toBe(nodeV1);
    },
  );

  test('a second proxy edit while the first one waits ends the first as READY_FOR_NEXT_OPEN: the popup and arrivals only ever switch to the newest revision', async () => {
    h = await createHarness();
    const { envId } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    let env = h.repos.environments.get(envId)!;
    // 第一次修改指向了另一个买家的代理（随后更正）
    const u1 = await h.app.updateEnvironment(envId, { request_id: rid(), expected_revision: env.revision, changes: { proxy: { host: '203.0.113.99' } } }, WEB);
    await h.idle();
    expect(h.repos.operations.get(u1.operation_id)!.phase).toBe('WAITING_ROUTE');
    env = h.repos.environments.get(envId)!;
    const u2 = await h.app.updateEnvironment(envId, { request_id: rid(), expected_revision: env.revision, changes: { proxy: { host: '203.0.113.30' } } }, WEB);
    await h.idle();
    expect(h.repos.environments.get(envId)!.deployedProxyRevision).toBe(3);
    expect(h.repos.operations.get(u2.operation_id)!.phase).toBe('WAITING_ROUTE');
    const first = h.repos.operations.get(u1.operation_id)!;
    expect(first).toMatchObject({ phase: 'READY_FOR_NEXT_OPEN', status: 'succeeded', supersededBy: u2.operation_id, error: null });
    expect(h.repos.outbox.pendingForOperation(u1.operation_id)).toEqual([]);
    type Pending = { data: { pendingVerification: { operation_id: string } | null } };
    const state = await h.native(PROFILE_A, { type: 'getCurrentState' });
    expect((state as Pending).data.pendingVerification?.operation_id).toBe(u2.operation_id);
    // 旧的准备页再到达：已结束，不切换
    const stale = await h.native(PROFILE_A, { type: 'beginSafariVerification', operation_id: u1.operation_id, amazon_tabs_open: false });
    expect((stale as { data: { status: string } }).data.status).toBe('not_needed');
    const arrived = await h.native(PROFILE_A, { type: 'beginSafariVerification', operation_id: u2.operation_id, amazon_tabs_open: false });
    expect((arrived as { data: { status: string } }).data.status).toBe('pending');
    await h.idle();
    await verify(h, PROFILE_A, u2.operation_id);
    expect(h.repos.operations.get(u2.operation_id)!.phase).toBe('ACTIVE_VERIFIED');
    expect(h.repos.routeState.get()).toMatchObject({ activeProxyRevision: 3, phase: 'active_verified' });
    const after = await h.native(PROFILE_A, { type: 'getCurrentState' });
    expect((after as Pending).data.pendingVerification).toBeNull();
    expect(safariOutcome(h).leafPolicyName).toBe('SFE-N-E0001-US01-v003');
  });

  test('a WAITING_ROUTE publish whose revision was replaced (left over from before the upgrade) ends READY_FOR_NEXT_OPEN on arrival without touching Surge', async () => {
    h = await createHarness();
    const { envId } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const nodeV1 = h.repos.proxyRevisions.get(envId, 1)!.nodeName;
    let env = h.repos.environments.get(envId)!;
    const u1 = await h.app.updateEnvironment(envId, { request_id: rid(), expected_revision: env.revision, changes: { proxy: { host: '203.0.113.99' } } }, WEB);
    await h.idle();
    env = h.repos.environments.get(envId)!;
    const u2 = await h.app.updateEnvironment(envId, { request_id: rid(), expected_revision: env.revision, changes: { proxy: { host: '203.0.113.30' } } }, WEB);
    await h.idle();
    // 升级前留下的数据：同一环境的两个发布都停在 WAITING_ROUTE
    h.repos.operations.update(u1.operation_id, { phase: 'WAITING_ROUTE', status: 'waiting', supersededBy: null });
    const before = writesCount();
    const arrived = await h.native(PROFILE_A, { type: 'beginSafariVerification', operation_id: u1.operation_id, amazon_tabs_open: false });
    expect((arrived as { data: { status: string } }).data.status).toBe('pending');
    await h.idle();
    const op = h.repos.operations.get(u1.operation_id)!;
    expect(op).toMatchObject({ phase: 'READY_FOR_NEXT_OPEN', status: 'succeeded', error: null });
    expect(h.repos.operations.listSteps(u1.operation_id).at(-1)!.message).toContain('已被之后的修改替换');
    expect(writesCount()).toEqual(before);
    expect(h.repos.routeState.get()).toMatchObject({ phase: 'active_verified', entryMode: 'ACTIVE', activeProxyRevision: 1, selectedNode: nodeV1 });
    expect(h.repos.operations.get(u2.operation_id)!.phase).toBe('WAITING_ROUTE');
  });

  test('a publish switch whose revision is replaced while it waits in VERIFY_ONLY is not committed: it rolls back per step 14 and the newer revision switches next', async () => {
    h = await createHarness();
    const { envId } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const nodeV1 = h.repos.proxyRevisions.get(envId, 1)!.nodeName;
    let env = h.repos.environments.get(envId)!;
    const u1 = await h.app.updateEnvironment(envId, { request_id: rid(), expected_revision: env.revision, changes: { proxy: { host: '203.0.113.99' } } }, WEB);
    await h.idle();
    await h.native(PROFILE_A, { type: 'beginSafariVerification', operation_id: u1.operation_id, amazon_tabs_open: false });
    await h.idle();
    expect(h.repos.operations.get(u1.operation_id)!.phase).toBe('VERIFY_ONLY');
    // 等待实测期间更正代理：更新的版本已部署
    env = h.repos.environments.get(envId)!;
    const u2 = await h.app.updateEnvironment(envId, { request_id: rid(), expected_revision: env.revision, changes: { proxy: { host: '203.0.113.30' } } }, WEB);
    await h.idle();
    expect(h.repos.environments.get(envId)!.deployedProxyRevision).toBe(3);
    expect(h.repos.operations.get(u2.operation_id)!.phase).toBe('WAITING_ROUTE');
    // 旧准备页的实测通过：不提交被替换的版本
    await verify(h, PROFILE_A, u1.operation_id);
    const op = h.repos.operations.get(u1.operation_id)!;
    expect(op).toMatchObject({ phase: 'FAILED', status: 'failed' });
    expect(op.error?.code).toBe('NODE_NOT_DEPLOYED');
    expect(h.repos.routeState.get()).toMatchObject({ phase: 'failed', entryMode: 'BLOCKED', activeProxyRevision: 1, selectedNode: nodeV1 });
    expect(h.repos.environments.get(envId)!.lastVerifiedProxyRevision).toBe(1);
    expect(safariOutcome(h).failed).toBe(true);
    // 更新的版本在下次到达时切换
    await h.native(PROFILE_A, { type: 'beginSafariVerification', operation_id: u2.operation_id, amazon_tabs_open: false });
    await h.idle();
    await verify(h, PROFILE_A, u2.operation_id);
    expect(h.repos.operations.get(u2.operation_id)!.phase).toBe('ACTIVE_VERIFIED');
    expect(h.repos.routeState.get()).toMatchObject({ activeProxyRevision: 3, phase: 'active_verified', entryMode: 'ACTIVE' });
    expect(safariOutcome(h).leafPolicyName).toBe('SFE-N-E0001-US01-v003');
  });

  // 更正的版本已保存但没有部署成功（发布失败、暂停待部署）：被替换的版本从不切换（§6.3 第 2、13 步：替换指之后保存了更新的版本）
  const failCorrection = {
    failed: () => h.fake.failNext('listPolicies'),
    parked: () => h.revoke(['connection_continuity']),
  } as const;

  test.each(['failed', 'parked'] as const)(
    'saving a correction ends the replaced WAITING_ROUTE at once, even when the correction is %s: the popup and a stale arrival never switch to the replaced revision',
    async (how) => {
      h = await createHarness();
      const { envId } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
      const nodeV1 = h.repos.proxyRevisions.get(envId, 1)!.nodeName;
      let env = h.repos.environments.get(envId)!;
      // 第一次修改指向了另一个买家的代理（随后更正）
      const u1 = await h.app.updateEnvironment(envId, { request_id: rid(), expected_revision: env.revision, changes: { proxy: { host: '203.0.113.99' } } }, WEB);
      await h.idle();
      expect(h.repos.operations.get(u1.operation_id)!.phase).toBe('WAITING_ROUTE');
      failCorrection[how]();
      env = h.repos.environments.get(envId)!;
      const u2 = await h.app.updateEnvironment(envId, { request_id: rid(), expected_revision: env.revision, changes: { proxy: { host: '203.0.113.30' } } }, WEB);
      // 保存事务中即结束（不等更正的版本部署）
      const first = h.repos.operations.get(u1.operation_id)!;
      expect(first).toMatchObject({ phase: 'READY_FOR_NEXT_OPEN', status: 'succeeded', supersededBy: u2.operation_id, error: null });
      expect(h.repos.operations.listSteps(u1.operation_id).at(-1)!.message).toContain('已保存 v003');
      expect(h.repos.outbox.pendingForOperation(u1.operation_id)).toEqual([]);
      await h.idle();
      const second = h.repos.operations.get(u2.operation_id)!;
      expect(second.phase).toBe(how === 'failed' ? 'FAILED' : 'WAITING_DEPLOYMENT');
      expect(h.repos.environments.get(envId)!).toMatchObject({ desiredProxyRevision: 3, deployedProxyRevision: 2 });
      type Pending = { data: { pendingVerification: { operation_id: string } | null } };
      const state = await h.native(PROFILE_A, { type: 'getCurrentState' });
      expect((state as Pending).data.pendingVerification).toBeNull();
      const before = writesCount();
      // 旧准备页再到达：已结束，不切换，也不提示「重新使用此环境」（那会选用被替换的版本）
      const stale = await h.native(PROFILE_A, { type: 'beginSafariVerification', operation_id: u1.operation_id, amazon_tabs_open: false });
      expect((stale as { data: { status: string; message: string } }).data).toEqual({ status: 'not_needed', message: '等待已结束：之后又修改了代理，不切换到这一版本，当前出口不变' });
      await h.idle();
      expect(writesCount()).toEqual(before);
      expect(h.repos.routeState.get()).toMatchObject({ phase: 'active_verified', entryMode: 'ACTIVE', activeProxyRevision: 1, selectedNode: nodeV1 });
      expect(safariOutcome(h).leafPolicyName).toBe(nodeV1);
    },
  );

  test('a WAITING_ROUTE publish left over with a saved-but-undeployed newer revision ends READY_FOR_NEXT_OPEN on arrival without touching Surge', async () => {
    h = await createHarness();
    const { envId } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const nodeV1 = h.repos.proxyRevisions.get(envId, 1)!.nodeName;
    let env = h.repos.environments.get(envId)!;
    const u1 = await h.app.updateEnvironment(envId, { request_id: rid(), expected_revision: env.revision, changes: { proxy: { host: '203.0.113.99' } } }, WEB);
    await h.idle();
    h.fake.failNext('listPolicies');
    env = h.repos.environments.get(envId)!;
    await h.app.updateEnvironment(envId, { request_id: rid(), expected_revision: env.revision, changes: { proxy: { host: '203.0.113.30' } } }, WEB);
    await h.idle();
    expect(h.repos.environments.get(envId)!).toMatchObject({ desiredProxyRevision: 3, deployedProxyRevision: 2 });
    // 升级前留下的数据：保存时没有结束等待
    h.repos.operations.update(u1.operation_id, { phase: 'WAITING_ROUTE', status: 'waiting', supersededBy: null });
    const before = writesCount();
    const arrived = await h.native(PROFILE_A, { type: 'beginSafariVerification', operation_id: u1.operation_id, amazon_tabs_open: false });
    expect((arrived as { data: { status: string } }).data.status).toBe('pending');
    await h.idle();
    expect(h.repos.operations.get(u1.operation_id)!).toMatchObject({ phase: 'READY_FOR_NEXT_OPEN', status: 'succeeded', error: null });
    expect(h.repos.operations.listSteps(u1.operation_id).at(-1)!.message).toContain('已被之后的修改替换（已保存 v003，尚未部署）');
    expect(writesCount()).toEqual(before);
    expect(h.repos.routeState.get()).toMatchObject({ phase: 'active_verified', entryMode: 'ACTIVE', activeProxyRevision: 1, selectedNode: nodeV1 });
    expect(safariOutcome(h).leafPolicyName).toBe(nodeV1);
  });

  test('a publish switch waiting in VERIFY_ONLY is not committed when a correction is saved but fails to deploy: it rolls back per step 14', async () => {
    h = await createHarness();
    const { envId } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const nodeV1 = h.repos.proxyRevisions.get(envId, 1)!.nodeName;
    let env = h.repos.environments.get(envId)!;
    const u1 = await h.app.updateEnvironment(envId, { request_id: rid(), expected_revision: env.revision, changes: { proxy: { host: '203.0.113.99' } } }, WEB);
    await h.idle();
    await h.native(PROFILE_A, { type: 'beginSafariVerification', operation_id: u1.operation_id, amazon_tabs_open: false });
    await h.idle();
    expect(h.repos.operations.get(u1.operation_id)!.phase).toBe('VERIFY_ONLY');
    h.fake.failNext('listPolicies');
    env = h.repos.environments.get(envId)!;
    const u2 = await h.app.updateEnvironment(envId, { request_id: rid(), expected_revision: env.revision, changes: { proxy: { host: '203.0.113.30' } } }, WEB);
    await h.idle();
    expect(h.repos.operations.get(u2.operation_id)!.phase).toBe('FAILED');
    expect(h.repos.environments.get(envId)!).toMatchObject({ desiredProxyRevision: 3, deployedProxyRevision: 2 });
    // 旧准备页的实测通过：不提交被替换的版本
    await verify(h, PROFILE_A, u1.operation_id);
    const op = h.repos.operations.get(u1.operation_id)!;
    expect(op).toMatchObject({ phase: 'FAILED', status: 'failed' });
    expect(op.error?.code).toBe('NODE_NOT_DEPLOYED');
    expect(op.error?.message).toContain('已保存 v003，尚未部署');
    expect(h.repos.routeState.get()).toMatchObject({ phase: 'failed', entryMode: 'BLOCKED', activeProxyRevision: 1, selectedNode: nodeV1 });
    expect(h.repos.environments.get(envId)!.lastVerifiedProxyRevision).toBe(1);
    expect(safariOutcome(h).failed).toBe(true);
  });

  describe.each(['ruleset_resource', 'temp_rule'] as const)('[%s] a correction saved while a passing result is being checked (after the version check of step 13)', (entryStrategy) => {
    /** 核对通过之后：重读事实时（getTakeoverState），或已记下写入 ACTIVE 之后的第一次 Surge 调用时，用户保存更正 v003。 */
    async function run(when: 'facts' | 'active_write') {
      let armed = false;
      let save: (() => Promise<void>) | null = null;
      let opId = '';
      const writeStarted = () => (payloadOf(h.repos.operations.get(opId)!).route as { activeWriteStarted?: boolean }).activeWriteStarted === true;
      h = await createHarness({
        entryStrategy,
        surge: (fake) =>
          new Proxy(fake, {
            get(target, prop) {
              const v = Reflect.get(target, prop, target) as unknown;
              if (typeof v !== 'function') return v;
              const fn = (v as (...a: unknown[]) => unknown).bind(target);
              return (...args: unknown[]) => {
                const due = armed && save !== null && (when === 'facts' ? prop === 'getTakeoverState' : writeStarted());
                if (!due) return fn(...args);
                const s = save!;
                save = null;
                return (async () => {
                  await s();
                  return fn(...args);
                })();
              };
            },
          }) as unknown as SurgeAdapter,
      });
      const { envId } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
      const nodeV1 = h.repos.proxyRevisions.get(envId, 1)!.nodeName;
      let env = h.repos.environments.get(envId)!;
      const u1 = await h.app.updateEnvironment(envId, { request_id: rid(), expected_revision: env.revision, changes: { proxy: { host: '203.0.113.99' } } }, WEB);
      opId = u1.operation_id;
      await h.idle();
      await h.native(PROFILE_A, { type: 'beginSafariVerification', operation_id: u1.operation_id, amazon_tabs_open: false });
      await h.idle();
      expect(h.repos.operations.get(u1.operation_id)!.phase).toBe('VERIFY_ONLY');
      let u2 = '';
      save = async () => {
        env = h.repos.environments.get(envId)!;
        u2 = (await h.app.updateEnvironment(envId, { request_id: rid(), expected_revision: env.revision, changes: { proxy: { host: '203.0.113.30' } } }, WEB)).operation_id;
      };
      armed = true;
      expect((await verify(h, PROFILE_A, u1.operation_id)).ok).toBe(true);
      await h.idle();
      armed = false;
      expect(u2).not.toBe('');
      return { envId, nodeV1, u1: u1.operation_id, u2 };
    }

    test.each(['facts', 'active_write'] as const)('saved during %s: the replaced revision is never committed; the switch rolls back per step 14 and the correction waits for the next arrival', async (when) => {
      const { envId, nodeV1, u1, u2 } = await run(when);
      expect(h.repos.environments.get(envId)!).toMatchObject({ desiredProxyRevision: 3, lastVerifiedProxyRevision: 1 });
      const op = h.repos.operations.get(u1)!;
      expect(op).toMatchObject({ phase: 'FAILED', status: 'failed' });
      expect(op.error?.code).toBe('NODE_NOT_DEPLOYED');
      expect(op.error?.message).toContain('代理版本 v002 已被之后的修改替换');
      expect(op.error?.message).toContain(when === 'facts' ? '未进入使用中模式' : '入口已写入使用中模式、未提交');
      expect(h.repos.routeState.get()).toMatchObject({ phase: 'failed', entryMode: 'BLOCKED', activeProxyRevision: 1, selectedNode: nodeV1 });
      expect(h.repos.probes.latest(envId, 'safari')!.proxyRevision).toBe(1);
      expect(h.repos.operations.get(u2)!.phase).toBe('WAITING_ROUTE');
      expect(safariOutcome(h).failed).toBe(true);
    });
  });

  test.each(['ruleset_resource', 'temp_rule'] as const)(
    '[%s] a correction saved during the switch\'s step 1–3 reads stops the switch before its first Surge write',
    async (entryStrategy) => {
      let save: (() => Promise<void>) | null = null;
      h = await createHarness({ entryStrategy, surge: (fake) => beforeCall(fake, 'getGroupMembers', () => { const s = save; save = null; return s; }) });
      const { envId } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
      const nodeV1 = h.repos.proxyRevisions.get(envId, 1)!.nodeName;
      let env = h.repos.environments.get(envId)!;
      const u1 = await h.app.updateEnvironment(envId, { request_id: rid(), expected_revision: env.revision, changes: { proxy: { host: '203.0.113.99' } } }, WEB);
      await h.idle();
      expect(h.repos.operations.get(u1.operation_id)!.phase).toBe('WAITING_ROUTE');
      let u2 = '';
      // 第 2 步读取 SFE-ROUTE 成员时用户保存了更正（更正的发布随后失败）
      save = async () => {
        expect(h.repos.operations.get(u1.operation_id)!.status).toBe('running');
        h.fake.failNext('listPolicies');
        env = h.repos.environments.get(envId)!;
        u2 = (await h.app.updateEnvironment(envId, { request_id: rid(), expected_revision: env.revision, changes: { proxy: { host: '203.0.113.30' } } }, WEB)).operation_id;
      };
      const routeWrites = () => ({ ...writesCount(), update: 0, addTemp: h.fake.calls.addTempRule ?? 0, removeTemp: h.fake.calls.removeTempRule ?? 0 });
      const before = routeWrites();
      const entryBefore = entryWrites(h.fake);
      await h.native(PROFILE_A, { type: 'beginSafariVerification', operation_id: u1.operation_id, amazon_tabs_open: false });
      await h.idle();
      expect(u2).not.toBe('');
      const op = h.repos.operations.get(u1.operation_id)!;
      expect(op).toMatchObject({ phase: 'READY_FOR_NEXT_OPEN', status: 'succeeded', error: null });
      expect(h.repos.operations.listSteps(u1.operation_id).at(-1)!.message).toContain('已被之后的修改替换');
      // 没有阻断、没有结束连接、没有改选节点（入口规则集文件与临时规则都没有写入）
      expect(routeWrites()).toEqual(before);
      expect(entryWrites(h.fake)).toEqual(entryBefore);
      expect(h.repos.routeState.get()).toMatchObject({ phase: 'active_verified', entryMode: 'ACTIVE', activeProxyRevision: 1, selectedNode: nodeV1 });
      expect(safariOutcome(h).leafPolicyName).toBe(nodeV1);
    },
  );

  test('a revision replaced while its publish was still deploying never enters WAITING_ROUTE', async () => {
    let save: (() => Promise<void>) | null = null;
    h = await createHarness({ surge: (fake) => beforeCall(fake, 'getGroupMembers', () => { const s = save; save = null; return s; }) });
    const { envId } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const nodeV1 = h.repos.proxyRevisions.get(envId, 1)!.nodeName;
    let env = h.repos.environments.get(envId)!;
    let u2 = '';
    save = async () => {
      h.fake.failNext('listPolicies');
      env = h.repos.environments.get(envId)!;
      u2 = (await h.app.updateEnvironment(envId, { request_id: rid(), expected_revision: env.revision, changes: { proxy: { host: '203.0.113.30' } } }, WEB)).operation_id;
    };
    // v2 的发布读取组成员时（已越过第 0 步的期望版本核对）用户保存了更正；更正的发布随后失败
    const u1 = await h.app.updateEnvironment(envId, { request_id: rid(), expected_revision: env.revision, changes: { proxy: { host: '203.0.113.99' } } }, WEB);
    await h.idle();
    expect(u2).not.toBe('');
    expect(h.repos.environments.get(envId)!).toMatchObject({ desiredProxyRevision: 3, deployedProxyRevision: 2 });
    expect(h.repos.operations.get(u2)!.phase).toBe('FAILED');
    const op = h.repos.operations.get(u1.operation_id)!;
    expect(op).toMatchObject({ phase: 'READY_FOR_NEXT_OPEN', status: 'succeeded', error: null });
    expect(h.repos.operations.listSteps(u1.operation_id).at(-1)!.message).toContain('发布期间又修改了代理（已保存 v003）');
    expect(h.repos.outbox.pendingForOperation(u1.operation_id)).toEqual([]);
    type Pending = { data: { pendingVerification: { operation_id: string } | null } };
    expect(((await h.native(PROFILE_A, { type: 'getCurrentState' })) as Pending).data.pendingVerification).toBeNull();
    expect(h.repos.routeState.get()).toMatchObject({ phase: 'active_verified', entryMode: 'ACTIVE', activeProxyRevision: 1, selectedNode: nodeV1 });
  });

  test('replacing the front proxy ends the replaced WAITING_ROUTE in the same transaction', async () => {
    h = await createHarness();
    const { envId } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    let env = h.repos.environments.get(envId)!;
    const u1 = await h.app.updateEnvironment(envId, { request_id: rid(), expected_revision: env.revision, changes: { proxy: { host: '203.0.113.99' } } }, WEB);
    await h.idle();
    expect(h.repos.operations.get(u1.operation_id)!.phase).toBe('WAITING_ROUTE');
    const front = await h.app.registerFrontProxy({ request_id: rid(), surgeName: 'Front-B' }, WEB);
    const preview = await h.app.replaceFrontPreview(h.frontId, { to_front_id: front.id, environment_ids: [envId] }, WEB);
    env = h.repos.environments.get(envId)!;
    h.revoke(['connection_continuity']);
    const acc = await h.app.replaceFrontCommit(
      h.frontId,
      { request_id: rid(), to_front_id: front.id, environment_ids: [envId], preview_digest: preview.preview_digest, expected_revisions: { [envId]: env.revision } },
      WEB,
    );
    expect(h.repos.operations.get(u1.operation_id)!).toMatchObject({ phase: 'READY_FOR_NEXT_OPEN', status: 'succeeded', supersededBy: acc.operation_id, error: null });
    await h.idle();
    expect(h.repos.environments.get(envId)!).toMatchObject({ desiredProxyRevision: 3, deployedProxyRevision: 2 });
    expect(h.repos.routeState.get().activeProxyRevision).toBe(1);
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

  for (const variant of ['edited while the other switch waits in VERIFY_ONLY', 'edited just before the other switch was accepted'] as const) {
    for (const entryStrategy of ['ruleset_resource', 'temp_rule'] as const) {
      test(`[${entryStrategy}] ${variant}: when another environment's switch commits, the in-use environment's WAITING_ROUTE ends as READY_FOR_NEXT_OPEN (no false "switching", no NEEDS_CONFIRMATION failure)`, async () => {
        h = await createHarness({ entryStrategy });
        const { a: X, b: Y } = await twoEnvs();
        const edit = async () => {
          const env = h.repos.environments.get(X)!;
          return (await h.app.updateEnvironment(X, { request_id: rid(), expected_revision: env.revision, changes: { proxy: { host: '203.0.113.20' } } }, WEB)).operation_id;
        };
        let yOp: string;
        let xPub: string;
        if (variant === 'edited while the other switch waits in VERIFY_ONLY') {
          yOp = await startSwitch(Y);
          xPub = await edit();
          await h.idle();
        } else {
          xPub = await edit();
          yOp = (await h.app.activate(Y, { request_id: rid('act'), old_session_policy: 'closed_confirmed', confirmed_environment_id: X }, WEB)).operation_id;
          await h.idle();
        }
        expect(h.repos.operations.get(yOp)!.phase).toBe('VERIFY_ONLY');
        // Y 仍在切换（使用中的环境仍是 X）：X 的发布进入 WAITING_ROUTE
        expect(h.repos.operations.get(xPub)!.phase).toBe('WAITING_ROUTE');
        // 此时 X 的场景到达：另一个切换正在进行，不说正在切换到新版本，也不排入到达
        type Begin = { data: { status: string; message: string; switching?: boolean } };
        const early = ((await h.native(PROFILE_A, { type: 'beginSafariVerification', operation_id: xPub, amazon_tabs_open: false })) as Begin).data;
        expect(early).toEqual({ status: 'pending', phase: 'WAITING_ROUTE', message: expect.stringContaining('另一个切换或检测正在进行'), switching: false });
        expect(JSON.stringify(early)).not.toContain('正在切换到新版本');
        expect(h.repos.outbox.pendingForOperation(xPub).some((r) => r.resumeReason === 'profile_arrived')).toBe(false);
        await verify(h, PROFILE_B, yOp);
        expect(h.repos.operations.get(yOp)!.phase).toBe('ACTIVE_VERIFIED');
        const selY = await h.fake.getGroupSelection(ROUTE_GROUP_NAME);
        // Y 的提交在同一事务中结束 X 的等待：新版本已部署、未切换
        const pub = h.repos.operations.get(xPub)!;
        expect(pub).toMatchObject({ phase: 'READY_FOR_NEXT_OPEN', status: 'succeeded', supersededBy: yOp, error: null });
        expect(h.repos.operations.listSteps(xPub).at(-1)!.message).toContain('另一个环境已切换并通过 Safari 实测');
        expect(h.repos.outbox.pendingForOperation(xPub)).toEqual([]);
        expect(h.events.some((e) => e.type === 'operation.updated' && (e as { operation?: { id?: string } }).operation?.id === xPub && (e as { operation?: { phase?: string } }).operation?.phase === 'READY_FOR_NEXT_OPEN')).toBe(true);
        // X 的弹窗不再提示继续切换；准备页再到达得到「等待已结束」，执行器不切换、不失败
        type State = { data: { relation: string; pendingVerification: unknown } };
        const st = (await h.native(PROFILE_A, { type: 'getCurrentState' })) as State;
        expect(st.data.relation).toBe('other_active');
        expect(st.data.pendingVerification).toBeNull();
        const late = ((await h.native(PROFILE_A, { type: 'beginSafariVerification', operation_id: xPub, amazon_tabs_open: false })) as Begin).data;
        expect(late).toMatchObject({ status: 'not_needed', message: '等待已结束：新版本已部署，请重新使用此环境以切换' });
        await h.idle();
        expect(h.repos.operations.get(xPub)!).toMatchObject({ phase: 'READY_FOR_NEXT_OPEN', status: 'succeeded' });
        expect(h.repos.routeState.get()).toMatchObject({ activeEnvironmentId: Y, phase: 'active_verified', entryMode: 'ACTIVE' });
        expect(await h.fake.getGroupSelection(ROUTE_GROUP_NAME)).toBe(selY);
        // 到达截止时间过后也没有任何变化
        await h.clock.advanceAsync((h.repos.settings.get('profileArrivalTimeoutSec') + 5) * 1000);
        await h.idle();
        expect(h.repos.operations.get(xPub)!.phase).toBe('READY_FOR_NEXT_OPEN');
        expect(h.repos.routeState.get()).toMatchObject({ activeEnvironmentId: Y, phase: 'active_verified' });
      });
    }
  }

  test('…but when the other switch is cancelled the in-use environment stays in use: its WAITING_ROUTE survives and a later arrival switches to the new revision', async () => {
    h = await createHarness();
    const { a: X, b: Y } = await twoEnvs();
    const yOp = await startSwitch(Y);
    const env = h.repos.environments.get(X)!;
    const xPub = (await h.app.updateEnvironment(X, { request_id: rid(), expected_revision: env.revision, changes: { proxy: { host: '203.0.113.20' } } }, WEB)).operation_id;
    await h.idle();
    expect(h.repos.operations.get(xPub)!.phase).toBe('WAITING_ROUTE');
    await h.app.cancelOperation(yOp, { request_id: rid() }, WEB);
    await h.idle();
    expect(h.repos.operations.get(yOp)!.phase).toBe('FAILED');
    expect(h.repos.routeState.get().activeEnvironmentId).toBe(X);
    expect(h.repos.operations.get(xPub)!.phase).toBe('WAITING_ROUTE');
    const begin = await h.native(PROFILE_A, { type: 'beginSafariVerification', operation_id: xPub, amazon_tabs_open: false });
    expect((begin as { data: unknown }).data).toMatchObject({ status: 'pending', message: '已到达，正在切换到新版本', switching: true });
    await h.idle();
    expect(h.repos.operations.get(xPub)!.phase).toBe('VERIFY_ONLY');
    await verify(h, PROFILE_A, xPub);
    expect(h.repos.operations.get(xPub)!.phase).toBe('ACTIVE_VERIFIED');
    expect(h.repos.routeState.get()).toMatchObject({ activeEnvironmentId: X, activeProxyRevision: 2, phase: 'active_verified' });
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
  const uninitializedProfile = '[Proxy]\nFront-A = socks5, 192.0.2.10, 1080\n[Proxy Group]\nDaily = select, Front-A, DIRECT\n[Rule]\nFINAL,DIRECT\n';

  test('uninitialized draft deletion needs no route group or network writes and supersedes only its parked publish', async () => {
    h = await createHarness({ sourceProfile: uninitializedProfile, capabilities: [] });
    const a = await createEnv(h, 'Draft-A', '203.0.113.10');
    const b = await createEnv(h, 'Draft-B', '203.0.113.11');
    expect(h.repos.operations.get(a.operation_id)!.status).toBe('parked');
    // Real CLI throws for an absent group; the fake normally returns null.
    h.fake.failNext('getGroupSelection', new SfeError('SURGE_COMMAND_FAILED', 'Policy group does not exist.'));
    const before = { ...h.fake.calls };
    const env = h.repos.environments.get(a.environment_id!)!;
    const d = await h.app.deleteEnvironment(env.id, { request_id: rid(), expected_revision: env.revision }, ADMIN);
    await h.idle();
    expect(h.repos.operations.get(d.operation_id)!.status).toBe('succeeded');
    expect(h.repos.environments.get(env.id)!.deletedAt).not.toBeNull();
    expect(h.repos.proxyRevisions.listByEnvironment(env.id).every((r) => r.state === 'retired')).toBe(true);
    expect(h.repos.operations.get(a.operation_id)).toMatchObject({ status: 'superseded', supersededBy: d.operation_id, error: null });
    expect(h.repos.operations.get(b.operation_id)!.status).toBe('parked');
    for (const name of ['getGroupSelection', 'selectGroupPolicy', 'updateExternalResource', 'reloadProfile', 'killRequest', 'addTempRule', 'removeTempRule']) {
      expect(h.fake.calls[name] ?? 0).toBe(before[name] ?? 0);
    }
  });

  test('an uninitialized draft whose proxy was edited (v1 superseded, v2 desired) is still deleted without querying the absent route group; secrets orphaned, parked create and update ops superseded', async () => {
    h = await createHarness({ sourceProfile: uninitializedProfile, capabilities: [] });
    const a = await createEnv(h, 'Draft-A', '203.0.113.10', { username: 'synth-user', password: 'synth-proxy-pw', login: 'buyer01@example.test', accountPassword: 'synth-account-pw' });
    const envId = a.environment_id!;
    const env0 = h.repos.environments.get(envId)!;
    const u = await h.app.updateEnvironment(envId, { request_id: rid(), expected_revision: env0.revision, changes: { proxy: { host: '203.0.113.20' } } }, WEB);
    await h.idle();
    expect(h.repos.proxyRevisions.listByEnvironment(envId).map((r) => [r.revision, r.state])).toEqual([
      [1, 'superseded'],
      [2, 'desired'],
    ]);
    expect(h.repos.operations.get(u.operation_id)!.status).toBe('parked');
    const accountRef = h.repos.accounts.get(envId)!.passwordRef!;
    const proxyRefs = h.repos.proxyRevisions.listByEnvironment(envId).flatMap((r) => [r.usernameRef, r.passwordRef]).filter((x): x is string => !!x);
    expect(proxyRefs.length).toBeGreaterThan(0);
    // 真实 CLI 对不存在的组报错
    h.fake.failNext('getGroupSelection', new SfeError('SURGE_COMMAND_FAILED', 'Policy group does not exist.'));
    const before = h.fake.calls.getGroupSelection ?? 0;
    const env = h.repos.environments.get(envId)!;
    const d = await h.app.deleteEnvironment(envId, { request_id: rid(), expected_revision: env.revision }, ADMIN);
    await h.idle();
    expect(h.repos.operations.get(d.operation_id)!.status).toBe('succeeded');
    expect(h.fake.calls.getGroupSelection ?? 0).toBe(before);
    expect(h.repos.environments.get(envId)!.deletedAt).not.toBeNull();
    expect(h.repos.proxyRevisions.listByEnvironment(envId).every((r) => r.state === 'retired')).toBe(true);
    expect(h.repos.accounts.get(envId)).toBeNull();
    for (const ref of [accountRef, ...proxyRefs]) expect(h.repos.secretRefs.get(ref)!.state).toBe('orphaned');
    expect(h.repos.operations.get(a.operation_id)).toMatchObject({ status: 'superseded', supersededBy: d.operation_id });
    expect(h.repos.operations.get(u.operation_id)).toMatchObject({ status: 'superseded', supersededBy: d.operation_id });
  });

  test('draft deletion fails closed if runtime policy inventory cannot be read', async () => {
    h = await createHarness({ sourceProfile: uninitializedProfile, capabilities: [] });
    const a = await createEnv(h, 'Draft', '203.0.113.10');
    h.fake.failNext('listPolicies');
    const env = h.repos.environments.get(a.environment_id!)!;
    const d = await h.app.deleteEnvironment(env.id, { request_id: rid(), expected_revision: env.revision }, ADMIN);
    await h.idle();
    expect(h.repos.operations.get(d.operation_id)!.status).toBe('failed');
    expect(h.repos.environments.get(env.id)!.deletedAt).toBeNull();
    expect(h.repos.operations.get(a.operation_id)!.status).toBe('parked');
  });

  test('existing route group query errors are not treated as an absent group', async () => {
    h = await createHarness({ sourceProfile: uninitializedProfile + '[Proxy Group]\nSFE-ROUTE = select, REJECT\n', capabilities: [] });
    const a = await createEnv(h, 'Draft', '203.0.113.10');
    h.fake.failNext('getGroupSelection');
    const env = h.repos.environments.get(a.environment_id!)!;
    const d = await h.app.deleteEnvironment(env.id, { request_id: rid(), expected_revision: env.revision }, ADMIN);
    await h.idle();
    expect(h.repos.operations.get(d.operation_id)!.status).toBe('failed');
    expect(h.repos.environments.get(env.id)!.deletedAt).toBeNull();
  });

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
