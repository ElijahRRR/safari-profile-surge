// 优先级检查覆盖夹在本应用入口规则之间的规则（docs/ARCHITECTURE.md §5.5）：对账报告 precedence_violation，
// 普通模式仍然撤销本应用入口（§5.2），从不移除或修改用户的临时规则。只用合成数据。

import { afterEach, describe, expect, test } from 'vitest';
import { FAKE_SAFARI_PATH, FAKE_VERIFY_HOST } from '../../src/surge/fake.js';
import { tempRuleText } from '../../src/surge/generate.js';
import { PROFILE_A, WEB, bind, createEnv, createHarness, rid, safariOutcome, type Harness } from './harness.js';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

/** 激活到 VERIFY_ONLY 等待后取消：回滚停在 BLOCKED（临时规则 {block}，没有切换前的路由）。 */
async function activateThenCancel(env: string): Promise<void> {
  const a = await h.app.activate(env, { request_id: rid() }, WEB);
  await h.idle();
  expect(h.repos.operations.get(a.operation_id)!.phase).toBe('VERIFY_ONLY');
  await h.app.cancelOperation(a.operation_id, { request_id: rid() }, WEB);
  await h.idle();
}

describe('temp_rule: a user rule between app entry rules', () => {
  test('reconcile reports precedence_violation; normal mode still undoes the entry and keeps the user rule', async () => {
    h = await createHarness({ entryStrategy: 'temp_rule' });
    const env = (await createEnv(h, 'US-Buyer-A', '203.0.113.10')).environment_id!;
    await bind(h, PROFILE_A, env);
    // 取消等待中的激活：回滚停在 BLOCKED（{block}）
    await activateThenCancel(env);
    expect(h.repos.routeState.get().entryMode).toBe('BLOCKED');
    const cfg = { processPaths: h.repos.settings.get('safariProcessPaths'), verifyHost: FAKE_VERIFY_HOST };
    const block = tempRuleText('block', cfg);
    const user = 'DOMAIN-SUFFIX,amazon.com,DIRECT';
    // 尾部插入的交错（用户在本应用两次写入之间加了临时规则）：用户规则落在 block 之前
    await h.fake.removeTempRule(block);
    await h.fake.addTempRule(user);
    await h.fake.addTempRule(block);
    expect(h.fake.tempRules).toEqual([user, block]);
    expect(safariOutcome(h, 'www.amazon.com').rule).toBe(user);

    await h.app.runPeriodicReconcile();
    const route = h.repos.routeState.get();
    expect(route.warnings).toContain('precedence_violation');
    expect(route.phase).toBe('attention');
    const status = await h.app.refreshSurge(WEB);
    expect(status.precedenceIssues).toContainEqual({ rule: user, source: 'temp_rule', severity: 'blocking' });

    const n = await h.app.enterNormal({ request_id: rid('normal') }, WEB);
    await h.idle();
    const op = h.repos.operations.get(n.operation_id!)!;
    expect(op.phase).toBe('NORMAL_RESTORED');
    expect((op.result as { precedenceIssues: unknown[] }).precedenceIssues).toContainEqual({ rule: user, source: 'temp_rule', severity: 'blocking' });
    expect(h.repos.routeState.get()).toMatchObject({ entryMode: 'NORMAL', phase: 'idle', activeEnvironmentId: null });
    expect(h.fake.tempRules).toEqual([user]);
    expect(safariOutcome(h, 'daily.example.test').policyName).toBe('Daily');
    expect(h.fake.calls.reloadProfile ?? 0).toBe(0);
  });

  /**
   * temp_rule 下先激活一次再取消（回滚停在 BLOCKED [旧 block]），再模拟进程路径变化（合成路径）：
   * 期望的规则文本随之改变，一次超时的写入留下新文本 block 的意图记录（尚未生效）。
   */
  async function blockedWithPendingNewBlock(): Promise<{ env: string; newBlock: string }> {
    h = await createHarness({ entryStrategy: 'temp_rule' });
    const env = (await createEnv(h, 'US-Buyer-A', '203.0.113.10')).environment_id!;
    await bind(h, PROFILE_A, env);
    await activateThenCancel(env);
    expect(h.repos.routeState.get().entryMode).toBe('BLOCKED');
    const paths = [FAKE_SAFARI_PATH, '/Applications/Safari Technology Preview.app/Contents/MacOS/Safari Technology Preview'];
    h.repos.settings.set('safariProcessPaths', paths);
    const newBlock = tempRuleText('block', { processPaths: paths, verifyHost: FAKE_VERIFY_HOST });
    h.repos.managedObjects.upsertIntent({ kind: 'temp_rule', identity: newBlock, contentDigest: null, state: 'pending_add', createdByOperation: null });
    return { env, newBlock };
  }

  function expectSafariBlocked(): void {
    for (const protocol of ['tcp', 'udp'] as const) {
      const r = safariOutcome(h, 'www.example.test', protocol);
      expect(r.failed && r.policyName?.startsWith('REJECT')).toBe(true);
    }
  }

  test('a rollback whose cleanup would let Safari fall to the user rule refuses before any write: Safari stays blocked, needs attention; normal mode still undoes the entry', async () => {
    const { env, newBlock } = await blockedWithPendingNewBlock();
    const user = 'DOMAIN-SUFFIX,example.test,DIRECT';
    // 受控检查（第 2 步）通过之后：用户在尾部加了一条临时规则，之前超时的新 block 写入随后才生效
    // → [旧 block, 用户规则, 新 block]（duplicate_block）
    const members = h.fake.getGroupMembers.bind(h.fake);
    let landed = false;
    h.fake.getGroupMembers = async (group: string) => {
      if (!landed) {
        landed = true;
        await h.fake.addTempRule(user);
        await h.fake.addTempRule(newBlock);
      }
      return members(group);
    };
    const a = await h.app.activate(env, { request_id: rid() }, WEB);
    await h.idle();
    expect(landed).toBe(true);
    const op = h.repos.operations.get(a.operation_id!)!;
    // 第 6 步（未标为撤销）以 UNKNOWN_STATE 拒绝 → 回滚撤销到 BLOCKED：清理会先移除排在用户规则之前的旧 block，
    // 让 Safari 经用户规则直连 → 写入之前拒绝，回滚停在需要处理
    expect(op.phase).toBe('BLOCKED_NEEDS_ATTENTION');
    expect((op.result as { entryCleanup?: unknown[] } | null)?.entryCleanup ?? []).toEqual([]);
    expect(h.repos.routeState.get()).toMatchObject({ phase: 'attention', entryMode: 'UNKNOWN' });
    expect(h.fake.tempRules.slice(1)).toEqual([user, newBlock]);
    expect(h.fake.tempRules).toHaveLength(3);
    expectSafariBlocked();

    // 普通模式（中间阻断标为 towardNormal）照常撤销本应用入口，用户规则不动
    const n = await h.app.enterNormal({ request_id: rid('normal') }, WEB);
    await h.idle();
    const normal = h.repos.operations.get(n.operation_id!)!;
    expect(normal.error).toBeNull();
    expect(normal.phase).toBe('NORMAL_RESTORED');
    expect((normal.result as { precedenceIssues: unknown[] }).precedenceIssues).toContainEqual({ rule: user, source: 'temp_rule', severity: 'blocking' });
    expect(h.repos.routeState.get()).toMatchObject({ entryMode: 'NORMAL', phase: 'idle' });
    expect(h.fake.tempRules).toEqual([user]);
    expect(h.fake.calls.reloadProfile ?? 0).toBe(0);
  });

  test('with the user rule already between the old and the new block: activation stops at the pre-write check, normal mode still reaches NORMAL', async () => {
    const { env, newBlock } = await blockedWithPendingNewBlock();
    const user = 'DOMAIN-SUFFIX,example.test,DIRECT';
    await h.fake.addTempRule(user);
    await h.fake.addTempRule(newBlock);
    const before = h.fake.tempRules;
    const a = await h.app.activate(env, { request_id: rid() }, WEB);
    await h.idle();
    const op = h.repos.operations.get(a.operation_id!)!;
    expect(op.phase).toBe('FAILED');
    expect(op.error!.code).toBe('PRECEDENCE_VIOLATION');
    expect(h.fake.tempRules).toEqual(before);
    expectSafariBlocked();
    const n = await h.app.enterNormal({ request_id: rid('normal') }, WEB);
    await h.idle();
    expect(h.repos.operations.get(n.operation_id!)!.phase).toBe('NORMAL_RESTORED');
    expect(h.fake.tempRules).toEqual([user]);
  });
});
