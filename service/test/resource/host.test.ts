// 本机资源服务的 handle()：每种拒绝原因都得到逐字节相同的 404，503 只给令牌正确而没有可提供版本的请求，200 的响应头逐项
// 固定；审计记录的生命周期；提供版本的状态转换；内容上限；进程内绑定方的端口独占。只用合成令牌与回环地址。
import { describe, expect, test } from 'vitest';
import { RESOURCE_PORT_MIN, SfeError } from '@sfe/contract';
import {
  RESOURCE_AUDIT_LIMIT,
  RESOURCE_LOG_INTERVAL_MS,
  RESOURCE_MAX_BYTES,
  createResourceHost,
  virtualBinder,
  type ResourceAuditRecord,
  type ResourceBinder,
  type ResourceHost,
  type ResourceRequest,
  type VirtualResourceBinder,
} from '../../src/resource/index.js';
import { FakeClock } from '../../src/util/clock.js';
import { OTHER_TOKEN, PATH, PORT, TOKEN, goodRequest, recordingLogger, sampleContent, wire, type RecordingLogger } from './helpers.js';

interface Setup {
  host: ResourceHost;
  binder: VirtualResourceBinder;
  registry: Map<number, unknown>;
  clock: FakeClock;
  logger: RecordingLogger;
  get(over?: Partial<Omit<ResourceRequest, 'localPort'>>): ReturnType<VirtualResourceBinder['request']>;
}

async function setup(opts: { load?: boolean; registry?: Map<number, unknown>; audit?: { records: ResourceAuditRecord[]; nextSeq: number } } = {}): Promise<Setup> {
  const clock = new FakeClock('2026-10-31T00:00:00.000Z');
  const logger = recordingLogger();
  const registry = opts.registry ?? new Map<number, unknown>();
  const binder = virtualBinder(registry);
  const host = createResourceHost({ token: TOKEN, clock, logger, binder, ...(opts.audit ? { audit: opts.audit } : {}) });
  host.configure(PORT);
  await host.listen();
  if (opts.load !== false) host.loadCommitted({ generation: 3, content: sampleContent(3) });
  return { host, binder, registry, clock, logger, get: (over = {}) => binder.request(PORT, goodRequest(over)) };
}

const NOT_FOUND_HEADERS = {
  'Content-Length': '0',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'none'; sandbox",
  'Referrer-Policy': 'no-referrer',
  Connection: 'close',
};

const hostHeader = ['Host', `127.0.0.1:${PORT}`];

