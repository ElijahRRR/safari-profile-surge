import { describe, expect, test } from 'vitest';
import { redactFreeText, redactProfileText, redactProxyLine, redactUrls } from '../../src/surge/redact-profile.js';

const SECRETS = ['exampleUsr1', 'examplePwd1', 'psk-value-1', 'apikey-value', 'ca-pass-value', 'tok-value', 'wg-private', 'url-pass', 'q-token'];

const PROFILE = [
  '#!MANAGED-CONFIG https://u:url-pass@sub.example.test/conf?token=q-token',
  '[General]',
  'http-api = apikey-value@127.0.0.1:6171',
  'http-api-tls = false',
  'loglevel = notify',
  '',
  '[Proxy]',
  'A = socks5, 192.0.2.10, 1080, username=exampleUsr1, password=examplePwd1, underlying-proxy=Front-A',
  'B = http, 192.0.2.11, 8080, exampleUsr1, examplePwd1',
  'C = snell, 192.0.2.12, 443, psk=psk-value-1, version=4',
  'D = trojan, 192.0.2.13, 443, password="examplePwd1", sni=a.example.test',
  '',
  '[MITM]',
  'ca-passphrase = ca-pass-value',
  'ca-p12 = MIIQ',
  'hostname = a.example.test',
  '',
  '[WireGuard home]',
  'private-key = wg-private',
  'peer = (public-key = pub, endpoint = 192.0.2.20:51820)',
  '',
  '[Rule]',
  'URL-REGEX,^https://a.example.test/x?token=tok-value,REJECT',
  'FINAL,DIRECT',
].join('\r\n');

describe('redactProfileText', () => {
  const out = redactProfileText(PROFILE);

  test.each(SECRETS)('masks %s', (secret) => {
    expect(out).not.toContain(secret);
  });

  test('keeps structure, names, hosts and line endings', () => {
    expect(out.split('\r\n')).toHaveLength(PROFILE.split('\r\n').length);
    expect(out).toContain('A = socks5, 192.0.2.10, 1080, username=***, password=***, underlying-proxy=Front-A');
    expect(out).toContain('B = http, 192.0.2.11, 8080, ***, ***');
    expect(out).toContain('http-api = ***');
    expect(out).toContain('ca-passphrase = ***');
    expect(out).toContain('hostname = a.example.test');
    expect(out).toContain('#!MANAGED-CONFIG https://***@sub.example.test/conf?***');
    expect(out).toContain('FINAL,DIRECT');
  });
});

describe('free text', () => {
  test('URLs lose userinfo, query and fragment', () => {
    expect(redactUrls('see https://a:b@x.example.test/p/q?k=v#frag now')).toBe('see https://***@x.example.test/p/q?***#*** now');
  });
  test('inline key=value secrets anywhere', () => {
    expect(redactFreeText('error near password=examplePwd2, psk = abc and token=zzz')).toBe('error near password=***, psk = *** and token=***');
    expect(redactFreeText('http-api = k@127.0.0.1:1')).toBe('http-api = ***');
  });
  test('proxy line positional credentials', () => {
    expect(redactProxyLine('N = socks5, 192.0.2.1, 1080, u1, p1')).toBe('N = socks5, 192.0.2.1, 1080, ***, ***');
  });
});

describe('loopback URLs (D10: the resource read token is in the path)', () => {
  // 合成令牌与地址：运行时拼出
  const TOKEN = 'cd'.repeat(32);
  const LINE = `SFE-ROUTE = select, REJECT, policy-path=http://127.0.0.1:20001/${TOKEN}/sfe-nodes.list`;

  test.each(['127.0.0.1:20001', 'localhost:20001', '[::1]:20001', '127.0.0.1', 'LocalHost'])('redactUrls masks the whole path for %s', (host) => {
    expect(redactUrls(`policy-path=http://${host}/${TOKEN}/sfe-nodes.list`)).toBe(`policy-path=http://${host}/***`);
    expect(redactUrls(`see https://${host}/${TOKEN}/x?q=1#f end`)).toBe(`see https://${host}/*** end`);
  });

  test('userinfo stays masked; a bare or root loopback address is kept', () => {
    expect(redactUrls(`http://u:p@127.0.0.1:20001/${TOKEN}/sfe-nodes.list`)).toBe('http://***@127.0.0.1:20001/***');
    expect(redactUrls('http://127.0.0.1:6171')).toBe('http://127.0.0.1:6171');
    expect(redactUrls('http://127.0.0.1:6171/')).toBe('http://127.0.0.1:6171/');
  });

  test('other hosts and schemes keep the path', () => {
    expect(redactUrls('https://nodes.example.test/a/b.list?t=1')).toBe('https://nodes.example.test/a/b.list?***');
    expect(redactUrls('http://192.0.2.1:8080/a/b')).toBe('http://192.0.2.1:8080/a/b');
    expect(redactUrls('socks5://127.0.0.1:1080/x')).toBe('socks5://127.0.0.1:1080/x');
  });

  test('profile redaction and free text never show the token (managed diff, Surge errors)', () => {
    const profile = ['[Proxy Group]', '# SFE-BEGIN group v1', LINE, '# SFE-END group', '[Rule]', 'FINAL,DIRECT'].join('\n');
    const out = redactProfileText(profile);
    expect(out).not.toContain(TOKEN);
    expect(out).toContain('SFE-ROUTE = select, REJECT, policy-path=http://127.0.0.1:20001/***');
    expect(redactFreeText(`下载 http://127.0.0.1:20001/${TOKEN}/sfe-nodes.list 失败`)).toBe('下载 http://127.0.0.1:20001/*** 失败');
  });
});
