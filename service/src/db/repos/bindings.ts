// 场景绑定（一对一）与各场景最近上报（只作提示，从不改变路由）。

import { col, mapper, nowIso, toIso, type InsertOf, type RepoContext } from './common.js';

export interface ProfileBindingRecord {
  profileId: string;
  environmentId: string;
  state: 'bound' | 'bound_unverified_id';
  boundAt: string;
}

const bindingMap = mapper<ProfileBindingRecord>('profile_bindings', {
  profileId: col.text('profile_id'),
  environmentId: col.text('environment_id'),
  state: col.text<ProfileBindingRecord['state']>('state'),
  boundAt: col.time('bound_at'),
});

export interface ProfileBindingsRepo {
  byProfile(profileId: string): ProfileBindingRecord | null;
  byEnvironment(environmentId: string): ProfileBindingRecord | null;
  list(): ProfileBindingRecord[];
  /** 场景或环境已绑定时违反唯一约束而抛错（调用方先检查并返回 PROFILE_ALREADY_BOUND / ENVIRONMENT_ALREADY_BOUND）。 */
  insert(rec: InsertOf<ProfileBindingRecord, 'boundAt'>): ProfileBindingRecord;
  updateState(profileId: string, state: ProfileBindingRecord['state']): boolean;
  delete(profileId: string): boolean;
  deleteByEnvironment(environmentId: string): boolean;
}

export function createProfileBindingsRepo(ctx: RepoContext): ProfileBindingsRepo {
  const { db } = ctx;
  const one = (sql: string, p: string) => {
    const row = db.get(sql, [p]);
    return row ? bindingMap.fromRow(row) : null;
  };
  const repo: ProfileBindingsRepo = {
    byProfile: (profileId) => one('SELECT * FROM profile_bindings WHERE profile_id = ?', profileId),
    byEnvironment: (environmentId) => one('SELECT * FROM profile_bindings WHERE environment_id = ?', environmentId),
    list: () => db.all('SELECT * FROM profile_bindings ORDER BY bound_at, profile_id').map(bindingMap.fromRow),
    insert(rec) {
      bindingMap.insert(db, { ...rec, boundAt: rec.boundAt ?? nowIso(ctx) });
      return repo.byProfile(rec.profileId)!;
    },
    updateState: (profileId, state) => bindingMap.update(db, { state }, 'profile_id = ?', [profileId]) > 0,
    delete: (profileId) => db.run('DELETE FROM profile_bindings WHERE profile_id = ?', [profileId]).changes > 0,
    deleteByEnvironment: (environmentId) => db.run('DELETE FROM profile_bindings WHERE environment_id = ?', [environmentId]).changes > 0,
  };
  return repo;
}

export interface ProfileReportRecord {
  profileId: string;
  windowsOpen: number;
  amazonTabsOpen: boolean;
  sitePermissionGranted: boolean;
  reportedAt: string;
}

const reportMap = mapper<ProfileReportRecord>('profile_reports', {
  profileId: col.text('profile_id'),
  windowsOpen: col.int('windows_open'),
  amazonTabsOpen: col.bool('amazon_tabs_open'),
  sitePermissionGranted: col.bool('site_permission_granted'),
  reportedAt: col.time('reported_at'),
});

export interface ProfileReportsRepo {
  get(profileId: string): ProfileReportRecord | null;
  upsert(rec: InsertOf<ProfileReportRecord, 'reportedAt'>): ProfileReportRecord;
  list(): ProfileReportRecord[];
  /** reportedAt ≥ since 的上报（例如最近 10 分钟内）。 */
  listSince(since: Date | string): ProfileReportRecord[];
  delete(profileId: string): boolean;
}

export function createProfileReportsRepo(ctx: RepoContext): ProfileReportsRepo {
  const { db } = ctx;
  const repo: ProfileReportsRepo = {
    get(profileId) {
      const row = db.get('SELECT * FROM profile_reports WHERE profile_id = ?', [profileId]);
      return row ? reportMap.fromRow(row) : null;
    },
    upsert(rec) {
      reportMap.insert(db, { ...rec, reportedAt: rec.reportedAt ?? nowIso(ctx) }, 'OR REPLACE');
      return repo.get(rec.profileId)!;
    },
    list: () => db.all('SELECT * FROM profile_reports ORDER BY reported_at DESC, profile_id').map(reportMap.fromRow),
    listSince: (since) => db.all('SELECT * FROM profile_reports WHERE reported_at >= ? ORDER BY reported_at DESC, profile_id', [toIso(since)]).map(reportMap.fromRow),
    delete: (profileId) => db.run('DELETE FROM profile_reports WHERE profile_id = ?', [profileId]).changes > 0,
  };
  return repo;
}
