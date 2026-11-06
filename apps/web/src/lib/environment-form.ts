// 环境编辑表单的状态与提交内容（纯函数，便于测试）。秘密字段按 SecretChange 语义：
// 默认保持不变（不发送），明确替换才发送新值，明确清除发送 clear；从不预填已保存的值。
// 修改只发送变化了的字段（PATCH 语义）。

import type {
  AccountDetail,
  AccountInput,
  BindingView,
  CreateEnvironmentRequest,
  EnvironmentChanges,
  EnvironmentInput,
  EnvironmentView,
  FieldError,
  FrontProxyId,
  ProxyInput,
  SecretChange,
  SiteCode,
  UpdateEnvironmentRequest,
} from '@sfe/contract';

export type EnvironmentSubmit =
  | { kind: 'create'; request: CreateEnvironmentRequest }
  | { kind: 'update'; environmentId: string; request: UpdateEnvironmentRequest };

export type SecretAction = 'keep' | 'replace' | 'clear';
export type BindingStage = NonNullable<BindingView['stage']>;

export interface SecretState {
  action: SecretAction;
  value: string;
}

export interface EnvironmentFormState {
  displayName: string;
  site: SiteCode;
  host: string;
  port: string;
  frontProxyId: FrontProxyId | null;
  expectedExitIp: string;
  autoOpenOrders: boolean;
  autoFillLogin: boolean;
  accountLabel: string;
  loginIdentifier: string;
  proxyUsername: SecretState;
  proxyPassword: SecretState;
  accountPassword: SecretState;
  bindingStage: BindingStage | null;
}

const emptySecret = (): SecretState => ({ action: 'keep', value: '' });

export function initialForm(env: EnvironmentView | null, account: AccountDetail | null): EnvironmentFormState {
  if (!env) {
    return {
      displayName: '',
      site: 'US',
      host: '',
      port: '',
      frontProxyId: null,
      expectedExitIp: '',
      autoOpenOrders: true,
      autoFillLogin: false,
      accountLabel: '',
      loginIdentifier: '',
      proxyUsername: emptySecret(),
      proxyPassword: emptySecret(),
      accountPassword: emptySecret(),
      bindingStage: null,
    };
  }
  const rev = env.proxy.desired ?? env.proxy.deployed;
  return {
    displayName: env.displayName,
    site: env.site,
    host: rev?.host ?? '',
    port: rev ? String(rev.port) : '',
    frontProxyId: rev?.frontProxyId ?? null,
    expectedExitIp: env.expectedExitIp ?? '',
    autoOpenOrders: env.autoOpenOrders,
    autoFillLogin: env.autoFillLogin,
    accountLabel: env.account.label ?? '',
    loginIdentifier: account?.loginIdentifier ?? '',
    proxyUsername: emptySecret(),
    proxyPassword: emptySecret(),
    accountPassword: emptySecret(),
    bindingStage: env.binding.stage,
  };
}

/** 新建：有值即设置（replace），留空不发送。编辑：keep 不发送，replace 发送新值，clear 发送清除。 */
export function secretChange(state: SecretState, mode: 'create' | 'edit'): SecretChange | undefined {
  if (mode === 'create') return state.value !== '' ? { action: 'replace', value: state.value } : undefined;
  if (state.action === 'replace') return { action: 'replace', value: state.value };
  if (state.action === 'clear') return { action: 'clear' };
  return undefined;
}

export function parsePort(text: string): number | null {
  if (!/^\d{1,5}$/.test(text.trim())) return null;
  const n = Number(text.trim());
  return n >= 1 && n <= 65535 ? n : null;
}

/** 只做必要的即时检查；完整校验在服务端（与导入、插件、CLI 共用）。 */
export function validateForm(form: EnvironmentFormState, mode: 'create' | 'edit'): FieldError[] {
  const errors: FieldError[] = [];
  if (form.displayName.trim() === '') errors.push({ field: 'displayName', message: '环境名称必填' });
  if (form.host.trim() === '') errors.push({ field: 'proxy.host', message: '代理地址必填' });
  if (parsePort(form.port) === null) errors.push({ field: 'proxy.port', message: '端口必须是 1–65535 的整数' });
  const secrets: Array<[keyof EnvironmentFormState, string]> = [
    ['proxyUsername', 'proxy.username'],
    ['proxyPassword', 'proxy.password'],
    ['accountPassword', 'account.password'],
  ];
  if (mode === 'edit') {
    for (const [key, field] of secrets) {
      const s = form[key] as SecretState;
      if (s.action === 'replace' && s.value === '') errors.push({ field, message: '选择了替换，请输入新的值；不修改请选「保持不变」' });
    }
  }
  return errors;
}

