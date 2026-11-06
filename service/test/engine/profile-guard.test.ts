// SFE-ROUTE 选择的配置身份守卫（engine/route-guard.ts、engine/pending-hold.ts；docs/ARCHITECTURE.md §6.3 第 8、13、14 步、§6.5、§6.6
// 「配置身份」「推迟的改选」、§6.7）：Surge 中每个配置有自己的同名组与选择，本应用只在确认是固定工作配置时改选或认定 SFE-ROUTE
// 的选择（写入之前核对、读回之后再核对）；不能确认时不改动其他配置中的同名组，如实写明没有改选、按未确认的保持记下，回到固定
// 工作配置之后由对账核对中断之前的改选或排入一次改选。进入普通模式从不因此被拒绝，只跳过 SFE-ROUTE 的改选。
// 假 Surge 按配置分开保存选择并记下每次改选时加载的配置（selectionWrites）。只用合成数据（文档地址、example.test）。

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { ROUTE_GROUP_NAME, SfeError, type ActivateRequest } from '@sfe/contract';
import type { OperationRecord } from '../../src/db/index.js';
import { payloadOf } from '../../src/domain/operations.js';
import { runForgedHold, runNormal, settleAbandonedTransition } from '../../src/engine/handlers/route.js';
import { maybeEnqueueForgedHold } from '../../src/engine/node-resource.js';
import { PENDING_HOLD_KEY, type PendingHold } from '../../src/engine/pending-hold.js';
import { routeGuard } from '../../src/engine/route-guard.js';
import type { EntryController, SurgeAdapter, SurgeProfileInfo } from '../../src/ports.js';
import { ADMIN, PROFILE_A, PROFILE_B, PROFILE_C, WEB, activeEnv, bind, createEnv, createHarness, rid, verify, type Harness } from './harness.js';
import { dropNodesOnNextUpdate, until } from './publish-helpers.js';

const G = ROUTE_GROUP_NAME;
let h: Harness;
afterEach(async () => {
  await h?.close();
});

// ---------- 夹具 ----------

const other = (): SurgeProfileInfo => ({ name: 'Other', path: `${h.surgeDir}/Other.conf` });
let working: SurgeProfileInfo;
function rememberWorking(): void {
  working = { ...h.fake.currentProfile };
}
/** 切到另一个配置（第一次访问时复制固定工作配置此刻的选择）；sel 给出时设它的同名 SFE-ROUTE。 */
function toOther(sel?: string): void {
  h.fake.currentProfile = other();
  if (sel !== undefined) h.fake.setSelectionFor(other(), G, sel);
}
function toWorking(): void {
  h.fake.currentProfile = { ...working };
}
/** 在固定工作配置之外发生的改选（不允许有）。 */
const writesOffWorking = () => h.fake.selectionWrites.filter((w) => !w.home);
const op = (id: string): OperationRecord => h.repos.operations.get(id)!;
const steps = (id: string): string => h.repos.operations.listSteps(id).map((s) => s.message).join('\n');
const lastStep = (id: string): string => h.repos.operations.listSteps(id).at(-1)!.message;
const nodeOf = (envId: string, revision = 1): string => h.repos.proxyRevisions.get(envId, revision)!.nodeName;
const pending = (): PendingHold | null => h.app.engine.kv.get<PendingHold>(PENDING_HOLD_KEY);
const holds = (): OperationRecord[] => h.repos.operations.listRecent(500).filter((o) => o.kind === 'route.hold').reverse();
const arrivalTimeout = async (): Promise<void> => {
  await h.clock.advanceAsync((h.repos.settings.get('profileArrivalTimeoutSec') + 1) * 1000);
  await h.idle();
};

/** A 使用中，B 已部署、已关联（未激活）。 */
async function twoEnvs(): Promise<{ a: string; b: string }> {
  const { envId: a } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
  const created = await createEnv(h, 'US-Buyer-B', '203.0.113.11');
  await bind(h, PROFILE_B, created.environment_id!);
  rememberWorking();
  clearWrites();
  return { a, b: created.environment_id! };
}

/** 夹具准备（激活等）中的改选不计入：只看之后的改选。 */
function clearWrites(): void {
  h.fake.selectionWrites.splice(0);
}

async function startSwitch(env: string, extra: Partial<ActivateRequest> = {}): Promise<string> {
  const route = h.repos.routeState.get();
  const req: ActivateRequest = { request_id: rid('act'), old_session_policy: 'closed_confirmed', confirmed_environment_id: route.activeEnvironmentId, ...extra };
  const a = await h.app.activate(env, req, WEB);
  await h.idle();
  return a.operation_id;
}

/** 读当前配置在 when() 成立时失败 times 次（模拟 surge-cli 一次读取失败）；其余调用照常。 */
function failProfileReads(when: () => boolean, times: number): { hits: () => number } {
  const orig = h.fake.getCurrentProfile.bind(h.fake);
  let left = times;
  let hits = 0;
  h.fake.getCurrentProfile = async () => {
    if (left > 0 && when()) {
      left -= 1;
      hits += 1;
      throw new SfeError('SURGE_COMMAND_FAILED', '读取当前配置失败：模拟失败');
    }
    return orig();
  };
  return { hits: () => hits };
}
const during = (opId: () => string | null) => (): boolean => opId() !== null && h.app.executor.currentOperationId === opId();

