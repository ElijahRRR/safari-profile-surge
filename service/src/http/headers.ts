// 每个响应都带的安全头（docs/ARCHITECTURE.md §7.1）。从不发送任何 CORS 头：网页与服务同源，
// 其他来源的页面既不能读响应，也拿不到 Authorization 令牌。

import type { ServerResponse } from 'node:http';

export const CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'; object-src 'none'";

export const NO_STORE = 'no-store';
/** 只用于文件名带内容哈希的构建产物（/assets/index-AbCd1234.js）。 */
export const IMMUTABLE = 'public, max-age=31536000, immutable';

const HASHED_ASSET_RE = /^\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/;

export function isHashedAssetPath(pathname: string): boolean {
  return HASHED_ASSET_RE.test(pathname);
}

export function applySecurityHeaders(res: ServerResponse): void {
  res.setHeader('Cache-Control', NO_STORE);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  // 不是 CORS：禁止其他来源把响应嵌入为图片/脚本等子资源
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
}

export const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
};

export function mimeTypeFor(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  const ext = dot === -1 ? '' : fileName.slice(dot).toLowerCase();
  return MIME_TYPES[ext] ?? 'application/octet-stream';
}
