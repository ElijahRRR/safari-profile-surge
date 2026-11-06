import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { CONTENT_SECURITY_POLICY } from '../../src/http/headers.js';
import { json, rawRequest, send, startHarness, type Harness } from './server-harness.js';

let h: Harness;
beforeEach(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h.close();
});

describe('binding', () => {
  test('listens on 127.0.0.1 only', () => {
    expect(h.url).toBe(`http://127.0.0.1:${h.port}`);
    expect(h.server.boundUrl()).toBe(h.url);
  });

  test('boundUrl is null after close', async () => {
    await h.server.close();
    expect(h.server.boundUrl()).toBeNull();
  });
});

describe('Host header', () => {
  test('foreign host name is rejected with 403 FORBIDDEN_ORIGIN', async () => {
    const r = await send(h, { path: '/api/environments', host: `evil.example.test:${h.port}` });
    expect(r.status).toBe(403);
    expect(json(r).error.code).toBe('FORBIDDEN_ORIGIN');
    expect(h.app.calls).toHaveLength(0);
  });

  test('loopback host on a different port is rejected', async () => {
    const r = await send(h, { path: '/api/environments', host: `127.0.0.1:${h.port + 1}` });
    expect(r.status).toBe(403);
  });

  test('host without port is rejected', async () => {
    const r = await send(h, { path: '/', host: '127.0.0.1' });
    expect(r.status).toBe(403);
  });

  test('DNS-rebinding style host is rejected for static files too', async () => {
    const r = await send(h, { path: '/', host: `attacker.invalid:${h.port}`, token: null });
    expect(r.status).toBe(403);
    expect(r.body).not.toContain('<div id="app">');
  });

  test('localhost:<port> is accepted', async () => {
    const r = await send(h, { path: '/api/environments', host: `localhost:${h.port}` });
    expect(r.status).toBe(200);
  });

  test('LOCALHOST in upper case is accepted', async () => {
    const r = await send(h, { path: '/api/environments', host: `LOCALHOST:${h.port}` });
    expect(r.status).toBe(200);
  });

  test('missing Host header is rejected', async () => {
    const text = await rawRequest(h.port, `GET / HTTP/1.0\r\n\r\n`);
    expect(text).toMatch(/^HTTP\/1\.1 403/);
  });
});

describe('Origin header', () => {
  test('Origin: null is rejected', async () => {
    const r = await send(h, { path: '/api/environments', headers: { origin: 'null' } });
    expect(r.status).toBe(403);
    expect(json(r).error.code).toBe('FORBIDDEN_ORIGIN');
    expect(h.app.calls).toHaveLength(0);
  });

  test('foreign port on loopback is rejected', async () => {
    const r = await send(h, { method: 'POST', path: '/api/routing/normal', body: '{}', headers: { origin: `http://127.0.0.1:${h.port + 1}` } });
    expect(r.status).toBe(403);
    expect(h.app.calls).toHaveLength(0);
  });

  test('foreign site is rejected', async () => {
    const r = await send(h, { path: '/api/snapshot', headers: { origin: 'https://evil.example.test' } });
    expect(r.status).toBe(403);
  });

  test('https scheme with the same host is rejected', async () => {
    const r = await send(h, { path: '/api/snapshot', headers: { origin: `https://127.0.0.1:${h.port}` } });
    expect(r.status).toBe(403);
  });

  test('same origin (127.0.0.1) is accepted', async () => {
    const r = await send(h, { path: '/api/environments', headers: { origin: `http://127.0.0.1:${h.port}` } });
    expect(r.status).toBe(200);
  });

  test('same origin (localhost) is accepted', async () => {
    const r = await send(h, { path: '/api/environments', headers: { origin: `http://localhost:${h.port}` } });
    expect(r.status).toBe(200);
  });

  test('absent Origin is accepted (same-origin GET navigation)', async () => {
    const r = await send(h, { path: '/api/environments' });
    expect(r.status).toBe(200);
  });
});

describe('no CORS', () => {
  test('preflight gets no Access-Control headers', async () => {
    const r = await send(h, {
      method: 'OPTIONS',
      path: '/api/environments',
      headers: { origin: 'https://evil.example.test', 'access-control-request-method': 'POST' },
      token: null,
    });
    expect(r.status).toBeGreaterThanOrEqual(400);
    for (const k of Object.keys(r.headers)) expect(k).not.toMatch(/^access-control-/);
  });

  test('successful API response has no Access-Control headers', async () => {
    const r = await send(h, { path: '/api/environments', headers: { origin: `http://127.0.0.1:${h.port}` } });
    expect(r.status).toBe(200);
    for (const k of Object.keys(r.headers)) expect(k).not.toMatch(/^access-control-/);
  });
});

describe('security headers', () => {
  const paths = ['/api/environments', '/', '/missing.txt', '/auth/exchange?code=x', '/auth/exchange.js'];
  for (const path of paths) {
    test(`present on ${path.split('?')[0]}`, async () => {
      const r = await send(h, { path });
      expect(r.headers['x-content-type-options']).toBe('nosniff');
      expect(r.headers['referrer-policy']).toBe('no-referrer');
      expect(r.headers['content-security-policy']).toBe(CONTENT_SECURITY_POLICY);
      expect(r.headers['cache-control']).toBe('no-store');
      expect(r.headers['set-cookie']).toBeUndefined();
    });
  }

  test('present on rejected requests', async () => {
    const r = await send(h, { path: '/api/environments', token: null });
    expect(r.status).toBe(401);
    expect(r.headers['content-security-policy']).toBe(CONTENT_SECURITY_POLICY);
    expect(r.headers['cache-control']).toBe('no-store');
  });

  test('CSP is exactly the specified policy', () => {
    expect(CONTENT_SECURITY_POLICY).toBe(
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'; object-src 'none'",
    );
  });
});
