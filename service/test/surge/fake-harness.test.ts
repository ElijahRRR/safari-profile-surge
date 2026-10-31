// 引擎测试夹具中假 Surge 与本机资源服务的接线（D10）：两种节点资源模式、固定端口、virtualBinder、FakeSurge 下载经资源服务的
// 真实 handle()、h.resourceFault 的各类故障、crash() 先关闭旧的资源服务、能力授予。夹具本身不创建引擎的资源服务（那是引擎
// 启动的职责）：这里在不启动引擎时手动装上一个，与引擎是否已接入资源服务无关。只用合成数据。

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { CAPABILITY_GATES, EMPTY_PLACEHOLDER_NODE, LEGACY_NODE_GROUP_LINE, NODE_RESOURCE_FILE, parseNodeResourceUrl } from '@sfe/contract';
import { createResourceHost, loadResourceToken, type ResourceHost } from '../../src/resource/index.js';
import { FAKE_REMOTE_ERRORS } from '../../src/surge/fake.js';
import { loopbackGroupBlockLines, nodeLine, resourceBody } from '../../src/surge/generate.js';
import { LOOPBACK_CAPS, RESOURCE_TEST_PORT, createHarness, type Harness, type HarnessOptions } from '../engine/harness.js';
import { recordingLogger } from '../resource/helpers.js';

const A = 'SFE-N-E0001-US01-v001';
const LINE_A = nodeLine({ name: A, host: '203.0.113.11', port: 1080, username: null, password: null, front: 'Front-A' });

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

/** 不启动引擎的 loopback 夹具，装上一个用同一令牌、同一绑定方的资源服务（正在提供第 0 代）。 */
async function loopbackWithHost(opts: HarnessOptions = {}): Promise<{ h: Harness; host: ResourceHost; key: string }> {
  h = await createHarness({ nodeResource: 'loopback', start: false, ...opts });
  const token = await loadResourceToken(h.store, h.repos.meta);
  const host = createResourceHost({ token, clock: h.clock, logger: recordingLogger(), binder: h.binder });
  host.configure(h.resourcePort);
  await host.listen();
  host.loadCommitted({ generation: 0, content: resourceBody(0, []) });
  h.app.engine.resource = host;
  return { h, host, key: h.resourceKey()! };
}

const ours = async (hh: Harness, key: string) => (await hh.fake.listExternalResources()).find((r) => r.key === key)!;

