import { afterEach, describe, expect, it, vi } from 'vitest';
import { NATIVE_PERMISSIONS } from '@sfe/contract';
import { NATIVE_REQUEST_TYPES, createNativeClient, isNativeRequestType, parseNativeResponse } from '../src/shared/native';
import { createPageClient } from '../src/shared/messages';
import { mockBrowser } from './fixtures';

describe('parseNativeResponse', () => {
  it('accepts ok and error responses', () => {
    expect(parseNativeResponse({ ok: true, data: { a: 1 } })).toEqual({ ok: true, data: { a: 1 } });
    expect(parseNativeResponse({ ok: false, error: { code: 'NOT_FOUND', message: '找不到' } })).toEqual({
      ok: false,
      error: { code: 'NOT_FOUND', message: '找不到' },
    });
  });

  it('accepts an HTTP-style error body', () => {
    expect(parseNativeResponse({ error: { code: 'AUTH_REQUIRED', message: '未登录' } })).toMatchObject({ ok: false, error: { code: 'AUTH_REQUIRED' } });
  });

  it.each([null, undefined, 'x', 42, [], { ok: 'yes' }, { ok: false }, { ok: false, error: { code: 1 } }])('rejects malformed %j', (raw) => {
    const r = parseNativeResponse(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INTERNAL');
  });
});

describe('createNativeClient', () => {
  afterEach(() => vi.useRealTimers());

  it('sends a v1 envelope', async () => {
    const send = vi.fn(async () => ({ ok: true, data: 1 }));
    await createNativeClient({ send }).call({ type: 'getCurrentState' });
    expect(send).toHaveBeenCalledWith({ v: 1, message: { type: 'getCurrentState' } });
  });

  it('turns a transport failure into an error without echoing it', async () => {
    const client = createNativeClient({ send: async () => Promise.reject(new Error('/Users/someone/secret-path token=abc')) });
    const r = await client.call({ type: 'getCurrentState' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.message).not.toContain('secret-path');
      expect(r.error.message).not.toContain('token');
    }
  });

  it('times out as unknown state', async () => {
    vi.useFakeTimers();
    const client = createNativeClient({ send: () => new Promise(() => undefined) }, { timeoutMs: 1000 });
    const p = client.call({ type: 'getCurrentState' });
    await vi.advanceTimersByTimeAsync(1001);
    const r = await p;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('UNKNOWN_STATE');
  });
});

describe('request types', () => {
  it('match the contract permission matrix', () => {
    expect([...NATIVE_REQUEST_TYPES].sort()).toEqual(Object.keys(NATIVE_PERMISSIONS).sort());
    expect(isNativeRequestType('getCurrentState')).toBe(true);
    expect(isNativeRequestType('switchProfile')).toBe(false);
    expect(isNativeRequestType(undefined)).toBe(false);
  });
});

describe('createPageClient', () => {
  it('wraps native requests for the background', async () => {
    const b = mockBrowser();
    (b.runtime.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, data: 'x' });
    const r = await createPageClient(b).call({ type: 'getCurrentState' });
    expect(b.runtime.sendMessage).toHaveBeenCalledWith({ sfe: 'native', message: { type: 'getCurrentState' } });
    expect(r).toEqual({ ok: true, data: 'x' });
  });

  it('asks the background for profile state', async () => {
    const b = mockBrowser();
    (b.runtime.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, data: {} });
    await createPageClient(b).profileState(true);
    expect(b.runtime.sendMessage).toHaveBeenCalledWith({ sfe: 'profileState', report: true });
  });

  it('reports an error when the background does not answer', async () => {
    const b = mockBrowser();
    (b.runtime.sendMessage as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('gone'));
    expect((await createPageClient(b).call({ type: 'getCurrentState' })).ok).toBe(false);
    (b.runtime.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    expect((await createPageClient(b).call({ type: 'getCurrentState' })).ok).toBe(false);
  });
});