/** 每一行都必须得到与其他行逐字节相同的 404。 */
const REJECTIONS: Array<[string, Partial<Omit<ResourceRequest, 'localPort'>>, string]> = [
  ['POST', { method: 'POST' }, 'method'],
  ['HEAD', { method: 'HEAD' }, 'method'],
  ['lowercase get', { method: 'get' }, 'method'],
  ['OPTIONS', { method: 'OPTIONS' }, 'method'],
  ['absolute-form target', { rawPath: `http://127.0.0.1:${PORT}${PATH}` }, 'target'],
  ['asterisk target', { rawPath: '*' }, 'target'],
  ['empty target', { rawPath: '' }, 'target'],
  ['query', { rawPath: `${PATH}?x=1` }, 'query'],
  ['empty query', { rawPath: `${PATH}?` }, 'query'],
  ['fragment', { rawPath: `${PATH}#f` }, 'query'],
  ['percent-escaped basename', { rawPath: `/${TOKEN}/sfe%2Dnodes.list` }, 'percent_escape'],
  ['percent-escaped token', { rawPath: `/%61${'a'.repeat(63)}/sfe-nodes.list` }, 'percent_escape'],
  ['percent-escaped slash', { rawPath: `/${TOKEN}%2Fsfe-nodes.list` }, 'percent_escape'],
  ['leading double slash', { rawPath: `//${TOKEN}/sfe-nodes.list` }, 'path'],
  ['inner double slash', { rawPath: `/${TOKEN}//sfe-nodes.list` }, 'path'],
  ['trailing slash', { rawPath: `${PATH}/` }, 'path'],
  ['other basename', { rawPath: `/${TOKEN}/sfe-nodes.txt` }, 'path'],
  ['uppercase basename', { rawPath: `/${TOKEN}/SFE-NODES.LIST` }, 'path'],
  ['extra leading segment', { rawPath: `/x/${TOKEN}/sfe-nodes.list` }, 'path'],
  ['extra trailing segment', { rawPath: `${PATH}/extra` }, 'path'],
  ['dot segment', { rawPath: `/${TOKEN}/./sfe-nodes.list` }, 'path'],
  ['parent segment', { rawPath: `/../${TOKEN}/sfe-nodes.list` }, 'path'],
  ['missing token', { rawPath: '/sfe-nodes.list' }, 'path'],
  ['empty token segment', { rawPath: '//sfe-nodes.list' }, 'path'],
  ['token only', { rawPath: `/${TOKEN}` }, 'path'],
  ['root', { rawPath: '/' }, 'path'],
  ['uppercase token', { rawPath: `/${TOKEN.toUpperCase()}/sfe-nodes.list` }, 'token_format'],
  ['short token', { rawPath: `/${'a'.repeat(63)}/sfe-nodes.list` }, 'token_format'],
  ['long token', { rawPath: `/${'a'.repeat(65)}/sfe-nodes.list` }, 'token_format'],
  ['non-hex token', { rawPath: `/${'g'.repeat(64)}/sfe-nodes.list` }, 'token_format'],
  ['wrong token', { rawPath: `/${OTHER_TOKEN}/sfe-nodes.list` }, 'token_mismatch'],
  ['token off by one char', { rawPath: `/${'a'.repeat(63)}b/sfe-nodes.list` }, 'token_mismatch'],
  ['no Host', { rawHeaders: ['User-Agent', 'x'] }, 'host'],
  ['duplicate Host', { rawHeaders: [...hostHeader, ...hostHeader] }, 'host'],
  ['duplicate Host differing in case', { rawHeaders: [...hostHeader, 'host', `127.0.0.1:${PORT}`] }, 'host'],
  ['Host localhost', { rawHeaders: ['Host', `localhost:${PORT}`] }, 'host'],
  ['Host without port', { rawHeaders: ['Host', '127.0.0.1'] }, 'host'],
  ['Host with other port', { rawHeaders: ['Host', `127.0.0.1:${PORT + 1}`] }, 'host'],
  ['Host with padded port', { rawHeaders: ['Host', `127.0.0.1:0${PORT}`] }, 'host'],
  ['Host IPv6 loopback', { rawHeaders: ['Host', `[::1]:${PORT}`] }, 'host'],
  ['Host with trailing space', { rawHeaders: ['Host', `127.0.0.1:${PORT} `] }, 'host'],
  ['Host of another site', { rawHeaders: ['Host', 'evil.example.test'] }, 'host'],
  ['remote documentation address', { remoteAddress: '192.0.2.1' }, 'remote_address'],
  ['remote IPv6 loopback', { remoteAddress: '::1' }, 'remote_address'],
  ['remote 127.0.0.2', { remoteAddress: '127.0.0.2' }, 'remote_address'],
  ['remote mapped non-loopback', { remoteAddress: '::ffff:192.0.2.1' }, 'remote_address'],
  ['remote unknown', { remoteAddress: null }, 'remote_address'],
  ['local any address', { localAddress: '0.0.0.0' }, 'local_address'],
  ['local unknown', { localAddress: null }, 'local_address'],
  ['local IPv6 loopback', { localAddress: '::1' }, 'local_address'],
  ['odd raw header list', { rawHeaders: [...hostHeader, 'Accept'] }, 'malformed_headers'],
  ['Origin', { rawHeaders: [...hostHeader, 'Origin', 'https://evil.example.test'] }, 'forbidden_header'],
  ['Origin null', { rawHeaders: [...hostHeader, 'Origin', 'null'] }, 'forbidden_header'],
  ['Referer', { rawHeaders: [...hostHeader, 'Referer', 'https://evil.example.test/page'] }, 'forbidden_header'],
  ['Cookie', { rawHeaders: [...hostHeader, 'Cookie', 'session=synthetic'] }, 'forbidden_header'],
  ['Authorization', { rawHeaders: [...hostHeader, 'Authorization', 'Bearer synthetic'] }, 'forbidden_header'],
  ['Upgrade', { rawHeaders: [...hostHeader, 'Upgrade', 'websocket'] }, 'forbidden_header'],
  ['Expect', { rawHeaders: [...hostHeader, 'Expect', '100-continue'] }, 'forbidden_header'],
  ['Transfer-Encoding', { rawHeaders: [...hostHeader, 'Transfer-Encoding', 'chunked'] }, 'forbidden_header'],
  ['Sec-Fetch-Mode', { rawHeaders: [...hostHeader, 'Sec-Fetch-Mode', 'no-cors'] }, 'forbidden_header'],
  ['sec-fetch-site lowercase', { rawHeaders: [...hostHeader, 'sec-fetch-site', 'cross-site'] }, 'forbidden_header'],
  ['SEC-FETCH-DEST uppercase', { rawHeaders: [...hostHeader, 'SEC-FETCH-DEST', 'empty'] }, 'forbidden_header'],
  ['non-zero Content-Length', { rawHeaders: [...hostHeader, 'Content-Length', '5'] }, 'content_length'],
  ['malformed Content-Length', { rawHeaders: [...hostHeader, 'Content-Length', 'abc'] }, 'content_length'],
];

