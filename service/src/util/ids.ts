// 标识与令牌。标识形如 op_01J9Z…（ULID 形式：48 位毫秒时间 + 80 位随机，Crockford base32），
// 按时间排序；令牌只用于会话、登录码、test_id 与传输令牌，至少 128 位随机。

import { randomBytes } from 'node:crypto';
import type { IdGenerator } from '../ports.js';

export type IdPrefix = Parameters<IdGenerator['next']>[0];

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_MAX = 2 ** 48 - 1;
const RANDOM_BITS = 80n;
const RANDOM_MAX = (1n << RANDOM_BITS) - 1n;
/** 令牌最少 16 字节（128 位）。 */
export const MIN_TOKEN_BYTES = 16;
const MAX_TOKEN_BYTES = 1024;

export const ID_BODY_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export interface IdGeneratorOptions {
  /** 测试注入：毫秒时间。 */
  now?: () => number;
  /** 测试注入：随机字节来源。 */
  random?: (bytes: number) => Buffer;
}

/**
 * 同一毫秒内（或系统时间回拨时）保持单调：在上一个随机部分上加一个随机步长（1..2^32），
 * 而不是简单加一，使后一个标识不能由前一个直接推出。随机部分溢出时时间部分进一。
 */
export function createIdGenerator(opts: IdGeneratorOptions = {}): IdGenerator {
  const now = opts.now ?? Date.now;
  const random = opts.random ?? ((n: number) => randomBytes(n));
  let lastTime = -1;
  let lastRandom = 0n;

  function nextBody(): string {
    let time = Math.floor(now());
    if (!Number.isSafeInteger(time) || time < 0 || time > TIME_MAX) throw new RangeError('id clock out of range');
    let rand: bigint;
    if (time <= lastTime) {
      time = lastTime;
      const step = BigInt(random(4).readUInt32BE(0)) + 1n;
      rand = lastRandom + step;
      if (rand > RANDOM_MAX) {
        time = lastTime + 1;
        if (time > TIME_MAX) throw new RangeError('id clock out of range');
        rand = bytesToBigInt(random(10));
      }
    } else {
      rand = bytesToBigInt(random(10));
    }
    lastTime = time;
    lastRandom = rand;
    return encodeTime(time) + encodeRandom(rand);
  }

  return {
    next(prefix: IdPrefix): string {
      return `${prefix}_${nextBody()}`;
    },
    token(bytes = 32): string {
      if (!Number.isInteger(bytes) || bytes < MIN_TOKEN_BYTES || bytes > MAX_TOKEN_BYTES) {
        throw new RangeError(`token bytes must be an integer between ${MIN_TOKEN_BYTES} and ${MAX_TOKEN_BYTES}`);
      }
      return random(bytes).toString('base64url');
    },
  };
}

/** 解析标识中的时间部分（用于排序与排错）；格式不符返回 null。 */
export function idTimestamp(id: string): Date | null {
  const body = id.slice(id.indexOf('_') + 1);
  if (!ID_BODY_RE.test(body)) return null;
  let t = 0;
  for (const ch of body.slice(0, 10)) t = t * 32 + CROCKFORD.indexOf(ch);
  return new Date(t);
}

function encodeTime(time: number): string {
  let out = '';
  let t = time;
  for (let i = 0; i < 10; i++) {
    out = CROCKFORD[t % 32]! + out;
    t = Math.floor(t / 32);
  }
  return out;
}

function encodeRandom(value: bigint): string {
  let out = '';
  let v = value;
  for (let i = 0; i < 16; i++) {
    out = CROCKFORD[Number(v & 31n)]! + out;
    v >>= 5n;
  }
  return out;
}

function bytesToBigInt(buf: Buffer): bigint {
  let v = 0n;
  for (const b of buf) v = (v << 8n) | BigInt(b);
  return v & RANDOM_MAX;
}
