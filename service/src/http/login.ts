// AppService.issueLoginCode 的实现助手（维护通道）：只有 HTTP 已绑定时才签发，返回实际监听地址上的
// 一次性登录链接。登录码只出现在返回值中，由宿主 App 或 sfe open 的 .webloc 文件打开。

import { AUTH_EXCHANGE_PATH, SfeError, type LoginCodeResponse } from '@sfe/contract';
import type { SessionStore } from './sessions.js';

export function buildLoginUrl(boundUrl: string, code: string): string {
  return `${boundUrl}${AUTH_EXCHANGE_PATH}?code=${encodeURIComponent(code)}`;
}

export function issueLoginUrl(sessions: Pick<SessionStore, 'issueLoginCode'>, http: { boundUrl(): string | null }): LoginCodeResponse {
  const base = http.boundUrl();
  if (base === null) throw new SfeError('INTERNAL', '签发登录链接失败：网页服务尚未启动');
  const { code, expiresAt } = sessions.issueLoginCode();
  return { url: buildLoginUrl(base, code), expiresAt };
}
