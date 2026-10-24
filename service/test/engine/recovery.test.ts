import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { ENTRY_RULESET_FILES, NODE_RESOURCE_FILE, ROUTE_GROUP_NAME, type RollbackResult } from '@sfe/contract';
import { FAKE_CHROME_PATH, FAKE_VERIFY_HOST } from '../../src/surge/fake.js';
import { capabilityUnverified } from '../../src/surge/primitives.js';
import { payloadOf } from '../../src/domain/operations.js';
import type { SurgeAdapter } from '../../src/ports.js';
import { PROFILE_A, PROFILE_B, PROFILE_C, WEB, activeEnv, bind, createEnv, createHarness, entryWrites, envInput, rid, safariOutcome, verify, type Harness } from './harness.js';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

/** 让某个 FakeSurge 原语挂起（模拟进程在调用中途崩溃）。 */
function hang(name: 'updateExternalResource' | 'selectGroupPolicy' | 'getGroupMembers' | 'listActiveRequests', when: (...args: string[]) => boolean = () => true): { entered: () => boolean; restore: () => void } {
  const fake = h.fake as unknown as Record<string, (...args: string[]) => Promise<unknown>>;
  const orig = fake[name]!.bind(h.fake);
  let entered = false;
  fake[name] = (...args: string[]) => {
    if (!when(...args)) return orig(...args);
    entered = true;
    return new Promise(() => undefined);
  };
  return {
    entered: () => entered,
    restore: () => {
      fake[name] = orig;
    },
  };
}

/**
 * 让 ruleset_resource 的入口写入挂在“等待 Surge 重新加载”上（模拟进程在写入文件之后、读回确认之前崩溃）：
 * 只拦截刚写入、尚未被 Surge 加载的那一版见证的 rule match（载入时对已加载见证的读回照常）。bit 为空时任一入口文件。
 */
function hangEntryWrite(bit?: string): { entered: () => boolean; restore: () => void } {
  const fake = h.fake as unknown as { matchRule: (input: { host: string; processPath: string }) => Promise<unknown> };
  const orig = fake.matchRule.bind(h.fake);
  let entered = false;
  fake.matchRule = (input: { host: string; processPath: string }) => {
    // 见证探测按合成进程路径识别（/var/empty/sfe-entry-witness-<位>-<标记>，目标是文档地址 IP）
    const m = /^\/var\/empty\/sfe-entry-witness-(udp|verify|block|active)-[0-9a-z]+$/.exec(input.processPath);
    const loaded = m ? (h.fake.loadedContent(`ruleset:sfe-entry-${m[1]}.list`) ?? '').includes(input.processPath) : true;
    if (!m || loaded || (bit !== undefined && m[1] !== bit)) return orig(input);
    entered = true;
    return new Promise(() => undefined);
  };
  return {
    entered: () => entered,
    restore: () => {
      fake.matchRule = orig;
    },
  };
}

async function until(cond: () => boolean): Promise<void> {
  const end = Date.now() + 5000;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 2));
  expect(cond()).toBe(true);
}

function nodeNames(): string[] {
  return readFileSync(join(h.surgeDir, NODE_RESOURCE_FILE), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '' && !l.startsWith('#'))
    .map((l) => l.split('=')[0]!.trim());
}

