// 节点资源可能被伪造时的 REJECT 保持（用户决定 D11，docs/ARCHITECTURE.md §6.6）：下载核对确认 Surge 中的节点可能是伪造的——
// (a) 无法解释的下载（unexplained_fetch，令牌同时可疑），或 (b) 路由不是普通模式时 SFE-ROUTE 选中节点的参数与其版本不同——服务
// 记下 resource:forgedNodes、带 node_resource_forged，并由执行器把 SFE-ROUTE 改选 REJECT（route.hold）；从不结束连接、重载或全局
// 改代理，排队的普通模式先执行，REJECT 不自动恢复，只由经确认的读回清除伪造状态。只用合成数据（文档地址、example.test）。
// 伪造标记在测试中经引擎 kv 的原始键读写（不经新的读写函数），这些测试在没有 D11 的实现上按行为失败。

import { afterEach, describe, expect, test } from 'vitest';
import { ROUTE_GROUP_NAME, SfeError } from '@sfe/contract';
import type { OperationRecord } from '../../src/db/index.js';
import { confirmNodeResource, maybeEnqueueForgedHold } from '../../src/engine/node-resource.js';
import { matchAuditRecord, readNeedsRefresh, readTokenSuspect } from '../../src/resource/index.js';
import { FAKE_CHROME_PATH, FAKE_SAFARI_PATH, FAKE_VERIFY_HOST } from '../../src/surge/fake.js';
import { nodeLine, resourceBody } from '../../src/surge/generate.js';
import { resourceUpdateTimeoutError } from '../../src/surge/primitives.js';
import { PROFILE_A, PROFILE_B, WEB, activeEnv, bind, createEnv, createHarness, envInput, rid, safariOutcome, verify, type Harness } from './harness.js';
import { dropNodesOnNextUpdate, hangAt, until } from './publish-helpers.js';
import { ourResource, serveAndFetch } from './resource-fixtures.js';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

const FORGED_KEY = 'resource:forgedNodes';
const HOLD_KEY = 'resource:forgedHold';
const forged = () => h.app.engine.kv.get<{ since: string; reasons: string[] }>(FORGED_KEY);
const setForged = (reasons: string[]) => h.app.engine.kv.set(FORGED_KEY, { since: h.clock.now().toISOString(), reasons });
const holds = (): OperationRecord[] =>
  h.repos.operations
    .listRecent(500)
    .filter((o) => o.kind === ('route.hold' as OperationRecord['kind']))
    .reverse();
const selection = () => h.fake.getGroupSelection(ROUTE_GROUP_NAME);
const op = (id: string) => h.repos.operations.get(id)!;
const calls = (k: string): number => (h.fake.calls as Record<string, number | undefined>)[k] ?? 0;
const steps = (id: string): string => h.repos.operations.listSteps(id).map((s) => s.message).join('\n');
const running = (kind: string): boolean => h.repos.operations.listByStatus(['running']).some((o) => o.kind === kind);
const nodeOf = (envId: string): string => h.repos.proxyRevisions.get(envId, h.repos.environments.get(envId)!.deployedProxyRevision!)!.nodeName;
const line = (name: string, host: string) => nodeLine({ name, host, port: 1080, username: null, password: null, front: 'Front-A' });

/**
 * 时钟拨后 30 秒（不触发周期任务），Surge 的缓存变成一份本服务从未提供过的列表（更新时间为此刻，如同端口被他人占用期间
 * Surge 下载了占用者提供的列表）：之后的审计无法解释这次下载。
 */
function seedUnexplained(lines: string[]): void {
  h.clock.set(new Date(h.clock.now().getTime() + 30_000));
  h.fake.seedRemoteCache(h.resourceUrl()!, resourceBody(99, lines), { updatedAt: h.clock.now() });
}

/** Surge 载入了由本服务答复的、同名但服务器不同的节点（参数漂移；下载有完整的审计记录，令牌不可疑）。 */
async function driftNodes(lines: string[]): Promise<void> {
  const generation = h.repos.meta.configurationGeneration() + 1;
  await serveAndFetch(h, generation, resourceBody(generation, lines));
  h.app.engine.resource!.revertToCommitted();
}

/** 记录 SFE-ROUTE 改选：执行中操作的种类与选择。 */
function recordSelects(): string[] {
  const out: string[] = [];
  const orig = h.fake.selectGroupPolicy.bind(h.fake);
  h.fake.selectGroupPolicy = async (group: string, policy: string) => {
    const kinds = h.repos.operations.listByStatus(['running']).map((o) => o.kind);
    out.push(`${kinds.join('+') || '-'}:${policy}`);
    return orig(group, policy);
  };
  return out;
}

/** 记录执行器领取的条目属于哪个操作。 */
function recordClaims(): string[] {
  const order: string[] = [];
  const claim = h.repos.outbox.claimNext.bind(h.repos.outbox);
  h.repos.outbox.claimNext = (now, prefer) => {
    const row = claim(now, prefer);
    if (row) order.push(row.operationId);
    return row;
  };
  return order;
}

/** 准备页：到达并签发检测编号（之后由 submitCheck 提交）。 */
async function beginCheck(profileId: string, operationId: string): Promise<{ test_id: string; route_epoch: number; started: string }> {
  const begin = await h.native(profileId, { type: 'beginSafariVerification', operation_id: operationId, amazon_tabs_open: false });
  if (!begin.ok) throw new Error(`begin failed: ${begin.error.code}`);
  const data = begin.data as { status: string; test_id: string; route_epoch: number };
  if (data.status !== 'ready') throw new Error(`begin not ready: ${data.status}`);
  return { test_id: data.test_id, route_epoch: data.route_epoch, started: h.clock.now().toISOString() };
}

async function submitCheck(profileId: string, operationId: string, t: { test_id: string; route_epoch: number; started: string }) {
  h.fake.simulateRequest({ processPath: FAKE_SAFARI_PATH, host: FAKE_VERIFY_HOST, protocol: 'tcp' });
  const r = await h.native(profileId, {
    type: 'submitSafariVerification',
    operation_id: operationId,
    test_id: t.test_id,
    route_epoch: t.route_epoch,
    observed_ip: '192.0.2.50',
    http_status: 200,
    error: null,
    started_at: t.started,
    finished_at: h.clock.now().toISOString(),
  });
  await h.idle();
  return r;
}

/** 使用中环境 A 与已部署、已关联的环境 B。 */
async function activeAWithB(): Promise<{ a: string; b: string; nodeA: string; nodeB: string }> {
  const { envId: a } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
  const b = (await createEnv(h, 'US-Buyer-B', '203.0.113.11')).environment_id!;
  await bind(h, PROFILE_B, b);
  return { a, b, nodeA: nodeOf(a), nodeB: nodeOf(b) };
}

