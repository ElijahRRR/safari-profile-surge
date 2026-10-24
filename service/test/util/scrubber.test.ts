import { describe, expect, test } from 'vitest';
import { createScrubber, MAX_REGISTERED_CHARS, MAX_REGISTERED_SECRET_LENGTH, MAX_REGISTERED_VALUES, SCRUB_MASK, scrubText } from '../../src/util/scrubber.js';

const M = SCRUB_MASK;
// 测试夹具中的“秘密”用插值拼接，避免仓库秘密扫描把测试文本当作真实凭据
const kv = (k: string, v: string) => `${k}=${v}`;
const PW = 'S3cr3t-Pw-01';
const USER = 'buyer-user-01';

describe('Surge node lines', () => {
  test('masks username/password params and keeps the rest of the line', () => {
    const line = `SFE-N-E0001-US01-v003 = socks5, 203.0.113.10, 1080, ${kv('username', USER)}, ${kv('password', PW)}, underlying-proxy=HK-01`;
    const out = scrubText(line);
    expect(out).toBe(`SFE-N-E0001-US01-v003 = socks5, 203.0.113.10, 1080, username=${M}, password=${M}, underlying-proxy=HK-01`);
  });

  test.each([
    ['psk', 'snell-psk-value-1'],
    ['passphrase', 'wg-pass-phrase'],
    ['passwd', 'old-style-pw'],
    ['obfs-host', 'cdn.example.test'],
    ['obfs-uri', '/hidden-path'],
    ['ca-passphrase', 'p12-pass'],
    ['ca-p12', 'MIIKAAAAAA'],
    ['key', 'private-key-1'],
    ['api-key', 'some-api-key-1'],
    ['access_token', 'tok-12345'],
  ])('masks %s', (name, value) => {
    const out = scrubText(`Node = trojan, 198.51.100.4, 443, ${kv(name, value)}, sni=www.example.test`);
    expect(out).not.toContain(value);
    expect(out).toContain(`${name}=${M}`);
    expect(out).toContain('sni=www.example.test');
  });

  test('masks quoted values with spaces', () => {
    const out = scrubText(`X = ss, 192.0.2.1, 8388, encrypt-method=aes-128-gcm, ${kv('password', '"two words"')}`);
    expect(out).toContain(`password=${M}`);
    expect(out).not.toContain('two words');
    expect(out).toContain('encrypt-method=aes-128-gcm');
  });

  test('masks positional credentials of socks5/http proxies', () => {
    const out = scrubText('Home = socks5, 192.0.2.5, 1080, alice01, Wonderland99, underlying-proxy=Front');
    expect(out).toBe(`Home = socks5, 192.0.2.5, 1080, ${M}, ${M}, underlying-proxy=Front`);
    const http = scrubText('Corp = https, proxy.example.test, 8443, bob, Hunter2-x');
    expect(http).toBe(`Corp = https, proxy.example.test, 8443, ${M}, ${M}`);
  });

  test('positional masking spans every line of a multi-line profile', () => {
    const text = ['[Proxy]', 'A = socks5, 192.0.2.5, 1080, u-one, p-one', 'B = http, 192.0.2.6, 8080, u-two, p-two', 'C = socks5, 192.0.2.7, 1080'].join('\n');
    const out = scrubText(text);
    for (const s of ['u-one', 'p-one', 'u-two', 'p-two']) expect(out).not.toContain(s);
    expect(out).toContain('C = socks5, 192.0.2.7, 1080');
  });
});

describe('http-api and API keys', () => {
  test('masks http-api lines and siblings', () => {
    const key = 'Abc123Def456';
    expect(scrubText(`http-api = ${key}@127.0.0.1:6171`)).toBe(`http-api = ${M}`);
    expect(scrubText(`http-api=${key}@0.0.0.0:6171`)).toBe(`http-api=${M}`);
    expect(scrubText('http-api-tls = true')).toBe(`http-api-tls = ${M}`);
  });

  test('masks X-Key headers case-insensitively', () => {
    const key = 'Zz9-secret-key';
    expect(scrubText(`X-Key: ${key}`)).toBe(`X-Key: ${M}`);
    expect(scrubText(`x-key:${key} trailing`)).toBe(`x-key:${M} trailing`);
  });

  test('masks <key>@host:port API strings and keeps the address', () => {
    const key = 'mykey778899';
    expect(scrubText(`connect ${key}@127.0.0.1:6171 failed`)).toBe(`connect ${M}@127.0.0.1:6171 failed`);
    expect(scrubText(`via ${key}@[::1]:6171`)).toBe(`via ${M}@[::1]:6171`);
    expect(scrubText(`via ${key}@localhost:6171`)).toBe(`via ${M}@localhost:6171`);
  });

  test('masks Authorization, Cookie and Bearer values', () => {
    expect(scrubText('Authorization: Bearer abc.def.ghi')).toBe(`Authorization: ${M}`);
    expect(scrubText('cookie: a=1; b=2')).toBe(`cookie: ${M}`);
    expect(scrubText('sent bearer tok_123 to server')).toBe(`sent bearer ${M} to server`);
  });
});

