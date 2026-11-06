// 本机资源服务（D10）的数据库部分：迁移 7、内部设置 resourcePort、meta 中的读取令牌引用。只用合成数据。
import { describe, expect, test } from 'vitest';
import { CAPABILITY_CONTEXT_FIELDS, RESOURCE_PORT_MAX, RESOURCE_PORT_MIN, type CapabilityContext } from '@sfe/contract';
import { openDatabase } from '../../src/db/db.js';
import { createRepositories } from '../../src/db/index.js';
import { isResourcePort } from '../../src/db/repos/settings.js';
import { MIGRATIONS } from '../../src/db/schema.js';
import { createEngineKv } from '../../src/engine/kv.js';
import { readNeedsRefresh } from '../../src/resource/state.js';
import { makeRepos } from './fixtures.js';

const AT = '2026-10-31T00:00:00.000Z';

describe('migration 7: loopback node resource (D10)', () => {
  /** 只执行到第 6 版。 */
  function v6Database() {
    const db = openDatabase(':memory:');
    for (const m of MIGRATIONS.slice(0, 6)) db.exec(m);
    db.run("INSERT INTO meta(key, value) VALUES('schema_version', '6')");
    return db;
  }
  const ctx = JSON.stringify(Object.fromEntries(CAPABILITY_CONTEXT_FIELDS.map((f) => [f, null])) as unknown as CapabilityContext);

  test('drops the local-file capability records, proposals and resource-file digests; other rows stay', () => {
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(7);
    const db = v6Database();
    const keys = ['targeted_resource_refresh', 'policy_path_reread', 'connection_continuity', 'native_bridge_ipc', 'auto_reload_atomic_replace'];
    for (const key of keys) {
      db.run('INSERT INTO capabilities(key, status, context, verified_at, note) VALUES(?, ?, ?, ?, ?)', [key, 'supported', ctx, AT, 'old']);
      db.run(
        `INSERT INTO capability_proposals(id, key, proposed_status, context, summary, evidence_digest, submitted_by, submitted_at)
         VALUES(?, ?, 'supported', ?, 'summary', 'sha256:00000000', 'agent', ?)`,
        [`prop_${key}`, key, ctx, AT],
      );
    }
    const meta: Array<[string, string]> = [
      ['engine:mo_prev:resource_file:sfe-nodes.list', '{"digest":"d1"}'],
      ['engine:mo_prev:resource_file:other.list', '{"digest":"d2"}'],
      // 下划线不是通配符：相似的键不删
      ['engine:moXprev:resourceXfile:sfe-nodes.list', '{"digest":"d3"}'],
      ['engine:mo_prev:entry_ruleset_file:sfe-entry-udp.list', '{"digest":"d4"}'],
      ['engine:mo_prev:group_segment:SFE-ROUTE', '{"digest":"d5"}'],
      ['engine:resource:writeBaseline', '{"bodyDigest":"d6","membersBefore":["REJECT"]}'],
      ['engine:resource:needsRefresh', '{"operationId":"op_01"}'],
      ['pepper_created', '1'],
    ];
    for (const [k, v] of meta) db.run('INSERT INTO meta(key, value) VALUES(?, ?)', [k, v]);
    db.run(
      `INSERT INTO managed_objects(id, kind, identity, content_digest, state, updated_at)
       VALUES('mo_res', 'resource_file', 'sfe-nodes.list', 'digest-res', 'present', ?)`,
      [AT],
    );

    expect(db.migrate()).toEqual({ from: 6, to: MIGRATIONS.length });

    const capKeys = db.all<{ key: string }>('SELECT key FROM capabilities ORDER BY key').map((r) => r.key);
    expect(capKeys).toEqual(['auto_reload_atomic_replace', 'native_bridge_ipc']);
    const propKeys = db.all<{ key: string }>('SELECT key FROM capability_proposals ORDER BY key').map((r) => r.key);
    expect(propKeys).toEqual(['auto_reload_atomic_replace', 'native_bridge_ipc']);
    const metaKeys = db.all<{ key: string }>("SELECT key FROM meta WHERE key <> 'schema_version' ORDER BY key").map((r) => r.key);
    expect(metaKeys).toEqual([
      'engine:moXprev:resourceXfile:sfe-nodes.list',
      'engine:mo_prev:entry_ruleset_file:sfe-entry-udp.list',
      'engine:mo_prev:group_segment:SFE-ROUTE',
      'engine:resource:needsRefresh',
      'pepper_created',
    ]);
    // 旧的本地节点文件可能仍在磁盘上：归属记录不在迁移中改动（由重新合并确认改用资源服务后清除）
    expect(db.get('SELECT kind, identity, content_digest, state FROM managed_objects WHERE id = ?', ['mo_res'])).toEqual({
      kind: 'resource_file',
      identity: 'sfe-nodes.list',
      content_digest: 'digest-res',
      state: 'present',
    });
    db.close();
  });

  test('a fresh database migrates through 7 and is idempotent', () => {
    const db = openDatabase(':memory:');
    expect(db.migrate()).toEqual({ from: 0, to: MIGRATIONS.length });
    expect(db.migrate()).toEqual({ from: MIGRATIONS.length, to: MIGRATIONS.length });
    db.close();
  });

  test('the legacy needsRefresh record still reads as needing a refresh after the migration (fail closed)', () => {
    const db = v6Database();
    db.run("INSERT INTO meta(key, value) VALUES('engine:resource:needsRefresh', '{\"operationId\":\"op_01\"}')");
    db.migrate();
    expect(readNeedsRefresh(createEngineKv(db))).toEqual({ generation: 0, reason: 'unreadable' });
    db.close();
  });
});

