// 普通模式永远可用（docs/ARCHITECTURE.md §5.2、§6.5）：优先级问题、被外部修改的本应用入口文件、结束 Safari 连接失败
// 都不能让它卡在 BLOCKED。只撤销本应用入口，从不改成 DIRECT/FINAL、不重载、不切换配置。只用合成数据。

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { ENTRY_RULESET_FILES } from '@sfe/contract';
import { FAKE_SAFARI_PATH } from '../../src/surge/fake.js';
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
