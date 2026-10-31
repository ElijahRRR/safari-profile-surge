// 回环发布（D10）的崩溃恢复、互斥、端口被占用与保留集：在每个中断点（T1 之后、暂存之后、单 key 更新之后与 T2 之前、T2 之后）
// 崩溃，重启时撤回候选指针并保留 needsRefresh，恢复从不重放，按需排入恰好一次系统强制刷新发布，使 Surge 回到已提交版本；同一时间
// 只有一个发布在提供候选；发布期间另一个进程答复了 Surge 的下载 → 无法解释的下载 → 令牌可疑；保留集按已提交版本与 Surge 成员的
// 并集保护仍可能被使用的节点。只用合成数据。

import { afterEach, describe, expect, test } from 'vitest';
import { ROUTE_GROUP_NAME } from '@sfe/contract';
import type { OperationRecord } from '../../src/db/index.js';
import { nodeLine, resourceBody } from '../../src/surge/generate.js';
import { PROFILE_A, WEB, activeEnv, createEnv, createHarness, envInput, rid, type Harness } from './harness.js';
import { hangAt, needsRefresh, nodes, pointer, served, tokenSuspect, until, updates } from './publish-helpers.js';
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

/** 更新环境 X 的端口（新版本 v002），返回操作编号；之后的发布在 hook 设下的位置挂起。 */
async function updatePort(envId: string, port: number): Promise<string> {
  const env = h.repos.environments.get(envId)!;
  return (await h.app.updateEnvironment(envId, { request_id: rid('upd'), expected_revision: env.revision, changes: { proxy: { port } } }, WEB)).operation_id;
}

/** 本机资源服务提供候选之后（单 key 更新之后的读回）第一次读组成员时挂起。 */
function hangAtReadback(x: Harness): { reached: () => boolean; restore: () => void } {
  const orig = x.fake.getGroupMembers.bind(x.fake);
  let reached = false;
  x.fake.getGroupMembers = (group: string) => {
    if (x.app.engine.resource?.served()?.state !== 'candidate') return orig(group);
    reached = true;
    return new Promise(() => undefined);
  };
  return {
    reached: () => reached,
    restore: () => {
      x.fake.getGroupMembers = orig;
    },
  };
}

