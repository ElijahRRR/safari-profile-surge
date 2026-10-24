import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { CAPABILITY_CONTEXT_FIELDS, CAPABILITY_KEYS, type CapabilityContext } from '@sfe/contract';
import { isSqliteExperimentalWarning, openDatabase } from '../../src/db/db.js';
import { createRepositories } from '../../src/db/index.js';
import { MIGRATIONS } from '../../src/db/schema.js';
import { computeCapabilityViews } from '../../src/surge/capability-gate.js';

const fresh = () => mkdtempSync(join(tmpdir(), 'sfe-db-'));

describe('openDatabase + migrate', () => {
  test('migrates from 0 to the latest version, then is idempotent', () => {
    const db = openDatabase(':memory:');
    expect(db.schemaVersion()).toBe(0);
    expect(db.migrate()).toEqual({ from: 0, to: MIGRATIONS.length });
    expect(db.schemaVersion()).toBe(MIGRATIONS.length);
    expect(db.migrate()).toEqual({ from: MIGRATIONS.length, to: MIGRATIONS.length });
    const tables = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((r) => r.name);
    expect(tables).toEqual(expect.arrayContaining(['environments', 'operations', 'outbox', 'secret_refs', 'route_state', 'meta']));
    db.close();
  });

  test('refuses a database newer than the program', () => {
    const db = openDatabase(':memory:');
    db.migrate();
    db.run("UPDATE meta SET value = '999' WHERE key = 'schema_version'");
    expect(() => db.migrate()).toThrow(expect.objectContaining({ code: 'INTERNAL' }));
  });

  test('pragmas: foreign keys on, busy timeout 5000', () => {
    const db = openDatabase(':memory:');
    expect(db.get<{ foreign_keys: number }>('PRAGMA foreign_keys')?.foreign_keys).toBe(1);
    expect(db.get<{ timeout: number }>('PRAGMA busy_timeout')?.timeout).toBe(5000);
  });

  test('foreign keys are enforced', () => {
    const db = openDatabase(':memory:');
    db.migrate();
    expect(() =>
      db.run(
        `INSERT INTO proxy_revisions (environment_id, revision, protocol, host, port, front_proxy_id, node_name, state, created_at)
         VALUES ('env_missing', 1, 'socks5', '203.0.113.1', 1080, 'front_missing', 'SFE-N-E0001-US01-v001', 'desired', '2026-01-01T00:00:00.000Z')`,
      ),
    ).toThrow(/FOREIGN KEY/);
  });

  test('file database: created 0600, WAL, existing loose file tightened', () => {
    const dir = fresh();
    const path = join(dir, 'sfe.sqlite');
    const db = openDatabase(path);
    db.migrate();
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(db.get<{ journal_mode: string }>('PRAGMA journal_mode')?.journal_mode).toBe('wal');
    db.close();
    chmodSync(path, 0o644);
    const again = openDatabase(path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(again.schemaVersion()).toBe(MIGRATIONS.length);
    again.close();
  });

  test('refuses a symlinked database path', () => {
    const dir = fresh();
    const real = join(dir, 'real.sqlite');
    writeFileSync(real, '');
    const link = join(dir, 'link.sqlite');
    symlinkSync(real, link);
    expect(() => openDatabase(link)).toThrow();
  });

  test('normalises booleans and undefined parameters', () => {
    const db = openDatabase(':memory:');
    db.exec('CREATE TABLE t (a INTEGER, b TEXT)');
    db.run('INSERT INTO t VALUES (?, ?)', [true, undefined]);
    db.run('INSERT INTO t VALUES (:a, :b)', { a: false, b: 'x' });
    expect(db.all('SELECT a, b FROM t ORDER BY rowid')).toEqual([
      { a: 1, b: null },
      { a: 0, b: 'x' },
    ]);
  });

  test('close() makes further use fail', () => {
    const db = openDatabase(':memory:');
    db.close();
    expect(() => db.run('SELECT 1')).toThrow();
    expect(() => db.tx(() => 1)).toThrow();
    db.close();
  });
});

describe('tx', () => {
  const setup = () => {
    const db = openDatabase(':memory:');
    db.exec('CREATE TABLE t (v TEXT)');
    const values = () => db.all<{ v: string }>('SELECT v FROM t ORDER BY rowid').map((r) => r.v);
    return { db, values };
  };

  test('commits and returns the callback value', () => {
    const { db, values } = setup();
    expect(db.tx(() => (db.run("INSERT INTO t VALUES ('a')"), 42))).toBe(42);
    expect(values()).toEqual(['a']);
    expect(db.inTransaction()).toBe(false);
  });

  test('rolls back everything on error and rethrows', () => {
    const { db, values } = setup();
    expect(() =>
      db.tx(() => {
        db.run("INSERT INTO t VALUES ('a')");
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(values()).toEqual([]);
    expect(db.raw.isTransaction).toBe(false);
  });

  test('nested failure rolls back only the savepoint when caught', () => {
    const { db, values } = setup();
    db.tx(() => {
      db.run("INSERT INTO t VALUES ('outer')");
      expect(() =>
        db.tx(() => {
          db.run("INSERT INTO t VALUES ('inner')");
          throw new Error('inner failed');
        }),
      ).toThrow('inner failed');
      db.tx(() => db.run("INSERT INTO t VALUES ('inner-ok')"));
    });
    expect(values()).toEqual(['outer', 'inner-ok']);
  });

  test('nested failure that propagates rolls back the whole transaction', () => {
    const { db, values } = setup();
    expect(() =>
      db.tx(() => {
        db.run("INSERT INTO t VALUES ('outer')");
        db.tx(() => {
          db.run("INSERT INTO t VALUES ('inner')");
          throw new Error('x');
        });
      }),
    ).toThrow('x');
    expect(values()).toEqual([]);
  });

  test('three levels of nesting', () => {
    const { db, values } = setup();
    db.tx(() => {
      db.run("INSERT INTO t VALUES ('1')");
      db.tx(() => {
        db.run("INSERT INTO t VALUES ('2')");
        try {
          db.tx(() => {
            db.run("INSERT INTO t VALUES ('3')");
            throw new Error('lvl3');
          });
        } catch {
          // 只回滚第三层
        }
      });
    });
    expect(values()).toEqual(['1', '2']);
  });

  test('async callbacks are rejected and rolled back', () => {
    const { db, values } = setup();
    expect(() =>
      db.tx(async () => {
        db.run("INSERT INTO t VALUES ('a')");
      }),
    ).toThrow(/synchronous/);
    expect(values()).toEqual([]);
    expect(db.inTransaction()).toBe(false);
  });

  test('BEGIN IMMEDIATE takes the write lock: a second connection cannot write meanwhile', () => {
    const dir = fresh();
    const path = join(dir, 'lock.sqlite');
    const a = openDatabase(path);
    a.exec('CREATE TABLE t (v TEXT)');
    const b = openDatabase(path);
    b.exec('PRAGMA busy_timeout = 0');
    a.tx(() => {
      a.run("INSERT INTO t VALUES ('a')");
      expect(() => b.run("INSERT INTO t VALUES ('b')")).toThrow(/locked|busy/i);
    });
    b.run("INSERT INTO t VALUES ('b')");
    expect(a.all('SELECT v FROM t ORDER BY rowid')).toEqual([{ v: 'a' }, { v: 'b' }]);
    a.close();
    b.close();
  });
});

describe('sqlite ExperimentalWarning filter', () => {
  test('predicate matches only the sqlite experimental warning', () => {
    expect(isSqliteExperimentalWarning('SQLite is an experimental feature and might change at any time', 'ExperimentalWarning')).toBe(true);
    expect(isSqliteExperimentalWarning('SQLite is an experimental feature', { type: 'ExperimentalWarning' })).toBe(true);
    expect(isSqliteExperimentalWarning('VM Modules is an experimental feature', 'ExperimentalWarning')).toBe(false);
    expect(isSqliteExperimentalWarning('SQLite something', 'DeprecationWarning')).toBe(false);
  });

  test('process.emitWarning is restored after opening a database', () => {
    const before = process.emitWarning;
    openDatabase(':memory:').close();
    expect(process.emitWarning).toBe(before);
  });

  test('in a fresh process: the sqlite warning is suppressed, other warnings still print', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const serviceRoot = resolve(here, '..', '..');
    const tsx = resolve(serviceRoot, '..', 'node_modules', '.bin', 'tsx');
    const script = [
      "import { openDatabase } from './src/db/db.ts';",
      "const db = openDatabase(':memory:'); db.migrate(); db.close();",
      "process.emitWarning('canary-warning-for-test', 'ExperimentalWarning');",
    ].join('\n');
    const res = spawnSync(tsx, ['--eval', script], { cwd: serviceRoot, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } });
    expect(res.status).toBe(0);
    expect(res.stderr).toContain('canary-warning-for-test');
    expect(res.stderr).not.toMatch(/SQLite is an experimental/);
  }, 30_000);
});

describe('migration 2: local secret values, bridge_keychain_access removed', () => {
  /** 只执行到第 1 版（旧版钥匙串数据库的结构）。 */
  function v1Database(path: string | ':memory:' = ':memory:') {
    const db = openDatabase(path);
    db.exec(MIGRATIONS[0]!);
    db.run("INSERT INTO meta(key, value) VALUES('schema_version', '1')");
    return db;
  }
  const ctx = Object.fromEntries(CAPABILITY_CONTEXT_FIELDS.map((f) => [f, null])) as unknown as CapabilityContext;

  test('creates secret_values and drops bridge_keychain_access records and proposals; other rows stay', () => {
    const db = v1Database();
    const at = '2026-10-21T00:00:00.000Z';
    for (const key of ['bridge_keychain_access', 'native_bridge_ipc']) {
      db.run('INSERT INTO capabilities(key, status, context, verified_at, note) VALUES(?, ?, ?, ?, ?)', [key, 'supported', JSON.stringify(ctx), at, 'old']);
      db.run(
        `INSERT INTO capability_proposals(id, key, proposed_status, context, summary, evidence_digest, submitted_by, submitted_at)
         VALUES(?, ?, 'supported', ?, 'summary', 'sha256:00000000', 'agent', ?)`,
        [`prop_${key}`, key, JSON.stringify(ctx), at],
      );
    }
    db.run("INSERT INTO meta(key, value) VALUES('pepper_created', '1')");
    expect(db.migrate()).toEqual({ from: 1, to: MIGRATIONS.length });
    expect(db.all<{ key: string }>('SELECT key FROM capabilities').map((r) => r.key)).toEqual(['native_bridge_ipc']);
    expect(db.all<{ key: string }>('SELECT key FROM capability_proposals').map((r) => r.key)).toEqual(['native_bridge_ipc']);
    expect(db.all('SELECT * FROM secret_values')).toEqual([]);
    // 迁移本身不改 pepper 标志：旧版数据目录由启动时的检查拒绝（secrets/local-store.ts）
    expect(db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'pepper_created'")?.value).toBe('1');
    // 视图与门槛不受影响：只按现有能力项计算
    const repos = createRepositories(db);
    const views = computeCapabilityViews(repos.capabilities.list(), ctx);
    expect(views.map((v) => v.key)).toEqual([...CAPABILITY_KEYS]);
    expect(views.some((v) => (v.key as string) === 'bridge_keychain_access')).toBe(false);
    expect(repos.proposals.list({ pending: true }).map((p) => p.key)).toEqual(['native_bridge_ipc']);
    db.close();
  });

  test('secret_values enforces the kind set and unique refs', () => {
    const db = openDatabase(':memory:');
    db.migrate();
    const at = '2026-10-21T00:00:00.000Z';
    db.run('INSERT INTO secret_values(ref, kind, value, created_at) VALUES(?, ?, ?, ?)', ['sec_1', 'proxy', 'v', at]);
    expect(() => db.run('INSERT INTO secret_values(ref, kind, value, created_at) VALUES(?, ?, ?, ?)', ['sec_1', 'proxy', 'w', at])).toThrow();
    expect(() => db.run('INSERT INTO secret_values(ref, kind, value, created_at) VALUES(?, ?, ?, ?)', ['sec_2', 'keychain', 'w', at])).toThrow();
    db.close();
  });

  test('refuses a symlinked -wal next to the database', () => {
    const dir = fresh();
    const path = join(dir, 'sfe.sqlite');
    writeFileSync(join(dir, 'elsewhere'), '');
    symlinkSync(join(dir, 'elsewhere'), `${path}-wal`);
    expect(() => openDatabase(path)).toThrow(expect.objectContaining({ code: 'UNSAFE_LOCATION' }));
  });
});
