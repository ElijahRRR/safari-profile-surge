// 钥匙串错误：统一为 SECRET_STORE_FAILED，details.reason 区分原因；消息与 details 从不包含秘密值。

import { SfeError } from '@sfe/contract';

export type SecretStoreFailureReason = 'denied' | 'locked' | 'acl' | 'not_found' | 'timeout' | 'other';

const ACTION: Record<'put' | 'get' | 'delete', string> = {
  put: '写入钥匙串失败',
  get: '读取钥匙串失败',
  delete: '删除钥匙串项失败',
};

const REASON: Record<SecretStoreFailureReason, string> = {
  denied: '用户拒绝了访问',
  locked: '钥匙串已锁定',
  acl: '访问控制不匹配',
  not_found: '找不到该项',
  timeout: '等待钥匙串授权超时，可重试',
  other: '钥匙串工具返回错误',
};

export function secretStoreError(op: 'put' | 'get' | 'delete', reason: SecretStoreFailureReason, message?: string): SfeError {
  return new SfeError('SECRET_STORE_FAILED', `${ACTION[op]}：${message ?? REASON[reason]}`, { details: { reason } });
}

export function isSecretStoreFailure(err: unknown, reason?: SecretStoreFailureReason): boolean {
  return err instanceof SfeError && err.code === 'SECRET_STORE_FAILED' && (reason === undefined || err.details?.reason === reason);
}
