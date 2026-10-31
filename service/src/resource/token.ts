// 本机资源服务的读取令牌（D10）：32 个随机字节的小写十六进制，作为系统秘密保存在本机后台资料中（引用 sfe.resource-token.<n>，
// 当前引用记在 meta.resourceTokenRef）。只在从未创建过时生成；引用已记录而读不到值、或值的格式不对时 fail closed
// （SECRET_STORE_FAILED），从不静默重新生成——工作配置中的资源地址含当前令牌，换令牌只能经重新合并的“轮换资源地址”（改写受
// 管理的组定义并重载同一配置）。令牌值从不进入日志、错误信息或命令行参数。

import { randomBytes } from 'node:crypto';
import { RESOURCE_TOKEN_RE, SfeError } from '@sfe/contract';
import type { MetaRepo } from '../db/repos/meta.js';
import type { SecretStore } from '../ports.js';

export const RESOURCE_TOKEN_REF_PREFIX = 'sfe.resource-token.';
const RESOURCE_TOKEN_BYTES = 32;
const REF_RE = /^sfe\.resource-token\.([1-9][0-9]{0,8})$/;
/** 轮换时最多跳过这么多个已被占用的引用（之前中断的轮换留下的值）。 */
const MAX_ROTATION_PROBES = 16;

export type ResourceTokenMeta = Pick<MetaRepo, 'resourceTokenRef' | 'setResourceTokenRef'>;

/** 第 n 个令牌的引用（n ≥ 1）。 */
export function resourceTokenRefOf(n: number): string {
  if (!Number.isSafeInteger(n) || n < 1 || n > 999_999_999) throw new RangeError('invalid resource token ref index');
  return `${RESOURCE_TOKEN_REF_PREFIX}${n}`;
}

/** 引用中的编号；不是令牌引用为 null。 */
export function resourceTokenRefIndex(ref: string): number | null {
  const m = REF_RE.exec(ref);
  return m ? Number(m[1]) : null;
}

function failure(reason: 'not_found' | 'bad_format' | 'other', message: string): SfeError {
  return new SfeError('SECRET_STORE_FAILED', message, { details: { reason } });
}

function newToken(): string {
  return randomBytes(RESOURCE_TOKEN_BYTES).toString('hex');
}

/**
 * 读取当前读取令牌；从未创建过（meta 中没有引用）时创建 sfe.resource-token.1 并记下引用。
 * 失败抛 SECRET_STORE_FAILED：details.reason not_found（引用已记录而值不在）| bad_format（引用或值的格式不对），秘密存储
 * 本身的读写错误照原样抛出（reason other 等）。
 */
export async function loadResourceToken(store: SecretStore, meta: ResourceTokenMeta): Promise<string> {
  const ref = meta.resourceTokenRef();
  if (ref === null) {
    const first = resourceTokenRefOf(1);
    // 写入之后、记下引用之前崩溃：本机资料中已有第一个令牌（尚未写入任何工作配置），沿用并补记引用
    const existing = await store.get(first);
    if (existing !== null) {
      if (!RESOURCE_TOKEN_RE.test(existing)) throw failure('bad_format', '读取秘密失败：本机资源服务的读取令牌格式不正确');
      meta.setResourceTokenRef(first);
      return existing;
    }
    const value = newToken();
    await store.put(first, value, 'system');
    // 只有写入成功之后才记引用
    meta.setResourceTokenRef(first);
    return value;
  }
  if (resourceTokenRefIndex(ref) === null) throw failure('bad_format', '读取秘密失败：本机资源服务读取令牌的引用格式不正确');
  const value = await store.get(ref);
  if (value === null) throw failure('not_found', '读取秘密失败：本机后台资料中找不到本机资源服务的读取令牌，已停止提供节点资源');
  if (!RESOURCE_TOKEN_RE.test(value)) throw failure('bad_format', '读取秘密失败：本机资源服务的读取令牌格式不正确');
  return value;
}

/**
 * 轮换：在下一个未使用的引用（sfe.resource-token.<n+1>，之前中断的轮换留下的值从不复用，跳到再下一个）创建新令牌并返回
 * 引用与值。不改 meta：调用方在改写工作配置并提交之后再 setResourceTokenRef(ref)，然后删除旧引用的值。
 */
export async function rotateResourceToken(store: SecretStore, meta: ResourceTokenMeta): Promise<{ ref: string; token: string }> {
  const current = meta.resourceTokenRef();
  if (current === null) throw failure('not_found', '保存秘密失败：还没有本机资源服务的读取令牌，不能轮换');
  const n = resourceTokenRefIndex(current);
  if (n === null) throw failure('bad_format', '保存秘密失败：本机资源服务读取令牌的引用格式不正确');
  for (let i = 1; i <= MAX_ROTATION_PROBES; i++) {
    const ref = resourceTokenRefOf(n + i);
    if ((await store.get(ref)) !== null) continue;
    const token = newToken();
    await store.put(ref, token, 'system');
    return { ref, token };
  }
  throw failure('other', '保存秘密失败：找不到可用的读取令牌引用');
}
