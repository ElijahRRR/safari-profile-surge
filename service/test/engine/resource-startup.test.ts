// 本机资源服务（D10）的启动顺序（loopback-spec §6 第 1–8 步）：令牌读不到时服务照常启动、端口首次选定并保存（避开 [General]
// 中的端口）、指针初始化与候选版本撤回、门槛之外的代数不提供（503）、监听之前的审计、端口被占用、系统强制刷新只排入一次。
// 只用合成数据（文档地址、example.test、合成令牌）。

import { readFileSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, test } from 'vitest';
import { RESOURCE_PORT_MAX, RESOURCE_PORT_MIN } from '@sfe/contract';
import {
  classifyGroupLine,
  confirmNodeResource,
  generalPorts,
  pickResourcePort,
  SYSTEM_REFRESH_KEY,
} from '../../src/engine/node-resource.js';
import {
  RESOURCE_KV_KEYS,
  matchAuditRecord,
  readAuditState,
  readNeedsRefresh,
  readServedPointer,
  readTokenSuspect,
  writeNeedsRefresh,
  writeServedPointer,
} from '../../src/resource/index.js';
import { LEGACY_NODE_GROUP_LINE, nodeResourceUrl } from '@sfe/contract';
import { loopbackGroupBlockLines, resourceBody } from '../../src/surge/generate.js';
import { FAKE_REMOTE_ERRORS } from '../../src/surge/fake.js';
import type { OperationRecord } from '../../src/db/index.js';
import { reconcile } from '../../src/engine/reconcile.js';
import { LOOPBACK_CAPS, PROFILE_A, WEB, bind, createEnv, createHarness, rid, verify, type Harness } from './harness.js';
import { commitNodes, fetchResource, legacyDeployNodes, ourResource } from './resource-fixtures.js';

let h: Harness;

afterEach(async () => {
  await h?.close();
});

const TOKEN = 'a'.repeat(64);

function systemRefreshOps(x: Harness): OperationRecord[] {
  return x.repos.operations.listRecent(200).filter((o) => o.kind === 'deploy.publish' && o.initiatorKind === 'service' && o.payload.forceRefresh === true);
}

function logIndex(x: Harness, msg: string, from = 0): number {
  return x.logs.findIndex((l, i) => i >= from && l.includes(`"msg":"${msg}"`));
}

function insertDeployment(x: Harness, generation: number, opts: { state?: 'verified' | 'published'; digest?: string } = {}): void {
  x.repos.deployments.insert({
    generation,
    workingProfileDigest: null,
    resourceDigest: opts.digest ?? x.files.digestContent(resourceBody(generation, [])),
    nodeManifest: [],
    selectionBefore: null,
    state: opts.state ?? 'verified',
    operationId: null,
  });
}

describe('pure helpers', () => {
  test('classifyGroupLine: ours only for the exact generated block, legacy, other loopback addresses, none', () => {
    const url = nodeResourceUrl(23456, TOKEN);
    const other = nodeResourceUrl(23457, TOKEN);
    const block = (lines: string[]) => ['[Proxy Group]', '# SFE-BEGIN group v1', ...lines, '# SFE-END group', ''].join('\n');
    expect(classifyGroupLine(block(loopbackGroupBlockLines(url)), url)).toBe('ours');
    expect(classifyGroupLine(block(loopbackGroupBlockLines(other)), url)).toBe('loopback_other');
    // 令牌读不到（地址未知）时同样只能是 loopback_other
    expect(classifyGroupLine(block(loopbackGroupBlockLines(url)), null)).toBe('loopback_other');
    // 段内容被改过（多了一行）：不是本服务生成的定义
    expect(classifyGroupLine(block([...loopbackGroupBlockLines(url), '# 用户的注释']), url)).toBe('loopback_other');
    expect(classifyGroupLine(block([LEGACY_NODE_GROUP_LINE]), url)).toBe('legacy');
    expect(classifyGroupLine(block(['SFE-ROUTE = select, REJECT']), url)).toBe('none');
    expect(classifyGroupLine('[Proxy Group]\nDaily = select, DIRECT\n', url)).toBe('none');
  });

  test('generalPorts reads only the port-holding [General] keys', () => {
    const text = [
      '[General]',
      'http-api = key@127.0.0.1:26171',
      'http-listen = 0.0.0.0:26152',
      'socks5-listen = 127.0.0.1:26153',
      'external-controller-access = pw@0.0.0.0:26170',
      'probe-bind = 26199',
      'dns-server = 192.0.2.53',
      'loglevel = notify',
      '[Proxy]',
      'Daily = socks5, 192.0.2.10, 26180',
      '',
    ].join('\n');
    expect([...generalPorts(text)].sort()).toEqual([26152, 26153, 26170, 26171, 26199]);
  });

  test('pickResourcePort skips excluded, out-of-range and repeated picks, tries at most 10 times', async () => {
    const tried: number[] = [];
    const seq = [26171, 19999, 40000, 26171, 30001, 30002];
    const port = await pickResourcePort({
      excluded: new Set([26171]),
      random: () => seq.shift()!,
      tryBind: async (p) => {
        tried.push(p);
        return p === 30002;
      },
    });
    expect(port).toBe(30002);
    expect(tried).toEqual([30001, 30002]);
    let picks = 0;
    const none = await pickResourcePort({
      excluded: new Set(),
      random: () => RESOURCE_PORT_MIN + ++picks,
      tryBind: async () => false,
    });
    expect(none).toBeNull();
    expect(picks).toBe(10);
  });
});

