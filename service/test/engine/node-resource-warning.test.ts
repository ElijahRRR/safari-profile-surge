// 节点资源未确认（D10 的路由警告 node_resource_unverified）：使用中的路由不再“受控”，但进入普通模式永远可用（CLAUDE.md、
// docs/ARCHITECTURE.md §6.5）——受理从不按这一警告拒绝，执行照常撤销本应用入口。只用合成数据。

import { afterEach, describe, expect, test } from 'vitest';
import { ROUTE_GROUP_NAME, type ActivateRequest, type RollbackResult } from '@sfe/contract';
import { readNeedsRefresh } from '../../src/resource/index.js';
import { PROFILE_A, PROFILE_B, WEB, activeEnv, bind, createEnv, createHarness, rid, safariOutcome, verify, type Harness } from './harness.js';

let h: Harness;

afterEach(async () => {
  await h?.close();
});

describe('node_resource_unverified never blocks normal mode', () => {
  test.each(['ruleset_resource', 'temp_rule'] as const)(
    '%s: an otherwise verified route with the warning is not in control; normal mode is offered, accepted and completes on the original rules',
    async (entryStrategy) => {
      h = await createHarness({ entryStrategy });
      const { envId } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
      const before = h.repos.routeState.get();
      expect(before.phase).toBe('active_verified');
      // 对照：没有警告时受控（有效的实测出口、已验证阶段）
      expect(await h.app.ensureInControl()).toEqual({ ok: true, reason: null, checked: true });
      // 只加上节点资源未确认的警告（阶段仍是 active_verified）：不受控只能来自这一警告
      h.repos.routeState.update({ warnings: [...before.warnings, 'node_resource_unverified'] });
      const control = await h.app.ensureInControl();
      expect(control.ok).toBe(false);
      expect(control.checked).toBe(true);
      expect(control.reason).toContain('node_resource_unverified');
      // 对账保留警告；服务端视图与扩展摘要仍提供进入普通模式
      expect(h.repos.routeState.get().warnings).toContain('node_resource_unverified');
      expect(h.app.views.routeView().normalModeOffered).toBe(true);
      const state = (await h.native(PROFILE_A, { type: 'getCurrentState' })) as { ok: boolean; data: { routeSummary: { normalModeOffered: boolean } } };
      expect(state.ok).toBe(true);
      expect(state.data.routeSummary.normalModeOffered).toBe(true);
      const n = await h.app.enterNormal({ request_id: rid('normal'), old_session_policy: 'closed_confirmed', confirmed_environment_id: envId }, WEB);
      await h.idle();
      const op = h.repos.operations.get(n.operation_id)!;
      expect(op.error).toBeNull();
      expect(op).toMatchObject({ phase: 'NORMAL_RESTORED', status: 'succeeded' });
      expect(h.repos.routeState.get()).toMatchObject({ entryMode: 'NORMAL', phase: 'idle', activeEnvironmentId: null });
      // 普通模式不清除它（与 managed_segments_changed 一样保留）：只有经确认的节点资源读回才清除
      expect(h.repos.routeState.get().warnings).toContain('node_resource_unverified');
      // Safari 按原规则发出（不是 DIRECT 或 FINAL 的复制，也不经 SFE-ROUTE）
      expect(safariOutcome(h, 'daily.example.test').policyName).toBe('Daily');
    },
  );
});

async function startSwitch(env: string, extra: Partial<ActivateRequest> = {}): Promise<string> {
  const route = h.repos.routeState.get();
  const req: ActivateRequest = { request_id: rid('act'), old_session_policy: 'closed_confirmed', confirmed_environment_id: route.activeEnvironmentId, ...extra };
  const a = await h.app.activate(env, req, WEB);
  await h.idle();
  return a.operation_id;
}

function addWarning(): void {
  const route = h.repos.routeState.get();
  h.repos.routeState.update({ warnings: [...route.warnings, 'node_resource_unverified'] });
}

