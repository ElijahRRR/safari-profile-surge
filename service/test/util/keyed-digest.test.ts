import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { canonicalJson, canonicalRequestForm, deriveKey, hmacHex, keyedRequestDigest } from '../../src/util/keyed-digest.js';

const pepper = Buffer.alloc(32, 7);
const key = deriveKey(pepper, 'request');
const PW = 'Proxy-Pw-55';
const LOGIN = 'Login-Pw-66';

describe('hmacHex / deriveKey', () => {
  test('hmacHex is deterministic sha256 hex', () => {
    expect(hmacHex(key, 'abc')).toMatch(/^[0-9a-f]{64}$/);
    expect(hmacHex(key, 'abc')).toBe(hmacHex(key, Buffer.from('abc')));
  });

  test('different labels derive different keys', () => {
    expect(deriveKey(pepper, 'fp').equals(deriveKey(pepper, 'request'))).toBe(false);
    expect(deriveKey(pepper, 'fp').equals(deriveKey(pepper, 'fp'))).toBe(true);
  });

  test('rejects short keys and empty labels', () => {
    expect(() => hmacHex(Buffer.alloc(8), 'x')).toThrow(RangeError);
    expect(() => deriveKey(Buffer.alloc(8), 'fp')).toThrow(RangeError);
    expect(() => deriveKey(pepper, '')).toThrow(RangeError);
  });
});

describe('canonicalJson', () => {
  test('sorts keys at every level and has no whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: 'x' } })).toBe('{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}');
  });

  test('sorts integer-like keys lexicographically, not numerically', () => {
    expect(canonicalJson({ 10: 'a', 2: 'b', a: 'c' })).toBe('{"10":"a","2":"b","a":"c"}');
  });

  test('matches JSON.stringify for undefined, Dates and non-finite numbers', () => {
    expect(canonicalJson({ a: undefined, b: [undefined, 1], c: new Date('2026-01-01T00:00:00Z'), d: Number.NaN })).toBe(
      '{"b":[null,1],"c":"2026-01-01T00:00:00.000Z","d":null}',
    );
  });

  test('same content in different key order gives the same text', () => {
    expect(canonicalJson({ x: 1, y: { p: 1, q: 2 } })).toBe(canonicalJson({ y: { q: 2, p: 1 }, x: 1 }));
  });

  test('throws on cycles and BigInt', () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    expect(() => canonicalJson(a)).toThrow(TypeError);
    expect(() => canonicalJson({ n: 1n })).toThrow(TypeError);
  });
});

const createRequest = (pw: string, login: string) => ({
  request_id: 'req-1',
  environment: {
    displayName: 'US-买家01',
    site: 'US',
    proxy: {
      protocol: 'socks5',
      host: '203.0.113.10',
      port: 1080,
      username: { action: 'replace', value: 'proxy-user-1' },
      password: { action: 'replace', value: pw },
      frontProxyId: null,
    },
    account: { loginIdentifier: 'buyer01@example.test', password: { action: 'replace', value: login } },
  },
});

describe('keyedRequestDigest', () => {
  test('same input gives the same digest regardless of key order', () => {
    const a = createRequest(PW, LOGIN);
    const b = JSON.parse(JSON.stringify(a)) as typeof a;
    const reordered = { environment: { ...b.environment, proxy: { ...b.environment.proxy } }, request_id: b.request_id };
    expect(keyedRequestDigest(key, a)).toBe(keyedRequestDigest(key, reordered));
    expect(keyedRequestDigest(key, a)).toMatch(/^[0-9a-f]{64}$/);
  });

  test('a changed secret changes the digest', () => {
    expect(keyedRequestDigest(key, createRequest(PW, LOGIN))).not.toBe(keyedRequestDigest(key, createRequest(`${PW}x`, LOGIN)));
  });

  test('a different key gives a different digest', () => {
    const other = deriveKey(Buffer.alloc(32, 9), 'request');
    expect(keyedRequestDigest(key, createRequest(PW, LOGIN))).not.toBe(keyedRequestDigest(other, createRequest(PW, LOGIN)));
  });

  test('secret values are absent from the canonical form, including unkeyed hashes of them', () => {
    const form = canonicalRequestForm(key, createRequest(PW, LOGIN));
    for (const secret of [PW, LOGIN, 'proxy-user-1']) {
      expect(form).not.toContain(secret);
      expect(form).not.toContain(createHash('sha256').update(secret).digest('hex'));
    }
    expect(form).toContain('"action":"replace"');
    expect(form).toContain('203.0.113.10');
    expect(form).toContain('buyer01@example.test');
  });

  test('redacts import records, base64 content and plain secret fields at any depth', () => {
    const body = {
      request_id: 'imp-1',
      format: 'json',
      content_base64: Buffer.from('display_name,proxy_password\nA,Csv-Pw-1').toString('base64'),
      records: [
        { display_name: 'A', proxy_host: '198.51.100.7', proxy_port: 1080, proxy_username: 'csv-user-1', proxy_password: 'Csv-Pw-1', login_password: 'Csv-Login-1' },
        { display_name: 'B', proxy_host: '198.51.100.8', proxy_port: '1080', proxy_password: null },
      ],
      nested: { proxy: { username: 'plain-proxy-user' }, password: 'top-pw-1' },
    };
    const form = canonicalRequestForm(key, body);
    for (const secret of ['Csv-Pw-1', 'csv-user-1', 'Csv-Login-1', 'plain-proxy-user', 'top-pw-1', body.content_base64]) {
      expect(form).not.toContain(secret);
    }
    expect(form).toContain('"proxy_password":null');
    expect(form).toContain('198.51.100.7');
  });

  test('keep/clear SecretChange are kept verbatim', () => {
    const form = canonicalRequestForm(key, { proxy: { password: { action: 'keep' }, username: { action: 'clear' } } });
    expect(form).toBe('{"proxy":{"password":{"action":"keep"},"username":{"action":"clear"}}}');
  });

  test('username outside a proxy object is not treated as secret', () => {
    expect(canonicalRequestForm(key, { account: { username: 'visible' } })).toContain('visible');
  });
});
