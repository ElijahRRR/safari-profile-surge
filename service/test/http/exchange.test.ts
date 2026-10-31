import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { AUTH_EXCHANGE_SCRIPT } from '../../src/http/auth-pages.js';
import { send, startHarness, type Harness } from './server-harness.js';

let h: Harness;
beforeEach(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h.close();
});

const tokenFromPage = (html: string): string | null => /<meta name="sfe-session" content="([^"]+)">/.exec(html)?.[1] ?? null;

describe('GET /auth/exchange', () => {
  test('valid code → no-store HTML with the session meta and the static script', async () => {
    const { code } = h.sessions.issueLoginCode();
    const r = await send(h, { path: `/auth/exchange?code=${code}`, token: null });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['referrer-policy']).toBe('no-referrer');
    expect(r.body).toContain('<script src="/auth/exchange.js"></script>');
    expect(r.body).toContain('lang="zh-CN"');
    const token = tokenFromPage(r.body);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(h.sessions.validate(token!)).not.toBeNull();
    // 页面不含内联脚本（CSP 禁止）
    expect(r.body).not.toMatch(/<script>(?!<\/script>)/);
    expect(r.body).not.toContain(code);
  });

  test('the issued token authenticates /api', async () => {
    const { code } = h.sessions.issueLoginCode();
    const page = await send(h, { path: `/auth/exchange?code=${code}`, token: null });
    const token = tokenFromPage(page.body)!;
    const r = await send(h, { path: '/api/session', token });
    expect(r.status).toBe(200);
  });

  test('code is single use: second exchange → 401 page', async () => {
    const { code } = h.sessions.issueLoginCode();
    await send(h, { path: `/auth/exchange?code=${code}`, token: null });
    const r = await send(h, { path: `/auth/exchange?code=${code}`, token: null });
    expect(r.status).toBe(401);
    expect(r.body).toContain('登录链接无效或已过期，请从菜单栏 App 或 sfe open 重新打开');
    expect(tokenFromPage(r.body)).toBeNull();
  });

  test('expired code → 401 page', async () => {
    const { code } = h.sessions.issueLoginCode();
    h.clock.advance(61_000);
    const r = await send(h, { path: `/auth/exchange?code=${code}`, token: null });
    expect(r.status).toBe(401);
  });

  test('missing code → 401 page', async () => {
    const r = await send(h, { path: '/auth/exchange', token: null });
    expect(r.status).toBe(401);
  });

  test('rate limited after 10 attempts → 429 page', async () => {
    // 测试夹具登录时已用掉 1 次
    for (let i = 0; i < 9; i++) {
      const r = await send(h, { path: `/auth/exchange?code=${'A'.repeat(43)}`, token: null });
      expect(r.status).toBe(401);
    }
    const { code } = h.sessions.issueLoginCode();
    const r = await send(h, { path: `/auth/exchange?code=${code}`, token: null });
    expect(r.status).toBe(429);
    expect(r.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(tokenFromPage(r.body)).toBeNull();
  });

  test('POST is not allowed', async () => {
    const { code } = h.sessions.issueLoginCode();
    const r = await send(h, { method: 'POST', path: `/auth/exchange?code=${code}`, body: '{}', token: null });
    expect(r.status).toBe(405);
    // 未被消费
    expect(h.sessions.exchange(code)).not.toBeNull();
  });

  test('foreign Origin cannot exchange', async () => {
    const { code } = h.sessions.issueLoginCode();
    const r = await send(h, { path: `/auth/exchange?code=${code}`, token: null, headers: { origin: 'https://evil.example.test' } });
    expect(r.status).toBe(403);
    expect(h.sessions.exchange(code)).not.toBeNull();
  });

  test.each(['cross-site', 'same-site'])('Sec-Fetch-Site: %s is refused without consuming the code or the rate limit', async (site) => {
    const { code } = h.sessions.issueLoginCode();
    for (let i = 0; i < 12; i++) {
      const r = await send(h, { path: `/auth/exchange?code=${code}`, token: null, headers: { 'sec-fetch-site': site } });
      expect(r.status).toBe(403);
      expect(tokenFromPage(r.body)).toBeNull();
    }
    const ok = await send(h, { path: `/auth/exchange?code=${code}`, token: null, headers: { 'sec-fetch-site': 'none' } });
    expect(ok.status).toBe(200);
  });

  test('Sec-Fetch-Site: same-origin is accepted', async () => {
    const { code } = h.sessions.issueLoginCode();
    const r = await send(h, { path: `/auth/exchange?code=${code}`, token: null, headers: { 'sec-fetch-site': 'same-origin' } });
    expect(r.status).toBe(200);
  });

  test('neither the code nor the token appears in logs', async () => {
    const { code } = h.sessions.issueLoginCode();
    const page = await send(h, { path: `/auth/exchange?code=${code}`, token: null });
    const token = tokenFromPage(page.body)!;
    await send(h, { path: '/api/session', token });
    await send(h, { path: `/auth/exchange?code=${code}`, token: null });
    const text = h.logger.text();
    expect(text).not.toContain(code);
    expect(text).not.toContain(token);
    expect(h.logger.entries.some((e) => e.fields?.route === 'GET /auth/exchange')).toBe(true);
  });
});

describe('GET /auth/exchange.js', () => {
  test('is a static same-origin script', async () => {
    const r = await send(h, { path: '/auth/exchange.js', token: null });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body).toBe(AUTH_EXCHANGE_SCRIPT);
  });

  test('stores the token in localStorage sfe.session inside try/catch, then location.replace("/")', () => {
    expect(AUTH_EXCHANGE_SCRIPT).toContain(`meta[name="sfe-session"]`);
    expect(AUTH_EXCHANGE_SCRIPT).toMatch(/try \{\s*window\.localStorage\.setItem\('sfe\.session', token\);\s*\} catch/);
    expect(AUTH_EXCHANGE_SCRIPT).toContain("window.location.replace('/')");
  });

  test('script behaviour in a minimal DOM', () => {
    const store = new Map<string, string>();
    let replaced: string | null = null;
    let metaContent = 'TOKEN_abcdefghijklmnopqrstuvwxyz0123456789ABCD';
    const status = { textContent: '' };
    const document = {
      querySelector: () => ({ getAttribute: () => metaContent, setAttribute: (_: string, v: string) => (metaContent = v) }),
      getElementById: () => status,
    };
    const window = {
      localStorage: { setItem: (k: string, v: string) => store.set(k, v) },
      location: { replace: (u: string) => (replaced = u) },
    };
    new Function('document', 'window', AUTH_EXCHANGE_SCRIPT)(document, window);
    expect(store.get('sfe.session')).toBe('TOKEN_abcdefghijklmnopqrstuvwxyz0123456789ABCD');
    expect(replaced).toBe('/');
    expect(metaContent).toBe('');
  });

  test('blocked storage shows a message and does not navigate', () => {
    let replaced: string | null = null;
    const status = { textContent: '' };
    const document = {
      querySelector: () => ({ getAttribute: () => 'TOKEN', setAttribute: () => undefined }),
      getElementById: () => status,
    };
    const window = {
      localStorage: {
        setItem: () => {
          throw new Error('SecurityError');
        },
      },
      location: { replace: (u: string) => (replaced = u) },
    };
    new Function('document', 'window', AUTH_EXCHANGE_SCRIPT)(document, window);
    expect(replaced).toBeNull();
    expect(status.textContent).toContain('保存登录状态失败');
  });
});
