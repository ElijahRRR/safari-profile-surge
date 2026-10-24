import { describe, expect, it, vi } from 'vitest';
import type { NativeRequest, NativeResponse } from '@sfe/contract';
import { classifySender, createRouter, type RouterDeps } from '../src/background/router';
import type { NativeClient } from '../src/shared/native';
import { PAGE_SENDER, PROFILE_STATE, contentSender, currentState, environment, ok } from './fixtures';

function setup(state = currentState(), fillReply: NativeResponse<unknown> = ok({ fills: [] })) {
  const sent: NativeRequest[] = [];
  const native: NativeClient = {
    call: vi.fn(async (message: NativeRequest) => {
      sent.push(message);
      if (message.type === 'getCurrentState') return ok(state);
      if (message.type === 'requestLoginFill') return fillReply;
      return ok({ forwarded: message.type });
    }) as unknown as NativeClient['call'],
  };
  const deps: RouterDeps = {
    runtimeId: 'ext-id-1',
    extensionBaseUrl: 'safari-web-extension://ext-uuid/',
    native,
    collectProfileState: vi.fn(async () => PROFILE_STATE),
  };
  return { router: createRouter(deps), sent, deps };
}

const FILL = { type: 'requestLoginFill', form_action: 'https://www.amazon.com/ap/signin', fields: ['identifier', 'password'] };

describe('sender classification', () => {
  const deps = { runtimeId: 'ext-id-1', extensionBaseUrl: 'safari-web-extension://ext-uuid/' };
  it('extension pages by url prefix', () => {
    expect(classifySender(PAGE_SENDER, deps)).toBe('extension_page');
  });
  it('content scripts by own id with a web url', () => {
    expect(classifySender(contentSender(), deps)).toBe('content_script');
  });
  it('foreign when id is missing or different', () => {
    expect(classifySender({ url: PAGE_SENDER.url }, deps)).toBe('foreign');
    expect(classifySender({ ...PAGE_SENDER, id: 'other' }, deps)).toBe('foreign');
    expect(classifySender(undefined, deps)).toBe('foreign');
  });
  it('a web page whose url merely contains the extension url is not an extension page', () => {
    expect(classifySender({ id: 'ext-id-1', url: 'https://www.amazon.com/?x=safari-web-extension://ext-uuid/' }, deps)).toBe('content_script');
  });
});

