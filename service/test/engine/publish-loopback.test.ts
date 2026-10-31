// 回环发布（D10，loopback-spec §7）：本机资源服务提供候选版本 → 只对本应用的资源单 key 更新一次 → 有限等待与严格读回（读回必须
// 对应一条本服务记下的、候选代数的完整 200）→ 提交；其他结局一律回滚（按 Surge 是否可能已载入候选决定是否再更新一次）。
// 下载失败的各类（2026-10-25 回环矩阵：503、连接重置、截断、无响应、拒绝连接、空 200、只有坏行）、坏行被跳过、同名参数替换、
// 结果不明的更新、更新进行中、skipped、key 安全检查与资源服务的各项前提。只用合成数据。

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { EMPTY_PLACEHOLDER_LINE, NODE_RESOURCE_FILE, ROUTE_GROUP_NAME } from '@sfe/contract';
import type { NodeManifestEntry } from '../../src/db/index.js';
import { validateResourceBody } from '../../src/engine/handlers/publish.js';
import { readAuditState, writeTokenSuspect } from '../../src/resource/index.js';
import { FAKE_REMOTE_ERRORS } from '../../src/surge/fake.js';
import { resourceBody } from '../../src/surge/generate.js';
import { RESOURCE_KEY_NEEDS_HTTP_MESSAGE } from '../../src/surge/resource-key.js';
import { ADMIN, PROFILE_A, WEB, activeEnv, createEnv, createHarness, envInput, rid, type Harness, type ResourceFault } from './harness.js';
import { dropNodesOnNextUpdate, loaded, needsRefresh, nodes, pointer, served, tokenSuspect, updates } from './publish-helpers.js';
import { fetchResource, ourResource } from './resource-fixtures.js';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

const op = (id: string) => h.repos.operations.get(id)!;
const nodeOf = (envId: string, revision = 1) => h.repos.proxyRevisions.get(envId, revision)!.nodeName;

/** 记录每次单 key 更新的 key。 */
function recordUpdateKeys(x: Harness): string[] {
  const keys: string[] = [];
  const orig = x.fake.updateExternalResource.bind(x.fake);
  x.fake.updateExternalResource = async (key: string) => {
    keys.push(key);
    return orig(key);
  };
  return keys;
}

