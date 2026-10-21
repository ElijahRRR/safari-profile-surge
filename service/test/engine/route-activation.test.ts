// 受控切换的收尾与接手（docs/ARCHITECTURE.md §6.3）：写入 ACTIVE 之前重新检查激活门槛、提交后立即对账；
// 取代等待中的激活后在写入前失败 → 按快照回滚，不让 VERIFY_ONLY 无人负责；被外部修改的本应用入口文件
// 从不被激活悄悄改写（§5.5，只有撤销入口会改写）。只用合成数据。

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { ENTRY_RULESET_FILES, ROUTE_GROUP_NAME, type ActivateRequest, type RollbackResult } from '@sfe/contract';
import { FAKE_VERIFY_HOST } from '../../src/surge/fake.js';
import { PROFILE_A, PROFILE_B, PROFILE_C, WEB, activeEnv, bind, createEnv, createHarness, grantForCurrentHost, rid, safariOutcome, verify, type Harness } from './harness.js';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

async function startSwitch(env: string, extra: Partial<ActivateRequest> = {}): Promise<string> {
  const route = h.repos.routeState.get();
  const req: ActivateRequest = { request_id: rid('act'), old_session_policy: 'closed_confirmed', confirmed_environment_id: route.activeEnvironmentId, ...extra };
  const a = await h.app.activate(env, req, WEB);
  await h.idle();
  return a.operation_id;
}

describe('step 13: gates re-checked before ACTIVE', () => {
  test('an activation gate revoked during the VERIFY_ONLY wait → rollback, entry never ACTIVE', async () => {
    h = await createHarness();
    const env = (await createEnv(h, 'US-Buyer-A', '203.0.113.10')).environment_id!;
    await bind(h, PROFILE_A, env);
    const opId = await startSwitch(env);
    expect(h.repos.operations.get(opId)!.phase).toBe('VERIFY_ONLY');
    h.revoke(['safari_process_attribution']);
    const updates = h.fake.calls.updateExternalResource ?? 0;
    await verify(h, PROFILE_A, opId);
    const op = h.repos.operations.get(opId)!;
    expect(op.phase).toBe('FAILED');
    expect(op.error?.code).toBe('CAPABILITY_UNVERIFIED');
    expect((op.error?.details as { missing: Array<{ key: string }> }).missing.map((m) => m.key)).toContain('safari_process_attribution');
    const route = h.repos.routeState.get();
    expect(route).toMatchObject({ phase: 'failed', entryMode: 'BLOCKED', activeEnvironmentId: null });
    expect(h.repos.environments.get(env)!.lastVerifiedProxyRevision).toBeNull();
    // 只写回阻断（verify 位），从不写入 ACTIVE；Safari 全部拒绝
    expect((h.fake.calls.updateExternalResource ?? 0) - updates).toBe(1);
    expect(safariOutcome(h).failed).toBe(true);
    expect(safariOutcome(h, FAKE_VERIFY_HOST).failed).toBe(true);
  });

  test('Safari updated during the VERIFY_ONLY wait while the service keeps running → rollback, entry never ACTIVE', async () => {
    h = await createHarness();
    grantForCurrentHost(h, ['safari_process_attribution']);
    const env = (await createEnv(h, 'US-Buyer-A', '203.0.113.10')).environment_id!;
    await bind(h, PROFILE_A, env);
    const opId = await startSwitch(env);
    expect(h.repos.operations.get(opId)!.phase).toBe('VERIFY_ONLY');
    // Safari 经软件更新单独升级，未重启、服务未重启：启动时读到的版本已过时
    h.host.safariVersion = '19.1';
    await verify(h, PROFILE_A, opId);
    const op = h.repos.operations.get(opId)!;
    expect(op.phase).toBe('FAILED');
    expect(op.error?.code).toBe('CAPABILITY_UNVERIFIED');
    expect((op.error?.details as { missing: Array<{ key: string; staleReasons: string[] }> }).missing).toContainEqual({ key: 'safari_process_attribution', staleReasons: ['safariVersion'] });
    expect(h.repos.routeState.get()).toMatchObject({ phase: 'failed', entryMode: 'BLOCKED', activeEnvironmentId: null });
    expect(h.repos.environments.get(env)!.lastVerifiedProxyRevision).toBeNull();
    expect(safariOutcome(h).failed).toBe(true);
  });

  test('Safari updated after service start, before activation → the operation fails before touching the route', async () => {
    h = await createHarness();
    grantForCurrentHost(h, ['safari_process_attribution']);
    const env = (await createEnv(h, 'US-Buyer-A', '203.0.113.10')).environment_id!;
    await bind(h, PROFILE_A, env);
    h.host.safariVersion = '19.1';
    const updates = h.fake.calls.updateExternalResource ?? 0;
    const opId = await startSwitch(env);
    const op = h.repos.operations.get(opId)!;
    expect(op.phase).toBe('FAILED');
    expect(op.error?.code).toBe('CAPABILITY_UNVERIFIED');
    expect(h.repos.routeState.get()).toMatchObject({ entryMode: 'NORMAL', activeEnvironmentId: null });
    expect((h.fake.calls.updateExternalResource ?? 0) - updates).toBe(0);
  });

  test('fact-derived warnings come back right after the commit (no wait for the next periodic reconcile)', async () => {
    h = await createHarness();
    const env = (await createEnv(h, 'US-Buyer-A', '203.0.113.10')).environment_id!;
    await bind(h, PROFILE_A, env);
    const opId = await startSwitch(env);
    // 等待期间受管理段被外部修改（对账会标记 managed_segments_changed；提交按设计清除警告）
    const text = readFileSync(h.profilePath, 'utf8').replace('SFE-ROUTE = select, REJECT, policy-path=sfe-nodes.list', 'SFE-ROUTE = select, REJECT, DIRECT, policy-path=sfe-nodes.list');
    writeFileSync(h.profilePath, text);
    await h.app.runPeriodicReconcile();
    expect(h.repos.routeState.get().warnings).toContain('managed_segments_changed');
    await verify(h, PROFILE_A, opId);
    expect(h.repos.operations.get(opId)!.phase).toBe('ACTIVE_VERIFIED');
    const route = h.repos.routeState.get();
    expect(route.warnings).toContain('managed_segments_changed');
    expect(route.phase).toBe('attention');
    expect((await h.app.ensureInControl()).ok).toBe(false);
  });
});

