import { describe, expect, test } from 'vitest';
import type { ImportRecord } from '@sfe/contract';
import { displayNameKey, normalizeRecord, parseImportBoolean, resolveSite } from '../../src/importer/normalize.js';

const MARKER = 'Mk7SecretZz9';

const base: ImportRecord = {
  display_name: '示例-买家01',
  proxy_host: '203.0.113.10',
  proxy_port: '1080',
  site: 'US',
};

const norm = (over: Partial<Record<keyof ImportRecord, unknown>> = {}, opts: { defaultSite?: 'US' | null; row?: number } = {}) =>
  normalizeRecord({ ...base, ...over } as ImportRecord, { defaultSite: opts.defaultSite ?? null, row: opts.row ?? 2 });

const fields = (r: ReturnType<typeof norm>) => r.errors.map((e) => e.field);

describe('normalizeRecord: full record', () => {
  test('valid record maps every field', () => {
    const r = norm({
      environment_id: 'env_01',
      proxy_type: 'socks5',
      proxy_username: 'example-user',
      proxy_password: 'example-pass',
      front_proxy: '前置-香港01',
      account_label: '示例买家号',
      login_identifier: 'buyer01@example.test',
      login_password: 'example only',
      expected_exit_ip: '203.0.113.20',
      auto_open_orders: '否',
      auto_fill_login: '是',
    });
    expect(r.errors).toEqual([]);
    expect(r.environmentId).toBe('env_01');
    expect(r.frontProxyRef).toBe('前置-香港01');
    expect(r.input).toEqual({
      displayName: '示例-买家01',
      site: 'US',
      autoOpenOrders: false,
      autoFillLogin: true,
      proxy: {
        protocol: 'socks5',
        host: '203.0.113.10',
        port: 1080,
        username: { action: 'replace', value: 'example-user' },
        password: { action: 'replace', value: 'example-pass' },
        frontProxyId: null,
        expectedExitIp: '203.0.113.20',
      },
      account: {
        label: '示例买家号',
        loginIdentifier: 'buyer01@example.test',
        password: { action: 'replace', value: 'example only' },
      },
    });
  });

  test('minimal record uses defaults and lists blank fields', () => {
    const r = norm();
    expect(r.errors).toEqual([]);
    expect(r.environmentId).toBeNull();
    expect(r.frontProxyRef).toBeNull();
    expect(r.input.autoOpenOrders).toBe(true);
    expect(r.input.autoFillLogin).toBe(false);
    expect(r.input.proxy.protocol).toBe('socks5');
    expect(r.input.proxy.username).toEqual({ action: 'keep' });
    expect(r.input.proxy.password).toEqual({ action: 'keep' });
    expect(r.input.proxy.expectedExitIp).toBeNull();
    expect(r.input.account).toEqual({ label: null, loginIdentifier: null, password: { action: 'keep' } });
    expect(r.blankFields).toEqual(
      expect.arrayContaining(['environment_id', 'proxy_type', 'proxy_username', 'proxy_password', 'front_proxy', 'login_password', 'auto_open_orders', 'auto_fill_login']),
    );
    expect(r.blankFields).not.toContain('display_name');
  });

  test('values are trimmed', () => {
    const r = norm({ display_name: '  示例  ', proxy_host: ' 203.0.113.10 ', proxy_port: ' 1080 ', front_proxy: ' F1 ' });
    expect(r.errors).toEqual([]);
    expect(r.input.displayName).toBe('示例');
    expect(r.input.proxy.host).toBe('203.0.113.10');
    expect(r.frontProxyRef).toBe('F1');
  });

  test('error fields use the rows[N]. prefix', () => {
    const r = norm({ display_name: '', proxy_host: 'not a host' }, { row: 7 });
    expect(fields(r)).toEqual(['rows[7].displayName', 'rows[7].proxy.host']);
  });
});

