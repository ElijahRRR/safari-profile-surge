// 本机秘密存储（不使用钥匙串）：值以明文保存在服务数据库的 secret_values 表中，只靠所有者专用的文件权限保护；
// 引用从不覆盖；读到与写入的值登记到脱敏器；错误中从不含值；删除的值不留在数据库文件与 -wal 中。
// 使用钥匙串的旧版数据目录在启动时（迁移之前）fail closed。

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { openDatabase } from '../../src/db/index.js';
import { MIGRATIONS } from '../../src/db/schema.js';
import { LocalSecretStore, assertNoLegacyKeychainData, findLegacyKeychainData } from '../../src/secrets/local-store.js';
import { PEPPER_REF, loadPepper } from '../../src/secrets/pepper.js';
import { SecretRefManager } from '../../src/secrets/secret-ref-manager.js';
import { createIdGenerator } from '../../src/util/ids.js';
import { createScrubber } from '../../src/util/scrubber.js';
import { ensurePrivateDirSync } from '../../src/util/secure-files.js';
import { makeRepos, seedEnvironment } from '../db/fixtures.js';

const cleanup: string[] = [];
afterEach(() => {
  for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'sfe-local-secrets-'));
  cleanup.push(d);
  return d;
}

function setup(opts: { path?: string } = {}) {
  const t = makeRepos(opts.path ? { path: opts.path } : {});
  const scrubber = createScrubber();
  const store = new LocalSecretStore({ db: t.db, clock: t.clock, scrubber });
  const mgr = new SecretRefManager(t.repos, store, createIdGenerator({ now: () => t.clock.now().getTime() }), t.clock);
  return { ...t, scrubber, store, mgr };
}

const rows = (t: ReturnType<typeof setup>) => t.db.all<{ ref: string; kind: string; value: string }>('SELECT ref, kind, value FROM secret_values ORDER BY ref');

describe('LocalSecretStore', () => {
  test('put/get/delete for proxy, account and system secrets; account passwords are readable too', async () => {
    const t = setup();
    await t.store.put('sec_proxy', 'synth-proxy-pw-1', 'proxy');
    await t.store.put('sec_acc', 'synth-login-pw-1', 'account');
    await t.store.put(PEPPER_REF, 'synth-pepper', 'system');
    expect(await t.store.get('sec_proxy')).toBe('synth-proxy-pw-1');
    expect(await t.store.get('sec_acc')).toBe('synth-login-pw-1');
    expect(await t.store.get(PEPPER_REF)).toBe('synth-pepper');
    expect(rows(t)).toEqual([
      { ref: 'sec_acc', kind: 'account', value: 'synth-login-pw-1' },
      { ref: 'sec_proxy', kind: 'proxy', value: 'synth-proxy-pw-1' },
      { ref: PEPPER_REF, kind: 'system', value: 'synth-pepper' },
    ]);
    await t.store.delete('sec_acc');
    expect(await t.store.get('sec_acc')).toBeNull();
    // 不存在时删除是幂等的
    await expect(t.store.delete('sec_acc')).resolves.toBeUndefined();
    expect(await t.store.get('sec_never')).toBeNull();
  });

  test('refs are never overwritten, and the error never contains either value', async () => {
    const t = setup();
    await t.store.put('sec_1', 'synth-first-value', 'proxy');
    const err = await t.store.put('sec_1', 'synth-second-value', 'proxy').catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'SECRET_STORE_FAILED', details: { reason: 'other' } });
    const text = JSON.stringify({ m: (err as Error).message, d: (err as { details?: unknown }).details });
    expect(text).not.toContain('synth-first-value');
    expect(text).not.toContain('synth-second-value');
    expect(await t.store.get('sec_1')).toBe('synth-first-value');
  });

  test('rejects malformed refs and kinds without touching the table', async () => {
    const t = setup();
    await expect(t.store.put('bad ref', 'v-1', 'proxy')).rejects.toMatchObject({ code: 'SECRET_STORE_FAILED' });
    await expect(t.store.put('sec_1', 'v-1', 'other' as never)).rejects.toMatchObject({ code: 'SECRET_STORE_FAILED' });
    await expect(t.store.get('')).rejects.toMatchObject({ code: 'SECRET_STORE_FAILED' });
    await expect(t.store.delete('x'.repeat(300))).rejects.toMatchObject({ code: 'SECRET_STORE_FAILED' });
    expect(rows(t)).toEqual([]);
  });

  test('values written and read are registered with the scrubber', async () => {
    const t = setup();
    await t.store.put('sec_1', 'synth-written-secret', 'proxy');
    expect(t.scrubber.scrub('x synth-written-secret y')).not.toContain('synth-written-secret');
    // 重启后（新的脱敏器）读出即登记
    const fresh = createScrubber();
    const reader = new LocalSecretStore({ db: t.db, clock: t.clock, scrubber: fresh });
    expect(fresh.scrub('synth-written-secret')).toContain('synth-written-secret');
    expect(await reader.get('sec_1')).toBe('synth-written-secret');
    expect(fresh.scrub('a synth-written-secret b')).not.toContain('synth-written-secret');
  });

  test('database errors are reported without SQL text or values', async () => {
    const t = setup();
    t.db.exec('DROP TABLE secret_values');
    const err = (await t.store.put('sec_1', 'synth-lost-value', 'proxy').catch((e: unknown) => e)) as Error;
    expect(err).toMatchObject({ code: 'SECRET_STORE_FAILED', details: { reason: 'other' } });
    expect(err.message).not.toMatch(/secret_values|INSERT|synth-lost-value/);
    await expect(t.store.get('sec_1')).rejects.toMatchObject({ code: 'SECRET_STORE_FAILED' });
  });

  test('loadPepper keeps the pepper as a system secret in the same table', async () => {
    const t = setup();
    const pepper = await loadPepper(t.store, t.repos.meta, createIdGenerator());
    expect(pepper).toHaveLength(32);
    expect(t.db.get<{ kind: string }>('SELECT kind FROM secret_values WHERE ref = ?', [PEPPER_REF])?.kind).toBe('system');
    expect((await loadPepper(t.store, t.repos.meta, createIdGenerator())).equals(pepper)).toBe(true);
  });
});

