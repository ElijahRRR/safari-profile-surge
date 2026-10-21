import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { NODE_RESOURCE_FILE, ROUTE_GROUP_NAME } from '@sfe/contract';
import { PROFILE_A, WEB, activeEnv, bind, createEnv, createHarness, rid, safariOutcome, verify, type Harness } from './harness.js';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

/** 让某个 FakeSurge 原语挂起（模拟进程在调用中途崩溃）。 */
function hang(name: 'updateExternalResource' | 'selectGroupPolicy', when: (...args: string[]) => boolean = () => true): { entered: () => boolean; restore: () => void } {
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
  test('crash while refreshing the resource → FAILED UNKNOWN_STATE; next publish converges without duplicate nodes', async () => {
    h = await createHarness({ dbFile: true });
    const envId = (await createEnv(h, 'US-Buyer-A', '203.0.113.10')).environment_id!;
    const stuck = hang('updateExternalResource');
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
