// 本地节点资源的发布语义（Surge Mac 6.10，§6.2）：外部资源更新跳过本地资源（HTTP API 文档：“Local resources are
// skipped.”），发布从不调用 updateExternalResource，也从不把它当作刷新；原子写入后在有限时间内等待 Surge 自动重新读取
// （文件监视），再读回组成员。本地 policy-path 是否被监视没有写入文档：没有 policy_path_reread 记录时新版本保持待部署，
// 已部署的节点不受影响。只用合成数据。
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { NODE_RESOURCE_FILE, ROUTE_GROUP_NAME, SfeError } from '@sfe/contract';
import { CHAIN_EVIDENCE_PREFLIGHT } from '../../src/engine/handlers/probes.js';
import { resourceBodyDigest } from '../../src/engine/handlers/publish.js';
import type { SurgeExternalResource } from '../../src/ports.js';
import type { FakeSurge } from '../../src/surge/fake.js';
import { WEB, createEnv, createHarness, envInput, rid, type Harness } from './harness.js';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

const resource = (hh: Harness) => readFileSync(join(hh.surgeDir, NODE_RESOURCE_FILE), 'utf8');
const steps = (hh: Harness, opId: string) => hh.repos.operations.listSteps(opId).map((s) => s.message);
const NODE_KEY = `policy-path:${NODE_RESOURCE_FILE}`;

/**
 * 推进可控时钟直到操作离开 queued/running：发布在等待 Surge 重新读取时按 FakeClock 轮询。只在写入之后（DEPLOYING、
 * ROLLING_BACK）推进时钟，写入前的校验（文件读写）按真实时间完成，不让时钟在它们中途跳动。
 */
async function driveUntilSettled(hh: Harness, opId: string, stepMs = 250, maxRounds = 2_000): Promise<void> {
  for (let i = 0; i < maxRounds; i++) {
    const op = hh.repos.operations.get(opId)!;
    if (op.status !== 'queued' && op.status !== 'running') break;
    await new Promise((r) => setTimeout(r, 2));
    if (op.phase === 'DEPLOYING' || op.phase === 'ROLLING_BACK') await hh.clock.advanceAsync(stepMs);
  }
  await hh.idle();
}

