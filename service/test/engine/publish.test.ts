// 发布（D10）：门槛、成功路径、读回级别、基线检查、读回不一致的回滚与保留集。节点资源由本机资源服务提供，发布只对本应用的
// 资源单 key 更新一次并读回；断言看资源服务提供的版本、Surge 缓存的内容与写原语的调用次数，从不看本地节点文件。只用合成数据。

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { CAPABILITY_GATES, NODE_RESOURCE_FILE, WORKING_PROFILE_NAME, type CapabilityKey } from '@sfe/contract';
import { profileMatches } from '../../src/engine/context.js';
import { ADMIN, PROFILE_A, WEB, activeEnv, bind, createEnv, createHarness, entryWrites, envInput, rid, safariOutcome, type Harness } from './harness.js';
import { dropNodesOnNextUpdate, loaded, nodes, pointer, served, updates } from './publish-helpers.js';
import { fetchResource } from './resource-fixtures.js';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

const WRITE_PRIMITIVES = ['updateExternalResource', 'selectGroupPolicy', 'addTempRule', 'removeTempRule', 'killRequest', 'reloadProfile'];
// 写原语的调用次数之外还看入口规则集文件（ruleset_resource 的入口写入是文件写入加文件监视，不经适配器写原语）
const writes = (hh: Harness) => ({ ...Object.fromEntries(WRITE_PRIMITIVES.map((k) => [k, hh.fake.calls[k] ?? 0])), ...entryWrites(hh.fake) });
/** 本机资源服务提供的版本与 Surge 缓存的本应用节点资源：门槛不足或失败时两者都不变。 */
const resource = (hh: Harness) => ({ served: served(hh), loaded: loaded(hh), pointer: pointer(hh) });

describe('publish gate (identical for automatic and manual publish)', () => {
  test.each(CAPABILITY_GATES.publish.map((k) => [k]))('missing %s → WAITING_DEPLOYMENT, nothing written', async (key) => {
    h = await createHarness();
    h.revoke([key as CapabilityKey]);
    const before = writes(h);
    const fileBefore = resource(h);
    const a = await createEnv(h, 'US-Buyer-01', '203.0.113.10');
    const op = h.repos.operations.get(a.operation_id)!;
    expect(op.phase).toBe('WAITING_DEPLOYMENT');
    expect(op.status).toBe('parked');
    expect(op.error?.code).toBe('CAPABILITY_UNVERIFIED');
    expect(JSON.stringify(op.error?.details)).toContain(key);
    expect(writes(h)).toEqual(before);
    expect(resource(h)).toEqual(fileBefore);
    // 手动发布的门槛完全相同，没有“确认后强制发布”的参数
    const manual = await h.app.publishPending({ request_id: rid('pub'), force: true } as never, WEB);
    await h.idle();
    expect(h.repos.operations.get(manual.operation_id)!.phase).toBe('WAITING_DEPLOYMENT');
    expect(writes(h)).toEqual(before);
    await bind(h, PROFILE_A, a.environment_id!);
    const view = await h.app.getEnvironment(a.environment_id!, WEB);
    expect(view.facets.deployment).toBe('blocked_by_capability');
    expect(view.readiness).toBe('waiting_deployment');
    expect(view.nextActions[0]).toMatchObject({ kind: 'verify_capability' });
    expect(view.nextActions[0]!.capabilities).toContain(key);
  });

  test('after the capability is confirmed, publishPending deploys', async () => {
    h = await createHarness();
    h.revoke(['loopback_resource_update']);
    const a = await createEnv(h, 'US-Buyer-01', '203.0.113.10');
    h.grant(['loopback_resource_update']);
    const p = await h.app.publishPending({ request_id: rid('pub') }, WEB);
    await h.idle();
    expect(h.repos.operations.get(p.operation_id)!.phase).toBe('READY_FOR_NEXT_OPEN');
    expect(h.repos.environments.get(a.environment_id!)!.deployedProxyRevision).toBe(1);
  });

  test('auto-reload setting differing from the condition the loopback update was measured under parks the publish', async () => {
    h = await createHarness();
    // 实测时自动重载为关；当前读到开（回环资源单 key 更新的记录，不是 auto_reload_atomic_replace）
    const cap = h.repos.capabilities.get('loopback_resource_update')!;
    h.repos.capabilities.upsert({ ...cap, context: { ...cap.context!, autoReload: 'off' } });
    h.fake.reportedAutoReload = true;
    const before = writes(h);
    const a = await createEnv(h, 'US-Buyer-01', '203.0.113.10');
    const op = h.repos.operations.get(a.operation_id)!;
    expect(op.phase).toBe('WAITING_DEPLOYMENT');
    expect(op.error?.code).toBe('CAPABILITY_UNVERIFIED');
    expect(writes(h)).toEqual(before);
    // auto_reload_atomic_replace 的条件不参与发布门槛
    h.repos.capabilities.upsert({ ...cap, context: { ...cap.context!, autoReload: 'on' } });
    const other = h.repos.capabilities.get('auto_reload_atomic_replace')!;
    h.repos.capabilities.upsert({ ...other, context: { ...other.context!, autoReload: 'off' } });
    const p = await h.app.publishPending({ request_id: rid('pub') }, WEB);
    await h.idle();
    expect(h.repos.operations.get(p.operation_id)!.phase).toBe('READY_FOR_NEXT_OPEN');
  });
});

