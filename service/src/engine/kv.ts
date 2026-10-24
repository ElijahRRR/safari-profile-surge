// 引擎自用的小型键值记录，存放在 meta 表（键带 engine: 前缀，与计数器分开）。只存非秘密的结构化数据：
// 请求幂等台账（非操作类请求）、managed_objects 意图的写前摘要等。写入同样经过秘密字段防护。

import { toJsonColumn } from '../db/repos/common.js';
import type { Db } from '../db/index.js';

const PREFIX = 'engine:';

export interface EngineKv {
  get<T>(key: string): T | null;
  set(key: string, value: unknown): void;
  delete(key: string): void;
  /** 键以 prefix 开头的全部条目。 */
  list<T>(prefix: string): Array<{ key: string; value: T }>;
}

export function createEngineKv(db: Db): EngineKv {
  return {
    get<T>(key: string): T | null {
      const row = db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', [PREFIX + key]);
      if (!row) return null;
      try {
        return JSON.parse(row.value) as T;
      } catch {
        return null;
      }
    },
    set(key: string, value: unknown): void {
      db.run('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [PREFIX + key, toJsonColumn(value)]);
    },
    delete(key: string): void {
      db.run('DELETE FROM meta WHERE key = ?', [PREFIX + key]);
    },
    list<T>(prefix: string) {
      const rows = db.all<{ key: string; value: string }>("SELECT key, value FROM meta WHERE key >= ? AND key < ? ORDER BY key", [
        PREFIX + prefix,
        `${PREFIX}${prefix}￿`,
      ]);
      const out: Array<{ key: string; value: T }> = [];
      for (const r of rows) {
        try {
          out.push({ key: r.key.slice(PREFIX.length), value: JSON.parse(r.value) as T });
        } catch {
          // 损坏的条目忽略
        }
      }
      return out;
    },
  };
}