describe('(a) unexplained fetch → the executor holds REJECT', () => {
  test('R1: found by the periodic reconcile on an active route: route.hold selects REJECT and reads it back; no connection ended, no reload; Chrome unaffected', async () => {
    h = await createHarness();
    const { envId: a } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const nodeA = nodeOf(a);
    const kills = calls('killRequest');
    const reloads = calls('reloadProfile');
    seedUnexplained([line(nodeA, '192.0.2.66')]);
    await h.app.runPeriodicReconcile();
    await h.idle();
    expect(await selection()).toBe('REJECT');
    const route = h.repos.routeState.get();
    expect(route).toMatchObject({ phase: 'attention', selectedNode: 'REJECT', activeEnvironmentId: a, entryMode: 'ACTIVE' });
    expect(route.warnings).toEqual(expect.arrayContaining(['node_resource_unverified', 'node_resource_forged', 'buyer_exit_connections_unconfirmed']));
    expect(route.warnings).not.toContain('entry_unverified');
    expect(h.app.views.routeView().normalModeOffered).toBe(true);
    const hs = holds();
    expect(hs).toHaveLength(1);
    expect(hs[0]).toMatchObject({ initiatorKind: 'service', phase: 'COMPLETED', status: 'succeeded', result: { rejectSelected: true, rejectCause: 'node_resource_forged' } });
    const text = steps(hs[0]!.id);
    expect(text).toContain('SFE-ROUTE 已改选 REJECT（读回确认）');
    expect(text).toContain('更换本机资源地址');
    expect(text).not.toContain('用户决定');
    expect(calls('killRequest')).toBe(kills);
    expect(calls('reloadProfile')).toBe(reloads);
    expect(forged()?.reasons).toContain('unexplained_fetch');
    expect(readTokenSuspect(h.app.engine.kv)).toMatchObject({ reason: 'unexplained_fetch' });
    // 经 SFE-ROUTE 的 Safari 新连接被拒绝；Chrome 不命中本应用规则
    expect(safariOutcome(h, 'www.amazon.com').failed).toBe(true);
    expect(h.fake.simulateRequest({ processPath: FAKE_CHROME_PATH, host: 'www.amazon.com', protocol: 'tcp' }).policyName).not.toBe('SFE-ROUTE');
    // 环境的下一步按路由记录如实写明 SFE-ROUTE 当前是 REJECT
    const view = h.app.views.environmentView(a)!;
    expect(view.nextActions[0]).toMatchObject({ kind: 'activate' });
    expect(view.nextActions[0]!.message).toContain('Surge 中的节点可能是伪造的，SFE-ROUTE 当前是 REJECT');
    expect(view.nextActions.some((x) => x.kind === 'open_orders' || x.kind === 'probe_safari')).toBe(false);
    // 之后的对账不再排入（已是 REJECT）
    await h.app.runPeriodicReconcile();
    await h.idle();
    expect(holds()).toHaveLength(1);
    // 令牌、地址与端口从不进入操作说明或日志
    const token = h.app.engine.resource!.token;
    expect(`${text}\n${h.logs.join('\n')}`).not.toContain(token);
  });

  test('R2: evidence left while the service was stopped → the startup audit marks it, the executor holds REJECT after restart', async () => {
    h = await createHarness({ dbFile: true });
    const { envId: a } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    seedUnexplained([line(nodeOf(a), '192.0.2.66')]);
    await h.crash();
    await h.idle();
    expect(await selection()).toBe('REJECT');
    expect(holds()).toHaveLength(1);
    expect(holds()[0]).toMatchObject({ phase: 'COMPLETED', result: { rejectSelected: true } });
    expect(h.repos.routeState.get()).toMatchObject({ phase: 'attention', selectedNode: 'REJECT' });
    expect(forged()?.reasons).toContain('unexplained_fetch');
  });

  test('R2b: a pre-D11 install (tokenSuspect unexplained_fetch, no marker) is backfilled at startup and held', async () => {
    h = await createHarness({ dbFile: true });
    await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    h.app.engine.kv.set('resource:tokenSuspect', { since: h.clock.now().toISOString(), reason: 'unexplained_fetch' });
    expect(forged()).toBeNull();
    await h.crash();
    await h.idle();
    expect(forged()).toMatchObject({ reasons: ['unexplained_fetch'] });
    expect(await selection()).toBe('REJECT');
    expect(h.repos.routeState.get().warnings).toEqual(expect.arrayContaining(['node_resource_unverified', 'node_resource_forged']));
  });

  test('R2c (amendment 3): the backfill runs even when the read token is unavailable at restart', async () => {
    h = await createHarness({ dbFile: true });
    await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    h.app.engine.kv.set('resource:tokenSuspect', { since: h.clock.now().toISOString(), reason: 'unexplained_fetch' });
    await h.store.delete('sfe.resource-token.1');
    await h.crash();
    await h.idle();
    expect(h.app.engine.resource).toBeNull();
    expect(forged()).toMatchObject({ reasons: ['unexplained_fetch'] });
    expect(await selection()).toBe('REJECT');
  });

  test('R3: found by a publish discover audit → the publish parks on token_suspect, then the hold selects REJECT', async () => {
    h = await createHarness();
    const { envId: a } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    seedUnexplained([line(nodeOf(a), '192.0.2.66')]);
    const claims = recordClaims();
    const b = await createEnv(h, 'US-Buyer-B', '203.0.113.11');
    expect(op(b.operation_id)).toMatchObject({ phase: 'WAITING_DEPLOYMENT', error: { details: { reason: 'token_suspect' } } });
    const hs = holds();
    expect(hs).toHaveLength(1);
    expect(hs[0]).toMatchObject({ phase: 'COMPLETED', result: { rejectSelected: true } });
    expect(claims.indexOf(hs[0]!.id)).toBeGreaterThan(claims.indexOf(b.operation_id));
    expect(await selection()).toBe('REJECT');
  });

  test('R4: found by a deploy readback (port squatting) → BLOCKED publish, exactly one hold selects REJECT; normal mode still works', async () => {
    h = await createHarness();
    const { envId: a } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    h.clock.set(new Date(h.clock.now().getTime() + 30_000));
    h.resourceFault({ kind: 'squat', status: 200, body: resourceBody(99, [line(nodeOf(a), '192.0.2.66')]) });
    const b = await createEnv(h, 'US-Buyer-B', '203.0.113.11');
    h.resourceFault(null);
    expect(op(b.operation_id)).toMatchObject({ phase: 'BLOCKED_NEEDS_ATTENTION', status: 'needs_attention' });
    expect(await selection()).toBe('REJECT');
    expect(holds()).toHaveLength(1);
    expect(holds()[0]).toMatchObject({ phase: 'COMPLETED', result: { rejectSelected: true, rejectCause: 'node_resource_forged' } });
    expect(h.repos.routeState.get().warnings).toEqual(expect.arrayContaining(['node_resource_unverified', 'node_resource_forged']));
    const n = await h.app.enterNormal({ request_id: rid('normal'), old_session_policy: 'closed_confirmed', confirmed_environment_id: a }, WEB);
    await h.idle();
    expect(op(n.operation_id)).toMatchObject({ phase: 'NORMAL_RESTORED', status: 'succeeded' });
    // 普通模式不清除伪造状态，也不恢复买家节点
    expect(forged()).not.toBeNull();
    expect(h.repos.routeState.get().warnings).toEqual(expect.arrayContaining(['node_resource_unverified', 'node_resource_forged']));
    expect(await selection()).toBe('REJECT');
  });
});

