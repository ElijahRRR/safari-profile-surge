// 并发的同一请求（客户端重试）：幂等核对在主事务内进行，后到的请求返回原操作（duplicate: true），
// 不报版本冲突、不撞 request_id 唯一约束，也不留下钥匙串项（§6.1）。
// 提交前有异步步骤（文件读取、钥匙串写入），哪个调用先提交并不确定：断言与顺序无关。
import { afterEach, describe, expect, test } from 'vitest';
import type { Accepted } from '@sfe/contract';
import { WEB, createEnv, createHarness, envInput, rid, type Harness } from './harness.js';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

const FAR_FUTURE = '2999-01-01T00:00:00.000Z';

function outcomes<T>(results: PromiseSettledResult<T>[]): Array<T | string> {
  return results.map((r) => (r.status === 'fulfilled' ? r.value : `rejected: ${(r.reason as { code?: string }).code ?? String(r.reason)}`));
}

/** 两个并发调用：恰好一个是原操作（duplicate: false），另一个是同一操作的重复（duplicate: true）。返回原操作。 */
function originalAndDuplicate(results: PromiseSettledResult<Accepted>[]): Accepted {
  const values = outcomes(results);
  expect(values.filter((v) => typeof v === 'string')).toEqual([]);
  const [original, duplicate] = (values as Accepted[]).slice().sort((a, b) => Number(a.duplicate) - Number(b.duplicate));
  expect(original).toMatchObject({ duplicate: false });
  expect(duplicate).toEqual({ ...original, duplicate: true });
  return original!;
}

describe('concurrent retries with the same request_id', () => {
  test('two identical updateEnvironment calls in flight → the original operation and a duplicate (either order)', async () => {
    h = await createHarness();
    const envId = (await createEnv(h, 'US-Buyer-01', '203.0.113.10', { password: 'synthpass01' })).environment_id!;
    const env = h.repos.environments.get(envId)!;
    const req = { request_id: rid('upd'), expected_revision: env.revision, changes: { proxy: { password: { action: 'replace' as const, value: 'synthpass02' } } } };
    originalAndDuplicate(await Promise.allSettled([h.app.updateEnvironment(envId, req, WEB), h.app.updateEnvironment(envId, req, WEB)]));
    await h.idle();
    expect(h.repos.environments.get(envId)!.revision).toBe(env.revision + 1);
    expect(h.repos.proxyRevisions.maxRevision(envId)).toBe(2);
    // 后到请求写入的钥匙串项被丢弃：不留下未引用的秘密
    expect(h.repos.secretRefs.listStalePending(FAR_FUTURE)).toEqual([]);
  });

  test('two identical createEnvironment calls in flight → one environment, the other is a duplicate', async () => {
    h = await createHarness();
    const req = { request_id: rid('create'), environment: envInput('US-Buyer-01', '203.0.113.10', { username: 'synthuser1', password: 'synthpass01' }) };
    originalAndDuplicate(await Promise.allSettled([h.app.createEnvironment(req, WEB), h.app.createEnvironment(req, WEB)]));
    await h.idle();
    expect(h.repos.environments.list()).toHaveLength(1);
    expect(h.repos.secretRefs.listStalePending(FAR_FUTURE)).toEqual([]);
  });

  test('two identical remergeCommit calls in flight → one remerge operation, the other is a duplicate', async () => {
    h = await createHarness();
    const preview = await h.app.remergePreview(WEB);
    const req = { request_id: rid('remerge'), preview_digest: preview.preview_digest };
    originalAndDuplicate(await Promise.allSettled([h.app.remergeCommit(req, WEB), h.app.remergeCommit(req, WEB)]));
    await h.idle();
    expect(h.repos.operations.listRecent(50).filter((o) => o.kind === 'maintenance.remerge')).toHaveLength(1);
  });

  test('two identical replaceFrontCommit calls in flight → one replacement, the other is a duplicate', async () => {
    h = await createHarness();
    const a = (await createEnv(h, 'US-Buyer-A', '203.0.113.10')).environment_id!;
    const front = await h.app.registerFrontProxy({ request_id: rid(), surgeName: 'Front-B' }, WEB);
    const preview = await h.app.replaceFrontPreview(h.frontId, { to_front_id: front.id, environment_ids: [a] }, WEB);
    const revs = Object.fromEntries(preview.items.map((i) => [i.environment_id, i.revision]));
    const req = { request_id: rid('replace'), to_front_id: front.id, environment_ids: [a], preview_digest: preview.preview_digest, expected_revisions: revs };
    originalAndDuplicate(await Promise.allSettled([h.app.replaceFrontCommit(h.frontId, req, WEB), h.app.replaceFrontCommit(h.frontId, req, WEB)]));
    await h.idle();
    expect(h.repos.proxyRevisions.maxRevision(a)).toBe(2);
  });

  test('a concurrent request reusing the request_id with different content is still rejected', async () => {
    h = await createHarness();
    const id = rid('create');
    const a = { request_id: id, environment: envInput('US-Buyer-01', '203.0.113.10') };
    const b = { request_id: id, environment: envInput('US-Buyer-02', '203.0.113.11') };
    const results = outcomes(await Promise.allSettled([h.app.createEnvironment(a, WEB), h.app.createEnvironment(b, WEB)]));
    // 先提交的一个成功，另一个因内容不同被拒绝（哪个先提交不确定）
    const accepted = results.filter((r): r is Accepted => typeof r !== 'string');
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toMatchObject({ duplicate: false });
    expect(results.filter((r) => typeof r === 'string')).toEqual(['rejected: DUPLICATE_REQUEST_MISMATCH']);
    await h.idle();
    expect(h.repos.environments.list()).toHaveLength(1);
    expect(h.repos.environments.get(accepted[0]!.environment_id!)).not.toBeNull();
  });
});
