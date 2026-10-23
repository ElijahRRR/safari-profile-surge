import { afterEach, describe, expect, it } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import EnvironmentEditDialog from '../src/components/EnvironmentEditDialog.vue';
import type { EnvironmentSubmit } from '../src/lib/environment-form';
import { buildChanges, initialForm } from '../src/lib/environment-form';
import { environment, snapshot } from './fixtures';

let wrapper: VueWrapper | null = null;
afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  document.body.innerHTML = '';
});

const fronts = snapshot().frontProxies;

async function open(mode: 'create' | 'edit', env = environment(), account: { loginIdentifier: string | null } | null = { loginIdentifier: 'buyer01@example.test' }) {
  wrapper = mount(EnvironmentEditDialog, {
    attachTo: document.body,
    props: {
      show: true,
      mode,
      environment: mode === 'edit' ? env : null,
      account: account ? { environment_id: env.id, label: env.account.label, loginIdentifier: account.loginIdentifier, hasPassword: true } : null,
      frontProxies: fronts,
      defaultFrontProxyId: 'front_1',
      requestId: 'web-req-fixed',
    },
  });
  await nextTick();
  return wrapper;
}

function input(selector: string): HTMLInputElement {
  const el = document.body.querySelector<HTMLInputElement>(selector);
  if (!el) throw new Error(`missing ${selector}`);
  return el;
}

async function type(el: HTMLInputElement, value: string) {
  el.value = value;
  el.dispatchEvent(new Event('input'));
  await nextTick();
}

function secret(label: string): HTMLElement {
  const el = document.body.querySelector<HTMLElement>(`[data-secret="${label}"]`);
  if (!el) throw new Error(`missing secret ${label}`);
  return el;
}

async function chooseAction(label: string, action: 'keep' | 'replace' | 'clear') {
  secret(label).querySelector<HTMLButtonElement>(`[data-action="${action}"]`)!.click();
  await nextTick();
}

async function save() {
  input('[data-test="env-save"]').click();
  await nextTick();
}

function submitted(): EnvironmentSubmit[] {
  return (wrapper!.emitted('submit') ?? []).map((args) => args[0] as EnvironmentSubmit);
}

