// 发布批次的崩溃恢复与回滚归属（§6.2）：合并进批次的操作与导入逐行操作在崩溃后不会永远停在 running；
// 多目标发布按操作记录；回滚写入失败或中途崩溃时，本应用自己写入的节点资源不会被误报为外部修改。
// 从不重放写入：写入阶段的批次记为 UNKNOWN_STATE，由下一次发布按事实收敛。
import { afterEach, describe, expect, test } from 'vitest';
import { NODE_RESOURCE_FILE, type ImportPreviewRequest } from '@sfe/contract';
import type { ManagedProfileFiles } from '../../src/surge/files.js';
import { WEB, createEnv, createHarness, envInput, rid, type Harness } from './harness.js';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

type FakeMethod = 'updateExternalResource' | 'listPolicies';

/** 让某个 FakeSurge 原语挂起（模拟进程在调用中途崩溃）。 */
function hang(name: FakeMethod): { entered: () => boolean; restore: () => void } {
  const fake = h.fake as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const orig = fake[name]!.bind(h.fake);
  let entered = false;
  fake[name] = () => {
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
  test('crash while refreshing: the merged sibling is settled too, and the next publish converges both', async () => {
    h = await createHarness({ dbFile: true });
    const { x, y, ux, uy } = await queueTwoPortEdits();
    const stuck = hang('updateExternalResource');
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
    // 两个待部署目标由一次发布收敛
    const pub = await h.app.publishPending({ request_id: rid() }, WEB);
    await h.idle();
    expect(op(pub.operation_id).phase).toBe('READY_FOR_NEXT_OPEN');
    expect(h.repos.environments.get(x)!.deployedProxyRevision).toBe(2);
    expect(h.repos.environments.get(y)!.deployedProxyRevision).toBe(2);
    expect(h.fake.calls.reloadProfile ?? 0).toBe(0);
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
    h.revoke(['policy_path_reread']);
    const a = await createEnv(h, 'US-Buyer-01', '203.0.113.10');
    const b = await createEnv(h, 'US-Buyer-02', '203.0.113.11');
    expect(op(a.operation_id).phase).toBe('WAITING_DEPLOYMENT');
    h.grant(['policy_path_reread']);
    const pub = await h.app.publishPending({ request_id: rid() }, WEB);
    await h.idle();
    expect(op(pub.operation_id).phase).toBe('READY_FOR_NEXT_OPEN');
    expect((op(pub.operation_id).result as { targets: unknown[] }).targets).toHaveLength(2);
    for (const id of [a.environment_id!, b.environment_id!]) expect(h.repos.environments.get(id)!.deployedProxyRevision).toBe(1);
    const rows = h.repos.deployments.listOperations(h.repos.deployments.latest()!.generation);
    expect(rows).toEqual([{ generation: rows[0]!.generation, operationId: pub.operation_id, environmentId: null, proxyRevision: null, outcome: 'deployed' }]);
  });
});

describe('rollback ownership of the node resource', () => {
  /** 第一次定向刷新失败（读回不一致 → 回滚）；回滚写入节点资源时按 mode 失败或挂起。 */
  function failRefreshThenRollbackWrite(mode: 'throw' | 'hang'): { rollbackWriteEntered: () => boolean; restore: () => void } {
    const origUpdate = h.fake.updateExternalResource.bind(h.fake);
    let refreshes = 0;
    h.fake.updateExternalResource = async (key: string) => {
      refreshes++;
      if (refreshes === 1) throw new Error('refresh failed');
      return origUpdate(key);
    };
    const engine = h.app.engine;
    const origFiles = engine.profileFiles.bind(engine);
    let resourceWrites = 0;
    let entered = false;
    engine.profileFiles = (): ManagedProfileFiles | null => {
      const f = origFiles();
      if (!f) return f;
      return {
        ...f,
        writeAtomic: async (name, content, prev) => {
          if (name === NODE_RESOURCE_FILE && ++resourceWrites === 2) {
            entered = true;
            if (mode === 'throw') throw new Error('disk full');
            return new Promise<never>(() => undefined);
          }
          return f.writeAtomic(name, content, prev);
        },
      };
    };
    return {
      rollbackWriteEntered: () => entered,
      restore: () => {
        h.fake.updateExternalResource = origUpdate;
        engine.profileFiles = origFiles;
      },
    };
  }

  test('rollback write fails → needs attention, but the next publish is not misreported as BASELINE_CHANGED', async () => {
    h = await createHarness();
    await createEnv(h, 'US-Buyer-A', '203.0.113.10');
    const patch = failRefreshThenRollbackWrite('throw');
    const b = await createEnv(h, 'US-Buyer-B', '203.0.113.11');
    expect(patch.rollbackWriteEntered()).toBe(true);
    expect(op(b.operation_id).phase).toBe('BLOCKED_NEEDS_ATTENTION');
    patch.restore();
    // 文件仍是本应用刚写入的内容：归属记录确认它
    const rec = h.repos.managedObjects.get('resource_file', NODE_RESOURCE_FILE)!;
    expect(rec.state).toBe('present');
    expect(rec.contentDigest).toBe(await h.app.engine.profileFiles()!.digest(NODE_RESOURCE_FILE));
    const pub = await h.app.publishPending({ request_id: rid() }, WEB);
    await h.idle();
    expect(op(pub.operation_id).error?.code).not.toBe('BASELINE_CHANGED');
    expect(op(pub.operation_id).phase).toBe('READY_FOR_NEXT_OPEN');
    expect(h.repos.environments.get(b.environment_id!)!.deployedProxyRevision).toBe(1);
  });

  test('crash in ROLLING_BACK before the rollback write → recovery confirms our own content; the next publish converges', async () => {
    h = await createHarness({ dbFile: true });
    await createEnv(h, 'US-Buyer-A', '203.0.113.10');
    const patch = failRefreshThenRollbackWrite('hang');
    const b = await h.app.createEnvironment({ request_id: rid(), environment: envInput('US-Buyer-B', '203.0.113.11') }, WEB);
    await until(patch.rollbackWriteEntered);
    expect(op(b.operation_id).phase).toBe('ROLLING_BACK');
    patch.restore();
    await h.crash();
    await h.idle();
    expect(op(b.operation_id).error?.code).toBe('UNKNOWN_STATE');
    expect(h.repos.managedObjects.get('resource_file', NODE_RESOURCE_FILE)!.state).toBe('present');
    const pub = await h.app.publishPending({ request_id: rid() }, WEB);
    await h.idle();
    expect(op(pub.operation_id).error?.code).not.toBe('BASELINE_CHANGED');
    expect(op(pub.operation_id).phase).toBe('READY_FOR_NEXT_OPEN');
    expect(h.repos.environments.get(b.environment_id!)!.deployedProxyRevision).toBe(1);
  });
});
