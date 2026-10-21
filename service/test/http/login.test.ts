import { describe, expect, test } from 'vitest';
import { SfeError } from '@sfe/contract';
import { buildLoginUrl, issueLoginUrl } from '../../src/http/login.js';
import { sessionFixture } from './helpers.js';

describe('issueLoginUrl', () => {
  test('builds the exchange URL on the bound address', () => {
    const { sessions } = sessionFixture();
    const res = issueLoginUrl(sessions, { boundUrl: () => 'http://127.0.0.1:61847' });
    expect(res.url).toMatch(/^http:\/\/127\.0\.0\.1:61847\/auth\/exchange\?code=[A-Za-z0-9_-]{43}$/);
    const code = new URL(res.url).searchParams.get('code')!;
    expect(sessions.exchange(code)).not.toBeNull();
  });

  test('refuses when HTTP is not bound and does not issue a code', () => {
    const { sessions, db } = sessionFixture();
    expect(() => issueLoginUrl(sessions, { boundUrl: () => null })).toThrow(SfeError);
    expect((db.prepare('SELECT COUNT(*) AS n FROM login_codes').get() as { n: number }).n).toBe(0);
  });

  test('buildLoginUrl encodes the code', () => {
    expect(buildLoginUrl('http://localhost:1', 'a+b')).toBe('http://localhost:1/auth/exchange?code=a%2Bb');
  });
});