describe('success', () => {
  test('one update of our key only, never all, never a reload; other resources untouched; members and selection read back; audit matched; pointer committed; warning and needsRefresh cleared', async () => {
    h = await createHarness();
    const a = (await createEnv(h, 'US-Buyer-A', '203.0.113.10', { username: 'synthUserA', password: 'synthPassA' })).environment_id!;
    expect(pointer(h)).toEqual({ committed: { generation: 1 }, candidate: null });
    // 之前的检查留下的警告与刷新要求：经确认的读回清除
    h.repos.routeState.update({ warnings: ['node_resource_unverified'] });
    const keys = recordUpdateKeys(h);
    const fetchesBefore = h.fake.remoteFetches.length;
    const entryReloads = h.fake.watcherReloads.length;
    const selection = await h.fake.getGroupSelection(ROUTE_GROUP_NAME);
    const b = await createEnv(h, 'US-Buyer-B', '203.0.113.11');
    expect(op(b.operation_id).phase).toBe('READY_FOR_NEXT_OPEN');
    expect(keys).toEqual([h.resourceKey()]);
    expect(h.fake.updateAllAttempts).toBe(0);
    expect(h.fake.calls.reloadProfile ?? 0).toBe(0);
    expect(h.fake.reloadCount).toBe(0);
    // 只下载了本应用的资源一次（入口规则集等其他资源没有被更新或重新读取）
    expect(h.fake.remoteFetches.slice(fetchesBefore).map((f) => ({ key: f.key, trigger: f.trigger, outcome: f.outcome }))).toEqual([{ key: h.resourceKey(), trigger: 'update', outcome: 'downloaded' }]);
    expect(h.fake.watcherReloads.length).toBe(entryReloads);
    expect(await nodes(h)).toEqual([nodeOf(a), nodeOf(b.environment_id!)]);
    expect(await h.fake.getGroupSelection(ROUTE_GROUP_NAME)).toBe(selection);
    expect(pointer(h)).toEqual({ committed: { generation: 2 }, candidate: null });
    expect(served(h)).toMatchObject({ generation: 2, state: 'committed' });
    const d = h.repos.deployments.latest()!;
    expect(d).toMatchObject({ generation: 2, state: 'verified', readbackLevel: 'full' });
    expect(d.resourceDigest).toBe(h.files.digestContent(fetchResource(h).body.toString('utf8')));
    // 审计状态前移到这次下载（候选代数的完整 200）
    const r = (await ourResource(h))!;
    const record = h.app.engine.resource!.audit().find((x) => x.generation === 2 && x.complete)!;
    expect(readAuditState(h.app.engine.kv)).toMatchObject({ verifiedUpdatedAt: r.lastUpdatedAt!.toISOString(), verifiedError: null, auditedSeq: record.seq });
    expect(h.repos.routeState.get().warnings).not.toContain('node_resource_unverified');
    expect(needsRefresh(h)).toBeNull();
    // 步骤与操作记录中从不出现令牌、地址或资源 key
    const token = h.app.engine.resource!.token;
    const text = JSON.stringify([h.repos.operations.listSteps(b.operation_id), op(b.operation_id)]);
    expect(text).not.toContain(token);
    expect(text).not.toContain(h.resourceKey()!);
    expect(text).not.toContain(String(h.resourcePort));
    expect(h.logs.some((l) => l.includes(token))).toBe(false);
    // Surge 配置目录中没有本地节点文件，凭据不落盘
    expect(existsSync(join(h.surgeDir, NODE_RESOURCE_FILE))).toBe(false);
    expect(loaded(h)).toContain('synthPassA');
  });

  test('an empty manifest is served as the placeholder-only generation and read back as [REJECT, SFE-EMPTY]', async () => {
    h = await createHarness();
    const a = await createEnv(h, 'US-Buyer-A', '203.0.113.10', { password: 'synthPassE1' });
    const env = h.repos.environments.get(a.environment_id!)!;
    await h.app.deleteEnvironment(env.id, { request_id: rid(), expected_revision: env.revision }, ADMIN);
    await h.idle();
    const p = await h.app.publishPending({ request_id: rid('pub') }, WEB);
    await h.idle();
    expect(op(p.operation_id)).toMatchObject({ phase: 'COMPLETED', status: 'succeeded' });
    const d = h.repos.deployments.latest()!;
    expect(d).toMatchObject({ state: 'verified', readbackLevel: 'full', nodeManifest: [] });
    expect(fetchResource(h).body.toString('utf8')).toBe(resourceBody(d.generation, []));
    expect(await h.fake.getGroupMembers(ROUTE_GROUP_NAME)).toEqual(['REJECT', 'SFE-EMPTY']);
    expect(h.repos.proxyRevisions.get(env.id, 1)!.state).toBe('retired');
  });

  test('nothing pending, nothing removed, Surge already on the committed generation: no update at all', async () => {
    h = await createHarness();
    await createEnv(h, 'US-Buyer-A', '203.0.113.10');
    const before = updates(h);
    const generation = h.repos.meta.configurationGeneration();
    const p = await h.app.publishPending({ request_id: rid('pub') }, WEB);
    await h.idle();
    expect(op(p.operation_id)).toMatchObject({ phase: 'COMPLETED', status: 'succeeded' });
    expect(updates(h)).toBe(before);
    expect(h.repos.meta.configurationGeneration()).toBe(generation);
  });
});

