// 前置代理。默认前置的唯一来源是 front_proxies.is_default（部分唯一索引保证最多一个）。

import type { FrontProxyState } from '@sfe/contract';
import { col, mapper, nowIso, type InsertOf, type RepoContext } from './common.js';

export interface FrontProxyRecord {
  id: string;
  surgeName: string;
  kind: 'node';
  state: FrontProxyState;
  isDefault: boolean;
  retired: boolean;
  lastCheckedAt: string | null;
  createdAt: string;
}

const frontMap = mapper<FrontProxyRecord>('front_proxies', {
  id: col.text('id'),
  surgeName: col.text('surge_name'),
  kind: col.text<'node'>('kind'),
  state: col.text<FrontProxyState>('state'),
  isDefault: col.bool('is_default'),
  retired: col.bool('retired'),
  lastCheckedAt: col.timeNull('last_checked_at'),
  createdAt: col.time('created_at'),
});

export interface FrontProxiesRepo {
  /** 默认包含已停用的；按登记时间排序。 */
  list(opts?: { includeRetired?: boolean }): FrontProxyRecord[];
  get(id: string): FrontProxyRecord | null;
  byName(surgeName: string): FrontProxyRecord | null;
  /** isDefault 为 true 时在同一事务中清除原默认值。 */
  insert(rec: InsertOf<FrontProxyRecord, 'createdAt' | 'lastCheckedAt' | 'isDefault' | 'retired' | 'kind'>): FrontProxyRecord;
  /** patch.isDefault 为 true 时在同一事务中清除原默认值。 */
  update(id: string, patch: Partial<Omit<FrontProxyRecord, 'id' | 'createdAt'>>): boolean;
  /** 设为默认（null 表示清除默认）；在同一事务中清除原默认值。返回目标是否存在。 */
  setDefault(id: string | null): boolean;
  getDefault(): FrontProxyRecord | null;
}

export function createFrontProxiesRepo(ctx: RepoContext): FrontProxiesRepo {
  const { db } = ctx;
  const clearDefault = () => db.run('UPDATE front_proxies SET is_default = 0 WHERE is_default = 1');
  const repo: FrontProxiesRepo = {
    list(opts) {
      const where = opts?.includeRetired === false ? 'WHERE retired = 0' : '';
      return db.all(`SELECT * FROM front_proxies ${where} ORDER BY created_at, id`).map(frontMap.fromRow);
    },
    get(id) {
      const row = db.get('SELECT * FROM front_proxies WHERE id = ?', [id]);
      return row ? frontMap.fromRow(row) : null;
    },
    byName(surgeName) {
      const row = db.get('SELECT * FROM front_proxies WHERE surge_name = ?', [surgeName]);
      return row ? frontMap.fromRow(row) : null;
    },
    insert(rec) {
      const full: FrontProxyRecord = {
        ...rec,
        kind: rec.kind ?? 'node',
        isDefault: rec.isDefault ?? false,
        retired: rec.retired ?? false,
        lastCheckedAt: rec.lastCheckedAt ?? null,
        createdAt: rec.createdAt ?? nowIso(ctx),
      };
      return db.tx(() => {
        if (full.isDefault) clearDefault();
        frontMap.insert(db, full);
        return repo.get(full.id)!;
      });
    },
    update(id, patch) {
      return db.tx(() => {
        if (!repo.get(id)) return false;
        if (patch.isDefault === true) clearDefault();
        frontMap.update(db, patch, 'id = ?', [id]);
        return true;
      });
    },
    setDefault(id) {
      return db.tx(() => {
        if (id !== null && !repo.get(id)) return false;
        clearDefault();
        if (id !== null) db.run('UPDATE front_proxies SET is_default = 1 WHERE id = ?', [id]);
        return true;
      });
    },
    getDefault() {
      const row = db.get('SELECT * FROM front_proxies WHERE is_default = 1');
      return row ? frontMap.fromRow(row) : null;
    },
  };
  return repo;
}
