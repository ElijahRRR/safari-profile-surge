// 本机资源服务（D10）的对账检查（loopback-spec §6）：每次对账重试监听、审计、比较组成员与已提交版本、核对使用中节点的参数，
// 发现问题时设 node_resource_unverified（只由经确认的读回清除，对账从不清除）；对账从不写 Surge。切换前（checkSwitchPreconditions）
// 同样核对目标节点的参数。只用合成数据（文档地址、example.test）。

import { afterEach, describe, expect, test } from 'vitest';
import { ROUTE_GROUP_NAME } from '@sfe/contract';
import { confirmNodeResource, serveCommittedGeneration } from '../../src/engine/node-resource.js';
import { FAKE_REMOTE_ERRORS } from '../../src/surge/fake.js';
import { matchAuditRecord, readNeedsRefresh, readTokenSuspect } from '../../src/resource/index.js';
import { nodeLine, resourceBody } from '../../src/surge/generate.js';
import { PROFILE_A, PROFILE_B, WEB, bind, createEnv, createHarness, rid, verify, type Harness } from './harness.js';
import { commitNodes, fetchResource, ourResource, serveAndFetch } from './resource-fixtures.js';

let h: Harness;

afterEach(async () => {
  await h?.close();
});

const FOREIGN_LINE = 'SFE-N-TEST = socks5, 192.0.2.80, 1080, underlying-proxy=Front-A';

/**
 * 只看对账本身：撤销只属于发布门槛的 loopback_publish_crash，对账排入的系统强制刷新发布停泊（否则它会单 key 更新、读回并
 * 清除警告——那是发布的测试，见 publish-loopback*.test.ts）。激活门槛不含这一项。
 */
async function reconcileOnlyHarness(): Promise<Harness> {
  const x = await createHarness({ nodeResource: 'loopback' });
  x.revoke(['loopback_publish_crash']);
  await x.idle();
  return x;
}

/** Surge 写原语的调用次数（对账从不写 Surge）。 */
function surgeWrites(x: Harness): number {
  const c = x.fake.calls as Record<string, number | undefined>;
  return ['updateExternalResource', 'reloadProfile', 'selectGroupPolicy', 'addTempRule', 'removeTempRule', 'killConnection'].reduce((n, k) => n + (c[k] ?? 0), 0);
}

/** loopback 夹具中一个经确认部署并激活、实测通过的环境。 */
async function activeLoopbackEnv(x: Harness, name: string, host: string, profileId: string): Promise<{ envId: string; nodeName: string }> {
  const envId = (await createEnv(x, name, host)).environment_id!;
  await commitNodes(x, [envId]);
  await bind(x, profileId, envId);
  const route = x.repos.routeState.get();
  const act = await x.app.activate(
    envId,
    route.activeEnvironmentId ? { request_id: rid('act'), old_session_policy: 'closed_confirmed', confirmed_environment_id: route.activeEnvironmentId } : { request_id: rid('act') },
    WEB,
  );
  await x.idle();
  const r = await verify(x, profileId, act.operation_id);
  if (!r.ok) throw new Error(`verify failed: ${r.error.code}`);
  const op = x.repos.operations.get(act.operation_id)!;
  if (op.phase !== 'ACTIVE_VERIFIED') throw new Error(`activation ended at ${op.phase}: ${JSON.stringify(op.error)}`);
  const env = x.repos.environments.get(envId)!;
  return { envId, nodeName: x.repos.proxyRevisions.get(envId, env.deployedProxyRevision!)!.nodeName };
}

