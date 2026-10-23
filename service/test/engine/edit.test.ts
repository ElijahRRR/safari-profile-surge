import { afterEach, describe, expect, test } from 'vitest';
import { CAPABILITY_KEYS, SfeError } from '@sfe/contract';
import { ADMIN, AGENT, PROFILE_A, WEB, activeEnv, bind, createEnv, createHarness, envInput, rid, type Harness } from './harness.js';

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

const surgeWrites = () => ({ update: h.fake.calls.updateExternalResource ?? 0, select: h.fake.calls.selectGroupPolicy ?? 0, reload: h.fake.calls.reloadProfile ?? 0 });

describe('create', () => {
  test('validation failure → 422, no operation, nothing written to the secret store', async () => {
    h = await createHarness();
    const ops = h.repos.operations.listRecent(100).length;
    const err = await expectError(
      h.app.createEnvironment({ request_id: rid(), environment: envInput('', '203.0.113.10', { password: 'bad pass with spaces' }) }, WEB),
      'VALIDATION_FAILED',
    );
    expect(err.fieldErrors!.map((f) => f.field)).toEqual(expect.arrayContaining(['displayName', 'proxy.password']));
    expect(JSON.stringify(err.toBody())).not.toContain('bad pass');
    expect(h.repos.operations.listRecent(100).length).toBe(ops);
    expect(h.store.calls.filter((c) => c.op === 'put' && c.kind !== 'system')).toHaveLength(0);
  });

  test('no default front → validation error', async () => {
    h = await createHarness();
    h.repos.frontProxies.setDefault(null);
    await expectError(h.app.createEnvironment({ request_id: rid(), environment: envInput('US-Buyer-01', '203.0.113.10') }, WEB), 'VALIDATION_FAILED');
  });

  test('null front resolves to the default at save time and is stored as a concrete id', async () => {
    h = await createHarness();
    const a = await createEnv(h, 'US-Buyer-01', '203.0.113.10');
    expect(h.repos.proxyRevisions.get(a.environment_id!, 1)!.frontProxyId).toBe(h.frontId);
  });

  test('secrets go to the secret store only; environment rows store refs and keyed fingerprints', async () => {
    h = await createHarness();
    const a = await createEnv(h, 'US-Buyer-01', '203.0.113.10', { username: 'synthuser01', password: 'synthpass01', accountPassword: 'acct-secret-01' });
    const rev = h.repos.proxyRevisions.get(a.environment_id!, 1)!;
    expect(rev.usernameRef).toMatch(/^sec_/);
    expect(rev.passwordFp).toMatch(/^[0-9a-f]{64}$/);
    expect(h.repos.secretRefs.get(rev.passwordRef!)!.state).toBe('committed');
    const acc = h.repos.accounts.get(a.environment_id!)!;
    expect(h.store.kindOf(acc.passwordRef!)).toBe('account');
    // 账号密码保存在本机后台资料中（不使用钥匙串），只在登录填充把关通过后读出
    expect(await h.store.get(acc.passwordRef!)).toBe('acct-secret-01');
    expect(await h.store.get(rev.passwordRef!)).toBe('synthpass01');
  });

  test('secret store failure is recoverable: no operation, no pending ref left, retry succeeds', async () => {
    h = await createHarness();
    h.store.injectFailure('put', 'other');
    const req = { request_id: rid(), environment: envInput('US-Buyer-01', '203.0.113.10', { password: 'synthpass01' }) };
    const err = await expectError(h.app.createEnvironment(req, WEB), 'SECRET_STORE_FAILED');
    expect(err.details).toMatchObject({ reason: 'other' });
    expect(h.repos.operations.byRequestId(req.request_id)).toBeNull();
    expect(h.repos.secretRefs.listStalePending(new Date('2100-01-01'))).toEqual([]);
    const ok = await h.app.createEnvironment(req, WEB);
    expect(ok.duplicate).toBe(false);
  });
});

