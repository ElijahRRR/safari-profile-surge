// 网页会话（docs/ARCHITECTURE.md §2、§7.1）：一次性登录码换取会话令牌，不用 Cookie。
// 登录码与令牌都只存 SHA-256（两者都是 256 位随机值，无需加盐即不可逆推）；明文只在签发时返回一次。
// 登录码 60 秒、单次；会话绝对 12 小时、空闲 2 小时。交换端点在内存中限速。

import { createHash } from 'node:crypto';
import { SfeError } from '@sfe/contract';

export const LOGIN_CODE_TTL_MS = 60_000;
export const SESSION_ABSOLUTE_TTL_MS = 12 * 60 * 60 * 1000;
export const SESSION_IDLE_TTL_MS = 2 * 60 * 60 * 1000;
export const EXCHANGE_RATE_LIMIT = { attempts: 10, windowMs: 60_000 } as const;
/** last_seen_at 最多每分钟写一次：减少每个请求都写库（空闲判断精度损失不超过 1 分钟）。 */
export const SESSION_TOUCH_INTERVAL_MS = 60_000;
/** 登录码与令牌：32 字节随机数的 base64url（无填充，43 个字符）。 */
export const SECRET_BYTES = 32;
const SECRET_RE = /^[A-Za-z0-9_-]{43}$/;

/** 最小的 SQLite 依赖面：node:sqlite 的 DatabaseSync 满足。 */
export interface SessionDb {
  prepare(sql: string): any;
}

export interface SessionStoreOptions {
  now: () => Date;
  random: (n: number) => Buffer;
}

export interface SessionValidation {
  /** 审计用会话编号：由令牌哈希再派生，不能用来认证。 */
  sessionId: string;
  /** 绝对过期与空闲过期中较早者。 */
  expiresAt: string;
}