type TransitionHook = (mode: string) => 'throw' | 'unconfirmed' | null;
/** 包一层入口控制器：hook 返回 throw 时切换抛出，unconfirmed 时读回改为未经运行时求值确认。 */
function wrapEntry(hook: TransitionHook): void {
  const engine = h.app.engine;
  const orig = engine.entryController.bind(engine);
  engine.entryController = ((owner: Parameters<typeof orig>[0]) => {
    const c = orig(owner);
    if (!c) return c;
    return new Proxy(c, {
      get(t, prop) {
        if (prop === 'transition') {
          return async (...args: Parameters<EntryController['transition']>) => {
            const what = hook(args[0]);
            if (what === 'throw') throw new SfeError('UNKNOWN_STATE', '模拟：入口切换失败');
            const rb = await t.transition(...args);
            return what === 'unconfirmed' ? { ...rb, runtimeConfirmed: false } : rb;
          };
        }
        const v = Reflect.get(t, prop, t) as unknown;
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    });
  }) as typeof engine.entryController;
}

/** 插入一条崩溃之前已记下改选意图的执行中激活（结束点按它重新结束）。 */
function insertInterruptedActivation(id: string, externalSelectionBefore = false): OperationRecord {
  const o = h.repos.operations.insert({
    id,
    requestId: rid(id),
    requestDigest: 'synthetic',
    kind: 'route.activate',
    initiatorKind: 'web',
    status: 'running',
    phase: 'VALIDATING',
    payload: {
      endHold: {
        externalSelectionBefore,
        ending: { phase: 'FAILED', status: 'failed', error: { code: 'PREFLIGHT_FAILED', message: '代理预检失败（合成），路由未改变' }, step: '代理预检失败（合成），路由未改变', cancelOutbox: true },
      },
    },
  });
  // 执行中的操作在服务重启时由崩溃恢复领取（它的执行器条目）
  h.repos.outbox.enqueue(o.id, null, h.clock.now());
  return o;
}

// ---------- G1–G21 ----------

describe('route end points never write another profile\'s same-named SFE-ROUTE', () => {
  test('G1: activation refused with EXTERNAL_PROFILE writes nothing on the other profile and keeps 「路由未改变」', async () => {
    h = await createHarness();
    const { a, b } = await twoEnvs();
    toOther(nodeOf(b));
    const opId = await startSwitch(a);
    expect(writesOffWorking()).toEqual([]);
    expect(op(opId)).toMatchObject({ status: 'failed', error: { code: 'EXTERNAL_PROFILE' } });
    expect(op(opId).error!.message).toContain('路由未改变');
    expect(op(opId).result?.rejectSelected).toBeUndefined();
    const route = h.repos.routeState.get();
    expect(route.selectedNode).toBe(nodeOf(a));
    expect(route.warnings).toContain('external_profile_change');
    expect(route.warnings).not.toContain('external_selection_change');
  });

  test('G2: forged marker on another profile: the end hold is not written and recorded unconfirmed; back on the working profile a hold selects REJECT there', async () => {
    h = await createHarness();
    const { a, b } = await twoEnvs();
    h.app.engine.kv.set('resource:forgedNodes', { since: h.clock.now().toISOString(), reasons: ['unexplained_fetch'] });
    toOther(nodeOf(b));
    const opId = await startSwitch(b, { confirmed_environment_id: a });
    expect(writesOffWorking()).toEqual([]);
    expect(op(opId)).toMatchObject({ status: 'needs_attention', phase: 'BLOCKED_NEEDS_ATTENTION' });
    expect(op(opId).result).toMatchObject({ rejectSelected: false, rejectCause: 'node_resource_forged', rejectGuard: { reason: 'external_profile', stage: 'not_attempted' } });
    expect(op(opId).error!.message).toContain('Surge 当前配置不是固定工作配置');
    expect(op(opId).error!.message).toContain('没有改选 REJECT');
    expect(op(opId).error!.message).toContain('立即进入普通模式（不必先切回固定工作配置）');
    expect(h.repos.routeState.get().selectedNode).toBe(nodeOf(a));
    expect(pending()).toMatchObject({ kind: 'skipped', operationId: opId, block: 'external_profile' });
    toWorking();
    await h.app.runPeriodicReconcile();
    await h.idle();
    expect(holds().some((o) => o.status === 'succeeded')).toBe(true);
    expect(h.fake.selectionWrites.filter((w) => w.policy === 'REJECT').every((w) => w.home)).toBe(true);
    expect(h.fake.selectionWrites.some((w) => w.policy === 'REJECT' && w.home)).toBe(true);
    expect(h.fake.selectionFor('home', G)).toBe('REJECT');
    expect(writesOffWorking()).toEqual([]);
  });

  test('G3: a recovered end hold with an intent is not credited from another profile; back on the working profile (selection not REJECT) a hold selects REJECT there', async () => {
    h = await createHarness();
    const { a, b } = await twoEnvs();
    // 用户之前在 Surge 中把 SFE-ROUTE 改选到 B 的节点（对账记下外部修改），结束点因此要改选 REJECT 而服务在改选之前崩溃
    h.fake.setSelectionFor('home', G, nodeOf(b));
    h.repos.routeState.update({ warnings: [...h.repos.routeState.get().warnings, 'external_selection_change'], phase: 'external_change' });
    await h.app.stop();
    const pendingOp = insertInterruptedActivation('op_g3', true);
    toOther('REJECT');
    await h.crash();
    await h.idle();
    expect(h.fake.selectionWrites).toEqual([]);
    const o = op(pendingOp.id);
    expect(o).toMatchObject({ status: 'needs_attention' });
    expect(o.result).toMatchObject({ rejectSelected: false, rejectGuard: { stage: 'interrupted', reason: 'external_profile' } });
    expect(lastStep(pendingOp.id)).toContain('无法确认中断之前是否已在固定工作配置上改选 REJECT');
    expect(lastStep(pendingOp.id)).not.toContain('已改选 REJECT（读回确认）');
    expect(h.repos.routeState.get().selectedNode).toBe(nodeOf(a));
    expect(pending()).toMatchObject({ kind: 'intent', operationId: pendingOp.id });
    toWorking();
    await h.app.runPeriodicReconcile();
    await h.idle();
    expect(steps(pendingOp.id)).toContain('中断之前本操作的改选没有生效');
    expect(h.fake.selectionFor('home', G)).toBe('REJECT');
    expect(h.repos.routeState.get().selectedNode).toBe('REJECT');
    expect(writesOffWorking()).toEqual([]);
    expect(pending()).toBeNull();
  });

  test('G4: a recovered end hold with an intent: the working profile\'s REJECT is credited by the first reconcile on the working profile', async () => {
    h = await createHarness();
    const { a } = await twoEnvs();
    await h.app.stop();
    const pendingOp = insertInterruptedActivation('op_g4');
    // 崩溃之前的改选已在固定工作配置上生效；另一个配置的同名组选着 A 的节点
    h.fake.setSelectionFor('home', G, 'REJECT');
    toOther(nodeOf(a));
    await h.crash();
    await h.idle();
    expect(op(pendingOp.id).result).toMatchObject({ rejectSelected: false, rejectGuard: { stage: 'interrupted' } });
    expect(h.repos.routeState.get().warnings).not.toContain('external_selection_change');
    expect(h.repos.routeState.get().selectedNode).toBe(nodeOf(a));
    toWorking();
    await h.app.runPeriodicReconcile();
    await h.idle();
    const route = h.repos.routeState.get();
    expect(route.selectedNode).toBe('REJECT');
    expect(route.warnings).not.toContain('external_selection_change');
    expect(steps(pendingOp.id)).toContain('读回 SFE-ROUTE 为 REJECT，与中断之前本操作记下的改选意图一致：按本应用的改选记下，不当作外部修改');
    expect(pending()).toBeNull();
    const before = h.repos.routeState.get().warnings;
    await h.app.runPeriodicReconcile();
    expect(h.repos.routeState.get().warnings).toEqual(before);
    expect(h.fake.selectionWrites).toEqual([]);
  });

  test('G5: profile unknown at an end point (liveness listPolicies, 3 identity failures): a verified route is not degraded; a drifted selection escalates to attention without writing', async () => {
    h = await createHarness({ livenessPrimitive: 'listPolicies' });
    const { a, b } = await twoEnvs();
    // (a) 选择仍是已验证的出口
    const p1 = (await h.app.probe(a, { request_id: rid(), kind: 'safari' }, WEB)).operation_id;
    await h.idle();
    const f1 = failProfileReads(during(() => p1), 3);
    await arrivalTimeout();
    expect(f1.hits()).toBe(3);
    expect(op(p1)).toMatchObject({ status: 'failed', phase: 'FAILED' });
    expect(op(p1).result?.rejectGuard).toBeUndefined();
    expect(h.fake.selectionWrites).toEqual([]);
    // (b) 选择在等待期间被改到 B 的节点
    const p2 = (await h.app.probe(a, { request_id: rid(), kind: 'safari' }, WEB)).operation_id;
    await h.idle();
    h.fake.setSelectionFor('home', G, nodeOf(b));
    const f2 = failProfileReads(during(() => p2), 3);
    await arrivalTimeout();
    expect(f2.hits()).toBe(3);
    expect(op(p2)).toMatchObject({ status: 'needs_attention', phase: 'BLOCKED_NEEDS_ATTENTION' });
    expect(op(p2).result).toMatchObject({ rejectSelected: false, rejectGuard: { reason: 'profile_unknown', stage: 'not_attempted' } });
    expect(h.fake.selectionWrites).toEqual([]);
    const route = h.repos.routeState.get();
    expect(route.phase).toBe('attention');
    expect(route.warnings).toContain('entry_unverified');
  });

  test('G6: VERIFY_ONLY timeout on another profile: the rollback neither restores nor writes, keeps the snapshot and needs attention; back on the working profile a hold selects REJECT', async () => {
    h = await createHarness();
    const { a, b } = await twoEnvs();
    const opId = await startSwitch(b);
    expect(op(opId).phase).toBe('VERIFY_ONLY');
    toOther();
    await h.app.runPeriodicReconcile();
    expect(h.repos.routeState.get().warnings).toContain('external_profile_change');
    await arrivalTimeout();
    expect(writesOffWorking()).toEqual([]);
    const o = op(opId);
    expect(o).toMatchObject({ status: 'needs_attention', phase: 'BLOCKED_NEEDS_ATTENTION' });
    expect(o.result?.rollback).toBeUndefined();
    expect(o.result).toMatchObject({ rejectSelected: false, rejectGuard: { reason: 'external_profile', stage: 'not_attempted' } });
    expect(lastStep(opId)).toContain('没有恢复切换前的节点');
    expect(lastStep(opId)).toContain('立即进入普通模式（不必先切回固定工作配置）');
    const route = h.repos.routeState.get();
    expect(route).toMatchObject({ phase: 'attention', entryMode: 'UNKNOWN', selectedNode: nodeOf(b) });
    expect(route.warnings).toEqual(expect.arrayContaining(['entry_unverified', 'external_profile_change']));
    expect(route.activationSnapshot).not.toBeNull();
    toWorking();
    expect(h.fake.selectionFor('home', G)).toBe(nodeOf(b));
    await h.app.runPeriodicReconcile();
    await h.idle();
    expect(h.fake.selectionFor('home', G)).toBe('REJECT');
    expect(writesOffWorking()).toEqual([]);
    expect(nodeOf(a)).not.toBe(nodeOf(b));
  });

  test('G7a: the rollback catch on another profile (entry transition fails) does not write REJECT', async () => {
    h = await createHarness();
    const { b } = await twoEnvs();
    const opId = await startSwitch(b);
    toOther();
    wrapEntry((mode) => (mode === 'BLOCKED' ? 'throw' : null));
    await arrivalTimeout();
    expect(h.fake.selectionWrites.filter((w) => w.policy === 'REJECT')).toEqual([]);
    expect(op(opId).error!.details).toMatchObject({ rejectSelected: false, rejectGuard: { reason: 'external_profile', stage: 'not_attempted' } });
    expect(op(opId).error!.message).toContain('没有改选 REJECT');
  });

  test('G7b: holdUnconfirmedRollback on another profile (rollback BLOCKED unconfirmed) does not write REJECT', async () => {
    h = await createHarness();
    const { b } = await twoEnvs();
    const opId = await startSwitch(b);
    toOther();
    wrapEntry((mode) => (mode === 'BLOCKED' ? 'unconfirmed' : null));
    await arrivalTimeout();
    expect(h.fake.selectionWrites.filter((w) => w.policy === 'REJECT')).toEqual([]);
    expect(op(opId).error!.details).toMatchObject({ rejectSelected: false, rejectGuard: { reason: 'external_profile' } });
    expect(op(opId).error!.message).toContain('也没有改选 SFE-ROUTE（Surge 当前配置不是固定工作配置，不改动其他配置中的同名组）');
  });
});

describe('normal mode on another profile: entry undo and kills run, SFE-ROUTE is untouched', () => {
  test('G8a: success with an unconfirmed tightening: NORMAL_RESTORED, kills, no write, rejectGuard, normal-mode remedy', async () => {
    h = await createHarness();
    const { a } = await twoEnvs();
    toOther();
    wrapEntry((mode) => (mode === 'BLOCKED' ? 'unconfirmed' : null));
    const n = await h.app.enterNormal({ request_id: rid('normal'), old_session_policy: 'closed_confirmed', confirmed_environment_id: a }, WEB);
    await h.idle();
    const o = op(n.operation_id);
    expect(o.phase).toBe('NORMAL_RESTORED');
    expect(h.repos.routeState.get().entryMode).toBe('NORMAL');
    expect(Array.isArray(o.result?.killResults)).toBe(true);
    expect(h.fake.selectionWrites).toEqual([]);
    expect(o.result).toMatchObject({ rejectSelected: false, rejectGuard: { reason: 'external_profile', stage: 'not_attempted' } });
    expect(lastStep(n.operation_id)).toContain('再次进入普通模式（可在当前配置上进行）');
  });

  test('G8b: failure with a loosened entry: kills, no write, attention, rejectGuard, no 「读回就是使用中环境已验证的出口」', async () => {
    h = await createHarness();
    const { b } = await twoEnvs();
    await startSwitch(b);
    clearWrites();
    toOther();
    wrapEntry((mode) => (mode === 'BLOCKED' ? 'unconfirmed' : mode === 'NORMAL' ? 'throw' : null));
    const n = await h.app.enterNormal({ request_id: rid('normal'), old_session_policy: 'closed_confirmed', confirmed_environment_id: h.repos.routeState.get().activeEnvironmentId }, WEB);
    await h.idle();
    const o = op(n.operation_id);
    expect(o.status).toBe('failed');
    expect(Array.isArray(o.result?.killResults)).toBe(true);
    expect(h.fake.selectionWrites).toEqual([]);
    expect(h.repos.routeState.get().phase).toBe('attention');
    expect(o.result).toMatchObject({ rejectSelected: false, rejectGuard: { reason: 'external_profile' } });
    expect(lastStep(n.operation_id)).not.toContain('读回就是使用中环境已验证的出口');
  });

  test('G9: settleAbandonedTransition on another profile does not write', async () => {
    h = await createHarness();
    const { b } = await twoEnvs();
    const opId = await startSwitch(b);
    const before = h.repos.routeState.get().selectedNode;
    toOther();
    await settleAbandonedTransition(h.app.engine, opId, new Error('合成异常'));
    expect(h.fake.selectionWrites.filter((w) => w.policy === 'REJECT')).toEqual([]);
    expect(op(opId).error!.details).toMatchObject({ rejectSelected: false, rejectGuard: { reason: 'external_profile', stage: 'not_attempted' } });
    const route = h.repos.routeState.get();
    expect(route).toMatchObject({ phase: 'attention', entryMode: 'UNKNOWN', selectedNode: before });
    expect(route.warnings).toContain('entry_unverified');
  });

  test('G10: delete on another profile is refused before reading or writing SFE-ROUTE', async () => {
    h = await createHarness();
    const { envId: c } = await activeEnv(h, 'US-Buyer-C', '203.0.113.12', PROFILE_C);
    rememberWorking();
    clearWrites();
    const n = await h.app.enterNormal({ request_id: rid('normal'), old_session_policy: 'closed_confirmed', confirmed_environment_id: c }, WEB);
    await h.idle();
    expect(op(n.operation_id).phase).toBe('NORMAL_RESTORED');
    expect(h.fake.selectionFor('home', G)).toBe(nodeOf(c));
    clearWrites();
    toOther();
    const reads = h.fake.calls.getGroupSelection ?? 0;
    const env = h.repos.environments.get(c)!;
    const d = await h.app.deleteEnvironment(c, { request_id: rid(), expected_revision: env.revision }, WEB);
    await h.idle();
    expect(op(d.operation_id)).toMatchObject({ status: 'failed', error: { code: 'EXTERNAL_PROFILE' } });
    expect(op(d.operation_id).error!.message).toContain('删除失败：Surge 当前配置不是固定工作配置，无法核对 SFE-ROUTE 的选择，环境未删除');
    expect(h.repos.environments.get(c)!.deletedAt).toBeNull();
    expect(h.fake.calls.getGroupSelection ?? 0).toBe(reads);
    expect(h.fake.selectionWrites).toEqual([]);
    expect(h.repos.routeState.get().selectedNode).toBe(nodeOf(c));
  });
});

describe('publish rollback on another profile', () => {
  test('G11a: fallback evidence, but the rollback runs on another profile: no reselect, the text says SFE-ROUTE may have fallen back on the working profile', async () => {
    h = await createHarness();
    const { envId: a } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    rememberWorking();
    clearWrites();
    const selected = nodeOf(a);
    const orig = h.fake.updateExternalResource.bind(h.fake);
    let n = 0;
    h.fake.updateExternalResource = async (key: string) => {
      const r = await orig(key);
      n += 1;
      // 回滚的单 key 更新之后 Surge 已切到另一个配置（在 hook 中切换 currentProfile，不改写 getCurrentProfile）
      if (n === 2) toOther();
      return r;
    };
    // 包在上面之外：它在第一次更新之后恢复成上面的包装
    dropNodesOnNextUpdate(h, [selected]);
    const b = await createEnv(h, 'US-Buyer-B', '203.0.113.11');
    await h.idle();
    expect(n).toBeGreaterThanOrEqual(2);
    expect(h.fake.selectionWrites).toEqual([]);
    const o = op(b.operation_id);
    expect(o.status).toBe('needs_attention');
    expect(o.error!.message).toContain('不能确认回滚结果属于固定工作配置');
    expect(o.error!.message).toContain('固定工作配置中的 SFE-ROUTE 可能已回落到 REJECT，回滚没有改回原选择');
  });

  test('G11b: the candidate was never loaded and the rollback check runs on another profile: not confirmed, no 「原选择未变」 or 「被外部修改」', async () => {
    h = await createHarness();
    await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    rememberWorking();
    clearWrites();
    const orig = h.fake.updateExternalResource.bind(h.fake);
    h.fake.updateExternalResource = async () => {
      h.fake.updateExternalResource = orig;
      toOther();
      throw new SfeError('SURGE_COMMAND_FAILED', '更新资源失败：模拟失败');
    };
    const b = await createEnv(h, 'US-Buyer-B', '203.0.113.11');
    await h.idle();
    const o = op(b.operation_id);
    expect(o.status).toBe('needs_attention');
    expect(o.error!.message).toContain('回滚读到的 SFE-ROUTE 选择不作认定，也没有改动它');
    expect(o.error!.message).not.toContain('没有读取');
    expect(steps(b.operation_id)).not.toContain('原选择未变');
    expect(steps(b.operation_id)).not.toContain('被外部修改');
    expect(h.fake.selectionWrites).toEqual([]);
  });

  test('G11c: the held rollback reads committed members from another profile: the forged marker and warnings are not cleared', async () => {
    h = await createHarness();
    await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    rememberWorking();
    clearWrites();
    h.app.engine.kv.set('resource:forgedNodes', { since: h.clock.now().toISOString(), reasons: ['node_detail_mismatch'] });
    await h.app.runPeriodicReconcile();
    await h.idle();
    expect(h.repos.routeState.get().warnings).toContain('node_resource_forged');
    const orig = h.fake.updateExternalResource.bind(h.fake);
    h.fake.updateExternalResource = async (key: string) => {
      const r = await orig(key);
      if (h.fake.currentProfile.name !== 'Other') toOther();
      return r;
    };
    const b = await createEnv(h, 'US-Buyer-B', '203.0.113.11');
    await h.idle();
    expect(op(b.operation_id).status).not.toBe('succeeded');
    expect(h.app.engine.kv.get('resource:forgedNodes')).not.toBeNull();
    expect(h.repos.routeState.get().warnings).toEqual(expect.arrayContaining(['node_resource_forged', 'node_resource_unverified']));
    expect(writesOffWorking()).toEqual([]);
  });

  test('PG-T3: the rollback restored the original selection on the working profile, then the profile switched before the r2 post-check: the text says it was restored (read back), not 「没有读取或改动」', async () => {
    h = await createHarness();
    const { envId: a } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    rememberWorking();
    clearWrites();
    const selected = nodeOf(a);
    const sgp = h.fake.selectGroupPolicy.bind(h.fake);
    let reselectDone = false;
    h.fake.selectGroupPolicy = async (g: string, policy: string) => {
      await sgp(g, policy);
      if (policy === selected) reselectDone = true;
    };
    // 改回之后的第 1 次读当前配置是改选写入的核对；第 2 次（r1、r2 之后的核对）之前 Surge 已切到另一个配置
    const gcp = h.fake.getCurrentProfile.bind(h.fake);
    let after = 0;
    h.fake.getCurrentProfile = async () => {
      if (reselectDone) {
        after += 1;
        if (after === 2) toOther();
      }
      return gcp();
    };
    dropNodesOnNextUpdate(h, [selected]);
    const b = await createEnv(h, 'US-Buyer-B', '203.0.113.11');
    await h.idle();
    expect(reselectDone).toBe(true);
    expect(h.fake.selectionWrites).toEqual([{ profile: expect.any(String), group: G, policy: selected, home: true }]);
    const o = op(b.operation_id);
    expect(o.status).toBe('needs_attention');
    expect(o.error!.message).toContain('不能确认回滚结果属于固定工作配置');
    expect(o.error!.message).toContain('SFE-ROUTE 已在固定工作配置上改回原选择（读回确认');
    expect(o.error!.message).not.toContain('回滚没有读取或改动');
    expect(o.error!.message).not.toContain('也没有改动它');
  });
});

describe('reconcile compares the selection only on the working profile', () => {
  test('G12a: another profile selecting another node raises external_profile_change, not external_selection_change', async () => {
    h = await createHarness();
    const { b } = await twoEnvs();
    toOther(nodeOf(b));
    await h.app.runPeriodicReconcile();
    const w = h.repos.routeState.get().warnings;
    expect(w).toContain('external_profile_change');
    expect(w).not.toContain('external_selection_change');
    toWorking();
    h.fake.setSelectionFor('home', G, nodeOf(b));
    await h.app.runPeriodicReconcile();
    expect(h.repos.routeState.get().warnings).toContain('external_selection_change');
  });

  test('G12b: an unknown profile (identity read failed) does not raise external_selection_change; the next reconcile on the working profile does', async () => {
    h = await createHarness({ livenessPrimitive: 'listPolicies' });
    const { b } = await twoEnvs();
    h.fake.setSelectionFor('home', G, nodeOf(b));
    // 对账读事实（readBasicFacts）不重试：一次读取失败即无法确认当前配置
    h.fake.failNext('getCurrentProfile');
    await h.app.runPeriodicReconcile();
    expect(h.repos.routeState.get().warnings).not.toContain('external_selection_change');
    await h.app.runPeriodicReconcile();
    expect(h.repos.routeState.get().warnings).toContain('external_selection_change');
  });
});

describe('profile changes inside one operation (pre-check and post-check)', () => {
  test('G13: the profile switches between activation step 2 and step 8: the target is not selected on the other profile', async () => {
    h = await createHarness();
    const { a, b } = await twoEnvs();
    let opId: string | null = null;
    const orig = h.fake.listActiveRequests.bind(h.fake);
    let switched = false;
    h.fake.listActiveRequests = async (...args: Parameters<typeof orig>) => {
      if (!switched && opId !== null && h.app.executor.currentOperationId === opId) {
        switched = true;
        toOther();
      }
      return orig(...args);
    };
    const req: ActivateRequest = { request_id: rid('act'), old_session_policy: 'closed_confirmed', confirmed_environment_id: a };
    opId = (await h.app.activate(b, req, WEB)).operation_id;
    await h.idle();
    expect(switched).toBe(true);
    expect(h.fake.selectionWrites).toEqual([]);
    expect(op(opId)).toMatchObject({ status: 'needs_attention', phase: 'BLOCKED_NEEDS_ATTENTION' });
    expect(op(opId).result).toMatchObject({ rejectSelected: false, rejectGuard: { reason: 'external_profile', stage: 'not_attempted' } });
    expect(steps(opId)).toContain('切换失败：Surge 当前配置不是固定工作配置，没有选择目标节点');
    expect(h.repos.routeState.get().selectedNode).toBe(nodeOf(a));
    expect(h.fake.selectionFor('home', G)).toBe(nodeOf(a));
  });

  test('G14: the profile switches during the REJECT write: the hold is not credited (profile_changed); the working profile\'s REJECT is credited later', async () => {
    h = await createHarness();
    const { a, b } = await twoEnvs();
    const p = (await h.app.probe(a, { request_id: rid(), kind: 'safari' }, WEB)).operation_id;
    await h.idle();
    h.fake.setSelectionFor('home', G, nodeOf(b));
    h.fake.setSelectionFor(other(), G, 'REJECT');
    const orig = h.fake.selectGroupPolicy.bind(h.fake);
    h.fake.selectGroupPolicy = async (g: string, policy: string) => {
      await orig(g, policy);
      if (policy === 'REJECT') toOther();
    };
    await arrivalTimeout();
    h.fake.selectGroupPolicy = orig;
    expect(op(p).result).toMatchObject({ rejectSelected: false, rejectGuard: { stage: 'profile_changed' } });
    expect(lastStep(p)).toContain('不能确认改选落在固定工作配置上');
    expect(h.repos.routeState.get().selectedNode).not.toBe('REJECT');
    expect(pending()).toMatchObject({ kind: 'intent', operationId: p });
    // 写入实际落在固定工作配置上：回到固定工作配置之后的对账按本应用的改选记下
    expect(h.fake.selectionFor('home', G)).toBe('REJECT');
    toWorking();
    await h.app.runPeriodicReconcile();
    expect(h.repos.routeState.get().selectedNode).toBe('REJECT');
    expect(steps(p)).toContain('按本应用的改选记下，不当作外部修改');
    expect(pending()).toBeNull();
  });

  test('G15: a verification submitted while on another profile does not commit ACTIVE; the rollback is guarded', async () => {
    h = await createHarness();
    const { b } = await twoEnvs();
    const opId = await startSwitch(b);
    toOther();
    await verify(h, PROFILE_B, opId);
    const o = op(opId);
    expect(o.phase).not.toBe('ACTIVE_VERIFIED');
    expect(o).toMatchObject({ status: 'needs_attention', phase: 'BLOCKED_NEEDS_ATTENTION' });
    expect(steps(opId)).toContain('切换失败：Surge 当前配置不是固定工作配置，未进入使用中模式');
    expect(writesOffWorking()).toEqual([]);
  });

  test('G17: a retest refuses to start while the profile is unknown, and a retest pass is not credited while on another profile', async () => {
    h = await createHarness({ livenessPrimitive: 'listPolicies' });
    const { a } = await twoEnvs();
    let p1: string | null = null;
    failProfileReads(during(() => p1), 10);
    p1 = (await h.app.probe(a, { request_id: rid(), kind: 'safari' }, WEB)).operation_id;
    await h.idle();
    expect(op(p1)).toMatchObject({ status: 'failed', error: { code: 'EXTERNAL_PROFILE' } });
    expect(op(p1).error!.message).toContain('重新检测失败：无法确认 Surge 当前配置是否是固定工作配置');
    p1 = null;
    const p2 = (await h.app.probe(a, { request_id: rid(), kind: 'safari' }, WEB)).operation_id;
    await h.idle();
    expect(op(p2).status).toBe('waiting');
    toOther();
    await verify(h, PROFILE_A, p2);
    expect(op(p2).status).not.toBe('succeeded');
    expect(op(p2).error!.message).toContain('不能确认实测经过固定工作配置');
    expect(writesOffWorking()).toEqual([]);
  });
});

describe('deferred REJECT, identity retry and crash recovery', () => {
  test('G18: normal mode fails with a loosened entry under CLI liveness: one identity read failure is retried and REJECT is written; three failures skip it and the first working reconcile enqueues the hold', async () => {
    h = await createHarness({ livenessPrimitive: 'listExternalResources' });
    const { b } = await twoEnvs();
    await startSwitch(b);
    wrapEntry((mode) => (mode === 'BLOCKED' ? 'throw' : null));
    let n1: string | null = null;
    const f1 = failProfileReads(during(() => n1), 1);
    n1 = (await h.app.enterNormal({ request_id: rid('normal'), old_session_policy: 'closed_confirmed', confirmed_environment_id: h.repos.routeState.get().activeEnvironmentId }, WEB)).operation_id;
    await h.idle();
    expect(f1.hits()).toBe(1);
    expect(op(n1).result).toMatchObject({ rejectSelected: true });
    expect(op(n1).result?.rejectGuard).toBeUndefined();
    expect(h.fake.selectionFor('home', G)).toBe('REJECT');
  });

  test('G18b: three identity failures skip the REJECT (truthful, attention); the first reconcile that confirms the working profile enqueues a hold that selects REJECT', async () => {
    h = await createHarness({ livenessPrimitive: 'listExternalResources' });
    const { b } = await twoEnvs();
    await startSwitch(b);
    clearWrites();
    wrapEntry((mode) => (mode === 'BLOCKED' ? 'throw' : null));
    let n1: string | null = null;
    const f = failProfileReads(during(() => n1), 3);
    n1 = (await h.app.enterNormal({ request_id: rid('normal'), old_session_policy: 'closed_confirmed', confirmed_environment_id: h.repos.routeState.get().activeEnvironmentId }, WEB)).operation_id;
    await h.idle();
    expect(f.hits()).toBe(3);
    expect(op(n1).result).toMatchObject({ rejectSelected: false, rejectGuard: { reason: 'profile_unknown', stage: 'not_attempted' } });
    expect(h.fake.selectionWrites).toEqual([]);
    expect(h.repos.routeState.get().phase).toBe('attention');
    expect(pending()).toMatchObject({ kind: 'skipped', operationId: n1 });
    await h.app.runPeriodicReconcile();
    await h.idle();
    expect(h.fake.selectionFor('home', G)).toBe('REJECT');
    expect(h.repos.routeState.get().selectedNode).toBe('REJECT');
    expect(steps(n1)).toContain('服务排入的改选已在固定工作配置上把 SFE-ROUTE 改选 REJECT（读回确认）');
    expect(pending()).toBeNull();
  });

  test('G19: end hold intent recorded, crash before the select, restart on another profile whose SFE-ROUTE is REJECT: not credited; back on the working profile the hold selects REJECT there', async () => {
    let gate: ((name: string, args: unknown[]) => 'hang' | 'fail' | null) | null = null;
    const gated = (fake: object): SurgeAdapter =>
      new Proxy(fake, {
        get(target, prop) {
          const v = Reflect.get(target, prop, target) as unknown;
          if (typeof v !== 'function') return v;
          const fn = v as (...args: unknown[]) => unknown;
          return (...args: unknown[]) => {
            const g = gate?.(String(prop), args) ?? null;
            if (g === 'hang') return new Promise(() => undefined);
            if (g === 'fail') return Promise.reject(new Error('模拟：超时'));
            return fn.apply(target, args);
          };
        },
      }) as unknown as SurgeAdapter;
    h = await createHarness({ dbFile: true, surge: (fake) => gated(fake) });
    const { a, b } = await twoEnvs();
    h.fake.setSelectionFor('home', G, nodeOf(b));
    let opId = '';
    let selecting = false;
    gate = (name, args) => {
      if (opId === '' || h.app.executor.currentOperationId !== opId) return null;
      if (name === 'getGroupMembers') return 'fail';
      if (!selecting && name === 'selectGroupPolicy' && args[1] === 'REJECT') {
        selecting = true;
        return 'hang';
      }
      return null;
    };
    opId = (await h.app.activate(a, { request_id: rid('act') }, WEB)).operation_id;
    await until(() => selecting);
    expect(payloadOf(op(opId)).endHold).toBeDefined();
    gate = null;
    toOther('REJECT');
    const writes = h.fake.selectionWrites.length;
    await h.crash();
    await h.idle();
    expect(h.fake.selectionWrites.length).toBe(writes);
    expect(op(opId).result).toMatchObject({ rejectSelected: false, rejectGuard: { stage: 'interrupted' } });
    expect(h.repos.routeState.get().selectedNode).not.toBe('REJECT');
    toWorking();
    await h.app.runPeriodicReconcile();
    await h.idle();
    expect(h.fake.selectionFor('home', G)).toBe('REJECT');
    expect(writesOffWorking()).toEqual([]);
  });

  test('G20: two identity read failures then success: today\'s outcome (REJECT written and credited)', async () => {
    h = await createHarness({ livenessPrimitive: 'listPolicies' });
    const { a, b } = await twoEnvs();
    const p = (await h.app.probe(a, { request_id: rid(), kind: 'safari' }, WEB)).operation_id;
    await h.idle();
    h.fake.setSelectionFor('home', G, nodeOf(b));
    const f = failProfileReads(during(() => p), 2);
    await arrivalTimeout();
    expect(f.hits()).toBe(2);
    expect(op(p).result).toMatchObject({ rejectSelected: true });
    expect(op(p).result?.rejectGuard).toBeUndefined();
    expect(h.repos.routeState.get().selectedNode).toBe('REJECT');
    expect(h.fake.selectionFor('home', G)).toBe('REJECT');
  });

  test('G21a: crash recovery with an intent whose selection cannot be read, no queued normal: REJECT is written and credited as the op\'s own', async () => {
    h = await createHarness();
    const { b } = await twoEnvs();
    h.fake.setSelectionFor('home', G, nodeOf(b));
    await h.app.stop();
    const pendingOp = insertInterruptedActivation('op_g21a');
    // 启动对账读选择失败（没有记下外部修改），恢复中的结束点再失败一次：记录仍表明选着已验证的出口
    const orig = h.fake.getGroupSelection.bind(h.fake);
    let failed = 0;
    let inOp = 0;
    h.fake.getGroupSelection = async (g: string) => {
      if (failed < 2) {
        failed += 1;
        if (h.app.executor.currentOperationId === pendingOp.id) inOp += 1;
        throw new SfeError('SURGE_COMMAND_FAILED', '读取策略组失败：模拟失败');
      }
      return orig(g);
    };
    await h.crash();
    await h.idle();
    expect(failed).toBe(2);
    expect(inOp).toBe(1);
    expect(h.repos.routeState.get().warnings).not.toContain('external_selection_change');
    const o = op(pendingOp.id);
    expect(o).toMatchObject({ status: 'needs_attention' });
    expect(o.result).toMatchObject({ rejectSelected: true });
    expect(lastStep(pendingOp.id)).not.toContain('路由未改变');
    expect(h.fake.selectionFor('home', G)).toBe('REJECT');
  });

  test('G21b: crash recovery with an intent whose selection cannot be read and a queued normal: interrupted (读取 SFE-ROUTE 失败), not 「路由未改变」', async () => {
    h = await createHarness();
    const { a } = await twoEnvs();
    await h.app.stop();
    const pendingOp = insertInterruptedActivation('op_g21b');
    const normal = h.repos.operations.insert({
      id: 'op_g21b_normal',
      requestId: rid('normal'),
      requestDigest: 'synthetic',
      kind: 'route.normal',
      initiatorKind: 'web',
      status: 'queued',
      phase: 'SAVED',
      payload: { normal: { oldSessionPolicy: 'closed_confirmed', expectedActiveEnvironmentId: a, hadManagedEnvironment: true } },
    });
    h.repos.outbox.enqueue(normal.id, null, h.clock.now());
    const orig = h.fake.getGroupSelection.bind(h.fake);
    h.fake.getGroupSelection = async (g: string) => {
      if (h.app.executor.currentOperationId === pendingOp.id) throw new SfeError('SURGE_COMMAND_FAILED', '读取策略组失败：模拟失败');
      return orig(g);
    };
    const writes = h.fake.selectionWrites.length;
    await h.crash();
    await h.idle();
    const o = op(pendingOp.id);
    expect(o.result).toMatchObject({ rejectSelected: false, rejectGuard: { reason: 'selection_unreadable', stage: 'interrupted' } });
    expect(steps(pendingOp.id)).toContain('无法确认中断之前是否已在固定工作配置上改选 REJECT（读取 SFE-ROUTE 失败');
    expect(lastStep(pendingOp.id)).not.toContain('路由未改变');
    expect(h.fake.selectionWrites.length).toBe(writes);
  });

  test('G22: a stale pending record (a later route operation rewrote the route) appends a step to the original operation', async () => {
    h = await createHarness({ livenessPrimitive: 'listPolicies' });
    const { a, b } = await twoEnvs();
    const p = (await h.app.probe(a, { request_id: rid(), kind: 'safari' }, WEB)).operation_id;
    await h.idle();
    h.fake.setSelectionFor('home', G, nodeOf(b));
    failProfileReads(during(() => p), 3);
    await arrivalTimeout();
    expect(pending()).toMatchObject({ kind: 'skipped', operationId: p });
    // 之后的普通模式改写了路由（读到另一个配置时也只跳过 SFE-ROUTE 的改选）
    toOther();
    const n = await h.app.enterNormal({ request_id: rid('normal'), old_session_policy: 'closed_confirmed', confirmed_environment_id: a }, WEB);
    await h.idle();
    expect(op(n.operation_id).phase).toBe('NORMAL_RESTORED');
    toWorking();
    await h.app.runPeriodicReconcile();
    expect(steps(p)).toContain('之后的路由操作已改写路由，不再按本操作排入改选');
    expect(pending()).toBeNull();
  });

  test('G23: no credit while a transition owns the route (VERIFY_ONLY wait); the record is kept', async () => {
    h = await createHarness();
    const { b } = await twoEnvs();
    const opId = await startSwitch(b);
    const route = h.repos.routeState.get();
    expect(route.phase).toBe('awaiting_safari_verify');
    const rec: PendingHold = {
      kind: 'intent',
      operationId: 'op_synthetic_hold',
      intent: { externalSelectionBefore: false, cause: 'node_resource_forged' },
      cause: 'node_resource_forged',
      block: 'external_profile',
      routeEpoch: route.routeEpoch,
      routeOperationId: route.operationId,
      selectedNode: route.selectedNode,
      recordedAt: h.clock.now().toISOString(),
    };
    h.app.engine.kv.set(PENDING_HOLD_KEY, rec);
    h.fake.setSelectionFor('home', G, 'REJECT');
    await h.app.runPeriodicReconcile();
    expect(h.repos.routeState.get().selectedNode).toBe(nodeOf(b));
    expect(pending()).toMatchObject({ operationId: 'op_synthetic_hold' });
    expect(op(opId).status).toBe('waiting');
  });
});

describe('profile unknown variants (CLI liveness, three identity read failures): no write, the reason is 无法确认', () => {
  const opts = { livenessPrimitive: 'listExternalResources' as const };

  test('#6 settleAbandonedTransition', async () => {
    h = await createHarness(opts);
    const { b } = await twoEnvs();
    const opId = await startSwitch(b);
    clearWrites();
    failProfileReads(() => true, 3);
    await settleAbandonedTransition(h.app.engine, opId, new Error('合成异常'));
    expect(h.fake.selectionWrites).toEqual([]);
    expect(op(opId).error!.details).toMatchObject({ rejectSelected: false, rejectGuard: { reason: 'profile_unknown', stage: 'not_attempted' } });
  });

  test('#9 rollback (VERIFY_ONLY timeout)', async () => {
    h = await createHarness(opts);
    const { b } = await twoEnvs();
    const opId = await startSwitch(b);
    clearWrites();
    failProfileReads(during(() => opId), 3);
    await arrivalTimeout();
    expect(h.fake.selectionWrites).toEqual([]);
    expect(op(opId).result).toMatchObject({ rejectSelected: false, rejectGuard: { reason: 'profile_unknown', stage: 'not_attempted' } });
    expect(lastStep(opId)).toContain('回滚未完成：无法确认 Surge 当前配置是否是固定工作配置');
  });

  test('#10 holdUnconfirmedRollback', async () => {
    h = await createHarness(opts);
    const { b } = await twoEnvs();
    const opId = await startSwitch(b);
    clearWrites();
    wrapEntry((mode) => (mode === 'BLOCKED' ? 'unconfirmed' : null));
    failProfileReads(during(() => opId), 3);
    await arrivalTimeout();
    expect(h.fake.selectionWrites).toEqual([]);
    expect(op(opId).error!.details).toMatchObject({ rejectSelected: false, rejectGuard: { reason: 'profile_unknown' } });
  });

  test('#12 normal mode success with an unconfirmed tightening', async () => {
    h = await createHarness(opts);
    const { a } = await twoEnvs();
    wrapEntry((mode) => (mode === 'BLOCKED' ? 'unconfirmed' : null));
    let n: string | null = null;
    failProfileReads(during(() => n), 3);
    n = (await h.app.enterNormal({ request_id: rid('normal'), old_session_policy: 'closed_confirmed', confirmed_environment_id: a }, WEB)).operation_id;
    await h.idle();
    expect(op(n).phase).toBe('NORMAL_RESTORED');
    expect(h.fake.selectionWrites).toEqual([]);
    expect(op(n).result).toMatchObject({ rejectSelected: false, rejectGuard: { reason: 'profile_unknown', stage: 'not_attempted' } });
  });

  test('#21 delete', async () => {
    h = await createHarness(opts);
    const { envId: c } = await activeEnv(h, 'US-Buyer-C', '203.0.113.12', PROFILE_C);
    rememberWorking();
    const n = await h.app.enterNormal({ request_id: rid('normal'), old_session_policy: 'closed_confirmed', confirmed_environment_id: c }, WEB);
    await h.idle();
    clearWrites();
    let d: string | null = null;
    failProfileReads(during(() => d), 3);
    d = (await h.app.deleteEnvironment(c, { request_id: rid(), expected_revision: h.repos.environments.get(c)!.revision }, WEB)).operation_id;
    await h.idle();
    expect(op(n.operation_id).phase).toBe('NORMAL_RESTORED');
    expect(op(d)).toMatchObject({ status: 'failed', error: { code: 'EXTERNAL_PROFILE' } });
    expect(op(d).error!.message).toContain('删除失败：无法确认 Surge 当前配置是否是固定工作配置');
    expect(h.repos.environments.get(c)!.deletedAt).toBeNull();
    expect(h.fake.selectionWrites).toEqual([]);
  });
});

describe('guard details', () => {
  test('G24: the profile switches during the step-8 target write: not recorded as the selection; back on the working profile the matching selection is reported as the app\'s own unconfirmed write, and a hold selects REJECT', async () => {
    h = await createHarness();
    const { a, b } = await twoEnvs();
    h.fake.setSelectionFor(other(), G, nodeOf(b));
    const orig = h.fake.selectGroupPolicy.bind(h.fake);
    h.fake.selectGroupPolicy = async (g: string, policy: string) => {
      await orig(g, policy);
      if (policy === nodeOf(b)) toOther();
    };
    const opId = await startSwitch(b);
    h.fake.selectGroupPolicy = orig;
    expect(op(opId)).toMatchObject({ status: 'needs_attention', phase: 'BLOCKED_NEEDS_ATTENTION' });
    expect(steps(opId)).toContain('切换失败：选择目标节点期间Surge 当前配置不是固定工作配置，不能确认选择落在固定工作配置上');
    expect(h.repos.routeState.get().selectedNode).toBe(nodeOf(a));
    expect(h.app.engine.kv.get('route:unconfirmedWrite')).toMatchObject({ policy: nodeOf(b), operationId: opId });
    expect(h.fake.selectionFor('home', G)).toBe(nodeOf(b));
    toWorking();
    await h.app.runPeriodicReconcile();
    await h.idle();
    const notes = h.repos.operations
      .listRecent(50)
      .filter((o) => o.kind === 'maintenance.reconcile')
      .map((o) => steps(o.id))
      .join('\n');
    expect(notes).toContain(`与本应用之前未经确认的写入（${nodeOf(b)}）一致，不是外部修改`);
    expect(h.app.engine.kv.get('route:unconfirmedWrite')).toBeNull();
    expect(h.fake.selectionFor('home', G)).toBe('REJECT');
    expect(writesOffWorking()).toEqual([]);
  });


  test('a failed tryReuse post-check refuses before the first write (no block, no kills)', async () => {
    h = await createHarness();
    const { a } = await twoEnvs();
    let opId: string | null = null;
    const orig = h.fake.getGroupSelection.bind(h.fake);
    let reads = 0;
    h.fake.getGroupSelection = async (g: string) => {
      if (opId !== null && h.app.executor.currentOperationId === opId) {
        reads += 1;
        // 第 1 次是复用之前对账的读取，第 2 次是复用自己的读取：之后 Surge 已切到另一个配置
        if (reads === 2) {
          const v = await orig(g);
          toOther();
          return v;
        }
      }
      return orig(g);
    };
    const kills = h.fake.calls.listActiveRequests ?? 0;
    opId = (await h.app.activate(a, { request_id: rid('act') }, WEB)).operation_id;
    await h.idle();
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(op(opId)).toMatchObject({ status: 'failed', error: { code: 'EXTERNAL_PROFILE' } });
    expect(op(opId).error!.message).toContain('激活失败：Surge 当前配置不是固定工作配置，路由未改变');
    expect(steps(opId)).not.toContain('已阻断 Safari 新请求');
    expect(h.fake.calls.listActiveRequests ?? 0).toBe(kills);
    expect(h.fake.selectionWrites).toEqual([]);
  });

  test('routeGuard does not swallow an engine restart: the next reconcile still sees the uptime drop', async () => {
    h = await createHarness();
    await twoEnvs();
    await h.clock.advanceAsync(60_000);
    await h.idle();
    await h.app.runPeriodicReconcile();
    expect(h.repos.routeState.get().warnings).not.toContain('surge_restarted');
    // 只重启引擎：进程启动时间不变，运行时长变小（getRuntimeInfo）
    const orig = h.fake.getRuntimeInfo.bind(h.fake);
    h.fake.getRuntimeInfo = async () => ({ ...(await orig()), uptimeSeconds: 4 });
    // 结束点的守卫先于下一次对账运行：它只核对配置身份，不覆盖对账用作比较基线的运行时长
    expect((await routeGuard(h.app.engine)).allowed).toBe(true);
    await h.app.runPeriodicReconcile();
    expect(h.repos.routeState.get().warnings).toContain('surge_restarted');
  });

  test('G16: only route-guard.ts selects SFE-ROUTE, and raw selection reads stay in the allowlist', () => {
    const root = fileURLToPath(new URL('../../src/engine', import.meta.url));
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (name.endsWith('.ts')) files.push(p);
      }
    };
    walk(root);
    const count = (text: string, needle: string): number => text.split(needle).length - 1;
    const selects: Record<string, number> = {};
    const reads: Record<string, number> = {};
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      const rel = f.slice(root.length + 1);
      if (count(text, 'selectGroupPolicy(') > 0) selects[rel] = count(text, 'selectGroupPolicy(');
      if (count(text, 'getGroupSelection(') > 0) reads[rel] = count(text, 'getGroupSelection(');
    }
    expect(selects).toEqual({ 'route-guard.ts': 1 });
    // 允许的原始读取：route-guard.ts（守卫读取与不认定的读取）、对账 readExtraFacts、发布读回 observe、核对门槛 currentSelection
    expect(reads).toEqual({ 'route-guard.ts': 3, 'reconcile.ts': 1, 'handlers/publish.ts': 1, 'handlers/route.ts': 1 });
    // 核对门槛的包装 currentSelection 同样是不经守卫的原始读取（T11）：只允许在这些函数中调用（以后要认定的读取改用 readRouteSelection；
    // 新的调用点会让这里失败）。在整个 src 中按文件与所在函数统计
    const srcRoot = fileURLToPath(new URL('../../src', import.meta.url));
    const srcFiles: string[] = [];
    const walkSrc = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walkSrc(p);
        else if (name.endsWith('.ts')) srcFiles.push(p);
      }
    };
    walkSrc(srcRoot);
    const wrapperCalls: string[] = [];
    for (const f of srcFiles) {
      const text = readFileSync(f, 'utf8');
      const rel = f.slice(srcRoot.length + 1);
      for (const m of text.matchAll(/\bcurrentSelection\b/g)) {
        const before = text.slice(0, m.index);
        const line = before.slice(before.lastIndexOf('\n') + 1) + text.slice(m.index, text.indexOf('\n', m.index));
        if (/^\s*(\/\/|\*)/.test(line)) continue; // 注释
        if (/export async function currentSelection\(/.test(line)) continue; // 定义
        if (/^\s*import\b/.test(line) || /^\s*[\w\s,{}]*currentSelection[\w\s,]*[},]/.test(line) && !line.includes('(')) {
          wrapperCalls.push(`${rel}:import`);
          continue;
        }
        const fns = [...before.matchAll(/(?:async\s+)?function\s+(\w+)\s*\(/g)];
        wrapperCalls.push(`${rel}:${fns.at(-1)?.[1] ?? '?'}`);
      }
    }
    expect(wrapperCalls.sort()).toEqual(
      ['engine/verification.ts:import', 'engine/verification.ts:beginVerification', 'engine/handlers/route.ts:tryReuse', 'engine/handlers/route.ts:startProbeWaiting', 'engine/handlers/route.ts:completeVerification'].sort(),
    );
  });
});