describe('members compared with the committed version', () => {
  test('a served but uncommitted candidate in Surge → warning without tokenSuspect; sticky until a confirmed readback', async () => {
    h = await reconcileOnlyHarness();
    // 发布中断：候选版本由本服务提供、Surge 已下载，之后撤回（从未提交）
    await serveAndFetch(h, 9, resourceBody(9, [FOREIGN_LINE]));
    h.app.engine.resource!.revertToCommitted();
    expect(await h.fake.getGroupMembers(ROUTE_GROUP_NAME)).toEqual(['REJECT', 'SFE-N-TEST']);
    const writes = surgeWrites(h);
    // 空闲且普通模式时周期对账仍运行（工作配置引用本机资源服务）
    await h.app.runPeriodicReconcile();
    const route = h.repos.routeState.get();
    expect(route.warnings).toContain('node_resource_unverified');
    expect(route.phase).toBe('idle');
    // 下载由本服务答复（有完整的审计记录）：不是令牌可疑
    expect(readTokenSuspect(h.app.engine.kv)).toBeNull();
    const rec = h.repos.operations.listRecent(20).find((o) => o.kind === 'maintenance.reconcile')!;
    expect(rec.payload).toMatchObject({ added: ['node_resource_unverified'] });
    expect(h.repos.operations.listSteps(rec.id).map((st) => st.message).join('；')).toContain('节点资源未确认：SFE-ROUTE 的成员与已提交版本不同');
    expect(surgeWrites(h)).toBe(writes);
    // Surge 又下载了已提交版本：成员一致，但对账从不清除警告
    const mark = h.app.engine.resource!.auditMark();
    h.clock.advance(2_000);
    await h.fake.updateExternalResource(h.resourceKey()!);
    expect(await h.fake.getGroupMembers(ROUTE_GROUP_NAME)).toEqual(['REJECT', 'SFE-EMPTY']);
    await h.app.runPeriodicReconcile();
    expect(h.repos.routeState.get().warnings).toContain('node_resource_unverified');
    // 经确认的读回清除
    const r = (await ourResource(h))!;
    const matched = matchAuditRecord(h.app.engine.resource!.audit(), r.lastUpdatedAt!, h.app.engine.resourceAuditToleranceMs(), mark, 0)!;
    confirmNodeResource(h.app.engine, { generation: 0, matchedSeq: matched.seq, snapshot: { updatedAt: r.lastUpdatedAt, error: r.error }, clearNeedsRefresh: true });
    expect(h.repos.routeState.get().warnings).not.toContain('node_resource_unverified');
    await h.app.runPeriodicReconcile();
    expect(h.repos.routeState.get().warnings).not.toContain('node_resource_unverified');
    expect(readNeedsRefresh(h.app.engine.kv)).toBeNull();
  });

  test('members are not compared while a publish operation is writing (DEPLOYING)', async () => {
    h = await createHarness({ nodeResource: 'loopback' });
    await h.idle();
    const op = h.repos.operations.insert({
      id: 'op_publish_writing',
      requestId: rid('pub'),
      requestDigest: 'service',
      kind: 'deploy.publish',
      initiatorKind: 'web',
      phase: 'DEPLOYING',
      status: 'running',
      payload: { environmentIds: null },
    });
    await serveAndFetch(h, 9, resourceBody(9, [FOREIGN_LINE]));
    h.app.engine.resource!.revertToCommitted();
    await h.app.refreshSurge(WEB);
    expect(h.repos.routeState.get().warnings).not.toContain('node_resource_unverified');
    h.repos.operations.update(op.id, { phase: 'FAILED', status: 'failed' });
    await h.app.refreshSurge(WEB);
    expect(h.repos.routeState.get().warnings).toContain('node_resource_unverified');
  });
});

describe('audit while serving', () => {
  test('an error from our own failed answer is explained; one answered by another process is not', async () => {
    h = await reconcileOnlyHarness();
    await h.app.runPeriodicReconcile();
    // 本服务接受了请求而答复中途出错（令牌正确的 200 没有写完）：可以解释
    h.resourceFault({ kind: 'http', status: 503 }, { times: 1 });
    await expect(h.fake.updateExternalResource(h.resourceKey()!)).rejects.toThrow();
    expect((await ourResource(h))!.error).toContain('503');
    await h.app.runPeriodicReconcile();
    expect(readTokenSuspect(h.app.engine.kv)).toBeNull();
    expect(h.repos.routeState.get().warnings).not.toContain('node_resource_unverified');
    // 本服务一直在监听，另一个答复却出现了（本服务没有答复过任何失败）：无法解释
    h.clock.advance(1_000);
    h.resourceFault({ kind: 'squat', status: 404, body: '' }, { times: 1 });
    await expect(h.fake.updateExternalResource(h.resourceKey()!)).rejects.toThrow();
    await h.app.runPeriodicReconcile();
    expect(readTokenSuspect(h.app.engine.kv)).toMatchObject({ reason: 'unexplained_error' });
    expect(h.repos.routeState.get().warnings).toContain('node_resource_unverified');
    expect(fetchResource(h).status).toBe(404);
  });

  test('regression: our own 503 answered while an audit reads Surge counts in the next audit (no false tokenSuspect)', async () => {
    // temp_rule：读入口不读外部资源，对账中读外部资源的只有节点资源检查
    h = await createHarness({ nodeResource: 'loopback', entryStrategy: 'temp_rule' });
    h.revoke(['loopback_publish_crash']);
    await h.idle();
    await h.app.runPeriodicReconcile();
    const engine = h.app.engine;
    const host = engine.resource!;
    // 这次对账读外部资源期间：本服务没有可提供的版本、答复了 Surge 的一次下载 503；读到的快照是下载之前的（还没有错误）
    const orig = h.fake.listExternalResources.bind(h.fake);
    let fired = false;
    h.fake.listExternalResources = async () => {
      const list = await orig();
      if (!fired) {
        fired = true;
        host.unload();
        await h.fake.updateExternalResource(h.resourceKey()!).catch(() => undefined);
        await serveCommittedGeneration(engine);
      }
      return list;
    };
    await h.app.runPeriodicReconcile();
    expect(fired).toBe(true);
    h.fake.listExternalResources = orig;
    expect((await ourResource(h))!.error).toBe(FAKE_REMOTE_ERRORS.status(503));
    // 下一次审计看到这个错误：本服务一直在监听，读取期间的 503 算进这一次的失败次数
    await h.app.runPeriodicReconcile();
    expect(readTokenSuspect(engine.kv)).toBeNull();
    expect(h.logs.some((l) => l.includes('"msg":"resource.audit_unexplained"'))).toBe(false);
  });

  test('the listener lost its port to another process: retried each tick, tokenSuspect and the warning', async () => {
    h = await createHarness({ nodeResource: 'loopback' });
    await h.idle();
    const engine = h.app.engine;
    await engine.resource!.close();
    // 端口空闲：下一次对账重新监听，不报警
    await h.app.runPeriodicReconcile();
    expect(engine.resource!.listening()).toBe(true);
    expect(h.repos.routeState.get().warnings).not.toContain('node_resource_unverified');
    await engine.resource!.close();
    h.binderRegistry.set(h.resourcePort, 'other-process');
    await h.app.runPeriodicReconcile();
    expect(engine.resource!.listening()).toBe(false);
    expect(readTokenSuspect(engine.kv)).toMatchObject({ reason: 'port_in_use' });
    expect(h.repos.routeState.get().warnings).toContain('node_resource_unverified');
  });
});

