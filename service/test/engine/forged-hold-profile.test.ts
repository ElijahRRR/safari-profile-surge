// 节点可能被伪造时的 REJECT 保持（route.hold，用户决定 D11）在崩溃恢复中的配置身份核对（docs/ARCHITECTURE.md §6.6「执行」第 1 步）：
// 改选意图属于固定工作配置；Surge 不可连接、当前不是固定工作配置或无法确认当前配置时，不把读到的 REJECT 记为本操作的改选、
// 不改动其他配置中的同名组；回到固定工作配置之后由对账核对并记下中断之前的改选。只用合成数据（文档地址、example.test）。

import { afterEach, expect, test } from 'vitest';
import { ROUTE_GROUP_NAME, SfeError } from '@sfe/contract';
import type { OperationRecord } from '../../src/db/index.js';
import { runForgedHold } from '../../src/engine/handlers/route.js';
import { maybeEnqueueForgedHold } from '../../src/engine/node-resource.js';
import { PENDING_HOLD_KEY } from '../../src/engine/pending-hold.js';
import type { SurgeProfileInfo } from '../../src/ports.js';
import { PROFILE_A, WEB, activeEnv, createHarness, rid, type Harness, type HarnessOptions } from './harness.js';
import { hangAt, until } from './publish-helpers.js';

const G = ROUTE_GROUP_NAME;
let h: Harness;
afterEach(async () => {
  await h?.close();
});

const other = (): SurgeProfileInfo => ({ name: 'Other', path: `${h.surgeDir}/Other.conf` });
const op = (id: string): OperationRecord => h.repos.operations.get(id)!;
const steps = (id: string): string => h.repos.operations.listSteps(id).map((s) => s.message).join('\n');
const holds = (): OperationRecord[] => h.repos.operations.listRecent(500).filter((o) => o.kind === 'route.hold').reverse();
const nodeOf = (envId: string): string => h.repos.proxyRevisions.get(envId, 1)!.nodeName;

test('H1: recovered hold must not attribute another profile REJECT to its saved intent', async () => {
  h = await createHarness();
  await activeEnv(h, 'Synthetic-A', '203.0.113.10', PROFILE_A);
  await h.app.stop();
  const before = h.repos.routeState.get();
  h.app.engine.kv.set('resource:forgedNodes', { since: h.clock.now().toISOString(), reasons: ['unexplained_fetch'] });
  const pending = h.repos.operations.insert({
    id: 'op_profile_hold',
    requestId: rid('profile-hold'),
    requestDigest: 'service',
    kind: 'route.hold',
    initiatorKind: 'service',
    status: 'running',
    phase: 'VALIDATING',
    payload: { forgedHold: { reasons: ['unexplained_fetch'] }, endHold: { externalSelectionBefore: false, cause: 'node_resource_forged' } },
  });
  // 记下的意图属于固定工作配置；假 Surge 现在报告另一个配置，它的同名组选着 REJECT
  h.fake.currentProfile = other();
  h.fake.setSelectionFor(other(), G, 'REJECT');
  const writes = h.fake.selectionWrites.length;
  await runForgedHold(h.app.engine, pending, { recovering: true });
  const result = op(pending.id);
  expect(result).toMatchObject({ status: 'failed', error: { code: 'EXTERNAL_PROFILE' } });
  expect(result.result?.rejectSelected).not.toBe(true);
  expect(result.error!.details).toMatchObject({ rejectSelected: false, rejectGuard: { reason: 'external_profile', stage: 'interrupted' } });
  expect(steps(pending.id)).toContain('无法确认中断之前是否已在固定工作配置上改选 REJECT');
  expect(steps(pending.id)).not.toContain('：没有改选');
  expect(h.repos.routeState.get().selectedNode).toBe(before.selectedNode);
  expect(h.repos.routeState.get().warnings).toContain('buyer_exit_connections_unconfirmed');
  expect(h.app.engine.kv.get(PENDING_HOLD_KEY)).toMatchObject({ kind: 'intent', operationId: pending.id, cause: 'node_resource_forged' });
  // 不能确认是固定工作配置的保持不受重试间隔限制（回到固定工作配置之后立即再核对）
  expect(h.app.engine.kv.get('resource:forgedHold')).toMatchObject({ unreachable: true });
  expect(h.fake.selectionWrites.length).toBe(writes);
});

