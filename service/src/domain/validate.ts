// 输入校验（导入、网页、插件、CLI 共用）。返回字段错误列表，不抛异常；消息为简体中文。
// 凭据可表达性规则与 surge/generate.ts 的序列化共用同一正则，避免两处规则漂移。

import { isIP } from 'node:net';
import { isSiteCode, type EnvironmentChanges, type EnvironmentInput, type FieldError, type SecretChange } from '@sfe/contract';

/**
 * 当前 Surge 节点行中可以安全表达的代理用户名/密码字符。先只允许字母、数字和 `. _ ~ -`：
 * 其他符号在 6.5 节点行中是否会被当作分隔符、注释或转义尚未实测。P0 的凭据字符夹具
 * （tools/p0）逐个证明安全后，才在这里放宽（见 docs/ARCHITECTURE.md §5.4）。
 */
export const SURGE_SAFE_CREDENTIAL_RE = /^[A-Za-z0-9._~-]{1,128}$/;

/** Surge 中可被 underlying-proxy 引用的已有节点名：不得含逗号、等号、引号、换行或前后空白。 */
const SURGE_REF_NAME_RE = /^[^,="\r\n#;]{1,128}$/;

const HOSTNAME_RE = /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
// 控制字符（含换行、制表、DEL）；用于展示名、账号等自由文本。
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

export const LIMITS = {
  displayName: 64,
  accountLabel: 64,
  loginIdentifier: 254,
  accountPassword: 256,
} as const;

export function isSurgeSafeCredential(value: string): boolean {
  return SURGE_SAFE_CREDENTIAL_RE.test(value);
}

export function isSurgeReferenceName(value: string): boolean {
  return SURGE_REF_NAME_RE.test(value) && value.trim() === value && value.length > 0;
}

/** 代理连接地址：IPv4、IPv6（不带方括号）或至少两段的域名。 */
export function validateHost(host: unknown, field = 'proxy.host'): FieldError[] {
  if (typeof host !== 'string' || host.length === 0) return [{ field, message: '代理地址必填' }];
  if (host.trim() !== host) return [{ field, message: '代理地址前后不能有空格' }];
  if (isIP(host) !== 0) {
    return [];
  }
  if (host.startsWith('[') || host.includes(':')) return [{ field, message: 'IPv6 地址请不要带方括号或端口' }];
  if (!HOSTNAME_RE.test(host)) return [{ field, message: '代理地址不是有效的 IP 或域名' }];
  return [];
}

export function validatePort(port: unknown, field = 'proxy.port'): FieldError[] {
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    return [{ field, message: '端口必须是 1–65535 的整数' }];
  }
  return [];
}

export function validateIp(value: unknown, field: string): FieldError[] {
  if (value === null || value === undefined || value === '') return [];
  if (typeof value !== 'string' || isIP(value) === 0) return [{ field, message: '不是有效的 IP 地址' }];
  return [];
}

function validateText(value: unknown, field: string, label: string, max: number, required: boolean): FieldError[] {
  if (value === null || value === undefined || value === '') {
    return required ? [{ field, message: `${label}必填` }] : [];
  }
  if (typeof value !== 'string') return [{ field, message: `${label}格式不正确` }];
  if (value.trim() !== value) return [{ field, message: `${label}前后不能有空格` }];
  if (CONTROL_RE.test(value)) return [{ field, message: `${label}不能包含换行或控制字符` }];
  if ([...value].length > max) return [{ field, message: `${label}不能超过 ${max} 个字符` }];
  return [];
}

export function validateDisplayName(value: unknown, field = 'displayName'): FieldError[] {
  return validateText(value, field, '环境名称', LIMITS.displayName, true);
}

function validateSecretChange(
  change: SecretChange | undefined,
  field: string,
  kind: 'proxy' | 'account',
): FieldError[] {
  if (change === undefined) return [];
  if (typeof change !== 'object' || change === null) return [{ field, message: '修改方式不正确' }];
  if (change.action === 'keep' || change.action === 'clear') return [];
  if (change.action !== 'replace' || typeof change.value !== 'string') return [{ field, message: '修改方式不正确' }];
  if (kind === 'proxy') {
    if (!isSurgeSafeCredential(change.value)) {
      return [{ field, message: '只能包含字母、数字和 . _ ~ -：其他字符在当前 Surge 节点语法中尚未证明可安全表达，请更换凭据' }];
    }
    return [];
  }
  if (change.value.length === 0 || change.value.length > LIMITS.accountPassword || CONTROL_RE.test(change.value)) {
    return [{ field, message: `密码长度需为 1–${LIMITS.accountPassword}，且不能包含控制字符` }];
  }
  return [];
}

