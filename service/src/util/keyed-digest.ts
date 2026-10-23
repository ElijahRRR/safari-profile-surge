// 带密钥摘要（docs/ARCHITECTURE.md §4）：服务内部的一切摘要都是 pepper 派生密钥的 HMAC，
// 从不对含秘密的内容做无密钥哈希。请求摘要先把秘密值替换成 HMAC，再规范化、再整体 HMAC。

import { createHmac } from 'node:crypto';

const MIN_KEY_BYTES = 16;

export function hmacHex(key: Buffer, data: string | Buffer): string {
  if (!Buffer.isBuffer(key) || key.length < MIN_KEY_BYTES) throw new RangeError('hmac key too short');
  return createHmac('sha256', key).update(data).digest('hex');
}

/** 按用途派生子密钥：HMAC-SHA256(pepper, "sfe-derive\0" + label)。不同用途的摘要互不可比。 */
export function deriveKey(pepper: Buffer, label: string): Buffer {
  if (!Buffer.isBuffer(pepper) || pepper.length < MIN_KEY_BYTES) throw new RangeError('pepper too short');
  if (typeof label !== 'string' || label.length === 0) throw new RangeError('derive label required');
  return createHmac('sha256', pepper).update(`sfe-derive\0${label}`).digest();
}

/**
 * 规范 JSON：对象键按 UTF-16 码元排序、无空白；undefined 字段省略（数组中为 null），
 * 有 toJSON 的值（Date）先转换；非有限数字为 null（与 JSON.stringify 一致）。循环引用与 BigInt 抛错。
 */
export function canonicalJson(value: unknown): string {
  return serialize(value, new Set());
}

