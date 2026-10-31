import { connect, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { charsetExpectation, CHARSET_CLASSES } from '../src/charset.js';
import { directGet } from '../src/http-client.js';
import { ConnectionRegistry } from '../src/servers/registry.js';
import { exitRoute, frontRoute, isTestHost, portIsFree, startTestServers, type RunningServers } from '../src/servers/run.js';
import { OPCODE, acceptKey, decodeFrames, encodeFrame } from '../src/servers/websocket.js';
import { testPageHtml } from '../src/servers/page.js';

describe('websocket framing', () => {
  it('computes the RFC 6455 accept key', () => {
    expect(acceptKey('dGhlIHNhbXBsZSBub25jZQ==')).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  });

  it('round-trips masked and unmasked frames of different lengths', () => {
    for (const len of [0, 5, 125, 126, 70000]) {
      const payload = Buffer.alloc(len, 0x61);
      for (const mask of [true, false]) {
        const { frames, rest } = decodeFrames(encodeFrame(OPCODE.text, payload, mask));
        expect(rest.length).toBe(0);
        expect(frames).toHaveLength(1);
        expect(frames[0]!.payload.equals(payload)).toBe(true);
        expect(frames[0]!.opcode).toBe(OPCODE.text);
      }
    }
  });

  it('keeps partial frames for later', () => {
    const f = encodeFrame(OPCODE.text, Buffer.from('hello'), true);
    const { frames, rest } = decodeFrames(Buffer.concat([f, f.subarray(0, 3)]));
    expect(frames).toHaveLength(1);
    expect(rest.length).toBe(3);
  });

  it('rejects oversized frames', () => {
    const header = Buffer.from([0x81, 127, 0, 0, 0, 0, 0x10, 0, 0, 0]);
    expect(() => decodeFrames(header)).toThrow();
  });
});

describe('routes', () => {
  const ports = { echo: 18080, exit: 18081, front: 18082, deadFront: 18083 };
  it('maps test hosts to the echo server', () => {
    expect(isTestHost('echo.p0.example.test')).toBe(true);
    expect(isTestHost('P0.EXAMPLE.TEST.')).toBe(true);
    expect(isTestHost('p0.example.test.evil.invalid')).toBe(false);
    expect(exitRoute({ host: 'chain.p0.example.test', port: 18080, atyp: 'domain' }, ports, [])).toEqual({ host: '127.0.0.1', port: 18080 });
  });

  it('allows upstream test hosts only on 80/443', () => {
    expect(exitRoute({ host: 'api.ipify.org', port: 443, atyp: 'domain' }, ports, ['api.ipify.org'])).toEqual({ host: 'api.ipify.org', port: 443 });
    expect(exitRoute({ host: 'api.ipify.org', port: 22, atyp: 'domain' }, ports, ['api.ipify.org'])).toBeNull();
    expect(exitRoute({ host: 'other.example.test', port: 443, atyp: 'domain' }, ports, ['api.ipify.org'])).toBeNull();
    expect(exitRoute({ host: '203.0.113.5', port: 443, atyp: 'ipv4' }, ports, ['api.ipify.org'])).toBeNull();
  });

  it('front only forwards to the local exit port', () => {
    expect(frontRoute({ host: '127.0.0.1', port: 18081, atyp: 'ipv4' }, ports)).toEqual({ host: '127.0.0.1', port: 18081 });
    expect(frontRoute({ host: 'localhost', port: 18081, atyp: 'domain' }, ports)).toEqual({ host: '127.0.0.1', port: 18081 });
    expect(frontRoute({ host: '127.0.0.1', port: 18080, atyp: 'ipv4' }, ports)).toBeNull();
    expect(frontRoute({ host: '198.51.100.1', port: 18081, atyp: 'ipv4' }, ports)).toBeNull();
  });
});

describe('registry', () => {
  it('tracks front and exit hops', () => {
    const r = new ConnectionRegistry();
    r.addFrontOutbound(40001);
    expect(r.isFromFront(40001)).toBe(true);
    r.removeFrontOutbound(40001);
    expect(r.isFromFront(40001)).toBe(false);
    r.addExitOutbound(40002, { user: 'p0-a', throughFront: true, target: 'x:1', at: 0 });
    expect(r.lookupExit(40002)?.user).toBe('p0-a');
    expect(r.lookupExit(undefined)).toBeNull();
  });
});

describe('test page', () => {
  it('embeds config safely and has no inline secrets', () => {
    const html = testPageHtml({ app: 'safari', mode: 'poll', verifyUrl: 'https://api.ipify.org/?format=json', ipv6Url: 'https://api6.ipify.org/', h3Url: 'https://h3.example.test/</script>', intervalMs: 1000 });
    expect(html).not.toContain('</script>"');
    expect(html).toContain('\\u003c/script\\u003e');
    expect(html).toContain('SFE P0 测试页');
  });
});

// ---------- 完整链路：客户端 → 前置 → 出口 → 回显 ----------

let running: RunningServers | null = null;
afterEach(async () => {
  await running?.close();
  running = null;
});

/** 依次发送 writes[i]，每次等收到 replySizes[i] 字节的应答后再发下一条；返回最后剩余的字节。 */
function handshake(socket: Socket, writes: Buffer[], replySizes: number[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    let idx = 0;
    const onData = (c: Buffer): void => {
      buf = Buffer.concat([buf, c]);
      while (idx < writes.length && buf.length >= replySizes[idx]!) {
        buf = buf.subarray(replySizes[idx]!);
        idx++;
        if (idx < writes.length) socket.write(writes[idx]!);
        else {
          socket.off('data', onData);
          resolve(buf);
          return;
        }
      }
    };
    socket.on('data', onData);
    socket.once('error', reject);
    socket.write(writes[0]!);
  });
}