// ---------- 评审后续：推迟改选的归属与服务排入的改选 ----------

/** 服务排入的推迟改选（route.hold，endHoldDeferred）改选 REJECT：写入生效之后挂住（服务在记下之前崩溃）。 */
function hangDeferredReject(): { hung: () => boolean; restore: () => void } {
  const orig = h.fake.selectGroupPolicy.bind(h.fake);
  let hung = false;
  h.fake.selectGroupPolicy = async (g: string, policy: string) => {
    const cur = h.app.executor.currentOperationId;
    const o = cur ? h.repos.operations.get(cur) : null;
    if (!hung && policy === 'REJECT' && o?.kind === 'route.hold' && payloadOf(o).endHoldDeferred) {
      hung = true;
      await orig(g, policy);
      return new Promise<void>(() => undefined);
    }
    return orig(g, policy);
  };
  return { hung: () => hung, restore: () => (h.fake.selectGroupPolicy = orig) };
}

const reconcileOps = (): OperationRecord[] => h.repos.operations.listRecent(500).filter((o) => o.kind === 'maintenance.reconcile');
const deferredHolds = (): OperationRecord[] => holds().filter((o) => payloadOf(o).endHoldDeferred !== undefined);

/**
 * 普通模式（入口已放宽）失败而三次读不到当前配置：REJECT 被跳过（route:pendingHold kind skipped）；之后第一次确认是固定工作配置的
 * 对账排入服务的改选，它改选 REJECT 之后服务在记下之前崩溃（还没有 crash：由调用方决定崩溃之前的情况）。
 */
