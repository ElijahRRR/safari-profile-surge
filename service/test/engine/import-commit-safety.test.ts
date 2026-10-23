// 导入提交与单项修改保持同样的保证：活动环境的预期出口立即与最近一次 Safari 实测比较（§6.3.16）；
// 并发的同一提交请求返回原结果（§6.1）；超长的秘密单元格不会让脱敏器失效。
import { afterEach, describe, expect, test } from 'vitest';
import type { ImportPreviewRequest } from '@sfe/contract';
import { PROFILE_A, WEB, activeEnv, createEnv, createHarness, rid, type Harness } from './harness.js';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

const HEADER = 'environment_id,display_name,proxy_type,proxy_host,proxy_port,proxy_username,proxy_password,front_proxy,site,account_label,login_identifier,login_password,expected_exit_ip,auto_open_orders,auto_fill_login';

function csv(rows: string[]): ImportPreviewRequest {
  return { format: 'csv', content_base64: Buffer.from([HEADER, ...rows].join('\n') + '\n', 'utf8').toString('base64') };
}

async function importUpdate(envId: string, row: string): Promise<void> {
  const req = csv([row]);
  const preview = await h.app.importPreview(req, WEB);
  expect(preview.rows[0]!.status).toBe('update');
  const result = await h.app.importCommit(
    { ...req, request_id: rid('imp'), preview_digest: preview.preview_digest, decisions: [{ row: 2, action: 'update', environment_id: envId, expected_revision: preview.rows[0]!.current_revision! }] },
    WEB,
  );
  expect(result.items[0]!.status).toBe('update');
  await h.idle();
}

describe('import: expected exit IP of the active environment', () => {
  test('a changed expected exit is compared with the last ok Safari probe, exactly like a single edit', async () => {
    h = await createHarness();
    // 实测出口 192.0.2.50
    const { envId } = await activeEnv(h, 'US-Buyer-01', '203.0.113.10', PROFILE_A);
    const selects = h.fake.calls.selectGroupPolicy ?? 0;
    const eventsBefore = h.events.length;
    await importUpdate(envId, `${envId},US-Buyer-01,socks5,203.0.113.10,1080,,,,US,,,,198.51.100.99,,`);
    expect(h.repos.environments.get(envId)!.expectedExitIp).toBe('198.51.100.99');
    expect(h.repos.environments.get(envId)!.desiredProxyRevision).toBe(1);
    expect(h.repos.routeState.get().warnings).toContain('exit_ip_mismatch');
    expect((await h.app.ensureInControl()).ok).toBe(false);
    // 路由状态变化推送给订阅者（与单项修改相同）
    const routeEvent = h.events.slice(eventsBefore).find((e) => e.type === 'route.updated');
    expect(routeEvent && routeEvent.type === 'route.updated' && routeEvent.route.warnings).toContain('exit_ip_mismatch');
    // 改回与实测一致 → 清除；不切换、不写 Surge
    await importUpdate(envId, `${envId},US-Buyer-01,socks5,203.0.113.10,1080,,,,US,,,,192.0.2.50,,`);
    expect(h.repos.routeState.get().warnings).not.toContain('exit_ip_mismatch');
    expect(h.repos.routeState.get().activeEnvironmentId).toBe(envId);
    expect(h.fake.calls.selectGroupPolicy ?? 0).toBe(selects);
  });
});

describe('import: concurrent retries of the same commit', () => {
  test('two identical commits in flight → the same result, one batch, no stray secret items', async () => {
    h = await createHarness();
    const req = csv([',US-New-1,socks5,203.0.113.20,1080,synthuser1,synthpass1,,US,,,acct-pw-1,,,']);
    const preview = await h.app.importPreview(req, WEB);
    const commit = { ...req, request_id: rid('imp'), preview_digest: preview.preview_digest, decisions: [{ row: 2, action: 'create' as const }] };
    const settled = await Promise.allSettled([h.app.importCommit(commit, WEB), h.app.importCommit(commit, WEB)]);
    expect(settled.map((s) => s.status)).toEqual(['fulfilled', 'fulfilled']);
    const [first, second] = settled.map((s) => (s as PromiseFulfilledResult<Awaited<ReturnType<typeof h.app.importCommit>>>).value);
    expect(second).toEqual(first);
    await h.idle();
    expect(h.repos.environments.list()).toHaveLength(1);
    expect(h.repos.operations.listRecent(100).filter((o) => o.kind === 'import.batch')).toHaveLength(1);
    expect(h.repos.secretRefs.listStalePending('2999-01-01T00:00:00.000Z')).toEqual([]);
  });
});

describe('import: oversized secret cells', () => {
  test('a preview with a huge password cell is rejected per row and later operations keep working', async () => {
    h = await createHarness();
    const { envId } = await activeEnv(h, 'US-Buyer-01', '203.0.113.10', PROFILE_A);
    const huge = 'Q'.repeat(70_000);
    const preview = await h.app.importPreview(csv([`,US-Huge,socks5,203.0.113.30,1080,,${huge},,US,,,${huge},,,`]), WEB);
    expect(preview.rows[0]!.status).toBe('invalid');
    expect(JSON.stringify(preview)).not.toContain(huge);
    // 脱敏器仍可用：新建、修改与回到普通模式都正常受理
    const b = await createEnv(h, 'US-Buyer-02', '203.0.113.11', { password: 'synthpass02' });
    expect(h.repos.operations.get(b.operation_id)!.phase).toBe('READY_FOR_NEXT_OPEN');
    const normal = await h.app.enterNormal({ request_id: rid(), old_session_policy: 'closed_confirmed', confirmed_environment_id: envId }, WEB);
    await h.idle();
    expect(h.repos.operations.get(normal.operation_id)!.status).not.toBe('failed');
    expect(h.repos.routeState.get().entryMode).toBe('NORMAL');
  });
});