describe('crash recovery (same SQLite file, same Surge)', () => {
  test('crash while waiting for Surge to re-read the resource → FAILED UNKNOWN_STATE; next publish converges without duplicate nodes', async () => {
    h = await createHarness({ dbFile: true });
    const envId = (await createEnv(h, 'US-Buyer-A', '203.0.113.10')).environment_id!;
    // 写入节点资源之后第一次读组成员就是等待重新读取（写入之前另读一次组成员作为对照）；发布从不调用外部资源更新
    // （Surge 6.10 跳过本地资源）
    const resourceBefore = readFileSync(join(h.surgeDir, NODE_RESOURCE_FILE), 'utf8');
    const stuck = hang('getGroupMembers', () => readFileSync(join(h.surgeDir, NODE_RESOURCE_FILE), 'utf8') !== resourceBefore);
    const env = h.repos.environments.get(envId)!;
    const upd = await h.app.updateEnvironment(envId, { request_id: rid(), expected_revision: env.revision, changes: { proxy: { port: 1081 } } }, WEB);
    await until(stuck.entered);
    expect(h.repos.operations.get(upd.operation_id)!.phase).toBe('DEPLOYING');
    stuck.restore();
    await h.crash();
    await h.idle();
    const op = h.repos.operations.get(upd.operation_id)!;
    expect(op.phase).toBe('FAILED');
    expect(op.error?.code).toBe('UNKNOWN_STATE');
    expect(h.repos.environments.get(envId)!.deployedProxyRevision).toBe(1);
    // 待部署的修改保留，由一次发布收敛
    const pub = await h.app.publishPending({ request_id: rid() }, WEB);
    await h.idle();
    expect(h.repos.operations.get(pub.operation_id)!.phase).toBe('READY_FOR_NEXT_OPEN');
    expect(h.repos.environments.get(envId)!.deployedProxyRevision).toBe(2);
    const names = nodeNames();
    expect(new Set(names).size).toBe(names.length);
    expect(h.fake.calls.reloadProfile ?? 0).toBe(0);
    expect(h.fake.calls.updateExternalResource ?? 0).toBe(0);
  });

  test('crash mid-switch → rollback from the activation snapshot; selection never left on an unverified exit', async () => {
    h = await createHarness({ dbFile: true });
    const envId = (await createEnv(h, 'US-Buyer-A', '203.0.113.10')).environment_id!;
    await bind(h, PROFILE_A, envId);
    const stuck = hang('selectGroupPolicy', (_g, p) => p !== 'REJECT');
    const a = await h.app.activate(envId, { request_id: rid() }, WEB);
    await until(stuck.entered);
    expect(h.repos.routeState.get().entryMode).toBe('BLOCKED');
    stuck.restore();
    await h.crash();
    await h.idle();
    const op = h.repos.operations.get(a.operation_id)!;
    expect(['FAILED', 'BLOCKED_NEEDS_ATTENTION']).toContain(op.phase);
    expect(op.error?.code).toBe('UNKNOWN_STATE');
    expect(await h.fake.getGroupSelection(ROUTE_GROUP_NAME)).toBe('REJECT');
    expect(h.repos.routeState.get().activeEnvironmentId).toBeNull();
    // 之后的显式激活可以完成
    const again = await h.app.activate(envId, { request_id: rid() }, WEB);
    await h.idle();
    await verify(h, PROFILE_A, again.operation_id);
    expect(h.repos.operations.get(again.operation_id)!.phase).toBe('ACTIVE_VERIFIED');
  });

  /** A 使用中，B 已部署并关联；B 的激活挂在某次规则集刷新上时崩溃。 */
  async function crashMidSwitchToB(bit: string | undefined, opts: { deferPreflight?: boolean } = {}) {
    const { envId: a } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const b = (await createEnv(h, 'US-Buyer-B', '203.0.113.11')).environment_id!;
    await bind(h, PROFILE_B, b);
    if (opts.deferPreflight) h.revoke(['independent_node_preflight']);
    const epoch = h.repos.routeState.get().routeEpoch;
    const stuck = hangEntryWrite(bit);
    const act = await h.app.activate(b, { request_id: rid(), old_session_policy: 'closed_confirmed', confirmed_environment_id: a }, WEB);
    await until(stuck.entered);
    const op = h.repos.operations.get(act.operation_id)!;
    stuck.restore();
    return { a, b, epoch, opId: act.operation_id, phaseAtCrash: op.phase, stageAtCrash: (op.payload as { route: { stage: string } }).route.stage };
  }

  test('crash during the BLOCKED write while the op phase is still PREFLIGHT_OK → rolled back, writes not replayed', async () => {
    h = await createHarness({ dbFile: true });
    const { a, epoch, opId, phaseAtCrash, stageAtCrash } = await crashMidSwitchToB(undefined);
    // 操作阶段还停在写入前的值，但 epoch 已递增、切换已开始
    expect(phaseAtCrash).toBe('PREFLIGHT_OK');
    expect(stageAtCrash).toBe('switching');
    await h.crash();
    await h.idle();
    const op = h.repos.operations.get(opId)!;
    expect(op.phase).toBe('FAILED');
    expect(op.error?.code).toBe('UNKNOWN_STATE');
    expect(h.repos.operations.listSteps(opId).some((s) => s.phase === 'VERIFY_ONLY')).toBe(false);
    const route = h.repos.routeState.get();
    expect(route.routeEpoch).toBe(epoch + 1);
    expect(route).toMatchObject({ phase: 'failed', entryMode: 'BLOCKED', activeEnvironmentId: a, selectedNode: h.repos.proxyRevisions.get(a, 1)!.nodeName });
    expect(route.warnings).toContain('rollback_needs_reverify');
    expect(safariOutcome(h).failed).toBe(true);
    expect(h.fake.calls.reloadProfile ?? 0).toBe(0);
  });

  test('crash after the deferred preflight (op phase back at PREFLIGHT_OK, target node selected) → rolled back to the previous node', async () => {
    h = await createHarness({ dbFile: true });
    const { a, b, epoch, opId, phaseAtCrash } = await crashMidSwitchToB('verify', { deferPreflight: true });
    expect(phaseAtCrash).toBe('PREFLIGHT_OK');
    expect(await h.fake.getGroupSelection(ROUTE_GROUP_NAME)).toBe(h.repos.proxyRevisions.get(b, 1)!.nodeName);
    await h.crash();
    await h.idle();
    const op = h.repos.operations.get(opId)!;
    expect(op.phase).toBe('FAILED');
    expect(h.repos.operations.listSteps(opId).filter((s) => s.message.includes('开始检查激活条件'))).toHaveLength(1);
    const route = h.repos.routeState.get();
    expect(route.routeEpoch).toBe(epoch + 1);
    const nodeA = h.repos.proxyRevisions.get(a, 1)!.nodeName;
    expect(route).toMatchObject({ phase: 'failed', entryMode: 'BLOCKED', activeEnvironmentId: a, selectedNode: nodeA });
    expect(await h.fake.getGroupSelection(ROUTE_GROUP_NAME)).toBe(nodeA);
    expect(safariOutcome(h, FAKE_VERIFY_HOST).failed).toBe(true);
  });

  /**
   * A 使用中，B 停在 VERIFY_ONLY 等待；C 取代 B 后在写入前失败，按快照回滚时挂在回滚的阻断写入上崩溃。
   * C 的 stage 仍是 pending、routeEpoch 仍为空（epoch 是 supersedeWaiting 递增的路由 epoch）。
   */
  async function crashDuringSupersedingRollback() {
    const { envId: a } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const b = (await createEnv(h, 'US-Buyer-B', '203.0.113.11')).environment_id!;
    await bind(h, PROFILE_B, b);
    const c = (await createEnv(h, 'US-Buyer-C', '203.0.113.12')).environment_id!;
    await bind(h, PROFILE_C, c);
    const first = await h.app.activate(b, { request_id: rid(), old_session_policy: 'closed_confirmed', confirmed_environment_id: a }, WEB);
    await h.idle();
    expect(h.repos.operations.get(first.operation_id)!.phase).toBe('VERIFY_ONLY');
    const stuck = hangEntryWrite();
    h.fake.failNext('getGroupMembers');
    const second = await h.app.activate(c, { request_id: rid(), old_session_policy: 'closed_confirmed', confirmed_environment_id: a }, WEB);
    await until(stuck.entered);
    const op = h.repos.operations.get(second.operation_id)!;
    expect(op.phase).toBe('ROLLING_BACK');
    expect(op.routeEpoch).toBeNull();
    expect((op.payload as { route: { stage: string } }).route.stage).toBe('pending');
    expect(h.repos.routeState.get()).toMatchObject({ phase: 'rolling_back', operationId: second.operation_id });
    stuck.restore();
    return { a, b, c, opId: second.operation_id };
  }

  test('crash during the rollback of a superseding activation that failed before writing → rollback resumed, switch never replayed', async () => {
    h = await createHarness({ dbFile: true });
    const { a, c, opId } = await crashDuringSupersedingRollback();
    const nodeA = h.repos.proxyRevisions.get(a, 1)!.nodeName;
    const nodeC = h.repos.proxyRevisions.get(c, 1)!.nodeName;
    const selects = h.fake.calls.selectGroupPolicy ?? 0;
    await h.crash();
    await h.idle();
    const op = h.repos.operations.get(opId)!;
    expect(op.phase).toBe('FAILED');
    expect(op.error?.code).toBe('UNKNOWN_STATE');
    const steps = h.repos.operations.listSteps(opId);
    expect(steps.filter((s) => s.message.includes('开始检查激活条件'))).toHaveLength(1);
    expect(steps.some((s) => s.phase === 'SAFARI_BLOCKED' || s.phase === 'VERIFY_ONLY')).toBe(false);
    // 只恢复切换前的节点，从不选择 C 的节点
    expect((h.fake.calls.selectGroupPolicy ?? 0) - selects).toBe(1);
    expect(await h.fake.getGroupSelection(ROUTE_GROUP_NAME)).toBe(nodeA);
    expect(await h.fake.getGroupSelection(ROUTE_GROUP_NAME)).not.toBe(nodeC);
    const route = h.repos.routeState.get();
    expect(route).toMatchObject({ phase: 'failed', entryMode: 'BLOCKED', activeEnvironmentId: a, selectedNode: nodeA, operationId: opId });
    expect(route.warnings).toContain('rollback_needs_reverify');
    expect(safariOutcome(h, FAKE_VERIFY_HOST).failed).toBe(true);
    expect(safariOutcome(h).failed).toBe(true);
    expect(h.fake.calls.reloadProfile ?? 0).toBe(0);
  });

  test('…and when the resumed rollback cannot restore the previous node, the entry still ends BLOCKED (never VERIFY_ONLY on an unverified exit)', async () => {
    h = await createHarness({ dbFile: true });
    const { opId } = await crashDuringSupersedingRollback();
    h.fake.failNext('getGroupMembers');
    await h.crash();
    await h.idle();
    const op = h.repos.operations.get(opId)!;
    expect(op.phase).toBe('BLOCKED_NEEDS_ATTENTION');
    const route = h.repos.routeState.get();
    expect(route).toMatchObject({ phase: 'attention', entryMode: 'BLOCKED', operationId: opId });
    expect(route.warnings).toContain('entry_unverified');
    expect(safariOutcome(h, FAKE_VERIFY_HOST).failed).toBe(true);
    expect(safariOutcome(h).failed).toBe(true);
  });

  test('VERIFY_ONLY waiting operation survives a restart and completes', async () => {
    h = await createHarness({ dbFile: true });
    const envId = (await createEnv(h, 'US-Buyer-A', '203.0.113.10')).environment_id!;
    await bind(h, PROFILE_A, envId);
    const a = await h.app.activate(envId, { request_id: rid() }, WEB);
    await h.idle();
    expect(h.repos.operations.get(a.operation_id)!.phase).toBe('VERIFY_ONLY');
    await h.crash();
    await h.idle();
    expect(h.repos.operations.get(a.operation_id)!.phase).toBe('VERIFY_ONLY');
    const r = await verify(h, PROFILE_A, a.operation_id);
    expect(r.ok).toBe(true);
    expect(h.repos.operations.get(a.operation_id)!.phase).toBe('ACTIVE_VERIFIED');
  });

  test('verification deadline still fires after a restart → rollback', async () => {
    h = await createHarness({ dbFile: true });
    const envId = (await createEnv(h, 'US-Buyer-A', '203.0.113.10')).environment_id!;
    await bind(h, PROFILE_A, envId);
    const a = await h.app.activate(envId, { request_id: rid() }, WEB);
    await h.idle();
    const begin = await h.native(PROFILE_A, { type: 'beginSafariVerification', operation_id: a.operation_id, amazon_tabs_open: false });
    expect(begin.ok).toBe(true);
    await h.crash();
    await h.clock.advanceAsync((h.repos.settings.get('safariVerifyTimeoutSec') + 5) * 1000);
    await h.idle();
    const op = h.repos.operations.get(a.operation_id)!;
    expect(op.phase).toBe('FAILED');
    expect(op.error?.code).toBe('SAFARI_VERIFY_TIMEOUT');
    // 原来是 NORMAL：保持 BLOCKED 并失败（§6.3.14），Safari 全部拒绝，没有活动环境
    const route = h.repos.routeState.get();
    expect(route.entryMode).toBe('BLOCKED');
    expect(route.activeEnvironmentId).toBeNull();
    expect(safariOutcome(h).failed).toBe(true);
  });

  test('active environment stays active across a restart (no writes on startup)', async () => {
    h = await createHarness({ dbFile: true });
    const { envId } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const writes = ['updateExternalResource', 'selectGroupPolicy', 'killRequest', 'reloadProfile'].map((k) => h.fake.calls[k] ?? 0);
    await h.crash();
    await h.idle();
    expect(['updateExternalResource', 'selectGroupPolicy', 'killRequest', 'reloadProfile'].map((k) => h.fake.calls[k] ?? 0)).toEqual(writes);
    const route = h.repos.routeState.get();
    expect(route.activeEnvironmentId).toBe(envId);
    expect(route.phase).toBe('active_verified');
  });

  test('startup sweep removes stale pending secret refs left by a crash', async () => {
    h = await createHarness({ dbFile: true });
    // 崩溃发生在“秘密已写入、主事务未提交”之间
    h.repos.tx(() => h.repos.secretRefs.insertPending({ ref: 'sec_stale0001', kind: 'proxy', ownerKind: 'proxy_revision', ownerId: 'env_x', createdAt: h.clock.now().toISOString() }));
    await h.store.put('sec_stale0001', 'synth-stale-value', 'proxy');
    h.clock.advance(11 * 60 * 1000);
    await h.crash();
    await h.idle();
    for (let i = 0; i < 50 && h.store.has('sec_stale0001'); i++) await new Promise((r) => setImmediate(r));
    expect(h.store.has('sec_stale0001')).toBe(false);
    expect(h.repos.secretRefs.get('sec_stale0001')).toBeNull();
  });

  test('a candidate --check directory left by a process killed during --check (plaintext proxy credentials) is removed at the next start', async () => {
    h = await createHarness({ dbFile: true });
    const tmpDir = join(h.dir, 'tmp');
    const fake = h.fake as unknown as { checkProfile: (path: string) => Promise<unknown> };
    const orig = fake.checkProfile.bind(h.fake);
    let entered = false;
    // surge-cli --check 卡住，随后进程被强制终止：checkCandidate 的 finally 不执行
    fake.checkProfile = () => {
      entered = true;
      return new Promise(() => undefined);
    };
    await h.app.createEnvironment({ request_id: rid('create'), environment: envInput('US-Buyer-A', '203.0.113.10', { password: 'synthOrphanPw7788' }) }, WEB);
    await until(() => entered);
    const left = readdirSync(tmpDir).filter((n) => n.startsWith('candidate-'));
    expect(left).toHaveLength(1);
    expect(readFileSync(join(tmpDir, left[0]!, NODE_RESOURCE_FILE), 'utf8')).toContain('synthOrphanPw7788');
    // tmp 中不是候选目录的条目，以及名称相符的符号链接，都不删除；候选目录内指向真实文件的符号链接只删除链接本身
    mkdirSync(join(h.dir, 'outside'));
    writeFileSync(join(h.dir, 'outside', 'keep.txt'), 'keep');
    symlinkSync(join(h.dir, 'outside', 'keep.txt'), join(tmpDir, left[0]!, 'linked-real.list'));
    symlinkSync(join(h.dir, 'outside'), join(tmpDir, 'candidate-link01'));
    writeFileSync(join(tmpDir, 'unrelated.txt'), 'x');
    fake.checkProfile = orig;
    await h.crash();
    await h.idle();
    expect(readdirSync(tmpDir).filter((n) => n.startsWith('candidate-')).sort()).toEqual(['candidate-link01']);
    expect(existsSync(join(tmpDir, left[0]!))).toBe(false);
    expect(readFileSync(join(h.dir, 'outside', 'keep.txt'), 'utf8')).toBe('keep');
    expect(existsSync(join(tmpDir, 'unrelated.txt'))).toBe(true);
  });

  test('a temp file of an atomic write into the Surge profile directory, left by a process killed between write and rename (plaintext buyer credentials), is removed at the next start; other dot-files are kept', async () => {
    h = await createHarness({ dbFile: true });
    const leftovers = [
      `.${NODE_RESOURCE_FILE}.sfe-tmp-0123456789abcdef`,
      `.${ENTRY_RULESET_FILES.active}.sfe-tmp-89abcdef01234567`,
      `.${basename(h.profilePath)}.sfe-tmp-fedcba9876543210`,
    ];
    const LEFTOVER_PW = 'synthLeftPw7788';
    for (const n of leftovers) writeFileSync(join(h.surgeDir, n), `SFE-N-E0001-US01-v001 = socks5, 203.0.113.10, 1080, username=synthUser, password=${LEFTOVER_PW}\n`, { mode: 0o600 });
    // 不是本应用文件的临时文件名、名称不完整的、不是点开头的、其他点文件：一概不碰
    const kept = ['.DS_Store', '.other.list.sfe-tmp-0123456789abcdef', `.${NODE_RESOURCE_FILE}.sfe-tmp-short`, `${NODE_RESOURCE_FILE}.sfe-tmp-0123456789abcdef`];
    for (const n of kept) writeFileSync(join(h.surgeDir, n), 'x');
    // 名称相符的符号链接不跟随、不删除
    writeFileSync(join(h.dir, 'outside.txt'), 'keep');
    const link = `.${ENTRY_RULESET_FILES.udp}.sfe-tmp-0011223344556677`;
    symlinkSync(join(h.dir, 'outside.txt'), join(h.surgeDir, link));
    await h.crash();
    await h.idle();
    for (const n of leftovers) expect(existsSync(join(h.surgeDir, n))).toBe(false);
    for (const n of kept) expect(existsSync(join(h.surgeDir, n))).toBe(true);
    expect(lstatSync(join(h.surgeDir, link)).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(h.dir, 'outside.txt'), 'utf8')).toBe('keep');
    expect(h.logs.join('\n')).not.toContain(LEFTOVER_PW);
    expect(h.logs.join('\n')).toContain('startup.profile_temp_files_removed');
  });
});

