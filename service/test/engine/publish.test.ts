import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { CAPABILITY_GATES, NODE_RESOURCE_FILE, WORKING_PROFILE_NAME, type CapabilityKey } from '@sfe/contract';
import { profileMatches } from '../../src/engine/context.js';
import { anyContext, ADMIN, PROFILE_A, WEB, activeEnv, bind, createEnv, createHarness, entryWrites, envInput, rid, safariOutcome, type Harness } from './harness.js';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

const WRITE_PRIMITIVES = ['updateExternalResource', 'selectGroupPolicy', 'addTempRule', 'removeTempRule', 'killRequest', 'reloadProfile'];
// 写原语的调用次数之外还看入口规则集文件（ruleset_resource 的入口写入是文件写入加文件监视，不经适配器写原语）
const writes = (hh: Harness) => ({ ...Object.fromEntries(WRITE_PRIMITIVES.map((k) => [k, hh.fake.calls[k] ?? 0])), ...entryWrites(hh.fake) });
const resource = (hh: Harness) => readFileSync(join(hh.surgeDir, NODE_RESOURCE_FILE), 'utf8');

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
    expect(resource(h)).toBe(fileBefore);
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
    h.revoke(['policy_path_reread']);
    const a = await createEnv(h, 'US-Buyer-01', '203.0.113.10');
    h.grant(['policy_path_reread']);
    const p = await h.app.publishPending({ request_id: rid('pub') }, WEB);
    await h.idle();
    expect(h.repos.operations.get(p.operation_id)!.phase).toBe('READY_FOR_NEXT_OPEN');
    expect(h.repos.environments.get(a.environment_id!)!.deployedProxyRevision).toBe(1);
  });

  test('auto-reload setting differing from the verified condition parks the publish', async () => {
    h = await createHarness();
    // 实测时自动重载为关；当前读到开
    const cap = h.repos.capabilities.get('auto_reload_atomic_replace')!;
    h.repos.capabilities.upsert({ ...cap, context: { ...cap.context!, autoReload: 'off' } });
    h.fake.reportedAutoReload = true;
    const before = writes(h);
    const a = await createEnv(h, 'US-Buyer-01', '203.0.113.10');
    const op = h.repos.operations.get(a.operation_id)!;
    expect(op.phase).toBe('WAITING_DEPLOYMENT');
    expect(op.error?.code).toBe('CAPABILITY_UNVERIFIED');
    expect(writes(h)).toEqual(before);
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
    // 预检不返回出口 IP
    const p = h.repos.probes.latest(a.environment_id!, 'preflight')!;
    expect(p.outcome).toBe('ok');
    expect(p.exitIp).toBeNull();
    // 资源文件头只含代数，不含摘要
    expect(resource(h).split('\n')[0]).toBe('# SFE managed resource · generation 1');
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

  test('managed-segment edit stops with BASELINE_CHANGED and nothing is written', async () => {
    h = await createHarness();
    const text = readFileSync(h.profilePath, 'utf8').replace('SFE-ROUTE = select, REJECT, policy-path=sfe-nodes.list', 'SFE-ROUTE = select, DIRECT, policy-path=sfe-nodes.list');
    writeFileSync(h.profilePath, text);
    const before = writes(h);
    const a = await createEnv(h, 'US-Buyer-01', '203.0.113.10');
    const op = h.repos.operations.get(a.operation_id)!;
    expect(op.phase).toBe('FAILED');
    expect(op.error?.code).toBe('BASELINE_CHANGED');
    expect(JSON.stringify(op.error)).not.toContain('DIRECT');
    expect(writes(h)).toEqual(before);
  });

  test('externally edited resource file → BASELINE_CHANGED', async () => {
    h = await createHarness();
    writeFileSync(join(h.surgeDir, NODE_RESOURCE_FILE), '# edited by hand\n');
    const a = await createEnv(h, 'US-Buyer-01', '203.0.113.10');
    expect(h.repos.operations.get(a.operation_id)!.error?.code).toBe('BASELINE_CHANGED');
    expect(resource(h)).toBe('# edited by hand\n');
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
    const a = await createEnv(h, 'US-Buyer-01', '203.0.113.10', { password: pw });
    const op = h.repos.operations.get(a.operation_id)!;
    expect(op.error?.code).toBe('SURGE_CHECK_FAILED');
    expect(JSON.stringify(op)).not.toContain('synthpass99');
    expect(resource(h)).toBe(fileBefore);
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
    expect(resource(h)).toBe(fileBefore);
    // 写入之后的读回读到同名、无路径的当前配置：EXTERNAL_PROFILE，按同一路径回滚
    h.fake.currentProfile = working;
    const orig = h.fake.getCurrentProfile.bind(h.fake);
    h.fake.getCurrentProfile = async () => (resource(h) === fileBefore ? orig() : { name: WORKING_PROFILE_NAME, path: null });
    const b = await createEnv(h, 'US-Buyer-02', '203.0.113.11');
    const op = h.repos.operations.get(b.operation_id)!;
    expect(op.error?.code).toBe('EXTERNAL_PROFILE');
    expect((op.error?.details as { checks: string[] }).checks).toContain('profile');
    expect(h.repos.deployments.latest()!.state).toBe('rolled_back');
    expect(h.repos.environments.get(b.environment_id!)!.deployedProxyRevision).toBeNull();
  });

  test('front missing in Surge → FRONT_PROXY_MISSING for that environment only', async () => {
    h = await createHarness();
    h.repos.frontProxies.insert({ id: 'front_gone', surgeName: 'Gone-Front', state: 'ok' });
    const a = await createEnv(h, 'US-Buyer-01', '203.0.113.10', { proxy: { protocol: 'socks5', host: '203.0.113.10', port: 1080, frontProxyId: 'front_gone' } });
    const op = h.repos.operations.get(a.operation_id)!;
    expect(op.phase).toBe('FAILED');
    expect(op.error?.code).toBe('FRONT_PROXY_MISSING');
  });

  test('no resource pointing at the node file → RESOURCE_MISSING', async () => {
    h = await createHarness();
    h.fake.lieOnNext('listExternalResources', []);
    const a = await createEnv(h, 'US-Buyer-01', '203.0.113.10');
    expect(h.repos.operations.get(a.operation_id)!.error?.code).toBe('RESOURCE_MISSING');
  });
});

describe('readback mismatch → rollback through the same path', () => {
  test('selection lost when Surge re-reads the resource is restored; previous resource restored', async () => {
    h = await createHarness();
    const { envId } = await activeEnv(h, 'US-Buyer-01', '203.0.113.10', PROFILE_A);
    const node = h.repos.routeState.get().selectedNode!;
    const prevManifest = h.repos.deployments.latest()!.nodeManifest;
    const orig = h.fake.getGroupMembers.bind(h.fake);
    let first = true;
    h.fake.getGroupMembers = async (group: string) => {
      const r = await orig(group);
      if (first) {
        first = false;
        // 模拟 Surge 重新读取节点资源后组选择回落到首成员
        await h.fake.selectGroupPolicy('SFE-ROUTE', 'REJECT');
      }
      return r;
    };
    const b = await createEnv(h, 'US-Buyer-02', '203.0.113.11');
    const op = h.repos.operations.get(b.operation_id)!;
    expect(op.phase).toBe('FAILED');
    expect(op.error?.code).toBe('READBACK_MISMATCH');
    expect(await h.fake.getGroupSelection('SFE-ROUTE')).toBe(node);
    expect((await h.fake.getGroupMembers('SFE-ROUTE')).slice(1)).toEqual(prevManifest.map((m) => m.nodeName));
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
});