describe('superseding a waiting activation, then failing before any write', () => {
  test('the new activation rolls back the inherited VERIFY_ONLY state from the snapshot', async () => {
    h = await createHarness();
    const { envId: a } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const b = (await createEnv(h, 'US-Buyer-B', '203.0.113.11')).environment_id!;
    await bind(h, PROFILE_B, b);
    const c = (await createEnv(h, 'US-Buyer-C', '203.0.113.12')).environment_id!;
    await bind(h, PROFILE_C, c);
    const nodeA = h.repos.proxyRevisions.get(a, 1)!.nodeName;
    const first = await startSwitch(b);
    expect(h.repos.routeState.get()).toMatchObject({ phase: 'awaiting_safari_verify', entryMode: 'VERIFY_ONLY' });
    h.fake.failNext('getGroupMembers');
    const second = await startSwitch(c, { confirmed_environment_id: a });
    expect(h.repos.operations.get(first)!.phase).toBe('SUPERSEDED');
    const op = h.repos.operations.get(second)!;
    expect(op.phase).toBe('FAILED');
    expect(op.error?.code).toBe('SURGE_COMMAND_FAILED');
    const rb = (op.result as { rollback: RollbackResult }).rollback;
    expect(rb).toMatchObject({ previousEnvironmentId: a, restoredSelection: nodeA, entryModeAfter: 'BLOCKED', needsReverify: true });
    const route = h.repos.routeState.get();
    expect(route).toMatchObject({ phase: 'failed', entryMode: 'BLOCKED', activeEnvironmentId: a, selectedNode: nodeA, awaitingDeadline: null });
    expect(route.warnings).toContain('rollback_needs_reverify');
    expect(await h.fake.getGroupSelection('SFE-ROUTE')).toBe(nodeA);
    // 检测主机不再经被取代的未验证出口
    expect(safariOutcome(h, FAKE_VERIFY_HOST).failed).toBe(true);
    expect(safariOutcome(h).failed).toBe(true);
  });

  test('a pre-write failure without an inherited transitional state only fails (route untouched)', async () => {
    h = await createHarness();
    const { envId: a } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const b = (await createEnv(h, 'US-Buyer-B', '203.0.113.11')).environment_id!;
    await bind(h, PROFILE_B, b);
    const before = h.repos.routeState.get();
    h.fake.failNext('getGroupMembers');
    const opId = await startSwitch(b, { confirmed_environment_id: a });
    expect(h.repos.operations.get(opId)!.phase).toBe('FAILED');
    const route = h.repos.routeState.get();
    expect(route).toMatchObject({ phase: 'active_verified', entryMode: 'ACTIVE', activeEnvironmentId: a, routeEpoch: before.routeEpoch, selectedNode: before.selectedNode });
  });
});

