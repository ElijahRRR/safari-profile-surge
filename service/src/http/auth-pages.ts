// 登录交换页（docs/ARCHITECTURE.md §7.1）。CSP 禁止内联脚本，所以令牌放在 meta 中，由同源静态脚本
// /auth/exchange.js 取走、写入本源 localStorage 后用 location.replace('/') 离开，地址栏与历史记录都不保留登录码。

export const AUTH_EXCHANGE_SCRIPT_PATH = '/auth/exchange.js';
export const SESSION_STORAGE_KEY = 'sfe.session';
export const SESSION_META_NAME = 'sfe-session';

export const AUTH_FAILED_MESSAGE = '登录链接无效或已过期，请从菜单栏 App 或 sfe open 重新打开';
export const AUTH_CROSS_SITE_MESSAGE = '登录被拒绝：登录链接只能从菜单栏 App 或 sfe open 打开';
export const AUTH_RATE_LIMITED_MESSAGE = '登录尝试过于频繁，请 1 分钟后从菜单栏 App 或 sfe open 重新打开';

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function page(title: string, head: string, body: string): string {
  return [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="referrer" content="no-referrer">',
    head,
    `<title>${escapeHtml(title)}</title>`,
    '</head>',
    `<body>${body}</body>`,
    '</html>',
    '',
  ].join('\n');
}

export function exchangeSuccessPage(token: string): string {
  return page(
    '正在打开管理后台',
    `<meta name="${SESSION_META_NAME}" content="${escapeHtml(token)}">`,
    `<p id="sfe-status">正在打开管理后台。</p><noscript><p>需要启用 JavaScript 才能打开管理后台。</p></noscript><script src="${AUTH_EXCHANGE_SCRIPT_PATH}"></script>`,
  );
}

export function exchangeFailurePage(message: string): string {
  return page('无法打开管理后台', '', `<p>${escapeHtml(message)}</p>`);
}

/** 静态脚本：只读 meta、写 localStorage、清掉 meta、替换地址。存储被禁用时显示原因并停在本页。 */
export const AUTH_EXCHANGE_SCRIPT = `(function () {
  'use strict';
  var meta = document.querySelector('meta[name="${SESSION_META_NAME}"]');
  var token = meta ? meta.getAttribute('content') : '';
  var status = document.getElementById('sfe-status');
  if (meta) meta.setAttribute('content', '');
  if (!token) {
    if (status) status.textContent = '${AUTH_FAILED_MESSAGE}';
    return;
  }
  try {
    window.localStorage.setItem('${SESSION_STORAGE_KEY}', token);
  } catch (e) {
    if (status) status.textContent = '保存登录状态失败：浏览器禁止了本地存储，请关闭无痕浏览后重新打开';
    return;
  }
  token = '';
  window.location.replace('/');
})();
`;
