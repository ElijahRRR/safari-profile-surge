import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { parseDemoNativeBody } from '../../src/http/server.js';
import { json, rawGet, send, startHarness, type Harness } from './server-harness.js';

function harnessRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'sfe-harness-'));
  mkdirSync(join(root, 'assets'));
  writeFileSync(join(root, 'popup.html'), '<!doctype html><title>popup</title>');
  writeFileSync(join(root, 'assets', 'popup-AbCd1234.js'), 'void 0;');
  writeFileSync(join(root, '.secret'), 'HARNESS_DOTFILE');
  return root;
}

const envelope = { v: 1, message: { type: 'getCurrentState' } };

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

describe('demo routes absent when demo=false', () => {
  test('POST /dev/native → 404 even with a valid token; app not called', async () => {
    h = await startHarness({ demo: false, extensionHarnessRoot: harnessRoot() });
    const r = await send(h, { method: 'POST', path: '/dev/native', body: JSON.stringify({ profileId: null, envelope }) });
    expect(r.status).toBe(404);
    expect(h.app.calls).toHaveLength(0);
  });

  test('GET /dev/extension/popup.html → 404', async () => {
    h = await startHarness({ demo: false, extensionHarnessRoot: harnessRoot() });
    const r = await send(h, { path: '/dev/extension/popup.html' });
    expect(r.status).toBe(404);
    expect(r.body).not.toContain('popup');
  });
});

describe('demo routes when demo=true', () => {
  test('POST /dev/native requires Bearer', async () => {
    h = await startHarness({ demo: true });
    const r = await send(h, { method: 'POST', path: '/dev/native', body: JSON.stringify({ profileId: null, envelope }), token: null });
    expect(r.status).toBe(401);
    expect(h.app.calls).toHaveLength(0);
  });

  test('POST /dev/native forwards a demo BridgeEnvelope and returns the NativeResponse', async () => {
    h = await startHarness({ demo: true });
    h.app.respond('handleNative', { ok: true, data: { relation: 'none_active' } });
    const r = await send(h, {
      method: 'POST',
      path: '/dev/native',
      body: JSON.stringify({ profileId: 'ABCDEF12-3456-7890-ABCD-EF1234567890', envelope: { v: 1, message: { type: 'reportProfileState', windows_open: 1, amazon_tabs_open: false, site_permission_granted: true } } }),
    });
    expect(r.status).toBe(200);
    expect(json(r)).toEqual({ ok: true, data: { relation: 'none_active' } });
    expect(h.app.callsTo('handleNative')[0]!.args[0]).toEqual({
      v: 1,
      auth: 'demo',
      bridge: { profileId: 'ABCDEF12-3456-7890-ABCD-EF1234567890', bridgeVersion: 'demo' },
      message: { type: 'reportProfileState', windows_open: 1, amazon_tabs_open: false, site_permission_granted: true },
    });
  });

  test('handleNative errors become { ok: false, error }', async () => {
    h = await startHarness({ demo: true });
    const { SfeError } = await import('@sfe/contract');
    h.app.throwOn('handleNative', new SfeError('BINDING_MISMATCH', '操作失败：场景与环境不符'));
    const r = await send(h, { method: 'POST', path: '/dev/native', body: JSON.stringify({ profileId: null, envelope }) });
    expect(r.status).toBe(200);
    expect(json(r)).toEqual({ ok: false, error: { code: 'BINDING_MISMATCH', message: '操作失败：场景与环境不符' } });
  });

  test('bad profileId → 400 { ok: false }', async () => {
    h = await startHarness({ demo: true });
    const r = await send(h, { method: 'POST', path: '/dev/native', body: JSON.stringify({ profileId: 'short', envelope }) });
    expect(r.status).toBe(400);
    expect(json(r).ok).toBe(false);
    expect(h.app.calls).toHaveLength(0);
  });

  test('GET /dev/native → 405', async () => {
    h = await startHarness({ demo: true });
    const r = await send(h, { path: '/dev/native' });
    expect(r.status).toBe(405);
  });

  test('serves the extension harness under /dev/extension/', async () => {
    h = await startHarness({ demo: true, extensionHarnessRoot: harnessRoot() });
    const page = await send(h, { path: '/dev/extension/popup.html', token: null });
    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toBe('text/html; charset=utf-8');
    const asset = await send(h, { path: '/dev/extension/assets/popup-AbCd1234.js', token: null });
    expect(asset.status).toBe(200);
    expect(asset.headers['cache-control']).toBe('no-store');
  });

  test('harness static files reject traversal and dotfiles', async () => {
    h = await startHarness({ demo: true, extensionHarnessRoot: harnessRoot() });
    for (const p of ['/dev/extension/.secret', '/dev/extension/..%2f..%2fetc%2fpasswd', '/dev/extension/../popup.html']) {
      const r = await rawGet(h.port, p);
      expect(r.status).not.toBe(200);
      expect(r.text).not.toContain('HARNESS_DOTFILE');
    }
  });

  test('/dev/extension redirects to the trailing-slash form', async () => {
    h = await startHarness({ demo: true, extensionHarnessRoot: harnessRoot() });
    const r = await send(h, { path: '/dev/extension' });
    expect(r.status).toBe(308);
    expect(r.headers.location).toBe('/dev/extension/');
  });

  test('without a harness root, /dev/extension is 404', async () => {
    h = await startHarness({ demo: true, extensionHarnessRoot: null });
    const r = await send(h, { path: '/dev/extension/popup.html' });
    expect(r.status).toBe(404);
  });

  test('session reports demoMode', async () => {
    h = await startHarness({ demo: true });
    const r = await send(h, { path: '/api/session' });
    expect(json(r).demoMode).toBe(true);
  });
});

describe('parseDemoNativeBody', () => {
  test('accepts null profileId and known message types', () => {
    expect(parseDemoNativeBody({ profileId: null, envelope })).toMatchObject({ ok: true, profileId: null });
  });

  test.each([
    [{ profileId: 'x/y', envelope }],
    [{ profileId: null, envelope: { v: 2, message: { type: 'getCurrentState' } } }],
    [{ profileId: null, envelope: { v: 1, message: { type: 'deleteEverything' } } }],
    [{ profileId: null, envelope: { v: 1, message: { type: 'toString' } } }],
    [{ profileId: null }],
    [{ profileId: 123, envelope }],
  ])('rejects %j', (body) => {
    expect(parseDemoNativeBody(body as Record<string, unknown>).ok).toBe(false);
  });
});