describe('idempotency and revisions', () => {
  test('same request_id and content → original operation with duplicate: true; different content → 409', async () => {
    h = await createHarness();
    const req = { request_id: rid(), environment: envInput('US-Buyer-01', '203.0.113.10', { password: 'synthpass01' }) };
    const a = await h.app.createEnvironment(req, WEB);
    const b = await h.app.createEnvironment(req, WEB);
    expect(b).toEqual({ ...a, duplicate: true });
    await expectError(h.app.createEnvironment({ ...req, environment: envInput('US-Buyer-01', '203.0.113.10', { password: 'synthpass02' }) }, WEB), 'DUPLICATE_REQUEST_MISMATCH');
    await h.idle();
    expect(h.repos.environments.list()).toHaveLength(1);
  });

  test('stale expected_revision → REVISION_CONFLICT with redacted diff; no lost update', async () => {
    h = await createHarness();
    const a = await createEnv(h, 'US-Buyer-01', '203.0.113.10', { login: 'buyer01@example.test' });
    const env = h.repos.environments.get(a.environment_id!)!;
    await h.app.updateEnvironment(env.id, { request_id: rid(), expected_revision: env.revision, changes: { displayName: 'From-Plugin' } }, WEB);
    const err = await expectError(
      h.app.updateEnvironment(env.id, { request_id: rid(), expected_revision: env.revision, changes: { displayName: 'From-Web', account: { loginIdentifier: 'buyer09@example.test' } } }, WEB),
      'REVISION_CONFLICT',
    );
    expect(err.details).toMatchObject({ currentRevision: env.revision + 1, expectedRevision: env.revision });
    const diff = (err.details as { diff: Array<{ field: string; before: string; after: string }> }).diff;
    expect(diff.find((d) => d.field === 'displayName')).toEqual({ field: 'displayName', before: 'From-Plugin', after: 'From-Web' });
    expect(JSON.stringify(diff)).not.toContain('buyer09@');
    expect(h.repos.environments.get(env.id)!.displayName).toBe('From-Plugin');
  });
});

describe('pure-data edits (§6.1)', () => {
  test('display name, site, options and account complete in the same transaction without touching Surge', async () => {
    h = await createHarness();
    const a = await createEnv(h, 'US-Buyer-01', '203.0.113.10');
    const env = h.repos.environments.get(a.environment_id!)!;
    const before = surgeWrites();
    const u = await h.app.updateEnvironment(env.id, { request_id: rid(), expected_revision: env.revision, changes: { displayName: 'Renamed', autoOpenOrders: false, account: { label: 'buyer label' } } }, WEB);
    const op = h.repos.operations.get(u.operation_id)!;
    expect(op.phase).toBe('COMPLETED');
    expect(op.status).toBe('succeeded');
    expect(h.repos.outbox.pendingForOperation(op.id)).toEqual([]);
    expect(h.repos.environments.get(env.id)!.desiredProxyRevision).toBe(1);
    expect(surgeWrites()).toEqual(before);
    // 节点名不随改名变化
    expect(h.repos.proxyRevisions.get(env.id, 1)!.nodeName).toBe('SFE-N-E0001-US01-v001');
  });

  test('expected-exit-IP-only edit creates no new revision; on the active env it is compared with the last ok probe', async () => {
    h = await createHarness();
    const { envId } = await activeEnv(h, 'US-Buyer-01', '203.0.113.10', PROFILE_A);
    const before = surgeWrites();
    let env = h.repos.environments.get(envId)!;
    const u = await h.app.updateEnvironment(envId, { request_id: rid(), expected_revision: env.revision, changes: { proxy: { expectedExitIp: '192.0.2.99' } } }, WEB);
    expect(h.repos.operations.get(u.operation_id)!.phase).toBe('COMPLETED');
    expect(h.repos.environments.get(envId)!.desiredProxyRevision).toBe(1);
    expect(h.repos.routeState.get().warnings).toContain('exit_ip_mismatch');
    expect((await h.app.ensureInControl()).ok).toBe(false);
    // 改成与实测一致 → 清除
    env = h.repos.environments.get(envId)!;
    await h.app.updateEnvironment(envId, { request_id: rid(), expected_revision: env.revision, changes: { proxy: { expectedExitIp: '192.0.2.50' } } }, WEB);
    expect(h.repos.routeState.get().warnings).not.toContain('exit_ip_mismatch');
    expect(surgeWrites()).toEqual(before);
    expect(h.repos.routeState.get().activeEnvironmentId).toBe(envId);
  });

  test('account identifier or password change sets changed_since_page_check; acknowledge clears it', async () => {
    h = await createHarness();
    const a = await createEnv(h, 'US-Buyer-01', '203.0.113.10', { login: 'buyer01@example.test', accountPassword: 'acct-secret-01' });
    let env = h.repos.environments.get(a.environment_id!)!;
    const oldRef = h.repos.accounts.get(env.id)!.passwordRef!;
    await h.app.updateEnvironment(env.id, { request_id: rid(), expected_revision: env.revision, changes: { account: { password: { action: 'replace', value: 'acct-secret-02' } } } }, WEB);
    const acc = h.repos.accounts.get(env.id)!;
    expect(acc.changedSincePageCheck).toBe(true);
    expect(acc.passwordRef).not.toBe(oldRef);
    expect(h.repos.secretRefs.get(oldRef)!.state).toBe('orphaned');
    const view = await h.app.getEnvironment(env.id, WEB);
    expect(view.nextActions.map((n) => n.kind)).toContain('acknowledge_account_change');
    env = h.repos.environments.get(env.id)!;
    await h.app.acknowledgeAccount(env.id, { request_id: rid(), expected_revision: env.revision }, WEB);
    expect(h.repos.accounts.get(env.id)!.changedSincePageCheck).toBe(false);
    const r = await h.app.engine.secrets.sweep();
    expect(r.deleted).toContain(oldRef);
  });

  test('clear account password removes the reference', async () => {
    h = await createHarness();
    const a = await createEnv(h, 'US-Buyer-01', '203.0.113.10', { accountPassword: 'acct-secret-01' });
    const env = h.repos.environments.get(a.environment_id!)!;
    await h.app.updateEnvironment(env.id, { request_id: rid(), expected_revision: env.revision, changes: { account: { password: { action: 'clear' } } } }, WEB);
    expect(h.repos.accounts.get(env.id)!.passwordRef).toBeNull();
  });
});

