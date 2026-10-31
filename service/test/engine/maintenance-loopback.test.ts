// 维护的本机资源服务改造（D10，loopback-spec §7）：初始化写入指向本服务当前地址的节点组定义（从不创建 sfe-nodes.list）、
// 重新合并把旧的本地节点文件定义改用本机资源服务（只在 resourceServe 门槛满足之后）并在读回确认之后删除旧文件、选项
// “更换本机资源地址”（新令牌与端口、旧令牌 404、只有它能清除令牌可疑）、预览只读且结果确定。只用合成数据。

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { LEGACY_NODE_GROUP_LINE, NODE_RESOURCE_FILE, RESOURCE_PORT_MAX, RESOURCE_PORT_MIN, SfeError, WORKING_PROFILE_NAME, parseNodeResourceUrl } from '@sfe/contract';
import type { OperationRecord } from '../../src/db/index.js';
import { LEGACY_LINE_KEPT_TEXT } from '../../src/engine/maintenance.js';
import { loopbackPortOfLocation, loopbackPortsIn, nodeResourceStatus } from '../../src/engine/node-resource.js';
import {
  RESOURCE_KV_KEYS,
  readNeedsRefresh,
  readServedPointer,
  readTokenSuspect,
  writeNeedsRefresh,
  writeServedPointer,
  writeTokenSuspect,
} from '../../src/resource/index.js';
import { loopbackResourceRequest } from '../../src/surge/fake.js';
import { loopbackGroupBlockLines } from '../../src/surge/generate.js';
import { WEB, createEnv, createHarness, rid, type Harness } from './harness.js';
import { fetchResource, legacyDeployNodes, ourResource } from './resource-fixtures.js';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

async function expectError(p: Promise<unknown>, code: string): Promise<SfeError> {
  try {
    await p;
  } catch (err) {
    expect((err as SfeError).code).toBe(code);
    return err as SfeError;
  }
  throw new Error(`expected ${code}`);
}

// 合成源配置：用户节点（占位凭据）、用户策略组与 FINAL
const SOURCE = [
  '[General]',
  'loglevel = notify',
  '',
  '[Proxy]',
  'Front-A = socks5, 192.0.2.10, 1080, username=example-user, password=example-pass',
  '',
  '[Proxy Group]',
  'Daily = select, Front-A, DIRECT',
  '',
  '[Rule]',
  'FINAL,DIRECT',
  '',
].join('\n');

const workingPath = () => join(h.surgeDir, `${WORKING_PROFILE_NAME}.conf`);
const steps = (opId: string) => h.repos.operations.listSteps(opId).map((s) => s.message);
const remergePublishes = (): OperationRecord[] => h.repos.operations.listRecent(100).filter((o) => o.kind === 'deploy.publish' && o.requestId.startsWith('remerge:'));

/** 本服务地址的一次下载，令牌换成 token（端口与路径的其余部分不变）。 */
function fetchWithToken(port: number, token: string) {
  const url = h.resourceUrl()!;
  const target = loopbackResourceRequest(url)!;
  const current = parseNodeResourceUrl(url)!.token;
  return h.binder.request(port, { ...target.request, rawPath: target.request.rawPath.replace(current, token) });
}

describe('pure helpers', () => {
  test('loopbackPortOfLocation reads the port of a (redacted) loopback http(s) location only; loopbackPortsIn finds every loopback port in a profile text', () => {
    expect(loopbackPortOfLocation('http://127.0.0.1:23456/***')).toBe(23456);
    expect(loopbackPortOfLocation('http://***@localhost:8080/rules.list')).toBe(8080);
    expect(loopbackPortOfLocation('http://[::1]:9000/x')).toBe(9000);
    expect(loopbackPortOfLocation('http://127.0.0.2/x')).toBe(80);
    expect(loopbackPortOfLocation('https://rules.example.test:8443/a.list')).toBeNull();
    expect(loopbackPortOfLocation('/Users/example/Surge/sfe-nodes.list')).toBeNull();
    expect(loopbackPortOfLocation('ftp://127.0.0.1:21/x')).toBeNull();
    const text = ['[General]', 'http-api = key@127.0.0.1:6171', 'external-controller-access = pw@0.0.0.0:6170', '# 注释 localhost:30001', '[Rule]', 'RULE-SET,http://[::1]:30002/x.list,DIRECT', 'DOMAIN,a127.0.0.1:30003,DIRECT'].join('\n');
    expect([...loopbackPortsIn(text)].sort((a, b) => a - b)).toEqual([6171, 30001, 30002]);
  });
});