describe('handle(): uniform 404 for every rejection', () => {
  test.each(REJECTIONS)('%s → 404 counted as %s', async (_name, over, reason) => {
    const s = await setup();
    const r = s.get(over);
    expect(r.status).toBe(404);
    expect(r.headers).toEqual(NOT_FOUND_HEADERS);
    expect(r.body.length).toBe(0);
    expect(s.host.failureCounters()[reason]).toBe(1);
    expect(s.host.audit()).toEqual([]);
  });

  test('every rejection reason produces byte-identical responses', async () => {
    const s = await setup();
    const wires = new Set(REJECTIONS.map(([, over]) => wire(s.get(over))));
    expect(wires.size).toBe(1);
    // 与原因无关：响应头的顺序也相同
    expect([...wires][0]).toBe(JSON.stringify([404, Object.entries(NOT_FOUND_HEADERS), '']));
    const counters = s.host.failureCounters();
    expect(Object.values(counters).reduce((a, b) => a + b, 0)).toBe(REJECTIONS.length);
  });

  test('a local port that differs from the bound port is rejected', async () => {
    const s = await setup();
    const r = s.host.handle({ ...goodRequest(), localPort: PORT + 1 });
    expect(wire(r.response)).toBe(wire(s.get({ method: 'POST' })));
    expect(s.host.failureCounters().local_port).toBe(1);
  });

  test('not bound: even a perfect request is rejected (Host cannot match)', async () => {
    const clock = new FakeClock('2026-10-31T00:00:00.000Z');
    const host = createResourceHost({ token: TOKEN, clock, logger: recordingLogger(), binder: virtualBinder() });
    host.configure(PORT);
    host.loadCommitted({ generation: 1, content: sampleContent(1) });
    expect(host.handle({ ...goodRequest(), localPort: PORT }).response.status).toBe(404);
    expect(host.failureCounters().host).toBe(1);
  });
});

describe('handle(): accepted requests', () => {
  test('200 with exactly the fixed headers and the full body', async () => {
    const s = await setup();
    const r = s.get();
    expect(r.status).toBe(200);
    const body = Buffer.from(sampleContent(3), 'utf8');
    expect(r.headers).toEqual({
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': String(body.length),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Referrer-Policy': 'no-referrer',
      Connection: 'close',
    });
    expect(r.body.equals(body)).toBe(true);
  });

  test('header names are case-insensitive; mapped loopback addresses, Content-Length: 0 and conditional/encoding headers are fine', async () => {
    const s = await setup();
    const r = s.get({
      rawHeaders: [
        'HOST',
        `127.0.0.1:${PORT}`,
        'Content-Length',
        '0',
        'If-None-Match',
        '"etag"',
        'If-Modified-Since',
        'Sat, 31 Oct 2026 00:00:00 GMT',
        'Accept-Encoding',
        'gzip, br',
        'Accept-Language',
        'zh-CN',
      ],
      remoteAddress: '::ffff:127.0.0.1',
      localAddress: '::ffff:127.0.0.1',
    });
    // 条件请求头与压缩一律忽略：总是完整的明文 200，没有 ETag、Last-Modified、Content-Encoding 或 CORS 头
    expect(r.status).toBe(200);
    expect(r.body.toString('utf8')).toBe(sampleContent(3));
    const names = Object.keys(r.headers).map((k) => k.toLowerCase());
    for (const banned of ['etag', 'last-modified', 'content-encoding', 'access-control-allow-origin', 'vary', 'date']) expect(names).not.toContain(banned);
  });

  test('Content-Length counts UTF-8 bytes', async () => {
    const s = await setup();
    const content = '# SFE managed resource · generation 4\n节点 = reject\n';
    s.host.unload();
    s.host.loadCommitted({ generation: 4, content });
    const r = s.get();
    expect(r.headers['Content-Length']).toBe(String(Buffer.byteLength(content, 'utf8')));
    expect(r.body.toString('utf8')).toBe(content);
  });

  test('a returned body cannot change what is served next', async () => {
    const s = await setup();
    s.get().body.fill(0);
    expect(s.get().body.toString('utf8')).toBe(sampleContent(3));
  });
});