describe('download failures (2026-10-25 matrix): Surge keeps the old nodes; the rollback decision follows the evidence', () => {
  const cases: Array<{ name: string; fault: ResourceFault; times: number; text: string; held: boolean }> = [
    { name: '503', fault: { kind: 'http', status: 503 }, times: 1, text: FAKE_REMOTE_ERRORS.status(503), held: true },
    { name: 'reset', fault: { kind: 'reset' }, times: 6, text: FAKE_REMOTE_ERRORS.interrupted, held: true },
    { name: 'truncated', fault: { kind: 'truncated' }, times: 2, text: FAKE_REMOTE_ERRORS.interrupted, held: true },
    { name: 'no_response', fault: { kind: 'no_response' }, times: 2, text: FAKE_REMOTE_ERRORS.timeout, held: true },
    { name: 'refused', fault: { kind: 'refused' }, times: 1, text: FAKE_REMOTE_ERRORS.refused, held: false },
    { name: 'empty200', fault: { kind: 'http', status: 200, body: '' }, times: 1, text: FAKE_REMOTE_ERRORS.empty, held: true },
    { name: 'onlyBad', fault: { kind: 'http', status: 200, body: 'not a proxy line\n[Proxy]\n' }, times: 1, text: FAKE_REMOTE_ERRORS.parse, held: true },
  ];

  test.each(cases)('$name: publish FAILED with the reason, old nodes and selection kept, pointer unchanged', async ({ fault, times, text, held }) => {
    h = await createHarness();
    const { envId: a } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const committed = pointer(h)!;
    const selection = await h.fake.getGroupSelection(ROUTE_GROUP_NAME);
    const before = updates(h);
    h.resourceFault(fault, { times });
    const b = await createEnv(h, 'US-Buyer-B', '203.0.113.11');
    const o = op(b.operation_id);
    expect(o).toMatchObject({ phase: 'FAILED', status: 'failed', error: { code: 'SURGE_COMMAND_FAILED' } });
    expect(o.error!.message).toContain(text);
    // 下载有本服务的审计记录（服务接受了请求而答复出错）时 Surge 可能载入了候选：回滚单 key 更新一次；拒绝连接时什么也没到达
    expect(updates(h) - before).toBe(held ? 2 : 1);
    expect(h.repos.deployments.latest()!.state).toBe('rolled_back');
    expect(await nodes(h)).toEqual([nodeOf(a)]);
    expect(await h.fake.getGroupSelection(ROUTE_GROUP_NAME)).toBe(selection);
    expect(pointer(h)).toEqual(committed);
    expect(served(h)).toMatchObject({ generation: committed.committed.generation, state: 'committed' });
    expect(h.repos.environments.get(b.environment_id!)!.deployedProxyRevision).toBeNull();
    expect(h.repos.routeState.get()).toMatchObject({ phase: 'active_verified', activeEnvironmentId: a });
    expect(h.repos.routeState.get().warnings).not.toContain('node_resource_unverified');
    expect(needsRefresh(h)).toBeNull();
    expect(tokenSuspect(h)).toBeNull();
  });

  test('a persistent 503: the rollback update fails too → BLOCKED_NEEDS_ATTENTION, route attention, node_resource_unverified, needsRefresh kept; normal mode still works', async () => {
    h = await createHarness();
    const { envId: a } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const before = updates(h);
    h.resourceFault({ kind: 'http', status: 503 });
    const b = await createEnv(h, 'US-Buyer-B', '203.0.113.11');
    h.resourceFault(null);
    expect(op(b.operation_id)).toMatchObject({ phase: 'BLOCKED_NEEDS_ATTENTION', status: 'needs_attention', error: { code: 'READBACK_MISMATCH' } });
    expect(updates(h) - before).toBe(2);
    expect(h.repos.deployments.latest()!.state).toBe('failed');
    const route = h.repos.routeState.get();
    expect(route).toMatchObject({ phase: 'attention', activeEnvironmentId: a });
    expect(route.warnings).toEqual(expect.arrayContaining(['node_resource_unverified', 'external_selection_change']));
    expect(needsRefresh(h)).not.toBeNull();
    // Surge 仍是旧节点（下载失败时保留缓存）
    expect(await nodes(h)).toEqual([nodeOf(a)]);
    const n = await h.app.enterNormal({ request_id: rid('normal'), old_session_policy: 'closed_confirmed', confirmed_environment_id: a }, WEB);
    await h.idle();
    expect(op(n.operation_id)).toMatchObject({ phase: 'NORMAL_RESTORED', status: 'succeeded' });
    // 下一次发布收敛并清除警告
    const p = await h.app.publishPending({ request_id: rid('pub') }, WEB);
    await h.idle();
    expect(op(p.operation_id).status).toBe('succeeded');
    expect(h.repos.routeState.get().warnings).not.toContain('node_resource_unverified');
    expect(needsRefresh(h)).toBeNull();
  });
});