describe('crash recovery with a normal mode accepted behind the interrupted operation (§6.1 claim order)', () => {
  /** 记录重启之后领取的条目属于哪个操作（照常按执行器给出的优先级领取）。 */
  function recordClaims(): string[] {
    const order: string[] = [];
    const claim = h.repos.outbox.claimNext.bind(h.repos.outbox);
    h.repos.outbox.claimNext = (now, prefer) => {
      const row = claim(now, prefer);
      if (row) order.push(row.operationId);
      return row;
    };
    return order;
  }

  /**
   * 使用中环境 A 改代理（发布 P，environment.update）停在 WAITING_ROUTE；绑定场景到达后 P 开始切换，挂在选择新节点上（已递增
   * epoch、阻断、结束连接；opts.duringRollback：选择新节点失败，挂在回滚恢复切换前的节点上）；其间受理进入普通模式 N（排在 P 之后），
   * 然后服务崩溃。
   */
  async function crashMidPublishSwitchWithQueuedNormal(opts: { duringRollback?: boolean } = {}): Promise<{ envId: string; nodeA: string; P: string; N: string }> {
    const { envId } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const nodeA = h.repos.proxyRevisions.get(envId, 1)!.nodeName;
    const env = h.repos.environments.get(envId)!;
    const u = await h.app.updateEnvironment(envId, { request_id: rid(), expected_revision: env.revision, changes: { proxy: { host: '203.0.113.20' } } }, WEB);
    await h.idle();
    expect(h.repos.operations.get(u.operation_id)).toMatchObject({ kind: 'environment.update', phase: 'WAITING_ROUTE' });
    if (opts.duringRollback) h.fake.failNext('selectGroupPolicy');
    const stuck = hang('selectGroupPolicy', (_g, p) => p !== 'REJECT' && (!opts.duringRollback || p === nodeA));
    await h.native(PROFILE_A, { type: 'beginSafariVerification', operation_id: u.operation_id, amazon_tabs_open: false });
    await until(stuck.entered);
    expect(h.repos.operations.get(u.operation_id)).toMatchObject({ status: 'running', phase: opts.duringRollback ? 'ROLLING_BACK' : 'SAFARI_BLOCKED' });
    expect(h.repos.routeState.get()).toMatchObject({ entryMode: 'BLOCKED', operationId: u.operation_id });
    const n = await h.app.enterNormal({ request_id: rid(), old_session_policy: 'closed_confirmed', confirmed_environment_id: envId }, WEB);
    expect(h.repos.operations.get(n.operation_id)).toMatchObject({ status: 'queued', payload: { normal: { queuedBehind: [u.operation_id] } } });
    stuck.restore();
    return { envId, nodeA, P: u.operation_id, N: n.operation_id };
  }

  function expectOriginalRules(N: string): void {
    expect(h.repos.operations.get(N)!.phase).toBe('NORMAL_RESTORED');
    expect(h.repos.routeState.get()).toMatchObject({ phase: 'idle', entryMode: 'NORMAL', activeEnvironmentId: null, operationId: N });
    // Safari 按 Surge 原规则发出（合成工作配置的 FINAL,DIRECT），不是本应用入口的阻断或 SFE-ROUTE；Chrome 从不命中 Safari 规则
    expect(safariOutcome(h)).toMatchObject({ rule: 'FINAL,DIRECT', failed: false });
    expect(safariOutcome(h, FAKE_VERIFY_HOST)).toMatchObject({ rule: 'FINAL,DIRECT', failed: false });
    expect(h.fake.simulateRequest({ processPath: FAKE_CHROME_PATH, host: 'www.example.test', protocol: 'tcp' }).rule).toBe('FINAL,DIRECT');
  }

  for (const entryStrategy of ['ruleset_resource', 'temp_rule'] as const) {
    test(`[${entryStrategy}] crash mid active-environment publish switch with a queued normal mode → the interrupted switch is recovered (rolled back) first, then the normal mode leaves Safari on the original rules`, async () => {
      h = await createHarness({ entryStrategy });
      const { nodeA, P, N } = await crashMidPublishSwitchWithQueuedNormal();
      const order = recordClaims();
      await h.crash();
      await h.idle();
      // 重启前持有执行器的发布先按事实恢复（回滚到切换前的节点并保持阻断），之后才执行排在它之后的普通模式
      expect(order.indexOf(P)).toBe(0);
      expect(order.indexOf(N)).toBeGreaterThan(0);
      const pub = h.repos.operations.get(P)!;
      expect(pub).toMatchObject({ phase: 'FAILED', status: 'failed' });
      expect((pub.result as { rollback: RollbackResult }).rollback).toMatchObject({ restoredSelection: nodeA, entryModeAfter: 'BLOCKED' });
      expect(h.repos.operations.listSteps(P).at(-1)!.message).toContain('已回滚：恢复切换前的节点');
      expectOriginalRules(N);
    });
  }

  test('[ruleset_resource, rule match unavailable] the interrupted switch holds REJECT first (unconfirmed rollback); the normal mode then still ends on the original rules', async () => {
    h = await createHarness({ entryStrategy: 'ruleset_resource' });
    const { P, N } = await crashMidPublishSwitchWithQueuedNormal();
    h.fake.matchRule = async () => {
      throw capabilityUnverified('matchRule');
    };
    const order = recordClaims();
    await h.crash();
    await h.idle();
    expect(order.indexOf(P)).toBe(0);
    expect(h.repos.operations.get(P)!.phase).toBe('BLOCKED_NEEDS_ATTENTION');
    expect(h.repos.operations.get(N)!.phase).toBe('NORMAL_RESTORED');
    expect(h.repos.routeState.get()).toMatchObject({ phase: 'idle', entryMode: 'NORMAL', activeEnvironmentId: null, operationId: N });
    expect(safariOutcome(h)).toMatchObject({ rule: 'FINAL,DIRECT', failed: false });
  });

  test('crash during the rollback of an active-environment publish switch with a queued normal mode → the rollback is resumed first, then the normal mode', async () => {
    h = await createHarness();
    const { nodeA, P, N } = await crashMidPublishSwitchWithQueuedNormal({ duringRollback: true });
    const order = recordClaims();
    await h.crash();
    await h.idle();
    expect(order.indexOf(P)).toBe(0);
    expect(h.repos.operations.get(P)!.phase).toBe('FAILED');
    expect((h.repos.operations.get(P)!.result as { rollback: RollbackResult }).rollback.restoredSelection).toBe(nodeA);
    expectOriginalRules(N);
  });

  test('second line of defence: a crash-recovered switch whose route a later operation already took is superseded without touching Surge', async () => {
    h = await createHarness();
    const { P, N } = await crashMidPublishSwitchWithQueuedNormal();
    // 模拟错误的领取顺序（例如升级前的版本）：普通模式先于崩溃恢复中的发布执行并完成
    const writes = () => ({ select: h.fake.calls.selectGroupPolicy ?? 0, kill: h.fake.calls.killRequest ?? 0, ...entryWrites(h.fake) });
    let atRecovery: ReturnType<typeof writes> | null = null;
    const claim = h.repos.outbox.claimNext.bind(h.repos.outbox);
    h.repos.outbox.claimNext = (now, prefer) => {
      const row = claim(now, [[N], ...(prefer ?? [])]);
      if (row?.operationId === P) atRecovery = writes();
      return row;
    };
    await h.crash();
    await h.idle();
    const pub = h.repos.operations.get(P)!;
    expect(pub).toMatchObject({ phase: 'SUPERSEDED', status: 'superseded', supersededBy: N });
    expect(h.repos.operations.listSteps(P).at(-1)!.message).toContain('路由已由之后的操作接手');
    // 恢复的发布没有再写入 Surge（没有回到阻断、没有改选节点、没有结束连接）
    expect(atRecovery).not.toBeNull();
    expect(writes()).toEqual(atRecovery);
    expectOriginalRules(N);
  });

  test('…and when the later operation ended without confirming its undo (SFE-ROUTE still on an unverified node), the superseded switch is an end point: it moves SFE-ROUTE to REJECT and says so instead of "the route keeps its result" (§6.1, §6.3 step 14)', async () => {
    h = await createHarness();
    const { P, N } = await crashMidPublishSwitchWithQueuedNormal();
    const origMatch = h.fake.matchRule.bind(h.fake);
    const fake = h.fake as unknown as Record<string, (...args: string[]) => Promise<unknown>>;
    const origSelect = fake.selectGroupPolicy!.bind(h.fake);
    const selects: string[][] = [];
    let running: 'N' | 'P' | null = null;
    let failRejectInN = true;
    fake.selectGroupPolicy = async (...args: string[]) => {
      selects.push([running ?? '-', ...args]);
      // 普通模式改选 REJECT 失败一次：它结束时 SFE-ROUTE 仍选着切换写入的未验证节点
      if (running === 'N' && args[1] === 'REJECT' && failRejectInN) {
        failRejectInN = false;
        throw new Error('改选失败（测试）');
      }
      return origSelect(...args);
    };
    // 模拟错误的领取顺序（同上）；普通模式的撤销无法经运行时求值确认（rule match 不可用）
    const claim = h.repos.outbox.claimNext.bind(h.repos.outbox);
    h.repos.outbox.claimNext = (now, prefer) => {
      const row = claim(now, [[N], ...(prefer ?? [])]);
      if (row?.operationId === N) {
        running = 'N';
        (h.fake as unknown as { matchRule: unknown }).matchRule = async () => {
          throw capabilityUnverified('matchRule');
        };
      }
      if (row?.operationId === P) {
        running = 'P';
        (h.fake as unknown as { matchRule: unknown }).matchRule = origMatch;
      }
      return row;
    };
    await h.crash();
    await h.idle();
    expect(h.repos.operations.get(N)!.phase).toBe('NORMAL_RESTORED');
    const pub = h.repos.operations.get(P)!;
    expect(pub).toMatchObject({ phase: 'SUPERSEDED', status: 'superseded', supersededBy: N });
    expect(pub.result).toMatchObject({ rejectSelected: true });
    expect(selects.filter((c) => c[0] === 'P')).toEqual([['P', ROUTE_GROUP_NAME, 'REJECT']]);
    const last = h.repos.operations.listSteps(P).at(-1)!.message;
    expect(last).toContain('不回滚、不改写入口');
    expect(last).toContain('SFE-ROUTE 已改选 REJECT（读回确认）');
    expect(last).not.toContain('路由保持它的结果');
    expect(await h.fake.getGroupSelection(ROUTE_GROUP_NAME)).toBe('REJECT');
  });

  test('crash while a normal mode runs → after the restart it resumes before an operation accepted earlier that is not a route operation', async () => {
    h = await createHarness();
    const { envId: a } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const b = (await createEnv(h, 'US-Buyer-B', '203.0.113.11')).environment_id!;
    await bind(h, PROFILE_B, b);
    const nodeB = h.repos.proxyRevisions.get(b, 1)!.nodeName;
    let createId: string | null = null;
    let normalId: string | null = null;
    // B 的切换选择节点期间：先受理一次环境创建（发布，不是路由操作），再受理普通模式；切换在放宽入口之前把路由交给普通模式
    const fake = h.fake as unknown as Record<string, (...args: string[]) => Promise<unknown>>;
    const select = fake.selectGroupPolicy!.bind(h.fake);
    fake.selectGroupPolicy = async (...args: string[]) => {
      if (args[1] === nodeB && normalId === null) {
        createId = (await h.app.createEnvironment({ request_id: rid('create'), environment: envInput('US-Buyer-C', '203.0.113.12') }, WEB)).operation_id;
        h.clock.advance(1_000);
        normalId = (await h.app.enterNormal({ request_id: rid(), old_session_policy: 'closed_confirmed', confirmed_environment_id: a }, WEB)).operation_id;
      }
      return select(...args);
    };
    // 普通模式结束 Safari 连接时进程退出
    const stuck = hang('listActiveRequests', () => normalId !== null && h.repos.operations.get(normalId)!.status === 'running');
    const act = await h.app.activate(b, { request_id: rid('act'), old_session_policy: 'closed_confirmed', confirmed_environment_id: a }, WEB);
    await until(stuck.entered);
    fake.selectGroupPolicy = select;
    stuck.restore();
    expect(h.repos.operations.get(act.operation_id)).toMatchObject({ phase: 'SUPERSEDED', supersededBy: normalId });
    expect(h.repos.operations.get(normalId!)!.status).toBe('running');
    expect(h.repos.operations.get(createId!)!.status).toBe('queued');
    expect(h.repos.routeState.get()).toMatchObject({ phase: 'switching', operationId: normalId });
    const order = recordClaims();
    await h.crash();
    await h.idle();
    // 过渡中的路由（普通模式撤销入口到一半）不因受理更早的发布多停留
    expect(order[0]).toBe(normalId);
    expect(order.indexOf(createId!)).toBeGreaterThan(0);
    expectOriginalRules(normalId!);
    expect(h.repos.operations.get(createId!)!.status).toBe('succeeded');
  });

  /** 路由空闲的普通模式；激活 Y 停在第 1–3 步读取 SFE-ROUTE 成员上（尚未写入：running、stage pending、没有 epoch），然后服务崩溃。 */
  async function crashBeforeFirstWrite(): Promise<{ env: string; X: string }> {
    const env = (await createEnv(h, 'US-Buyer-Y', '203.0.113.10')).environment_id!;
    await bind(h, PROFILE_A, env);
    const stuck = hang('getGroupMembers', (g) => g === ROUTE_GROUP_NAME);
    const X = (await h.app.activate(env, { request_id: rid('act') }, WEB)).operation_id;
    await until(stuck.entered);
    const x = h.repos.operations.get(X)!;
    expect(x).toMatchObject({ status: 'running', routeEpoch: null });
    expect(payloadOf(x).route?.stage).toBe('pending');
    expect(h.repos.routeState.get()).toMatchObject({ entryMode: 'NORMAL', phase: 'idle' });
    stuck.restore();
    return { env, X };
  }

  for (const entryStrategy of ['ruleset_resource', 'temp_rule'] as const) {
    test(`[${entryStrategy}] crash before an activation's first write, wall clock stepped back 30 s across the restart, then normal mode → the interrupted activation is recovered first and the normal mode leaves Safari on the original rules for good`, async () => {
      h = await createHarness({ entryStrategy });
      const { X } = await crashBeforeFirstWrite();
      h.clock.advance(2_000);
      h.clock.set(h.clock.now().getTime() - 30_000);
      const order = recordClaims();
      await h.crash();
      await h.idle();
      // 放回的条目可用时间在“将来”，仍最先领取：崩溃恢复不等墙上时钟追上
      expect(order[0]).toBe(X);
      expect(h.repos.operations.get(X)!.status).not.toBe('running');
      const N = (await h.app.enterNormal({ request_id: rid('normal') }, WEB)).operation_id;
      await h.idle();
      expect(h.repos.operations.get(X)).toMatchObject({ status: 'superseded', supersededBy: N });
      expectOriginalRules(N);
      // 墙上时钟追上、到达截止时间之后：旧请求没有在普通模式之后重新阻断 Safari 或写入检测入口
      await h.clock.advanceAsync(31_000);
      await h.idle();
      await h.clock.advanceAsync((h.repos.settings.get('profileArrivalTimeoutSec') + 5) * 1000);
      await h.idle();
      expect(h.repos.operations.get(X)).toMatchObject({ status: 'superseded', supersededBy: N });
      expectOriginalRules(N);
    });
  }

  for (const entryStrategy of ['ruleset_resource', 'temp_rule'] as const) {
    test(`[${entryStrategy}] second line of defence: a normal mode that starts before an activation interrupted before its first write was recovered ends that activation (SUPERSEDED), so it never re-runs after the normal mode`, async () => {
      h = await createHarness({ entryStrategy });
      const { X } = await crashBeforeFirstWrite();
      // 普通模式在崩溃之前受理、排在中断的激活之后
      const N = (await h.app.enterNormal({ request_id: rid('normal') }, WEB)).operation_id;
      expect(h.repos.operations.get(N)!.payload).toMatchObject({ normal: { queuedBehind: [X] } });
      // 模拟错误的领取顺序（例如激活的条目暂时领取不到）：普通模式先于崩溃恢复中的激活执行
      const writes = () => ({ select: h.fake.calls.selectGroupPolicy ?? 0, kill: h.fake.calls.killRequest ?? 0, ...entryWrites(h.fake) });
      const claim = h.repos.outbox.claimNext.bind(h.repos.outbox);
      h.repos.outbox.claimNext = (now, prefer) => claim(now, [[N], ...(prefer ?? [])]);
      await h.crash();
      await h.idle();
      const x = h.repos.operations.get(X)!;
      expect(x).toMatchObject({ phase: 'SUPERSEDED', status: 'superseded', supersededBy: N });
      expect(h.repos.operations.listSteps(X).at(-1)!.message).toContain('服务重启时本操作在第一次写入 Surge 之前中断');
      expect(h.repos.operations.listSteps(X).some((st) => st.phase === 'SAFARI_BLOCKED' || st.phase === 'VERIFY_ONLY')).toBe(false);
      expect(h.repos.outbox.pendingForOperation(X)).toEqual([]);
      expectOriginalRules(N);
      const after = writes();
      await h.clock.advanceAsync((h.repos.settings.get('profileArrivalTimeoutSec') + 5) * 1000);
      await h.idle();
      expect(writes()).toEqual(after);
      expectOriginalRules(N);
    });
  }
});