describe('node_resource_unverified and activation', () => {
  test('a new activation is refused before any write while the warning is set; the route stays as it was', async () => {
    h = await createHarness();
    const { envId: a } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const b = (await createEnv(h, 'US-Buyer-B', '203.0.113.11')).environment_id!;
    await bind(h, PROFILE_B, b);
    const nodeA = h.repos.proxyRevisions.get(a, 1)!.nodeName;
    addWarning();
    const epoch = h.repos.routeState.get().routeEpoch;
    const selects = h.fake.calls.selectGroupPolicy ?? 0;
    const opId = await startSwitch(b);
    const op = h.repos.operations.get(opId)!;
    expect(op).toMatchObject({ phase: 'FAILED', status: 'failed' });
    expect(op.error).toMatchObject({ code: 'NODE_NOT_DEPLOYED', details: { reason: 'node_resource_unverified' } });
    expect(op.error!.message).toContain('路由未改变');
    expect(h.fake.calls.selectGroupPolicy ?? 0).toBe(selects);
    expect(h.repos.routeState.get()).toMatchObject({ activeEnvironmentId: a, selectedNode: nodeA, entryMode: 'ACTIVE', routeEpoch: epoch });
    expect(await h.fake.getGroupSelection(ROUTE_GROUP_NAME)).toBe(nodeA);
    expect(h.repos.routeState.get().warnings).toContain('node_resource_unverified');
  });

  test.each([false, true])('activation rollback with the warning %s: restores the previous buyer node only without it, otherwise holds REJECT and keeps the warning', async (warned) => {
    h = await createHarness();
    const { envId: a } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const b = (await createEnv(h, 'US-Buyer-B', '203.0.113.11')).environment_id!;
    await bind(h, PROFILE_B, b);
    const nodeA = h.repos.proxyRevisions.get(a, 1)!.nodeName;
    const opId = await startSwitch(b);
    expect(h.repos.routeState.get()).toMatchObject({ phase: 'awaiting_safari_verify', entryMode: 'VERIFY_ONLY' });
    // 等待实测期间对账发现节点资源无法确认（这里直接设警告）；实测失败（Safari 没有经检测入口发出请求）→ 第 14 步回滚
    if (warned) addWarning();
    await verify(h, PROFILE_B, opId, { simulate: false });
    const op = h.repos.operations.get(opId)!;
    expect(op).toMatchObject({ phase: 'FAILED', status: 'failed' });
    const rollback = (op.result as { rollback: RollbackResult }).rollback;
    const route = h.repos.routeState.get();
    expect(route).toMatchObject({ entryMode: 'BLOCKED', activeEnvironmentId: a });
    if (!warned) {
      expect(rollback).toMatchObject({ previousEnvironmentId: a, restoredSelection: nodeA, needsReverify: true });
      expect(route).toMatchObject({ phase: 'failed', selectedNode: nodeA });
      expect(route.warnings).toContain('rollback_needs_reverify');
      expect(await h.fake.getGroupSelection(ROUTE_GROUP_NAME)).toBe(nodeA);
      return;
    }
    expect(rollback).toMatchObject({ previousEnvironmentId: null, restoredSelection: null, needsReverify: false, rejectKept: true });
    expect(route).toMatchObject({ phase: 'attention', selectedNode: 'REJECT' });
    expect(route.warnings).toContain('node_resource_unverified');
    expect(route.warnings).not.toContain('rollback_needs_reverify');
    expect(await h.fake.getGroupSelection(ROUTE_GROUP_NAME)).toBe('REJECT');
    expect(h.repos.operations.listSteps(opId).map((st) => st.message).join('；')).toContain('节点资源未确认');
    // Safari 保持阻断；进入普通模式照常可用，并保留警告
    expect(safariOutcome(h).failed).toBe(true);
    expect(h.app.views.routeView().normalModeOffered).toBe(true);
    const n = await h.app.enterNormal({ request_id: rid('normal'), old_session_policy: 'closed_confirmed', confirmed_environment_id: a }, WEB);
    await h.idle();
    expect(h.repos.operations.get(n.operation_id)).toMatchObject({ phase: 'NORMAL_RESTORED', status: 'succeeded' });
    expect(h.repos.routeState.get().warnings).toContain('node_resource_unverified');
  });

  test('the warning set during the Safari check wait: the passing check is not committed (no ACTIVE), the route holds REJECT', async () => {
    h = await createHarness();
    const { envId: a } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const b = (await createEnv(h, 'US-Buyer-B', '203.0.113.11')).environment_id!;
    await bind(h, PROFILE_B, b);
    const opId = await startSwitch(b);
    addWarning();
    await verify(h, PROFILE_B, opId);
    const op = h.repos.operations.get(opId)!;
    expect(op).toMatchObject({ phase: 'FAILED', status: 'failed' });
    expect(op.error).toMatchObject({ code: 'NODE_NOT_DEPLOYED' });
    expect(op.error!.message).toContain('节点资源未确认');
    const route = h.repos.routeState.get();
    expect(route).toMatchObject({ entryMode: 'BLOCKED', activeEnvironmentId: a, selectedNode: 'REJECT', phase: 'attention' });
    expect(route.warnings).toContain('node_resource_unverified');
    expect(h.repos.environments.get(b)!.lastVerifiedProxyRevision).toBeNull();
    expect(await h.fake.getGroupSelection(ROUTE_GROUP_NAME)).toBe('REJECT');
  });
});

