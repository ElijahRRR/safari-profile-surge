// 重新合并恢复节点资源后的发布（§6.2）：恢复的文件与上次发布的节点名称相同，但 Surge 可能已加载被篡改的内容。
// 这次发布必须真正写入、定向刷新并逐节点读回，不能走“没有需要发布的修改”的捷径；跟随的发布失败时，
// 刷新要求保留到下一次发布，直到刷新并读回成功。
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
    const refreshesBefore = h.fake.calls.updateExternalResource ?? 0;
    const deploymentsBefore = h.repos.deployments.list().length;

    const preview = await h.app.remergePreview(WEB);
    expect(preview.managedFilesDiff).toContain(NODE_RESOURCE_FILE);
    const acc = await h.app.remergeCommit({ request_id: rid(), preview_digest: preview.preview_digest }, WEB);
    await h.idle();
    expect(h.repos.operations.get(acc.operation_id)!.phase).toBe('COMPLETED');

    const follow = h.repos.operations.listRecent(50).find((o) => o.kind === 'deploy.publish' && o.requestId.startsWith('remerge:'))!;
    expect(follow.phase).toBe('COMPLETED');
    expect(h.fake.calls.updateExternalResource ?? 0).toBeGreaterThan(refreshesBefore);
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

    // 下一次显式发布（没有待部署的修改）仍然写入、定向刷新并逐节点读回
    const refreshesBefore = h.fake.calls.updateExternalResource ?? 0;
    const deploymentsBefore = h.repos.deployments.list().length;
    const pub = await h.app.publishPending({ request_id: rid() }, WEB);
    await h.idle();
    expect(h.repos.operations.get(pub.operation_id)!.phase).toBe('COMPLETED');
    expect(h.fake.calls.updateExternalResource ?? 0).toBeGreaterThan(refreshesBefore);
    expect(h.repos.deployments.list().length).toBe(deploymentsBefore + 1);
    expect(h.repos.deployments.latest()!.state).toBe('verified');
    expect((await h.fake.getPolicyDetail(node)).server).toBe('203.0.113.10');

    // 刷新并读回成功后要求已清除：之后没有修改的发布回到捷径
    const refreshesAfter = h.fake.calls.updateExternalResource ?? 0;
    const again = await h.app.publishPending({ request_id: rid() }, WEB);
    await h.idle();
    expect(h.repos.operations.get(again.operation_id)!.phase).toBe('COMPLETED');
    expect(h.fake.calls.updateExternalResource ?? 0).toBe(refreshesAfter);
    expect(h.repos.deployments.list().length).toBe(deploymentsBefore + 1);
    expect(h.fake.calls.reloadProfile ?? 0).toBe(0);
  });

  test('an ordinary publish with nothing pending still takes the no-write shortcut', async () => {
    h = await createHarness();
    await createEnv(h, 'US-Buyer-A', '203.0.113.10');
    const refreshesBefore = h.fake.calls.updateExternalResource ?? 0;
    const deploymentsBefore = h.repos.deployments.list().length;
    const pub = await h.app.publishPending({ request_id: rid() }, WEB);
    await h.idle();
    expect(h.repos.operations.get(pub.operation_id)!.phase).toBe('COMPLETED');
    expect(h.fake.calls.updateExternalResource ?? 0).toBe(refreshesBefore);
    expect(h.repos.deployments.list().length).toBe(deploymentsBefore);
  });
});