/** 保持记下意图、改选 REJECT 已在固定工作配置上生效，之后服务在记下之前崩溃（挂在改选调用中）。 */
async function holdAppliedThenStuck(opts: HarnessOptions = {}): Promise<{ envId: string; holdId: string; working: SurgeProfileInfo }> {
  h = await createHarness({ dbFile: true, ...opts });
  const { envId } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
  const working = { ...h.fake.currentProfile };
  h.app.engine.kv.set('resource:forgedNodes', { since: h.clock.now().toISOString(), reasons: ['unexplained_fetch'] });
  const stuck = hangAt(h, 'selectGroupPolicy', 1);
  const hold = maybeEnqueueForgedHold(h.app.engine);
  expect(hold).not.toBeNull();
  await until(stuck.reached);
  expect(h.fake.selectionFor('home', G)).toBe('REJECT');
  stuck.restore();
  expect(op(hold!.id)).toMatchObject({ status: 'running', payload: { endHold: { cause: 'node_resource_forged' } } });
  return { envId, holdId: hold!.id, working };
}

/** 读当前配置在恢复中的保持执行时失败 times 次（启动对账照常）。 */
function failProfileReadsInHold(holdId: string, times: number): { hits: () => number } {
  const orig = h.fake.getCurrentProfile.bind(h.fake);
  let left = times;
  let hits = 0;
  h.fake.getCurrentProfile = async () => {
    if (left > 0 && h.app.executor.currentOperationId === holdId) {
      left -= 1;
      hits += 1;
      throw new SfeError('SURGE_COMMAND_FAILED', '读取当前配置失败：模拟失败');
    }
    return orig();
  };
  return { hits: () => hits };
}

test('H2: F1 round trip: recovery on another profile ends interrupted (no credit, no external change); back on the working profile the own REJECT is credited', async () => {
  const { envId, holdId, working } = await holdAppliedThenStuck();
  h.fake.currentProfile = other();
  h.fake.setSelectionFor(other(), G, nodeOf(envId));
  await h.crash();
  await h.idle();
  expect(holds()).toHaveLength(1);
  expect(op(holdId)).toMatchObject({ status: 'failed', error: { code: 'EXTERNAL_PROFILE' } });
  expect(steps(holdId)).toContain('无法确认中断之前是否已在固定工作配置上改选 REJECT');
  expect(h.repos.routeState.get().warnings).not.toContain('external_selection_change');
  h.fake.currentProfile = working;
  await h.app.runPeriodicReconcile();
  await h.idle();
  const route = h.repos.routeState.get();
  expect(route.selectedNode).toBe('REJECT');
  expect(route.warnings).not.toContain('external_selection_change');
  expect(h.app.views.environmentView(envId)!.nextActions[0]?.message).toContain('SFE-ROUTE 当前是 REJECT');
  expect(h.app.engine.kv.get('resource:forgedHold')).toBeNull();
  expect(steps(holdId)).toContain('与中断之前本操作记下的改选意图一致：按本应用的改选记下，不当作外部修改');
  expect(holds()).toHaveLength(1);
  expect(h.fake.selectionWrites.filter((w) => !w.home)).toEqual([]);
});

test('H3: the same round trip with Surge unreachable during recovery (SURGE_UNREACHABLE)', async () => {
  const { envId, holdId } = await holdAppliedThenStuck();
  h.fake.reachable = false;
  await h.crash();
  await h.idle();
  expect(holds()).toHaveLength(1);
  expect(op(holdId)).toMatchObject({ status: 'failed', error: { code: 'SURGE_UNREACHABLE' } });
  expect(steps(holdId)).toContain('无法确认中断之前是否已在固定工作配置上改选 REJECT（无法连接 Surge');
  h.fake.reachable = true;
  await h.app.runPeriodicReconcile();
  await h.idle();
  const route = h.repos.routeState.get();
  expect(route.selectedNode).toBe('REJECT');
  expect(route.warnings).not.toContain('external_selection_change');
  expect(h.app.views.environmentView(envId)!.nextActions[0]?.message).toContain('SFE-ROUTE 当前是 REJECT');
  expect(holds()).toHaveLength(1);
});

test('H4: F2: intent applied on the working profile, a queued normal, the profile unknown during recovery → SUPERSEDED with an intent-aware text, no select', async () => {
  const { envId, holdId } = await holdAppliedThenStuck({ livenessPrimitive: 'listPolicies' });
  const n = await h.app.enterNormal({ request_id: rid('normal'), old_session_policy: 'closed_confirmed', confirmed_environment_id: envId }, WEB);
  const f = failProfileReadsInHold(holdId, 3);
  const writes = h.fake.selectionWrites.length;
  await h.crash();
  await h.idle();
  expect(f.hits()).toBe(3);
  expect(op(holdId)).toMatchObject({ phase: 'SUPERSEDED', status: 'superseded', supersededBy: n.operation_id });
  expect(steps(holdId)).not.toContain('没有改选 SFE-ROUTE');
  expect(steps(holdId)).toContain('中断之前可能已在固定工作配置上改选 REJECT');
  expect(h.fake.selectionFor('home', G)).toBe('REJECT');
  expect(h.fake.selectionWrites.length).toBe(writes);
});