describe('startup order', () => {
  test('a fresh loopback start: token pinned in the scrubber, generation 0 served, audit initialised before listening, one parked system refresh, nothing written to Surge', async () => {
    // 发布门槛不满足：系统强制刷新停泊（与之后的回环发布实现无关），启动本身从不写 Surge
    h = await createHarness({ nodeResource: 'loopback', servedPointer: 'absent', withholdLoopbackCapabilities: true });
    await h.idle();
    const engine = h.app.engine;
    const host = engine.resource!;
    const url = h.resourceUrl()!;
    expect(url).toBe(h.profileResourceUrl);
    expect(host.listening()).toBe(true);
    expect(host.served()).toEqual({ generation: 0, state: 'committed', bytes: Buffer.byteLength(resourceBody(0, [])) });
    expect(readServedPointer(engine.kv)).toEqual({ committed: { generation: 0 }, candidate: null });
    expect(readNeedsRefresh(engine.kv)).toEqual({ generation: 0, reason: 'pointer_init' });
    // 审计按 Surge 已有的第 0 代初始化（不报警），在监听之前
    expect(readAuditState(engine.kv)).toMatchObject({ verifiedError: null });
    const init = logIndex(h, 'resource.pointer_initialized');
    const audited = logIndex(h, 'resource.audit_initialized');
    const listening = logIndex(h, 'resource.listening');
    const enqueued = logIndex(h, 'resource.refresh_enqueued');
    expect(init).toBeGreaterThanOrEqual(0);
    expect(init).toBeLessThan(audited);
    expect(audited).toBeLessThan(listening);
    expect(listening).toBeLessThan(enqueued);
    // 令牌登记到脱敏器；日志从不含令牌或地址
    const token = host.token;
    expect(engine.scrubber.scrub(`请求 ${url} 失败`)).not.toContain(token);
    expect(h.logs.some((l) => l.includes(token))).toBe(false);
    // 第 8 步：恰好一次系统强制刷新，门槛不满足而停泊；启动从不更新外部资源或重载配置
    const ops = systemRefreshOps(h);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ phase: 'WAITING_DEPLOYMENT', status: 'parked' });
    expect(h.fake.calls.updateExternalResource ?? 0).toBe(0);
    expect(h.fake.calls.reloadProfile ?? 0).toBe(0);
    expect(h.repos.routeState.get().warnings).not.toContain('node_resource_unverified');
    // 状态视图：不含令牌、地址或端口
    const snapshot = h.app.views.snapshot('0.0.0-test', false);
    expect(snapshot.surge.nodeResource).toEqual({ state: 'serving', tokenSuspect: false, needsRefresh: true });
    const json = JSON.stringify(snapshot);
    expect(json).not.toContain(token);
    expect(json).not.toContain(url);
  });

  test('the system refresh is enqueued at most once: reconciles and crashes add none; a confirmed readback re-arms it', async () => {
    h = await createHarness({ nodeResource: 'loopback', servedPointer: 'absent', withholdLoopbackCapabilities: true });
    await h.idle();
    expect(systemRefreshOps(h)).toHaveLength(1);
    await h.app.runPeriodicReconcile();
    await h.app.refreshSurge(WEB);
    await h.app.ensureInControl();
    await h.idle();
    expect(systemRefreshOps(h)).toHaveLength(1);
    await h.crash();
    await h.idle();
    expect(systemRefreshOps(h)).toHaveLength(1);
    expect(h.app.engine.kv.get(SYSTEM_REFRESH_KEY)).toMatchObject({ operationId: systemRefreshOps(h)[0]!.id });
    // 经确认的读回（模拟一次发布）：needsRefresh 与系统刷新记录一起清除
    await commitNodes(h, []);
    expect(readNeedsRefresh(h.app.engine.kv)).toBeNull();
    expect(h.app.engine.kv.get(SYSTEM_REFRESH_KEY)).toBeNull();
    // 之后又需要刷新（这里：resourceServe 门槛不满足，已提交的第 1 代停止提供）：再排入一次，之后同样只有一次
    await h.app.runPeriodicReconcile();
    await h.idle();
    expect(h.app.engine.resource!.served()).toBeNull();
    expect(readNeedsRefresh(h.app.engine.kv)).toEqual({ generation: 1, reason: 'serve_gated' });
    expect(systemRefreshOps(h)).toHaveLength(2);
    await h.app.runPeriodicReconcile();
    await h.idle();
    expect(systemRefreshOps(h)).toHaveLength(2);
  });

  test('not enqueued while another publish operation is open', async () => {
    h = await createHarness({ nodeResource: 'loopback', servedPointer: 'absent', withholdLoopbackCapabilities: true, start: false });
    const open = h.repos.operations.insert({
      id: 'op_open_publish',
      requestId: rid('open'),
      requestDigest: 'service',
      kind: 'deploy.publish',
      initiatorKind: 'web',
      phase: 'WAITING_ROUTE',
      status: 'waiting',
      payload: { environmentIds: null },
    });
    await h.app.start();
    await h.idle();
    expect(systemRefreshOps(h)).toHaveLength(0);
    h.repos.operations.update(open.id, { phase: 'FAILED', status: 'failed' });
    await h.app.runPeriodicReconcile();
    await h.idle();
    expect(systemRefreshOps(h)).toHaveLength(1);
  });

  test('never enqueued while the working profile has the legacy line', async () => {
    h = await createHarness({ nodeResource: 'legacy' });
    await h.idle();
    await h.app.runPeriodicReconcile();
    await h.crash();
    await h.idle();
    expect(systemRefreshOps(h)).toHaveLength(0);
    expect(h.app.engine.resourceRuntime.line).toBe('legacy');
    expect(h.app.views.snapshot('0.0.0-test', false).surge.nodeResource).toMatchObject({ state: 'legacy_line' });
    // 指针按初始化写入（没有可用的发布：第 0 代、需要刷新），但工作配置没有引用本机资源服务：不排入
    expect(readNeedsRefresh(h.app.engine.kv)).toEqual({ generation: 0, reason: 'pointer_init' });
    // 资源服务照常监听，但工作配置没有引用它：从不设节点资源警告
    expect(h.app.engine.resource!.listening()).toBe(true);
    expect(h.repos.routeState.get().warnings).not.toContain('node_resource_unverified');
  });
});

