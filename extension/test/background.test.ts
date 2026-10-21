import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NATIVE_APP_ID, type NativeEnvelope } from '@sfe/contract';
import { REPORT_DEBOUNCE_MS, installBackground, nativeMessagingTransport } from '../src/background/background';
import { collectProfileState } from '../src/background/profile-state';
import type { NativeTransport } from '../src/shared/native';
import { PAGE_SENDER, contentSender, currentState, flush, mockBrowser, ok, onMessageListener } from './fixtures';

function recordingTransport() {
  const envelopes: NativeEnvelope[] = [];
  const transport: NativeTransport = {
    send: vi.fn(async (envelope: NativeEnvelope) => {
      envelopes.push(envelope);
      if (envelope.message.type === 'getCurrentState') return ok(currentState());
      return ok({ recorded: true });
    }),
  };
  return { transport, envelopes };
}

describe('installBackground', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('registers one runtime.onMessage listener that answers asynchronously', async () => {
    const b = mockBrowser();
    const { transport } = recordingTransport();
    installBackground(b, transport);
    const listener = onMessageListener(b);
    const sendResponse = vi.fn();
    const keepOpen = listener({ sfe: 'native', message: { type: 'getCurrentState' } }, PAGE_SENDER, sendResponse);
    expect(keepOpen).toBe(true);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledTimes(1));
    expect(sendResponse.mock.calls[0]![0]).toMatchObject({ ok: true });
  });

  it('wraps every native message in the v1 envelope', async () => {
    const b = mockBrowser();
    const { transport, envelopes } = recordingTransport();
    const handle = installBackground(b, transport);
    await handle.router({ sfe: 'native', message: { type: 'getCurrentState' } }, PAGE_SENDER);
    expect(envelopes).toEqual([{ v: 1, message: { type: 'getCurrentState' } }]);
  });

  it('never sends activation or normal mode from lifecycle, window, tab or focus events', async () => {
    const b = mockBrowser({ tabs: [{ id: 1, url: 'https://www.amazon.com/gp/css/order-history' }] });
    const { transport, envelopes } = recordingTransport();
    installBackground(b, transport);
    for (const [name, fns] of Object.entries(b.listeners)) {
      if (name === 'runtime.onMessage') continue;
      for (const fn of fns) fn({ id: 1 }, {}, {});
    }
    await vi.advanceTimersByTimeAsync(REPORT_DEBOUNCE_MS * 2);
    await flush();
    const types = envelopes.map((e) => e.message.type);
    expect(types.every((t) => t === 'reportProfileState')).toBe(true);
    expect(types).not.toContain('activateCurrentEnvironment');
    expect(types).not.toContain('enterNormalMode');
  });

  it('debounces window and tab events into one profile report', async () => {
    const b = mockBrowser({ windows: 2, tabs: [{ id: 1, url: 'https://www.amazon.com/' }] });
    const { transport, envelopes } = recordingTransport();
    installBackground(b, transport);
    for (const name of ['tabs.onCreated', 'tabs.onRemoved', 'windows.onCreated', 'windows.onRemoved']) {
      b.listeners[name]![0]!({ id: 1 });
    }
    await vi.advanceTimersByTimeAsync(REPORT_DEBOUNCE_MS + 10);
    await flush();
    expect(envelopes.map((e) => e.message)).toEqual([
      { type: 'reportProfileState', windows_open: 2, amazon_tabs_open: true, site_permission_granted: true },
    ]);
  });

  it('does not listen to focus changes or tab activation at all', () => {
    const b = mockBrowser();
    installBackground(b, recordingTransport().transport);
    expect(b.listeners['windows.onFocusChanged']).toHaveLength(0);
    expect(b.listeners['tabs.onActivated']).toHaveLength(0);
    expect(b.listeners['runtime.onStartup']).toHaveLength(0);
  });

  it('answers content-script fill requests through the rebuilt path only', async () => {
    const b = mockBrowser();
    const { transport, envelopes } = recordingTransport();
    const handle = installBackground(b, transport);
    await handle.router(
      { type: 'requestLoginFill', form_action: 'https://www.amazon.com/ap/signin', fields: ['password'], route_epoch: 1 },
      contentSender(),
    );
    expect(envelopes.map((e) => e.message.type)).toEqual(['getCurrentState', 'requestLoginFill']);
    expect(envelopes[1]!.message).toMatchObject({ route_epoch: 7, frame_is_top: true });
  });

  it('never writes to the console', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m));
    const b = mockBrowser();
    const handle = installBackground(b, recordingTransport().transport);
    await handle.router({ sfe: 'native', message: { type: 'getCurrentState' } }, PAGE_SENDER);
    await handle.router({ type: 'requestLoginFill', form_action: 'https://www.amazon.com/ap/signin', fields: ['password'] }, contentSender());
    for (const s of spies) expect(s).not.toHaveBeenCalled();
    for (const s of spies) s.mockRestore();
  });
});

describe('nativeMessagingTransport', () => {
  it('calls sendNativeMessage with the host app id and the envelope', async () => {
    const b = mockBrowser();
    const t = nativeMessagingTransport(b, NATIVE_APP_ID);
    await t.send({ v: 1, message: { type: 'getCurrentState' } });
    expect(b.runtime.sendNativeMessage).toHaveBeenCalledWith(NATIVE_APP_ID, { v: 1, message: { type: 'getCurrentState' } });
  });

  it('rejects when nativeMessaging is unavailable', async () => {
    const b = mockBrowser();
    delete (b.runtime as { sendNativeMessage?: unknown }).sendNativeMessage;
    await expect(nativeMessagingTransport(b, NATIVE_APP_ID).send({ v: 1, message: { type: 'getCurrentState' } })).rejects.toThrow();
  });
});

describe('collectProfileState', () => {
  it('counts windows, queries Amazon tabs by url pattern and checks the site permission', async () => {
    const b = mockBrowser({ windows: 3, tabs: [{ id: 1 }], permission: false });
    const report = await collectProfileState(b);
    expect(report).toEqual({ windows_open: 3, amazon_tabs_open: true, site_permission_granted: false });
    expect(b.tabs!.query).toHaveBeenCalledWith({ url: ['https://www.amazon.com/*'] });
    expect(b.permissions!.contains).toHaveBeenCalledWith({ origins: ['https://www.amazon.com/*'] });
  });

  it('reports no Amazon tabs when the query is empty', async () => {
    const b = mockBrowser({ tabs: [] });
    expect((await collectProfileState(b)).amazon_tabs_open).toBe(false);
  });

  it('falls back conservatively when APIs fail', async () => {
    const b = mockBrowser();
    (b.windows!.getAll as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('x'));
    (b.tabs!.query as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('x'));
    (b.permissions!.contains as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('x'));
    expect(await collectProfileState(b)).toEqual({ windows_open: 1, amazon_tabs_open: true, site_permission_granted: false });
  });

  it('works without the windows API', async () => {
    const b = mockBrowser();
    delete (b as { windows?: unknown }).windows;
    expect((await collectProfileState(b)).windows_open).toBe(1);
  });
});
