// tcpBinder 的真实套接字测试：只在 127.0.0.1 上，端口在 [RESOURCE_PORT_MIN, RESOURCE_PORT_MAX) 内随机选取（被占用时换一个）。
// 只用合成令牌与内容；不连接任何外部地址。
import { request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { afterEach, describe, expect, test } from 'vitest';
import { RESOURCE_PORT_MAX, RESOURCE_PORT_MIN, SfeError } from '@sfe/contract';
import { createResourceHost, tcpBinder, type ResourceAuditRecord, type ResourceHost } from '../../src/resource/index.js';
import { FakeClock } from '../../src/util/clock.js';
import { OTHER_TOKEN, PATH, TOKEN, recordingLogger, sampleContent } from './helpers.js';

const hosts: ResourceHost[] = [];

afterEach(async () => {
  for (const h of hosts.splice(0)) await h.close();
});

/** 在范围内随机选端口并监听；被占用（本机其他程序）时换一个。 */
async function listeningHost(load = true): Promise<{ host: ResourceHost; port: number; served: ResourceAuditRecord[] }> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = RESOURCE_PORT_MIN + Math.floor(Math.random() * (RESOURCE_PORT_MAX - RESOURCE_PORT_MIN));
    const host = createResourceHost({ token: TOKEN, clock: new FakeClock('2026-10-31T00:00:00.000Z'), logger: recordingLogger(), binder: tcpBinder({ logger: recordingLogger() }) });
    host.configure(port);
    try {
      await host.listen();
    } catch (err) {
      if (err instanceof SfeError && err.details?.reason === 'port_in_use') continue;
      throw err;
    }
    hosts.push(host);
    if (load) host.loadCommitted({ generation: 2, content: sampleContent(2) });
    const served: ResourceAuditRecord[] = [];
    host.onServed((r) => served.push(r));
    return { host, port, served };
  }
  throw new Error('no free port in range');
}

interface HttpResult {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  rawHeaders: string[];
  body: Buffer;
}

function get(port: number, path: string, headers: Record<string, string> = {}): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'GET', headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, rawHeaders: res.rawHeaders, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

/** 原始请求：返回服务器在关闭连接之前送出的全部字节，以及连接是否由对方关闭。 */
function raw(port: number, text: string, timeoutMs = 4000): Promise<{ data: string; closed: boolean; error: string | null }> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    const chunks: Buffer[] = [];
    let error: string | null = null;
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ data: Buffer.concat(chunks).toString('latin1'), closed: false, error });
    }, timeoutMs);
    socket.on('data', (c: Buffer) => chunks.push(c));
    socket.on('error', (e: NodeJS.ErrnoException) => {
      error = e.code ?? 'error';
    });
    socket.on('close', () => {
      clearTimeout(timer);
      resolve({ data: Buffer.concat(chunks).toString('latin1'), closed: true, error });
    });
    socket.write(text);
  });
}