describe('strict readback', () => {
  test('valid A/B + bad C: Surge reports success and drops C; the readback catches it and rolls back to A/B', async () => {
    h = await createHarness();
    const a = (await createEnv(h, 'US-Buyer-A', '203.0.113.10')).environment_id!;
    const b = (await createEnv(h, 'US-Buyer-B', '203.0.113.11')).environment_id!;
    await h.app.executor.stop();
    const c = await h.app.createEnvironment({ request_id: rid(), environment: envInput('US-Buyer-C', '203.0.113.12') }, WEB);
    dropNodesOnNextUpdate(h, [nodeOf(c.environment_id!)]);
    const before = updates(h);
    h.app.executor.start();
    await h.idle();
    const o = op(c.operation_id);
    expect(o).toMatchObject({ phase: 'FAILED', error: { code: 'READBACK_MISMATCH' } });
    expect((o.error!.details as { checks: string[] }).checks).toContain('members');
    expect(updates(h) - before).toBe(2);
    expect(await nodes(h)).toEqual([nodeOf(a), nodeOf(b)]);
    expect(h.repos.deployments.latest()!.state).toBe('rolled_back');
  });

  test('duplicate node names are refused before anything is served or updated', async () => {
    h = await createHarness();
    const a = (await createEnv(h, 'US-Buyer-A', '203.0.113.10')).environment_id!;
    h.revoke(['loopback_publish_crash']);
    const b = (await createEnv(h, 'US-Buyer-B', '203.0.113.11')).environment_id!;
    h.grant(['loopback_publish_crash']);
    // 只差凭据的重名读回无法区分（矩阵 dupC：第一条定义生效）：在提供之前拒绝。这里是只差大小写的重名（数据库的唯一约束区分
    // 大小写，Surge 的策略名不一定区分）
    const variant = nodeOf(a).replace(/v001$/, 'V001');
    expect(variant).not.toBe(nodeOf(a));
    h.repos.db.run('UPDATE proxy_revisions SET node_name = ? WHERE environment_id = ? AND revision = 1', [variant, b]);
    const before = updates(h);
    const committed = pointer(h);
    const p = await h.app.publishPending({ request_id: rid('pub') }, WEB);
    await h.idle();
    expect(op(p.operation_id)).toMatchObject({ phase: 'FAILED', error: { code: 'VALIDATION_FAILED', details: { reason: 'duplicate_name' } } });
    expect(updates(h)).toBe(before);
    expect(pointer(h)).toEqual(committed);
    expect(served(h)).toMatchObject({ state: 'committed', generation: committed!.committed.generation });
    expect(h.repos.deployments.list().some((d) => d.state === 'candidate')).toBe(false);
  });

  test('validateResourceBody: each line is exactly its manifest entry; reserved and duplicate names, section lines, oversize and a missing placeholder are refused', () => {
    const m = (n: number): NodeManifestEntry => ({ nodeName: `SFE-N-E000${n}-US0${n}-v001`, environmentId: `env${n}`, proxyRevision: 1 });
    const expected = (x: NodeManifestEntry) => ({ host: `203.0.113.${x.environmentId.slice(3)}`, port: 1080, front: 'Front-A' });
    const line = (x: NodeManifestEntry, host = expected(x).host) => `${x.nodeName} = socks5, ${host}, 1080, username=u1, password=p1, underlying-proxy=Front-A`;
    const [m1, m2] = [m(1), m(2)];
    expect(validateResourceBody(resourceBody(5, [line(m1), line(m2)]), [m1, m2], expected)).toBeNull();
    expect(validateResourceBody(resourceBody(5, []), [], expected)).toBeNull();
    expect(validateResourceBody(`# SFE managed resource · generation 5\n${EMPTY_PLACEHOLDER_LINE}\nSFE-OTHER = reject\n`, [], expected)).toBe('placeholder');
    expect(validateResourceBody(resourceBody(5, [line(m1), line(m1)]), [m1, { ...m1, environmentId: 'env1' }], expected)).toBe('duplicate_name');
    expect(validateResourceBody(resourceBody(5, [line(m1, '198.51.100.9')]), [m1], expected)).toBe('mismatch');
    expect(validateResourceBody(resourceBody(5, [line(m1)]), [m1, m2], expected)).toBe('count');
    expect(validateResourceBody(`# x\n[Proxy]\n${line(m1)}\n`, [m1], expected)).toBe('section_line');
    const reserved = { ...m1, nodeName: 'SFE-EMPTY' };
    expect(validateResourceBody(`# x\nSFE-EMPTY = socks5, 203.0.113.1, 1080, underlying-proxy=Front-A\n`, [reserved], expected)).toBe('reserved_name');
    expect(validateResourceBody(`# x\nDIRECT = socks5, 203.0.113.1, 1080, underlying-proxy=Front-A\n`, [{ ...m1, nodeName: 'DIRECT' }], expected)).toBe('reserved_name');
    expect(validateResourceBody(`# x\n${'#'.repeat(1024 * 1024)}\n`, [], expected)).toBe('too_large');
    expect(validateResourceBody(`# x\r\n${line(m1)}\n`, [m1], expected)).toBe('control_character');
  });

  test('same-name parameter change: detected by the per-node detail readback (rollback); without getPolicyDetail the readback is partial, the deployment stays published and needsRefresh is kept', async () => {
    h = await createHarness();
    const a = (await createEnv(h, 'US-Buyer-A', '203.0.113.10')).environment_id!;
    // Surge 读回的新节点服务器与它的版本不同（同名参数替换：成员名称看不出来）
    const origDetail = h.fake.getPolicyDetail.bind(h.fake);
    h.fake.getPolicyDetail = async (name: string) => {
      const d = await origDetail(name);
      return name.includes('E0002') && served(h)?.state === 'candidate' ? { ...d, server: '198.51.100.99' } : d;
    };
    const b = await createEnv(h, 'US-Buyer-B', '203.0.113.11');
    expect(op(b.operation_id)).toMatchObject({ phase: 'FAILED', error: { code: 'READBACK_MISMATCH' } });
    expect((op(b.operation_id).error!.details as { checks: string[] }).checks).toContain(`detail:${nodeOf(b.environment_id!)}`);
    expect(await nodes(h)).toEqual([nodeOf(a)]);
    h.fake.getPolicyDetail = origDetail;
    // 没有逐节点参数读回：同样的情形无法发现——读回不完整，不标为已核对，刷新要求保留
    const mech = h.fake.mechanism.bind(h.fake);
    h.fake.mechanism = () => ({ ...mech(), getPolicyDetail: 'unavailable' });
    const p = await h.app.publishPending({ request_id: rid('pub') }, WEB);
    await h.idle();
    expect(op(p.operation_id)).toMatchObject({ phase: 'DEPLOYED_UNVERIFIED' });
    expect(h.repos.deployments.latest()).toMatchObject({ state: 'published', readbackLevel: 'partial' });
    expect(needsRefresh(h)).not.toBeNull();
    expect(h.repos.environments.get(b.environment_id!)!.deployedProxyRevision).toBeNull();
  });
});

