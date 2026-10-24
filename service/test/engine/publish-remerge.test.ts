// 重新合并恢复节点资源后的发布（§6.2）：恢复的文件与上次发布的节点名称相同，但 Surge 可能已加载被篡改的内容。
// 这次发布必须真正写入、等待 Surge 自动重新读取并逐节点读回，不能走“没有需要发布的修改”的捷径；跟随的发布失败时，
// 读回要求保留到下一次发布，直到读回成功。Surge 6.10 的外部资源更新跳过本地资源：任何一步都不调用 updateExternalResource。
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { NODE_RESOURCE_FILE, SfeError } from '@sfe/contract';
import { WEB, createEnv, createHarness, rid, type Harness } from './harness.js';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

describe('publish after remerge restores the node resource', () => {
  test('a tampered resource already loaded by Surge is refreshed and read back node by node', async () => {
    h = await createHarness();
    const envId = (await createEnv(h, 'US-Buyer-A', '203.0.113.10')).environment_id!;
    const node = h.repos.proxyRevisions.get(envId, 1)!.nodeName;
    const resourcePath = join(h.surgeDir, NODE_RESOURCE_FILE);
    const published = readFileSync(resourcePath, 'utf8');
    writeFileSync(resourcePath, published.replace('203.0.113.10', '198.51.100.77'));
    // Surge 重启后加载了被篡改的文件
    h.fake.restart();
    expect((await h.fake.getPolicyDetail(node)).server).toBe('198.51.100.77');
    const deploymentsBefore = h.repos.deployments.list().length;

    const preview = await h.app.remergePreview(WEB);
    expect(preview.managedFilesDiff).toContain(NODE_RESOURCE_FILE);
    const acc = await h.app.remergeCommit({ request_id: rid(), preview_digest: preview.preview_digest }, WEB);
    await h.idle();
    expect(h.repos.operations.get(acc.operation_id)!.phase).toBe('COMPLETED');

    const follow = h.repos.operations.listRecent(50).find((o) => o.kind === 'deploy.publish' && o.requestId.startsWith('remerge:'))!;
    expect(follow.phase).toBe('COMPLETED');
    expect(h.fake.calls.updateExternalResource ?? 0).toBe(0);
    expect(h.fake.watcherReloads.some((r) => r.key === `policy-path:${NODE_RESOURCE_FILE}`)).toBe(true);
    expect(h.repos.deployments.list().length).toBe(deploymentsBefore + 1);
    expect(h.repos.deployments.latest()!.state).toBe('verified');
    // Surge 已加载的节点参数回到期望值
    expect((await h.fake.getPolicyDetail(node)).server).toBe('203.0.113.10');
    expect(readFileSync(resourcePath, 'utf8')).not.toContain('198.51.100.77');
    expect(h.fake.calls.reloadProfile ?? 0).toBe(0);
  });

  test('the follow-up publish fails (Surge unreachable): the next explicit publish still refreshes and reads back', async () => {
    h = await createHarness();
    const envId = (await createEnv(h, 'US-Buyer-A', '203.0.113.10')).environment_id!;
    const node = h.repos.proxyRevisions.get(envId, 1)!.nodeName;
    const resourcePath = join(h.surgeDir, NODE_RESOURCE_FILE);
    writeFileSync(resourcePath, readFileSync(resourcePath, 'utf8').replace('203.0.113.10', '198.51.100.77'));
    h.fake.restart();
    expect((await h.fake.getPolicyDetail(node)).server).toBe('198.51.100.77');

    // Surge 暂时没有重新读取恢复的文件（监视延迟或漏掉了变化）
    h.fake.watchLocalPolicyPaths = false;
    const preview = await h.app.remergePreview(WEB);
    const acc = await h.app.remergeCommit({ request_id: rid(), preview_digest: preview.preview_digest }, WEB);
    // 跟随的发布读取策略时 Surge 不可达（重新合并本身不读取策略）
    h.fake.failNext('listPolicies', new SfeError('SURGE_UNREACHABLE', '连接 Surge 失败：模拟不可达'));
    await h.idle();
    expect(h.repos.operations.get(acc.operation_id)!.phase).toBe('COMPLETED');
    const follow = h.repos.operations.listRecent(50).find((o) => o.kind === 'deploy.publish' && o.requestId.startsWith('remerge:'))!;
    expect(follow.status).toBe('failed');
    expect(follow.error?.code).toBe('SURGE_UNREACHABLE');
    // 文件已恢复，但 Surge 仍在使用被篡改的节点参数
    expect(readFileSync(resourcePath, 'utf8')).not.toContain('198.51.100.77');
    expect((await h.fake.getPolicyDetail(node)).server).toBe('198.51.100.77');

    // 下一次显式发布（没有待部署的修改）仍然写入并逐节点读回；Surge 重新读取后读到期望值
    h.fake.watchLocalPolicyPaths = true;
    const deploymentsBefore = h.repos.deployments.list().length;
    const pub = await h.app.publishPending({ request_id: rid() }, WEB);
    await h.idle();
    expect(h.repos.operations.get(pub.operation_id)!.phase).toBe('COMPLETED');
    expect(h.repos.deployments.list().length).toBe(deploymentsBefore + 1);
    expect(h.repos.deployments.latest()!.state).toBe('verified');
    expect((await h.fake.getPolicyDetail(node)).server).toBe('203.0.113.10');

    // 读回成功后要求已清除：之后没有修改的发布回到捷径（不再写入）
    const again = await h.app.publishPending({ request_id: rid() }, WEB);
    await h.idle();
    expect(h.repos.operations.get(again.operation_id)!.phase).toBe('COMPLETED');
    expect(h.repos.deployments.list().length).toBe(deploymentsBefore + 1);
    expect(h.fake.calls.updateExternalResource ?? 0).toBe(0);
    expect(h.fake.calls.reloadProfile ?? 0).toBe(0);
  });

  test('restoring the node resource settles its ownership: an unsettled write-before digest (possibly of content with since-retired credentials) is dropped even when the follow-up publish fails', async () => {
    h = await createHarness();
    await createEnv(h, 'US-Buyer-A', '203.0.113.10');
    const resourcePath = join(h.surgeDir, NODE_RESOURCE_FILE);
    writeFileSync(resourcePath, readFileSync(resourcePath, 'utf8').replace('203.0.113.10', '198.51.100.77'));
    // 之前一次未结算的写入留下的写前摘要（例如回滚之后读回无法确认的旧版本留下的）
    const files = h.app.engine.profileFiles()!;
    const prevKey = `mo_prev:resource_file:${NODE_RESOURCE_FILE}`;
    h.app.engine.kv.set(prevKey, { digest: files.digestContent(`# 合成的旧内容 ${['synth', 'Old', 'Body'].join('')}\n`) });
    const preview = await h.app.remergePreview(WEB);
    const acc = await h.app.remergeCommit({ request_id: rid(), preview_digest: preview.preview_digest }, WEB);
    h.fake.failNext('listPolicies', new SfeError('SURGE_UNREACHABLE', '连接 Surge 失败：模拟不可达'));
    await h.idle();
    expect(h.repos.operations.get(acc.operation_id)!.phase).toBe('COMPLETED');
    const follow = h.repos.operations.listRecent(50).find((o) => o.kind === 'deploy.publish' && o.requestId.startsWith('remerge:'))!;
    expect(follow.status).toBe('failed');
    expect(h.app.engine.kv.get(prevKey)).toBeNull();
    expect(h.repos.managedObjects.get('resource_file', NODE_RESOURCE_FILE)).toMatchObject({ state: 'present', contentDigest: await files.digest(NODE_RESOURCE_FILE) });
  });

  test('a forced publish whose readback finds the tampered parameters still loaded rolls back and keeps the requirement', async () => {
    h = await createHarness();
    const envId = (await createEnv(h, 'US-Buyer-A', '203.0.113.10')).environment_id!;
    const node = h.repos.proxyRevisions.get(envId, 1)!.nodeName;
    const resourcePath = join(h.surgeDir, NODE_RESOURCE_FILE);
    writeFileSync(resourcePath, readFileSync(resourcePath, 'utf8').replace('203.0.113.10', '198.51.100.77'));
    h.fake.restart();
    // Surge 一直没有重新读取恢复的文件：组成员名称相同，只有逐节点读回能发现参数不对
    h.fake.watchLocalPolicyPaths = false;
    const preview = await h.app.remergePreview(WEB);
    await h.app.remergeCommit({ request_id: rid(), preview_digest: preview.preview_digest }, WEB);
    await h.idle();
    const follow = h.repos.operations.listRecent(50).find((o) => o.kind === 'deploy.publish' && o.requestId.startsWith('remerge:'))!;
    expect(follow.status).toBe('failed');
    expect(follow.error?.code).toBe('READBACK_MISMATCH');
    expect(JSON.stringify(follow.error?.details)).toContain(`detail:${node}`);
    expect((await h.fake.getPolicyDetail(node)).server).toBe('198.51.100.77');
    expect(h.fake.calls.updateExternalResource ?? 0).toBe(0);
    // 读回要求保留：下一次发布（Surge 已能重新读取）再次写入并读回
    h.fake.watchLocalPolicyPaths = true;
    const deploymentsBefore = h.repos.deployments.list().length;
    const pub = await h.app.publishPending({ request_id: rid() }, WEB);
    await h.idle();
    expect(h.repos.operations.get(pub.operation_id)!.phase).toBe('COMPLETED');
    expect(h.repos.deployments.list().length).toBe(deploymentsBefore + 1);
    expect((await h.fake.getPolicyDetail(node)).server).toBe('203.0.113.10');
  });

  test('CLI-only install (no per-node detail readback): unchanged member names prove nothing, so the forced publish is not verified and the requirement stays until a publish that changes the members', async () => {
    h = await createHarness({
      readbackCovers: true,
      // 只有 CLI：getPolicyDetail 没有映射（只读不到逐节点参数）
      surge: (fake) =>
        new Proxy(fake, {
          get(target, prop) {
            if (prop === 'mechanism') return () => ({ ...target.mechanism(), getPolicyDetail: 'unavailable' });
            if (prop === 'getPolicyDetail') return async () => {
              throw new SfeError('CAPABILITY_UNVERIFIED', '调用 Surge 失败：原语 getPolicyDetail 在当前实现中尚未通过实测', { details: { primitive: 'getPolicyDetail' } });
            };
            const v: unknown = Reflect.get(target, prop, target);
            return typeof v === 'function' ? v.bind(target) : v;
          },
        }) as unknown as typeof fake,
    });
    const envId = (await createEnv(h, 'US-Buyer-A', '203.0.113.10')).environment_id!;
    const node = h.repos.proxyRevisions.get(envId, 1)!.nodeName;
    const resourcePath = join(h.surgeDir, NODE_RESOURCE_FILE);
    writeFileSync(resourcePath, readFileSync(resourcePath, 'utf8').replace('203.0.113.10', '198.51.100.77'));
    h.fake.restart();
    // Surge 一直没有重新读取恢复的文件：名称相同，等待的第一次读取就“一致”
    h.fake.watchLocalPolicyPaths = false;
    const preview = await h.app.remergePreview(WEB);
    await h.app.remergeCommit({ request_id: rid(), preview_digest: preview.preview_digest }, WEB);
    await h.idle();
    const follow = h.repos.operations.listRecent(50).find((o) => o.kind === 'deploy.publish' && o.requestId.startsWith('remerge:'))!;
    const followSteps = h.repos.operations.listSteps(follow.id).map((st) => st.message);
    expect(follow.phase).toBe('COMPLETED');
    expect(followSteps.some((m) => m.includes('Surge 已自动重新读取'))).toBe(false);
    expect(followSteps.some((m) => m.includes('不能据此证明 Surge 重新读取了文件'))).toBe(true);
    expect(followSteps.some((m) => m.includes('无法证明 Surge 已重新读取节点资源'))).toBe(true);
    expect(h.repos.deployments.latest()).toMatchObject({ state: 'published', readbackLevel: 'partial' });
    expect(h.app.engine.kv.get('resource:needsRefresh')).not.toBeNull();
    expect((await h.fake.getPolicyDetail(node)).server).toBe('198.51.100.77');

    // 下一次没有修改的发布仍然强制写入（要求保留），名称仍相同：照样不能证明
    h.fake.watchLocalPolicyPaths = true;
    const deploymentsBefore = h.repos.deployments.list().length;
    const again = await h.app.publishPending({ request_id: rid() }, WEB);
    await h.idle();
    expect(h.repos.operations.get(again.operation_id)!.phase).toBe('COMPLETED');
    expect(h.repos.deployments.list().length).toBe(deploymentsBefore + 1);
    expect(h.app.engine.kv.get('resource:needsRefresh')).not.toBeNull();

    // 一次改变组成员的发布（新环境）：成员从写入前的清单变为期望清单，证明 Surge 重新读取了整个文件 → 要求清除
    await createEnv(h, 'US-Buyer-B', '203.0.113.11');
    expect(h.repos.deployments.latest()!.state).toBe('verified');
    expect(h.app.engine.kv.get('resource:needsRefresh')).toBeNull();
    expect((await h.fake.getPolicyDetail(node)).server).toBe('203.0.113.10');
    expect(h.fake.calls.updateExternalResource ?? 0).toBe(0);
    expect(h.fake.calls.reloadProfile ?? 0).toBe(0);
  });

  test('an ordinary publish with nothing pending still takes the no-write shortcut', async () => {
    h = await createHarness();
    await createEnv(h, 'US-Buyer-A', '203.0.113.10');
    const reloadsBefore = h.fake.watcherReloads.length;
    const deploymentsBefore = h.repos.deployments.list().length;
    const pub = await h.app.publishPending({ request_id: rid() }, WEB);
    await h.idle();
    expect(h.repos.operations.get(pub.operation_id)!.phase).toBe('COMPLETED');
    expect(h.fake.watcherReloads.length).toBe(reloadsBefore);
    expect(h.repos.deployments.list().length).toBe(deploymentsBefore);
    expect(h.fake.calls.updateExternalResource ?? 0).toBe(0);
  });
});