async function deferredHoldAppliedThenStuck(): Promise<{ n1: string; holdOp: string }> {
  h = await createHarness({ livenessPrimitive: 'listExternalResources' });
  const { b } = await twoEnvs();
  await startSwitch(b);
  wrapEntry((mode) => (mode === 'BLOCKED' ? 'throw' : null));
  let n1: string | null = null;
  failProfileReads(during(() => n1), 3);
  n1 = (await h.app.enterNormal({ request_id: rid('normal'), old_session_policy: 'closed_confirmed', confirmed_environment_id: h.repos.routeState.get().activeEnvironmentId }, WEB)).operation_id;
  await h.idle();
  expect(pending()).toMatchObject({ kind: 'skipped', operationId: n1 });
  clearWrites();
  const hang = hangDeferredReject();
  await h.app.runPeriodicReconcile();
  await until(hang.hung);
  hang.restore();
  const holdOp = deferredHolds().at(-1)!.id;
  expect(payloadOf(op(holdOp)).endHold).toBeDefined();
  expect(h.fake.selectionFor('home', G)).toBe('REJECT');
  return { n1, holdOp };
}

describe('review follow-ups: pending-hold attribution and the service-enqueued hold', () => {
  test('PG-T1: an interrupted intent found not applied is resolved (skipped); the service-enqueued hold\'s REJECT after a crash is not credited to the interrupted select', async () => {
    h = await createHarness();
    const { b } = await twoEnvs();
    h.fake.setSelectionFor('home', G, nodeOf(b));
    h.repos.routeState.update({ warnings: [...h.repos.routeState.get().warnings, 'external_selection_change'], phase: 'external_change' });
    await h.app.stop();
    const x = insertInterruptedActivation('op_pgt1', true);
    toOther('REJECT');
    await h.crash();
    await h.idle();
    expect(pending()).toMatchObject({ kind: 'intent', operationId: x.id, stage: 'interrupted' });
    toWorking();
    const hang = hangDeferredReject();
    await h.app.runPeriodicReconcile();
    await until(hang.hung);
    hang.restore();
    // 第一次确认是固定工作配置的对账读到 B 的节点：意图已解决为没有生效
    expect(pending()).toMatchObject({ kind: 'skipped', operationId: x.id });
    expect(pending()?.intent).toBeUndefined();
    expect(steps(x.id)).toContain('中断之前本操作的改选没有生效');
    const writes = h.fake.selectionWrites.length;
    await h.crash();
    await h.idle();
    expect(steps(x.id)).not.toContain('与中断之前本操作记下的改选意图一致');
    expect(reconcileOps().filter((o) => o.payload?.credited !== undefined)).toEqual([]);
    expect(steps(x.id)).toContain('服务排入的改选已在固定工作配置上把 SFE-ROUTE 改选 REJECT（读回确认）');
    expect(h.fake.selectionWrites.length).toBe(writes);
    expect(h.repos.routeState.get().selectedNode).toBe('REJECT');
    expect(h.fake.selectionFor('home', G)).toBe('REJECT');
    expect(pending()).toBeNull();
  });

  test('PG-T1 (variant): the service-enqueued hold ends unavailable; a later REJECT chosen by the user is not credited to the interrupted intent', async () => {
    h = await createHarness();
    const { a, b } = await twoEnvs();
    h.fake.setSelectionFor('home', G, nodeOf(b));
    h.repos.routeState.update({ warnings: [...h.repos.routeState.get().warnings, 'external_selection_change'], phase: 'external_change' });
    await h.app.stop();
    const x = insertInterruptedActivation('op_pgt1b', true);
    toOther('REJECT');
    await h.crash();
    await h.idle();
    toWorking();
    // 服务排入的改选开始执行时 Surge 已切到另一个配置：没有改选，记录保留
    let flipped = false;
    const gcp = h.fake.getCurrentProfile.bind(h.fake);
    h.fake.getCurrentProfile = async () => {
      const cur = h.app.executor.currentOperationId;
      if (!flipped && cur && h.repos.operations.get(cur)?.kind === 'route.hold') {
        flipped = true;
        toOther();
      }
      return gcp();
    };
    await h.app.runPeriodicReconcile();
    await h.idle();
    expect(flipped).toBe(true);
    expect(deferredHolds().at(-1)).toMatchObject({ status: 'failed' });
    expect(pending()).toMatchObject({ kind: 'skipped', operationId: x.id });
    h.fake.getCurrentProfile = gcp;
    toWorking();
    // 用户之后在 Surge 中自己选了 REJECT
    h.fake.setSelectionFor('home', G, 'REJECT');
    await h.app.runPeriodicReconcile();
    await h.idle();
    expect(steps(x.id)).not.toContain('与中断之前本操作记下的改选意图一致');
    expect(reconcileOps().filter((o) => o.payload?.credited !== undefined)).toEqual([]);
    expect(h.repos.routeState.get().selectedNode).toBe(nodeOf(a));
    expect(pending()).toBeNull();
  });

  test('PG-T7 / T6(b): a crash after the service-enqueued hold applied REJECT: the startup reconcile leaves the skipped record to that hold, whose recovery credits its own REJECT without re-selecting', async () => {
    const { n1, holdOp } = await deferredHoldAppliedThenStuck();
    const writes = h.fake.selectionWrites.length;
    await h.crash();
    await h.idle();
    expect(steps(n1)).not.toContain('不是本操作改选的');
    expect(steps(n1)).toContain('服务排入的改选已在固定工作配置上把 SFE-ROUTE 改选 REJECT（读回确认）');
    expect(op(holdOp)).toMatchObject({ status: 'succeeded', result: { rejectSelected: true } });
    expect(h.fake.selectionWrites.length).toBe(writes);
    const route = h.repos.routeState.get();
    expect(route.selectedNode).toBe('REJECT');
    expect(route.warnings).not.toContain('external_selection_change');
    expect(pending()).toBeNull();
  });

  test('PG-T2(a): the crashed service-enqueued hold\'s first recovery read fails and the second reads REJECT: its own REJECT is credited, not 「已是 REJECT，不需要改选」', async () => {
    const { holdOp } = await deferredHoldAppliedThenStuck();
    const orig = h.fake.getGroupSelection.bind(h.fake);
    let failed = 0;
    h.fake.getGroupSelection = async (g: string) => {
      if (failed < 1 && h.app.executor.currentOperationId === holdOp) {
        failed += 1;
        throw new SfeError('SURGE_COMMAND_FAILED', '读取策略组失败：模拟失败');
      }
      return orig(g);
    };
    await h.crash();
    await h.idle();
    expect(failed).toBe(1);
    expect(op(holdOp)).toMatchObject({ status: 'succeeded', result: { rejectSelected: true } });
    expect(steps(holdOp)).not.toContain('SFE-ROUTE 已是 REJECT，不需要改选');
    const route = h.repos.routeState.get();
    expect(route.selectedNode).toBe('REJECT');
    expect(route.warnings).not.toContain('external_selection_change');
  });

  test('PG-T2(b): the crashed service-enqueued hold cannot read SFE-ROUTE and a normal mode is queued: SUPERSEDED says REJECT may have been selected before the interruption, not 「没有改选」', async () => {
    const { n1, holdOp } = await deferredHoldAppliedThenStuck();
    const normal = h.repos.operations.insert({
      id: 'op_pgt2b_normal',
      requestId: rid('normal'),
      requestDigest: 'synthetic',
      kind: 'route.normal',
      initiatorKind: 'web',
      status: 'queued',
      phase: 'SAVED',
      payload: { normal: { oldSessionPolicy: 'closed_confirmed', expectedActiveEnvironmentId: h.repos.routeState.get().activeEnvironmentId, hadManagedEnvironment: true } },
    });
    h.repos.outbox.enqueue(normal.id, null, h.clock.now());
    const orig = h.fake.getGroupSelection.bind(h.fake);
    h.fake.getGroupSelection = async (g: string) => {
      if (h.app.executor.currentOperationId === holdOp) throw new SfeError('SURGE_COMMAND_FAILED', '读取策略组失败：模拟失败');
      return orig(g);
    };
    await h.crash();
    await h.idle();
    expect(op(holdOp).status).toBe('superseded');
    expect(lastStep(holdOp)).not.toContain('没有改选 SFE-ROUTE');
    expect(lastStep(holdOp)).toContain('服务中断之前可能已在固定工作配置上改选 REJECT');
    expect(steps(n1)).not.toContain('服务排入的改选让给了之后进入普通模式的请求（没有改选）');
    expect(steps(n1)).toContain('服务排入的改选让给了之后进入普通模式的请求（服务中断之前可能已改选 REJECT');
  });

  test('PG-T6: a forged-cause pending record whose marker was cleared before the service-enqueued hold runs: no forged warnings or rejectCause, entry_unverified instead', async () => {
    h = await createHarness();
    const { b } = await twoEnvs();
    h.fake.setSelectionFor('home', G, nodeOf(b));
    await h.app.runPeriodicReconcile();
    expect(h.repos.routeState.get().warnings).toContain('external_selection_change');
    const route = h.repos.routeState.get();
    const rec: PendingHold = {
      kind: 'skipped',
      operationId: 'op_synthetic_src',
      cause: 'node_resource_forged',
      block: 'external_profile',
      routeEpoch: route.routeEpoch,
      routeOperationId: route.operationId,
      selectedNode: route.selectedNode,
      recordedAt: h.clock.now().toISOString(),
    };
    h.app.engine.kv.set(PENDING_HOLD_KEY, rec);
    // 伪造标记已由经确认的读回清除（没有 resource:forgedNodes）
    expect(h.app.engine.kv.get('resource:forgedNodes')).toBeNull();
    await h.app.runPeriodicReconcile();
    await h.idle();
    const hold = deferredHolds().at(-1)!;
    expect(hold).toMatchObject({ status: 'succeeded', result: { rejectSelected: true } });
    expect(hold.result?.rejectCause).toBeUndefined();
    const warnings = h.repos.routeState.get().warnings;
    expect(warnings).not.toContain('node_resource_forged');
    expect(warnings).not.toContain('node_resource_unverified');
    expect(warnings).toContain('entry_unverified');
    expect(h.fake.selectionFor('home', G)).toBe('REJECT');
  });

  test('PG-T10: a record from a profile_changed hold (no interruption) is credited, or found not applied, without saying 「中断之前」', async () => {
    h = await createHarness();
    const { a, b } = await twoEnvs();
    const p = (await h.app.probe(a, { request_id: rid(), kind: 'safari' }, WEB)).operation_id;
    await h.idle();
    h.fake.setSelectionFor('home', G, nodeOf(b));
    h.fake.setSelectionFor(other(), G, 'REJECT');
    // 改选期间（写入之前）配置变了：写入落在另一个配置上，固定工作配置仍选着 B 的节点
    const orig = h.fake.selectGroupPolicy.bind(h.fake);
    h.fake.selectGroupPolicy = async (g: string, policy: string) => {
      if (policy === 'REJECT') toOther();
      await orig(g, policy);
    };
    await arrivalTimeout();
    h.fake.selectGroupPolicy = orig;
    expect(op(p).result).toMatchObject({ rejectSelected: false, rejectGuard: { stage: 'profile_changed' } });
    expect(pending()).toMatchObject({ kind: 'intent', operationId: p, stage: 'profile_changed' });
    toWorking();
    const hang = hangDeferredReject();
    await h.app.runPeriodicReconcile();
    hang.restore();
    const added = h.repos.operations.listSteps(p).map((s) => s.message).slice(-2).join('\n');
    expect(added).toContain('本操作改选期间配置变了的那次改选没有落在固定工作配置上');
    expect(added).not.toContain('中断之前');
  });

  test('PG-T11(a): another route.hold is already open: the original operation is not told a hold was enqueued, but that the open hold will select', async () => {
    h = await createHarness({ livenessPrimitive: 'listPolicies' });
    const { a, b } = await twoEnvs();
    const p = (await h.app.probe(a, { request_id: rid(), kind: 'safari' }, WEB)).operation_id;
    await h.idle();
    h.fake.setSelectionFor('home', G, nodeOf(b));
    failProfileReads(during(() => p), 3);
    await arrivalTimeout();
    expect(pending()).toMatchObject({ kind: 'skipped', operationId: p });
    // 一个已排队的 REJECT 保持（没有执行器条目：留在排队中）
    h.repos.operations.insert({
      id: 'op_open_hold',
      requestId: rid('hold'),
      requestDigest: 'service',
      kind: 'route.hold',
      initiatorKind: 'service',
      status: 'queued',
      phase: 'SAVED',
      payload: { forgedHold: { reasons: ['unexplained_fetch'] } },
    });
    await h.app.runPeriodicReconcile();
    await h.app.runPeriodicReconcile();
    expect(deferredHolds()).toEqual([]);
    expect(steps(p)).not.toContain('服务排入一次 SFE-ROUTE 改选 REJECT');
    const noted = h.repos.operations.listSteps(p).filter((s) => s.message.includes('已有排队或执行中的 SFE-ROUTE REJECT 保持，由它改选'));
    expect(noted).toHaveLength(1);
  });

  test('PG-T11(b): the service-enqueued hold ends not_needed: the original operation is told no REJECT was made', async () => {
    h = await createHarness({ livenessPrimitive: 'listPolicies' });
    const { a, b } = await twoEnvs();
    const p = (await h.app.probe(a, { request_id: rid(), kind: 'safari' }, WEB)).operation_id;
    await h.idle();
    h.fake.setSelectionFor('home', G, nodeOf(b));
    failProfileReads(during(() => p), 3);
    await arrivalTimeout();
    expect(pending()).toMatchObject({ kind: 'skipped', operationId: p });
    // 服务排入的改选执行之前，用户已在 Surge 中选了 REJECT
    const orig = h.fake.getGroupSelection.bind(h.fake);
    h.fake.getGroupSelection = async (g: string) => {
      const cur = h.app.executor.currentOperationId;
      if (cur && h.repos.operations.get(cur)?.kind === 'route.hold') h.fake.setSelectionFor('home', G, 'REJECT');
      return orig(g);
    };
    await h.app.runPeriodicReconcile();
    await h.idle();
    expect(deferredHolds().at(-1)).toMatchObject({ status: 'succeeded' });
    expect(steps(p)).toContain('服务排入一次 SFE-ROUTE 改选 REJECT');
    expect(lastStep(p)).toContain('服务排入的改选结束：SFE-ROUTE 已是 REJECT，不需要改选');
  });

  test('T6(a): a pending record, a queued normal and a working reconcile: the service-enqueued hold yields (SUPERSEDED) without selecting', async () => {
    h = await createHarness({ livenessPrimitive: 'listPolicies' });
    const { a, b } = await twoEnvs();
    const p = (await h.app.probe(a, { request_id: rid(), kind: 'safari' }, WEB)).operation_id;
    await h.idle();
    h.fake.setSelectionFor('home', G, nodeOf(b));
    failProfileReads(during(() => p), 3);
    await arrivalTimeout();
    expect(pending()).toMatchObject({ kind: 'skipped', operationId: p });
    clearWrites();
    // 对账排入服务的改选之后、执行器领取它之前受理了普通模式（执行器停止：由测试直接执行服务的改选，固定让出的分支）
    await h.app.stop();
    await h.app.runPeriodicReconcile();
    const hold = deferredHolds().at(-1)!;
    expect(hold.status).toBe('queued');
    const normalId = (await h.app.enterNormal({ request_id: rid('normal'), old_session_policy: 'closed_confirmed', confirmed_environment_id: a }, WEB)).operation_id;
    await runForgedHold(h.app.engine, hold);
    expect(op(hold.id).status).toBe('superseded');
    expect(op(hold.id).supersededBy).toBe(normalId);
    expect(h.fake.selectionWrites).toEqual([]);
  });

  test('T6 / P11: a service-enqueued hold refused by the guard keeps the pending record; the next working reconcile enqueues it again and REJECT is written there', async () => {
    h = await createHarness({ livenessPrimitive: 'listExternalResources' });
    const { b } = await twoEnvs();
    await startSwitch(b);
    clearWrites();
    wrapEntry((mode) => (mode === 'BLOCKED' ? 'throw' : null));
    let n1: string | null = null;
    failProfileReads(during(() => n1), 3);
    n1 = (await h.app.enterNormal({ request_id: rid('normal'), old_session_policy: 'closed_confirmed', confirmed_environment_id: h.repos.routeState.get().activeEnvironmentId }, WEB)).operation_id;
    await h.idle();
    expect(pending()).toMatchObject({ kind: 'skipped', operationId: n1 });
    let flipped = false;
    const gcp = h.fake.getCurrentProfile.bind(h.fake);
    h.fake.getCurrentProfile = async () => {
      const cur = h.app.executor.currentOperationId;
      if (!flipped && cur && h.repos.operations.get(cur)?.kind === 'route.hold') {
        flipped = true;
        toOther();
      }
      return gcp();
    };
    await h.app.runPeriodicReconcile();
    await h.idle();
    expect(flipped).toBe(true);
    expect(deferredHolds().at(-1)).toMatchObject({ status: 'failed' });
    expect(pending()).toMatchObject({ operationId: n1 });
    toWorking();
    await h.app.runPeriodicReconcile();
    await h.idle();
    expect(h.fake.selectionFor('home', G)).toBe('REJECT');
    expect(writesOffWorking()).toEqual([]);
  });
});

