// HTTP 测试工具：内存 SQLite（只建会话两张表，DDL 与 db/schema.ts 一致）、可控时钟、记录日志。

import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { createSessionStore, type SessionStore } from '../../src/http/sessions.js';
import type { LogLevel } from '../../src/ports.js';

const require = createRequire(import.meta.url);

export const SESSION_DDL = `
  CREATE TABLE web_sessions (
    token_hash TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    revoked_at TEXT
  );
  CREATE TABLE login_codes (
    code_hash TEXT PRIMARY KEY,
    expires_at TEXT NOT NULL,
    used_at TEXT
  );
`;

let sqlite: typeof import('node:sqlite') | null = null;

function loadSqlite(): typeof import('node:sqlite') {
  if (sqlite) return sqlite;
  const original = process.emitWarning;
  // 只在加载期间屏蔽 node:sqlite 的实验特性警告
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === 'string' ? warning : warning.message;
    if (/SQLite/.test(text)) return;
    return (original as (...a: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    sqlite = require('node:sqlite') as typeof import('node:sqlite');
  } finally {
    process.emitWarning = original;
  }
  return sqlite;
}

export function memoryDb(): DatabaseSync {
  const { DatabaseSync: Db } = loadSqlite();
  const db = new Db(':memory:');
  db.exec(SESSION_DDL);
  return db;
}

export interface TestClock {
  now: () => Date;
  advance(ms: number): void;
  set(iso: string): void;
}

export function testClock(start = '2026-10-21T08:00:00.000Z'): TestClock {
  let t = Date.parse(start);
  return {
    now: () => new Date(t),
    advance(ms) {
      t += ms;
    },
    set(iso) {
      t = Date.parse(iso);
    },
  };
}

export interface LogEntry {
  level: LogLevel;
  msg: string;
  fields?: Record<string, unknown>;
}

export function recordingLogger(): { log(level: LogLevel, msg: string, fields?: Record<string, unknown>): void; entries: LogEntry[]; text(): string } {
  const entries: LogEntry[] = [];
  return {
    entries,
    log(level, msg, fields) {
      entries.push(fields === undefined ? { level, msg } : { level, msg, fields });
    },
    text() {
      return JSON.stringify(entries);
    },
  };
}

export function sessionFixture(clock = testClock()): { db: DatabaseSync; clock: TestClock; sessions: SessionStore } {
  const db = memoryDb();
  const sessions = createSessionStore(db, { now: clock.now, random: (n) => randomBytes(n) });
  return { db, clock, sessions };
}

/** 签发登录码并交换，得到一个有效的会话令牌。 */
export function loginToken(sessions: SessionStore): string {
  const { code } = sessions.issueLoginCode();
  const res = sessions.exchange(code);
  if (!res) throw new Error('exchange failed in fixture');
  return res.token;
}