describe('crash at each point of a publish → restart reverts the candidate, keeps needsRefresh, one system refresh brings Surge back to the committed generation', () => {
  type Point = 'after_t1' | 'after_stage' | 'after_stage_fetched' | 'after_update';

  test.each<Point>(['after_t1', 'after_stage', 'after_stage_fetched', 'after_update'])('%s', async (point) => {
    h = await createHarness({ dbFile: true });
    const x = (await createEnv(h, 'US-Buyer-X', '203.0.113.10')).environment_id!;
    const committed = pointer(h)!;
    const committedNodes = await nodes(h);
    const updatesBefore = updates(h);
    let release: { reached: () => boolean; restore: () => void };
    const host = h.app.engine.resource!;
    if (point === 'after_t1') {
      // T1 已提交、尚未暂存就退出：暂存不生效，挂在单 key 更新之前
      host.stageCandidate = () => undefined;
      release = hangAt(h, 'updateExternalResource', 1, { before: true });
    } else if (point === 'after_update') {
      release = hangAtReadback(h);
    } else {
      release = hangAt(h, 'updateExternalResource', 1, { before: true });
    }
    const upd = await updatePort(x, 1081);
    await until(release.reached);
    expect(op(upd).phase).toBe('DEPLOYING');
    const candidate = pointer(h)!.candidate!.generation;
    expect(candidate).toBe(committed.committed.generation + 1);
    expect(needsRefresh(h)).toEqual({ generation: candidate, reason: 'publish' });
    // Surge 自己的定时刷新在这时下载了正在提供的候选
    if (point === 'after_stage_fetched') h.fake.runScheduledRefresh(h.resourceKey()!);
    release.restore();
    const servedCandidate = point === 'after_stage_fetched' || point === 'after_update';
    expect(await nodes(h)).toEqual(servedCandidate ? [nodeOf(x, 1), nodeOf(x, 2)] : committedNodes);
    await h.crash();
    await h.idle();
    // 恢复从不重放：操作 UNKNOWN_STATE，候选发布记录 failed
    expect(op(upd)).toMatchObject({ phase: 'FAILED', status: 'failed', error: { code: 'UNKNOWN_STATE' } });
    expect(h.repos.deployments.get(candidate)!.state).toBe('failed');
    // 启动撤回候选（记下 startup_candidate），恰好一次系统强制刷新：单 key 更新并读回，没有目标环境
    expect(h.logs.some((l) => l.includes('"msg":"resource.candidate_reverted"'))).toBe(true);
    const refresh = systemRefreshOps();
    expect(refresh).toHaveLength(1);
    expect(refresh[0]).toMatchObject({ phase: 'COMPLETED', status: 'succeeded' });
    expect(refresh[0]!.payload).toMatchObject({ environmentIds: [] });
    expect(updates(h) - updatesBefore).toBe(point === 'after_update' ? 2 : 1);
    // Surge 回到已提交的节点（新的已提交代数，节点与之前相同）；候选的修改仍待部署
    expect(await nodes(h)).toEqual(committedNodes);
    expect(pointer(h)!.candidate).toBeNull();
    expect(pointer(h)!.committed.generation).toBeGreaterThan(candidate);
    expect(needsRefresh(h)).toBeNull();
    expect(h.repos.environments.get(x)!).toMatchObject({ deployedProxyRevision: 1, desiredProxyRevision: 2 });
    expect(h.repos.proxyRevisions.get(x, 2)!.state).toBe('desired');
    // 提供过的候选让节点资源一度无法确认；经确认的读回之后清除
    expect(h.repos.routeState.get().warnings).not.toContain('node_resource_unverified');
    expect(h.fake.updateAllAttempts).toBe(0);
    expect(h.fake.calls.reloadProfile ?? 0).toBe(0);
    // 待部署的修改由一次显式发布收敛
    const p = await h.app.publishPending({ request_id: rid('pub') }, WEB);
    await h.idle();
    expect(op(p.operation_id).phase).toBe('READY_FOR_NEXT_OPEN');
    expect(h.repos.environments.get(x)!.deployedProxyRevision).toBe(2);
  });

  test('a served candidate with the system refresh parked: the warning is raised at startup and stays until a confirmed readback', async () => {
    h = await createHarness({ dbFile: true });
    const x = (await createEnv(h, 'US-Buyer-X', '203.0.113.10')).environment_id!;
    const release = hangAtReadback(h);
    const upd = await updatePort(x, 1081);
    await until(release.reached);
    release.restore();
    h.revoke(['loopback_publish_crash']);
    await h.crash();
    await h.idle();
    expect(op(upd).error?.code).toBe('UNKNOWN_STATE');
    expect(h.repos.routeState.get().warnings).toContain('node_resource_unverified');
    expect(systemRefreshOps()).toEqual([expect.objectContaining({ phase: 'WAITING_DEPLOYMENT', status: 'parked' })]);
    expect(needsRefresh(h)).toMatchObject({ reason: 'startup_candidate' });
    h.grant(['loopback_publish_crash']);
    const p = await h.app.publishPending({ request_id: rid('pub') }, WEB);
    await h.idle();
    expect(op(p.operation_id).phase).toBe('READY_FOR_NEXT_OPEN');
    expect(h.repos.routeState.get().warnings).not.toContain('node_resource_unverified');
    expect(needsRefresh(h)).toBeNull();
  });

  test('after T2 (committed), before the rest of the settlement: nothing to revert, no system refresh, Surge already on the committed generation', async () => {
    h = await createHarness({ dbFile: true });
    const x = (await createEnv(h, 'US-Buyer-X', '203.0.113.10')).environment_id!;
    // T2 之后的第一次 Surge 调用是非活动环境的预检：在它这里挂起
    const release = hangAt(h, 'testPolicy', 1, { before: true });
    const upd = await updatePort(x, 1081);
    await until(release.reached);
    release.restore();
    const committed = pointer(h)!;
    expect(committed.candidate).toBeNull();
    expect(h.repos.deployments.get(committed.committed.generation)!.state).toBe('verified');
    const updatesBefore = updates(h);
    await h.crash();
    await h.idle();
    expect(op(upd).error?.code).toBe('UNKNOWN_STATE');
    expect(pointer(h)).toEqual(committed);
    expect(needsRefresh(h)).toBeNull();
    expect(systemRefreshOps()).toEqual([]);
    expect(updates(h)).toBe(updatesBefore);
    expect(served(h)).toMatchObject({ generation: committed.committed.generation, state: 'committed' });
    expect(fetchResource(h).status).toBe(200);
    expect(await nodes(h)).toEqual(h.repos.deployments.get(committed.committed.generation)!.nodeManifest.map((m) => m.nodeName));
    expect(await nodes(h)).toContain(nodeOf(x, 2));
    expect(h.repos.environments.get(x)!.deployedProxyRevision).toBe(2);
  });
});