describe('token unavailable', () => {
  test('loopback line: the service starts without a resource host, raises the warning, normal mode works and publishing parks', async () => {
    h = await createHarness({ nodeResource: 'loopback' });
    await h.idle();
    const before = systemRefreshOps(h).length;
    await h.store.delete('sfe.resource-token.1');
    await h.crash();
    await h.idle();
    expect(h.app.engine.resource).toBeNull();
    expect(h.resourceUrl()).toBeNull();
    expect(h.logs.some((l) => l.includes('"msg":"resource.token_unavailable"') && l.includes('"reason":"not_found"'))).toBe(true);
    // 工作配置引用了本机资源服务形式的地址：节点资源未确认
    expect(h.app.engine.resourceRuntime.line).toBe('loopback_other');
    expect(h.repos.routeState.get().warnings).toContain('node_resource_unverified');
    expect(h.app.views.snapshot('0.0.0-test', false).surge.nodeResource).toMatchObject({ state: 'token_unavailable' });
    expect(systemRefreshOps(h)).toHaveLength(before);
    // 端口上没有任何服务：Surge 的下载被拒绝
    expect(() => h.binder.request(h.resourcePort, { method: 'GET', rawPath: '/', rawHeaders: [], remoteAddress: '127.0.0.1', localAddress: '127.0.0.1' })).toThrow();
    // 进入普通模式不受影响
    const n = await h.app.enterNormal({ request_id: rid('normal') }, WEB);
    await h.idle();
    expect(h.repos.operations.get(n.operation_id)).toMatchObject({ phase: 'NORMAL_RESTORED', status: 'succeeded' });
    // 发布停泊，从不更新外部资源
    const calls = h.fake.calls.updateExternalResource ?? 0;
    const p = await h.app.publishPending({ request_id: rid('publish') }, WEB);
    await h.idle();
    expect(h.repos.operations.get(p.operation_id)).toMatchObject({ phase: 'WAITING_DEPLOYMENT', status: 'parked' });
    expect(h.fake.calls.updateExternalResource ?? 0).toBe(calls);
  });

  test('legacy line: an active route still enters normal mode; no node resource warning', async () => {
    h = await createHarness({ nodeResource: 'legacy' });
    // D7 时部署的节点（D10 的发布在旧组行上停泊）
    const envId = (await createEnv(h, 'US-Buyer-A', '203.0.113.10')).environment_id!;
    await legacyDeployNodes(h, [envId]);
    await bind(h, PROFILE_A, envId);
    const act = await h.app.activate(envId, { request_id: rid('act') }, WEB);
    await h.idle();
    expect((await verify(h, PROFILE_A, act.operation_id)).ok).toBe(true);
    expect(h.repos.operations.get(act.operation_id)!.phase).toBe('ACTIVE_VERIFIED');
    await h.store.delete('sfe.resource-token.1');
    await h.crash();
    await h.idle();
    expect(h.app.engine.resource).toBeNull();
    expect(h.repos.routeState.get().warnings).not.toContain('node_resource_unverified');
    const n = await h.app.enterNormal({ request_id: rid('normal'), old_session_policy: 'closed_confirmed', confirmed_environment_id: envId }, WEB);
    await h.idle();
    expect(h.repos.operations.get(n.operation_id)).toMatchObject({ phase: 'NORMAL_RESTORED', status: 'succeeded' });
    expect(h.repos.routeState.get()).toMatchObject({ entryMode: 'NORMAL', phase: 'idle' });
  });
});

describe('port', () => {
  test('first start picks an in-range port, persists it and listens on it; later starts keep it', async () => {
    // 工作配置不引用本机资源服务（旧组行）：首次选定的端口与它无关
    h = await createHarness({ nodeResource: 'legacy', start: false });
    h.repos.settings.setResourcePort(null);
    await h.app.start();
    await h.idle();
    const port = h.repos.settings.get('resourcePort');
    expect(port).not.toBeNull();
    expect(port!).toBeGreaterThanOrEqual(RESOURCE_PORT_MIN);
    expect(port!).toBeLessThan(RESOURCE_PORT_MAX);
    expect(h.app.engine.resource!.listening()).toBe(true);
    expect(h.app.engine.resource!.port()).toBe(port);
    expect(h.binderRegistry.has(port!)).toBe(true);
    // 日志不带端口
    const line = h.logs.find((l) => l.includes('"msg":"resource.port_selected"'));
    expect(line).toBeDefined();
    expect(line).not.toContain(String(port));
    await h.crash();
    expect(h.repos.settings.get('resourcePort')).toBe(port);
    expect(h.app.engine.resource!.port()).toBe(port);
  });

  test('no free port in 10 picks: the port stays unset, nothing listens, the service still runs and normal mode works', async () => {
    h = await createHarness({ nodeResource: 'legacy', start: false });
    h.repos.settings.setResourcePort(null);
    for (let p = RESOURCE_PORT_MIN; p < RESOURCE_PORT_MAX; p++) h.binderRegistry.set(p, 'other-process');
    await h.app.start();
    await h.idle();
    expect(h.repos.settings.get('resourcePort')).toBeNull();
    expect(h.app.engine.resourceUrl()).toBeNull();
    expect(h.app.engine.resource!.listening()).toBe(false);
    expect(h.logs.some((l) => l.includes('"msg":"resource.port_unavailable"'))).toBe(true);
    const n = await h.app.enterNormal({ request_id: rid('normal') }, WEB);
    await h.idle();
    expect(h.repos.operations.get(n.operation_id)).toMatchObject({ phase: 'NORMAL_RESTORED', status: 'succeeded' });
  });
});

