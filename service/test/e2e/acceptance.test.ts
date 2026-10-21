// 实时同步设计 §11 验收清单 1–12 的离线对应（FakeSurge + 内存秘密存储 + 可控时钟）。
// 这些只证明编排与状态机；真实网络出口、Safari 进程归属、H2/QUIC 与长连接行为必须在测试 Mac 上验收（docs/ACCEPTANCE.md）。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { CAPABILITY_GATES, CAPABILITY_KEYS, NODE_RESOURCE_FILE, ROUTE_GROUP_NAME, SfeError } from '@sfe/contract';
import { FAKE_CHROME_PATH, FAKE_SAFARI_PATH, FAKE_VERIFY_HOST } from '../../src/surge/fake.js';
import { PROFILE_A, PROFILE_B, WEB, activeEnv, bind, createEnv, createHarness, rid, safariOutcome, verify, type Harness } from '../engine/harness.js';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

const GLOBAL_WRITES = ['reloadProfile'];
const ROUTE_WRITES = ['updateExternalResource', 'selectGroupPolicy', 'addTempRule', 'removeTempRule', 'killRequest', 'reloadProfile'];
const counts = (keys: string[]) => keys.map((k) => h.fake.calls[k] ?? 0);
const chrome = (host = 'www.example.test', longLived = false) => h.fake.simulateRequest({ processPath: FAKE_CHROME_PATH, host, protocol: 'tcp', longLived });

async function expectError(p: Promise<unknown>, code: string): Promise<SfeError> {
  try {
    await p;
  } catch (err) {
    expect((err as SfeError).code).toBe(code);
    return err as SfeError;
  }
  throw new Error(`expected ${code}`);
}

function nodeNames(): string[] {
  return readFileSync(join(h.surgeDir, NODE_RESOURCE_FILE), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '' && !l.startsWith('#'))
    .map((l) => l.split('=')[0]!.trim());
}