describe('proxy type', () => {
  test.each(['', 'socks5', 'SOCKS5', ' Socks5 '])('%j is socks5', (v) => {
    const r = norm({ proxy_type: v });
    expect(r.errors).toEqual([]);
    expect(r.input.proxy.protocol).toBe('socks5');
  });

  test.each(['http', 'https', 'socks4', 'ss', 'socks'])('%j is invalid', (v) => {
    const r = norm({ proxy_type: v });
    expect(fields(r)).toEqual(['rows[2].proxy.protocol']);
    expect(r.errors[0]!.message).toContain('SOCKS5');
  });
});

describe('port', () => {
  test.each([
    ['1080', 1080],
    [1080, 1080],
    ['08080', 8080],
    ['65535', 65535],
  ])('%j → %d', (v, n) => {
    const r = norm({ proxy_port: v });
    expect(r.errors).toEqual([]);
    expect(r.input.proxy.port).toBe(n);
  });

  test.each(['abc', '1080.5', '-1', '+1080', '0', '65536', '70000', '1e3', 1080.5])('%j is invalid with one error', (v) => {
    const r = norm({ proxy_port: v });
    expect(fields(r)).toEqual(['rows[2].proxy.port']);
  });

  test('blank port is required', () => {
    const r = norm({ proxy_port: '' });
    expect(r.errors).toEqual([{ field: 'rows[2].proxy.port', message: '代理端口必填' }]);
    expect(r.blankFields).toContain('proxy_port');
  });
});

describe('site', () => {
  test.each(['US', 'us', ' Us ', '美国', '美国站', 'amazon.com', 'www.amazon.com', 'https://www.amazon.com/', 'Amazon 美国站', 'ＵＳ'])(
    '%j → US',
    (v) => {
      const r = norm({ site: v });
      expect(r.errors).toEqual([]);
      expect(r.input.site).toBe('US');
    },
  );

  test('blank site uses the default site', () => {
    const r = norm({ site: '' }, { defaultSite: 'US' });
    expect(r.errors).toEqual([]);
    expect(r.input.site).toBe('US');
    expect(r.blankFields).toContain('site');
  });

  test('blank site without default is invalid (never assumes US)', () => {
    const r = norm({ site: null });
    expect(fields(r)).toEqual(['rows[2].site']);
    expect(r.input.site).not.toBe('US');
  });

  test.each(['UK', 'amazon.co.uk', 'www.amazon.de', 'JP', '日本', 'amazon.com.evil.invalid'])('%j is invalid even with a default', (v) => {
    const r = norm({ site: v }, { defaultSite: 'US' });
    expect(fields(r)).toEqual(['rows[2].site']);
    expect(r.errors[0]!.message).toContain('不受支持');
  });

  test('resolveSite direct', () => {
    expect(resolveSite('www.amazon.com')).toBe('US');
    expect(resolveSite('amazon')).toBeNull();
  });
});

describe('booleans', () => {
  test.each([
    ['是', true],
    ['否', false],
    ['true', true],
    ['FALSE', false],
    ['1', true],
    ['0', false],
    ['开', true],
    ['关', false],
    ['yes', true],
    ['No', false],
    ['on', true],
    ['off', false],
    ['开启', true],
    ['关闭', false],
    [true, true],
    [false, false],
    [1, true],
    [0, false],
  ])('%j → %s', (v, b) => {
    expect(parseImportBoolean(v)).toBe(b);
    const r = norm({ auto_open_orders: v, auto_fill_login: v });
    expect(r.errors).toEqual([]);
    expect(r.input.autoOpenOrders).toBe(b);
    expect(r.input.autoFillLogin).toBe(b);
  });

  test('defaults: auto open orders on, auto fill off', () => {
    const r = norm({ auto_open_orders: '', auto_fill_login: null });
    expect(r.input.autoOpenOrders).toBe(true);
    expect(r.input.autoFillLogin).toBe(false);
  });

  test.each(['maybe', '2', 'y', 'TRUE!', 2])('%j is invalid', (v) => {
    const r = norm({ auto_fill_login: v });
    expect(fields(r)).toEqual(['rows[2].autoFillLogin']);
  });
});