describe('init writes the loopback group line', () => {
  test('the working profile points SFE-ROUTE at the current address; committed generation 0 (placeholder) is served; no sfe-nodes.list; --check never contacts the resource server; previews are deterministic', async () => {
    h = await createHarness({ sourceProfile: SOURCE });
    const engine = h.app.engine;
    const url = engine.resourceUrl()!;
    expect(url).not.toBeNull();
    expect(engine.resource!.listening()).toBe(true);
    // --check 看到的是相对的候选节点列表（只含占位行），从不是本机资源服务地址
    const checked: Array<{ profile: string; nodes: string | null }> = [];
    const check = h.fake.checkProfile.bind(h.fake);
    h.fake.checkProfile = async (path: string) => {
      const dir = path.slice(0, path.lastIndexOf('/'));
      checked.push({ profile: readFileSync(path, 'utf8'), nodes: existsSync(join(dir, NODE_RESOURCE_FILE)) ? readFileSync(join(dir, NODE_RESOURCE_FILE), 'utf8') : null });
      return check(path);
    };
    const preview = await h.app.initPreview({}, WEB);
    expect(preview.checks.find((c) => c.name === 'resource_server')).toMatchObject({ ok: true });
    expect(preview.checks.find((c) => c.name === 'check')).toMatchObject({ ok: true });
    expect(checked).toHaveLength(1);
    expect(checked[0]!.profile).toContain('SFE-ROUTE = select, REJECT, policy-path=sfe-nodes.list');
    expect(checked[0]!.profile).not.toContain(engine.resource!.token);
    expect(checked[0]!.nodes).toContain('SFE-EMPTY = reject');
    // 地址在差异中遮盖；两次预览摘要相同
    expect(preview.managedDiff).toContain('policy-path=http://127.0.0.1:');
    expect(preview.managedDiff).not.toContain(engine.resource!.token);
    expect((await h.app.initPreview({}, WEB)).preview_digest).toBe(preview.preview_digest);
    const acc = await h.app.initCommit({ request_id: rid('init'), preview_digest: preview.preview_digest }, WEB);
    await h.idle();
    expect(h.repos.operations.get(acc.operation_id)).toMatchObject({ phase: 'COMPLETED', status: 'succeeded' });
    const text = readFileSync(workingPath(), 'utf8');
    expect(text).toContain(`# SFE-BEGIN group v1\n${loopbackGroupBlockLines(url)[0]}\n# SFE-END group`);
    expect(existsSync(join(h.surgeDir, NODE_RESOURCE_FILE))).toBe(false);
    expect(readServedPointer(engine.kv)).toEqual({ committed: { generation: 0 }, candidate: null });
    expect(readNeedsRefresh(engine.kv)).toBeNull();
    expect(engine.resource!.served()).toMatchObject({ generation: 0, state: 'committed' });
    expect(fetchResource(h).body.toString('utf8')).toContain('SFE-EMPTY = reject');
    expect(engine.resourceRuntime.line).toBe('ours');
    expect(nodeResourceStatus(engine)).toEqual({ state: 'serving', tokenSuspect: false, needsRefresh: false });
    expect(h.fake.calls.reloadProfile ?? 0).toBe(0);
    expect(h.fake.calls.updateExternalResource ?? 0).toBe(0);
    // 操作说明与日志不含令牌
    expect(JSON.stringify(steps(acc.operation_id))).not.toContain(engine.resource!.token);
    expect(h.logs.join('\n')).not.toContain(engine.resource!.token);
  });

  test('the resource server is not listening on the configured port → preview check fails, commit is refused with RESOURCE_SERVER_UNAVAILABLE; nothing written', async () => {
    h = await createHarness({ sourceProfile: SOURCE, start: false });
    h.binderRegistry.set(h.resourcePort, 'other-process');
    await h.app.start();
    expect(h.app.engine.resource!.listening()).toBe(false);
    const preview = await h.app.initPreview({}, WEB);
    expect(preview.checks.find((c) => c.name === 'resource_server')).toMatchObject({ ok: false });
    await expectError(h.app.initCommit({ request_id: rid(), preview_digest: preview.preview_digest }, WEB), 'RESOURCE_SERVER_UNAVAILABLE');
    expect(existsSync(workingPath())).toBe(false);
  });

  test('the read token is unavailable → SECRET_STORE_FAILED; no port picked → RESOURCE_SERVER_UNAVAILABLE; nothing written', async () => {
    h = await createHarness({ sourceProfile: SOURCE });
    await h.store.delete('sfe.resource-token.1');
    await h.crash();
    expect(h.app.engine.resource).toBeNull();
    await expectError(h.app.initPreview({}, WEB), 'SECRET_STORE_FAILED');
    await expectError(h.app.initCommit({ request_id: rid(), preview_digest: 'x'.repeat(64) }, WEB), 'SECRET_STORE_FAILED');
    expect(existsSync(workingPath())).toBe(false);
  });

  test('an existing external resource on 127.0.0.1:<our port>, or a source reference to that port, is a collision', async () => {
    h = await createHarness({ sourceProfile: SOURCE.replace('FINAL,DIRECT', `RULE-SET,http://127.0.0.1:${23456}/rules.list,DIRECT\nFINAL,DIRECT`) });
    const p = await h.app.initPreview({}, WEB);
    expect(p.nameCollisions).toContain('外部资源指向本机资源服务的端口');
    expect(p.nameCollisions.some((n) => n.startsWith('127.0.0.1:23456'))).toBe(true);
    expect(p.checks.find((c) => c.name === 'collisions')).toMatchObject({ ok: false });
    await expectError(h.app.initCommit({ request_id: rid(), preview_digest: p.preview_digest }, WEB), 'NAME_COLLISION');
    expect(existsSync(workingPath())).toBe(false);
  });
});