describe('served pointer', () => {
  test('initialised once to the latest verified/published deployment whose regenerated body matches; no refresh needed', async () => {
    h = await createHarness({ nodeResource: 'loopback', servedPointer: 'absent', start: false });
    insertDeployment(h, 2, { state: 'verified' });
    insertDeployment(h, 3, { state: 'published' });
    await h.app.start();
    await h.idle();
    const kv = h.app.engine.kv;
    expect(readServedPointer(kv)).toEqual({ committed: { generation: 3 }, candidate: null });
    expect(readNeedsRefresh(kv)).toBeNull();
    expect(h.app.engine.resource!.served()).toMatchObject({ generation: 3, state: 'committed' });
    const r = fetchResource(h);
    expect(r.status).toBe(200);
    expect(r.body.toString('utf8')).toBe(resourceBody(3, []));
    // Surge 中已是同样的节点（只有占位节点）：不需要刷新，不排入
    expect(systemRefreshOps(h)).toHaveLength(0);
  });

  test('the latest deployment cannot be regenerated → the older matching one is committed and a refresh is required', async () => {
    h = await createHarness({ nodeResource: 'loopback', servedPointer: 'absent', start: false });
    // 系统强制刷新停泊（只属于发布门槛的一项不满足）：这里只看指针初始化
    h.revoke(['loopback_publish_crash']);
    insertDeployment(h, 2);
    insertDeployment(h, 4, { digest: 'scrubbed' });
    await h.app.start();
    await h.idle();
    expect(readServedPointer(h.app.engine.kv)).toEqual({ committed: { generation: 2 }, candidate: null });
    expect(readNeedsRefresh(h.app.engine.kv)).toEqual({ generation: 2, reason: 'pointer_init' });
  });

  test('startup reverts a candidate (never replays it) and records needsRefresh; a candidate that was served raises the warning', async () => {
    h = await createHarness({ nodeResource: 'loopback' });
    // 系统强制刷新停泊（只属于发布门槛的一项不满足）：这里只看启动时的撤回（之后的收敛见 publish-loopback-crash.test.ts）
    h.revoke(['loopback_publish_crash']);
    await h.idle();
    // 候选版本提供过一次（令牌正确的 200，审计记录持久保存），之后进程崩溃
    h.app.engine.resource!.stageCandidate({ generation: 7, content: resourceBody(7, []) });
    expect(fetchResource(h).status).toBe(200);
    writeServedPointer(h.app.engine.kv, { committed: { generation: 0 }, candidate: { generation: 7 } });
    await h.crash();
    await h.idle();
    const kv = h.app.engine.kv;
    expect(readServedPointer(kv)).toEqual({ committed: { generation: 0 }, candidate: null });
    expect(readNeedsRefresh(kv)).toEqual({ generation: 7, reason: 'startup_candidate' });
    expect(h.app.engine.resource!.served()).toMatchObject({ generation: 0, state: 'committed' });
    expect(h.logs.some((l) => l.includes('"msg":"resource.candidate_reverted"'))).toBe(true);
    expect(h.repos.routeState.get().warnings).toContain('node_resource_unverified');
  });

  test('a reverted candidate that was never served does not raise the warning', async () => {
    h = await createHarness({ nodeResource: 'loopback' });
    h.revoke(['loopback_publish_crash']);
    await h.idle();
    writeServedPointer(h.app.engine.kv, { committed: { generation: 0 }, candidate: { generation: 7 } });
    await h.crash();
    await h.idle();
    expect(readNeedsRefresh(h.app.engine.kv)).toEqual({ generation: 7, reason: 'startup_candidate' });
    expect(h.repos.routeState.get().warnings).not.toContain('node_resource_unverified');
  });

  test('generation > 0 without the resourceServe gate is not served (503) until the gate is met again', async () => {
    h = await createHarness({ nodeResource: 'loopback', servedPointer: 'absent', start: false });
    insertDeployment(h, 3);
    h.revoke(['loopback_resource_auth']);
    await h.app.start();
    await h.idle();
    expect(h.app.engine.resource!.served()).toBeNull();
    expect(fetchResource(h).status).toBe(503);
    expect(h.logs.some((l) => l.includes('"msg":"resource.serve_gated"'))).toBe(true);
    expect(readNeedsRefresh(h.app.engine.kv)).toEqual({ generation: 3, reason: 'serve_gated' });
    h.grant(['loopback_resource_auth']);
    await h.app.runPeriodicReconcile();
    expect(h.app.engine.resource!.served()).toMatchObject({ generation: 3, state: 'committed' });
    expect(fetchResource(h).status).toBe(200);
  });

  test('a committed generation whose regenerated body differs from the record is not served (503)', async () => {
    h = await createHarness({ nodeResource: 'loopback' });
    h.revoke(['loopback_publish_crash']);
    await h.idle();
    insertDeployment(h, 3, { digest: h.files.digestContent('# SFE managed resource · generation 3\nSFE-OTHER = reject\n') });
    writeServedPointer(h.app.engine.kv, { committed: { generation: 3 }, candidate: null });
    writeNeedsRefresh(h.app.engine.kv, null);
    await h.crash();
    await h.idle();
    expect(h.app.engine.resource!.served()).toBeNull();
    expect(fetchResource(h).status).toBe(503);
    expect(h.logs.some((l) => l.includes('"msg":"resource.regenerate_failed"'))).toBe(true);
    expect(readNeedsRefresh(h.app.engine.kv)).toEqual({ generation: 3, reason: 'regenerate_failed' });
  });
});