describe('publish happy path', () => {
  test('deploys with full readback, preflight ok → READY_FOR_NEXT_OPEN; no reload', async () => {
    h = await createHarness();
    const a = await createEnv(h, 'US-Buyer-01', '203.0.113.10', { username: 'synthuser01', password: 'synthpass01' });
    const op = h.repos.operations.get(a.operation_id)!;
    expect(op.phase).toBe('READY_FOR_NEXT_OPEN');
    expect(op.result).toMatchObject({ readbackLevel: 'full', uncheckedFields: [] });
    const d = h.repos.deployments.latest()!;
    expect(d.state).toBe('verified');
    expect(d.nodeManifest.map((m) => m.nodeName)).toEqual(['SFE-N-E0001-US01-v001']);
    expect(await h.fake.getGroupMembers('SFE-ROUTE')).toEqual(['REJECT', 'SFE-N-E0001-US01-v001']);
    expect(h.fake.calls.reloadProfile ?? 0).toBe(0);
    expect(updates(h)).toBe(1);
    expect(served(h)).toMatchObject({ generation: 1, state: 'committed' });
    expect(pointer(h)).toEqual({ committed: { generation: 1 }, candidate: null });
    // 预检不返回出口 IP
    const p = h.repos.probes.latest(a.environment_id!, 'preflight')!;
    expect(p.outcome).toBe('ok');
    expect(p.exitIp).toBeNull();
    // 提供的内容的首行只含代数，不含摘要；Surge 的配置目录中没有本地节点文件
    expect(fetchResource(h).body.toString('utf8').split('\n')[0]).toBe('# SFE managed resource · generation 1');
    expect(readdirSync(h.surgeDir)).not.toContain(NODE_RESOURCE_FILE);
    // 候选副本已删除
    expect(readdirSync(join(h.dir, 'tmp'))).toEqual([]);
  });

  test('without independent preflight → DEPLOYED_UNVERIFIED with inconclusive probe', async () => {
    h = await createHarness();
    h.revoke(['independent_node_preflight']);
    const before = h.fake.calls.testPolicy ?? 0;
    const a = await createEnv(h, 'US-Buyer-01', '203.0.113.10');
    expect(h.repos.operations.get(a.operation_id)!.phase).toBe('DEPLOYED_UNVERIFIED');
    expect(h.repos.probes.latest(a.environment_id!, 'preflight')!.outcome).toBe('inconclusive');
    expect(h.fake.calls.testPolicy ?? 0).toBe(before);
    const view = await h.app.getEnvironment(a.environment_id!, WEB);
    expect(view.readiness).toBe('needs_binding');
  });

  test('preflight failure → FAILED PREFLIGHT_FAILED and proxy_unavailable', async () => {
    h = await createHarness();
    h.fake.setPolicyTestResult('SFE-N-E0001-US01-v001', { ok: false, latencyMs: null, error: 'front unreachable' });
    const a = await createEnv(h, 'US-Buyer-01', '203.0.113.10');
    const op = h.repos.operations.get(a.operation_id)!;
    expect(op.phase).toBe('FAILED');
    expect(op.error?.code).toBe('PREFLIGHT_FAILED');
    expect(h.repos.environments.get(a.environment_id!)!.deployedProxyRevision).toBe(1);
    expect((await h.app.getEnvironment(a.environment_id!, WEB)).readiness).toBe('proxy_unavailable');
  });

  test('coalesces queued publish operations into one deployment, each keeps its own result', async () => {
    h = await createHarness();
    await h.app.executor.stop();
    const a = await h.app.createEnvironment({ request_id: rid(), environment: envInput('US-Buyer-01', '203.0.113.10') }, WEB);
    const b = await h.app.createEnvironment({ request_id: rid(), environment: envInput('US-Buyer-02', '203.0.113.11') }, WEB);
    h.app.executor.start();
    await h.idle();
    expect(h.repos.deployments.list().length).toBe(1);
    expect(h.repos.deployments.latest()!.nodeManifest).toHaveLength(2);
    expect(h.repos.operations.get(a.operation_id)!.phase).toBe('READY_FOR_NEXT_OPEN');
    expect(h.repos.operations.get(b.operation_id)!.phase).toBe('READY_FOR_NEXT_OPEN');
  });
});