describe('(b) the selected node differs from its revision while the route is not NORMAL', () => {
  test('R6: in the rollback readback (committed version) → BLOCKED publish with the forged marker, the hold selects REJECT', async () => {
    h = await createHarness();
    const { envId: a } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const nodeA = nodeOf(a);
    const origDetail = h.fake.getPolicyDetail.bind(h.fake);
    const publishPhase = () => h.repos.operations.listByStatus(['running']).find((o) => o.kind === 'environment.create')?.phase;
    h.fake.getPolicyDetail = async (name: string) => {
      const d = await origDetail(name);
      const phase = publishPhase();
      // 候选的新节点参数不同：发布读回失败、回滚；回滚读回中选中的已提交节点参数不同
      if (phase === 'DEPLOYING' && name !== nodeA) return { ...d, server: '192.0.2.77' };
      if (phase === 'ROLLING_BACK' && name === nodeA) return { ...d, server: '192.0.2.66' };
      return d;
    };
    const b = await createEnv(h, 'US-Buyer-B', '203.0.113.11');
    h.fake.getPolicyDetail = origDetail;
    expect(op(b.operation_id)).toMatchObject({ phase: 'BLOCKED_NEEDS_ATTENTION' });
    expect(forged()?.reasons).toEqual(['node_detail_mismatch']);
    expect(readTokenSuspect(h.app.engine.kv)).toBeNull();
    expect(await selection()).toBe('REJECT');
    expect(holds()).toHaveLength(1);
    expect(h.repos.routeState.get().warnings).toEqual(expect.arrayContaining(['node_resource_unverified', 'node_resource_forged']));
  });

  test('R6b (amendment 5): in the deploy readback while the rollback is skipped (Surge still updating) → held without waiting for a reconcile', async () => {
    h = await createHarness();
    const { envId: a } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const nodeA = nodeOf(a);
    const origDetail = h.fake.getPolicyDetail.bind(h.fake);
    const origList = h.fake.listExternalResources.bind(h.fake);
    const deploying = () => h.repos.operations.listByStatus(['running']).some((o) => o.kind === 'environment.create' && o.phase === 'DEPLOYING');
    h.fake.getPolicyDetail = async (name: string) => {
      const d = await origDetail(name);
      return deploying() && name === nodeA ? { ...d, server: '192.0.2.66' } : d;
    };
    // 读回之后 Surge 报告仍在更新：回滚不再更新（不进入按已提交版本的回滚读回）
    let readbackReads = 0;
    h.fake.listExternalResources = async () => {
      const list = await origList();
      if (!deploying() || h.app.engine.resource?.served()?.state !== 'candidate') return list;
      readbackReads++;
      return readbackReads > 2 ? list.map((r) => (r.key === h.resourceKey() ? { ...r, updating: true } : r)) : list;
    };
    const reconciles = h.repos.operations.listRecent(500).filter((o) => o.kind === 'maintenance.reconcile').length;
    const b = await createEnv(h, 'US-Buyer-B', '203.0.113.11');
    h.fake.getPolicyDetail = origDetail;
    h.fake.listExternalResources = origList;
    expect(op(b.operation_id).status).toBe('needs_attention');
    expect(forged()?.reasons).toEqual(['node_detail_mismatch']);
    expect(await selection()).toBe('REJECT');
    expect(holds()).toHaveLength(1);
    // 没有经对账
    expect(h.repos.operations.listRecent(500).filter((o) => o.kind === 'maintenance.reconcile').length).toBe(reconciles);
  });

  test('R6c (review RS-1/F1): in the deploy readback while the same publish\'s rollback confirms the committed nodes → the queued hold still selects REJECT', async () => {
    h = await createHarness();
    const { envId: a } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const nodeA = nodeOf(a);
    // Surge 真的载入了 A 的节点参数不同的列表（下载有审计记录，令牌不可疑）；还没有对账发现
    await driftNodes([line(nodeA, '192.0.2.66')]);
    const origUpdate = h.fake.updateExternalResource.bind(h.fake);
    const phase = () => h.repos.operations.listByStatus(['running']).find((o) => o.kind === 'environment.create')?.phase;
    // 部署的更新超时且没有载入候选：Surge 仍是参数不同的列表；回滚的更新下载已提交版本，完整读回确认
    h.fake.updateExternalResource = async (key: string) => {
      if (phase() === 'DEPLOYING') throw resourceUpdateTimeoutError();
      return origUpdate(key);
    };
    let markedInRollback = false;
    const origDetail = h.fake.getPolicyDetail.bind(h.fake);
    h.fake.getPolicyDetail = async (name: string) => {
      if (phase() === 'ROLLING_BACK' && forged() !== null) markedInRollback = true;
      return origDetail(name);
    };
    const selects = recordSelects();
    const b = await createEnv(h, 'US-Buyer-B', '203.0.113.11');
    h.fake.updateExternalResource = origUpdate;
    h.fake.getPolicyDetail = origDetail;
    expect(markedInRollback).toBe(true);
    expect(op(b.operation_id).status).not.toBe('succeeded');
    expect(steps(b.operation_id)).toContain('经读回确认');
    // 回滚的确认清除了标记（参数已恢复），但之前的参数不同仍是证据：保持照样改选 REJECT
    expect(forged()).toBeNull();
    expect(await selection()).toBe('REJECT');
    expect(selects.filter((s) => s.endsWith(':REJECT')).length).toBeGreaterThan(0);
    const hs = holds();
    expect(hs).toHaveLength(1);
    expect(hs[0]).toMatchObject({ phase: 'COMPLETED', status: 'succeeded', result: { rejectSelected: true, rejectCause: 'node_resource_forged' } });
    const text = steps(hs[0]!.id);
    expect(text).toContain('SFE-ROUTE 已改选 REJECT（读回确认）');
    expect(text).toContain('之后经确认的读回已恢复已提交版本的参数并清除了这一状态');
    expect(text).not.toContain('更换本机资源地址');
    const route = h.repos.routeState.get();
    expect(route).toMatchObject({ phase: 'attention', selectedNode: 'REJECT' });
    // 标记已清除：不再加两项节点资源警告（没有之后的确认会清除它们）；已建立的连接如实记下
    expect(route.warnings).toContain('buyer_exit_connections_unconfirmed');
    expect(route.warnings).not.toContain('node_resource_forged');
    expect(route.warnings).not.toContain('node_resource_unverified');
    // 之后的对账不再排入
    await h.app.runPeriodicReconcile();
    await h.idle();
    expect(holds()).toHaveLength(1);
  });

  test('R6e (review RS-1): same, and the hold\'s select fails → FAILED truthfully: no promise that a later reconcile retries (the marker is gone)', async () => {
    h = await createHarness();
    const { envId: a } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const nodeA = nodeOf(a);
    await driftNodes([line(nodeA, '192.0.2.66')]);
    const origUpdate = h.fake.updateExternalResource.bind(h.fake);
    const phase = () => h.repos.operations.listByStatus(['running']).find((o) => o.kind === 'environment.create')?.phase;
    h.fake.updateExternalResource = async (key: string) => {
      if (phase() === 'DEPLOYING') throw resourceUpdateTimeoutError();
      return origUpdate(key);
    };
    const origSelect = h.fake.selectGroupPolicy.bind(h.fake);
    h.fake.selectGroupPolicy = async (group: string, policy: string) => {
      if (running('route.hold')) throw new SfeError('SURGE_COMMAND_FAILED', '调用 Surge 失败：模拟失败');
      return origSelect(group, policy);
    };
    await createEnv(h, 'US-Buyer-B', '203.0.113.11');
    h.fake.updateExternalResource = origUpdate;
    h.fake.selectGroupPolicy = origSelect;
    expect(forged()).toBeNull();
    const hs = holds();
    expect(hs).toHaveLength(1);
    expect(hs[0]).toMatchObject({ phase: 'FAILED', result: { rejectSelected: false } });
    expect(hs[0]!.error!.message).toContain('伪造状态已清除，之后的对账不会再排入改选');
    expect(hs[0]!.error!.message).not.toContain('会再次尝试改选');
    expect(h.app.engine.kv.get(HOLD_KEY)).toBeNull();
    expect(await selection()).toBe(nodeA);
    // 已建立的连接如实记下（进入普通模式结束它们）；不加不会再被清除的两项节点资源警告
    const route = h.repos.routeState.get();
    expect(route.warnings).toContain('buyer_exit_connections_unconfirmed');
    expect(route.warnings).not.toContain('node_resource_forged');
  });

  test('R6d (review RS-1): the startup reconcile finds (b) while a publish that crashed before any write is re-run first and confirms the nodes → the hold still selects REJECT', async () => {
    h = await createHarness({ dbFile: true });
    const { envId: a } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const nodeA = nodeOf(a);
    await driftNodes([line(nodeA, '192.0.2.66')]);
    const stuck = hangAt(h, 'listPolicies', 1, { before: true });
    const b = await h.app.createEnvironment({ request_id: rid('create'), environment: envInput('US-Buyer-B', '203.0.113.11') }, WEB);
    await until(stuck.reached);
    expect(op(b.operation_id)).toMatchObject({ status: 'running' });
    expect(['DEPLOYING', 'RECONCILING', 'ROLLING_BACK']).not.toContain(op(b.operation_id).phase);
    stuck.restore();
    await h.crash();
    await h.idle();
    // 恢复中的发布（先于保持领取）经确认的读回清除了启动对账记下的标记
    expect(op(b.operation_id).status).toBe('succeeded');
    expect(forged()).toBeNull();
    const hs = holds();
    expect(hs).toHaveLength(1);
    expect(hs[0]).toMatchObject({ phase: 'COMPLETED', result: { rejectSelected: true } });
    expect(await selection()).toBe('REJECT');
    expect(h.repos.routeState.get()).toMatchObject({ selectedNode: 'REJECT', phase: 'attention' });
  });

  test('G5: a rollback that cannot update (Surge keeps the candidate) without a parameter mismatch on the selected node sets no marker and no hold', async () => {
    h = await createHarness();
    const { envId: a } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const nodeA = nodeOf(a);
    const origDetail = h.fake.getPolicyDetail.bind(h.fake);
    const origUpdate = h.fake.updateExternalResource.bind(h.fake);
    const phase = () => h.repos.operations.listByStatus(['running']).find((o) => o.kind === 'environment.create')?.phase;
    h.fake.getPolicyDetail = async (name: string) => {
      const d = await origDetail(name);
      return phase() === 'DEPLOYING' && name !== nodeA ? { ...d, server: '192.0.2.77' } : d;
    };
    h.fake.updateExternalResource = async (key: string) => {
      if (phase() === 'ROLLING_BACK') throw new SfeError('SURGE_COMMAND_FAILED', '调用 Surge 失败：模拟失败');
      return origUpdate(key);
    };
    const b = await createEnv(h, 'US-Buyer-B', '203.0.113.11');
    h.fake.getPolicyDetail = origDetail;
    h.fake.updateExternalResource = origUpdate;
    expect(op(b.operation_id)).toMatchObject({ phase: 'BLOCKED_NEEDS_ATTENTION' });
    expect(forged()).toBeNull();
    expect(holds()).toHaveLength(0);
    expect(await selection()).toBe(nodeA);
  });

  test('R14: the hold runs while an activation waits for its Safari check: phase and owner unchanged, the later check fails and the rollback keeps REJECT (the refresh may clear the forged state first)', async () => {
    h = await createHarness();
    const { a, b, nodeA, nodeB } = await activeAWithB();
    const act = await h.app.activate(b, { request_id: rid('act'), old_session_policy: 'closed_confirmed', confirmed_environment_id: a }, WEB);
    await h.idle();
    expect(op(act.operation_id)).toMatchObject({ status: 'waiting', phase: 'VERIFY_ONLY' });
    expect(await selection()).toBe(nodeB);
    const check = await beginCheck(PROFILE_B, act.operation_id);
    const selects = recordSelects();
    await driftNodes([line(nodeA, '203.0.113.10'), line(nodeB, '192.0.2.88')]);
    await h.app.runPeriodicReconcile();
    await h.idle();
    expect(await selection()).toBe('REJECT');
    const route = h.repos.routeState.get();
    // 负责的操作不变（对账已把阶段改为需要处理）；选择记为 REJECT，快照记下 forgedHeld
    expect(route).toMatchObject({ operationId: act.operation_id, selectedNode: 'REJECT' });
    expect(route.activationSnapshot?.forgedHeld).toBe(true);
    expect(op(act.operation_id).status).toBe('waiting');
    const hs = holds();
    expect(hs).toHaveLength(1);
    expect(steps(hs[0]!.id)).toContain('路由仍由未结束的切换负责');
    // 同一次对账排入的系统强制刷新经确认的读回清除了伪造状态（REJECT 不自动恢复）
    expect(forged()).toBeNull();
    const r = await submitCheck(PROFILE_B, act.operation_id, check);
    expect(r.ok).toBe(true);
    const o = op(act.operation_id);
    expect(o.status).toBe('failed');
    expect(o.result).toMatchObject({ rollback: { rejectKept: true, restoredSelection: null } });
    expect(steps(act.operation_id)).toContain('等待期间 Surge 中的节点可能是伪造的');
    expect(await selection()).toBe('REJECT');
    expect(selects.filter((s) => s.endsWith(`:${nodeA}`) || s.endsWith(`:${nodeB}`))).toEqual([]);
    expect(h.repos.routeState.get()).toMatchObject({ selectedNode: 'REJECT', entryMode: 'BLOCKED' });
  });

  test('R14b: same, with the system refresh parked (the forged state stays): the rollback keeps REJECT and both warnings', async () => {
    h = await createHarness();
    const { a, b, nodeA, nodeB } = await activeAWithB();
    const act = await h.app.activate(b, { request_id: rid('act'), old_session_policy: 'closed_confirmed', confirmed_environment_id: a }, WEB);
    await h.idle();
    const check = await beginCheck(PROFILE_B, act.operation_id);
    h.revoke(['loopback_publish_crash']);
    await driftNodes([line(nodeA, '203.0.113.10'), line(nodeB, '192.0.2.88')]);
    await h.app.runPeriodicReconcile();
    await h.idle();
    expect(forged()).not.toBeNull();
    expect(await selection()).toBe('REJECT');
    const r = await submitCheck(PROFILE_B, act.operation_id, check);
    expect(r.ok).toBe(true);
    expect(op(act.operation_id).status).toBe('failed');
    expect(await selection()).toBe('REJECT');
    expect(h.repos.routeState.get().warnings).toEqual(expect.arrayContaining(['node_resource_unverified', 'node_resource_forged']));
  });

  test('R14c (review F3): the hold fails during the wait (select throws) → the rollback keeps REJECT but does not claim REJECT was selected during the wait', async () => {
    h = await createHarness();
    const { a, b, nodeA, nodeB } = await activeAWithB();
    const act = await h.app.activate(b, { request_id: rid('act'), old_session_policy: 'closed_confirmed', confirmed_environment_id: a }, WEB);
    await h.idle();
    expect(op(act.operation_id)).toMatchObject({ status: 'waiting', phase: 'VERIFY_ONLY' });
    const check = await beginCheck(PROFILE_B, act.operation_id);
    h.revoke(['loopback_publish_crash']);
    const selects = recordSelects();
    h.fake.failNext('selectGroupPolicy', new SfeError('SURGE_COMMAND_FAILED', '调用 Surge 失败：模拟失败'));
    await driftNodes([line(nodeA, '203.0.113.10'), line(nodeB, '192.0.2.88')]);
    await h.app.runPeriodicReconcile();
    await h.idle();
    expect(holds()[0]).toMatchObject({ status: 'failed', result: { rejectSelected: false } });
    expect(await selection()).toBe(nodeB);
    // 回滚仍不恢复切换前的买家节点（forgedHeld 不论改选是否成功都记）
    const snap = h.repos.routeState.get().activationSnapshot;
    expect(snap?.forgedHeld).toBe(true);
    expect(snap?.forgedHoldSelected).toBeUndefined();
    await submitCheck(PROFILE_B, act.operation_id, check);
    const o = op(act.operation_id);
    expect(o.status).toBe('failed');
    expect(o.result).toMatchObject({ rollback: { rejectKept: true, restoredSelection: null } });
    // 核对时（已选择目标节点之后）的拒绝不是写入之前的拒绝（准备页据此不说「没有选择任何买家节点」）
    expect(o.error).toMatchObject({ code: 'NODE_NOT_DEPLOYED', details: { forged: true } });
    expect((o.error?.details as { beforeWrite?: unknown }).beforeWrite).toBeUndefined();
    expect(await selection()).toBe('REJECT');
    expect(selects.filter((x) => x.endsWith(`:${nodeA}`))).toEqual([]);
    const text = steps(act.operation_id);
    expect(text).not.toContain('等待期间 Surge 中的节点可能是伪造的、SFE-ROUTE 已改选 REJECT');
    expect(text).toContain('切换失败：Surge 中的节点可能是伪造的，不恢复切换前的买家节点');
  });

  test('R14d (review F3): forgedHeld carried from an interrupted earlier switch into a new activation → its rollback keeps REJECT without claiming a REJECT during its own wait', async () => {
    h = await createHarness();
    const { a, b, nodeA } = await activeAWithB();
    // 之前一次切换中断而快照仍在：它的等待期间 REJECT 保持读回确认过（forgedHeld 与 forgedHoldSelected）；伪造状态之后已清除
    const r0 = h.repos.routeState.get();
    h.repos.routeState.update({
      activationSnapshot: {
        previousEnvironmentId: a,
        previousProxyRevision: r0.activeProxyRevision,
        previousSelectedNode: nodeA,
        previousEntryMode: r0.entryMode,
        previousSafariProbeId: null,
        previousRouteEpoch: r0.routeEpoch,
        previousPhase: r0.phase,
        forgedHeld: true,
        forgedHoldSelected: true,
      },
    });
    expect(forged()).toBeNull();
    const act = await h.app.activate(b, { request_id: rid('act'), old_session_policy: 'closed_confirmed', confirmed_environment_id: a }, WEB);
    await h.idle();
    expect(op(act.operation_id)).toMatchObject({ status: 'waiting', phase: 'VERIFY_ONLY' });
    // 新的切换沿用快照：forgedHeld 沿用（回滚不恢复切换前的买家节点），forgedHoldSelected 去掉
    const snap = h.repos.routeState.get().activationSnapshot;
    expect(snap?.forgedHeld).toBe(true);
    expect(snap?.forgedHoldSelected).toBeUndefined();
    await h.app.cancelOperation(act.operation_id, { request_id: rid('cancel') }, WEB);
    await h.idle();
    expect(op(act.operation_id).result).toMatchObject({ rollback: { rejectKept: true, restoredSelection: null } });
    expect(await selection()).toBe('REJECT');
    const text = steps(act.operation_id);
    expect(text).not.toContain('等待期间 Surge 中的节点可能是伪造的、SFE-ROUTE 已改选 REJECT');
    expect(text).toContain('这次或之前的切换进行中服务发现过 Surge 中的节点可能是伪造的');
  });

  test('G1: a drift on a node that is not selected, or with the route idle NORMAL, only raises the warning (no marker, no hold)', async () => {
    h = await createHarness();
    const { a, nodeA, nodeB } = await activeAWithB();
    h.revoke(['loopback_publish_crash']);
    await driftNodes([line(nodeA, '203.0.113.10'), line(nodeB, '192.0.2.88')]);
    await h.app.runPeriodicReconcile();
    await h.idle();
    expect(forged()).toBeNull();
    expect(holds()).toHaveLength(0);
    expect(await selection()).toBe(nodeA);
    expect(h.repos.routeState.get()).toMatchObject({ activeEnvironmentId: a, selectedNode: nodeA });
  });
});