describe('audit before listening', () => {
  async function downWhileSurgeFetches(x: Harness, fault: Parameters<Harness['resourceFault']>[0]): Promise<void> {
    // 服务停止（执行器停止、监听已关闭），另一个进程在这期间答复了 Surge 的一次下载（显式更新或定时刷新）
    await x.app.stop();
    await x.app.engine.resource!.close();
    x.clock.advance(30_000);
    x.resourceFault(fault, { times: 1 });
    await x.fake.updateExternalResource(x.resourceKey()!).catch(() => undefined);
    x.resourceFault(null);
  }

  test('a download answered by another process while the service was down → tokenSuspect before listening, the token is refused, the warning is raised', async () => {
    h = await createHarness({ nodeResource: 'loopback' });
    await h.idle();
    await downWhileSurgeFetches(h, { kind: 'squat', status: 200, body: resourceBody(0, ['SFE-SQUAT = socks5, 192.0.2.66, 1080']) });
    expect((await ourResource(h))!.error).toBeNull();
    const from = h.logs.length;
    await h.crash();
    await h.idle();
    const kv = h.app.engine.kv;
    expect(readTokenSuspect(kv)).toMatchObject({ reason: 'unexplained_fetch' });
    expect(logIndex(h, 'resource.audit_unexplained', from)).toBeGreaterThan(from - 1);
    expect(logIndex(h, 'resource.audit_unexplained', from)).toBeLessThan(logIndex(h, 'resource.listening', from));
    // 令牌正确的请求也得到统一的 404
    expect(h.app.engine.resource!.listening()).toBe(true);
    expect(fetchResource(h).status).toBe(404);
    expect(h.repos.routeState.get().warnings).toContain('node_resource_unverified');
    expect(readNeedsRefresh(kv)).not.toBeNull();
    expect(h.app.views.snapshot('0.0.0-test', false).surge.nodeResource).toMatchObject({ state: 'serving', tokenSuspect: true });
  });

  test('an HTTP error answered by another process while down → unexplained_error → tokenSuspect', async () => {
    h = await createHarness({ nodeResource: 'loopback' });
    await h.idle();
    await downWhileSurgeFetches(h, { kind: 'squat', status: 404, body: '' });
    expect((await ourResource(h))!.error).not.toBeNull();
    await h.crash();
    await h.idle();
    expect(readTokenSuspect(h.app.engine.kv)).toMatchObject({ reason: 'unexplained_error' });
    expect(h.repos.routeState.get().warnings).toContain('node_resource_unverified');
  });

  test('regression: a never-loaded resource (empty Surge cache): a 404 answered by another process while the service was down is still found (the error text, not a bare not_ready)', async () => {
    h = await createHarness({ nodeResource: 'loopback', surgeCache: 'empty' });
    // 系统刷新停泊：Surge 中的资源保持从未下载成功
    h.revoke(['loopback_publish_crash']);
    await h.idle();
    expect((await ourResource(h))!.lastUpdatedAt).toBeNull();
    await downWhileSurgeFetches(h, { kind: 'squat', status: 404, body: '' });
    const r = (await ourResource(h))!;
    expect(r.lastUpdatedAt).toBeNull();
    expect(r.error).toBe(FAKE_REMOTE_ERRORS.status(404));
    await h.crash();
    await h.idle();
    expect(readTokenSuspect(h.app.engine.kv)).toMatchObject({ reason: 'unexplained_error' });
  });

  test('regression: our own 503 shortly before a clean stop is audited at stop, so the startup audit after the restart does not flag it', async () => {
    h = await createHarness({ nodeResource: 'loopback' });
    await createEnv(h, 'US-Buyer-A', '203.0.113.10');
    await h.idle();
    // resourceServe 门槛失效：本服务不再提供（503），Surge 的定时刷新得到 503；之后很快正常停止（还没有对账）
    h.app.engine.resource!.unload();
    h.clock.advance(1_000);
    await h.fake.updateExternalResource(h.resourceKey()!).catch(() => undefined);
    expect((await ourResource(h))!.error).toBe(FAKE_REMOTE_ERRORS.status(503));
    await h.app.stop();
    await h.app.engine.resource!.close();
    await h.crash();
    await h.idle();
    expect(readTokenSuspect(h.app.engine.kv)).toBeNull();
    expect(h.logs.some((l) => l.includes('"msg":"resource.audit_unexplained"'))).toBe(false);
  });

  test('connection refused while the service was down is explained: no tokenSuspect, no warning', async () => {
    h = await createHarness({ nodeResource: 'loopback' });
    await h.idle();
    await downWhileSurgeFetches(h, { kind: 'refused' });
    expect((await ourResource(h))!.error).not.toBeNull();
    await h.crash();
    await h.idle();
    expect(readTokenSuspect(h.app.engine.kv)).toBeNull();
    expect(h.repos.routeState.get().warnings).not.toContain('node_resource_unverified');
    expect(fetchResource(h).status).toBe(200);
  });

  test('regression: a squatter that takes the token and never answers (Surge times out) while the service was down → unexplained_error → tokenSuspect, the token is refused', async () => {
    h = await createHarness({ nodeResource: 'loopback' });
    await h.idle();
    await h.app.stop();
    await h.app.engine.resource!.close();
    h.clock.advance(30_000);
    // 另一个进程接受了连接、读到了带读取令牌的请求却不答复：Surge 等到超时（2026-10-25 矩阵“服务不发送响应” → -1001）
    const orig = h.fake.remoteSource;
    h.fake.remoteSource = () => ({ kind: 'no_response' });
    await h.fake.updateExternalResource(h.resourceKey()!).catch(() => undefined);
    h.fake.remoteSource = orig;
    expect((await ourResource(h))!.error).toBe(FAKE_REMOTE_ERRORS.timeout);
    const from = h.logs.length;
    await h.crash();
    await h.idle();
    expect(readTokenSuspect(h.app.engine.kv)).toMatchObject({ reason: 'unexplained_error' });
    expect(logIndex(h, 'resource.audit_unexplained', from)).toBeLessThan(logIndex(h, 'resource.listening', from));
    // 之后占用者拿着令牌来取：统一的 404，从不提供凭据
    expect(fetchResource(h).status).toBe(404);
    expect(h.repos.routeState.get().warnings).toContain('node_resource_unverified');
  });

  test('regression: Surge relaunched with its cache dropped and the first download not done yet (bare not_ready) is not a token leak', async () => {
    h = await createHarness({ nodeResource: 'loopback', fakeRemote: { remoteCacheOnRestart: 'drop' } });
    await h.idle();
    await h.app.runPeriodicReconcile();
    // 加载时的那次下载要 60 秒才完成：期间 Surge 报告 not_ready、没有更新时间
    h.fake.slowUpdate = { durationMs: 60_000 };
    h.fake.restart();
    const r = (await ourResource(h))!;
    expect(r).toMatchObject({ error: 'not_ready', lastUpdatedAt: null, updating: true });
    const from = h.logs.length;
    await h.app.runPeriodicReconcile();
    expect(readTokenSuspect(h.app.engine.kv)).toBeNull();
    expect(logIndex(h, 'resource.audit_unexplained', from)).toBe(-1);
    // 下载完成（由本服务答复）：审计与本服务的记录对上，仍然没有令牌可疑
    h.fake.slowUpdate = null;
    h.clock.advance(61_000);
    await h.app.runPeriodicReconcile();
    expect((await ourResource(h))!.error).toBeNull();
    expect(readTokenSuspect(h.app.engine.kv)).toBeNull();
    expect(logIndex(h, 'resource.audit_unexplained', from)).toBe(-1);
  });

  /** 停止期间占用端口的一方答复了 Surge 的一次下载（伪造的列表），之后重启时 Surge 的外部资源读两次都失败（启动审计与启动对账）。 */
  async function squatThenRestartUnreadable(x: Harness): Promise<void> {
    await downWhileSurgeFetches(x, { kind: 'squat', status: 200, body: resourceBody(0, ['SFE-SQUAT = socks5, 192.0.2.66, 1080']) });
    x.fake.failNext('listExternalResources');
    x.fake.failNext('listExternalResources');
    await x.crash();
    await x.idle();
  }

  test('regression: the startup audit could not read Surge → the service does not listen until an audit succeeds; Surge\'s next fetch is refused, so the squatter\'s fetch is still found', async () => {
    // temp_rule：读入口不读外部资源，外部资源只由启动审计与节点资源检查读取
    h = await createHarness({ nodeResource: 'loopback', entryStrategy: 'temp_rule' });
    await h.idle();
    await squatThenRestartUnreadable(h);
    const engine = h.app.engine;
    expect(engine.resource!.listening()).toBe(false);
    expect(h.logs.some((l) => l.includes('"msg":"resource.listen_deferred"'))).toBe(true);
    // 推迟期间 Surge 的下载得到连接被拒绝（不会被本服务的下载覆盖证据）
    await h.fake.updateExternalResource(h.resourceKey()!).catch(() => undefined);
    expect((await ourResource(h))!.error).toBe(FAKE_REMOTE_ERRORS.refused);
    // 能读到外部资源的对账：先按“没有一直监听”审计，发现停止期间的下载，之后才监听；令牌正确的请求得到 404
    await h.app.runPeriodicReconcile();
    expect(readTokenSuspect(engine.kv)).toMatchObject({ reason: 'unexplained_fetch' });
    expect(engine.resource!.listening()).toBe(true);
    expect(fetchResource(h).status).toBe(404);
    expect(h.repos.routeState.get().warnings).toContain('node_resource_unverified');
  });

  test('regression: the startup audit could not read Surge → a publish before the next audit parks (not listening) instead of overwriting the evidence', async () => {
    h = await createHarness({ nodeResource: 'loopback', entryStrategy: 'temp_rule' });
    await h.idle();
    await squatThenRestartUnreadable(h);
    const updates = h.fake.calls.updateExternalResource ?? 0;
    const b = await createEnv(h, 'US-Buyer-B', '203.0.113.11');
    expect(h.repos.operations.get(b.operation_id)).toMatchObject({ phase: 'WAITING_DEPLOYMENT', status: 'parked', error: { code: 'RESOURCE_SERVER_UNAVAILABLE' } });
    expect((h.fake.calls.updateExternalResource ?? 0) - updates).toBe(0);
    await h.app.runPeriodicReconcile();
    expect(readTokenSuspect(h.app.engine.kv)).toMatchObject({ reason: 'unexplained_fetch' });
    // 占用者拿着之前收到的令牌来取：统一的 404，从不提供凭据
    expect(fetchResource(h).status).toBe(404);
  });

  test('regression: a publish audits the state it reads before the update: an unexplained fetch since the last audit parks it (token suspect), the update is never sent and the evidence is not overwritten', async () => {
    h = await createHarness({ nodeResource: 'loopback' });
    await h.idle();
    await createEnv(h, 'US-Buyer-A', '203.0.113.10');
    // 上一次审计之后 Surge 载入了本服务没有提供过的内容（没有对应的审计记录），之后还没有对账
    h.clock.advance(5_000);
    h.fake.seedRemoteCache(h.resourceUrl()!, resourceBody(0, ['SFE-SQUAT = socks5, 192.0.2.66, 1080']), { updatedAt: h.clock.now() });
    const updates = h.fake.calls.updateExternalResource ?? 0;
    const b = await createEnv(h, 'US-Buyer-B', '203.0.113.11');
    const op = h.repos.operations.get(b.operation_id)!;
    expect(op).toMatchObject({ phase: 'WAITING_DEPLOYMENT', status: 'parked', error: { code: 'RESOURCE_SERVER_UNAVAILABLE', details: { reason: 'token_suspect' } } });
    expect((h.fake.calls.updateExternalResource ?? 0) - updates).toBe(0);
    expect(readTokenSuspect(h.app.engine.kv)).toMatchObject({ reason: 'unexplained_fetch' });
    expect(h.repos.routeState.get().warnings).toContain('node_resource_unverified');
    expect(fetchResource(h).status).toBe(404);
  });

  test('an auditState row that exists but cannot be read → warning and needsRefresh, never tokenSuspect; re-initialised only by a confirmed readback', async () => {
    h = await createHarness({ nodeResource: 'loopback' });
    h.revoke(['loopback_publish_crash']);
    await h.idle();
    const kv = h.app.engine.kv;
    writeNeedsRefresh(kv, null);
    kv.set(RESOURCE_KV_KEYS.auditState, { verifiedUpdatedAt: null, verifiedError: null, auditedSeq: 1 });
    await h.crash();
    await h.idle();
    expect(h.repos.routeState.get().warnings).toContain('node_resource_unverified');
    expect(readTokenSuspect(kv)).toBeNull();
    expect(readNeedsRefresh(kv)).toEqual({ generation: 0, reason: 'audit_state_unreadable' });
    // 对账不重新初始化它
    await h.app.runPeriodicReconcile();
    expect(readAuditState(kv)).toBeNull();
    expect(kv.has(RESOURCE_KV_KEYS.auditState)).toBe(true);
    // 经确认的读回（一次真正的发布：单 key 更新并读回）之后重新初始化并清除警告
    h.grant(['loopback_publish_crash']);
    const p = await h.app.publishPending({ request_id: rid('publish') }, WEB);
    await h.idle();
    expect(h.repos.operations.get(p.operation_id)).toMatchObject({ phase: 'COMPLETED', status: 'succeeded' });
    expect(readAuditState(kv)).not.toBeNull();
    expect(readNeedsRefresh(kv)).toBeNull();
    expect(h.repos.routeState.get().warnings).not.toContain('node_resource_unverified');
  });
});