/**
 * D7 升级来的安装：工作配置是旧的本地节点文件定义，节点经本地文件部署（verified 发布），managed_objects 中有 resource_file 记录；
 * 升级后第一次启动按最近的 verified 发布初始化指针（已提交版本 = 该发布）。
 */
async function legacyInstall(opts: { revoke?: boolean } = {}): Promise<{ envId: string; generation: number; node: string }> {
  h = await createHarness({ nodeResource: 'legacy' });
  const envId = (await createEnv(h, 'US-Buyer-A', '203.0.113.10')).environment_id!;
  await h.idle();
  const generation = await legacyDeployNodes(h, [envId]);
  const digest = await h.files.digest(NODE_RESOURCE_FILE);
  h.repos.tx(() => {
    h.repos.managedObjects.upsertIntent({ kind: 'resource_file', identity: NODE_RESOURCE_FILE, contentDigest: digest, state: 'pending_add', createdByOperation: null });
    h.repos.managedObjects.setState('resource_file', NODE_RESOURCE_FILE, 'present', { contentDigest: digest });
    h.app.engine.kv.delete(RESOURCE_KV_KEYS.served);
    writeNeedsRefresh(h.app.engine.kv, null);
  });
  if (opts.revoke) h.revoke(['loopback_resource_restart']);
  await h.crash();
  await h.idle();
  expect(readServedPointer(h.app.engine.kv)).toEqual({ committed: { generation }, candidate: null });
  const env = h.repos.environments.get(envId)!;
  const node = h.repos.proxyRevisions.get(envId, env.deployedProxyRevision!)!.nodeName;
  expect(await h.fake.getGroupMembers('SFE-ROUTE')).toEqual(['REJECT', node]);
  return { envId, generation, node };
}

