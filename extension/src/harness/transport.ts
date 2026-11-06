// 演示模式的原生传输：把原生消息改为 HTTP 发到本机服务的演示端点
// POST /dev/native { profileId, envelope }，带网页会话令牌。只在 --mode harness 构建中使用。

import type { NativeEnvelope } from '@sfe/contract';
import { failure, type NativeTransport } from '../shared/native';

export const HARNESS_NATIVE_ENDPOINT = '/dev/native';
export const SESSION_STORAGE_KEY = 'sfe.session';

export function readSessionToken(storage: Pick<Storage, 'getItem'> | null | undefined): string | null {
  try {
    const value = storage?.getItem(SESSION_STORAGE_KEY);
    return value && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

export function harnessHttpTransport(opts: {
  profileId: string | null;
  getToken: () => string | null;
  fetchImpl?: typeof fetch;
  endpoint?: string;
}): NativeTransport {
  const doFetch = opts.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  return {
    async send(envelope: NativeEnvelope) {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      const token = opts.getToken();
      if (token) headers.authorization = `Bearer ${token}`;
      const res = await doFetch(opts.endpoint ?? HARNESS_NATIVE_ENDPOINT, {
        method: 'POST',
        headers,
        body: JSON.stringify({ profileId: opts.profileId, envelope }),
        cache: 'no-store',
        credentials: 'omit',
      });
      if (res.status === 401) return failure('AUTH_REQUIRED', '连接演示服务失败：请先登录网页后台');
      try {
        return await res.json();
      } catch {
        return failure('INTERNAL', `连接演示服务失败：HTTP ${res.status}`);
      }
    },
  };
}