describe('ambiguous and slow updates', () => {
  test('update_timeout while Surge applies the candidate anyway: never replayed; the rollback update brings Surge back to the committed nodes', async () => {
    h = await createHarness();
    const a = (await createEnv(h, 'US-Buyer-A', '203.0.113.10')).environment_id!;
    const before = updates(h);
    h.fake.timeoutNextUpdate();
    const b = await createEnv(h, 'US-Buyer-B', '203.0.113.11');
    const o = op(b.operation_id);
    expect(o).toMatchObject({ phase: 'FAILED', error: { code: 'SURGE_COMMAND_FAILED', details: { reason: 'update_timeout' } } });
    expect(updates(h) - before).toBe(2);
    expect(await nodes(h)).toEqual([nodeOf(a)]);
    expect(h.repos.deployments.latest()!.state).toBe('rolled_back');
    expect(needsRefresh(h)).toBeNull();
  });

  test('update_timeout and the candidate applied a little later (Surge reports updating): the bounded wait sees it applied, the rollback restores the committed nodes', async () => {
    h = await createHarness({ resourceUpdateWait: { timeoutMs: 10_000, pollMs: 500, settleMs: 0 } });
    const a = (await createEnv(h, 'US-Buyer-A', '203.0.113.10')).environment_id!;
    const before = updates(h);
    h.fake.timeoutNextUpdate({ applyAfterMs: 2_000 });
    const b = await h.app.createEnvironment({ request_id: rid(), environment: envInput('US-Buyer-B', '203.0.113.11') }, WEB);
    // 只在等待 Surge 结束更新时推进假时钟（校验、--check 等真实 I/O 照常完成）
    for (let i = 0; i < 2_000 && ['queued', 'running'].includes(op(b.operation_id).status); i++) {
      await new Promise((r) => setTimeout(r, 2));
      if (['DEPLOYING', 'ROLLING_BACK'].includes(op(b.operation_id).phase)) await h.clock.advanceAsync(500);
    }
    await h.idle();
    expect(op(b.operation_id)).toMatchObject({ phase: 'FAILED', error: { details: { reason: 'update_timeout' } } });
    expect(updates(h) - before).toBe(2);
    expect(await nodes(h)).toEqual([nodeOf(a)]);
  });

  test('Surge still updating at the bound: rolled back without a second update → BLOCKED_NEEDS_ATTENTION with the warning; the late download gets the committed generation', async () => {
    h = await createHarness();
    const a = (await createEnv(h, 'US-Buyer-A', '203.0.113.10')).environment_id!;
    const before = updates(h);
    h.fake.slowUpdate = { durationMs: 60_000 };
    const b = await createEnv(h, 'US-Buyer-B', '203.0.113.11');
    h.fake.slowUpdate = null;
    expect(op(b.operation_id)).toMatchObject({ phase: 'BLOCKED_NEEDS_ATTENTION', status: 'needs_attention' });
    expect(updates(h) - before).toBe(1);
    expect(pointer(h)!.candidate).toBeNull();
    expect(served(h)).toMatchObject({ state: 'committed', generation: 1 });
    expect(h.repos.routeState.get().warnings).toContain('node_resource_unverified');
    expect(needsRefresh(h)).not.toBeNull();
    // Surge 的那次下载之后才发生：资源服务已撤回候选，它拿到的是已提交版本
    h.clock.advance(61_000);
    expect(await nodes(h)).toEqual([nodeOf(a)]);
  });

  test('Surge already updating before the publish: parked without serving anything', async () => {
    h = await createHarness();
    await createEnv(h, 'US-Buyer-A', '203.0.113.10');
    h.fake.slowUpdate = { durationMs: 60_000 };
    h.fake.runScheduledRefresh(h.resourceKey()!);
    h.fake.slowUpdate = null;
    const before = updates(h);
    const b = await createEnv(h, 'US-Buyer-B', '203.0.113.11');
    expect(op(b.operation_id)).toMatchObject({ phase: 'WAITING_DEPLOYMENT', status: 'parked', error: { details: { reason: 'resource_updating' } } });
    expect(updates(h)).toBe(before);
    expect(served(h)).toMatchObject({ state: 'committed', generation: 1 });
  });

  test('a skipped result is a failure (Surge did not download), never "no change"', async () => {
    h = await createHarness();
    const a = (await createEnv(h, 'US-Buyer-A', '203.0.113.10')).environment_id!;
    const before = updates(h);
    h.fake.lieOnNext('updateExternalResource', { key: h.resourceKey(), refreshed: false, outcome: 'skipped' });
    const b = await createEnv(h, 'US-Buyer-B', '203.0.113.11');
    expect(op(b.operation_id)).toMatchObject({ phase: 'FAILED', error: { code: 'SURGE_COMMAND_FAILED', details: { outcome: 'skipped' } } });
    // Surge 没有载入候选：不再更新，核对它仍是已提交版本
    expect(updates(h) - before).toBe(1);
    expect(await nodes(h)).toEqual([nodeOf(a)]);
    expect(h.repos.deployments.latest()!.state).toBe('rolled_back');
  });
});

