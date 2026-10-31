// 假 Surge 的远端节点资源（D10）：按回环矩阵的真机证据（docs/verification/2026-10-25-loopback-main-witness-matrix.md）
// 逐行核对单 key 更新的成功与失败语义、主配置见证（单 key 更新从不加载磁盘上改过的主配置、不碰其他资源）、定时刷新、重启
// 缓存、慢更新与“适配器超时而更新仍生效”，以及经真实资源服务处理程序（virtualBinder）的下载。只用合成数据：令牌
// 'a'.repeat(64)、RFC 5737 地址、example.test。

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { EMPTY_PLACEHOLDER_LINE, EMPTY_PLACEHOLDER_NODE, ENTRY_RULESET_FILES, NODE_RESOURCE_FILE, SfeError, nodeResourceUrl } from '@sfe/contract';
import { createResourceHost, matchAuditRecord, resourceLocationHash, virtualBinder } from '../../src/resource/index.js';
import {
  FAKE_CHROME_PATH,
  FAKE_REMOTE_ATTEMPTS,
  FAKE_REMOTE_ERRORS,
  FakeSurge,
  createFakeSurgeEnvironment,
  fakeOpaqueResourceKey,
  loopbackRemoteSource,
  loopbackResourceRequest,
  type FakeRemoteResponse,
  type FakeSurgeOptions,
} from '../../src/surge/fake.js';
import { loopbackGroupBlockLines, nodeLine, resourceBody } from '../../src/surge/generate.js';
import { parseResourceUpdateText } from '../../src/surge/parse-output.js';
import { canUseCliForResourceKey, resourceUpdateRoute } from '../../src/surge/resource-key.js';
import { recordingLogger } from '../resource/helpers.js';

const TOKEN = 'a'.repeat(64);
const PORT = 23456;
const URL = nodeResourceUrl(PORT, TOKEN);
/** 另一项远端资源（用户自己的组，另一个端口）：单 key 更新本应用资源时它不能变化。 */
const OTHER_URL = `http://127.0.0.1:${PORT + 1}/${'b'.repeat(64)}/other.list`;

const A = 'SFE-N-E0001-US01-v001';
const B = 'SFE-N-E0002-US01-v001';
const C = 'SFE-N-E0003-US01-v001';
const node = (name: string, host: string, extra: { front?: string; username?: string | null; port?: number } = {}) =>
  nodeLine({ name, host, port: extra.port ?? 1080, username: extra.username ?? null, password: null, front: extra.front ?? 'Front-A' });
const LINE_A = node(A, '203.0.113.11');
const LINE_B = node(B, '203.0.113.12');
const LINE_C = node(C, '203.0.113.13');
const body = (gen: number, lines: string[]) => resourceBody(gen, lines);

/** 可编排的资源服务：按地址给出当前答复（函数时每次请求调用一次），记录每次请求（不含地址）。 */
function scriptedServer() {
  const answers = new Map<string, FakeRemoteResponse | ((n: number) => FakeRemoteResponse)>();
  const requests: string[] = [];
  const source = (url: string): FakeRemoteResponse => {
    requests.push(url === URL ? 'ours' : url === OTHER_URL ? 'other' : 'unknown');
    const a = answers.get(url);
    if (a === undefined) return { kind: 'refused' };
    return typeof a === 'function' ? a(requests.length) : a;
  };
  return {
    source,
    requests,
    serve(lines: string[], gen = 1, url = URL) {
      answers.set(url, { kind: 'http', status: 200, body: body(gen, lines) });
    },
    answer(r: FakeRemoteResponse | ((n: number) => FakeRemoteResponse), url = URL) {
      answers.set(url, r);
    },
    stop(url = URL) {
      answers.delete(url);
    },
    count(which: 'ours' | 'other') {
      return requests.filter((r) => r === which).length;
    },
  };
}

let dir: string;
let t: number;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sfe-fake-remote-'));
  t = Date.parse('2026-10-25T00:00:00.000Z');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function setup(opts: Partial<FakeSurgeOptions> & { userRules?: string[]; otherGroup?: boolean } = {}) {
  const server = scriptedServer();
  const { userRules, otherGroup, ...fakeOpts } = opts;
  const env = createFakeSurgeEnvironment(dir, { resource: { url: URL }, ...(userRules ? { userRules } : {}) });
  if (otherGroup) {
    const text = readFileSync(env.profilePath, 'utf8').replace('# SFE-BEGIN group v1', `Other = select, DIRECT, policy-path=${OTHER_URL}\n# SFE-BEGIN group v1`);
    writeFileSync(env.profilePath, text);
  }
  const fake = new FakeSurge({ directory: dir, now: () => new Date(t), remoteSource: server.source, ...fakeOpts });
  const key = fake.resourceKeyFor(URL);
  const ours = async () => (await fake.listExternalResources()).find((r) => r.key === key)!;
  return { env, fake, server, key, ours };
}

/** 失败时的错误应与真实适配器对同一行文字的解析完全相同。 */
function adapterError(key: string, text: string): SfeError {
  try {
    parseResourceUpdateText(`${key}: ${text}`, key, (s) => s);
  } catch (e) {
    return e as SfeError;
  }
  throw new Error('expected a failure');
}

