import { afterEach, describe, expect, test } from 'vitest';
import { NATIVE_PERMISSIONS, type NativeRequest, type NativeRequestType } from '@sfe/contract';
import { PROFILE_A, PROFILE_B, PROFILE_C, WEB, activeEnv, bind, createEnv, createHarness, envInput, rid, verify, type Harness } from './harness.js';

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
    expect(other.routeSummary).toEqual({ routeEpoch: 1, entryMode: 'ACTIVE', phase: 'active_verified', buyerExitConnectionsUnconfirmed: false, normalModeOffered: true });
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
      expect(d.routeSummary).toEqual({ routeEpoch: expect.any(Number), entryMode: 'NORMAL', phase: 'idle', buyerExitConnectionsUnconfirmed: true, normalModeOffered: true });
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
