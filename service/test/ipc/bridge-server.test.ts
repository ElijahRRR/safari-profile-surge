import { lstatSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { NATIVE_MAX_MESSAGE_BYTES, SfeError } from '@sfe/contract';
import {
  BRIDGE_VERSION_RE,
  bridgeClientProof,
  bridgeServerProof,
  createBridgeServer,
  parseBridgeHello,
  proofMatches,
  sha256Hex,
  validateBridgeEnvelope,
  verifyBridgeRequest,
  type BridgeServerHandle,
} from '../../src/ipc/bridge-server.js';
import { createStubApp, type StubApp } from '../support/stub-app.js';
import { recordingLogger } from '../http/helpers.js';
import { bridgeCall, exchangeRaw, LineConn, makeStaleSocket, privateDir, randomNonce, type BridgeCallOptions, type Endpoint } from './helpers.js';

const TOKEN = 'bridge-token-synthetic-0123456789abcdef';
const OTHER_TOKEN = 'bridge-token-synthetic-0123456789abcdeX';
const PROFILE = '4F3C2A10-1B2C-4D5E-8F90-ABCDEF012345';
/** 与原生桥实际发送的格式一致（NativeBridge.bridgeVersion：短版本+构建号）。 */
const BRIDGE_VERSION = '0.1.0+1';

function payloadOf(over: { bridge?: unknown; message?: unknown; extra?: Record<string, unknown> } = {}): string {
  return JSON.stringify({
    bridge: over.bridge ?? { profileId: PROFILE, bridgeVersion: BRIDGE_VERSION },
    message: over.message ?? { type: 'getCurrentState' },
    ...over.extra,
  });
}

function call(endpoint: Endpoint, opts: Partial<BridgeCallOptions> = {}) {
  return bridgeCall(endpoint, { token: TOKEN, payload: payloadOf(), ...opts });
}

/** 握手成功并拿到应答；否则测试失败。 */
async function respond(endpoint: Endpoint, opts: Partial<BridgeCallOptions> = {}): Promise<any> {
  const r = await call(endpoint, opts);
  if (r.kind !== 'response') throw new Error(`expected a response, got ${r.kind}`);
  return r.response;
}

let server: BridgeServerHandle | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

async function startTcp(opts: { token?: () => string; handshakeTimeoutMs?: number; app?: StubApp; nonce?: () => string } = {}) {
  const app = opts.app ?? createStubApp();
  const logger = recordingLogger();
  server = createBridgeServer({
    app,
    transport: { kind: 'tcp', host: '127.0.0.1', port: 0 },
    token: opts.token ?? (() => TOKEN),
    logger,
    ...(opts.handshakeTimeoutMs !== undefined ? { handshakeTimeoutMs: opts.handshakeTimeoutMs } : {}),
    ...(opts.nonce ? { nonce: opts.nonce } : {}),
  });
  const addr = await server.listen();
  if (addr.kind !== 'tcp') throw new Error('expected tcp');
  const endpoint: Endpoint = { port: addr.port };
  return { app, logger, endpoint };
}

describe('bridge server (tcp)', () => {
  test('valid handshake and round trip: forwards { v, bridge, message } and returns the NativeResponse', async () => {
    const { app, endpoint } = await startTcp();
    app.respond('handleNative', { ok: true, data: { relation: 'none_active' } });
    expect(await respond(endpoint)).toEqual({ ok: true, data: { relation: 'none_active' } });
    const [c] = app.callsTo('handleNative');
    expect(c!.args[0]).toEqual({ v: 1, bridge: { profileId: PROFILE, bridgeVersion: BRIDGE_VERSION }, message: { type: 'getCurrentState' } });
  });

  test('the token never goes on the wire: the challenge carries only a nonce and a proof', async () => {
    const { endpoint } = await startTcp();
    const r = await call(endpoint);
    expect(r.kind).toBe('response');
    if (r.kind !== 'response') return;
    expect(Object.keys(r.challenge).sort()).toEqual(['serverNonce', 'serverProof', 'type', 'v']);
    expect(r.challenge.serverNonce).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(r.challenge)).not.toContain(TOKEN);
    expect(JSON.stringify(r.request)).not.toContain(TOKEN);
  });

  test('every connection gets a fresh server nonce', async () => {
    const { endpoint } = await startTcp();
    const a = await call(endpoint);
    const b = await call(endpoint);
    if (a.kind !== 'response' || b.kind !== 'response') throw new Error('handshake failed');
    expect(a.challenge.serverNonce).not.toBe(b.challenge.serverNonce);
  });

  test('binds 127.0.0.1 only', async () => {
    await startTcp();
    expect(server!.address()).toMatchObject({ kind: 'tcp', host: '127.0.0.1' });
    expect(() => createBridgeServer({ app: createStubApp(), transport: { kind: 'tcp', host: '0.0.0.0' as '127.0.0.1', port: 0 }, token: () => TOKEN, logger: recordingLogger() })).toThrow(SfeError);
  });

  test('null profileId is accepted (unidentified profile)', async () => {
    const { app, endpoint } = await startTcp();
    await respond(endpoint, { payload: payloadOf({ bridge: { profileId: null, bridgeVersion: BRIDGE_VERSION } }) });
    expect((app.callsTo('handleNative')[0]!.args[0] as { bridge: { profileId: unknown } }).bridge.profileId).toBeNull();
  });

  test('one request per connection: the server closes after the reply', async () => {
    const { app, endpoint } = await startTcp();
    const r = await call(endpoint, { request: (req) => `${JSON.stringify(req)}\n${JSON.stringify(req)}\n` });
    expect(r.kind).toBe('response');
    expect(app.callsTo('handleNative')).toHaveLength(1);
  });

  // —— 原生桥一侧：服务不能证明持有令牌时，不发送任何请求内容 ——

  test('a client holding a different token refuses the server and sends nothing', async () => {
    const { app, endpoint } = await startTcp();
    const r = await call(endpoint, { token: OTHER_TOKEN });
    expect(r.kind).toBe('server_unauthenticated');
    expect(app.calls).toHaveLength(0);
  });

  // —— 服务一侧：请求证明 ——

  test('a request proven with the wrong token is dropped without any reply', async () => {
    const { app, endpoint } = await startTcp();
    const r = await call(endpoint, {
      // 对端不持有令牌：用另一个令牌对本连接的随机数与 payload 计算证明
      request: (req, { clientNonce, serverNonce }) => ({ ...req, clientProof: bridgeClientProof(OTHER_TOKEN, serverNonce, clientNonce, String(req.payload)) }),
    });
    expect(r.kind).toBe('closed_after_request');
    expect(app.calls).toHaveLength(0);
  });

  test.each([
    ['missing proof', (req: Record<string, unknown>) => ({ ...req, clientProof: undefined })],
    ['non-string proof', (req: Record<string, unknown>) => ({ ...req, clientProof: 12345 })],
    ['uppercase proof', (req: Record<string, unknown>) => ({ ...req, clientProof: String(req.clientProof).toUpperCase() })],
    ['truncated proof', (req: Record<string, unknown>) => ({ ...req, clientProof: String(req.clientProof).slice(0, 63) })],
    ['flipped proof', (req: Record<string, unknown>) => ({ ...req, clientProof: `${String(req.clientProof).slice(0, 63)}${String(req.clientProof).endsWith('0') ? '1' : '0'}` })],
    ['payload changed after proving', (req: Record<string, unknown>) => ({ ...req, payload: payloadOf({ message: { type: 'enterNormalMode', request_id: 'req_x' } }) })],
    ['payload as an object', (req: Record<string, unknown>) => ({ ...req, payload: JSON.parse(String(req.payload)) })],
    ['wrong type', (req: Record<string, unknown>) => ({ ...req, type: 'hello' })],
    ['a second hello', () => ({ v: 1, type: 'hello', clientNonce: randomNonce() })],
    ['raw auth token instead of a proof', (req: Record<string, unknown>) => ({ v: 1, auth: TOKEN, payload: req.payload })],
  ])('wrong proof (%s) → connection dropped, nothing revealed, handleNative not called', async (_label, request) => {
    const { app, endpoint } = await startTcp();
    const r = await call(endpoint, { request });
    expect(r.kind).toBe('closed_after_request');
    expect(app.calls).toHaveLength(0);
  });

  test('a recorded request replayed on a new connection is rejected (proof is bound to the server nonce)', async () => {
    const { app, endpoint } = await startTcp();
    const clientNonce = randomNonce();
    const first = await call(endpoint, { clientNonce });
    if (first.kind !== 'response') throw new Error('handshake failed');
    const replay = await call(endpoint, { clientNonce, request: () => first.request });
    expect(replay.kind).toBe('closed_after_request');
    expect(app.callsTo('handleNative')).toHaveLength(1);
  });

  test('a server nonce equal to the client nonce is never used (reflection)', async () => {
    const fixed = randomNonce();
    const { app, endpoint } = await startTcp({ nonce: () => fixed });
    expect((await call(endpoint, { clientNonce: fixed })).kind).toBe('closed_after_hello');
    expect((await call(endpoint)).kind).toBe('response');
    expect(app.callsTo('handleNative')).toHaveLength(1);
  });

  test.each([
    ['not JSON', '{"v":1,\n'],
    ['wrong type', `${JSON.stringify({ v: 1, type: 'request', clientNonce: randomNonce() })}\n`],
    ['wrong version', `${JSON.stringify({ v: 2, type: 'hello', clientNonce: randomNonce() })}\n`],
    ['short nonce', `${JSON.stringify({ v: 1, type: 'hello', clientNonce: 'abcd' })}\n`],
    ['uppercase nonce', `${JSON.stringify({ v: 1, type: 'hello', clientNonce: randomNonce().toUpperCase() })}\n`],
    ['old single-line envelope with the token', `${JSON.stringify({ v: 1, auth: TOKEN, bridge: { profileId: PROFILE, bridgeVersion: BRIDGE_VERSION }, message: { type: 'getCurrentState' } })}\n`],
  ])('malformed hello (%s) → dropped without a challenge', async (_label, line) => {
    const { app, endpoint } = await startTcp();
    const { text } = await exchangeRaw(endpoint, line);
    expect(text).toBe('');
    expect(app.calls).toHaveLength(0);
  });

  test('an unconfigured (empty) token rejects every connection before any challenge', async () => {
    const { app, endpoint } = await startTcp({ token: () => '' });
    expect((await call(endpoint, { token: '' })).kind).toBe('closed_after_hello');
    expect((await call(endpoint)).kind).toBe('closed_after_hello');
    expect(app.calls).toHaveLength(0);
  });

  test('a token getter that throws rejects the connection', async () => {
    const { endpoint } = await startTcp({
      token: () => {
        throw new Error('unreadable');
      },
    });
    expect((await call(endpoint)).kind).toBe('closed_after_hello');
  });

  test('token rotation takes effect on the next connection', async () => {
    let current = TOKEN;
    const { endpoint } = await startTcp({ token: () => current });
    expect((await call(endpoint)).kind).toBe('response');
    current = OTHER_TOKEN;
    expect((await call(endpoint)).kind).toBe('server_unauthenticated');
    expect((await call(endpoint, { token: OTHER_TOKEN })).kind).toBe('response');
  });

  test('an HTTP request line is dropped without any reply', async () => {
    const { app, endpoint } = await startTcp();
    const { text } = await exchangeRaw(endpoint, `GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`);
    expect(text).toBe('');
    expect(app.calls).toHaveLength(0);
  });

  test('a cross-site POST body (form encoded) is dropped', async () => {
    const { endpoint } = await startTcp();
    const { text } = await exchangeRaw(endpoint, `POST /x HTTP/1.1\r\nContent-Type: text/plain\r\n\r\n{"v":1}\n`);
    expect(text).toBe('');
  });

  test('an oversized hello is dropped', async () => {
    const { endpoint } = await startTcp();
    const { text } = await exchangeRaw(endpoint, `{"v":1,"pad":"${'x'.repeat(2048)}"}\n`);
    expect(text).toBe('');
  });

  test('an oversized request line is dropped (it cannot be verified)', async () => {
    const { app, endpoint } = await startTcp();
    const r = await call(endpoint, { payload: payloadOf({ extra: { pad: 'x'.repeat(NATIVE_MAX_MESSAGE_BYTES + 10) } }) });
    expect(r.kind).toBe('closed_after_request');
    expect(app.calls).toHaveLength(0);
  });

  test('a request line exactly at the limit is accepted', async () => {
    const { endpoint } = await startTcp();
    const base = JSON.stringify({ v: 1, type: 'request', clientProof: '0'.repeat(64), payload: payloadOf({ message: { type: 'getCurrentState', pad: '' } }) }).length;
    const pad = 'x'.repeat(NATIVE_MAX_MESSAGE_BYTES - base);
    const r = await call(endpoint, { payload: payloadOf({ message: { type: 'getCurrentState', pad } }) });
    expect(r.kind).toBe('response');
    if (r.kind === 'response') expect(JSON.stringify(r.request).length).toBe(NATIVE_MAX_MESSAGE_BYTES);
  });

  // —— 证明通过之后：与原来相同的信封校验 ——

  test.each([
    ['too short', 'abc'],
    ['slash', 'ABCDEF12/../x'],
    ['spaces', 'ABCDEF12 3456'],
    ['too long', 'A'.repeat(65)],
    ['number', 12345678],
  ])('bad profileId (%s) → BAD_REQUEST', async (_label, profileId) => {
    const { app, endpoint } = await startTcp();
    const res = await respond(endpoint, { payload: payloadOf({ bridge: { profileId, bridgeVersion: BRIDGE_VERSION } }) });
    expect(res.error.code).toBe('BAD_REQUEST');
    expect(app.calls).toHaveLength(0);
  });

  test.each(['deleteAllEnvironments', 'toString', '__proto__', 'constructor', ''])('unknown message type %j → BAD_REQUEST', async (type) => {
    const { app, endpoint } = await startTcp();
    const res = await respond(endpoint, { payload: payloadOf({ message: { type } }) });
    expect(res.error.code).toBe('BAD_REQUEST');
    expect(app.calls).toHaveLength(0);
  });

  test('protocol version other than 1 in the request → BAD_REQUEST', async () => {
    const { endpoint } = await startTcp();
    expect((await respond(endpoint, { request: (req) => ({ ...req, v: 2 }) })).error.code).toBe('BAD_REQUEST');
  });

  test('a proven payload that is not a JSON object → BAD_REQUEST', async () => {
    const { endpoint } = await startTcp();
    for (const payload of ['{"bridge":', '[]', '"x"']) {
      expect((await respond(endpoint, { payload })).error.code).toBe('BAD_REQUEST');
    }
  });

  test('the bridgeVersion the native bridge sends ("0.1.0+1") is accepted end to end', async () => {
    const { app, endpoint } = await startTcp();
    expect((await respond(endpoint)).ok).toBe(true);
    expect(app.callsTo('handleNative')).toHaveLength(1);
  });

  test('half-closed request without a trailing newline is still answered', async () => {
    const { endpoint } = await startTcp();
    expect((await respond(endpoint, { endAfterRequest: true })).ok).toBe(true);
  });

  test('a client that never says hello is dropped after the handshake deadline', async () => {
    const { app, endpoint } = await startTcp({ handshakeTimeoutMs: 100 });
    const conn = new LineConn(endpoint);
    try {
      expect(await conn.next(2000)).toBeNull();
    } finally {
      conn.destroy();
    }
    expect(app.calls).toHaveLength(0);
  });

  test('a client that never sends the request is dropped after the handshake deadline', async () => {
    const { app, endpoint } = await startTcp({ handshakeTimeoutMs: 150 });
    const conn = new LineConn(endpoint);
    try {
      conn.send({ v: 1, type: 'hello', clientNonce: randomNonce() });
      expect(JSON.parse((await conn.next(2000))!).type).toBe('challenge');
      expect(await conn.next(2000)).toBeNull();
    } finally {
      conn.destroy();
    }
    expect(app.calls).toHaveLength(0);
  });

  test('a stalled partial request is dropped after the handshake deadline', async () => {
    const { app, endpoint } = await startTcp({ handshakeTimeoutMs: 150 });
    const r = await call(endpoint, { request: () => '{"v":1,"type":"request"', timeoutMs: 2000 });
    expect(r.kind).toBe('closed_after_request');
    expect(app.calls).toHaveLength(0);
  });

  test('SfeError from handleNative → { ok: false, error }', async () => {
    const app = createStubApp();
    app.throwOn('handleNative', new SfeError('BINDING_MISMATCH', '操作失败：场景与环境不符'));
    const { endpoint } = await startTcp({ app });
    expect(await respond(endpoint)).toEqual({ ok: false, error: { code: 'BINDING_MISMATCH', message: '操作失败：场景与环境不符' } });
  });

  test('other errors → INTERNAL without details', async () => {
    const app = createStubApp();
    app.throwOn('handleNative', new Error('secret store CANARY-kc-991 failed'));
    const { endpoint, logger } = await startTcp({ app });
    const res = await respond(endpoint);
    expect(res).toEqual({ ok: false, error: { code: 'INTERNAL', message: '服务内部错误' } });
    expect(JSON.stringify(res)).not.toContain('CANARY');
    expect(logger.text()).not.toContain('CANARY');
  });

  test('never logs message contents, the token, the profile id, nonces or proofs', async () => {
    const { app, endpoint, logger } = await startTcp();
    // 登录填充的应答带账号密码的值（服务从本机后台资料读出）：原样交给原生桥，从不写入日志
    const fills = [
      { field: 'identifier', value: 'buyer01@example.test' },
      { field: 'password', value: 'synth-CANARY-fill-pw' },
    ];
    app.respond('handleNative', { ok: true, data: { fills } });
    const ok = await call(endpoint, {
      payload: payloadOf({
        message: { type: 'requestLoginFill', top_url: 'https://www.amazon.com/ap/signin?CANARY-URL', frame_is_top: true, form_action: null, fields: ['identifier', 'password'], route_epoch: 3 },
      }),
    });
    if (ok.kind !== 'response') throw new Error('handshake failed');
    expect(JSON.stringify(ok)).toContain('synth-CANARY-fill-pw');
    await call(endpoint, { request: (req) => ({ ...req, clientProof: 'f'.repeat(64), payload: payloadOf({ message: { type: 'getCurrentState', note: 'CANARY-forged' } }) }) });
    await call(endpoint, { token: 'wrong-token-CANARY-000000000000000' });
    await exchangeRaw(endpoint, 'GET /CANARY-PATH HTTP/1.1\r\n\r\n');
    const text = logger.text();
    expect(text).not.toContain('CANARY');
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(PROFILE);
    expect(text).not.toContain('buyer01@example.test');
    expect(text).not.toContain(String(ok.challenge.serverNonce));
    expect(text).not.toContain(String(ok.challenge.serverProof));
    expect(text).not.toContain(String(ok.request.clientProof));
    expect(logger.entries.some((e) => e.fields?.type === 'requestLoginFill' && e.fields?.result === 'ok')).toBe(true);
    expect(logger.entries.some((e) => e.fields?.result === 'handshake_failed' && e.fields?.stage === 'request')).toBe(true);
  });
});