describe('loopback environment', () => {
  test('writes the loopback group line and no sfe-nodes.list; legacy stays available explicitly and by default', () => {
    const env = createFakeSurgeEnvironment(dir, { resource: { url: URL } });
    const text = readFileSync(env.profilePath, 'utf8');
    expect(text).toContain(`# SFE-BEGIN group v1\n${loopbackGroupBlockLines(URL)[0]}\n# SFE-END group`);
    expect(text).not.toContain('policy-path=sfe-nodes.list');
    expect(env.files).toEqual(Object.values(ENTRY_RULESET_FILES));
    expect(() => readFileSync(join(dir, NODE_RESOURCE_FILE))).toThrow();
    expect(env).toMatchObject({ nodeResource: 'loopback', remoteSource: null });

    const legacyDir = join(dir, 'legacy');
    const legacy = createFakeSurgeEnvironment(legacyDir, { legacy: true });
    expect(readFileSync(legacy.profilePath, 'utf8')).toContain('SFE-ROUTE = select, REJECT, policy-path=sfe-nodes.list');
    expect(legacy.files[0]).toBe(NODE_RESOURCE_FILE);
    expect(legacy.nodeResource).toBe('legacy');
    expect(createFakeSurgeEnvironment(join(dir, 'default')).nodeResource).toBe('legacy');
  });

  test('refuses conflicting options and a URL that is not ours', () => {
    expect(() => createFakeSurgeEnvironment(dir, { resource: { url: URL }, legacy: true })).toThrow(/mutually exclusive/);
    expect(() => createFakeSurgeEnvironment(dir, { resource: { url: 'https://nodes.example.test/a.list' } })).toThrow(SfeError);
  });

  test('request wires a remote source through the in-process binder (Host 127.0.0.1:<port>, loopback addresses)', async () => {
    const seen: unknown[] = [];
    const env = createFakeSurgeEnvironment(dir, {
      resource: {
        url: URL,
        request: (port, req) => {
          seen.push({ port, ...req });
          return { status: 200, headers: {}, body: Buffer.from(body(0, [])) };
        },
      },
    });
    const fake = new FakeSurge({ directory: dir, remoteSource: env.remoteSource! });
    expect(seen).toEqual([
      {
        port: PORT,
        method: 'GET',
        rawPath: `/${TOKEN}/${NODE_RESOURCE_FILE}`,
        rawHeaders: ['Host', `127.0.0.1:${PORT}`, 'User-Agent', 'Surge'],
        remoteAddress: '127.0.0.1',
        localAddress: '127.0.0.1',
      },
    ]);
    expect(await fake.getGroupMembers('SFE-ROUTE')).toEqual(['REJECT', EMPTY_PLACEHOLDER_NODE]);
  });

  test('loopbackRemoteSource maps ECONNREFUSED / ECONNRESET and treats non-loopback URLs as refused', () => {
    const err = (code: string) => () => {
      throw Object.assign(new Error(code), { code });
    };
    expect(loopbackRemoteSource(err('ECONNREFUSED'))(URL)).toEqual({ kind: 'refused' });
    expect(loopbackRemoteSource(err('ECONNRESET'))(URL)).toEqual({ kind: 'reset' });
    expect(() => loopbackRemoteSource(err('EOTHER'))(URL)).toThrow('EOTHER');
    const never = () => {
      throw new Error('must not be called');
    };
    for (const url of ['https://nodes.example.test/a.list', `http://localhost:${PORT}/x`, `http://127.0.0.1:70000/x`, 'http://127.0.0.1/x']) {
      expect(loopbackRemoteSource(never)(url), url).toEqual({ kind: 'refused' });
    }
    expect(loopbackResourceRequest(`http://127.0.0.1:${PORT}`)?.request.rawPath).toBe('/');
    expect(loopbackResourceRequest(`http://127.0.0.1:${PORT}/x?y=1#frag`)?.request.rawPath).toBe('/x?y=1');
  });
});

describe('listing: opaque keys, redacted location, location hash, readiness', () => {
  test('the key is opaque (first 32 hex of sha1) and safe for the CLI guard; location is redacted; the token appears nowhere', async () => {
    const { fake, key, ours, server } = setup();
    expect(key).toBe(fakeOpaqueResourceKey('policy-group', URL));
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    expect(canUseCliForResourceKey(key, TOKEN)).toBe(true);
    expect(resourceUpdateRoute(fake.mechanism(), key, TOKEN)).toEqual({ kind: 'fake' });
    server.serve([LINE_A]);
    await fake.updateExternalResource(key);
    expect(await ours()).toEqual({
      key,
      type: 'policy-group',
      location: `http://127.0.0.1:${PORT}/***`,
      locationHash: resourceLocationHash(URL),
      lastUpdatedAt: new Date(t),
      error: null,
      local: false,
      updating: false,
      fromModule: null,
    });
    const visible = JSON.stringify([await fake.listExternalResources(), fake.remoteFetches, fake.calls]);
    expect(visible).not.toContain(TOKEN);
  });

  test('urlKeys exposes the URL in the key: the CLI guard then requires the HTTP mechanism', async () => {
    const { fake, key, ours } = setup({ urlKeys: true });
    expect(key).toBe(`policy-path:${URL}`);
    expect((await ours()).key).toBe(key);
    expect(resourceUpdateRoute(fake.mechanism(), key, TOKEN)).toMatchObject({ kind: 'park', reason: 'key_unsafe_for_cli' });
    // 本地资源的 key 不变
    expect((await fake.listExternalResources()).map((r) => r.key)).toContain('ruleset:sfe-entry-block.list');
  });

  test('a resource never downloaded is not ready: error not_ready, no update time, only REJECT; the load attempt is recorded, not counted as a call', async () => {
    const { fake, ours, server } = setup();
    expect(await ours()).toMatchObject({ error: 'not_ready', lastUpdatedAt: null, updating: false });
    expect(await fake.getGroupMembers('SFE-ROUTE')).toEqual(['REJECT']);
    expect(await fake.getGroupSelection('SFE-ROUTE')).toBe('REJECT');
    expect(server.count('ours')).toBe(1);
    expect(fake.remoteFetches).toMatchObject([{ trigger: 'load', outcome: 'failed', error: FAKE_REMOTE_ERRORS.refused, attempts: 1 }]);
    expect(fake.calls.updateExternalResource).toBeUndefined();
    expect(fake.loadedContent(fake.resourceKeyFor(URL))).toBeNull();
  });

  test('watchLocalPolicyPaths has no effect on the remote resource', async () => {
    const { fake, server } = setup({ watchLocalPolicyPaths: true });
    server.serve([LINE_A]);
    t += 60_000;
    expect(await fake.getGroupMembers('SFE-ROUTE')).toEqual(['REJECT']);
    expect(fake.watcherReloads).toEqual([]);
    expect(server.count('ours')).toBe(1);
  });
});