describe('extension pages', () => {
  it('may forward activation, normal mode and other native requests', async () => {
    const { router, sent } = setup();
    for (const message of [
      { type: 'getCurrentState' },
      { type: 'activateCurrentEnvironment', request_id: 'r1', environment_id: 'env_1', amazon_tabs_open: false },
      { type: 'enterNormalMode', request_id: 'r2' },
      { type: 'getOperation', operation_id: 'op_1' },
    ]) {
      const r = await router({ sfe: 'native', message }, PAGE_SENDER);
      expect(r.ok).toBe(true);
    }
    expect(sent.map((m) => m.type)).toEqual(['getCurrentState', 'activateCurrentEnvironment', 'enterNormalMode', 'getOperation']);
  });

  it('rejects unknown request types', async () => {
    const { router, sent } = setup();
    const r = await router({ sfe: 'native', message: { type: 'switchProfile' } }, PAGE_SENDER);
    expect(r.ok).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('cannot send requestLoginFill directly (only the content path rebuilds it)', async () => {
    const { router, sent } = setup();
    const r = await router({ sfe: 'native', message: { ...FILL, top_url: 'https://www.amazon.com/ap/signin', frame_is_top: true, route_epoch: 7 } }, PAGE_SENDER);
    expect(r.ok).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('profileState with report sends reportProfileState and returns the report', async () => {
    const { router, sent } = setup();
    const r = await router({ sfe: 'profileState', report: true }, PAGE_SENDER);
    expect(r).toEqual({ ok: true, data: PROFILE_STATE });
    expect(sent).toEqual([{ type: 'reportProfileState', ...PROFILE_STATE }]);
  });

  it('profileState without report sends nothing native', async () => {
    const { router, sent } = setup();
    await router({ sfe: 'profileState', report: false }, PAGE_SENDER);
    expect(sent).toHaveLength(0);
  });

  it('rejects malformed messages', async () => {
    const { router } = setup();
    expect((await router('hello', PAGE_SENDER)).ok).toBe(false);
    expect((await router({ sfe: 'other' }, PAGE_SENDER)).ok).toBe(false);
  });
});

describe('content scripts', () => {
  it('may send only requestLoginFill', async () => {
    const { router, sent } = setup();
    for (const message of [
      { type: 'activateCurrentEnvironment', request_id: 'r', environment_id: 'env_1', amazon_tabs_open: false },
      { type: 'enterNormalMode', request_id: 'r' },
      { type: 'getCurrentState' },
      { sfe: 'native', message: { type: 'getCurrentState' } },
      { sfe: 'profileState', report: true },
    ]) {
      const r = await router(message, contentSender());
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('FORBIDDEN_ORIGIN');
    }
    expect(sent).toHaveLength(0);
  });

  it('rebuilds top_url, frame_is_top and route_epoch from sender and a fresh state', async () => {
    const { router, sent } = setup();
    const url = 'https://www.amazon.com/ap/signin?openid.return_to=x';
    const r = await router(
      { ...FILL, top_url: 'https://evil.invalid/', frame_is_top: true, route_epoch: 999, extra: 'ignored' },
      contentSender(url),
    );
    expect(r.ok).toBe(true);
    expect(sent.map((m) => m.type)).toEqual(['getCurrentState', 'requestLoginFill']);
    expect(sent[1]).toEqual({
      type: 'requestLoginFill',
      top_url: url,
      frame_is_top: true,
      form_action: 'https://www.amazon.com/ap/signin',
      fields: ['identifier', 'password'],
      route_epoch: 7,
    });
  });

  it('uses sender.url when Safari does not provide sender.tab', async () => {
    const { router, sent } = setup();
    const url = 'https://www.amazon.com/ax/claim/intent';
    const r = await router(FILL, { id: 'ext-id-1', url, frameId: 0 });
    expect(r.ok).toBe(true);
    expect(sent[1]).toMatchObject({ top_url: url, frame_is_top: true });
  });

  it('returns the fill values from the native bridge unchanged', async () => {
    const reply = ok({ fills: [{ field: 'identifier', value: 'buyer01@example.test' }] });
    const { router } = setup(currentState(), reply);
    expect(await router(FILL, contentSender())).toEqual(reply);
  });

  it('refuses sub-frames', async () => {
    const { router, sent } = setup();
    const r = await router(FILL, contentSender(undefined, 3));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.details?.reason).toBe('not_top_frame');
    expect(sent).toHaveLength(0);
  });

  it('refuses when Safari does not provide frameId', async () => {
    const { router, sent } = setup();
    const r = await router(FILL, { id: 'ext-id-1', url: 'https://www.amazon.com/ap/signin', tab: { url: 'https://www.amazon.com/ap/signin' } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.details?.reason).toBe('missing_sender');
    expect(sent).toHaveLength(0);
  });

  it('refuses when Safari provides neither tab url nor sender url', async () => {
    const { router, sent } = setup();
    const r = await router(FILL, { id: 'ext-id-1', frameId: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.details?.reason).toBe('missing_sender');
    expect(sent).toHaveLength(0);
  });

  it('refuses when sender id is missing', async () => {
    const { router, sent } = setup();
    const r = await router(FILL, { url: 'https://www.amazon.com/ap/signin', frameId: 0 });
    expect(r.ok).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it.each([
    ['look-alike host', 'https://www.amazon.com.example.invalid/ap/signin'],
    ['subdomain', 'https://smile.amazon.com/ap/signin'],
    ['plain http', 'http://www.amazon.com/ap/signin'],
    ['explicit port', 'https://www.amazon.com:8443/ap/signin'],
    ['mfa page', 'https://www.amazon.com/ap/mfa?x=1'],
    ['orders page', 'https://www.amazon.com/gp/css/order-history'],
  ])('refuses foreign or non-signin top url (%s)', async (_label, url) => {
    const { router, sent } = setup();
    const r = await router(FILL, contentSender(url));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.details?.reason).toBe('not_signin');
    expect(sent.map((m) => m.type)).toEqual(['getCurrentState']);
  });

  it('refuses when the tab url and the frame url disagree', async () => {
    const { router, sent } = setup();
    const r = await router(FILL, {
      id: 'ext-id-1',
      frameId: 0,
      url: 'https://www.amazon.com/gp/css/order-history',
      tab: { url: 'https://www.amazon.com/ap/signin' },
    });
    expect(r.ok).toBe(false);
    expect(sent.map((m) => m.type)).toEqual(['getCurrentState']);
  });

  it('refuses a form action outside the site', async () => {
    const { router, sent } = setup();
    const r = await router({ ...FILL, form_action: 'https://collector.example.invalid/steal' }, contentSender());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.details?.reason).toBe('bad_form_action');
    expect(sent.map((m) => m.type)).toEqual(['getCurrentState']);
  });

  it('refuses a missing form action without asking the service', async () => {
    const { router, sent } = setup();
    const r = await router({ ...FILL, form_action: null }, contentSender());
    expect(r.ok).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it.each([[[]], [['identifier', 'identifier']], [['token']], ['password']])('refuses bad field lists %j', async (fields) => {
    const { router, sent } = setup();
    const r = await router({ ...FILL, fields }, contentSender());
    expect(r.ok).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('refuses when the profile is not bound', async () => {
    const { router, sent } = setup(currentState({ environment: null, route: null, relation: 'none_active' }));
    const r = await router(FILL, contentSender());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.details?.reason).toBe('unbound');
    expect(sent.map((m) => m.type)).toEqual(['getCurrentState']);
  });

  it('refuses when route is null (not the active environment)', async () => {
    const { router, sent } = setup(currentState({ route: null, relation: 'other_active' }));
    const r = await router(FILL, contentSender());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.details?.reason).toBe('not_active');
    expect(sent.map((m) => m.type)).toEqual(['getCurrentState']);
  });

  it('refuses when the environment has autofill turned off', async () => {
    const { router, sent } = setup(currentState({ environment: environment({ autoFillLogin: false }) }));
    const r = await router(FILL, contentSender());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.details?.reason).toBe('autofill_off');
    expect(sent.map((m) => m.type)).toEqual(['getCurrentState']);
  });

  it('passes through a getCurrentState failure', async () => {
    const native: NativeClient = {
      call: vi.fn(async () => ({ ok: false, error: { code: 'INTERNAL', message: '连接本机服务失败' } })) as unknown as NativeClient['call'],
    };
    const router = createRouter({ runtimeId: 'ext-id-1', extensionBaseUrl: 'safari-web-extension://ext-uuid/', native, collectProfileState: async () => PROFILE_STATE });
    const r = await router(FILL, contentSender());
    expect(r.ok).toBe(false);
    expect(native.call).toHaveBeenCalledTimes(1);
  });
});

describe('content scripts: checkLoginFill (no recognisable fields on the page)', () => {
  const CHECK = { type: 'checkLoginFill' };

  it('answers eligible for a bound, autofill-enabled, active environment on its sign-in page without requesting values', async () => {
    const { router, sent } = setup();
    expect(await router({ ...CHECK, fields: ['password'], form_action: 'https://collector.example.invalid/' }, contentSender())).toEqual({ ok: true, data: { eligible: true } });
    expect(sent.map((m) => m.type)).toEqual(['getCurrentState']);
  });

  it.each([
    ['unbound', currentState({ environment: null, route: null, relation: 'none_active' })],
    ['autofill_off', currentState({ environment: environment({ autoFillLogin: false }) })],
    ['not_active', currentState({ route: null, relation: 'other_active' })],
  ])('refuses with reason %s', async (reason, state) => {
    const { router, sent } = setup(state);
    const r = await router(CHECK, contentSender());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.details?.reason).toBe(reason);
    expect(sent.map((m) => m.type)).toEqual(['getCurrentState']);
  });

  it('refuses a non-signin page and sub-frames like requestLoginFill', async () => {
    const { router, sent } = setup();
    const page = await router(CHECK, contentSender('https://www.amazon.com/gp/css/order-history'));
    expect(page.ok).toBe(false);
    if (!page.ok) expect(page.error.details?.reason).toBe('not_signin');
    const frame = await router(CHECK, contentSender(undefined, 3));
    expect(frame.ok).toBe(false);
    if (!frame.ok) expect(frame.error.details?.reason).toBe('not_top_frame');
    expect(sent.map((m) => m.type)).toEqual(['getCurrentState']);
  });

  it('extension pages cannot use it as a native request', async () => {
    const { router, sent } = setup();
    const r = await router({ sfe: 'native', message: CHECK }, PAGE_SENDER);
    expect(r.ok).toBe(false);
    expect(sent).toHaveLength(0);
  });
});

describe('foreign senders', () => {
  it('are refused for every message', async () => {
    const { router, sent } = setup();
    const r = await router({ sfe: 'native', message: { type: 'getCurrentState' } }, { id: 'another-extension', url: 'safari-web-extension://other/popup.html' });
    expect(r.ok).toBe(false);
    expect(sent).toHaveLength(0);
  });
});
