// 初始化与维护备份的索引（备份文件本身在 <数据目录>/backups，0700/0600）。只记路径与带密钥摘要。

import { col, mapper, nowIso, type InsertOf, type RepoContext } from './common.js';

export interface BackupFileEntry {
  /** 相对于备份目录的路径。 */
  relativePath: string;
  /** 带密钥摘要（HMAC）。 */
  digest: string;
  [key: string]: unknown;
}

/** 可读的运行开关：增强模式、系统代理、出站模式、自动重载、HTTP API 是否配置等。 */
export type BackupRuntimeSwitches = Record<string, unknown>;

export interface BackupRecord {
  id: string;
  reason: 'init' | 'remerge';
  sourcePath: string;
  backupDirectory: string;
  files: BackupFileEntry[];
  runtimeSwitches: BackupRuntimeSwitches;
  createdAt: string;
}

const backupMap = mapper<BackupRecord>('backups', {
  id: col.text('id'),
  reason: col.text<'init' | 'remerge'>('reason'),
  sourcePath: col.text('source_path'),
  backupDirectory: col.text('backup_directory'),
  files: col.json<BackupFileEntry[]>('files', []),
  runtimeSwitches: col.json<BackupRuntimeSwitches>('runtime_switches', {}),
  createdAt: col.time('created_at'),
});

export interface BackupsRepo {
  insert(rec: InsertOf<BackupRecord, 'createdAt'>): BackupRecord;
  get(id: string): BackupRecord | null;
  /** 按创建时间倒序。 */
  list(opts?: { reason?: BackupRecord['reason'] }): BackupRecord[];
  delete(id: string): boolean;
}

export function createBackupsRepo(ctx: RepoContext): BackupsRepo {
  const { db } = ctx;
  const repo: BackupsRepo = {
    insert(rec) {
      backupMap.insert(db, { ...rec, createdAt: rec.createdAt ?? nowIso(ctx) });
      return repo.get(rec.id)!;
    },
    get(id) {
      const row = db.get('SELECT * FROM backups WHERE id = ?', [id]);
      return row ? backupMap.fromRow(row) : null;
    },
    list(opts) {
      if (opts?.reason) return db.all('SELECT * FROM backups WHERE reason = ? ORDER BY created_at DESC, id DESC', [opts.reason]).map(backupMap.fromRow);
      return db.all('SELECT * FROM backups ORDER BY created_at DESC, id DESC').map(backupMap.fromRow);
    },
    delete: (id) => db.run('DELETE FROM backups WHERE id = ?', [id]).changes > 0,
  };
  return repo;
}