describe('parks: nothing served, nothing updated', () => {
  async function expectParked(x: Harness, code: string, reason?: string): Promise<string> {
    const before = updates(x);
    const servedBefore = x.app.engine.resource?.served() ?? null;
    const a = await createEnv(x, 'US-Buyer-A', '203.0.113.10');
    const o = x.repos.operations.get(a.operation_id)!;
    expect(o).toMatchObject({ phase: 'WAITING_DEPLOYMENT', status: 'parked', error: { code } });
    if (reason) expect(o.error!.details).toMatchObject({ reason });
    expect(updates(x)).toBe(before);
    if (x.app.engine.resource) expect(x.app.engine.resource.served()).toEqual(servedBefore);
    return o.error!.message;
  }

  test('a resource key that might carry the token is never put on the command line: CLI/fake mechanism parks; the HTTP mechanism publishes', async () => {
    h = await createHarness({ fakeRemote: { urlKeys: true } });
    expect(h.resourceKey()).toContain('://');
    const message = await expectParked(h, 'CAPABILITY_UNVERIFIED', 'key_unsafe_for_cli');
    expect(message).toContain(RESOURCE_KEY_NEEDS_HTTP_MESSAGE);
    expect(message).not.toContain(h.app.engine.resource!.token);
    const mech = h.fake.mechanism.bind(h.fake);
    h.fake.mechanism = () => ({ ...mech(), updateExternalResource: 'http' });
    const p = await h.app.publishPending({ request_id: rid('pub') }, WEB);
    await h.idle();
    expect(op(p.operation_id).phase).toBe('READY_FOR_NEXT_OPEN');
  });

  test('token suspect → parked until the resource address is rotated', async () => {
    h = await createHarness();
    writeTokenSuspect(h.app.engine.kv, { since: h.clock.now().toISOString(), reason: 'port_in_use' });
    const message = await expectParked(h, 'RESOURCE_SERVER_UNAVAILABLE', 'token_suspect');
    expect(message).toContain('轮换资源地址');
  });

  test('the resource service is not listening on its port → parked', async () => {
    h = await createHarness();
    await h.app.engine.resource!.close();
    h.binderRegistry.set(h.resourcePort, 'other-process');
    await expectParked(h, 'RESOURCE_SERVER_UNAVAILABLE', 'not_listening');
  });

  test('the read token is unavailable (no resource service) → parked SECRET_STORE_FAILED', async () => {
    h = await createHarness();
    await h.store.delete('sfe.resource-token.1');
    await h.crash();
    await h.idle();
    expect(h.app.engine.resource).toBeNull();
    await expectParked(h, 'SECRET_STORE_FAILED', 'token_unavailable');
  });

  test('the working profile still has the legacy local group line → parked: remerge needed; the local file is never written', async () => {
    h = await createHarness({ nodeResource: 'legacy' });
    const file = join(h.surgeDir, NODE_RESOURCE_FILE);
    const content = readFileSync(file, 'utf8');
    const message = await expectParked(h, 'RESOURCE_MISSING', 'legacy_line');
    expect(message).toContain('需要重新合并以改用本机资源服务');
    expect(readFileSync(file, 'utf8')).toBe(content);
    expect(h.fake.calls.reloadProfile ?? 0).toBe(0);
  });

  test('the publish gate is identical for the system refresh: the four loopback checks unmet → parked with the loopback text', async () => {
    h = await createHarness({ withholdLoopbackCapabilities: true });
    const message = await expectParked(h, 'CAPABILITY_UNVERIFIED');
    expect(message).toBe('发布暂停：回环资源单 key 更新、服务认证与端口占用、重启缓存、并发与崩溃补测尚未通过；新版本保持待部署');
  });
});