describe('remerge converts the legacy local group line only behind the resourceServe gate', () => {
  test('gate not met: the legacy line is kept unchanged (with the explanation), the local file and its record stay, no node resource publish', async () => {
    await legacyInstall({ revoke: true });
    const before = readFileSync(h.profilePath, 'utf8');
    const p = await h.app.remergePreview(WEB);
    expect(p.checks.find((c) => c.name === 'node_resource')).toEqual({ name: 'node_resource', ok: true, message: LEGACY_LINE_KEPT_TEXT });
    expect(p.requiresReload).toBe(false);
    const acc = await h.app.remergeCommit({ request_id: rid(), preview_digest: p.preview_digest }, WEB);
    await h.idle();
    expect(h.repos.operations.get(acc.operation_id)!.phase).toBe('COMPLETED');
    expect(steps(acc.operation_id)).toContain(LEGACY_LINE_KEPT_TEXT);
    expect(readFileSync(h.profilePath, 'utf8')).toBe(before);
    expect(existsSync(join(h.surgeDir, NODE_RESOURCE_FILE))).toBe(true);
    expect(h.repos.managedObjects.get('resource_file', NODE_RESOURCE_FILE)!.state).toBe('present');
    expect(remergePublishes()).toHaveLength(0);
    expect(h.fake.calls.reloadProfile ?? 0).toBe(1); // legacyDeployNodes 的那一次
    // 旧定义被改过（不再逐字是旧行）：恢复为旧行，仍不改用本机资源服务
    h.clock.advance(1000); // 备份目录按时间命名
    writeFileSync(h.profilePath, before.replace(LEGACY_NODE_GROUP_LINE, 'SFE-ROUTE = select, REJECT, DIRECT, policy-path=sfe-nodes.list'));
    const p2 = await h.app.remergePreview(WEB);
    expect(p2.checks.find((c) => c.name === 'node_resource')!.message).toBe(LEGACY_LINE_KEPT_TEXT);
    const acc2 = await h.app.remergeCommit({ request_id: rid(), preview_digest: p2.preview_digest }, WEB);
    await h.idle();
    expect(h.repos.operations.get(acc2.operation_id)!.phase).toBe('COMPLETED');
    expect(readFileSync(h.profilePath, 'utf8')).toBe(before);
    expect(remergePublishes()).toHaveLength(0);
    // 门槛之外也不能更换地址
    await expectError(h.app.remergeCommit({ request_id: rid(), preview_digest: (await h.app.remergePreview(WEB, { rotateResourceUrl: true })).preview_digest, rotateResourceUrl: true }, WEB), 'CAPABILITY_UNVERIFIED');
  });

  test('gate met: converts to the loopback line, reloads once, Surge downloads the committed version, the legacy file is deleted after the readback and its record scrubbed; one forced publish confirms', async () => {
    const { node } = await legacyInstall();
    const legacyPath = join(h.surgeDir, NODE_RESOURCE_FILE);
    expect(readFileSync(legacyPath, 'utf8')).toContain(node);
    const p = await h.app.remergePreview(WEB);
    expect(p.requiresReload).toBe(true);
    const check = p.checks.find((c) => c.name === 'node_resource')!;
    expect(check.ok).toBe(true);
    expect(check.message).toContain('将改用本机资源服务');
    expect(check.message).toContain('旧的本地节点文件 sfe-nodes.list 在读回确认之后删除');
    expect(p.managedDiff).not.toContain(h.app.engine.resource!.token);
    // 预览只读
    expect(existsSync(legacyPath)).toBe(true);
    expect(readNeedsRefresh(h.app.engine.kv)).toBeNull();
    const reloads = h.fake.calls.reloadProfile ?? 0;
    const updates = h.fake.calls.updateExternalResource ?? 0;
    const acc = await h.app.remergeCommit({ request_id: rid(), preview_digest: p.preview_digest }, WEB);
    await h.idle();
    expect(h.repos.operations.get(acc.operation_id)).toMatchObject({ phase: 'COMPLETED', status: 'succeeded' });
    expect(readFileSync(h.profilePath, 'utf8')).toContain(loopbackGroupBlockLines(h.resourceUrl()!)[0]);
    expect((h.fake.calls.reloadProfile ?? 0) - reloads).toBe(1);
    // 读回确认之后删除旧文件、清除记录
    expect(existsSync(legacyPath)).toBe(false);
    expect(h.repos.managedObjects.get('resource_file', NODE_RESOURCE_FILE)).toMatchObject({ state: 'removed', contentDigest: 'scrubbed' });
    expect(steps(acc.operation_id).some((s) => s.startsWith('已删除旧的本地节点文件 sfe-nodes.list'))).toBe(true);
    // 重载时 Surge 从本机资源服务下载了已提交版本；之后一次强制刷新发布经单 key 更新读回
    const publishes = remergePublishes();
    expect(publishes).toHaveLength(1);
    expect(publishes[0]).toMatchObject({ status: 'succeeded' });
    expect((h.fake.calls.updateExternalResource ?? 0) - updates).toBe(1);
    expect(h.fake.updateAllAttempts).toBe(0);
    expect(await h.fake.getGroupMembers('SFE-ROUTE')).toEqual(['REJECT', node]);
    expect(readNeedsRefresh(h.app.engine.kv)).toBeNull();
    expect(nodeResourceStatus(h.app.engine)).toEqual({ state: 'serving', tokenSuspect: false, needsRefresh: false });
    expect(h.repos.routeState.get().warnings).not.toContain('node_resource_unverified');
  });

  test('the legacy file differs from its record → converted but the file is kept and the record stays', async () => {
    await legacyInstall();
    const legacyPath = join(h.surgeDir, NODE_RESOURCE_FILE);
    writeFileSync(legacyPath, `${readFileSync(legacyPath, 'utf8')}# 用户的修改\n`);
    const p = await h.app.remergePreview(WEB);
    const acc = await h.app.remergeCommit({ request_id: rid(), preview_digest: p.preview_digest }, WEB);
    await h.idle();
    expect(h.repos.operations.get(acc.operation_id)!.phase).toBe('COMPLETED');
    expect(readFileSync(h.profilePath, 'utf8')).toContain(loopbackGroupBlockLines(h.resourceUrl()!)[0]);
    expect(existsSync(legacyPath)).toBe(true);
    expect(h.repos.managedObjects.get('resource_file', NODE_RESOURCE_FILE)!.state).toBe('present');
    expect(steps(acc.operation_id).some((s) => s.includes('与本应用的记录不一致'))).toBe(true);
  });

  test('the legacy file is already gone → the record is scrubbed immediately', async () => {
    await legacyInstall();
    const p = await h.app.remergePreview(WEB);
    // 预览之后、执行之前文件被删除（摘要只覆盖工作配置与候选）
    const { rmSync } = await import('node:fs');
    rmSync(join(h.surgeDir, NODE_RESOURCE_FILE));
    const acc = await h.app.remergeCommit({ request_id: rid(), preview_digest: p.preview_digest }, WEB);
    await h.idle();
    expect(h.repos.operations.get(acc.operation_id)!.phase).toBe('COMPLETED');
    expect(h.repos.managedObjects.get('resource_file', NODE_RESOURCE_FILE)).toMatchObject({ state: 'removed', contentDigest: 'scrubbed' });
    expect(steps(acc.operation_id)).toContain('旧的本地节点文件 sfe-nodes.list 已不存在：已清除它的记录');
  });

  test('the post-reload readback is not confirmed (Surge could not download) → the legacy file is kept; the next remerge deletes it once the forced publish confirmed the resource', async () => {
    await legacyInstall();
    const legacyPath = join(h.surgeDir, NODE_RESOURCE_FILE);
    const p = await h.app.remergePreview(WEB);
    // 重载时那一次下载被拒绝：资源尚未就绪
    h.resourceFault({ kind: 'refused' }, { times: 1 });
    const acc = await h.app.remergeCommit({ request_id: rid(), preview_digest: p.preview_digest }, WEB);
    await h.idle();
    expect(h.repos.operations.get(acc.operation_id)!.phase).toBe('COMPLETED');
    expect(steps(acc.operation_id).some((s) => s.startsWith('旧的本地节点文件 sfe-nodes.list 暂不删除'))).toBe(true);
    expect(existsSync(legacyPath)).toBe(true);
    expect(h.repos.managedObjects.get('resource_file', NODE_RESOURCE_FILE)!.state).toBe('present');
    // 强制刷新发布单 key 更新并确认
    expect(remergePublishes()[0]).toMatchObject({ status: 'succeeded' });
    expect((await ourResource(h))!.error).toBeNull();
    h.clock.advance(1000); // 备份目录按时间命名
    const p2 = await h.app.remergePreview(WEB);
    expect(p2.requiresReload).toBe(false);
    const acc2 = await h.app.remergeCommit({ request_id: rid(), preview_digest: p2.preview_digest }, WEB);
    await h.idle();
    expect(h.repos.operations.get(acc2.operation_id)!.phase).toBe('COMPLETED');
    expect(existsSync(legacyPath)).toBe(false);
    expect(h.repos.managedObjects.get('resource_file', NODE_RESOURCE_FILE)).toMatchObject({ state: 'removed', contentDigest: 'scrubbed' });
  });

  test('conversion requires the resource server to listen on the configured port', async () => {
    h = await createHarness({ nodeResource: 'legacy', start: false });
    h.binderRegistry.set(h.resourcePort, 'other-process');
    await h.app.start();
    await h.idle();
    expect(h.app.engine.resource!.listening()).toBe(false);
    const before = readFileSync(h.profilePath, 'utf8');
    const p = await h.app.remergePreview(WEB);
    expect(p.checks.find((c) => c.name === 'node_resource')).toMatchObject({ ok: false });
    await expectError(h.app.remergeCommit({ request_id: rid(), preview_digest: p.preview_digest }, WEB), 'RESOURCE_SERVER_UNAVAILABLE');
    expect(readFileSync(h.profilePath, 'utf8')).toBe(before);
    expect(h.fake.calls.reloadProfile ?? 0).toBe(0);
  });
});

