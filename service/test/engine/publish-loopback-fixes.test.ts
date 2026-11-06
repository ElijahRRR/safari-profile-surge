// 回环发布（D10）复核修正的回归测试：进入普通模式不被正在等待的发布拖住（第一次写入 Surge 之前让出）；回滚从不改回外部修改的
// 选择；回滚之前重读 Surge 是否仍在更新；回滚先撤回资源服务的候选版本；T2 事务失败时回滚、资源服务不提交候选、确认的副作用
// 不发生；崩溃中断的系统刷新重排一次。只用合成数据。

import { afterEach, describe, expect, test } from 'vitest';
import { ROUTE_GROUP_NAME } from '@sfe/contract';
import type { OperationRecord } from '../../src/db/index.js';
import { SYSTEM_REFRESH_KEY, maybeEnqueueSystemRefresh } from '../../src/engine/node-resource.js';
import { writeNeedsRefresh } from '../../src/resource/index.js';
import { PROFILE_A, WEB, activeEnv, createEnv, createHarness, envInput, rid, type Harness } from './harness.js';
import { dropNodesOnNextUpdate, hangAt, nodes, pointer, served, until, updates } from './publish-helpers.js';
import { fetchResource } from './resource-fixtures.js';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

const op = (id: string) => h.repos.operations.get(id)!;
const nodeOf = (envId: string, revision = 1) => h.repos.proxyRevisions.get(envId, revision)!.nodeName;

function systemRefreshOps(): OperationRecord[] {
  return h.repos.operations.listRecent(200).filter((o) => o.kind === 'deploy.publish' && o.initiatorKind === 'service' && o.payload.forceRefresh === true);
}

describe('normal mode is never held back by a publish waiting before its first write', () => {
  test('regression: a normal mode accepted while a publish waits in discovery (Surge updating) runs before that publish\'s update; the publish completes afterwards', async () => {
    h = await createHarness({ resourceUpdateWait: { timeoutMs: 30_000, pollMs: 500, settleMs: 0 } });
    const { envId: a } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    // Surge 自己的刷新进行中（20 秒）：发布在暂存之前等待它结束
    h.fake.slowUpdate = { durationMs: 20_000 };
    h.fake.runScheduledRefresh(h.resourceKey()!);
    h.fake.slowUpdate = null;
    const updateCalls: Array<{ normalDone: boolean }> = [];
    const orig = h.fake.updateExternalResource.bind(h.fake);
    let normalId: string | null = null;
    h.fake.updateExternalResource = async (key: string) => {
      updateCalls.push({ normalDone: normalId !== null && op(normalId).status === 'succeeded' });
      return orig(key);
    };
    const b = await h.app.createEnvironment({ request_id: rid(), environment: envInput('US-Buyer-B', '203.0.113.11') }, WEB);
    // 发布进入等待（VALIDATING）后受理普通模式
    await until(() => h.logs.some((l) => l.includes('"msg":"resource.served"')) || op(b.operation_id).phase === 'VALIDATING');
    for (let i = 0; i < 50 && op(b.operation_id).phase !== 'VALIDATING'; i++) await new Promise((r) => setTimeout(r, 2));
    expect(op(b.operation_id).phase).toBe('VALIDATING');
    const n = await h.app.enterNormal({ request_id: rid('normal'), old_session_policy: 'closed_confirmed', confirmed_environment_id: a }, WEB);
    normalId = n.operation_id;
    const acceptedAt = h.clock.now().getTime();
    for (let i = 0; i < 2_000 && (['queued', 'running'].includes(op(b.operation_id).status) || ['queued', 'running'].includes(op(n.operation_id).status)); i++) {
      await new Promise((r) => setTimeout(r, 2));
      await h.clock.advanceAsync(500);
    }
    await h.idle();
    expect(op(n.operation_id)).toMatchObject({ phase: 'NORMAL_RESTORED', status: 'succeeded' });
    // 普通模式在发布的第一次写入之前完成；发布让出之后重新执行并完成
    expect(updateCalls.length).toBeGreaterThanOrEqual(1);
    expect(updateCalls[0]!.normalDone).toBe(true);
    const yieldStep = h.repos.operations.listSteps(b.operation_id).find((s) => s.message.includes('让给排队的普通模式'));
    expect(yieldStep).toBeDefined();
    // 让出发生在发现阶段的等待中（一次轮询之内），不是等 Surge 的 20 秒刷新结束之后在第一次写入之前才让出
    expect(Date.parse(yieldStep!.at) - acceptedAt).toBeLessThanOrEqual(2_000);
    expect(op(b.operation_id).status).toBe('succeeded');
    expect(await nodes(h)).toEqual([nodeOf(a), nodeOf(b.environment_id!)]);
    expect(h.repos.routeState.get()).toMatchObject({ entryMode: 'NORMAL', phase: 'idle' });
  });
});