describe('SecretRefManager over the local store', () => {
  const TEN_MIN = 10 * 60 * 1000;

  test('create → commit → orphan → sweep removes both the value and the ref row', async () => {
    const t = setup();
    const ref = await t.mgr.createSecret('synth-pw-1', 'proxy', { kind: 'environment', id: 'env_1' });
    expect(t.repos.secretRefs.get(ref)?.state).toBe('pending');
    expect(await t.store.get(ref)).toBe('synth-pw-1');
    t.repos.tx(() => t.mgr.markCommitted(ref));
    t.repos.tx(() => t.mgr.orphan(ref));
    expect(await t.mgr.sweep()).toEqual({ deleted: [ref], kept: [], failed: [] });
    expect(t.repos.secretRefs.get(ref)).toBeNull();
    expect(rows(t)).toEqual([]);
  });

  test('stale pending refs are swept; referenced refs are kept with their value', async () => {
    const t = setup();
    const env = seedEnvironment(t.repos);
    const stale = await t.mgr.createSecret('synth-stale', 'proxy', { kind: 'environment', id: env.id });
    const used = await t.mgr.createSecret('synth-account-pw', 'account', { kind: 'account', id: env.id });
    t.repos.tx(() => {
      t.repos.accounts.insert({ environmentId: env.id, label: null, loginIdentifier: null, passwordRef: used, passwordFp: null });
      t.mgr.markCommitted(used);
      t.mgr.orphan(used);
    });
    t.clock.advance(TEN_MIN + 1);
    const res = await t.mgr.sweep();
    expect(res.deleted).toEqual([stale]);
    expect(res.kept).toEqual([used]);
    expect(t.repos.secretRefs.get(used)?.state).toBe('committed');
    expect(await t.store.get(used)).toBe('synth-account-pw');
    expect(await t.store.get(stale)).toBeNull();
  });

  test('discard removes an unused value', async () => {
    const t = setup();
    const ref = await t.mgr.createSecret('synth-discard', 'proxy', { kind: 'environment', id: 'e' });
    expect(await t.mgr.discard(ref)).toBe(true);
    expect(rows(t)).toEqual([]);
  });
});

