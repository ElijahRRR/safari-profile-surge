// 受控切换的收尾与接手（docs/ARCHITECTURE.md §6.3）：写入 ACTIVE 之前重新检查激活门槛、提交后立即对账；
// 取代等待中的激活后在写入前失败 → 按快照回滚，不让 VERIFY_ONLY 无人负责；被外部修改的本应用入口文件
// 从不被激活悄悄改写（§5.5，只有撤销入口会改写）。只用合成数据。

import { appendFileSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { ENTRY_RULESET_FILES, ROUTE_GROUP_NAME, type ActivateRequest, type RollbackResult } from '@sfe/contract';
import { FAKE_VERIFY_HOST } from '../../src/surge/fake.js';
import { PROFILE_A, PROFILE_B, PROFILE_C, WEB, activeEnv, bind, createEnv, createHarness, grantForCurrentHost, rid, safariOutcome, verify, type Harness } from './harness.js';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

/** 入口规则集文件被 Surge 文件监视重新加载的次数（ruleset_resource 每一步写入一个文件；从不调用外部资源更新）。 */
const entryReloads = (): number => h.fake.watcherReloads.filter((r) => r.key.startsWith('ruleset:sfe-entry-')).length;

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
    const updates = entryReloads();
    await verify(h, PROFILE_A, opId);
    const op = h.repos.operations.get(opId)!;
    expect(op.phase).toBe('FAILED');
    expect(op.error?.code).toBe('CAPABILITY_UNVERIFIED');
    expect((op.error?.details as { missing: Array<{ key: string }> }).missing.map((m) => m.key)).toContain('safari_process_attribution');
    const route = h.repos.routeState.get();
    expect(route).toMatchObject({ phase: 'failed', entryMode: 'BLOCKED', activeEnvironmentId: null });
    expect(h.repos.environments.get(env)!.lastVerifiedProxyRevision).toBeNull();
    // 只写回阻断（verify 位），从不写入 ACTIVE；Safari 全部拒绝
    expect(entryReloads() - updates).toBe(1);
    expect(h.fake.calls.updateExternalResource ?? 0).toBe(0);
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
    const updates = entryReloads();
    const opId = await startSwitch(env);
    const op = h.repos.operations.get(opId)!;
    expect(op.phase).toBe('FAILED');
    expect(op.error?.code).toBe('CAPABILITY_UNVERIFIED');
    expect(h.repos.routeState.get()).toMatchObject({ entryMode: 'NORMAL', activeEnvironmentId: null });
    expect(entryReloads() - updates).toBe(0);
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

/** 核对通过之后（读取 Surge 请求记录之后）执行一次 arm：在第 13 步注入一次意外异常。 */
function afterVerificationRead(arm: () => void): void {
  const orig = h.fake.listRecentRequests.bind(h.fake);
  h.fake.listRecentRequests = async () => {
    const records = await orig();
    h.fake.listRecentRequests = orig;
    arm();
    return records;
  };
}

/** 让 obj[key] 下一次调用抛出（一次性）。 */
function failOnce<T extends object, K extends keyof T>(obj: T, key: K, err: Error): void {
  const orig = obj[key];
  obj[key] = (() => {
    obj[key] = orig;
    throw err;
  }) as T[K];
}

const dbError = (code: string) => Object.assign(new Error(`synthetic ${code}`), { code });

describe('step 13: unexpected errors after a passed verification roll back from the snapshot (never an orphaned VERIFY_ONLY wait)', () => {
  test('home directory becomes unresolvable (link loop) during the VERIFY_ONLY wait → reading facts does not throw, the activation completes', async () => {
    h = await createHarness();
    const env = (await createEnv(h, 'US-Buyer-A', '203.0.113.10')).environment_id!;
    await bind(h, PROFILE_A, env);
    const opId = await startSwitch(env);
    expect(h.repos.operations.get(opId)!.phase).toBe('VERIFY_ONLY');
    const home = join(h.dir, 'home');
    symlinkSync(home, home); // realpath → ELOOP
    await verify(h, PROFILE_A, opId);
    expect(h.repos.operations.get(opId)!).toMatchObject({ phase: 'ACTIVE_VERIFIED', status: 'succeeded' });
    expect(h.repos.routeState.get()).toMatchObject({ phase: 'active_verified', entryMode: 'ACTIVE', activeEnvironmentId: env });
    const status = await h.app.refreshSurge(WEB);
    expect(status.profileDirectoryRisk).toBeNull();
    expect((await h.app.ensureInControl()).ok).toBe(true);
  });

  test('an unexpected error while re-checking the gates before ACTIVE → rollback to the previous node, Safari stays blocked', async () => {
    h = await createHarness();
    const { envId: a } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const b = (await createEnv(h, 'US-Buyer-B', '203.0.113.11')).environment_id!;
    await bind(h, PROFILE_B, b);
    const nodeA = h.repos.proxyRevisions.get(a, 1)!.nodeName;
    const opId = await startSwitch(b);
    expect(h.repos.routeState.get()).toMatchObject({ phase: 'awaiting_safari_verify', entryMode: 'VERIFY_ONLY', operationId: opId });
    // 第 13 步读取能力记录时出现意外的数据库错误（不是 SfeError）
    afterVerificationRead(() => failOnce(h.repos.capabilities, 'list', dbError('SQLITE_IOERR')));
    await verify(h, PROFILE_B, opId);
    const op = h.repos.operations.get(opId)!;
    expect(op).toMatchObject({ phase: 'FAILED', status: 'failed' });
    expect(op.error).toMatchObject({ code: 'INTERNAL' });
    expect(op.error!.message).not.toContain('SQLITE');
    expect((op.result as { rollback: RollbackResult }).rollback).toMatchObject({ previousEnvironmentId: a, restoredSelection: nodeA, entryModeAfter: 'BLOCKED' });
    const route = h.repos.routeState.get();
    expect(route).toMatchObject({ phase: 'failed', entryMode: 'BLOCKED', activeEnvironmentId: a, selectedNode: nodeA, awaitingDeadline: null });
    expect(route.warnings).toContain('rollback_needs_reverify');
    expect(await h.fake.getGroupSelection(ROUTE_GROUP_NAME)).toBe(nodeA);
    expect(h.repos.environments.get(b)!.lastVerifiedProxyRevision).toBeNull();
    // 检测主机不再经未提交的目标出口；其余 Safari 流量保持拒绝
    expect(safariOutcome(h, FAKE_VERIFY_HOST).failed).toBe(true);
    expect(safariOutcome(h).failed).toBe(true);
  });

  test('the commit fails after the entry reads back ACTIVE → rollback (ACTIVE → BLOCKED), never left ACTIVE without a record', async () => {
    h = await createHarness();
    const { envId: a } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const b = (await createEnv(h, 'US-Buyer-B', '203.0.113.11')).environment_id!;
    await bind(h, PROFILE_B, b);
    const nodeA = h.repos.proxyRevisions.get(a, 1)!.nodeName;
    const opId = await startSwitch(b);
    afterVerificationRead(() => failOnce(h.repos.environments, 'update', dbError('SQLITE_FULL')));
    await verify(h, PROFILE_B, opId);
    const op = h.repos.operations.get(opId)!;
    expect(op).toMatchObject({ phase: 'FAILED', status: 'failed' });
    expect(op.error).toMatchObject({ code: 'INTERNAL' });
    const route = h.repos.routeState.get();
    expect(route).toMatchObject({ phase: 'failed', entryMode: 'BLOCKED', activeEnvironmentId: a, selectedNode: nodeA });
    expect(route.warnings).toContain('rollback_needs_reverify');
    expect(h.repos.environments.get(b)!.lastVerifiedProxyRevision).toBeNull();
    expect(safariOutcome(h).failed).toBe(true);
    expect(safariOutcome(h, FAKE_VERIFY_HOST).failed).toBe(true);
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

describe('an interrupted switch never becomes the "previous route" of the next activation (§6.3 step 5/14)', () => {
  /** A 使用中，切到 B 停在 VERIFY_ONLY 等待（SFE-ROUTE 已选 B 的未验证节点）。 */
  async function switchedToB() {
    h = await createHarness();
    const { envId: a } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const b = (await createEnv(h, 'US-Buyer-B', '203.0.113.11')).environment_id!;
    await bind(h, PROFILE_B, b);
    const c = (await createEnv(h, 'US-Buyer-C', '203.0.113.12')).environment_id!;
    await bind(h, PROFILE_C, c);
    const nodeA = h.repos.proxyRevisions.get(a, 1)!.nodeName;
    const nodeB = h.repos.proxyRevisions.get(b, 1)!.nodeName;
    const opB = await startSwitch(b);
    expect(h.repos.routeState.get()).toMatchObject({ phase: 'awaiting_safari_verify', entryMode: 'VERIFY_ONLY', activeEnvironmentId: a, selectedNode: nodeB });
    return { a, b, c, nodeA, nodeB, opB };
  }

  /** 激活 C 并让它超时回滚：回滚目标必须是 A 的原节点，而不是半途切换写入的 B 节点。 */
  async function activateCAndTimeOut(a: string, c: string, nodeA: string) {
    const opC = await startSwitch(c, { confirmed_environment_id: a });
    expect(h.repos.routeState.get()).toMatchObject({ phase: 'awaiting_safari_verify', operationId: opC });
    await h.clock.advanceAsync((h.repos.settings.get('profileArrivalTimeoutSec') + 1) * 1000);
    await h.idle();
    const op = h.repos.operations.get(opC)!;
    expect(op.error?.code).toBe('SAFARI_VERIFY_TIMEOUT');
    expect((op.result as { rollback: RollbackResult }).rollback).toMatchObject({ previousEnvironmentId: a, restoredSelection: nodeA, entryModeAfter: 'BLOCKED', needsReverify: true });
    const route = h.repos.routeState.get();
    expect(route).toMatchObject({ phase: 'failed', entryMode: 'BLOCKED', activeEnvironmentId: a, selectedNode: nodeA });
    expect(route.warnings).toContain('rollback_needs_reverify');
    // 切换前状态已恢复：快照用完即清除
    expect(route.activationSnapshot).toBeNull();
    expect(await h.fake.getGroupSelection(ROUTE_GROUP_NAME)).toBe(nodeA);
    expect(safariOutcome(h).failed).toBe(true);
  }

  test('orphaned VERIFY_ONLY wait → reconcile attention → the next activation fails → rollback restores A\'s original node, not B\'s', async () => {
    const { a, c, nodeA, opB } = await switchedToB();
    // 负责的操作意外结束（例如核对中的意外异常只被执行器标为失败）：对账把无人负责的等待标为 attention
    h.repos.operations.update(opB, { phase: 'FAILED', status: 'failed', error: { code: 'INTERNAL', message: '执行失败：内部错误' } });
    await h.app.runPeriodicReconcile();
    expect(h.repos.routeState.get()).toMatchObject({ phase: 'attention', entryMode: 'VERIFY_ONLY', activeEnvironmentId: a });
    expect(h.repos.routeState.get().activationSnapshot).toMatchObject({ previousEnvironmentId: a, previousSelectedNode: nodeA });
    await activateCAndTimeOut(a, c, nodeA);
    // 重新核验 A 照常完成
    const re = await startSwitch(a, { confirmed_environment_id: a });
    await verify(h, PROFILE_A, re);
    expect(h.repos.routeState.get()).toMatchObject({ phase: 'active_verified', entryMode: 'ACTIVE', activeEnvironmentId: a, selectedNode: nodeA });
  });

  test('a rollback that could not be confirmed (attention) → the next activation fails → rollback restores A\'s original node, not B\'s', async () => {
    const { a, c, nodeA, nodeB, opB } = await switchedToB();
    h.fake.failNext('selectGroupPolicy');
    await h.app.cancelOperation(opB, { request_id: rid() }, WEB);
    await h.idle();
    expect(h.repos.operations.get(opB)!.phase).toBe('BLOCKED_NEEDS_ATTENTION');
    expect(h.repos.routeState.get()).toMatchObject({ phase: 'attention', entryMode: 'BLOCKED', activeEnvironmentId: a, selectedNode: nodeB });
    await activateCAndTimeOut(a, c, nodeA);
  });

  test('normal mode fails after an interrupted switch → the next activation fails → rollback restores A\'s original node, not B\'s', async () => {
    const { a, c, nodeA, nodeB, opB } = await switchedToB();
    h.repos.operations.update(opB, { phase: 'FAILED', status: 'failed', error: { code: 'INTERNAL', message: '执行失败：内部错误' } });
    await h.app.runPeriodicReconcile();
    expect(h.repos.routeState.get().phase).toBe('attention');
    // 普通模式读取入口时 Surge 调用失败（入口策略从不调用外部资源更新）
    h.fake.failNext('listExternalResources');
    const n = await h.app.enterNormal({ request_id: rid('normal'), old_session_policy: 'closed_confirmed', confirmed_environment_id: a }, WEB);
    await h.idle();
    expect(h.repos.operations.get(n.operation_id)!.phase).toBe('FAILED');
    expect(h.repos.routeState.get()).toMatchObject({ phase: 'failed', activeEnvironmentId: a, selectedNode: nodeB });
    await activateCAndTimeOut(a, c, nodeA);
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
    const writes = h.fake.watcherReloads.filter((r) => r.key.startsWith('ruleset:sfe-entry-') && !r.key.endsWith(ENTRY_RULESET_FILES.active)).length;
    const opId = await startSwitch(env);
    const op = h.repos.operations.get(opId)!;
    expect(op.phase).toBe('FAILED');
    expect(op.error?.code).toBe('BASELINE_CHANGED');
    expect((op.error?.details as { files: string[] }).files).toEqual([ENTRY_RULESET_FILES.active]);
    expect(h.repos.routeState.get()).toMatchObject({ phase: 'idle', entryMode: 'NORMAL', routeEpoch: before.routeEpoch, activeEnvironmentId: null });
    // 没有写入任何入口规则集文件（被编辑的 active 文件由文件监视加载，是用户的修改，不是本应用的写入）
    expect(h.fake.watcherReloads.filter((r) => r.key.startsWith('ruleset:sfe-entry-') && !r.key.endsWith(ENTRY_RULESET_FILES.active)).length).toBe(writes);
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
