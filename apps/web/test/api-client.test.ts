import { describe, expect, it, vi } from 'vitest';
import { API_ROUTES } from '@sfe/contract';
import { ApiClient, ApiError, SESSION_EXPIRED_MESSAGE, parseErrorBody } from '../src/api/client';
import { createLocalTokenStore, createMemoryTokenStore, parseStoredToken, SESSION_STORAGE_KEY } from '../src/api/session-token';
import { TOKEN, fakeFetch } from './fixtures';

function client(responder: Parameters<typeof fakeFetch>[0], token: string | null = TOKEN) {
  const { fetch, calls } = fakeFetch(responder);
  const onUnauthorized = vi.fn();
  const api = new ApiClient({ tokens: createMemoryTokenStore(token), fetch, onUnauthorized });
  return { api, calls, onUnauthorized };
}

describe('ApiClient', () => {
  it('sends Authorization: Bearer on every request, including GET', async () => {
    const { api, calls } = client(() => ({ status: 200, body: [] }));
    await api.listEnvironments();
    await api.listCapabilities();
    await api.getOperation('op_1');
    expect(calls).toHaveLength(3);
    for (const c of calls) expect(c.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('never sends cookies and disables caching', async () => {
    const seen: RequestInit[] = [];
    const api = new ApiClient({
      tokens: createMemoryTokenStore(TOKEN),
      fetch: (async (_u: RequestInfo | URL, init?: RequestInit) => {
        seen.push(init ?? {});
        return new Response('{}', { status: 200 });
      }) as typeof fetch,
    });
    await api.snapshot();
    expect(seen[0]?.credentials).toBe('omit');
    expect(seen[0]?.cache).toBe('no-store');
  });

  it('sends JSON bodies with the route method and path params encoded', async () => {
    const { api, calls } = client(() => ({ status: 202, body: { operation_id: 'op_9', environment_id: 'env 1', revision: 4, duplicate: false } }));
    const res = await api.updateEnvironment('env 1', { request_id: 'r1', expected_revision: 3, changes: { displayName: 'US-买家02' } });
    expect(res.operation_id).toBe('op_9');
    expect(calls[0]?.method).toBe('PATCH');
    expect(calls[0]?.url).toBe('/api/environments/env%201');
    expect(calls[0]?.headers['Content-Type']).toBe('application/json');
    expect(calls[0]?.body).toEqual({ request_id: 'r1', expected_revision: 3, changes: { displayName: 'US-买家02' } });
  });

  it('DELETE carries its body (request_id + expected_revision)', async () => {
    const { api, calls } = client(() => ({ status: 202, body: { operation_id: 'op_2', environment_id: 'env_1', revision: null, duplicate: false } }));
    await api.deleteEnvironment('env_1', { request_id: 'r2', expected_revision: 5 });
    expect(calls[0]?.method).toBe('DELETE');
    expect(calls[0]?.body).toEqual({ request_id: 'r2', expected_revision: 5 });
  });

  it('adds the limit query for listOperations', async () => {
    const { api, calls } = client(() => ({ status: 200, body: [] }));
    await api.listOperations(50);
    expect(calls[0]?.url).toBe(`${API_ROUTES.listOperations.path}?limit=50`);
  });

  it('turns { error } bodies into typed ApiError with code, fieldErrors and details', async () => {
    const { api } = client(() => ({
      status: 409,
      body: { error: { code: 'NEEDS_CONFIRMATION', message: '切换失败：需要确认旧窗口', details: { reason: 'other_environment_active' }, fieldErrors: [{ field: 'x', message: 'y' }] } },
    }));
    const err = await api.activate('env_1', { request_id: 'r' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    const e = err as ApiError;
    expect(e.status).toBe(409);
    expect(e.code).toBe('NEEDS_CONFIRMATION');
    expect(e.message).toBe('切换失败：需要确认旧窗口');
    expect(e.details).toEqual({ reason: 'other_environment_active' });
    expect(e.fieldErrors).toEqual([{ field: 'x', message: 'y' }]);
  });

  it('does not echo unexpected error bodies', async () => {
    const { api } = client(() => ({ status: 500, text: '<html>token: hunter2-secret</html>' }));
    const err = (await api.snapshot().catch((e: unknown) => e)) as ApiError;
    expect(err.code).toBe('INTERNAL');
    expect(err.message).not.toContain('hunter2');
    expect(err.message).toContain('500');
  });

  it('401 calls onUnauthorized and throws AUTH_REQUIRED', async () => {
    const { api, onUnauthorized } = client(() => ({ status: 401 }));
    const err = (await api.snapshot().catch((e: unknown) => e)) as ApiError;
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(err.code).toBe('AUTH_REQUIRED');
    expect(err.message).toBe(SESSION_EXPIRED_MESSAGE);
  });

  it('without a token it never hits the network and reports unauthorized', async () => {
    const { api, calls, onUnauthorized } = client(() => ({ status: 200, body: {} }), null);
    const err = (await api.snapshot().catch((e: unknown) => e)) as ApiError;
    expect(calls).toHaveLength(0);
    expect(onUnauthorized).toHaveBeenCalled();
    expect(err.status).toBe(401);
  });

  it('maps network failures to a readable error without retrying', async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const api = new ApiClient({ tokens: createMemoryTokenStore(TOKEN), fetch: fetch as unknown as typeof globalThis.fetch });
    const err = (await api.snapshot().catch((e: unknown) => e)) as ApiError;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(err.status).toBe(0);
    expect(err.message).toContain('连接本机服务失败');
  });

  it('returns text for the import template', async () => {
    const { api, calls } = client(() => ({ status: 200, text: 'display_name,proxy_host\n' }));
    await expect(api.importTemplate()).resolves.toBe('display_name,proxy_host\n');
    expect(calls[0]?.url).toBe('/api/imports/template.csv');
  });

  it('has a typed function for every API route except the event stream', () => {
    const api = new ApiClient({ tokens: createMemoryTokenStore(TOKEN) });
    const MAP: Record<string, string> = { surgeCandidates: 'surgeCandidates' };
    for (const name of Object.keys(API_ROUTES)) {
      if (name === 'events') continue;
      expect(typeof (api as unknown as Record<string, unknown>)[MAP[name] ?? name], name).toBe('function');
    }
  });
});

describe('parseErrorBody', () => {
  it('rejects unknown codes and malformed bodies', () => {
    expect(parseErrorBody({ error: { code: 'NOPE', message: 'x' } })).toBeNull();
    expect(parseErrorBody({ error: 'x' })).toBeNull();
    expect(parseErrorBody(null)).toBeNull();
    expect(parseErrorBody({ error: { code: 'NOT_FOUND', message: '找不到' } })).toEqual({ code: 'NOT_FOUND', message: '找不到' });
  });
});

describe('session token storage', () => {
  it('reads sfe.session from localStorage and clears it', () => {
    localStorage.setItem(SESSION_STORAGE_KEY, TOKEN);
    const store = createLocalTokenStore();
    expect(store.get()).toBe(TOKEN);
    store.clear();
    expect(localStorage.getItem(SESSION_STORAGE_KEY)).toBeNull();
    expect(store.get()).toBeNull();
  });

  it('survives a throwing storage', () => {
    const store = createLocalTokenStore(() => {
      throw new Error('denied');
    });
    expect(store.get()).toBeNull();
    expect(() => store.clear()).not.toThrow();
  });

  it('accepts a JSON wrapper and rejects values that are unsafe for headers', () => {
    expect(parseStoredToken(JSON.stringify({ token: TOKEN }))).toBe(TOKEN);
    expect(parseStoredToken('short')).toBeNull();
    expect(parseStoredToken(`${TOKEN}\r\nX-Evil: 1`)).toBeNull();
    expect(parseStoredToken('{not json')).toBeNull();
  });
});