describe('a publish batch that yields to normal mode is re-queued as a whole', () => {
  test('regression: a yielded batch with a merged member, then a publish accepted during the wait is claimed first → every op ends, every revision is deployed, the system refresh is not blocked', async () => {
    h = await createHarness();
    const { envId: a } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const orig = h.fake.listExternalResources.bind(h.fake);
    // 两个闸门：B 的发布在发现阶段停住（期间保存 C 与 D）；C 的批次（合并了 D）在发现阶段停住（期间保存 E 并受理普通模式）
    let gate1: (() => void) | null = null;
    let gate2: (() => void) | null = null;
    let armed1 = true;
    let cId: string | null = null;
    h.fake.listExternalResources = async () => {
      if (armed1) {
        armed1 = false;
        await new Promise<void>((r) => (gate1 = r));
      }
      if (gate2 === null && cId !== null && op(cId).status === 'running') await new Promise<void>((r) => (gate2 = r));
      return orig();
    };
    const b = await h.app.createEnvironment({ request_id: rid(), environment: envInput('US-Buyer-B', '203.0.113.11') }, WEB);
    await until(() => gate1 !== null);
    const c = await h.app.createEnvironment({ request_id: rid(), environment: envInput('US-Buyer-C', '203.0.113.12') }, WEB);
    const d = await h.app.createEnvironment({ request_id: rid(), environment: envInput('US-Buyer-D', '203.0.113.13') }, WEB);
    cId = c.operation_id;
    gate1!();
    await until(() => gate2 !== null);
    // C 的批次合并了 D
    expect(op(c.operation_id).payload.batchMembers).toEqual([d.operation_id]);
    expect(op(d.operation_id).status).toBe('running');
    const e = await h.app.createEnvironment({ request_id: rid(), environment: envInput('US-Buyer-E', '203.0.113.14') }, WEB);
    const n = await h.app.enterNormal({ request_id: rid('normal'), old_session_policy: 'closed_confirmed', confirmed_environment_id: a }, WEB);
    gate2!();
    await h.idle();
    for (let i = 0; i < 20; i++) {
      await h.clock.advanceAsync(1_000);
      await h.idle();
    }
    h.fake.listExternalResources = orig;
    expect(op(n.operation_id)).toMatchObject({ phase: 'NORMAL_RESTORED', status: 'succeeded' });
    expect(h.repos.operations.listSteps(c.operation_id).some((s) => s.message.includes('让给排队的普通模式'))).toBe(true);
    // 让出之后先被领取的是 E（受理更早），它收回了 C
    expect(op(e.operation_id).payload.batchMembers).toContain(c.operation_id);
    // 让出时清除了 C 上的合并记录：C 被 E 收回后不会再按旧记录收回 D（D 由自己的 outbox 行被合并）
    expect(op(c.operation_id).payload.batchMembers).toBeUndefined();
    for (const x of [b, c, d, e]) {
      expect(op(x.operation_id).status).toBe('succeeded');
      const env = h.repos.environments.get(x.environment_id!)!;
      expect(env.deployedProxyRevision).toBe(env.desiredProxyRevision);
    }
    // 没有留下排队却没有 outbox 行的发布
    expect(h.repos.operations.listByStatus(['queued', 'running'])).toEqual([]);
    for (const x of [b, c, d, e]) expect(h.repos.outbox.pendingForOperation(x.operation_id!)).toEqual([]);
    // 系统刷新没有被永远排队的操作挡住
    writeNeedsRefresh(h.app.engine.kv, { generation: 1, reason: 'synthetic' });
    expect(maybeEnqueueSystemRefresh(h.app.engine)).not.toBeNull();
  });
});