describe('bridge server (unix)', () => {
  test('socket file is created with mode 0600 and round trip works', async () => {
    const dir = privateDir();
    const path = join(dir, 'bridge.sock');
    server = createBridgeServer({ app: createStubApp(), transport: { kind: 'unix', path }, token: () => TOKEN, logger: recordingLogger() });
    expect(await server.listen()).toEqual({ kind: 'unix', path });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect((await respond({ path })).ok).toBe(true);
  });

  test('a stale socket path is replaced', async () => {
    const dir = privateDir();
    const path = join(dir, 'bridge.sock');
    makeStaleSocket(path);
    expect(lstatSync(path).isSocket()).toBe(true);
    server = createBridgeServer({ app: createStubApp(), transport: { kind: 'unix', path }, token: () => TOKEN, logger: recordingLogger() });
    await server.listen();
    expect((await respond({ path })).ok).toBe(true);
  });

  test('a regular file at the socket path is never removed', async () => {
    const dir = privateDir();
    const path = join(dir, 'bridge.sock');
    writeFileSync(path, 'not a socket');
    const s = createBridgeServer({ app: createStubApp(), transport: { kind: 'unix', path }, token: () => TOKEN, logger: recordingLogger() });
    await expect(s.listen()).rejects.toMatchObject({ code: 'UNSAFE_LOCATION' });
    expect(statSync(path).isFile()).toBe(true);
  });

  test('a live socket owned by another instance is not stolen', async () => {
    const dir = privateDir();
    const path = join(dir, 'bridge.sock');
    const first = createBridgeServer({ app: createStubApp(), transport: { kind: 'unix', path }, token: () => TOKEN, logger: recordingLogger() });
    await first.listen();
    try {
      const second = createBridgeServer({ app: createStubApp(), transport: { kind: 'unix', path }, token: () => TOKEN, logger: recordingLogger() });
      await expect(second.listen()).rejects.toBeInstanceOf(SfeError);
      expect((await respond({ path })).ok).toBe(true);
    } finally {
      await first.close();
    }
  });

  test('close removes the socket file', async () => {
    const dir = privateDir();
    const path = join(dir, 'bridge.sock');
    const s = createBridgeServer({ app: createStubApp(), transport: { kind: 'unix', path }, token: () => TOKEN, logger: recordingLogger() });
    await s.listen();
    await s.close();
    expect(() => statSync(path)).toThrow();
  });
});

