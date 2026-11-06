import { afterEach, describe, expect, it, vi } from 'vitest';
import { HARNESS_NATIVE_ENDPOINT, SESSION_STORAGE_KEY, harnessHttpTransport, readSessionToken } from '../src/harness/transport';
import { HARNESS_DEFAULT_EXIT_IP, harnessNavigate, harnessVerifyFetch, installHarness } from '../src/harness/shim';
import { createNativeClient } from '../src/shared/native';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('harnessHttpTransport', () => {
  it('posts { profileId, envelope } to /dev/native with the web session bearer token', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true, data: { recorded: true } }));
    const transport = harnessHttpTransport({ profileId: 'prof-demo-1', getToken: () => 'tok_synthetic', fetchImpl });
    const client = createNativeClient(transport);
    const r = await client.call({ type: 'getCurrentState' });
    expect(r).toEqual({ ok: true, data: { recorded: true } });
    const [url, init] = fetchImpl.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe(HARNESS_NATIVE_ENDPOINT);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok_synthetic');
    expect(init.credentials).toBe('omit');
    expect(JSON.parse(init.body as string)).toEqual({ profileId: 'prof-demo-1', envelope: { v: 1, message: { type: 'getCurrentState' } } });
  });

  it('omits the header without a token and maps 401 to AUTH_REQUIRED', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: { code: 'AUTH_REQUIRED', message: 'x' } }, 401));
    const client = createNativeClient(harnessHttpTransport({ profileId: null, getToken: () => null, fetchImpl }));
    const r = await client.call({ type: 'getCurrentState' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('AUTH_REQUIRED');
    const init = (fetchImpl.mock.calls[0]! as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
    expect(JSON.parse(init.body as string).profileId).toBeNull();
  });

  it('reads the session token from localStorage key sfe.session', () => {
    expect(SESSION_STORAGE_KEY).toBe('sfe.session');
    expect(readSessionToken({ getItem: (k: string) => (k === 'sfe.session' ? 'tok' : null) })).toBe('tok');
    expect(readSessionToken({ getItem: () => '' })).toBeNull();
    expect(readSessionToken({ getItem: () => { throw new Error('denied'); } })).toBeNull();
    expect(readSessionToken(null)).toBeNull();
  });
});

describe('installHarness', () => {
  const originalUrl = location.href;
  afterEach(() => {
    history.replaceState(null, '', originalUrl);
    delete (globalThis as { browser?: unknown }).browser;
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('routes page messages through the same router with HTTP transport and carries ?profile=', async () => {
    history.replaceState(null, '', '/dev/extension/popup.html?profile=prof-demo-1');
    localStorage.setItem('sfe.session', 'tok_synthetic');
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, data: { echoed: true } }));
    vi.stubGlobal('fetch', fetchMock);
    const b = installHarness();
    expect((globalThis as { browser?: unknown }).browser).toBe(b);
    const url = new URL(b.runtime.getURL('prepare.html'));
    expect(url.pathname).toBe('/dev/extension/prepare.html');
    expect(url.searchParams.get('profile')).toBe('prof-demo-1');
    const reply = await b.runtime.sendMessage({ sfe: 'native', message: { type: 'getCurrentState' } });
    expect(reply).toEqual({ ok: true, data: { echoed: true } });
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.profileId).toBe('prof-demo-1');
    expect(document.getElementById('sfe-harness-banner')?.textContent).toContain('DEMO');
    localStorage.removeItem('sfe.session');
  });

  it('never opens external sites', async () => {
    history.replaceState(null, '', '/dev/extension/popup.html?profile=prof-demo-1');
    const open = vi.fn();
    vi.stubGlobal('open', open);
    const b = installHarness();
    await b.tabs!.create({ url: 'https://www.amazon.com/gp/css/order-history' });
    expect(open).not.toHaveBeenCalled();
    await b.tabs!.create({ url: b.runtime.getURL('prepare.html') });
    expect(open).toHaveBeenCalledTimes(1);
    harnessNavigate('https://www.amazon.com/gp/css/order-history');
    expect(document.getElementById('sfe-harness-notice')?.textContent).toContain('www.amazon.com');
  });

  it('returns a synthetic documentation exit IP instead of calling the verify service', async () => {
    history.replaceState(null, '', '/dev/extension/prepare.html?op=op_1');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await harnessVerifyFetch('https://api.ipify.org/?format=json&sfe_test=t');
    expect(await res.json()).toEqual({ ip: HARNESS_DEFAULT_EXIT_IP });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
