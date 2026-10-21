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

/** 这些字段的值无论出现在请求的哪一层都按秘密处理。 */
const SECRET_FIELD_NAMES = new Set(['password', 'proxy_password', 'proxy_username', 'login_password', 'content_base64']);

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

function redact(key: Buffer, value: unknown, parentKey: string | null, stack: Set<object>): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date || Buffer.isBuffer(value)) return value;
  if (stack.has(value)) throw new TypeError('keyedRequestDigest: circular structure');
  stack.add(value);
  try {
    if (Array.isArray(value)) return value.map((v) => redact(key, v, parentKey, stack));
    if (isSecretChangeReplace(value)) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = k === 'value' ? secretToken(key, v) : redact(key, v, k, stack);
      return out;
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const secretField = SECRET_FIELD_NAMES.has(k) || (parentKey === 'proxy' && PROXY_SECRET_FIELD_NAMES.has(k));
      if (secretField && v !== null && v !== undefined && typeof v !== 'boolean' && !isSecretChange(v)) {
        // 字符串、数字、Buffer 或其他结构形式的秘密值整体替换；SecretChange 在递归中只替换 value
        out[k] = secretToken(key, Buffer.isBuffer(v) ? v.toString('base64') : v);
      } else {
        out[k] = redact(key, v, k, stack);
      }
    }
    return out;
  } finally {
    stack.delete(value);
  }
}

/**
 * 请求的规范形式：SecretChange 的替换值、password/proxy_password/proxy_username/login_password/
 * content_base64（任意层级，含导入 records 的每一项）与代理对象内的 username 都先替换为
 * `hmac:` + HMAC(key, "req\0" + 值)。结果不含任何秘密原文，也没有无密钥哈希。
 */
export function canonicalRequestForm(key: Buffer, body: unknown): string {
  return canonicalJson(redact(key, body, null, new Set()));
}

/** 幂等判断用的带密钥请求摘要（operations.request_digest）。 */
export function keyedRequestDigest(key: Buffer, body: unknown): string {
  return hmacHex(key, `request\0${canonicalRequestForm(key, body)}`);
}
