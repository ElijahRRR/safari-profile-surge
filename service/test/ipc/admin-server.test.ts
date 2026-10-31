import { chmodSync, lstatSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { ADMIN_OPS, SfeError, type AdminOp, type AdminRole } from '@sfe/contract';
import {
  ADMIN_FORBIDDEN_MESSAGE,
  actorForRole,
  createAdminServer,
  dispatchAdminRequest,
  validateAdminEnvelope,
  type AdminServerHandle,
} from '../../src/ipc/admin-server.js';
import { ndjsonRequest } from '../../src/ipc/ndjson.js';
import { createStubApp, type AppMethod } from '../support/stub-app.js';
import { recordingLogger } from '../http/helpers.js';
import { exchangeRaw, makeStaleSocket, privateDir, requestJson } from './helpers.js';

/** 命令 → 期望调用的 AppService 方法、是否带 id 参数。 */
const OP_TO_METHOD: Record<AdminOp, { method: AppMethod; id: boolean }> = {
  status: { method: 'snapshot', id: false },
  listEnvironments: { method: 'listEnvironments', id: false },
  getEnvironment: { method: 'getEnvironment', id: true },
  createEnvironment: { method: 'createEnvironment', id: false },
  updateEnvironment: { method: 'updateEnvironment', id: true },
  deleteEnvironment: { method: 'deleteEnvironment', id: true },
  unbind: { method: 'unbind', id: true },
  acknowledgeAccount: { method: 'acknowledgeAccount', id: true },
  importPreview: { method: 'importPreview', id: false },
  importCommit: { method: 'importCommit', id: false },
  importTemplate: { method: 'importTemplateCsv', id: false },
  getOperation: { method: 'getOperation', id: true },
  cancelOperation: { method: 'cancelOperation', id: true },
  acknowledgeWindows: { method: 'acknowledgeWindows', id: false },
  listOperations: { method: 'listOperations', id: false },
  activate: { method: 'activate', id: true },
  normal: { method: 'enterNormal', id: false },
  probe: { method: 'probe', id: true },
  publishPending: { method: 'publishPending', id: false },
  listCapabilities: { method: 'listCapabilities', id: false },
  proposeCapability: { method: 'proposeCapability', id: false },
  listFrontProxies: { method: 'listFrontProxies', id: false },
  surgePolicies: { method: 'surgePolicies', id: false },
  issueLoginCode: { method: 'issueLoginCode', id: false },
  accountDetail: { method: 'accountDetail', id: true },
  registerFrontProxy: { method: 'registerFrontProxy', id: false },
  updateFrontProxy: { method: 'updateFrontProxy', id: true },
  verifyFrontProxy: { method: 'verifyFrontProxy', id: true },
  replaceFrontPreview: { method: 'replaceFrontPreview', id: true },
  replaceFrontCommit: { method: 'replaceFrontCommit', id: true },
  getSettings: { method: 'getSettings', id: false },
  updateSettings: { method: 'updateSettings', id: false },
  refreshSurge: { method: 'refreshSurge', id: false },
};

const ROLES: AdminRole[] = ['agent', 'maintenance'];

describe('role enforcement for every op in ADMIN_OPS', () => {
  test('the mapping table covers exactly ADMIN_OPS', () => {
    expect(Object.keys(OP_TO_METHOD).sort()).toEqual(Object.keys(ADMIN_OPS).sort());
  });

  for (const op of Object.keys(ADMIN_OPS) as AdminOp[]) {
    for (const role of ROLES) {
      const allowed = (ADMIN_OPS[op].roles as readonly AdminRole[]).includes(role);
      test(`${op} on ${role}: ${allowed ? 'dispatched' : 'rejected'}`, async () => {
        const app = createStubApp();
        const { method, id } = OP_TO_METHOD[op];
        const args = id ? { id: 'env_01', request_id: 'req-1' } : { request_id: 'req-1' };
        const res = await dispatchAdminRequest(app, role, { v: 1, op, args });
        if (!allowed) {
          expect(res).toEqual({ ok: false, error: { code: 'BAD_REQUEST', message: ADMIN_FORBIDDEN_MESSAGE } });
          expect(app.calls).toHaveLength(0);
          return;
        }
        expect(res.ok).toBe(true);
        const calls = app.callsTo(method);
        expect(calls).toHaveLength(1);
        const callArgs = calls[0]!.args;
        if (id) expect(callArgs[0]).toBe('env_01');
        // id 不会混进请求体
        for (const a of callArgs) if (a && typeof a === 'object' && 'request_id' in a) expect(a).not.toHaveProperty('id');
        const actor = callArgs.find((a) => a && typeof a === 'object' && 'kind' in (a as object));
        if (actor !== undefined) expect(actor).toEqual(actorForRole(role));
      });
    }
  }

  test('maintenance-only ops are rejected on agent', () => {
    const maintenanceOnly = (Object.keys(ADMIN_OPS) as AdminOp[]).filter((op) => !(ADMIN_OPS[op].roles as readonly string[]).includes('agent'));
    expect(maintenanceOnly).toEqual(
      expect.arrayContaining(['issueLoginCode', 'accountDetail', 'updateSettings', 'registerFrontProxy', 'deleteEnvironment']),
    );
  });

  test('actor is { kind: agent } for agent and { kind: admin } for maintenance', () => {
    expect(actorForRole('agent')).toEqual({ kind: 'agent' });
    expect(actorForRole('maintenance')).toEqual({ kind: 'admin' });
  });

  test('issueLoginCode returns the app result only on maintenance', async () => {
    const app = createStubApp();
    app.respond('issueLoginCode', { url: 'http://127.0.0.1:61847/auth/exchange?code=SYNTH', expiresAt: '2026-10-21T08:01:00.000Z' });
    expect(await dispatchAdminRequest(app, 'maintenance', { v: 1, op: 'issueLoginCode', args: {} })).toMatchObject({ ok: true, data: { url: expect.any(String) } });
    expect(await dispatchAdminRequest(app, 'agent', { v: 1, op: 'issueLoginCode', args: {} })).toMatchObject({ ok: false });
    expect(app.callsTo('issueLoginCode')).toHaveLength(1);
  });

  test('importTemplate wraps the CSV', async () => {
    const app = createStubApp();
    const res = await dispatchAdminRequest(app, 'agent', { v: 1, op: 'importTemplate', args: {} });
    expect(res).toMatchObject({ ok: true, data: { csv: expect.stringContaining('display_name') } });
  });

  test('listOperations limit defaults to 50 and is validated', async () => {
    const app = createStubApp();
    await dispatchAdminRequest(app, 'agent', { v: 1, op: 'listOperations', args: {} });
    await dispatchAdminRequest(app, 'agent', { v: 1, op: 'listOperations', args: { limit: 7 } });
    expect(app.callsTo('listOperations').map((c) => c.args[0])).toEqual([50, 7]);
    expect(await dispatchAdminRequest(app, 'agent', { v: 1, op: 'listOperations', args: { limit: 0 } })).toMatchObject({ ok: false, error: { code: 'BAD_REQUEST' } });
  });
});

describe('envelope validation', () => {
  test.each(['toString', 'constructor', '__proto__', 'hasOwnProperty', 'switchProfile', 'reloadProfile', ''])('unknown op %j is rejected', async (op) => {
    const app = createStubApp();
    const res = await dispatchAdminRequest(app, 'maintenance', { v: 1, op, args: {} });
    expect(res.ok).toBe(false);
    expect(app.calls).toHaveLength(0);
  });

  test('wrong version, non-object args, non-object envelope', () => {
    expect(validateAdminEnvelope({ v: 2, op: 'status', args: {} }, 'agent').ok).toBe(false);
    expect(validateAdminEnvelope({ v: 1, op: 'status', args: [] }, 'agent').ok).toBe(false);
    expect(validateAdminEnvelope([], 'agent').ok).toBe(false);
    expect(validateAdminEnvelope({ v: 1, op: 'status' }, 'agent').ok).toBe(true);
  });

  test('missing id → BAD_REQUEST', async () => {
    const app = createStubApp();
    const res = await dispatchAdminRequest(app, 'agent', { v: 1, op: 'activate', args: { request_id: 'r' } });
    expect(res).toMatchObject({ ok: false, error: { code: 'BAD_REQUEST' } });
    expect(app.calls).toHaveLength(0);
  });

  test('SfeError passes through; other errors become INTERNAL', async () => {
    const app = createStubApp();
    app.throwOn('activate', new SfeError('NEEDS_CONFIRMATION', '切换失败：需要确认', { details: { reason: 'other_environment_active' } }));
    expect(await dispatchAdminRequest(app, 'agent', { v: 1, op: 'activate', args: { id: 'e' } })).toEqual({
      ok: false,
      error: { code: 'NEEDS_CONFIRMATION', message: '切换失败：需要确认', details: { reason: 'other_environment_active' } },
    });
    app.throwOn('snapshot', new Error('secret CANARY-77'));
    expect(await dispatchAdminRequest(app, 'agent', { v: 1, op: 'status', args: {} })).toEqual({ ok: false, error: { code: 'INTERNAL', message: '服务内部错误' } });
  });
});

let server: AdminServerHandle | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

describe('admin socket', () => {
  test('socket is 0600 inside a 0700 directory and answers over NDJSON', async () => {
    const dir = privateDir();
    const path = join(dir, 'agent.sock');
    const app = createStubApp();
    app.respond('listEnvironments', [{ id: 'env_a' }]);
    server = createAdminServer({ app, path, role: 'agent', logger: recordingLogger() });
    await server.listen();
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const res = await ndjsonRequest({ path }, { v: 1, op: 'listEnvironments', args: {} }, { maxResponseBytes: 1 << 20, timeoutMs: 2000 });
    expect(res).toEqual({ ok: true, data: [{ id: 'env_a' }] });
  });

  test('refuses to listen when the parent directory is not 0700', async () => {
    const dir = privateDir();
    const open = join(dir, 'open');
    mkdirSync(open);
    chmodSync(open, 0o755);
    const s = createAdminServer({ app: createStubApp(), path: join(open, 'agent.sock'), role: 'agent', logger: recordingLogger() });
    await expect(s.listen()).rejects.toMatchObject({ code: 'UNSAFE_LOCATION' });
  });

  test('removes a stale socket but never a regular file', async () => {
    const dir = privateDir();
    const stalePath = join(dir, 'm.sock');
    makeStaleSocket(stalePath);
    server = createAdminServer({ app: createStubApp(), path: stalePath, role: 'maintenance', logger: recordingLogger() });
    await server.listen();
    expect(lstatSync(stalePath).isSocket()).toBe(true);
    const filePath = join(dir, 'f.sock');
    writeFileSync(filePath, 'x');
    const s2 = createAdminServer({ app: createStubApp(), path: filePath, role: 'maintenance', logger: recordingLogger() });
    await expect(s2.listen()).rejects.toMatchObject({ code: 'UNSAFE_LOCATION' });
  });

  test('role is fixed by the socket: maintenance ops fail on agent.sock', async () => {
    const dir = privateDir();
    const path = join(dir, 'agent.sock');
    const app = createStubApp();
    server = createAdminServer({ app, path, role: 'agent', logger: recordingLogger() });
    await server.listen();
    const res = await requestJson({ path }, { v: 1, op: 'issueLoginCode', args: {}, role: 'maintenance' });
    expect(res).toEqual({ ok: false, error: { code: 'BAD_REQUEST', message: ADMIN_FORBIDDEN_MESSAGE } });
    expect(app.calls).toHaveLength(0);
  });

  test('non-JSON first byte is dropped silently', async () => {
    const dir = privateDir();
    const path = join(dir, 'agent.sock');
    server = createAdminServer({ app: createStubApp(), path, role: 'agent', logger: recordingLogger() });
    await server.listen();
    const { text } = await exchangeRaw({ path }, 'status\n');
    expect(text).toBe('');
  });

  test('oversized request → BAD_REQUEST', async () => {
    const dir = privateDir();
    const path = join(dir, 'agent.sock');
    server = createAdminServer({ app: createStubApp(), path, role: 'agent', logger: recordingLogger(), maxMessageBytes: 1024 });
    await server.listen();
    const res = await requestJson({ path }, { v: 1, op: 'importPreview', args: { content_base64: 'A'.repeat(4096) } });
    expect(res).toMatchObject({ ok: false, error: { code: 'BAD_REQUEST' } });
  });

  test('never logs args or results', async () => {
    const dir = privateDir();
    const path = join(dir, 'maintenance.sock');
    const app = createStubApp();
    app.respond('accountDetail', { environment_id: 'e', label: null, loginIdentifier: 'buyer01@example.test', hasPassword: true });
    const logger = recordingLogger();
    server = createAdminServer({ app, path, role: 'maintenance', logger });
    await server.listen();
    await requestJson({ path }, { v: 1, op: 'createEnvironment', args: { request_id: 'r', environment: { proxy: { password: { action: 'replace', value: 'CANARY-pw-123' } } } } });
    await requestJson({ path }, { v: 1, op: 'accountDetail', args: { id: 'e' } });
    const text = logger.text();
    expect(text).not.toContain('CANARY');
    expect(text).not.toContain('buyer01@example.test');
    expect(logger.entries.some((e) => e.fields?.op === 'createEnvironment' && e.fields?.result === 'ok')).toBe(true);
  });

  test('close removes the socket file', async () => {
    const dir = privateDir();
    const path = join(dir, 'agent.sock');
    const s = createAdminServer({ app: createStubApp(), path, role: 'agent', logger: recordingLogger() });
    await s.listen();
    await s.close();
    expect(() => lstatSync(path)).toThrow();
  });
});
