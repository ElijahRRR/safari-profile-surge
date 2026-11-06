// P0 测试资源服务（resource-server）在真实的 127.0.0.1 套接字上：处理程序是产品的 createResourceHost + tcpBinder；故障场景只在
// 产品处理程序接受了令牌正确的请求之后才改变答复（从不绕过 handle() 的令牌、Host、请求头与方法判断），改变了答复的请求从不标记
// 审计记录完成；请求记录只有名称与原因代码。另测占用者（--squat）只在端口空闲时绑定。

import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { rawHttp, rejectionProbes, statusOf } from '../src/commands/loopback-auth.js';
import { tcpBinder, resourceBody } from '../src/deps.js';
import {
  ensureResourceToken,
  readAuditRecords,
  readResourceLog,
  readServerStatus,
  scenarioBody,
  updateServed,
  type ResourceRequestLogEntry,
  type ResourceScenario,
} from '../src/loopback-state.js';
import { RunDir, newRunId } from '../src/run-dir.js';
import { SQUAT_BODY, startResourceServer, startSquatServer, type RunningResourceServer } from '../src/servers/resource.js';
import { TEST_NODES } from '../src/test-profile.js';
import { testLogger } from './support/loopback.js';

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
}

const clock = { now: () => new Date(), setTimeout: (fn: () => void, ms: number) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); } };
const LINES = [
  `${TEST_NODES.a} = socks5, 127.0.0.1, 18081, username=p0-a, password=example-p0, underlying-proxy=P0-Front`,
  `${TEST_NODES.b} = socks5, 127.0.0.1, 18081, username=p0-b, password=example-p0, underlying-proxy=P0-Front`,
  `${TEST_NODES.c} = socks5, 127.0.0.1, 18081, username=p0-c, password=example-p0, underlying-proxy=P0-Front`,
];

let server: RunningResourceServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

async function start(scenario: ResourceScenario | null = null) {
  const base = mkdtempSync(join(tmpdir(), 'sfe-p0-rs-'));
  const dir = RunDir.create(join(base, 'p0'), newRunId(new Date()));
  const token = ensureResourceToken(dir, () => randomBytes(32));
  const port = await freePort();
  updateServed(dir, new Date(), 'test', () => ({ committed: { generation: 1, content: resourceBody(1, LINES) } }));
  server = await startResourceServer({ dir, port, token, binder: tcpBinder({ logger: testLogger() }), clock, logger: testLogger(), scenario, peerProbe: async () => null });
  const valid = rejectionProbes(port, token).find((p) => p.id === 'valid')!.text;
  const set = async (s: ResourceScenario): Promise<void> => {
    const next = updateServed(dir, new Date(), 'test', () => ({ scenario: s }));
    await server!.sync();
    expect(server!.status().appliedRevision).toBeGreaterThanOrEqual(next.revision);
  };
  const requests = () => readResourceLog(dir).filter((e): e is ResourceRequestLogEntry => e.kind === 'request');
  return { dir, token, port, valid, set, requests };
}

function bodyOf(bytes: Buffer): string {
  const i = bytes.indexOf('\r\n\r\n');
  return i < 0 ? '' : bytes.subarray(i + 4).toString('utf8');
}

