import { afterEach, describe, expect, test } from 'vitest';
import { SfeError, type ImportPreviewRequest } from '@sfe/contract';
import { WEB, AGENT, createEnv, createHarness, rid, type Harness } from './harness.js';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

const HEADER = 'environment_id,display_name,proxy_type,proxy_host,proxy_port,proxy_username,proxy_password,front_proxy,site,account_label,login_identifier,login_password,expected_exit_ip,auto_open_orders,auto_fill_login';

function csv(rows: string[]): ImportPreviewRequest {
  return { format: 'csv', content_base64: Buffer.from([HEADER, ...rows].join('\n') + '\n', 'utf8').toString('base64') };
}

async function expectError(p: Promise<unknown>, code: string): Promise<SfeError> {
  try {
    await p;
  } catch (err) {
    expect((err as SfeError).code).toBe(code);
    return err as SfeError;
  }
  throw new Error(`expected ${code}`);
}

describe('import preview', () => {
  test('classifies create / update / unchanged / conflict / invalid with redacted diffs', async () => {
    h = await createHarness();
    const existing = await createEnv(h, 'US-Existing', '203.0.113.10', { password: 'synthpass01', login: 'buyer01@example.test' });
    const id = existing.environment_id!;
    const second = (await createEnv(h, 'US-Second', '203.0.113.12', { password: 'synthpass02' })).environment_id!;
    await createEnv(h, 'US-Dup', '203.0.113.11');
    const req = csv([
      ',US-New,socks5,203.0.113.20,1080,,,Front-A,US,,buyer20@example.test,,,,',
      `${id},US-Existing,socks5,203.0.113.10,1080,,synthpass01,,US,,buyer01@example.test,,,,`,
      `${second},US-Second,socks5,203.0.113.13,1080,,synthpass09,,US,,,,,,`,
      ',US-Dup,socks5,203.0.113.21,1080,,,,US,,,,,,',
      ',US-Bad,socks5,203.0.113.22,99999,,,,US,,,,,,',
      'env_missing,US-Ghost,socks5,203.0.113.23,1080,,,,US,,,,,,',
    ]);
    const p = await h.app.importPreview(req, WEB);
    expect(p.rows.map((r) => r.status)).toEqual(['create', 'unchanged', 'update', 'conflict', 'invalid', 'invalid']);
    expect(p.totals).toEqual({ create: 1, update: 1, unchanged: 1, conflict: 1, invalid: 2 });
    const upd = p.rows[2]!;
    expect(upd.current_revision).toBe(h.repos.environments.get(second)!.revision);
    expect(upd.diff).toEqual(
      expect.arrayContaining([
        { field: 'proxy.host', before: '203.0.113.12', after: '203.0.113.13' },
        { field: 'proxy.password', before: '已设置', after: '已修改' },
      ]),
    );
    expect(JSON.stringify(p)).not.toContain('synthpass09');
    expect(JSON.stringify(p)).not.toContain('buyer20@example.test');
    expect(p.rows[3]!.conflictCandidates).toHaveLength(1);
    expect(p.preview_digest).toMatch(/^[0-9a-f]{64}$/);
  });

  test('unregistered front proxy is invalid (never registered implicitly)', async () => {
    h = await createHarness();
    const p = await h.app.importPreview(csv([',US-New,socks5,203.0.113.20,1080,,,Unknown-Front,US,,,,,,']), WEB);
    expect(p.rows[0]!.status).toBe('invalid');
    expect(p.rows[0]!.errors[0]!.field).toBe('rows[2].front_proxy');
    expect(h.repos.frontProxies.byName('Unknown-Front')).toBeNull();
  });
});