describe('publishing the local node resource never counts an external-resource update as a refresh', () => {
  test('Surge re-reads the written file through its watcher; updateExternalResource is never called', async () => {
    h = await createHarness();
    const a = await createEnv(h, 'US-Buyer-01', '203.0.113.10');
    const op = h.repos.operations.get(a.operation_id)!;
    expect(op.phase).toBe('READY_FOR_NEXT_OPEN');
    expect(h.fake.calls.updateExternalResource ?? 0).toBe(0);
    expect(h.fake.calls.reloadProfile ?? 0).toBe(0);
    expect(h.fake.reloadCount).toBe(0);
    expect(h.fake.watcherReloads.map((r) => r.key)).toContain(NODE_KEY);
    expect(steps(h, a.operation_id).some((m) => m.includes('Surge 已自动重新读取节点资源') && m.includes('未调用外部资源更新'))).toBe(true);
    expect(await h.fake.getGroupMembers(ROUTE_GROUP_NAME)).toEqual(['REJECT', 'SFE-N-E0001-US01-v001']);
    // 预检的链路说明：rule explain 只作为未经实测的文档能力提及，链路以网络实测为准
    const probe = h.repos.probes.latest(a.environment_id!, 'preflight')!;
    expect(probe.chainEvidence).toBe(CHAIN_EVIDENCE_PREFLIGHT);
    expect(probe.chainEvidence).toContain('rule explain');
    expect(probe.chainEvidence).toContain('未经实测');
    expect(probe.chainEvidence).toContain('external_node_underlying_proxy 实测为准');
    expect(probe.chainEvidence).not.toContain('6.5');
  });

  test('without the policy_path_reread record a new revision stays WAITING_DEPLOYMENT with an accurate message; the deployed node is untouched', async () => {
    h = await createHarness();
    const a = await createEnv(h, 'US-Buyer-01', '203.0.113.10');
    const envId = a.environment_id!;
    expect(h.repos.environments.get(envId)!.deployedProxyRevision).toBe(1);
    h.revoke(['policy_path_reread']);
    const fileBefore = resource(h);
    const membersBefore = await h.fake.getGroupMembers(ROUTE_GROUP_NAME);
    const deploymentsBefore = h.repos.deployments.list().length;
    const env = h.repos.environments.get(envId)!;
    const u = await h.app.updateEnvironment(envId, { request_id: rid(), expected_revision: env.revision, changes: { proxy: { port: 1081 } } }, WEB);
    await h.idle();
    const op = h.repos.operations.get(u.operation_id)!;
    expect(op.phase).toBe('WAITING_DEPLOYMENT');
    expect(op.status).toBe('parked');
    expect(op.error?.code).toBe('CAPABILITY_UNVERIFIED');
    expect(op.error?.message).toContain('新版本保持待部署，已部署的节点不受影响');
    expect(op.error?.message).toContain('Local resources are skipped.');
    expect(op.error?.message).toContain('本地 policy-path 重新读取');
    expect(JSON.stringify(op.error?.details)).toContain('policy_path_reread');
    // 什么都没有写：文件、Surge 已加载的成员、已部署版本与发布记录不变
    expect(resource(h)).toBe(fileBefore);
    expect(await h.fake.getGroupMembers(ROUTE_GROUP_NAME)).toEqual(membersBefore);
    expect(h.repos.environments.get(envId)!.deployedProxyRevision).toBe(1);
    expect(h.repos.environments.get(envId)!.desiredProxyRevision).toBe(2);
    expect(h.repos.deployments.list().length).toBe(deploymentsBefore);
    expect(h.fake.calls.updateExternalResource ?? 0).toBe(0);
  });

  test('the record says supported but Surge never re-reads the file → bounded wait, READBACK_MISMATCH, rolled back', async () => {
    h = await createHarness({ watchLocalPolicyPaths: false, resourceReloadWait: { timeoutMs: 2_000, pollMs: 500 } });
    const fileBefore = resource(h);
    const started = h.clock.now().getTime();
    const a = await h.app.createEnvironment({ request_id: rid(), environment: envInput('US-Buyer-01', '203.0.113.10') }, WEB);
    await driveUntilSettled(h, a.operation_id);
    const op = h.repos.operations.get(a.operation_id)!;
    expect(op.phase).toBe('FAILED');
    expect(op.error?.code).toBe('READBACK_MISMATCH');
    expect(op.error?.message).toContain('等待时限内没有读到 Surge 重新读取节点资源后的组成员');
    expect((op.error?.details as { checks: string[] }).checks).toContain('members_not_reloaded');
    expect(steps(h, a.operation_id).some((m) => m.includes('等待 2.0 秒后仍未读到'))).toBe(true);
    // 等待有上限，且确实等到了时限
    expect(h.clock.now().getTime() - started).toBeGreaterThanOrEqual(2_000);
    expect(h.clock.now().getTime() - started).toBeLessThan(60_000);
    // 回滚到写入前的内容，Surge 侧的成员从未改变
    expect(h.repos.deployments.latest()!.state).toBe('rolled_back');
    expect(resource(h)).toBe(fileBefore);
    expect(await h.fake.getGroupMembers(ROUTE_GROUP_NAME)).toEqual(['REJECT']);
    expect(h.repos.environments.get(a.environment_id!)!.deployedProxyRevision).toBeNull();
    expect(h.fake.calls.updateExternalResource ?? 0).toBe(0);
    expect(h.fake.calls.reloadProfile ?? 0).toBe(0);
  });

  test('a watcher latency within the bound: the publish polls and deploys', async () => {
    h = await createHarness({ resourceReloadWait: { timeoutMs: 5_000, pollMs: 500 } });
    h.fake.localWatchLatencyMs = 1_200;
    const a = await h.app.createEnvironment({ request_id: rid(), environment: envInput('US-Buyer-01', '203.0.113.10') }, WEB);
    await driveUntilSettled(h, a.operation_id);
    const op = h.repos.operations.get(a.operation_id)!;
    expect(op.phase).toBe('READY_FOR_NEXT_OPEN');
    const waitStep = steps(h, a.operation_id).find((m) => m.startsWith('Surge 已自动重新读取节点资源'))!;
    expect(waitStep).toMatch(/等待 1\.5 秒，读取 4 次/);
    expect(h.fake.calls.updateExternalResource ?? 0).toBe(0);
  });

  test.each([
    ['still updating', (r: SurgeExternalResource) => ({ ...r, updating: true }), 'resource_updating'],
    ['remote', (r: SurgeExternalResource) => ({ ...r, local: false }), 'resource_not_local'],
    ['referenced by a module', (r: SurgeExternalResource) => ({ ...r, fromModule: 'Synthetic Module' }), 'resource_not_local'],
  ])('after the write Surge reports the resource as %s → READBACK_MISMATCH, rolled back, not deployed', async (_name, mutate, check) => {
    h = await createHarness();
    const fileBefore = resource(h);
    const orig = h.fake.listExternalResources.bind(h.fake);
    // 写入之前的资源检查照常；写入之后（读回）Surge 报告的资源状态不可接受
    h.fake.listExternalResources = async () => {
      const list = await orig();
      return resource(h) === fileBefore ? list : list.map((r) => (r.key === NODE_KEY ? mutate(r) : r));
    };
    const a = await createEnv(h, 'US-Buyer-01', '203.0.113.10');
    const op = h.repos.operations.get(a.operation_id)!;
    expect(op.phase).toBe('FAILED');
    expect(op.error?.code).toBe('READBACK_MISMATCH');
    expect((op.error?.details as { checks: string[] }).checks).toContain(check);
    expect(h.repos.deployments.latest()!.state).toBe('rolled_back');
    expect(resource(h)).toBe(fileBefore);
    expect(h.repos.environments.get(a.environment_id!)!.deployedProxyRevision).toBeNull();
    expect(h.fake.calls.updateExternalResource ?? 0).toBe(0);
  });

  test.each([
    ['a resource referenced by a module', (r: SurgeExternalResource) => ({ ...r, fromModule: 'Synthetic Module' }), 'NAME_COLLISION'],
    ['a resource Surge reports as remote', (r: SurgeExternalResource) => ({ ...r, local: false }), 'RESOURCE_MISSING'],
  ])('%s is not ours → nothing written', async (_name, mutate, code) => {
    h = await createHarness();
    const fileBefore = resource(h);
    const list = await h.fake.listExternalResources();
    h.fake.lieOnNext('listExternalResources', list.map((r) => (r.key === NODE_KEY ? mutate(r) : r)));
    const a = await createEnv(h, 'US-Buyer-01', '203.0.113.10');
    const op = h.repos.operations.get(a.operation_id)!;
    expect(op.phase).toBe('FAILED');
    expect(op.error?.code).toBe(code);
    expect(resource(h)).toBe(fileBefore);
    expect(h.repos.deployments.list()).toEqual([]);
  });

  test('an engine restart while Surge re-reads the resource is reported in the steps (uptime fell)', async () => {
    h = await createHarness();
    h.clock.advance(10_000);
    const orig = h.fake.getGroupMembers.bind(h.fake);
    const resourcePath = join(h.surgeDir, NODE_RESOURCE_FILE);
    const before = readFileSync(resourcePath, 'utf8');
    let first = true;
    // 写入之后第一次读组成员（等待 Surge 重新读取）时引擎重启；写入之前的对照读取照常
    h.fake.getGroupMembers = async (group: string) => {
      if (first && readFileSync(resourcePath, 'utf8') !== before) {
        first = false;
        h.fake.restart();
      }
      return orig(group);
    };
    const a = await createEnv(h, 'US-Buyer-01', '203.0.113.10');
    expect(steps(h, a.operation_id).some((m) => m.includes('Surge 引擎在发布期间重启'))).toBe(true);
  });

  test('without an engine restart the readback says so', async () => {
    h = await createHarness();
    const a = await createEnv(h, 'US-Buyer-01', '203.0.113.10');
    expect(steps(h, a.operation_id)).toContain('读回：未观察到 Surge 引擎重启');
  });
});

