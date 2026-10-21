// 秘密引用（docs/ARCHITECTURE.md §4）：数据库只记录引用、种类、归属与状态，从不记录值。

import { col, mapper, nowIso, toIso, type InsertOf, type RepoContext } from './common.js';

export type SecretKind = 'proxy' | 'account' | 'system';
export type SecretRefState = 'pending' | 'committed' | 'orphaned';

export interface SecretRefRecord {
  ref: string;
  kind: SecretKind;
  ownerKind: string;
  ownerId: string;
  state: SecretRefState;
  createdAt: string;
}

const refMap = mapper<SecretRefRecord>('secret_refs', {
  ref: col.text('ref'),
  kind: col.text<SecretKind>('kind'),
  ownerKind: col.text('owner_kind'),
  ownerId: col.text('owner_id'),
  state: col.text<SecretRefState>('state'),
  createdAt: col.time('created_at'),
});

export interface SecretRefsRepo {
  insertPending(rec: InsertOf<Omit<SecretRefRecord, 'state'>, 'createdAt'>): SecretRefRecord;
  get(ref: string): SecretRefRecord | null;
  /** 只有 pending → committed；返回是否发生了转换。 */
  markCommitted(ref: string): boolean;
  /** committed 或 pending → orphaned；返回是否发生了转换。 */
  markOrphaned(ref: string): boolean;
  /** 回到 committed（清扫时发现仍被引用）。 */
  restoreCommitted(ref: string): boolean;
  listOrphaned(): SecretRefRecord[];
  /** createdAt 早于 before 的 pending 引用。 */
  listStalePending(before: Date | string): SecretRefRecord[];
  listByOwner(ownerKind: string, ownerId: string): SecretRefRecord[];
  delete(ref: string): boolean;
  /**
   * 是否仍被引用：非 retired 的代理版本（用户名或密码引用）、账号密码引用、或任一设置值中出现该引用。
   * 引用是带随机部分的不透明串，设置值按子串匹配不会误判。
   */
  isReferenced(ref: string): boolean;
}

export function createSecretRefsRepo(ctx: RepoContext): SecretRefsRepo {
  const { db } = ctx;
  const repo: SecretRefsRepo = {
    insertPending(rec) {
      refMap.insert(db, { ...rec, state: 'pending', createdAt: rec.createdAt ?? nowIso(ctx) });
      return repo.get(rec.ref)!;
    },
    get(ref) {
      const row = db.get('SELECT * FROM secret_refs WHERE ref = ?', [ref]);
      return row ? refMap.fromRow(row) : null;
    },
    markCommitted: (ref) => db.run("UPDATE secret_refs SET state = 'committed' WHERE ref = ? AND state = 'pending'", [ref]).changes === 1,
    markOrphaned: (ref) => db.run("UPDATE secret_refs SET state = 'orphaned' WHERE ref = ? AND state IN ('pending','committed')", [ref]).changes === 1,
    restoreCommitted: (ref) => db.run("UPDATE secret_refs SET state = 'committed' WHERE ref = ? AND state <> 'committed'", [ref]).changes === 1,
    listOrphaned: () => db.all("SELECT * FROM secret_refs WHERE state = 'orphaned' ORDER BY created_at, ref").map(refMap.fromRow),
    listStalePending: (before) => db.all("SELECT * FROM secret_refs WHERE state = 'pending' AND created_at < ? ORDER BY created_at, ref", [toIso(before)]).map(refMap.fromRow),
    listByOwner: (ownerKind, ownerId) =>
      db.all('SELECT * FROM secret_refs WHERE owner_kind = ? AND owner_id = ? ORDER BY created_at, ref', [ownerKind, ownerId]).map(refMap.fromRow),
    delete: (ref) => db.run('DELETE FROM secret_refs WHERE ref = ?', [ref]).changes > 0,
    isReferenced(ref) {
      const row = db.get<{ n: number }>(
        `SELECT
           (SELECT COUNT(*) FROM proxy_revisions WHERE state <> 'retired' AND (username_ref = ?1 OR password_ref = ?1))
         + (SELECT COUNT(*) FROM accounts WHERE password_ref = ?1)
         + (SELECT COUNT(*) FROM settings WHERE instr(value, ?1) > 0) AS n`,
        [ref],
      );
      return (row?.n ?? 0) > 0;
    },
  };
  return repo;
}