describe('readback level', () => {
  const noDetail = (hh: Harness) => {
    const orig = hh.fake.mechanism.bind(hh.fake);
    hh.fake.mechanism = () => ({ ...orig(), getPolicyDetail: 'unavailable' });
  };

  test('partial readback not covered by P0 records → published, not activatable (sync_failed)', async () => {
    h = await createHarness();
    noDetail(h);
    const a = await createEnv(h, 'US-Buyer-01', '203.0.113.10');
    const op = h.repos.operations.get(a.operation_id)!;
    expect(op.phase).toBe('DEPLOYED_UNVERIFIED');
    expect(op.result).toMatchObject({ readbackLevel: 'partial', uncheckedFields: ['server', 'port', 'underlying-proxy'] });
    expect(h.repos.deployments.latest()!.state).toBe('published');
    expect(h.repos.environments.get(a.environment_id!)!.deployedProxyRevision).toBeNull();
    const view = await h.app.getEnvironment(a.environment_id!, WEB);
    expect(view.facets.deployment).toBe('readback_partial');
    expect(view.readiness).toBe('sync_failed');
  });

  test('partial readback covered by P0 records → verified and activatable', async () => {
    h = await createHarness({ readbackCovers: true });
    noDetail(h);
    const a = await createEnv(h, 'US-Buyer-01', '203.0.113.10');
    expect(h.repos.deployments.latest()!.state).toBe('verified');
    expect(h.repos.deployments.latest()!.readbackLevel).toBe('partial');
    expect(h.repos.environments.get(a.environment_id!)!.deployedProxyRevision).toBe(1);
  });
});

