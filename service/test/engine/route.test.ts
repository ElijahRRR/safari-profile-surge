import { afterEach, describe, expect, test } from 'vitest';
import { SfeError, type ActivateRequest, type RollbackResult } from '@sfe/contract';
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
  test('queued route operation → ROUTE_BUSY for new activation, normal mode and probe', async () => {
    h = await createHarness();
    const { a, b } = await twoEnvs();
    await h.app.executor.stop();
    await h.app.activate(b, { request_id: rid(), old_session_policy: 'closed_confirmed', confirmed_environment_id: a }, WEB);
    await expectError(h.app.activate(a, { request_id: rid() }, WEB), 'ROUTE_BUSY');
    await expectError(h.app.enterNormal({ request_id: rid(), old_session_policy: 'closed_confirmed', confirmed_environment_id: a }, WEB), 'ROUTE_BUSY');
    await expectError(h.app.probe(a, { request_id: rid(), kind: 'safari' }, WEB), 'ROUTE_BUSY');
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
    const state = await h.native(PROFILE_A, { type: 'getCurrentState' });
    expect((state as { data: { pendingVerification: { kind: string } } }).data.pendingVerification.kind).toBe('apply_new_revision');
    const first = await h.native(PROFILE_A, { type: 'beginSafariVerification', operation_id: opId, amazon_tabs_open: false });
    expect((first as { data: { status: string } }).data.status).toBe('pending');
    await h.idle();
    op = h.repos.operations.get(opId)!;
    expect(op.phase).toBe('VERIFY_ONLY');
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