/**
 * 引擎看到的 Surge 适配器：gate 返回 'hang' 时这次调用挂起（模拟进程在调用中途崩溃），'after' 时先照常执行、再挂起（写入已生效，
 * 读回之前崩溃），'fail' 时这次调用失败（模拟 surge-cli 超时）。崩溃之后的新实例同样经它，测试在崩溃之前清除或换掉 gate。
 */
type Gate = (name: string, args: unknown[]) => 'hang' | 'after' | 'fail' | null;
let gate: Gate | null = null;
let gateHits = 0;
function gated(fake: object): SurgeAdapter {
  return new Proxy(fake, {
    get(target, prop) {
      const v = Reflect.get(target, prop, target) as unknown;
      if (typeof v !== 'function') return v;
      const fn = v as (...args: unknown[]) => unknown;
      return (...args: unknown[]) => {
        const g = gate?.(String(prop), args) ?? null;
        if (g === null) return fn.apply(target, args);
        gateHits++;
        if (g === 'hang') return new Promise(() => undefined);
        if (g === 'fail') return Promise.reject(new Error('模拟：surge-cli 超时'));
        return (async () => {
          await fn.apply(target, args);
          await new Promise(() => undefined);
        })();
      };
    },
  }) as unknown as SurgeAdapter;
}

