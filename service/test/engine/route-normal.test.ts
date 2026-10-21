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
 * temp_rule 下先激活一次（尾部插入无法到达 VERIFY_ONLY：停在 BLOCKED），再模拟进程路径变化（例如 P0 更新后确认了新的
 * 路径，合成路径）：期望的规则文本随之改变，旧文本的记录仍在；一次中断的写入又留下了新文本 block 的意图记录 → 同一位有
 * 两条本应用规则（duplicate_block）。
 */
async function duplicateAfterPathChange(): Promise<{ env: string; paths: string[]; oldRules: string[]; oldUdp: string; oldBlock: string; newBlock: string }> {
  h = await createHarness({ entryStrategy: 'temp_rule' });
  const env = (await createEnv(h, 'US-Buyer-A', '203.0.113.10')).environment_id!;
  await bind(h, PROFILE_A, env);
  await h.app.activate(env, { request_id: rid() }, WEB);
  await h.idle();
  expect(h.repos.routeState.get().entryMode).toBe('BLOCKED');
  const oldCfg = { processPaths: h.repos.settings.get('safariProcessPaths'), verifyHost: FAKE_VERIFY_HOST };
  const paths = [FAKE_SAFARI_PATH, '/Applications/Safari Technology Preview.app/Contents/MacOS/Safari Technology Preview'];
  const oldRules = h.fake.tempRules;
  expect([...oldRules].sort()).toEqual([tempRuleText('udp', oldCfg), tempRuleText('block', oldCfg)].sort());
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
    // temp_rule 尾部插入无法到达 VERIFY_ONLY：激活失败并停在 BLOCKED（没有切换前的路由）
    const a = await h.app.activate(env, { request_id: rid() }, WEB);
    await h.idle();
    expect(h.repos.routeState.get().entryMode).toBe('BLOCKED');
    h.fake.setModuleRules([{ text: 'DOMAIN-SUFFIX,amazon.com,DIRECT', moduleName: 'user-module' }]);
    const opId = await enterNormal(null);
    expect(h.repos.operations.get(opId)!.phase).toBe('NORMAL_RESTORED');
    expectOriginalRules();
    expect(h.fake.tempRules).toEqual([]);
    void a;
  });

  test('duplicate app-owned temp rules after a process path change do not stop normal mode (temp_rule)', async () => {
    const { paths, oldRules, oldUdp, oldBlock, newBlock } = await duplicateAfterPathChange();
    const opId = await enterNormal(null);
    const op = h.repos.operations.get(opId)!;
    expect(op.error).toBeNull();
    expect(op.phase).toBe('NORMAL_RESTORED');
    expectOriginalRules();
    expect(h.fake.tempRules).toEqual([]);
    expect(h.repos.managedObjects.listByKind('temp_rule').map((r) => [r.identity, r.state]).sort()).toEqual(
      [...oldRules, newBlock, tempRuleText('udp', { processPaths: paths, verifyHost: FAKE_VERIFY_HOST })].map((t) => [t, 'removed']).sort(),
    );
    // 移除了哪些本应用规则记入操作（结果与步骤），不只在入口读回的证据里
    expectCleanupRecorded(opId, [
      { action: 'remove', kind: 'udp', rule: oldUdp },
      { action: 'remove', kind: 'block', rule: oldBlock },
    ]);
  });

  test('a rollback that cleans up duplicate app-owned temp rules keeps Safari blocked and records each removal in the operation (temp_rule)', async () => {
    const { env, paths, oldUdp, oldBlock, newBlock } = await duplicateAfterPathChange();
    // 再次激活：第 6 步（未标为撤销）以 UNKNOWN_STATE 拒绝 → 回滚（撤销到 BLOCKED）逐条清理并保持阻断
    const a = await h.app.activate(env, { request_id: rid() }, WEB);
    await h.idle();
    const op = h.repos.operations.get(a.operation_id!)!;
    expect(op.phase).toBe('FAILED');
    expect(op.error!.code).toBe('UNKNOWN_STATE');
    expect(h.repos.routeState.get().entryMode).toBe('BLOCKED');
    expect([...h.fake.tempRules].sort()).toEqual([newBlock, tempRuleText('udp', { processPaths: paths, verifyHost: FAKE_VERIFY_HOST })].sort());
    for (const protocol of ['tcp', 'udp'] as const) {
      const r = safariOutcome(h, 'www.example.test', protocol);
      expect(r.failed && r.policyName?.startsWith('REJECT')).toBe(true);
    }
    const messages = expectCleanupRecorded(a.operation_id!, [
      { action: 'remove', kind: 'udp', rule: oldUdp },
      { action: 'remove', kind: 'block', rule: oldBlock },
    ]);
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