describe('the hold yields to normal mode and never refuses it', () => {
  test('R7: enqueued inside a running activation; a normal mode accepted meanwhile runs first and the hold then needs nothing', async () => {
    h = await createHarness();
    const { a, b, nodeA, nodeB } = await activeAWithB();
    seedUnexplained([line(nodeA, '192.0.2.66'), line(nodeB, '203.0.113.11')]);
    const selects = recordSelects();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let reached = false;
    const origSel = h.fake.getGroupSelection.bind(h.fake);
    h.fake.getGroupSelection = async (group: string) => {
      if (!reached && running('route.activate') && forged() !== null) {
        reached = true;
        await gate;
      }
      return origSel(group);
    };
    const act = await h.app.activate(b, { request_id: rid('act'), old_session_policy: 'closed_confirmed', confirmed_environment_id: a }, WEB);
    await until(() => reached);
    expect(holds()).toHaveLength(1);
    expect(holds()[0]!.status).toBe('queued');
    const n = await h.app.enterNormal({ request_id: rid('normal'), old_session_policy: 'closed_confirmed', confirmed_environment_id: a }, WEB);
    expect(op(n.operation_id).status).toBe('queued');
    const claims = recordClaims();
    release();
    await h.idle();
    h.fake.getGroupSelection = origSel;
    expect(op(act.operation_id).error).toMatchObject({ code: 'NODE_NOT_DEPLOYED' });
    expect(op(n.operation_id)).toMatchObject({ phase: 'NORMAL_RESTORED', status: 'succeeded' });
    const hold = holds()[0]!;
    expect(claims.indexOf(n.operation_id)).toBeLessThan(claims.indexOf(hold.id));
    expect(op(hold.id)).toMatchObject({ phase: 'COMPLETED', status: 'succeeded', result: { forgedHold: 'not_needed' } });
    expect(selects.filter((s) => s.startsWith('route.hold'))).toEqual([]);
  });

  test('R7b: a hold that crashed after recording its intent and before selecting yields to a normal mode accepted before the restart (SUPERSEDED, no select)', async () => {
    h = await createHarness({ dbFile: true });
    const { envId: a } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const nodeA = nodeOf(a);
    seedUnexplained([line(nodeA, '192.0.2.66')]);
    const orig = h.fake.selectGroupPolicy.bind(h.fake);
    let reached = false;
    h.fake.selectGroupPolicy = async (group: string, policy: string) => {
      if (running('route.hold')) {
        reached = true;
        return new Promise(() => undefined);
      }
      return orig(group, policy);
    };
    await h.app.runPeriodicReconcile();
    await until(() => reached);
    const hold = holds()[0]!;
    expect(op(hold.id)).toMatchObject({ status: 'running', payload: { endHold: { cause: 'node_resource_forged' } } });
    const n = await h.app.enterNormal({ request_id: rid('normal'), old_session_policy: 'closed_confirmed', confirmed_environment_id: a }, WEB);
    h.fake.selectGroupPolicy = orig;
    const selects = recordSelects();
    await h.crash();
    await h.idle();
    expect(holds()).toHaveLength(1);
    expect(op(hold.id)).toMatchObject({ phase: 'SUPERSEDED', status: 'superseded', supersededBy: n.operation_id });
    expect(op(n.operation_id)).toMatchObject({ phase: 'NORMAL_RESTORED', status: 'succeeded' });
    expect(selects.filter((s) => s.endsWith(':REJECT'))).toEqual([]);
  });

  test('G3: normal mode is accepted from the web and the popup while the forged state is set', async () => {
    h = await createHarness();
    const { envId: a } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    seedUnexplained([line(nodeOf(a), '192.0.2.66')]);
    await h.app.runPeriodicReconcile();
    await h.idle();
    expect(await selection()).toBe('REJECT');
    const popup = await h.native(PROFILE_A, { type: 'enterNormalMode', request_id: rid('normal'), old_session_policy: 'closed_confirmed', confirmed_environment_id: a });
    expect(popup.ok).toBe(true);
    await h.idle();
    expect(h.repos.routeState.get()).toMatchObject({ entryMode: 'NORMAL', phase: 'idle' });
    const web = await h.app.enterNormal({ request_id: rid('normal') }, WEB);
    await h.idle();
    expect(op(web.operation_id).status).toBe('succeeded');
  });
});

