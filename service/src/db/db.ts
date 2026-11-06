// node:sqlite 封装（docs/ARCHITECTURE.md §4、§10）：外键开启、5 秒忙等、文件库用 WAL；
// 数据库文件新建为 0600，-wal/-shm/-journal 打开前后都确认为 0600（数据库以明文保存代理凭据与账号密码，只靠
// 所有者专用的文件权限保护）；secure_delete 开启，删除的内容在页内清零（明文秘密删除后不留在空闲空间中）；
// 迁移按 meta.schema_version 增量执行；事务 BEGIN IMMEDIATE，嵌套用 SAVEPOINT。
// node:sqlite 仍标为实验特性：只过滤它自己的 ExperimentalWarning，其他警告照常输出。

import { chmodSync, closeSync, constants as fsConstants, fchmodSync, fstatSync, lstatSync, openSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { DatabaseSync, SQLInputValue, StatementSync } from 'node:sqlite';
import { SfeError } from '@sfe/contract';
import { MIGRATIONS } from './schema.js';

type SqliteModule = typeof import('node:sqlite');

let sqliteModule: SqliteModule | null = null;

/** 只吞掉 node:sqlite 的实验特性警告（按类型与消息判断）。 */
export function isSqliteExperimentalWarning(warning: unknown, typeOrOptions?: unknown): boolean {
  const message = typeof warning === 'string' ? warning : warning instanceof Error ? warning.message : '';
  const type =
    warning instanceof Error
      ? warning.name
      : typeof typeOrOptions === 'string'
        ? typeOrOptions
        : typeof typeOrOptions === 'object' && typeOrOptions !== null
          ? String((typeOrOptions as { type?: unknown }).type ?? '')
          : '';
  return type === 'ExperimentalWarning' && /\bSQLite\b/.test(message);
}

function loadSqlite(): SqliteModule {
  if (sqliteModule) return sqliteModule;
  const require = createRequire(import.meta.url);
  const original = process.emitWarning;
  // 只在加载期间临时包装：加载时 Node 发出唯一一次实验警告
  process.emitWarning = function patchedEmitWarning(this: unknown, warning: string | Error, ...rest: unknown[]) {
    if (isSqliteExperimentalWarning(warning, rest[0])) return;
    return (original as (...a: unknown[]) => void).call(process, warning, ...rest);
  } as typeof process.emitWarning;
  try {
    sqliteModule = require('node:sqlite') as SqliteModule;
  } finally {
    process.emitWarning = original;
  }
  return sqliteModule;
}

export type SqlValue = string | number | bigint | null | Uint8Array | boolean | undefined;
export type SqlParams = SqlValue[] | Record<string, SqlValue>;
export type Row = Record<string, unknown>;

export interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

export interface Db {
  readonly path: string;
  /** 底层连接；只在仓库层之外确实需要时使用。 */
  readonly raw: DatabaseSync;
  exec(sql: string): void;
  run(sql: string, params?: SqlParams): RunResult;
  get<T extends Row = Row>(sql: string, params?: SqlParams): T | undefined;
  all<T extends Row = Row>(sql: string, params?: SqlParams): T[];
  /** 按 MIGRATIONS 增量迁移（幂等）。返回迁移前后的版本。 */
  migrate(): { from: number; to: number };
  schemaVersion(): number;
  /**
   * 同步事务：最外层 BEGIN IMMEDIATE，嵌套为 SAVEPOINT；fn 抛错时回滚本层并重新抛出。
   * fn 必须是同步的（返回 Promise 视为编程错误：回滚并抛错），避免在事务中跨越 await。
   */
  tx<T>(fn: () => T): T;
  inTransaction(): boolean;
  /**
   * 把 WAL 全部写回数据库文件并把 -wal 截断为 0 字节（PRAGMA wal_checkpoint(TRUNCATE)），清除旧帧中的内容副本
   * （例如刚删除的明文秘密）。事务中不执行；不等待锁（不经 busy_timeout），有其他读者持有旧快照时立即返回、可能只完成一部分。
   * 返回是否完整完成。
   */
  checkpointTruncate(): boolean;
  close(): void;
}

function normalizeValue(v: SqlValue): SQLInputValue {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v as SQLInputValue;
}

function normalizeParams(params: SqlParams | undefined): SQLInputValue[] | Record<string, SQLInputValue> {
  if (params === undefined) return [];
  if (Array.isArray(params)) return params.map(normalizeValue);
  const out: Record<string, SQLInputValue> = {};
  for (const [k, v] of Object.entries(params)) out[k] = normalizeValue(v);
  return out;
}

/** 新建（或收紧）数据库文件为 0600；拒绝符号链接与不属于当前用户的文件。 */
function preparePrivateFile(path: string): void {
  const fd = openSync(path, fsConstants.O_RDWR | fsConstants.O_CREAT | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new SfeError('UNSAFE_LOCATION', '打开数据库失败：路径不是普通文件');
    const uid = process.getuid?.();
    if (uid !== undefined && st.uid !== uid) throw new SfeError('UNSAFE_LOCATION', '打开数据库失败：数据库文件不属于当前用户');
    if ((st.mode & 0o077) !== 0) fchmodSync(fd, 0o600);
  } finally {
    closeSync(fd);
  }
}

/** SQLite 在数据库旁边创建的文件：WAL 模式的 -wal/-shm，以及回滚日志 -journal。 */
export const SQLITE_SIDECAR_SUFFIXES = ['-wal', '-shm', '-journal'] as const;

/**
 * 已存在的旁路文件收紧为 0600；拒绝符号链接、非普通文件与不属于当前用户的文件。SQLite 按数据库文件的权限新建它们
 * （数据库为 0600 时也是 0600），这里在打开前收紧旧文件、打开后再确认一次。
 */
export function preparePrivateSidecars(path: string): void {
  for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
    const p = `${path}${suffix}`;
    let st;
    try {
      st = lstatSync(p);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    if (st.isSymbolicLink() || !st.isFile()) throw new SfeError('UNSAFE_LOCATION', '打开数据库失败：数据库旁路文件不是普通文件');
    const uid = process.getuid?.();
    if (uid !== undefined && st.uid !== uid) throw new SfeError('UNSAFE_LOCATION', '打开数据库失败：数据库旁路文件不属于当前用户');
    if ((st.mode & 0o077) !== 0) chmodSync(p, 0o600);
  }
}

/** 普通读写等待其他连接释放锁的上限（busy_timeout）。 */
const BUSY_TIMEOUT_MS = 5000;

export function openDatabase(path: string | ':memory:'): Db {
  const { DatabaseSync } = loadSqlite();
  const isMemory = path === ':memory:';
  if (!isMemory) {
    preparePrivateFile(path);
    preparePrivateSidecars(path);
  }
  const raw = new DatabaseSync(path, { enableForeignKeyConstraints: true });
  raw.exec('PRAGMA foreign_keys = ON');
  raw.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  // 删除或改写的内容用零覆盖（node 内置 SQLite 缺省关闭）：被删除的明文秘密不留在数据库文件的空闲页中。
  // WAL 中旧帧的副本由删除秘密后的 checkpoint 清除（checkpointTruncate）
  raw.exec('PRAGMA secure_delete = ON');
  if (!isMemory) {
    raw.exec('PRAGMA journal_mode = WAL');
    // 路由与操作状态必须在提交后可靠落盘
    raw.exec('PRAGMA synchronous = FULL');
    // WAL 模式下 -wal/-shm 已创建：再确认一次权限
    try {
      preparePrivateSidecars(path);
    } catch (err) {
      raw.close();
      throw err;
    }
  }
  raw.exec('PRAGMA trusted_schema = OFF');

  const statements = new Map<string, StatementSync>();
  let depth = 0;
  let savepointSeq = 0;
  let closed = false;

  function stmt(sql: string): StatementSync {
    if (closed) throw new Error('database is closed');
    let s = statements.get(sql);
    if (!s) {
      s = raw.prepare(sql);
      statements.set(sql, s);
    }
    return s;
  }

  function call<R>(sql: string, params: SqlParams | undefined, fn: (s: StatementSync, p: SQLInputValue[] | Record<string, SQLInputValue>) => R): R {
    return fn(stmt(sql), normalizeParams(params));
  }

  const db: Db = {
    path,
    raw,
    exec(sql: string): void {
      if (closed) throw new Error('database is closed');
      raw.exec(sql);
    },
    run(sql, params) {
      return call(sql, params, (s, p) => {
        const r = Array.isArray(p) ? s.run(...p) : s.run(p);
        return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
      });
    },
    get<T extends Row = Row>(sql: string, params?: SqlParams): T | undefined {
      return call(sql, params, (s, p) => (Array.isArray(p) ? s.get(...p) : s.get(p))) as T | undefined;
    },
    all<T extends Row = Row>(sql: string, params?: SqlParams): T[] {
      return call(sql, params, (s, p) => (Array.isArray(p) ? s.all(...p) : s.all(p))) as T[];
    },
    schemaVersion(): number {
      const hasMeta = raw.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get();
      if (!hasMeta) return 0;
      const row = raw.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value?: string } | undefined;
      const v = row?.value === undefined ? 0 : Number(row.value);
      return Number.isInteger(v) && v >= 0 ? v : 0;
    },
    migrate() {
      const from = db.schemaVersion();
      if (from > MIGRATIONS.length) {
        throw new SfeError('INTERNAL', '打开数据库失败：数据库版本高于当前程序，请使用更新的版本');
      }
      for (let i = from; i < MIGRATIONS.length; i++) {
        db.tx(() => {
          raw.exec(MIGRATIONS[i]!);
          raw
            .prepare("INSERT INTO meta(key, value) VALUES('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
            .run(String(i + 1));
        });
      }
      return { from, to: MIGRATIONS.length };
    },
    tx<T>(fn: () => T): T {
      if (closed) throw new Error('database is closed');
      if (depth === 0) {
        raw.exec('BEGIN IMMEDIATE');
        depth++;
        try {
          const result = fn();
          assertSync(result);
          raw.exec('COMMIT');
          return result;
        } catch (err) {
          if (raw.isTransaction) raw.exec('ROLLBACK');
          throw err;
        } finally {
          depth--;
        }
      }
      const name = `sfe_sp_${++savepointSeq}`;
      raw.exec(`SAVEPOINT ${name}`);
      depth++;
      try {
        const result = fn();
        assertSync(result);
        raw.exec(`RELEASE ${name}`);
        return result;
      } catch (err) {
        if (raw.isTransaction) {
          raw.exec(`ROLLBACK TO ${name}`);
          raw.exec(`RELEASE ${name}`);
        }
        throw err;
      } finally {
        depth--;
      }
    },
    inTransaction(): boolean {
      return depth > 0;
    },
    checkpointTruncate(): boolean {
      if (closed) throw new Error('database is closed');
      if (depth > 0 || raw.isTransaction) return false;
      if (isMemory) return true;
      // 不经忙等待：TRUNCATE 要等全部读者用上最新快照，经忙处理器（busy_timeout）时另一个程序（数据库浏览器、sqlite3 中开着的
      // 读事务）持有读快照会让同步的 node:sqlite 冻结整个服务直到超时（每删除一个值一次，清扫还占着执行器）。忙时立即返回
      // false，由调用方留到之后再试（LocalSecretStore：下一次删除或清扫）
      raw.exec('PRAGMA busy_timeout = 0');
      try {
        const row = raw.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy?: number } | undefined;
        return Number(row?.busy ?? 1) === 0;
      } finally {
        raw.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
      }
    },
    close(): void {
      if (closed) return;
      closed = true;
      statements.clear();
      raw.close();
    },
  };
  return db;
}

function assertSync(result: unknown): void {
  if (result !== null && typeof result === 'object' && typeof (result as { then?: unknown }).then === 'function') {
    // 避免未处理的拒绝：吞掉这个 Promise 的结果，只报告误用
    (result as Promise<unknown>).then(
      () => undefined,
      () => undefined,
    );
    throw new TypeError('db.tx callback must be synchronous');
  }
}
