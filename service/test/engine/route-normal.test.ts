// 普通模式永远可用（docs/ARCHITECTURE.md §5.2、§6.5）：优先级问题、被外部修改的本应用入口文件、结束 Safari 连接失败
// 都不能让它卡在 BLOCKED。只撤销本应用入口，从不改成 DIRECT/FINAL、不重载、不切换配置。只用合成数据。

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { ENTRY_RULESET_FILES } from '@sfe/contract';
import { FAKE_SAFARI_PATH, FAKE_VERIFY_HOST } from '../../src/surge/fake.js';
import { tempRuleText } from '../../src/surge/generate.js';
import { PROFILE_A, WEB, activeEnv, bind, createEnv, createHarness, rid, safariOutcome, type Harness } from './harness.js';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

async function enterNormal(confirmed: string | null): Promise<string> {
  const req = confirmed ? { request_id: rid('normal'), old_session_policy: 'closed_confirmed' as const, confirmed_environment_id: confirmed } : { request_id: rid('normal') };
  const n = await h.app.enterNormal(req, WEB);
  await h.idle();
  return n.operation_id;
}

/**
 * temp_rule 下先激活一次再取消（条件互不相交的临时规则不论插入位置都能到达 VERIFY_ONLY；取消等待中的激活 → 回滚停在
 * BLOCKED，即 {block}），再模拟进程路径变化（例如 P0 更新后确认了新的路径，合成路径）：期望的规则文本随之改变，旧文本的
 * 记录仍在；一次中断的写入又留下了新文本 block 的意图记录 → 同一种有两条本应用规则（duplicate_block）。
 */
async function activateThenCancel(env: string): Promise<string> {
  const a = await h.app.activate(env, { request_id: rid() }, WEB);
  await h.idle();
  expect(h.repos.operations.get(a.operation_id)!.phase).toBe('VERIFY_ONLY');
  await h.app.cancelOperation(a.operation_id, { request_id: rid() }, WEB);
  await h.idle();
  return a.operation_id;
}

async function duplicateAfterPathChange(): Promise<{ env: string; paths: string[]; oldRules: string[]; oldUdp: string; oldBlock: string; newBlock: string }> {
  h = await createHarness({ entryStrategy: 'temp_rule' });
  const env = (await createEnv(h, 'US-Buyer-A', '203.0.113.10')).environment_id!;
  await bind(h, PROFILE_A, env);
  await activateThenCancel(env);
  expect(h.repos.routeState.get().entryMode).toBe('BLOCKED');
  const oldCfg = { processPaths: h.repos.settings.get('safariProcessPaths'), verifyHost: FAKE_VERIFY_HOST };
  const paths = [FAKE_SAFARI_PATH, '/Applications/Safari Technology Preview.app/Contents/MacOS/Safari Technology Preview'];
  const oldRules = h.fake.tempRules;
  expect(oldRules).toEqual([tempRuleText('block', oldCfg)]);
  h.repos.settings.set('safariProcessPaths', paths);
  const newBlock = tempRuleText('block', { processPaths: paths, verifyHost: FAKE_VERIFY_HOST });
  h.repos.managedObjects.upsertIntent({ kind: 'temp_rule', identity: newBlock, contentDigest: null, state: 'pending_add', createdByOperation: null });
  await h.fake.addTempRule(newBlock);
  return { env, paths, oldRules, oldUdp: tempRuleText('udp', oldCfg), oldBlock: tempRuleText('block', oldCfg), newBlock };
}

type CleanupRecord = { action: string; kind: string; rule: string };

/** 撤销清理逐条记入操作：结果 entryCleanup 与每条一个操作步骤（按顺序）。 */
function expectCleanupRecorded(opId: string, expected: CleanupRecord[]): string[] {
  const op = h.repos.operations.get(opId)!;
  expect((op.result as { entryCleanup?: CleanupRecord[] } | null)?.entryCleanup).toEqual(expected);
  const messages = h.repos.operations.listSteps(opId).map((st) => st.message);
  const cleanupSteps = messages.filter((m) => m.startsWith('撤销入口时逐条清理本应用的临时规则：'));
  const label = (c: CleanupRecord): string => (c.kind === 'unrecognized' ? '无法识别的规则' : c.kind);
  expect(cleanupSteps).toEqual(expected.map((c) => `撤销入口时逐条清理本应用的临时规则：${c.action === 'add' ? '加入' : '移除'} ${label(c)}「${c.rule}」（运行时读回确认）`));
  return messages;
}

