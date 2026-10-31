// 发布批次的崩溃恢复与回滚（§6.2，D10）：合并进批次的操作与导入逐行操作在崩溃后不会永远停在 running；多目标发布按操作
// 记录；回滚的单 key 更新失败或中途崩溃时需要处理或按事实收敛（系统强制刷新把 Surge 带回已提交版本），从不误报为外部修改。
// 从不重放：提供候选之后的批次记为 UNKNOWN_STATE，待部署的修改由下一次发布收敛。
import { afterEach, describe, expect, test } from 'vitest';
import { ROUTE_GROUP_NAME, type ImportPreviewRequest } from '@sfe/contract';
import { WEB, createEnv, createHarness, envInput, rid, type Harness } from './harness.js';
import { hangAt, needsRefresh, pointer, served } from './publish-helpers.js';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

// getGroupMembers：本机资源服务提供候选版本之后读组成员就是单 key 更新之后的读回（提供之前另读一次，作为更新之前的状态）。
type FakeMethod = 'getGroupMembers' | 'listPolicies';

/** 本机资源服务正在提供候选版本（已暂存、尚未提交或撤回）。 */
const candidateServed = (): boolean => served(h)?.state === 'candidate';

/** 让某个 FakeSurge 原语挂起（模拟进程在调用中途崩溃）；when 为 false 的调用照常执行。 */
function hang(name: FakeMethod, when: () => boolean = () => true): { entered: () => boolean; restore: () => void } {
  const fake = h.fake as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const orig = fake[name]!.bind(h.fake);
  let entered = false;
  fake[name] = (...args: unknown[]) => {
    if (!when()) return orig(...args);
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

async function until(cond: () => boolean): Promise<void> {
  const end = Date.now() + 5000;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 2));
  expect(cond()).toBe(true);
}

const op = (id: string) => h.repos.operations.get(id)!;
const revisionOf = (envId: string) => h.repos.environments.get(envId)!.revision;

async function queueTwoPortEdits(): Promise<{ x: string; y: string; ux: string; uy: string }> {
  const x = (await createEnv(h, 'US-Buyer-X', '203.0.113.10')).environment_id!;
  const y = (await createEnv(h, 'US-Buyer-Y', '203.0.113.11')).environment_id!;
  await h.app.executor.stop();
  const ux = (await h.app.updateEnvironment(x, { request_id: rid(), expected_revision: revisionOf(x), changes: { proxy: { port: 1081 } } }, WEB)).operation_id;
  const uy = (await h.app.updateEnvironment(y, { request_id: rid(), expected_revision: revisionOf(y), changes: { proxy: { port: 1082 } } }, WEB)).operation_id;
  return { x, y, ux, uy };
}