function socksConnect(host: string, port: number): Buffer {
  return Buffer.concat([Buffer.from([5, 1, 0, 3, host.length]), Buffer.from(host), Buffer.from([port >> 8, port & 0xff])]);
}

function auth(user: string, pass: string): Buffer {
  return Buffer.concat([Buffer.from([1, user.length]), Buffer.from(user), Buffer.from([Buffer.byteLength(pass)]), Buffer.from(pass)]);
}

describe('test servers end to end', () => {
  it('identifies the exit user and the front hop in the echo response', async () => {
    const logs: Array<{ file: string; e: Record<string, unknown> }> = [];
    running = await startTestServers({
      ports: { echo: 0, exit: 0, front: 0, deadFront: 1 },
      password: 'examplepw',
      allowUpstream: [],
      h3Host: 'h3.example.test',
      ipv6Host: 'v6.example.test',
      charsetExpectations: () => [],
      log: (file, e) => logs.push({ file, e }),
      tickMs: 50,
    });
    const { ports } = running;
    expect((await directGet(ports.echo, '/health')).json).toEqual({ ok: true, service: 'sfe-p0-echo' });

    const head = await fetch(`http://127.0.0.1:${ports.echo}/ip?t=head-preflight`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    expect(logs.some((l) => l.file === 'echo' && l.e.method === 'HEAD' && l.e.testId === 'head-preflight')).toBe(true);

    // 客户端 → 前置（不认证）→ 出口（认证）→ 回显
    const sock = connect(ports.front, '127.0.0.1');
    await new Promise((r) => sock.once('connect', r));
    const toExit = Buffer.concat([Buffer.from([5, 1, 0, 1, 127, 0, 0, 1]), Buffer.from([ports.exit >> 8, ports.exit & 0xff])]);
    await handshake(sock, [Buffer.from([5, 1, 0]), toExit], [2, 10]);
    await handshake(sock, [Buffer.from([5, 1, 2]), auth('p0-a', 'examplepw'), socksConnect('echo.p0.example.test', 18080)], [2, 2, 10]);
    sock.write('GET /ip?t=e2e&app=test HTTP/1.1\r\nHost: echo.p0.example.test\r\nConnection: close\r\n\r\n');
    const body = await new Promise<string>((resolve) => {
      let text = '';
      sock.on('data', (c: Buffer) => (text += c.toString()));
      sock.on('close', () => resolve(text));
    });
    const json = JSON.parse(body.slice(body.indexOf('\r\n\r\n') + 4)) as { via: string; throughFront: boolean; testId: string };
    expect(json).toMatchObject({ via: 'p0-a', throughFront: true, testId: 'e2e' });
    const exitAuth = logs.find((l) => l.file === 'exit' && l.e.kind === 'auth');
    expect(exitAuth?.e).toMatchObject({ ok: true, user: 'p0-a', throughFront: true });
    expect(logs.some((l) => l.file === 'front' && l.e.kind === 'connected')).toBe(true);
    expect(JSON.stringify(logs)).not.toContain('examplepw');
  });

  it('rejects unknown users and records charset verdicts', async () => {
    const logs: Array<{ file: string; e: Record<string, unknown> }> = [];
    const cls = CHARSET_CLASSES.find((c) => c.id === 'comma')!;
    const expectation = charsetExpectation(12, cls);
    running = await startTestServers({
      ports: { echo: 0, exit: 0, front: 0, deadFront: 1 },
      password: 'examplepw',
      allowUpstream: [],
      h3Host: 'h3.example.test',
      ipv6Host: 'v6.example.test',
      charsetExpectations: () => [expectation],
      log: (file, e) => logs.push({ file, e }),
    });
    const bad = connect(running.ports.exit, '127.0.0.1');
    await new Promise((r) => bad.once('connect', r));
    bad.write(Buffer.from([5, 1, 2]));
    await new Promise((r) => bad.once('data', r));
    bad.write(auth('stranger', 'examplepw'));
    const reply = await new Promise<Buffer>((r) => bad.once('data', r));
    expect([...reply]).toEqual([1, 1]);

    const cs = connect(running.ports.exit, '127.0.0.1');
    await new Promise((r) => cs.once('connect', r));
    // 用户名被截断（模拟逗号把节点行切开）
    await handshake(cs, [Buffer.from([5, 1, 2]), auth('p0cs12x', expectation.password), socksConnect('echo.p0.example.test', 18080)], [2, 2, 10]);
    cs.destroy();
    const v = logs.find((l) => l.e.kind === 'charset_auth');
    expect(v?.e).toMatchObject({ index: 12, verdict: 'username_altered', usernameLength: 7 });
  });

  it('serves the stream and websocket endpoints', async () => {
    running = await startTestServers({
      ports: { echo: 0, exit: 0, front: 0, deadFront: 1 },
      password: 'examplepw',
      allowUpstream: [],
      h3Host: 'h3.example.test',
      ipv6Host: 'v6.example.test',
      charsetExpectations: () => [],
      log: () => undefined,
      tickMs: 20,
    });
    const page = await directGet(running.ports.echo, '/app/chrome');
    expect(page.status).toBe(200);
    expect((await directGet(running.ports.echo, '/attr/other')).status).toBe(200);
    expect((await directGet(running.ports.echo, '/app/Bad_Label')).status).toBe(404);
    const s = connect(running.ports.echo, '127.0.0.1');
    await new Promise((r) => s.once('connect', r));
    s.write('GET /ws?app=test HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
    const text = await new Promise<string>((resolve) => {
      let buf = Buffer.alloc(0);
      s.on('data', (c: Buffer) => {
        buf = Buffer.concat([buf, c]);
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) return;
        const { frames } = decodeFrames(buf.subarray(end + 4));
        if (frames.length >= 2) resolve(frames.map((f) => f.payload.toString()).join('|'));
      });
    });
    expect(text).toContain('"hello":true');
    s.destroy();
  });

  it('checks whether a port is free', async () => {
    running = await startTestServers({
      ports: { echo: 0, exit: 0, front: 0, deadFront: 1 },
      password: 'examplepw',
      allowUpstream: [],
      h3Host: 'h3.example.test',
      ipv6Host: 'v6.example.test',
      charsetExpectations: () => [],
      log: () => undefined,
    });
    expect(await portIsFree(running.ports.echo)).toBe(false);
  });
});