describe('single-key update: success semantics (matrix rows)', () => {
  test('valid A/B: success, error null, members rebuilt with REJECT first, update time advances, node parameters readable', async () => {
    const { fake, key, ours, server } = setup();
    server.serve([LINE_A, LINE_B]);
    t += 1_000;
    await expect(fake.updateExternalResource(key)).resolves.toEqual({ key, refreshed: true, outcome: 'downloaded' });
    expect(await fake.getGroupMembers('SFE-ROUTE')).toEqual(['REJECT', A, B]);
    expect(await ours()).toMatchObject({ error: null, lastUpdatedAt: new Date(t) });
    expect(await fake.getPolicyDetail(B)).toMatchObject({ name: B, type: 'socks5', server: '203.0.113.12', port: 1080, underlyingProxy: 'Front-A' });
    expect(fake.loadedContent(key)).toBe([LINE_A, LINE_B].join('\n'));
    expect(fake.remoteFetches.at(-1)).toMatchObject({ key, trigger: 'update', outcome: 'downloaded', attempts: 1, accepted: 2, error: null });
    expect(fake.calls.updateExternalResource).toBe(1);
    expect(fake.reloadCount).toBe(0);
  });

  test('valid A/B + bad C: success with an empty error; C is dropped and a selected C falls back to REJECT', async () => {
    const { fake, key, ours, server } = setup({ userRules: ['DOMAIN-SUFFIX,example.test,SFE-ROUTE'] });
    server.serve([LINE_A, LINE_B, LINE_C]);
    await fake.updateExternalResource(key);
    await fake.selectGroupPolicy('SFE-ROUTE', C);
    server.serve([LINE_A, LINE_B, `${C} = socks5, 203.0.113.13`], 2);
    t += 1_000;
    await expect(fake.updateExternalResource(key)).resolves.toMatchObject({ outcome: 'downloaded' });
    expect(await ours()).toMatchObject({ error: null, lastUpdatedAt: new Date(t) });
    expect(await fake.getGroupMembers('SFE-ROUTE')).toEqual(['REJECT', A, B]);
    expect(await fake.getGroupSelection('SFE-ROUTE')).toBe('REJECT');
    expect(fake.simulateRequest({ processPath: FAKE_CHROME_PATH, host: 'www.example.test', protocol: 'tcp' })).toMatchObject({ policyName: 'SFE-ROUTE', failed: true });
  });

  test('a duplicate name (differs only in its parameters) succeeds and the first definition wins', async () => {
    const { fake, key, ours, server } = setup();
    server.serve([node(A, '203.0.113.11', { username: 'user-one' }), node(A, '203.0.113.99', { username: 'user-two' }), LINE_B]);
    await fake.updateExternalResource(key);
    expect((await ours()).error).toBeNull();
    expect(await fake.getGroupMembers('SFE-ROUTE')).toEqual(['REJECT', A, B]);
    expect(await fake.getPolicyDetail(A)).toMatchObject({ server: '203.0.113.11' });
    expect(fake.remoteFetches.at(-1)!.accepted).toBe(2);
  });

  test('a same-name parameter change (server, port or front) applies immediately and keeps the selection', async () => {
    const { fake, key, server } = setup();
    server.serve([LINE_A, LINE_B]);
    await fake.updateExternalResource(key);
    await fake.selectGroupPolicy('SFE-ROUTE', A);
    server.serve([node(A, '203.0.113.21', { port: 2080, front: 'Front-B' }), LINE_B], 2);
    await fake.updateExternalResource(key);
    expect(await fake.getGroupSelection('SFE-ROUTE')).toBe(A);
    expect(await fake.getPolicyDetail(A)).toMatchObject({ server: '203.0.113.21', port: 2080, underlyingProxy: 'Front-B' });
  });

  test('deleting the selected member falls back to REJECT (the first member); deleting another member keeps the selection', async () => {
    const { fake, key, server } = setup();
    server.serve([LINE_A, LINE_B, LINE_C]);
    await fake.updateExternalResource(key);
    await fake.selectGroupPolicy('SFE-ROUTE', B);
    server.serve([LINE_A, LINE_B], 2);
    await fake.updateExternalResource(key);
    expect(await fake.getGroupSelection('SFE-ROUTE')).toBe(B);
    server.serve([LINE_A], 3);
    await fake.updateExternalResource(key);
    expect(await fake.getGroupMembers('SFE-ROUTE')).toEqual(['REJECT', A]);
    expect(await fake.getGroupSelection('SFE-ROUTE')).toBe('REJECT');
  });

  test('a placeholder-only list is accepted: members [REJECT, SFE-EMPTY], and the placeholder rejects', async () => {
    const { fake, key, ours, server } = setup();
    server.serve([LINE_A]);
    await fake.updateExternalResource(key);
    await fake.selectGroupPolicy('SFE-ROUTE', A);
    server.serve([], 2);
    expect(body(2, [])).toContain(EMPTY_PLACEHOLDER_LINE);
    await expect(fake.updateExternalResource(key)).resolves.toMatchObject({ outcome: 'downloaded' });
    expect((await ours()).error).toBeNull();
    expect(await fake.getGroupMembers('SFE-ROUTE')).toEqual(['REJECT', EMPTY_PLACEHOLDER_NODE]);
    expect(await fake.getGroupSelection('SFE-ROUTE')).toBe('REJECT');
    expect(await fake.getPolicyDetail(EMPTY_PLACEHOLDER_NODE)).toMatchObject({ type: 'reject', server: null, port: null, underlyingProxy: null });
    await fake.selectGroupPolicy('SFE-ROUTE', EMPTY_PLACEHOLDER_NODE);
    expect(await fake.testPolicy('SFE-ROUTE', 'https://verify.example.test/')).toMatchObject({ ok: false });
  });

  test('update time resolution: ms is strictly increasing without clock movement; s rounds down and repeats within a second', async () => {
    const ms = setup();
    ms.server.serve([LINE_A]);
    await ms.fake.updateExternalResource(ms.key);
    const first = (await ms.ours()).lastUpdatedAt!;
    await ms.fake.updateExternalResource(ms.key);
    expect((await ms.ours()).lastUpdatedAt!.getTime()).toBe(first.getTime() + 1);

    rmSync(dir, { recursive: true, force: true });
    t = Date.parse('2026-10-25T00:00:10.250Z');
    const s = setup({ updatedAtResolution: 's' });
    s.server.serve([LINE_A]);
    await s.fake.updateExternalResource(s.key);
    expect((await s.ours()).lastUpdatedAt).toEqual(new Date('2026-10-25T00:00:10.000Z'));
    t += 600;
    s.server.serve([LINE_A, LINE_B], 2);
    await s.fake.updateExternalResource(s.key);
    expect((await s.ours()).lastUpdatedAt).toEqual(new Date('2026-10-25T00:00:10.000Z'));
    expect(await s.fake.getGroupMembers('SFE-ROUTE')).toEqual(['REJECT', A, B]);
  });
});