describe('503 versus 404', () => {
  test('503 only for a valid token while nothing is served; same headers as the 404', async () => {
    const s = await setup({ load: false });
    expect(s.host.served()).toBeNull();
    const r = s.get();
    expect(r.status).toBe(503);
    expect(r.headers).toEqual(NOT_FOUND_HEADERS);
    expect(r.body.length).toBe(0);
    expect(s.host.failureCounters().unavailable).toBe(1);
    expect(s.host.audit()).toEqual([]);
  });

  test('every rejection still wins over 503 while nothing is served', async () => {
    const s = await setup({ load: false });
    for (const [, over] of REJECTIONS) expect(s.get(over).status).toBe(404);
    expect(s.host.failureCounters().unavailable).toBeUndefined();
  });

  test('refuseToken: a valid token gets the uniform 404, never 200 or 503', async () => {
    const s = await setup();
    const canonical = wire(s.get({ method: 'POST' }));
    s.host.setRefuseToken(true);
    expect(wire(s.get())).toBe(canonical);
    s.host.unload();
    expect(wire(s.get())).toBe(canonical);
    expect(s.host.failureCounters().token_refused).toBe(2);
    expect(s.host.audit()).toEqual([]);
    s.host.loadCommitted({ generation: 3, content: sampleContent(3) });
    s.host.setRefuseToken(false);
    expect(s.get().status).toBe(200);
  });
});

