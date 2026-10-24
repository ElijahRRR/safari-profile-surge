import { connect, createServer, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { REP, buildReply, createSocks5Server, parseGreeting, parseRequest, parseUserPass } from '../src/servers/socks5.js';

describe('SOCKS5 parsers', () => {
  it('parses greetings incrementally', () => {
    expect(parseGreeting(Buffer.from([5]))).toEqual({ kind: 'incomplete' });
    expect(parseGreeting(Buffer.from([5, 2, 0]))).toEqual({ kind: 'incomplete' });
    expect(parseGreeting(Buffer.from([5, 2, 0, 2]))).toEqual({ kind: 'ok', value: { methods: [0, 2] }, used: 4 });
    expect(parseGreeting(Buffer.from([4, 1, 0]))).toEqual({ kind: 'error', error: 'bad_version' });
    expect(parseGreeting(Buffer.from([5, 0]))).toEqual({ kind: 'error', error: 'no_methods' });
  });

  it('parses username/password auth', () => {
    const buf = Buffer.concat([Buffer.from([1, 4]), Buffer.from('p0-a'), Buffer.from([3]), Buffer.from('xyz')]);
    const r = parseUserPass(buf);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.value.username.toString()).toBe('p0-a');
      expect(r.value.password.toString()).toBe('xyz');
      expect(r.used).toBe(buf.length);
    }
    expect(parseUserPass(buf.subarray(0, 5)).kind).toBe('incomplete');
    expect(parseUserPass(Buffer.from([2, 0, 0])).kind).toBe('error');
  });

  it('parses domain, IPv4 and IPv6 requests', () => {
    const domain = Buffer.concat([Buffer.from([5, 1, 0, 3, 16]), Buffer.from('echo.example.test'.slice(0, 16)), Buffer.from([0x46, 0x50])]);
    const r = parseRequest(domain);
    expect(r).toMatchObject({ kind: 'ok', value: { cmd: 1, target: { atyp: 'domain', port: 18000 } } });
    const v4 = parseRequest(Buffer.from([5, 1, 0, 1, 127, 0, 0, 1, 0x1f, 0x90]));
    expect(v4).toMatchObject({ kind: 'ok', value: { target: { host: '127.0.0.1', port: 8080, atyp: 'ipv4' } } });
    const v6 = Buffer.alloc(22);
    v6.set([5, 1, 0, 4]);
    v6[19] = 1;
    v6.writeUInt16BE(443, 20);
    expect(parseRequest(v6)).toMatchObject({ kind: 'ok', value: { target: { host: '0:0:0:0:0:0:0:1', port: 443, atyp: 'ipv6' } } });
    expect(parseRequest(Buffer.from([5, 1, 0, 9, 0, 0])).kind).toBe('error');
    expect(parseRequest(Buffer.from([5, 1, 0, 3, 5, 0x61])).kind).toBe('incomplete');
  });

  it('builds fixed replies', () => {
    expect([...buildReply(REP.notAllowed)]).toEqual([5, 2, 0, 1, 0, 0, 0, 0, 0, 0]);
  });
});

// ---------- 本机客户端握手 ----------

const servers: Server[] = [];
const sockets: Socket[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy();
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

function listen(server: Server): Promise<number> {
  servers.push(server);
  server.on('connection', (s) => sockets.push(s));
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)));
}

/** 读取直到至少 n 字节。 */
function readBytes(socket: Socket, n: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const onData = (c: Buffer): void => {
      buf = Buffer.concat([buf, c]);
      if (buf.length >= n) {
        socket.off('data', onData);
        resolve(buf);
      }
    };
    socket.on('data', onData);
    socket.once('close', () => (buf.length >= n ? resolve(buf) : reject(new Error(`closed after ${buf.length} bytes`))));
  });
}

async function echoTarget(): Promise<number> {
  return listen(createServer((s) => s.pipe(s)));
}

function client(port: number): Promise<Socket> {
  return new Promise((resolve) => {
    const s = connect(port, '127.0.0.1', () => resolve(s));
    sockets.push(s);
  });
}

function connectRequest(host: string, port: number): Buffer {
  return Buffer.concat([Buffer.from([5, 1, 0, 3, host.length]), Buffer.from(host), Buffer.from([port >> 8, port & 0xff])]);
}