describe('remerge with a candidate in the pointer', () => {
  test('no reload while a candidate is recorded: preview check fails and commit is refused', async () => {
    h = await createHarness();
    await h.idle();
    writeFileSync(h.profilePath, readFileSync(h.profilePath, 'utf8').replace('SFE-ROUTE = select, REJECT, ', 'SFE-ROUTE = select, REJECT, DIRECT, '));
    writeServedPointer(h.app.engine.kv, { committed: { generation: 0 }, candidate: { generation: 1 } });
    const p = await h.app.remergePreview(WEB);
    expect(p.checks.find((c) => c.name === 'node_resource')).toMatchObject({ ok: false });
    await expectError(h.app.remergeCommit({ request_id: rid(), preview_digest: p.preview_digest }, WEB), 'RESOURCE_SERVER_UNAVAILABLE');
    expect(h.fake.calls.reloadProfile ?? 0).toBe(0);
  });
});

describe('remerge option rotateResourceUrl', () => {
  function markSuspect(): void {
    writeTokenSuspect(h.app.engine.kv, { since: h.clock.now().toISOString(), reason: 'port_in_use' });
    h.app.engine.resource!.setRefuseToken(true);
  }

  test('the option must be a boolean; a plain remerge never clears tokenSuspect', async () => {
    h = await createHarness();
    await h.idle();
    await expectError(h.app.remergePreview(WEB, { rotateResourceUrl: 'yes' as unknown as boolean }), 'BAD_REQUEST');
    await expectError(h.app.remergeCommit({ request_id: rid(), preview_digest: 'x', rotateResourceUrl: 1 as unknown as boolean }, WEB), 'BAD_REQUEST');
    markSuspect();
    const p = await h.app.remergePreview(WEB);
    expect(p.checks.find((c) => c.name === 'resource_token')).toMatchObject({ ok: true });
    const acc = await h.app.remergeCommit({ request_id: rid(), preview_digest: p.preview_digest }, WEB);
    await h.idle();
    expect(h.repos.operations.get(acc.operation_id)!.phase).toBe('COMPLETED');
    expect(readTokenSuspect(h.app.engine.kv)).not.toBeNull();
    // 发布仍停泊在令牌可疑
    const pub = await h.app.publishPending({ request_id: rid('publish') }, WEB);
    await h.idle();
    expect(h.repos.operations.get(pub.operation_id)!.error).toMatchObject({ code: 'RESOURCE_SERVER_UNAVAILABLE', details: { reason: 'token_suspect' } });
  });

  test('preview generates nothing and is deterministic; commit: new token and port, the same profile reloaded once, tokenSuspect cleared, old token value deleted, old token gets 404; one forced publish re-reads the new resource', async () => {
    h = await createHarness();
    await h.idle();
    const engine = h.app.engine;
    const oldUrl = h.resourceUrl()!;
    const oldToken = engine.resource!.token;
    markSuspect();
    expect(fetchWithToken(h.resourcePort, oldToken).status).toBe(404);
    const plain = await h.app.remergePreview(WEB);
    const p = await h.app.remergePreview(WEB, { rotateResourceUrl: true });
    // 预览只读、确定：不生成令牌或端口，不改任何东西
    expect((await h.app.remergePreview(WEB, { rotateResourceUrl: true })).preview_digest).toBe(p.preview_digest);
    expect((await h.app.remergePreview(WEB)).preview_digest).toBe(plain.preview_digest);
    expect(p.preview_digest).not.toBe(plain.preview_digest);
    expect(h.repos.meta.resourceTokenRef()).toBe('sfe.resource-token.1');
    expect(await h.store.get('sfe.resource-token.2')).toBeNull();
    expect(h.repos.settings.get('resourcePort')).toBe(h.resourcePort);
    expect(h.resourceUrl()).toBe(oldUrl);
    expect(p.requiresReload).toBe(true);
    expect(p.checks.find((c) => c.name === 'rotate')).toMatchObject({ ok: true });
    expect(p.managedDiff).toContain('http://127.0.0.1:<新端口>/***');
    expect(p.managedDiff).not.toContain(oldToken);
    // 提交的选项必须与预览相同
    await expectError(h.app.remergeCommit({ request_id: rid(), preview_digest: plain.preview_digest, rotateResourceUrl: true }, WEB), 'PREVIEW_STALE');
    await expectError(h.app.remergeCommit({ request_id: rid(), preview_digest: p.preview_digest }, WEB), 'PREVIEW_STALE');
    const reloads = h.fake.calls.reloadProfile ?? 0;
    const updates = h.fake.calls.updateExternalResource ?? 0;
    const acc = await h.app.remergeCommit({ request_id: rid(), preview_digest: p.preview_digest, rotateResourceUrl: true }, WEB);
    await h.idle();
    expect(h.repos.operations.get(acc.operation_id)).toMatchObject({ phase: 'COMPLETED', status: 'succeeded' });
    // 新令牌引用与端口
    expect(h.repos.meta.resourceTokenRef()).toBe('sfe.resource-token.2');
    expect(await h.store.get('sfe.resource-token.1')).toBeNull();
    const port = h.repos.settings.get('resourcePort')!;
    expect(port).not.toBe(h.resourcePort);
    expect(port).toBeGreaterThanOrEqual(RESOURCE_PORT_MIN);
    expect(port).toBeLessThan(RESOURCE_PORT_MAX);
    const newUrl = h.resourceUrl()!;
    expect(parseNodeResourceUrl(newUrl)).toMatchObject({ port });
    expect(engine.resource!.token).not.toBe(oldToken);
    expect(engine.resource!.port()).toBe(port);
    const text = readFileSync(h.profilePath, 'utf8');
    expect(text).toContain(loopbackGroupBlockLines(newUrl)[0]);
    expect(text).not.toContain(oldToken);
    expect((h.fake.calls.reloadProfile ?? 0) - reloads).toBe(1);
    // 令牌可疑只由轮换清除；旧令牌在新端口得到 404，旧端口不再有任何服务
    expect(readTokenSuspect(engine.kv)).toBeNull();
    expect(fetchWithToken(port, oldToken).status).toBe(404);
    expect(() => fetchWithToken(h.resourcePort, oldToken)).toThrow();
    expect(fetchResource(h).status).toBe(200);
    // 一次强制刷新发布：对新资源单 key 更新并读回
    const publishes = remergePublishes();
    expect(publishes).toHaveLength(1);
    expect(publishes[0]).toMatchObject({ status: 'succeeded' });
    expect((h.fake.calls.updateExternalResource ?? 0) - updates).toBe(1);
    expect(h.fake.remoteFetches.filter((f) => f.trigger === 'update').at(-1)!.key).toBe(h.resourceKey());
    expect(await h.fake.getGroupMembers('SFE-ROUTE')).toEqual(['REJECT', 'SFE-EMPTY']);
    expect(readNeedsRefresh(engine.kv)).toBeNull();
    expect(nodeResourceStatus(engine)).toEqual({ state: 'serving', tokenSuspect: false, needsRefresh: false });
    // 令牌从不进入操作说明或日志
    const all = `${JSON.stringify(steps(acc.operation_id))}\n${h.logs.join('\n')}`;
    expect(all).not.toContain(oldToken);
    expect(all).not.toContain(engine.resource!.token);
    // 之后的发布照常进行
    const envId = (await createEnv(h, 'US-Buyer-A', '203.0.113.10')).environment_id!;
    await h.idle();
    expect(h.repos.environments.get(envId)!.deployedProxyRevision).not.toBeNull();
  });

  test('the reload fails → the rotation is undone: profile restored, new token deleted, the old address and tokenSuspect are kept; a retry succeeds', async () => {
    h = await createHarness();
    await h.idle();
    const engine = h.app.engine;
    const oldToken = engine.resource!.token;
    markSuspect();
    const before = readFileSync(h.profilePath, 'utf8');
    const p = await h.app.remergePreview(WEB, { rotateResourceUrl: true });
    h.fake.failNext('reloadProfile');
    const acc = await h.app.remergeCommit({ request_id: rid(), preview_digest: p.preview_digest, rotateResourceUrl: true }, WEB);
    await h.idle();
    expect(h.repos.operations.get(acc.operation_id)).toMatchObject({ phase: 'FAILED', status: 'failed' });
    expect(readFileSync(h.profilePath, 'utf8')).toBe(before);
    expect(h.repos.meta.resourceTokenRef()).toBe('sfe.resource-token.1');
    expect(await h.store.get('sfe.resource-token.2')).toBeNull();
    expect(h.repos.settings.get('resourcePort')).toBe(h.resourcePort);
    expect(engine.resource!.token).toBe(oldToken);
    expect(readTokenSuspect(engine.kv)).not.toBeNull();
    // 旧的资源服务仍在原端口、仍拒绝令牌；新端口上没有任何服务
    expect(engine.resource!.listening()).toBe(true);
    expect(fetchWithToken(h.resourcePort, oldToken).status).toBe(404);
    expect([...h.binderRegistry.keys()]).toEqual([h.resourcePort]);
    expect(remergePublishes()).toHaveLength(0);
    h.clock.advance(1000); // 备份目录按时间命名
    const p2 = await h.app.remergePreview(WEB, { rotateResourceUrl: true });
    const acc2 = await h.app.remergeCommit({ request_id: rid(), preview_digest: p2.preview_digest, rotateResourceUrl: true }, WEB);
    await h.idle();
    expect(h.repos.operations.get(acc2.operation_id)!.phase).toBe('COMPLETED');
    expect(h.repos.meta.resourceTokenRef()).toBe('sfe.resource-token.2');
    expect(readTokenSuspect(engine.kv)).toBeNull();
  });

  test('a token value left by an interrupted rotation is deleted at startup', async () => {
    h = await createHarness({ dbFile: true });
    await h.idle();
    await h.store.put('sfe.resource-token.2', 'b'.repeat(64), 'system');
    const harness = h;
    // crash() 之后引擎得到的地址仍须与工作配置相同：只删除不在 meta 中的引用
    await harness.crash();
    expect(await h.store.get('sfe.resource-token.2')).toBeNull();
    expect(await h.store.get('sfe.resource-token.1')).not.toBeNull();
    expect(h.logs.some((l) => l.includes('"msg":"resource.stale_tokens_removed"'))).toBe(true);
  });
});
