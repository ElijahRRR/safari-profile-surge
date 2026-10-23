import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { detectLoginForm, newPageMemory, readFormAction, runLoginAssist, type AssistDeps } from '../src/content/fill';
import type { Panel, PanelContent } from '../src/content/panel';
import { createPanel } from '../src/content/panel';
import { createRouter } from '../src/background/router';
import { createNativeClient } from '../src/shared/native';
import { PROFILE_STATE, contentSender, currentState, ok } from './fixtures';

const SIGNIN = 'https://www.amazon.com/ap/signin?openid.return_to=x';
const ACTION = 'https://www.amazon.com/ap/signin';
const SYN_PASSWORD = 'syn-login-pass-9';
const ELIGIBLE = { ok: true, data: { eligible: true } };

function page(html: string) {
  document.body.innerHTML = html;
}

function panelSpy() {
  const shown: PanelContent[] = [];
  const panel: Panel = {
    element: document.createElement('div'),
    show: vi.fn((c: PanelContent) => shown.push(c)),
    remove: vi.fn(),
  };
  return { panel, shown };
}

function deps(over: Partial<AssistDeps> & { reply?: unknown } = {}) {
  const sent: unknown[] = [];
  const { panel, shown } = panelSpy();
  const d: AssistDeps = {
    doc: document,
    pageUrl: SIGNIN,
    sendMessage: vi.fn(async (m) => {
      sent.push(structuredClone(m));
      return over.reply ?? { ok: true, data: { fills: [] } };
    }),
    navigate: vi.fn(),
    memory: newPageMemory(),
    panel,
    waitForFieldsMs: 0,
    ...over,
  };
  return { d, sent, shown };
}

const BOTH = `
  <form id="f" action="${ACTION}" method="post">
    <input type="email" id="ap_email" name="email">
    <input type="password" id="ap_password" name="password">
    <input type="submit" id="signInSubmit" value="Sign in">
  </form>`;

let submitSpy: ReturnType<typeof vi.spyOn>;
let requestSubmitSpy: ReturnType<typeof vi.spyOn>;
let clickSpy: ReturnType<typeof vi.spyOn>;
let submitEvents: number;
const onSubmit = (e: Event) => {
  submitEvents++;
  e.preventDefault();
};

beforeEach(() => {
  submitEvents = 0;
  document.addEventListener('submit', onSubmit, true);
  submitSpy = vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(() => undefined);
  requestSubmitSpy = vi.spyOn(HTMLFormElement.prototype, 'requestSubmit').mockImplementation(() => undefined);
  clickSpy = vi.spyOn(HTMLElement.prototype, 'click');
});

afterEach(() => {
  document.removeEventListener('submit', onSubmit, true);
  submitSpy.mockRestore();
  requestSubmitSpy.mockRestore();
  clickSpy.mockRestore();
  document.body.innerHTML = '';
});

function expectNoSubmitOrClick() {
  expect(submitSpy).not.toHaveBeenCalled();
  expect(requestSubmitSpy).not.toHaveBeenCalled();
  expect(clickSpy).not.toHaveBeenCalled();
  expect(submitEvents).toBe(0);
}

describe('field detection', () => {
  it('finds both fields in one form with its action', () => {
    page(BOTH);
    const d = detectLoginForm(document);
    expect(d.kind).toBe('form');
    if (d.kind === 'form') {
      expect(Object.keys(d.inputs).sort()).toEqual(['identifier', 'password']);
      expect(d.action).toBe(ACTION);
    }
  });

  it('ignores hidden inputs', () => {
    page(`<form action="${ACTION}">
      <input type="hidden" name="email" value="x">
      <input type="email" name="email" style="display:none">
      <div hidden><input type="password" id="ap_password"></div>
      <input type="password" name="password" style="visibility:hidden">
    </form>`);
    expect(detectLoginForm(document).kind).toBe('none');
  });

  it('reports fields outside a form', () => {
    page(`<input type="password" id="ap_password">`);
    expect(detectLoginForm(document).kind).toBe('no_form');
  });

  it('reads the real form action even when a field named "action" shadows it', () => {
    page(`<form id="f" action="${ACTION}"><input name="action" value="https://collector.example.invalid/"><input type="password" id="ap_password"></form>`);
    const form = document.getElementById('f') as HTMLFormElement;
    expect(readFormAction(form)).toBe(ACTION);
  });
});

