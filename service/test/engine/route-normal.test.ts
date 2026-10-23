// 普通模式永远可用（docs/ARCHITECTURE.md §5.2、§6.5）：优先级问题、被外部修改的本应用入口文件、结束 Safari 连接失败
// 都不能让它卡在 BLOCKED。只撤销本应用入口，从不改成 DIRECT/FINAL、不重载、不切换配置。只用合成数据。

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { ENTRY_PLACEHOLDER_RULE, ENTRY_RULESET_FILES, SfeError, type ProtocolCoverage } from '@sfe/contract';
import { processPathsDigest } from '../../src/engine/capabilities.js';
import { capabilityUnverified } from '../../src/surge/primitives.js';
import { FAKE_CHROME_PATH, FAKE_SAFARI_PATH, FAKE_VERIFY_HOST, FakeSurge } from '../../src/surge/fake.js';
import { entryRuleSetFileContent, parseEntryRuleSetFile, tempRuleText } from '../../src/surge/generate.js';
import { normalizeRuleText } from '../../src/surge/rules.js';
import { AGENT, ALL_CAPS, PROFILE_A, PROFILE_B, PROFILE_C, WEB, activeEnv, anyContext, bind, createEnv, createHarness, rid, safariOutcome, verify, type Harness } from './harness.js';

let h: Harness;

const FULL_COVERAGE: ProtocolCoverage = {
  ipv4: { result: 'pass', note: null },
  ipv6: { result: 'limitation', note: '本机网络无 IPv6，未覆盖' },
  http1: { result: 'pass', note: null },
  http2: { result: 'pass', note: null },
  http3_quic: { result: 'pass', note: 'H3 被拒绝并回落 TCP' },
  websocket: { result: 'pass', note: null },
  extension_page_fetch: { result: 'pass', note: null },
};

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

