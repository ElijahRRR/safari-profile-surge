// pepper：所有带密钥摘要（指纹、请求摘要、文件摘要）的根密钥，保存在本机后台资料中（系统秘密 sfe.pepper，
// 见 local-store.ts）。只在从未创建过时生成；曾经创建过却读不到时 fail closed（停止导入与发布），从不静默重新生成——
// 否则旧指纹全部失效，变化检测会把未改的凭据当成已改。使用钥匙串的旧版数据目录在启动时即被拒绝（local-store.ts）。

import { SfeError } from '@sfe/contract';
import type { IdGenerator, SecretStore } from '../ports.js';
import type { MetaRepo } from '../db/repos/meta.js';
import { deriveKey, hmacHex } from '../util/keyed-digest.js';

export const PEPPER_REF = 'sfe.pepper';
const PEPPER_BYTES = 32;

export type PepperPurpose = 'fp' | 'request' | 'file' | 'preview' | 'session';

function decodePepper(value: string): Buffer {
  const buf = Buffer.from(value, 'base64url');
  if (buf.length < PEPPER_BYTES || buf.toString('base64url') !== value) {
    throw new SfeError('SECRET_STORE_FAILED', '读取秘密失败：pepper 格式不正确', { details: { reason: 'other' } });
  }
  return buf;
}

export async function loadPepper(store: SecretStore, meta: Pick<MetaRepo, 'pepperCreated' | 'markPepperCreated'>, ids: IdGenerator): Promise<Buffer> {
  const existing = await store.get(PEPPER_REF);
  if (existing !== null) {
    const buf = decodePepper(existing);
    // 本机资料中已有（例如写入后、记标志前崩溃）：沿用并补记标志
    if (!meta.pepperCreated()) meta.markPepperCreated();
    return buf;
  }
  if (meta.pepperCreated()) {
    throw new SfeError('SECRET_STORE_FAILED', '读取秘密失败：本机后台资料中找不到 pepper，已停止导入与发布', { details: { reason: 'not_found' } });
  }
  const value = ids.token(PEPPER_BYTES);
  await store.put(PEPPER_REF, value, 'system');
  // 只有写入成功后才记标志；写入后崩溃则下次启动读到并补记
  meta.markPepperCreated();
  return decodePepper(value);
}

/** 按用途派生的子密钥。 */
export function pepperKey(pepper: Buffer, purpose: PepperPurpose): Buffer {
  return deriveKey(pepper, purpose);
}

/** 秘密值指纹（代理用户名/密码、账号密码）：HMAC(deriveKey(pepper,'fp'), value)。 */
export function fingerprint(pepper: Buffer, value: string): string {
  return hmacHex(deriveKey(pepper, 'fp'), value);
}