describe('node-line edits mint a new revision', () => {
  test('host change → new revision and publish; username keep shares the ref', async () => {
    h = await createHarness();
    const a = await createEnv(h, 'US-Buyer-01', '203.0.113.10', { username: 'synthuser01', password: 'synthpass01' });
    const env = h.repos.environments.get(a.environment_id!)!;
    const u = await h.app.updateEnvironment(env.id, { request_id: rid(), expected_revision: env.revision, changes: { proxy: { host: '203.0.113.20' } } }, WEB);
    await h.idle();
    const r1 = h.repos.proxyRevisions.get(env.id, 1)!;
    const r2 = h.repos.proxyRevisions.get(env.id, 2)!;
    expect(r2.nodeName).toBe('SFE-N-E0001-US01-v002');
    expect(r2.usernameRef).toBe(r1.usernameRef);
    expect(r2.passwordRef).toBe(r1.passwordRef);
    expect(h.repos.operations.get(u.operation_id)!.phase).toBe('READY_FOR_NEXT_OPEN');
    // 共享引用：旧版本 retired 后仍被新版本引用，回收时保留
    await h.app.publishPending({ request_id: rid() }, WEB);
    await h.idle();
    expect(h.repos.proxyRevisions.get(env.id, 1)!.state).toBe('retired');
    const sweep = await h.app.engine.secrets.sweep();
    expect(sweep.deleted).not.toContain(r1.usernameRef);
    expect(h.store.has(r1.usernameRef!)).toBe(true);
  });

  test('replacing a secret with the same value is not a change', async () => {
    h = await createHarness();
    const a = await createEnv(h, 'US-Buyer-01', '203.0.113.10', { password: 'synthpass01' });
    const env = h.repos.environments.get(a.environment_id!)!;
    const puts = h.store.calls.filter((c) => c.op === 'put').length;
    const u = await h.app.updateEnvironment(env.id, { request_id: rid(), expected_revision: env.revision, changes: { proxy: { password: { action: 'replace', value: 'synthpass01' } } } }, WEB);
    expect(h.repos.operations.get(u.operation_id)!.phase).toBe('COMPLETED');
    expect(h.repos.environments.get(env.id)!.desiredProxyRevision).toBe(1);
    expect(h.store.calls.filter((c) => c.op === 'put').length).toBe(puts);
  });

  test('front change mints a revision; unknown front is rejected', async () => {
    h = await createHarness();
    const a = await createEnv(h, 'US-Buyer-01', '203.0.113.10');
    h.repos.frontProxies.insert({ id: 'front_b', surgeName: 'Front-B', state: 'ok' });
    let env = h.repos.environments.get(a.environment_id!)!;
    await expectError(h.app.updateEnvironment(env.id, { request_id: rid(), expected_revision: env.revision, changes: { proxy: { frontProxyId: 'front_nope' } } }, WEB), 'VALIDATION_FAILED');
    await h.app.updateEnvironment(env.id, { request_id: rid(), expected_revision: env.revision, changes: { proxy: { frontProxyId: 'front_b' } } }, WEB);
    await h.idle();
    env = h.repos.environments.get(env.id)!;
    expect(env.desiredProxyRevision).toBe(2);
    expect(h.repos.proxyRevisions.get(env.id, 2)!.frontProxyId).toBe('front_b');
  });

  test('two quick edits before publishing: the earlier desired revision is superseded and never deployed', async () => {
    h = await createHarness();
    const a = await createEnv(h, 'US-Buyer-01', '203.0.113.10');
    await h.app.executor.stop();
    let env = h.repos.environments.get(a.environment_id!)!;
    const u1 = await h.app.updateEnvironment(env.id, { request_id: rid(), expected_revision: env.revision, changes: { proxy: { port: 1081 } } }, WEB);
    env = h.repos.environments.get(env.id)!;
    const u2 = await h.app.updateEnvironment(env.id, { request_id: rid(), expected_revision: env.revision, changes: { proxy: { port: 1082 } } }, WEB);
    h.app.executor.start();
    await h.idle();
    expect(h.repos.operations.get(u1.operation_id)!.phase).toBe('SUPERSEDED');
    expect(h.repos.operations.get(u2.operation_id)!.phase).toBe('READY_FOR_NEXT_OPEN');
    expect(h.repos.environments.get(env.id)!.deployedProxyRevision).toBe(3);
    expect(h.repos.deployments.latest()!.nodeManifest.map((m) => m.proxyRevision)).not.toContain(2);
  });
});