describe('node parameters', () => {
  test('the selected member in Surge no longer matches its revision (same name) → warning and attention for an active route', async () => {
    h = await createHarness({ nodeResource: 'loopback' });
    await h.idle();
    const { envId, nodeName } = await activeLoopbackEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    expect(h.repos.routeState.get()).toMatchObject({ phase: 'active_verified', activeEnvironmentId: envId });
    expect((await h.app.ensureInControl()).ok).toBe(true);
    // Surge 载入了同名但服务器不同的节点（由本服务答复的一次下载，名称不变：成员检查看不出来）
    const generation = h.repos.meta.configurationGeneration() + 1;
    await serveAndFetch(h, generation, resourceBody(generation, [nodeLine({ name: nodeName, host: '192.0.2.99', port: 1080, username: null, password: null, front: 'Front-A' })]));
    h.app.engine.resource!.revertToCommitted();
    await h.app.runPeriodicReconcile();
    const route = h.repos.routeState.get();
    expect(route.warnings).toContain('node_resource_unverified');
    expect(route.phase).toBe('attention');
    expect(readTokenSuspect(h.app.engine.kv)).toBeNull();
    const control = await h.app.ensureInControl();
    expect(control.ok).toBe(false);
  });

  test('checkSwitchPreconditions refuses a target whose parameters in Surge differ: route unchanged, nothing selected, warning set', async () => {
    h = await createHarness({ nodeResource: 'loopback' });
    await h.idle();
    const envId = (await createEnv(h, 'US-Buyer-A', '203.0.113.10')).environment_id!;
    await commitNodes(h, [envId]);
    await bind(h, PROFILE_A, envId);
    const nodeName = h.repos.proxyRevisions.get(envId, h.repos.environments.get(envId)!.deployedProxyRevision!)!.nodeName;
    const generation = h.repos.meta.configurationGeneration() + 1;
    await serveAndFetch(h, generation, resourceBody(generation, [nodeLine({ name: nodeName, host: '192.0.2.99', port: 1080, username: null, password: null, front: 'Front-A' })]));
    h.app.engine.resource!.revertToCommitted();
    const selects = h.fake.calls.selectGroupPolicy ?? 0;
    const act = await h.app.activate(envId, { request_id: rid('act') }, WEB);
    await h.idle();
    const op = h.repos.operations.get(act.operation_id)!;
    expect(op).toMatchObject({ phase: 'FAILED', status: 'failed' });
    expect(op.error).toMatchObject({ code: 'NODE_NOT_DEPLOYED' });
    expect(op.error!.message).toContain('节点资源未确认');
    expect(op.error!.message).toContain('路由未改变');
    expect(h.fake.calls.selectGroupPolicy ?? 0).toBe(selects);
    expect(h.repos.routeState.get()).toMatchObject({ phase: 'idle', entryMode: 'NORMAL', activeEnvironmentId: null });
    expect(h.logs.some((l) => l.includes('"msg":"resource.unverified"') && l.includes('node_detail_mismatch'))).toBe(true);
    // 警告带着刷新要求：排入的一次系统强制刷新单 key 更新、按已提交版本读回节点参数之后清除它（激活仍需用户重新发起）
    const refresh = h.repos.operations.listRecent(50).filter((o) => o.kind === 'deploy.publish' && o.initiatorKind === 'service');
    expect(refresh).toHaveLength(1);
    expect(refresh[0]).toMatchObject({ phase: 'COMPLETED', status: 'succeeded' });
    expect((await h.fake.getPolicyDetail(nodeName)).server).toBe('203.0.113.10');
    expect(h.repos.routeState.get().warnings).not.toContain('node_resource_unverified');
    expect(readNeedsRefresh(h.app.engine.kv)).toBeNull();
  });

  test('regression: a drifted in-use node (same name, other server) on an active route converges by one system refresh; the warning clears and the route stays in attention', async () => {
    h = await createHarness({ nodeResource: 'loopback' });
    await h.idle();
    const { envId, nodeName } = await activeLoopbackEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const rev = h.repos.proxyRevisions.get(envId, h.repos.environments.get(envId)!.deployedProxyRevision!)!;
    const generation = h.repos.meta.configurationGeneration() + 1;
    await serveAndFetch(h, generation, resourceBody(generation, [nodeLine({ name: nodeName, host: '192.0.2.99', port: 1080, username: null, password: null, front: 'Front-A' })]));
    h.app.engine.resource!.revertToCommitted();
    expect((await h.fake.getPolicyDetail(nodeName)).server).toBe('192.0.2.99');
    const updates = h.fake.calls.updateExternalResource ?? 0;
    const selects = h.fake.calls.selectGroupPolicy ?? 0;
    await h.app.runPeriodicReconcile();
    expect(h.repos.routeState.get().warnings).toContain('node_resource_unverified');
    expect(readNeedsRefresh(h.app.engine.kv)).toMatchObject({ reason: 'node_detail_mismatch' });
    await h.idle();
    // 一次单 key 更新恢复已提交的参数（同名参数变化立即生效、保持选择），从不改选
    expect((h.fake.calls.updateExternalResource ?? 0) - updates).toBe(1);
    expect(h.fake.calls.selectGroupPolicy ?? 0).toBe(selects);
    expect(await h.fake.getPolicyDetail(nodeName)).toMatchObject({ server: rev.host, port: rev.port });
    expect(await h.fake.getGroupSelection(ROUTE_GROUP_NAME)).toBe(nodeName);
    const route = h.repos.routeState.get();
    expect(route.warnings).not.toContain('node_resource_unverified');
    expect(readNeedsRefresh(h.app.engine.kv)).toBeNull();
    // 路由仍需要现有的重新核验流程才能回到已验证
    expect(route.phase).toBe('attention');
    await h.app.runPeriodicReconcile();
    expect(h.repos.routeState.get().warnings).not.toContain('node_resource_unverified');
  });
});