describe('URLs', () => {
  test('masks userinfo, query values and fragment values', () => {
    const url = `https://user01:${PW}@proxy.example.test:8443/path?q=abc&mode=1#frag=x`;
    expect(scrubText(`GET ${url} ok`)).toBe(`GET https://${M}@proxy.example.test:8443/path?q=${M}&mode=${M}#frag=${M} ok`);
    // 敏感参数名还会被参数规则整体遮盖到值的结尾（宁可多遮）
    const withToken = scrubText(`GET https://h.example.test/p?token=abc123&mode=1 ok`);
    expect(withToken).toBe(`GET https://h.example.test/p?token=${M} ok`);
  });

  test('masks socks5 URLs with credentials', () => {
    expect(scrubText('socks5://alice:Secret-1@203.0.113.9:1080')).toBe(`socks5://${M}@203.0.113.9:1080`);
  });

  test('keeps plain URLs without credentials or query unchanged', () => {
    expect(scrubText('see https://www.example.test/orders/history')).toBe('see https://www.example.test/orders/history');
  });

  test('login exchange URL never shows the code', () => {
    const code = 'Q2hhbmdlTWVQbGVhc2UxMjM0NTY3ODkw';
    const out = scrubText(`open http://127.0.0.1:61847/auth/exchange?code=${code}`);
    expect(out).not.toContain(code);
    expect(out).toContain('/auth/exchange?code=');
  });
});

describe('base64 runs', () => {
  test('masks long base64 / base64url / hex blobs', () => {
    const b64 = Buffer.from('a'.repeat(30) + '0123456789').toString('base64');
    const b64url = 'dGhpcyBpcyBhIHRva2VuIHZhbHVlIGZvciB0ZXN0aW5n_-1';
    const hex = 'a3f1'.repeat(16);
    for (const blob of [b64, b64url, hex]) {
      const out = scrubText(`blob ${blob} end`);
      expect(out).toBe(`blob ${M} end`);
    }
  });

  test('keeps short tokens, ids and node names', () => {
    const text = 'op_01J9ZQ8W6Y7R3M2K4N5P6Q7R8S env_01J9ZQ8W6Y7R3M2K4N5P6Q7R8T SFE-N-E0001-US01-v003';
    expect(scrubText(text)).toBe(text);
  });

  test('keeps digit-free path-like runs such as the Safari cryptex path', () => {
    const path = '/System/Volumes/Preboot/Cryptexes/App/System/Applications/Safari.app/Contents/MacOS/Safari';
    expect(scrubText(`PROCESS-NAME,${path}`)).toBe(`PROCESS-NAME,${path}`);
  });

  test('masks digit-free mixed-case runs without slashes', () => {
    const run = 'AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKlMnOp';
    expect(scrubText(run)).toBe(M);
  });
});

describe('JSON text', () => {
  test('masks sensitive JSON string/number values but keeps booleans', () => {
    const text = JSON.stringify({ proxy_password: 'pp-123', session_token: 99, hasPassword: true, host: '203.0.113.1' });
    const out = scrubText(text);
    expect(out).not.toContain('pp-123');
    expect(out).not.toContain(':99');
    expect(out).toContain('"hasPassword":true');
    expect(out).toContain('"host":"203.0.113.1"');
  });
});

/** 确定性的伪随机数（0 ≤ 结果 < n）。 */
function mulberry32(seed: number): (n: number) => number {
  let a = seed >>> 0;
  return (n) => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
  };
}