// 只映射了 CLI（getPolicyDetail 不可用）的安装：读回永远是 partial，“Surge 已重新读取”的证据只有组成员从写入前的清单
// 变为期望清单。一次写入前读取失败、或在等待中服务重启，都不能让新版本永远停在 partial（之后 Surge 已加载新节点，
// 每次写入前读到的成员都已是期望清单）。
describe('re-read proof on a CLI-only install survives a failed pre-write read and a service restart during the wait', () => {
  const cliOnly = (fake: FakeSurge): FakeSurge =>
    new Proxy(fake, {
      get(target, prop) {
        if (prop === 'mechanism') return () => ({ ...target.mechanism(), getPolicyDetail: 'unavailable' });
        if (prop === 'getPolicyDetail') return async () => {
          throw new SfeError('CAPABILITY_UNVERIFIED', '调用 Surge 失败：原语 getPolicyDetail 在当前实现中尚未通过实测', { details: { primitive: 'getPolicyDetail' } });
        };
        const v: unknown = Reflect.get(target, prop, target);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });

  async function until(cond: () => boolean): Promise<void> {
    const end = Date.now() + 5000;
    while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 2));
    expect(cond()).toBe(true);
  }

  test('one failed members read before the write is retried: the first publish is proven and deployed', async () => {
    h = await createHarness({ readbackCovers: true, surge: cliOnly });
    const before = resource(h);
    const orig = h.fake.getGroupMembers.bind(h.fake);
    let failures = 0;
    h.fake.getGroupMembers = async (group: string) => {
      if (failures === 0 && resource(h) === before) {
        failures++;
        throw new SfeError('SURGE_UNREACHABLE', '连接 Surge 失败：命令超时');
      }
      return orig(group);
    };
    const a = await createEnv(h, 'US-Buyer-01', '203.0.113.10');
    expect(failures).toBe(1);
    const op = h.repos.operations.get(a.operation_id)!;
    expect(op.phase).toBe('READY_FOR_NEXT_OPEN');
    expect(op.result).toMatchObject({ readbackLevel: 'partial' });
    expect(h.repos.environments.get(a.environment_id!)!.deployedProxyRevision).toBe(1);
    expect(h.repos.deployments.latest()!.state).toBe('verified');
    expect(steps(h, a.operation_id).some((m) => m.startsWith('Surge 已自动重新读取节点资源'))).toBe(true);
  });

  test('members unreadable before the write: nothing is written (no unprovable write), the revision stays pending and the next publish deploys it', async () => {
    h = await createHarness({ readbackCovers: true, surge: cliOnly });
    const before = resource(h);
    const orig = h.fake.getGroupMembers.bind(h.fake);
    let down = true;
    h.fake.getGroupMembers = async (group: string) => {
      if (down) throw new SfeError('SURGE_UNREACHABLE', '连接 Surge 失败：命令超时');
      return orig(group);
    };
    const deploymentsBefore = h.repos.deployments.list().length;
    const a = await createEnv(h, 'US-Buyer-01', '203.0.113.10');
    const op = h.repos.operations.get(a.operation_id)!;
    expect(op.phase).toBe('FAILED');
    expect(op.error?.code).toBe('SURGE_UNREACHABLE');
    expect(resource(h)).toBe(before);
    expect(h.repos.deployments.list().length).toBe(deploymentsBefore);
    expect(h.repos.environments.get(a.environment_id!)!.deployedProxyRevision).toBeNull();
    down = false;
    const pub = await h.app.publishPending({ request_id: rid('pub') }, WEB);
    await h.idle();
    expect(h.repos.operations.get(pub.operation_id)!.phase).toBe('READY_FOR_NEXT_OPEN');
    expect(h.repos.environments.get(a.environment_id!)!.deployedProxyRevision).toBe(1);
    expect(h.fake.calls.updateExternalResource ?? 0).toBe(0);
  });

  test('service restart while waiting for Surge to re-read: the next publish of the same nodes uses the members read before the first write and deploys', async () => {
    h = await createHarness({ readbackCovers: true, surge: cliOnly, dbFile: true });
    const before = resource(h);
    const orig = h.fake.getGroupMembers.bind(h.fake);
    let entered = false;
    // 写入之后第一次读组成员（等待 Surge 重新读取）时服务停止：挂起这次调用
    h.fake.getGroupMembers = (group: string) => {
      if (resource(h) === before) return orig(group);
      entered = true;
      return new Promise<string[]>(() => undefined);
    };
    const a = await h.app.createEnvironment({ request_id: rid(), environment: envInput('US-Buyer-01', '203.0.113.10') }, WEB);
    await until(() => entered);
    h.fake.getGroupMembers = orig;
    await h.crash();
    await h.idle();
    const crashed = h.repos.operations.get(a.operation_id)!;
    expect(crashed.status).toBe('failed');
    expect(crashed.error?.code).toBe('UNKNOWN_STATE');
    // Surge 已经加载了新节点：之后任何一次写入前读到的成员都已是期望清单
    expect(await h.fake.getGroupMembers(ROUTE_GROUP_NAME)).toEqual(['REJECT', 'SFE-N-E0001-US01-v001']);
    expect(h.repos.environments.get(a.environment_id!)!.deployedProxyRevision).toBeNull();

    const pub = await h.app.publishPending({ request_id: rid('pub') }, WEB);
    await h.idle();
    const op = h.repos.operations.get(pub.operation_id)!;
    expect(op.phase).toBe('READY_FOR_NEXT_OPEN');
    expect(h.repos.environments.get(a.environment_id!)!.deployedProxyRevision).toBe(1);
    expect(h.repos.deployments.latest()!.state).toBe('verified');
    const messages = steps(h, pub.operation_id);
    expect(messages.some((m) => m.includes('沿用第一次写入这组节点之前读到的成员'))).toBe(true);
    expect(messages.some((m) => m.startsWith('Surge 已自动重新读取节点资源'))).toBe(true);
    // 证据已用：之后再发布没有修改时走捷径
    expect(h.app.engine.kv.get('resource:writeBaseline')).toBeNull();
    expect(h.fake.calls.updateExternalResource ?? 0).toBe(0);
    expect(h.fake.calls.reloadProfile ?? 0).toBe(0);
  });

  test('a proven re-read whose readback is not yet covered keeps the write baseline: once coverage is recorded the next publish deploys the revision', async () => {
    h = await createHarness({ readbackCovers: false, surge: cliOnly });
    const a = await createEnv(h, 'US-Buyer-01', '203.0.113.10');
    const envId = a.environment_id!;
    // 组成员从 [REJECT] 变为期望清单（重新读取已证明），但没有读回覆盖记录：部署读回不完整，版本未部署
    expect(h.repos.operations.get(a.operation_id)!.result).toMatchObject({ targets: [expect.objectContaining({ outcome: 'partial' })] });
    expect(steps(h, a.operation_id).some((m) => m.includes('无法证明 Surge 已重新读取节点资源'))).toBe(false);
    expect(h.repos.deployments.latest()!.state).toBe('published');
    expect(h.repos.environments.get(envId)!.deployedProxyRevision).toBeNull();
    // 写入对照保留到部署被接受：之后写入前读到的成员都已是期望清单
    expect(h.app.engine.kv.get('resource:writeBaseline')).toMatchObject({ membersBefore: ['REJECT'] });
    h.grant(['policy_path_reread', 'targeted_resource_refresh', 'external_node_underlying_proxy'], 'readback-covers: server, port, underlying-proxy');
    const pub = await h.app.publishPending({ request_id: rid('pub') }, WEB);
    await h.idle();
    expect(h.repos.operations.get(pub.operation_id)!.phase).toBe('READY_FOR_NEXT_OPEN');
    expect(steps(h, pub.operation_id).some((m) => m.includes('沿用第一次写入这组节点之前读到的成员'))).toBe(true);
    expect(steps(h, pub.operation_id).some((m) => m.includes('无法证明 Surge 已重新读取节点资源'))).toBe(false);
    expect(h.repos.environments.get(envId)!.deployedProxyRevision).toBe(1);
    expect(h.repos.deployments.latest()!.state).toBe('verified');
    // 部署已被接受：对照用完
    expect(h.app.engine.kv.get('resource:writeBaseline')).toBeNull();
    expect(h.fake.calls.updateExternalResource ?? 0).toBe(0);
  });

  test('remerge drops the write baseline: a restored file with the same node names as tampered content Surge loaded proves nothing', async () => {
    h = await createHarness({ readbackCovers: true, surge: cliOnly });
    const envId = (await createEnv(h, 'US-Buyer-A', '203.0.113.10')).environment_id!;
    const node = h.repos.proxyRevisions.get(envId, 1)!.nodeName;
    const resourcePath = join(h.surgeDir, NODE_RESOURCE_FILE);
    const published = readFileSync(resourcePath, 'utf8');
    writeFileSync(resourcePath, published.replace('203.0.113.10', '198.51.100.77'));
    // Surge 重启后加载了被篡改的文件（名称相同），之后一直没有重新读取恢复的文件
    h.fake.restart();
    h.fake.watchLocalPolicyPaths = false;
    // 一份过期的写入对照：同一组节点行，写入前的成员不含该节点（若被沿用，名称相同的篡改内容会被当作“已重新读取”）
    h.app.engine.kv.set('resource:writeBaseline', { bodyDigest: resourceBodyDigest(h.files.digestContent, published), membersBefore: ['REJECT'] });
    const preview = await h.app.remergePreview(WEB);
    await h.app.remergeCommit({ request_id: rid(), preview_digest: preview.preview_digest }, WEB);
    await h.idle();
    const follow = h.repos.operations.listRecent(50).find((o) => o.kind === 'deploy.publish' && o.requestId.startsWith('remerge:'))!;
    expect(follow.phase).toBe('COMPLETED');
    expect(steps(h, follow.id).some((m) => m.includes('沿用第一次写入'))).toBe(false);
    expect(steps(h, follow.id).some((m) => m.includes('无法证明 Surge 已重新读取节点资源'))).toBe(true);
    expect(h.repos.deployments.latest()).toMatchObject({ state: 'published', readbackLevel: 'partial' });
    expect(h.app.engine.kv.get('resource:needsRefresh')).not.toBeNull();
    // 新的对照是这次写入前读到的成员（已含该节点）
    expect(h.app.engine.kv.get('resource:writeBaseline')).toMatchObject({ membersBefore: ['REJECT', node] });
    expect(h.fake.calls.updateExternalResource ?? 0).toBe(0);
  });
});