describe('audit records', () => {
  test('onServed fires before the response is written (complete=false) and again after (complete=true)', async () => {
    const clock = new FakeClock('2026-10-31T00:00:00.000Z');
    const events: string[] = [];
    const inner = virtualBinder();
    // 记录写出的时刻：包一层绑定方
    const binder: ResourceBinder = {
      bind: (port, handler) =>
        inner.bind(port, (req, respond) =>
          handler(req, (r, onFinished) => {
            events.push(`write:${r.status}`);
            respond(r, onFinished);
          }),
        ),
    };
    const host = createResourceHost({ token: TOKEN, clock, logger: recordingLogger(), binder });
    host.configure(PORT);
    await host.listen();
    host.loadCommitted({ generation: 7, content: sampleContent(7) });
    const seen: ResourceAuditRecord[] = [];
    host.onServed((rec) => {
      events.push(`served:${rec.complete}`);
      seen.push(rec);
    });
    const mark = host.auditMark();
    expect(inner.request(PORT, goodRequest()).status).toBe(200);
    expect(events).toEqual(['served:false', 'write:200', 'served:true']);
    expect(seen).toEqual([
      { seq: mark, at: new Date('2026-10-31T00:00:00.000Z'), generation: 7, complete: false },
      { seq: mark, at: new Date('2026-10-31T00:00:00.000Z'), generation: 7, complete: true },
    ]);
    expect(host.audit()).toEqual([{ seq: mark, at: new Date('2026-10-31T00:00:00.000Z'), generation: 7, complete: true }]);
    expect(host.auditMark()).toBe(mark + 1);
  });

  test('handle() called directly records the 200; only finished() (after the caller wrote it all) marks it complete', async () => {
    const s = await setup();
    const seen: boolean[] = [];
    s.host.onServed((rec) => seen.push(rec.complete));
    const r = s.host.handle({ ...goodRequest(), localPort: PORT });
    expect(r.response.status).toBe(200);
    expect(s.host.audit()).toEqual([expect.objectContaining({ seq: 1, complete: false, generation: 3 })]);
    r.finished();
    expect(s.host.audit()).toEqual([expect.objectContaining({ seq: 1, complete: true, generation: 3 })]);
    // 重复调用无效（不再通知）
    r.finished();
    expect(seen).toEqual([false, true]);
    // 中途断开的调用方不调用 finished()：记录保持未完成
    const aborted = s.host.handle({ ...goodRequest(), localPort: PORT });
    expect(aborted.response.status).toBe(200);
    expect(s.host.audit().map((a) => [a.seq, a.complete])).toEqual([
      [1, true],
      [2, false],
    ]);
  });

  test('finished() of a 404 or 503 does nothing', async () => {
    const s = await setup({ load: false });
    const seen: ResourceAuditRecord[] = [];
    s.host.onServed((rec) => seen.push(rec));
    const unavailable = s.host.handle({ ...goodRequest(), localPort: PORT });
    expect(unavailable.response.status).toBe(503);
    unavailable.finished();
    const rejected = s.host.handle({ ...goodRequest({ method: 'POST' }), localPort: PORT });
    expect(rejected.response.status).toBe(404);
    rejected.finished();
    expect(seen).toEqual([]);
    expect(s.host.audit()).toEqual([]);
  });

  test('a binder that never finishes the write leaves the record incomplete', async () => {
    const clock = new FakeClock('2026-10-31T00:00:00.000Z');
    const inner = virtualBinder();
    const binder: ResourceBinder = { bind: (port, handler) => inner.bind(port, (req, respond) => handler(req, (r) => respond(r))) };
    const host = createResourceHost({ token: TOKEN, clock, logger: recordingLogger(), binder });
    host.configure(PORT);
    await host.listen();
    host.loadCommitted({ generation: 1, content: sampleContent(1) });
    const seen: boolean[] = [];
    host.onServed((r) => seen.push(r.complete));
    expect(inner.request(PORT, goodRequest()).status).toBe(200);
    expect(seen).toEqual([false]);
    expect(host.audit()[0]!.complete).toBe(false);
  });

  test('when the record cannot be saved the content is not served (503) and the record is dropped', async () => {
    const s = await setup();
    const off = s.host.onServed(() => {
      throw new Error('disk full');
    });
    const r = s.get();
    expect(r.status).toBe(503);
    expect(r.body.length).toBe(0);
    expect(s.host.audit()).toEqual([]);
    expect(s.host.failureCounters().audit_failed).toBe(1);
    off();
    expect(s.get().status).toBe(200);
    // 序号不复用
    expect(s.host.audit().map((a) => a.seq)).toEqual([2]);
  });

  test('a failure while recording completion is only counted (the body is already out)', async () => {
    const s = await setup();
    s.host.onServed((rec) => {
      if (rec.complete) throw new Error('disk full');
    });
    expect(s.get().status).toBe(200);
    expect(s.host.audit()[0]!.complete).toBe(true);
    // 单独计数：它不是一次失败答复（审计的 servedFailureCount 不计入）
    expect(s.host.failureCounters()).toEqual({ audit_complete_failed: 1 });
  });

  test('bounded to the last 64 records; seq keeps increasing', async () => {
    const s = await setup();
    for (let i = 0; i < RESOURCE_AUDIT_LIMIT + 6; i++) {
      s.clock.advance(1000);
      expect(s.get().status).toBe(200);
    }
    const a = s.host.audit();
    expect(a).toHaveLength(RESOURCE_AUDIT_LIMIT);
    expect(a[0]!.seq).toBe(7);
    expect(a.at(-1)!.seq).toBe(RESOURCE_AUDIT_LIMIT + 6);
    expect(a.every((r) => r.complete)).toBe(true);
    expect(s.host.auditMark()).toBe(RESOURCE_AUDIT_LIMIT + 7);
  });

  test('restored records continue the sequence after a restart', async () => {
    const records: ResourceAuditRecord[] = [
      { seq: 40, at: new Date('2026-10-30T00:00:00.000Z'), generation: 2, complete: true },
      { seq: 41, at: new Date('2026-10-30T00:00:05.000Z'), generation: 3, complete: false },
    ];
    const s = await setup({ audit: { records, nextSeq: 45 } });
    expect(s.host.auditMark()).toBe(45);
    expect(s.host.audit()).toEqual(records);
    expect(s.get().status).toBe(200);
    expect(s.host.audit().map((r) => r.seq)).toEqual([40, 41, 45]);
    // nextSeq 小于记录序号时取记录序号之后
    const t = await setup({ audit: { records, nextSeq: 3 } });
    expect(t.host.auditMark()).toBe(42);
  });

  test('audit() hands out copies', async () => {
    const s = await setup();
    s.get();
    const a = s.host.audit();
    (a[0]!.at as Date).setTime(0);
    expect(s.host.audit()[0]!.at.toISOString()).toBe('2026-10-31T00:00:00.000Z');
  });
});