describe('the route operation that ends while the forged state is set', () => {
  test('R8: an activation refused by its precheck (unexplained fetch) ends in REJECT though the selection was the verified exit; no entry_unverified', async () => {
    h = await createHarness();
    const { a, b, nodeA, nodeB } = await activeAWithB();
    seedUnexplained([line(nodeA, '192.0.2.66'), line(nodeB, '203.0.113.11')]);
    const act = await h.app.activate(b, { request_id: rid('act'), old_session_policy: 'closed_confirmed', confirmed_environment_id: a }, WEB);
    await h.idle();
    const o = op(act.operation_id);
    expect(o.error).toMatchObject({ code: 'NODE_NOT_DEPLOYED', details: { forged: true, rejectSelected: true, rejectCause: 'node_resource_forged' } });
    expect(o.result).toMatchObject({ rejectSelected: true, rejectCause: 'node_resource_forged' });
    expect(o.error!.message).toContain('Surge 中的节点可能是伪造的');
    expect(o.error!.message).not.toContain('路由未改变');
    expect(steps(act.operation_id)).not.toContain('路由未改变');
    const route = h.repos.routeState.get();
    expect(route.warnings).not.toContain('entry_unverified');
    expect(route.warnings).toEqual(expect.arrayContaining(['node_resource_unverified', 'node_resource_forged', 'buyer_exit_connections_unconfirmed']));
    expect(route).toMatchObject({ selectedNode: 'REJECT', phase: 'attention' });
    expect(await selection()).toBe('REJECT');
  });

  test('R9: a failed normal mode no longer counts the selected buyer node as the verified exit while the forged marker is set', async () => {
    h = await createHarness({ entryStrategy: 'temp_rule' });
    const { envId: a } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    setForged(['unexplained_fetch']);
    h.fake.failNext('addTempRule');
    const n = await h.app.enterNormal({ request_id: rid('normal'), old_session_policy: 'closed_confirmed', confirmed_environment_id: a }, WEB);
    await h.idle();
    expect(op(n.operation_id).status).toBe('failed');
    expect(op(n.operation_id).result).toMatchObject({ rejectSelected: true });
    expect(await selection()).toBe('REJECT');
  });

  test('item 2: the marker without the warning still refuses an activation (the target itself not drifted) and raises both warnings; nothing selected', async () => {
    h = await createHarness();
    const a = (await createEnv(h, 'US-Buyer-A', '203.0.113.10')).environment_id!;
    await bind(h, PROFILE_A, a);
    setForged(['node_detail_mismatch']);
    const selects = calls('selectGroupPolicy');
    const act = await h.app.activate(a, { request_id: rid('act') }, WEB);
    await h.idle();
    expect(op(act.operation_id)).toMatchObject({ status: 'failed', error: { code: 'NODE_NOT_DEPLOYED', details: { forged: true, beforeWrite: true } } });
    expect(op(act.operation_id).error!.message).toContain('Surge 中的节点可能是伪造的');
    expect(calls('selectGroupPolicy')).toBe(selects);
    expect(h.repos.routeState.get().warnings).toEqual(expect.arrayContaining(['node_resource_unverified', 'node_resource_forged']));
    expect(h.repos.routeState.get()).toMatchObject({ entryMode: 'NORMAL', phase: 'idle' });
  });
});

