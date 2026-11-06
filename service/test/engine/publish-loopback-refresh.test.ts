// 刷新要求（resource:needsRefresh，D10）：Surge 可能载入了未提交的版本、或与已提交版本不一致时，下一次发布即使没有待部署的修改
// 也必须提供、单 key 更新一次并逐项读回，不走“没有修改”的捷径；读回失败或不完整（没有覆盖记录）时要求保留到下一次发布。对账
// 发现不一致时排入一次系统强制刷新（没有目标环境），读回不完整时不再自动反复排入。只用合成数据。

import { afterEach, describe, expect, test } from 'vitest';
import { SfeError } from '@sfe/contract';
import { SYSTEM_REFRESH_KEY } from '../../src/engine/node-resource.js';
import { writeNeedsRefresh } from '../../src/resource/index.js';
import { nodeLine, resourceBody } from '../../src/surge/generate.js';
import { WEB, createEnv, createHarness, rid, type Harness } from './harness.js';
import { needsRefresh, nodes, pointer, updates } from './publish-helpers.js';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

const op = (id: string) => h.repos.operations.get(id)!;
const nodeOf = (envId: string, revision = 1) => h.repos.proxyRevisions.get(envId, revision)!.nodeName;

function systemRefreshOps() {
  return h.repos.operations.listRecent(200).filter((o) => o.kind === 'deploy.publish' && o.initiatorKind === 'service' && o.payload.forceRefresh === true);
}

/** Surge 中同名节点的参数被换掉（例如之前别人占用端口时提供的列表）：getPolicyDetail 读回的服务器不同。 */
function tamperedDetail(x: Harness, node: string, server: string): () => void {
  const orig = x.fake.getPolicyDetail.bind(x.fake);
  x.fake.getPolicyDetail = async (name: string) => {
    const d = await orig(name);
    return name === node ? { ...d, server } : d;
  };
  return () => {
    x.fake.getPolicyDetail = orig;
  };
}

