import { describe, expect, test } from 'vitest';
import { isSecretStoreFailure, secretStoreError } from '../../src/secrets/errors.js';

describe('secretStoreError', () => {
  // 秘密保存在本机后台资料中（不使用钥匙串）：原因只有找不到、旧版钥匙串数据目录与其他读写错误
  test('describes the local store, not the Keychain', () => {
    const err = secretStoreError('put', 'other');
    expect(err.message).toBe('保存秘密失败：本机后台资料读写出错');
    expect(err).toMatchObject({ code: 'SECRET_STORE_FAILED', details: { reason: 'other' } });
    expect(isSecretStoreFailure(err, 'other')).toBe(true);
    expect(isSecretStoreFailure(err, 'not_found')).toBe(false);
    for (const reason of ['not_found', 'legacy_keychain_data', 'other'] as const) {
      for (const op of ['put', 'get', 'delete'] as const) expect(secretStoreError(op, reason).message).not.toMatch(/钥匙串项|钥匙串工具|授权提示/);
    }
    expect(secretStoreError('get', 'legacy_keychain_data').details).toEqual({ reason: 'legacy_keychain_data' });
  });

  test('an explicit message still overrides the reason text', () => {
    expect(secretStoreError('get', 'other', '自定义').message).toBe('读取秘密失败：自定义');
  });
});