/**
 * 与 apps/macos/Tests/BridgeHandshakeTests.swift 共用的已知答案（用 openssl 独立核对过）：
 * 两端各自计算出同样的值，才能保证 Swift 原生桥与 Node 服务的握手互通。
 */
const HANDSHAKE_VECTOR = {
  token: `${'A'.repeat(42)}Q`,
  clientNonce: '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff',
  serverNonce: 'f0e1d2c3b4a5968778695a4b3c2d1e0ff0e1d2c3b4a5968778695a4b3c2d1e0f',
  payload: '{"bridge":{"bridgeVersion":"0.1.0+1","profileId":"0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0"},"message":{"type":"getCurrentState"}}',
  payloadSha256: '8352f380e350e1ac3a602b1b49889512c1251ad98a249e159ed62ae6fb80e44e',
  serverProof: '3dad80eb1c48e870daab47bb1e870ba403d545132b17e8b5e3f7b918957ef0a7',
  clientProof: 'fd9e83a80d27a034b109fd7a0be483457c30fdf24ee295a10a6c2f7d436d51f8',
} as const;

describe('handshake helpers', () => {
  test('proofs match the shared known-answer vector', () => {
    const k = HANDSHAKE_VECTOR;
    expect(sha256Hex(k.payload)).toBe(k.payloadSha256);
    expect(bridgeServerProof(k.token, k.clientNonce, k.serverNonce)).toBe(k.serverProof);
    expect(bridgeClientProof(k.token, k.serverNonce, k.clientNonce, k.payload)).toBe(k.clientProof);
  });

  test('server and client proofs are domain separated', () => {
    const k = HANDSHAKE_VECTOR;
    expect(bridgeServerProof(k.token, k.serverNonce, k.clientNonce)).not.toBe(bridgeClientProof(k.token, k.clientNonce, k.serverNonce, k.payload));
  });

  test('proofMatches', () => {
    const p = HANDSHAKE_VECTOR.serverProof;
    expect(proofMatches(p, p)).toBe(true);
    expect(proofMatches(p.toUpperCase(), p)).toBe(false);
    expect(proofMatches(`${p.slice(0, 63)}${p.endsWith('0') ? '1' : '0'}`, p)).toBe(false);
    expect(proofMatches(p.slice(0, 62), p)).toBe(false);
    expect(proofMatches(null, p)).toBe(false);
    expect(proofMatches('', '')).toBe(false);
  });

  test('parseBridgeHello', () => {
    const n = HANDSHAKE_VECTOR.clientNonce;
    expect(parseBridgeHello({ v: 1, type: 'hello', clientNonce: n })).toBe(n);
    for (const raw of [null, [], 'x', { v: 2, type: 'hello', clientNonce: n }, { v: 1, type: 'request', clientNonce: n }, { v: 1, type: 'hello', clientNonce: n.toUpperCase() }, { v: 1, type: 'hello' }]) {
      expect(parseBridgeHello(raw)).toBeNull();
    }
  });

  test('verifyBridgeRequest accepts only a proof over this connection’s nonces and payload', () => {
    const k = HANDSHAKE_VECTOR;
    const req = { v: 1, type: 'request', clientProof: k.clientProof, payload: k.payload };
    expect(verifyBridgeRequest(req, k.token, k.clientNonce, k.serverNonce)).toEqual({ ok: true, v: 1, payload: k.payload });
    expect(verifyBridgeRequest(req, OTHER_TOKEN, k.clientNonce, k.serverNonce).ok).toBe(false);
    expect(verifyBridgeRequest(req, k.token, k.clientNonce, randomNonce()).ok).toBe(false);
    expect(verifyBridgeRequest(req, k.token, randomNonce(), k.serverNonce).ok).toBe(false);
    expect(verifyBridgeRequest({ ...req, payload: `${k.payload} ` }, k.token, k.clientNonce, k.serverNonce).ok).toBe(false);
    expect(verifyBridgeRequest(req, '', k.clientNonce, k.serverNonce).ok).toBe(false);
  });
});