describe('needsRefresh forces a publish with nothing pending', () => {
  test('one update and a full readback; the requirement is cleared only by it', async () => {
    h = await createHarness();
    const a = (await createEnv(h, 'US-Buyer-A', '203.0.113.10')).environment_id!;
    const generation = pointer(h)!.committed.generation;
    writeNeedsRefresh(h.app.engine.kv, { generation, reason: 'synthetic' });
    const before = updates(h);
    const p = await h.app.publishPending({ request_id: rid('pub') }, WEB);
    await h.idle();
    expect(op(p.operation_id)).toMatchObject({ phase: 'COMPLETED', status: 'succeeded' });
    expect(h.repos.operations.listSteps(p.operation_id).map((s) => s.message).join('\n')).toContain('需要与已提交版本重新核对');
    expect(updates(h) - before).toBe(1);
    expect(pointer(h)!.committed.generation).toBe(generation + 1);
    expect(h.repos.deployments.latest()).toMatchObject({ state: 'verified', readbackLevel: 'full' });
    expect(await nodes(h)).toEqual([nodeOf(a)]);
    expect(needsRefresh(h)).toBeNull();
  });

  test('the forced publish fails (Surge unreachable): the requirement stays; the next explicit publish still refreshes and reads back', async () => {
    h = await createHarness();
    await createEnv(h, 'US-Buyer-A', '203.0.113.10');
    writeNeedsRefresh(h.app.engine.kv, { generation: 1, reason: 'synthetic' });
    h.fake.failNext('listExternalResources', new SfeError('SURGE_UNREACHABLE', '连接 Surge 失败：模拟不可达'));
    const before = updates(h);
    const p1 = await h.app.publishPending({ request_id: rid('pub') }, WEB);
    await h.idle();
    expect(op(p1.operation_id).status).toBe('failed');
    expect(updates(h)).toBe(before);
    expect(needsRefresh(h)).not.toBeNull();
    const p2 = await h.app.publishPending({ request_id: rid('pub') }, WEB);
    await h.idle();
    expect(op(p2.operation_id).status).toBe('succeeded');
    expect(updates(h) - before).toBe(1);
    expect(needsRefresh(h)).toBeNull();
  });

  test('the forced publish reads back parameters that still differ (and the rollback readback too): BLOCKED_NEEDS_ATTENTION with the node resource warning, the requirement stays', async () => {
    h = await createHarness();
    const a = (await createEnv(h, 'US-Buyer-A', '203.0.113.10')).environment_id!;
    writeNeedsRefresh(h.app.engine.kv, { generation: 1, reason: 'synthetic' });
    const restore = tamperedDetail(h, nodeOf(a), '198.51.100.77');
    const p = await h.app.publishPending({ request_id: rid('pub') }, WEB);
    await h.idle();
    restore();
    expect(op(p.operation_id)).toMatchObject({ status: 'needs_attention', phase: 'BLOCKED_NEEDS_ATTENTION', error: { code: 'READBACK_MISMATCH' } });
    expect(op(p.operation_id).error!.message).toContain(`detail:${nodeOf(a)}`);
    expect(h.repos.deployments.latest()!.state).toBe('failed');
    expect(h.repos.routeState.get().warnings).toContain('node_resource_unverified');
    expect(needsRefresh(h)).not.toBeNull();
  });

  test('parameters that differ only while the candidate is served: rolled back and confirmed against the committed generation', async () => {
    h = await createHarness();
    const a = (await createEnv(h, 'US-Buyer-A', '203.0.113.10')).environment_id!;
    writeNeedsRefresh(h.app.engine.kv, { generation: 1, reason: 'synthetic' });
    const orig = h.fake.getPolicyDetail.bind(h.fake);
    h.fake.getPolicyDetail = async (name: string) => {
      const d = await orig(name);
      return h.app.engine.resource!.served()?.state === 'candidate' ? { ...d, server: '198.51.100.77' } : d;
    };
    const p = await h.app.publishPending({ request_id: rid('pub') }, WEB);
    await h.idle();
    h.fake.getPolicyDetail = orig;
    expect(op(p.operation_id)).toMatchObject({ status: 'failed', error: { code: 'READBACK_MISMATCH' } });
    expect((op(p.operation_id).error!.details as { checks: string[] }).checks).toContain(`detail:${nodeOf(a)}`);
    expect(h.repos.deployments.latest()!.state).toBe('rolled_back');
    // 回滚经确认的读回（Surge 重新下载已提交版本并逐项核对）满足了刷新要求
    expect(needsRefresh(h)).toBeNull();
    expect(h.repos.routeState.get().warnings).not.toContain('node_resource_unverified');
  });

  test('CLI-only install (no per-node detail readback): the forced publish is partial — published, not verified, the requirement stays; covered by the P0 records it is verified and cleared', async () => {
    h = await createHarness();
    await createEnv(h, 'US-Buyer-A', '203.0.113.10');
    const mech = h.fake.mechanism.bind(h.fake);
    h.fake.mechanism = () => ({ ...mech(), getPolicyDetail: 'unavailable' });
    writeNeedsRefresh(h.app.engine.kv, { generation: 1, reason: 'synthetic' });
    const p1 = await h.app.publishPending({ request_id: rid('pub') }, WEB);
    await h.idle();
    expect(op(p1.operation_id)).toMatchObject({ phase: 'COMPLETED', status: 'succeeded' });
    expect(h.repos.operations.listSteps(p1.operation_id).at(-1)!.message).toContain('读回不完整');
    expect(h.repos.deployments.latest()).toMatchObject({ state: 'published', readbackLevel: 'partial' });
    expect(needsRefresh(h)).not.toBeNull();
    // 覆盖记录（两项能力的说明都声明覆盖未核对字段）
    for (const key of ['loopback_resource_update', 'external_node_underlying_proxy'] as const) h.grant([key], 'readback-covers: server, port, underlying-proxy');
    const p2 = await h.app.publishPending({ request_id: rid('pub') }, WEB);
    await h.idle();
    expect(op(p2.operation_id).status).toBe('succeeded');
    expect(h.repos.deployments.latest()).toMatchObject({ state: 'verified', readbackLevel: 'partial' });
    expect(needsRefresh(h)).toBeNull();
  });

  test('an ordinary publish with nothing pending and nothing to refresh takes the shortcut (no update)', async () => {
    h = await createHarness();
    await createEnv(h, 'US-Buyer-A', '203.0.113.10');
    const before = updates(h);
    const p = await h.app.publishPending({ request_id: rid('pub') }, WEB);
    await h.idle();
    expect(op(p.operation_id)).toMatchObject({ phase: 'COMPLETED', status: 'succeeded' });
    expect(updates(h)).toBe(before);
  });
});