describe('secrets', () => {
  test('non-empty secret cells replace, empty cells keep', () => {
    const r = norm({ proxy_username: 'u1', proxy_password: '', login_password: null });
    expect(r.input.proxy.username).toEqual({ action: 'replace', value: 'u1' });
    expect(r.input.proxy.password).toEqual({ action: 'keep' });
    expect(r.input.account?.password).toEqual({ action: 'keep' });
  });

  test('whitespace-only secrets keep (import never clears a secret)', () => {
    const r = norm({ proxy_password: '   ', login_password: '  ' });
    expect(r.input.proxy.password).toEqual({ action: 'keep' });
    expect(r.input.account?.password).toEqual({ action: 'keep' });
  });

  test('proxy credentials are trimmed; login password is kept exactly', () => {
    const r = norm({ proxy_password: ' p-1 ', login_password: ' pw ' });
    expect(r.input.proxy.password).toEqual({ action: 'replace', value: 'p-1' });
    expect(r.input.account?.password).toEqual({ action: 'replace', value: ' pw ' });
  });

  test('numeric secret from JSON becomes text', () => {
    const r = norm({ proxy_password: 123456 });
    expect(r.input.proxy.password).toEqual({ action: 'replace', value: '123456' });
  });

  test('non-text secret is invalid without echoing', () => {
    const r = norm({ proxy_password: true });
    expect(fields(r)).toEqual(['rows[2].proxy.password']);
  });

  test('unsafe proxy credential characters are rejected without echoing the value', () => {
    const r = norm({ proxy_username: `${MARKER}@x`, proxy_password: `${MARKER},"x` });
    expect(fields(r)).toEqual(['rows[2].proxy.username', 'rows[2].proxy.password']);
    expect(JSON.stringify(r.errors)).not.toContain(MARKER);
  });

  test('over-long login password is rejected without echoing the value', () => {
    const r = norm({ login_password: MARKER.repeat(40) });
    expect(fields(r)).toEqual(['rows[2].account.password']);
    expect(JSON.stringify(r.errors)).not.toContain(MARKER);
  });
});

describe('other fields', () => {
  test('expected exit IP is optional', () => {
    expect(norm({ expected_exit_ip: '' }).input.proxy.expectedExitIp).toBeNull();
    expect(norm({ expected_exit_ip: '2001:db8::1' }).errors).toEqual([]);
  });

  test('invalid expected exit IP', () => {
    expect(fields(norm({ expected_exit_ip: 'exit.example.test' }))).toEqual(['rows[2].proxy.expectedExitIp']);
  });

  test('environment id format', () => {
    expect(norm({ environment_id: ' E0001 ' }).environmentId).toBe('E0001');
    const bad = norm({ environment_id: 'env 01;drop' });
    expect(bad.environmentId).toBeNull();
    expect(fields(bad)).toEqual(['rows[2].environment_id']);
  });

  test('front proxy reference is passed through; frontProxyId stays null', () => {
    const r = norm({ front_proxy: 'front_01HZX' });
    expect(r.frontProxyRef).toBe('front_01HZX');
    expect(r.input.proxy.frontProxyId).toBeNull();
  });

  test('numeric login identifier (phone stored as number) becomes text', () => {
    const r = norm({ login_identifier: 13800000000 });
    expect(r.input.account?.loginIdentifier).toBe('13800000000');
  });

  test('boolean in a text field is invalid', () => {
    expect(fields(norm({ display_name: true }))).toEqual(['rows[2].displayName']);
  });

  test('control characters in display name are invalid', () => {
    expect(fields(norm({ display_name: 'a\nb' }))).toEqual(['rows[2].displayName']);
  });

  test('display name over 64 characters is invalid', () => {
    expect(fields(norm({ display_name: '名'.repeat(65) }))).toEqual(['rows[2].displayName']);
  });

  test('formula-looking text is kept as plain text', () => {
    const r = norm({ display_name: '=1+1', account_label: '@SUM(A1)' });
    expect(r.input.displayName).toBe('=1+1');
    expect(r.input.account?.label).toBe('@SUM(A1)');
  });

  test('displayNameKey folds case and width', () => {
    expect(displayNameKey(' Buyer01 ')).toBe(displayNameKey('ＢＵＹＥＲ01'));
  });
});
