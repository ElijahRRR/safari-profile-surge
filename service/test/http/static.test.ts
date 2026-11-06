import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { isHashedAssetPath, mimeTypeFor } from '../../src/http/headers.js';
import { resolveStaticPath } from '../../src/http/static.js';
import { makeWebRoot, rawGet, send, startHarness, type Harness } from './server-harness.js';

let h: Harness;
beforeEach(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h.close();
});

describe('static files', () => {
  test("'/' serves index.html as text/html without auth", async () => {
    const r = await send(h, { path: '/', token: null });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(r.body).toContain('<div id="app">');
    expect(r.headers['cache-control']).toBe('no-store');
  });

  test('HEAD returns headers without a body', async () => {
    const r = await send(h, { method: 'HEAD', path: '/index.html' });
    expect(r.status).toBe(200);
    expect(r.body).toBe('');
    expect(Number(r.headers['content-length'])).toBeGreaterThan(0);
  });

  test.each([
    ['/assets/index-DMJtotKf.js', 'text/javascript; charset=utf-8'],
    ['/assets/index-DTSTiVJR.css', 'text/css; charset=utf-8'],
    ['/assets/logo.svg', 'image/svg+xml'],
  ])('%s has MIME %s', async (path, mime) => {
    const r = await send(h, { path });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe(mime);
  });

  test('hashed assets are immutable, others no-store', async () => {
    const hashed = await send(h, { path: '/assets/index-DMJtotKf.js' });
    expect(hashed.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    const plain = await send(h, { path: '/assets/logo.svg' });
    expect(plain.headers['cache-control']).toBe('no-store');
  });

  test('missing file → 404', async () => {
    const r = await send(h, { path: '/nope.js' });
    expect(r.status).toBe(404);
  });

  test('directory → 404', async () => {
    const r = await send(h, { path: '/assets' });
    expect(r.status).toBe(404);
  });

  test('POST to a static path → 405', async () => {
    const r = await send(h, { method: 'POST', path: '/index.html', body: '{}' });
    expect(r.status).toBe(405);
  });

  test('no web root → 404', async () => {
    const bare = await startHarness({ webRoot: null });
    try {
      const r = await send(bare, { path: '/' });
      expect(r.status).toBe(404);
    } finally {
      await bare.close();
    }
  });
});

describe('traversal and dotfiles', () => {
  const attempts = [
    '/../secret.txt',
    '/assets/../../secret.txt',
    '/%2e%2e/secret.txt',
    '/%2E%2E/secret.txt',
    '/..%2fsecret.txt',
    '/..%2Fsecret.txt',
    '/assets/..%2f..%2fsecret.txt',
    '/%2e%2e%2fsecret.txt',
    '/..%5csecret.txt',
    '/assets%5c..%5c..%5csecret.txt',
    '/..\\secret.txt',
    '/%252e%252e/secret.txt',
    '/.%2e/secret.txt',
    '/index.html%00.js',
    '//secret.txt',
  ];
  for (const path of attempts) {
    test(`rejects ${path}`, async () => {
      const r = await rawGet(h.port, path);
      expect(r.status).not.toBe(200);
      expect(r.text).not.toContain('OUTSIDE_ROOT_SECRET_MARKER');
    });
  }

  test.each(['/.env', '/assets/.hidden.js', '/%2eenv', '/assets/%2ehidden.js', '/.git/config'])('dotfile %s → 404', async (path) => {
    const r = await rawGet(h.port, path);
    expect(r.status).toBe(404);
    expect(r.text).not.toContain('DOTFILE_CONTENT_MARKER');
  });

  test('malformed percent-encoding → 400', async () => {
    const r = await rawGet(h.port, '/%E0%A4%A');
    expect(r.status).toBe(400);
  });

  test('symlink escaping the root → 404', async () => {
    const { base, webRoot } = makeWebRoot();
    symlinkSync(join(base, 'secret.txt'), join(webRoot, 'link.txt'));
    mkdirSync(join(base, 'outside-dir'));
    writeFileSync(join(base, 'outside-dir', 'x.js'), 'OUTSIDE_ROOT_SECRET_MARKER');
    symlinkSync(join(base, 'outside-dir'), join(webRoot, 'linked'));
    const s = await startHarness({ webRoot });
    try {
      for (const p of ['/link.txt', '/linked/x.js']) {
        const r = await rawGet(s.port, p);
        expect(r.status).toBe(404);
        expect(r.text).not.toContain('OUTSIDE_ROOT_SECRET_MARKER');
      }
    } finally {
      await s.close();
    }
  });

  test('resolveStaticPath keeps results inside the root', async () => {
    const { webRoot } = makeWebRoot();
    expect((await resolveStaticPath(webRoot, '/')).kind).toBe('file');
    expect((await resolveStaticPath(webRoot, '/assets/logo.svg')).kind).toBe('file');
    expect((await resolveStaticPath(webRoot, '/..%2f..%2fetc%2fpasswd')).kind).toBe('not_found');
    expect((await resolveStaticPath(webRoot, '/a\0b')).kind).toBe('not_found');
    expect((await resolveStaticPath(webRoot, '/%ZZ')).kind).toBe('bad_request');
  });
});

describe('helpers', () => {
  test('isHashedAssetPath', () => {
    expect(isHashedAssetPath('/assets/index-DMJtotKf.js')).toBe(true);
    expect(isHashedAssetPath('/assets/vendor-a1B2c3D4e5.css')).toBe(true);
    expect(isHashedAssetPath('/assets/logo.svg')).toBe(false);
    expect(isHashedAssetPath('/index-DMJtotKf.js')).toBe(false);
    expect(isHashedAssetPath('/assets/sub/index-DMJtotKf.js')).toBe(false);
  });

  test('mimeTypeFor', () => {
    expect(mimeTypeFor('a.HTML')).toBe('text/html; charset=utf-8');
    expect(mimeTypeFor('a.woff2')).toBe('font/woff2');
    expect(mimeTypeFor('a.unknown')).toBe('application/octet-stream');
    expect(mimeTypeFor('noext')).toBe('application/octet-stream');
  });
});
