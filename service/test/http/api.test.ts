import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { API_ROUTES, type ApiRouteName } from '@sfe/contract';
import { matchApiRoute, parseOperationsLimit } from '../../src/http/routes.js';
import type { AppMethod } from '../support/stub-app.js';
import { sfeError } from '../support/stub-app.js';
import { json, send, startHarness, type Harness } from './server-harness.js';

let h: Harness;
beforeEach(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h.close();
});

describe('authentication', () => {
  test('GET without Authorization → 401 AUTH_REQUIRED and the app is not called', async () => {
    const r = await send(h, { path: '/api/environments', token: null });
    expect(r.status).toBe(401);
    expect(json(r).error.code).toBe('AUTH_REQUIRED');
    expect(r.headers['www-authenticate']).toBe('Bearer');
    expect(h.app.calls).toHaveLength(0);
  });

  test('POST without Authorization → 401', async () => {
    const r = await send(h, { method: 'POST', path: '/api/routing/normal', body: '{}', token: null });
    expect(r.status).toBe(401);
    expect(h.app.calls).toHaveLength(0);
  });

  test('unknown token → 401', async () => {
    const r = await send(h, { path: '/api/snapshot', token: 'A'.repeat(43) });
    expect(r.status).toBe(401);
  });

  test('non-Bearer scheme → 401', async () => {
    const r = await send(h, { path: '/api/snapshot', headers: { authorization: `Basic ${h.token}` } });
    expect(r.status).toBe(401);
  });

  test('bearer scheme is case-insensitive', async () => {
    const r = await send(h, { path: '/api/snapshot', headers: { authorization: `bearer ${h.token}` } });
    expect(r.status).toBe(200);
  });

  test('cookies are ignored', async () => {
    const r = await send(h, { path: '/api/snapshot', token: null, headers: { cookie: `sfe.session=${h.token}` } });
    expect(r.status).toBe(401);
  });

  test('unknown /api path still requires auth first', async () => {
    const r = await send(h, { path: '/api/does-not-exist', token: null });
    expect(r.status).toBe(401);
  });

  test('actor is { kind: web, sessionId } and the session id is not the token', async () => {
    await send(h, { path: '/api/environments' });
    const call = h.app.callsTo('listEnvironments')[0]!;
    const actor = call.args[0] as { kind: string; sessionId: string };
    expect(actor.kind).toBe('web');
    expect(actor.sessionId).toMatch(/^web_/);
    expect(JSON.stringify(h.app.calls)).not.toContain(h.token);
  });

  test('GET /api/session returns SessionInfo', async () => {
    const r = await send(h, { path: '/api/session' });
    expect(r.status).toBe(200);
    const body = json(r);
    expect(body).toMatchObject({ authenticated: true, serviceVersion: '0.1.0-test', demoMode: false });
    expect(Date.parse(body.expiresAt)).toBeGreaterThan(h.clock.now().getTime());
    expect(r.body).not.toContain(h.token);
  });

  test('POST /api/session/logout revokes the token', async () => {
    const r = await send(h, { method: 'POST', path: '/api/session/logout', body: '{}' });
    expect(r.status).toBe(204);
    const after = await send(h, { path: '/api/session' });
    expect(after.status).toBe(401);
  });

  test('expired session → 401', async () => {
    h.clock.advance(3 * 60 * 60 * 1000);
    const r = await send(h, { path: '/api/snapshot' });
    expect(r.status).toBe(401);
  });
});

