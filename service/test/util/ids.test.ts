import { describe, expect, test } from 'vitest';
import { createIdGenerator, ID_BODY_RE, idTimestamp } from '../../src/util/ids.js';

describe('createIdGenerator().next', () => {
  test('prefix + underscore + 26 Crockford base32 chars', () => {
    const ids = createIdGenerator();
    for (const p of ['env', 'op', 'batch', 'probe', 'test', 'front', 'sec', 'sess', 'prop', 'mo', 'bak'] as const) {
      const id = ids.next(p);
      expect(id.startsWith(`${p}_`)).toBe(true);
      expect(id.slice(p.length + 1)).toMatch(ID_BODY_RE);
      // Crockford 不含 I L O U
      expect(id.slice(p.length + 1)).not.toMatch(/[ILOU]/);
    }
  });

  test('embeds the millisecond timestamp', () => {
    const t = Date.parse('2026-10-21T12:34:56.789Z');
    const ids = createIdGenerator({ now: () => t });
    expect(idTimestamp(ids.next('op'))?.toISOString()).toBe('2026-10-21T12:34:56.789Z');
  });

  test('unique across many calls', () => {
    const ids = createIdGenerator();
    const set = new Set<string>();
    for (let i = 0; i < 20000; i++) set.add(ids.next('op'));
    expect(set.size).toBe(20000);
  });

  test('strictly monotonic within the same millisecond', () => {
    const ids = createIdGenerator({ now: () => 1_700_000_000_000 });
    let prev = ids.next('op');
    for (let i = 0; i < 2000; i++) {
      const next = ids.next('op');
      expect(next > prev).toBe(true);
      prev = next;
    }
  });

  test('stays monotonic when the system clock goes backwards', () => {
    let t = 1_700_000_000_500;
    const ids = createIdGenerator({ now: () => t });
    const a = ids.next('op');
    t -= 400;
    const b = ids.next('op');
    expect(b > a).toBe(true);
  });

  test('successive ids in one millisecond are not simply +1', () => {
    // 随机步长：两个相邻标识的随机部分之差不是固定值
    const ids = createIdGenerator({ now: () => 1_700_000_000_000 });
    const decode = (id: string) => {
      const body = id.slice(3 + 10);
      let v = 0n;
      for (const ch of body) v = v * 32n + BigInt('0123456789ABCDEFGHJKMNPQRSTVWXYZ'.indexOf(ch));
      return v;
    };
    const vals = Array.from({ length: 6 }, () => decode(ids.next('op')));
    const diffs = new Set(vals.slice(1).map((v, i) => (v - vals[i]!).toString()));
    expect(diffs.size).toBeGreaterThan(1);
  });

  test('random overflow carries into the time part and stays monotonic', () => {
    let call = 0;
    const ids = createIdGenerator({
      now: () => 1_000,
      random: (n) => (n === 10 && call++ === 0 ? Buffer.alloc(10, 0xff) : Buffer.alloc(n, 0x01)),
    });
    const a = ids.next('op');
    const b = ids.next('op');
    expect(b > a).toBe(true);
    expect(idTimestamp(b)!.getTime()).toBe(1_001);
  });
});

describe('createIdGenerator().token', () => {
  test('defaults to 32 random bytes in base64url', () => {
    const ids = createIdGenerator();
    const t = ids.token();
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(t, 'base64url')).toHaveLength(32);
  });

  test('honours the byte count and is unique', () => {
    const ids = createIdGenerator();
    expect(Buffer.from(ids.token(16), 'base64url')).toHaveLength(16);
    expect(ids.token()).not.toBe(ids.token());
  });

  test.each([0, 8, 15, 15.5, -1, 4096])('rejects %s bytes', (n) => {
    expect(() => createIdGenerator().token(n)).toThrow(RangeError);
  });
});