function serialize(value: unknown, stack: Set<object>): string {
  if (value !== null && typeof value === 'object' && typeof (value as { toJSON?: unknown }).toJSON === 'function') {
    value = (value as { toJSON(): unknown }).toJSON();
  }
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'number':
      return Number.isFinite(value) ? JSON.stringify(value) : 'null';
    case 'boolean':
      return value ? 'true' : 'false';
    case 'bigint':
      throw new TypeError('canonicalJson: BigInt is not supported');
    case 'undefined':
    case 'function':
    case 'symbol':
      return 'null';
    default:
      break;
  }
  const obj = value as object;
  if (stack.has(obj)) throw new TypeError('canonicalJson: circular structure');
  stack.add(obj);
  try {
    if (Array.isArray(obj)) {
      return `[${obj.map((v) => serialize(v === undefined || typeof v === 'function' || typeof v === 'symbol' ? null : v, stack)).join(',')}]`;
    }
    if (Buffer.isBuffer(obj)) return JSON.stringify(obj.toString('base64'));
    const entries = Object.keys(obj)
      .filter((k) => {
        const v = (obj as Record<string, unknown>)[k];
        return v !== undefined && typeof v !== 'function' && typeof v !== 'symbol';
      })
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map((k) => `${JSON.stringify(k)}:${serialize((obj as Record<string, unknown>)[k], stack)}`).join(',')}}`;
  } finally {
    stack.delete(obj);
  }
}

/**
 * 这些字段的值无论出现在请求的哪一层都按秘密处理。导入的内容整体按秘密处理：csv/xlsx/json 文件内容（content_base64），以及 JSON
 * 导入的 records（GPT 或脚本经 agent.sock/HTTP 提交）——records 的键与表头一样按别名解析（importer/columns.ts resolveHeader：
 * 中文表头「代理密码」「登录密码」、proxy_pass、proxyPassword、Proxy Password 等），逐键识别秘密字段靠不住，漏掉一个别名就会让
 * 持久保存的 shape 依赖明文密码（可离线核对，§0「秘密的存放」）。
 */
const SECRET_FIELD_NAMES = new Set(['password', 'proxy_password', 'proxy_username', 'login_password', 'content_base64', 'records']);

/** 只在代理对象（父键为 proxy）中按秘密处理的字段。 */
const PROXY_SECRET_FIELD_NAMES = new Set(['username']);

function secretToken(key: Buffer, value: unknown): string {
  const text = typeof value === 'string' ? value : canonicalJson(value);
  return `hmac:${hmacHex(key, `req\0${text}`)}`;
}

function isSecretChangeReplace(value: unknown): value is { action: 'replace'; value: unknown } {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && (value as { action?: unknown }).action === 'replace' && 'value' in value;
}

function isSecretChange(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || Buffer.isBuffer(value)) return false;
  const action = (value as { action?: unknown }).action;
  return action === 'keep' || action === 'clear' || action === 'replace';
}

/**
 * 请求中由秘密派生的字段（本身不是秘密，但按含秘密的内容以 pepper 派生密钥计算）：导入与维护提交带回的 preview_digest
 * （导入预览对含密码的解析结果做带密钥摘要；维护预览对含用户节点凭据的工作配置做文件摘要）。持久保存的请求摘要（见
 * requestDigestParts）同样不能依赖它们。
 */
const SECRET_DERIVED_FIELD_NAMES = new Set(['preview_digest']);

function redact(token: (value: unknown) => string, value: unknown, parentKey: string | null, stack: Set<object>, extra: ReadonlySet<string> | null): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date || Buffer.isBuffer(value)) return value;
  if (stack.has(value)) throw new TypeError('keyedRequestDigest: circular structure');
  stack.add(value);
  try {
    if (Array.isArray(value)) return value.map((v) => redact(token, v, parentKey, stack, extra));
    if (isSecretChangeReplace(value)) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = k === 'value' ? token(v) : redact(token, v, k, stack, extra);
      return out;
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const secretField = SECRET_FIELD_NAMES.has(k) || (parentKey === 'proxy' && PROXY_SECRET_FIELD_NAMES.has(k)) || (extra !== null && extra.has(k));
      if (secretField && v !== null && v !== undefined && typeof v !== 'boolean' && !isSecretChange(v)) {
        // 字符串、数字、Buffer 或其他结构形式的秘密值整体替换；SecretChange 在递归中只替换 value
        out[k] = token(Buffer.isBuffer(v) ? v.toString('base64') : v);
      } else {
        out[k] = redact(token, v, k, stack, extra);
      }
    }
    return out;
  } finally {
    stack.delete(value);
  }
}

/**
 * 请求的规范形式：SecretChange 的替换值、password/proxy_password/proxy_username/login_password/
 * content_base64/records（任意层级；导入的 records 整体替换）与代理对象内的 username 都先替换为
 * `hmac:` + HMAC(key, "req\0" + 值)。结果不含任何秘密原文，也没有无密钥哈希。
 */
export function canonicalRequestForm(key: Buffer, body: unknown): string {
  return canonicalJson(redact((v) => secretToken(key, v), body, null, new Set(), null));
}

/** 带密钥的请求摘要（秘密值替换为同一密钥的 HMAC）：预览摘要等只在内存中或返回给调用方、从不持久保存的用途。 */
export function keyedRequestDigest(key: Buffer, body: unknown): string {
  return hmacHex(key, `request\0${canonicalRequestForm(key, body)}`);
}

/**
 * 持久保存的幂等请求摘要（operations.request_digest 与不创建操作的请求台账）的两部分，以及请求是否带秘密值（secret）。pepper 与这些摘要保存在同一个数据库中
 * （§0「秘密的存放」），按 pepper 派生密钥计算的秘密 HMAC 会让任何拿到数据库副本的人离线核对猜测的旧密码（已替换、已清扫的
 * 账号密码与代理密码）——所以持久保存的部分都不依赖秘密：
 * - shape：秘密字段与秘密派生的字段（preview_digest）一律替换为同一占位，再以 persistentKey（pepper 派生）整体 HMAC，与秘密无关；
 * - full：秘密字段以 ephemeralKey 的 HMAC 替换后整体 HMAC。ephemeralKey 每个进程随机生成、从不持久保存：同一进程内能区分只有
 *   秘密不同的两个请求，进程结束之后任何人（包括拿到数据库副本的人）都无法用它核对猜测。
 */
export function requestDigestParts(persistentKey: Buffer, ephemeralKey: Buffer, body: unknown): { shape: string; full: string; secret: boolean } {
  const shape = hmacHex(persistentKey, `request-shape\0${canonicalJson(redact(() => 'secret', body, null, new Set(), SECRET_DERIVED_FIELD_NAMES))}`);
  const full = hmacHex(ephemeralKey, `request\0${canonicalJson(redact((v) => secretToken(ephemeralKey, v), body, null, new Set(), SECRET_DERIVED_FIELD_NAMES))}`);
  return { shape, full, secret: carriesSecret(body) };
}

/**
 * 请求是否带秘密值（秘密字段或 SecretChange 的替换值；秘密派生的 preview_digest 不算）：只有 full 部分能区分两个这样的请求，而它
 * 的密钥不跨进程保存——服务重新启动之后无法判断同一 request_id 的两次请求带的是否是同一个秘密（engine/ledger.ts sameRequestDigest）。
 */
function carriesSecret(body: unknown): boolean {
  let found = false;
  redact(
    () => {
      found = true;
      return 'secret';
    },
    body,
    null,
    new Set(),
    null,
  );
  return found;
}