describe('import commit', () => {
  test('one batch op + per-row ops + a single coalesced publish; per-row conflicts do not stop others', async () => {
    h = await createHarness();
    const existing = await createEnv(h, 'US-Existing', '203.0.113.10');
    const id = existing.environment_id!;
    const req = csv([
      ',US-New-1,socks5,203.0.113.20,1080,synthuser1,synthpass1,,US,,,,,,',
      ',US-New-2,socks5,203.0.113.21,1080,,,,US,,,,,,',
      `${id},US-Existing,socks5,203.0.113.30,1080,,,,US,,,,,,`,
    ]);
    const preview = await h.app.importPreview(req, WEB);
    const deploymentsBefore = h.repos.deployments.list().length;
    // 第 3 行（更新）在预览之后被另一界面修改 → 只有这一行冲突
    const env = h.repos.environments.get(id)!;
    await h.app.updateEnvironment(id, { request_id: rid(), expected_revision: env.revision, changes: { displayName: 'US-Existing' } }, WEB);
    const result = await h.app.importCommit(
      {
        ...req,
        request_id: rid('imp'),
        preview_digest: preview.preview_digest,
        decisions: [
          { row: 2, action: 'create' },
          { row: 3, action: 'create' },
          { row: 4, action: 'update', environment_id: id, expected_revision: preview.rows[2]!.current_revision! },
        ],
      },
      WEB,
    );
    expect(result.items.map((i) => i.status)).toEqual(['create', 'create', 'revision_conflict']);
    expect(result.items[2]!.diff).toBeDefined();
    await h.idle();
    expect(h.repos.deployments.list().length).toBe(deploymentsBefore + 1);
    const batch = h.repos.operations.get(result.operation_id)!;
    expect(batch.kind).toBe('import.batch');
    expect(batch.phase).toBe('READY_FOR_NEXT_OPEN');
    for (const item of result.items.slice(0, 2)) {
      const child = h.repos.operations.get(item.operation_id!)!;
      expect(child.kind).toBe('environment.create');
      expect(child.phase).toBe('READY_FOR_NEXT_OPEN');
      expect(h.repos.environments.get(item.environment_id!)!.deployedProxyRevision).toBe(1);
    }
    // 冲突行：没有新版本，秘密未留下
    expect(h.repos.environments.get(id)!.desiredProxyRevision).toBe(1);
  });

  test('identical re-import is a no-op: no operations, no revisions, no publish', async () => {
    h = await createHarness();
    const req = csv([',US-New-1,socks5,203.0.113.20,1080,synthuser1,synthpass1,,US,,buyer01@example.test,acct-pw-1,,,']);
    const p1 = await h.app.importPreview(req, WEB);
    const r1 = await h.app.importCommit({ ...req, request_id: rid(), preview_digest: p1.preview_digest, decisions: [{ row: 2, action: 'create' }] }, WEB);
    await h.idle();
    const envId = r1.items[0]!.environment_id!;
    const exported = `${envId},US-New-1,socks5,203.0.113.20,1080,synthuser1,synthpass1,,US,,buyer01@example.test,acct-pw-1,,,`;
    const req2 = csv([exported]);
    const p2 = await h.app.importPreview(req2, WEB);
    expect(p2.rows[0]!.status).toBe('unchanged');
    const opsBefore = h.repos.operations.listRecent(500).length;
    const deploymentsBefore = h.repos.deployments.list().length;
    const putsBefore = h.store.calls.filter((c) => c.op === 'put').length;
    const r2 = await h.app.importCommit({ ...req2, request_id: rid(), preview_digest: p2.preview_digest, decisions: [] }, WEB);
    await h.idle();
    expect(r2.items[0]!.status).toBe('skipped');
    expect(h.repos.operations.listRecent(500).length).toBe(opsBefore + 1);
    expect(h.repos.deployments.list().length).toBe(deploymentsBefore);
    expect(h.repos.proxyRevisions.maxRevision(envId)).toBe(1);
    expect(h.store.calls.filter((c) => c.op === 'put').length).toBe(putsBefore);
  });

  test('stale preview digest → PREVIEW_STALE', async () => {
    h = await createHarness();
    const req = csv([',US-New-1,socks5,203.0.113.20,1080,,,,US,,,,,,']);
    const p = await h.app.importPreview(req, WEB);
    const changed = csv([',US-New-1,socks5,203.0.113.99,1080,,,,US,,,,,,']);
    await expectError(h.app.importCommit({ ...changed, request_id: rid(), preview_digest: p.preview_digest, decisions: [{ row: 2, action: 'create' }] }, WEB), 'PREVIEW_STALE');
    expect(h.repos.environments.list()).toHaveLength(0);
  });

  test('conflict rows must be decided explicitly and never merge by name', async () => {
    h = await createHarness();
    const existing = await createEnv(h, 'US-Dup', '203.0.113.10');
    const req = csv([',US-Dup,socks5,203.0.113.21,1080,,,,US,,,,,,']);
    const p = await h.app.importPreview(req, WEB);
    expect(p.rows[0]!.status).toBe('conflict');
    // 无决定 → 跳过
    const skipped = await h.app.importCommit({ ...req, request_id: rid(), preview_digest: p.preview_digest, decisions: [] }, WEB);
    expect(skipped.items[0]!.status).toBe('skipped');
    // 明确选择更新已有环境
    const env = h.repos.environments.get(existing.environment_id!)!;
    const upd = await h.app.importCommit(
      { ...req, request_id: rid(), preview_digest: p.preview_digest, decisions: [{ row: 2, action: 'update', environment_id: env.id, expected_revision: env.revision }] },
      WEB,
    );
    expect(upd.items[0]!.status).toBe('update');
    await h.idle();
    expect(h.repos.proxyRevisions.get(env.id, 2)!.host).toBe('203.0.113.21');
  });

  test('blank secret cells keep existing secrets (import never clears)', async () => {
    h = await createHarness();
    const existing = await createEnv(h, 'US-Keep', '203.0.113.10', { password: 'synthpass01', accountPassword: 'acct-pw-1' });
    const id = existing.environment_id!;
    const req = csv([`${id},US-Keep,socks5,203.0.113.10,1081,,,,US,,,,,,`]);
    const p = await h.app.importPreview(req, WEB);
    expect(p.rows[0]!.status).toBe('update');
    await h.app.importCommit({ ...req, request_id: rid(), preview_digest: p.preview_digest, decisions: [{ row: 2, action: 'update', environment_id: id, expected_revision: p.rows[0]!.current_revision! }] }, WEB);
    await h.idle();
    const r2 = h.repos.proxyRevisions.get(id, 2)!;
    expect(r2.port).toBe(1081);
    expect(r2.passwordRef).toBe(h.repos.proxyRevisions.get(id, 1)!.passwordRef);
    expect(h.repos.accounts.get(id)!.passwordRef).not.toBeNull();
  });

  test('JSON records import and duplicate commit request returns the same result', async () => {
    h = await createHarness();
    const req: ImportPreviewRequest = {
      format: 'json',
      records: [{ display_name: 'US-Json-1', proxy_host: '203.0.113.40', proxy_port: 1080, proxy_password: 'synthpass40', site: 'US' }],
    };
    const p = await h.app.importPreview(req, AGENT);
    expect(p.rows[0]!.status).toBe('create');
    const commit = { ...req, request_id: rid(), preview_digest: p.preview_digest, decisions: [{ row: 1, action: 'create' as const }] };
    const r1 = await h.app.importCommit(commit, AGENT);
    const r2 = await h.app.importCommit(commit, AGENT);
    expect(r2).toEqual(r1);
    await h.idle();
    expect(h.repos.environments.list()).toHaveLength(1);
  });

  test('invalid decisions are rejected synchronously without creating anything', async () => {
    h = await createHarness();
    const req = csv([',US-New-1,socks5,203.0.113.20,1080,,,,US,,,,,,']);
    const p = await h.app.importPreview(req, WEB);
    await expectError(
      h.app.importCommit({ ...req, request_id: rid(), preview_digest: p.preview_digest, decisions: [{ row: 2, action: 'update', environment_id: 'env_x', expected_revision: 1 }] }, WEB),
      'VALIDATION_FAILED',
    );
    expect(h.repos.environments.list()).toHaveLength(0);
    expect(h.repos.operations.listRecent(100).filter((o) => o.kind === 'import.batch')).toHaveLength(0);
  });
});