describe('the resourceServe records revoked while a generation > 0 is served', () => {
  test('regression: reset of loopback_resource_auth while Surge is unreachable → the committed credentials are no longer served (503) at once', async () => {
    h = await createHarness({ nodeResource: 'loopback' });
    await createEnv(h, 'US-Buyer-A', '203.0.113.10');
    await h.idle();
    expect(fetchResource(h).status).toBe(200);
    expect(h.app.engine.resource!.served()).toMatchObject({ generation: 1, state: 'committed' });
    h.fake.reachable = false;
    await h.app.confirmCapability({ request_id: rid('cap'), action: 'reset', key: 'loopback_resource_auth', note: null }, WEB);
    expect(fetchResource(h).status).toBe(503);
    expect(readNeedsRefresh(h.app.engine.kv)).toMatchObject({ generation: 1, reason: 'serve_gated' });
    // Surge 仍不可达的对账不恢复提供
    await h.app.runPeriodicReconcile();
    expect(fetchResource(h).status).toBe(503);
  });

  test('regression: records revoked while the working profile no longer points at our address → the next reconcile stops serving generation > 0', async () => {
    h = await createHarness({ nodeResource: 'loopback' });
    await createEnv(h, 'US-Buyer-A', '203.0.113.10');
    await h.idle();
    expect(fetchResource(h).status).toBe(200);
    // 节点组定义被改成另一个回环地址（不再是本服务当前的）
    const text = readFileSync(h.profilePath, 'utf8');
    writeFileSync(h.profilePath, text.replace(h.app.engine.resource!.token, 'c'.repeat(64)));
    h.revoke(['loopback_resource_auth']);
    await h.app.runPeriodicReconcile();
    expect(fetchResource(h).status).toBe(503);
  });
});