describe('settings: resourcePort (internal)', () => {
  test('defaults to null, accepts only integers in [MIN, MAX) or null, through setResourcePort only', () => {
    const { repos } = makeRepos();
    expect(repos.settings.get('resourcePort')).toBeNull();
    repos.settings.setResourcePort(RESOURCE_PORT_MIN);
    expect(repos.settings.get('resourcePort')).toBe(RESOURCE_PORT_MIN);
    repos.settings.setResourcePort(RESOURCE_PORT_MAX - 1);
    expect(repos.settings.getAll().resourcePort).toBe(RESOURCE_PORT_MAX - 1);
    for (const bad of [RESOURCE_PORT_MIN - 1, RESOURCE_PORT_MAX, 0, -1, 65535, 18084, 20000.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => repos.settings.setResourcePort(bad)).toThrow(TypeError);
    }
    expect(() => repos.settings.setResourcePort('20001' as unknown as number)).toThrow(TypeError);
    expect(repos.settings.get('resourcePort')).toBe(RESOURCE_PORT_MAX - 1);
    repos.settings.setResourcePort(null);
    expect(repos.settings.get('resourcePort')).toBeNull();
  });

  test('the generic set/reset refuse the internal key', () => {
    const { repos } = makeRepos();
    const anySettings = repos.settings as unknown as { set(k: string, v: unknown): void; reset(k: string): void };
    expect(() => anySettings.set('resourcePort', 23456)).toThrow(TypeError);
    expect(() => anySettings.reset('resourcePort')).toThrow(TypeError);
    expect(repos.settings.get('resourcePort')).toBeNull();
  });

  test('never appears in the settings view', () => {
    const { repos } = makeRepos();
    repos.settings.setResourcePort(23456);
    const view = repos.settings.view('/Applications/Surge.app/Contents/Applications/surge-cli');
    expect(Object.keys(view)).not.toContain('resourcePort');
    expect(JSON.stringify(view)).not.toContain('23456');
  });

  test('a stored out-of-range or corrupt value reads as the default', () => {
    const { repos } = makeRepos();
    repos.db.run("INSERT INTO settings(key, value) VALUES('resourcePort', '18084')");
    expect(repos.settings.get('resourcePort')).toBeNull();
    repos.db.run("UPDATE settings SET value = '\"23456\"' WHERE key = 'resourcePort'");
    expect(repos.settings.get('resourcePort')).toBeNull();
    repos.db.run("UPDATE settings SET value = '23456' WHERE key = 'resourcePort'");
    expect(repos.settings.get('resourcePort')).toBe(23456);
  });

  test('isResourcePort', () => {
    expect(isResourcePort(RESOURCE_PORT_MIN)).toBe(true);
    expect(isResourcePort(RESOURCE_PORT_MAX - 1)).toBe(true);
    expect(isResourcePort(RESOURCE_PORT_MAX)).toBe(false);
    expect(isResourcePort(RESOURCE_PORT_MIN - 1)).toBe(false);
    expect(isResourcePort(null)).toBe(false);
  });
});

describe('meta: resourceTokenRef', () => {
  test('null until set; only token refs are accepted; never holds the token value', () => {
    const { repos, db } = makeRepos();
    expect(repos.meta.resourceTokenRef()).toBeNull();
    repos.meta.setResourceTokenRef('sfe.resource-token.1');
    expect(repos.meta.resourceTokenRef()).toBe('sfe.resource-token.1');
    repos.meta.setResourceTokenRef('sfe.resource-token.12');
    expect(repos.meta.resourceTokenRef()).toBe('sfe.resource-token.12');
    for (const bad of ['', 'sfe.resource-token.0', 'sfe.resource-token.01', 'sfe.resource-token.x', 'sfe.pepper', 'a'.repeat(64)]) {
      expect(() => repos.meta.setResourceTokenRef(bad)).toThrow(RangeError);
    }
    expect(repos.meta.resourceTokenRef()).toBe('sfe.resource-token.12');
    // 与引擎 kv（engine: 前缀）分开
    expect(db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'resource_token_ref'")?.value).toBe('sfe.resource-token.12');
  });

  test('createRepositories over a migrated database exposes the new members', () => {
    const db = openDatabase(':memory:');
    db.migrate();
    const repos = createRepositories(db);
    expect(repos.meta.resourceTokenRef()).toBeNull();
    expect(repos.settings.get('resourcePort')).toBeNull();
    db.close();
  });
});