describe('roles and masking', () => {
  test('agent snapshot masks login identifiers; accountDetail is web/admin only', async () => {
    h = await createHarness();
    const a = await createEnv(h, 'US-Buyer-01', '203.0.113.10', { login: 'buyer01@example.test' });
    const snap = await h.app.snapshot(AGENT);
    expect(JSON.stringify(snap)).not.toContain('buyer01@example.test');
    expect(snap.environments[0]!.account.loginIdentifierMasked).toBe('b*****1@example.test');
    await expectError(h.app.accountDetail(a.environment_id!, AGENT), 'BAD_REQUEST');
    expect((await h.app.accountDetail(a.environment_id!, WEB)).loginIdentifier).toBe('buyer01@example.test');
    expect((await h.app.accountDetail(a.environment_id!, ADMIN)).loginIdentifier).toBe('buyer01@example.test');
    const ops = await h.app.listOperations(50, AGENT);
    expect(JSON.stringify(ops)).not.toContain('buyer01@example.test');
  });

  test('issueLoginCode only for admin', async () => {
    h = await createHarness();
    await expectError(h.app.issueLoginCode(AGENT), 'BAD_REQUEST');
    await expectError(h.app.issueLoginCode(WEB), 'BAD_REQUEST');
    expect((await h.app.issueLoginCode(ADMIN)).url).toContain('/auth/exchange');
  });

  test('snapshot carries demoMode false and the event sequence', async () => {
    h = await createHarness();
    await createEnv(h, 'US-Buyer-01', '203.0.113.10');
    const snap = await h.app.snapshot(WEB);
    expect(snap.demoMode).toBe(false);
    expect(snap.sequence).toBe(h.app.events.currentSequence());
    expect(snap.capabilities).toHaveLength(CAPABILITY_KEYS.length);
    expect(snap.capabilities).toHaveLength(19);
    expect(snap.capabilities.map((c) => c.key)).not.toContain('bridge_keychain_access');
    expect(snap.settings.workingProfilePath).toBe(h.profilePath);
  });

  test('binding view shows only the profile id prefix', async () => {
    h = await createHarness();
    const a = await createEnv(h, 'US-Buyer-01', '203.0.113.10');
    await bind(h, PROFILE_A, a.environment_id!);
    const v = await h.app.getEnvironment(a.environment_id!, WEB);
    expect(v.binding.profileIdShort).toBe(PROFILE_A.slice(0, 8));
    expect(JSON.stringify(v)).not.toContain(PROFILE_A);
  });
});