describe('review follow-ups: truthful texts', () => {
  test('PG-T4: the app\'s own unconfirmed restore write found on the working profile is not reported as an external change (entry_unverified instead); no stale external warning after the hold selects REJECT', async () => {
    h = await createHarness();
    const { a, b } = await twoEnvs();
    const opId = await startSwitch(b);
    const sgp = h.fake.selectGroupPolicy.bind(h.fake);
    h.fake.selectGroupPolicy = async (g: string, policy: string) => {
      await sgp(g, policy);
      if (policy === nodeOf(a)) toOther();
    };
    await arrivalTimeout();
    h.fake.selectGroupPolicy = sgp;
    expect(op(opId).result).toMatchObject({ rejectGuard: { stage: 'profile_changed' } });
    expect(h.app.engine.kv.get('route:unconfirmedWrite')).toMatchObject({ policy: nodeOf(a), operationId: opId });
    toWorking();
    await h.app.runPeriodicReconcile();
    await h.idle();
    const notes = reconcileOps().map((o) => steps(o.id)).join('\n');
    expect(notes).toContain(`与本应用之前未经确认的写入（${nodeOf(a)}）一致，不是外部修改`);
    expect(notes).not.toContain('SFE-ROUTE 的选择被外部修改');
    const route = h.repos.routeState.get();
    expect(route.warnings).not.toContain('external_selection_change');
    expect(route.warnings).toContain('entry_unverified');
    expect(route.phase).toBe('attention');
    // 服务排入的改选已在固定工作配置上改选 REJECT：之后没有声称外部修改的警告留下
    expect(h.fake.selectionFor('home', G)).toBe('REJECT');
    expect(route.selectedNode).toBe('REJECT');
  });

  test('PG-T8: step 8 refused (no target written): the guarded rollback does not say SFE-ROUTE may still select a node this switch wrote', async () => {
    h = await createHarness();
    const { a, b } = await twoEnvs();
    let opId: string | null = null;
    const orig = h.fake.listActiveRequests.bind(h.fake);
    let switched = false;
    h.fake.listActiveRequests = async (...args: Parameters<typeof orig>) => {
      if (!switched && opId !== null && h.app.executor.currentOperationId === opId) {
        switched = true;
        toOther();
      }
      return orig(...args);
    };
    opId = (await h.app.activate(b, { request_id: rid('act'), old_session_policy: 'closed_confirmed', confirmed_environment_id: a }, WEB)).operation_id;
    await h.idle();
    expect(switched).toBe(true);
    expect(h.fake.selectionWrites).toEqual([]);
    expect(lastStep(opId)).toContain('本次切换没有选择目标节点');
    expect(lastStep(opId)).not.toContain('本次切换写入的未验证节点');
  });

  test('PG-T13: Surge becomes unreachable right after the rollback\'s BLOCKED readback: the text does not imply another profile and asks for normal mode once Surge is reachable', async () => {
    h = await createHarness();
    const { b } = await twoEnvs();
    const opId = await startSwitch(b);
    expect(op(opId).phase).toBe('VERIFY_ONLY');
    // 回滚回到阻断并读回之后 Surge 不可连接
    const engine = h.app.engine;
    const origCtrl = engine.entryController.bind(engine);
    engine.entryController = ((owner: Parameters<typeof origCtrl>[0]) => {
      const c = origCtrl(owner);
      if (!c) return c;
      return new Proxy(c, {
        get(t, prop) {
          if (prop === 'transition') {
            return async (...args: Parameters<EntryController['transition']>) => {
              const rb = await t.transition(...args);
              if (args[0] === 'BLOCKED') h.fake.reachable = false;
              return rb;
            };
          }
          const v = Reflect.get(t, prop, t) as unknown;
          return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(t) : v;
        },
      });
    }) as typeof engine.entryController;
    await arrivalTimeout();
    const o = op(opId);
    expect(o).toMatchObject({ status: 'needs_attention', phase: 'BLOCKED_NEEDS_ATTENTION' });
    expect(o.result).toMatchObject({ rejectGuard: { reason: 'surge_unreachable', stage: 'not_attempted' } });
    const text = lastStep(opId);
    expect(text).toContain('回滚未完成：无法连接 Surge，没有恢复切换前的节点，也没有改选 SFE-ROUTE；入口在连接中断之前读回为阻断');
    expect(text).toContain('需要处理：Surge 可以连接之后进入普通模式');
    expect(text).not.toContain('不改动其他配置中的同名组');
    expect(text).not.toContain('固定工作配置重新加载之后');
    expect(text).not.toContain('不必先切回固定工作配置');
  });
});

// ---------- 评审后续：守卫分支的固定（在读取时切换配置、每个写入点的配置变化、身份读取重试） ----------

/**
 * active() 成立时：读当前配置（守卫的核对）之后的下一次 SFE-ROUTE 读取之前切到另一个配置（它的同名组选着 sel）——模拟在守卫之后、
 * 要认定的读取之时切换配置（不是在写入时）。
 */