describe('served state', () => {
  test('load, stage, revert, commit, unload', async () => {
    const s = await setup({ load: false });
    expect(s.host.served()).toBeNull();
    const c0 = sampleContent(0, []);
    s.host.loadCommitted({ generation: 0, content: c0 });
    expect(s.host.served()).toEqual({ generation: 0, state: 'committed', bytes: Buffer.byteLength(c0) });
    const c5 = sampleContent(5, ['SFE-N-E0001-US01-v001', 'SFE-N-E0002-US02-v001']);
    s.host.stageCandidate({ generation: 5, content: c5 });
    expect(s.host.served()).toEqual({ generation: 5, state: 'candidate', bytes: Buffer.byteLength(c5) });
    expect(s.get().body.toString('utf8')).toBe(c5);
    s.host.revertToCommitted();
    expect(s.host.served()).toEqual({ generation: 0, state: 'committed', bytes: Buffer.byteLength(c0) });
    expect(s.get().body.toString('utf8')).toBe(c0);
    s.host.stageCandidate({ generation: 6, content: c5 });
    s.host.commitCandidate();
    expect(s.host.served()).toEqual({ generation: 6, state: 'committed', bytes: Buffer.byteLength(c5) });
    expect(s.host.audit().map((r) => r.generation)).toEqual([5, 0]);
    s.host.unload();
    expect(s.host.served()).toBeNull();
    expect(s.get().status).toBe(503);
  });

  test('illegal transitions throw and leave the state unchanged', async () => {
    const s = await setup();
    expect(() => s.host.commitCandidate()).toThrow(SfeError);
    expect(() => s.host.stageCandidate({ generation: 3, content: sampleContent(3) })).toThrow(SfeError);
    s.host.stageCandidate({ generation: 4, content: sampleContent(4) });
    expect(() => s.host.stageCandidate({ generation: 5, content: sampleContent(5) })).toThrow(SfeError);
    expect(() => s.host.loadCommitted({ generation: 9, content: sampleContent(9) })).toThrow(SfeError);
    expect(s.host.served()).toEqual(expect.objectContaining({ generation: 4, state: 'candidate' }));
    for (const generation of [-1, 1.5, Number.NaN]) {
      expect(() => s.host.loadCommitted({ generation, content: 'x' })).toThrow(SfeError);
    }
    expect(() => s.host.loadCommitted({ generation: 1, content: 7 as unknown as string })).toThrow(SfeError);
  });

  test('a candidate staged with nothing committed reverts to 503', async () => {
    const s = await setup({ load: false });
    s.host.stageCandidate({ generation: 2, content: sampleContent(2) });
    expect(s.get().status).toBe(200);
    s.host.revertToCommitted();
    expect(s.host.served()).toBeNull();
    expect(s.get().status).toBe(503);
  });

  test('content over 1 MiB is refused (load and stage); exactly 1 MiB is accepted', async () => {
    const s = await setup({ load: false });
    const exact = 'x'.repeat(RESOURCE_MAX_BYTES);
    const over = 'x'.repeat(RESOURCE_MAX_BYTES + 1);
    // 多字节字符按 UTF-8 字节计
    const overMultibyte = '节'.repeat(Math.floor(RESOURCE_MAX_BYTES / 3) + 1);
    for (const content of [over, overMultibyte]) {
      expect(() => s.host.loadCommitted({ generation: 1, content })).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
      expect(() => s.host.stageCandidate({ generation: 2, content })).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
    }
    expect(s.host.served()).toBeNull();
    s.host.loadCommitted({ generation: 1, content: exact });
    expect(s.host.served()?.bytes).toBe(RESOURCE_MAX_BYTES);
    expect(s.get().body.length).toBe(RESOURCE_MAX_BYTES);
  });
});