describe('crash safety, dedup, failures and the claim order', () => {
  test('R10: crash after the select and before recording → the recovered hold records its own REJECT; no lingering external_selection_change', async () => {
    h = await createHarness({ dbFile: true });
    const { envId: a } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    seedUnexplained([line(nodeOf(a), '192.0.2.66')]);
    const stuck = hangAt(h, 'selectGroupPolicy', 1);
    await h.app.runPeriodicReconcile();
    await until(stuck.reached);
    expect(await selection()).toBe('REJECT');
    stuck.restore();
    await h.crash();
    await h.idle();
    const hs = holds();
    expect(hs).toHaveLength(1);
    expect(hs[0]).toMatchObject({ phase: 'COMPLETED', result: { rejectSelected: true } });
    const route = h.repos.routeState.get();
    expect(route.selectedNode).toBe('REJECT');
    expect(route.warnings).not.toContain('external_selection_change');
  });

  test('R10c (review F2): same, and the recovered hold\'s first selection read fails → its re-read REJECT still counts as its own selection', async () => {
    h = await createHarness({ dbFile: true });
    const { envId: a } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    seedUnexplained([line(nodeOf(a), '192.0.2.66')]);
    const stuck = hangAt(h, 'selectGroupPolicy', 1);
    await h.app.runPeriodicReconcile();
    await until(stuck.reached);
    expect(await selection()).toBe('REJECT');
    stuck.restore();
    // 恢复中的保持第一次读取选择失败（只这一次）
    const orig = h.fake.getGroupSelection.bind(h.fake);
    let failed = false;
    h.fake.getGroupSelection = async (group: string) => {
      if (!failed && (new Error().stack ?? '').includes('runForgedHold')) {
        failed = true;
        throw new SfeError('SURGE_COMMAND_FAILED', '调用 Surge 失败：模拟失败');
      }
      return orig(group);
    };
    await h.crash();
    await h.idle();
    h.fake.getGroupSelection = orig;
    expect(failed).toBe(true);
    const hs = holds();
    expect(hs).toHaveLength(1);
    expect(hs[0]).toMatchObject({ phase: 'COMPLETED', result: { rejectSelected: true } });
    expect(steps(hs[0]!.id)).not.toContain('SFE-ROUTE 已是 REJECT，不需要改选');
    const route = h.repos.routeState.get();
    expect(route.selectedNode).toBe('REJECT');
    expect(route.warnings).not.toContain('external_selection_change');
    expect(route.warnings).toContain('buyer_exit_connections_unconfirmed');
  });

  test('R10b: crash before the select → the recovered hold selects REJECT', async () => {
    h = await createHarness({ dbFile: true });
    const { envId: a } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    seedUnexplained([line(nodeOf(a), '192.0.2.66')]);
    const orig = h.fake.getGroupSelection.bind(h.fake);
    let reached = false;
    h.fake.getGroupSelection = async (group: string) => {
      if (!reached && running('route.hold')) {
        reached = true;
        return new Promise(() => undefined);
      }
      return orig(group);
    };
    await h.app.runPeriodicReconcile();
    await until(() => reached);
    h.fake.getGroupSelection = orig;
    await h.crash();
    await h.idle();
    expect(await selection()).toBe('REJECT');
    expect(holds()).toHaveLength(1);
    expect(holds()[0]).toMatchObject({ phase: 'COMPLETED', result: { rejectSelected: true } });
  });

  test('R11: at most one queued hold', async () => {
    h = await createHarness();
    await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    setForged(['unexplained_fetch']);
    const mod = (await import('../../src/engine/node-resource.js')) as Record<string, unknown>;
    const enqueue = mod.maybeEnqueueForgedHold as (e: unknown) => unknown;
    expect(enqueue(h.app.engine)).not.toBeNull();
    // 之后新增的原因补记到已排队的保持（标记在它执行之前被清除时它按这些原因判断，review RS-1）
    setForged(['unexplained_fetch', 'node_detail_mismatch']);
    expect(enqueue(h.app.engine)).toBeNull();
    expect(holds()).toHaveLength(1);
    expect((holds()[0]!.payload as { forgedHold?: { reasons: string[] } }).forgedHold?.reasons).toEqual(['unexplained_fetch', 'node_detail_mismatch']);
    await h.idle();
    expect(await selection()).toBe('REJECT');
  });

  test('R12: Surge unreachable at the select → FAILED truthfully; the next reachable periodic reconcile enqueues again (no spacing) and holds', async () => {
    h = await createHarness();
    const { envId: a } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const nodeA = nodeOf(a);
    seedUnexplained([line(nodeA, '192.0.2.66')]);
    h.fake.failNext('selectGroupPolicy', new SfeError('SURGE_UNREACHABLE', '无法连接 Surge：模拟'));
    await h.app.runPeriodicReconcile();
    await h.idle();
    const first = holds()[0]!;
    expect(first).toMatchObject({ phase: 'FAILED', status: 'failed', error: { code: 'SURGE_UNREACHABLE' } });
    expect(first.error!.message).toContain('未能改选 REJECT');
    expect(first.error!.message).toContain('请立即进入普通模式');
    expect(first.error!.message).not.toContain('已改选');
    expect(first.result).toMatchObject({ rejectSelected: false });
    expect(await selection()).toBe(nodeA);
    expect(h.app.engine.kv.get(HOLD_KEY)).toMatchObject({ unreachable: true });
    // 没有确认改选时环境的下一步不声称已改选
    expect(h.app.views.environmentView(a)!.nextActions[0]!.message).toContain('SFE-ROUTE 尚未确认改选 REJECT');
    await h.app.runPeriodicReconcile();
    await h.idle();
    expect(holds()).toHaveLength(2);
    expect(holds()[1]).toMatchObject({ phase: 'COMPLETED', result: { rejectSelected: true } });
    expect(await selection()).toBe('REJECT');
    expect(h.app.engine.kv.get(HOLD_KEY)).toBeNull();
  });

  test('R12b: a reachable readback mismatch → spaced 5 minutes for periodic reconciles; a manual refresh enqueues at once', async () => {
    h = await createHarness();
    const { envId: a } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const nodeA = nodeOf(a);
    seedUnexplained([line(nodeA, '192.0.2.66')]);
    const orig = h.fake.selectGroupPolicy.bind(h.fake);
    let ignored = false;
    h.fake.selectGroupPolicy = async (group: string, policy: string) => {
      // Surge 没有应用这次改选：读回仍是原节点
      if (!ignored && policy === 'REJECT' && running('route.hold')) {
        ignored = true;
        return;
      }
      return orig(group, policy);
    };
    await h.app.runPeriodicReconcile();
    await h.idle();
    expect(holds()[0]).toMatchObject({ phase: 'FAILED', error: { code: 'READBACK_MISMATCH' } });
    expect(h.app.engine.kv.get(HOLD_KEY)).toMatchObject({ unreachable: false });
    h.clock.set(new Date(h.clock.now().getTime() + 60_000));
    await h.app.runPeriodicReconcile();
    await h.idle();
    expect(holds()).toHaveLength(1);
    expect(await selection()).toBe(nodeA);
    await h.app.refreshSurge(WEB);
    await h.idle();
    expect(holds()).toHaveLength(2);
    expect(await selection()).toBe('REJECT');
  });

  test('item 4: not on the working profile → nothing enqueued or selected; back on the working profile → held', async () => {
    h = await createHarness();
    const { envId: a } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const nodeA = nodeOf(a);
    setForged(['unexplained_fetch']);
    const working = { ...h.fake.currentProfile };
    h.fake.currentProfile = { name: 'Other', path: `${h.surgeDir}/Other.conf` };
    const selects = calls('selectGroupPolicy');
    await h.app.runPeriodicReconcile();
    await h.idle();
    expect(holds()).toHaveLength(0);
    expect(calls('selectGroupPolicy')).toBe(selects);
    expect(h.repos.routeState.get().warnings).toContain('node_resource_forged');
    // 已排入的保持在执行时发现不是工作配置：不改选
    const mod = (await import('../../src/engine/node-resource.js')) as Record<string, unknown>;
    h.app.engine.facts.onWorkingProfile = true;
    expect((mod.maybeEnqueueForgedHold as (e: unknown) => unknown)(h.app.engine)).not.toBeNull();
    await h.idle();
    expect(holds()[0]).toMatchObject({ phase: 'FAILED', error: { code: 'EXTERNAL_PROFILE' } });
    expect(calls('selectGroupPolicy')).toBe(selects);
    expect(await selection()).toBe(nodeA);
    h.fake.currentProfile = working;
    await h.app.runPeriodicReconcile();
    await h.idle();
    expect(await selection()).toBe('REJECT');
    expect(holds().at(-1)).toMatchObject({ phase: 'COMPLETED', result: { rejectSelected: true } });
  });

  test('R15: claim order — a queued hold before an older queued publish; a queued normal mode before the hold', async () => {
    h = await createHarness();
    await h.idle();
    await h.app.stop();
    const { repos } = h;
    const insert = (id: string, kind: string, payload: Record<string, unknown> = {}) => {
      repos.operations.insert({ id, requestId: rid(id), requestDigest: 'service', kind: kind as OperationRecord['kind'], initiatorKind: 'service', phase: 'SAVED', status: 'queued', payload });
      repos.outbox.enqueue(id, null, h.clock.now());
    };
    insert('op_test_publish', 'deploy.publish', { environmentIds: [] });
    insert('op_test_hold', 'route.hold', { forgedHold: { reasons: ['unexplained_fetch'] } });
    const mod = (await import('../../src/engine/executor.js')) as { Executor: new (e: unknown, d: unknown) => unknown };
    const pref = () => (new mod.Executor(h.app.engine, async () => undefined) as unknown as { claimPreference(): string[][] }).claimPreference();
    expect(repos.outbox.claimNext(h.clock.now(), pref())!.operationId).toBe('op_test_hold');
    insert('op_test_hold2', 'route.hold', { forgedHold: { reasons: ['unexplained_fetch'] } });
    insert('op_test_normal', 'route.normal', { normal: { oldSessionPolicy: null, expectedActiveEnvironmentId: null, hadManagedEnvironment: false } });
    expect(repos.outbox.claimNext(h.clock.now(), pref())!.operationId).toBe('op_test_normal');
    expect(repos.outbox.claimNext(h.clock.now(), pref())!.operationId).toBe('op_test_hold2');
    expect(repos.outbox.claimNext(h.clock.now(), pref())!.operationId).toBe('op_test_publish');
  });
});