test('H5: F5(a): another profile, an intent and a queued normal → SUPERSEDED, no select, the intent-aware text', async () => {
  const { envId, holdId } = await holdAppliedThenStuck();
  const n = await h.app.enterNormal({ request_id: rid('normal'), old_session_policy: 'closed_confirmed', confirmed_environment_id: envId }, WEB);
  h.fake.currentProfile = other();
  const writes = h.fake.selectionWrites.length;
  await h.crash();
  await h.idle();
  expect(op(holdId)).toMatchObject({ phase: 'SUPERSEDED', status: 'superseded', supersededBy: n.operation_id });
  expect(steps(holdId)).toContain('中断之前可能已在固定工作配置上改选 REJECT（Surge 当前配置不是固定工作配置，无法核对）');
  expect(h.fake.selectionWrites.length).toBe(writes);
});

test('H6 (pin): F5(b): working profile, applied intent, a queued normal → the hold records its own REJECT before the normal mode runs', async () => {
  const { envId, holdId } = await holdAppliedThenStuck();
  const n = await h.app.enterNormal({ request_id: rid('normal'), old_session_policy: 'closed_confirmed', confirmed_environment_id: envId }, WEB);
  await h.crash();
  await h.idle();
  // 意图的读回排在让给排队普通模式之前：结束为本操作的改选（不是 SUPERSEDED），之后普通模式照常完成
  expect(op(holdId)).toMatchObject({ phase: 'COMPLETED', status: 'succeeded', result: { rejectSelected: true } });
  expect(op(holdId).supersededBy).toBeNull();
  expect(op(n.operation_id).phase).toBe('NORMAL_RESTORED');
});

test('H7: F5(c): the profile read fails three times inside the recovered hold (first identity check exhausted), no normal → step 4 re-reads it and the own REJECT is recorded; no lingering external_selection_change', async () => {
  const { holdId } = await holdAppliedThenStuck({ livenessPrimitive: 'listPolicies' });
  const f = failProfileReadsInHold(holdId, 3);
  await h.crash();
  await h.idle();
  expect(f.hits()).toBe(3);
  expect(op(holdId)).toMatchObject({ phase: 'COMPLETED', status: 'succeeded', result: { rejectSelected: true } });
  const route = h.repos.routeState.get();
  expect(route.selectedNode).toBe('REJECT');
  expect(route.warnings).not.toContain('external_selection_change');
});

test('H8 (T7): amendment 8(c): an unresolved intent with the forged marker cleared during recovery ends interrupted (not 「不需要改选」); back on the working profile the own REJECT is credited', async () => {
  const { holdId, working } = await holdAppliedThenStuck();
  h.fake.currentProfile = other();
  h.fake.setSelectionFor(other(), G, 'REJECT');
  // 启动时经确认的读回清除了伪造状态（原因不含 node_detail_mismatch）
  h.app.engine.kv.delete('resource:forgedNodes');
  const writes = h.fake.selectionWrites.length;
  await h.crash();
  await h.idle();
  expect(op(holdId)).toMatchObject({ status: 'failed', error: { code: 'EXTERNAL_PROFILE' } });
  expect(steps(holdId)).toContain('无法确认中断之前是否已在固定工作配置上改选 REJECT');
  expect(steps(holdId)).not.toContain('不需要改选');
  expect(h.app.engine.kv.get(PENDING_HOLD_KEY)).toMatchObject({ kind: 'intent', operationId: holdId });
  expect(h.fake.selectionWrites.length).toBe(writes);
  h.fake.currentProfile = working;
  await h.app.runPeriodicReconcile();
  await h.idle();
  expect(h.repos.routeState.get().selectedNode).toBe('REJECT');
  expect(steps(holdId)).toContain('与中断之前本操作记下的改选意图一致：按本应用的改选记下');
  expect(h.fake.selectionWrites.filter((w) => !w.home)).toEqual([]);
});

test('PG-T5: while Surge is still on another profile, the next action for an interrupted forged hold does not claim the select failed or never ran', async () => {
  const { envId, holdId } = await holdAppliedThenStuck();
  h.fake.currentProfile = other();
  h.fake.setSelectionFor(other(), G, nodeOf(envId));
  await h.crash();
  await h.idle();
  expect(op(holdId).error!.details).toMatchObject({ rejectGuard: { stage: 'interrupted' } });
  // 固定工作配置上 REJECT 其实已生效
  expect(h.fake.selectionFor('home', G)).toBe('REJECT');
  const message = h.app.views.environmentView(envId)!.nextActions[0]!.message;
  expect(message).toContain('SFE-ROUTE 尚未在固定工作配置上确认改选 REJECT');
  expect(message).toContain('无法确认中断之前或改选期间的改选');
  expect(message).not.toContain('（改选失败或尚未执行）');
});