describe('publish batch crash recovery', () => {
  test('crash after the single-key update, before the readback: the merged sibling is settled too, Surge is brought back to the committed nodes, and the next publish converges both', async () => {
    h = await createHarness({ dbFile: true });
    const { x, y, ux, uy } = await queueTwoPortEdits();
    const committed = await h.fake.getGroupMembers(ROUTE_GROUP_NAME);
    const stuck = hang('getGroupMembers', candidateServed);
    h.app.executor.start();
    await until(stuck.entered);
    // X 是主操作，Y 被合并进同一批次
    expect(op(ux).phase).toBe('DEPLOYING');
    expect(op(uy).phase).toBe('DEPLOYING');
    stuck.restore();
    await h.crash();
    await h.idle();
    for (const id of [ux, uy]) {
      expect(op(id).status).toBe('failed');
      expect(op(id).error?.code).toBe('UNKNOWN_STATE');
    }
    h.clock.advance(60 * 60 * 1000);
    await h.idle();
    expect(h.repos.operations.listByStatus(['queued', 'running'])).toEqual([]);
    // 启动撤回了候选指针，系统强制刷新（没有目标环境）把 Surge 带回已提交版本
    expect(pointer(h)?.candidate).toBeNull();
    expect(await h.fake.getGroupMembers(ROUTE_GROUP_NAME)).toEqual(committed);
    expect(needsRefresh(h)).toBeNull();
    // 两个待部署目标由一次发布收敛
    const pub = await h.app.publishPending({ request_id: rid() }, WEB);
    await h.idle();
    expect(op(pub.operation_id).phase).toBe('READY_FOR_NEXT_OPEN');
    expect(h.repos.environments.get(x)!.deployedProxyRevision).toBe(2);
    expect(h.repos.environments.get(y)!.deployedProxyRevision).toBe(2);
    expect(h.fake.calls.reloadProfile ?? 0).toBe(0);
    expect(h.fake.updateAllAttempts).toBe(0);
  });

  test('crash before any write: the re-run batch re-collects the merged sibling instead of leaving it running', async () => {
    h = await createHarness({ dbFile: true });
    const { x, y, ux, uy } = await queueTwoPortEdits();
    const stuck = hang('listPolicies');
    h.app.executor.start();
    await until(stuck.entered);
    expect(op(ux).phase).toBe('VALIDATING');
    expect(op(uy).status).toBe('running');
    stuck.restore();
    await h.crash();
    await h.idle();
    expect(op(ux).phase).toBe('READY_FOR_NEXT_OPEN');
    expect(op(uy).phase).toBe('READY_FOR_NEXT_OPEN');
    expect(h.repos.environments.get(x)!.deployedProxyRevision).toBe(2);
    expect(h.repos.environments.get(y)!.deployedProxyRevision).toBe(2);
    expect(h.repos.operations.listByStatus(['queued', 'running'])).toEqual([]);
  });

  test('crash before any write in an import batch: the row operations are re-collected and deployed', async () => {
    h = await createHarness({ dbFile: true });
    const header = 'environment_id,display_name,proxy_type,proxy_host,proxy_port,proxy_username,proxy_password,front_proxy,site,account_label,login_identifier,login_password,expected_exit_ip,auto_open_orders,auto_fill_login';
    const rows = [',US-Imp-1,socks5,203.0.113.20,1080,,,,US,,,,,,', ',US-Imp-2,socks5,203.0.113.21,1080,,,,US,,,,,,'];
    const req: ImportPreviewRequest = { format: 'csv', content_base64: Buffer.from([header, ...rows].join('\n') + '\n', 'utf8').toString('base64') };
    const preview = await h.app.importPreview(req, WEB);
    const stuck = hang('listPolicies');
    const result = await h.app.importCommit({ ...req, request_id: rid('imp'), preview_digest: preview.preview_digest, decisions: [{ row: 2, action: 'create' }, { row: 3, action: 'create' }] }, WEB);
    await until(stuck.entered);
    const children = result.items.map((i) => i.operation_id!);
    for (const id of children) expect(op(id).status).toBe('running');
    stuck.restore();
    await h.crash();
    await h.idle();
    expect(op(result.operation_id).phase).toBe('READY_FOR_NEXT_OPEN');
    for (const id of children) expect(op(id).phase).toBe('READY_FOR_NEXT_OPEN');
    for (const item of result.items) expect(h.repos.environments.get(item.environment_id!)!.deployedProxyRevision).toBe(1);
  });

  test('startup backstop: a running publish operation that nothing will ever claim is failed as UNKNOWN_STATE', async () => {
    h = await createHarness({ dbFile: true });
    const envId = (await createEnv(h, 'US-Buyer-01', '203.0.113.10')).environment_id!;
    const orphan = h.repos.operations.insert({
      id: 'op_orphan0001',
      requestId: rid('orphan'),
      requestDigest: 'x',
      kind: 'environment.update',
      initiatorKind: 'web',
      environmentId: envId,
      phase: 'VALIDATING',
      status: 'running',
      payload: { targets: [{ environmentId: envId, proxyRevision: 1 }] },
    });
    expect(h.repos.outbox.pendingForOperation(orphan.id)).toEqual([]);
    await h.crash();
    await h.idle();
    expect(op(orphan.id).status).toBe('failed');
    expect(op(orphan.id).error?.code).toBe('UNKNOWN_STATE');
  });
});

describe('deployment records', () => {
  test('one publish operation with several pending targets deploys them all (one record per operation)', async () => {
    h = await createHarness();
    h.revoke(['loopback_resource_update']);
    const a = await createEnv(h, 'US-Buyer-01', '203.0.113.10');
    const b = await createEnv(h, 'US-Buyer-02', '203.0.113.11');
    expect(op(a.operation_id).phase).toBe('WAITING_DEPLOYMENT');
    h.grant(['loopback_resource_update']);
    const pub = await h.app.publishPending({ request_id: rid() }, WEB);
    await h.idle();
    expect(op(pub.operation_id).phase).toBe('READY_FOR_NEXT_OPEN');
    expect((op(pub.operation_id).result as { targets: unknown[] }).targets).toHaveLength(2);
    for (const id of [a.environment_id!, b.environment_id!]) expect(h.repos.environments.get(id)!.deployedProxyRevision).toBe(1);
    const rows = h.repos.deployments.listOperations(h.repos.deployments.latest()!.generation);
    expect(rows).toEqual([{ generation: rows[0]!.generation, operationId: pub.operation_id, environmentId: null, proxyRevision: null, outcome: 'deployed' }]);
  });
});