describe('clearing', () => {
  test('R13: (a) with tokenSuspect: activation refused; normal mode; remerge with a new resource address → the forced publish clears the forged state; REJECT kept; explicit re-use works', async () => {
    h = await createHarness();
    const { envId: a } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    seedUnexplained([line(nodeOf(a), '192.0.2.66')]);
    await h.app.runPeriodicReconcile();
    await h.idle();
    expect(await selection()).toBe('REJECT');
    const selects = calls('selectGroupPolicy');
    const refused = await h.app.activate(a, { request_id: rid('act') }, WEB);
    await h.idle();
    expect(op(refused.operation_id).error).toMatchObject({ code: 'NODE_NOT_DEPLOYED', details: { forged: true } });
    expect(op(refused.operation_id).error!.message).toContain('更换本机资源地址');
    expect(calls('selectGroupPolicy')).toBe(selects);
    const n = await h.app.enterNormal({ request_id: rid('normal'), old_session_policy: 'closed_confirmed', confirmed_environment_id: a }, WEB);
    await h.idle();
    expect(op(n.operation_id).phase).toBe('NORMAL_RESTORED');
    const p = await h.app.remergePreview(WEB, { rotateResourceUrl: true });
    expect(p.checks.find((c) => c.name === 'forged_nodes')).toMatchObject({ ok: true });
    expect(p.checks.find((c) => c.name === 'forged_nodes')!.message).toContain('更换本机资源地址');
    const acc = await h.app.remergeCommit({ request_id: rid(), preview_digest: p.preview_digest, rotateResourceUrl: true }, WEB);
    await h.idle();
    expect(op(acc.operation_id).phase).toBe('COMPLETED');
    expect(forged()).toBeNull();
    expect(readTokenSuspect(h.app.engine.kv)).toBeNull();
    const route = h.repos.routeState.get();
    expect(route.warnings).not.toContain('node_resource_forged');
    expect(route.warnings).not.toContain('node_resource_unverified');
    expect(await selection()).toBe('REJECT');
    const act = await h.app.activate(a, { request_id: rid('act') }, WEB);
    await h.idle();
    const r = await verify(h, PROFILE_A, act.operation_id);
    expect(r.ok).toBe(true);
    expect(op(act.operation_id).phase).toBe('ACTIVE_VERIFIED');
    expect(await selection()).toBe(nodeOf(a));
  });

  test('confirmNodeResource keeps the marker while the token is suspect; a node_detail_mismatch marker needs a full parameter readback (amendment 6)', async () => {
    h = await createHarness();
    await h.idle();
    const engine = h.app.engine;
    const mark = engine.resource!.auditMark();
    h.clock.advance(2_000);
    await h.fake.updateExternalResource(h.resourceKey()!);
    const r = (await ourResource(h))!;
    const matched = matchAuditRecord(engine.resource!.audit(), r.lastUpdatedAt!, engine.resourceAuditToleranceMs(), mark, 0)!;
    const confirm = (detailsChecked: boolean) =>
      confirmNodeResource(engine, { generation: 0, matchedSeq: matched.seq, snapshot: { updatedAt: r.lastUpdatedAt, error: r.error }, clearNeedsRefresh: true, detailsChecked } as Parameters<typeof confirmNodeResource>[1]);
    h.repos.routeState.update({ warnings: ['node_resource_unverified', 'node_resource_forged'] });
    // 令牌可疑：保留
    setForged(['unexplained_fetch']);
    h.app.engine.kv.set('resource:tokenSuspect', { since: h.clock.now().toISOString(), reason: 'unexplained_fetch' });
    confirm(true);
    expect(forged()).not.toBeNull();
    expect(h.repos.routeState.get().warnings).toEqual(expect.arrayContaining(['node_resource_unverified', 'node_resource_forged']));
    h.app.engine.kv.delete('resource:tokenSuspect');
    // 参数不同的原因：读回不完整时保留（与两项警告、刷新要求一起）
    setForged(['node_detail_mismatch']);
    h.app.engine.kv.set('resource:needsRefresh', { generation: 0, reason: 'node_detail_mismatch' });
    confirm(false);
    expect(forged()).not.toBeNull();
    expect(readNeedsRefresh(engine.kv)).not.toBeNull();
    expect(h.repos.routeState.get().warnings).toEqual(expect.arrayContaining(['node_resource_unverified', 'node_resource_forged']));
    confirm(true);
    expect(forged()).toBeNull();
    expect(readNeedsRefresh(engine.kv)).toBeNull();
    expect(h.repos.routeState.get().warnings).not.toContain('node_resource_forged');
    expect(h.repos.routeState.get().warnings).not.toContain('node_resource_unverified');
  });

  test('item 7: an unreadable marker is held with a truthful reason (not "Surge reported a download")', async () => {
    h = await createHarness();
    await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    h.app.engine.kv.set(FORGED_KEY, 'garbage');
    await h.app.runPeriodicReconcile();
    await h.idle();
    expect(await selection()).toBe('REJECT');
    const text = steps(holds()[0]!.id);
    expect(text).toContain('无法读取');
    expect(text).not.toContain('Surge 报告了本服务没有提供过的下载');
  });
});