describe('harness node resource modes', () => {
  test('loopback is the default; legacy mode: local group line, fixed resource port, virtual binder, no remote fetches', async () => {
    h = await createHarness();
    expect(h.nodeResource).toBe('loopback');
    await h.close();
    h = await createHarness({ nodeResource: 'legacy' });
    expect(h.nodeResource).toBe('legacy');
    expect(readFileSync(h.profilePath, 'utf8')).toContain(LEGACY_NODE_GROUP_LINE);
    expect(existsSync(join(h.surgeDir, NODE_RESOURCE_FILE))).toBe(true);
    expect(h.repos.settings.get('resourcePort')).toBe(RESOURCE_TEST_PORT);
    expect(h.resourcePort).toBe(RESOURCE_TEST_PORT);
    expect(h.profileResourceUrl).toBeNull();
    expect(h.app.engine.deps.resourceBinder).toBe(h.binder);
    expect(h.app.engine.resourceUpdateWait()).toEqual({ timeoutMs: 0, pollMs: 0, settleMs: 0 });
    expect(h.resourceRequests).toEqual([]);
  });

  test('loopback: the working profile points at the URL from the product token and the fixed port; Surge already holds generation 0', async () => {
    h = await createHarness({ nodeResource: 'loopback' });
    const url = h.profileResourceUrl!;
    const token = await loadResourceToken(h.store, h.repos.meta);
    expect(parseNodeResourceUrl(url)).toEqual({ port: RESOURCE_TEST_PORT, token });
    expect(readFileSync(h.profilePath, 'utf8')).toContain(`# SFE-BEGIN group v1\n${loopbackGroupBlockLines(url)[0]}\n# SFE-END group`);
    expect(existsSync(join(h.surgeDir, NODE_RESOURCE_FILE))).toBe(false);
    expect(h.fake.watchLocalPolicyPaths).toBe(false);
    // 引擎接入资源服务之前 resourceUrl 为 null；接入之后必须等于工作配置中的地址（夹具在启动后核对）
    expect([null, url]).toContain(h.resourceUrl());
    // 初始化时的重载已下载第 0 代：构造时不下载
    const key = h.fake.resourceKeyFor(url);
    expect(h.fake.remoteFetches.filter((f) => f.trigger === 'load')).toEqual([]);
    expect((await ours(h, key))).toMatchObject({ error: null, lastUpdatedAt: new Date(Date.parse('2026-10-21T00:00:00.000Z') - 60_000) });
    expect(await h.fake.getGroupMembers('SFE-ROUTE')).toEqual(['REJECT', EMPTY_PLACEHOLDER_NODE]);
  });

  test("loopback with surgeCache 'empty': no sfe-nodes.list; Surge starts not ready after a refused download", async () => {
    h = await createHarness({ nodeResource: 'loopback', surgeCache: 'empty' });
    const url = h.profileResourceUrl!;
    const token = await loadResourceToken(h.store, h.repos.meta);
    expect(parseNodeResourceUrl(url)).toEqual({ port: RESOURCE_TEST_PORT, token });
    expect(readFileSync(h.profilePath, 'utf8')).toContain(`# SFE-BEGIN group v1\n${loopbackGroupBlockLines(url)[0]}\n# SFE-END group`);
    expect(existsSync(join(h.surgeDir, NODE_RESOURCE_FILE))).toBe(false);
    expect(h.fake.watchLocalPolicyPaths).toBe(false);
    // 引擎接入资源服务之前 resourceUrl 为 null；接入之后必须等于工作配置中的地址（夹具在启动后核对）
    expect([null, url]).toContain(h.resourceUrl());
    // 构造 FakeSurge 时（引擎尚未监听）的下载被拒绝
    expect(h.resourceRequests[0]).toMatchObject({ port: RESOURCE_TEST_PORT, fault: null, result: 'refused', status: null });
    expect(h.fake.remoteFetches[0]).toMatchObject({ key: h.fake.resourceKeyFor(url), trigger: 'load', error: FAKE_REMOTE_ERRORS.refused });
    expect(JSON.stringify([h.resourceRequests, h.fake.remoteFetches])).not.toContain(token);
  });

  test('loopback downloads pass through the installed host: resourceUrl/resourceKey follow the engine, audit records complete', async () => {
    const { h: hh, host, key } = await loopbackWithHost();
    expect(hh.resourceUrl()).toBe(hh.profileResourceUrl);
    expect(key).toBe(hh.fake.resourceKeyFor(hh.profileResourceUrl!));
    await hh.fake.updateExternalResource(key);
    expect(await hh.fake.getGroupMembers('SFE-ROUTE')).toEqual(['REJECT', EMPTY_PLACEHOLDER_NODE]);
    expect(host.audit()).toMatchObject([{ generation: 0, complete: true }]);
    expect(hh.resourceRequests.at(-1)).toMatchObject({ port: RESOURCE_TEST_PORT, fault: null, result: 'http', status: 200 });
  });

  test('withholdLoopbackCapabilities leaves the four loopback keys unrecorded; the default grants every publish and resourceServe key', async () => {
    h = await createHarness({ start: false });
    for (const key of [...CAPABILITY_GATES.publish, ...CAPABILITY_GATES.resourceServe]) expect(h.repos.capabilities.get(key)?.status, key).toBe('supported');
    await h.close();
    h = await createHarness({ start: false, withholdLoopbackCapabilities: true });
    for (const key of LOOPBACK_CAPS) expect(h.repos.capabilities.get(key)?.status ?? 'unverified', key).not.toBe('supported');
    expect(h.repos.capabilities.get('external_node_underlying_proxy')?.status).toBe('supported');
    expect(h.repos.capabilities.get('connection_continuity')?.status).toBe('supported');
  });

  test('fakeRemote options and update wait overrides reach FakeSurge and the engine', async () => {
    h = await createHarness({ nodeResource: 'loopback', start: false, fakeRemote: { urlKeys: true, remoteCacheOnRestart: 'drop' }, resourceUpdateWait: { timeoutMs: 1_000, pollMs: 100, settleMs: 0 }, resourceAuditToleranceMs: 2_000 });
    expect(h.fake.resourceKeyFor(h.profileResourceUrl!)).toBe(`policy-path:${h.profileResourceUrl!}`);
    expect(h.fake.remoteCacheOnRestart).toBe('drop');
    expect(h.app.engine.resourceUpdateWait()).toEqual({ timeoutMs: 1_000, pollMs: 100, settleMs: 0 });
    expect(h.app.engine.resourceAuditToleranceMs()).toBe(2_000);
  });
});