describe('resource-server over a real 127.0.0.1 socket', () => {
  it('answers a valid token with the committed generation through the product handler and completes the audit record', async () => {
    const t = await start();
    const res = await rawHttp(t.port, t.valid);
    expect(statusOf(res)).toBe(200);
    expect(bodyOf(res)).toBe(resourceBody(1, LINES));
    const [entry] = t.requests();
    expect(entry).toMatchObject({ handler: 'product', status: 200, reason: 'ok', tokenOk: true, generation: 1, scenario: 'ok', method: 'GET' });
    expect(entry!.headers).toEqual(['host', 'x-sfe-p0-probe', 'connection']);
    await new Promise((r) => setTimeout(r, 20));
    expect(readAuditRecords(t.dir)).toEqual([expect.objectContaining({ seq: entry!.seq, generation: 1, complete: true })]);
    // 请求记录从不含令牌、路径或内容
    const log = t.dir.readText('servers/resource.jsonl')!;
    expect(log).not.toContain(t.token);
    expect(log).not.toContain('sfe-nodes.list');
    expect(log).not.toContain('example-p0');
    expect(readServerStatus(t.dir)).toMatchObject({ listening: true, port: t.port, serving: { generation: 1, state: 'committed' } });
  });

  it('never lets a fault scenario bypass handle(): every rejected request gets the product 404, only an accepted one gets the fault', async () => {
    const t = await start();
    await t.set('http500');
    const probes = rejectionProbes(t.port, t.token);
    const statuses: Record<string, number | null> = {};
    for (const p of probes) statuses[p.id] = statusOf(await rawHttp(t.port, p.text));
    for (const p of probes.filter((x) => x.id !== 'valid')) expect(statuses[p.id], p.id).toBe(404);
    expect(statuses.valid).toBe(500);
    const entries = t.requests();
    expect(entries.filter((e) => e.handler === 'scenario')).toHaveLength(1);
    expect(entries.filter((e) => e.handler === 'product').every((e) => e.status === 404 && e.reason !== 'ok')).toBe(true);
    // 改答的 500 从不标记完成：核对不会把它当作一次下载
    await new Promise((r) => setTimeout(r, 20));
    expect(readAuditRecords(t.dir).every((r) => !r.complete)).toBe(true);
  });

  it('reset closes without a response, truncate cuts the declared body, hang sends headers and then nothing', async () => {
    const t = await start();
    await t.set('reset');
    expect((await rawHttp(t.port, t.valid)).length).toBe(0);
    await t.set('truncate');
    const cut = await rawHttp(t.port, t.valid);
    const declared = Number(/Content-Length: (\d+)/.exec(cut.toString('latin1'))![1]);
    expect(Buffer.byteLength(bodyOf(cut))).toBeLessThan(declared);
    await t.set('hang');
    const t0 = Date.now();
    const hung = await rawHttp(t.port, t.valid, 400);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(350);
    expect(statusOf(hung)).toBe(200);
    expect(bodyOf(hung)).toBe('');
    await new Promise((r) => setTimeout(r, 20));
    expect(readAuditRecords(t.dir).every((r) => !r.complete)).toBe(true);
    expect(t.requests().map((e) => [e.scenario, e.handler, e.status])).toEqual([
      ['reset', 'scenario', null],
      ['truncate', 'scenario', 200],
      ['hang', 'scenario', 200],
    ]);
  });

  it('content scenarios transform the served generation and stay incomplete; restartUninitialized is the product 503; stop refuses connections', async () => {
    const t = await start();
    await t.set('validAbBadC');
    const body = bodyOf(await rawHttp(t.port, t.valid));
    expect(body).toBe(scenarioBody('validAbBadC', resourceBody(1, LINES)));
    expect(body).not.toContain('p0-c');
    await t.set('restartUninitialized');
    expect(statusOf(await rawHttp(t.port, t.valid))).toBe(503);
    expect(t.requests().at(-1)).toMatchObject({ handler: 'product', status: 503, reason: 'unavailable' });
    await t.set('stop');
    expect(server!.status().listening).toBe(false);
    expect((await rawHttp(t.port, t.valid)).length).toBe(0);
    await t.set('ok');
    expect(statusOf(await rawHttp(t.port, t.valid))).toBe(200);
  });

  it('a restart drops an uncommitted candidate (like the product) and continues the audit sequence', async () => {
    const t = await start();
    updateServed(t.dir, new Date(), 'test', () => ({ candidate: { generation: 2, content: resourceBody(2, LINES.slice(0, 2)) } }));
    await server!.sync();
    expect(bodyOf(await rawHttp(t.port, t.valid))).toBe(resourceBody(2, LINES.slice(0, 2)));
    await server!.close();
    server = await startResourceServer({ dir: t.dir, port: t.port, token: t.token, binder: tcpBinder({ logger: testLogger() }), clock, logger: testLogger(), scenario: null, peerProbe: async () => null });
    expect(bodyOf(await rawHttp(t.port, t.valid))).toBe(resourceBody(1, LINES));
    await new Promise((r) => setTimeout(r, 20));
    const seqs = readAuditRecords(t.dir).map((r) => r.seq);
    expect(seqs).toEqual([1, 2]);
  });

  it('refuses to start when the port is held, never trying another port', async () => {
    const t = await start();
    await expect(startResourceServer({ dir: t.dir, port: t.port, token: t.token, binder: tcpBinder({ logger: testLogger() }), clock, logger: testLogger(), scenario: null })).rejects.toMatchObject({
      code: 'RESOURCE_SERVER_UNAVAILABLE',
      details: { reason: 'port_in_use' },
    });
  });
});