function switchAtGuardedRead(active: () => boolean, sel: string): { switched: () => boolean } {
  let armed = false;
  let switched = false;
  const gcp = h.fake.getCurrentProfile.bind(h.fake);
  h.fake.getCurrentProfile = async () => {
    if (!switched && active()) armed = true;
    return gcp();
  };
  const ggs = h.fake.getGroupSelection.bind(h.fake);
  h.fake.getGroupSelection = async (g: string) => {
    if (armed && !switched && active()) {
      switched = true;
      toOther(sel);
    }
    return ggs(g);
  };
  return { switched: () => switched };
}
const currentKind = (): string | null => {
  const cur = h.app.executor.currentOperationId;
  return cur ? (h.repos.operations.get(cur)?.kind ?? null) : null;
};
/** 写入 policy 之后（写入已生效）切到另一个配置：改选期间配置变了（profile_changed）。 */
function switchAfterWrite(policy: string): () => void {
  const sgp = h.fake.selectGroupPolicy.bind(h.fake);
  h.fake.selectGroupPolicy = async (g: string, p: string) => {
    await sgp(g, p);
    if (p === policy) toOther();
  };
  return () => (h.fake.selectGroupPolicy = sgp);
}

describe('review follow-ups: credited reads switch at the read (T2)', () => {
  test('T2/P1: holdAtRouteEnd\'s decision read is post-checked: a switch to another profile (REJECT there) at the read does not end the op as 「路由未改变」', async () => {
    h = await createHarness();
    const { a, b } = await twoEnvs();
    const p = (await h.app.probe(a, { request_id: rid(), kind: 'safari' }, WEB)).operation_id;
    await h.idle();
    h.fake.setSelectionFor('home', G, nodeOf(b));
    const sw = switchAtGuardedRead(during(() => p), 'REJECT');
    await arrivalTimeout();
    expect(sw.switched()).toBe(true);
    expect(op(p).result).toMatchObject({ rejectSelected: false, rejectGuard: { reason: 'external_profile', stage: 'not_attempted' } });
    expect(steps(p)).not.toContain('路由未改变');
    expect(pending()).toMatchObject({ kind: 'skipped', operationId: p });
    expect(h.fake.selectionWrites).toEqual([]);
  });

  test('T2: the crash-recovery intent read is post-checked: a switch at the read ends interrupted, not the op\'s own REJECT', async () => {
    h = await createHarness();
    const { a } = await twoEnvs();
    await h.app.stop();
    const x = insertInterruptedActivation('op_t2_intent');
    const sw = switchAtGuardedRead(() => h.app.executor.currentOperationId === x.id, 'REJECT');
    await h.crash();
    await h.idle();
    expect(sw.switched()).toBe(true);
    expect(op(x.id).result).toMatchObject({ rejectSelected: false, rejectGuard: { reason: 'external_profile', stage: 'interrupted' } });
    expect(h.repos.routeState.get().selectedNode).toBe(nodeOf(a));
    expect(pending()).toMatchObject({ kind: 'intent', operationId: x.id });
    expect(h.fake.selectionWrites).toEqual([]);
  });

  test('T2: the rollback\'s no-previous read is post-checked: a switch at the read goes to holdGuardedRollback (nothing credited, no rollback result)', async () => {
    h = await createHarness();
    const created = await createEnv(h, 'US-Buyer-A', '203.0.113.10');
    await bind(h, PROFILE_A, created.environment_id!);
    rememberWorking();
    clearWrites();
    const opId = await startSwitch(created.environment_id!);
    expect(op(opId).phase).toBe('VERIFY_ONLY');
    clearWrites();
    const sw = switchAtGuardedRead(() => h.app.executor.currentOperationId === opId && h.repos.operations.get(opId)?.phase === 'ROLLING_BACK', 'REJECT');
    await arrivalTimeout();
    expect(sw.switched()).toBe(true);
    expect(op(opId)).toMatchObject({ status: 'needs_attention', phase: 'BLOCKED_NEEDS_ATTENTION' });
    expect(op(opId).result?.rollback).toBeUndefined();
    expect(op(opId).result).toMatchObject({ rejectSelected: false, rejectGuard: { reason: 'external_profile', stage: 'not_attempted' } });
    expect(h.repos.routeState.get().selectedNode).not.toBe('REJECT');
    expect(h.fake.selectionWrites).toEqual([]);
  });

  test('T2: route.hold step 5 read is post-checked: a switch at the read (REJECT there) ends unavailable, not 「已是 REJECT，不需要改选」', async () => {
    h = await createHarness();
    await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    rememberWorking();
    clearWrites();
    h.app.engine.kv.set('resource:forgedNodes', { since: h.clock.now().toISOString(), reasons: ['unexplained_fetch'] });
    const sw = switchAtGuardedRead(() => currentKind() === 'route.hold', 'REJECT');
    const hold = maybeEnqueueForgedHold(h.app.engine);
    expect(hold).not.toBeNull();
    await h.idle();
    expect(sw.switched()).toBe(true);
    expect(op(hold!.id)).toMatchObject({ status: 'failed', error: { code: 'EXTERNAL_PROFILE' } });
    expect(steps(hold!.id)).not.toContain('已是 REJECT');
    expect(h.repos.routeState.get().selectedNode).not.toBe('REJECT');
    expect(h.fake.selectionWrites).toEqual([]);
  });

  test('T2: the delete read is post-checked: a switch at the read refuses the delete (environment kept)', async () => {
    h = await createHarness();
    const { envId } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    rememberWorking();
    await h.app.enterNormal({ request_id: rid(), old_session_policy: 'closed_confirmed', confirmed_environment_id: envId }, WEB);
    await h.idle();
    clearWrites();
    const sw = switchAtGuardedRead(() => currentKind() === 'environment.delete', 'REJECT');
    const d = await h.app.deleteEnvironment(envId, { request_id: rid(), expected_revision: h.repos.environments.get(envId)!.revision }, WEB);
    await h.idle();
    expect(sw.switched()).toBe(true);
    expect(op(d.operation_id)).toMatchObject({ status: 'failed', error: { code: 'EXTERNAL_PROFILE' } });
    expect(op(d.operation_id).error!.message).toContain('读取 SFE-ROUTE 期间Surge 当前配置不是固定工作配置');
    expect(h.repos.environments.get(envId)!.deletedAt).toBeNull();
    expect(h.fake.selectionWrites).toEqual([]);
  });

  test('T2/P14: the reconcile credit is post-checked: a REJECT read after a switch to another profile is not credited as the interrupted hold', async () => {
    h = await createHarness();
    const { a } = await twoEnvs();
    const route = h.repos.routeState.get();
    const rec: PendingHold = {
      kind: 'intent',
      operationId: 'op_synthetic_hold',
      intent: { externalSelectionBefore: false },
      block: 'external_profile',
      routeEpoch: route.routeEpoch,
      routeOperationId: route.operationId,
      selectedNode: route.selectedNode,
      recordedAt: h.clock.now().toISOString(),
    };
    h.app.engine.kv.set(PENDING_HOLD_KEY, rec);
    // 对账读完事实（固定工作配置）之后、读选择时 Surge 已切到另一个配置（它的同名组选着 REJECT）
    let switched = false;
    const ggs = h.fake.getGroupSelection.bind(h.fake);
    h.fake.getGroupSelection = async (g: string) => {
      if (!switched && h.app.executor.currentOperationId === null) {
        switched = true;
        toOther('REJECT');
      }
      return ggs(g);
    };
    await h.app.runPeriodicReconcile();
    h.fake.getGroupSelection = ggs;
    expect(switched).toBe(true);
    expect(h.repos.routeState.get().selectedNode).toBe(nodeOf(a));
    expect(h.fake.selectionFor('home', G)).toBe(nodeOf(a));
    expect(reconcileOps().filter((o) => o.payload?.credited !== undefined)).toEqual([]);
  });
});

describe('review follow-ups: profile_changed at each write site (T3)', () => {
  test('T3/P4: the rollback restore write: not credited as restored; the unconfirmed write is recorded and named on return', async () => {
    h = await createHarness();
    const { a, b } = await twoEnvs();
    const opId = await startSwitch(b);
    expect(op(opId).phase).toBe('VERIFY_ONLY');
    const restore = switchAfterWrite(nodeOf(a));
    await arrivalTimeout();
    restore();
    expect(op(opId)).toMatchObject({ status: 'needs_attention', phase: 'BLOCKED_NEEDS_ATTENTION' });
    expect(op(opId).result?.rollback).toBeUndefined();
    expect(op(opId).result).toMatchObject({ rejectSelected: false, rejectGuard: { reason: 'external_profile', stage: 'profile_changed' } });
    expect(steps(opId)).not.toContain('已回滚：恢复切换前的节点');
    expect(h.repos.routeState.get().selectedNode).toBe(nodeOf(b));
    expect(h.app.engine.kv.get('route:unconfirmedWrite')).toMatchObject({ policy: nodeOf(a), operationId: opId });
    toWorking();
    await h.app.runPeriodicReconcile();
    await h.idle();
    expect(reconcileOps().map((o) => steps(o.id)).join('\n')).toContain(`与本应用之前未经确认的写入（${nodeOf(a)}）一致，不是外部修改`);
  });

  test('T3: the rollback rejectKept write (REJECT before the switch): an intent record, credited by the next working reconcile', async () => {
    h = await createHarness();
    const { b } = await twoEnvs();
    // 切换前 SFE-ROUTE 已改选 REJECT（之前一次结束点的保持）：回滚改回 REJECT，不恢复任何买家节点
    h.fake.setSelectionFor('home', G, 'REJECT');
    h.repos.routeState.update({ selectedNode: 'REJECT' });
    const opId = await startSwitch(b);
    expect(op(opId).phase).toBe('VERIFY_ONLY');
    const restore = switchAfterWrite('REJECT');
    await arrivalTimeout();
    restore();
    expect(op(opId).result).toMatchObject({ rejectSelected: false, rejectGuard: { reason: 'external_profile', stage: 'profile_changed' } });
    expect(op(opId).result?.rollback).toBeUndefined();
    expect(pending()).toMatchObject({ kind: 'intent', operationId: opId, stage: 'profile_changed' });
    expect(h.repos.routeState.get().selectedNode).toBe(nodeOf(b));
    toWorking();
    await h.app.runPeriodicReconcile();
    expect(h.repos.routeState.get().selectedNode).toBe('REJECT');
    expect(steps(opId)).toContain('按本应用的改选记下，不当作外部修改');
  });

  test('T3: the publish rollback reselect write: not counted as reselected; the unconfirmed write is recorded', async () => {
    h = await createHarness();
    const { envId: a } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    rememberWorking();
    clearWrites();
    const selected = nodeOf(a);
    const restore = switchAfterWrite(selected);
    dropNodesOnNextUpdate(h, [selected]);
    const b = await createEnv(h, 'US-Buyer-B', '203.0.113.11');
    await h.idle();
    restore();
    expect(h.fake.selectionWrites.map((w) => w.policy)).toEqual([selected]);
    const o = op(b.operation_id);
    expect(o.status).toBe('needs_attention');
    expect(o.error!.message).not.toContain('改回原选择（读回确认');
    expect(o.error!.message).not.toContain('原选择已恢复');
    expect(h.app.engine.kv.get('route:unconfirmedWrite')).toMatchObject({ policy: selected, operationId: b.operation_id });
  });

  test('T3: route.hold step 7 write: FAILED with rejectGuard profile_changed and an intent record', async () => {
    h = await createHarness();
    await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    rememberWorking();
    clearWrites();
    h.app.engine.kv.set('resource:forgedNodes', { since: h.clock.now().toISOString(), reasons: ['unexplained_fetch'] });
    const restore = switchAfterWrite('REJECT');
    const hold = maybeEnqueueForgedHold(h.app.engine);
    await h.idle();
    restore();
    expect(op(hold!.id)).toMatchObject({ status: 'failed', error: { code: 'EXTERNAL_PROFILE', details: { rejectGuard: { reason: 'external_profile', stage: 'profile_changed' } } } });
    expect(pending()).toMatchObject({ kind: 'intent', operationId: hold!.id, stage: 'profile_changed' });
    expect(h.repos.routeState.get().selectedNode).not.toBe('REJECT');
  });

  test('T3: the delete REJECT write: the delete is refused and the environment kept', async () => {
    h = await createHarness();
    const { envId } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    rememberWorking();
    await h.app.enterNormal({ request_id: rid(), old_session_policy: 'closed_confirmed', confirmed_environment_id: envId }, WEB);
    await h.idle();
    clearWrites();
    const restore = switchAfterWrite('REJECT');
    const d = await h.app.deleteEnvironment(envId, { request_id: rid(), expected_revision: h.repos.environments.get(envId)!.revision }, WEB);
    await h.idle();
    restore();
    expect(op(d.operation_id)).toMatchObject({ status: 'failed', error: { code: 'EXTERNAL_PROFILE' } });
    expect(op(d.operation_id).error!.message).toContain('改选 SFE-ROUTE 期间Surge 当前配置不是固定工作配置');
    expect(h.repos.environments.get(envId)!.deletedAt).toBeNull();
    expect(h.repos.routeState.get().selectedNode).not.toBe('REJECT');
  });

  test('T3: normal mode\'s failure REJECT (withChangedIntent): profile_changed records an intent', async () => {
    h = await createHarness();
    const { b } = await twoEnvs();
    await startSwitch(b);
    wrapEntry((mode) => (mode === 'BLOCKED' ? 'throw' : null));
    const restore = switchAfterWrite('REJECT');
    const n = await h.app.enterNormal({ request_id: rid('normal'), old_session_policy: 'closed_confirmed', confirmed_environment_id: h.repos.routeState.get().activeEnvironmentId }, WEB);
    await h.idle();
    restore();
    expect(op(n.operation_id).result).toMatchObject({ rejectSelected: false, rejectGuard: { reason: 'external_profile', stage: 'profile_changed' } });
    expect(pending()).toMatchObject({ kind: 'intent', operationId: n.operation_id, stage: 'profile_changed' });
  });

  test('T3: holdAtRouteEnd\'s catch path (a repository read throws) still checks the profile: no write on another profile', async () => {
    h = await createHarness();
    const { a, b } = await twoEnvs();
    toOther(nodeOf(b));
    // 结束点读操作出错（只在 holdAtRouteEnd 中失败一次）：照样失败即关闭，但同样只在固定工作配置上改选
    const orig = h.repos.operations.listByStatus.bind(h.repos.operations);
    let thrown = false;
    h.repos.operations.listByStatus = ((...args: Parameters<typeof orig>) => {
      if (!thrown && (new Error().stack ?? '').includes('holdAtRouteEnd')) {
        thrown = true;
        throw new Error('合成：读取操作失败');
      }
      return orig(...args);
    }) as typeof orig;
    const opId = await startSwitch(a);
    h.repos.operations.listByStatus = orig;
    expect(thrown).toBe(true);
    expect(writesOffWorking()).toEqual([]);
    expect(h.fake.selectionWrites).toEqual([]);
    expect(op(opId).result).toMatchObject({ rejectSelected: false, rejectGuard: { reason: 'external_profile', stage: 'not_attempted' } });
  });
});

