import { afterEach, describe, expect, test } from 'vitest';
import { NATIVE_PERMISSIONS, type NativeRequest, type NativeRequestType } from '@sfe/contract';
import { ALL_CAPS, PROFILE_A, PROFILE_B, PROFILE_C, WEB, activeEnv, bind, createEnv, createHarness, envInput, rid, verify, type Harness } from './harness.js';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

const errCode = (r: { ok: boolean; error?: { code: string } }) => (r.ok ? 'OK' : r.error!.code);

function sample(type: NativeRequestType, envId: string): NativeRequest {
  const now = '2026-10-21T00:00:00.000Z';
  switch (type) {
    case 'getCurrentState':
      return { type };
    case 'reportProfileState':
      return { type, windows_open: 1, amazon_tabs_open: false, site_permission_granted: true };
    case 'bindCurrentProfile':
      return { type, request_id: rid(), environment_id: envId, expected_revision: 99 };
    case 'createAndBindEnvironment':
      return { type, request_id: rid(), environment: envInput('X', '203.0.113.99') };
    case 'updateCurrentEnvironment':
      return { type, request_id: rid(), environment_id: envId, expected_revision: 99, changes: { displayName: 'Y' } };
    case 'activateCurrentEnvironment':
      return { type, request_id: rid(), environment_id: envId, amazon_tabs_open: false };
    case 'enterNormalMode':
      return { type, request_id: rid() };
    case 'probeCurrentEnvironment':
      return { type, request_id: rid(), environment_id: envId, kind: 'safari' };
    case 'acknowledgeAccountChange':
      return { type, request_id: rid(), environment_id: envId, expected_revision: 99 };
    case 'getOperation':
      return { type, operation_id: 'op_missing' };
    case 'cancelOperation':
      return { type, request_id: rid(), operation_id: 'op_missing' };
    case 'acknowledgeWindowsClosed':
      return { type, request_id: rid() };
    case 'beginSafariVerification':
      return { type, operation_id: 'op_missing', amazon_tabs_open: false };
    case 'submitSafariVerification':
      return { type, operation_id: 'op_missing', test_id: 'x', route_epoch: 0, observed_ip: null, http_status: null, error: null, started_at: now, finished_at: now };
    case 'requestLoginFill':
      return { type, top_url: 'https://www.amazon.com/ap/signin', frame_is_top: true, form_action: 'https://www.amazon.com/ap/signin', fields: ['identifier'], route_epoch: 0 };
  }
}

describe('NATIVE_PERMISSIONS matrix', () => {
  test.each(Object.keys(NATIVE_PERMISSIONS) as NativeRequestType[])('%s is enforced per profile state', async (type) => {
    h = await createHarness();
    const env = (await createEnv(h, 'US-Buyer-A', '203.0.113.10')).environment_id!;
    await bind(h, PROFILE_B, env);
    const allowed = NATIVE_PERMISSIONS[type];
    const unidentified = await h.native(null, sample(type, env));
    if (allowed.includes('unidentified')) expect(errCode(unidentified)).toBe('OK');
    else expect(errCode(unidentified)).toBe('PROFILE_UNBOUND');
    const unbound = await h.native(PROFILE_C, sample(type, env));
    if (!allowed.includes('unbound')) expect(['PROFILE_UNBOUND']).toContain(errCode(unbound));
    else expect(errCode(unbound)).not.toBe('PROFILE_UNBOUND');
    const bound = await h.native(PROFILE_B, sample(type, env));
    if (!allowed.includes('bound')) expect(errCode(bound)).toBe('PROFILE_ALREADY_BOUND');
    else expect(['PROFILE_UNBOUND', 'PROFILE_ALREADY_BOUND']).not.toContain(errCode(bound));
  });
});

describe('binding', () => {
  test('environment_id must match the binding — checked before revisions and before creating operations', async () => {
    h = await createHarness();
    const a = (await createEnv(h, 'US-Buyer-A', '203.0.113.10')).environment_id!;
    const b = (await createEnv(h, 'US-Buyer-B', '203.0.113.11')).environment_id!;
    await bind(h, PROFILE_A, a);
    const ops = h.repos.operations.listRecent(500).length;
    for (const msg of [
      { type: 'updateCurrentEnvironment' as const, request_id: rid(), environment_id: b, expected_revision: 999, changes: { displayName: 'X' } },
      { type: 'activateCurrentEnvironment' as const, request_id: rid(), environment_id: b, amazon_tabs_open: false },
      { type: 'probeCurrentEnvironment' as const, request_id: rid(), environment_id: b, kind: 'preflight' as const },
      { type: 'acknowledgeAccountChange' as const, request_id: rid(), environment_id: b, expected_revision: 999 },
    ]) {
      const r = await h.native(PROFILE_A, msg);
      expect(errCode(r)).toBe('BINDING_MISMATCH');
    }
    expect(h.repos.operations.listRecent(500).length).toBe(ops);
  });

  test('bind requires native_bridge_ipc; unverified native_profile_id → bound_unverified_id', async () => {
    h = await createHarness();
    const a = (await createEnv(h, 'US-Buyer-A', '203.0.113.10')).environment_id!;
    h.revoke(['native_bridge_ipc']);
    const env = h.repos.environments.get(a)!;
    const denied = await h.native(PROFILE_A, { type: 'bindCurrentProfile', request_id: rid(), environment_id: a, expected_revision: env.revision });
    expect(errCode(denied)).toBe('CAPABILITY_UNVERIFIED');
    h.grant(['native_bridge_ipc']);
    h.revoke(['native_profile_id']);
    const ok = await h.native(PROFILE_A, { type: 'bindCurrentProfile', request_id: rid(), environment_id: a, expected_revision: env.revision });
    expect(errCode(ok)).toBe('OK');
    expect(h.repos.profileBindings.byProfile(PROFILE_A)!.state).toBe('bound_unverified_id');
    expect((await h.app.getEnvironment(a, WEB)).binding.state).toBe('bound_unverified_id');
  });

  test('cannot bind an environment that is already bound', async () => {
    h = await createHarness();
    const a = (await createEnv(h, 'US-Buyer-A', '203.0.113.10')).environment_id!;
    await bind(h, PROFILE_A, a);
    const env = h.repos.environments.get(a)!;
    const r = await h.native(PROFILE_B, { type: 'bindCurrentProfile', request_id: rid(), environment_id: a, expected_revision: env.revision });
    expect(errCode(r)).toBe('ENVIRONMENT_ALREADY_BOUND');
  });

  test('createAndBind creates, binds and publishes in one request', async () => {
    h = await createHarness();
    const r = await h.native(PROFILE_C, { type: 'createAndBindEnvironment', request_id: rid(), environment: envInput('US-Buyer-C', '203.0.113.30') });
    expect(errCode(r)).toBe('OK');
    await h.idle();
    const envId = (r as { data: { environment_id: string } }).data.environment_id;
    expect(h.repos.profileBindings.byProfile(PROFILE_C)!.environmentId).toBe(envId);
    expect(h.repos.environments.get(envId)!.deployedProxyRevision).toBe(1);
  });
});