describe('rollback of the node resource', () => {
  /** 第一次读回（提供候选之后）读到的仍是旧成员 → 读回不一致 → 回滚（Surge 已下载候选：回滚单 key 更新一次）。 */
  function staleMembersOnFirstReadback(): void {
    const orig = h.fake.getGroupMembers.bind(h.fake);
    let lied = false;
    h.fake.getGroupMembers = async (group: string) => {
      if (!lied && candidateServed()) {
        lied = true;
        return ['REJECT', 'SFE-N-E0001-US01-v001'];
      }
      return orig(group);
    };
  }

  test('the rollback update fails → needs attention with the node resource warning and needsRefresh kept; the next publish converges, never BASELINE_CHANGED', async () => {
    h = await createHarness();
    await createEnv(h, 'US-Buyer-A', '203.0.113.10');
    staleMembersOnFirstReadback();
    const orig = h.fake.updateExternalResource.bind(h.fake);
    let calls = 0;
    h.fake.updateExternalResource = async (key: string) => {
      if (++calls === 2) throw new Error('synthetic rollback update failure');
      return orig(key);
    };
    const b = await createEnv(h, 'US-Buyer-B', '203.0.113.11');
    h.fake.updateExternalResource = orig;
    expect(calls).toBe(2);
    expect(op(b.operation_id).phase).toBe('BLOCKED_NEEDS_ATTENTION');
    expect(h.repos.deployments.latest()!.state).toBe('failed');
    expect(h.repos.routeState.get().warnings).toContain('node_resource_unverified');
    expect(pointer(h)?.candidate).toBeNull();
    expect(served(h)).toMatchObject({ state: 'committed', generation: 1 });
    expect(needsRefresh(h)).not.toBeNull();
    // 下一次发布：Surge 中仍是候选（未提交）——提供并单 key 更新、读回一致，清除警告
    const pub = await h.app.publishPending({ request_id: rid() }, WEB);
    await h.idle();
    expect(op(pub.operation_id).error?.code).not.toBe('BASELINE_CHANGED');
    expect(op(pub.operation_id).phase).toBe('READY_FOR_NEXT_OPEN');
    expect(h.repos.environments.get(b.environment_id!)!.deployedProxyRevision).toBe(1);
    expect(h.repos.routeState.get().warnings).not.toContain('node_resource_unverified');
    expect(needsRefresh(h)).toBeNull();
  });

  test('crash in ROLLING_BACK during the rollback update → recovery fails the batch (never replays); one system refresh brings Surge back; the next publish converges', async () => {
    h = await createHarness({ dbFile: true });
    await createEnv(h, 'US-Buyer-A', '203.0.113.10');
    const committedMembers = await h.fake.getGroupMembers(ROUTE_GROUP_NAME);
    staleMembersOnFirstReadback();
    // 第一次更新是发布的，第二次是回滚的：挂在回滚的更新上（Surge 已下载候选之后才挂起的是发布那一次，这里挂在调用之前）
    const stuck = hangAt(h, 'updateExternalResource', 2, { before: true });
    const b = await h.app.createEnvironment({ request_id: rid(), environment: envInput('US-Buyer-B', '203.0.113.11') }, WEB);
    await until(stuck.reached);
    expect(op(b.operation_id).phase).toBe('ROLLING_BACK');
    // 回滚事务已撤回候选指针，needsRefresh 保留
    expect(pointer(h)?.candidate).toBeNull();
    expect(needsRefresh(h)).not.toBeNull();
    stuck.restore();
    await h.crash();
    await h.idle();
    expect(op(b.operation_id).error?.code).toBe('UNKNOWN_STATE');
    expect(h.repos.deployments.list(10).find((d) => d.operationId === b.operation_id)!.state).toBe('failed');
    expect(await h.fake.getGroupMembers(ROUTE_GROUP_NAME)).toEqual(committedMembers);
    expect(needsRefresh(h)).toBeNull();
    const pub = await h.app.publishPending({ request_id: rid() }, WEB);
    await h.idle();
    expect(op(pub.operation_id).error?.code).not.toBe('BASELINE_CHANGED');
    expect(op(pub.operation_id).phase).toBe('READY_FOR_NEXT_OPEN');
    expect(h.repos.environments.get(b.environment_id!)!.deployedProxyRevision).toBe(1);
  });
});