describe('createScrubber: value registry', () => {
  test('replaces registered values anywhere in free text', () => {
    const s = createScrubber();
    s.register('Tr1cky-Value');
    const err = 'Command failed: /Applications/Surge.app/Contents/Applications/surge-cli --check /tmp/x.conf\nerror: auth rejected (Tr1cky-Value)';
    const out = s.scrub(err);
    expect(out).not.toContain('Tr1cky-Value');
    expect(out).toContain(`(${M})`);
    expect(out).toContain('surge-cli --check');
  });

  test('scrubs execFile-style Error objects deeply', () => {
    const s = createScrubber();
    s.register('Tr1cky-Value');
    const e = Object.assign(new Error('Command failed: surge-cli test Tr1cky-Value'), { code: 1, details: { stderr: 'bad Tr1cky-Value' } });
    const out = s.scrubDeep({ err: e }) as unknown as { err: Record<string, unknown> };
    expect(JSON.stringify(out)).not.toContain('Tr1cky-Value');
    expect(out.err.code).toBe(1);
  });

  test('ignores values shorter than 3 characters', () => {
    const s = createScrubber();
    s.register('ab');
    s.register('');
    expect(s.registeredCount()).toBe(0);
    expect(s.scrub('ab cd ab')).toBe('ab cd ab');
  });

  test('replaces longest registered value first', () => {
    const s = createScrubber();
    s.register('abc');
    s.register('abcdefghi');
    expect(s.scrub('x abcdefghi y abc z')).toBe(`x ${M} y ${M} z`);
  });

  test('treats regex metacharacters literally and covers URL-encoded / JSON-escaped forms', () => {
    const s = createScrubber();
    const secret = 'p@ss "w(o)rd"+?*';
    s.register(secret);
    expect(s.scrub(`raw ${secret} end`)).toBe(`raw ${M} end`);
    expect(s.scrub(`enc ${encodeURIComponent(secret)} end`)).toBe(`enc ${M} end`);
    expect(s.scrub(`json ${JSON.stringify(secret)} end`)).toBe(`json "${M}" end`);
  });

  test('scrubText does not use any registry', () => {
    const s = createScrubber();
    s.register('registered-only');
    expect(scrubText('registered-only')).toBe('registered-only');
    expect(s.scrub('registered-only')).toBe(M);
  });

  test('scrubbing is idempotent', () => {
    const s = createScrubber();
    s.register(PW);
    const text = `A = socks5, 192.0.2.5, 1080, ${kv('username', USER)}, ${kv('password', PW)}\nhttps://u:p@h.example.test/?a=1 ${PW}`;
    const once = s.scrub(text);
    expect(s.scrub(once)).toBe(once);
  });

  test('leaves ordinary log text intact', () => {
    const s = createScrubber();
    const text = '发布失败：节点 SFE-N-E0001-US01-v003 读回不一致（READBACK_MISMATCH），代理 203.0.113.10:1080';
    expect(s.scrub(text)).toBe(text);
  });

  test('oversized values (only possible from rejected requests) are ignored and never break later scrubbing', () => {
    const s = createScrubber();
    s.register('Tr1cky-Value');
    const count = s.registeredCount();
    s.register('u'.repeat(80_000));
    s.register('p'.repeat(80_000));
    s.register('x'.repeat(MAX_REGISTERED_SECRET_LENGTH + 1));
    expect(s.registeredCount()).toBe(count);
    expect(() => s.scrub('still works')).not.toThrow();
    expect(s.scrub('error: auth rejected (Tr1cky-Value)')).toBe(`error: auth rejected (${M})`);
    expect(s.scrubDeep({ message: 'Tr1cky-Value' })).toEqual({ message: M });
  });

  test('secrets of every accepted length are masked, including URL-encoded and JSON-escaped forms', () => {
    const s = createScrubber();
    // 账号密码最长 256 个字符（含非 ASCII）；URL 编码形式远长于原值，不受登记上限影响
    const account = '密钥Ab1-'.repeat(43).slice(0, 256);
    const proxy = 'Aa0._~-'.repeat(19).slice(0, 128);
    s.register(account);
    s.register(proxy);
    expect(s.scrub(`a ${account} b`)).toBe(`a ${M} b`);
    expect(s.scrub(`a ${encodeURIComponent(account)} b`)).toBe(`a ${M} b`);
    expect(s.scrub(`a ${JSON.stringify(account)} b`)).toBe(`a "${M}" b`);
    expect(s.scrub(`a ${proxy} b`)).toBe(`a ${M} b`);
    const longest = 'q'.repeat(MAX_REGISTERED_SECRET_LENGTH);
    s.register(longest);
    expect(s.scrub(`<${longest}>`)).toBe(`<${M}>`);
  });

  test('registering thousands of values (a 2000-row import) stays fast and every value is still masked', () => {
    const s = createScrubber();
    const secrets = Array.from({ length: 6000 }, (_, i) => `Imp0rt-${i}-${(i * 7919).toString(36)}`);
    const started = Date.now();
    for (const v of secrets) s.register(v);
    expect(Date.now() - started).toBeLessThan(2000);
    for (const v of [secrets[0]!, secrets[2999]!, secrets[5999]!]) expect(s.scrub(`row: ${v};`)).toBe(`row: ${M};`);
  });

  test('100 000 values sharing a prefix: registration and later scrubbing stay fast, the registry is bounded', () => {
    const s = createScrubber();
    // 与操作编号同前缀的随机值（被拒绝的请求可以反复送来）：不能让之后每条含 op_ 的日志都变慢
    const rnd = mulberry32(42);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const junk = Array.from({ length: 100_000 }, () => `op_${Array.from({ length: 20 }, () => alphabet[rnd(alphabet.length)]).join('')}`);
    expect(new Set(junk).size).toBe(junk.length);
    const registerStarted = Date.now();
    for (const v of junk) s.register(v);
    expect(Date.now() - registerStarted).toBeLessThan(3000);
    expect(s.registeredCount()).toBeLessThanOrEqual(MAX_REGISTERED_VALUES);

    const lines = Array.from({ length: 500 }, (_, i) => `operation op_${String(i).padStart(12, '0')}xyz phase=DEPLOYING step ${i} op_${i}`);
    const scrubStarted = Date.now();
    for (const line of lines) expect(s.scrub(line)).toBe(line);
    expect(Date.now() - scrubStarted).toBeLessThan(1000);
    // 最近登记的值仍被遮盖；最早的值在超出容量后被淘汰
    expect(s.scrub(`x ${junk.at(-1)!} y`)).toBe(`x ${M} y`);
    expect(s.scrub(`x ${junk[0]!} y`)).toBe(`x ${junk[0]!} y`);
  });

  test('a value registered again is kept while older, unused values are evicted', () => {
    const s = createScrubber();
    const keep = 'Still-In-Use-Secret';
    s.register(keep);
    for (let i = 0; i <= MAX_REGISTERED_VALUES; i++) {
      s.register(`Fill-${i}-value`);
      // 仍在使用的秘密每次读取都会再次登记
      if (i % 10_000 === 0) s.register(keep);
    }
    expect(s.registeredCount()).toBe(MAX_REGISTERED_VALUES);
    expect(s.scrub(`auth rejected (${keep})`)).toBe(`auth rejected (${M})`);
    expect(s.scrub('<Fill-0-value>')).toBe('<Fill-0-value>');
    expect(s.scrub(`<Fill-${MAX_REGISTERED_VALUES}-value>`)).toBe(`<${M}>`);
  });

  test('the registry is bounded by total characters as well', () => {
    const s = createScrubber();
    const per = MAX_REGISTERED_SECRET_LENGTH;
    const n = Math.ceil(MAX_REGISTERED_CHARS / per) + 100;
    for (let i = 0; i < n; i++) s.register(`${String(i).padStart(8, '0')}${'k'.repeat(per - 8)}`);
    expect(s.registeredCount()).toBeLessThanOrEqual(Math.floor(MAX_REGISTERED_CHARS / per));
    const newest = `${String(n - 1).padStart(8, '0')}${'k'.repeat(per - 8)}`;
    expect(s.scrub(`[${newest}]`)).toBe(`[${M}]`);
  });

  test('insert, evict and match agree with a naive reference on overlapping values', () => {
    // 小容量 + 两字母表：大量共享前缀、拆分与合并边
    const s = createScrubber({ maxValues: 12 });
    const live: string[] = [];
    const rnd = mulberry32(7);
    const word = (min: number, max: number) => Array.from({ length: min + rnd(max - min + 1) }, () => 'ab'[rnd(2)]).join('');
    const reference = (text: string): string => {
      let out = '';
      let i = 0;
      while (i < text.length) {
        const hit = live.filter((v) => text.startsWith(v, i)).sort((a, b) => b.length - a.length)[0];
        if (hit === undefined) {
          out += text[i];
          i++;
        } else {
          out += M;
          i += hit.length;
        }
      }
      return out;
    };
    for (let step = 0; step < 3000; step++) {
      const v = word(3, 9);
      const at = live.indexOf(v);
      if (at !== -1) live.splice(at, 1);
      live.push(v);
      if (live.length > 12) live.shift();
      s.register(v);
      expect(s.registeredCount()).toBe(live.length);
      const text = word(0, 40);
      expect(s.scrub(text)).toBe(reference(text));
    }
  });

  test('values sharing a prefix: the longest match at each position wins', () => {
    const s = createScrubber();
    for (const v of ['abc', 'abcdef', 'abcd', 'zzabc']) s.register(v);
    expect(s.scrub('abcdefg abcdx abcz zzabcdef')).toBe(`${M}g ${M}x ${M}z ${M}def`);
  });

  test('a lone surrogate in a secret does not throw and is still masked', () => {
    const s = createScrubber();
    const odd = 'ab\ud800cd';
    expect(() => s.register(odd)).not.toThrow();
    expect(s.scrub(`x ${odd} y`)).toBe(`x ${M} y`);
  });

  test('fails closed: an unconvertible input yields the mask instead of throwing', () => {
    const s = createScrubber();
    const hostile = {
      toString(): string {
        throw new Error('boom');
      },
    };
    expect(s.scrub(hostile as unknown as string)).toBe(M);
  });
});

