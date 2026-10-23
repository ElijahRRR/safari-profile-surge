// 本机秘密存储（用户决定：不使用钥匙串，见 docs/ARCHITECTURE.md §0）：代理凭据、账号密码与系统秘密（pepper）
// 以明文保存在服务自己的 SQLite 数据库（secret_values 表）中，只靠所有者专用的文件权限保护（数据目录 0700，
// 数据库及其 -wal/-shm 0600，见 db/db.ts）。删除的值不留在数据库文件或 -wal 中（secure_delete 加删除后的
// checkpoint）。值从不进入日志、错误信息、事件、操作结果或命令行参数；
// 写入与读出的值都登记到脱敏器。引用从不复用、从不覆盖；引用的四步协议与回收见 secret-ref-manager.ts。

import { SfeError } from '@sfe/contract';
import type { Clock, Scrubber, SecretStore } from '../ports.js';
import type { Db } from '../db/index.js';
import type { SecretKind } from '../db/repos/secret-refs.js';
import { secretStoreError } from './errors.js';
import { PEPPER_REF } from './pepper.js';

const REF_RE = /^[A-Za-z0-9._:-]{1,256}$/;
const KINDS: ReadonlySet<string> = new Set<SecretKind>(['proxy', 'account', 'system']);

export interface LocalSecretStoreOptions {
  db: Db;
  clock: Clock;
  /** 写入与读出的值都登记到脱敏器（按值替换）。 */
  scrubber?: Pick<Scrubber, 'register'>;
}

export class LocalSecretStore implements SecretStore {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly scrubber: Pick<Scrubber, 'register'> | undefined;

  constructor(opts: LocalSecretStoreOptions) {
    this.db = opts.db;
    this.clock = opts.clock;
    this.scrubber = opts.scrubber;
  }

  async put(ref: string, value: string, kind: SecretKind): Promise<void> {
    assertRef('put', ref);
    if (typeof value !== 'string') throw secretStoreError('put', 'other', '秘密值格式不正确');
    if (!KINDS.has(kind)) throw secretStoreError('put', 'other', '秘密种类不正确');
    this.scrubber?.register(value);
    let inserted: boolean;
    try {
      inserted =
        this.db.run('INSERT INTO secret_values(ref, kind, value, created_at) VALUES(?, ?, ?, ?) ON CONFLICT(ref) DO NOTHING', [ref, kind, value, this.clock.now().toISOString()])
          .changes === 1;
    } catch {
      // 数据库错误的原文不外传（可能带 SQL 片段）；值从不出现在错误中
      throw secretStoreError('put', 'other');
    }
    // 引用从不复用：已存在即失败，避免覆盖仍在使用的秘密
    if (!inserted) throw secretStoreError('put', 'other', '引用已存在');
  }

  /** 任何种类都可读取（包括账号密码：登录填充由服务读出后经原生桥交给扩展）。 */
  async get(ref: string): Promise<string | null> {
    assertRef('get', ref);
    let row: { value: unknown } | undefined;
    try {
      row = this.db.get<{ value: unknown }>('SELECT value FROM secret_values WHERE ref = ?', [ref]);
    } catch {
      throw secretStoreError('get', 'other');
    }
    if (!row) return null;
    if (typeof row.value !== 'string') throw secretStoreError('get', 'other', '保存的秘密格式不正确');
    this.scrubber?.register(row.value);
    return row.value;
  }

  /**
   * 不存在时视为成功（幂等）。删除了值时随即 checkpoint 并截断 -wal：secure_delete 只清零数据库页，WAL 中写入该值时的
   * 旧帧仍有明文副本。checkpoint 失败不影响删除结果（值已从表中删除），下次删除时再试。
   */
  async delete(ref: string): Promise<void> {
    assertRef('delete', ref);
    let removed: boolean;
    try {
      removed = this.db.run('DELETE FROM secret_values WHERE ref = ?', [ref]).changes > 0;
    } catch {
      throw secretStoreError('delete', 'other');
    }
    if (!removed) return;
    try {
      this.db.checkpointTruncate();
    } catch {
      // 只影响旧帧何时被清除；不外传数据库错误原文
    }
  }
}

function assertRef(op: 'put' | 'get' | 'delete', ref: string): void {
  if (typeof ref !== 'string' || !REF_RE.test(ref)) throw secretStoreError(op, 'other', '引用格式不正确');
}

// ---------- 旧版（钥匙串）数据目录 ----------

export interface LegacyKeychainData {
  /** meta 记录 pepper 曾经创建过，本机资料中却没有它。 */
  pepperMissing: boolean;
  /** 已提交（committed）却没有本机值的秘密引用数。 */
  missingCommittedRefs: number;
}

/**
 * 数据目录由使用钥匙串的旧版本创建时返回缺失情况，否则返回 null。只读数据库，从不读取钥匙串。
 * 在迁移之前调用（main.ts），拒绝时数据库保持旧版本的结构：迁移 2 之前没有 secret_values 表，不可能有本机值，
 * 记录过的 pepper 与全部已提交的引用都算缺失；还没有任何表的新数据库不是旧版。迁移之后调用也得到同样的结论。
 */
export function findLegacyKeychainData(db: Db): LegacyKeychainData | null {
  const hasTable = (name: string) => db.get("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?", [name]) !== undefined;
  const hasValues = hasTable('secret_values');
  let pepperMissing = false;
  if (hasTable('meta')) {
    const pepperFlag = db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'pepper_created'");
    pepperMissing = Number(pepperFlag?.value ?? 0) === 1 && (!hasValues || !db.get('SELECT 1 AS ok FROM secret_values WHERE ref = ?', [PEPPER_REF]));
  }
  let missingCommittedRefs = 0;
  if (hasTable('secret_refs')) {
    const missing = db.get<{ n: number }>(
      hasValues
        ? "SELECT COUNT(*) AS n FROM secret_refs r WHERE r.state = 'committed' AND NOT EXISTS (SELECT 1 FROM secret_values v WHERE v.ref = r.ref)"
        : "SELECT COUNT(*) AS n FROM secret_refs WHERE state = 'committed'",
    );
    missingCommittedRefs = Number(missing?.n ?? 0);
  }
  return pepperMissing || missingCommittedRefs > 0 ? { pepperMissing, missingCommittedRefs } : null;
}

export const LEGACY_KEYCHAIN_DATA_MESSAGE =
  '启动失败：数据目录由使用钥匙串的旧版本创建，本版本不读取钥匙串，其中的代理凭据、账号密码与 pepper 无法使用。' +
  '请换用新的数据目录重新初始化，并重新导入代理与账号资料；旧的钥匙串项可以按 docs/INSTALL.md 用 security delete-generic-password 手动删除。';

/**
 * 启动时 fail closed（在迁移之前，拒绝时不改动数据库，旧版本仍能打开它）：旧版数据目录中已提交的引用与 pepper 的值
 * 都在钥匙串里，本版本从不读取钥匙串迁移，也从不在 pepper 曾经存在时重新生成（旧指纹会全部失效）。
 * 只给出缺失数量，不含引用或值。
 */
export function assertNoLegacyKeychainData(db: Db): void {
  const legacy = findLegacyKeychainData(db);
  if (!legacy) return;
  throw new SfeError('SECRET_STORE_FAILED', LEGACY_KEYCHAIN_DATA_MESSAGE, {
    details: { reason: 'legacy_keychain_data', pepperMissing: legacy.pepperMissing, missingCommittedRefs: legacy.missingCommittedRefs },
  });
}