describe('squatter (--squat)', () => {
  it('binds 127.0.0.1 only when the port is free and answers anything with the forged list', async () => {
    const port = await freePort();
    const logs: ResourceRequestLogEntry[] = [];
    const sq = await startSquatServer({ port, mode: 'squat200', binder: tcpBinder({ logger: testLogger() }), clock, token: 'a'.repeat(64), log: (e) => void (e.kind === 'request' && logs.push(e)) });
    try {
      expect(sq.holdsLoopback).toBe(true);
      const res = await rawHttp(port, `GET /${'a'.repeat(64)}/sfe-nodes.list HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
      expect(statusOf(res)).toBe(200);
      expect(bodyOf(res)).toBe(SQUAT_BODY);
      expect(logs).toEqual([expect.objectContaining({ role: 'squat', handler: 'squat', tokenOk: true, status: 200 })]);
    } finally {
      await sq.close();
    }
  });

  it('squatHang takes the request (with the token) and writes only the headers: Surge waits until its request timeout', async () => {
    const port = await freePort();
    const logs: ResourceRequestLogEntry[] = [];
    const sq = await startSquatServer({ port, mode: 'squatHang', binder: tcpBinder({ logger: testLogger() }), clock, token: 'a'.repeat(64), log: (e) => void (e.kind === 'request' && logs.push(e)) });
    try {
      expect(sq.holdsLoopback).toBe(true);
      const t0 = Date.now();
      // 读到时限为止：只有响应头（声明完整长度），没有内容，连接一直没有被占用者关闭
      const res = await rawHttp(port, `GET /${'a'.repeat(64)}/sfe-nodes.list HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`, 400);
      expect(Date.now() - t0).toBeGreaterThanOrEqual(350);
      expect(statusOf(res)).toBe(200);
      const text = res.toString('latin1');
      expect(text).toMatch(new RegExp(`Content-Length: ${Buffer.byteLength(SQUAT_BODY)}\\r\\n`, 'i'));
      expect(text.slice(text.indexOf('\r\n\r\n') + 4)).toBe('');
      expect(logs).toEqual([expect.objectContaining({ role: 'squat', handler: 'squat', tokenOk: true, scenario: 'squatHang', bytes: 0 })]);
    } finally {
      await sq.close();
    }
  });

  it('fails to bind 127.0.0.1 while the resource server holds the port and records the other addresses', async () => {
    const t = await start();
    const sq = await startSquatServer({ port: t.port, mode: 'squat404', binder: tcpBinder({ logger: testLogger() }), clock, token: null, log: null });
    try {
      expect(sq.holdsLoopback).toBe(false);
      expect(sq.binds[0]).toEqual({ address: '127.0.0.1', result: 'in_use' });
      expect(sq.binds.map((b) => b.address)).toEqual(['127.0.0.1', '0.0.0.0', '::', '::1']);
      // 发往 127.0.0.1 的请求仍到达资源服务
      expect(statusOf(await rawHttp(t.port, t.valid))).toBe(200);
      expect(sq.requests()).toBe(0);
    } finally {
      await sq.close();
    }
  });
});
