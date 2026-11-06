// 仓库层的公共部分：列映射（camelCase 记录 ↔ snake_case 列）、时间规范化、JSON 列与秘密防护。

import { SfeError } from '@sfe/contract';
import type { Clock, IdGenerator, Scrubber } from '../../ports.js';
import type { Db, Row, SqlValue } from '../db.js';

export interface RepoContext {
  db: Db;
  clock: Clock;
  ids: IdGenerator;
  /** 写入步骤消息、错误消息与错误详情前的脱敏；缺省为只按规则脱敏的实例。 */
  scrubber: Scrubber;
  scrub: (text: string) => string;
}

/** 插入时可省略的自动字段。 */
export type InsertOf<R, Auto extends keyof R> = Omit<R, Auto> & Partial<Pick<R, Auto>>;

/** ISO 时间统一为 toISOString() 形式，保证按字符串比较即按时间比较。 */
export function toIso(value: Date | string): string {
  const d = value instanceof Date ? value : new Date(value);
  const t = d.getTime();
  if (!Number.isFinite(t)) throw new RangeError(`invalid timestamp: ${String(value)}`);
  return d.toISOString();
}

export function nowIso(ctx: RepoContext): string {
  return ctx.clock.now().toISOString();
}

// ---------- 秘密防护 ----------

/**
 * 数据库不保存任何秘密（§2「含秘密的位置」）。JSON 列写入前检查：SecretChange 的替换值，或这些键名下的
 * 字符串/数字值，都视为误把秘密写进数据库，直接拒绝。引用（*_ref、*Ref）与“是否已配置”布尔值不受影响。
 */
const FORBIDDEN_JSON_KEYS =
  /^(password|passwd|passphrase|proxy_password|proxy_username|login_password|username|content_base64|secret|token|session_token|login_code|api_key|apikey|http_api_key|authorization|cookie)$/i;

export function assertNoSecretMaterial(value: unknown, path = '$', seen: Set<object> = new Set()): void {
  if (value === null || typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoSecretMaterial(v, `${path}[${i}]`, seen));
    return;
  }
  const obj = value as Record<string, unknown>;
  if (obj.action === 'replace' && 'value' in obj) throw secretRejected(`${path}.value`);
  for (const [k, v] of Object.entries(obj)) {
    if (FORBIDDEN_JSON_KEYS.test(k) && (typeof v === 'string' || typeof v === 'number' || typeof v === 'bigint') && String(v).length > 0) {
      throw secretRejected(`${path}.${k}`);
    }
    assertNoSecretMaterial(v, `${path}.${k}`, seen);
  }
}

function secretRejected(field: string): SfeError {
  return new SfeError('INTERNAL', '保存记录失败：内容含有秘密字段', { details: { field } });
}

export function toJsonColumn(value: unknown): string {
  assertNoSecretMaterial(value);
  const text = JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
  if (text === undefined) throw new TypeError('value is not JSON-serialisable');
  return text;
}

export function parseJson<T>(text: unknown, fallback: T): T {
  if (text === null || text === undefined) return fallback;
  try {
    return JSON.parse(String(text)) as T;
  } catch {
    return fallback;
  }
}

// ---------- 列映射 ----------

export interface ColumnSpec<V> {
  col: string;
  to(value: V): SqlValue;
  from(raw: unknown): V;
}

export type TableSpec<R> = { [K in keyof R]-?: ColumnSpec<R[K]> };

const str = (raw: unknown): string => (typeof raw === 'string' ? raw : String(raw));
const num = (raw: unknown): number => (typeof raw === 'number' ? raw : Number(raw));

export const col = {
  text<T extends string = string>(name: string): ColumnSpec<T> {
    return { col: name, to: (v) => v, from: (r) => str(r) as T };
  },
  textNull<T extends string = string>(name: string): ColumnSpec<T | null> {
    return { col: name, to: (v) => v ?? null, from: (r) => (r === null || r === undefined ? null : (str(r) as T)) };
  },
  time(name: string): ColumnSpec<string> {
    return { col: name, to: (v) => toIso(v), from: (r) => str(r) };
  },
  timeNull(name: string): ColumnSpec<string | null> {
    return { col: name, to: (v) => (v === null || v === undefined ? null : toIso(v)), from: (r) => (r === null || r === undefined ? null : str(r)) };
  },
  int(name: string): ColumnSpec<number> {
    return { col: name, to: (v) => v, from: (r) => num(r) };
  },
  intNull(name: string): ColumnSpec<number | null> {
    return { col: name, to: (v) => v ?? null, from: (r) => (r === null || r === undefined ? null : num(r)) };
  },
  bool(name: string): ColumnSpec<boolean> {
    return { col: name, to: (v) => (v ? 1 : 0), from: (r) => num(r) === 1 };
  },
  boolNull(name: string): ColumnSpec<boolean | null> {
    return { col: name, to: (v) => (v === null || v === undefined ? null : v ? 1 : 0), from: (r) => (r === null || r === undefined ? null : num(r) === 1) };
  },
  json<T>(name: string, fallback: T): ColumnSpec<T> {
    return { col: name, to: (v) => toJsonColumn(v), from: (r) => parseJson<T>(r, fallback) };
  },
  jsonNull<T>(name: string): ColumnSpec<T | null> {
    return { col: name, to: (v) => (v === null || v === undefined ? null : toJsonColumn(v)), from: (r) => parseJson<T | null>(r, null) };
  },
};

export interface Mapper<R> {
  readonly table: string;
  fromRow(row: Row): R;
  /** INSERT 全部列。 */
  insert(db: Db, rec: R, orClause?: 'OR IGNORE' | 'OR REPLACE'): number;
  /** 按 patch 中出现的字段更新；返回受影响行数。patch 为空时返回 0。 */
  update(db: Db, patch: Partial<R>, where: string, whereParams: SqlValue[]): number;
  columns(keys?: Array<keyof R>): string;
}

export function mapper<R>(table: string, spec: TableSpec<R>): Mapper<R> {
  const keys = Object.keys(spec) as Array<keyof R>;
  return {
    table,
    fromRow(row: Row): R {
      const out = {} as R;
      for (const k of keys) {
        const s = spec[k];
        out[k] = s.from(row[s.col]);
      }
      return out;
    },
    insert(db, rec, orClause) {
      const cols = keys.map((k) => spec[k].col);
      const params = keys.map((k) => spec[k].to(rec[k]));
      const sql = `INSERT ${orClause ?? ''} INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
      return db.run(sql, params).changes;
    },
    update(db, patch, where, whereParams) {
      const sets: string[] = [];
      const params: SqlValue[] = [];
      for (const k of keys) {
        if (!Object.prototype.hasOwnProperty.call(patch, k)) continue;
        const v = patch[k];
        if (v === undefined) continue;
        sets.push(`${spec[k].col} = ?`);
        params.push(spec[k].to(v as R[keyof R]));
      }
      if (sets.length === 0) return 0;
      return db.run(`UPDATE ${table} SET ${sets.join(', ')} WHERE ${where}`, [...params, ...whereParams]).changes;
    },
    columns(subset) {
      return (subset ?? keys).map((k) => spec[k].col).join(', ');
    },
  };
}

export function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(', ');
}
