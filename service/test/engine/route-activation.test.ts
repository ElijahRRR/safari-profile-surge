// 受控切换的收尾与接手（docs/ARCHITECTURE.md §6.3）：写入 ACTIVE 之前重新检查激活门槛、提交后立即对账；
// 取代等待中的激活后在写入前失败 → 按快照回滚，不让 VERIFY_ONLY 无人负责；被外部修改的本应用入口文件
// 从不被激活悄悄改写（§5.5，只有撤销入口会改写）。只用合成数据。

import { appendFileSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { ENTRY_RULESET_FILES, ROUTE_GROUP_NAME, type ActivateRequest, type RollbackResult } from '@sfe/contract';
import { FAKE_CHROME_PATH, FAKE_SAFARI_PATH, FAKE_VERIFY_HOST } from '../../src/surge/fake.js';
import { capabilityUnverified } from '../../src/surge/primitives.js';
import { FakeSurge } from '../../src/surge/fake.js';

const FakeSurgeProto = FakeSurge.prototype;
import { AGENT, PROFILE_A, PROFILE_B, PROFILE_C, WEB, TEST_ENDPOINT, activeEnv, bind, createEnv, createHarness, grantForCurrentHost, instanceContext, rid, safariOutcome, verify, type Harness } from './harness.js';

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
    // 失败即关闭：入口最后确认的是 VERIFY_ONLY、选择是 B 的未验证节点——SFE-ROUTE 改选 REJECT（读回确认），检测主机不经 B 发出
    // 改选过 REJECT：路由需要处理（与回滚无法确认相同），入口未经确认
    expect(h.repos.routeState.get()).toMatchObject({ phase: 'attention', activeEnvironmentId: a, selectedNode: 'REJECT' });
    expect(h.repos.routeState.get().warnings).toContain('entry_unverified');
    expect(h.repos.routeState.get().activationSnapshot).toMatchObject({ previousEnvironmentId: a, previousSelectedNode: nodeA });
    expect(await h.fake.getGroupSelection(ROUTE_GROUP_NAME)).toBe('REJECT');
    expect(safariOutcome(h, FAKE_VERIFY_HOST).leafPolicyName).not.toBe(nodeB);
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

describe('a rollback whose return to BLOCKED is not runtime-confirmed (rule match unavailable, watcher slower than the wait; ruleset_resource)', () => {
  /** rule match 读不到（撤销入口改走退路：写入并等满文件监视上限），假 Surge 的文件监视延迟（假时钟 60 秒）高于等待上限。 */
  function ruleMatchGoneAndSlowWatcher(): void {
    h.fake.matchRule = async () => {
      throw capabilityUnverified('matchRule');
    };
    h.fake.localWatchLatencyMs = 60_000;
  }

  test('the first activation fails at its blocking step: the rollback does not claim Safari stays blocked (Surge still has the original rules loaded), ends as needs-attention with the entry UNKNOWN (entry_unverified) and SFE-ROUTE on REJECT', async () => {
    h = await createHarness();
    const env = (await createEnv(h, 'US-Buyer-A', '203.0.113.10')).environment_id!;
    await bind(h, PROFILE_A, env);
    ruleMatchGoneAndSlowWatcher();
    const opId = await startSwitch(env);
    const op = h.repos.operations.get(opId)!;
    expect(op).toMatchObject({ phase: 'BLOCKED_NEEDS_ATTENTION', status: 'needs_attention' });
    const steps = h.repos.operations.listSteps(opId).map((st) => st.message);
    expect(steps.some((m) => m.includes('Safari 保持阻断'))).toBe(false);
    expect(steps.at(-1)).toContain('入口已按计划写入阻断，但未经运行时求值确认，Surge 可能仍加载着写入之前的入口');
    expect((op.result as { rollback?: RollbackResult } | null)?.rollback).toBeUndefined();
    const route = h.repos.routeState.get();
    expect(route).toMatchObject({ phase: 'attention', entryMode: 'UNKNOWN', selectedNode: 'REJECT', activeEnvironmentId: null });
    expect(route.warnings).toContain('entry_unverified');
    expect(h.app.views.routeView().normalModeOffered).toBe(true);
    // 说明属实：Surge 仍按原规则放行 Safari（写入的阻断尚未加载）
    expect(safariOutcome(h).rule).toBe('FINAL,DIRECT');
    // 文件监视赶上之后 Safari 被阻断
    h.clock.advance(120_000);
    expect(safariOutcome(h).failed).toBe(true);
    expect(h.fake.calls.reloadProfile ?? 0).toBe(0);
  });

  test('cancelling a switch from verified A to B: the rollback does not restore A\'s node while VERIFY_ONLY may still be loaded — Safari\'s verify-host request is rejected, never sent through A\'s (or B\'s) exit', async () => {
    h = await createHarness();
    const { envId: a } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const nodeA = h.repos.routeState.get().selectedNode!;
    const b = (await createEnv(h, 'US-Buyer-B', '203.0.113.11')).environment_id!;
    await bind(h, PROFILE_B, b);
    const opId = await startSwitch(b);
    expect(h.repos.operations.get(opId)!.phase).toBe('VERIFY_ONLY');
    const nodeB = h.repos.routeState.get().selectedNode!;
    expect(nodeB).not.toBe(nodeA);
    ruleMatchGoneAndSlowWatcher();
    await h.app.cancelOperation(opId, { request_id: rid() }, WEB);
    await h.idle();
    expect(h.repos.operations.get(opId)).toMatchObject({ phase: 'BLOCKED_NEEDS_ATTENTION', status: 'needs_attention' });
    expect(h.repos.operations.listSteps(opId).some((st) => st.message.includes('Safari 保持阻断'))).toBe(false);
    expect(await h.fake.getGroupSelection(ROUTE_GROUP_NAME)).toBe('REJECT');
    const route = h.repos.routeState.get();
    // 没有恢复 A 的节点；激活快照保留（之后的激活与回滚仍从最初的切换前状态出发）
    expect(route).toMatchObject({ phase: 'attention', entryMode: 'UNKNOWN', selectedNode: 'REJECT', activeEnvironmentId: a });
    expect(route.activationSnapshot).toMatchObject({ previousEnvironmentId: a, previousSelectedNode: nodeA });
    expect(route.warnings).toContain('entry_unverified');
    // Surge 仍加载着 VERIFY_ONLY：检测主机经 SFE-ROUTE，被 REJECT 拒绝
    const v = h.fake.simulateRequest({ processPath: FAKE_SAFARI_PATH, host: FAKE_VERIFY_HOST, protocol: 'tcp', longLived: true });
    expect(v.policyName).toBe(ROUTE_GROUP_NAME);
    expect(v.leafPolicyName).toBe('REJECT');
    expect(v.failed).toBe(true);
    expect(safariOutcome(h).failed).toBe(true);
    // rule match 恢复、文件监视恢复正常之后普通模式照常完成
    h.clock.advance(120_000);
    h.fake.localWatchLatencyMs = 0;
    h.fake.matchRule = (FakeSurgeProto.matchRule as typeof h.fake.matchRule).bind(h.fake);
    const n = await h.app.enterNormal({ request_id: rid(), old_session_policy: 'closed_confirmed', confirmed_environment_id: a }, WEB);
    await h.idle();
    expect(h.repos.operations.get(n.operation_id)!.phase).toBe('NORMAL_RESTORED');
    expect(h.repos.routeState.get()).toMatchObject({ entryMode: 'NORMAL', phase: 'idle', activeEnvironmentId: null, activationSnapshot: null });
    expect(h.fake.calls.reloadProfile ?? 0).toBe(0);
  });
});

describe('a rollback that cannot confirm its return to BLOCKED never leaves Safari on the switch\'s unverified exit (§6.3 step 14, fail closed)', () => {
  /** A 使用中（已验证），切到 B 停在 VERIFY_ONLY 等待：SFE-ROUTE 已选 B 的未验证节点，Surge 加载着 VERIFY_ONLY。 */
  async function switchingToB() {
    h = await createHarness();
    const { envId: a } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const nodeA = h.repos.routeState.get().selectedNode!;
    const b = (await createEnv(h, 'US-Buyer-B', '203.0.113.11')).environment_id!;
    await bind(h, PROFILE_B, b);
    const opB = await startSwitch(b);
    const nodeB = h.repos.proxyRevisions.get(b, 1)!.nodeName;
    expect(h.repos.routeState.get()).toMatchObject({ phase: 'awaiting_safari_verify', entryMode: 'VERIFY_ONLY', activeEnvironmentId: a, selectedNode: nodeB });
    return { a, b, nodeA, nodeB, opB };
  }

  /** Safari 访问检测主机（Surge 仍加载着 VERIFY_ONLY 时经 SFE-ROUTE）。 */
  const verifyHostRequest = () => h.fake.simulateRequest({ processPath: FAKE_SAFARI_PATH, host: FAKE_VERIFY_HOST, protocol: 'tcp', longLived: true });

  test('rule match available, file watcher slower than the limit (ruleset_resource): cancelling A→B times out the return to BLOCKED; SFE-ROUTE is moved to REJECT (read back), so Safari\'s verify-host request is rejected, never sent through B\'s exit', async () => {
    const { a, nodeA, opB } = await switchingToB();
    // 回滚写入阻断（verify 关闭）之后，Surge 的文件监视在时限内没有重新加载：仍加载着 VERIFY_ONLY
    h.fake.localWatchLatencyMs = 60_000;
    await h.app.cancelOperation(opB, { request_id: rid() }, WEB);
    await h.idle();
    const op = h.repos.operations.get(opB)!;
    expect(op).toMatchObject({ phase: 'BLOCKED_NEEDS_ATTENTION', status: 'needs_attention' });
    expect(op.error?.message).toContain('回滚无法确认：入口状态未知，需要处理；SFE-ROUTE 已改选 REJECT（读回确认）');
    expect(op.error?.details).toMatchObject({ rejectSelected: true });
    expect(h.repos.operations.listSteps(opB).some((st) => st.message.includes('Safari 保持已确认的阻断'))).toBe(false);
    expect(await h.fake.getGroupSelection(ROUTE_GROUP_NAME)).toBe('REJECT');
    const route = h.repos.routeState.get();
    // 没有恢复 A 的节点（入口未确认阻断）；激活快照保留，之后的激活与回滚仍从最初的切换前状态出发
    expect(route).toMatchObject({ phase: 'attention', entryMode: 'UNKNOWN', selectedNode: 'REJECT', activeEnvironmentId: a });
    expect(route.activationSnapshot).toMatchObject({ previousEnvironmentId: a, previousSelectedNode: nodeA });
    expect(route.warnings).toContain('entry_unverified');
    // Surge 仍加载着 VERIFY_ONLY：检测主机经 SFE-ROUTE，被 REJECT 拒绝
    const v = verifyHostRequest();
    expect(v.policyName).toBe(ROUTE_GROUP_NAME);
    expect(v.leafPolicyName).toBe('REJECT');
    expect(v.failed).toBe(true);
    expect(safariOutcome(h).failed).toBe(true);
    // Chrome 不命中本应用入口
    expect(h.fake.simulateRequest({ processPath: FAKE_CHROME_PATH, host: FAKE_VERIFY_HOST, protocol: 'tcp' }).policyName).not.toBe(ROUTE_GROUP_NAME);
    // 文件监视赶上之后普通模式照常完成
    h.clock.advance(120_000);
    h.fake.localWatchLatencyMs = 0;
    const n = await h.app.enterNormal({ request_id: rid(), old_session_policy: 'closed_confirmed', confirmed_environment_id: a }, WEB);
    await h.idle();
    expect(h.repos.operations.get(n.operation_id)!.phase).toBe('NORMAL_RESTORED');
    expect(h.repos.routeState.get()).toMatchObject({ entryMode: 'NORMAL', phase: 'idle', activeEnvironmentId: null, activationSnapshot: null });
    expect(safariOutcome(h).rule).toBe('FINAL,DIRECT');
    expect(h.fake.calls.reloadProfile ?? 0).toBe(0);
  });

  test.each([
    ['the REJECT selection fails', 'fail'],
    ['the REJECT selection silently does not apply (read back differs)', 'lie'],
  ] as const)('same rollback, but %s: reported truthfully (not recorded as REJECT, says Safari may still go out through the selected buyer exit), the failure never escapes the rollback', async (_label, kind) => {
    const { a, nodeB, opB } = await switchingToB();
    h.fake.localWatchLatencyMs = 60_000;
    // 回到阻断不调用 selectGroupPolicy：下一次调用就是改选 REJECT
    if (kind === 'fail') h.fake.failNext('selectGroupPolicy');
    else h.fake.lieOnNext('selectGroupPolicy');
    await h.app.cancelOperation(opB, { request_id: rid() }, WEB);
    await h.idle();
    const op = h.repos.operations.get(opB)!;
    // 回滚自己结算（不是执行器兜底的“执行失败：内部错误”）
    expect(op).toMatchObject({ phase: 'BLOCKED_NEEDS_ATTENTION', status: 'needs_attention' });
    expect(op.error?.message).toContain('SFE-ROUTE 未能改选 REJECT（');
    expect(op.error?.message).toContain('Safari 请求（至少检测主机）可能仍经 SFE-ROUTE 当前选择的买家出口发出');
    expect(op.error?.message).not.toContain('已改选 REJECT');
    expect(op.error?.details).toMatchObject({ rejectSelected: false });
    expect(h.repos.operations.listSteps(opB).some((st) => st.message.includes('执行失败：内部错误'))).toBe(false);
    const route = h.repos.routeState.get();
    expect(route).toMatchObject({ phase: 'attention', entryMode: 'UNKNOWN', selectedNode: nodeB, activeEnvironmentId: a });
    expect(route.warnings).toContain('entry_unverified');
    // 说明属实：选择仍是 B 的节点，检测主机经 B 发出
    expect(await h.fake.getGroupSelection(ROUTE_GROUP_NAME)).toBe(nodeB);
    expect(verifyHostRequest().leafPolicyName).toBe(nodeB);
    expect(h.app.views.routeView().normalModeOffered).toBe(true);
    // 普通模式（文件监视恢复后）撤销本应用入口
    h.clock.advance(120_000);
    h.fake.localWatchLatencyMs = 0;
    const n = await h.app.enterNormal({ request_id: rid(), old_session_policy: 'closed_confirmed', confirmed_environment_id: a }, WEB);
    await h.idle();
    expect(h.repos.operations.get(n.operation_id)!.phase).toBe('NORMAL_RESTORED');
    expect(verifyHostRequest().policyName).not.toBe(ROUTE_GROUP_NAME);
  });

  test('a normal mode that took over the waiting switch fails at its blocking step (watcher slower than the limit): SFE-ROUTE is moved to REJECT, Safari\'s verify-host request is not sent through B\'s exit', async () => {
    const { a, opB } = await switchingToB();
    h.fake.localWatchLatencyMs = 60_000;
    const n = await h.app.enterNormal({ request_id: rid(), old_session_policy: 'closed_confirmed', confirmed_environment_id: a }, WEB);
    await h.idle();
    expect(h.repos.operations.get(opB)!.phase).toBe('SUPERSEDED');
    const op = h.repos.operations.get(n.operation_id)!;
    expect(op.phase).toBe('FAILED');
    expect(op.result).toMatchObject({ rejectSelected: true });
    expect(h.repos.operations.listSteps(n.operation_id).at(-1)!.message).toContain('SFE-ROUTE 已改选 REJECT（读回确认）');
    expect(h.repos.routeState.get()).toMatchObject({ phase: 'attention', entryMode: 'UNKNOWN', selectedNode: 'REJECT', activeEnvironmentId: a });
    expect(await h.fake.getGroupSelection(ROUTE_GROUP_NAME)).toBe('REJECT');
    const v = verifyHostRequest();
    expect(v.leafPolicyName).toBe('REJECT');
    expect(v.failed).toBe(true);
    expect(h.app.views.routeView().normalModeOffered).toBe(true);
    // 文件监视赶上之后再进入普通模式照常完成
    h.clock.advance(120_000);
    h.fake.localWatchLatencyMs = 0;
    const again = await h.app.enterNormal({ request_id: rid(), old_session_policy: 'closed_confirmed', confirmed_environment_id: a }, WEB);
    await h.idle();
    expect(h.repos.operations.get(again.operation_id)!.phase).toBe('NORMAL_RESTORED');
    expect(safariOutcome(h).rule).toBe('FINAL,DIRECT');
  });

  test('an unexpected error escaping the rollback (e.g. a database error) does not orphan the VERIFY_ONLY wait on B\'s exit: the executor guard moves SFE-ROUTE to REJECT and marks the operation needs-attention; both environments are re-sent', async () => {
    const { a, b, opB } = await switchingToB();
    const routeState = h.repos.routeState as { update: typeof h.repos.routeState.update };
    const orig = routeState.update.bind(h.repos.routeState);
    let thrown = false;
    routeState.update = (patch) => {
      if (!thrown && patch.phase === 'rolling_back') {
        thrown = true;
        throw new Error('模拟数据库错误');
      }
      return orig(patch);
    };
    await h.app.cancelOperation(opB, { request_id: rid() }, WEB);
    await h.idle();
    routeState.update = orig;
    expect(thrown).toBe(true);
    const op = h.repos.operations.get(opB)!;
    expect(op).toMatchObject({ phase: 'BLOCKED_NEEDS_ATTENTION', status: 'needs_attention' });
    expect(op.error?.message).toContain('切换中断：处理中出现意外错误');
    expect(op.error?.message).toContain('SFE-ROUTE 已改选 REJECT（读回确认）');
    expect(h.repos.routeState.get()).toMatchObject({ phase: 'attention', entryMode: 'UNKNOWN', selectedNode: 'REJECT', activeEnvironmentId: a });
    expect(h.repos.routeState.get().warnings).toContain('entry_unverified');
    const v = verifyHostRequest();
    expect(v.leafPolicyName).toBe('REJECT');
    expect(v.failed).toBe(true);
    // 网页后台只在 environment.updated 中更新环境：B（切换中 → 未使用）与 A（→ 路由状态需要处理）的最后一个事件与服务端视图一致
    for (const id of [b, a]) {
      const last = h.events.filter((e) => e.type === 'environment.updated' && e.environment.id === id).at(-1);
      const ev = last && last.type === 'environment.updated' ? last.environment : null;
      const fresh = h.app.views.environmentView(id)!;
      expect({ id, route: ev?.facets.route, readiness: ev?.readiness }).toEqual({ id, route: fresh.facets.route, readiness: fresh.readiness });
    }
    expect(h.app.views.environmentView(b)!.facets.route).toBe('inactive');
    const n = await h.app.enterNormal({ request_id: rid(), old_session_policy: 'closed_confirmed', confirmed_environment_id: a }, WEB);
    await h.idle();
    expect(h.repos.operations.get(n.operation_id)!.phase).toBe('NORMAL_RESTORED');
  });
});

describe('rule match unavailable during a rollback (ruleset_resource fallback, watcher slower than the wait): what the rollback reports and selects', () => {
  async function switchingToBWithoutRuleMatch() {
    h = await createHarness();
    const { envId: a } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const b = (await createEnv(h, 'US-Buyer-B', '203.0.113.11')).environment_id!;
    await bind(h, PROFILE_B, b);
    const opB = await startSwitch(b);
    const nodeB = h.repos.proxyRevisions.get(b, 1)!.nodeName;
    expect(h.repos.routeState.get()).toMatchObject({ phase: 'awaiting_safari_verify', entryMode: 'VERIFY_ONLY', selectedNode: nodeB });
    h.fake.matchRule = async () => {
      throw capabilityUnverified('matchRule');
    };
    h.fake.localWatchLatencyMs = 60_000;
    return { a, nodeB, opB };
  }

  test('the REJECT selection of an unconfirmed return to BLOCKED fails: reported truthfully (SFE-ROUTE still on B\'s node, not recorded as REJECT), the operation still settles as needs-attention', async () => {
    const { a, nodeB, opB } = await switchingToBWithoutRuleMatch();
    h.fake.failNext('selectGroupPolicy');
    await h.app.cancelOperation(opB, { request_id: rid() }, WEB);
    await h.idle();
    const op = h.repos.operations.get(opB)!;
    expect(op).toMatchObject({ phase: 'BLOCKED_NEEDS_ATTENTION', status: 'needs_attention' });
    expect(op.error?.message).toContain('入口已按计划写入阻断，但未经运行时求值确认');
    expect(op.error?.message).toContain('未恢复切换前的节点，但 SFE-ROUTE 未能改选 REJECT（');
    expect(op.error?.message).not.toContain('已改选 REJECT');
    expect(op.error?.details).toMatchObject({ rejectSelected: false });
    expect(h.repos.routeState.get()).toMatchObject({ phase: 'attention', entryMode: 'UNKNOWN', selectedNode: nodeB, activeEnvironmentId: a });
    expect(await h.fake.getGroupSelection(ROUTE_GROUP_NAME)).toBe(nodeB);
    expect(h.app.views.routeView().normalModeOffered).toBe(true);
  });

  test('a fallback return to BLOCKED reported only as PRECEDENCE_VIOLATION (a rule before the entry) is not taken as a confirmed block: no "Safari stays blocked" claim, SFE-ROUTE moved to REJECT, Safari\'s verify-host request is rejected', async () => {
    const { a, opB } = await switchingToBWithoutRuleMatch();
    h.fake.setModuleRules([{ text: 'DOMAIN-SUFFIX,amazon.com,DIRECT', moduleName: 'user-module' }]);
    await h.app.cancelOperation(opB, { request_id: rid() }, WEB);
    await h.idle();
    const op = h.repos.operations.get(opB)!;
    expect(op).toMatchObject({ phase: 'BLOCKED_NEEDS_ATTENTION', status: 'needs_attention' });
    expect(op.error?.message).not.toContain('Safari 保持已确认的阻断');
    expect(op.error?.message).toContain('SFE-ROUTE 已改选 REJECT（读回确认）');
    expect(h.repos.routeState.get()).toMatchObject({ phase: 'attention', entryMode: 'UNKNOWN', selectedNode: 'REJECT', activeEnvironmentId: a });
    const v = h.fake.simulateRequest({ processPath: FAKE_SAFARI_PATH, host: FAKE_VERIFY_HOST, protocol: 'tcp' });
    expect(v.policyName).toBe(ROUTE_GROUP_NAME);
    expect(v.leafPolicyName).toBe('REJECT');
    expect(v.failed).toBe(true);
  });
});

describe('what a rollback that cannot confirm its return to BLOCKED reports and keeps (§6.3 step 14)', () => {
  /** A 使用中（已验证），切到 B 停在 VERIFY_ONLY 等待。 */
  async function switchingToB(strategy: 'ruleset_resource' | 'temp_rule' = 'ruleset_resource', extra: Partial<ActivateRequest> = {}) {
    h = await createHarness({ entryStrategy: strategy });
    const { envId: a } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const nodeA = h.repos.routeState.get().selectedNode!;
    const b = (await createEnv(h, 'US-Buyer-B', '203.0.113.11')).environment_id!;
    await bind(h, PROFILE_B, b);
    const opB = await startSwitch(b, extra);
    const nodeB = h.repos.proxyRevisions.get(b, 1)!.nodeName;
    expect(h.repos.routeState.get()).toMatchObject({ phase: 'awaiting_safari_verify', entryMode: 'VERIFY_ONLY', activeEnvironmentId: a, selectedNode: nodeB });
    return { a, b, nodeA, nodeB, opB };
  }
  const cancel = async (opId: string) => {
    await h.app.cancelOperation(opId, { request_id: rid() }, WEB);
    await h.idle();
  };
  function ruleMatchGone(): void {
    h.fake.matchRule = async () => {
      throw capabilityUnverified('matchRule');
    };
  }

  test.each(['ruleset_resource', 'temp_rule'] as const)('%s: a return to BLOCKED whose final readback fails only because a module rule sits before the entry does not claim a confirmed block; it lists the rules and records precedence_violation', async (strategy) => {
    const { a, opB } = await switchingToB(strategy);
    h.fake.setModuleRules([{ text: 'DOMAIN-SUFFIX,example.test,DIRECT', moduleName: 'user-module' }]);
    await cancel(opB);
    const op = h.repos.operations.get(opB)!;
    expect(op).toMatchObject({ phase: 'BLOCKED_NEEDS_ATTENTION', status: 'needs_attention' });
    const steps = h.repos.operations.listSteps(opB).map((st) => st.message);
    expect(steps.some((m) => m.includes('Safari 保持已确认的阻断') || m.startsWith('已回滚'))).toBe(false);
    expect(op.error?.message).toContain('入口位已读回为阻断，但有 1 条规则排在本应用入口之前');
    expect(op.error?.message).toContain('不能确认 Safari 保持阻断');
    expect((op.result as { precedenceIssues?: Array<{ severity: string }> }).precedenceIssues?.some((i) => i.severity === 'blocking')).toBe(true);
    const route = h.repos.routeState.get();
    expect(route).toMatchObject({ phase: 'attention', entryMode: 'BLOCKED', activeEnvironmentId: a });
    expect(route.warnings).toEqual(expect.arrayContaining(['entry_unverified', 'precedence_violation', 'buyer_exit_connections_unconfirmed']));
    // 排在入口之前的规则也可能把 Safari 请求交给 SFE-ROUTE：它选着的 B 的未验证节点改为 REJECT
    expect(await h.fake.getGroupSelection(ROUTE_GROUP_NAME)).toBe('REJECT');
    expect(route.selectedNode).toBe('REJECT');
    // 说明属实：被排在入口之前的规则匹配的 Safari 请求按它发出（直连），其余被阻断；从不经 SFE-ROUTE
    const www = safariOutcome(h);
    expect(www.rule).toBe('DOMAIN-SUFFIX,example.test,DIRECT');
    expect(www.policyName).not.toBe(ROUTE_GROUP_NAME);
    // 其他场景的弹窗紧接着读取状态（上一次对账仍在 5 秒有效期内，不再对账）：摘要标明入口未经确认，顶栏不声称「Safari 已阻断」
    for (const profile of [PROFILE_C, null]) {
      const d = (await h.native(profile, { type: 'getCurrentState' })) as { ok: true; data: { routeSummary: { entryMode: string; entryUnconfirmed: boolean } } };
      expect(d.data.routeSummary).toMatchObject({ entryMode: 'BLOCKED', entryUnconfirmed: true });
    }
  });

  // 切换中途（第 2 步检查之后）出现排在入口之前的模块规则（用户启用或模块自动更新、其他工具 `rule temp add`）：第 9 步写入
  // VERIFY_ONLY 之前的检查或第 6 步阻断的最终读回以 PRECEDENCE_VIOLATION 失败，最后确认的入口位是阻断。回滚不能凭这一记录跳过
  // 回到阻断与读回、恢复切换前的节点并声称「Safari 保持阻断」：被模块规则匹配的 Safari 请求直连发出。
  test.each([
    ['ruleset_resource', 'step 8 (after selecting the new node)'],
    ['temp_rule', 'step 8 (after selecting the new node)'],
    ['ruleset_resource', 'step 2 (after the precedence check passed)'],
    ['temp_rule', 'step 2 (after the precedence check passed)'],
  ] as const)('%s: a module rule placed before the entry during the switch, at %s, makes the rollback re-read the block, list the rules and hold REJECT instead of claiming Safari stays blocked', async (strategy, where) => {
    h = await createHarness({ entryStrategy: strategy });
    const { envId: a } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const nodeA = h.repos.routeState.get().selectedNode!;
    const b = (await createEnv(h, 'US-Buyer-B', '203.0.113.11')).environment_id!;
    await bind(h, PROFILE_B, b);
    const nodeB = h.repos.proxyRevisions.get(b, 1)!.nodeName;
    const moduleRule = [{ text: 'DOMAIN-SUFFIX,example.test,DIRECT', moduleName: 'user-module' }];
    if (where.startsWith('step 8')) {
      const select = h.fake.selectGroupPolicy.bind(h.fake);
      h.fake.selectGroupPolicy = async (group: string, policy: string) => {
        await select(group, policy);
        if (group === ROUTE_GROUP_NAME && policy === nodeB) h.fake.setModuleRules(moduleRule);
      };
    } else {
      // 第 2 步最后读 SFE-ROUTE 成员（读回入口与优先级检查之后）
      const members = h.fake.getGroupMembers.bind(h.fake);
      let armed = true;
      h.fake.getGroupMembers = async (group: string) => {
        const r = await members(group);
        if (armed) {
          armed = false;
          h.fake.setModuleRules(moduleRule);
        }
        return r;
      };
    }
    const opB = await startSwitch(b);
    const op = h.repos.operations.get(opB)!;
    expect(op).toMatchObject({ phase: 'BLOCKED_NEEDS_ATTENTION', status: 'needs_attention' });
    const steps = h.repos.operations.listSteps(opB).map((st) => st.message);
    const claimsBlock = (m: string): boolean => m.replaceAll('不能确认 Safari 保持阻断', '').includes('Safari 保持阻断') || m.includes('Safari 保持已确认的阻断');
    expect(steps.some((m) => m.startsWith('已回滚') || claimsBlock(m))).toBe(false);
    expect(op.error?.message).toContain('不能确认 Safari 保持阻断');
    expect((op.result as { precedenceIssues?: Array<{ severity: string }> }).precedenceIssues?.some((i) => i.severity === 'blocking')).toBe(true);
    const route = h.repos.routeState.get();
    expect(route).toMatchObject({ phase: 'attention', activeEnvironmentId: a, selectedNode: 'REJECT' });
    expect(route.warnings).toEqual(expect.arrayContaining(['entry_unverified', 'precedence_violation', 'buyer_exit_connections_unconfirmed']));
    expect(route.warnings).not.toContain('rollback_needs_reverify');
    // 没有恢复切换前的买家出口：快照保留，SFE-ROUTE 改选 REJECT
    expect(route.activationSnapshot?.previousSelectedNode).toBe(nodeA);
    expect(await h.fake.getGroupSelection(ROUTE_GROUP_NAME)).toBe('REJECT');
    // 说明属实：被模块规则匹配的 Safari 请求按它直连发出，其余被阻断；从不经 SFE-ROUTE
    const www = safariOutcome(h);
    expect(www.rule).toBe('DOMAIN-SUFFIX,example.test,DIRECT');
    expect(www.policyName).not.toBe(ROUTE_GROUP_NAME);
    const other = h.fake.simulateRequest({ processPath: FAKE_SAFARI_PATH, host: 'shop.other.test2', protocol: 'tcp' });
    expect(other.failed).toBe(true);
  });

  test('an acknowledgement of old windows accepted while the rollback catch moves SFE-ROUTE to REJECT is not undone by the rollback', async () => {
    h = await createHarness();
    const { envId: a } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const b = (await createEnv(h, 'US-Buyer-B', '203.0.113.11')).environment_id!;
    await bind(h, PROFILE_B, b);
    const opB = await startSwitch(b, { old_session_policy: 'keep_open_acknowledged', confirmed_environment_id: a });
    await verify(h, PROFILE_B, opB);
    expect(h.repos.routeState.get().warnings).toContain('old_windows_kept_open');
    const c = (await createEnv(h, 'US-Buyer-C', '203.0.113.12')).environment_id!;
    await bind(h, PROFILE_C, c);
    const opC = await startSwitch(c, { old_session_policy: 'closed_confirmed', confirmed_environment_id: b });
    expect(h.repos.routeState.get().warnings).toContain('old_windows_kept_open');
    // 回到阻断超时（文件监视比上限慢）→ 回滚的失败处理改选 REJECT；改选的 Surge 调用期间用户确认旧窗口已关闭
    h.fake.localWatchLatencyMs = 60_000;
    const select = h.fake.selectGroupPolicy.bind(h.fake);
    let acknowledged = false;
    h.fake.selectGroupPolicy = async (group: string, policy: string) => {
      if (policy === 'REJECT' && !acknowledged) {
        acknowledged = true;
        await h.app.acknowledgeWindows({ request_id: rid() }, WEB);
        expect(h.repos.routeState.get().warnings).not.toContain('old_windows_kept_open');
      }
      return select(group, policy);
    };
    await cancel(opC);
    expect(acknowledged).toBe(true);
    expect(h.repos.operations.get(opC)!).toMatchObject({ phase: 'BLOCKED_NEEDS_ATTENTION', status: 'needs_attention' });
    expect(h.repos.routeState.get().warnings).not.toContain('old_windows_kept_open');
  });

  test('an expected-exit-IP edit accepted while the rollback catch moves SFE-ROUTE to REJECT keeps its exit_ip_mismatch', async () => {
    const { a, opB } = await switchingToB();
    h.fake.localWatchLatencyMs = 60_000;
    const select = h.fake.selectGroupPolicy.bind(h.fake);
    let edited = false;
    h.fake.selectGroupPolicy = async (group: string, policy: string) => {
      if (policy === 'REJECT' && !edited) {
        edited = true;
        const env = h.repos.environments.get(a)!;
        await h.app.updateEnvironment(a, { request_id: rid(), expected_revision: env.revision, changes: { proxy: { expectedExitIp: '192.0.2.99' } } } as never, WEB);
        expect(h.repos.routeState.get().warnings).toContain('exit_ip_mismatch');
      }
      return select(group, policy);
    };
    await cancel(opB);
    expect(edited).toBe(true);
    expect(h.repos.operations.get(opB)!).toMatchObject({ phase: 'BLOCKED_NEEDS_ATTENTION', status: 'needs_attention' });
    expect(h.repos.environments.get(a)!.expectedExitIp).toBe('192.0.2.99');
    expect(h.repos.routeState.get().warnings).toEqual(expect.arrayContaining(['exit_ip_mismatch', 'entry_unverified']));
  });

  test.each([
    ['rule match unavailable (not runtime-confirmed: the REJECT hold)', 'hold'],
    ['watcher slower than the limit (the rollback catch)', 'catch'],
  ] as const)('after an earlier rollback restored A, a re-verification of A cancelled with %s does not keep claiming the original node was restored and Safari stays blocked', async (_label, path) => {
    const { a, nodeA, opB } = await switchingToB();
    await cancel(opB);
    expect(h.repos.routeState.get()).toMatchObject({ phase: 'failed', entryMode: 'BLOCKED', activeEnvironmentId: a, selectedNode: nodeA });
    expect(h.repos.routeState.get().warnings).toContain('rollback_needs_reverify');
    expect(h.app.views.environmentView(a)!.facets.route).toBe('rolled_back');
    const opRe = await startSwitch(a);
    expect(h.repos.operations.get(opRe)!.phase).toBe('VERIFY_ONLY');
    if (path === 'hold') ruleMatchGone();
    h.fake.localWatchLatencyMs = 60_000;
    await cancel(opRe);
    expect(h.repos.operations.get(opRe)!).toMatchObject({ phase: 'BLOCKED_NEEDS_ATTENTION', status: 'needs_attention' });
    const route = h.repos.routeState.get();
    expect(route).toMatchObject({ phase: 'attention', entryMode: 'UNKNOWN', selectedNode: 'REJECT', activeEnvironmentId: a });
    expect(route.warnings).not.toContain('rollback_needs_reverify');
    const view = h.app.views.environmentView(a)!;
    expect(view.facets.route).not.toBe('rolled_back');
    expect(view.nextActions.some((x) => x.message.includes('已恢复原节点'))).toBe(false);
    expect(view.nextActions[0]?.message).toBe('路由状态需要处理：请重新使用此环境或进入普通模式');
    expect(h.app.views.routeView().warnings).not.toContain('rollback_needs_reverify');
  });

  test.each([
    ['rule match unavailable (the REJECT hold)', 'hold'],
    ['watcher slower than the limit (the rollback catch)', 'catch'],
  ] as const)('%s: moving SFE-ROUTE to REJECT does not move the verify-host connection already open on B\'s exit — the text only claims new connections, the route carries the buyer-exit warning, and normal mode ends that connection', async (_label, path) => {
    const { a, nodeB, opB } = await switchingToB();
    // 准备页的检测请求留下一条经 SFE-ROUTE → B 的长连接
    const live = h.fake.simulateRequest({ processPath: FAKE_SAFARI_PATH, host: FAKE_VERIFY_HOST, protocol: 'tcp', longLived: true });
    expect(live.leafPolicyName).toBe(nodeB);
    if (path === 'hold') ruleMatchGone();
    h.fake.localWatchLatencyMs = 60_000;
    const kills = h.fake.calls.killRequest ?? 0;
    await cancel(opB);
    const op = h.repos.operations.get(opB)!;
    expect(op).toMatchObject({ phase: 'BLOCKED_NEEDS_ATTENTION', status: 'needs_attention' });
    expect(op.error?.message).toContain('SFE-ROUTE 已改选 REJECT（读回确认）');
    expect(op.error?.message).not.toContain('不会经任何买家出口发出');
    expect(op.error?.message).toContain('已建立的 Safari 连接不受改选影响，可能仍在买家出口上');
    // 改选不结束已建立的连接：它仍在 B 的出口上，路由带警告并提供普通模式
    expect(h.fake.calls.killRequest ?? 0).toBe(kills);
    expect((await h.fake.listActiveRequests()).find((r) => r.id === live.id)?.leafPolicyName).toBe(nodeB);
    expect(h.repos.routeState.get().warnings).toEqual(expect.arrayContaining(['entry_unverified', 'buyer_exit_connections_unconfirmed']));
    expect(h.app.views.routeView().normalModeOffered).toBe(true);
    h.clock.advance(120_000);
    h.fake.localWatchLatencyMs = 0;
    h.fake.matchRule = (FakeSurgeProto.matchRule as typeof h.fake.matchRule).bind(h.fake);
    const n = await h.app.enterNormal({ request_id: rid(), old_session_policy: 'closed_confirmed', confirmed_environment_id: a }, WEB);
    await h.idle();
    expect(h.repos.operations.get(n.operation_id)!.phase).toBe('NORMAL_RESTORED');
    expect((await h.fake.listActiveRequests()).some((r) => r.id === live.id)).toBe(false);
    expect(h.repos.routeState.get().warnings).not.toContain('buyer_exit_connections_unconfirmed');
  });

  test('temp_rule with rule match failing: the unconfirmed rollback says the block rule was read back from the temp-rule list and effective rule order, not that Surge may still have the earlier entry loaded', async () => {
    const { opB } = await switchingToB('temp_rule');
    ruleMatchGone();
    await cancel(opB);
    const op = h.repos.operations.get(opB)!;
    expect(op).toMatchObject({ phase: 'BLOCKED_NEEDS_ATTENTION', status: 'needs_attention' });
    const messages = [op.error!.message, ...h.repos.operations.listSteps(opB).map((st) => st.message)];
    expect(messages.some((m) => m.includes('Surge 可能仍加载着写入之前的入口'))).toBe(false);
    expect(op.error?.message).toContain('临时规则已按 Surge 的临时规则列表与有效规则顺序读回，但 Surge 实际如何匹配 Safari 请求未经 rule match 求值确认');
    expect(h.repos.routeState.get()).toMatchObject({ phase: 'attention', entryMode: 'UNKNOWN', selectedNode: 'REJECT' });
  });

  test.each([2, 3])('temp_rule with rule match failing: the rollback\'s removal #%i fails after steps accepted only from the temp-rule list — the structural block is not reported as a confirmed block; SFE-ROUTE moves to REJECT, the entry is UNKNOWN', async (nth) => {
    const { a, nodeA, opB } = await switchingToB('temp_rule');
    ruleMatchGone();
    // 回到阻断：加入 block（容忍）、移除 verify（容忍）、移除 blockOther……第 nth 次移除超时且没有生效（规则仍在列表中）
    const remove = h.fake.removeTempRule.bind(h.fake);
    let removals = 0;
    h.fake.removeTempRule = async (rule: string) => {
      removals += 1;
      if (removals === nth) throw new Error('rule temp remove timed out');
      return remove(rule);
    };
    await cancel(opB);
    expect(removals).toBeGreaterThanOrEqual(nth);
    const op = h.repos.operations.get(opB)!;
    expect(op).toMatchObject({ phase: 'BLOCKED_NEEDS_ATTENTION', status: 'needs_attention' });
    expect(op.error?.message).not.toContain('Safari 保持已确认的阻断');
    expect(op.error?.message).toContain('入口状态未知');
    const route = h.repos.routeState.get();
    expect(route).toMatchObject({ phase: 'attention', entryMode: 'UNKNOWN', selectedNode: 'REJECT', activeEnvironmentId: a });
    expect(route.warnings).toContain('entry_unverified');
    expect(route.activationSnapshot?.previousSelectedNode).toBe(nodeA);
    expect(await h.fake.getGroupSelection(ROUTE_GROUP_NAME)).toBe('REJECT');
  });

  test('temp_rule: after an unconfirmed-rollback hold, re-activating A with rule match still failing does not restore A\'s node on the structural block — it holds REJECT again and keeps the snapshot', async () => {
    const { a, nodeA, opB } = await switchingToB('temp_rule');
    ruleMatchGone();
    await cancel(opB);
    expect(h.repos.routeState.get()).toMatchObject({ phase: 'attention', entryMode: 'UNKNOWN', selectedNode: 'REJECT', activeEnvironmentId: a });
    // 网页仍允许「使用此环境」（readiness 仍是 active）：激活第 6 步阻断的最终读回读不到 rule match
    const opRe = await startSwitch(a);
    const op = h.repos.operations.get(opRe)!;
    expect(op).toMatchObject({ phase: 'BLOCKED_NEEDS_ATTENTION', status: 'needs_attention' });
    const steps = h.repos.operations.listSteps(opRe).map((st) => st.message);
    expect(steps.some((m) => m.startsWith('已回滚') || m.includes('Safari 保持阻断') || m.includes('Safari 保持已确认的阻断'))).toBe(false);
    const route = h.repos.routeState.get();
    expect(route).toMatchObject({ phase: 'attention', entryMode: 'UNKNOWN', selectedNode: 'REJECT', activeEnvironmentId: a });
    expect(route.warnings).toContain('entry_unverified');
    expect(route.warnings).not.toContain('rollback_needs_reverify');
    expect(route.activationSnapshot?.previousSelectedNode).toBe(nodeA);
    expect(await h.fake.getGroupSelection(ROUTE_GROUP_NAME)).toBe('REJECT');
  });

  test('cancelling or timing out records the request, not a promised outcome: no step claims the original node is restored when the rollback ends on REJECT', async () => {
    const { opB } = await switchingToB();
    ruleMatchGone();
    h.fake.localWatchLatencyMs = 60_000;
    await cancel(opB);
    const op = h.repos.operations.get(opB)!;
    expect(op.phase).toBe('BLOCKED_NEEDS_ATTENTION');
    const messages = h.repos.operations.listSteps(opB).map((st) => st.message);
    expect(messages.some((m) => m.includes('恢复原节点并保持阻断') || m.includes('恢复切换前节点并保持阻断'))).toBe(false);
    expect(messages).toContain('已取消切换；开始回滚：尝试回到阻断并恢复切换前的节点（回到阻断无法确认时不恢复，SFE-ROUTE 改选 REJECT，并要求处理）');
    expect((op.result as { failure: { message: string } }).failure.message).toBe('已取消切换');
  });
});

describe('entry settings (strategy, process paths, verify endpoint) never change under an open route operation (§5.2 normal mode always available)', () => {
  type Strategy = 'temp_rule' | 'ruleset_resource';

  async function proposeStrategy(strategy: Strategy): Promise<string> {
    const r = await h.app.proposeCapability(
      {
        request_id: rid('prop'),
        key: 'runtime_entry_modes',
        proposed_status: 'supported',
        context: instanceContext(h.fake),
        summary: 'P0 实测入口策略（合成）',
        evidence_digest: 'sha256:0123456789abcdef',
        entry_strategy: strategy,
      },
      AGENT,
    );
    return r.proposal_id;
  }

  /** 激活第 2 步受控检查读 SFE-ROUTE 成员时（入口仍记为普通模式，尚未写入阻断）执行一次 during。 */
  function duringPreWriteRead(during: () => Promise<void>): { fired: () => boolean } {
    const fake = h.fake as unknown as { getGroupMembers: (group: string) => Promise<string[]> };
    const orig = fake.getGroupMembers.bind(h.fake);
    let fired = false;
    fake.getGroupMembers = async (group) => {
      if (!fired) {
        fired = true;
        expect(h.repos.routeState.get().entryMode).toBe('NORMAL');
        await during();
      }
      return orig(group);
    };
    return { fired: () => fired };
  }

  for (const [from, to] of [['temp_rule', 'ruleset_resource'], ['ruleset_resource', 'temp_rule']] as Array<[Strategy, Strategy]>) {
    test(`${from} → ${to} confirmed during an activation's pre-write reads is refused (ROUTE_BUSY); cancel and normal mode then undo the entry the activation wrote, and the change is accepted once the route is idle NORMAL`, async () => {
      h = await createHarness({ entryStrategy: from });
      const env = (await createEnv(h, 'US-Buyer-A', '203.0.113.10')).environment_id!;
      await bind(h, PROFILE_A, env);
      const proposalId = await proposeStrategy(to);
      let refusal: { code?: string } | null = null;
      const hook = duringPreWriteRead(async () => {
        refusal = await h.app.confirmCapability({ request_id: rid('conf'), action: 'confirm', proposal_id: proposalId }, WEB).then(
          () => null,
          (e: { code?: string }) => e,
        );
      });
      const opId = await startSwitch(env);
      expect(hook.fired()).toBe(true);
      expect(refusal).not.toBeNull();
      expect(refusal!.code).toBe('ROUTE_BUSY');
      expect(h.repos.settings.get('entryStrategy')).toBe(from);
      expect(h.repos.operations.get(opId)!.phase).toBe('VERIFY_ONLY');
      // 取消：按写入它的策略回到阻断并恢复（没有切换前的路由），Safari 全部拒绝
      await h.app.cancelOperation(opId, { request_id: rid('cancel') }, WEB);
      await h.idle();
      expect(h.repos.operations.get(opId)!.phase).toBe('FAILED');
      expect(h.repos.routeState.get()).toMatchObject({ entryMode: 'BLOCKED', phase: 'failed' });
      // 普通模式撤销本应用入口：Safari 回到原规则（合成配置的 FINAL），检测主机不再经 SFE-ROUTE
      const n = await h.app.enterNormal({ request_id: rid('normal') }, WEB);
      await h.idle();
      expect(h.repos.operations.get(n.operation_id)!.phase).toBe('NORMAL_RESTORED');
      expect(h.repos.routeState.get()).toMatchObject({ entryMode: 'NORMAL', phase: 'idle' });
      expect(h.fake.tempRules).toEqual([]);
      for (const host of ['www.example.test', FAKE_VERIFY_HOST]) {
        const o = safariOutcome(h, host);
        expect(o.failed).toBe(false);
        expect(o.policyName).not.toBe('SFE-ROUTE');
      }
      // 路由空闲的普通模式、没有未结束的路由操作：同一条提议可以确认
      await h.app.confirmCapability({ request_id: rid('conf'), action: 'confirm', proposal_id: proposalId }, WEB);
      expect(h.repos.settings.get('entryStrategy')).toBe(to);
    });
  }

  test('a verify-endpoint change during an activation\'s pre-write reads is refused (ROUTE_BUSY)', async () => {
    h = await createHarness({ entryStrategy: 'temp_rule' });
    (h.app.engine.deps as { verifyEndpoints: unknown }).verifyEndpoints = [TEST_ENDPOINT, { id: 'alt', url: 'https://verify2.example.test/', host: 'verify2.example.test', label: 'b' }];
    const env = (await createEnv(h, 'US-Buyer-A', '203.0.113.10')).environment_id!;
    await bind(h, PROFILE_A, env);
    let refusal: { code?: string } | null = null;
    duringPreWriteRead(async () => {
      refusal = await h.app.updateSettings({ request_id: rid('set'), verifyEndpointId: 'alt' }, WEB).then(
        () => null,
        (e: { code?: string }) => e,
      );
    });
    const opId = await startSwitch(env);
    expect(refusal!.code).toBe('ROUTE_BUSY');
    expect(h.repos.settings.get('verifyEndpointId')).toBe('ipify');
    expect(h.repos.operations.get(opId)!.phase).toBe('VERIFY_ONLY');
  });

  test('a process-path or strategy change refused while a normal mode is queued or the route is not idle NORMAL', async () => {
    h = await createHarness({ entryStrategy: 'temp_rule' });
    const proposalId = await proposeStrategy('ruleset_resource');
    const { envId } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    await expect(h.app.confirmCapability({ request_id: rid('conf'), action: 'confirm', proposal_id: proposalId }, WEB)).rejects.toMatchObject({ code: 'ENVIRONMENT_ACTIVE' });
    // 普通模式已受理、尚未执行（入口仍是 ACTIVE）：拒绝
    await h.app.enterNormal({ request_id: rid('normal'), old_session_policy: 'closed_confirmed', confirmed_environment_id: envId }, WEB);
    await expect(h.app.confirmCapability({ request_id: rid('conf'), action: 'confirm', proposal_id: proposalId }, WEB)).rejects.toMatchObject({ code: 'ROUTE_BUSY' });
    await h.idle();
    await h.app.confirmCapability({ request_id: rid('conf'), action: 'confirm', proposal_id: proposalId }, WEB);
    expect(h.repos.settings.get('entryStrategy')).toBe('ruleset_resource');
  });

  test('defence in depth: entry settings changed outside acceptance during the pre-write reads → the activation stops before its first write (route untouched, no app rule in Surge)', async () => {
    h = await createHarness({ entryStrategy: 'temp_rule' });
    const env = (await createEnv(h, 'US-Buyer-A', '203.0.113.10')).environment_id!;
    await bind(h, PROFILE_A, env);
    const epoch = h.repos.routeState.get().routeEpoch;
    duringPreWriteRead(async () => {
      h.repos.settings.set('entryStrategy', 'ruleset_resource');
    });
    const opId = await startSwitch(env);
    const op = h.repos.operations.get(opId)!;
    expect(op).toMatchObject({ phase: 'FAILED', status: 'failed' });
    expect(op.error?.code).toBe('CAPABILITY_UNVERIFIED');
    expect(op.error?.message).toContain('路由未改变');
    expect(h.repos.routeState.get()).toMatchObject({ entryMode: 'NORMAL', phase: 'idle', routeEpoch: epoch, activationSnapshot: null });
    expect(h.fake.tempRules).toEqual([]);
    expect(safariOutcome(h).failed).toBe(false);
  });
});