describe('listen', () => {
  test('port in use while the profile references our URL → tokenSuspect and the warning; listening is retried on each reconcile tick', async () => {
    h = await createHarness({ nodeResource: 'loopback' });
    await h.idle();
    await h.app.engine.resource!.close();
    h.binderRegistry.set(h.resourcePort, 'other-process');
    await h.crash();
    await h.idle();
    const engine = h.app.engine;
    expect(engine.resource!.listening()).toBe(false);
    expect(h.logs.some((l) => l.includes('"msg":"resource.listen_failed"') && l.includes('"reason":"port_in_use"'))).toBe(true);
    expect(readTokenSuspect(engine.kv)).toMatchObject({ reason: 'port_in_use' });
    expect(h.repos.routeState.get().warnings).toContain('node_resource_unverified');
    // 警告总是带着刷新要求（网页据此提供“重新同步节点资源”）
    expect(h.app.views.snapshot('0.0.0-test', false).surge.nodeResource).toEqual({ state: 'not_listening', tokenSuspect: true, needsRefresh: true });
    h.binderRegistry.delete(h.resourcePort);
    await h.app.runPeriodicReconcile();
    expect(engine.resource!.listening()).toBe(true);
    expect(h.logs.some((l) => l.includes('"msg":"resource.listen_restored"'))).toBe(true);
    // 令牌可疑与警告是粘性的：只有轮换资源地址与经确认的读回能清除
    expect(readTokenSuspect(engine.kv)).not.toBeNull();
    expect(fetchResource(h).status).toBe(404);
    expect(h.repos.routeState.get().warnings).toContain('node_resource_unverified');
  });

  test('Surge unreachable at startup with a committed generation it cannot serve yet: listening waits for Surge, so its own 503 is never mistaken for another process', async () => {
    h = await createHarness({ nodeResource: 'loopback' });
    await h.idle();
    insertDeployment(h, 3);
    writeServedPointer(h.app.engine.kv, { committed: { generation: 3 }, candidate: null });
    // Mac 重启：本服务先于 Surge 启动
    h.fake.reachable = false;
    await h.crash();
    await h.idle();
    const engine = h.app.engine;
    expect(engine.resource!.served()).toBeNull();
    expect(engine.resource!.listening()).toBe(false);
    expect(h.logs.some((l) => l.includes('"msg":"resource.listen_deferred"'))).toBe(true);
    await h.app.runPeriodicReconcile();
    expect(engine.resource!.listening()).toBe(false);
    expect(h.repos.routeState.get().warnings).not.toContain('node_resource_unverified');
    // Surge 启动后下载一次：没有监听，连接被拒绝（保留旧资源）
    h.fake.reachable = true;
    await expect(h.fake.updateExternalResource(h.resourceKey()!)).rejects.toThrow();
    // Surge 可达的对账：按读到的版本重新判定门槛并加载第 3 代，然后监听、审计——拒绝连接总能解释
    await h.app.runPeriodicReconcile();
    expect(engine.resource!.served()).toMatchObject({ generation: 3, state: 'committed' });
    expect(engine.resource!.listening()).toBe(true);
    expect(readTokenSuspect(engine.kv)).toBeNull();
    // 之后的下载由本服务答复，审计照常
    h.clock.advance(1_000);
    await h.fake.updateExternalResource(h.resourceKey()!);
    await h.app.runPeriodicReconcile();
    expect(readTokenSuspect(engine.kv)).toBeNull();
    expect(h.repos.routeState.get().warnings).not.toContain('node_resource_unverified');
  });

  test('after stop, a reconcile still in flight never re-listens the closed host', async () => {
    h = await createHarness({ nodeResource: 'loopback' });
    await h.idle();
    const engine = h.app.engine;
    await h.app.stop();
    await engine.resource!.close();
    await reconcile(engine, 'refresh');
    expect(engine.resource!.listening()).toBe(false);
    expect(h.binderRegistry.has(h.resourcePort)).toBe(false);
  });

  test('port in use with the legacy line: logged, no tokenSuspect', async () => {
    h = await createHarness({ nodeResource: 'legacy' });
    await h.idle();
    await h.app.engine.resource!.close();
    h.binderRegistry.set(h.resourcePort, 'other-process');
    await h.crash();
    await h.idle();
    expect(h.app.engine.resource!.listening()).toBe(false);
    expect(h.logs.some((l) => l.includes('"msg":"resource.listen_failed"'))).toBe(true);
    expect(readTokenSuspect(h.app.engine.kv)).toBeNull();
    expect(h.repos.routeState.get().warnings).not.toContain('node_resource_unverified');
  });
});