// 路由名 → [方法, 路径参数, 期望调用的 AppService 方法, 期望状态]
const ROUTE_EXPECTATIONS: Record<Exclude<ApiRouteName, 'events' | 'session' | 'logout'>, { method: AppMethod; status: number; idArg: boolean; bodyArg: boolean }> = {
  snapshot: { method: 'snapshot', status: 200, idArg: false, bodyArg: false },
  listEnvironments: { method: 'listEnvironments', status: 200, idArg: false, bodyArg: false },
  createEnvironment: { method: 'createEnvironment', status: 202, idArg: false, bodyArg: true },
  updateEnvironment: { method: 'updateEnvironment', status: 202, idArg: true, bodyArg: true },
  deleteEnvironment: { method: 'deleteEnvironment', status: 202, idArg: true, bodyArg: true },
  accountDetail: { method: 'accountDetail', status: 200, idArg: true, bodyArg: false },
  acknowledgeAccount: { method: 'acknowledgeAccount', status: 202, idArg: true, bodyArg: true },
  activate: { method: 'activate', status: 202, idArg: true, bodyArg: true },
  probe: { method: 'probe', status: 202, idArg: true, bodyArg: true },
  unbind: { method: 'unbind', status: 202, idArg: true, bodyArg: true },
  normal: { method: 'enterNormal', status: 202, idArg: false, bodyArg: true },
  publishPending: { method: 'publishPending', status: 202, idArg: false, bodyArg: true },
  getOperation: { method: 'getOperation', status: 200, idArg: true, bodyArg: false },
  cancelOperation: { method: 'cancelOperation', status: 202, idArg: true, bodyArg: true },
  acknowledgeWindows: { method: 'acknowledgeWindows', status: 202, idArg: false, bodyArg: true },
  listOperations: { method: 'listOperations', status: 200, idArg: false, bodyArg: false },
  importPreview: { method: 'importPreview', status: 200, idArg: false, bodyArg: true },
  importCommit: { method: 'importCommit', status: 200, idArg: false, bodyArg: true },
  importTemplate: { method: 'importTemplateCsv', status: 200, idArg: false, bodyArg: false },
  listCapabilities: { method: 'listCapabilities', status: 200, idArg: false, bodyArg: false },
  confirmCapability: { method: 'confirmCapability', status: 200, idArg: false, bodyArg: true },
  getSettings: { method: 'getSettings', status: 200, idArg: false, bodyArg: false },
  updateSettings: { method: 'updateSettings', status: 200, idArg: false, bodyArg: true },
  listFrontProxies: { method: 'listFrontProxies', status: 200, idArg: false, bodyArg: false },
  registerFrontProxy: { method: 'registerFrontProxy', status: 200, idArg: false, bodyArg: true },
  updateFrontProxy: { method: 'updateFrontProxy', status: 200, idArg: true, bodyArg: true },
  verifyFrontProxy: { method: 'verifyFrontProxy', status: 202, idArg: true, bodyArg: true },
  replaceFrontPreview: { method: 'replaceFrontPreview', status: 200, idArg: true, bodyArg: true },
  replaceFrontCommit: { method: 'replaceFrontCommit', status: 202, idArg: true, bodyArg: true },
  surgeCandidates: { method: 'surgePolicies', status: 200, idArg: false, bodyArg: false },
  refreshSurge: { method: 'refreshSurge', status: 200, idArg: false, bodyArg: false },
  initPreview: { method: 'initPreview', status: 200, idArg: false, bodyArg: true },
  initCommit: { method: 'initCommit', status: 202, idArg: false, bodyArg: true },
  remergePreview: { method: 'remergePreview', status: 200, idArg: false, bodyArg: false },
  remergeCommit: { method: 'remergeCommit', status: 202, idArg: false, bodyArg: true },
};