describe('warning-only reasons keep today\'s behaviour (G2)', () => {
  test('an unexplained resource error on an active route: tokenSuspect and the warning, no marker, no hold, selection unchanged', async () => {
    h = await createHarness();
    const { envId: a } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    await h.app.runPeriodicReconcile();
    h.clock.set(new Date(h.clock.now().getTime() + 1_000));
    h.resourceFault({ kind: 'squat', status: 404, body: '' }, { times: 1 });
    await expect(h.fake.updateExternalResource(h.resourceKey()!)).rejects.toThrow();
    await h.app.runPeriodicReconcile();
    await h.idle();
    expect(readTokenSuspect(h.app.engine.kv)).toMatchObject({ reason: 'unexplained_error' });
    expect(h.repos.routeState.get().warnings).toContain('node_resource_unverified');
    expect(forged()).toBeNull();
    expect(holds()).toHaveLength(0);
    expect(await selection()).toBe(nodeOf(a));
  });
});

describe('guards pinned after the final verification', () => {
  /** 使用中环境 A 进入普通模式且入口经确认（entryMode NORMAL、没有 entry_unverified）；SFE-ROUTE 仍选着 A 的节点。 */
  async function confirmedNormalWithBuyerSelection(): Promise<{ a: string; nodeA: string }> {
    const { envId: a } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const nodeA = nodeOf(a);
    const n = await h.app.enterNormal({ request_id: rid('normal'), old_session_policy: 'closed_confirmed', confirmed_environment_id: a }, WEB);
    await h.idle();
    expect(op(n.operation_id)).toMatchObject({ phase: 'NORMAL_RESTORED', status: 'succeeded' });
    const route = h.repos.routeState.get();
    expect(route.entryMode).toBe('NORMAL');
    expect(route.warnings).not.toContain('entry_unverified');
    // 前提：普通模式之后 SFE-ROUTE 仍选着买家节点（否则看不出是否改选）
    expect(await selection()).toBe(nodeA);
    return { a, nodeA };
  }

  test('G6: an unexplained fetch while the route is a confirmed NORMAL records the marker but queues no hold and selects nothing', async () => {
    h = await createHarness();
    const { nodeA } = await confirmedNormalWithBuyerSelection();
    const selects = calls('selectGroupPolicy');
    seedUnexplained([line(nodeA, '192.0.2.66')]);
    await h.app.runPeriodicReconcile();
    await h.idle();
    expect(forged()?.reasons).toContain('unexplained_fetch');
    expect(holds()).toHaveLength(0);
    expect(calls('selectGroupPolicy')).toBe(selects);
    expect(await selection()).toBe(nodeA);
  });

  test('G7: a parameter drift of the selected node while the route is a confirmed NORMAL sets no marker and queues no hold', async () => {
    h = await createHarness();
    const { nodeA } = await confirmedNormalWithBuyerSelection();
    const selects = calls('selectGroupPolicy');
    h.revoke(['loopback_publish_crash']);
    await driftNodes([line(nodeA, '192.0.2.88')]);
    await h.app.runPeriodicReconcile();
    await h.idle();
    expect(forged()).toBeNull();
    expect(holds()).toHaveLength(0);
    expect(calls('selectGroupPolicy')).toBe(selects);
    expect(await selection()).toBe(nodeA);
  });

  test('item 2b: the marker alone (no warning) appearing while an activation waits for its Safari check refuses the commit; the rollback keeps REJECT', async () => {
    h = await createHarness();
    const { a, b, nodeA, nodeB } = await activeAWithB();
    const act = await h.app.activate(b, { request_id: rid('act'), old_session_policy: 'closed_confirmed', confirmed_environment_id: a }, WEB);
    await h.idle();
    expect(op(act.operation_id)).toMatchObject({ status: 'waiting', phase: 'VERIFY_ONLY' });
    expect(await selection()).toBe(nodeB);
    const check = await beginCheck(PROFILE_B, act.operation_id);
    // 标记在而警告还没有加上（例如对账在标记之后抛出）
    setForged(['unexplained_fetch']);
    expect(h.repos.routeState.get().warnings).not.toContain('node_resource_unverified');
    const selects = recordSelects();
    const r = await submitCheck(PROFILE_B, act.operation_id, check);
    expect(r.ok).toBe(true);
    const o = op(act.operation_id);
    expect(o.status).toBe('failed');
    expect(o.error).toMatchObject({ code: 'NODE_NOT_DEPLOYED', details: { forged: true } });
    expect(o.error!.message).toContain('Surge 中的节点可能是伪造的');
    expect(h.repos.routeState.get().entryMode).not.toBe('ACTIVE');
    expect(h.repos.routeState.get().activeEnvironmentId).not.toBe(b);
    expect(await selection()).toBe('REJECT');
    expect(selects.filter((s) => s.endsWith(`:${nodeA}`) || s.endsWith(`:${nodeB}`))).toEqual([]);
  });

  test('item 2c: the marker alone (no warning) stops a publish rollback from re-selecting the node Surge dropped (fallback to REJECT stays)', async () => {
    h = await createHarness();
    const { envId: a } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const selected = nodeOf(a);
    expect(await selection()).toBe(selected);
    setForged(['unexplained_fetch']);
    expect(h.repos.routeState.get().warnings).not.toContain('node_resource_unverified');
    const selects = recordSelects();
    // Surge 跳过了这次下载中选中节点的行：它从成员中消失，选择回落到 REJECT
    dropNodesOnNextUpdate(h, [selected]);
    const b = await createEnv(h, 'US-Buyer-B', '203.0.113.11');
    expect(op(b.operation_id).status).not.toBe('succeeded');
    expect(selects.filter((s) => s.endsWith(`:${selected}`))).toEqual([]);
    expect(await selection()).toBe('REJECT');
    expect(steps(b.operation_id)).not.toContain('原选择已恢复');
  });

  test('R7c: a hold queued while the route was ACTIVE runs after a normal mode made the route a confirmed NORMAL → not needed, the buyer selection is left alone', async () => {
    h = await createHarness();
    const { envId: a } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const nodeA = nodeOf(a);
    // 暂停执行器的领取：保持与普通模式都排队之后再按领取顺序执行（普通模式先于保持，R15）
    let paused = true;
    const claim = h.repos.outbox.claimNext.bind(h.repos.outbox);
    h.repos.outbox.claimNext = (now, prefer) => (paused ? null : claim(now, prefer));
    setForged(['unexplained_fetch']);
    const hold = maybeEnqueueForgedHold(h.app.engine, { selection: nodeA });
    expect(hold).not.toBeNull();
    const n = await h.app.enterNormal({ request_id: rid('normal'), old_session_policy: 'closed_confirmed', confirmed_environment_id: a }, WEB);
    expect(op(n.operation_id).status).toBe('queued');
    const claims = recordClaims();
    const selects = recordSelects();
    paused = false;
    h.app.engine.kick();
    await h.idle();
    expect(op(n.operation_id)).toMatchObject({ phase: 'NORMAL_RESTORED', status: 'succeeded' });
    expect(claims.indexOf(n.operation_id)).toBeLessThan(claims.indexOf(hold!.id));
    expect(h.repos.routeState.get().entryMode).toBe('NORMAL');
    expect(op(hold!.id)).toMatchObject({ phase: 'COMPLETED', status: 'succeeded', result: { forgedHold: 'not_needed' } });
    expect(steps(hold!.id)).toContain('入口是经确认的普通模式');
    expect(selects.filter((s) => s.endsWith(':REJECT'))).toEqual([]);
    expect(await selection()).toBe(nodeA);
  });

  test('R4b: a deploy readback that sees an unexplained download whose selected-node parameters match marks unexplained_fetch on its own and holds REJECT', async () => {
    h = await createHarness();
    const { envId: a } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const nodeA = nodeOf(a);
    const detail = await h.fake.getPolicyDetail(nodeA);
    h.clock.set(new Date(h.clock.now().getTime() + 30_000));
    // 占用者提供的列表中选中节点的参数与其版本相同：只有“无法解释的下载”这一条证据
    h.resourceFault({ kind: 'squat', status: 200, body: resourceBody(99, [line(nodeA, detail.server!)]) });
    const b = await createEnv(h, 'US-Buyer-B', '203.0.113.11');
    h.resourceFault(null);
    expect(op(b.operation_id).status).not.toBe('succeeded');
    expect(forged()?.reasons).toContain('unexplained_fetch');
    expect(forged()?.reasons).not.toContain('node_detail_mismatch');
    expect(holds()).toHaveLength(1);
    expect(holds()[0]).toMatchObject({ phase: 'COMPLETED', result: { rejectSelected: true, rejectCause: 'node_resource_forged' } });
    expect(await selection()).toBe('REJECT');
  });
});