describe('the system refresh enqueued by reconcile', () => {
  test('Surge holds members that are not the committed generation (served by this service, then reverted): one system refresh converges it; reconciles afterwards add none', async () => {
    h = await createHarness();
    const a = (await createEnv(h, 'US-Buyer-A', '203.0.113.10')).environment_id!;
    // 本服务提供过、从未提交的一份（例如崩溃之前）：Surge 载入了它
    const host = h.app.engine.resource!;
    const generation = h.repos.meta.configurationGeneration() + 1;
    const extra = nodeLine({ name: 'SFE-N-E0099-US99-v001', host: '192.0.2.80', port: 1080, username: null, password: null, front: 'Front-A' });
    host.stageCandidate({ generation, content: resourceBody(generation, [extra]) });
    h.clock.advance(2_000);
    await h.fake.updateExternalResource(h.resourceKey()!);
    host.revertToCommitted();
    expect(await nodes(h)).toEqual(['SFE-N-E0099-US99-v001']);
    const before = updates(h);
    await h.app.runPeriodicReconcile();
    await h.idle();
    const refresh = systemRefreshOps();
    expect(refresh).toHaveLength(1);
    expect(refresh[0]).toMatchObject({ phase: 'COMPLETED', status: 'succeeded', payload: { environmentIds: [], systemRefresh: 'members_mismatch' } });
    expect(updates(h) - before).toBe(1);
    expect(await nodes(h)).toEqual([nodeOf(a)]);
    expect(h.repos.routeState.get().warnings).not.toContain('node_resource_unverified');
    await h.app.runPeriodicReconcile();
    await h.idle();
    expect(systemRefreshOps()).toHaveLength(1);
    expect(updates(h) - before).toBe(1);
  });

  test('a system refresh whose readback is partial keeps needsRefresh but is not re-enqueued by later reconciles (no automatic repeated updates)', async () => {
    h = await createHarness();
    await createEnv(h, 'US-Buyer-A', '203.0.113.10');
    const mech = h.fake.mechanism.bind(h.fake);
    h.fake.mechanism = () => ({ ...mech(), getPolicyDetail: 'unavailable' });
    writeNeedsRefresh(h.app.engine.kv, { generation: 1, reason: 'synthetic' });
    const before = updates(h);
    await h.app.runPeriodicReconcile();
    await h.idle();
    expect(systemRefreshOps()).toHaveLength(1);
    expect(h.repos.deployments.latest()).toMatchObject({ state: 'published', readbackLevel: 'partial' });
    expect(needsRefresh(h)).not.toBeNull();
    expect(h.app.engine.kv.get(SYSTEM_REFRESH_KEY)).not.toBeNull();
    for (let i = 0; i < 3; i++) {
      await h.app.runPeriodicReconcile();
      await h.idle();
    }
    expect(systemRefreshOps()).toHaveLength(1);
    expect(updates(h) - before).toBe(1);
  });
});
