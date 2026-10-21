// manifest.json 的唯一来源（构建时写出）。权限按 ARCHITECTURE §9：只有 nativeMessaging 与 storage，
// 不申请 tabs；站点权限只有各站点主机与固定的检测服务主机；内容脚本只匹配登录路径、只在顶层框架。

import { SITES, VERIFY_ENDPOINTS } from '@sfe/contract';

export const EXTENSION_NAME = 'Safari 场景出口';
export const EXTENSION_VERSION = '0.1.0';
export const ICON_SIZES = [16, 32, 48, 96, 128, 256, 512] as const;

export function siteHostPermissions(): string[] {
  return Object.values(SITES).map((s) => `https://${s.host}/*`);
}

export function verifyHostPermissions(): string[] {
  return [...new Set(VERIFY_ENDPOINTS.map((e) => `https://${e.host}/*`))];
}

export function contentScriptMatches(): string[] {
  return Object.values(SITES).flatMap((s) => [`https://${s.host}/ap/*`, `https://${s.host}/ax/*`]);
}

/** 扩展页面 CSP：只允许自身脚本与样式，网络只允许检测服务。 */
export function extensionPagesCsp(): string {
  const connect = ["'self'", ...new Set(VERIFY_ENDPOINTS.map((e) => `https://${e.host}`))].join(' ');
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    `connect-src ${connect}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export function buildManifest(): Record<string, unknown> {
  const icons = Object.fromEntries(ICON_SIZES.map((s) => [String(s), `icons/icon-${s}.png`]));
  return {
    manifest_version: 3,
    name: EXTENSION_NAME,
    version: EXTENSION_VERSION,
    description: '按 Safari 场景使用指定的 Surge 出口，Chrome 保持原规则。',
    icons,
    permissions: ['nativeMessaging', 'storage'],
    host_permissions: [...siteHostPermissions(), ...verifyHostPermissions()],
    background: { scripts: ['background.js'], type: 'module', persistent: false },
    content_scripts: [
      {
        matches: contentScriptMatches(),
        js: ['content.js'],
        run_at: 'document_idle',
        all_frames: false,
      },
    ],
    action: {
      default_popup: 'popup.html',
      default_title: EXTENSION_NAME,
      default_icon: { '16': 'icons/icon-16.png', '32': 'icons/icon-32.png', '48': 'icons/icon-48.png' },
    },
    content_security_policy: { extension_pages: extensionPagesCsp() },
  };
}
