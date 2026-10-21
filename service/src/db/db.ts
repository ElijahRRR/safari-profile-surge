// node:sqlite 封装（docs/ARCHITECTURE.md §4、§10）：外键开启、5 秒忙等、文件库用 WAL；
// 数据库文件新建为 0600；迁移按 meta.schema_version 增量执行；事务 BEGIN IMMEDIATE，嵌套用 SAVEPOINT。
// node:sqlite 仍标为实验特性：只过滤它自己的 ExperimentalWarning，其他警告照常输出。

import { closeSync, constants as fsConstants, fchmodSync, fstatSync, openSync } from 'node:fs';
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

export function openDatabase(path: string | ':memory:'): Db {
  const { DatabaseSync } = loadSqlite();
  const isMemory = path === ':memory:';
  if (!isMemory) preparePrivateFile(path);
  const raw = new DatabaseSync(path, { enableForeignKeyConstraints: true });
  raw.exec('PRAGMA foreign_keys = ON');
  raw.exec('PRAGMA busy_timeout = 5000');
  if (!isMemory) {
    raw.exec('PRAGMA journal_mode = WAL');
    // 路由与操作状态必须在提交后可靠落盘
    raw.exec('PRAGMA synchronous = FULL');
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