describe('configure, listen, close', () => {
  test('url follows the configured port regardless of the binding; listening means bound on the configured port', async () => {
    const registry = new Map<number, unknown>();
    const host = createResourceHost({ token: TOKEN, clock: new FakeClock(), logger: recordingLogger(), binder: virtualBinder(registry) });
    expect(host.url()).toBeNull();
    await expect(host.listen()).rejects.toMatchObject({ code: 'RESOURCE_SERVER_UNAVAILABLE', details: { reason: 'other' } });
    host.configure(PORT);
    expect(host.url()).toBe(`http://127.0.0.1:${PORT}${PATH}`);
    expect(host.port()).toBeNull();
    expect(host.listening()).toBe(false);
    await host.listen();
    await host.listen();
    expect(host.port()).toBe(PORT);
    expect(host.listening()).toBe(true);
    expect([...registry.keys()]).toEqual([PORT]);
    host.configure(PORT + 1);
    expect(host.listening()).toBe(false);
    expect(host.port()).toBe(PORT);
    expect(host.url()).toBe(`http://127.0.0.1:${PORT + 1}${PATH}`);
    await host.listen();
    expect(host.port()).toBe(PORT + 1);
    expect([...registry.keys()]).toEqual([PORT + 1]);
    await host.close();
    expect(host.port()).toBeNull();
    expect(host.listening()).toBe(false);
    expect(registry.size).toBe(0);
    await host.close();
  });

  test('configure validates the port (range checks live in settings)', () => {
    const host = createResourceHost({ token: TOKEN, clock: new FakeClock(), logger: recordingLogger(), binder: virtualBinder() });
    for (const bad of [0, -1, 65536, 1.5, Number.NaN]) expect(() => host.configure(bad)).toThrow(RangeError);
    host.configure(18084);
    expect(host.url()).toBe(`http://127.0.0.1:18084${PATH}`);
    host.configure(null);
    expect(host.url()).toBeNull();
  });

  test('a malformed token is refused without echoing it', () => {
    for (const bad of [TOKEN.toUpperCase(), 'a'.repeat(63), `${'a'.repeat(63)}g`]) {
      let message = '';
      try {
        createResourceHost({ token: bad, clock: new FakeClock(), logger: recordingLogger(), binder: virtualBinder() });
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toBe('invalid resource token format');
    }
  });

  test('a binder that reports another port is refused', async () => {
    const binder: ResourceBinder = { bind: async () => ({ port: PORT + 9, close: async () => undefined }) };
    const host = createResourceHost({ token: TOKEN, clock: new FakeClock(), logger: recordingLogger(), binder });
    host.configure(PORT);
    await expect(host.listen()).rejects.toMatchObject({ code: 'RESOURCE_SERVER_UNAVAILABLE' });
    expect(host.listening()).toBe(false);
  });

  test('regression: configure() while a listen is pending → a later listen() binds the new port (never resolves unbound)', async () => {
    const registry = new Map<number, unknown>();
    const inner = virtualBinder(registry);
    const binds: number[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const binder: ResourceBinder = {
      bind: async (port, handler) => {
        binds.push(port);
        if (binds.length === 1) await gate;
        return inner.bind(port, handler);
      },
    };
    const host = createResourceHost({ token: TOKEN, clock: new FakeClock(), logger: recordingLogger(), binder });
    host.configure(PORT);
    const p1 = host.listen();
    // 同一端口的并发调用共用进行中的绑定
    const p1b = host.listen();
    host.configure(PORT + 1);
    const p2 = host.listen();
    release();
    await p1;
    await p1b;
    await p2;
    expect(binds).toEqual([PORT, PORT + 1]);
    expect(host.port()).toBe(PORT + 1);
    expect(host.listening()).toBe(true);
    expect([...registry.keys()]).toEqual([PORT + 1]);
    expect(host.url()).toBe(`http://127.0.0.1:${PORT + 1}${PATH}`);
    await host.close();
  });

  test('a pending listen that fails does not stop a later listen() for a changed port', async () => {
    const registry = new Map<number, unknown>([[PORT, 'squatter']]);
    const host = createResourceHost({ token: TOKEN, clock: new FakeClock(), logger: recordingLogger(), binder: virtualBinder(registry) });
    host.configure(PORT);
    const p1 = host.listen();
    host.configure(PORT + 1);
    const p2 = host.listen();
    await expect(p1).rejects.toMatchObject({ details: { reason: 'port_in_use' } });
    await p2;
    expect(host.listening()).toBe(true);
    expect(host.port()).toBe(PORT + 1);
    await host.close();
  });

  test('a non-SfeError bind failure becomes RESOURCE_SERVER_UNAVAILABLE other', async () => {
    const binder: ResourceBinder = {
      bind: async () => {
        throw new Error('EACCES');
      },
    };
    const host = createResourceHost({ token: TOKEN, clock: new FakeClock(), logger: recordingLogger(), binder });
    host.configure(PORT);
    await expect(host.listen()).rejects.toMatchObject({ code: 'RESOURCE_SERVER_UNAVAILABLE', details: { reason: 'other' } });
  });
});

describe('virtualBinder', () => {
  test('port exclusivity through the shared registry; the port is released on close', async () => {
    const registry = new Map<number, unknown>();
    const a = await setup({ registry });
    const second = createResourceHost({ token: TOKEN, clock: new FakeClock(), logger: recordingLogger(), binder: virtualBinder(registry) });
    second.configure(PORT);
    await expect(second.listen()).rejects.toMatchObject({ code: 'RESOURCE_SERVER_UNAVAILABLE', details: { reason: 'port_in_use' } });
    expect(second.listening()).toBe(false);
    await a.host.close();
    await second.listen();
    expect(second.listening()).toBe(true);
    // 新实例接手：请求到达新实例（未加载 → 503）
    expect(a.binder.request(PORT, goodRequest()).status).toBe(503);
  });

  test('a port pre-occupied by someone else is in use, and requests to it are refused', async () => {
    const registry = new Map<number, unknown>([[PORT, 'squatter']]);
    const binder = virtualBinder(registry);
    await expect(binder.bind(PORT, () => undefined)).rejects.toMatchObject({ details: { reason: 'port_in_use' } });
    expect(() => binder.request(PORT, goodRequest())).toThrow(expect.objectContaining({ code: 'ECONNREFUSED' }));
  });

  test('nobody bound → ECONNREFUSED; a handler that does not respond → ECONNRESET', async () => {
    const binder = virtualBinder();
    expect(() => binder.request(PORT, goodRequest())).toThrow(expect.objectContaining({ code: 'ECONNREFUSED' }));
    await binder.bind(PORT, () => undefined);
    expect(() => binder.request(PORT, goodRequest())).toThrow(expect.objectContaining({ code: 'ECONNRESET' }));
    await expect(binder.bind(0, () => undefined)).rejects.toMatchObject({ code: 'RESOURCE_SERVER_UNAVAILABLE' });
    await expect(binder.bind(RESOURCE_PORT_MIN, () => undefined)).resolves.toMatchObject({ port: RESOURCE_PORT_MIN });
  });

  test('a stale close does not release a port that another binding now holds', async () => {
    const registry = new Map<number, unknown>();
    const binder = virtualBinder(registry);
    const first = await binder.bind(PORT, (_req, respond) => respond({ status: 404, headers: {}, body: Buffer.alloc(0) }));
    await first.close();
    await binder.bind(PORT, (_req, respond) => respond({ status: 503, headers: {}, body: Buffer.alloc(0) }));
    await first.close();
    expect(registry.has(PORT)).toBe(true);
    expect(binder.request(PORT, goodRequest()).status).toBe(503);
  });
});

describe('logging', () => {
  test('at most one line per reason per minute, with the count carried over', async () => {
    const s = await setup();
    for (let i = 0; i < 5; i++) s.get({ method: 'POST' });
    s.get({ rawPath: `/${OTHER_TOKEN}/sfe-nodes.list` });
    const rejected = () => s.logger.entries.filter((e) => e.msg === 'resource.request_rejected');
    expect(rejected().map((e) => e.fields)).toEqual([
      { reason: 'method', count: 1 },
      { reason: 'token_mismatch', count: 1 },
    ]);
    s.clock.advance(RESOURCE_LOG_INTERVAL_MS - 1);
    s.get({ method: 'POST' });
    expect(rejected()).toHaveLength(2);
    s.clock.advance(1);
    s.get({ method: 'POST' });
    expect(rejected().at(-1)!.fields).toEqual({ reason: 'method', count: 6 });
    expect(s.host.failureCounters().method).toBe(7);
  });

  test('logs never contain the token, the path, header values or the body', async () => {
    const s = await setup();
    s.get();
    s.get({ rawPath: `/${OTHER_TOKEN}/sfe-nodes.list` });
    s.get({ rawHeaders: [...hostHeader, 'Origin', 'https://evil.example.test', 'Cookie', 'session=synthetic-cookie'] });
    s.get({ rawPath: `${PATH}?secret=1` });
    s.host.unload();
    s.get();
    s.host.setRefuseToken(true);
    s.get();
    const text = s.logger.text();
    expect(s.logger.entries.length).toBeGreaterThanOrEqual(5);
    for (const leaked of [TOKEN, OTHER_TOKEN, 'sfe-nodes.list', 'evil.example.test', 'synthetic-cookie', 'secret=1', '192.0.2.10', 'socks5', `127.0.0.1:${PORT}`]) {
      expect(text).not.toContain(leaked);
    }
  });
});