describe('single-key update: failures keep the cached nodes (matrix rows)', () => {
  const rows: Array<{ name: string; answer: FakeRemoteResponse; text: string; attempts: number }> = [
    ...[401, 403, 404, 500, 503].map((status) => ({ name: `HTTP ${status}`, answer: { kind: 'http' as const, status, body: '' }, text: FAKE_REMOTE_ERRORS.status(status), attempts: 1 })),
    { name: 'connection reset', answer: { kind: 'reset' }, text: FAKE_REMOTE_ERRORS.interrupted, attempts: 6 },
    { name: 'truncated response', answer: { kind: 'truncated' }, text: FAKE_REMOTE_ERRORS.interrupted, attempts: 2 },
    { name: 'no response', answer: { kind: 'no_response' }, text: FAKE_REMOTE_ERRORS.timeout, attempts: 2 },
    { name: 'server stopped', answer: { kind: 'refused' }, text: FAKE_REMOTE_ERRORS.refused, attempts: 1 },
    { name: 'empty 200', answer: { kind: 'http', status: 200, body: '' }, text: '服务器未返回任何数据。', attempts: 1 },
    { name: 'only bad lines', answer: { kind: 'http', status: 200, body: `# SFE managed resource · generation 2\n${C} = socks5, 203.0.113.13\ngarbage\n` }, text: 'Failed to parse remote resource data', attempts: 1 },
    { name: 'header only', answer: { kind: 'http', status: 200, body: '# SFE managed resource · generation 2\n' }, text: 'Failed to parse remote resource data', attempts: 1 },
  ];

  test.each(rows)('$name: SURGE_COMMAND_FAILED like the adapters; nodes, selection, readiness and update time kept', async ({ answer, text, attempts }) => {
    const { fake, key, ours, server } = setup({ userRules: ['DOMAIN-SUFFIX,example.test,SFE-ROUTE'] });
    server.serve([LINE_A, LINE_B, LINE_C]);
    await fake.updateExternalResource(key);
    await fake.selectGroupPolicy('SFE-ROUTE', C);
    const before = await ours();
    const requestsBefore = server.count('ours');
    server.answer(answer);
    t += 5_000;
    const err = (await fake.updateExternalResource(key).catch((e: unknown) => e)) as SfeError;
    expect(err).toBeInstanceOf(SfeError);
    expect(err.code).toBe('SURGE_COMMAND_FAILED');
    expect(err.message).toBe(adapterError(key, text).message);
    expect(server.count('ours') - requestsBefore).toBe(attempts);
    expect(fake.remoteFetches.at(-1)).toMatchObject({ outcome: 'failed', error: text, attempts });
    // 证据：退出 0、ready=true、error 非空；旧 A/B/C、C 选择与链路保留
    expect(await ours()).toMatchObject({ error: text, lastUpdatedAt: before.lastUpdatedAt, updating: false });
    expect(await fake.getGroupMembers('SFE-ROUTE')).toEqual(['REJECT', A, B, C]);
    expect(await fake.getGroupSelection('SFE-ROUTE')).toBe(C);
    expect(fake.simulateRequest({ processPath: FAKE_CHROME_PATH, host: 'www.example.test', protocol: 'tcp' })).toMatchObject({ failed: false, chain: ['SFE-ROUTE', C, 'Front-A'] });
    expect(fake.reloadCount).toBe(0);
  });

  test('attempt counts follow the latest answer; a retry that succeeds is a success', async () => {
    expect(FAKE_REMOTE_ATTEMPTS).toEqual({ http: 1, reset: 6, truncated: 2, no_response: 2, refused: 1 });
    const { fake, key, ours, server } = setup();
    let n = 0;
    server.answer(() => (++n < 3 ? { kind: 'reset' } : { kind: 'http', status: 200, body: body(1, [LINE_A]) }));
    await expect(fake.updateExternalResource(key)).resolves.toMatchObject({ outcome: 'downloaded' });
    expect(n).toBe(3);
    expect((await ours()).error).toBeNull();
    expect(fake.remoteFetches.at(-1)).toMatchObject({ attempts: 3, outcome: 'downloaded' });
  });

  test('the next success clears the error; a failure before the first success stays not ready', async () => {
    const { fake, key, ours, server } = setup();
    server.answer({ kind: 'http', status: 503, body: '' });
    await expect(fake.updateExternalResource(key)).rejects.toMatchObject({ code: 'SURGE_COMMAND_FAILED' });
    expect(await ours()).toMatchObject({ error: 'not_ready', lastUpdatedAt: null });
    server.serve([LINE_A]);
    await fake.updateExternalResource(key);
    server.answer({ kind: 'http', status: 500, body: '' });
    await expect(fake.updateExternalResource(key)).rejects.toThrow(FAKE_REMOTE_ERRORS.status(500));
    expect((await ours()).error).toBe(FAKE_REMOTE_ERRORS.status(500));
    server.serve([LINE_A, LINE_B], 2);
    await fake.updateExternalResource(key);
    expect((await ours()).error).toBeNull();
  });

  test('failNext and lieOnNext still apply to the update primitive (an injected lie never downloads)', async () => {
    const { fake, key, server } = setup();
    server.serve([LINE_A]);
    fake.lieOnNext('updateExternalResource', { key, refreshed: true, outcome: 'downloaded' });
    await expect(fake.updateExternalResource(key)).resolves.toMatchObject({ outcome: 'downloaded' });
    expect(await fake.getGroupMembers('SFE-ROUTE')).toEqual(['REJECT']);
    fake.failNext('updateExternalResource', new SfeError('SURGE_UNREACHABLE', '模拟'), { afterEffect: true });
    await expect(fake.updateExternalResource(key)).rejects.toMatchObject({ code: 'SURGE_UNREACHABLE' });
    expect(await fake.getGroupMembers('SFE-ROUTE')).toEqual(['REJECT', A]);
  });
});