describe('baseline checks', () => {
  test('user edit outside managed segments is adopted as the new baseline', async () => {
    h = await createHarness();
    await createEnv(h, 'US-Buyer-01', '203.0.113.10');
    const text = readFileSync(h.profilePath, 'utf8').replace('FINAL,DIRECT', 'DOMAIN-SUFFIX,user-added.example.test,DIRECT\nFINAL,DIRECT');
    writeFileSync(h.profilePath, text);
    const b = await createEnv(h, 'US-Buyer-02', '203.0.113.11');
    const op = h.repos.operations.get(b.operation_id)!;
    expect(op.phase).toBe('READY_FOR_NEXT_OPEN');
    const steps = h.repos.operations.listSteps(op.id).map((s) => s.message);
    expect(steps.some((m) => m.includes('作为新基线'))).toBe(true);
    expect(readFileSync(h.profilePath, 'utf8')).toContain('user-added.example.test');
  });

  test('the deployment keeps only a process-local check of the working profile: after a restart an outside edit is still adopted, without the note', async () => {
    h = await createHarness({ dbFile: true });
    await createEnv(h, 'US-Buyer-01', '203.0.113.10');
    const recorded = h.repos.deployments.latest()!.workingProfileDigest!;
    // 不是工作配置的 pepper 派生摘要（files.digestContent），而是本进程随机密钥下的核对值
    expect(recorded).toMatch(/^eph1:[0-9a-f]{16}:[0-9a-f]{64}$/);
    expect(recorded).not.toContain(h.app.engine.profileFiles()!.digestContent(readFileSync(h.profilePath, 'utf8')));
    await h.crash();
    writeFileSync(h.profilePath, readFileSync(h.profilePath, 'utf8').replace('FINAL,DIRECT', 'DOMAIN-SUFFIX,user-added.example.test,DIRECT\nFINAL,DIRECT'));
    const b = await createEnv(h, 'US-Buyer-02', '203.0.113.11');
    const op = h.repos.operations.get(b.operation_id)!;
    expect(op.phase).toBe('READY_FOR_NEXT_OPEN');
    // 之前的进程记下的核对值无从比较：不提示，也不因此失败
    expect(h.repos.operations.listSteps(op.id).some((s) => s.message.includes('作为新基线'))).toBe(false);
    expect(h.repos.deployments.latest()!.workingProfileDigest).not.toBe(recorded);
  });

  test('managed-segment edit stops with BASELINE_CHANGED and nothing is written', async () => {
    h = await createHarness();
    const original = readFileSync(h.profilePath, 'utf8');
    const text = original.replace(/SFE-ROUTE = select, REJECT, /, 'SFE-ROUTE = select, DIRECT, ');
    expect(text).not.toBe(original);
    writeFileSync(h.profilePath, text);
    const before = writes(h);
    const a = await createEnv(h, 'US-Buyer-01', '203.0.113.10');
    const op = h.repos.operations.get(a.operation_id)!;
    expect(op.phase).toBe('FAILED');
    expect(op.error?.code).toBe('BASELINE_CHANGED');
    expect(JSON.stringify(op.error)).not.toContain('DIRECT');
    expect(writes(h)).toEqual(before);
  });

  test('a reference to the resource service port outside the managed group segment → NAME_COLLISION, nothing served or updated', async () => {
    h = await createHarness();
    const port = h.resourcePort;
    const text = readFileSync(h.profilePath, 'utf8').replace('Daily = select, Front-A, Front-B, DIRECT', `Daily = select, Front-A, Front-B, DIRECT\nUser-Import = select, policy-path=http://127.0.0.1:${port}/x/list`);
    writeFileSync(h.profilePath, text);
    const before = writes(h);
    const fileBefore = resource(h);
    const a = await createEnv(h, 'US-Buyer-01', '203.0.113.10');
    const op = h.repos.operations.get(a.operation_id)!;
    expect(op.error?.code).toBe('NAME_COLLISION');
    expect(JSON.stringify(op.error)).toContain('resource_reference');
    expect(writes(h)).toEqual(before);
    expect(resource(h)).toEqual(fileBefore);
  });

  test('a stray sfe-nodes.list in the Surge directory is never read or written', async () => {
    h = await createHarness();
    writeFileSync(join(h.surgeDir, NODE_RESOURCE_FILE), '# edited by hand\n');
    const a = await createEnv(h, 'US-Buyer-01', '203.0.113.10');
    expect(h.repos.operations.get(a.operation_id)!.phase).toBe('READY_FOR_NEXT_OPEN');
    expect(readFileSync(join(h.surgeDir, NODE_RESOURCE_FILE), 'utf8')).toBe('# edited by hand\n');
  });

  test('foreign SFE- object in the profile → NAME_COLLISION', async () => {
    h = await createHarness();
    const text = readFileSync(h.profilePath, 'utf8').replace('[Proxy Group]', 'SFE-N-E9999-US99-v001 = socks5, 198.51.100.9, 1080\n\n[Proxy Group]');
    writeFileSync(h.profilePath, text);
    const a = await createEnv(h, 'US-Buyer-01', '203.0.113.10');
    expect(h.repos.operations.get(a.operation_id)!.error?.code).toBe('NAME_COLLISION');
  });

  test('--check failure → SURGE_CHECK_FAILED, active files untouched, output scrubbed, candidate deleted', async () => {
    h = await createHarness();
    const fileBefore = resource(h);
    const pw = 'synthpass99';
    h.fake.checkProfile = async () => ({ ok: false, message: `line 3: SFE-N-E0001-US01-v001 = socks5, 203.0.113.10, 1080, password=${pw} invalid` });
    const before = writes(h);
    const a = await createEnv(h, 'US-Buyer-01', '203.0.113.10', { password: pw });
    const op = h.repos.operations.get(a.operation_id)!;
    expect(op.error?.code).toBe('SURGE_CHECK_FAILED');
    expect(JSON.stringify(op)).not.toContain('synthpass99');
    expect(resource(h)).toEqual(fileBefore);
    expect(writes(h)).toEqual(before);
    expect(readdirSync(join(h.dir, 'tmp'))).toEqual([]);
  });

  test('current profile is not the working profile → EXTERNAL_PROFILE, nothing written', async () => {
    h = await createHarness();
    h.fake.currentProfile = { name: 'Other', path: join(h.surgeDir, 'Other.conf') };
    const before = writes(h);
    const a = await createEnv(h, 'US-Buyer-01', '203.0.113.10');
    expect(h.repos.operations.get(a.operation_id)!.error?.code).toBe('EXTERNAL_PROFILE');
    expect(writes(h)).toEqual(before);
  });

  // Surge 当前配置只按完整路径认定（profileMatches）：同名但没有路径（HTTP 的 getCurrentProfile 不给路径；“profiles that do
  // not originate from a local file report no path”）不是工作配置。之前按名称回退时这里会被当作工作配置。
  test('the working profile name without a path is not the working profile: refused before writing, and at readback rolled back', async () => {
    h = await createHarness();
    const working = { ...h.fake.currentProfile };
    expect(profileMatches({ name: WORKING_PROFILE_NAME, path: null }, { name: WORKING_PROFILE_NAME, path: working.path! })).toBe(false);
    expect(profileMatches({ name: WORKING_PROFILE_NAME, path: '' }, { name: WORKING_PROFILE_NAME, path: working.path! })).toBe(false);
    expect(profileMatches({ name: 'renamed', path: working.path }, { name: WORKING_PROFILE_NAME, path: working.path! })).toBe(true);
    h.fake.currentProfile = { name: WORKING_PROFILE_NAME, path: null };
    const st = await h.app.refreshSurge(WEB);
    expect(st.onWorkingProfile).toBe(false);
    const before = writes(h);
    const fileBefore = resource(h);
    const a = await createEnv(h, 'US-Buyer-01', '203.0.113.10');
    expect(h.repos.operations.get(a.operation_id)!.error?.code).toBe('EXTERNAL_PROFILE');
    expect(writes(h)).toEqual(before);
    expect(resource(h)).toEqual(fileBefore);
    // 提供候选之后的读回读到同名、无路径的当前配置：EXTERNAL_PROFILE，按同一路径回滚
    h.fake.currentProfile = working;
    const orig = h.fake.getCurrentProfile.bind(h.fake);
    h.fake.getCurrentProfile = async () => (served(h)?.state === 'candidate' ? { name: WORKING_PROFILE_NAME, path: null } : orig());
    const b = await createEnv(h, 'US-Buyer-02', '203.0.113.11');
    const op = h.repos.operations.get(b.operation_id)!;
    expect(op.error?.code).toBe('EXTERNAL_PROFILE');
    expect((op.error?.details as { checks: string[] }).checks).toContain('profile');
    expect(h.repos.deployments.latest()!.state).toBe('rolled_back');
    expect(h.repos.environments.get(b.environment_id!)!.deployedProxyRevision).toBeNull();
    expect(served(h)).toMatchObject({ generation: 0, state: 'committed' });
  });

  test('front missing in Surge → FRONT_PROXY_MISSING for that environment only', async () => {
    h = await createHarness();
    h.repos.frontProxies.insert({ id: 'front_gone', surgeName: 'Gone-Front', state: 'ok' });
    const a = await createEnv(h, 'US-Buyer-01', '203.0.113.10', { proxy: { protocol: 'socks5', host: '203.0.113.10', port: 1080, frontProxyId: 'front_gone' } });
    const op = h.repos.operations.get(a.operation_id)!;
    expect(op.phase).toBe('FAILED');
    expect(op.error?.code).toBe('FRONT_PROXY_MISSING');
  });

  test('no resource pointing at the resource service in Surge → parked RESOURCE_MISSING (remerge needed), nothing served or updated', async () => {
    h = await createHarness();
    h.fake.lieOnNext('listExternalResources', []);
    const before = writes(h);
    const a = await createEnv(h, 'US-Buyer-01', '203.0.113.10');
    expect(h.repos.operations.get(a.operation_id)!).toMatchObject({ phase: 'WAITING_DEPLOYMENT', status: 'parked', error: { code: 'RESOURCE_MISSING' } });
    expect(h.repos.operations.get(a.operation_id)!.error?.message).toContain('需要重新合并');
    expect(writes(h)).toEqual(before);
    expect(served(h)).toMatchObject({ generation: 0, state: 'committed' });
  });
});

