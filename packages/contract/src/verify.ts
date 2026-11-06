// Safari 出口检测服务。地址在构建时固定，并写入扩展 host_permissions 与 VERIFY_ONLY 规则；
// 不允许自由填写（防止把 Amazon 放进检测白名单，或由不可信服务伪造出口）。
// 检测请求只带一次性测试编号，不发送 Amazon URL、买家号或密码。

import type { VerifyEndpoint } from './models.js';

export const VERIFY_ENDPOINTS: readonly VerifyEndpoint[] = [
  { id: 'ipify', url: 'https://api.ipify.org/?format=json', host: 'api.ipify.org', label: 'ipify（IPv4）' },
  { id: 'ipify64', url: 'https://api64.ipify.org/?format=json', host: 'api64.ipify.org', label: 'ipify（IPv4/IPv6）' },
];

export const DEFAULT_VERIFY_ENDPOINT_ID = 'ipify';

export function verifyEndpointById(id: string): VerifyEndpoint | null {
  return VERIFY_ENDPOINTS.find((e) => e.id === id) ?? null;
}

/** 构造带一次性测试编号的检测地址。编号只用于浏览器侧记录；不开 MITM 时 Surge 看不到它。 */
export function buildVerifyUrl(endpoint: VerifyEndpoint, testId: string): string {
  const url = new URL(endpoint.url);
  url.searchParams.set('sfe_test', testId);
  return url.toString();
}
