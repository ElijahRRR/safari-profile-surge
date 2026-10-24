import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { SfeError } from '@sfe/contract';
import {
  EXCHANGE_RATE_LIMIT,
  LOGIN_CODE_TTL_MS,
  SESSION_ABSOLUTE_TTL_MS,
  SESSION_IDLE_TTL_MS,
  createSessionStore,
  isWellFormedSecret,
} from '../../src/http/sessions.js';
import { loginToken, memoryDb, sessionFixture, testClock } from './helpers.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

describe('login codes', () => {
  test('code is 32 random bytes in base64url and expires in 60 s', () => {
    const { sessions, clock } = sessionFixture();
    const { code, expiresAt } = sessions.issueLoginCode();
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(code, 'base64url')).toHaveLength(32);
    expect(Date.parse(expiresAt) - clock.now().getTime()).toBe(LOGIN_CODE_TTL_MS);
  });

  test('only the sha256 of the code is stored', () => {
    const { sessions, db } = sessionFixture();
    const { code } = sessions.issueLoginCode();
    const rows = db.prepare('SELECT * FROM login_codes').all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.code_hash).toBe(sha(code));
    expect(JSON.stringify(rows)).not.toContain(code);
  });

  test('uses the injected random source', () => {
    const db = memoryDb();
    const clock = testClock();
    const store = createSessionStore(db, { now: clock.now, random: (n) => Buffer.alloc(n, 7) });
    expect(store.issueLoginCode().code).toBe(Buffer.alloc(32, 7).toString('base64url'));
  });

  test('exchange is single use', () => {
    const { sessions } = sessionFixture();
    const { code } = sessions.issueLoginCode();
    const first = sessions.exchange(code);
    expect(first).not.toBeNull();
    expect(sessions.exchange(code)).toBeNull();
  });

  test('exchange fails after 60 s', () => {
    const { sessions, clock } = sessionFixture();
    const { code } = sessions.issueLoginCode();
    clock.advance(LOGIN_CODE_TTL_MS);
    expect(sessions.exchange(code)).toBeNull();
  });

  test('exchange succeeds just before expiry', () => {
    const { sessions, clock } = sessionFixture();
    const { code } = sessions.issueLoginCode();
    clock.advance(LOGIN_CODE_TTL_MS - 1);
    expect(sessions.exchange(code)).not.toBeNull();
  });

  test('unknown and malformed codes return null', () => {
    const { sessions } = sessionFixture();
    expect(sessions.exchange('A'.repeat(43))).toBeNull();
    expect(sessions.exchange('short')).toBeNull();
    expect(sessions.exchange('')).toBeNull();
    expect(sessions.exchange('../../etc/passwd')).toBeNull();
  });

  test('rate limit: 10 attempts per minute, then RATE_LIMITED', () => {
    const { sessions, clock } = sessionFixture();
    for (let i = 0; i < EXCHANGE_RATE_LIMIT.attempts; i++) expect(sessions.exchange('x')).toBeNull();
    const { code } = sessions.issueLoginCode();
    let thrown: unknown;
    try {
      sessions.exchange(code);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SfeError);
    expect((thrown as SfeError).code).toBe('RATE_LIMITED');
    clock.advance(EXCHANGE_RATE_LIMIT.windowMs - 1);
    expect(() => sessions.exchange(code)).toThrow(SfeError);
  });

  test('rate-limited attempt does not consume the code', () => {
    const { sessions, clock } = sessionFixture();
    for (let i = 0; i < EXCHANGE_RATE_LIMIT.attempts; i++) sessions.exchange('x');
    clock.advance(1000);
    const { code } = sessions.issueLoginCode();
    expect(() => sessions.exchange(code)).toThrow(SfeError);
    clock.advance(EXCHANGE_RATE_LIMIT.windowMs - 1000);
    expect(sessions.exchange(code)).not.toBeNull();
  });

  test('rate limit is a sliding window', () => {
    const { sessions, clock } = sessionFixture();
    for (let i = 0; i < 5; i++) sessions.exchange('x');
    clock.advance(30_000);
    for (let i = 0; i < 5; i++) sessions.exchange('x');
    expect(() => sessions.exchange('x')).toThrow(SfeError);
    clock.advance(30_000);
    expect(sessions.exchange('x')).toBeNull();
  });
});