describe('single-key update touches only that resource (main-config witness)', () => {
  test('never loads an edited on-disk main profile and never touches other resources; an explicit reload is the positive control', async () => {
    const { env, fake, key, server } = setup({ otherGroup: true });
    server.serve([LINE_A]);
    server.serve([node('SFE-N-E0009-US01-v001', '203.0.113.90')], 1, OTHER_URL);
    await fake.reloadProfile();
    const otherKey = fake.resourceKeyFor(OTHER_URL);
    const blockKey = `ruleset:${ENTRY_RULESET_FILES.block}`;
    const snapshot = async () => {
      const list = await fake.listExternalResources();
      return {
        other: list.find((r) => r.key === otherKey),
        local: list.filter((r) => r.local),
        otherContent: fake.loadedContent(otherKey),
        blockContent: fake.loadedContent(blockKey),
        rules: await fake.listRules(),
        // 本应用资源的节点之外的策略（用户节点、其他资源的节点、组）
        policies: await fake.listPolicies().then((p) => ({ ...p, proxies: p.proxies.filter((n) => n !== A && n !== B) })),
        otherMembers: await fake.getGroupMembers('Other'),
      };
    };
    const reloadsBefore = fake.reloadCount;
    const before = await snapshot();
    expect(before.otherMembers).toEqual(['DIRECT', 'SFE-N-E0009-US01-v001']);
    const otherRequests = server.count('other');

    // 磁盘上的主配置被改动（新的用户节点、规则与组），但没有重载
    const edited = readFileSync(env.profilePath, 'utf8')
      .replace('[Proxy]\n', '[Proxy]\nWitness-Node = http, 192.0.2.99, 8080\n')
      .replace('FINAL,DIRECT', 'DOMAIN,witness.example.test,REJECT\nFINAL,DIRECT')
      .replace('# SFE-BEGIN group v1', 'Witness = select, DIRECT\n# SFE-BEGIN group v1');
    writeFileSync(env.profilePath, edited);
    server.serve([LINE_A, LINE_B], 2);
    server.serve([node('SFE-N-E0009-US01-v002', '203.0.113.91')], 2, OTHER_URL);
    t += 10_000;
    await fake.updateExternalResource(key);

    expect(await fake.getGroupMembers('SFE-ROUTE')).toEqual(['REJECT', A, B]);
    expect(await snapshot()).toEqual(before);
    expect(server.count('other')).toBe(otherRequests);
    expect(fake.reloadCount).toBe(reloadsBefore);
    expect(fake.calls.reloadProfile).toBe(1);
    expect((await fake.listRules()).some((r) => r.text.includes('witness.example.test'))).toBe(false);
    expect((await fake.listPolicies()).proxies).not.toContain('Witness-Node');

    // 阳性对照：显式重载同一配置才会加载改动（已就绪的远端资源沿用缓存，不重新下载）
    await fake.reloadProfile();
    expect((await fake.listRules()).some((r) => r.text.includes('witness.example.test'))).toBe(true);
    expect((await fake.listPolicies()).groups).toContain('Witness');
    expect(server.count('other')).toBe(otherRequests);
    expect(await fake.getGroupMembers('Other')).toEqual(['DIRECT', 'SFE-N-E0009-US01-v001']);
  });

  test('update all is never supported; unknown keys fail; local resources are skipped', async () => {
    const { fake, server } = setup();
    for (const k of ['all', 'ALL', '', ' ']) {
      await expect(fake.updateExternalResource(k)).rejects.toMatchObject({ code: 'INTERNAL' });
    }
    expect(fake.updateAllAttempts).toBe(4);
    expect(server.count('ours')).toBe(1);
    await expect(fake.updateExternalResource('0'.repeat(32))).rejects.toMatchObject({ code: 'SURGE_COMMAND_FAILED' });
    await expect(fake.updateExternalResource(`ruleset:${ENTRY_RULESET_FILES.block}`)).resolves.toMatchObject({ refreshed: false, outcome: 'skipped' });
    expect(server.count('ours')).toBe(1);
  });
});