export function validateEnvironmentInput(input: EnvironmentInput, prefix = ''): FieldError[] {
  const p = (f: string) => `${prefix}${f}`;
  const errors: FieldError[] = [];
  if (typeof input !== 'object' || input === null) return [{ field: p('environment'), message: '缺少环境数据' }];
  errors.push(...validateDisplayName(input.displayName, p('displayName')));
  if (!isSiteCode(input.site)) errors.push({ field: p('site'), message: '站点必须明确选择（首版只支持 Amazon 美国站）' });
  for (const key of ['autoOpenOrders', 'autoFillLogin'] as const) {
    if (input[key] !== undefined && typeof input[key] !== 'boolean') errors.push({ field: p(key), message: '只能是开或关' });
  }
  const proxy = input.proxy;
  if (typeof proxy !== 'object' || proxy === null) {
    errors.push({ field: p('proxy'), message: '代理必填' });
  } else {
    if (proxy.protocol !== 'socks5') errors.push({ field: p('proxy.protocol'), message: '首版只支持 SOCKS5' });
    errors.push(...validateHost(proxy.host, p('proxy.host')));
    errors.push(...validatePort(proxy.port, p('proxy.port')));
    errors.push(...validateSecretChange(proxy.username, p('proxy.username'), 'proxy'));
    errors.push(...validateSecretChange(proxy.password, p('proxy.password'), 'proxy'));
    if (proxy.frontProxyId !== null && typeof proxy.frontProxyId !== 'string') {
      errors.push({ field: p('proxy.frontProxyId'), message: '前置代理引用不正确' });
    }
    errors.push(...validateIp(proxy.expectedExitIp, p('proxy.expectedExitIp')));
  }
  if (input.account !== undefined) errors.push(...validateAccount(input.account, p('account')));
  return errors;
}

export function validateAccount(account: NonNullable<EnvironmentInput['account']>, prefix: string): FieldError[] {
  const errors: FieldError[] = [];
  errors.push(...validateText(account.label, `${prefix}.label`, '买家号备注', LIMITS.accountLabel, false));
  errors.push(...validateText(account.loginIdentifier, `${prefix}.loginIdentifier`, '登录账号', LIMITS.loginIdentifier, false));
  errors.push(...validateSecretChange(account.password, `${prefix}.password`, 'account'));
  return errors;
}

export function validateEnvironmentChanges(changes: EnvironmentChanges): FieldError[] {
  const errors: FieldError[] = [];
  if (typeof changes !== 'object' || changes === null) return [{ field: 'changes', message: '缺少修改内容' }];
  if (changes.displayName !== undefined) errors.push(...validateDisplayName(changes.displayName));
  if (changes.site !== undefined && !isSiteCode(changes.site)) errors.push({ field: 'site', message: '站点不受支持' });
  for (const key of ['autoOpenOrders', 'autoFillLogin'] as const) {
    if (changes[key] !== undefined && typeof changes[key] !== 'boolean') errors.push({ field: key, message: '只能是开或关' });
  }
  const proxy = changes.proxy;
  if (proxy !== undefined) {
    if (proxy.protocol !== undefined && proxy.protocol !== 'socks5') errors.push({ field: 'proxy.protocol', message: '首版只支持 SOCKS5' });
    if (proxy.host !== undefined) errors.push(...validateHost(proxy.host));
    if (proxy.port !== undefined) errors.push(...validatePort(proxy.port));
    errors.push(...validateSecretChange(proxy.username, 'proxy.username', 'proxy'));
    errors.push(...validateSecretChange(proxy.password, 'proxy.password', 'proxy'));
    if (proxy.frontProxyId !== undefined && proxy.frontProxyId !== null && typeof proxy.frontProxyId !== 'string') {
      errors.push({ field: 'proxy.frontProxyId', message: '前置代理引用不正确' });
    }
    if (proxy.expectedExitIp !== undefined) errors.push(...validateIp(proxy.expectedExitIp, 'proxy.expectedExitIp'));
  }
  if (changes.account !== undefined) errors.push(...validateAccount(changes.account, 'account'));
  if (Object.keys(changes).length === 0) errors.push({ field: 'changes', message: '没有需要保存的修改' });
  return errors;
}
