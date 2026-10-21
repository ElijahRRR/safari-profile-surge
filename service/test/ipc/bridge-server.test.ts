import { lstatSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { NATIVE_MAX_MESSAGE_BYTES, SfeError } from '@sfe/contract';
import { createBridgeServer, tokenMatches, validateBridgeEnvelope, type BridgeServerHandle } from '../../src/ipc/bridge-server.js';
import { createStubApp, type StubApp } from '../support/stub-app.js';
import { recordingLogger } from '../http/helpers.js';
import { exchangeRaw, makeStaleSocket, privateDir, requestJson, type Endpoint } from './helpers.js';

const TOKEN = 'bridge-token-synthetic-0123456789abcdef';
const PROFILE = '4F3C2A10-1B2C-4D5E-8F90-ABCDEF012345';

function envelope(overrides: Record<string, unknown> = {}) {
  return { v: 1, auth: TOKEN, bridge: { profileId: PROFILE, bridgeVersion: '1.0.0' }, message: { type: 'getCurrentState' }, ...overrides };
}

let server: BridgeServerHandle | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

async function startTcp(opts: { token?: () => string; readTimeoutMs?: number; app?: StubApp } = {}) {
  const app = opts.app ?? createStubApp();
  const logger = recordingLogger();
  server = createBridgeServer({
    app,
    transport: { kind: 'tcp', host: '127.0.0.1', port: 0 },
    token: opts.token ?? (() => TOKEN),
    logger,
    ...(opts.readTimeoutMs !== undefined ? { readTimeoutMs: opts.readTimeoutMs } : {}),
  });
  const addr = await server.listen();
  if (addr.kind !== 'tcp') throw new Error('expected tcp');
  const endpoint: Endpoint = { port: addr.port };
  return { app, logger, endpoint };
}

describe('bridge server (tcp)', () => {
  test('valid round trip: forwards the envelope and returns the NativeResponse', async () => {
    const { app, endpoint } = await startTcp();
    app.respond('handleNative', { ok: true, data: { relation: 'none_active' } });
    const res = await requestJson(endpoint, envelope());
    expect(res).toEqual({ ok: true, data: { relation: 'none_active' } });
    const [call] = app.callsTo('handleNative');
    expect(call!.args[0]).toEqual(envelope());
  });

  test('binds 127.0.0.1 only', async () => {
    await startTcp();
    expect(server!.address()).toMatchObject({ kind: 'tcp', host: '127.0.0.1' });
    expect(() => createBridgeServer({ app: createStubApp(), transport: { kind: 'tcp', host: '0.0.0.0' as '127.0.0.1', port: 0 }, token: () => TOKEN, logger: recordingLogger() })).toThrow(SfeError);
  });

  test('null profileId is accepted (unidentified profile)', async () => {
    const { app, endpoint } = await startTcp();
    await requestJson(endpoint, envelope({ bridge: { profileId: null, bridgeVersion: '1.0.0' } }));
    expect((app.callsTo('handleNative')[0]!.args[0] as { bridge: { profileId: unknown } }).bridge.profileId).toBeNull();
  });

  test('one request per connection: the server closes after the reply', async () => {
    const { endpoint } = await startTcp();
    const { text } = await exchangeRaw(endpoint, `${JSON.stringify(envelope())}\n${JSON.stringify(envelope())}\n`);
    expect(text.trim().split('\n')).toHaveLength(1);
  });

  test('wrong token → AUTH_REQUIRED and handleNative is not called', async () => {
    const { app, endpoint } = await startTcp();
    const res = await requestJson(endpoint, envelope({ auth: 'bridge-token-synthetic-0123456789abcdeX' }));
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('AUTH_REQUIRED');
    expect(app.callsTo('handleNative')).toHaveLength(0);
  });

  test('missing or non-string token → AUTH_REQUIRED', async () => {
    const { endpoint } = await startTcp();
    expect((await requestJson(endpoint, envelope({ auth: undefined }))).error.code).toBe('AUTH_REQUIRED');
    expect((await requestJson(endpoint, envelope({ auth: 12345 }))).error.code).toBe('AUTH_REQUIRED');
  });

  test('an unconfigured (empty) token rejects everything, including an empty presented token', async () => {
    const { endpoint } = await startTcp({ token: () => '' });
    expect((await requestJson(endpoint, envelope({ auth: '' }))).error.code).toBe('AUTH_REQUIRED');
    expect((await requestJson(endpoint, envelope())).error.code).toBe('AUTH_REQUIRED');
  });

  test('token rotation takes effect on the next request', async () => {
    let current = TOKEN;
    const { endpoint } = await startTcp({ token: () => current });
    expect((await requestJson(endpoint, envelope())).ok).toBe(true);
    current = 'rotated-token-synthetic-000000000000';
    expect((await requestJson(endpoint, envelope())).error.code).toBe('AUTH_REQUIRED');
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

  test('oversized line → BAD_REQUEST then close', async () => {
    const { app, endpoint } = await startTcp();
    const big = `{"v":1,"pad":"${'x'.repeat(NATIVE_MAX_MESSAGE_BYTES + 10)}"}\n`;
    const { text } = await exchangeRaw(endpoint, big);
    const res = JSON.parse(text.split('\n')[0]!);
    expect(res).toMatchObject({ ok: false, error: { code: 'BAD_REQUEST' } });
    expect(app.calls).toHaveLength(0);
  });

  test('a line just under the limit is accepted for parsing', async () => {
    const { endpoint } = await startTcp();
    const base = JSON.stringify(envelope({ pad: '' }));
    const pad = 'x'.repeat(NATIVE_MAX_MESSAGE_BYTES - base.length);
    const res = await requestJson(endpoint, envelope({ pad }));
    expect(res.ok).toBe(true);
  });

  test.each([
    ['too short', 'abc'],
    ['slash', 'ABCDEF12/../x'],
    ['spaces', 'ABCDEF12 3456'],
    ['too long', 'A'.repeat(65)],
    ['number', 12345678],
  ])('bad profileId (%s) → BAD_REQUEST', async (_label, profileId) => {
    const { app, endpoint } = await startTcp();
    const res = await requestJson(endpoint, envelope({ bridge: { profileId, bridgeVersion: '1.0.0' } }));
    expect(res.error.code).toBe('BAD_REQUEST');
    expect(app.calls).toHaveLength(0);
  });

  test.each(['deleteAllEnvironments', 'toString', '__proto__', 'constructor', ''])('unknown message type %j → BAD_REQUEST', async (type) => {
    const { app, endpoint } = await startTcp();
    const res = await requestJson(endpoint, envelope({ message: { type } }));
    expect(res.error.code).toBe('BAD_REQUEST');
    expect(app.calls).toHaveLength(0);
  });

  test('protocol version other than 1 → BAD_REQUEST', async () => {
    const { endpoint } = await startTcp();
    expect((await requestJson(endpoint, envelope({ v: 2 }))).error.code).toBe('BAD_REQUEST');
  });

  test('invalid JSON → BAD_REQUEST', async () => {
    const { endpoint } = await startTcp();
    const { text } = await exchangeRaw(endpoint, '{"v":1,\n');
    expect(JSON.parse(text.split('\n')[0]!).error.code).toBe('BAD_REQUEST');
  });

  test('half-closed request without a trailing newline is still answered', async () => {
    const { endpoint } = await startTcp();
    const { text } = await exchangeRaw(endpoint, JSON.stringify(envelope()), { endAfterWrite: true });
    expect(JSON.parse(text.split('\n')[0]!).ok).toBe(true);
  });

  test('a stalled partial request is dropped after the read timeout', async () => {
    const { app, endpoint } = await startTcp({ readTimeoutMs: 100 });
    const { text } = await exchangeRaw(endpoint, '{"v":1');
    expect(text).toBe('');
    expect(app.calls).toHaveLength(0);
  });

  test('SfeError from handleNative → { ok: false, error }', async () => {
    const app = createStubApp();
    app.throwOn('handleNative', new SfeError('BINDING_MISMATCH', '操作失败：场景与环境不符'));
    const { endpoint } = await startTcp({ app });
    expect(await requestJson(endpoint, envelope())).toEqual({ ok: false, error: { code: 'BINDING_MISMATCH', message: '操作失败：场景与环境不符' } });
  });

  test('other errors → INTERNAL without details', async () => {
    const app = createStubApp();
    app.throwOn('handleNative', new Error('keychain item CANARY-kc-991 locked'));
    const { endpoint, logger } = await startTcp({ app });
    const res = await requestJson(endpoint, envelope());
    expect(res).toEqual({ ok: false, error: { code: 'INTERNAL', message: '服务内部错误' } });
    expect(JSON.stringify(res)).not.toContain('CANARY');
    expect(logger.text()).not.toContain('CANARY');
  });

  test('never logs message contents, the token or the profile id', async () => {
    const { app, endpoint, logger } = await startTcp();
    app.respond('handleNative', { ok: true, data: { fills: [{ field: 'identifier', value: 'buyer01@example.test' }] } });
    await requestJson(
      endpoint,
      envelope({
        message: { type: 'requestLoginFill', top_url: 'https://www.amazon.com/ap/signin?CANARY-URL', frame_is_top: true, form_action: null, fields: ['identifier'], route_epoch: 3 },
      }),
    );
    await requestJson(endpoint, envelope({ auth: 'wrong-token-CANARY-000000000000000' }));
    await exchangeRaw(endpoint, 'GET /CANARY-PATH HTTP/1.1\r\n\r\n');
    const text = logger.text();
    expect(text).not.toContain('CANARY');
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(PROFILE);
    expect(text).not.toContain('buyer01@example.test');
    expect(logger.entries.some((e) => e.fields?.type === 'requestLoginFill' && e.fields?.result === 'ok')).toBe(true);
  });
});

describe('bridge server (unix)', () => {
  test('socket file is created with mode 0600 and round trip works', async () => {
    const dir = privateDir();
    const path = join(dir, 'bridge.sock');
    server = createBridgeServer({ app: createStubApp(), transport: { kind: 'unix', path }, token: () => TOKEN, logger: recordingLogger() });
    expect(await server.listen()).toEqual({ kind: 'unix', path });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect((await requestJson({ path }, envelope())).ok).toBe(true);
  });

  test('a stale socket path is replaced', async () => {
    const dir = privateDir();
    const path = join(dir, 'bridge.sock');
    makeStaleSocket(path);
    expect(lstatSync(path).isSocket()).toBe(true);
    server = createBridgeServer({ app: createStubApp(), transport: { kind: 'unix', path }, token: () => TOKEN, logger: recordingLogger() });
    await server.listen();
    expect((await requestJson({ path }, envelope())).ok).toBe(true);
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
      expect((await requestJson({ path }, envelope())).ok).toBe(true);
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

describe('envelope helpers', () => {
  test('tokenMatches', () => {
    expect(tokenMatches(TOKEN, TOKEN)).toBe(true);
    expect(tokenMatches(`${TOKEN}x`, TOKEN)).toBe(false);
    expect(tokenMatches('', '')).toBe(false);
    expect(tokenMatches(null, TOKEN)).toBe(false);
  });

  test('validateBridgeEnvelope rejects non-objects', () => {
    for (const raw of [null, [], 'x', 1]) expect(validateBridgeEnvelope(raw, TOKEN).ok).toBe(false);
  });

  test('validateBridgeEnvelope checks the token before anything else', () => {
    const r = validateBridgeEnvelope({ v: 9, auth: 'nope', bridge: null, message: null }, TOKEN);
    expect(r).toMatchObject({ ok: false, error: { code: 'AUTH_REQUIRED' } });
  });

  test('validateBridgeEnvelope rejects a bad bridgeVersion', () => {
    expect(validateBridgeEnvelope(envelope({ bridge: { profileId: PROFILE, bridgeVersion: 'a b' } }), TOKEN).ok).toBe(false);
    expect(validateBridgeEnvelope(envelope({ bridge: { profileId: PROFILE } }), TOKEN).ok).toBe(false);
  });
});
