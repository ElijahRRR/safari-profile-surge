// 秘密金丝雀（docs/ARCHITECTURE.md §11）：标记秘密经所有入口进入后，扫描日志、SQLite 文件字节、
// 事件流、接口响应与数据目录，均不得出现。Surge 配置目录中的节点资源文件按设计包含代理凭据，不在扫描范围内。

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { NODE_RESOURCE_FILE, type ImportPreviewRequest, type NativeRequest } from '@sfe/contract';
import { AGENT, PROFILE_A, PROFILE_C, WEB, activeEnv, createEnv, createHarness, envInput, rid, type Harness } from '../engine/harness.js';

const MARK = 'CanaryZq9x7Marker';
const secret = (tag: string) => `${MARK}${tag}`;

let h: Harness;
afterEach(async () => {
  await h?.close();
});

function walk(dir: string, skip: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (p === skip) continue;
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p, skip));
    else if (st.isFile()) out.push(p);
  }
  return out;
}

function serialize(v: unknown): string {
  if (v instanceof Error) return JSON.stringify({ name: v.name, message: v.message, ...(v as unknown as Record<string, unknown>) });
  return JSON.stringify(v);
}

test('marker secrets never reach logs, SQLite bytes, events, responses or data files', async () => {
  h = await createHarness({ dbFile: true });

  // 1. 网页创建：代理用户名、代理密码、账号密码
  const { envId } = await activeEnv(h, 'US-Canary-A', '203.0.113.10', PROFILE_A, {
    username: secret('User1'),
    password: secret('Pass1'),
    accountPassword: secret('Acct1'),
    login: 'buyer01@example.test',
  });

  // 2. 更新：新代理密码与账号密码（活动环境 → 发布后进入等待路由）
  let env = h.repos.environments.get(envId)!;
  await h.record(
    h.app.updateEnvironment(
      envId,
      { request_id: rid(), expected_revision: env.revision, changes: { proxy: { password: { action: 'replace', value: secret('Pass2') } }, account: { label: null, loginIdentifier: 'buyer01@example.test', password: { action: 'replace', value: secret('Acct2') } } } },
      WEB,
    ),
  );
  await h.idle();

  // 3. 候选校验失败：Surge 的错误输出原样带出秘密（模拟 --check 打印出错行）
  env = h.repos.environments.get(envId)!;
  const failing = (await createEnv(h, 'US-Canary-Check', '203.0.113.11', { password: secret('Pass3') })).environment_id!;
  h.fake.lieOnNext('checkProfile', { ok: false, message: `line 3: invalid proxy password=${secret('Pass4')} username=${secret('User1')}` });
  const fenv = h.repos.environments.get(failing)!;
  await h.record(h.app.updateEnvironment(failing, { request_id: rid(), expected_revision: fenv.revision, changes: { proxy: { password: { action: 'replace', value: secret('Pass4') } } } }, WEB));
  await h.idle();
  const failedOps = h.repos.operations.listRecent(50).filter((o) => o.error?.code === 'SURGE_CHECK_FAILED');
  expect(failedOps.length).toBeGreaterThan(0);

  // 4. CSV 导入（预览 + 提交）
  const header = 'environment_id,display_name,proxy_type,proxy_host,proxy_port,proxy_username,proxy_password,front_proxy,site,account_label,login_identifier,login_password,expected_exit_ip,auto_open_orders,auto_fill_login';
  const csvReq: ImportPreviewRequest = {
    format: 'csv',
    content_base64: Buffer.from(`${header}\n,US-Canary-Csv,socks5,203.0.113.20,1080,${secret('User5')},${secret('Pass5')},,US,,buyer05@example.test,${secret('Acct5')},,,\n`, 'utf8').toString('base64'),
  };
  const csvPreview = await h.record(h.app.importPreview(csvReq, WEB));
  await h.record(h.app.importCommit({ ...csvReq, request_id: rid(), preview_digest: csvPreview.preview_digest, decisions: [{ row: 2, action: 'create' }] }, WEB));
  await h.idle();

  // 5. JSON 导入（代理通道）
  const jsonReq: ImportPreviewRequest = {
    format: 'json',
    records: [{ display_name: 'US-Canary-Json', proxy_host: '203.0.113.21', proxy_port: 1080, proxy_username: secret('User6'), proxy_password: secret('Pass6'), login_password: secret('Acct6'), site: 'US' }],
  };
  const jsonPreview = await h.record(h.app.importPreview(jsonReq, AGENT));
  await h.record(h.app.importCommit({ ...jsonReq, request_id: rid(), preview_digest: jsonPreview.preview_digest, decisions: [{ row: 1, action: 'create' }] }, AGENT));
  await h.idle();

  // 6. 原生：未绑定场景创建并关联
  await h.native(PROFILE_C, { type: 'createAndBindEnvironment', request_id: rid(), environment: envInput('US-Canary-Native', '203.0.113.22', { username: secret('User7'), password: secret('Pass7'), accountPassword: secret('Acct7') }) } as NativeRequest);
  await h.idle();

  // 7. 校验失败的请求（参数错误）也不得回显秘密
  await h.record(h.app.createEnvironment({ request_id: rid(), environment: { ...envInput('', '203.0.113.23', { password: secret('Pass8') }) } }, WEB)).catch(() => undefined);

  // 8. 读取所有视图
  await h.record(h.app.snapshot(WEB));
  await h.record(h.app.listEnvironments(WEB));
  for (const e of h.repos.environments.list()) {
    await h.record(h.app.getEnvironment(e.id, WEB));
    await h.record(h.app.accountDetail(e.id, WEB)).catch(() => undefined);
  }
  const ops = await h.record(h.app.listOperations(200, WEB));
  for (const o of ops) await h.record(h.app.getOperation(o.id, WEB));
  await h.record(h.app.refreshSurge(WEB));

  // 对照：秘密确实经所有入口进入了钥匙串与 Surge 节点资源（测试本身有效）
  expect(h.store.size).toBeGreaterThanOrEqual(10);
  expect(h.repos.environments.list().map((e) => e.displayName).sort()).toEqual(['US-Canary-A', 'US-Canary-Check', 'US-Canary-Csv', 'US-Canary-Json', 'US-Canary-Native']);
  expect(readFileSync(join(h.surgeDir, NODE_RESOURCE_FILE), 'utf8')).toContain(secret('Pass7'));

  // ---- 扫描 ----
  const leaks: string[] = [];
  for (const line of h.logs) if (line.includes(MARK)) leaks.push(`log: ${line.slice(0, 80)}`);
  for (const e of h.events) if (JSON.stringify(e).includes(MARK)) leaks.push(`event: ${e.type}`);
  for (const r of h.responses) if (serialize(r).includes(MARK)) leaks.push(`response: ${serialize(r).slice(0, 80)}`);
  const marker = Buffer.from(MARK, 'utf8');
  for (const file of walk(h.dir, h.surgeDir)) {
    if (readFileSync(file).includes(marker)) leaks.push(`file: ${file.slice(h.dir.length)}`);
  }
  expect(leaks).toEqual([]);
  // SQLite 文件存在且被扫描到
  expect(walk(h.dir, h.surgeDir).some((f) => f.endsWith('sfe.sqlite'))).toBe(true);
});