describe('review follow-ups: identity read retry and the profile-unknown escalation read (T4, T5, T9)', () => {
  test('T4/P12: one identity read failure at retest start (CLI liveness) is retried; the retest starts', async () => {
    h = await createHarness({ livenessPrimitive: 'listExternalResources' });
    const { a } = await twoEnvs();
    let p: string | null = null;
    const f = failProfileReads(during(() => p), 1);
    p = (await h.app.probe(a, { request_id: rid(), kind: 'safari' }, WEB)).operation_id;
    await h.idle();
    expect(f.hits()).toBe(1);
    expect(op(p).status).toBe('waiting');
  });

  test('T4/P13: one identity read failure in the post-check after the REJECT write is retried; the hold is credited', async () => {
    h = await createHarness({ livenessPrimitive: 'listPolicies' });
    const { a, b } = await twoEnvs();
    const p = (await h.app.probe(a, { request_id: rid(), kind: 'safari' }, WEB)).operation_id;
    await h.idle();
    h.fake.setSelectionFor('home', G, nodeOf(b));
    let afterSelect = false;
    let failedOnce = false;
    const sgp = h.fake.selectGroupPolicy.bind(h.fake);
    h.fake.selectGroupPolicy = async (g: string, policy: string) => {
      await sgp(g, policy);
      if (policy === 'REJECT') afterSelect = true;
    };
    const gcp = h.fake.getCurrentProfile.bind(h.fake);
    h.fake.getCurrentProfile = async () => {
      if (afterSelect && !failedOnce) {
        failedOnce = true;
        throw new SfeError('SURGE_COMMAND_FAILED', '读取当前配置失败：模拟失败');
      }
      return gcp();
    };
    await arrivalTimeout();
    expect(failedOnce).toBe(true);
    expect(op(p).result).toMatchObject({ rejectSelected: true });
    expect(h.repos.routeState.get().selectedNode).toBe('REJECT');
  });

  test('T4 (M30): the post-check fails with SURGE_UNREACHABLE: the reason is 无法连接 Surge, not 无法确认当前配置', async () => {
    h = await createHarness({ livenessPrimitive: 'listPolicies' });
    const { a, b } = await twoEnvs();
    const p = (await h.app.probe(a, { request_id: rid(), kind: 'safari' }, WEB)).operation_id;
    await h.idle();
    h.fake.setSelectionFor('home', G, nodeOf(b));
    let afterSelect = false;
    const sgp = h.fake.selectGroupPolicy.bind(h.fake);
    h.fake.selectGroupPolicy = async (g: string, policy: string) => {
      await sgp(g, policy);
      if (policy === 'REJECT') afterSelect = true;
    };
    const gcp = h.fake.getCurrentProfile.bind(h.fake);
    let left = 3;
    h.fake.getCurrentProfile = async () => {
      if (afterSelect && left > 0) {
        left -= 1;
        throw new SfeError('SURGE_UNREACHABLE', '无法连接 Surge：模拟失败');
      }
      return gcp();
    };
    await arrivalTimeout();
    expect(left).toBe(0);
    expect(op(p).result).toMatchObject({ rejectSelected: false, rejectGuard: { reason: 'surge_unreachable', stage: 'profile_changed' } });
    expect(lastStep(p)).toContain('改选 SFE-ROUTE 期间无法连接 Surge');
  });

  test('T5/P17: profile unknown at an end point and the selection drifted after the last reconcile (record still shows the verified exit): the uncredited read escalates to attention without writing', async () => {
    h = await createHarness({ livenessPrimitive: 'listPolicies' });
    const { a, b } = await twoEnvs();
    const p = (await h.app.probe(a, { request_id: rid(), kind: 'safari' }, WEB)).operation_id;
    await h.idle();
    const orig = h.fake.getCurrentProfile.bind(h.fake);
    let left = 3;
    h.fake.getCurrentProfile = async () => {
      if (left > 0 && h.app.executor.currentOperationId === p) {
        // 用户在上一次对账之后、结束点核对之前改选了 B 的节点
        if (left === 3) h.fake.setSelectionFor('home', G, nodeOf(b));
        left -= 1;
        throw new SfeError('SURGE_COMMAND_FAILED', '读取当前配置失败：模拟失败');
      }
      return orig();
    };
    await arrivalTimeout();
    expect(left).toBe(0);
    // 记录仍表明选着已验证的出口（对账还没有发现漂移）
    expect(h.repos.routeState.get().warnings).not.toContain('external_selection_change');
    expect(op(p).result).toMatchObject({ rejectSelected: false, rejectGuard: { reason: 'profile_unknown', stage: 'not_attempted' } });
    expect(pending()).toMatchObject({ kind: 'skipped', operationId: p });
    expect(h.fake.selectionWrites).toEqual([]);
  });

  test('T9/P10c: delete fails when the SFE-ROUTE read fails on the confirmed working profile (Q7)', async () => {
    h = await createHarness();
    const { envId } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    await h.app.enterNormal({ request_id: rid(), old_session_policy: 'closed_confirmed', confirmed_environment_id: envId }, WEB);
    await h.idle();
    h.fake.failNext('getGroupSelection');
    const d = await h.app.deleteEnvironment(envId, { request_id: rid(), expected_revision: h.repos.environments.get(envId)!.revision }, ADMIN);
    await h.idle();
    expect(op(d.operation_id).status).toBe('failed');
    expect(h.repos.environments.get(envId)!.deletedAt).toBeNull();
  });
});

// ---------- 变异回退检查的后续：之前去掉也不会让任何测试失败的守卫与推迟改选 ----------

/**
 * 回到固定工作配置之后的第一次对账：route:pendingHold 让它排入服务的改选（route.hold，endHoldDeferred），执行器在固定工作配置上
 * 改选 REJECT。返回排入的改选。
 */
async function backOnWorkingDeferredHold(): Promise<OperationRecord | undefined> {
  toWorking();
  await h.app.runPeriodicReconcile();
  await h.idle();
  return deferredHolds().at(-1);
}
/** 每一次 REJECT 改选都在固定工作配置上（按假 Surge 的逐配置写入记录），并且至少有一次；固定工作配置的选择是 REJECT。 */
function rejectOnWorkingOnly(): void {
  const rejects = h.fake.selectionWrites.filter((w) => w.policy === 'REJECT');
  expect(rejects.length).toBeGreaterThan(0);
  expect(rejects.every((w) => w.home)).toBe(true);
  expect(writesOffWorking()).toEqual([]);
  expect(h.fake.selectionFor('home', G)).toBe('REJECT');
}

describe('mutation follow-ups: each guard refusal records the deferred REJECT (amendment 1)', () => {
  test('M-R11: settleAbandonedTransition refused on another profile records route:pendingHold; back on the working profile the deferred hold selects REJECT there only', async () => {
    h = await createHarness();
    const { b } = await twoEnvs();
    const opId = await startSwitch(b);
    expect(op(opId).phase).toBe('VERIFY_ONLY');
    clearWrites();
    toOther(nodeOf(b));
    await settleAbandonedTransition(h.app.engine, opId, new Error('合成异常'));
    expect(h.fake.selectionWrites).toEqual([]);
    expect(op(opId).error!.details).toMatchObject({ rejectSelected: false, rejectGuard: { reason: 'external_profile', stage: 'not_attempted' } });
    expect(pending()).toMatchObject({ kind: 'skipped', operationId: opId, block: 'external_profile' });
    expect(h.fake.selectionFor('home', G)).toBe(nodeOf(b));
    const hold = await backOnWorkingDeferredHold();
    expect(hold).toMatchObject({ status: 'succeeded', result: { rejectSelected: true } });
    expect(payloadOf(hold!).endHoldDeferred?.sourceOperationId).toBe(opId);
    rejectOnWorkingOnly();
    expect(h.fake.selectionFor(other(), G)).toBe(nodeOf(b));
    expect(steps(opId)).toContain('服务排入的改选已在固定工作配置上把 SFE-ROUTE 改选 REJECT（读回确认）');
    expect(pending()).toBeNull();
  });

  test('M-R28: the rollback catch (entry transition fails) refused on another profile records route:pendingHold; back on the working profile the deferred hold selects REJECT there only', async () => {
    h = await createHarness();
    const { b } = await twoEnvs();
    const opId = await startSwitch(b);
    clearWrites();
    toOther(nodeOf(b));
    wrapEntry((mode) => (mode === 'BLOCKED' ? 'throw' : null));
    await arrivalTimeout();
    expect(h.fake.selectionWrites).toEqual([]);
    expect(op(opId)).toMatchObject({ status: 'needs_attention', phase: 'BLOCKED_NEEDS_ATTENTION' });
    expect(op(opId).error!.message).toContain('回滚无法确认');
    expect(op(opId).error!.details).toMatchObject({ rejectSelected: false, rejectGuard: { reason: 'external_profile', stage: 'not_attempted' } });
    expect(pending()).toMatchObject({ kind: 'skipped', operationId: opId, block: 'external_profile' });
    const hold = await backOnWorkingDeferredHold();
    expect(hold).toMatchObject({ status: 'succeeded', result: { rejectSelected: true } });
    expect(payloadOf(hold!).endHoldDeferred?.sourceOperationId).toBe(opId);
    rejectOnWorkingOnly();
    expect(h.fake.selectionFor(other(), G)).toBe(nodeOf(b));
    expect(pending()).toBeNull();
  });

  test('M-R30: holdUnconfirmedRollback refused (profile unknown, CLI liveness) records route:pendingHold; once the profile is confirmed the deferred hold selects REJECT on the working profile only', async () => {
    h = await createHarness({ livenessPrimitive: 'listExternalResources' });
    const { b } = await twoEnvs();
    const opId = await startSwitch(b);
    clearWrites();
    wrapEntry((mode) => (mode === 'BLOCKED' ? 'unconfirmed' : null));
    const f = failProfileReads(during(() => opId), 3);
    await arrivalTimeout();
    expect(f.hits()).toBe(3);
    expect(h.fake.selectionWrites).toEqual([]);
    expect(op(opId).error!.message).toContain('回滚未能确认');
    expect(op(opId).error!.details).toMatchObject({ rejectSelected: false, rejectGuard: { reason: 'profile_unknown', stage: 'not_attempted' } });
    expect(pending()).toMatchObject({ kind: 'skipped', operationId: opId, block: 'profile_unknown' });
    // 另一个配置的同名组从未被写过；下一次对账确认是固定工作配置
    const hold = await backOnWorkingDeferredHold();
    expect(hold).toMatchObject({ status: 'succeeded', result: { rejectSelected: true } });
    expect(payloadOf(hold!).endHoldDeferred?.sourceOperationId).toBe(opId);
    rejectOnWorkingOnly();
    expect(pending()).toBeNull();
  });

  test('M-R30b: holdUnconfirmedRollback refused on another profile records route:pendingHold; back on the working profile the deferred hold selects REJECT there only', async () => {
    h = await createHarness();
    const { b } = await twoEnvs();
    const opId = await startSwitch(b);
    clearWrites();
    toOther(nodeOf(b));
    wrapEntry((mode) => (mode === 'BLOCKED' ? 'unconfirmed' : null));
    await arrivalTimeout();
    expect(h.fake.selectionWrites).toEqual([]);
    expect(op(opId).error!.details).toMatchObject({ rejectSelected: false, rejectGuard: { reason: 'external_profile' } });
    expect(pending()).toMatchObject({ kind: 'skipped', operationId: opId, block: 'external_profile' });
    const hold = await backOnWorkingDeferredHold();
    expect(hold).toMatchObject({ status: 'succeeded', result: { rejectSelected: true } });
    rejectOnWorkingOnly();
    expect(h.fake.selectionFor(other(), G)).toBe(nodeOf(b));
    expect(pending()).toBeNull();
  });
});

describe('mutation follow-ups: the verified-exit readback is post-checked (R12)', () => {
  test('M-R12a: normal mode fails with a loosened entry and the profile switches at the verified-exit read (the other profile selects the verified node): not credited as 「停在原来已验证的路由上」, nothing written on the other profile, the deferred hold selects REJECT on the working profile', async () => {
    h = await createHarness();
    const { a, b } = await twoEnvs();
    // 用户在上一次对账之后把固定工作配置的 SFE-ROUTE 改选到 B 的节点（记录仍表明选着 A 已验证的出口）
    h.fake.setSelectionFor('home', G, nodeOf(b));
    wrapEntry((mode) => (mode === 'BLOCKED' ? 'throw' : null));
    let n: string | null = null;
    // 守卫核对（固定工作配置）之后、要认定的读取之时切到另一个配置：它的同名组选着 A 已验证的节点
    const sw = switchAtGuardedRead(during(() => n), nodeOf(a));
    n = (await h.app.enterNormal({ request_id: rid('normal'), old_session_policy: 'closed_confirmed', confirmed_environment_id: a }, WEB)).operation_id;
    await h.idle();
    expect(sw.switched()).toBe(true);
    const o = op(n);
    expect(o.status).toBe('failed');
    expect(lastStep(n)).not.toContain('读回就是使用中环境已验证的出口');
    expect(o.result).toMatchObject({ rejectSelected: false, rejectGuard: { reason: 'external_profile', stage: 'not_attempted' } });
    expect(writesOffWorking()).toEqual([]);
    expect(h.fake.selectionWrites).toEqual([]);
    expect(h.repos.routeState.get().phase).toBe('attention');
    expect(pending()).toMatchObject({ kind: 'skipped', operationId: n, block: 'external_profile' });
    const hold = await backOnWorkingDeferredHold();
    expect(hold).toMatchObject({ status: 'succeeded', result: { rejectSelected: true } });
    rejectOnWorkingOnly();
    expect(h.fake.selectionFor(other(), G)).toBe(nodeOf(a));
  });

  test('M-R12b: settleAbandonedTransition for a normal mode that owns the switching route: a profile switch at the verified-exit read is not credited and writes nothing on the other profile', async () => {
    h = await createHarness();
    const { a, b } = await twoEnvs();
    h.fake.setSelectionFor('home', G, nodeOf(b));
    // 普通模式撤销入口时记下的切换中（没有激活快照：记录表明选着 A 已验证的出口），处理器的意外异常越过了它自己的失败处理
    const normal = h.repos.operations.insert({
      id: 'op_mr12b_normal',
      requestId: rid('normal'),
      requestDigest: 'synthetic',
      kind: 'route.normal',
      initiatorKind: 'web',
      status: 'running',
      phase: 'VALIDATING',
      payload: { normal: { oldSessionPolicy: 'closed_confirmed', expectedActiveEnvironmentId: a, hadManagedEnvironment: true } },
    });
    h.repos.routeState.update({ phase: 'switching', operationId: normal.id });
    const sw = switchAtGuardedRead(() => true, nodeOf(a));
    await settleAbandonedTransition(h.app.engine, normal.id, new Error('合成异常'));
    expect(sw.switched()).toBe(true);
    expect(h.fake.selectionWrites).toEqual([]);
    const o = op(normal.id);
    expect(o).toMatchObject({ status: 'needs_attention', phase: 'BLOCKED_NEEDS_ATTENTION' });
    expect(o.error!.details).toMatchObject({ rejectSelected: false, rejectGuard: { reason: 'external_profile', stage: 'not_attempted' } });
    expect(o.error!.message).toContain('SFE-ROUTE 没有改选 REJECT');
    expect(pending()).toMatchObject({ kind: 'skipped', operationId: normal.id });
    const hold = await backOnWorkingDeferredHold();
    expect(hold).toMatchObject({ status: 'succeeded', result: { rejectSelected: true } });
    rejectOnWorkingOnly();
  });
});

/**
 * 普通模式（入口已放宽）失败而三次读不到当前配置（CLI 检测原语）：REJECT 被跳过，记下 route:pendingHold（kind skipped）。之后执行器
 * 停止，第一次确认是固定工作配置的对账排入服务的改选（留在排队中，由测试直接执行）。
 */
async function queuedDeferredHold(): Promise<{ n1: string; b: string; hold: OperationRecord }> {
  h = await createHarness({ livenessPrimitive: 'listExternalResources' });
  const { b } = await twoEnvs();
  await startSwitch(b);
  wrapEntry((mode) => (mode === 'BLOCKED' ? 'throw' : null));
  let n1: string | null = null;
  failProfileReads(during(() => n1), 3);
  n1 = (await h.app.enterNormal({ request_id: rid('normal'), old_session_policy: 'closed_confirmed', confirmed_environment_id: h.repos.routeState.get().activeEnvironmentId }, WEB)).operation_id;
  await h.idle();
  expect(pending()).toMatchObject({ kind: 'skipped', operationId: n1 });
  clearWrites();
  await h.app.stop();
  await h.app.runPeriodicReconcile();
  const hold = deferredHolds().at(-1)!;
  expect(hold.status).toBe('queued');
  expect(payloadOf(hold).endHoldDeferred?.sourceOperationId).toBe(n1);
  return { n1, b, hold };
}