describe('scheduled refresh, reload and restart', () => {
  test('no scheduled refresh by default, even after a long clock jump', async () => {
    const { fake, server } = setup();
    server.serve([LINE_A]);
    t += 3_600_000;
    expect(await fake.getGroupMembers('SFE-ROUTE')).toEqual(['REJECT']);
    fake.simulateRequest({ processPath: FAKE_CHROME_PATH, host: 'www.example.test', protocol: 'tcp' });
    expect(server.count('ours')).toBe(1);
  });

  test('remoteRefreshIntervalMs refreshes through the same path (not counted as a call); one fetch per check even after several intervals', async () => {
    const { fake, key, ours, server } = setup({ remoteRefreshIntervalMs: 60_000 });
    server.serve([LINE_A]);
    t += 59_999;
    expect(await fake.getGroupMembers('SFE-ROUTE')).toEqual(['REJECT']);
    t += 1;
    expect(await fake.getGroupMembers('SFE-ROUTE')).toEqual(['REJECT', A]);
    expect(fake.remoteFetches.at(-1)).toMatchObject({ key, trigger: 'scheduled', outcome: 'downloaded' });
    expect(fake.calls.updateExternalResource).toBeUndefined();

    // 失败的定时刷新：保留缓存、记错误；simulateRequest 也会触发
    server.answer({ kind: 'http', status: 503, body: '' });
    t += 180_000;
    fake.simulateRequest({ processPath: FAKE_CHROME_PATH, host: 'www.example.test', protocol: 'tcp' });
    expect(server.count('ours')).toBe(3);
    expect(await ours()).toMatchObject({ error: FAKE_REMOTE_ERRORS.status(503) });
    expect(await fake.getGroupMembers('SFE-ROUTE')).toEqual(['REJECT', A]);
    fake.runScheduledRefresh(key);
    expect(server.count('ours')).toBe(4);
    expect(() => fake.runScheduledRefresh('0'.repeat(32))).toThrow();
  });

  test('reloadProfile keeps a ready cache (no download) and downloads a not-ready resource once', async () => {
    const { fake, key, ours, server } = setup();
    server.serve([LINE_A]);
    await fake.reloadProfile();
    expect(server.count('ours')).toBe(2);
    expect(fake.remoteFetches.at(-1)).toMatchObject({ trigger: 'load', outcome: 'downloaded' });
    const ready = await ours();
    server.serve([LINE_A, LINE_B], 2);
    t += 1_000;
    await fake.reloadProfile();
    expect(server.count('ours')).toBe(2);
    expect(await ours()).toEqual(ready);
    expect(await fake.getGroupMembers('SFE-ROUTE')).toEqual(['REJECT', A]);
    expect(fake.loadedContent(key)).toBe(LINE_A);
  });

  test("restart with 'keep' keeps the cache, error and selection without downloading; 'drop' downloads once and stays empty if the server is down", async () => {
    const keep = setup();
    keep.server.serve([LINE_A, LINE_B]);
    await keep.fake.updateExternalResource(keep.key);
    await keep.fake.selectGroupPolicy('SFE-ROUTE', B);
    keep.server.stop();
    await expect(keep.fake.updateExternalResource(keep.key)).rejects.toThrow(FAKE_REMOTE_ERRORS.refused);
    const before = await keep.ours();
    const requests = keep.server.count('ours');
    t += 60_000;
    keep.fake.restart();
    expect(keep.server.count('ours')).toBe(requests);
    expect(await keep.ours()).toEqual(before);
    expect(await keep.fake.getGroupMembers('SFE-ROUTE')).toEqual(['REJECT', A, B]);
    // 选择是 Surge 自己保存的（假 Surge 跨重启保留，与旧行为相同）
    expect(await keep.fake.getGroupSelection('SFE-ROUTE')).toBe(B);

    rmSync(dir, { recursive: true, force: true });
    const drop = setup({ remoteCacheOnRestart: 'drop' });
    drop.server.serve([LINE_A]);
    await drop.fake.updateExternalResource(drop.key);
    drop.server.answer({ kind: 'http', status: 503, body: '' });
    drop.fake.restart();
    expect(drop.fake.remoteFetches.at(-1)).toMatchObject({ trigger: 'load', outcome: 'failed', error: FAKE_REMOTE_ERRORS.status(503) });
    expect(await drop.ours()).toMatchObject({ error: 'not_ready', lastUpdatedAt: null });
    expect(await drop.fake.getGroupMembers('SFE-ROUTE')).toEqual(['REJECT']);
    drop.server.serve([LINE_A, LINE_B], 2);
    drop.fake.restart();
    expect(await drop.fake.getGroupMembers('SFE-ROUTE')).toEqual(['REJECT', A, B]);
  });

  test('seedRemoteCache installs a cache as if downloaded in an earlier run (no request, no fetch record)', async () => {
    const server = scriptedServer();
    createFakeSurgeEnvironment(dir, { resource: { url: URL } });
    const fake0 = new FakeSurge({ directory: dir, now: () => new Date(t), remoteSource: server.source });
    fake0.seedRemoteCache(URL, body(3, [LINE_B]), { updatedAt: new Date(t - 60_000) });
    expect(await fake0.getGroupMembers('SFE-ROUTE')).toEqual(['REJECT', B]);
    expect((await fake0.listExternalResources()).find((r) => r.key === fake0.resourceKeyFor(URL))).toMatchObject({ error: null, lastUpdatedAt: new Date(t - 60_000) });
    expect(server.count('ours')).toBe(1);
    expect(fake0.remoteFetches).toHaveLength(1);
    expect(() => fake0.seedRemoteCache(URL, '')).toThrow(/not accepted/);

    // 构造选项 remoteCache：第一次加载时已就绪，不下载
    const fake1 = new FakeSurge({ directory: dir, now: () => new Date(t), remoteSource: server.source, remoteCache: [{ url: URL, body: body(0, []) }] });
    expect(fake1.remoteFetches).toEqual([]);
    expect(server.count('ours')).toBe(1);
    expect(await fake1.getGroupMembers('SFE-ROUTE')).toEqual(['REJECT', EMPTY_PLACEHOLDER_NODE]);
    expect((await fake1.listExternalResources()).find((r) => r.key === fake1.resourceKeyFor(URL))).toMatchObject({ error: null, lastUpdatedAt: new Date(t) });
  });
});