describe('createScrubber: scrubDeep', () => {
  test('masks the value of SecretChange replace objects and keeps the shape', () => {
    const s = createScrubber();
    const out = s.scrubDeep({ changes: { proxy: { host: '203.0.113.2', user: { action: 'replace', value: 'Plain-Secret-1' }, other: { action: 'keep' } } } });
    expect(out).toEqual({ changes: { proxy: { host: '203.0.113.2', user: { action: 'replace', value: M }, other: { action: 'keep' } } } });
  });

  test('masks sensitive keys but keeps booleans and nulls', () => {
    const s = createScrubber();
    const out = s.scrubDeep({
      password: { action: 'replace', value: 'x-secret' },
      proxy_password: 'pp-1',
      apiKey: 'k-1',
      token: 'tok',
      Authorization: 'Bearer z',
      cookie: 'c=1',
      content_base64: 'QUJD',
      login_code: 'lc-1',
      oauth: 'o-1',
      passwordRef: 'sec_01J9Z',
      hasPassword: true,
      hasUsername: false,
      secret: null,
      host: '198.51.100.1',
    });
    expect(out).toEqual({
      password: M,
      proxy_password: M,
      apiKey: M,
      token: M,
      Authorization: M,
      cookie: M,
      content_base64: M,
      login_code: M,
      oauth: M,
      passwordRef: M,
      hasPassword: true,
      hasUsername: false,
      secret: null,
      host: '198.51.100.1',
    });
  });

  test('code: masks login codes but keeps error codes, errno codes and environment codes', () => {
    const s = createScrubber();
    expect(s.scrubDeep({ code: 'Q2hhbmdlTWVQbGVhc2Ux_-x' })).toEqual({ code: M });
    expect(s.scrubDeep({ code: 'READBACK_MISMATCH' })).toEqual({ code: 'READBACK_MISMATCH' });
    expect(s.scrubDeep({ code: 'ENOENT' })).toEqual({ code: 'ENOENT' });
    expect(s.scrubDeep({ code: 'E0001' })).toEqual({ code: 'E0001' });
    expect(s.scrubDeep({ code: 2 })).toEqual({ code: 2 });
  });

  test('walks arrays, nested objects, Maps and Sets; handles cycles and buffers', () => {
    const s = createScrubber();
    s.register('deep-secret');
    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic.self = cyclic;
    const when = new Date('2026-01-01T00:00:00.000Z');
    const out = s.scrubDeep({
      list: ['deep-secret', { msg: 'has deep-secret inside' }],
      map: new Map([['k', 'deep-secret']]),
      set: new Set(['deep-secret']),
      buf: Buffer.from('raw-bytes'),
      when,
      cyclic,
    }) as Record<string, unknown>;
    const text = JSON.stringify(out);
    expect(text).not.toContain('deep-secret');
    expect(text).not.toContain('raw-bytes');
    expect(out.when).toBe(when);
    expect((out.cyclic as Record<string, unknown>).self).toBe('‹循环引用›');
  });

  test('does not mutate the input', () => {
    const s = createScrubber();
    const input = { password: 'abc-123', nested: { token: 't-1' } };
    s.scrubDeep(input);
    expect(input).toEqual({ password: 'abc-123', nested: { token: 't-1' } });
  });
});