describe('exclusivity', () => {
  test('one publish at a time: a second publish waits on the executor until the first ends; only one candidate is ever staged', async () => {
    h = await createHarness();
    const x = (await createEnv(h, 'US-Buyer-X', '203.0.113.10')).environment_id!;
    const host = h.app.engine.resource!;
    const stage = host.stageCandidate.bind(host);
    const staged: number[] = [];
    host.stageCandidate = (g) => {
      // 已有候选时再暂存是编程错误（资源服务本身也会拒绝）
      expect(host.served()?.state).toBe('committed');
      staged.push(g.generation);
      stage(g);
    };
    // 第一个发布挂在它的单 key 更新上，直到放行
    const orig = h.fake.updateExternalResource.bind(h.fake);
    let releaseFirst: (() => void) | null = null;
    let first = true;
    h.fake.updateExternalResource = async (key: string) => {
      if (first) {
        first = false;
        await new Promise<void>((r) => {
          releaseFirst = r;
        });
      }
      return orig(key);
    };
    const u1 = await updatePort(x, 1081);
    await until(() => releaseFirst !== null);
    expect(op(u1).phase).toBe('DEPLOYING');
    // 第二个发布请求：排队，不领取
    const b = await h.app.createEnvironment({ request_id: rid(), environment: envInput('US-Buyer-B', '203.0.113.11') }, WEB);
    await new Promise((r) => setTimeout(r, 20));
    expect(op(b.operation_id)).toMatchObject({ status: 'queued' });
    expect(staged).toHaveLength(1);
    expect(served(h)).toMatchObject({ state: 'candidate', generation: staged[0] });
    releaseFirst!();
    await h.idle();
    expect(op(u1).phase).toBe('READY_FOR_NEXT_OPEN');
    expect(op(b.operation_id).phase).toBe('READY_FOR_NEXT_OPEN');
    expect(staged).toHaveLength(2);
    expect(staged[1]).toBeGreaterThan(staged[0]!);
    expect(host.served()).toMatchObject({ state: 'committed', generation: staged[1] });
  });
});

describe('another process answered Surge during the publish (port squatting)', () => {
  test('Surge loaded content the service never served → unexplained fetch: tokenSuspect, the token is refused, no rollback update, BLOCKED with the warning; later publishes park; normal mode works', async () => {
    h = await createHarness();
    const { envId: a } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    h.clock.advance(30_000);
    const before = updates(h);
    const foreign = nodeLine({ name: nodeOf(a), host: '192.0.2.66', port: 1080, username: null, password: null, front: 'Front-A' });
    h.resourceFault({ kind: 'squat', status: 200, body: resourceBody(99, [foreign]) });
    const b = await createEnv(h, 'US-Buyer-B', '203.0.113.11');
    h.resourceFault(null);
    expect(op(b.operation_id)).toMatchObject({ phase: 'BLOCKED_NEEDS_ATTENTION', status: 'needs_attention' });
    expect(tokenSuspect(h)).toMatchObject({ reason: 'unexplained_fetch' });
    expect(updates(h) - before).toBe(1);
    expect(fetchResource(h).status).toBe(404);
    const route = h.repos.routeState.get();
    expect(route.warnings).toContain('node_resource_unverified');
    expect(route.phase).toBe('attention');
    // 对账同样无法解释这次下载
    await h.app.runPeriodicReconcile();
    expect(tokenSuspect(h)).not.toBeNull();
    const p = await h.app.publishPending({ request_id: rid('pub') }, WEB);
    await h.idle();
    expect(op(p.operation_id)).toMatchObject({ phase: 'WAITING_DEPLOYMENT', error: { details: { reason: 'token_suspect' } } });
    const n = await h.app.enterNormal({ request_id: rid('normal'), old_session_policy: 'closed_confirmed', confirmed_environment_id: a }, WEB);
    await h.idle();
    expect(op(n.operation_id)).toMatchObject({ phase: 'NORMAL_RESTORED', status: 'succeeded' });
  });
});