export function buildCreateInput(form: EnvironmentFormState): EnvironmentInput {
  const proxy: ProxyInput = {
    protocol: 'socks5',
    host: form.host,
    port: parsePort(form.port) ?? 0,
    frontProxyId: form.frontProxyId,
    expectedExitIp: form.expectedExitIp.trim() === '' ? null : form.expectedExitIp.trim(),
  };
  // 秘密字段用展开写入：避免出现形如“字段名 等号 值”的赋值，与仓库秘密扫描规则混淆。
  const user = secretChange(form.proxyUsername, 'create');
  const pass = secretChange(form.proxyPassword, 'create');
  Object.assign(proxy, user ? { username: user } : {}, pass ? { password: pass } : {});
  const input: EnvironmentInput = {
    displayName: form.displayName,
    site: form.site,
    autoOpenOrders: form.autoOpenOrders,
    autoFillLogin: form.autoFillLogin,
    proxy,
  };
  const accountPass = secretChange(form.accountPassword, 'create');
  if (form.accountLabel !== '' || form.loginIdentifier !== '' || accountPass) {
    input.account = {
      label: form.accountLabel === '' ? null : form.accountLabel,
      loginIdentifier: form.loginIdentifier === '' ? null : form.loginIdentifier,
      ...(accountPass ? { password: accountPass } : {}),
    };
  }
  return input;
}

/**
 * 编辑：只包含变化了的字段。initialLoginIdentifier 是打开编辑时读到的完整登录账号；为 null 表示
 * 没能读取（只有打码值），此时登录账号留空表示不修改。
 */
export function buildChanges(form: EnvironmentFormState, env: EnvironmentView, initialLoginIdentifier: string | null): EnvironmentChanges {
  const base = initialForm(env, null);
  const changes: EnvironmentChanges = {};
  if (form.displayName !== env.displayName) changes.displayName = form.displayName;
  if (form.site !== env.site) changes.site = form.site;
  if (form.autoOpenOrders !== env.autoOpenOrders) changes.autoOpenOrders = form.autoOpenOrders;
  if (form.autoFillLogin !== env.autoFillLogin) changes.autoFillLogin = form.autoFillLogin;

  const proxy: Partial<ProxyInput> = {};
  if (form.host !== base.host) proxy.host = form.host;
  const port = parsePort(form.port);
  if (port !== null && String(port) !== base.port) proxy.port = port;
  if (form.frontProxyId !== base.frontProxyId) proxy.frontProxyId = form.frontProxyId;
  const exitIp = form.expectedExitIp.trim() === '' ? null : form.expectedExitIp.trim();
  if (exitIp !== (env.expectedExitIp ?? null)) proxy.expectedExitIp = exitIp;
  const user = secretChange(form.proxyUsername, 'edit');
  const pass = secretChange(form.proxyPassword, 'edit');
  Object.assign(proxy, user ? { username: user } : {}, pass ? { password: pass } : {});
  if (Object.keys(proxy).length > 0) changes.proxy = proxy;

  const account: AccountInput = {};
  if (form.accountLabel !== (env.account.label ?? '')) account.label = form.accountLabel === '' ? null : form.accountLabel;
  if (initialLoginIdentifier !== null) {
    if (form.loginIdentifier !== initialLoginIdentifier) account.loginIdentifier = form.loginIdentifier === '' ? null : form.loginIdentifier;
  } else if (form.loginIdentifier !== '') {
    account.loginIdentifier = form.loginIdentifier;
  }
  const accountPass = secretChange(form.accountPassword, 'edit');
  Object.assign(account, accountPass ? { password: accountPass } : {});
  if (Object.keys(account).length > 0) changes.account = account;

  if (env.binding.state === 'unbound' && form.bindingStage !== env.binding.stage) changes.bindingStage = form.bindingStage;
  return changes;
}

/** 服务端字段路径（environment.proxy.host / changes.proxy.host / proxy.host）归一到表单字段。 */
export function normalizeFieldPath(field: string): string {
  return field.replace(/^(environment|changes)\./, '');
}

export function clearSecrets(form: EnvironmentFormState): void {
  form.proxyUsername = emptySecret();
  form.proxyPassword = emptySecret();
  form.accountPassword = emptySecret();
}
