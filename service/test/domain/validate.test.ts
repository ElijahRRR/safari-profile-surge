import { describe, expect, test } from 'vitest';
import type { EnvironmentInput } from '@sfe/contract';
import {
  isSurgeReferenceName,
  isSurgeSafeCredential,
  validateEnvironmentChanges,
  validateEnvironmentInput,
  validateHost,
} from '../../src/domain/validate.js';

const base: EnvironmentInput = {
  displayName: 'US-买家01',
  site: 'US',
  proxy: { protocol: 'socks5', host: '203.0.113.10', port: 1080, frontProxyId: null },
};

describe('validateHost', () => {
  test.each(['203.0.113.10', '2001:db8::1', 'proxy.example.test', 'a-b.example.co'])('accepts %s', (h) => {
    expect(validateHost(h)).toEqual([]);
  });
  test.each(['', ' 1.2.3.4', 'localhost', '[2001:db8::1]', '1.2.3.4:1080', 'exa mple.com', 'a..b', '-a.com', 'a,b.com'])(
    'rejects %j',
    (h) => {
      expect(validateHost(h)).toHaveLength(1);
    },
  );
});

describe('credential safety', () => {
  test('accepts conservative charset', () => {
    expect(isSurgeSafeCredential('user_01')).toBe(true);
    expect(isSurgeSafeCredential('P@ss-w0rd!(x)')).toBe(true);
  });
  test.each(['a,b', 'a"b', "a'b", 'a=b', 'a b', 'a#b', 'a;b', 'a\\b', 'a`b', 'pässwort', 'a\nb', ''])('rejects %j', (v) => {
    expect(isSurgeSafeCredential(v)).toBe(false);
  });
  test('reference names', () => {
    expect(isSurgeReferenceName('🇭🇰 香港 01')).toBe(true);
    expect(isSurgeReferenceName('a,b')).toBe(false);
    expect(isSurgeReferenceName(' padded')).toBe(false);
  });
});

describe('validateEnvironmentInput', () => {
  test('valid minimal input', () => {
    expect(validateEnvironmentInput(base)).toEqual([]);
  });
  test('reports field paths with prefix', () => {
    const errors = validateEnvironmentInput(
      {
        ...base,
        displayName: '',
        proxy: { ...base.proxy, port: 70000, password: { action: 'replace', value: 'a,b' } },
      },
      'rows[2].',
    );
    expect(errors.map((e) => e.field)).toEqual(['rows[2].displayName', 'rows[2].proxy.port', 'rows[2].proxy.password']);
  });
  test('site must be explicit and supported', () => {
    expect(validateEnvironmentInput({ ...base, site: 'UK' as never }).map((e) => e.field)).toEqual(['site']);
  });
  test('account password allows any printable chars', () => {
    expect(validateEnvironmentInput({ ...base, account: { password: { action: 'replace', value: 'a,"b= c' } } })).toEqual([]);
    expect(validateEnvironmentInput({ ...base, account: { password: { action: 'replace', value: 'a\nb' } } })).toHaveLength(1);
  });
});

describe('validateEnvironmentChanges', () => {
  test('empty changes rejected', () => {
    expect(validateEnvironmentChanges({})).toEqual([{ field: 'changes', message: '没有需要保存的修改' }]);
  });
  test('partial proxy changes validated', () => {
    expect(validateEnvironmentChanges({ proxy: { host: '203.0.113.20' } })).toEqual([]);
    expect(validateEnvironmentChanges({ proxy: { port: 0 } })).toHaveLength(1);
  });
});