describe('loopback route with the warning', () => {
  test('raised by reconcile on an active route: normal mode works and keeps the warning; a new activation is refused', async () => {
    h = await reconcileOnlyHarness();
    const { envId } = await activeLoopbackEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const b = (await createEnv(h, 'US-Buyer-B', '203.0.113.11')).environment_id!;
    await commitNodes(h, [envId, b]);
    await bind(h, PROFILE_B, b);
    // 发布中断留下的候选版本（多了一个节点）：成员与已提交版本不同
    const generation = h.repos.meta.configurationGeneration() + 1;
    await serveAndFetch(h, generation, resourceBody(generation, [FOREIGN_LINE]));
    h.app.engine.resource!.revertToCommitted();
    await h.app.runPeriodicReconcile();
    expect(h.repos.routeState.get()).toMatchObject({ phase: 'attention' });
    expect(h.repos.routeState.get().warnings).toContain('node_resource_unverified');
    expect(h.app.views.routeView().normalModeOffered).toBe(true);
    const n = await h.app.enterNormal({ request_id: rid('normal'), old_session_policy: 'closed_confirmed', confirmed_environment_id: envId }, WEB);
    await h.idle();
    expect(h.repos.operations.get(n.operation_id)).toMatchObject({ phase: 'NORMAL_RESTORED', status: 'succeeded' });
    expect(h.repos.routeState.get()).toMatchObject({ entryMode: 'NORMAL', phase: 'idle' });
    expect(h.repos.routeState.get().warnings).toContain('node_resource_unverified');
    const act = await h.app.activate(b, { request_id: rid('act') }, WEB);
    await h.idle();
    expect(h.repos.operations.get(act.operation_id)).toMatchObject({ phase: 'FAILED', status: 'failed', error: { code: 'NODE_NOT_DEPLOYED' } });
    expect(h.repos.routeState.get()).toMatchObject({ entryMode: 'NORMAL', phase: 'idle', activeEnvironmentId: null });
  });
});