function expectOriginalRules(): void {
  const route = h.repos.routeState.get();
  expect(route).toMatchObject({ entryMode: 'NORMAL', phase: 'idle', activeEnvironmentId: null });
  // 原规则：用户规则与 FINAL，不是本应用改成 DIRECT
  expect(safariOutcome(h, 'daily.example.test').policyName).toBe('Daily');
  expect(safariOutcome(h).rule).toBe('FINAL,DIRECT');
  expect(h.fake.calls.reloadProfile ?? 0).toBe(0);
}

describe('normal mode is always available (§5.2)', () => {
  test('a blocking module rule ahead of the entry does not stop normal mode (ruleset_resource)', async () => {
    h = await createHarness();
    const { envId } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    h.fake.setModuleRules([{ text: 'DOMAIN-SUFFIX,amazon.com,DIRECT', moduleName: 'user-module' }]);
    const opId = await enterNormal(envId);
    const op = h.repos.operations.get(opId)!;
    expect(op.phase).toBe('NORMAL_RESTORED');
    expect((op.result as { precedenceIssues: Array<{ severity: string }> }).precedenceIssues.some((i) => i.severity === 'blocking')).toBe(true);
    expect(h.repos.operations.listSteps(opId).some((s) => s.message.includes('排在本应用入口之前'))).toBe(true);
    expectOriginalRules();
    // 从不停用或修改用户模块
    expect(safariOutcome(h, 'www.amazon.com').rule).toBe('DOMAIN-SUFFIX,amazon.com,DIRECT');
  });

  test('a blocking module rule does not stop normal mode from a BLOCKED entry (temp_rule)', async () => {
    h = await createHarness({ entryStrategy: 'temp_rule' });
    const env = (await createEnv(h, 'US-Buyer-A', '203.0.113.10')).environment_id!;
    await bind(h, PROFILE_A, env);
    // 取消等待中的激活：回滚停在 BLOCKED（没有切换前的路由）
    const a = await activateThenCancel(env);
    expect(h.repos.routeState.get().entryMode).toBe('BLOCKED');
    h.fake.setModuleRules([{ text: 'DOMAIN-SUFFIX,amazon.com,DIRECT', moduleName: 'user-module' }]);
    const opId = await enterNormal(null);
    expect(h.repos.operations.get(opId)!.phase).toBe('NORMAL_RESTORED');
    expectOriginalRules();
    expect(h.fake.tempRules).toEqual([]);
    void a;
  });

  test('duplicate app-owned temp rules after a process path change do not stop normal mode (temp_rule)', async () => {
    const { oldRules, oldBlock, newBlock } = await duplicateAfterPathChange();
    const opId = await enterNormal(null);
    const op = h.repos.operations.get(opId)!;
    expect(op.error).toBeNull();
    expect(op.phase).toBe('NORMAL_RESTORED');
    expectOriginalRules();
    expect(h.fake.tempRules).toEqual([]);
    // 第一次激活加入又移除了 udp、verify、blockOther（VERIFY_ONLY 的规则），记录都已是 removed
    const oldCfg = { processPaths: [FAKE_SAFARI_PATH], verifyHost: FAKE_VERIFY_HOST };
    expect(h.repos.managedObjects.listByKind('temp_rule').map((r) => [r.identity, r.state]).sort()).toEqual(
      [...oldRules, newBlock, ...(['udp', 'verify', 'blockOther'] as const).map((k) => tempRuleText(k, oldCfg))].map((t) => [t, 'removed']).sort(),
    );
    // 移除了哪些本应用规则记入操作（结果与步骤），不只在入口读回的证据里
    expectCleanupRecorded(opId, [{ action: 'remove', kind: 'block', rule: oldBlock }]);
  });

  test('a rollback that cleans up duplicate app-owned temp rules keeps Safari blocked and records each removal in the operation (temp_rule)', async () => {
    const { env, oldBlock, newBlock } = await duplicateAfterPathChange();
    // 再次激活：第 6 步（未标为撤销）以 UNKNOWN_STATE 拒绝 → 回滚（撤销到 BLOCKED）逐条清理并保持阻断
    const a = await h.app.activate(env, { request_id: rid() }, WEB);
    await h.idle();
    const op = h.repos.operations.get(a.operation_id!)!;
    expect(op.phase).toBe('FAILED');
    expect(op.error!.code).toBe('UNKNOWN_STATE');
    expect(h.repos.routeState.get().entryMode).toBe('BLOCKED');
    // BLOCKED 只需要匹配 Safari 全部流量的 block（当前进程路径）
    expect(h.fake.tempRules).toEqual([newBlock]);
    for (const protocol of ['tcp', 'udp'] as const) {
      const r = safariOutcome(h, 'www.example.test', protocol);
      expect(r.failed && r.policyName?.startsWith('REJECT')).toBe(true);
    }
    const messages = expectCleanupRecorded(a.operation_id!, [{ action: 'remove', kind: 'block', rule: oldBlock }]);
    // 步骤顺序：开始回滚 → 逐条清理 → 回滚结束（Safari 保持阻断）
    const rollbackAt = messages.findIndex((m) => m.includes('开始回滚'));
    const cleanupAt = messages.findIndex((m) => m.startsWith('撤销入口时逐条清理本应用的临时规则：'));
    const failedAt = messages.findIndex((m) => m.includes('Safari 保持阻断'));
    expect(rollbackAt).toBeGreaterThanOrEqual(0);
    expect(cleanupAt).toBeGreaterThan(rollbackAt);
    expect(failedAt).toBeGreaterThan(cleanupAt);
    expect(h.fake.calls.reloadProfile ?? 0).toBe(0);
  });

  test('an externally edited app-owned entry file is overwritten toward NORMAL; managed_segments_changed is kept', async () => {
    h = await createHarness();
    const { envId } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const file = join(h.surgeDir, ENTRY_RULESET_FILES.active);
    appendFileSync(file, '# note\n');
    const opId = await enterNormal(envId);
    const op = h.repos.operations.get(opId)!;
    expect(op.phase).toBe('NORMAL_RESTORED');
    expectOriginalRules();
    expect(readFileSync(file, 'utf8')).not.toContain('# note');
    expect(h.repos.routeState.get().warnings).toContain('managed_segments_changed');
    // 本应用记录与改写后的文件一致；maintenance.remerge 的入口前提（NORMAL）已满足
    const rec = h.repos.managedObjects.get('entry_ruleset_file', ENTRY_RULESET_FILES.active)!;
    expect(rec.state).toBe('present');
    expect(rec.contentDigest).toBe(await h.files.digest(ENTRY_RULESET_FILES.active));
    // 改写之后已重新一致：空闲时的下一次对账清除警告（不粘到下一次激活）
    await h.app.refreshSurge(WEB);
    expect(h.repos.routeState.get().warnings).not.toContain('managed_segments_changed');
  });

  test('managed_segments_changed kept by normal mode clears in idle/NORMAL once the segments are restored, not before', async () => {
    h = await createHarness();
    const { envId } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const original = readFileSync(h.profilePath, 'utf8');
    writeFileSync(h.profilePath, original.replace('SFE-ROUTE = select, REJECT, policy-path=sfe-nodes.list', 'SFE-ROUTE = select, REJECT, DIRECT, policy-path=sfe-nodes.list'));
    await h.app.runPeriodicReconcile();
    expect(h.repos.routeState.get().warnings).toContain('managed_segments_changed');
    const opId = await enterNormal(envId);
    expect(h.repos.operations.get(opId)!.phase).toBe('NORMAL_RESTORED');
    expectOriginalRules();
    expect(h.repos.routeState.get().warnings).toEqual(['managed_segments_changed']);
    // 受管理段仍被改动：保留
    await h.app.refreshSurge(WEB);
    expect(h.repos.routeState.get().warnings).toEqual(['managed_segments_changed']);
    // 恢复受管理段（例如经 maintenance.remerge）之后清除；路由保持 idle/NORMAL，不写 Surge
    writeFileSync(h.profilePath, original);
    const updates = h.fake.calls.updateExternalResource ?? 0;
    await h.app.refreshSurge(WEB);
    expect(h.repos.routeState.get()).toMatchObject({ phase: 'idle', entryMode: 'NORMAL', warnings: [] });
    expect(h.fake.calls.updateExternalResource ?? 0).toBe(updates);
    const rec = h.repos.operations.listRecent(50).find((o) => o.kind === 'maintenance.reconcile' && (o.payload as { removed?: string[] }).removed !== undefined)!;
    expect((rec.payload as { removed: string[] }).removed).toEqual(['managed_segments_changed']);
  });

  test('app temp rules removed while Surge keeps running (not a restart): normal mode writes nothing but still ends the live Safari connection on the buyer exit (temp_rule)', async () => {
    h = await createHarness({ entryStrategy: 'temp_rule' });
    const { envId } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    expect(h.repos.routeState.get().entryMode).toBe('ACTIVE');
    const live = h.fake.simulateRequest({ processPath: FAKE_SAFARI_PATH, host: 'www.example.test', protocol: 'tcp', longLived: true });
    expect(live.policyName).toBe('SFE-ROUTE');
    // 别的工具在 Surge 运行中移除了本应用的临时规则（例如 `rule temp remove` 或 `rule temp flush`），没有重启
    for (const rule of h.fake.tempRules) await h.fake.removeTempRule(rule);
    expect(h.fake.tempRules).toEqual([]);
    expect((await h.fake.listActiveRequests()).some((r) => r.id === live.id)).toBe(true);
    const writes = { add: h.fake.calls.addTempRule ?? 0, remove: h.fake.calls.removeTempRule ?? 0, kill: h.fake.calls.killRequest ?? 0 };
    const opId = await enterNormal(envId);
    const op = h.repos.operations.get(opId)!;
    expect(op.phase).toBe('NORMAL_RESTORED');
    // 不需要阻断、不写入临时规则；旧连接照常结束，不再留在买家出口上
    expect({ add: h.fake.calls.addTempRule ?? 0, remove: h.fake.calls.removeTempRule ?? 0 }).toEqual({ add: writes.add, remove: writes.remove });
    expect(h.fake.calls.killRequest ?? 0).toBe(writes.kill + 1);
    expect((await h.fake.listActiveRequests()).some((r) => r.id === live.id)).toBe(false);
    expect((op.result as { killResults: Array<{ surgeRequestId: string; ok: boolean }> }).killResults).toEqual([expect.objectContaining({ surgeRequestId: live.id, ok: true })]);
    const messages = h.repos.operations.listSteps(opId).map((st) => st.message);
    expect(messages.some((m) => m.includes('不需要阻断，未写入；仍结束 Safari 的旧连接'))).toBe(true);
    expect(messages.some((m) => m.startsWith('已结束 Safari 连接 1 条'))).toBe(true);
    expectOriginalRules();
  });

  test('…and an earlier attempt already normalized ownership without ending connections: the retry whose first readback is NORMAL still ends the live Safari connection (temp_rule)', async () => {
    h = await createHarness({ entryStrategy: 'temp_rule' });
    const { envId } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const live = h.fake.simulateRequest({ processPath: FAKE_SAFARI_PATH, host: 'www.example.test', protocol: 'tcp', longLived: true });
    expect(live.policyName).toBe('SFE-ROUTE');
    for (const rule of h.fake.tempRules) await h.fake.removeTempRule(rule);
    // 第一次尝试：中间阻断按事实确认归属（全部本应用记录标为已移除）之后，下一次读取有效规则失败一次（服务在此崩溃同理）
    const listRules = h.fake.listRules.bind(h.fake);
    let armed = true;
    h.fake.listRules = async () => {
      if (armed && h.repos.managedObjects.listByKind('temp_rule').every((r) => r.state === 'removed')) {
        armed = false;
        throw new Error('模拟失败：读取有效规则');
      }
      return listRules();
    };
    const kills = h.fake.calls.killRequest ?? 0;
    const first = await enterNormal(envId);
    expect(h.repos.operations.get(first)!.phase).toBe('FAILED');
    expect(h.repos.routeState.get()).toMatchObject({ activeEnvironmentId: envId });
    expect(h.repos.routeState.get().entryMode).not.toBe('NORMAL');
    expect(h.fake.calls.killRequest ?? 0).toBe(kills);
    // 重试：控制器已看不到本应用记录，第一次读回就是 NORMAL；路由记录仍是托管状态，照常结束旧连接
    const opId = await enterNormal(envId);
    const op = h.repos.operations.get(opId)!;
    expect(op.phase).toBe('NORMAL_RESTORED');
    expect(h.fake.calls.killRequest ?? 0).toBe(kills + 1);
    expect((await h.fake.listActiveRequests()).some((r) => r.id === live.id)).toBe(false);
    expect((op.result as { killResults: Array<{ surgeRequestId: string; ok: boolean }> }).killResults).toEqual([expect.objectContaining({ surgeRequestId: live.id, ok: true })]);
    expect(h.repos.operations.listSteps(opId).some((st) => st.message.includes('仍结束 Safari 的旧连接'))).toBe(true);
    expectOriginalRules();
    // 已在普通模式（空闲、没有使用中的环境）时再次进入普通模式：不结束按原规则发出的 Safari 连接
    const direct = h.fake.simulateRequest({ processPath: FAKE_SAFARI_PATH, host: 'www.example.test', protocol: 'tcp', longLived: true });
    expect(direct.policyName).not.toBe('SFE-ROUTE');
    const again = await enterNormal(null);
    expect(h.repos.operations.get(again)!.phase).toBe('NORMAL_RESTORED');
    expect(h.fake.calls.killRequest ?? 0).toBe(kills + 1);
    expect((await h.fake.listActiveRequests()).some((r) => r.id === direct.id)).toBe(true);
  });

  test('a watcher slower than the entry wait for the whole normal mode (ruleset_resource): retries keep what was written and normal mode finishes', async () => {
    h = await createHarness();
    const { envId } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    // 假 Surge 的监视延迟（假时钟 60 秒）一直高于入口等待上限（40 毫秒）：每一步都超时；两次尝试之间监视赶上
    h.fake.localWatchLatencyMs = 60_000;
    const phases: string[] = [];
    let last = '';
    for (let i = 0; i < 8; i++) {
      last = await enterNormal(envId);
      phases.push(h.repos.operations.get(last)!.phase);
      if (phases.at(-1) === 'NORMAL_RESTORED') break;
      // 失败时 Safari 不会比已确认的状态更宽松，也从不被当作 NORMAL
      expect(h.repos.routeState.get()).toMatchObject({ phase: 'failed', activeEnvironmentId: envId });
      expect(h.repos.routeState.get().entryMode).not.toBe('NORMAL');
      h.clock.advance(120_000);
    }
    // ACTIVE → BLOCKED（block+、active-，收紧，超时保留）→ NORMAL（udp-、block-，撤销中放宽，超时同样保留）→ 按见证确认
    expect(phases).toEqual(['FAILED', 'FAILED', 'FAILED', 'FAILED', 'NORMAL_RESTORED']);
    // 完成的那一次：上一次保留的 block- 已由见证确认加载，入口已是普通模式。四条 RULE-SET 仍在有效规则中，步骤按 ruleset_resource
    // 的事实写明（入口文件已全部为占位规则），不写 temp_rule 的“Surge 中没有本应用的入口规则”
    expect((await h.fake.listRules()).filter((r) => /^RULE-SET,sfe-entry-/.test(r.text))).toHaveLength(4);
    const already = h.repos.operations.listSteps(last).map((st) => st.message).filter((m) => m.startsWith('入口已是普通模式'));
    expect(already).toEqual([expect.stringContaining('入口规则集文件已全部为占位规则，见证与运行时探测读回确认 Surge 已加载')]);
    expect(already[0]).not.toContain('Surge 中没有本应用的入口规则');
    expectOriginalRules();
    expect(safariOutcome(h, 'www.example.test', 'udp').rule).toBe('FINAL,DIRECT');
    expect(h.fake.calls.updateExternalResource ?? 0).toBe(0);
  });

  test('…retried every 30 s while the watcher needs 60 s (ruleset_resource): no retry re-tightens a kept udp-/block-, normal mode finishes and each failure says to wait for the watcher', async () => {
    h = await createHarness();
    const { envId } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    h.fake.localWatchLatencyMs = 60_000;
    const ops: string[] = [];
    for (let i = 0; i < 14; i++) {
      ops.push(await enterNormal(envId));
      const op = h.repos.operations.get(ops.at(-1)!)!;
      if (op.phase === 'NORMAL_RESTORED') break;
      expect(h.repos.routeState.get()).toMatchObject({ phase: 'failed', activeEnvironmentId: envId });
      expect(h.repos.routeState.get().entryMode).not.toBe('NORMAL');
      expect(op.error?.message).toContain('请等 Surge 的文件监视加载之后再重试');
      h.clock.advance(30_000);
    }
    const failures = ops.map((id) => h.repos.operations.get(id)!).filter((o) => o.phase === 'FAILED');
    expect(ops.map((id) => h.repos.operations.get(id)!.phase)).toEqual([...failures.map(() => 'FAILED'), 'NORMAL_RESTORED']);
    // 进入 NORMAL 一段之后（第一次保留 udp-）不再有收紧的一步：不在两段之间来回写入
    const details = failures.map((o) => o.error!.details as { failedStep: { bit: string; value: boolean }; keptTowardTarget?: boolean; keptStricter?: boolean });
    const firstToward = details.findIndex((d) => d.keptTowardTarget === true);
    expect(firstToward).toBeGreaterThan(0);
    expect(details.slice(firstToward).every((d) => d.keptTowardTarget === true && d.failedStep.value === false)).toBe(true);
    expect(failures.length).toBeLessThanOrEqual(8);
    // block- 尚未加载的那次重试不宣称已阻断
    const heldOff = failures.filter((o) => h.repos.operations.listSteps(o.id).some((st) => st.message.includes('上一次保留的 block 关闭尚未确认加载')));
    expect(heldOff.length).toBeGreaterThan(0);
    for (const o of heldOff) expect(h.repos.operations.listSteps(o.id).some((st) => st.message.startsWith('已阻断 Safari 新请求'))).toBe(false);
    expectOriginalRules();
    expect(safariOutcome(h, 'www.example.test', 'udp').rule).toBe('FINAL,DIRECT');
    expect(h.fake.calls.updateExternalResource ?? 0).toBe(0);
  });

  test('…with a blocking module rule ahead of the entry: the retry whose intermediate block is already in force (udp off) reports the rule and goes on', async () => {
    h = await createHarness();
    const { envId } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    h.fake.setModuleRules([{ text: 'DOMAIN-SUFFIX,amazon.com,DIRECT', moduleName: 'user-module' }]);
    h.fake.localWatchLatencyMs = 60_000;
    const ops: string[] = [];
    for (let i = 0; i < 8; i++) {
      ops.push(await enterNormal(envId));
      if (h.repos.operations.get(ops.at(-1)!)!.phase === 'NORMAL_RESTORED') break;
      h.clock.advance(120_000);
    }
    expect(ops.map((id) => h.repos.operations.get(id)!.phase)).toEqual(['FAILED', 'FAILED', 'FAILED', 'FAILED', 'NORMAL_RESTORED']);
    // 第四次：中间阻断已成立（block 开、udp 已关），不写入，排在入口之前的规则照样记入结果，继续撤销入口
    const fourth = h.repos.operations.get(ops[3]!)!;
    expect((fourth.result as { precedenceIssues: Array<{ rule: string; severity: string }> }).precedenceIssues).toContainEqual(
      expect.objectContaining({ rule: 'DOMAIN-SUFFIX,amazon.com,DIRECT', severity: 'blocking' }),
    );
    expect(h.repos.operations.listSteps(ops[3]!).some((s) => s.message.includes('排在本应用入口之前'))).toBe(true);
    expectOriginalRules();
    expect(safariOutcome(h, 'www.amazon.com').rule).toBe('DOMAIN-SUFFIX,amazon.com,DIRECT');
  });

  test('best-effort kill: listing active requests fails → recorded, normal mode still completes', async () => {
    h = await createHarness();
    const { envId } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    h.revoke(['safari_process_attribution']);
    h.fake.simulateRequest({ processPath: FAKE_SAFARI_PATH, host: 'www.example.test', protocol: 'tcp', longLived: true });
    h.fake.failNext('listActiveRequests');
    const opId = await enterNormal(envId);
    const op = h.repos.operations.get(opId)!;
    expect(op.phase).toBe('NORMAL_RESTORED');
    expect(op.result).toMatchObject({ killBestEffort: true, killError: { code: 'SURGE_COMMAND_FAILED' } });
    expect(h.repos.operations.listSteps(opId).some((s) => s.message.includes('未能确认结束 Safari 连接'))).toBe(true);
    expectOriginalRules();
  });

  test('strict kill: a connection that cannot be ended is reported, normal mode still completes', async () => {
    h = await createHarness();
    const { envId } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const live = h.fake.simulateRequest({ processPath: FAKE_SAFARI_PATH, host: 'www.example.test', protocol: 'tcp', longLived: true });
    h.fake.failNext('killRequest');
    const opId = await enterNormal(envId);
    const op = h.repos.operations.get(opId)!;
    expect(op.phase).toBe('NORMAL_RESTORED');
    const result = op.result as { killBestEffort: boolean; killResults: Array<{ surgeRequestId: string; ok: boolean }>; killError: { code: string } };
    expect(result.killBestEffort).toBe(false);
    expect(result.killResults).toEqual([expect.objectContaining({ surgeRequestId: live.id, ok: false })]);
    expect(result.killError.code).toBe('READBACK_MISMATCH');
    expectOriginalRules();
  });
});