describe('the warning always comes with a way to clear it (a refresh requirement)', () => {
  const systemRefreshOps = () => h.repos.operations.listRecent(100).filter((o) => o.kind === 'deploy.publish' && o.initiatorKind === 'service' && o.payload.forceRefresh === true);
  const updates = () => h.fake.calls.updateExternalResource ?? 0;

  test('regression: one transient read without our resource → warning with needsRefresh → one system refresh → its confirmed readback clears both', async () => {
    // temp_rule：读入口不读外部资源，对账中读外部资源的只有节点资源检查
    h = await createHarness({ entryStrategy: 'temp_rule' });
    const a = (await createEnv(h, 'US-Buyer-A', '203.0.113.10')).environment_id!;
    await h.idle();
    const before = updates();
    // 一次对账读到的外部资源列表里没有本应用的资源（例如 Surge 正在重载）
    h.fake.lieOnNext('listExternalResources', []);
    await h.app.runPeriodicReconcile();
    // 对账设下警告（系统刷新随即排入；它可能已经开始执行，所以这里看对账的记录）
    const rec = h.repos.operations.listRecent(50).find((o) => o.kind === 'maintenance.reconcile' && (o.payload.added as string[] | undefined)?.includes('node_resource_unverified'));
    expect(rec).toBeDefined();
    expect(systemRefreshOps()).toHaveLength(1);
    expect(systemRefreshOps()[0]!.payload).toMatchObject({ systemRefresh: 'needs_refresh' });
    await h.idle();
    expect(systemRefreshOps()).toHaveLength(1);
    expect(systemRefreshOps()[0]).toMatchObject({ phase: 'COMPLETED', status: 'succeeded' });
    expect(updates() - before).toBe(1);
    expect(h.repos.routeState.get().warnings).not.toContain('node_resource_unverified');
    expect(readNeedsRefresh(h.app.engine.kv)).toBeNull();
    // 之后激活不再因节点资源未确认被拒绝
    await bind(h, PROFILE_A, a);
    const act = await h.app.activate(a, { request_id: rid('act') }, WEB);
    await h.idle();
    expect(h.repos.operations.get(act.operation_id)!.error?.code).not.toBe('NODE_NOT_DEPLOYED');
  });

  test('regression: an explicit publish with nothing pending never takes the no-op shortcut while the warning is set', async () => {
    h = await createHarness();
    await createEnv(h, 'US-Buyer-A', '203.0.113.10');
    await h.idle();
    // 升级之前（或令牌一度读不到时）设下、没有刷新要求的警告
    addWarning();
    expect(readNeedsRefresh(h.app.engine.kv)).toBeNull();
    const before = updates();
    const p = await h.app.publishPending({ request_id: rid('pub') }, WEB);
    await h.idle();
    expect(h.repos.operations.get(p.operation_id)).toMatchObject({ phase: 'COMPLETED', status: 'succeeded' });
    expect(updates() - before).toBe(1);
    expect(h.repos.routeState.get().warnings).not.toContain('node_resource_unverified');
  });

  test('regression: a warning persisted across a restart without a refresh requirement gets one at startup and is cleared by the system refresh', async () => {
    h = await createHarness({ dbFile: true });
    await createEnv(h, 'US-Buyer-A', '203.0.113.10');
    await h.idle();
    addWarning();
    expect(readNeedsRefresh(h.app.engine.kv)).toBeNull();
    const before = updates();
    await h.crash();
    await h.idle();
    expect(systemRefreshOps().filter((o) => o.status === 'succeeded')).toHaveLength(1);
    expect(updates() - before).toBe(1);
    expect(h.repos.routeState.get().warnings).not.toContain('node_resource_unverified');
    expect(readNeedsRefresh(h.app.engine.kv)).toBeNull();
  });
});