describe('harness resource faults', () => {
  test('http: the host accepts and records (incomplete), Surge sees the status; times limits the fault', async () => {
    const { h: hh, host, key } = await loopbackWithHost();
    await hh.fake.updateExternalResource(key);
    hh.resourceFault({ kind: 'http', status: 500 }, { times: 1 });
    await expect(hh.fake.updateExternalResource(key)).rejects.toThrow(FAKE_REMOTE_ERRORS.status(500));
    expect(host.audit().map((r) => r.complete)).toEqual([true, false]);
    expect((await ours(hh, key)).error).toBe(FAKE_REMOTE_ERRORS.status(500));
    expect(hh.resourceRequests.at(-1)).toMatchObject({ fault: 'http', result: 'http', status: 500 });
    await hh.fake.updateExternalResource(key);
    expect((await ours(hh, key)).error).toBeNull();
    expect(host.audit().map((r) => r.complete)).toEqual([true, false, true]);
  });

  test.each([
    { kind: 'reset' as const, attempts: 6, text: FAKE_REMOTE_ERRORS.interrupted },
    { kind: 'truncated' as const, attempts: 2, text: FAKE_REMOTE_ERRORS.interrupted },
    { kind: 'no_response' as const, attempts: 2, text: FAKE_REMOTE_ERRORS.timeout },
  ])('$kind reaches the host on every attempt and leaves incomplete records; Surge keeps its cache', async ({ kind, attempts, text }) => {
    const { h: hh, host, key } = await loopbackWithHost();
    await hh.fake.updateExternalResource(key);
    hh.resourceFault({ kind });
    await expect(hh.fake.updateExternalResource(key)).rejects.toThrow(text);
    expect(host.audit().filter((r) => !r.complete)).toHaveLength(attempts);
    expect(hh.resourceRequests.filter((r) => r.fault === kind)).toHaveLength(attempts);
    expect(await hh.fake.getGroupMembers('SFE-ROUTE')).toEqual(['REJECT', EMPTY_PLACEHOLDER_NODE]);
    hh.resourceFault(null);
    await hh.fake.updateExternalResource(key);
    expect((await ours(hh, key)).error).toBeNull();
  });

  test('refused never reaches the host; squat bypasses it and Surge loads what the squatter served', async () => {
    const { h: hh, host, key } = await loopbackWithHost();
    await hh.fake.updateExternalResource(key);
    const counters = host.failureCounters();
    hh.resourceFault({ kind: 'refused' }, { times: 1 });
    await expect(hh.fake.updateExternalResource(key)).rejects.toThrow(FAKE_REMOTE_ERRORS.refused);
    expect(host.failureCounters()).toEqual(counters);
    expect(host.audit()).toHaveLength(1);

    hh.resourceFault({ kind: 'squat', status: 200, body: resourceBody(9, [LINE_A]) });
    await hh.fake.updateExternalResource(key);
    expect(await hh.fake.getGroupMembers('SFE-ROUTE')).toEqual(['REJECT', A]);
    expect(host.audit()).toHaveLength(1);
    expect(hh.resourceRequests.at(-1)).toMatchObject({ fault: 'squat', result: 'http', status: 200 });
    hh.resourceFault({ kind: 'squat', status: 404, body: '' });
    await expect(hh.fake.updateExternalResource(key)).rejects.toThrow(FAKE_REMOTE_ERRORS.status(404));
    expect(host.failureCounters()).toEqual(counters);
  });

  test('a server-side fault while the host is not listening has no effect and is not consumed', async () => {
    const { h: hh, host, key } = await loopbackWithHost();
    await host.close();
    hh.resourceFault({ kind: 'http', status: 500 }, { times: 1 });
    await expect(hh.fake.updateExternalResource(key)).rejects.toThrow(FAKE_REMOTE_ERRORS.refused);
    expect(hh.resourceRequests.at(-1)).toMatchObject({ fault: null, result: 'refused' });
    await host.listen();
    await expect(hh.fake.updateExternalResource(key)).rejects.toThrow(FAKE_REMOTE_ERRORS.status(500));
    await hh.fake.updateExternalResource(key);
    expect(() => hh.resourceFault({ kind: 'reset' }, { times: 0 })).toThrow(RangeError);
  });

  test('a port held by another process: the binder refuses a second bind; requests are refused unless a squat answers', async () => {
    h = await createHarness({ nodeResource: 'loopback', start: false });
    h.binderRegistry.set(RESOURCE_TEST_PORT, 'another-process');
    const host = createResourceHost({ token: await loadResourceToken(h.store, h.repos.meta), clock: h.clock, logger: recordingLogger(), binder: h.binder });
    host.configure(h.resourcePort);
    await expect(host.listen()).rejects.toMatchObject({ code: 'RESOURCE_SERVER_UNAVAILABLE', details: { reason: 'port_in_use' } });
    const key = h.fake.resourceKeyFor(h.profileResourceUrl!);
    await expect(h.fake.updateExternalResource(key)).rejects.toThrow(FAKE_REMOTE_ERRORS.refused);
  });
});

describe('harness crash', () => {
  test('crash() closes the old instance’s resource host before the new instance starts', async () => {
    const { h: hh, host } = await loopbackWithHost();
    const old = hh.app;
    await hh.crash();
    expect(hh.app).not.toBe(old);
    expect(host.listening()).toBe(false);
    // 新实例接入资源服务之后，它的地址必须与工作配置相同（夹具已核对）；尚未接入时为 null
    expect([null, hh.profileResourceUrl]).toContain(hh.resourceUrl());
  });
});