describe('an externally edited app-owned entry file is never silently overwritten by an activation (§5.5)', () => {
  test('refused before any write (BASELINE_CHANGED, route untouched); normal mode overwrites it, then activation works', async () => {
    h = await createHarness();
    const env = (await createEnv(h, 'US-Buyer-A', '203.0.113.10')).environment_id!;
    await bind(h, PROFILE_A, env);
    const file = join(h.surgeDir, ENTRY_RULESET_FILES.active);
    appendFileSync(file, '# user note\n');
    const before = h.repos.routeState.get();
    const updates = h.fake.calls.updateExternalResource ?? 0;
    const opId = await startSwitch(env);
    const op = h.repos.operations.get(opId)!;
    expect(op.phase).toBe('FAILED');
    expect(op.error?.code).toBe('BASELINE_CHANGED');
    expect((op.error?.details as { files: string[] }).files).toEqual([ENTRY_RULESET_FILES.active]);
    expect(h.repos.routeState.get()).toMatchObject({ phase: 'idle', entryMode: 'NORMAL', routeEpoch: before.routeEpoch, activeEnvironmentId: null });
    expect(h.fake.calls.updateExternalResource ?? 0).toBe(updates);
    expect(readFileSync(file, 'utf8')).toContain('# user note');
    // 普通模式（撤销入口）改写它并在操作中记录；之后激活照常进行
    const n = await h.app.enterNormal({ request_id: rid('normal') }, WEB);
    await h.idle();
    const normal = h.repos.operations.get(n.operation_id)!;
    expect(normal.phase).toBe('NORMAL_RESTORED');
    expect((normal.result as { changedEntryFiles: string[] }).changedEntryFiles).toEqual([ENTRY_RULESET_FILES.active]);
    expect(h.repos.operations.listSteps(n.operation_id).some((s) => s.message.includes('本应用的入口文件已被外部修改'))).toBe(true);
    expect(readFileSync(file, 'utf8')).not.toContain('# user note');
    const again = await startSwitch(env);
    expect(h.repos.operations.get(again)!.phase).toBe('VERIFY_ONLY');
  });

  test('edited between the pre-write check and the blocking step: the activation does not overwrite it; the rollback (undo) does and keeps managed_segments_changed', async () => {
    h = await createHarness();
    const { envId: a } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const b = (await createEnv(h, 'US-Buyer-B', '203.0.113.11')).environment_id!;
    await bind(h, PROFILE_B, b);
    const nodeA = h.repos.proxyRevisions.get(a, 1)!.nodeName;
    const file = join(h.surgeDir, ENTRY_RULESET_FILES.active);
    // 第 2 步的最后一次读取（SFE-ROUTE 成员）之后、阻断写入之前，用户编辑了入口文件
    const fake = h.fake as unknown as { getGroupMembers: (g: string) => Promise<string[]> };
    const orig = fake.getGroupMembers.bind(h.fake);
    let edited = false;
    fake.getGroupMembers = async (g: string) => {
      const r = await orig(g);
      if (!edited) {
        edited = true;
        appendFileSync(file, '# user note\n');
      }
      return r;
    };
    const opId = await startSwitch(b);
    fake.getGroupMembers = orig;
    expect(edited).toBe(true);
    const op = h.repos.operations.get(opId)!;
    expect(op.phase).toBe('FAILED');
    expect(op.error?.code).toBe('BASELINE_CHANGED');
    expect(h.repos.operations.listSteps(opId).some((s) => s.phase === 'SAFARI_BLOCKED' || s.phase === 'VERIFY_ONLY')).toBe(false);
    expect((op.result as { rollback: RollbackResult }).rollback).toMatchObject({ previousEnvironmentId: a, restoredSelection: nodeA, entryModeAfter: 'BLOCKED' });
    const route = h.repos.routeState.get();
    expect(route).toMatchObject({ phase: 'failed', entryMode: 'BLOCKED', activeEnvironmentId: a, selectedNode: nodeA });
    expect(route.warnings).toEqual(expect.arrayContaining(['rollback_needs_reverify', 'managed_segments_changed']));
    expect(await h.fake.getGroupSelection(ROUTE_GROUP_NAME)).toBe(nodeA);
    expect(readFileSync(file, 'utf8')).not.toContain('# user note');
    expect(safariOutcome(h).failed).toBe(true);
    expect(safariOutcome(h, FAKE_VERIFY_HOST).failed).toBe(true);
    expect(h.fake.calls.reloadProfile ?? 0).toBe(0);
  });
});