describe('mutation follow-ups: the service-enqueued deferred hold and the pending record', () => {
  test('M-R46: Surge is unreachable when the service-enqueued hold runs: no select, no intent claimed, route:pendingHold kept; once reachable the next working reconcile enqueues it again and REJECT is written on the working profile', async () => {
    const { n1, hold } = await queuedDeferredHold();
    h.fake.reachable = false;
    const selects = h.fake.calls.selectGroupPolicy ?? 0;
    await runForgedHold(h.app.engine, op(hold.id));
    // 推迟的 REJECT 没有丢：记录仍属于来源操作；没有尝试改选，也没有记下改选意图
    expect(pending()).toMatchObject({ kind: 'skipped', operationId: n1 });
    expect(h.fake.calls.selectGroupPolicy ?? 0).toBe(selects);
    expect(payloadOf(op(hold.id)).endHold).toBeUndefined();
    expect(op(hold.id)).toMatchObject({ status: 'failed', error: { code: 'SURGE_UNREACHABLE' } });
    expect(op(hold.id).error!.message).toContain('无法连接 Surge：没有改选');
    expect(op(hold.id).result?.rejectSelected).toBeUndefined();
    expect(h.repos.routeState.get().selectedNode).not.toBe('REJECT');
    h.fake.reachable = true;
    await h.app.runPeriodicReconcile();
    const again = deferredHolds().at(-1)!;
    expect(again.id).not.toBe(hold.id);
    await runForgedHold(h.app.engine, op(again.id));
    expect(op(again.id)).toMatchObject({ status: 'succeeded', result: { rejectSelected: true } });
    rejectOnWorkingOnly();
    expect(pending()).toBeNull();
  });

  test('M-R48: the service-enqueued hold finds its source record overwritten by a later route operation: not needed, nothing written; the later record stays for its own hold', async () => {
    const { n1, b, hold } = await queuedDeferredHold();
    // 之后受理的普通模式先执行（排队的普通模式先于 REJECT 保持领取）：Surge 此时是另一个配置，它同样失败并记下自己的 route:pendingHold
    const n2 = (await h.app.enterNormal({ request_id: rid('normal'), old_session_policy: 'closed_confirmed', confirmed_environment_id: h.repos.routeState.get().activeEnvironmentId }, WEB)).operation_id;
    toOther(nodeOf(b));
    await runNormal(h.app.engine, op(n2));
    expect(op(n2).result).toMatchObject({ rejectSelected: false, rejectGuard: { reason: 'external_profile', stage: 'not_attempted' } });
    expect(pending()).toMatchObject({ kind: 'skipped', operationId: n2 });
    toWorking();
    expect(h.fake.selectionFor('home', G)).toBe(nodeOf(b));
    await runForgedHold(h.app.engine, op(hold.id));
    expect(op(hold.id)).toMatchObject({ status: 'succeeded', phase: 'COMPLETED' });
    expect(lastStep(hold.id)).toContain('之后的路由操作已改写路由（或已处理），不需要改选');
    expect(payloadOf(op(hold.id)).endHold).toBeUndefined();
    expect(h.fake.selectionWrites).toEqual([]);
    expect(pending()).toMatchObject({ kind: 'skipped', operationId: n2 });
    expect(steps(n1)).toContain('服务排入的改选结束：之后的路由操作已改写路由（或已处理），不需要改选');
  });

  test('M-P11: a newer route:pendingHold overwrites an older one: the older source operation is told its record is no longer followed', async () => {
    h = await createHarness();
    const { b } = await twoEnvs();
    await startSwitch(b);
    clearWrites();
    toOther(nodeOf(b));
    wrapEntry((mode) => (mode === 'BLOCKED' ? 'throw' : null));
    const failedNormal = async (): Promise<string> => {
      const id = (await h.app.enterNormal({ request_id: rid('normal'), old_session_policy: 'closed_confirmed', confirmed_environment_id: h.repos.routeState.get().activeEnvironmentId }, WEB)).operation_id;
      await h.idle();
      expect(op(id).result).toMatchObject({ rejectSelected: false, rejectGuard: { reason: 'external_profile', stage: 'not_attempted' } });
      return id;
    };
    const n1 = await failedNormal();
    expect(pending()).toMatchObject({ kind: 'skipped', operationId: n1 });
    expect(steps(n1)).not.toContain('不再按本操作排入改选');
    // 用户再次进入普通模式（仍在另一个配置上）：它的记录覆盖之前的记录
    const n2 = await failedNormal();
    expect(pending()).toMatchObject({ kind: 'skipped', operationId: n2 });
    expect(lastStep(n1)).toBe('之后的路由操作已改写路由，不再按本操作排入改选');
    expect(steps(n2)).not.toContain('不再按本操作排入改选');
    expect(h.fake.selectionWrites).toEqual([]);
  });
});

describe('mutation follow-ups: the reconcile credit (amendment 8(b), P10, C4)', () => {
  test('M-P7: crediting an intent while the route reads active_verified leaves the phase attention, never active_verified with selectedNode REJECT', async () => {
    h = await createHarness();
    await twoEnvs();
    const route = h.repos.routeState.get();
    expect(route.phase).toBe('active_verified');
    // 合成记录（与 G23 相同）：实际只经很长的链条出现——等待实测的激活负责路由时 REJECT 保持中断（记录不作废），之后它提交 ACTIVE
    const rec: PendingHold = {
      kind: 'intent',
      operationId: 'op_synthetic_hold',
      intent: { externalSelectionBefore: false },
      block: 'external_profile',
      stage: 'interrupted',
      routeEpoch: route.routeEpoch,
      routeOperationId: route.operationId,
      selectedNode: route.selectedNode,
      recordedAt: h.clock.now().toISOString(),
    };
    h.app.engine.kv.set(PENDING_HOLD_KEY, rec);
    h.fake.setSelectionFor('home', G, 'REJECT');
    await h.app.runPeriodicReconcile();
    const after = h.repos.routeState.get();
    expect(reconcileOps().some((o) => o.payload?.credited === 'op_synthetic_hold')).toBe(true);
    expect(after.selectedNode).toBe('REJECT');
    expect(after.phase).toBe('attention');
    expect(pending()).toBeNull();
  });

  test('M-P10: an external_selection_change raised for the app\'s own interrupted REJECT (the post-check could not confirm the profile) is removed when the next working reconcile credits it', async () => {
    h = await createHarness({ livenessPrimitive: 'listPolicies' });
    const { a } = await twoEnvs();
    await h.app.stop();
    const x = insertInterruptedActivation('op_mp10');
    // 崩溃之前的改选已在固定工作配置上生效；重启时 Surge 是另一个配置（它的同名组选着 A 的节点）
    h.fake.setSelectionFor('home', G, 'REJECT');
    toOther(nodeOf(a));
    await h.crash();
    await h.idle();
    expect(pending()).toMatchObject({ kind: 'intent', operationId: x.id, intent: { externalSelectionBefore: false } });
    expect(h.repos.routeState.get().warnings).not.toContain('external_selection_change');
    toWorking();
    // 对账读事实（固定工作配置）之后，读取之后的核对三次读不到当前配置：不认定；读到的 REJECT 与记录比较，记下外部修改
    let calls = 0;
    const gcp = h.fake.getCurrentProfile.bind(h.fake);
    h.fake.getCurrentProfile = async () => {
      calls += 1;
      if (calls >= 2 && calls <= 4) throw new SfeError('SURGE_COMMAND_FAILED', '读取当前配置失败：模拟失败');
      return gcp();
    };
    await h.app.runPeriodicReconcile();
    h.fake.getCurrentProfile = gcp;
    expect(calls).toBe(4);
    expect(h.repos.routeState.get().warnings).toContain('external_selection_change');
    expect(h.repos.routeState.get().selectedNode).toBe(nodeOf(a));
    expect(pending()).toMatchObject({ kind: 'intent', operationId: x.id });
    await h.app.runPeriodicReconcile();
    const route = h.repos.routeState.get();
    expect(route.selectedNode).toBe('REJECT');
    expect(route.warnings).not.toContain('external_selection_change');
    expect(steps(x.id)).toContain('与中断之前本操作记下的改选意图一致：按本应用的改选记下，不当作外部修改');
    expect(pending()).toBeNull();
  });

  test('M-C4: the reconcile credit needs facts read on the working profile: facts and the REJECT read on another profile, back on the working profile before the post-check: not credited', async () => {
    h = await createHarness();
    const { b } = await twoEnvs();
    // G3 的情形：固定工作配置的 SFE-ROUTE 选着 B 的节点（已记下外部修改），重启时另一个配置的同名组选着 REJECT
    h.fake.setSelectionFor('home', G, nodeOf(b));
    h.repos.routeState.update({ warnings: [...h.repos.routeState.get().warnings, 'external_selection_change'], phase: 'external_change' });
    await h.app.stop();
    const x = insertInterruptedActivation('op_mc4', true);
    toOther('REJECT');
    await h.crash();
    await h.idle();
    expect(pending()).toMatchObject({ kind: 'intent', operationId: x.id });
    // 对账读事实与读选择时仍是另一个配置；读完选择之后、读取之后的核对之前回到固定工作配置（核对因此通过）
    let back = false;
    const ggs = h.fake.getGroupSelection.bind(h.fake);
    h.fake.getGroupSelection = async (g: string) => {
      const v = await ggs(g);
      if (!back && h.app.executor.currentOperationId === null) {
        back = true;
        toWorking();
      }
      return v;
    };
    await h.app.runPeriodicReconcile();
    h.fake.getGroupSelection = ggs;
    expect(back).toBe(true);
    expect(h.repos.routeState.get().selectedNode).not.toBe('REJECT');
    expect(reconcileOps().filter((o) => o.payload?.credited !== undefined)).toEqual([]);
    expect(steps(x.id)).not.toContain('按本应用的改选记下');
    expect(pending()).toMatchObject({ kind: 'intent', operationId: x.id });
    expect(h.fake.selectionFor('home', G)).toBe(nodeOf(b));
    expect(h.fake.selectionWrites).toEqual([]);
  });
});

describe('mutation follow-ups: texts', () => {
  const EXPOSURE = 'Surge 当前加载的配置若也含本应用入口（例如固定工作配置的副本），Safari 请求此刻可能经该配置中同名 SFE-ROUTE 选择的出口发出，本应用不改动它';

  test('M-RG13a: the exposure sentence (amendment 4) is in the end-hold text on another profile', async () => {
    h = await createHarness();
    const { a, b } = await twoEnvs();
    h.app.engine.kv.set('resource:forgedNodes', { since: h.clock.now().toISOString(), reasons: ['unexplained_fetch'] });
    toOther(nodeOf(b));
    const opId = await startSwitch(b, { confirmed_environment_id: a });
    expect(op(opId).result).toMatchObject({ rejectGuard: { reason: 'external_profile', stage: 'not_attempted' } });
    expect(op(opId).error!.message).toContain(EXPOSURE);
    expect(writesOffWorking()).toEqual([]);
  });

  test('M-RG13b: the exposure sentence is in the guarded rollback text when the profile is unknown (CLI liveness, three identity failures), and not when Surge is unreachable', async () => {
    h = await createHarness({ livenessPrimitive: 'listExternalResources' });
    const { b } = await twoEnvs();
    const opId = await startSwitch(b);
    failProfileReads(during(() => opId), 3);
    await arrivalTimeout();
    expect(op(opId).result).toMatchObject({ rejectGuard: { reason: 'profile_unknown', stage: 'not_attempted' } });
    expect(lastStep(opId)).toContain(`回滚未完成：无法确认 Surge 当前配置是否是固定工作配置`);
    expect(lastStep(opId)).toContain(EXPOSURE);
    // 无法连接 Surge：没有迹象表明加载的是另一个配置，不写暴露说明（PG-T13 的情形）
    await h.close();
    h = await createHarness();
    const { b: b2 } = await twoEnvs();
    const op2 = await startSwitch(b2);
    const engine = h.app.engine;
    const origCtrl = engine.entryController.bind(engine);
    engine.entryController = ((owner: Parameters<typeof origCtrl>[0]) => {
      const c = origCtrl(owner);
      if (!c) return c;
      return new Proxy(c, {
        get(t, prop) {
          if (prop === 'transition') {
            return async (...args: Parameters<EntryController['transition']>) => {
              const rb = await t.transition(...args);
              if (args[0] === 'BLOCKED') h.fake.reachable = false;
              return rb;
            };
          }
          const v = Reflect.get(t, prop, t) as unknown;
          return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(t) : v;
        },
      });
    }) as typeof engine.entryController;
    await arrivalTimeout();
    expect(op(op2).result).toMatchObject({ rejectGuard: { reason: 'surge_unreachable', stage: 'not_attempted' } });
    expect(lastStep(op2)).not.toContain(EXPOSURE);
  });

  test('M-B1: fallback evidence, but Surge is unreachable when the rollback would reselect: not reselected, the text says SFE-ROUTE may have fallen back to REJECT on the working profile, nothing written', async () => {
    h = await createHarness();
    const { envId: a } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    rememberWorking();
    clearWrites();
    const selected = nodeOf(a);
    const upd = h.fake.updateExternalResource.bind(h.fake);
    let n = 0;
    h.fake.updateExternalResource = async (key: string) => {
      const r = await upd(key);
      n += 1;
      return r;
    };
    // 回滚的单 key 更新（第 2 次更新）之后，等待更新结束的读取看到空闲；紧接着 Surge 不可连接（改回原选择之前的核对）
    const ler = h.fake.listExternalResources.bind(h.fake);
    let cut = false;
    h.fake.listExternalResources = async () => {
      const r = await ler();
      if (n >= 2 && !cut) {
        cut = true;
        h.fake.reachable = false;
      }
      return r;
    };
    // 包在上面之外：它在第一次更新之后恢复成上面的包装
    dropNodesOnNextUpdate(h, [selected]);
    const b = await createEnv(h, 'US-Buyer-B', '203.0.113.11');
    await h.idle();
    expect(cut).toBe(true);
    expect(h.fake.selectionWrites).toEqual([]);
    const o = op(b.operation_id);
    expect(o.status).toBe('needs_attention');
    expect(o.error!.message).toContain('无法连接 Surge：选中的节点曾从成员中消失，固定工作配置中的 SFE-ROUTE 可能已回落到 REJECT，回滚没有改回原选择');
    // 无法连接 Surge：没有迹象表明加载的是另一个配置
    expect(o.error!.message).not.toContain('不改动其他配置中的同名组');
  });
});

describe('发布回滚时改回原选择的守卫短暂拒绝（B7）', () => {
  test('M-B7: 回滚更新之后 Surge 短暂切到另一份配置、读回之前回到工作配置：回滚说明写明选择可能已回落到 REJECT、没有改回，不归咎于外部修改', async () => {
    h = await createHarness();
    const { envId: a } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    rememberWorking();
    clearWrites();
    const selected = nodeOf(a);
    const orig = h.fake.updateExternalResource.bind(h.fake);
    let updates = 0;
    let armed = false;
    let flipped = false;
    h.fake.updateExternalResource = async (key: string) => {
      const r = await orig(key);
      updates += 1;
      // 第二次单 key 更新是回滚的更新：之后改回原选择之前的守卫读到另一份配置
      if (updates === 2) {
        toOther();
        armed = true;
      }
      return r;
    };
    // 第二次读取当前配置之后回到工作配置：改回原选择之前的守卫被拒绝，之后回滚的读回在工作配置上确认
    let reads = 0;
    const gcp = h.fake.getCurrentProfile.bind(h.fake);
    h.fake.getCurrentProfile = async () => {
      const r = await gcp();
      if (armed && ++reads >= 2) {
        armed = false;
        flipped = true;
        toWorking();
      }
      return r;
    };
    dropNodesOnNextUpdate(h, [selected]);
    const b = await createEnv(h, 'US-Buyer-B', '203.0.113.11');
    await h.idle();
    expect(flipped).toBe(true);
    const text = lastStep(b.operation_id);
    expect(text).toContain('可能已回落到 REJECT，回滚没有改回原选择');
    expect(text).not.toContain('在发布期间被外部修改');
    expect(writesOffWorking()).toEqual([]);
  });
});
