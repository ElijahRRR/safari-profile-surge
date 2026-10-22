import { describe, expect, test } from 'vitest';
import { isSecretStoreFailure, secretStoreError } from '../../src/secrets/errors.js';

describe('secretStoreError', () => {
  // errSecInteractionNotAllowed（线路值 locked）：Apple 只定义为 “Interaction with the Security Server is not allowed.”，
  // 无法显示授权提示时也会返回，不能断言为「钥匙串已锁定」。文字与 KeychainStatus.swift 的 displayText 一致。
  test('locked is described as interaction not allowed, not as a locked keychain', () => {
    const err = secretStoreError('put', 'locked');
    expect(err.message).toBe('写入钥匙串失败：钥匙串需要用户交互但当前不允许（可能已锁定，或无法显示授权提示）');
    expect(err.message).not.toContain('钥匙串已锁定');
    expect(err).toMatchObject({ code: 'SECRET_STORE_FAILED', details: { reason: 'locked' } });
    expect(isSecretStoreFailure(err, 'locked')).toBe(true);
  });

  test('an explicit message still overrides the reason text', () => {
    expect(secretStoreError('get', 'locked', '自定义').message).toBe('读取钥匙串失败：自定义');
  });
});