describe('crash at a route operation end point: a decided failure or REJECT hold survives the restart (§6.1, §6.3 step 14, §6.4)', () => {
  afterEach(() => {
    gate = null;
  });

  async function crashWhenGated(): Promise<void> {
    await until(() => gateHits > 0);
    gate = null;
    await h.crash();
    await h.idle();
  }

  async function ordersAllowed(): Promise<boolean> {
    const st = (await h.native(PROFILE_A, { type: 'getCurrentState' })) as { ok: true; data: { ordersAllowed: boolean } };
    return st.data.ordersAllowed;
  }

  async function mismatchingRetest(): Promise<{ a: string; p: string; probeBefore: string }> {
    gateHits = 0;
    h = await createHarness({ dbFile: true, surge: (fake) => gated(fake) });
    const { envId: a } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const env = h.repos.environments.get(a)!;
    await h.app.updateEnvironment(a, { request_id: rid(), expected_revision: env.revision, changes: { proxy: { expectedExitIp: '192.0.2.50' } } }, WEB);
    await h.idle();
    const probeBefore = h.repos.probes.latest(a, 'safari')!.id;
    const p = (await h.app.probe(a, { request_id: rid(), kind: 'safari' }, WEB)).operation_id;
    await h.idle();
    expect(h.repos.operations.get(p)!.status).toBe('waiting');
    return { a, p, probeBefore };
  }

  function expectMismatchRecorded(a: string, p: string, probeBefore: string): void {
    const op = h.repos.operations.get(p)!;
    expect(op).toMatchObject({ phase: 'FAILED', status: 'failed' });
    expect(op.error?.code).toBe('EXIT_IP_MISMATCH');
    expect(op.result?.probeWarning).toBe('exit_ip_mismatch');
    expect(h.repos.routeState.get().warnings).toContain('exit_ip_mismatch');
    const probe = h.repos.probes.latest(a, 'safari')!;
    expect(probe.id).not.toBe(probeBefore);
    expect(probe.outcome).toBe('mismatch');
    // 没有重新开始等待检测（检测编号已消费，准备页不会再提交）
    expect(h.repos.operations.listSteps(p).filter((s) => s.message.includes('等待在绑定的 Safari 场景中完成出口检测'))).toHaveLength(1);
    expect(h.repos.outbox.pendingForOperation(p)).toEqual([]);
  }

  test('a mismatching retest result is being checked (Surge request records read) when the service dies → after the restart the check is redone from the submitted result: exit_ip_mismatch, orders and fill stop', async () => {
    const { a, p, probeBefore } = await mismatchingRetest();
    gate = (name) => (name === 'listRecentRequests' && h.app.executor.currentOperationId === p ? 'hang' : null);
    void verify(h, PROFILE_A, p, { observedIp: '192.0.2.77' });
    await crashWhenGated();
    expectMismatchRecorded(a, p, probeBefore);
    expect(await ordersAllowed()).toBe(false);
    expect((await h.app.ensureInControl()).ok).toBe(false);
    // 之前的检测截止时间到期也不改变结果
    await h.clock.advanceAsync(200_000);
    await h.idle();
    expectMismatchRecorded(a, p, probeBefore);
  });

  test('…and when the mismatch was already decided and the end point is reading SFE-ROUTE: after the restart it ends with that decision', async () => {
    const { a, p, probeBefore } = await mismatchingRetest();
    let listed = false;
    gate = (name) => {
      if (h.app.executor.currentOperationId !== p) return null;
      if (name === 'listRecentRequests') listed = true;
      else if (name === 'getGroupSelection' && listed) return 'hang';
      return null;
    };
    void verify(h, PROFILE_A, p, { observedIp: '192.0.2.77' });
    await crashWhenGated();
    expectMismatchRecorded(a, p, probeBefore);
    expect(h.repos.operations.listSteps(p).some((s) => s.message.includes('按已判定的结果结束'))).toBe(true);
    expect(await ordersAllowed()).toBe(false);
  });

  test('…and when that end point had already moved SFE-ROUTE (changed in Surge) to REJECT: after the restart the hold is recorded as this operation\'s, like without the crash', async () => {
    const run = async (crash: boolean) => {
      const { a, p } = await mismatchingRetest();
      const b = (await createEnv(h, 'US-Buyer-B', '203.0.113.11')).environment_id!;
      const nodeB = h.repos.proxyRevisions.get(b, 1)!.nodeName;
      // 核对开始时用户在 Surge 中把 SFE-ROUTE 改选到别的买家节点（签发检测编号时它还是目标节点）
      let moved = false;
      gate = (name, args) => {
        if (h.app.executor.currentOperationId !== p) return null;
        if (name === 'getGroupSelection' && !moved) {
          moved = true;
          void h.fake.selectGroupPolicy(ROUTE_GROUP_NAME, nodeB);
        }
        return crash && name === 'selectGroupPolicy' && args[1] === 'REJECT' ? 'after' : null;
      };
      const r = verify(h, PROFILE_A, p, { observedIp: '192.0.2.77' });
      if (crash) await crashWhenGated();
      else await r;
      const op = h.repos.operations.get(p)!;
      const route = h.repos.routeState.get();
      const out = {
        op: { phase: op.phase, status: op.status, code: op.error?.code, rejectSelected: op.result?.rejectSelected, probeWarning: op.result?.probeWarning },
        route: { phase: route.phase, selectedNode: route.selectedNode, warnings: [...route.warnings].sort() },
        orders: await ordersAllowed(),
      };
      expect(h.repos.probes.latest(a, 'safari')!.outcome).toBe('failed');
      await h.close();
      return out;
    };
    const baseline = await run(false);
    expect(baseline).toEqual({
      op: { phase: 'BLOCKED_NEEDS_ATTENTION', status: 'needs_attention', code: 'SAFARI_VERIFY_FAILED', rejectSelected: true, probeWarning: 'probe_failed' },
      route: { phase: 'attention', selectedNode: 'REJECT', warnings: ['buyer_exit_connections_unconfirmed', 'entry_unverified', 'probe_failed'] },
      orders: false,
    });
    expect(await run(true)).toEqual(baseline);
  });

  test('…and when the check had read SFE-ROUTE on another buyer\'s node and, after the restart, every selection read fails until the hold: the decided verdict keeps what the check read and the end point still holds REJECT', async () => {
    const { a, p } = await mismatchingRetest();
    const b = (await createEnv(h, 'US-Buyer-B', '203.0.113.11')).environment_id!;
    const nodeB = h.repos.proxyRevisions.get(b, 1)!.nodeName;
    // 核对开始时用户在 Surge 中把 SFE-ROUTE 改选到 B 的节点（核对读到它，判定失败）；结束点重读时进程退出
    let reads = 0;
    gate = (name) => {
      if (h.app.executor.currentOperationId !== p || name !== 'getGroupSelection') return null;
      reads += 1;
      if (reads === 1) {
        void h.fake.selectGroupPolicy(ROUTE_GROUP_NAME, nodeB);
        return null;
      }
      return 'hang';
    };
    void verify(h, PROFILE_A, p, { observedIp: '192.0.2.77' });
    await until(() => gateHits > 0);
    expect(payloadOf(h.repos.operations.get(p)!).route?.verdict).toMatchObject({ failure: { code: 'SAFARI_VERIFY_FAILED' }, observedSelection: nodeB });
    // 重启之后 Surge 的选择读取一直失败（启动对账因此记不下外部改选），直到结束点改选 REJECT
    let rejected = false;
    gate = (name, args) => {
      if (name === 'selectGroupPolicy' && args[1] === 'REJECT') rejected = true;
      return name === 'getGroupSelection' && !rejected ? 'fail' : null;
    };
    await h.crash();
    await h.idle();
    gate = null;
    const op = h.repos.operations.get(p)!;
    expect(op).toMatchObject({ phase: 'BLOCKED_NEEDS_ATTENTION', status: 'needs_attention' });
    expect(op.error?.code).toBe('SAFARI_VERIFY_FAILED');
    expect(op.result).toMatchObject({ rejectSelected: true, probeWarning: 'probe_failed' });
    expect(h.repos.operations.listSteps(p).at(-1)!.message).not.toContain('路由未改变');
    expect(h.repos.routeState.get()).toMatchObject({ phase: 'attention', selectedNode: 'REJECT' });
    expect(await h.fake.getGroupSelection(ROUTE_GROUP_NAME)).toBe('REJECT');
    expect(h.repos.probes.latest(a, 'safari')!.outcome).toBe('failed');
  });

  // 结束点改选 REJECT（holdAtRouteEnd）之后、记下之前服务崩溃：after = 改选已生效、读回之前；readback = 读回挂起
  describe.each([
    ['after', (): Gate => (name, args) => (name === 'selectGroupPolicy' && args[1] === 'REJECT' ? 'after' : null)],
    [
      'readback',
      (): Gate => {
        let selected = false;
        return (name, args) => {
          if (name === 'selectGroupPolicy' && args[1] === 'REJECT') selected = true;
          else if (name === 'getGroupSelection' && selected) return 'hang';
          return null;
        };
      },
    ],
  ] as const)('crash %s the end point selected REJECT', (_label, crashGateOf) => {
    async function endWithMovedSelection(start: (a: string) => Promise<string>, crash: boolean) {
      gateHits = 0;
      h = await createHarness({ dbFile: true, surge: (fake) => gated(fake) });
      const { envId: a } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
      const b = (await createEnv(h, 'US-Buyer-B', '203.0.113.11')).environment_id!;
      const p = await start(a);
      // 用户在 Surge 中把 SFE-ROUTE 改选到别的买家节点；等待截止时间到期，结束点改选 REJECT
      await h.fake.selectGroupPolicy(ROUTE_GROUP_NAME, h.repos.proxyRevisions.get(b, 1)!.nodeName);
      const crashGate = crashGateOf();
      const fresh = (() => {
        let armed = true;
        return (name: string, args: unknown[]) => {
          if (!armed || h.app.executor.currentOperationId !== p) return null;
          const g = crashGate(name, args);
          if (g === 'hang' || g === 'after') armed = false;
          return g;
        };
      })();
      if (crash) gate = fresh;
      await h.clock.advanceAsync((h.repos.settings.get('profileArrivalTimeoutSec') + 1) * 1000);
      if (crash) {
        await until(() => gateHits > 0);
        expect(payloadOf(h.repos.operations.get(p)!).route?.ending).toBeDefined();
        expect(payloadOf(h.repos.operations.get(p)!).endHold).toBeDefined();
        gate = null;
        await h.crash();
      }
      await h.idle();
      const op = h.repos.operations.get(p)!;
      const route = h.repos.routeState.get();
      const out = {
        op: { phase: op.phase, status: op.status, code: op.error?.code, rejectSelected: op.result?.rejectSelected, unchanged: (h.repos.operations.listSteps(p).at(-1)?.message ?? '').includes('路由未改变') },
        route: { phase: route.phase, selectedNode: route.selectedNode, operationId: route.operationId === p, warnings: [...route.warnings].sort() },
        actual: await h.fake.getGroupSelection(ROUTE_GROUP_NAME),
      };
      await h.close();
      return out;
    }

    test('a retest arrival timeout → after the restart: BLOCKED_NEEDS_ATTENTION with rejectSelected, route attention / REJECT / entry_unverified, exactly as without the crash', async () => {
      const start = async (a: string) => {
        const p = (await h.app.probe(a, { request_id: rid(), kind: 'safari' }, WEB)).operation_id;
        await h.idle();
        return p;
      };
      const baseline = await endWithMovedSelection(start, false);
      expect(baseline).toMatchObject({
        op: { phase: 'BLOCKED_NEEDS_ATTENTION', status: 'needs_attention', code: 'SAFARI_VERIFY_TIMEOUT', rejectSelected: true, unchanged: false },
        route: { phase: 'attention', selectedNode: 'REJECT', operationId: true },
        actual: 'REJECT',
      });
      expect(baseline.route.warnings).toEqual(expect.arrayContaining(['entry_unverified', 'buyer_exit_connections_unconfirmed']));
      expect(await endWithMovedSelection(start, true)).toEqual(baseline);
    });

    test('a WAITING_ROUTE timeout → after the restart: needs_attention with rejectSelected (never "succeeded, route unchanged"), exactly as without the crash', async () => {
      const start = async (a: string) => {
        const env = h.repos.environments.get(a)!;
        const p = (await h.app.updateEnvironment(a, { request_id: rid('upd'), expected_revision: env.revision, changes: { proxy: { host: '203.0.113.20' } } }, WEB)).operation_id;
        await h.idle();
        expect(h.repos.operations.get(p)!.phase).toBe('WAITING_ROUTE');
        return p;
      };
      const baseline = await endWithMovedSelection(start, false);
      expect(baseline).toMatchObject({
        op: { phase: 'BLOCKED_NEEDS_ATTENTION', status: 'needs_attention', code: 'UNKNOWN_STATE', rejectSelected: true, unchanged: false },
        route: { phase: 'attention', selectedNode: 'REJECT', operationId: true },
        actual: 'REJECT',
      });
      expect(baseline.route.warnings).toEqual(expect.arrayContaining(['entry_unverified', 'buyer_exit_connections_unconfirmed']));
      expect(await endWithMovedSelection(start, true)).toEqual(baseline);
    });
  });

  test('a WAITING_ROUTE timeout whose end point selected REJECT while a normal mode was accepted (queued behind it), then the service died before recording the hold → after the restart the hold is still recorded as this operation\'s (never "succeeded, route unchanged"); the normal mode then restores the original rules', async () => {
    gateHits = 0;
    h = await createHarness({ dbFile: true, surge: (fake) => gated(fake) });
    const { envId: a } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const b = (await createEnv(h, 'US-Buyer-B', '203.0.113.11')).environment_id!;
    const env = h.repos.environments.get(a)!;
    const w = (await h.app.updateEnvironment(a, { request_id: rid('upd'), expected_revision: env.revision, changes: { proxy: { host: '203.0.113.20' } } }, WEB)).operation_id;
    await h.idle();
    expect(h.repos.operations.get(w)!.phase).toBe('WAITING_ROUTE');
    // 用户在 Surge 中把 SFE-ROUTE 改选到别的买家节点；等待截止时间到期，结束点改选 REJECT（已生效，读回之前进程退出）
    await h.fake.selectGroupPolicy(ROUTE_GROUP_NAME, h.repos.proxyRevisions.get(b, 1)!.nodeName);
    let armed = true;
    gate = (name, args) => {
      if (!armed || h.app.executor.currentOperationId !== w || name !== 'selectGroupPolicy' || args[1] !== 'REJECT') return null;
      armed = false;
      return 'after';
    };
    await h.clock.advanceAsync((h.repos.settings.get('profileArrivalTimeoutSec') + 1) * 1000);
    await until(() => gateHits > 0);
    expect(payloadOf(h.repos.operations.get(w)!).endHold).toBeDefined();
    // 改选期间用户点击「进入普通模式」：受理（从不拒绝），排在结束中的发布之后
    const n = (await h.app.enterNormal({ request_id: rid('n'), old_session_policy: 'closed_confirmed', confirmed_environment_id: a }, WEB)).operation_id;
    expect(h.repos.operations.get(n)!.status).toBe('queued');
    gate = null;
    await h.crash();
    await h.idle();
    const op = h.repos.operations.get(w)!;
    expect(op).toMatchObject({ phase: 'BLOCKED_NEEDS_ATTENTION', status: 'needs_attention' });
    expect(op.result?.rejectSelected).toBe(true);
    expect(h.repos.operations.listSteps(w).at(-1)!.message).not.toContain('路由未改变');
    // 普通模式接着从需要处理的路由撤销本应用入口：Safari 按 Surge 原规则发出，Chrome 从不命中 Safari 规则
    expect(h.repos.operations.get(n)!.phase).toBe('NORMAL_RESTORED');
    expect(h.repos.routeState.get()).toMatchObject({ phase: 'idle', entryMode: 'NORMAL', activeEnvironmentId: null, operationId: n });
    expect(safariOutcome(h)).toMatchObject({ rule: 'FINAL,DIRECT', failed: false });
    expect(h.fake.simulateRequest({ processPath: FAKE_CHROME_PATH, host: 'www.example.test', protocol: 'tcp' }).rule).toBe('FINAL,DIRECT');
  });

  test.each(['temp_rule', 'ruleset_resource'] as const)(
    '[%s] a running activation that fails before writing, whose end point selected REJECT while a normal mode was accepted (queued behind it), then the service died before recording the hold → after the restart the activation is re-ended with its recorded failure, not re-run: the hold is its own (never "stopped before the first write, no node changed"), and the route record ends on REJECT like Surge',
    async (entryStrategy) => {
      gateHits = 0;
      h = await createHarness({ dbFile: true, entryStrategy, surge: (fake) => gated(fake) });
      const { envId: a } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
      const b = (await createEnv(h, 'US-Buyer-B', '203.0.113.11')).environment_id!;
      // 用户在 Surge 中把 SFE-ROUTE 改选到 B 的节点，然后重新使用 A：第 2 步读 SFE-ROUTE 的成员失败（写入之前失败，操作仍是执行中、
      // 没有 route.ending），结束点改选 REJECT（已生效，读回之前进程退出）
      await h.fake.selectGroupPolicy(ROUTE_GROUP_NAME, h.repos.proxyRevisions.get(b, 1)!.nodeName);
      let opId = '';
      let selecting = false;
      gate = (name, args) => {
        if (opId === '' || h.app.executor.currentOperationId !== opId) return null;
        if (name === 'getGroupMembers') return 'fail';
        if (!selecting && name === 'selectGroupPolicy' && args[1] === 'REJECT') {
          selecting = true;
          return 'after';
        }
        return null;
      };
      opId = (await h.app.activate(a, { request_id: rid('act') }, WEB)).operation_id;
      await until(() => selecting);
      for (let i = 0; i < 500 && (await h.fake.getGroupSelection(ROUTE_GROUP_NAME)) !== 'REJECT'; i++) await new Promise((r) => setTimeout(r, 2));
      expect(await h.fake.getGroupSelection(ROUTE_GROUP_NAME)).toBe('REJECT');
      const before = h.repos.operations.get(opId)!;
      expect(before.status).toBe('running');
      expect(payloadOf(before).route?.ending).toBeUndefined();
      expect(payloadOf(before).endHold?.ending).toMatchObject({ phase: 'FAILED', status: 'failed' });
      // 改选期间用户点击「进入普通模式」：受理（从不拒绝），排在执行中的激活之后
      const n = (await h.app.enterNormal({ request_id: rid('n'), old_session_policy: 'closed_confirmed', confirmed_environment_id: a }, WEB)).operation_id;
      expect(h.repos.operations.get(n)!.status).toBe('queued');
      gate = null;
      await h.crash();
      await h.idle();
      const op = h.repos.operations.get(opId)!;
      expect(op).toMatchObject({ phase: 'BLOCKED_NEEDS_ATTENTION', status: 'needs_attention' });
      expect(op.result?.rejectSelected).toBe(true);
      const last = h.repos.operations.listSteps(opId).at(-1)!.message;
      expect(last).not.toContain('没有改选节点');
      expect(last).toContain('SFE-ROUTE 已改选 REJECT（读回确认）');
      expect(h.repos.operations.listSteps(opId).map((s) => s.phase)).not.toContain('SUPERSEDED');
      // 普通模式接着撤销本应用入口：Safari 按 Surge 原规则发出，路由记录的选择与 Surge 一致（REJECT），Chrome 从不命中 Safari 规则
      expect(h.repos.operations.get(n)!.phase).toBe('NORMAL_RESTORED');
      expect(h.repos.routeState.get()).toMatchObject({ phase: 'idle', entryMode: 'NORMAL', activeEnvironmentId: null, operationId: n, selectedNode: 'REJECT' });
      expect(await h.fake.getGroupSelection(ROUTE_GROUP_NAME)).toBe('REJECT');
      expect(safariOutcome(h)).toMatchObject({ rule: 'FINAL,DIRECT', failed: false });
      expect(h.fake.simulateRequest({ processPath: FAKE_CHROME_PATH, host: 'www.example.test', protocol: 'tcp' }).rule).toBe('FINAL,DIRECT');
    },
  );
});
