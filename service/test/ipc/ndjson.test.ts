import { connect, createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { NdjsonClientError, ndjsonRequest, readLine, writeLineAndClose, type ReadLineResult } from '../../src/ipc/ndjson.js';
import { privateDir } from './helpers.js';

let server: Server | null = null;
const open = new Set<Socket>();
afterEach(async () => {
  for (const s of open) s.destroy();
  open.clear();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = null;
});

/** 起一个服务端，按给定方式读取一行，把结果交给测试。 */
async function serve(opts: Parameters<typeof readLine>[1], onLine?: (r: ReadLineResult, s: Socket) => Promise<void> | void): Promise<{ path: string; results: ReadLineResult[] }> {
  const path = join(privateDir(), 's.sock');
  const results: ReadLineResult[] = [];
  server = createServer({ allowHalfOpen: true, pauseOnConnect: true }, async (socket) => {
    open.add(socket);
    socket.on('close', () => open.delete(socket));
    const r = await readLine(socket, opts);
    results.push(r);
    if (onLine) await onLine(r, socket);
    else socket.destroy();
  });
  await new Promise<void>((r) => server!.listen(path, r));
  return { path, results };
}

describe('readLine', () => {
  test('a line split across chunks', async () => {
    const { path } = await serve({ maxBytes: 1024, timeoutMs: 2000, requireJsonObject: true }, async (r, s) => {
      await writeLineAndClose(s, r);
    });
    const res = await new Promise<string>((resolve) => {
      const c = connect(path);
      let text = '';
      c.on('data', (d) => (text += d));
      c.on('close', () => resolve(text));
      c.write('{"a":');
      setTimeout(() => c.write('1}\n'), 30);
    });
    expect(JSON.parse(res)).toEqual({ kind: 'line', line: '{"a":1}' });
  });

  test('the very first byte must be { (leading whitespace is rejected)', async () => {
    const { path, results } = await serve({ maxBytes: 1024, timeoutMs: 2000, requireJsonObject: true });
    await new Promise<void>((resolve) => {
      const c = connect(path);
      c.on('close', () => resolve());
      c.on('error', () => undefined);
      c.write(' {"x":1}\n');
    });
    expect(results).toEqual([{ kind: 'bad_first_byte' }]);
  });

  test('requireJsonObject accepts a JSON object line', async () => {
    const { path } = await serve({ maxBytes: 1024, timeoutMs: 2000, requireJsonObject: true }, async (r, s) => {
      await writeLineAndClose(s, r);
    });
    const res = await ndjsonRequest({ path }, { x: 1 }, { maxResponseBytes: 4096, timeoutMs: 2000 });
    expect(res).toEqual({ kind: 'line', line: '{"x":1}' });
  });

  test('invalid UTF-8 is reported', async () => {
    const { path } = await serve({ maxBytes: 1024, timeoutMs: 2000 }, async (r, s) => {
      await writeLineAndClose(s, r);
    });
    const res = await new Promise<string>((resolve) => {
      const c = connect(path);
      let text = '';
      c.on('data', (d) => (text += d));
      c.on('close', () => resolve(text));
      c.write(Buffer.from([0x7b, 0xff, 0xfe, 0x7d, 0x0a]));
    });
    expect(JSON.parse(res)).toEqual({ kind: 'invalid_utf8' });
  });

  test('limit counts bytes before the newline', async () => {
    const { path } = await serve({ maxBytes: 9, timeoutMs: 2000 }, async (r, s) => {
      await writeLineAndClose(s, r);
    });
    // '{"abc":1}' 正好 9 字节
    expect(await ndjsonRequest({ path }, { abc: 1 }, { maxResponseBytes: 4096, timeoutMs: 2000 })).toEqual({ kind: 'line', line: '{"abc":1}' });
    expect(await ndjsonRequest({ path }, { abcd: 1 }, { maxResponseBytes: 4096, timeoutMs: 2000 })).toEqual({ kind: 'too_large' });
  });
});

describe('ndjsonRequest', () => {
  test('connect failure rejects quickly with kind connect (no lingering timer)', async () => {
    const started = Date.now();
    const err = await ndjsonRequest({ path: join(privateDir(), 'missing.sock') }, {}, { maxResponseBytes: 1024, timeoutMs: 60_000 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NdjsonClientError);
    expect((err as NdjsonClientError).kind).toBe('connect');
    expect((err as NdjsonClientError).errno).toBe('ENOENT');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test('server closing without a reply → closed', async () => {
    const { path } = await serve({ maxBytes: 1024, timeoutMs: 2000 });
    const err = await ndjsonRequest({ path }, { a: 1 }, { maxResponseBytes: 1024, timeoutMs: 2000 }).catch((e: unknown) => e);
    expect((err as NdjsonClientError).kind).toBe('closed');
  });

  test('a silent server → timeout', async () => {
    const { path } = await serve({ maxBytes: 1024, timeoutMs: 5000 }, async () => {
      await new Promise((r) => setTimeout(r, 400));
    });
    const err = await ndjsonRequest({ path }, { a: 1 }, { maxResponseBytes: 1024, timeoutMs: 100 }).catch((e: unknown) => e);
    expect((err as NdjsonClientError).kind).toBe('timeout');
  });

  test('a non-JSON reply → invalid_response', async () => {
    const { path } = await serve({ maxBytes: 1024, timeoutMs: 2000 }, (_r, s) => {
      s.end('not json\n');
    });
    const err = await ndjsonRequest({ path }, { a: 1 }, { maxResponseBytes: 1024, timeoutMs: 2000 }).catch((e: unknown) => e);
    expect((err as NdjsonClientError).kind).toBe('invalid_response');
  });
});
