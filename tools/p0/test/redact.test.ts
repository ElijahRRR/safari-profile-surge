import { describe, expect, it } from 'vitest';
import { redactSummary, redactSummaryLines } from '../src/redact.js';

describe('redactSummary', () => {
  it('masks non-loopback IPv4 and keeps loopback', () => {
    expect(redactSummary('出口 203.0.113.7，本机 127.0.0.1:18080')).toBe('出口 <ip>，本机 127.0.0.1:18080');
  });

  it('masks IPv6 but not times or ::1', () => {
    expect(redactSummary('出口 2001:db8::1 时间 12:30:45 回环 ::1')).toBe('出口 <ip> 时间 12:30:45 回环 ::1');
  });

  it('keeps version-like dotted numbers that are not IPs', () => {
    const s = 'Safari build 20619.2.8.11.12';
    expect(redactSummary(s)).toBe(s);
  });

  it('masks emails', () => {
    expect(redactSummary('账号 buyer01@example.test 已登录')).toBe('账号 <email> 已登录');
  });

  it('masks home directory and other user names', () => {
    expect(redactSummary('/Users/alice/Library/x and /Users/bob/y', { home: '/Users/alice' })).toBe('~/Library/x and /Users/<user>/y');
  });

  it('masks secrets in proxy parameters and http-api lines', () => {
    const out = redactSummary('node = socks5, 192.0.2.1, 1080, username=u1, password=example-secret http-api = k@127.0.0.1:6171');
    expect(out).not.toContain('example-secret');
    expect(out).not.toContain('k@127');
  });

  it('masks URL query and user info', () => {
    const out = redactSummary('https://user:pw@example.test/path?token=abc#frag');
    expect(out).not.toContain('user:pw');
    expect(out).not.toContain('token=abc');
    expect(out).toContain('example.test/path');
  });

  it('masks long mixed tokens but keeps prefixed digests', () => {
    const token = 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7';
    const digest = `hmac-sha256:${'ab12'.repeat(16)}`;
    const out = redactSummary(`令牌 ${token} 摘要 ${digest}`);
    expect(out).toContain('<token>');
    expect(out).not.toContain(token);
    expect(out).toContain(digest);
  });

  it('does not mangle process paths', () => {
    const paths = [
      '/System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.Networking.xpc/Contents/MacOS/com.apple.WebKit.Networking',
      '/Applications/Safari.app/Contents/MacOS/Safari',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ];
    for (const p of paths) expect(redactSummary(p)).toBe(p);
  });

  it('removes control characters', () => {
    expect(redactSummary('a\u0007b\u001bc')).toBe('abc');
  });
});

describe('redactSummaryLines', () => {
  it('joins, redacts each line and truncates', () => {
    const text = redactSummaryLines(['a 203.0.113.9', 'b'], {}, 100);
    expect(text).toBe('a <ip>\nb');
    expect(redactSummaryLines(['x'.repeat(50)], {}, 10)).toHaveLength(10);
  });
});