describe('readback mismatch → rollback through the same path', () => {
  test('Surge drops the selected node from the candidate and the selection falls to REJECT: one rollback update restores the committed nodes and the selection', async () => {
    h = await createHarness();
    const { envId } = await activeEnv(h, 'US-Buyer-01', '203.0.113.10', PROFILE_A);
    const node = h.repos.routeState.get().selectedNode!;
    const prevManifest = h.repos.deployments.latest()!.nodeManifest;
    const committed = pointer(h)!.committed.generation;
    const updatesBefore = updates(h);
    // Surge 下载候选时跳过了选中节点的行：选择回落到首成员 REJECT
    dropNodesOnNextUpdate(h, [node]);
    const b = await createEnv(h, 'US-Buyer-02', '203.0.113.11');
    const op = h.repos.operations.get(b.operation_id)!;
    expect(op.phase).toBe('FAILED');
    expect(op.error?.code).toBe('READBACK_MISMATCH');
    expect((op.error?.details as { checks: string[] }).checks).toEqual(expect.arrayContaining(['members', 'selection']));
    // 发布一次 + 回滚一次
    expect(updates(h) - updatesBefore).toBe(2);
    expect(await h.fake.getGroupSelection('SFE-ROUTE')).toBe(node);
    expect(await nodes(h)).toEqual(prevManifest.map((m) => m.nodeName));
    expect(pointer(h)).toEqual({ committed: { generation: committed }, candidate: null });
    expect(h.repos.deployments.latest()!.state).toBe('rolled_back');
    expect(h.repos.environments.get(b.environment_id!)!.deployedProxyRevision).toBeNull();
    expect(safariOutcome(h).leafPolicyName).toBe(node);
    expect(h.repos.routeState.get().activeEnvironmentId).toBe(envId);
  });
});