describe('getCurrentState', () => {
  test('unidentified profile sees no environment names', async () => {
    h = await createHarness();
    await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const r = await h.native(null, { type: 'getCurrentState' });
    const d = (r as { data: Record<string, unknown> }).data;
    expect(d).toMatchObject({ profile: { identified: false }, environment: null, route: null, relation: 'other_active', otherActiveLabel: null, bindable: [] });
    expect(JSON.stringify(d)).not.toContain('US-Buyer-A');
  });

  test('unbound identified profile gets bindable environments and the other active label', async () => {
    h = await createHarness();
    await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    await createEnv(h, 'US-Buyer-B', '203.0.113.11');
    const d = ((await h.native(PROFILE_C, { type: 'getCurrentState' })) as { data: { bindable: Array<{ label: string }>; otherActiveLabel: string; route: unknown } }).data;
    expect(d.bindable.map((b) => b.label)).toEqual(['US-Buyer-B · E0002']);
    expect(d.otherActiveLabel).toBe('US-Buyer-A · E0001');
    expect(d.route).toBeNull();
  });

  test('non-active bound profile gets only the route summary; active profile gets the full route and orders', async () => {
    h = await createHarness();
    await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const b = (await createEnv(h, 'US-Buyer-B', '203.0.113.11')).environment_id!;
    await bind(h, PROFILE_B, b);
    const other = ((await h.native(PROFILE_B, { type: 'getCurrentState' })) as { data: Record<string, unknown> }).data;
    expect(other.route).toBeNull();
    expect(other.routeSummary).toEqual({ routeEpoch: 1, entryMode: 'ACTIVE', phase: 'active_verified', buyerExitConnectionsUnconfirmed: false, entryUnconfirmed: false, normalModeOffered: true, reconciled: true });
    expect(other.relation).toBe('other_active');
    expect(other.ordersAllowed).toBe(false);
    expect(other.activationAvailable).toBe(true);
    const mine = ((await h.native(PROFILE_A, { type: 'getCurrentState' })) as { data: Record<string, unknown> }).data;
    expect(mine.relation).toBe('this_active');
    expect(mine.route).not.toBeNull();
    expect(mine.ordersAllowed).toBe(true);
  });

  test('after a normal mode that could not confirm ending Safari connections, every identified profile learns it from the route summary and can enter normal mode again', async () => {
    h = await createHarness();
    const { envId } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const live = h.fake.simulateRequest({ processPath: '/Applications/Safari.app/Contents/MacOS/Safari', host: 'www.example.test', protocol: 'tcp', longLived: true });
    expect(live.policyName).toBe('SFE-ROUTE');
    h.fake.failNext('killRequest');
    const n = await h.native(PROFILE_A, { type: 'enterNormalMode', request_id: rid(), old_session_policy: 'closed_confirmed', confirmed_environment_id: envId });
    expect(n.ok).toBe(true);
    await h.idle();
    expect(h.repos.routeState.get()).toMatchObject({ entryMode: 'NORMAL', phase: 'idle', activeEnvironmentId: null, warnings: ['buyer_exit_connections_unconfirmed'] });
    for (const profile of [PROFILE_A, PROFILE_C]) {
      const d = ((await h.native(profile, { type: 'getCurrentState' })) as { data: Record<string, unknown> }).data;
      expect(d.relation).toBe('none_active');
      expect(d.route).toBeNull();
      expect(d.routeSummary).toEqual({ routeEpoch: expect.any(Number), entryMode: 'NORMAL', phase: 'idle', buyerExitConnectionsUnconfirmed: true, entryUnconfirmed: false, normalModeOffered: true, reconciled: true });
    }
    const again = await h.native(PROFILE_C, { type: 'enterNormalMode', request_id: rid() });
    expect(again.ok).toBe(true);
    await h.idle();
    expect((await h.fake.listActiveRequests()).some((r) => r.id === live.id)).toBe(false);
    const d = ((await h.native(PROFILE_A, { type: 'getCurrentState' })) as { data: { routeSummary: { buyerExitConnectionsUnconfirmed: boolean; normalModeOffered: boolean } } }).data;
    expect(d.routeSummary.buyerExitConnectionsUnconfirmed).toBe(false);
    // 已确认结束、入口经运行时确认：持久标记清除，不再提供普通模式
    expect(d.routeSummary.normalModeOffered).toBe(false);
  });

  test('the route summary in a response comes from the same read as the full route, after the action precheck has reconciled (Surge restarted while the route was in use)', async () => {
    h = await createHarness({ entryStrategy: 'temp_rule' });
    await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    expect(h.repos.routeState.get()).toMatchObject({ entryMode: 'ACTIVE', phase: 'active_verified' });
    // Surge 重启：临时规则被丢弃，Safari 已按原规则发出；服务在动作前检查的有效期（5 秒，提交 ACTIVE 之后的对账也算）内没有再对账
    h.fake.restart();
    h.clock.advance(6_000);
    const d = ((await h.native(PROFILE_A, { type: 'getCurrentState' })) as {
      data: { relation: string; ordersAllowed: boolean; route: { entryMode: string; phase: string; normalModeOffered: boolean } | null; routeSummary: { entryMode: string; phase: string; normalModeOffered: boolean } };
    }).data;
    const route = h.repos.routeState.get();
    // 动作前检查已对账（路由不再是使用中且已验证）；摘要（弹窗顶栏按它显示）与完整路由一致，都不再是 ACTIVE/active_verified
    expect(route.phase).toBe('attention');
    expect(d.relation).toBe('this_active');
    expect(d.ordersAllowed).toBe(false);
    expect(d.route).not.toBeNull();
    expect({ entryMode: d.routeSummary.entryMode, phase: d.routeSummary.phase }).toEqual({ entryMode: d.route!.entryMode, phase: d.route!.phase });
    expect(d.routeSummary).toMatchObject({ entryMode: route.entryMode, phase: route.phase, normalModeOffered: true });
  });

  type StateData = {
    relation: string;
    ordersAllowed: boolean;
    ordersBlockedReason: string | null;
    route: { entryMode: string; phase: string; warnings: string[] } | null;
    routeSummary: { entryMode: string; phase: string; reconciled: boolean };
  };
  const stateOf = async (profile: string | null) => ((await h.native(profile, { type: 'getCurrentState' })) as { ok: true; data: StateData }).data;

  test('orders are judged on the route read for the same response: a reconcile outside the action precheck that marks the route attention blocks orders at once, inside the precheck window', async () => {
    h = await createHarness({ entryStrategy: 'temp_rule' });
    await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    h.clock.advance(6_000);
    // 弹窗轮询：动作前检查已对账，允许打开订单页
    expect((await stateOf(PROFILE_A)).ordersAllowed).toBe(true);
    // 2 秒后 Surge 重启（临时规则丢弃，Safari 按原规则发出），周期对账（不是动作前检查）先发现
    h.clock.advance(2_000);
    h.fake.restart();
    await h.app.runPeriodicReconcile();
    expect(h.repos.routeState.get()).toMatchObject({ phase: 'attention', entryMode: 'UNKNOWN' });
    // 1 秒后的下一次轮询仍在上一次检查的有效期内：不能沿用之前的判定，按这次读到的路由拒绝
    h.clock.advance(1_000);
    const d = await stateOf(PROFILE_A);
    expect(d.route).toMatchObject({ phase: 'attention', entryMode: 'UNKNOWN' });
    expect(d.ordersAllowed).toBe(false);
    expect(d.ordersBlockedReason).toBe('路由不在已验证状态');
    expect(h.fake.simulateRequest({ processPath: '/Applications/Safari.app/Contents/MacOS/Safari', host: 'www.amazon.com', protocol: 'tcp' }).policyName).not.toBe('SFE-ROUTE');
  });

  test('orders are blocked as soon as the web refresh finds outbound mode changed to direct, inside the precheck window', async () => {
    h = await createHarness();
    await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    h.clock.advance(6_000);
    expect((await stateOf(PROFILE_A)).ordersAllowed).toBe(true);
    h.clock.advance(1_000);
    h.fake.takeover = { ...h.fake.takeover, outboundMode: 'direct' };
    await h.app.refreshSurge(WEB);
    h.clock.advance(1_000);
    const d = await stateOf(PROFILE_A);
    expect(d.route!.warnings).toContain('outbound_mode_changed');
    expect(d.ordersAllowed).toBe(false);
    expect(d.ordersBlockedReason).toBe('路由不在已验证状态');
  });

  test('when the action precheck cannot finish reconciling (slow Surge after a restart, or the executor busy with another reconcile), the summary is marked unreconciled and orders stay blocked', async () => {
    h = await createHarness({ entryStrategy: 'temp_rule' });
    await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    h.clock.advance(6_000);
    h.fake.restart();
    // 重启之后的读取很慢：组选择读取挂起，直到放行
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const orig = h.fake.getGroupSelection.bind(h.fake);
    h.fake.getGroupSelection = async (name: string) => {
      await gate;
      return orig(name);
    };
    const pending = h.native(PROFILE_A, { type: 'getCurrentState' });
    await h.clock.advanceAsync(5_000);
    const d = ((await pending) as { data: StateData }).data;
    expect(d.ordersAllowed).toBe(false);
    expect(d.ordersBlockedReason).toBe('读取 Surge 状态超时');
    // 摘要仍是对账之前的记录，但标为未对账：弹窗顶栏不按它声称托管中
    expect(d.routeSummary).toMatchObject({ entryMode: 'ACTIVE', phase: 'active_verified', reconciled: false });
    // 执行器正忙（后台的动作前对账仍在进行）时，并发的检查共用它，同样未对账
    const busy = h.native(PROFILE_B, { type: 'getCurrentState' });
    await h.clock.advanceAsync(5_000);
    expect(((await busy) as { data: StateData }).data.routeSummary.reconciled).toBe(false);
    release();
    h.fake.getGroupSelection = orig;
    await h.idle();
    await new Promise((r) => setTimeout(r, 0));
    const after = await stateOf(PROFILE_A);
    expect(after.routeSummary).toMatchObject({ entryMode: 'UNKNOWN', phase: 'attention', reconciled: true });
    expect(after.ordersAllowed).toBe(false);

    // 另一来源占着执行器（周期对账）：检查不能运行，同样标为未对账
    h.clock.advance(6_000);
    let releasePeriodic!: () => void;
    const gatePeriodic = new Promise<void>((r) => (releasePeriodic = r));
    h.fake.getGroupSelection = async (name: string) => {
      await gatePeriodic;
      return orig(name);
    };
    const periodic = h.app.runPeriodicReconcile();
    await new Promise((r) => setTimeout(r, 0));
    const whileBusy = await stateOf(PROFILE_A);
    expect(whileBusy.routeSummary.reconciled).toBe(false);
    expect(whileBusy.ordersBlockedReason).toBe('正在切换出口，请稍后再试');
    releasePeriodic();
    h.fake.getGroupSelection = orig;
    await periodic;
  });

  test('every profile gets a reconciled summary while the route is managed, not only the active environment\'s profile (Surge restarted)', async () => {
    h = await createHarness({ entryStrategy: 'temp_rule' });
    await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const b = (await createEnv(h, 'US-Buyer-B', '203.0.113.11')).environment_id!;
    await bind(h, PROFILE_B, b);
    h.clock.advance(6_000);
    h.fake.restart();
    for (const profile of [PROFILE_B, PROFILE_C, null]) {
      const d = await stateOf(profile);
      expect(d.relation).toBe('other_active');
      expect(d.route).toBeNull();
      // 先对账再读取：摘要不再是 ACTIVE/active_verified（弹窗顶栏不显示「托管中」）
      expect(d.routeSummary).toMatchObject({ entryMode: 'UNKNOWN', phase: 'attention', reconciled: true });
    }
    expect(h.repos.routeState.get()).toMatchObject({ entryMode: 'UNKNOWN', phase: 'attention' });
  });

  test('automatic opening of orders needs the fillAndAutoOpen gate (§5.2): with native_profile_id and first_request_and_old_connections unverified, orders stay manually allowed but autoOpenAllowed is false with the reason', async () => {
    h = await createHarness({ capabilities: ALL_CAPS.filter((k) => k !== 'native_profile_id' && k !== 'first_request_and_old_connections') });
    await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    h.clock.advance(6_000);
    const d = (await h.native(PROFILE_A, { type: 'getCurrentState' })) as { ok: true; data: { ordersAllowed: boolean; autoOpenAllowed: boolean; autoOpenBlockedReason: string | null; environment: { autoOpenOrders: boolean } } };
    expect(d.data.environment.autoOpenOrders).toBe(true);
    expect(d.data.ordersAllowed).toBe(true);
    expect(d.data.autoOpenAllowed).toBe(false);
    expect(d.data.autoOpenBlockedReason).toContain('自动打开订单页所需能力尚未通过实测');
    // 两项能力通过实测之后允许自动打开
    h.grant(['native_profile_id', 'first_request_and_old_connections']);
    const e = (await h.native(PROFILE_A, { type: 'getCurrentState' })) as { ok: true; data: { ordersAllowed: boolean; autoOpenAllowed: boolean; autoOpenBlockedReason: string | null } };
    expect(e.data).toMatchObject({ ordersAllowed: true, autoOpenAllowed: true, autoOpenBlockedReason: null });
  });

  test.each([
    ['ruleset_resource', 'listExternalResources'],
    ['temp_rule', 'listTempRules'],
  ] as const)('%s: while an accepted normal mode runs its first readback (route still active_verified, reconcile reused within 5 s), orders and auto-open are blocked', async (entryStrategy, method) => {
    h = await createHarness({ entryStrategy });
    const { envId } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    h.clock.advance(1_000);
    // 普通模式开始执行后第一次读取入口时挂起：路由仍是使用中且已验证
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const reached = new Promise<void>((r) => (entered = r));
    const fake = h.fake as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    const orig = fake[method]!.bind(h.fake);
    fake[method] = async (...a: unknown[]) => {
      entered();
      await gate;
      return orig(...a);
    };
    const n = (await h.native(PROFILE_A, { type: 'enterNormalMode', request_id: rid('n'), old_session_policy: 'keep_open_acknowledged', confirmed_environment_id: envId })) as { ok: true; data: { operation_id: string } };
    await reached;
    expect(h.repos.operations.get(n.data.operation_id)!.status).toBe('running');
    expect(h.repos.routeState.get()).toMatchObject({ phase: 'active_verified', entryMode: 'ACTIVE' });
    const d = (await h.native(PROFILE_A, { type: 'getCurrentState' })) as { ok: true; data: StateData & { autoOpenAllowed: boolean } };
    expect(d.data.routeSummary.reconciled).toBe(true);
    expect(d.data.ordersAllowed).toBe(false);
    expect(d.data.autoOpenAllowed).toBe(false);
    expect(d.data.ordersBlockedReason).toBe('正在进入普通模式');
    fake[method] = orig;
    release();
    await h.idle();
    expect(h.repos.operations.get(n.data.operation_id)!.phase).toBe('NORMAL_RESTORED');
  });

  test('autoOpenAllowed is never true when orders are not allowed', async () => {
    h = await createHarness();
    const a = (await createEnv(h, 'US-Buyer-A', '203.0.113.10')).environment_id!;
    await bind(h, PROFILE_A, a);
    const d = (await h.native(PROFILE_A, { type: 'getCurrentState' })) as { ok: true; data: { ordersAllowed: boolean; ordersBlockedReason: string | null; autoOpenAllowed: boolean; autoOpenBlockedReason: string | null } };
    expect(d.data.ordersAllowed).toBe(false);
    expect(d.data.autoOpenAllowed).toBe(false);
    expect(d.data.autoOpenBlockedReason).toBe(d.data.ordersBlockedReason);
  });

  test('an idle normal-mode route needs no precheck: getCurrentState does not read Surge and the summary counts as reconciled', async () => {
    h = await createHarness();
    const total = () => Object.values(h.fake.calls).reduce((a, b) => a + b, 0);
    const calls = total();
    const d = await stateOf(PROFILE_C);
    expect(d.routeSummary).toMatchObject({ entryMode: 'NORMAL', phase: 'idle', reconciled: true });
    expect(total()).toBe(calls);
  });

  test('reportProfileState is only a hint and never changes routing', async () => {
    h = await createHarness();
    await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const before = h.repos.routeState.get();
    await h.native(PROFILE_C, { type: 'reportProfileState', windows_open: 3, amazon_tabs_open: true, site_permission_granted: false });
    await h.idle();
    const after = h.repos.routeState.get();
    expect({ ...after, updatedAt: '' }).toEqual({ ...before, updatedAt: '' });
    expect(h.repos.profileReports.get(PROFILE_C)!.windowsOpen).toBe(3);
    // 未识别场景（可能是默认场景）的上报同样只作提示，记入共用的一条记录（不是任何场景 ID）
    const r = await h.native(null, { type: 'reportProfileState', windows_open: 2, amazon_tabs_open: false, site_permission_granted: true });
    expect(r).toEqual({ ok: true, data: { recorded: true } });
    await h.idle();
    expect({ ...h.repos.routeState.get(), updatedAt: '' }).toEqual({ ...before, updatedAt: '' });
    const unidentified = h.repos.profileReports.list().filter((x) => x.profileId !== PROFILE_C);
    expect(unidentified).toEqual([expect.objectContaining({ profileId: '~unidentified', windowsOpen: 2 })]);
    expect(h.repos.profileBindings.byProfile('~unidentified')).toBeNull();
  });
});