describe('confirmNodeResource', () => {
  test('clears the warning, needsRefresh and the system refresh record and advances the audit state in one step; keeps the warning while the token is suspect', async () => {
    h = await createHarness({ nodeResource: 'loopback' });
    await h.idle();
    const engine = h.app.engine;
    h.repos.routeState.update({ warnings: ['node_resource_unverified'] });
    // Surge 再次下载已提交的第 0 代（本服务答复），读回匹配
    const mark = engine.resource!.auditMark();
    h.clock.advance(5_000);
    await h.fake.updateExternalResource(h.resourceKey()!);
    const r = (await ourResource(h))!;
    const matched = matchAuditRecord(engine.resource!.audit(), r.lastUpdatedAt!, engine.resourceAuditToleranceMs(), mark, 0)!;
    expect(matched).not.toBeNull();
    const result = confirmNodeResource(engine, { generation: 0, matchedSeq: matched.seq, snapshot: { updatedAt: r.lastUpdatedAt, error: r.error }, clearNeedsRefresh: true });
    expect(result.warningCleared).toBe(true);
    expect(h.repos.routeState.get().warnings).not.toContain('node_resource_unverified');
    expect(readNeedsRefresh(engine.kv)).toBeNull();
    expect(engine.kv.get(SYSTEM_REFRESH_KEY)).toBeNull();
    expect(readAuditState(engine.kv)).toEqual({ verifiedUpdatedAt: r.lastUpdatedAt!.toISOString(), verifiedError: null, auditedSeq: matched.seq, windowSeq: matched.seq });
    // 之后的对账审计为 ok：不再报警
    await h.app.runPeriodicReconcile();
    expect(h.repos.routeState.get().warnings).not.toContain('node_resource_unverified');
    // 令牌可疑时保留警告；不是已提交的代数时拒绝
    h.repos.routeState.update({ warnings: ['node_resource_unverified'] });
    engine.kv.set(RESOURCE_KV_KEYS.tokenSuspect, { since: h.clock.now().toISOString(), reason: 'port_in_use' });
    expect(confirmNodeResource(engine, { generation: 0, matchedSeq: matched.seq, snapshot: { updatedAt: r.lastUpdatedAt, error: null }, clearNeedsRefresh: false }).warningCleared).toBe(false);
    expect(h.repos.routeState.get().warnings).toContain('node_resource_unverified');
    expect(() => confirmNodeResource(engine, { generation: 5, matchedSeq: matched.seq, snapshot: { updatedAt: r.lastUpdatedAt, error: null }, clearNeedsRefresh: true })).toThrow();
    expect(LOOPBACK_CAPS).toHaveLength(4);
  });
});

describe('remerge rotation option', () => {
  test('rotateResourceUrl reaches the remerge preview (rotation check, no token or port generated); a non-boolean value is refused', async () => {
    h = await createHarness({ nodeResource: 'loopback' });
    await h.idle();
    const p = await h.app.remergePreview(WEB, { rotateResourceUrl: true });
    expect(p.checks.find((c) => c.name === 'rotate')).toMatchObject({ ok: true });
    expect(h.repos.meta.resourceTokenRef()).toBe('sfe.resource-token.1');
    expect(h.repos.settings.get('resourcePort')).toBe(h.resourcePort);
    await expect(h.app.remergeCommit({ request_id: rid('remerge'), preview_digest: 'x', rotateResourceUrl: true }, WEB)).rejects.toMatchObject({ code: 'PREVIEW_STALE' });
    await expect(h.app.remergePreview(WEB, { rotateResourceUrl: 'yes' as unknown as boolean })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});
