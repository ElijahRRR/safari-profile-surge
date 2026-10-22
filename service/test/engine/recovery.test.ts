import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { NODE_RESOURCE_FILE, ROUTE_GROUP_NAME } from '@sfe/contract';
import { FAKE_VERIFY_HOST } from '../../src/surge/fake.js';
import { PROFILE_A, PROFILE_B, PROFILE_C, WEB, activeEnv, bind, createEnv, createHarness, rid, safariOutcome, verify, type Harness } from './harness.js';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

/** 让某个 FakeSurge 原语挂起（模拟进程在调用中途崩溃）。 */
function hang(name: 'updateExternalResource' | 'selectGroupPolicy' | 'getGroupMembers', when: (...args: string[]) => boolean = () => true): { entered: () => boolean; restore: () => void } {
  const fake = h.fake as unknown as Record<string, (...args: string[]) => Promise<unknown>>;
  const orig = fake[name]!.bind(h.fake);
  let entered = false;
  fake[name] = (...args: string[]) => {
    if (!when(...args)) return orig(...args);
    entered = true;
    return new Promise(() => undefined);
  };
  return {
    entered: () => entered,
    restore: () => {
      fake[name] = orig;
    },
  };
}

/**
 * 让 ruleset_resource 的入口写入挂在“等待 Surge 重新加载”上（模拟进程在写入文件之后、读回确认之前崩溃）：
 * 只拦截刚写入、尚未被 Surge 加载的那一版见证的 rule match（载入时对已加载见证的读回照常）。bit 为空时任一入口文件。
 */
function hangEntryWrite(bit?: string): { entered: () => boolean; restore: () => void } {
  const fake = h.fake as unknown as { matchRule: (input: { host: string }) => Promise<unknown> };
  const orig = fake.matchRule.bind(h.fake);
  let entered = false;
  fake.matchRule = (input: { host: string }) => {
    const m = /^sfe-entry-(udp|verify|block|active)-[0-9a-z]+\.invalid$/.exec(input.host);
    const loaded = m ? (h.fake.loadedContent(`ruleset:sfe-entry-${m[1]}.list`) ?? '').includes(input.host) : true;
    if (!m || loaded || (bit !== undefined && m[1] !== bit)) return orig(input);
    entered = true;
    return new Promise(() => undefined);
  };
  return {
    entered: () => entered,
    restore: () => {
      fake.matchRule = orig;
    },
  };
}

async function until(cond: () => boolean): Promise<void> {
  const end = Date.now() + 5000;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 2));
  expect(cond()).toBe(true);
}

function nodeNames(): string[] {
  return readFileSync(join(h.surgeDir, NODE_RESOURCE_FILE), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '' && !l.startsWith('#'))
    .map((l) => l.split('=')[0]!.trim());
}