describe('retention follows the committed generation and what Surge actually holds', () => {
  /** X（与可选的 Y）已部署；更新 target 的端口，Surge 载入候选后、提交之前崩溃；系统强制刷新停泊（Surge 一直载入着候选）。 */
  async function crashWithCandidateLoaded(target: 'X' | 'Y'): Promise<{ x: string; y: string | null }> {
    h = await createHarness({ dbFile: true });
    const x = (await createEnv(h, 'US-Buyer-X', '203.0.113.10', { password: 'synthPassX1' })).environment_id!;
    const y = target === 'Y' ? (await createEnv(h, 'US-Buyer-Y', '203.0.113.11', { password: 'synthPassY1' })).environment_id! : null;
    const release = hangAtReadback(h);
    const upd = await updatePort(target === 'X' ? x : y!, 1081);
    await until(release.reached);
    release.restore();
    h.revoke(['loopback_publish_crash']);
    await h.crash();
    await h.idle();
    expect(op(upd).error?.code).toBe('UNKNOWN_STATE');
    return { x, y };
  }

  test('deleting an environment whose new revision Surge still holds from an uncommitted candidate never retires it (its credentials survive the sweep) until a publish converges', async () => {
    const { x } = await crashWithCandidateLoaded('X');
    const [x1, x2] = [nodeOf(x, 1), nodeOf(x, 2)];
    expect(await nodes(h)).toEqual([x1, x2]);
    expect(h.repos.deployments.get(pointer(h)!.committed.generation)!.nodeManifest.map((m) => m.nodeName)).toEqual([x1]);
    const env = h.repos.environments.get(x)!;
    const del = await h.app.deleteEnvironment(x, { request_id: rid('del'), expected_revision: env.revision }, WEB);
    await h.idle();
    expect(op(del.operation_id).phase).toBe('COMPLETED');
    const rev2 = h.repos.proxyRevisions.get(x, 2)!;
    expect(h.repos.proxyRevisions.get(x, 1)!.state).toBe('superseded');
    expect(rev2.state).toBe('superseded');
    expect(h.repos.secretRefs.get(rev2.passwordRef!)?.state).toBe('committed');
    await h.app.engine.secrets.sweep();
    expect(h.store.has(rev2.passwordRef!)).toBe(true);
    h.grant(['loopback_publish_crash']);
    const p = await h.app.publishPending({ request_id: rid('pub') }, WEB);
    await h.idle();
    expect(op(p.operation_id)).toMatchObject({ phase: 'COMPLETED', status: 'succeeded' });
    expect(await nodes(h)).toEqual(['SFE-EMPTY']);
    expect(h.repos.proxyRevisions.get(x, 1)!.state).toBe('retired');
    expect(h.repos.proxyRevisions.get(x, 2)!.state).toBe('retired');
    expect(h.repos.secretRefs.get(rev2.passwordRef!)?.state).toBe('orphaned');
  });

  test('a node only in the uncommitted candidate Surge loaded, selected in Surge: the next publish keeps it (Surge members count as current names; never removed while selected)', async () => {
    const { x, y } = await crashWithCandidateLoaded('Y');
    const [x1, y1, y2] = [nodeOf(x, 1), nodeOf(y!, 1), nodeOf(y!, 2)];
    expect(await nodes(h)).toEqual([x1, y1, y2]);
    await h.fake.selectGroupPolicy(ROUTE_GROUP_NAME, y2);
    h.grant(['loopback_publish_crash']);
    // 只发布 X（没有待部署的修改）：Y2 仍待部署、从未提交，但它在 Surge 的成员中且被选中——保留在新的已提交版本中
    const p = await h.app.publishPending({ request_id: rid('pub'), environment_ids: [x] }, WEB);
    await h.idle();
    expect(op(p.operation_id)).toMatchObject({ phase: 'COMPLETED', status: 'succeeded' });
    const manifest = h.repos.deployments.get(pointer(h)!.committed.generation)!.nodeManifest.map((m) => m.nodeName);
    expect(manifest).toEqual([x1, y1, y2]);
    expect(await h.fake.getGroupSelection(ROUTE_GROUP_NAME)).toBe(y2);
    expect(h.repos.proxyRevisions.get(y!, 2)!.state).not.toBe('retired');
  });
});