describe('runLoginAssist', () => {
  it('requests only the fields present on the page', async () => {
    page(`<form action="${ACTION}"><input type="password" id="ap_password"></form>`);
    const { d, sent } = deps({ reply: { ok: true, data: { fills: [] } } });
    await runLoginAssist(d);
    expect(sent).toEqual([{ type: 'requestLoginFill', form_action: ACTION, fields: ['password'] }]);
  });

  it('sends nothing but the three allowed keys (no top url, frame or epoch)', async () => {
    page(BOTH);
    const { d, sent } = deps();
    await runLoginAssist(d);
    expect(Object.keys(sent[0] as object).sort()).toEqual(['fields', 'form_action', 'type']);
  });

  it('fills via the native setter, fires input and change, and never submits or clicks', async () => {
    page(BOTH);
    const email = document.getElementById('ap_email') as HTMLInputElement;
    const passwordEl = document.getElementById('ap_password') as HTMLInputElement;
    const seen: string[] = [];
    for (const el of [email, passwordEl]) {
      el.addEventListener('input', () => seen.push(`input:${el.id}`));
      el.addEventListener('change', () => seen.push(`change:${el.id}`));
    }
    const { d, shown } = deps({
      reply: { ok: true, data: { fills: [{ field: 'identifier', value: 'buyer01@example.test' }, { field: 'password', value: SYN_PASSWORD }] } },
    });
    const outcome = await runLoginAssist(d);
    expect(outcome).toBe('filled');
    expect(email.value).toBe('buyer01@example.test');
    expect(passwordEl.value).toBe(SYN_PASSWORD);
    expect(seen).toEqual(['input:ap_email', 'change:ap_email', 'input:ap_password', 'change:ap_password']);
    expect(shown.at(-1)?.title).toBe('已填充账号与密码');
    expect(JSON.stringify(shown)).not.toContain(SYN_PASSWORD);
    expectNoSubmitOrClick();
  });

  it('discards the fill when form.action changes before writing', async () => {
    page(BOTH);
    const form = document.querySelector('form')!;
    const passwordEl = document.getElementById('ap_password') as HTMLInputElement;
    const { d, shown } = deps();
    d.sendMessage = vi.fn(async () => {
      form.setAttribute('action', 'https://collector.example.invalid/steal');
      return { ok: true, data: { fills: [{ field: 'password', value: SYN_PASSWORD }] } };
    });
    const outcome = await runLoginAssist(d);
    expect(outcome).toBe('discarded');
    expect(passwordEl.value).toBe('');
    expect(shown.at(-1)?.title).toBe('未自动填充');
    expectNoSubmitOrClick();
  });

  it('re-checks form.action before each value', async () => {
    page(BOTH);
    const form = document.querySelector('form')!;
    const email = document.getElementById('ap_email') as HTMLInputElement;
    const passwordEl = document.getElementById('ap_password') as HTMLInputElement;
    // 第一次写入后页面改了提交地址：第二个值必须丢弃。
    email.addEventListener('input', () => form.setAttribute('action', 'https://collector.example.invalid/'));
    const { d } = deps({ reply: { ok: true, data: { fills: [{ field: 'identifier', value: 'buyer01@example.test' }, { field: 'password', value: SYN_PASSWORD }] } } });
    expect(await runLoginAssist(d)).toBe('discarded');
    expect(passwordEl.value).toBe('');
  });

  it('fills each field at most once per page load', async () => {
    page(BOTH);
    const memory = newPageMemory();
    const first = deps({ memory, reply: { ok: true, data: { fills: [{ field: 'identifier', value: 'buyer01@example.test' }] } } });
    await runLoginAssist(first.d);
    const second = deps({ memory, reply: { ok: true, data: { fills: [{ field: 'identifier', value: 'other@example.test' }, { field: 'password', value: SYN_PASSWORD }] } } });
    await runLoginAssist(second.d);
    expect(first.sent).toHaveLength(1);
    // 两个字段都已请求过：第二次运行不再发送。
    expect(second.sent).toHaveLength(0);
    expect((document.getElementById('ap_email') as HTMLInputElement).value).toBe('buyer01@example.test');
  });

  it('ignores fill values for fields it did not request', async () => {
    page(`<form action="${ACTION}"><input type="email" id="ap_email"></form><input type="password" id="stray">`);
    const { d } = deps({ reply: { ok: true, data: { fills: [{ field: 'password', value: SYN_PASSWORD }] } } });
    await runLoginAssist(d);
    expect((document.getElementById('stray') as HTMLInputElement).value).toBe('');
  });

  it('shows the manual hint when fields are not recognised and the profile is eligible (only the eligibility check is sent)', async () => {
    page(`<form action="${ACTION}"><input type="text" name="otp"></form>`);
    const { d, sent, shown } = deps({ reply: ELIGIBLE });
    expect(await runLoginAssist(d)).toBe('manual');
    expect(sent).toEqual([{ type: 'checkLoginFill' }]);
    expect(shown[0]?.title).toBe('可手动填充');
  });

  it('shows the manual hint when fields are outside a form and the profile is eligible (no fill request)', async () => {
    page(`<input type="email" id="ap_email"><input type="password" id="ap_password">`);
    const { d, sent, shown } = deps({ reply: ELIGIBLE });
    expect(await runLoginAssist(d)).toBe('manual');
    expect(sent).toEqual([{ type: 'checkLoginFill' }]);
    expect(shown[0]?.title).toBe('可手动填充');
  });

  describe('no recognisable fields in a profile where fill does not apply', () => {
    const NO_FIELDS = `<form action="${ACTION}"><input type="text" name="otp"></form>`;
    const OUTSIDE_FORM = `<input type="email" id="ap_email"><input type="password" id="ap_password">`;
    const refusal = (reason: string) => ({ ok: false, error: { code: 'FILL_NOT_ALLOWED', message: '登录填充失败', details: { reason } } });

    it.each([
      // 未识别场景时 getCurrentState 没有环境，后台同样回答 unbound
      ['unbound or unidentified profile', refusal('unbound')],
      ['autofill turned off', refusal('autofill_off')],
      ['not the active environment', refusal('not_active')],
      ['native bridge unreachable (cannot confirm)', { ok: false, error: { code: 'SURGE_UNREACHABLE', message: '无法连接本机服务', details: { reason: 'connect_failed' } } }],
      ['background returned nothing', undefined],
    ])('stays silent: %s', async (_label, reply) => {
      for (const html of [NO_FIELDS, OUTSIDE_FORM, '']) {
        page(html);
        const sent: unknown[] = [];
        const { d, shown } = deps();
        d.sendMessage = vi.fn(async (m) => {
          sent.push(structuredClone(m));
          return reply;
        });
        expect(await runLoginAssist(d)).toBe('silent');
        expect(shown).toHaveLength(0);
        expect(sent).toEqual([{ type: 'checkLoginFill' }]);
      }
    });

    it('stays silent when the background does not answer at all', async () => {
      page(NO_FIELDS);
      const { d, shown } = deps();
      d.sendMessage = vi.fn(async () => {
        throw new Error('Could not establish connection');
      });
      expect(await runLoginAssist(d)).toBe('silent');
      expect(shown).toHaveLength(0);
    });

    it('never mounts any panel in the page', async () => {
      page(NO_FIELDS);
      const { d } = deps({ reply: refusal('unbound') });
      delete d.panel;
      expect(await runLoginAssist(d)).toBe('silent');
      expect(document.querySelector('[data-sfe-login-assist]')).toBeNull();
    });
  });

  it('does nothing at all on MFA pages', async () => {
    page(`<form action="${ACTION}"><input type="password" id="ap_password"><input name="otpCode"></form>`);
    const { d, sent, shown } = deps({ pageUrl: 'https://www.amazon.com/ap/mfa?arb=x' });
    expect(await runLoginAssist(d)).toBe('skipped');
    expect(sent).toHaveLength(0);
    expect(shown).toHaveLength(0);
  });

  it('does nothing on non-signin or foreign pages', async () => {
    page(BOTH);
    for (const url of ['https://www.amazon.com/gp/css/order-history', 'https://www.amazon.com.example.invalid/ap/signin', 'http://www.amazon.com/ap/signin']) {
      const { d, sent } = deps({ pageUrl: url });
      expect(await runLoginAssist(d)).toBe('skipped');
      expect(sent).toHaveLength(0);
    }
  });

  it('stays silent when the profile is unbound or autofill is off', async () => {
    for (const reason of ['unbound', 'autofill_off']) {
      page(BOTH);
      const { d, shown } = deps({ reply: { ok: false, error: { code: 'FILL_NOT_ALLOWED', message: '登录填充失败', details: { reason } } } });
      expect(await runLoginAssist(d)).toBe('silent');
      expect(shown).toHaveLength(0);
    }
  });

  it('shows the refusal reason and the manual hint for other refusals', async () => {
    page(BOTH);
    const { d, shown } = deps({ reply: { ok: false, error: { code: 'FILL_NOT_ALLOWED', message: '登录填充失败：路由未受控', details: { reason: 'not_controlled' } } } });
    expect(await runLoginAssist(d)).toBe('refused');
    expect(shown[0]?.detail).toContain('路由未受控');
    expect(shown[0]?.detail).toContain('可手动填充');
  });

  describe('malformed fill replies (the native bridge forwards the service reply unchanged)', () => {
    // 旧版（钥匙串）服务在替换 App 后仍在运行时的应答：密码项只有 keychainRef/expiresAt，没有 value。
    const KEYCHAIN_ERA_REPLY = {
      ok: true,
      data: {
        fills: [
          { field: 'identifier', value: 'buyer01@example.test' },
          { field: 'password', keychainRef: 'acct_0123456789abcdef', expiresAt: '2026-10-23T08:00:30.000Z' },
        ],
      },
    };

    function expectNothingFilled(shown: PanelContent[]) {
      expect((document.getElementById('ap_email') as HTMLInputElement).value).toBe('');
      expect((document.getElementById('ap_password') as HTMLInputElement).value).toBe('');
      expect(shown).toHaveLength(1);
      expect(shown[0]?.title).toBe('未自动填充');
      expect(shown[0]?.tone).toBe('warning');
      expect(shown[0]?.detail).toContain('格式不符');
      expect(shown[0]?.detail).toContain('可手动填充');
      expectNoSubmitOrClick();
    }

    it('fills nothing (not even the identifier) for a Keychain-era { keychainRef, expiresAt } password entry', async () => {
      page(BOTH);
      const { d, shown } = deps({ reply: KEYCHAIN_ERA_REPLY });
      expect(await runLoginAssist(d)).toBe('refused');
      expectNothingFilled(shown);
      expect(d.memory!.filled.size).toBe(0);
    });

    it('fills nothing for the Keychain-era reply through the real background router and native client', async () => {
      page(BOTH);
      const transport = {
        send: vi.fn(async (env: { message: { type: string } }) => {
          if (env.message.type === 'getCurrentState') return ok(currentState());
          if (env.message.type === 'requestLoginFill') return KEYCHAIN_ERA_REPLY;
          return ok({});
        }),
      };
      const router = createRouter({
        runtimeId: 'ext-id-1',
        extensionBaseUrl: 'safari-web-extension://ext-uuid/',
        native: createNativeClient(transport),
        collectProfileState: async () => PROFILE_STATE,
      });
      const { d, shown } = deps({ sendMessage: (m) => router(m, contentSender(SIGNIN)) });
      expect(await runLoginAssist(d)).toBe('refused');
      expect(transport.send.mock.calls.map(([env]) => env.message.type)).toEqual(['getCurrentState', 'requestLoginFill']);
      expectNothingFilled(shown);
    });

    it.each([
      ['a non-string value', [{ field: 'password', value: 12345 }]],
      ['a null value', [{ field: 'password', value: null }]],
      ['an empty value', [{ field: 'identifier', value: 'buyer01@example.test' }, { field: 'password', value: '' }]],
      ['an unknown field', [{ field: 'identifier', value: 'buyer01@example.test' }, { field: 'otp', value: '123456' }]],
      ['a repeated field', [{ field: 'password', value: SYN_PASSWORD }, { field: 'password', value: 'other-pass' }]],
      ['a non-object entry', [{ field: 'identifier', value: 'buyer01@example.test' }, 'password']],
      ['fills that is not an array', { password: SYN_PASSWORD }],
    ])('fills nothing when the reply has %s', async (_label, fills) => {
      page(BOTH);
      const { d, shown } = deps({ reply: { ok: true, data: { fills } } });
      expect(await runLoginAssist(d)).toBe('refused');
      expectNothingFilled(shown);
    });

    it('fills nothing when ok:true carries no data', async () => {
      page(BOTH);
      const { d, shown } = deps({ reply: { ok: true } });
      expect(await runLoginAssist(d)).toBe('refused');
      expectNothingFilled(shown);
    });
  });

  it('waits briefly for late-rendered fields', async () => {
    page('<div id="root"></div>');
    const { d, sent } = deps({ waitForFieldsMs: 2000 });
    const p = runLoginAssist(d);
    setTimeout(() => {
      document.getElementById('root')!.innerHTML = `<form action="${ACTION}"><input type="password" id="ap_password"></form>`;
    }, 10);
    await p;
    expect(sent).toEqual([{ type: 'requestLoginFill', form_action: ACTION, fields: ['password'] }]);
  });

  it('does not overwrite a field the user is typing in', async () => {
    page(BOTH);
    const passwordEl = document.getElementById('ap_password') as HTMLInputElement;
    passwordEl.focus();
    passwordEl.value = 'user-typed';
    const { d } = deps({ reply: { ok: true, data: { fills: [{ field: 'password', value: SYN_PASSWORD }] } } });
    await runLoginAssist(d);
    expect(passwordEl.value).toBe('user-typed');
  });

  it('never logs', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m));
    page(BOTH);
    const { d } = deps({ reply: { ok: true, data: { fills: [{ field: 'password', value: SYN_PASSWORD }] } } });
    await runLoginAssist(d);
    for (const s of spies) expect(s).not.toHaveBeenCalled();
    for (const s of spies) s.mockRestore();
  });
});

describe('panel', () => {
  it('mounts in a closed shadow root that page scripts cannot reach, and can be removed', () => {
    const navigate = vi.fn();
    const panel = createPanel(document, { ordersUrl: 'https://www.amazon.com/gp/css/order-history', navigate });
    panel.show({ title: '可手动填充', tone: 'info' });
    expect(document.querySelector('[data-sfe-login-assist]')).not.toBeNull();
    expect(panel.element.shadowRoot).toBeNull();
    panel.remove();
    expect(document.querySelector('[data-sfe-login-assist]')).toBeNull();
  });

  it('back button click handler navigates once', () => {
    const navigate = vi.fn();
    const attach = vi.spyOn(HTMLElement.prototype, 'attachShadow');
    const panel = createPanel(document, { ordersUrl: 'https://www.amazon.com/gp/css/order-history', navigate });
    const shadow = attach.mock.results[0]!.value as ShadowRoot;
    attach.mockRestore();
    panel.show({ title: '已填充密码', detail: '请核对后自行登录。', tone: 'success' });
    const back = Array.from(shadow.querySelectorAll('button')).find((b) => b.textContent === '返回订单')!;
    back.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    back.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith('https://www.amazon.com/gp/css/order-history');
    panel.remove();
  });
});