describe('slow update and ambiguous timeout', () => {
  test('slowUpdate: the call answers before the download; updating stays true until the duration passes, then the download applies', async () => {
    const { fake, key, ours, server } = setup();
    fake.slowUpdate = { durationMs: 2_000 };
    server.serve([LINE_A]);
    const requests = server.count('ours');
    await expect(fake.updateExternalResource(key)).resolves.toEqual({ key, refreshed: true, outcome: 'downloaded' });
    expect(server.count('ours')).toBe(requests);
    expect(await ours()).toMatchObject({ updating: true, error: 'not_ready' });
    expect(fake.isUpdating(key)).toBe(true);
    // 进行中再次更新：不另起下载
    await expect(fake.updateExternalResource(key)).resolves.toMatchObject({ outcome: 'downloaded' });
    t += 1_999;
    expect(await fake.getGroupMembers('SFE-ROUTE')).toEqual(['REJECT']);
    // 下载在完成时才发生：期间换掉的内容就是 Surge 拿到的内容
    server.serve([LINE_A, LINE_B], 2);
    t += 1;
    expect(await ours()).toMatchObject({ updating: false, error: null, lastUpdatedAt: new Date(t) });
    expect(await fake.getGroupMembers('SFE-ROUTE')).toEqual(['REJECT', A, B]);
    expect(server.count('ours')).toBe(requests + 1);
    expect(fake.remoteFetches.at(-1)).toMatchObject({ trigger: 'update', at: new Date(t) });
    expect(fake.calls.updateExternalResource).toBe(2);
  });

  test("slowUpdate with reply 'timeout' throws the adapter timeout; scheduled refreshes and the load at construction are slow too", async () => {
    const { fake, key, ours, server } = setup({ slowUpdate: { durationMs: 500, reply: 'timeout' } });
    // 构造时的下载也在进行中（尚未发出请求）
    expect(server.count('ours')).toBe(0);
    expect(await ours()).toMatchObject({ updating: true, error: 'not_ready' });
    t += 500;
    expect((await ours()).updating).toBe(false);
    expect(fake.remoteFetches).toMatchObject([{ trigger: 'load', outcome: 'failed' }]);
    server.serve([LINE_A]);
    await expect(fake.updateExternalResource(key)).rejects.toMatchObject({ code: 'SURGE_COMMAND_FAILED', details: { reason: 'update_timeout' } });
    await expect(fake.updateExternalResource(key)).rejects.toMatchObject({ details: { reason: 'update_timeout' } });
    t += 500;
    expect((await ours()).updating).toBe(false);
    expect(await fake.getGroupMembers('SFE-ROUTE')).toEqual(['REJECT', A]);
    fake.runScheduledRefresh(key);
    expect((await ours()).updating).toBe(true);
  });

  test('timeoutNextUpdate: the adapter reports update_timeout but the update still applies (immediately or after a delay)', async () => {
    const { fake, key, ours, server } = setup();
    server.serve([LINE_A]);
    fake.timeoutNextUpdate();
    const err = (await fake.updateExternalResource(key).catch((e: unknown) => e)) as SfeError;
    expect(err).toMatchObject({ code: 'SURGE_COMMAND_FAILED', details: { primitive: 'updateExternalResource', reason: 'update_timeout' } });
    expect(await fake.getGroupMembers('SFE-ROUTE')).toEqual(['REJECT', A]);

    server.serve([LINE_A, LINE_B], 2);
    fake.timeoutNextUpdate({ applyAfterMs: 1_000 });
    await expect(fake.updateExternalResource(key)).rejects.toMatchObject({ details: { reason: 'update_timeout' } });
    expect(await ours()).toMatchObject({ updating: true });
    expect(await fake.getGroupMembers('SFE-ROUTE')).toEqual(['REJECT', A]);
    t += 1_000;
    expect(await fake.getGroupMembers('SFE-ROUTE')).toEqual(['REJECT', A, B]);
    expect((await ours()).updating).toBe(false);
    // 只作用一次
    await expect(fake.updateExternalResource(key)).resolves.toMatchObject({ outcome: 'downloaded' });
    expect(() => fake.timeoutNextUpdate({ applyAfterMs: -1 })).toThrow(RangeError);
  });

  test('a restart abandons an in-flight download', async () => {
    const { fake, key, ours, server } = setup();
    fake.slowUpdate = { durationMs: 1_000 };
    server.serve([LINE_A]);
    await fake.updateExternalResource(key);
    fake.slowUpdate = null;
    server.stop();
    fake.restart();
    t += 5_000;
    expect(await ours()).toMatchObject({ updating: false, error: 'not_ready' });
    expect(fake.remoteFetches.map((f) => f.trigger)).toEqual(['load', 'load']);
  });
});