describe('rollback and the SFE-ROUTE selection', () => {
  test('regression: REJECT selected in Surge during a publish stays REJECT after the rollback; the route reports external_selection_change', async () => {
    h = await createHarness();
    const { envId: a } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    expect(h.repos.routeState.get().phase).toBe('active_verified');
    const orig = h.fake.updateExternalResource.bind(h.fake);
    let fired = false;
    h.fake.updateExternalResource = async (key: string) => {
      const r = await orig(key);
      if (!fired) {
        fired = true;
        // 用户在 Surge 中把 SFE-ROUTE 改为 REJECT（紧急停止）
        await h.fake.selectGroupPolicy(ROUTE_GROUP_NAME, 'REJECT');
      }
      return r;
    };
    const selects = h.fake.calls.selectGroupPolicy ?? 0;
    const b = await createEnv(h, 'US-Buyer-B', '203.0.113.11');
    h.fake.updateExternalResource = orig;
    const o = op(b.operation_id);
    expect(o).toMatchObject({ phase: 'FAILED', status: 'failed', error: { code: 'READBACK_MISMATCH' } });
    // 回滚从不改回：选择仍是 REJECT（本服务没有调用 selectGroupPolicy）
    expect(await h.fake.getGroupSelection(ROUTE_GROUP_NAME)).toBe('REJECT');
    // 只有用户自己的那一次选择
    expect(h.fake.calls.selectGroupPolicy ?? 0).toBe(selects + 1);
    expect(h.repos.operations.listSteps(b.operation_id).some((s) => s.message.includes('回滚没有改动它'))).toBe(true);
    const route = h.repos.routeState.get();
    expect(route.warnings).toContain('external_selection_change');
    expect(route.warnings).not.toContain('node_resource_unverified');
    expect(route.phase).toBe('external_change');
    expect(await nodes(h)).toEqual([nodeOf(a)]);
  });

  test('regression: the rollback\'s confirmation transaction fails after confirming the resource → no confirmation side effects (log, audit point); the op needs attention', async () => {
    h = await createHarness();
    await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const orig = h.fake.updateExternalResource.bind(h.fake);
    let fired = false;
    h.fake.updateExternalResource = async (key: string) => {
      const r = await orig(key);
      if (!fired) {
        fired = true;
        await h.fake.selectGroupPolicy(ROUTE_GROUP_NAME, 'REJECT');
      }
      return r;
    };
    // 回滚的确认事务中、confirmNodeResource 之后（noteExternalSelection 记录外部修改时）写入失败：整个事务回滚
    const origUpdate = h.repos.routeState.update.bind(h.repos.routeState);
    let auditAtThrow: unknown = undefined;
    h.repos.routeState.update = ((patch: Parameters<typeof origUpdate>[0]) => {
      if (auditAtThrow === undefined && patch.phase === 'external_change') {
        auditAtThrow = h.app.engine.resourceRuntime.lastAudit;
        throw new Error('synthetic rollback confirmation transaction failure');
      }
      return origUpdate(patch);
    }) as typeof h.repos.routeState.update;
    const logsFrom = h.logs.length;
    const b = await createEnv(h, 'US-Buyer-B', '203.0.113.11');
    h.fake.updateExternalResource = orig;
    h.repos.routeState.update = origUpdate;
    expect(auditAtThrow).not.toBeUndefined();
    expect(op(b.operation_id)).toMatchObject({ phase: 'BLOCKED_NEEDS_ATTENTION', status: 'needs_attention' });
    expect(op(b.operation_id).error!.message).toContain('回滚结果无法记录');
    // 没有记录的确认不留下任何确认的副作用
    expect(h.logs.slice(logsFrom).filter((l) => l.includes('"msg":"resource.confirmed"'))).toEqual([]);
    expect(h.app.engine.resourceRuntime.lastAudit).toBe(auditAtThrow);
    expect(h.repos.routeState.get().warnings).toContain('node_resource_unverified');
  });

  test('a candidate that made Surge drop the selected node (fallback to REJECT) is rolled back and the original selection restored', async () => {
    h = await createHarness();
    const { envId: a } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const selected = nodeOf(a);
    expect(await h.fake.getGroupSelection(ROUTE_GROUP_NAME)).toBe(selected);
    // Surge 跳过了这次下载中选中节点的行：它从成员中消失，选择回落到 REJECT（2026-10-25 矩阵）
    dropNodesOnNextUpdate(h, [selected]);
    const b = await createEnv(h, 'US-Buyer-B', '203.0.113.11');
    expect(op(b.operation_id)).toMatchObject({ phase: 'FAILED', status: 'failed' });
    expect(await h.fake.getGroupSelection(ROUTE_GROUP_NAME)).toBe(selected);
    expect(h.repos.operations.listSteps(b.operation_id).some((s) => s.message.includes('原选择已恢复'))).toBe(true);
    expect(h.repos.routeState.get().warnings).not.toContain('external_selection_change');
  });
});