describe('retention', () => {
  test('superseded revision of an inactive environment is removed and retired; secrets reclaimed', async () => {
    h = await createHarness();
    const a = await createEnv(h, 'US-Buyer-01', '203.0.113.10', { password: 'synthpass01' });
    const envId = a.environment_id!;
    const oldRef = h.repos.proxyRevisions.get(envId, 1)!.passwordRef!;
    const env = h.repos.environments.get(envId)!;
    await h.app.updateEnvironment(envId, { request_id: rid(), expected_revision: env.revision, changes: { proxy: { host: '203.0.113.20', password: { action: 'replace', value: 'synthpass02' } } } }, WEB);
    await h.idle();
    // 刚被替换的已部署版本留到之后的发布再合批移除，避免发布成功后立即触发第二次更新
    expect(h.repos.deployments.latest()!.nodeManifest.map((m) => m.proxyRevision)).toEqual([1, 2]);
    expect(h.repos.proxyRevisions.get(envId, 1)!.state).toBe('superseded');
    await h.app.publishPending({ request_id: rid() }, WEB);
    await h.idle();
    expect(h.repos.deployments.latest()!.nodeManifest.map((m) => m.proxyRevision)).toEqual([2]);
    expect(h.repos.proxyRevisions.get(envId, 1)!.state).toBe('retired');
    const swept = await h.repos.secretRefs.get(oldRef);
    expect(swept?.state).toBe('orphaned');
    const r = await h.app.engine.secrets.sweep();
    expect(r.deleted).toContain(oldRef);
    expect(h.store.has(oldRef)).toBe(false);
  });

  test('active environment keeps its verified revision while the new one is published', async () => {
    h = await createHarness();
    const { envId } = await activeEnv(h, 'US-Buyer-01', '203.0.113.10', PROFILE_A);
    const env = h.repos.environments.get(envId)!;
    const u = await h.app.updateEnvironment(envId, { request_id: rid(), expected_revision: env.revision, changes: { proxy: { host: '203.0.113.20' } } }, WEB);
    await h.idle();
    expect(h.repos.deployments.latest()!.nodeManifest.map((m) => m.proxyRevision)).toEqual([1, 2]);
    expect(h.repos.operations.get(u.operation_id)!.phase).toBe('WAITING_ROUTE');
    // 活动环境仍使用旧版本，Safari 未被阻断
    expect(h.repos.routeState.get().activeProxyRevision).toBe(1);
    expect(safariOutcome(h).leafPolicyName).toBe('SFE-N-E0001-US01-v001');
  });

  test('deleted environment nodes are removed by a later publish', async () => {
    h = await createHarness();
    const a = await createEnv(h, 'US-Buyer-01', '203.0.113.10', { password: 'synthpass01' });
    await createEnv(h, 'US-Buyer-02', '203.0.113.11');
    const env = h.repos.environments.get(a.environment_id!)!;
    const del = await h.app.deleteEnvironment(env.id, { request_id: rid(), expected_revision: env.revision }, ADMIN);
    await h.idle();
    expect(h.repos.operations.get(del.operation_id)!.phase).toBe('COMPLETED');
    expect(h.repos.proxyRevisions.get(env.id, 1)!.state).toBe('superseded');
    await h.app.publishPending({ request_id: rid() }, WEB);
    await h.idle();
    expect(h.repos.deployments.latest()!.nodeManifest.map((m) => m.nodeName)).toEqual(['SFE-N-E0002-US02-v001']);
    expect(h.repos.proxyRevisions.get(env.id, 1)!.state).toBe('retired');
  });

  /** 下一次发布：Surge 下载候选时跳过选中节点的行、选择回落到首成员 → 读回不一致 → 回滚到已提交版本。 */
  async function publishWithSelectionDrop(name: string, host: string): Promise<string> {
    dropNodesOnNextUpdate(h, [h.repos.routeState.get().selectedNode!]);
    const c = await createEnv(h, name, host);
    return c.operation_id;
  }

  /** 一次读回不完整（getPolicyDetail 瞬时失败一次，没有读回覆盖记录）的发布：结束为 published，不是 verified。 */
  async function partialPublish(): Promise<void> {
    const origDetail = h.fake.getPolicyDetail.bind(h.fake);
    let failOnce = true;
    h.fake.getPolicyDetail = async (n: string) => {
      if (failOnce) {
        failOnce = false;
        throw new Error('transient');
      }
      return origDetail(n);
    };
    await h.app.publishPending({ request_id: rid('pub') }, WEB);
    await h.idle();
    h.fake.getPolicyDetail = origDetail;
    expect(h.repos.deployments.latest()!.state).toBe('published');
  }

  test('a deleted environment\'s node removed by a partial (published) publish is not retired while the latest verified publish still lists it: its secrets survive the sweep and the next mismatching publish rolls back cleanly; a later verified publish retires it', async () => {
    h = await createHarness();
    const pw = ['syn', 'th', 'pw', 'R'].join('');
    const a = await createEnv(h, 'US-Buyer-01', '203.0.113.10', { password: `${pw}7` });
    await activeEnv(h, 'US-Buyer-02', '203.0.113.11', PROFILE_A);
    const gen2 = h.repos.deployments.latest()!;
    expect(gen2.state).toBe('verified');
    const selected = h.repos.routeState.get().selectedNode!;
    const envA = h.repos.environments.get(a.environment_id!)!;
    const a1 = h.repos.proxyRevisions.get(envA.id, 1)!;
    const del = await h.app.deleteEnvironment(envA.id, { request_id: rid(), expected_revision: envA.revision }, ADMIN);
    await h.idle();
    expect(h.repos.operations.get(del.operation_id)!.phase).toBe('COMPLETED');
    await partialPublish();
    // A1 已从资源中移除，但仍是回滚目标（gen 2）的一部分：不退役、摘要不清除、凭据仍被引用
    expect(h.repos.deployments.latest()!.nodeManifest.map((m) => m.nodeName)).not.toContain(a1.nodeName);
    expect(h.repos.proxyRevisions.get(envA.id, 1)!.state).toBe('superseded');
    expect(h.repos.deployments.list(50).find((d) => d.generation === gen2.generation)!.resourceDigest).not.toBe('scrubbed');
    expect(h.repos.secretRefs.get(a1.passwordRef!)?.state).toBe('committed');
    await h.app.engine.secrets.sweep();
    expect(h.store.has(a1.passwordRef!)).toBe(true);
    const opId = await publishWithSelectionDrop('US-Buyer-03', '203.0.113.12');
    const op = h.repos.operations.get(opId)!;
    expect(op).toMatchObject({ phase: 'FAILED', status: 'failed' });
    expect(op.error?.code).toBe('READBACK_MISMATCH');
    expect(h.repos.deployments.latest()!.state).toBe('rolled_back');
    expect(h.repos.routeState.get().phase).toBe('active_verified');
    expect(await h.fake.getGroupSelection('SFE-ROUTE')).toBe(selected);
    expect(safariOutcome(h).leafPolicyName).toBe(selected);
    // 之后一次 verified 的发布：回滚目标不再含 A1 → 退役、凭据回收、含它的发布记录摘要清除
    await h.app.publishPending({ request_id: rid('pub') }, WEB);
    await h.idle();
    expect(h.repos.deployments.latest()!.state).toBe('verified');
    expect(h.repos.proxyRevisions.get(envA.id, 1)!.state).toBe('retired');
    expect(h.repos.secretRefs.get(a1.passwordRef!)?.state).toBe('orphaned');
    expect(h.repos.deployments.list(50).find((d) => d.generation === gen2.generation)!.resourceDigest).toBe('scrubbed');
  });

  test('deleting an environment while SFE-ROUTE members cannot be read retires nothing that might still be loaded (no secret reclaim); the next publish removes and retires it', async () => {
    h = await createHarness();
    const pw = ['syn', 'th', 'pw', 'D'].join('');
    const a = await createEnv(h, 'US-Buyer-01', '203.0.113.10', { password: `${pw}9` });
    const envA = h.repos.environments.get(a.environment_id!)!;
    const a1 = h.repos.proxyRevisions.get(envA.id, 1)!;
    // A 的新版本只保存、没有发布（门槛不足而停泊）：它从未进入任何已提交版本，只有 Surge 的成员能说明它不在其中
    h.revoke(['loopback_publish_crash']);
    await h.app.updateEnvironment(envA.id, { request_id: rid(), expected_revision: envA.revision, changes: { proxy: { password: { action: 'replace', value: `${pw}8` } } } }, WEB);
    await h.idle();
    h.grant(['loopback_publish_crash']);
    const a2 = h.repos.proxyRevisions.get(envA.id, 2)!;
    expect(a2.state).toBe('desired');
    // 删除时读取 SFE-ROUTE 成员失败（只在删除操作执行期间）
    const orig = h.fake.getGroupMembers.bind(h.fake);
    let failures = 0;
    h.fake.getGroupMembers = async (group: string) => {
      if (h.repos.operations.listByStatus(['running'], { kinds: ['environment.delete'] }).length > 0) {
        failures++;
        throw new Error('synthetic read failure');
      }
      return orig(group);
    };
    const cur = h.repos.environments.get(envA.id)!;
    const del = await h.app.deleteEnvironment(envA.id, { request_id: rid(), expected_revision: cur.revision }, ADMIN);
    await h.idle();
    h.fake.getGroupMembers = orig;
    expect(failures).toBeGreaterThan(0);
    expect(h.repos.operations.get(del.operation_id)!.phase).toBe('COMPLETED');
    expect(h.repos.operations.listSteps(del.operation_id).map((st) => st.message).join('\n')).toContain('读取节点资源失败');
    // 已提交版本中的 A1 与无法确认的 A2 都不退役，凭据不回收
    expect(h.repos.proxyRevisions.get(envA.id, 1)!.state).toBe('superseded');
    expect(h.repos.proxyRevisions.get(envA.id, 2)!.state).toBe('superseded');
    expect(h.repos.secretRefs.get(a1.passwordRef!)?.state).toBe('committed');
    expect(h.repos.secretRefs.get(a2.passwordRef!)?.state).toBe('committed');
    await h.app.engine.secrets.sweep();
    expect(h.store.has(a1.passwordRef!)).toBe(true);
    expect(h.store.has(a2.passwordRef!)).toBe(true);
    // 之后的发布按保留规则移除并退役
    await h.app.publishPending({ request_id: rid('pub') }, WEB);
    await h.idle();
    expect(await nodes(h)).toEqual(['SFE-EMPTY']);
    expect(h.repos.proxyRevisions.get(envA.id, 1)!.state).toBe('retired');
    expect(h.repos.proxyRevisions.get(envA.id, 2)!.state).toBe('retired');
    expect(h.repos.secretRefs.get(a1.passwordRef!)?.state).toBe('orphaned');
  });

  test('deleting an environment whose node is in the committed generation keeps it until a later publish (with members read); a never-deployed revision is retired at once', async () => {
    h = await createHarness();
    const a = await createEnv(h, 'US-Buyer-01', '203.0.113.10', { password: 'synthpassC1' });
    const envA = h.repos.environments.get(a.environment_id!)!;
    h.revoke(['loopback_publish_crash']);
    await h.app.updateEnvironment(envA.id, { request_id: rid(), expected_revision: envA.revision, changes: { proxy: { password: { action: 'replace', value: 'synthpassC2' } } } }, WEB);
    await h.idle();
    h.grant(['loopback_publish_crash']);
    const cur = h.repos.environments.get(envA.id)!;
    await h.app.deleteEnvironment(envA.id, { request_id: rid(), expected_revision: cur.revision }, ADMIN);
    await h.idle();
    expect(h.repos.proxyRevisions.get(envA.id, 1)!.state).toBe('superseded');
    expect(h.repos.proxyRevisions.get(envA.id, 2)!.state).toBe('retired');
  });
});