describe('downloads through the real resource host (virtualBinder)', () => {
  function hosted() {
    const binder = virtualBinder();
    const logger = recordingLogger();
    const host = createResourceHost({ token: TOKEN, clock: { now: () => new Date(t), setTimeout: () => () => undefined }, logger, binder });
    host.configure(PORT);
    const env = createFakeSurgeEnvironment(dir, { resource: { url: URL, request: (port, req) => binder.request(port, req) } });
    const fake = new FakeSurge({ directory: dir, now: () => new Date(t), remoteSource: env.remoteSource! });
    const key = fake.resourceKeyFor(URL);
    return { binder, host, fake, key, logger, ours: async () => (await fake.listExternalResources()).find((r) => r.key === key)! };
  }

  test('not listening → refused without reaching the host; nothing served → 503; served → audited complete download', async () => {
    const { host, fake, key, ours, logger } = hosted();
    expect(fake.remoteFetches).toMatchObject([{ trigger: 'load', error: FAKE_REMOTE_ERRORS.refused }]);
    expect(host.failureCounters()).toEqual({});
    await host.listen();
    await expect(fake.updateExternalResource(key)).rejects.toThrow(FAKE_REMOTE_ERRORS.status(503));
    expect(host.failureCounters()).toMatchObject({ unavailable: 1 });
    host.loadCommitted({ generation: 0, content: body(0, []) });
    t += 1_000;
    await fake.updateExternalResource(key);
    expect(await fake.getGroupMembers('SFE-ROUTE')).toEqual(['REJECT', EMPTY_PLACEHOLDER_NODE]);
    const snap = await ours();
    expect(host.audit()).toMatchObject([{ seq: 1, generation: 0, complete: true }]);
    expect(matchAuditRecord(host.audit(), snap.lastUpdatedAt!, 5_000, 1, 0)).toMatchObject({ seq: 1 });
    expect(logger.text()).not.toContain(TOKEN);
  });

  test('candidate, revert and a wrong token: Surge holds exactly what the handler served', async () => {
    const { host, fake, key, ours } = hosted();
    await host.listen();
    host.loadCommitted({ generation: 0, content: body(0, []) });
    await fake.updateExternalResource(key);
    host.stageCandidate({ generation: 1, content: body(1, [LINE_A, LINE_B]) });
    await fake.updateExternalResource(key);
    expect(await fake.getGroupMembers('SFE-ROUTE')).toEqual(['REJECT', A, B]);
    host.revertToCommitted();
    await fake.updateExternalResource(key);
    expect(await fake.getGroupMembers('SFE-ROUTE')).toEqual(['REJECT', EMPTY_PLACEHOLDER_NODE]);
    expect(host.audit().map((r) => [r.generation, r.complete])).toEqual([
      [0, true],
      [1, true],
      [0, true],
    ]);
    // 令牌可能泄露（tokenSuspect）：统一 404，Surge 保留缓存
    host.setRefuseToken(true);
    await expect(fake.updateExternalResource(key)).rejects.toThrow(FAKE_REMOTE_ERRORS.status(404));
    expect(await ours()).toMatchObject({ error: FAKE_REMOTE_ERRORS.status(404) });
    expect(await fake.getGroupMembers('SFE-ROUTE')).toEqual(['REJECT', EMPTY_PLACEHOLDER_NODE]);
    expect(host.failureCounters()).toMatchObject({ token_refused: 1 });
    // 关闭之后：连接被拒绝，没有请求到达处理程序
    await host.close();
    await expect(fake.updateExternalResource(key)).rejects.toThrow(FAKE_REMOTE_ERRORS.refused);
    expect(host.failureCounters()).toMatchObject({ token_refused: 1 });
  });

  test('a profile URL with another token gets the uniform 404 from the handler', async () => {
    const binder = virtualBinder();
    const host = createResourceHost({ token: TOKEN, clock: { now: () => new Date(t), setTimeout: () => () => undefined }, logger: recordingLogger(), binder });
    host.configure(PORT);
    await host.listen();
    host.loadCommitted({ generation: 0, content: body(0, []) });
    const other = nodeResourceUrl(PORT, 'c'.repeat(64));
    const env = createFakeSurgeEnvironment(dir, { resource: { url: other, request: (port, req) => binder.request(port, req) } });
    const fake = new FakeSurge({ directory: dir, now: () => new Date(t), remoteSource: env.remoteSource! });
    expect(fake.remoteFetches).toMatchObject([{ outcome: 'failed', error: FAKE_REMOTE_ERRORS.status(404) }]);
    expect(host.failureCounters()).toMatchObject({ token_mismatch: 1 });
    expect(host.audit()).toEqual([]);
  });
});