describe('deleted values do not linger on disk', () => {
  const CANARY = 'synth-canary-amazon-pw-7Q4zK9';
  /** 文件中是否还有这段明文（不存在的文件视为没有）。 */
  const onDisk = (file: string) => existsSync(file) && readFileSync(file).includes(Buffer.from(CANARY, 'utf8'));

  test('sweeping an orphaned account password removes it from sfe.sqlite and -wal, while open and after a restart', async () => {
    const path = join(tempDir(), 'sfe.sqlite');
    const t = setup({ path });
    expect(t.db.get<{ secure_delete: number }>('PRAGMA secure_delete')?.secure_delete).toBe(1);
    // 值先进入 WAL，再经 checkpoint 写进数据库文件：两处都曾有明文
    const ref = await t.mgr.createSecret(CANARY, 'account', { kind: 'account', id: 'env_1' });
    t.repos.tx(() => t.mgr.markCommitted(ref));
    t.db.exec('PRAGMA wal_checkpoint(PASSIVE)');
    expect(onDisk(path)).toBe(true);
    // 删除环境 / 替换密码 → orphan → 清扫删除
    t.repos.tx(() => t.mgr.orphan(ref));
    expect(await t.mgr.sweep()).toEqual({ deleted: [ref], kept: [], failed: [] });
    expect(onDisk(path), 'sfe.sqlite while open').toBe(false);
    expect(onDisk(`${path}-wal`), '-wal while open').toBe(false);
    t.db.close();
    const reopened = openDatabase(path);
    reopened.migrate();
    reopened.close();
    for (const f of [path, `${path}-wal`]) expect(onDisk(f), f).toBe(false);
  });

  test('discarding an unused value (failed save) also leaves no copy', async () => {
    const path = join(tempDir(), 'sfe.sqlite');
    const t = setup({ path });
    const ref = await t.mgr.createSecret(CANARY, 'proxy', { kind: 'environment', id: 'env_1' });
    expect(onDisk(`${path}-wal`)).toBe(true);
    expect(await t.mgr.discard(ref)).toBe(true);
    for (const f of [path, `${path}-wal`]) expect(onDisk(f), f).toBe(false);
    t.db.close();
  });

  test('another program holding a read snapshot never freezes the service: each delete returns at once, and the deferred -wal truncation is done by a later sweep once the reader is gone', async () => {
    const path = join(tempDir(), 'sfe.sqlite');
    const t = setup({ path });
    const refs: string[] = [];
    for (let i = 0; i < 3; i++) {
      const ref = await t.mgr.createSecret(`${CANARY}-${i}`, 'account', { kind: 'account', id: `env_${i}` });
      t.repos.tx(() => t.mgr.markCommitted(ref));
      refs.push(ref);
    }
    // 数据库浏览器或 sqlite3 中开着的读事务：持有旧快照
    const { DatabaseSync } = await import('node:sqlite');
    const other = new DatabaseSync(path);
    other.exec('BEGIN');
    other.prepare('SELECT COUNT(*) AS n FROM secret_values').get();
    t.repos.tx(() => {
      for (const ref of refs) t.mgr.orphan(ref);
    });
    const started = Date.now();
    expect((await t.mgr.sweep()).deleted).toHaveLength(3);
    // 不经忙等待：不会每个值等 busy_timeout（5 秒）
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(rows(t)).toEqual([]);
    expect(onDisk(`${path}-wal`), '-wal still has the old frames while the reader pins them').toBe(true);
    other.exec('COMMIT');
    other.close();
    // 读者离开之后的清扫补做截断：旧帧不再留在 -wal 中
    await t.mgr.sweep();
    expect(onDisk(`${path}-wal`)).toBe(false);
    expect(onDisk(path)).toBe(false);
    t.db.close();
  });

  test('a deferred -wal truncation survives a service restart: the first sweep of the new process truncates once the reader is gone', async () => {
    const path = join(tempDir(), 'sfe.sqlite');
    const t = setup({ path });
    const ref = await t.mgr.createSecret(CANARY, 'account', { kind: 'account', id: 'env_1' });
    t.repos.tx(() => t.mgr.markCommitted(ref));
    // 数据库浏览器中开着的读事务，跨过服务的停止与重新启动（App 升级、菜单停止再启动）
    const { DatabaseSync } = await import('node:sqlite');
    const other = new DatabaseSync(path);
    other.exec('BEGIN');
    other.prepare('SELECT COUNT(*) AS n FROM secret_values').get();
    t.repos.tx(() => t.mgr.orphan(ref));
    expect((await t.mgr.sweep()).deleted).toEqual([ref]);
    // 服务停止：关闭的不是最后一个连接，SQLite 不写回、不删除 -wal
    t.db.close();
    expect(onDisk(`${path}-wal`), '-wal after the service stopped while the reader is open').toBe(true);
    // 重新启动：新进程的启动清扫（读者仍在时截断不能完成，之后每小时再试）
    const t2 = setup({ path });
    expect(await t2.mgr.sweep()).toEqual({ deleted: [], kept: [], failed: [] });
    expect(onDisk(`${path}-wal`), '-wal while the reader still pins the old frames').toBe(true);
    other.exec('COMMIT');
    other.close();
    // 读者离开之后的下一次清扫（每小时）：旧帧不再留在 -wal 中
    await t2.mgr.sweep();
    expect(onDisk(`${path}-wal`)).toBe(false);
    expect(onDisk(path)).toBe(false);
    t2.db.close();
  });

  test('a sweep of many orphaned values lets the event loop run between values and truncates the -wal once at the end (not once per value)', async () => {
    const path = join(tempDir(), 'sfe.sqlite');
    const t = setup({ path });
    const refs: string[] = [];
    for (let i = 0; i < 8; i++) {
      const ref = await t.mgr.createSecret(`${CANARY}-${i}`, 'account', { kind: 'account', id: `env_${i}` });
      t.repos.tx(() => t.mgr.markCommitted(ref));
      refs.push(ref);
    }
    // 每个进程的第一次截断（启动时的清扫）已经做过
    await t.store.flush();
    t.repos.tx(() => {
      for (const ref of refs) t.mgr.orphan(ref);
    });
    let truncations = 0;
    const checkpoint = t.db.checkpointTruncate.bind(t.db);
    t.db.checkpointTruncate = () => {
      truncations++;
      return checkpoint();
    };
    // 事件循环的轮数：同步数据库操作包成的 Promise 只是微任务，不让出事件循环时这个计数在清扫期间不变
    let ticks = 0;
    let counting = true;
    const tick = (): void => {
      if (!counting) return;
      ticks++;
      setImmediate(tick);
    };
    setImmediate(tick);
    const del = t.store.delete.bind(t.store);
    const ticksAtDelete: number[] = [];
    t.store.delete = async (ref, opts) => {
      ticksAtDelete.push(ticks);
      return del(ref, opts);
    };
    const r = await t.mgr.sweep();
    counting = false;
    expect(r.deleted).toHaveLength(refs.length);
    expect(truncations).toBe(1);
    expect(ticksAtDelete).toHaveLength(refs.length);
    expect(ticksAtDelete.at(-1)! - ticksAtDelete[0]!).toBeGreaterThanOrEqual(refs.length - 2);
    for (const f of [path, `${path}-wal`]) expect(onDisk(f), f).toBe(false);
    t.db.close();
  });

  test('discarding a batch of unused values (an import whose rows all conflict) also yields between values and truncates once, leaving no copy', async () => {
    const path = join(tempDir(), 'sfe.sqlite');
    const t = setup({ path });
    await t.store.flush();
    const refs: string[] = [];
    for (let i = 0; i < 8; i++) refs.push(await t.mgr.createSecret(`${CANARY}-${i}`, 'proxy', { kind: 'import', id: 'batch_1' }));
    // 其中一个已被提交并引用（例如别的行用上了它）：跳过，不删除
    const env = seedEnvironment(t.repos);
    t.repos.tx(() => {
      t.repos.accounts.insert({ environmentId: env.id, label: null, loginIdentifier: null, passwordRef: refs[0]!, passwordFp: null });
      t.mgr.markCommitted(refs[0]!);
    });
    let truncations = 0;
    const checkpoint = t.db.checkpointTruncate.bind(t.db);
    t.db.checkpointTruncate = () => {
      truncations++;
      return checkpoint();
    };
    let ticks = 0;
    let counting = true;
    const tick = (): void => {
      if (!counting) return;
      ticks++;
      setImmediate(tick);
    };
    setImmediate(tick);
    const settled = t.mgr.discardUnused(refs).then((n) => ({ n, ticks }));
    const { n, ticks: atEnd } = await settled;
    counting = false;
    expect(n).toBe(refs.length - 1);
    expect(atEnd).toBeGreaterThanOrEqual(refs.length - 1);
    expect(truncations).toBe(1);
    for (let i = 1; i < refs.length; i++) expect(onDisk(`${path}-wal`) && readFileSync(`${path}-wal`).includes(Buffer.from(`${CANARY}-${i}`, 'utf8'))).toBe(false);
    t.db.close();
  });

  test('checkpointTruncate is skipped inside a transaction and is a no-op for memory databases', () => {
    const t = setup();
    expect(t.db.checkpointTruncate()).toBe(true);
    expect(t.repos.tx(() => t.db.checkpointTruncate())).toBe(false);
  });
});