describe('getOperation scoping', () => {
  test('own environment or own initiated only; otherwise NOT_FOUND', async () => {
    h = await createHarness();
    const a = await createEnv(h, 'US-Buyer-A', '203.0.113.10');
    const b = await createEnv(h, 'US-Buyer-B', '203.0.113.11');
    await bind(h, PROFILE_A, a.environment_id!);
    expect(errCode(await h.native(PROFILE_A, { type: 'getOperation', operation_id: a.operation_id }))).toBe('OK');
    expect(errCode(await h.native(PROFILE_A, { type: 'getOperation', operation_id: b.operation_id }))).toBe('NOT_FOUND');
    // 未绑定场景发起的普通模式：可读取自己发起的操作
    const n = await h.native(PROFILE_C, { type: 'enterNormalMode', request_id: rid() });
    const nid = (n as { data: { operation_id: string } }).data.operation_id;
    expect(errCode(await h.native(PROFILE_C, { type: 'getOperation', operation_id: nid }))).toBe('OK');
    expect(errCode(await h.native(PROFILE_C, { type: 'getOperation', operation_id: a.operation_id }))).toBe('NOT_FOUND');
  });

  test('begin/submit only for the bound environment; test id single use; stale epoch rejected', async () => {
    h = await createHarness();
    const { envId: a } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const b = (await createEnv(h, 'US-Buyer-B', '203.0.113.11')).environment_id!;
    await bind(h, PROFILE_B, b);
    const act = await h.app.activate(b, { request_id: rid(), old_session_policy: 'closed_confirmed', confirmed_environment_id: a }, WEB);
    await h.idle();
    expect(errCode(await h.native(PROFILE_A, { type: 'beginSafariVerification', operation_id: act.operation_id, amazon_tabs_open: false }))).toBe('BINDING_MISMATCH');
    const begin = await h.native(PROFILE_B, { type: 'beginSafariVerification', operation_id: act.operation_id, amazon_tabs_open: false });
    const t = (begin as { data: { test_id: string; route_epoch: number; verify_url: string } }).data;
    expect(t.test_id.length).toBeGreaterThanOrEqual(22);
    expect(t.verify_url).toContain('sfe_test=');
    const sub = (epoch: number, testId = t.test_id) =>
      h.native(PROFILE_B, {
        type: 'submitSafariVerification',
        operation_id: act.operation_id,
        test_id: testId,
        route_epoch: epoch,
        observed_ip: '192.0.2.50',
        http_status: 200,
        error: null,
        started_at: h.clock.now().toISOString(),
        finished_at: h.clock.now().toISOString(),
      });
    expect(errCode(await sub(t.route_epoch - 1))).toBe('STALE_ROUTE_EPOCH');
    expect(errCode(await sub(t.route_epoch, 'not-a-test'))).toBe('SAFARI_VERIFY_FAILED');
    h.fake.simulateRequest({ processPath: '/Applications/Safari.app/Contents/MacOS/Safari', host: 'verify.example.test', protocol: 'tcp' });
    expect(errCode(await sub(t.route_epoch))).toBe('OK');
    expect(errCode(await sub(t.route_epoch))).toBe('SAFARI_VERIFY_FAILED');
    await h.idle();
    expect(h.repos.operations.get(act.operation_id)!.phase).toBe('ACTIVE_VERIFIED');
  });
});