/** 提议并确认新的 Safari 进程路径（合成的进程归属记录）。 */
async function confirmPaths(paths: string[]): Promise<void> {
  const { proposal_id } = await h.app.proposeCapability(
    {
      request_id: rid('prop'),
      key: 'safari_process_attribution',
      proposed_status: 'supported',
      context: { ...anyContext(), surgeVersion: '6.10.0', surgeBuild: '12500', processPathsDigest: processPathsDigest(paths) },
      summary: '进程归属（合成）',
      evidence_digest: 'sha256:0123456789abcdef',
      protocol_coverage: FULL_COVERAGE,
      safari_process_paths: paths,
    },
    AGENT,
  );
  await h.app.confirmCapability({ request_id: rid(), action: 'confirm', proposal_id }, WEB);
  expect(h.repos.settings.get('safariProcessPaths')).toEqual(paths);
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

  test('…without rule match: the blocking step with rules ahead of the entry says it was not runtime-confirmed, and normal mode keeps the buyer-exit warning (ruleset_resource)', async () => {
    h = await createHarness();
    const { envId } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    h.fake.setModuleRules([{ text: 'PROCESS-NAME,Safari,DIRECT', moduleName: 'Mod' }]);
    h.fake.matchRule = async () => {
      throw capabilityUnverified('matchRule');
    };
    const opId = await enterNormal(envId);
    const op = h.repos.operations.get(opId)!;
    expect(op.phase).toBe('NORMAL_RESTORED');
    expect((op.result as { precedenceIssues: Array<{ severity: string }> }).precedenceIssues.some((i) => i.severity === 'blocking')).toBe(true);
    const blocked = h.repos.operations.listSteps(opId).map((st) => st.message).filter((m) => m.startsWith('入口已切换到阻断'));
    expect(blocked).toEqual([expect.stringContaining('未经运行时求值确认')]);
    expect(blocked[0]).toContain('排在本应用入口之前');
    expect(h.repos.routeState.get().warnings).toEqual(expect.arrayContaining(['entry_unverified', 'buyer_exit_connections_unconfirmed']));
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
    expect(messages.some((m) => m.includes('不需要阻断，未写入；仍结束 Safari 可能经买家出口的旧连接'))).toBe(true);
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
    expect(h.repos.operations.listSteps(opId).some((st) => st.message.includes('仍结束 Safari 可能经买家出口的旧连接'))).toBe(true);
    expectOriginalRules();
    // 已在普通模式（空闲、没有使用中的环境）时再次进入普通模式：不结束按原规则发出的 Safari 连接
    const direct = h.fake.simulateRequest({ processPath: FAKE_SAFARI_PATH, host: 'www.example.test', protocol: 'tcp', longLived: true });
    expect(direct.policyName).not.toBe('SFE-ROUTE');
    const again = await enterNormal(null);
    expect(h.repos.operations.get(again)!.phase).toBe('NORMAL_RESTORED');
    expect(h.fake.calls.killRequest ?? 0).toBe(kills + 1);
    expect((await h.fake.listActiveRequests()).some((r) => r.id === direct.id)).toBe(true);
  });

  test('a rollback that fails after the app temp rules were removed records NORMAL (attention, snapshot kept): normal mode still ends the Safari connection on SFE-ROUTE (temp_rule)', async () => {
    h = await createHarness({ entryStrategy: 'temp_rule' });
    const env = (await createEnv(h, 'US-Buyer-A', '203.0.113.10')).environment_id!;
    await bind(h, PROFILE_A, env);
    // 第一次激活（没有切换前的环境）到 VERIFY_ONLY：Safari 经 SFE-ROUTE 打开检测主机的长连接
    const a = await h.app.activate(env, { request_id: rid() }, WEB);
    await h.idle();
    expect(h.repos.operations.get(a.operation_id)!.phase).toBe('VERIFY_ONLY');
    expect(h.repos.routeState.get().activeEnvironmentId).toBeNull();
    const live = h.fake.simulateRequest({ processPath: FAKE_SAFARI_PATH, host: FAKE_VERIFY_HOST, protocol: 'tcp', longLived: true });
    expect(live.policyName).toBe('SFE-ROUTE');
    // 别的工具移除了本应用的临时规则（`rule temp flush`），回滚的第一次加入又失败一次：回滚按最后确认的 NORMAL 记录、停在需要处理
    for (const rule of h.fake.tempRules) await h.fake.removeTempRule(rule);
    h.fake.failNext('addTempRule');
    await h.app.cancelOperation(a.operation_id, { request_id: rid() }, WEB);
    await h.idle();
    const route = h.repos.routeState.get();
    expect(route).toMatchObject({ entryMode: 'NORMAL', phase: 'attention', activeEnvironmentId: null });
    expect(route.activationSnapshot).not.toBeNull();
    expect((await h.fake.listActiveRequests()).some((r) => r.id === live.id)).toBe(true);
    const kills = h.fake.calls.killRequest ?? 0;
    // 普通模式：第一次读回已是 NORMAL，但路由记录不是空闲的普通模式（激活写入过 VERIFY_ONLY）——照常结束 Safari 连接
    const opId = await enterNormal(null);
    const op = h.repos.operations.get(opId)!;
    expect(op.phase).toBe('NORMAL_RESTORED');
    expect(h.fake.calls.killRequest ?? 0).toBe(kills + 1);
    expect((await h.fake.listActiveRequests()).some((r) => r.id === live.id)).toBe(false);
    expect((op.result as { killResults: Array<{ surgeRequestId: string; ok: boolean }> }).killResults).toEqual([expect.objectContaining({ surgeRequestId: live.id, ok: true })]);
    expect(h.repos.operations.listSteps(opId).some((st) => st.message.includes('仍结束 Safari 可能经买家出口的旧连接'))).toBe(true);
    expectOriginalRules();
    // 已确认结束之后再次进入普通模式：不结束按原规则发出的连接
    const direct = h.fake.simulateRequest({ processPath: FAKE_SAFARI_PATH, host: 'www.example.test', protocol: 'tcp', longLived: true });
    expect(direct.policyName).not.toBe('SFE-ROUTE');
    expect(h.repos.operations.get(await enterNormal(null))!.phase).toBe('NORMAL_RESTORED');
    expect(h.fake.calls.killRequest ?? 0).toBe(kills + 1);
    expect((await h.fake.listActiveRequests()).some((r) => r.id === direct.id)).toBe(true);
  });

  test('…and the web and every identified profile (bound or unbound) are offered normal mode in that NORMAL/attention state (temp_rule)', async () => {
    h = await createHarness({ entryStrategy: 'temp_rule' });
    const env = (await createEnv(h, 'US-Buyer-A', '203.0.113.10')).environment_id!;
    await bind(h, PROFILE_A, env);
    const a = await h.app.activate(env, { request_id: rid() }, WEB);
    await h.idle();
    expect(h.repos.operations.get(a.operation_id)!.phase).toBe('VERIFY_ONLY');
    const live = h.fake.simulateRequest({ processPath: FAKE_SAFARI_PATH, host: FAKE_VERIFY_HOST, protocol: 'tcp', longLived: true });
    expect(live.policyName).toBe('SFE-ROUTE');
    for (const rule of h.fake.tempRules) await h.fake.removeTempRule(rule);
    h.fake.failNext('addTempRule');
    await h.app.cancelOperation(a.operation_id, { request_id: rid() }, WEB);
    await h.idle();
    const route = h.repos.routeState.get();
    expect(route).toMatchObject({ entryMode: 'NORMAL', phase: 'attention', activeEnvironmentId: null, warnings: ['entry_unverified'] });
    expect(route.warnings).not.toContain('buyer_exit_connections_unconfirmed');
    // 网页后台：路由视图由服务端判定提供普通模式（入口记为 NORMAL、没有活动环境、没有买家出口警告也一样）
    expect((await h.app.snapshot(WEB)).route.normalModeOffered).toBe(true);
    // 扩展：绑定场景与未绑定场景的路由摘要都提供
    for (const profile of [PROFILE_A, PROFILE_B]) {
      const d = ((await h.native(profile, { type: 'getCurrentState' })) as { data: { relation: string; routeSummary: Record<string, unknown> } }).data;
      expect(d.relation).toBe('none_active');
      expect(d.routeSummary).toEqual({ routeEpoch: expect.any(Number), entryMode: 'NORMAL', phase: 'attention', buyerExitConnectionsUnconfirmed: false, entryUnconfirmed: true, normalModeOffered: true, reconciled: true });
    }
    const n = await h.native(PROFILE_B, { type: 'enterNormalMode', request_id: rid() });
    expect(n.ok).toBe(true);
    await h.idle();
    expect((await h.fake.listActiveRequests()).some((r) => r.id === live.id)).toBe(false);
    expect((await h.app.snapshot(WEB)).route.normalModeOffered).toBe(false);
  });

  test('a normal mode whose kill fails and whose final readback fails after NORMAL was confirmed: the route keeps the buyer-exit warning and the marker, every view still offers normal mode, and the next one ends the connection (temp_rule)', async () => {
    h = await createHarness({ entryStrategy: 'temp_rule' });
    const env = (await createEnv(h, 'US-Buyer-A', '203.0.113.10')).environment_id!;
    await bind(h, PROFILE_A, env);
    // 第一次激活（从 NORMAL）到 VERIFY_ONLY：设置持久标记；Safari 经 SFE-ROUTE 打开检测主机的长连接；取消 → 阻断、失败
    const a = await h.app.activate(env, { request_id: rid() }, WEB);
    await h.idle();
    expect(h.repos.operations.get(a.operation_id)!.phase).toBe('VERIFY_ONLY');
    const live = h.fake.simulateRequest({ processPath: FAKE_SAFARI_PATH, host: FAKE_VERIFY_HOST, protocol: 'tcp', longLived: true });
    expect(live.policyName).toBe('SFE-ROUTE');
    await h.app.cancelOperation(a.operation_id, { request_id: rid() }, WEB);
    await h.idle();
    expect(h.repos.routeState.get()).toMatchObject({ entryMode: 'BLOCKED', phase: 'failed', activeEnvironmentId: null, warnings: [] });
    // 普通模式：结束连接失败；撤销入口的最后一步（移除 block）已读回确认 NORMAL，之后最终读回读取临时规则失败一次
    h.fake.failNext('killRequest');
    const listTempRules = h.fake.listTempRules.bind(h.fake);
    let readsAfterRemoval = 0;
    h.fake.listTempRules = async () => {
      if (h.fake.tempRules.length === 0 && ++readsAfterRemoval === 2) throw new Error('模拟失败：读取临时规则');
      return listTempRules();
    };
    const first = await enterNormal(null);
    h.fake.listTempRules = listTempRules;
    const op = h.repos.operations.get(first)!;
    expect(op.phase).toBe('FAILED');
    expect((op.result as { killResults: Array<{ surgeRequestId: string; ok: boolean }> }).killResults).toEqual([expect.objectContaining({ surgeRequestId: live.id, ok: false })]);
    expect(h.fake.tempRules).toEqual([]);
    const route = h.repos.routeState.get();
    expect(route).toMatchObject({ entryMode: 'NORMAL', phase: 'idle', activeEnvironmentId: null, activationSnapshot: null });
    expect(route.warnings).toContain('buyer_exit_connections_unconfirmed');
    expect((await h.fake.listActiveRequests()).some((r) => r.id === live.id)).toBe(true);
    expect(h.repos.operations.listSteps(first).at(-1)!.message).toContain('未能确认 Safari 已没有经买家出口的连接');
    // 网页后台与任何已识别场景都提供普通模式；对账不处理空闲的普通模式，状态保持
    await h.app.runPeriodicReconcile();
    expect((await h.app.snapshot(WEB)).route.normalModeOffered).toBe(true);
    for (const profile of [PROFILE_A, PROFILE_B]) {
      const d = ((await h.native(profile, { type: 'getCurrentState' })) as { data: { relation: string; routeSummary: Record<string, unknown> } }).data;
      expect(d.relation).toBe('none_active');
      expect(d.routeSummary).toEqual({ routeEpoch: expect.any(Number), entryMode: 'NORMAL', phase: 'idle', buyerExitConnectionsUnconfirmed: true, entryUnconfirmed: false, normalModeOffered: true, reconciled: true });
    }
    // 下一次普通模式（未绑定场景发起）结束买家出口上的连接，警告清除、不再提供
    const n = await h.native(PROFILE_B, { type: 'enterNormalMode', request_id: rid() });
    expect(n.ok).toBe(true);
    await h.idle();
    expect((await h.fake.listActiveRequests()).some((r) => r.id === live.id)).toBe(false);
    expect(h.repos.routeState.get().warnings).not.toContain('buyer_exit_connections_unconfirmed');
    expect((await h.app.snapshot(WEB)).route.normalModeOffered).toBe(false);
  });

  test('a Safari connection that normal mode could not end is ended by the next normal mode, although the route is already idle/NORMAL (ruleset_resource)', async () => {
    h = await createHarness();
    const { envId } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const live = h.fake.simulateRequest({ processPath: FAKE_SAFARI_PATH, host: 'www.example.test', protocol: 'tcp', longLived: true });
    expect(live.policyName).toBe('SFE-ROUTE');
    h.fake.failNext('killRequest');
    const first = await enterNormal(envId);
    expect(h.repos.operations.get(first)!).toMatchObject({ phase: 'NORMAL_RESTORED', result: { killError: { code: 'READBACK_MISMATCH' } } });
    expect(h.repos.routeState.get()).toMatchObject({ entryMode: 'NORMAL', phase: 'idle', activeEnvironmentId: null, activationSnapshot: null });
    expect((await h.fake.listActiveRequests()).some((r) => r.id === live.id)).toBe(true);
    const kills = h.fake.calls.killRequest ?? 0;
    const again = await enterNormal(null);
    const op = h.repos.operations.get(again)!;
    expect(op.phase).toBe('NORMAL_RESTORED');
    expect(h.fake.calls.killRequest ?? 0).toBe(kills + 1);
    expect((await h.fake.listActiveRequests()).some((r) => r.id === live.id)).toBe(false);
    expect((op.result as { killError?: unknown }).killError).toBeUndefined();
    // 这一次确认结束：之后再进入普通模式不再结束按原规则发出的连接
    const direct = h.fake.simulateRequest({ processPath: FAKE_SAFARI_PATH, host: 'www.example.test', protocol: 'tcp', longLived: true });
    expect(direct.policyName).not.toBe('SFE-ROUTE');
    expect(h.repos.operations.get(await enterNormal(null))!.phase).toBe('NORMAL_RESTORED');
    expect(h.fake.calls.killRequest ?? 0).toBe(kills + 1);
    expect((await h.fake.listActiveRequests()).some((r) => r.id === direct.id)).toBe(true);
  });

  test('a normal mode that could not confirm ending Safari connections says so in its final step and leaves a route warning until a later normal mode ends them (ruleset_resource)', async () => {
    h = await createHarness();
    const { envId } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const live = h.fake.simulateRequest({ processPath: FAKE_SAFARI_PATH, host: 'www.example.test', protocol: 'tcp', longLived: true });
    expect(live.policyName).toBe('SFE-ROUTE');
    h.fake.failNext('killRequest');
    const first = await enterNormal(envId);
    expect(h.repos.operations.get(first)!).toMatchObject({ phase: 'NORMAL_RESTORED', status: 'succeeded' });
    const last = h.repos.operations.listSteps(first).at(-1)!.message;
    expect(last).toContain('未能确认 Safari 已没有经买家出口的连接');
    expect(last).not.toContain('Safari 按 Surge 原规则发出请求');
    expect(h.repos.routeState.get()).toMatchObject({ entryMode: 'NORMAL', phase: 'idle', warnings: ['buyer_exit_connections_unconfirmed'] });
    // 下一次普通模式确认结束：警告清除，完成说明不再保留
    const again = await enterNormal(null);
    expect((await h.fake.listActiveRequests()).some((r) => r.id === live.id)).toBe(false);
    expect(h.repos.operations.listSteps(again).at(-1)!.message).toBe('已进入普通模式：Safari 按 Surge 原规则发出请求');
    expect(h.repos.routeState.get().warnings).toEqual([]);
  });

  test('a process-path change while Safari may still have a connection on SFE-ROUTE: the next normal mode still ends it by the earlier path and leaves that path\'s connections on the original rules alone (ruleset_resource)', async () => {
    h = await createHarness();
    const { envId } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const live = h.fake.simulateRequest({ processPath: FAKE_SAFARI_PATH, host: 'www.example.test', protocol: 'tcp', longLived: true });
    expect(live.policyName).toBe('SFE-ROUTE');
    h.fake.failNext('killRequest');
    expect(h.repos.operations.get(await enterNormal(envId))!.phase).toBe('NORMAL_RESTORED');
    expect((await h.fake.listActiveRequests()).some((r) => r.id === live.id)).toBe(true);
    // 新的进程归属提议（合成路径）只列出 Safari Technology Preview：入口已是普通模式，确认成功
    const stp = '/Applications/Safari Technology Preview.app/Contents/MacOS/Safari Technology Preview';
    await confirmPaths([stp]);
    // 之前路径上按原规则发出的连接：不再是配置的 Safari 进程，也不经买家出口——不结束
    const direct = h.fake.simulateRequest({ processPath: FAKE_SAFARI_PATH, host: 'www.example.test', protocol: 'tcp', longLived: true });
    expect(direct.rule).toBe('FINAL,DIRECT');
    const kills = h.fake.calls.killRequest ?? 0;
    const again = await enterNormal(null);
    const op = h.repos.operations.get(again)!;
    expect(op.phase).toBe('NORMAL_RESTORED');
    expect(h.fake.calls.killRequest ?? 0).toBe(kills + 1);
    expect((await h.fake.listActiveRequests()).some((r) => r.id === live.id)).toBe(false);
    expect((await h.fake.listActiveRequests()).some((r) => r.id === direct.id)).toBe(true);
    expect((op.result as { killResults: Array<{ surgeRequestId: string; ok: boolean }> }).killResults).toEqual([expect.objectContaining({ surgeRequestId: live.id, ok: true })]);
    expect(h.repos.routeState.get().warnings).not.toContain('buyer_exit_connections_unconfirmed');
    // 已确认结束：之后再进入普通模式不再结束
    expect(h.repos.operations.get(await enterNormal(null))!.phase).toBe('NORMAL_RESTORED');
    expect(h.fake.calls.killRequest ?? 0).toBe(kills + 1);
    expect((await h.fake.listActiveRequests()).some((r) => r.id === direct.id)).toBe(true);
  });

  test('activation after a process-path change while the buyer-exit warning is kept: step 7 also ends the replaced path\'s connection on the earlier buyer exit (not its connections on the original rules, not Chrome) before the route counts as in use (ruleset_resource)', async () => {
    h = await createHarness();
    const stp = '/Applications/Safari Technology Preview.app/Contents/MacOS/Safari Technology Preview';
    h.repos.settings.set('safariProcessPaths', [FAKE_SAFARI_PATH, stp]);
    const { envId: envA } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const nodeA = h.repos.routeState.get().selectedNode;
    const live = h.fake.simulateRequest({ processPath: stp, host: 'www.example.test', protocol: 'tcp', longLived: true });
    expect(live.policyName).toBe('SFE-ROUTE');
    expect(live.leafPolicyName).toBe(nodeA);
    h.fake.failNext('killRequest');
    expect(h.repos.operations.get(await enterNormal(envA))!.phase).toBe('NORMAL_RESTORED');
    expect(h.repos.routeState.get().warnings).toContain('buyer_exit_connections_unconfirmed');
    // 新的进程归属提议（合成路径）只列出 Safari：入口已是普通模式，确认成功；P0 重新确认依赖的能力
    await confirmPaths([FAKE_SAFARI_PATH]);
    h.grant(ALL_CAPS);
    // 被换掉的路径上按原规则发出的连接与 Chrome 的连接：不经买家出口，不结束
    const direct = h.fake.simulateRequest({ processPath: stp, host: 'www.example.test', protocol: 'tcp', longLived: true });
    expect(direct.rule).toBe('FINAL,DIRECT');
    const chrome = h.fake.simulateRequest({ processPath: FAKE_CHROME_PATH, host: 'www.example.test', protocol: 'tcp', longLived: true });
    const { envId: envB } = await activeEnv(h, 'US-Buyer-B', '203.0.113.20', PROFILE_B);
    const route = h.repos.routeState.get();
    expect(route).toMatchObject({ phase: 'active_verified', entryMode: 'ACTIVE', activeEnvironmentId: envB });
    expect(route.selectedNode).not.toBe(nodeA);
    const active = await h.fake.listActiveRequests();
    expect(active.some((r) => r.id === live.id)).toBe(false);
    expect(active.some((r) => r.id === direct.id)).toBe(true);
    expect(active.some((r) => r.id === chrome.id)).toBe(true);
    // 第 7 步确认结束了可能经之前买家出口的连接：警告随之清除，不是被提交悄悄丢掉
    expect(route.warnings).not.toContain('buyer_exit_connections_unconfirmed');
  });

  test('an activation that did not record ending Safari connections at step 7 (in flight from before the upgrade) keeps the buyer-exit warning at commit (ruleset_resource)', async () => {
    h = await createHarness();
    const { envId: envA } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    h.fake.simulateRequest({ processPath: FAKE_SAFARI_PATH, host: 'www.example.test', protocol: 'tcp', longLived: true });
    h.fake.failNext('killRequest');
    expect(h.repos.operations.get(await enterNormal(envA))!.phase).toBe('NORMAL_RESTORED');
    expect(h.repos.routeState.get().warnings).toContain('buyer_exit_connections_unconfirmed');
    const envB = (await createEnv(h, 'US-Buyer-B', '203.0.113.20')).environment_id!;
    await bind(h, PROFILE_B, envB);
    const act = await h.app.activate(envB, { request_id: rid('act') }, WEB);
    await h.idle();
    const op = h.repos.operations.get(act.operation_id)!;
    expect(op.phase).toBe('VERIFY_ONLY');
    const payload = op.payload as { route: Record<string, unknown> };
    expect(payload.route.safariConnectionsEnded).toBe(true);
    const { safariConnectionsEnded: _ended, ...legacy } = payload.route;
    h.repos.operations.update(op.id, { payload: { ...payload, route: legacy } });
    expect((await verify(h, PROFILE_B, act.operation_id)).ok).toBe(true);
    expect(h.repos.operations.get(act.operation_id)!.phase).toBe('ACTIVE_VERIFIED');
    expect(h.repos.routeState.get()).toMatchObject({ phase: 'active_verified', activeEnvironmentId: envB });
    expect(h.repos.routeState.get().warnings).toContain('buyer_exit_connections_unconfirmed');
  });

  test('entry already NORMAL: Safari reconnecting on the original rules right after the kill is not reported as a kill failure (temp_rule)', async () => {
    h = await createHarness({ entryStrategy: 'temp_rule' });
    const { envId } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const live = h.fake.simulateRequest({ processPath: FAKE_SAFARI_PATH, host: 'www.example.test', protocol: 'tcp', longLived: true });
    expect(live.policyName).toBe('SFE-ROUTE');
    for (const rule of h.fake.tempRules) await h.fake.removeTempRule(rule);
    // 每次结束之后 Safari 立即重连：入口已没有本应用规则，按原规则（FINAL,DIRECT）发出
    const kill = h.fake.killRequest.bind(h.fake);
    const reconnected: string[] = [];
    h.fake.killRequest = async (id: string) => {
      await kill(id);
      const r = h.fake.simulateRequest({ processPath: FAKE_SAFARI_PATH, host: 'www.example.test', protocol: 'tcp', longLived: true });
      expect(r.rule).toBe('FINAL,DIRECT');
      reconnected.push(r.id);
    };
    const opId = await enterNormal(envId);
    const op = h.repos.operations.get(opId)!;
    expect(op.phase).toBe('NORMAL_RESTORED');
    const result = op.result as { killResults: Array<{ surgeRequestId: string; ok: boolean }>; killError?: unknown };
    expect(result.killError).toBeUndefined();
    expect(result.killResults).toEqual([expect.objectContaining({ surgeRequestId: live.id, ok: true })]);
    const messages = h.repos.operations.listSteps(opId).map((st) => st.message);
    expect(messages.some((m) => m.startsWith('已结束 Safari 连接 1 条'))).toBe(true);
    expect(messages.some((m) => m.includes('未能确认结束 Safari 连接'))).toBe(false);
    expect(reconnected).toHaveLength(1);
    expect((await h.fake.listActiveRequests()).some((r) => r.id === reconnected[0])).toBe(true);
    expectOriginalRules();
  });

  test('ruleset_resource without rule match: every normal mode still ends Safari connections that may be on the buyer exit (fail closed) but not those on the original rules; once rule match confirms the entry the record is cleared and later normal modes end nothing', async () => {
    h = await createHarness();
    const envId = (await createEnv(h, 'US-Buyer-A', '203.0.113.10')).environment_id!;
    await bind(h, PROFILE_A, envId);
    await h.app.activate(envId, { request_id: rid('act') }, WEB);
    await h.idle();
    // VERIFY_ONLY：Safari 经 SFE-ROUTE 打开检测主机的长连接（买家出口）
    const live = h.fake.simulateRequest({ processPath: FAKE_SAFARI_PATH, host: FAKE_VERIFY_HOST, protocol: 'tcp', longLived: true });
    expect(live.policyName).toBe('SFE-ROUTE');
    const matchRule = h.fake.matchRule.bind(h.fake);
    const noMatchRule = async (): Promise<never> => {
      throw capabilityUnverified('matchRule');
    };
    h.fake.matchRule = noMatchRule;
    // 第一次普通模式结束连接失败：买家出口上的连接留到下一次
    h.fake.failNext('killRequest');
    const first = await enterNormal(h.repos.routeState.get().activeEnvironmentId);
    expect(h.repos.operations.get(first)!.phase).toBe('NORMAL_RESTORED');
    expect(h.repos.routeState.get()).toMatchObject({ entryMode: 'NORMAL', phase: 'idle', activeEnvironmentId: null });
    // 撤销入口未经运行时确认：不能确认 Safari 之后没有经 SFE-ROUTE 的新连接，路由状态带警告
    expect(h.repos.routeState.get().warnings).toEqual(expect.arrayContaining(['entry_unverified', 'buyer_exit_connections_unconfirmed']));
    expect((await h.fake.listActiveRequests()).some((r) => r.id === live.id)).toBe(true);
    // 普通的 Safari 长连接（按原规则）与 Chrome
    const direct = h.fake.simulateRequest({ processPath: FAKE_SAFARI_PATH, host: 'www.example.test', protocol: 'tcp', longLived: true });
    expect(direct.rule).toBe('FINAL,DIRECT');
    const chrome = h.fake.simulateRequest({ processPath: FAKE_CHROME_PATH, host: 'www.example.test', protocol: 'tcp', longLived: true });
    const kills = h.fake.calls.killRequest ?? 0;
    // 读回为 UNKNOWN（rule match 不可用），中间阻断按文件内容返回 NORMAL：入口从未经运行时确认，记录保留——仍结束 Safari
    // 可能经买家出口的连接；按原规则发出的连接不在买家出口上，不结束
    const again = await enterNormal(null);
    const op = h.repos.operations.get(again)!;
    expect(op.phase).toBe('NORMAL_RESTORED');
    expect(h.fake.calls.killRequest ?? 0).toBe(kills + 1);
    expect((op.result as { killResults: Array<{ surgeRequestId: string; ok: boolean }> }).killResults).toEqual([expect.objectContaining({ surgeRequestId: live.id, ok: true })]);
    const active = (await h.fake.listActiveRequests()).map((r) => r.id);
    expect(active).not.toContain(live.id);
    expect(active).toContain(direct.id);
    expect(active).toContain(chrome.id);
    const already = h.repos.operations.listSteps(again).map((st) => st.message).filter((m) => m.startsWith('入口已是普通模式'));
    expect(already).toEqual([expect.stringContaining('仍结束 Safari 可能经买家出口的旧连接')]);
    expect(h.repos.routeState.get().warnings).toContain('buyer_exit_connections_unconfirmed');
    // rule match 恢复：读回经见证与探测确认已是普通模式；没有可能经买家出口的连接，清除记录与警告，按原规则的连接不碰
    h.fake.matchRule = matchRule;
    const direct2 = h.fake.simulateRequest({ processPath: FAKE_SAFARI_PATH, host: 'www.example.test', protocol: 'tcp', longLived: true });
    const third = await enterNormal(null);
    expect(h.repos.operations.get(third)!.phase).toBe('NORMAL_RESTORED');
    expect(h.fake.calls.killRequest ?? 0).toBe(kills + 1);
    expect((await h.fake.listActiveRequests()).some((r) => r.id === direct2.id)).toBe(true);
    expect(h.repos.routeState.get().warnings).not.toContain('buyer_exit_connections_unconfirmed');
    expect(h.repos.routeState.get().warnings).not.toContain('entry_unverified');
    // 之后 rule match 再次不可用：没有 Safari 可能经 SFE-ROUTE 的记录，不结束按原规则发出的连接；步骤不声称未确立的事实
    h.fake.matchRule = noMatchRule;
    const direct3 = h.fake.simulateRequest({ processPath: FAKE_SAFARI_PATH, host: 'www.example.test', protocol: 'tcp', longLived: true });
    const fourth = await enterNormal(null);
    expect(h.repos.operations.get(fourth)!.phase).toBe('NORMAL_RESTORED');
    expect(h.fake.calls.killRequest ?? 0).toBe(kills + 1);
    expect((await h.fake.listActiveRequests()).some((r) => r.id === direct3.id)).toBe(true);
    const idle = h.repos.operations.listSteps(fourth).map((st) => st.message).filter((m) => m.startsWith('入口已是普通模式'));
    expect(idle).toEqual([expect.stringContaining('不结束 Safari 连接')]);
    expect(idle[0]).not.toContain('仍结束 Safari 可能经买家出口的旧连接');
    expect(idle[0]).not.toContain('之前的 Safari 连接已确认结束');
  });

  test.each(['temp_rule', 'ruleset_resource'] as const)(
    'retrying normal mode from idle NORMAL with the buyer-exit warning (offered to any profile) ends only the Safari connection that may be on the buyer exit, not Safari connections on the original rules, not Chrome (%s)',
    async (entryStrategy) => {
      h = await createHarness({ entryStrategy });
      const { envId } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
      const live = h.fake.simulateRequest({ processPath: FAKE_SAFARI_PATH, host: 'www.example.test', protocol: 'tcp', longLived: true });
      expect(live.policyName).toBe('SFE-ROUTE');
      h.fake.failNext('killRequest');
      expect(h.repos.operations.get(await enterNormal(envId))!.phase).toBe('NORMAL_RESTORED');
      expect(h.repos.routeState.get()).toMatchObject({ entryMode: 'NORMAL', phase: 'idle', warnings: ['buyer_exit_connections_unconfirmed'] });
      const direct = h.fake.simulateRequest({ processPath: FAKE_SAFARI_PATH, host: 'www.example.test', protocol: 'tcp', longLived: true });
      expect(direct.rule).toBe('FINAL,DIRECT');
      expect(direct.policyName).toBe('DIRECT');
      const chrome = h.fake.simulateRequest({ processPath: FAKE_CHROME_PATH, host: 'www.example.test', protocol: 'tcp', longLived: true });
      const n = await h.native(PROFILE_C, { type: 'enterNormalMode', request_id: rid() });
      expect(n.ok).toBe(true);
      await h.idle();
      const opId = (n as { data: { operation_id: string } }).data.operation_id;
      const op = h.repos.operations.get(opId)!;
      expect(op.phase).toBe('NORMAL_RESTORED');
      expect((op.result as { killResults: Array<{ surgeRequestId: string; ok: boolean }> }).killResults).toEqual([expect.objectContaining({ surgeRequestId: live.id, ok: true })]);
      const active = (await h.fake.listActiveRequests()).map((r) => r.id);
      expect(active).not.toContain(live.id);
      expect(active).toContain(direct.id);
      expect(active).toContain(chrome.id);
      expect(h.repos.routeState.get().warnings).not.toContain('buyer_exit_connections_unconfirmed');
    },
  );

  test('ruleset_resource without rule match and a watcher slower than the wait: a Safari connection opened on SFE-ROUTE right after the unconfirmed normal mode is ended by the next normal mode', async () => {
    h = await createHarness();
    const { envId } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    h.fake.matchRule = async () => {
      throw capabilityUnverified('matchRule');
    };
    // 假 Surge 的监视延迟（假时钟 60 秒）高于入口等待上限（40 毫秒）：退路等满上限后按文件内容视为已加载
    h.fake.localWatchLatencyMs = 60_000;
    // 收紧未经运行时求值确认时普通模式完成前改选 REJECT；这里改选失败（如实报告），SFE-ROUTE 仍选着 A 的节点
    h.fake.failNext('selectGroupPolicy');
    const nodeA = h.repos.routeState.get().selectedNode;
    const first = await enterNormal(envId);
    expect(h.repos.operations.get(first)!.phase).toBe('NORMAL_RESTORED');
    expect(h.repos.operations.get(first)!.result).toMatchObject({ rejectSelected: false });
    expect(h.repos.operations.listSteps(first).at(-1)!.message).toContain('SFE-ROUTE 未能改选 REJECT（');
    expect(h.repos.routeState.get()).toMatchObject({ entryMode: 'NORMAL', phase: 'idle', activeEnvironmentId: null, selectedNode: nodeA });
    // Surge 仍加载着写前的 ACTIVE 内容：普通模式之后 Safari 的新长连接经 SFE-ROUTE 发出（买家出口）
    const live = h.fake.simulateRequest({ processPath: FAKE_SAFARI_PATH, host: 'www.example.test', protocol: 'tcp', longLived: true });
    expect(live.policyName).toBe('SFE-ROUTE');
    expect(live.leafPolicyName).toBe(nodeA);
    expect(h.repos.routeState.get().warnings).toContain('buyer_exit_connections_unconfirmed');
    // 监视赶上之后新请求按原规则；之前的长连接仍在买家出口上
    h.clock.advance(120_000);
    expect(safariOutcome(h, 'www.example.test').rule).toBe('FINAL,DIRECT');
    const kills = h.fake.calls.killRequest ?? 0;
    const again = await enterNormal(null);
    const op = h.repos.operations.get(again)!;
    expect(op.phase).toBe('NORMAL_RESTORED');
    expect(h.fake.calls.killRequest ?? 0).toBe(kills + 1);
    expect((await h.fake.listActiveRequests()).some((r) => r.id === live.id)).toBe(false);
    expect((op.result as { killResults: Array<{ surgeRequestId: string; ok: boolean }> }).killResults).toEqual([expect.objectContaining({ surgeRequestId: live.id, ok: true })]);
    const messages = h.repos.operations.listSteps(again).map((st) => st.message);
    expect(messages.some((m) => m.includes('仍结束 Safari 可能经买家出口的旧连接'))).toBe(true);
    expect(messages.some((m) => m.includes('之前的 Safari 连接已确认结束'))).toBe(false);
    expect(h.fake.calls.reloadProfile ?? 0).toBe(0);
  });

  test('ruleset_resource without rule match and a watcher slower than the wait: a normal mode whose block is not runtime-confirmed does not end Safari connections on the original rules (Surge may still have the earlier entry loaded), and Safari reconnecting on them is not a kill failure', async () => {
    h = await createHarness();
    const envId = (await createEnv(h, 'US-Buyer-A', '203.0.113.10')).environment_id!;
    await bind(h, PROFILE_A, envId);
    h.fake.matchRule = async () => {
      throw capabilityUnverified('matchRule');
    };
    h.fake.localWatchLatencyMs = 60_000;
    // 激活在阻断一步失败（激活方向从不走退路），回滚经退路写入阻断：Surge 仍加载着原来的普通模式，路由不是空闲的普通模式
    const act = await h.app.activate(envId, { request_id: rid('act') }, WEB);
    await h.idle();
    expect(h.repos.operations.get(act.operation_id)!.status).toBe('needs_attention');
    expect(h.repos.routeState.get()).toMatchObject({ phase: 'attention', entryMode: 'UNKNOWN' });
    // Safari 按原规则的长连接（用户规则 Daily、FINAL）与 Chrome
    const daily = h.fake.simulateRequest({ processPath: FAKE_SAFARI_PATH, host: 'daily.example.test', protocol: 'tcp', longLived: true });
    expect(daily.policyName).toBe('Daily');
    const direct = h.fake.simulateRequest({ processPath: FAKE_SAFARI_PATH, host: 'www.example.test', protocol: 'tcp', longLived: true });
    expect(direct.rule).toBe('FINAL,DIRECT');
    const chrome = h.fake.simulateRequest({ processPath: FAKE_CHROME_PATH, host: 'www.example.test', protocol: 'tcp', longLived: true });
    const kills = h.fake.calls.killRequest ?? 0;
    const n = await enterNormal(null);
    const op = h.repos.operations.get(n)!;
    expect(op.phase).toBe('NORMAL_RESTORED');
    // 阻断未经运行时求值确认：不按“入口已阻断”结束配置路径上的全部 Safari 连接；按原规则的连接不在买家出口上，不结束、不记失败
    expect(h.fake.calls.killRequest ?? 0).toBe(kills);
    expect((op.result as { killResults: unknown[] }).killResults).toEqual([]);
    const active = (await h.fake.listActiveRequests()).map((r) => r.id);
    expect(active).toEqual(expect.arrayContaining([daily.id, direct.id, chrome.id]));
    const messages = h.repos.operations.listSteps(n).map((st) => st.message);
    expect(messages.some((m) => m.startsWith('已阻断 Safari 新请求'))).toBe(false);
    expect(messages).toContain('入口已按计划写入阻断：rule match 读不到或当前 Surge 不支持，入口按结构读回或写入并等待完成，未经运行时求值确认，Surge 可能仍加载着写入之前的入口（Safari 可能仍按原规则发出）；只结束 Safari 可能经买家出口的连接');
    // 入口未经运行时确认：记录与警告保留，下一次普通模式再结束可能经买家出口的连接
    expect(h.repos.routeState.get().warnings).toEqual(expect.arrayContaining(['entry_unverified', 'buyer_exit_connections_unconfirmed']));
    expect(h.fake.calls.reloadProfile ?? 0).toBe(0);
  });

  test('ruleset_resource without rule match and a watcher slower than the wait: while a normal mode\'s block is not runtime-confirmed the route never records BLOCKED (a later failure or activation would take it as confirmed)', async () => {
    h = await createHarness();
    const { envId } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    h.fake.matchRule = async () => {
      throw capabilityUnverified('matchRule');
    };
    h.fake.localWatchLatencyMs = 60_000;
    // 结束 Safari 连接时（中间阻断之后、撤销入口之前）记下路由记录的入口模式
    const seen: string[] = [];
    const list = h.fake.listActiveRequests.bind(h.fake);
    h.fake.listActiveRequests = async () => {
      if (h.repos.operations.listByStatus(['running']).some((o) => o.kind === 'route.normal')) seen.push(h.repos.routeState.get().entryMode);
      return list();
    };
    const n = await enterNormal(envId);
    expect(h.repos.operations.get(n)!.phase).toBe('NORMAL_RESTORED');
    expect(seen.length).toBeGreaterThan(0);
    expect(seen).not.toContain('BLOCKED');
    expect(seen).toContain('UNKNOWN');
    expect(h.repos.routeState.get().warnings).toEqual(expect.arrayContaining(['entry_unverified', 'buyer_exit_connections_unconfirmed']));
  });

  test.each([
    ['A in use (ACTIVE on A\'s exit)', false],
    ['a switch to B waiting at VERIFY_ONLY (B\'s unverified exit selected)', true],
  ] as const)(
    'ruleset_resource without rule match and a watcher slower than the wait, from %s: the normal mode completes but its undo is not runtime-confirmed — SFE-ROUTE is moved to REJECT so Safari never goes out through a buyer exit while Surge still has the earlier entry loaded',
    async (_label, switching) => {
      h = await createHarness();
      const { envId: a } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
      if (switching) {
        const b = (await createEnv(h, 'US-Buyer-B', '203.0.113.11')).environment_id!;
        await bind(h, PROFILE_B, b);
        const act = await h.app.activate(b, { request_id: rid(), old_session_policy: 'closed_confirmed', confirmed_environment_id: a }, WEB);
        await h.idle();
        expect(h.repos.operations.get(act.operation_id)!.phase).toBe('VERIFY_ONLY');
      }
      const before = h.repos.routeState.get().selectedNode!;
      h.fake.matchRule = async () => {
        throw capabilityUnverified('matchRule');
      };
      h.fake.localWatchLatencyMs = 60_000;
      const n = await enterNormal(a);
      const op = h.repos.operations.get(n)!;
      expect(op.phase).toBe('NORMAL_RESTORED');
      expect(op.result).toMatchObject({ rejectSelected: true });
      expect(h.repos.operations.listSteps(n).at(-1)!.message).toContain('SFE-ROUTE 已改选 REJECT（读回确认）：Surge 加载撤销之前若仍加载着检测或使用中入口');
      expect(h.repos.routeState.get()).toMatchObject({ entryMode: 'NORMAL', phase: 'idle', activeEnvironmentId: null, selectedNode: 'REJECT' });
      expect(h.repos.routeState.get().warnings).toEqual(expect.arrayContaining(['entry_unverified', 'buyer_exit_connections_unconfirmed']));
      // Surge 仍加载着撤销之前的入口：经 SFE-ROUTE 的 Safari 请求被拒绝，不经 A 或 B 的出口
      const v = h.fake.simulateRequest({ processPath: FAKE_SAFARI_PATH, host: FAKE_VERIFY_HOST, protocol: 'tcp' });
      expect(v.policyName).toBe('SFE-ROUTE');
      expect(v.leafPolicyName).toBe('REJECT');
      expect(v.leafPolicyName).not.toBe(before);
      expect(v.failed).toBe(true);
      expect(h.fake.simulateRequest({ processPath: FAKE_CHROME_PATH, host: 'www.example.test', protocol: 'tcp' }).policyName).not.toBe('SFE-ROUTE');
      // 文件监视加载撤销之后 Safari 按原规则发出
      h.clock.advance(120_000);
      expect(safariOutcome(h).rule).toBe('FINAL,DIRECT');
      expect(h.fake.calls.reloadProfile ?? 0).toBe(0);
    },
  );

  test('entry files of the earlier format without a witness: the already-NORMAL step does not claim witness confirmation (ruleset_resource)', async () => {
    h = await createHarness();
    const { envId } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const cfg = { processPaths: [FAKE_SAFARI_PATH], verifyHost: FAKE_VERIFY_HOST };
    for (const bit of ['udp', 'verify', 'block', 'active'] as const) {
      const name = ENTRY_RULESET_FILES[bit];
      await h.files.writeAtomic(name, entryRuleSetFileContent(bit, false, cfg, null), await h.files.digest(name));
      h.repos.managedObjects.setState('entry_ruleset_file', name, 'present', { contentDigest: await h.files.digest(name) });
    }
    const opId = await enterNormal(envId);
    expect(h.repos.operations.get(opId)!.phase).toBe('NORMAL_RESTORED');
    const already = h.repos.operations.listSteps(opId).map((st) => st.message).filter((m) => m.startsWith('入口已是普通模式'));
    expect(already).toEqual([expect.stringContaining('文件没有见证规则')]);
    expect(already[0]).not.toContain('见证与运行时探测读回确认');
    expect(already[0]).toContain('仍结束 Safari 可能经买家出口的旧连接');
    expectOriginalRules();
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
      // 入口状态未知时路由需要处理（attention），确认停在阻断时为 failed
      expect(['failed', 'attention']).toContain(h.repos.routeState.get().phase);
      expect(h.repos.routeState.get().activeEnvironmentId).toBe(envId);
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
      // 入口状态未知时路由需要处理（attention），确认停在阻断时为 failed
      expect(['failed', 'attention']).toContain(h.repos.routeState.get().phase);
      expect(h.repos.routeState.get().activeEnvironmentId).toBe(envId);
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

  test('…retried every 30 s with a module rule routing Safari to SFE-ROUTE ahead of the entry: the retry that holds a kept block- off records the rule and does not claim Safari cannot reach SFE-ROUTE', async () => {
    h = await createHarness();
    const { envId } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const moduleRule = 'AND,((PROCESS-NAME,Safari),(DOMAIN-SUFFIX,example.test)),SFE-ROUTE';
    h.fake.setModuleRules([{ text: moduleRule, moduleName: 'user-module' }]);
    h.fake.localWatchLatencyMs = 60_000;
    const ops: string[] = [];
    for (let i = 0; i < 14; i++) {
      ops.push(await enterNormal(envId));
      if (h.repos.operations.get(ops.at(-1)!)!.phase === 'NORMAL_RESTORED') break;
      h.clock.advance(30_000);
    }
    expect(h.repos.operations.get(ops.at(-1)!)!.phase).toBe('NORMAL_RESTORED');
    const heldOff = ops.filter((id) => h.repos.operations.listSteps(id).some((st) => st.message.includes('上一次保留的 block 关闭尚未确认加载')));
    expect(heldOff.length).toBeGreaterThan(0);
    for (const id of heldOff) {
      const op = h.repos.operations.get(id)!;
      expect((op.result as { precedenceIssues?: Array<{ rule: string; severity: string }> }).precedenceIssues).toContainEqual(expect.objectContaining({ rule: moduleRule, severity: 'blocking' }));
      const step = h.repos.operations.listSteps(id).map((st) => st.message).find((m) => m.includes('上一次保留的 block 关闭尚未确认加载'))!;
      expect(step).toContain('排在本应用入口之前');
      expect(step).not.toContain('Safari 新请求不会经 SFE-ROUTE');
    }
    // 用户模块不被修改：普通模式之后 Safari 按它发出
    expect(safariOutcome(h, 'www.example.test').rule).toBe(moduleRule);
    expect(h.fake.calls.reloadProfile ?? 0).toBe(0);
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

describe('a failed or unconfirmed normal mode reports only what was read back (§6.5)', () => {
  test.each(['temp_rule', 'ruleset_resource'] as const)('%s: SFE-ROUTE switched to another buyer\'s node outside the record, then a normal mode whose first write fails: SFE-ROUTE is moved to REJECT (Safari never left on B\'s exit) and the step does not claim it did not fall back', async (strategy) => {
    h = await createHarness({ entryStrategy: strategy });
    const { envId: a } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const nodeA = h.repos.routeState.get().selectedNode!;
    const b = (await createEnv(h, 'US-Buyer-B', '203.0.113.20')).environment_id!;
    const nodeB = h.repos.proxyRevisions.get(b, 1)!.nodeName;
    // 用户在 Surge 界面把 SFE-ROUTE 改选 B 的节点：对账只加警告，路由记录的选择仍是 A 的节点
    await h.fake.selectGroupPolicy('SFE-ROUTE', nodeB);
    await h.app.runPeriodicReconcile();
    expect(h.repos.routeState.get()).toMatchObject({ selectedNode: nodeA, activationSnapshot: null });
    expect(h.repos.routeState.get().warnings).toContain('external_selection_change');
    expect(safariOutcome(h, 'www.amazon.com').leafPolicyName).toBe(nodeB);
    if (strategy === 'temp_rule') h.fake.failNext('addTempRule');
    else h.fake.failNext('listExternalResources');
    const n = await enterNormal(a);
    const op = h.repos.operations.get(n)!;
    expect(op.status).toBe('failed');
    expect(op.result).toMatchObject({ rejectSelected: true });
    const last = h.repos.operations.listSteps(n).at(-1)!.message;
    expect(last).not.toContain('未回退到其他出口');
    expect(last).toContain('SFE-ROUTE 已改选 REJECT（读回确认）');
    expect(await h.fake.getGroupSelection('SFE-ROUTE')).toBe('REJECT');
    expect(h.repos.routeState.get().selectedNode).toBe('REJECT');
    // Safari 不再经 B 的出口发出（经 SFE-ROUTE 被拒绝）；Chrome 不命中本应用规则
    const after = safariOutcome(h, 'www.amazon.com');
    expect(after.leafPolicyName).not.toBe(nodeB);
    expect(after.failed).toBe(true);
    expect(h.fake.simulateRequest({ processPath: FAKE_CHROME_PATH, host: 'www.amazon.com', protocol: 'tcp' }).policyName).not.toBe('SFE-ROUTE');
  });

  test('a failed normal mode whose selection reads back as the active environment\'s verified exit leaves it (no REJECT) and says so', async () => {
    h = await createHarness({ entryStrategy: 'temp_rule' });
    const { envId: a } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const nodeA = h.repos.routeState.get().selectedNode!;
    h.fake.failNext('addTempRule');
    const n = await enterNormal(a);
    expect(h.repos.operations.get(n)!.status).toBe('failed');
    expect(await h.fake.getGroupSelection('SFE-ROUTE')).toBe(nodeA);
    expect(h.repos.operations.listSteps(n).at(-1)!.message).toContain('SFE-ROUTE 的选择读回就是使用中环境已验证的出口：Safari 停在原来已验证的路由上，未回退到其他出口');
  });

  test('ruleset_resource without rule match and a watcher slower than the wait: the unconfirmed intermediate block is not recorded under the SAFARI_BLOCKED phase (shown as "Safari 已阻断"), while a confirmed one is', async () => {
    h = await createHarness();
    const { envId } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    h.fake.matchRule = async () => {
      throw capabilityUnverified('matchRule');
    };
    h.fake.localWatchLatencyMs = 60_000;
    const seen: string[] = [];
    const list = h.fake.listActiveRequests.bind(h.fake);
    h.fake.listActiveRequests = async () => {
      const normal = h.repos.operations.listByStatus(['running']).find((o) => o.kind === 'route.normal');
      if (normal) seen.push(normal.phase);
      return list();
    };
    const n = await enterNormal(envId);
    expect(h.repos.operations.get(n)!.phase).toBe('NORMAL_RESTORED');
    expect(seen.length).toBeGreaterThan(0);
    expect(seen).not.toContain('SAFARI_BLOCKED');
    const steps = h.repos.operations.listSteps(n);
    const block = steps.find((st) => st.message.startsWith('入口已按计划写入阻断'))!;
    expect(block.phase).not.toBe('SAFARI_BLOCKED');
    expect(steps.some((st) => st.phase === 'SAFARI_BLOCKED')).toBe(false);
    // 对照：rule match 可用时中间阻断读回确认，记在 SAFARI_BLOCKED 之下
    h.fake.matchRule = (FakeSurge.prototype.matchRule as typeof h.fake.matchRule).bind(h.fake);
    h.fake.localWatchLatencyMs = 0;
    h.clock.advance(120_000);
    const { envId: again } = await activeEnv(h, 'US-Buyer-B', '203.0.113.11', PROFILE_B);
    const n2 = await enterNormal(again);
    expect(h.repos.operations.get(n2)!.phase).toBe('NORMAL_RESTORED');
    expect(h.repos.operations.listSteps(n2).find((st) => st.message === '已阻断 Safari 新请求（读回确认）')!.phase).toBe('SAFARI_BLOCKED');
  });

  test('temp_rule: a module rule ahead of the entry, then the normal mode fails after its intermediate block: the route does not claim a plain block — it carries precedence_violation and entry_unverified', async () => {
    h = await createHarness({ entryStrategy: 'temp_rule' });
    const { envId } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    h.fake.setModuleRules([{ text: 'DOMAIN-SUFFIX,www.amazon.com,DIRECT', moduleName: 'user-module' }]);
    // 结束 Safari 连接之后（中间阻断已写入）撤销入口的第一次写入失败
    const list = h.fake.listActiveRequests.bind(h.fake);
    let armed = false;
    h.fake.listActiveRequests = async () => {
      if (!armed && h.repos.operations.listByStatus(['running']).some((o) => o.kind === 'route.normal')) {
        armed = true;
        h.fake.failNext('removeTempRule');
      }
      return list();
    };
    const n = await enterNormal(envId);
    expect(armed).toBe(true);
    const op = h.repos.operations.get(n)!;
    expect(op.status).toBe('failed');
    expect((op.result as { precedenceIssues?: unknown[] }).precedenceIssues?.length).toBeGreaterThan(0);
    const route = h.repos.routeState.get();
    expect(route.entryMode).toBe('BLOCKED');
    expect(route.warnings).toEqual(expect.arrayContaining(['precedence_violation', 'entry_unverified']));
    // 记录的阻断只是入口位：被模块规则匹配的 Safari 请求按它直连
    expect(safariOutcome(h, 'www.amazon.com').rule).toBe('DOMAIN-SUFFIX,www.amazon.com,DIRECT');
    expect(h.app.views.routeView().normalModeOffered).toBe(true);
  });

  test('temp_rule with rule match failing: the normal mode\'s unconfirmed block and completion say the rules were read back structurally, not that Surge may still have the earlier entry loaded', async () => {
    h = await createHarness({ entryStrategy: 'temp_rule' });
    const { envId } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    h.fake.matchRule = async () => {
      throw capabilityUnverified('matchRule');
    };
    const n = await enterNormal(envId);
    expect(h.repos.operations.get(n)!.phase).toBe('NORMAL_RESTORED');
    const messages = h.repos.operations.listSteps(n).map((st) => st.message);
    // temp_rule 没有加载阶段：任何“仍加载着”“加载撤销之前”的说法都不成立（含完成说明中改选 REJECT 的一句）
    expect(messages.filter((m) => /仍加载着|加载撤销之前|写入之前的入口|写前的入口/.test(m))).toEqual([]);
    expect(messages.some((m) => m.includes('临时规则已按 Surge 的临时规则列表与有效规则顺序读回'))).toBe(true);
    const done = messages.at(-1)!;
    expect(done).toContain('临时规则已按列表与有效规则顺序读回');
    expect(h.repos.operations.get(n)!.result).toMatchObject({ rejectSelected: true });
    expect(done).toContain('SFE-ROUTE 已改选 REJECT（读回确认）：临时规则已按 Surge 的临时规则列表与有效规则顺序读回，但 Surge 实际如何匹配 Safari 请求未经 rule match 求值确认');
  });

  test('temp_rule with rule match failing: the intermediate block\'s udp removal times out after steps accepted only from the temp-rule list — the failed normal mode records UNKNOWN with entry_unverified, not a runtime-confirmed BLOCKED', async () => {
    h = await createHarness({ entryStrategy: 'temp_rule' });
    const { envId } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    h.fake.matchRule = async () => {
      throw capabilityUnverified('matchRule');
    };
    // ACTIVE → BLOCKED：加入 block（容忍）、移除 active（容忍）、移除 udp——超时且没有生效（规则仍在列表中）
    const udp = tempRuleText('udp', { processPaths: h.repos.settings.get('safariProcessPaths'), verifyHost: FAKE_VERIFY_HOST });
    const remove = h.fake.removeTempRule.bind(h.fake);
    let failed = false;
    h.fake.removeTempRule = async (rule: string) => {
      if (!failed && rule === udp) {
        failed = true;
        throw new Error('rule temp remove timed out');
      }
      return remove(rule);
    };
    const n = await enterNormal(envId);
    expect(failed).toBe(true);
    const op = h.repos.operations.get(n)!;
    expect(op.status).toBe('failed');
    const done = h.repos.operations.listSteps(n).at(-1)!.message;
    expect(done).not.toContain('最后经运行时求值确认的状态（BLOCKED）');
    expect(done).toContain('入口状态未知');
    const route = h.repos.routeState.get();
    // 入口状态未知：路由需要处理（与回滚无法确认相同），不显示为普通的失败
    expect(route).toMatchObject({ entryMode: 'UNKNOWN', phase: 'attention' });
    expect(route.warnings).toContain('entry_unverified');
  });

  test('temp_rule with rule match failing: a normal mode that took over B\'s VERIFY_ONLY wait wrote an unconfirmed block; its removal then fails — the route is not recorded as a confirmed BLOCKED and SFE-ROUTE moves off B\'s unverified node to REJECT', async () => {
    h = await createHarness({ entryStrategy: 'temp_rule' });
    const { envId: a } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const b = (await createEnv(h, 'US-Buyer-B', '203.0.113.11')).environment_id!;
    await bind(h, PROFILE_B, b);
    const act = await h.app.activate(b, { request_id: rid('act'), old_session_policy: 'closed_confirmed', confirmed_environment_id: a }, WEB);
    await h.idle();
    expect(h.repos.operations.get(act.operation_id)!.phase).toBe('VERIFY_ONLY');
    const nodeB = h.repos.proxyRevisions.get(b, 1)!.nodeName;
    h.fake.matchRule = async () => {
      throw capabilityUnverified('matchRule');
    };
    // 结束 Safari 连接之后（未经确认的中间阻断已写入）撤销入口的第一次移除失败：block 仍在列表中
    const list = h.fake.listActiveRequests.bind(h.fake);
    let armed = false;
    h.fake.listActiveRequests = async () => {
      if (!armed && h.repos.operations.listByStatus(['running']).some((o) => o.kind === 'route.normal')) {
        armed = true;
        h.fake.failNext('removeTempRule');
      }
      return list();
    };
    const n = await enterNormal(a);
    expect(armed).toBe(true);
    expect(h.repos.operations.get(act.operation_id)!.phase).toBe('SUPERSEDED');
    const op = h.repos.operations.get(n)!;
    expect(op.status).toBe('failed');
    const steps = h.repos.operations.listSteps(n).map((st) => st.message);
    expect(steps.some((m) => m.includes('入口已按计划写入阻断') && m.includes('未经运行时求值确认'))).toBe(true);
    expect(steps.at(-1)).not.toContain('最后经运行时求值确认的状态（BLOCKED）');
    expect(steps.at(-1)).not.toContain('未回退到其他出口');
    const route = h.repos.routeState.get();
    expect(route).toMatchObject({ entryMode: 'UNKNOWN', phase: 'attention', selectedNode: 'REJECT' });
    expect(route.warnings).toContain('entry_unverified');
    expect(await h.fake.getGroupSelection('SFE-ROUTE')).toBe('REJECT');
    expect(await h.fake.getGroupSelection('SFE-ROUTE')).not.toBe(nodeB);
    expect(op.result).toMatchObject({ rejectSelected: true });
  });

  test('ruleset_resource: after a successful rollback (「已恢复原节点并保持阻断」), a normal mode that fails with the entry unknown drops rollback_needs_reverify and the environment shows the route needs attention', async () => {
    h = await createHarness();
    const { envId: a } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const nodeA = h.repos.routeState.get().selectedNode!;
    const b = (await createEnv(h, 'US-Buyer-B', '203.0.113.11')).environment_id!;
    await bind(h, PROFILE_B, b);
    const act = await h.app.activate(b, { request_id: rid('act'), old_session_policy: 'closed_confirmed', confirmed_environment_id: a }, WEB);
    await h.idle();
    await h.clock.advanceAsync((h.repos.settings.get('profileArrivalTimeoutSec') + 1) * 1000);
    await h.idle();
    expect(h.repos.operations.get(act.operation_id)!.phase).toBe('FAILED');
    expect(h.repos.routeState.get()).toMatchObject({ phase: 'failed', entryMode: 'BLOCKED', activeEnvironmentId: a, selectedNode: nodeA });
    expect(h.repos.routeState.get().warnings).toContain('rollback_needs_reverify');
    // 文件监视比入口等待慢：撤销入口的第一步超时，写入保留——入口状态未知
    h.fake.localWatchLatencyMs = 60_000;
    const n = await enterNormal(a);
    const op = h.repos.operations.get(n)!;
    expect(op.status).toBe('failed');
    const route = h.repos.routeState.get();
    expect(route).toMatchObject({ entryMode: 'UNKNOWN', phase: 'attention', activeEnvironmentId: a, selectedNode: nodeA });
    expect(route.warnings).toContain('entry_unverified');
    expect(route.warnings).not.toContain('rollback_needs_reverify');
    const view = h.app.views.environmentView(a)!;
    expect(view.facets.route).toBe('active');
    expect(view.nextActions[0]!.message).toContain('路由状态需要处理');
  });

  test('temp_rule: after a successful rollback, a Surge restart (temp rules discarded) makes reconcile record the entry unknown and drop rollback_needs_reverify', async () => {
    h = await createHarness({ entryStrategy: 'temp_rule' });
    const { envId: a } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const b = (await createEnv(h, 'US-Buyer-B', '203.0.113.11')).environment_id!;
    await bind(h, PROFILE_B, b);
    await h.app.activate(b, { request_id: rid('act'), old_session_policy: 'closed_confirmed', confirmed_environment_id: a }, WEB);
    await h.idle();
    await h.clock.advanceAsync((h.repos.settings.get('profileArrivalTimeoutSec') + 1) * 1000);
    await h.idle();
    expect(h.repos.routeState.get().warnings).toContain('rollback_needs_reverify');
    h.fake.restart();
    await h.app.ensureInControl();
    await h.idle();
    const route = h.repos.routeState.get();
    expect(route).toMatchObject({ phase: 'attention', entryMode: 'UNKNOWN' });
    expect(route.warnings).toContain('entry_unverified');
    expect(route.warnings).not.toContain('rollback_needs_reverify');
    // Safari 已按原规则发出（临时规则随重启丢弃）：不再显示「已恢复原节点并保持阻断」
    expect(safariOutcome(h).rule).toBe('FINAL,DIRECT');
    const view = h.app.views.environmentView(a)!;
    expect(view.facets.route).toBe('active');
    expect(view.nextActions[0]!.message).toContain('路由状态需要处理');
  });
});

describe('entry strategy changed on an idle NORMAL route, before maintenance.remerge writes the new entry (§5.2, §5.5, §6.5)', () => {
  /** temp_rule、空闲的普通模式、从未激活；确认 runtime_entry_modes 的提议改用 ruleset_resource（工作配置里还没有四条 RULE-SET）。 */
  async function strategyChangedBeforeRemerge(): Promise<void> {
    h = await createHarness({ entryStrategy: 'temp_rule' });
    expect(h.repos.routeState.get()).toMatchObject({ entryMode: 'NORMAL', phase: 'idle', activeEnvironmentId: null, activationSnapshot: null });
    const { proposal_id } = await h.app.proposeCapability(
      {
        request_id: rid('prop'),
        key: 'runtime_entry_modes',
        proposed_status: 'supported',
        context: { ...anyContext(), surgeVersion: '6.10.0', surgeBuild: '12500' },
        summary: '入口模式（合成）',
        evidence_digest: 'sha256:0123456789abcdef',
        entry_strategy: 'ruleset_resource',
      },
      AGENT,
    );
    await h.app.confirmCapability({ request_id: rid(), action: 'confirm', proposal_id }, WEB);
    expect(h.repos.settings.get('entryStrategy')).toBe('ruleset_resource');
    expect(readFileSync(h.profilePath, 'utf8')).not.toContain('sfe-entry-');
  }

  test('normal mode still succeeds on the original rules without writing anything, and remerge stays available afterwards', async () => {
    await strategyChangedBeforeRemerge();
    const writes = { ...h.fake.calls };
    const n = await enterNormal(null);
    const op = h.repos.operations.get(n)!;
    expect(op.error).toBeNull();
    expect(op).toMatchObject({ phase: 'NORMAL_RESTORED', status: 'succeeded' });
    const last = h.repos.operations.listSteps(n).at(-1)!.message;
    expect(last).toBe('已进入普通模式：Safari 按 Surge 原规则发出请求');
    expect(h.repos.operations.listSteps(n).map((st) => st.message).join('\n')).toContain('尚未写入工作配置');
    const route = h.repos.routeState.get();
    expect(route).toMatchObject({ entryMode: 'NORMAL', phase: 'idle', activeEnvironmentId: null });
    expect(route.warnings).toEqual([]);
    expect(h.app.views.routeView().normalModeOffered).toBe(false);
    // 没有写入 Surge 或入口文件：不加临时规则、不创建入口规则集文件、不改选 SFE-ROUTE、不结束连接
    for (const k of ['addTempRule', 'removeTempRule', 'selectGroupPolicy', 'killRequest', 'reloadProfile'] as const) expect(h.fake.calls[k] ?? 0).toBe(writes[k] ?? 0);
    for (const name of Object.values(ENTRY_RULESET_FILES)) expect(() => readFileSync(join(h.surgeDir, name), 'utf8')).toThrow();
    expectOriginalRules();
    // 恢复路径仍在：重新合并的入口检查通过（入口为普通模式），没有被普通模式留下的 UNKNOWN 卡住
    const p = await h.app.remergePreview(WEB);
    expect(p.checks.find((c) => c.name === 'entry')!.ok).toBe(true);
    expect(p.managedDiff).toContain('RULE-SET');
    const acc = await h.app.remergeCommit({ request_id: rid(), preview_digest: p.preview_digest }, WEB);
    await h.idle();
    expect(h.repos.operations.get(acc.operation_id)!.phase).toBe('COMPLETED');
    expect(readFileSync(h.profilePath, 'utf8')).toContain('sfe-entry-');
    // 重新合并之后（经用户确认的那一次同一配置重载）普通模式照常：入口文件为占位规则，已是普通模式
    const reloads = h.fake.calls.reloadProfile ?? 0;
    const n2 = await enterNormal(null);
    expect(h.repos.operations.get(n2)!.phase).toBe('NORMAL_RESTORED');
    expect(h.repos.routeState.get()).toMatchObject({ entryMode: 'NORMAL', phase: 'idle', activeEnvironmentId: null });
    expect(safariOutcome(h, 'daily.example.test').policyName).toBe('Daily');
    expect(safariOutcome(h).rule).toBe('FINAL,DIRECT');
    expect(h.fake.calls.reloadProfile ?? 0).toBe(reloads);
  });

  test('ruleset_resource entry not yet written: an activation stops before its first write (RESOURCE_MISSING), the route is untouched, and normal mode still succeeds', async () => {
    await strategyChangedBeforeRemerge();
    // 改用新策略让依赖入口策略的能力回到待验证：按新策略重新记录（测试专用），只剩入口尚未写入这一条
    h.grant(ALL_CAPS);
    expect(h.repos.settings.get('entryStrategy')).toBe('ruleset_resource');
    const env = (await createEnv(h, 'US-Buyer-A', '203.0.113.10')).environment_id!;
    await bind(h, PROFILE_A, env);
    const before = h.repos.routeState.get();
    const writes = { ...h.fake.calls };
    const a = await h.app.activate(env, { request_id: rid('act') }, WEB);
    await h.idle();
    const op = h.repos.operations.get(a.operation_id)!;
    expect(op).toMatchObject({ phase: 'FAILED', status: 'failed' });
    expect(op.error?.code).toBe('RESOURCE_MISSING');
    expect(op.error?.message).toContain('重新合并');
    expect(h.repos.routeState.get()).toMatchObject({ entryMode: 'NORMAL', phase: 'idle', routeEpoch: before.routeEpoch, activationSnapshot: null, selectedNode: before.selectedNode });
    for (const k of ['addTempRule', 'removeTempRule', 'selectGroupPolicy', 'killRequest'] as const) expect(h.fake.calls[k] ?? 0).toBe(writes[k] ?? 0);
    for (const name of Object.values(ENTRY_RULESET_FILES)) expect(() => readFileSync(join(h.surgeDir, name), 'utf8')).toThrow();
    const n = await enterNormal(null);
    expect(h.repos.operations.get(n)!.phase).toBe('NORMAL_RESTORED');
    expectOriginalRules();
  });

  test('rule match unavailable: the not-yet-written entry is judged from Surge\'s effective rule list only; normal mode still succeeds and says so', async () => {
    await strategyChangedBeforeRemerge();
    h.fake.matchRule = async () => {
      throw capabilityUnverified('matchRule');
    };
    const n = await enterNormal(null);
    expect(h.repos.operations.get(n)!).toMatchObject({ phase: 'NORMAL_RESTORED', status: 'succeeded' });
    const steps = h.repos.operations.listSteps(n).map((st) => st.message);
    expect(steps.some((m) => m.includes('尚未写入工作配置') && m.includes('只按有效规则列表判断'))).toBe(true);
    // 有效规则列表已表明没有规则能把 Safari 交给 SFE-ROUTE：路由不带 entry_unverified（§5.2），完成说明照常
    expect(h.repos.routeState.get()).toMatchObject({ entryMode: 'NORMAL', phase: 'idle', warnings: [] });
    expect(steps.at(-1)).toBe('已进入普通模式：Safari 按 Surge 原规则发出请求');
    expectOriginalRules();
    const p = await h.app.remergePreview(WEB);
    expect(p.checks.find((c) => c.name === 'entry')!.ok).toBe(true);
  });
});

describe('entry strategy changed before remerge, and rule match fails transiently (not "unavailable") during normal mode (§5.2)', () => {
  test('normal mode completes from Surge\'s effective rule list (no entry rule, nothing routed to SFE-ROUTE): no REJECT hold, no buyer-exit warning, and remerge stays available', async () => {
    h = await createHarness({ entryStrategy: 'temp_rule' });
    const { proposal_id } = await h.app.proposeCapability(
      {
        request_id: rid('prop'),
        key: 'runtime_entry_modes',
        proposed_status: 'supported',
        context: { ...anyContext(), surgeVersion: '6.10.0', surgeBuild: '12500' },
        summary: '入口模式（合成）',
        evidence_digest: 'sha256:0123456789abcdef',
        entry_strategy: 'ruleset_resource',
      },
      AGENT,
    );
    await h.app.confirmCapability({ request_id: rid(), action: 'confirm', proposal_id }, WEB);
    expect(h.repos.settings.get('entryStrategy')).toBe('ruleset_resource');
    // 命令超时（CLI 适配器的形状）：不是「rule match 不可用」，结果未知
    h.fake.matchRule = async () => {
      throw new SfeError('SURGE_UNREACHABLE', '连接 Surge 失败：命令超时');
    };
    const selects = h.fake.calls.selectGroupPolicy ?? 0;
    const n = await enterNormal(null);
    const op = h.repos.operations.get(n)!;
    expect(op.error).toBeNull();
    expect(op).toMatchObject({ phase: 'NORMAL_RESTORED', status: 'succeeded' });
    const steps = h.repos.operations.listSteps(n).map((st) => st.message);
    expect(steps.some((m) => m.includes('尚未写入工作配置') && m.includes('只按有效规则列表判断'))).toBe(true);
    expect(steps.join('\n')).not.toContain('请先在维护中重新合并');
    // 没有改选 SFE-ROUTE、没有声称 Safari 的连接可能在买家出口上（它从未经过 SFE-ROUTE）
    expect(h.fake.calls.selectGroupPolicy ?? 0).toBe(selects);
    const route = h.repos.routeState.get();
    expect(route).toMatchObject({ entryMode: 'NORMAL', phase: 'idle', activeEnvironmentId: null });
    // 也不带 entry_unverified：判断只依据有效规则列表，而它已表明没有规则能把 Safari 交给 SFE-ROUTE（§5.2）
    expect(route.warnings).toEqual([]);
    expect(route.selectedNode).not.toBe('REJECT');
    expectOriginalRules();
    const p = await h.app.remergePreview(WEB);
    expect(p.checks.find((c) => c.name === 'entry')!.ok).toBe(true);
  });
});

describe('the entry RULE-SET lines removed or reordered in the working profile outside the app while an environment is in use (ruleset_resource, §5.2, §5.5)', () => {
  /** 文件中除见证规则之外只有占位规则（parseEntryRuleSetFile 去掉注释与见证行）。 */
  const placeholderOnly = (bit: 'udp' | 'verify' | 'block' | 'active'): boolean => {
    const { bodies, witness } = parseEntryRuleSetFile(bit, readFileSync(join(h.surgeDir, ENTRY_RULESET_FILES[bit]), 'utf8'));
    return witness !== null && bodies.length === 1 && bodies[0] === normalizeRuleText(ENTRY_PLACEHOLDER_RULE);
  };

  /** 用户在 Surge 的编辑器中改动工作配置（或恢复了一份旧副本）并保存，Surge 重新加载它。 */
  async function editEntrySegment(mode: 'block' | 'one-line' | 'reorder'): Promise<void> {
    const lines = readFileSync(h.profilePath, 'utf8').split('\n');
    let out: string[];
    if (mode === 'block') {
      const b = lines.findIndex((l) => l.startsWith('# SFE-BEGIN entry'));
      const e = lines.findIndex((l) => l.startsWith('# SFE-END entry'));
      expect(b).toBeGreaterThanOrEqual(0);
      out = [...lines.slice(0, b), ...lines.slice(e + 1)];
    } else if (mode === 'one-line') {
      out = lines.filter((l) => !l.startsWith('RULE-SET,sfe-entry-udp'));
    } else {
      out = [...lines];
      const bi = out.findIndex((l) => l.startsWith('RULE-SET,sfe-entry-block'));
      const ai = out.findIndex((l) => l.startsWith('RULE-SET,sfe-entry-active'));
      [out[bi], out[ai]] = [out[ai]!, out[bi]!];
    }
    writeFileSync(h.profilePath, out.join('\n'));
    await h.fake.reloadProfile();
    await h.app.runPeriodicReconcile();
  }

  test.each(['block', 'one-line', 'reorder'] as const)('%s: normal mode rewrites the entry files to placeholders and completes on the original rules; remerge then restores the segment and the environment can be used again', async (mode) => {
    h = await createHarness();
    const { envId } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    await editEntrySegment(mode);
    expect(h.repos.routeState.get()).toMatchObject({ phase: 'attention', entryMode: 'UNKNOWN' });
    expect(h.repos.routeState.get().warnings).toContain('managed_segments_changed');
    const reloads = h.fake.calls.reloadProfile ?? 0;
    const n = await enterNormal(envId);
    const op = h.repos.operations.get(n)!;
    expect(op.error).toBeNull();
    expect(op).toMatchObject({ phase: 'NORMAL_RESTORED', status: 'succeeded' });
    expect(h.repos.operations.listSteps(n).map((st) => st.message).join('\n')).toContain('已把入口规则集文件改写为占位规则');
    const route = h.repos.routeState.get();
    expect(route).toMatchObject({ entryMode: 'NORMAL', phase: 'idle', activeEnvironmentId: null });
    expect(route.warnings).toContain('managed_segments_changed');
    expect(route.warnings).not.toContain('entry_unverified');
    for (const bit of ['udp', 'verify', 'block', 'active'] as const) expect(placeholderOnly(bit)).toBe(true);
    // Safari 按原规则发出（不是 DIRECT 或 FINAL 的复制，也不经 SFE-ROUTE）；Chrome 从不命中本应用规则
    expect(safariOutcome(h, 'daily.example.test').policyName).toBe('Daily');
    expect(safariOutcome(h)).toMatchObject({ rule: 'FINAL,DIRECT', failed: false });
    expect(safariOutcome(h, FAKE_VERIFY_HOST)).toMatchObject({ rule: 'FINAL,DIRECT', failed: false });
    expect(safariOutcome(h, 'www.example.test', 'udp').rule).toBe('FINAL,DIRECT');
    expect(h.fake.simulateRequest({ processPath: FAKE_CHROME_PATH, host: FAKE_VERIFY_HOST, protocol: 'tcp' }).policyName).not.toBe('SFE-ROUTE');
    expect(h.fake.calls.reloadProfile ?? 0).toBe(reloads);
    // 恢复路径：重新合并的入口检查通过，恢复入口段之后 Surge 加载的是占位规则（普通模式）
    const p = await h.app.remergePreview(WEB);
    expect(p.checks.find((c) => c.name === 'entry')!.ok).toBe(true);
    const acc = await h.app.remergeCommit({ request_id: rid(), preview_digest: p.preview_digest }, WEB);
    await h.idle();
    expect(h.repos.operations.get(acc.operation_id)!.phase).toBe('COMPLETED');
    const restored = readFileSync(h.profilePath, 'utf8');
    expect(['udp', 'verify', 'block', 'active'].map((b) => restored.indexOf(`RULE-SET,sfe-entry-${b}.list`))).toEqual(
      [...['udp', 'verify', 'block', 'active'].map((b) => restored.indexOf(`RULE-SET,sfe-entry-${b}.list`))].sort((x, y) => x - y),
    );
    expect(safariOutcome(h)).toMatchObject({ rule: 'FINAL,DIRECT', failed: false });
    const n2 = await enterNormal(null);
    expect(h.repos.operations.get(n2)!.phase).toBe('NORMAL_RESTORED');
    // 之后可以照常使用环境
    const act = await h.app.activate(envId, { request_id: rid('act') }, WEB);
    await h.idle();
    const r = await verify(h, PROFILE_A, act.operation_id);
    expect(r.ok).toBe(true);
    expect(h.repos.operations.get(act.operation_id)!.phase).toBe('ACTIVE_VERIFIED');
  });

  test('rule match unavailable: the rewritten placeholder files are not claimed as witness-confirmed and Safari is not claimed to be on the original rules unconditionally', async () => {
    h = await createHarness();
    const { envId } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    await editEntrySegment('one-line');
    h.fake.matchRule = async () => {
      throw capabilityUnverified('matchRule');
    };
    const n = await enterNormal(envId);
    expect(h.repos.operations.get(n)!).toMatchObject({ phase: 'NORMAL_RESTORED', status: 'succeeded' });
    const step = h.repos.operations.listSteps(n).map((st) => st.message).find((m) => m.includes('已把入口规则集文件改写为占位规则'))!;
    expect(step).toBeDefined();
    expect(step).not.toContain('由见证确认已加载');
    expect(step).toContain('未经见证确认已加载（rule match 不可用时按文件监视上限等满）');
    expect(step).not.toMatch(/，Safari 按原规则发出；/);
    expect(step).toContain('文件监视比上限慢时可能仍加载着改写之前的入口');
    expect(step).toContain('未经运行时求值确认');
    // 收紧未经确认：路由带 entry_unverified，SFE-ROUTE 改选 REJECT（失败即关闭）
    expect(h.repos.routeState.get().warnings).toEqual(expect.arrayContaining(['entry_unverified', 'buyer_exit_connections_unconfirmed']));
    expect(await h.fake.getGroupSelection('SFE-ROUTE')).toBe('REJECT');
  });

  test('an activation while the segment is damaged stops before its first write (no block written, SFE-ROUTE untouched) and says how to recover', async () => {
    h = await createHarness();
    const { envId } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const nodeA = h.repos.routeState.get().selectedNode!;
    await editEntrySegment('one-line');
    const files = Object.fromEntries(Object.values(ENTRY_RULESET_FILES).map((n) => [n, readFileSync(join(h.surgeDir, n), 'utf8')]));
    const selects = h.fake.calls.selectGroupPolicy ?? 0;
    const a = await h.app.activate(envId, { request_id: rid('act') }, WEB);
    await h.idle();
    const op = h.repos.operations.get(a.operation_id)!;
    expect(op).toMatchObject({ phase: 'FAILED', status: 'failed' });
    expect(op.error?.code).toBe('RESOURCE_MISSING');
    expect(op.error?.message).toContain('请先进入普通模式，再在维护中重新合并');
    expect(h.repos.operations.listSteps(a.operation_id).some((st) => st.phase === 'SAFARI_BLOCKED' || st.phase === 'ROLLING_BACK')).toBe(false);
    expect(h.fake.calls.selectGroupPolicy ?? 0).toBe(selects);
    expect(await h.fake.getGroupSelection('SFE-ROUTE')).toBe(nodeA);
    for (const [n, text] of Object.entries(files)) expect(readFileSync(join(h.surgeDir, n), 'utf8')).toBe(text);
  });
});

describe('an older queued activation never runs after a newer normal mode that already started (claim order broken by a backward wall-clock step)', () => {
  test.each(['ruleset_resource', 'temp_rule'] as const)('%s: activation accepted, clock steps back 1 s, normal mode accepted → the activation is superseded, the route stays idle NORMAL and Safari keeps the original rules', async (entryStrategy) => {
    h = await createHarness({ entryStrategy });
    const env = (await createEnv(h, 'US-Buyer-A', '203.0.113.10')).environment_id!;
    await bind(h, PROFILE_A, env);
    const daily = h.fake.simulateRequest({ processPath: FAKE_SAFARI_PATH, host: 'www.example.test', protocol: 'tcp', longLived: true });
    // 执行器忙（这里停下）：两个请求都排队；受理之间墙上时钟回拨（例如 NTP 校正），普通模式的可用时间反而更早
    await h.app.executor.stop();
    const act = (await h.app.activate(env, { request_id: rid('act') }, WEB)).operation_id;
    h.clock.set(h.clock.now().getTime() - 1000);
    const n = (await h.app.enterNormal({ request_id: rid('normal') }, WEB)).operation_id;
    expect(h.repos.operations.get(n)!.payload).toMatchObject({ normal: { queuedBehind: [act] } });
    const writes = h.fake.calls.selectGroupPolicy ?? 0;
    h.app.executor.start();
    await h.idle();
    await h.clock.advanceAsync(2000);
    await h.idle();
    expect(h.repos.operations.get(n)!.phase).toBe('NORMAL_RESTORED');
    expect(h.repos.operations.get(act)).toMatchObject({ phase: 'SUPERSEDED', status: 'superseded', supersededBy: n });
    expect(h.repos.operations.listSteps(act).some((s) => s.phase === 'SAFARI_BLOCKED' || s.phase === 'VERIFY_ONLY')).toBe(false);
    expect(h.repos.routeState.get()).toMatchObject({ phase: 'idle', entryMode: 'NORMAL', operationId: n, activationSnapshot: null });
    expect(h.fake.calls.selectGroupPolicy ?? 0).toBe(writes);
    expect(safariOutcome(h)).toMatchObject({ rule: 'FINAL,DIRECT', failed: false });
    expect(safariOutcome(h, FAKE_VERIFY_HOST)).toMatchObject({ rule: 'FINAL,DIRECT', failed: false });
    // 按原规则发出的 Safari 长连接没有被结束
    expect((await h.fake.listActiveRequests()).some((r) => r.id === daily.id)).toBe(true);
  });
});