describe('sync design §11 acceptance (offline equivalents)', () => {
  test('1. plugin edits the active environment IP → pending shown at once → node deployed → Safari exit moves → both sides show applied', async () => {
    h = await createHarness();
    const { envId } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const env = h.repos.environments.get(envId)!;
    const seq = h.events.at(-1)!.sequence;
    const r = await h.native(PROFILE_A, { type: 'updateCurrentEnvironment', request_id: rid(), environment_id: envId, expected_revision: env.revision, changes: { proxy: { host: '203.0.113.20' } } });
    expect(r.ok).toBe(true);
    const opId = (r as { data: { operation_id: string } }).data.operation_id;
    // 受理后立即可见“待同步”（网页通过事件流收到）
    const first = h.events.find((e) => e.sequence > seq && e.type === 'environment.updated');
    expect(first && first.type === 'environment.updated' && first.environment.proxy.desired?.revision).toBe(2);
    await h.idle();
    expect(h.repos.operations.get(opId)!.phase).toBe('WAITING_ROUTE');
    expect((await h.fake.getGroupMembers(ROUTE_GROUP_NAME))).toContain('SFE-N-E0001-US01-v002');
    await h.native(PROFILE_A, { type: 'beginSafariVerification', operation_id: opId, amazon_tabs_open: false });
    await h.idle();
    await verify(h, PROFILE_A, opId);
    expect(h.repos.operations.get(opId)!.phase).toBe('ACTIVE_VERIFIED');
    expect(safariOutcome(h).leafPolicyName).toBe('SFE-N-E0001-US01-v002');
    const web = await h.app.getEnvironment(envId, WEB);
    const plugin = await h.native(PROFILE_A, { type: 'getCurrentState' });
    expect(web.readiness).toBe('active');
    expect(web.proxy.deployed?.revision).toBe(2);
    expect(JSON.stringify((plugin as { data: unknown }).data)).toContain('"revision":2');
    expect(counts(GLOBAL_WRITES)).toEqual([0]);
  });

  test('2. web edits a non-current environment → its plugin reads the new version → current exit unchanged', async () => {
    h = await createHarness();
    await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const b = (await createEnv(h, 'US-Buyer-B', '203.0.113.11')).environment_id!;
    await bind(h, PROFILE_B, b);
    const before = counts(['selectGroupPolicy', 'killRequest']);
    const envB = h.repos.environments.get(b)!;
    await h.app.updateEnvironment(b, { request_id: rid(), expected_revision: envB.revision, changes: { proxy: { host: '203.0.113.21' } } }, WEB);
    await h.idle();
    const state = await h.native(PROFILE_B, { type: 'getCurrentState' });
    expect(JSON.stringify(state)).toContain('203.0.113.21');
    expect(safariOutcome(h).leafPolicyName).toBe('SFE-N-E0001-US01-v001');
    expect(counts(['selectGroupPolicy', 'killRequest'])).toEqual(before);
  });

  test('3. account-only change → no Surge write, no group switch, no connection kill', async () => {
    h = await createHarness();
    const { envId } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A, { login: 'buyer01@example.test', accountPassword: 'synth-acct-01' });
    h.fake.simulateRequest({ processPath: FAKE_SAFARI_PATH, host: 'www.example.test', protocol: 'tcp', longLived: true });
    const before = counts(ROUTE_WRITES);
    const env = h.repos.environments.get(envId)!;
    const acc = await h.app.updateEnvironment(
      envId,
      { request_id: rid(), expected_revision: env.revision, changes: { account: { label: null, loginIdentifier: 'buyer02@example.test', password: { action: 'replace', value: 'synth-acct-02' } } } },
      WEB,
    );
    await h.idle();
    expect(h.repos.operations.get(acc.operation_id)!.phase).toBe('COMPLETED');
    expect(counts(ROUTE_WRITES)).toEqual(before);
    expect((await h.fake.listActiveRequests()).length).toBe(1);
    expect(h.repos.accounts.get(envId)!.changedSincePageCheck).toBe(true);
    expect(h.repos.proxyRevisions.maxRevision(envId)).toBe(1);
  });

  test('4. concurrent edits → the stale revision is rejected, nothing is overwritten', async () => {
    h = await createHarness();
    const id = (await createEnv(h, 'US-Buyer-A', '203.0.113.10')).environment_id!;
    const rev = h.repos.environments.get(id)!.revision;
    await h.app.updateEnvironment(id, { request_id: rid(), expected_revision: rev, changes: { proxy: { port: 1081 } } }, WEB);
    const err = await expectError(h.app.updateEnvironment(id, { request_id: rid(), expected_revision: rev, changes: { proxy: { port: 1082 } } }, WEB), 'REVISION_CONFLICT');
    expect(JSON.stringify(err.details)).toContain('1081');
    await h.idle();
    expect(h.repos.proxyRevisions.get(id, 2)!.port).toBe(1081);
    expect(h.repos.proxyRevisions.maxRevision(id)).toBe(2);
  });

  test('5. closing the page does not stop the work; reopening shows the real result (event replay)', async () => {
    h = await createHarness();
    const seq = h.events.at(-1)?.sequence ?? 0;
    const acc = await h.app.createEnvironment({ request_id: rid(), environment: { displayName: 'US-Buyer-A', site: 'US', autoOpenOrders: true, autoFillLogin: false, proxy: { protocol: 'socks5', host: '203.0.113.10', port: 1080, frontProxyId: null }, account: { label: null, loginIdentifier: null } } }, WEB);
    // 没有任何界面在等待：执行器在后台完成
    await h.idle();
    const op = await h.app.getOperation(acc.operation_id, WEB);
    expect(op.phase).toBe('READY_FOR_NEXT_OPEN');
    const missed = h.app.events.since(seq)!;
    expect(missed.some((e) => e.type === 'operation.updated' && e.operation.id === acc.operation_id && e.operation.phase === 'READY_FOR_NEXT_OPEN')).toBe(true);
  });

  test('6. check failure, front failure and Surge errors never end as applied', async () => {
    h = await createHarness();
    const id = (await createEnv(h, 'US-Buyer-A', '203.0.113.10')).environment_id!;
    const update = async (port: number) => {
      const env = h.repos.environments.get(id)!;
      const a = await h.app.updateEnvironment(id, { request_id: rid(), expected_revision: env.revision, changes: { proxy: { port } } }, WEB);
      await h.idle();
      return h.repos.operations.get(a.operation_id)!;
    };
    h.fake.lieOnNext('checkProfile', { ok: false, message: 'line 1: 合成错误' });
    let op = await update(1081);
    expect(op.error?.code).toBe('SURGE_CHECK_FAILED');
    const policies = await h.fake.listPolicies();
    h.fake.lieOnNext('listPolicies', { proxies: policies.proxies.filter((p) => p !== 'Front-A'), groups: policies.groups });
    op = await update(1082);
    expect(op.error?.code).toBe('FRONT_PROXY_MISSING');
    h.fake.failNext('updateExternalResource', new SfeError('SURGE_UNREACHABLE', '调用 Surge 失败：模拟超时'));
    op = await update(1083);
    expect(['READY_FOR_NEXT_OPEN', 'ACTIVE_VERIFIED', 'COMPLETED']).not.toContain(op.phase);
    expect(h.repos.environments.get(id)!.deployedProxyRevision).toBe(1);
    const view = await h.app.getEnvironment(id, WEB);
    expect(['ready', 'active']).not.toContain(view.readiness);
  });

  test('7. forced stop at each stage → recovery from facts: no duplicate nodes, never DIRECT', async () => {
    h = await createHarness({ dbFile: true });
    const id = (await createEnv(h, 'US-Buyer-A', '203.0.113.10')).environment_id!;
    await bind(h, PROFILE_A, id);
    const fake = h.fake as unknown as Record<string, (...a: string[]) => Promise<unknown>>;
    for (const [prim, act] of [
      ['updateExternalResource', async () => {
        const env = h.repos.environments.get(id)!;
        await h.app.updateEnvironment(id, { request_id: rid(), expected_revision: env.revision, changes: { proxy: { port: 1081 } } }, WEB);
      }],
      ['selectGroupPolicy', async () => {
        await h.app.activate(id, { request_id: rid() }, WEB);
      }],
    ] as const) {
      const orig = fake[prim]!.bind(h.fake);
      let entered = false;
      fake[prim] = (...a: string[]) => {
        if (prim === 'selectGroupPolicy' && a[1] === 'REJECT') return orig(...a);
        entered = true;
        return new Promise(() => undefined);
      };
      await act();
      const end = Date.now() + 5000;
      while (!entered && Date.now() < end) await new Promise((r) => setTimeout(r, 2));
      expect(entered).toBe(true);
      fake[prim] = orig;
      await h.crash();
      await h.idle();
      const names = nodeNames();
      expect(new Set(names).size).toBe(names.length);
      expect(await h.fake.getGroupSelection(ROUTE_GROUP_NAME)).not.toBe('DIRECT');
      expect(await h.fake.getGroupMembers(ROUTE_GROUP_NAME)).not.toContain('DIRECT');
    }
    const pub = await h.app.publishPending({ request_id: rid() }, WEB);
    await h.idle();
    expect(h.repos.operations.get(pub.operation_id)!.phase).not.toBe('FAILED');
    expect(h.fake.calls.reloadProfile ?? 0).toBe(0);
  });

  test('8. switching ends old Safari connections only; Chrome keeps its connection and its exit', async () => {
    h = await createHarness();
    const { envId: a } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const b = (await createEnv(h, 'US-Buyer-B', '203.0.113.11')).environment_id!;
    await bind(h, PROFILE_B, b);
    const oldSafari = h.fake.simulateRequest({ processPath: FAKE_SAFARI_PATH, host: 'www.example.test', protocol: 'tcp', longLived: true });
    const oldChrome = chrome('www.example.test', true);
    expect(oldSafari.leafPolicyName).toBe('SFE-N-E0001-US01-v001');
    const act = await h.app.activate(b, { request_id: rid(), old_session_policy: 'closed_confirmed', confirmed_environment_id: a }, WEB);
    await h.idle();
    await verify(h, PROFILE_B, act.operation_id);
    expect(h.repos.operations.get(act.operation_id)!.phase).toBe('ACTIVE_VERIFIED');
    const active = (await h.fake.listActiveRequests()).map((r) => r.id);
    expect(active).not.toContain(oldSafari.id);
    expect(active).toContain(oldChrome.id);
    expect(safariOutcome(h).leafPolicyName).toBe('SFE-N-E0002-US02-v001');
    const c = chrome();
    expect(c.policyName).toBe(oldChrome.policyName);
    expect(c.chain.some((n) => n.startsWith('SFE-'))).toBe(false);
  });

  test('9. VERIFY_ONLY: shopping traffic blocked, verification host reachable; after verification normal access', async () => {
    h = await createHarness();
    const id = (await createEnv(h, 'US-Buyer-A', '203.0.113.10')).environment_id!;
    await bind(h, PROFILE_A, id);
    const act = await h.app.activate(id, { request_id: rid() }, WEB);
    await h.idle();
    expect(h.repos.operations.get(act.operation_id)!.phase).toBe('VERIFY_ONLY');
    expect(safariOutcome(h, 'www.amazon.example.test').failed).toBe(true);
    expect(safariOutcome(h, FAKE_VERIFY_HOST).leafPolicyName).toBe('SFE-N-E0001-US01-v001');
    expect(safariOutcome(h, 'www.amazon.example.test', 'udp').failed).toBe(true);
    await verify(h, PROFILE_A, act.operation_id);
    const after = safariOutcome(h, 'www.amazon.example.test');
    expect(after.failed).toBe(false);
    expect(after.leafPolicyName).toBe('SFE-N-E0001-US01-v001');
  });

  test('10. normal mode runs the full original rules and keeps managed and user settings intact', async () => {
    h = await createHarness();
    const original = readFileSync(h.profilePath, 'utf8');
    const { envId } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const n = await h.app.enterNormal({ request_id: rid(), old_session_policy: 'closed_confirmed', confirmed_environment_id: envId }, WEB);
    await h.idle();
    expect(h.repos.operations.get(n.operation_id)!.phase).toBe('NORMAL_RESTORED');
    // Safari 与 Chrome 走同一套原规则（用户策略组与 FINAL），不是 DIRECT 复制
    expect(safariOutcome(h, 'daily.example.test').policyName).toBe('Daily');
    expect(chrome('daily.example.test').policyName).toBe('Daily');
    expect(safariOutcome(h, 'www.example.test').rule).toBe(chrome('www.example.test').rule);
    expect(readFileSync(h.profilePath, 'utf8')).toBe(original);
    expect((await h.app.refreshSurge(WEB)).managedSectionsIntact).toBe(true);
    expect(h.fake.calls.reloadProfile ?? 0).toBe(0);
  });

  test('11. capabilities measured on Surge 6.5.0 do not carry over to another Surge build (no borrowed abilities)', async () => {
    h = await createHarness();
    const { envId } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    // 能力记录绑定到实测时的上下文（版本、构建、配置身份等）
    const ctx = h.app.engine.capabilityContext();
    expect(ctx.surgeVersion).toBe('6.5.0');
    for (const key of CAPABILITY_KEYS) h.repos.capabilities.upsert({ key, status: 'supported', context: ctx, verifiedAt: h.clock.now().toISOString(), note: '测试记录' });
    (h.fake as unknown as { version: string; build: string }).version = '6.6.0';
    (h.fake as unknown as { version: string; build: string }).build = '11000';
    await h.app.refreshSurge(WEB);
    const caps = await h.app.listCapabilities();
    // 依赖 Surge 的能力全部失效；只依赖 Safari/macOS 的能力（扩展、原生桥）不受 Surge 版本影响
    const safariOnly = new Set(['native_profile_id', 'native_bridge_ipc', 'bridge_keychain_access', 'extension_install_persistence', 'open_profile_by_id', 'profile_batch_create']);
    for (const c of caps) {
      if (safariOnly.has(c.key)) expect(c.effectiveStatus, c.key).toBe('supported');
      else expect(c.effectiveStatus, c.key).not.toBe('supported');
    }
    expect(caps.find((c) => c.key === 'targeted_resource_refresh')!.staleReasons).toEqual(expect.arrayContaining(['surgeVersion', 'surgeBuild']));
    expect(CAPABILITY_GATES.publish.every((k) => !safariOnly.has(k))).toBe(true);
    const env = h.repos.environments.get(envId)!;
    await expectError(h.app.activate(envId, { request_id: rid() }, WEB), 'CAPABILITY_UNVERIFIED');
    const upd = await h.app.updateEnvironment(envId, { request_id: rid(), expected_revision: env.revision, changes: { proxy: { port: 1081 } } }, WEB);
    await h.idle();
    expect(h.repos.operations.get(upd.operation_id)!.phase).toBe('WAITING_DEPLOYMENT');
    // 普通模式始终可用
    const n = await h.app.enterNormal({ request_id: rid(), old_session_policy: 'closed_confirmed', confirmed_environment_id: envId }, WEB);
    await h.idle();
    expect(h.repos.operations.get(n.operation_id)!.phase).toBe('NORMAL_RESTORED');
  });

  test('12. targeted refresh keeps Chrome connections and profile identity; plain switch never reloads; bad resource keeps the selection', async () => {
    h = await createHarness();
    const { envId: a } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const profileBefore = await h.fake.getCurrentProfile();
    const longChrome = chrome('www.example.test', true);
    // 新增节点：定向刷新
    const b = (await createEnv(h, 'US-Buyer-B', '203.0.113.11')).environment_id!;
    expect((await h.fake.listActiveRequests()).map((r) => r.id)).toContain(longChrome.id);
    expect(chrome().policyName).toBe(longChrome.policyName);
    expect(await h.fake.getCurrentProfile()).toEqual(profileBefore);
    // 单纯切换环境：不重载
    await bind(h, PROFILE_B, b);
    const act = await h.app.activate(b, { request_id: rid(), old_session_policy: 'closed_confirmed', confirmed_environment_id: a }, WEB);
    await h.idle();
    await verify(h, PROFILE_B, act.operation_id);
    expect(h.fake.calls.reloadProfile ?? 0).toBe(0);
    expect(h.fake.reloadCount).toBe(0);
    // 坏资源：读回不一致 → 回滚，原选择保留
    const selection = await h.fake.getGroupSelection(ROUTE_GROUP_NAME);
    h.fake.lieOnNext('getGroupMembers', ['REJECT']);
    const c = await createEnv(h, 'US-Buyer-C', '203.0.113.12');
    const op = h.repos.operations.get(c.operation_id)!;
    expect(op.phase).not.toBe('READY_FOR_NEXT_OPEN');
    expect(await h.fake.getGroupSelection(ROUTE_GROUP_NAME)).toBe(selection);
    expect(safariOutcome(h).leafPolicyName).toBe(selection);
  });
});