describe('requestLoginFill (§6.10)', () => {
  async function fillSetup(): Promise<{ envId: string; epoch: number }> {
    h = await createHarness();
    const { envId } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A, { login: 'buyer01@example.test', accountPassword: 'synth-account-pw' });
    const env = h.repos.environments.get(envId)!;
    await h.app.updateEnvironment(envId, { request_id: rid(), expected_revision: env.revision, changes: { autoFillLogin: true } }, WEB);
    return { envId, epoch: h.repos.routeState.get().routeEpoch };
  }
  const req = (epoch: number, patch: Record<string, unknown> = {}): NativeRequest =>
    ({
      type: 'requestLoginFill',
      top_url: 'https://www.amazon.com/ap/signin?openid=x',
      frame_is_top: true,
      form_action: 'https://www.amazon.com/ap/signin',
      fields: ['identifier', 'password'],
      route_epoch: epoch,
      ...patch,
    }) as NativeRequest;

  /** 账号密码引用被读取的次数（只在 §6.10 全部通过之后读取）。 */
  const passwordReads = (envId: string) => {
    const ref = h.repos.accounts.get(envId)!.passwordRef!;
    return h.store.calls.filter((c) => c.op === 'get' && c.ref === ref).length;
  };

  test('success: identifier and password are returned as values read from the local store; logs never contain them', async () => {
    const { envId, epoch } = await fillSetup();
    expect(passwordReads(envId)).toBe(0);
    const r = await h.native(PROFILE_A, req(epoch));
    expect(errCode(r)).toBe('OK');
    const fills = (r as { data: { fills: Array<Record<string, string>> } }).data.fills;
    // 与原生桥交给扩展的应答完全相同：只有 field 与 value，没有引用或有效期
    expect(fills).toEqual([
      { field: 'identifier', value: 'buyer01@example.test' },
      { field: 'password', value: 'synth-account-pw' },
    ]);
    expect(passwordReads(envId)).toBe(1);
    // 读到的密码已登记到脱敏器：之后任何日志、错误或步骤中出现都会被遮盖
    expect(h.app.engine.scrubber.scrub('x synth-account-pw y')).not.toContain('synth-account-pw');
    h.app.engine.log('warn', 'test.echo', { message: 'leak synth-account-pw' });
    const logs = h.logs.join('\n');
    expect(logs).toContain('login_fill.allowed');
    expect(logs).not.toContain('synth-account-pw');
    expect(logs).not.toContain('buyer01@example.test');
  });

  test('success: only the requested fields are read and returned', async () => {
    const { envId, epoch } = await fillSetup();
    const r = await h.native(PROFILE_A, req(epoch, { fields: ['identifier'] }));
    expect((r as { data: { fills: unknown[] } }).data.fills).toEqual([{ field: 'identifier', value: 'buyer01@example.test' }]);
    expect(passwordReads(envId)).toBe(0);
    const pw = await h.native(PROFILE_A, req(epoch, { fields: ['password', 'password'] }));
    expect((pw as { data: { fills: unknown[] } }).data.fills).toEqual([{ field: 'password', value: 'synth-account-pw' }]);
  });

  test.each([
    ['frame not top', { frame_is_top: false }, 'frame'],
    ['not a sign-in page', { top_url: 'https://www.amazon.com/gp/css/order-history' }, 'page'],
    ['look-alike host', { top_url: 'https://www.amazon.com.example.test/ap/signin' }, 'page'],
    ['mfa page', { top_url: 'https://www.amazon.com/ap/mfa' }, 'page'],
    ['form action missing', { form_action: null }, 'form_action'],
    ['form action cross-origin', { form_action: 'https://evil.example.test/ap/signin' }, 'form_action'],
    ['form action http', { form_action: 'http://www.amazon.com/ap/signin' }, 'form_action'],
    ['stale epoch', { route_epoch: -1 }, 'epoch'],
    ['no fields', { fields: [] }, 'fields'],
  ])('refused: %s — nothing is read or returned', async (_name, patch, reason) => {
    const { envId, epoch } = await fillSetup();
    const r = await h.native(PROFILE_A, req(epoch, patch));
    expect(errCode(r)).toBe('FILL_NOT_ALLOWED');
    expect((r as unknown as { error: { details: { reason: string } } }).error.details.reason).toBe(reason);
    expect(passwordReads(envId)).toBe(0);
    expect(JSON.stringify(r)).not.toContain('synth-account-pw');
    expect(JSON.stringify(r)).not.toContain('buyer01@example.test');
  });

  test('refused: auto fill disabled for the environment', async () => {
    const { envId, epoch } = await fillSetup();
    const env = h.repos.environments.get(envId)!;
    await h.app.updateEnvironment(envId, { request_id: rid(), expected_revision: env.revision, changes: { autoFillLogin: false } }, WEB);
    const r = await h.native(PROFILE_A, req(epoch));
    expect((r as unknown as { error: { details: { reason: string } } }).error.details.reason).toBe('disabled');
  });

  test.each([['native_profile_id'], ['first_request_and_old_connections']] as const)('refused: fill capability gate missing (%s); no keychain capability exists', async (key) => {
    const { envId, epoch } = await fillSetup();
    h.revoke([key]);
    const r = await h.native(PROFILE_A, req(epoch));
    const error = (r as unknown as { error: { details: { reason: string; missing: string[] } } }).error;
    expect(error.details.reason).toBe('capability');
    expect(error.details.missing).toEqual([key]);
    expect(passwordReads(envId)).toBe(0);
    expect(JSON.stringify(r)).not.toContain('synth-account-pw');
  });

  test('the password value missing from the local store → SECRET_STORE_FAILED, nothing returned', async () => {
    const { envId, epoch } = await fillSetup();
    await h.store.delete(h.repos.accounts.get(envId)!.passwordRef!);
    const r = await h.native(PROFILE_A, req(epoch));
    expect(errCode(r)).toBe('SECRET_STORE_FAILED');
    expect(JSON.stringify(r)).not.toContain('buyer01@example.test');
    expect(JSON.stringify(r)).not.toContain(h.repos.accounts.get(envId)!.passwordRef!);
  });

  test('the route changing while the password is read → refused (epoch), no value returned', async () => {
    const { envId, epoch } = await fillSetup();
    const ref = h.repos.accounts.get(envId)!.passwordRef!;
    const original = h.store.get.bind(h.store);
    h.store.get = async (r: string) => {
      const value = await original(r);
      if (r === ref) h.repos.tx(() => h.repos.routeState.update({ routeEpoch: epoch + 1 }));
      return value;
    };
    const r = await h.native(PROFILE_A, req(epoch));
    expect(errCode(r)).toBe('FILL_NOT_ALLOWED');
    expect((r as unknown as { error: { details: { reason: string } } }).error.details.reason).toBe('epoch');
    expect(JSON.stringify(r)).not.toContain('synth-account-pw');
  });

  test('refused: requesting profile is not bound to the active environment', async () => {
    const { envId, epoch } = await fillSetup();
    const b = (await createEnv(h, 'US-Buyer-B', '203.0.113.11')).environment_id!;
    await bind(h, PROFILE_B, b);
    const env = h.repos.environments.get(b)!;
    await h.app.updateEnvironment(b, { request_id: rid(), expected_revision: env.revision, changes: { autoFillLogin: true, account: { loginIdentifier: 'buyer02@example.test' } } }, WEB);
    const r = await h.native(PROFILE_B, req(epoch));
    expect((r as unknown as { error: { details: { reason: string } } }).error.details.reason).toBe('not_active');
    expect(passwordReads(envId)).toBe(0);
    expect(JSON.stringify(r)).not.toContain('synth-account-pw');
  });

  test('refused: route not in control (probe expired, external change)', async () => {
    const { envId, epoch } = await fillSetup();
    h.clock.advance(901_000);
    const r = await h.native(PROFILE_A, req(epoch));
    expect((r as unknown as { error: { details: { reason: string } } }).error.details.reason).toBe('control');
    expect(passwordReads(envId)).toBe(0);
    expect(JSON.stringify(r)).not.toContain('synth-account-pw');
  });

  test('refused: selection changed externally (precheck reconcile)', async () => {
    const { epoch } = await fillSetup();
    await h.fake.selectGroupPolicy('SFE-ROUTE', 'REJECT');
    const r = await h.native(PROFILE_A, req(epoch));
    expect((r as unknown as { error: { details: { reason: string } } }).error.details.reason).toBe('control');
    expect(h.repos.routeState.get().warnings).toContain('external_selection_change');
  });

  /**
   * 弹窗轮询（另一个请求）开始的动作前对账已读过出站模式、停在之后的 Surge 读取上（listPolicies 挂在闸门上）时，填充请求到达。
   * 返回 release：放开闸门。
   */
  async function precheckInFlight(): Promise<{ popup: Promise<unknown>; release: () => void }> {
    h.clock.advance(6_000); // 上一次对账已超过 5 秒：getCurrentState 开始新的动作前对账
    let reached!: () => void;
    const atListPolicies = new Promise<void>((r) => (reached = r));
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const orig = h.fake.listPolicies.bind(h.fake);
    h.fake.listPolicies = async () => {
      reached();
      await gate;
      return orig();
    };
    const popup = h.native(PROFILE_A, { type: 'getCurrentState' });
    await atListPolicies;
    return {
      popup,
      release: () => {
        h.fake.listPolicies = orig;
        open();
      },
    };
  }

  test('refused: a precheck that read Surge before the fill request is not reused — the fill waits for it and reconciles again (outbound mode changed in between)', async () => {
    const { epoch } = await fillSetup();
    const takeoverReads = () => h.fake.calls.getTakeoverState ?? 0;
    const { popup, release } = await precheckInFlight();
    const before = takeoverReads();
    // 用户把出站模式改为直连，然后填充请求到达（登录页加载时自动请求）
    h.fake.takeover = { ...h.fake.takeover, outboundMode: 'direct' };
    const fill = h.native(PROFILE_A, req(epoch));
    await new Promise((r) => setTimeout(r, 0));
    release();
    expect((await popup) as { ok: boolean }).toMatchObject({ ok: true });
    const r = await fill;
    expect(errCode(r)).toBe('FILL_NOT_ALLOWED');
    expect((r as unknown as { error: { details: { reason: string } } }).error.details.reason).toBe('control');
    expect(h.repos.routeState.get().warnings).toContain('outbound_mode_changed');
    // 填充在弹窗的对账之后另读了一次出站模式
    expect(takeoverReads() - before).toBeGreaterThanOrEqual(1);
  });

  test('refused: the same when that precheck already timed out for the popup and is still running', async () => {
    const { epoch } = await fillSetup();
    const { popup, release } = await precheckInFlight();
    await h.clock.advanceAsync(5_000);
    expect((await popup) as { data: { ordersAllowed: boolean } }).toMatchObject({ data: { ordersAllowed: false } });
    h.clock.advance(1_000);
    h.fake.takeover = { ...h.fake.takeover, outboundMode: 'direct' };
    const fill = h.native(PROFILE_A, req(epoch));
    await new Promise((r) => setTimeout(r, 0));
    release();
    const r = await fill;
    expect(errCode(r)).toBe('FILL_NOT_ALLOWED');
    expect((r as unknown as { error: { details: { reason: string } } }).error.details.reason).toBe('control');
  });

  test('a fill arriving while another request\'s precheck runs still succeeds when nothing changed (waits, then reconciles again; never "busy")', async () => {
    const { epoch } = await fillSetup();
    const { popup, release } = await precheckInFlight();
    const before = h.fake.calls.getTakeoverState ?? 0;
    const fill = h.native(PROFILE_A, req(epoch));
    await new Promise((r) => setTimeout(r, 0));
    release();
    await popup;
    expect(errCode(await fill)).toBe('OK');
    expect((h.fake.calls.getTakeoverState ?? 0) - before).toBeGreaterThanOrEqual(1);
  });

  /** 填充自己的动作前对账停在 listPolicies 上时执行 during（模拟真实 Surge 读取的延迟），之后放开。 */
  async function fillWithChangeDuringPrecheck(epoch: number, during: () => Promise<void>): Promise<Awaited<ReturnType<Harness['native']>>> {
    let reached!: () => void;
    const atListPolicies = new Promise<void>((r) => (reached = r));
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const orig = h.fake.listPolicies.bind(h.fake);
    h.fake.listPolicies = async () => {
      reached();
      await gate;
      return orig();
    };
    const fill = h.native(PROFILE_A, req(epoch));
    await atListPolicies;
    await during();
    h.fake.listPolicies = orig;
    open();
    return fill;
  }
  const reasonOf = (r: unknown) => (r as { error: { details: { reason: string } } }).error.details.reason;

  test('refused: fill turned off in the web console while the fill\'s own precheck runs → no value is returned (the save already committed)', async () => {
    const { envId, epoch } = await fillSetup();
    const r = await fillWithChangeDuringPrecheck(epoch, async () => {
      const env = h.repos.environments.get(envId)!;
      await h.app.updateEnvironment(envId, { request_id: rid(), expected_revision: env.revision, changes: { autoFillLogin: false } }, WEB);
    });
    expect(errCode(r)).toBe('FILL_NOT_ALLOWED');
    expect(reasonOf(r)).toBe('disabled');
    expect(JSON.stringify(r)).not.toContain('synth-account-pw');
    expect(passwordReads(envId)).toBe(0);
  });

  test('refused: account identifier and password replaced while the precheck runs → neither the old nor the new values are returned', async () => {
    const { envId, epoch } = await fillSetup();
    const r = await fillWithChangeDuringPrecheck(epoch, async () => {
      const env = h.repos.environments.get(envId)!;
      await h.app.updateEnvironment(
        envId,
        { request_id: rid(), expected_revision: env.revision, changes: { account: { loginIdentifier: 'buyer99@example.test', password: { action: 'replace', value: 'synth-new-pw' } } } },
        WEB,
      );
    });
    expect(errCode(r)).toBe('FILL_NOT_ALLOWED');
    expect(reasonOf(r)).toBe('account_changed');
    const text = JSON.stringify(r);
    expect(text).not.toContain('synth-account-pw');
    expect(text).not.toContain('buyer01@example.test');
    // 刷新页面后的新请求按新的资料填充
    const again = await h.native(PROFILE_A, req(epoch));
    expect((again as { data: { fills: unknown[] } }).data.fills).toEqual([
      { field: 'identifier', value: 'buyer99@example.test' },
      { field: 'password', value: 'synth-new-pw' },
    ]);
  });

  test('refused: password cleared while the precheck runs → the orphaned old value is never read or returned, even before the sweep deletes it', async () => {
    const { envId, epoch } = await fillSetup();
    const oldRef = h.repos.accounts.get(envId)!.passwordRef!;
    const r = await fillWithChangeDuringPrecheck(epoch, async () => {
      const env = h.repos.environments.get(envId)!;
      await h.app.updateEnvironment(envId, { request_id: rid(), expected_revision: env.revision, changes: { account: { password: { action: 'clear' } } } }, WEB);
    });
    expect(errCode(r)).toBe('FILL_NOT_ALLOWED');
    expect(reasonOf(r)).toBe('account_changed');
    expect(JSON.stringify(r)).not.toContain('synth-account-pw');
    expect(h.store.calls.filter((c) => c.op === 'get' && c.ref === oldRef)).toHaveLength(0);
  });

  test('refused: a normal mode accepted while the fill\'s own precheck runs → nothing is returned, and the normal mode then restores the original rules', async () => {
    const { envId, epoch } = await fillSetup();
    let normalId = '';
    const r = await fillWithChangeDuringPrecheck(epoch, async () => {
      // 弹窗「进入普通模式」：执行器被填充的动作前对账占用，普通模式排队，路由仍是使用中且已验证、epoch 不变
      const n = await h.app.enterNormal({ request_id: rid('normal'), old_session_policy: 'keep_open_acknowledged', confirmed_environment_id: envId }, WEB);
      normalId = n.operation_id;
      expect(h.repos.operations.get(normalId)!.status).toBe('queued');
    });
    expect(errCode(r)).toBe('FILL_NOT_ALLOWED');
    expect(reasonOf(r)).toBe('normal_pending');
    const text = JSON.stringify(r);
    expect(text).not.toContain('synth-account-pw');
    expect(text).not.toContain('buyer01@example.test');
    expect(passwordReads(envId)).toBe(0);
    await h.idle();
    expect(h.repos.operations.get(normalId)!.phase).toBe('NORMAL_RESTORED');
  });

  test('refused: a normal mode accepted while the password is being read → the value read is not returned', async () => {
    const { envId, epoch } = await fillSetup();
    const store = h.store as unknown as { get: (ref: string) => Promise<string | null> };
    const orig = store.get.bind(h.store);
    let accepted = false;
    store.get = async (ref) => {
      const v = await orig(ref);
      if (!accepted) {
        accepted = true;
        await h.app.enterNormal({ request_id: rid('normal'), old_session_policy: 'keep_open_acknowledged', confirmed_environment_id: envId }, WEB);
      }
      return v;
    };
    const r = await h.native(PROFILE_A, req(epoch));
    expect(accepted).toBe(true);
    // 受理普通模式不改 epoch，路由记录在它开始撤销入口之前仍是使用中且已验证
    expect(h.repos.routeState.get()).toMatchObject({ routeEpoch: epoch, activeEnvironmentId: envId, phase: 'active_verified' });
    expect(errCode(r)).toBe('FILL_NOT_ALLOWED');
    expect(reasonOf(r)).toBe('normal_pending');
    expect(JSON.stringify(r)).not.toContain('synth-account-pw');
  });

  test('refused: a switch to another environment accepted while the fill\'s own precheck runs → nothing is returned', async () => {
    const { envId, epoch } = await fillSetup();
    const b = (await createEnv(h, 'US-Buyer-B', '203.0.113.11')).environment_id!;
    await bind(h, PROFILE_B, b);
    const r = await fillWithChangeDuringPrecheck(epoch, async () => {
      await h.app.activate(b, { request_id: rid('act'), old_session_policy: 'keep_open_acknowledged', confirmed_environment_id: envId }, WEB);
    });
    expect(errCode(r)).toBe('FILL_NOT_ALLOWED');
    expect(reasonOf(r)).toBe('route_busy');
    expect(JSON.stringify(r)).not.toContain('synth-account-pw');
    expect(passwordReads(envId)).toBe(0);
  });

  test('refused: a change committed while the password is being read → the value read is not returned', async () => {
    const { envId, epoch } = await fillSetup();
    const store = h.store as unknown as { get: (ref: string) => Promise<string | null> };
    const orig = store.get.bind(h.store);
    let changed = false;
    store.get = async (ref) => {
      const v = await orig(ref);
      if (!changed) {
        changed = true;
        const env = h.repos.environments.get(envId)!;
        await h.app.updateEnvironment(envId, { request_id: rid(), expected_revision: env.revision, changes: { autoFillLogin: false } }, WEB);
      }
      return v;
    };
    const r = await h.native(PROFILE_A, req(epoch));
    expect(changed).toBe(true);
    expect(errCode(r)).toBe('FILL_NOT_ALLOWED');
    expect(reasonOf(r)).toBe('disabled');
    expect(JSON.stringify(r)).not.toContain('synth-account-pw');
  });

  test('refused: missing password for the account', async () => {
    h = await createHarness();
    const { envId } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A, { login: 'buyer01@example.test' });
    const env = h.repos.environments.get(envId)!;
    await h.app.updateEnvironment(envId, { request_id: rid(), expected_revision: env.revision, changes: { autoFillLogin: true } }, WEB);
    const r = await h.native(PROFILE_A, req(h.repos.routeState.get().routeEpoch));
    expect((r as unknown as { error: { details: { reason: string } } }).error.details.reason).toBe('password');
    const idOnly = await h.native(PROFILE_A, req(h.repos.routeState.get().routeEpoch, { fields: ['identifier'] }));
    expect(errCode(idOnly)).toBe('OK');
  });

  test('verification helper sanity: unrelated profile cannot verify', async () => {
    h = await createHarness();
    const { opId } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const r = await verify(h, PROFILE_C, opId);
    expect(errCode(r)).toBe('PROFILE_UNBOUND');
  });
});