describe('sessions', () => {
  test('token is 32 random bytes; only its sha256 is stored', () => {
    const { sessions, db } = sessionFixture();
    const token = loginToken(sessions);
    expect(isWellFormedSecret(token)).toBe(true);
    const rows = db.prepare('SELECT * FROM web_sessions').all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash).toBe(sha(token));
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  test('validate returns a session id that is not the token or its hash', () => {
    const { sessions } = sessionFixture();
    const token = loginToken(sessions);
    const v = sessions.validate(token);
    expect(v).not.toBeNull();
    expect(v!.sessionId).toMatch(/^web_[0-9a-f]{24}$/);
    expect(v!.sessionId).not.toContain(token);
    expect(sha(token)).not.toContain(v!.sessionId.slice(4));
    expect(sessions.validate(token)!.sessionId).toBe(v!.sessionId);
  });

  test('two sessions get different ids', () => {
    const { sessions } = sessionFixture();
    const a = sessions.validate(loginToken(sessions))!;
    const b = sessions.validate(loginToken(sessions))!;
    expect(a.sessionId).not.toBe(b.sessionId);
  });

  test('unknown or malformed token is rejected', () => {
    const { sessions } = sessionFixture();
    expect(sessions.validate('A'.repeat(43))).toBeNull();
    expect(sessions.validate('nope')).toBeNull();
    expect(sessions.validate('')).toBeNull();
  });

  test('idle expiry after 2 h without requests', () => {
    const { sessions, clock } = sessionFixture();
    const token = loginToken(sessions);
    clock.advance(SESSION_IDLE_TTL_MS - 1000);
    expect(sessions.validate(token)).not.toBeNull();
    clock.advance(SESSION_IDLE_TTL_MS - 1000);
    expect(sessions.validate(token)).not.toBeNull();
    clock.advance(SESSION_IDLE_TTL_MS);
    expect(sessions.validate(token)).toBeNull();
  });

  test('validate updates last_seen_at; touch=false does not', () => {
    const { sessions, clock, db } = sessionFixture();
    const token = loginToken(sessions);
    const lastSeen = () => (db.prepare('SELECT last_seen_at FROM web_sessions').get() as { last_seen_at: string }).last_seen_at;
    const t0 = lastSeen();
    clock.advance(60_000);
    expect(sessions.validate(token, { touch: false })).not.toBeNull();
    expect(lastSeen()).toBe(t0);
    sessions.validate(token);
    expect(lastSeen()).toBe(clock.now().toISOString());
  });

  test('last_seen_at is written at most once a minute', () => {
    const { sessions, clock, db } = sessionFixture();
    const token = loginToken(sessions);
    const lastSeen = () => (db.prepare('SELECT last_seen_at FROM web_sessions').get() as { last_seen_at: string }).last_seen_at;
    const t0 = lastSeen();
    clock.advance(30_000);
    sessions.validate(token);
    expect(lastSeen()).toBe(t0);
    clock.advance(30_000);
    sessions.validate(token);
    expect(lastSeen()).toBe(clock.now().toISOString());
  });

  test('touch=false never extends the idle window', () => {
    const { sessions, clock } = sessionFixture();
    const token = loginToken(sessions);
    for (let i = 0; i < 8; i++) {
      clock.advance(15 * 60_000);
      sessions.validate(token, { touch: false });
    }
    expect(sessions.validate(token, { touch: false })).toBeNull();
  });

  test('absolute expiry after 12 h even with activity', () => {
    const { sessions, clock } = sessionFixture();
    const token = loginToken(sessions);
    for (let elapsed = 0; elapsed < SESSION_ABSOLUTE_TTL_MS - 3_600_000; elapsed += 3_600_000) {
      clock.advance(3_600_000);
      expect(sessions.validate(token)).not.toBeNull();
    }
    clock.advance(3_600_000);
    expect(sessions.validate(token)).toBeNull();
  });

  test('expiresAt is the earlier of absolute and idle expiry', () => {
    const { sessions, clock } = sessionFixture();
    const token = loginToken(sessions);
    const start = clock.now().getTime();
    expect(Date.parse(sessions.validate(token)!.expiresAt)).toBe(start + SESSION_IDLE_TTL_MS);
    clock.advance(60_000);
    expect(Date.parse(sessions.validate(token)!.expiresAt)).toBe(start + 60_000 + SESSION_IDLE_TTL_MS);
  });

  test('expiresAt near the absolute limit is capped', () => {
    const { sessions, clock } = sessionFixture();
    const token = loginToken(sessions);
    const start = clock.now().getTime();
    for (let i = 0; i < 11; i++) {
      clock.advance(3_600_000);
      sessions.validate(token);
    }
    clock.advance(30 * 60_000);
    expect(Date.parse(sessions.validate(token)!.expiresAt)).toBe(start + SESSION_ABSOLUTE_TTL_MS);
  });

  test('revoke ends the session', () => {
    const { sessions } = sessionFixture();
    const token = loginToken(sessions);
    expect(sessions.revoke(token)).toBe(true);
    expect(sessions.validate(token)).toBeNull();
    expect(sessions.revoke(token)).toBe(false);
  });

  test('revoking one session leaves others valid', () => {
    const { sessions } = sessionFixture();
    const a = loginToken(sessions);
    const b = loginToken(sessions);
    sessions.revoke(a);
    expect(sessions.validate(b)).not.toBeNull();
  });

  test('purgeExpired removes used codes and expired sessions', () => {
    const { sessions, clock, db } = sessionFixture();
    const token = loginToken(sessions);
    sessions.issueLoginCode();
    clock.advance(SESSION_IDLE_TTL_MS + 1);
    sessions.purgeExpired();
    expect((db.prepare('SELECT COUNT(*) AS n FROM web_sessions').get() as { n: number }).n).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM login_codes').get() as { n: number }).n).toBe(0);
    expect(sessions.validate(token)).toBeNull();
  });
});