describe('EnvironmentEditDialog (edit)', () => {
  it('keeps every secret by default: no secret fields are sent and none are prefilled', async () => {
    await open('edit');
    expect(document.body.querySelectorAll('input[type="password"]')).toHaveLength(0);
    for (const label of ['代理用户名', '代理密码', '账号密码']) {
      expect(secret(label).querySelector('[data-action="keep"]')?.getAttribute('aria-checked')).toBe('true');
      expect(secret(label).textContent).toContain('已配置');
    }
    await type(input('[data-field="displayName"] input'), 'US-买家01-新');
    await save();
    const [payload] = submitted();
    expect(payload).toEqual({
      kind: 'update',
      environmentId: 'env_1',
      request: { request_id: 'web-req-fixed', expected_revision: 3, changes: { displayName: 'US-买家01-新' } },
    });
  });

  it('says where the account password is kept: the local service data, in plain text, owner-only (no Keychain)', async () => {
    await open('edit');
    expect(secret('账号密码').textContent).toContain('保存在本机后台的资料中（明文，仅本机用户可读）；网页与日志从不显示。');
    expect(document.body.textContent).not.toContain('钥匙串');
  });

  it('sends replace with the typed value only when 替换 is chosen', async () => {
    await open('edit');
    await chooseAction('代理密码', 'replace');
    const pw = secret('代理密码').querySelector<HTMLInputElement>('input')!;
    expect(pw.type).toBe('password');
    expect(pw.value).toBe('');
    await type(pw, 'n3w-Pass_word');
    await save();
    const p = submitted()[0]!;
    expect(p.kind).toBe('update');
    if (p.kind === 'update') {
      expect(p.request.changes).toEqual({ proxy: { password: { action: 'replace', value: 'n3w-Pass_word' } } });
    }
  });

  it('sends clear for 清除 and nothing else', async () => {
    await open('edit');
    await chooseAction('账号密码', 'clear');
    expect(secret('账号密码').querySelector('input')).toBeNull();
    await save();
    const p = submitted()[0]!;
    if (p.kind !== 'update') throw new Error('expected update');
    expect(p.request.changes).toEqual({ account: { password: { action: 'clear' } } });
  });

  it('switching back to 保持不变 discards the typed value', async () => {
    await open('edit');
    await chooseAction('代理用户名', 'replace');
    await type(secret('代理用户名').querySelector<HTMLInputElement>('input')!, 'user-x');
    await chooseAction('代理用户名', 'keep');
    await type(input('[data-field="port"] input'), '1081');
    await save();
    const p = submitted()[0]!;
    if (p.kind !== 'update') throw new Error('expected update');
    expect(p.request.changes).toEqual({ proxy: { port: 1081 } });
    expect(JSON.stringify(p)).not.toContain('user-x');
  });

  it('refuses 替换 with an empty value', async () => {
    await open('edit');
    await chooseAction('代理密码', 'replace');
    await save();
    expect(submitted()).toHaveLength(0);
    expect(secret('代理密码').textContent).toContain('请输入新的值');
  });

  it('cannot clear a secret that is not configured', async () => {
    const env = environment({ proxy: { desired: { ...environment().proxy.desired!, hasUsername: false }, deployed: null, active: null, lastVerified: null } });
    await open('edit', env);
    const clear = secret('代理用户名').querySelector<HTMLButtonElement>('[data-action="clear"]')!;
    expect(clear.disabled).toBe(true);
    expect(secret('代理用户名').textContent).toContain('未配置');
  });

  it('reports 没有需要保存的修改 instead of sending an empty PATCH', async () => {
    await open('edit');
    await save();
    expect(submitted()).toHaveLength(0);
    expect(document.body.textContent).toContain('没有需要保存的修改');
  });

  it('sends expected exit IP and options as their own fields', async () => {
    await open('edit');
    await type(input('[data-field="expectedExitIp"] input'), '192.0.2.44');
    const auto = input('[data-field="autoFillLogin"]');
    auto.click();
    await nextTick();
    await save();
    const p = submitted()[0]!;
    if (p.kind !== 'update') throw new Error('expected update');
    expect(p.request.changes).toEqual({ autoFillLogin: true, proxy: { expectedExitIp: '192.0.2.44' } });
  });

  it('can set the first-association stage for an unbound environment', async () => {
    const env = environment({ binding: { state: 'unbound', stage: null, profileIdShort: null, boundAt: null, sitePermissionGranted: null } });
    await open('edit', env);
    const stageTrigger = Array.from(document.body.querySelectorAll<HTMLButtonElement>('.select-trigger')).find((b) =>
      b.closest('div')?.parentElement?.textContent?.includes('关联进度'),
    )!;
    stageTrigger.click();
    await nextTick();
    const option = Array.from(document.body.querySelectorAll<HTMLElement>('[role="option"]')).find((o) => o.textContent?.includes('等待启用扩展并授权'))!;
    option.click();
    await nextTick();
    await save();
    const p = submitted()[0]!;
    if (p.kind !== 'update') throw new Error('expected update');
    expect(p.request.changes).toEqual({ bindingStage: 'awaiting_extension' });
  });

  it('shows server field errors next to the field', async () => {
    await open('edit');
    await wrapper!.setProps({ serverErrors: [{ field: 'changes.proxy.host', message: '代理地址不是有效的 IP 或域名' }] });
    expect(document.body.querySelector('[data-field="host"]')?.textContent).toContain('代理地址不是有效的 IP 或域名');
  });

  it('clears typed secrets when the dialog closes', async () => {
    await open('edit');
    await chooseAction('代理密码', 'replace');
    await type(secret('代理密码').querySelector<HTMLInputElement>('input')!, 'temp-secret');
    await wrapper!.setProps({ show: false });
    await wrapper!.setProps({ show: true });
    await nextTick();
    expect(secret('代理密码').querySelector('[data-action="keep"]')?.getAttribute('aria-checked')).toBe('true');
    expect(document.body.innerHTML).not.toContain('temp-secret');
  });
});

describe('EnvironmentEditDialog (create)', () => {
  it('sends secrets as replace when filled and omits them when empty', async () => {
    await open('create');
    await type(input('[data-field="displayName"] input'), 'US-买家09');
    await type(input('[data-field="host"] input'), '198.51.100.20');
    await type(input('[data-field="port"] input'), '1080');
    await type(secret('代理用户名').querySelector<HTMLInputElement>('input')!, 'user09');
    await save();
    const p = submitted()[0]!;
    expect(p.kind).toBe('create');
    if (p.kind !== 'create') return;
    expect(p.request.request_id).toBe('web-req-fixed');
    expect(p.request.environment).toEqual({
      displayName: 'US-买家09',
      site: 'US',
      autoOpenOrders: true,
      autoFillLogin: false,
      proxy: { protocol: 'socks5', host: '198.51.100.20', port: 1080, frontProxyId: null, expectedExitIp: null, username: { action: 'replace', value: 'user09' } },
    });
  });

  it('validates required fields before sending', async () => {
    await open('create');
    await type(input('[data-field="port"] input'), '70000');
    await save();
    expect(submitted()).toHaveLength(0);
    expect(document.body.textContent).toContain('环境名称必填');
    expect(document.body.textContent).toContain('端口必须是 1–65535 的整数');
  });
});

describe('buildChanges', () => {
  it('without a readable login identifier, an empty field means unchanged', () => {
    const env = environment();
    const form = initialForm(env, null);
    expect(buildChanges(form, env, null)).toEqual({});
    form.loginIdentifier = 'buyer99@example.test';
    expect(buildChanges(form, env, null)).toEqual({ account: { loginIdentifier: 'buyer99@example.test' } });
  });

  it('with a readable login identifier, clearing it sends null', () => {
    const env = environment();
    const form = initialForm(env, { environment_id: env.id, label: null, loginIdentifier: 'buyer01@example.test', hasPassword: true });
    form.loginIdentifier = '';
    expect(buildChanges(form, env, 'buyer01@example.test')).toEqual({ account: { loginIdentifier: null } });
  });
});