describe('SOCKS5 server against a local client', () => {
  it('authenticates, routes and relays data', async () => {
    const target = await echoTarget();
    const events: Array<Record<string, unknown>> = [];
    const port = await listen(
      createSocks5Server({
        requireAuth: true,
        authenticate: (u, p) => ({ ok: u.toString() === 'p0-a' && p.toString() === 'example-pw', user: 'p0-a' }),
        route: (t) => (t.host === 'echo.p0.example.test' ? { host: '127.0.0.1', port: target } : null),
        onEvent: (e) => events.push(e),
      }),
    );
    const s = await client(port);
    s.write(Buffer.from([5, 1, 2]));
    expect([...(await readBytes(s, 2))]).toEqual([5, 2]);
    s.write(Buffer.concat([Buffer.from([1, 4]), Buffer.from('p0-a'), Buffer.from([10]), Buffer.from('example-pw')]));
    expect([...(await readBytes(s, 2))]).toEqual([1, 0]);
    s.write(connectRequest('echo.p0.example.test', 18080));
    const reply = await readBytes(s, 10);
    expect(reply[1]).toBe(REP.succeeded);
    s.write('ping');
    expect((await readBytes(s, 4)).toString()).toBe('ping');
    s.destroy();
    const auth = events.find((e) => e.kind === 'auth');
    expect(auth).toMatchObject({ ok: true, user: 'p0-a', usernameLength: 4, passwordLength: 10 });
    expect(JSON.stringify(events)).not.toContain('example-pw');
  });

  it('rejects wrong credentials', async () => {
    const port = await listen(createSocks5Server({ requireAuth: true, authenticate: () => ({ ok: false, user: null }), route: () => null }));
    const s = await client(port);
    s.write(Buffer.from([5, 1, 2]));
    await readBytes(s, 2);
    s.write(Buffer.concat([Buffer.from([1, 1]), Buffer.from('x'), Buffer.from([1]), Buffer.from('y')]));
    expect([...(await readBytes(s, 2))]).toEqual([1, 1]);
  });

  it('requires authentication on the exit server', async () => {
    const port = await listen(createSocks5Server({ requireAuth: true, authenticate: () => ({ ok: true, user: 'x' }), route: () => null }));
    const s = await client(port);
    s.write(Buffer.from([5, 1, 0]));
    expect([...(await readBytes(s, 2))]).toEqual([5, 0xff]);
  });

  it('refuses targets outside the allowed routes', async () => {
    const events: Array<Record<string, unknown>> = [];
    const port = await listen(createSocks5Server({ requireAuth: false, route: () => null, onEvent: (e) => events.push(e) }));
    const s = await client(port);
    s.write(Buffer.from([5, 1, 0]));
    expect([...(await readBytes(s, 2))]).toEqual([5, 0]);
    s.write(connectRequest('elsewhere.invalid', 443));
    const reply = await readBytes(s, 10);
    expect(reply[1]).toBe(REP.notAllowed);
    expect(events.some((e) => e.kind === 'refused' && e.reason === 'target_not_allowed')).toBe(true);
  });

  it('refuses non-CONNECT commands', async () => {
    const port = await listen(createSocks5Server({ requireAuth: false, route: () => ({ host: '127.0.0.1', port: 9 }) }));
    const s = await client(port);
    s.write(Buffer.from([5, 1, 0]));
    await readBytes(s, 2);
    s.write(Buffer.from([5, 3, 0, 1, 127, 0, 0, 1, 0, 53]));
    expect((await readBytes(s, 10))[1]).toBe(REP.cmdNotSupported);
  });

  it('reports an unreachable upstream as refused', async () => {
    const closed = await listen(createServer());
    await new Promise<void>((r) => servers.pop()!.close(() => r()));
    const port = await listen(createSocks5Server({ requireAuth: false, route: () => ({ host: '127.0.0.1', port: closed }) }));
    const s = await client(port);
    s.write(Buffer.from([5, 1, 0]));
    await readBytes(s, 2);
    s.write(connectRequest('echo.p0.example.test', 80));
    expect((await readBytes(s, 10))[1]).toBe(REP.refused);
  });

  it('accepts a pipelined handshake in one write', async () => {
    const target = await echoTarget();
    const port = await listen(createSocks5Server({ requireAuth: false, route: () => ({ host: '127.0.0.1', port: target }) }));
    const s = await client(port);
    s.write(Buffer.concat([Buffer.from([5, 1, 0]), connectRequest('echo.p0.example.test', 80), Buffer.from('early')]));
    const all = await readBytes(s, 2 + 10 + 5);
    expect(all.subarray(12).toString()).toBe('early');
  });
});