export interface SessionStore {
  issueLoginCode(): { code: string; expiresAt: string };
  /** 登录码有效则作废并签发会话令牌；无效返回 null；超出限速抛 RATE_LIMITED。 */
  exchange(code: string): { token: string; expiresAt: string } | null;
  /** touch=false 只检查不续期（事件流心跳用，避免打开的页面让会话永不空闲过期）。 */
  validate(token: string, opts?: { touch?: boolean }): SessionValidation | null;
  revoke(token: string): boolean;
  /** 删除已过期的登录码与会话行。 */
  purgeExpired(): void;
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function sessionIdFromTokenHash(tokenHash: string): string {
  return `web_${createHash('sha256').update(`sfe.session-id:${tokenHash}`, 'utf8').digest('hex').slice(0, 24)}`;
}

export function isWellFormedSecret(value: unknown): value is string {
  return typeof value === 'string' && SECRET_RE.test(value);
}

interface SessionRow {
  token_hash: string;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  revoked_at: string | null;
}

interface CodeRow {
  code_hash: string;
  expires_at: string;
  used_at: string | null;
}

function ms(iso: string): number {
  const t = Date.parse(iso);
  // 无法解析的时间按已过期处理
  return Number.isFinite(t) ? t : 0;
}

export function createSessionStore(db: SessionDb, opts: SessionStoreOptions): SessionStore {
  const attempts: number[] = [];

  const stmt = {
    insertCode: db.prepare('INSERT INTO login_codes (code_hash, expires_at, used_at) VALUES (?, ?, NULL)'),
    getCode: db.prepare('SELECT code_hash, expires_at, used_at FROM login_codes WHERE code_hash = ?'),
    useCode: db.prepare('UPDATE login_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL'),
    insertSession: db.prepare('INSERT INTO web_sessions (token_hash, created_at, last_seen_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, NULL)'),
    getSession: db.prepare('SELECT token_hash, created_at, last_seen_at, expires_at, revoked_at FROM web_sessions WHERE token_hash = ?'),
    touchSession: db.prepare('UPDATE web_sessions SET last_seen_at = ? WHERE token_hash = ? AND revoked_at IS NULL'),
    revokeSession: db.prepare('UPDATE web_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL'),
    purgeCodes: db.prepare('DELETE FROM login_codes WHERE expires_at < ? OR used_at IS NOT NULL'),
    purgeSessions: db.prepare('DELETE FROM web_sessions WHERE expires_at < ? OR revoked_at IS NOT NULL OR last_seen_at < ?'),
  };

  function newSecret(): string {
    const bytes = opts.random(SECRET_BYTES);
    if (!Buffer.isBuffer(bytes) || bytes.length < SECRET_BYTES) throw new SfeError('INTERNAL', '服务内部错误');
    return bytes.subarray(0, SECRET_BYTES).toString('base64url');
  }

  function effectiveExpiry(row: SessionRow, lastSeenMs: number): number {
    return Math.min(ms(row.expires_at), lastSeenMs + SESSION_IDLE_TTL_MS);
  }

  function checkRateLimit(nowMs: number): void {
    while (attempts.length > 0 && nowMs - attempts[0]! >= EXCHANGE_RATE_LIMIT.windowMs) attempts.shift();
    if (attempts.length >= EXCHANGE_RATE_LIMIT.attempts) {
      throw new SfeError('RATE_LIMITED', '登录失败：尝试次数过多，请 1 分钟后重新打开');
    }
    attempts.push(nowMs);
  }

  const store: SessionStore = {
    issueLoginCode() {
      const now = opts.now();
      store.purgeExpired();
      const code = newSecret();
      const expiresAt = new Date(now.getTime() + LOGIN_CODE_TTL_MS).toISOString();
      stmt.insertCode.run(sha256Hex(code), expiresAt);
      return { code, expiresAt };
    },

    exchange(code) {
      const now = opts.now();
      const nowMs = now.getTime();
      checkRateLimit(nowMs);
      if (!isWellFormedSecret(code)) return null;
      const codeHash = sha256Hex(code);
      const row = stmt.getCode.get(codeHash) as CodeRow | undefined;
      if (!row || row.used_at !== null || ms(row.expires_at) <= nowMs) return null;
      // 条件更新保证单次使用：并发的第二次交换 changes 为 0
      const used = stmt.useCode.run(now.toISOString(), codeHash) as { changes: number | bigint };
      if (Number(used.changes) !== 1) return null;
      const token = newSecret();
      const createdAt = now.toISOString();
      const absolute = new Date(nowMs + SESSION_ABSOLUTE_TTL_MS).toISOString();
      stmt.insertSession.run(sha256Hex(token), createdAt, createdAt, absolute);
      return { token, expiresAt: new Date(Math.min(nowMs + SESSION_IDLE_TTL_MS, nowMs + SESSION_ABSOLUTE_TTL_MS)).toISOString() };
    },

    validate(token, validateOpts) {
      if (!isWellFormedSecret(token)) return null;
      const nowMs = opts.now().getTime();
      const tokenHash = sha256Hex(token);
      const row = stmt.getSession.get(tokenHash) as SessionRow | undefined;
      if (!row || row.revoked_at !== null) return null;
      if (ms(row.expires_at) <= nowMs) return null;
      if (nowMs - ms(row.last_seen_at) >= SESSION_IDLE_TTL_MS) return null;
      let lastSeenMs = ms(row.last_seen_at);
      if (validateOpts?.touch !== false && nowMs - lastSeenMs >= SESSION_TOUCH_INTERVAL_MS) {
        stmt.touchSession.run(new Date(nowMs).toISOString(), tokenHash);
        lastSeenMs = nowMs;
      }
      return { sessionId: sessionIdFromTokenHash(tokenHash), expiresAt: new Date(effectiveExpiry(row, lastSeenMs)).toISOString() };
    },

    revoke(token) {
      if (!isWellFormedSecret(token)) return false;
      const res = stmt.revokeSession.run(opts.now().toISOString(), sha256Hex(token)) as { changes: number | bigint };
      return Number(res.changes) > 0;
    },

    purgeExpired() {
      const now = opts.now();
      const nowIso = now.toISOString();
      stmt.purgeCodes.run(nowIso);
      stmt.purgeSessions.run(nowIso, new Date(now.getTime() - SESSION_IDLE_TTL_MS).toISOString());
    },
  };
  return store;
}