describe('owner-only permissions (plain text is protected only by file modes)', () => {
  test('data dir 0700; database, -wal and -shm 0600 even with a permissive umask', async () => {
    const base = tempDir();
    const dataDir = join(base, 'data');
    const old = process.umask(0);
    try {
      ensurePrivateDirSync(dataDir);
      const path = join(dataDir, 'sfe.sqlite');
      const t = setup({ path });
      await t.store.put('sec_1', 'synth-on-disk', 'proxy');
      expect(statSync(dataDir).mode & 0o777).toBe(0o700);
      for (const f of [path, `${path}-wal`, `${path}-shm`]) {
        expect(existsSync(f), f).toBe(true);
        expect(statSync(f).mode & 0o777, f).toBe(0o600);
      }
      t.db.close();
    } finally {
      process.umask(old);
    }
  });

  test('existing loose database, -wal and -shm files are tightened to 0600 on open', () => {
    const dir = tempDir();
    const path = join(dir, 'sfe.sqlite');
    const first = openDatabase(path);
    first.migrate();
    first.close();
    chmodSync(path, 0o644);
    for (const s of ['-wal', '-shm']) {
      writeFileSync(`${path}${s}`, '');
      chmodSync(`${path}${s}`, 0o644);
    }
    const db = openDatabase(path);
    for (const f of [path, `${path}-wal`, `${path}-shm`]) expect(statSync(f).mode & 0o077, f).toBe(0);
    db.close();
  });

  test('a loosened data dir is tightened back to 0700', () => {
    const dir = join(tempDir(), 'data');
    ensurePrivateDirSync(dir);
    chmodSync(dir, 0o755);
    ensurePrivateDirSync(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });
});

describe('legacy (Keychain) data directories', () => {
  test('a fresh or local-only data directory is not legacy', async () => {
    const t = setup();
    expect(findLegacyKeychainData(t.db)).toBeNull();
    await loadPepper(t.store, t.repos.meta, createIdGenerator());
    const ref = await t.mgr.createSecret('synth-pw', 'proxy', { kind: 'environment', id: 'e' });
    t.repos.tx(() => t.mgr.markCommitted(ref));
    expect(findLegacyKeychainData(t.db)).toBeNull();
    expect(() => assertNoLegacyKeychainData(t.db)).not.toThrow();
  });

  test('the pepper flag without a local pepper value is legacy; loadPepper never regenerates it', async () => {
    const t = setup();
    t.repos.meta.markPepperCreated();
    expect(findLegacyKeychainData(t.db)).toEqual({ pepperMissing: true, missingCommittedRefs: 0 });
    await expect(loadPepper(t.store, t.repos.meta, createIdGenerator())).rejects.toMatchObject({ code: 'SECRET_STORE_FAILED', details: { reason: 'not_found' } });
    expect(rows(t)).toEqual([]);
  });

  test('committed refs without local values are legacy; pending/orphaned ones are left to the sweeper', () => {
    const t = setup();
    const at = t.clock.now().toISOString();
    t.repos.tx(() => {
      for (const ref of ['sec_kc_committed_1', 'sec_kc_committed_2', 'sec_kc_pending', 'sec_kc_orphaned']) {
        t.repos.secretRefs.insertPending({ ref, kind: 'proxy', ownerKind: 'environment', ownerId: 'env_legacy', createdAt: at });
      }
      t.repos.secretRefs.markCommitted('sec_kc_committed_1');
      t.repos.secretRefs.markCommitted('sec_kc_committed_2');
      t.repos.secretRefs.markOrphaned('sec_kc_orphaned');
    });
    expect(findLegacyKeychainData(t.db)).toEqual({ pepperMissing: false, missingCommittedRefs: 2 });
  });

  test('a schema-1 database (before migration 2: no secret_values table) is checked without migrating it', () => {
    // 还没有任何表的新数据库不是旧版
    const empty = openDatabase(':memory:');
    expect(findLegacyKeychainData(empty)).toBeNull();
    empty.close();
    const db = openDatabase(':memory:');
    db.exec(MIGRATIONS[0]!);
    db.run("INSERT INTO meta(key, value) VALUES('schema_version', '1')");
    // 从未保存过秘密的旧结构数据库照常迁移
    expect(findLegacyKeychainData(db)).toBeNull();
    db.run("INSERT INTO meta(key, value) VALUES('pepper_created', '1')");
    expect(findLegacyKeychainData(db)).toEqual({ pepperMissing: true, missingCommittedRefs: 0 });
    const at = '2026-10-01T00:00:00.000Z';
    for (const [ref, state] of [
      ['sec_kc_a', 'committed'],
      ['sec_kc_b', 'committed'],
      ['sec_kc_c', 'pending'],
      ['sec_kc_d', 'orphaned'],
    ] as const) {
      db.run("INSERT INTO secret_refs(ref, kind, owner_kind, owner_id, state, created_at) VALUES(?, 'proxy', 'environment', 'env_old', ?, ?)", [ref, state, at]);
    }
    expect(() => assertNoLegacyKeychainData(db)).toThrow(expect.objectContaining({ code: 'SECRET_STORE_FAILED', details: { reason: 'legacy_keychain_data', pepperMissing: true, missingCommittedRefs: 2 } }));
    // 只读：结构与版本不变
    expect(db.schemaVersion()).toBe(1);
    expect(db.get("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'secret_values'")).toBeUndefined();
    db.close();
  });

  test('assertNoLegacyKeychainData fails closed with a clear Chinese message and no refs in the error', () => {
    const t = setup();
    t.repos.meta.markPepperCreated();
    t.repos.tx(() => {
      t.repos.secretRefs.insertPending({ ref: 'sec_kc_secret_ref', kind: 'account', ownerKind: 'account', ownerId: 'env_legacy', createdAt: t.clock.now().toISOString() });
      t.repos.secretRefs.markCommitted('sec_kc_secret_ref');
    });
    let err: unknown;
    try {
      assertNoLegacyKeychainData(t.db);
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({
      code: 'SECRET_STORE_FAILED',
      details: { reason: 'legacy_keychain_data', pepperMissing: true, missingCommittedRefs: 1 },
    });
    const message = (err as Error).message;
    expect(message).toContain('旧版本');
    expect(message).toContain('钥匙串');
    expect(message).toContain('重新导入');
    expect(message).toContain('docs/INSTALL.md');
    expect(message).toContain('security delete-generic-password');
    expect(JSON.stringify({ message, details: (err as { details?: unknown }).details })).not.toContain('sec_kc_secret_ref');
  });
});