describe('rollback ordering and freshness', () => {
  test('regression: Surge starts updating after the forward readback: the rollback re-reads it and sends no second update → BLOCKED_NEEDS_ATTENTION', async () => {
    h = await createHarness();
    const a = (await createEnv(h, 'US-Buyer-A', '203.0.113.10')).environment_id!;
    const before = updates(h);
    // 读回的节点参数读取（两次读回之后）期间 Surge 开始自己的刷新（60 秒），读回的参数也不一致 → 回滚
    const origDetail = h.fake.getPolicyDetail.bind(h.fake);
    let fired = false;
    h.fake.getPolicyDetail = async (name: string) => {
      const d = await origDetail(name);
      if (fired) return d;
      fired = true;
      h.fake.slowUpdate = { durationMs: 60_000 };
      h.fake.runScheduledRefresh(h.resourceKey()!);
      h.fake.slowUpdate = null;
      return { ...d, server: '192.0.2.99' };
    };
    const env = await h.app.createEnvironment({ request_id: rid(), environment: envInput('US-Buyer-B', '203.0.113.11') }, WEB);
    await h.idle();
    h.fake.getPolicyDetail = origDetail;
    expect(fired).toBe(true);
    expect(op(env.operation_id)).toMatchObject({ phase: 'BLOCKED_NEEDS_ATTENTION', status: 'needs_attention' });
    expect(op(env.operation_id).error!.message).toContain('Surge 仍在更新本应用的节点资源');
    expect(updates(h) - before).toBe(1);
    expect(served(h)).toMatchObject({ state: 'committed', generation: 1 });
    expect(h.repos.routeState.get().warnings).toContain('node_resource_unverified');
    h.clock.advance(61_000);
    expect(await nodes(h)).toEqual([nodeOf(a)]);
  });

  test('regression: the rollback\'s first transaction fails → the host already serves the committed generation, never the uncommitted candidate', async () => {
    h = await createHarness();
    await createEnv(h, 'US-Buyer-A', '203.0.113.10');
    const committedBody = fetchResource(h).body.toString('utf8');
    const orig = h.repos.operations.appendStep.bind(h.repos.operations);
    let thrown = false;
    h.repos.operations.appendStep = ((id: string, phase: string, message: string) => {
      if (phase === 'ROLLING_BACK' && !thrown) {
        thrown = true;
        throw new Error('synthetic rollback transaction failure');
      }
      return orig(id, phase as never, message);
    }) as typeof h.repos.operations.appendStep;
    h.resourceFault({ kind: 'http', status: 503 }, { times: 1 });
    const b = await createEnv(h, 'US-Buyer-B', '203.0.113.11');
    h.repos.operations.appendStep = orig;
    expect(thrown).toBe(true);
    expect(op(b.operation_id)).toMatchObject({ phase: 'FAILED', status: 'failed' });
    expect(served(h)).toMatchObject({ state: 'committed', generation: 1 });
    expect(fetchResource(h).body.toString('utf8')).toBe(committedBody);
  });
});

