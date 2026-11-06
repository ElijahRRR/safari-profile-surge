// 网页会话与一次性登录码：只存哈希（由调用方用带密钥 HMAC 计算），从不存令牌或登录码本身。

import { col, mapper, nowIso, toIso, type InsertOf, type RepoContext } from './common.js';

export interface WebSessionRecord {
  tokenHash: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  revokedAt: string | null;
}

const sessionMap = mapper<WebSessionRecord>('web_sessions', {
  tokenHash: col.text('token_hash'),
  createdAt: col.time('created_at'),
  lastSeenAt: col.time('last_seen_at'),
  expiresAt: col.time('expires_at'),
  revokedAt: col.timeNull('revoked_at'),
});

export interface WebSessionsRepo {
  insert(rec: InsertOf<WebSessionRecord, 'createdAt' | 'lastSeenAt' | 'revokedAt'>): WebSessionRecord;
  get(tokenHash: string): WebSessionRecord | null;
  /** 更新最近活动时间（空闲过期判断用）；已撤销的不更新。 */
  touch(tokenHash: string, at?: Date | string): boolean;
  revoke(tokenHash: string, at?: Date | string): boolean;
  revokeAll(at?: Date | string): number;
  /** 删除绝对过期或已撤销的会话。返回条数。 */
  deleteExpired(now: Date | string): number;
  listActive(now: Date | string): WebSessionRecord[];
}

export function createWebSessionsRepo(ctx: RepoContext): WebSessionsRepo {
  const { db } = ctx;
  const t = (at?: Date | string) => (at === undefined ? nowIso(ctx) : toIso(at));
  const repo: WebSessionsRepo = {
    insert(rec) {
      const now = nowIso(ctx);
      sessionMap.insert(db, { ...rec, createdAt: rec.createdAt ?? now, lastSeenAt: rec.lastSeenAt ?? rec.createdAt ?? now, revokedAt: rec.revokedAt ?? null });
      return repo.get(rec.tokenHash)!;
    },
    get(tokenHash) {
      const row = db.get('SELECT * FROM web_sessions WHERE token_hash = ?', [tokenHash]);
      return row ? sessionMap.fromRow(row) : null;
    },
    touch: (tokenHash, at) => db.run('UPDATE web_sessions SET last_seen_at = ? WHERE token_hash = ? AND revoked_at IS NULL', [t(at), tokenHash]).changes === 1,
    revoke: (tokenHash, at) => db.run('UPDATE web_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL', [t(at), tokenHash]).changes === 1,
    revokeAll: (at) => db.run('UPDATE web_sessions SET revoked_at = ? WHERE revoked_at IS NULL', [t(at)]).changes,
    deleteExpired: (now) => db.run('DELETE FROM web_sessions WHERE expires_at <= ? OR revoked_at IS NOT NULL', [toIso(now)]).changes,
    listActive: (now) => db.all('SELECT * FROM web_sessions WHERE revoked_at IS NULL AND expires_at > ? ORDER BY created_at', [toIso(now)]).map(sessionMap.fromRow),
  };
  return repo;
}

export interface LoginCodeRecord {
  codeHash: string;
  expiresAt: string;
  usedAt: string | null;
}

const codeMap = mapper<LoginCodeRecord>('login_codes', {
  codeHash: col.text('code_hash'),
  expiresAt: col.time('expires_at'),
  usedAt: col.timeNull('used_at'),
});

export interface LoginCodesRepo {
  insert(rec: InsertOf<LoginCodeRecord, 'usedAt'>): LoginCodeRecord;
  get(codeHash: string): LoginCodeRecord | null;
  /** 单次使用：只有未使用且未过期（expiresAt > now）时标记为已用并返回 true。 */
  consume(codeHash: string, now: Date | string): boolean;
  deleteExpired(now: Date | string): number;
}

export function createLoginCodesRepo(ctx: RepoContext): LoginCodesRepo {
  const { db } = ctx;
  const repo: LoginCodesRepo = {
    insert(rec) {
      codeMap.insert(db, { ...rec, usedAt: rec.usedAt ?? null });
      return repo.get(rec.codeHash)!;
    },
    get(codeHash) {
      const row = db.get('SELECT * FROM login_codes WHERE code_hash = ?', [codeHash]);
      return row ? codeMap.fromRow(row) : null;
    },
    consume(codeHash, now) {
      const n = toIso(now);
      return db.run('UPDATE login_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?', [n, codeHash, n]).changes === 1;
    },
    deleteExpired: (now) => db.run('DELETE FROM login_codes WHERE expires_at <= ? OR used_at IS NOT NULL', [toIso(now)]).changes,
  };
  return repo;
}
