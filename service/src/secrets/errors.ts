// 秘密存储错误：统一为 SECRET_STORE_FAILED，details.reason 区分原因；消息与 details 从不包含秘密值。
// 秘密保存在本机后台资料（服务数据库）中，不使用钥匙串（用户决定，见 docs/ARCHITECTURE.md §0）。

import { SfeError } from '@sfe/contract';

/**
 * not_found：找不到该项；legacy_keychain_data：数据目录由使用钥匙串的旧版本创建，本机资料中没有对应的值
 * （从不读取钥匙串迁移）；other：其他读写错误。
 */
export type SecretStoreFailureReason = 'not_found' | 'legacy_keychain_data' | 'other';

const ACTION: Record<'put' | 'get' | 'delete', string> = {
  put: '保存秘密失败',
  get: '读取秘密失败',
  delete: '删除秘密失败',
};

const REASON: Record<SecretStoreFailureReason, string> = {
  not_found: '本机后台资料中找不到该项',
  legacy_keychain_data: '数据目录由使用钥匙串的旧版本创建，本机后台资料中没有对应的值',
  other: '本机后台资料读写出错',
};

export function secretStoreError(op: 'put' | 'get' | 'delete', reason: SecretStoreFailureReason, message?: string): SfeError {
  return new SfeError('SECRET_STORE_FAILED', `${ACTION[op]}：${message ?? REASON[reason]}`, { details: { reason } });
}

export function isSecretStoreFailure(err: unknown, reason?: SecretStoreFailureReason): boolean {
  return err instanceof SfeError && err.code === 'SECRET_STORE_FAILED' && (reason === undefined || err.details?.reason === reason);
}