async function eventually(check: () => boolean, ms = 2000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('tcpBinder on 127.0.0.1', () => {
  test('GET with the correct Host → 200 with the fixed headers; the audit record completes', async () => {
    const { host, port, served } = await listeningHost();
    expect(host.listening()).toBe(true);
    expect(host.port()).toBe(port);
    const r = await get(port, PATH);
    expect(r.status).toBe(200);
    expect(r.body.toString('utf8')).toBe(sampleContent(2));
    expect(r.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(r.headers['content-length']).toBe(String(Buffer.byteLength(sampleContent(2))));
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers.connection).toBe('close');
    // 不发送 Date、ETag、Last-Modified 或 CORS 头
    for (const banned of ['date', 'etag', 'last-modified', 'access-control-allow-origin', 'keep-alive']) expect(r.headers[banned]).toBeUndefined();
    await eventually(() => served.length === 2);
    expect(served.map((s) => s.complete)).toEqual([false, true]);
    expect(host.audit()).toEqual([expect.objectContaining({ seq: 1, generation: 2, complete: true })]);
  });

  test('wrong token and wrong Host port → identical 404 responses', async () => {
    const { port } = await listeningHost();
    const a = await get(port, `/${OTHER_TOKEN}/sfe-nodes.list`);
    const b = await get(port, PATH, { Host: `127.0.0.1:${port + 1}` });
    const c = await get(port, PATH, { Host: `localhost:${port}` });
    for (const r of [a, b, c]) {
      expect(r.status).toBe(404);
      expect(r.body.length).toBe(0);
    }
    expect(b.rawHeaders).toEqual(a.rawHeaders);
    expect(c.rawHeaders).toEqual(a.rawHeaders);
  });

  test('nothing loaded → 503 for the valid token only', async () => {
    const { port } = await listeningHost(false);
    expect((await get(port, PATH)).status).toBe(503);
    expect((await get(port, `/${OTHER_TOKEN}/sfe-nodes.list`)).status).toBe(404);
  });

  test('a second bind of the same port fails with port_in_use; close releases the port', async () => {
    const { host, port } = await listeningHost();
    const other = createResourceHost({ token: TOKEN, clock: new FakeClock(), logger: recordingLogger(), binder: tcpBinder({ logger: recordingLogger() }) });
    other.configure(port);
    await expect(other.listen()).rejects.toMatchObject({ code: 'RESOURCE_SERVER_UNAVAILABLE', details: { reason: 'port_in_use' } });
    await expect(tcpBinder({ logger: recordingLogger() }).bind(port, () => undefined)).rejects.toMatchObject({ details: { reason: 'port_in_use' } });
    await host.close();
    expect(host.listening()).toBe(false);
    await other.listen();
    hosts.push(other);
    expect(other.listening()).toBe(true);
    other.loadCommitted({ generation: 9, content: sampleContent(9) });
    expect((await get(port, PATH)).body.toString('utf8')).toBe(sampleContent(9));
  });

  test('a request body gets the 404 and the connection is closed', async () => {
    const { port, served } = await listeningHost();
    const reference = await raw(port, `GET /${OTHER_TOKEN}/sfe-nodes.list HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`);
    expect(reference.data.startsWith('HTTP/1.1 404 ')).toBe(true);
    const res = await raw(port, `GET ${PATH} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Length: 5\r\n\r\nhello`);
    expect(res.closed).toBe(true);
    expect(res.data).toBe(reference.data);
    const chunked = await raw(port, `GET ${PATH} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n`);
    expect(chunked.closed).toBe(true);
    expect(chunked.data).toBe(reference.data);
    expect(served).toEqual([]);
  });

  test('Connection: close even when the client asks for keep-alive', async () => {
    const { port } = await listeningHost();
    const res = await raw(port, `GET ${PATH} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: keep-alive\r\n\r\n`);
    expect(res.closed).toBe(true);
    expect(res.data.startsWith('HTTP/1.1 200 ')).toBe(true);
    expect(res.data).toMatch(/\r\nConnection: close\r\n/);
    expect(res.data).not.toMatch(/\r\nDate: /i);
  });

  test('duplicate Host, missing Host and Expect all get the uniform 404 (never 400, 100 or 417)', async () => {
    const { port } = await listeningHost();
    const dup = await raw(port, `GET ${PATH} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nHost: 127.0.0.1:${port}\r\n\r\n`);
    const missing = await raw(port, `GET ${PATH} HTTP/1.1\r\n\r\n`);
    const http10 = await raw(port, `GET ${PATH} HTTP/1.0\r\n\r\n`);
    const expect100 = await raw(port, `GET ${PATH} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nExpect: 100-continue\r\n\r\n`);
    const expectOther = await raw(port, `GET ${PATH} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nExpect: something\r\n\r\n`);
    const reference = await raw(port, `GET /${OTHER_TOKEN}/sfe-nodes.list HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`);
    expect(reference.data.startsWith('HTTP/1.1 404 ')).toBe(true);
    for (const r of [dup, missing, http10, expect100, expectOther]) {
      expect(r.data.startsWith('HTTP/1.1 404 ')).toBe(true);
      expect(r.data).toBe(reference.data);
    }
  });

  test('regression: pipelined requests on one connection → only the first is handled; no audit record for the rest', async () => {
    const { host, port, served } = await listeningHost();
    const valid = `GET ${PATH} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`;
    const two = await raw(port, valid + valid);
    expect(two.closed).toBe(true);
    expect(two.data.match(/HTTP\/1\.1 /g)).toHaveLength(1);
    expect(two.data.startsWith('HTTP/1.1 200 ')).toBe(true);
    await eventually(() => served.length === 2);
    expect(host.audit()).toEqual([expect.objectContaining({ seq: 1, complete: true })]);
    // 第一个请求被拒绝：只有一个 404，后面合格的请求既不答复也不产生记录
    const rejectedFirst = await raw(port, `GET /x HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n` + valid);
    expect(rejectedFirst.closed).toBe(true);
    expect(rejectedFirst.data.match(/HTTP\/1\.1 /g)).toHaveLength(1);
    expect(rejectedFirst.data.startsWith('HTTP/1.1 404 ')).toBe(true);
    expect(host.audit()).toHaveLength(1);
    expect(host.failureCounters()).toEqual({ path: 1 });
  });

  test('regression: CONNECT gets the same uniform 404 bytes as other methods (counted as method), never a silent drop', async () => {
    const { host, port, served } = await listeningHost();
    const post = await raw(port, `POST ${PATH} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Length: 0\r\n\r\n`);
    expect(post.data.startsWith('HTTP/1.1 404 ')).toBe(true);
    for (const target of [`127.0.0.1:${port}`, PATH]) {
      const res = await raw(port, `CONNECT ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`);
      expect(res.closed).toBe(true);
      expect(res.data).toBe(post.data);
    }
    expect(host.failureCounters()).toEqual({ method: 3 });
    expect(served).toEqual([]);
    // 之后的普通请求照常
    expect((await get(port, PATH)).status).toBe(200);
  });

  test('a malformed request is dropped without a response', async () => {
    const { port } = await listeningHost();
    const res = await raw(port, 'NOT A REQUEST\r\n\r\n');
    expect(res.closed).toBe(true);
    expect(res.data).toBe('');
    const huge = await raw(port, `GET ${PATH} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nX-Pad: ${'p'.repeat(9000)}\r\n\r\n`);
    expect(huge.closed).toBe(true);
    expect(huge.data).toBe('');
  });

  test('does not listen on the IPv6 loopback', async () => {
    const { port } = await listeningHost();
    const res = await new Promise<string>((resolve) => {
      const s = connect({ host: '::1', port });
      s.on('connect', () => {
        s.destroy();
        resolve('connected');
      });
      s.on('error', (e: NodeJS.ErrnoException) => resolve(e.code ?? 'error'));
    });
    expect(res).not.toBe('connected');
  });
});