describe('route table', () => {
  for (const [name, exp] of Object.entries(ROUTE_EXPECTATIONS) as Array<[keyof typeof ROUTE_EXPECTATIONS, (typeof ROUTE_EXPECTATIONS)[keyof typeof ROUTE_EXPECTATIONS]]>) {
    test(`${name} → app.${exp.method} (${exp.status})`, async () => {
      const def = API_ROUTES[name];
      const path = def.path.replace(':id', 'env_01J%20X');
      const payload = { request_id: 'req-test-0001', marker: name };
      const r = await send(h, { method: def.method, path, ...(def.method === 'GET' ? {} : { body: JSON.stringify(payload) }) });
      expect(r.status).toBe(exp.status);
      const calls = h.app.callsTo(exp.method);
      expect(calls).toHaveLength(1);
      const args = calls[0]!.args;
      let i = 0;
      if (exp.idArg) expect(args[i++]).toBe('env_01J X');
      if (exp.bodyArg) expect(args[i++]).toEqual(payload);
      if (name === 'listOperations') expect(args[i++]).toBe(50);
      if (exp.method !== 'importTemplateCsv' && exp.method !== 'listCapabilities' && exp.method !== 'getSettings' && exp.method !== 'listFrontProxies' && exp.method !== 'surgePolicies') {
        expect(args[i]).toMatchObject({ kind: 'web' });
      }
    });
  }

  test('every contract route except events/session/logout is covered above', () => {
    const names = Object.keys(API_ROUTES).filter((n) => !['events', 'session', 'logout'].includes(n)).sort();
    expect(Object.keys(ROUTE_EXPECTATIONS).sort()).toEqual(names);
  });

  test('response body is the app result as JSON', async () => {
    h.app.respond('listEnvironments', [{ id: 'env_a', displayName: 'US-Buyer-01' }]);
    const r = await send(h, { path: '/api/environments' });
    expect(r.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(json(r)).toEqual([{ id: 'env_a', displayName: 'US-Buyer-01' }]);
  });

  test('GET /api/operations?limit=5 passes the limit', async () => {
    await send(h, { path: '/api/operations?limit=5' });
    expect(h.app.callsTo('listOperations')[0]!.args[0]).toBe(5);
  });

  test('GET /api/operations with a bad limit → 400', async () => {
    for (const bad of ['0', '-1', 'abc', '501', '1e3']) {
      const r = await send(h, { path: `/api/operations?limit=${bad}` });
      expect(r.status).toBe(400);
      expect(json(r).error.code).toBe('BAD_REQUEST');
    }
    expect(h.app.callsTo('listOperations')).toHaveLength(0);
  });

  test('GET /api/imports/template.csv is a text/csv attachment', async () => {
    const r = await send(h, { path: '/api/imports/template.csv' });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(r.headers['content-disposition']).toBe('attachment; filename="sfe-import-template.csv"');
    expect(r.body).toContain('203.0.113.10');
  });

  test('unknown /api path → 404 NOT_FOUND', async () => {
    const r = await send(h, { path: '/api/nope' });
    expect(r.status).toBe(404);
    expect(json(r).error.code).toBe('NOT_FOUND');
  });

  test('wrong method → 405 with Allow', async () => {
    const r = await send(h, { method: 'PUT', path: '/api/environments', body: '{}' });
    expect(r.status).toBe(405);
    expect(r.headers.allow).toContain('GET');
    expect(r.headers.allow).toContain('POST');
  });

  test('trailing slash does not match', async () => {
    const r = await send(h, { path: '/api/environments/' });
    expect(r.status).toBe(404);
  });

  test('malformed percent-encoding in a path param → 400', async () => {
    const r = await send(h, { path: '/api/operations/%E0%A4%A' });
    expect(r.status).toBe(400);
  });
});

describe('request bodies', () => {
  test('non-JSON content type → 415', async () => {
    const r = await send(h, { method: 'POST', path: '/api/routing/normal', body: 'request_id=x', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(r.status).toBe(415);
    expect(h.app.calls).toHaveLength(0);
  });

  test('text/plain (simple CORS request type) → 415', async () => {
    const r = await send(h, { method: 'POST', path: '/api/routing/normal', body: '{"request_id":"x"}', headers: { 'content-type': 'text/plain' } });
    expect(r.status).toBe(415);
  });

  test('application/json with charset is accepted', async () => {
    const r = await send(h, { method: 'POST', path: '/api/routing/normal', body: '{"request_id":"x"}', headers: { 'content-type': 'application/json; charset=utf-8' } });
    expect(r.status).toBe(202);
  });

  test('invalid JSON → 400', async () => {
    const r = await send(h, { method: 'POST', path: '/api/routing/normal', body: '{"request_id":' });
    expect(r.status).toBe(400);
    expect(json(r).error.code).toBe('BAD_REQUEST');
  });

  test('array body → 400', async () => {
    const r = await send(h, { method: 'POST', path: '/api/routing/normal', body: '[1,2]' });
    expect(r.status).toBe(400);
  });

  test('empty POST body is treated as {}', async () => {
    const r = await send(h, { method: 'POST', path: '/api/surge/refresh', headers: { 'content-length': '0' } });
    expect(r.status).toBe(200);
  });

  test('declared Content-Length over 8 MB → 413 and the app is not called', async () => {
    const r = await send(h, {
      method: 'POST',
      path: '/api/imports/preview',
      headers: { 'content-type': 'application/json', 'content-length': String(8 * 1024 * 1024 + 1) },
      body: '{}',
    }).catch((err: unknown) => ({ status: -1, headers: {}, body: String(err) }));
    if (r.status !== -1) expect(r.status).toBe(413);
    expect(h.app.calls).toHaveLength(0);
  });

  test('exactly 8 MB is accepted', async () => {
    const pad = 'x'.repeat(8 * 1024 * 1024 - '{"p":""}'.length);
    const r = await send(h, { method: 'POST', path: '/api/imports/preview', body: `{"p":"${pad}"}` });
    expect(r.status).toBe(200);
  });

  test('streamed body over the limit → 413', async () => {
    const small = await startHarness({ maxBodyBytes: 1024 });
    try {
      const r = await send(small, {
        method: 'POST',
        path: '/api/imports/preview',
        headers: { 'transfer-encoding': 'chunked' },
        body: `{"p":"${'y'.repeat(4096)}"}`,
      });
      expect(r.status).toBe(413);
      expect(json(r).error.code).toBe('BAD_REQUEST');
      expect(r.headers.connection).toBe('close');
      expect(small.app.calls).toHaveLength(0);
    } finally {
      await small.close();
    }
  });
});

describe('error mapping', () => {
  test('SfeError → httpStatusFor(code) + { error: toBody() }', async () => {
    h.app.throwOn('activate', sfeError('NEEDS_CONFIRMATION', '切换失败：需要确认旧窗口', { reason: 'other_environment_active' }));
    const r = await send(h, { method: 'POST', path: '/api/environments/env_1/activate', body: '{"request_id":"r1"}' });
    expect(r.status).toBe(409);
    expect(json(r)).toEqual({ error: { code: 'NEEDS_CONFIRMATION', message: '切换失败：需要确认旧窗口', details: { reason: 'other_environment_active' } } });
  });

  test('field errors are returned', async () => {
    const { SfeError } = await import('@sfe/contract');
    h.app.throwOn('createEnvironment', new SfeError('VALIDATION_FAILED', '保存失败：输入有误', { fieldErrors: [{ field: 'proxy.port', message: '端口必须是 1–65535 的整数' }] }));
    const r = await send(h, { method: 'POST', path: '/api/environments', body: '{}' });
    expect(r.status).toBe(422);
    expect(json(r).error.fieldErrors).toEqual([{ field: 'proxy.port', message: '端口必须是 1–65535 的整数' }]);
  });

  test.each([
    ['NOT_FOUND', 404],
    ['REVISION_CONFLICT', 409],
    ['CAPABILITY_UNVERIFIED', 412],
    ['SURGE_UNREACHABLE', 503],
    ['ROUTE_BUSY', 409],
    ['BINDING_MISMATCH', 403],
  ] as const)('%s → %i', async (code, status) => {
    h.app.throwOn('getOperation', sfeError(code));
    const r = await send(h, { path: '/api/operations/op_1' });
    expect(r.status).toBe(status);
    expect(json(r).error.code).toBe(code);
  });

  test('other errors → 500 INTERNAL with no message, stack or details', async () => {
    const secret = 'proxy-pass-CANARY-8812';
    const err = new Error(`execFile failed: socks5 password=${secret}`);
    (err as Error & { details?: unknown }).details = { secret };
    h.app.throwOn('snapshot', err);
    const r = await send(h, { path: '/api/snapshot' });
    expect(r.status).toBe(500);
    expect(json(r)).toEqual({ error: { code: 'INTERNAL', message: '服务内部错误' } });
    expect(r.body).not.toContain(secret);
    expect(r.body).not.toContain('at ');
    expect(h.logger.text()).not.toContain(secret);
  });

  test('a rejected non-Error value → 500 INTERNAL', async () => {
    h.app.throwOn('snapshot', 'boom');
    const r = await send(h, { path: '/api/snapshot' });
    expect(r.status).toBe(500);
    expect(json(r).error.code).toBe('INTERNAL');
  });
});

describe('logging', () => {
  test('logs route template, status, duration and error code', async () => {
    h.app.throwOn('getOperation', sfeError('NOT_FOUND'));
    await send(h, { path: '/api/operations/op_secret_id_1' });
    const entry = h.logger.entries.find((e) => e.fields?.route === 'GET /api/operations/:id');
    expect(entry).toBeDefined();
    expect(entry!.fields).toMatchObject({ status: 404, errorCode: 'NOT_FOUND' });
    expect(typeof entry!.fields!.durationMs).toBe('number');
  });

  test('never logs request bodies, response bodies, tokens or query strings', async () => {
    const canary = 'CANARY-proxy-password-5531';
    h.app.respond('importPreview', { echoed: canary });
    await send(h, { method: 'POST', path: '/api/imports/preview?x=QUERY-CANARY', body: JSON.stringify({ request_id: 'r', records: [{ proxy_password: canary }] }) });
    await send(h, { path: '/api/session' });
    const text = h.logger.text();
    expect(text).not.toContain(canary);
    expect(text).not.toContain('QUERY-CANARY');
    expect(text).not.toContain(h.token);
  });
});

describe('pure helpers', () => {
  test('matchApiRoute resolves params and methods', () => {
    expect(matchApiRoute('POST', '/api/environments/abc/activate')).toEqual({ kind: 'match', name: 'activate', path: '/api/environments/:id/activate', params: { id: 'abc' } });
    expect(matchApiRoute('GET', '/api/environments/abc/activate').kind).toBe('method_not_allowed');
    expect(matchApiRoute('GET', '/api/environments//account').kind).toBe('not_found');
    expect(matchApiRoute('GET', '/api/imports/template.csv')).toMatchObject({ kind: 'match', name: 'importTemplate' });
  });

  test('parseOperationsLimit', () => {
    expect(parseOperationsLimit(null)).toBe(50);
    expect(parseOperationsLimit('1')).toBe(1);
    expect(parseOperationsLimit('500')).toBe(500);
    expect(() => parseOperationsLimit('501')).toThrow();
  });
});
