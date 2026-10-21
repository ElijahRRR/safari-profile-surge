// 环境、代理版本、账号。秘密只以钥匙串引用（*_ref）与 HMAC 指纹（*_fp）出现。

import type { SiteCode } from '@sfe/contract';
import { col, mapper, nowIso, placeholders, type InsertOf, type RepoContext } from './common.js';

export type BindingStage = 'awaiting_profile' | 'awaiting_extension' | 'awaiting_association';

export interface EnvironmentRecord {
  id: string;
  seq: number;
  code: string;
  nodeTag: string;
  displayName: string;
  site: SiteCode;
  autoOpenOrders: boolean;
  autoFillLogin: boolean;
  revision: number;
  desiredProxyRevision: number | null;
  deployedProxyRevision: number | null;
  lastVerifiedProxyRevision: number | null;
  expectedExitIp: string | null;
  bindingStage: BindingStage | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type EnvironmentPatch = Partial<Omit<EnvironmentRecord, 'id' | 'seq' | 'code' | 'nodeTag' | 'createdAt'>>;

const envMap = mapper<EnvironmentRecord>('environments', {
  id: col.text('id'),
  seq: col.int('seq'),
  code: col.text('code'),
  nodeTag: col.text('node_tag'),
  displayName: col.text('display_name'),
  site: col.text<SiteCode>('site'),
  autoOpenOrders: col.bool('auto_open_orders'),
  autoFillLogin: col.bool('auto_fill_login'),
  revision: col.int('revision'),
  desiredProxyRevision: col.intNull('desired_proxy_revision'),
  deployedProxyRevision: col.intNull('deployed_proxy_revision'),
  lastVerifiedProxyRevision: col.intNull('last_verified_proxy_revision'),
  expectedExitIp: col.textNull('expected_exit_ip'),
  bindingStage: col.textNull<BindingStage>('binding_stage'),
  deletedAt: col.timeNull('deleted_at'),
  createdAt: col.time('created_at'),
  updatedAt: col.time('updated_at'),
});

export interface EnvironmentsRepo {
  get(id: string): EnvironmentRecord | null;
  byCode(code: string): EnvironmentRecord | null;
  /** 按稳定编号排序；默认不含已删除。 */
  list(opts?: { includeDeleted?: boolean }): EnvironmentRecord[];
  /** 未删除且展示名完全相同的环境（导入冲突判断）。 */
  listByDisplayName(displayName: string): EnvironmentRecord[];
  insert(rec: InsertOf<EnvironmentRecord, 'createdAt' | 'updatedAt' | 'deletedAt'>): EnvironmentRecord;
  /** updatedAt 未给出时自动设为当前时间。返回是否找到该行。 */
  update(id: string, patch: EnvironmentPatch): boolean;
  /** 乐观并发：只有当前 revision 等于 expectedRevision 时才更新。 */
  updateIfRevision(id: string, expectedRevision: number, patch: EnvironmentPatch): boolean;
}

export function createEnvironmentsRepo(ctx: RepoContext): EnvironmentsRepo {
  const { db } = ctx;
  const one = (sql: string, params: Array<string | number>) => {
    const row = db.get(sql, params);
    return row ? envMap.fromRow(row) : null;
  };
  return {
    get: (id) => one('SELECT * FROM environments WHERE id = ?', [id]),
    byCode: (code) => one('SELECT * FROM environments WHERE code = ?', [code]),
    list(opts) {
      const where = opts?.includeDeleted ? '' : 'WHERE deleted_at IS NULL';
      return db.all(`SELECT * FROM environments ${where} ORDER BY seq`).map(envMap.fromRow);
    },
    listByDisplayName(displayName) {
      return db.all('SELECT * FROM environments WHERE deleted_at IS NULL AND display_name = ? ORDER BY seq', [displayName]).map(envMap.fromRow);
    },
    insert(rec) {
      const now = nowIso(ctx);
      const full: EnvironmentRecord = { ...rec, deletedAt: rec.deletedAt ?? null, createdAt: rec.createdAt ?? now, updatedAt: rec.updatedAt ?? now };
      envMap.insert(db, full);
      return envMap.fromRow(db.get('SELECT * FROM environments WHERE id = ?', [full.id])!);
    },
    update(id, patch) {
      return envMap.update(db, { ...patch, updatedAt: patch.updatedAt ?? nowIso(ctx) }, 'id = ?', [id]) > 0;
    },
    updateIfRevision(id, expectedRevision, patch) {
      return envMap.update(db, { ...patch, updatedAt: patch.updatedAt ?? nowIso(ctx) }, 'id = ? AND revision = ?', [id, expectedRevision]) > 0;
    },
  };
}

// ---------- 代理版本 ----------

export type ProxyRevisionState = 'desired' | 'deployed' | 'superseded' | 'retired';

export interface ProxyRevisionRecord {
  environmentId: string;
  revision: number;
  protocol: 'socks5';
  host: string;
  port: number;
  usernameRef: string | null;
  usernameFp: string | null;
  passwordRef: string | null;
  passwordFp: string | null;
  frontProxyId: string;
  nodeName: string;
  state: ProxyRevisionState;
  createdAt: string;
  retiredAt: string | null;
}

const revMap = mapper<ProxyRevisionRecord>('proxy_revisions', {
  environmentId: col.text('environment_id'),
  revision: col.int('revision'),
  protocol: col.text<'socks5'>('protocol'),
  host: col.text('host'),
  port: col.int('port'),
  usernameRef: col.textNull('username_ref'),
  usernameFp: col.textNull('username_fp'),
  passwordRef: col.textNull('password_ref'),
  passwordFp: col.textNull('password_fp'),
  frontProxyId: col.text('front_proxy_id'),
  nodeName: col.text('node_name'),
  state: col.text<ProxyRevisionState>('state'),
  createdAt: col.time('created_at'),
  retiredAt: col.timeNull('retired_at'),
});

export interface ProxyRevisionsRepo {
  insert(rec: InsertOf<ProxyRevisionRecord, 'createdAt' | 'retiredAt'>): ProxyRevisionRecord;
  get(environmentId: string, revision: number): ProxyRevisionRecord | null;
  byNodeName(nodeName: string): ProxyRevisionRecord | null;
  listByEnvironment(environmentId: string): ProxyRevisionRecord[];
  list(filter?: { state?: ProxyRevisionState | ProxyRevisionState[]; frontProxyId?: string }): ProxyRevisionRecord[];
  /** 该环境的最大版本号；没有版本时为 0。 */
  maxRevision(environmentId: string): number;
  /** 改为 retired 时同时记录 retiredAt。 */
  updateState(environmentId: string, revision: number, state: ProxyRevisionState): boolean;
}

export function createProxyRevisionsRepo(ctx: RepoContext): ProxyRevisionsRepo {
  const { db } = ctx;
  const repo: ProxyRevisionsRepo = {
    insert(rec) {
      const full: ProxyRevisionRecord = { ...rec, createdAt: rec.createdAt ?? nowIso(ctx), retiredAt: rec.retiredAt ?? null };
      revMap.insert(db, full);
      return repo.get(full.environmentId, full.revision)!;
    },
    get(environmentId, revision) {
      const row = db.get('SELECT * FROM proxy_revisions WHERE environment_id = ? AND revision = ?', [environmentId, revision]);
      return row ? revMap.fromRow(row) : null;
    },
    byNodeName(nodeName) {
      const row = db.get('SELECT * FROM proxy_revisions WHERE node_name = ?', [nodeName]);
      return row ? revMap.fromRow(row) : null;
    },
    listByEnvironment(environmentId) {
      return db.all('SELECT * FROM proxy_revisions WHERE environment_id = ? ORDER BY revision', [environmentId]).map(revMap.fromRow);
    },
    list(filter) {
      const where: string[] = [];
      const params: string[] = [];
      if (filter?.state !== undefined) {
        const states = Array.isArray(filter.state) ? filter.state : [filter.state];
        if (states.length === 0) return [];
        where.push(`state IN (${placeholders(states.length)})`);
        params.push(...states);
      }
      if (filter?.frontProxyId !== undefined) {
        where.push('front_proxy_id = ?');
        params.push(filter.frontProxyId);
      }
      const sql = `SELECT * FROM proxy_revisions ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY environment_id, revision`;
      return db.all(sql, params).map(revMap.fromRow);
    },
    maxRevision(environmentId) {
      const row = db.get<{ m: number | null }>('SELECT MAX(revision) AS m FROM proxy_revisions WHERE environment_id = ?', [environmentId]);
      return row?.m ?? 0;
    },
    updateState(environmentId, revision, state) {
      const patch: Partial<ProxyRevisionRecord> = { state };
      if (state === 'retired') patch.retiredAt = nowIso(ctx);
      return revMap.update(db, patch, 'environment_id = ? AND revision = ?', [environmentId, revision]) > 0;
    },
  };
  return repo;
}

// ---------- 账号 ----------

export interface AccountRecord {
  environmentId: string;
  label: string | null;
  loginIdentifier: string | null;
  passwordRef: string | null;
  passwordFp: string | null;
  changedSincePageCheck: boolean;
  updatedAt: string;
}

const accountMap = mapper<AccountRecord>('accounts', {
  environmentId: col.text('environment_id'),
  label: col.textNull('label'),
  loginIdentifier: col.textNull('login_identifier'),
  passwordRef: col.textNull('password_ref'),
  passwordFp: col.textNull('password_fp'),
  changedSincePageCheck: col.bool('changed_since_page_check'),
  updatedAt: col.time('updated_at'),
});

export interface AccountsRepo {
  get(environmentId: string): AccountRecord | null;
  insert(rec: InsertOf<AccountRecord, 'updatedAt' | 'changedSincePageCheck'>): AccountRecord;
  update(environmentId: string, patch: Partial<Omit<AccountRecord, 'environmentId'>>): boolean;
  upsert(rec: InsertOf<AccountRecord, 'updatedAt' | 'changedSincePageCheck'>): AccountRecord;
  delete(environmentId: string): boolean;
}

export function createAccountsRepo(ctx: RepoContext): AccountsRepo {
  const { db } = ctx;
  const full = (rec: InsertOf<AccountRecord, 'updatedAt' | 'changedSincePageCheck'>): AccountRecord => ({
    ...rec,
    changedSincePageCheck: rec.changedSincePageCheck ?? false,
    updatedAt: rec.updatedAt ?? nowIso(ctx),
  });
  const repo: AccountsRepo = {
    get(environmentId) {
      const row = db.get('SELECT * FROM accounts WHERE environment_id = ?', [environmentId]);
      return row ? accountMap.fromRow(row) : null;
    },
    insert(rec) {
      accountMap.insert(db, full(rec));
      return repo.get(rec.environmentId)!;
    },
    update(environmentId, patch) {
      return accountMap.update(db, { ...patch, updatedAt: patch.updatedAt ?? nowIso(ctx) }, 'environment_id = ?', [environmentId]) > 0;
    },
    upsert(rec) {
      return db.tx(() => {
        if (repo.get(rec.environmentId)) {
          const { environmentId, ...rest } = full(rec);
          repo.update(environmentId, rest);
        } else {
          accountMap.insert(db, full(rec));
        }
        return repo.get(rec.environmentId)!;
      });
    },
    delete(environmentId) {
      return db.run('DELETE FROM accounts WHERE environment_id = ?', [environmentId]).changes > 0;
    },
  };
  return repo;
}