describe('T2 (the commit transaction)', () => {
  test('regression: T2 fails → rolled back; the host commits the candidate only after T2, and the failed T2 leaves no confirmation (log, event, audit point)', async () => {
    h = await createHarness();
    const a = (await createEnv(h, 'US-Buyer-A', '203.0.113.10')).environment_id!;
    const membersBefore = await h.fake.getGroupMembers(ROUTE_GROUP_NAME);
    const orig = h.repos.proxyRevisions.updateState.bind(h.repos.proxyRevisions);
    let thrown = false;
    h.repos.proxyRevisions.updateState = ((envId: string, revision: number, state: string) => {
      if (state === 'deployed' && !thrown) {
        thrown = true;
        throw new Error('synthetic T2 failure');
      }
      return orig(envId, revision, state as never);
    }) as typeof h.repos.proxyRevisions.updateState;
    const logsFrom = h.logs.length;
    const u0 = updates(h);
    const b = await createEnv(h, 'US-Buyer-B', '203.0.113.11');
    h.repos.proxyRevisions.updateState = orig;
    expect(thrown).toBe(true);
    expect(op(b.operation_id)).toMatchObject({ phase: 'FAILED', status: 'failed', error: { code: 'INTERNAL' } });
    expect(pointer(h)).toEqual({ committed: { generation: 1 }, candidate: null });
    expect(served(h)).toMatchObject({ generation: 1, state: 'committed' });
    expect(h.repos.deployments.get(2)!.state).toBe('rolled_back');
    expect(updates(h) - u0).toBe(2);
    expect(await h.fake.getGroupMembers(ROUTE_GROUP_NAME)).toEqual(membersBefore);
    expect(h.repos.environments.get(b.environment_id!)!.deployedProxyRevision).toBeNull();
    expect(h.repos.environments.get(a)!.deployedProxyRevision).toBe(1);
    // 失败的 T2 没有留下第 2 代的确认（只有回滚确认第 1 代）
    const confirmed = h.logs.slice(logsFrom).filter((l) => l.includes('"msg":"resource.confirmed"'));
    expect(confirmed.some((l) => l.includes('"generation":2'))).toBe(false);
    expect(confirmed.some((l) => l.includes('"generation":1'))).toBe(true);
  });
});

describe('crash recovery of the system refresh itself', () => {
  test('regression: a crash during the system refresh re-arms it once; a crash of that retry leaves the record (the user re-syncs)', async () => {
    h = await createHarness({ dbFile: true });
    await createEnv(h, 'US-Buyer-A', '203.0.113.10');
    writeNeedsRefresh(h.app.engine.kv, { generation: 1, reason: 'synthetic' });
    // 系统刷新在单 key 更新之后（读回之前）中断
    const hang = hangAt(h, 'updateExternalResource');
    await h.app.runPeriodicReconcile();
    await until(() => hang.reached());
    const first = systemRefreshOps();
    expect(first).toHaveLength(1);
    hang.restore();
    const hang2 = hangAt(h, 'updateExternalResource');
    await h.crash();
    await until(() => hang2.reached());
    // 重排的那一次（标 afterCrash）也中断
    const second = systemRefreshOps().filter((o) => o.id !== first[0]!.id);
    expect(second).toHaveLength(1);
    expect(h.app.engine.kv.get<{ operationId: string; afterCrash?: boolean }>(SYSTEM_REFRESH_KEY)).toMatchObject({ operationId: second[0]!.id, afterCrash: true });
    hang2.restore();
    await h.crash();
    await h.idle();
    expect(op(first[0]!.id)).toMatchObject({ phase: 'FAILED', error: { code: 'UNKNOWN_STATE' } });
    expect(op(second[0]!.id)).toMatchObject({ phase: 'FAILED', error: { code: 'UNKNOWN_STATE' } });
    // 同一崩溃链不再自动重排：needsRefresh 保留，由用户重新同步
    expect(systemRefreshOps()).toHaveLength(2);
    expect(h.app.views.snapshot('0.0.0-test', false).surge.nodeResource).toMatchObject({ needsRefresh: true });
  });
});