describe('crash recovery (same SQLite file, same Surge)', () => {
  test('crash while waiting for Surge to re-read the resource → FAILED UNKNOWN_STATE; next publish converges without duplicate nodes', async () => {
    h = await createHarness({ dbFile: true });
    const envId = (await createEnv(h, 'US-Buyer-A', '203.0.113.10')).environment_id!;
    // 写入节点资源之后第一次读组成员就是等待重新读取（写入之前另读一次组成员作为对照）；发布从不调用外部资源更新
    // （Surge 6.10 跳过本地资源）
    const resourceBefore = readFileSync(join(h.surgeDir, NODE_RESOURCE_FILE), 'utf8');
    const stuck = hang('getGroupMembers', () => readFileSync(join(h.surgeDir, NODE_RESOURCE_FILE), 'utf8') !== resourceBefore);
    const env = h.repos.environments.get(envId)!;
    const upd = await h.app.updateEnvironment(envId, { request_id: rid(), expected_revision: env.revision, changes: { proxy: { port: 1081 } } }, WEB);
    await until(stuck.entered);
    expect(h.repos.operations.get(upd.operation_id)!.phase).toBe('DEPLOYING');
    stuck.restore();
    await h.crash();
    await h.idle();
    const op = h.repos.operations.get(upd.operation_id)!;
    expect(op.phase).toBe('FAILED');
    expect(op.error?.code).toBe('UNKNOWN_STATE');
    expect(h.repos.environments.get(envId)!.deployedProxyRevision).toBe(1);
    // 待部署的修改保留，由一次发布收敛
    const pub = await h.app.publishPending({ request_id: rid() }, WEB);
    await h.idle();
    expect(h.repos.operations.get(pub.operation_id)!.phase).toBe('READY_FOR_NEXT_OPEN');
    expect(h.repos.environments.get(envId)!.deployedProxyRevision).toBe(2);
    const names = nodeNames();
    expect(new Set(names).size).toBe(names.length);
    expect(h.fake.calls.reloadProfile ?? 0).toBe(0);
    expect(h.fake.calls.updateExternalResource ?? 0).toBe(0);
  });

  test('crash mid-switch → rollback from the activation snapshot; selection never left on an unverified exit', async () => {
    h = await createHarness({ dbFile: true });
    const envId = (await createEnv(h, 'US-Buyer-A', '203.0.113.10')).environment_id!;
    await bind(h, PROFILE_A, envId);
    const stuck = hang('selectGroupPolicy', (_g, p) => p !== 'REJECT');
    const a = await h.app.activate(envId, { request_id: rid() }, WEB);
    await until(stuck.entered);
    expect(h.repos.routeState.get().entryMode).toBe('BLOCKED');
    stuck.restore();
    await h.crash();
    await h.idle();
    const op = h.repos.operations.get(a.operation_id)!;
    expect(['FAILED', 'BLOCKED_NEEDS_ATTENTION']).toContain(op.phase);
    expect(op.error?.code).toBe('UNKNOWN_STATE');
    expect(await h.fake.getGroupSelection(ROUTE_GROUP_NAME)).toBe('REJECT');
    expect(h.repos.routeState.get().activeEnvironmentId).toBeNull();
    // 之后的显式激活可以完成
    const again = await h.app.activate(envId, { request_id: rid() }, WEB);
    await h.idle();
    await verify(h, PROFILE_A, again.operation_id);
    expect(h.repos.operations.get(again.operation_id)!.phase).toBe('ACTIVE_VERIFIED');
  });

  /** A 使用中，B 已部署并关联；B 的激活挂在某次规则集刷新上时崩溃。 */
  async function crashMidSwitchToB(bit: string | undefined, opts: { deferPreflight?: boolean } = {}) {
    const { envId: a } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const b = (await createEnv(h, 'US-Buyer-B', '203.0.113.11')).environment_id!;
    await bind(h, PROFILE_B, b);
    if (opts.deferPreflight) h.revoke(['independent_node_preflight']);
    const epoch = h.repos.routeState.get().routeEpoch;
    const stuck = hangEntryWrite(bit);
    const act = await h.app.activate(b, { request_id: rid(), old_session_policy: 'closed_confirmed', confirmed_environment_id: a }, WEB);
    await until(stuck.entered);
    const op = h.repos.operations.get(act.operation_id)!;
    stuck.restore();
    return { a, b, epoch, opId: act.operation_id, phaseAtCrash: op.phase, stageAtCrash: (op.payload as { route: { stage: string } }).route.stage };
  }

  test('crash during the BLOCKED write while the op phase is still PREFLIGHT_OK → rolled back, writes not replayed', async () => {
    h = await createHarness({ dbFile: true });
    const { a, epoch, opId, phaseAtCrash, stageAtCrash } = await crashMidSwitchToB(undefined);
    // 操作阶段还停在写入前的值，但 epoch 已递增、切换已开始
    expect(phaseAtCrash).toBe('PREFLIGHT_OK');
    expect(stageAtCrash).toBe('switching');
    await h.crash();
    await h.idle();
    const op = h.repos.operations.get(opId)!;
    expect(op.phase).toBe('FAILED');
    expect(op.error?.code).toBe('UNKNOWN_STATE');
    expect(h.repos.operations.listSteps(opId).some((s) => s.phase === 'VERIFY_ONLY')).toBe(false);
    const route = h.repos.routeState.get();
    expect(route.routeEpoch).toBe(epoch + 1);
    expect(route).toMatchObject({ phase: 'failed', entryMode: 'BLOCKED', activeEnvironmentId: a, selectedNode: h.repos.proxyRevisions.get(a, 1)!.nodeName });
    expect(route.warnings).toContain('rollback_needs_reverify');
    expect(safariOutcome(h).failed).toBe(true);
    expect(h.fake.calls.reloadProfile ?? 0).toBe(0);
  });

  test('crash after the deferred preflight (op phase back at PREFLIGHT_OK, target node selected) → rolled back to the previous node', async () => {
    h = await createHarness({ dbFile: true });
    const { a, b, epoch, opId, phaseAtCrash } = await crashMidSwitchToB('verify', { deferPreflight: true });
    expect(phaseAtCrash).toBe('PREFLIGHT_OK');
    expect(await h.fake.getGroupSelection(ROUTE_GROUP_NAME)).toBe(h.repos.proxyRevisions.get(b, 1)!.nodeName);
    await h.crash();
    await h.idle();
    const op = h.repos.operations.get(opId)!;
    expect(op.phase).toBe('FAILED');
    expect(h.repos.operations.listSteps(opId).filter((s) => s.message.includes('开始检查激活条件'))).toHaveLength(1);
    const route = h.repos.routeState.get();
    expect(route.routeEpoch).toBe(epoch + 1);
    const nodeA = h.repos.proxyRevisions.get(a, 1)!.nodeName;
    expect(route).toMatchObject({ phase: 'failed', entryMode: 'BLOCKED', activeEnvironmentId: a, selectedNode: nodeA });
    expect(await h.fake.getGroupSelection(ROUTE_GROUP_NAME)).toBe(nodeA);
    expect(safariOutcome(h, FAKE_VERIFY_HOST).failed).toBe(true);
  });

  /**
   * A 使用中，B 停在 VERIFY_ONLY 等待；C 取代 B 后在写入前失败，按快照回滚时挂在回滚的阻断写入上崩溃。
   * C 的 stage 仍是 pending、routeEpoch 仍为空（epoch 是 supersedeWaiting 递增的路由 epoch）。
   */
  async function crashDuringSupersedingRollback() {
    const { envId: a } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const b = (await createEnv(h, 'US-Buyer-B', '203.0.113.11')).environment_id!;
    await bind(h, PROFILE_B, b);
    const c = (await createEnv(h, 'US-Buyer-C', '203.0.113.12')).environment_id!;
    await bind(h, PROFILE_C, c);
    const first = await h.app.activate(b, { request_id: rid(), old_session_policy: 'closed_confirmed', confirmed_environment_id: a }, WEB);
    await h.idle();
    expect(h.repos.operations.get(first.operation_id)!.phase).toBe('VERIFY_ONLY');
    const stuck = hangEntryWrite();
    h.fake.failNext('getGroupMembers');
    const second = await h.app.activate(c, { request_id: rid(), old_session_policy: 'closed_confirmed', confirmed_environment_id: a }, WEB);
    await until(stuck.entered);
    const op = h.repos.operations.get(second.operation_id)!;
    expect(op.phase).toBe('ROLLING_BACK');
    expect(op.routeEpoch).toBeNull();
    expect((op.payload as { route: { stage: string } }).route.stage).toBe('pending');
    expect(h.repos.routeState.get()).toMatchObject({ phase: 'rolling_back', operationId: second.operation_id });
    stuck.restore();
    return { a, b, c, opId: second.operation_id };
  }

  test('crash during the rollback of a superseding activation that failed before writing → rollback resumed, switch never replayed', async () => {
    h = await createHarness({ dbFile: true });
    const { a, c, opId } = await crashDuringSupersedingRollback();
    const nodeA = h.repos.proxyRevisions.get(a, 1)!.nodeName;
    const nodeC = h.repos.proxyRevisions.get(c, 1)!.nodeName;
    const selects = h.fake.calls.selectGroupPolicy ?? 0;
    await h.crash();
    await h.idle();
    const op = h.repos.operations.get(opId)!;
    expect(op.phase).toBe('FAILED');
    expect(op.error?.code).toBe('UNKNOWN_STATE');
    const steps = h.repos.operations.listSteps(opId);
    expect(steps.filter((s) => s.message.includes('开始检查激活条件'))).toHaveLength(1);
    expect(steps.some((s) => s.phase === 'SAFARI_BLOCKED' || s.phase === 'VERIFY_ONLY')).toBe(false);
    // 只恢复切换前的节点，从不选择 C 的节点
    expect((h.fake.calls.selectGroupPolicy ?? 0) - selects).toBe(1);
    expect(await h.fake.getGroupSelection(ROUTE_GROUP_NAME)).toBe(nodeA);
    expect(await h.fake.getGroupSelection(ROUTE_GROUP_NAME)).not.toBe(nodeC);
    const route = h.repos.routeState.get();
    expect(route).toMatchObject({ phase: 'failed', entryMode: 'BLOCKED', activeEnvironmentId: a, selectedNode: nodeA, operationId: opId });
    expect(route.warnings).toContain('rollback_needs_reverify');
    expect(safariOutcome(h, FAKE_VERIFY_HOST).failed).toBe(true);
    expect(safariOutcome(h).failed).toBe(true);
    expect(h.fake.calls.reloadProfile ?? 0).toBe(0);
  });

  test('…and when the resumed rollback cannot restore the previous node, the entry still ends BLOCKED (never VERIFY_ONLY on an unverified exit)', async () => {
    h = await createHarness({ dbFile: true });
    const { opId } = await crashDuringSupersedingRollback();
    h.fake.failNext('getGroupMembers');
    await h.crash();
    await h.idle();
    const op = h.repos.operations.get(opId)!;
    expect(op.phase).toBe('BLOCKED_NEEDS_ATTENTION');
    const route = h.repos.routeState.get();
    expect(route).toMatchObject({ phase: 'attention', entryMode: 'BLOCKED', operationId: opId });
    expect(route.warnings).toContain('entry_unverified');
    expect(safariOutcome(h, FAKE_VERIFY_HOST).failed).toBe(true);
    expect(safariOutcome(h).failed).toBe(true);
  });

  test('VERIFY_ONLY waiting operation survives a restart and completes', async () => {
    h = await createHarness({ dbFile: true });
    const envId = (await createEnv(h, 'US-Buyer-A', '203.0.113.10')).environment_id!;
    await bind(h, PROFILE_A, envId);
    const a = await h.app.activate(envId, { request_id: rid() }, WEB);
    await h.idle();
    expect(h.repos.operations.get(a.operation_id)!.phase).toBe('VERIFY_ONLY');
    await h.crash();
    await h.idle();
    expect(h.repos.operations.get(a.operation_id)!.phase).toBe('VERIFY_ONLY');
    const r = await verify(h, PROFILE_A, a.operation_id);
    expect(r.ok).toBe(true);
    expect(h.repos.operations.get(a.operation_id)!.phase).toBe('ACTIVE_VERIFIED');
  });

  test('verification deadline still fires after a restart → rollback', async () => {
    h = await createHarness({ dbFile: true });
    const envId = (await createEnv(h, 'US-Buyer-A', '203.0.113.10')).environment_id!;
    await bind(h, PROFILE_A, envId);
    const a = await h.app.activate(envId, { request_id: rid() }, WEB);
    await h.idle();
    const begin = await h.native(PROFILE_A, { type: 'beginSafariVerification', operation_id: a.operation_id, amazon_tabs_open: false });
    expect(begin.ok).toBe(true);
    await h.crash();
    await h.clock.advanceAsync((h.repos.settings.get('safariVerifyTimeoutSec') + 5) * 1000);
    await h.idle();
    const op = h.repos.operations.get(a.operation_id)!;
    expect(op.phase).toBe('FAILED');
    expect(op.error?.code).toBe('SAFARI_VERIFY_TIMEOUT');
    // 原来是 NORMAL：保持 BLOCKED 并失败（§6.3.14），Safari 全部拒绝，没有活动环境
    const route = h.repos.routeState.get();
    expect(route.entryMode).toBe('BLOCKED');
    expect(route.activeEnvironmentId).toBeNull();
    expect(safariOutcome(h).failed).toBe(true);
  });

  test('active environment stays active across a restart (no writes on startup)', async () => {
    h = await createHarness({ dbFile: true });
    const { envId } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const writes = ['updateExternalResource', 'selectGroupPolicy', 'killRequest', 'reloadProfile'].map((k) => h.fake.calls[k] ?? 0);
    await h.crash();
    await h.idle();
    expect(['updateExternalResource', 'selectGroupPolicy', 'killRequest', 'reloadProfile'].map((k) => h.fake.calls[k] ?? 0)).toEqual(writes);
    const route = h.repos.routeState.get();
    expect(route.activeEnvironmentId).toBe(envId);
    expect(route.phase).toBe('active_verified');
  });

  test('startup sweep removes stale pending secret refs left by a crash', async () => {
    h = await createHarness({ dbFile: true });
    // 崩溃发生在“钥匙串已写入、主事务未提交”之间
    h.repos.tx(() => h.repos.secretRefs.insertPending({ ref: 'sec_stale0001', kind: 'proxy', ownerKind: 'proxy_revision', ownerId: 'env_x', createdAt: h.clock.now().toISOString() }));
    await h.store.put('sec_stale0001', 'synth-stale-value', 'proxy');
    h.clock.advance(11 * 60 * 1000);
    await h.crash();
    await h.idle();
    for (let i = 0; i < 50 && h.store.has('sec_stale0001'); i++) await new Promise((r) => setImmediate(r));
    expect(h.store.has('sec_stale0001')).toBe(false);
    expect(h.repos.secretRefs.get('sec_stale0001')).toBeNull();
  });
});