describe('envelope validation', () => {
  const env = (bridge: unknown, message: unknown = { type: 'getCurrentState' }) => ({ v: 1, bridge, message });

  test('validateBridgeEnvelope rejects non-objects', () => {
    for (const raw of [null, [], 'x', 1]) expect(validateBridgeEnvelope(raw).ok).toBe(false);
  });

  test('validateBridgeEnvelope accepts the bridgeVersion format the native bridge emits ("0.1.0+1")', () => {
    expect(validateBridgeEnvelope(env({ profileId: PROFILE, bridgeVersion: '0.1.0+1' }))).toMatchObject({ ok: true, envelope: { bridge: { bridgeVersion: '0.1.0+1' } } });
    expect(validateBridgeEnvelope(env({ profileId: null, bridgeVersion: '0+0' })).ok).toBe(true);
    expect(BRIDGE_VERSION_RE.test('0.1.0+1')).toBe(true);
  });

  test('validateBridgeEnvelope rejects a bad bridgeVersion (including the old "0.1.0 (1)" format with a space)', () => {
    expect(validateBridgeEnvelope(env({ profileId: PROFILE, bridgeVersion: 'a b' })).ok).toBe(false);
    expect(validateBridgeEnvelope(env({ profileId: PROFILE, bridgeVersion: '0.1.0 (1)' })).ok).toBe(false);
    expect(validateBridgeEnvelope(env({ profileId: PROFILE })).ok).toBe(false);
  });

  test('validateBridgeEnvelope never copies a token-like field into the envelope', () => {
    const r = validateBridgeEnvelope({ ...env({ profileId: PROFILE, bridgeVersion: '0.1.0+1' }), auth: TOKEN });
    expect(r.ok).toBe(true);
    if (r.ok) expect(JSON.stringify(r.envelope)).not.toContain(TOKEN);
  });
});
