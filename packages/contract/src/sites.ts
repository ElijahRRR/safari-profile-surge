// Amazon 站点注册表。首版只支持美国站（用户确认）。新增站点时必须同时补充扩展 manifest 的
// host_permissions 与内容脚本 matches，逐站申请权限，不扩大到所有网站。

export const SITE_CODES = ['US'] as const;
export type SiteCode = (typeof SITE_CODES)[number];

export interface SiteDefinition {
  code: SiteCode;
  label: string;
  /** 订单页、登录页所在的唯一 HTTPS 主机名。 */
  host: string;
  ordersUrl: string;
  /** 允许条件填充的登录页路径前缀（顶层页面）。 */
  signinPathPrefixes: readonly string[];
}

export const SITES: Record<SiteCode, SiteDefinition> = {
  US: {
    code: 'US',
    label: 'Amazon 美国站',
    host: 'www.amazon.com',
    ordersUrl: 'https://www.amazon.com/gp/css/order-history',
    signinPathPrefixes: ['/ap/signin', '/ap/mfa', '/ax/claim'],
  },
};

export function isSiteCode(value: unknown): value is SiteCode {
  return typeof value === 'string' && (SITE_CODES as readonly string[]).includes(value);
}

/**
 * 判断 URL 是否为该站点允许填充的登录页：必须 https、主机名完全一致（不接受相似域名或子域）、
 * 无端口、无用户信息，且路径以登录前缀开头。/ap/mfa 仅用于识别“二次验证页”，不填充。
 */
export function classifySiteUrl(site: SiteCode, rawUrl: string): 'signin' | 'mfa' | 'orders' | 'other' | 'foreign' {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return 'foreign';
  }
  const def = SITES[site];
  if (url.protocol !== 'https:' || url.hostname !== def.host || url.port !== '' || url.username !== '' || url.password !== '') {
    return 'foreign';
  }
  if (url.pathname.startsWith('/ap/mfa')) return 'mfa';
  if (def.signinPathPrefixes.some((p) => p !== '/ap/mfa' && url.pathname.startsWith(p))) return 'signin';
  if (url.pathname.startsWith('/gp/css/order-history') || url.pathname.startsWith('/your-orders')) return 'orders';
  return 'other';
}
