import { describe, expect, test } from 'vitest';
import type { SecretStore } from '../../src/ports.js';
import { MemorySecretStore } from '../../src/secrets/memory-store.js';
import { secretStoreError } from '../../src/secrets/errors.js';
import { SecretRefManager } from '../../src/secrets/secret-ref-manager.js';
import { createIdGenerator } from '../../src/util/ids.js';
import { makeRepos, seedEnvironment, seedFront, seedRevision } from '../db/fixtures.js';

function setup(store: SecretStore = new MemorySecretStore()) {
  const t = makeRepos();
  const mgr = new SecretRefManager(t.repos, store, createIdGenerator({ now: () => t.clock.now().getTime() }), t.clock);
  return { ...t, store, mgr };
}

const TEN_MIN = 10 * 60 * 1000;

describe('createSecret / markCommitted', () => {
  test('inserts a pending ref, writes the store, then commits inside the caller transaction', async () => {
    const { repos, store, mgr } = setup();
    const ref = await mgr.createSecret('proxy-pw-1', 'proxy', { kind: 'environment', id: 'env_1' });
    expect(ref).toMatch(/^sec_[0-9A-Z]{26}$/);
    expect(repos.secretRefs.get(ref)).toMatchObject({ state: 'pending', kind: 'proxy', ownerKind: 'environment', ownerId: 'env_1' });
    expect(await store.get(ref)).toBe('proxy-pw-1');
    repos.tx(() => mgr.markCommitted(ref));
    expect(repos.secretRefs.get(ref)?.state).toBe('committed');
    // 幂等
    repos.tx(() => mgr.markCommitted(ref));
  });

  test('the pending row is committed before the store write starts (step 1 before step 2)', async () => {
    const t = makeRepos();
    const seen: string[] = [];
    const store: SecretStore = {
      put: async (ref) => {
        seen.push(t.repos.secretRefs.get(ref)?.state ?? 'missing');
        // 写秘密存储时不在任何事务中
        seen.push(String(t.db.inTransaction()));
      },
      get: async () => null,
      delete: async () => undefined,
    };
    const mgr = new SecretRefManager(t.repos, store, createIdGenerator(), t.clock);
    await mgr.createSecret('v-1', 'proxy', { kind: 'environment', id: 'e' });
    expect(seen).toEqual(['pending', 'false']);
  });

  test('markCommitted on a missing or orphaned ref throws and rolls back the caller transaction', async () => {
    const { repos, mgr } = setup();
    seedFront(repos);
    const env = seedEnvironment(repos);
    expect(() =>
      repos.tx(() => {
        seedRevision(repos, env, 1, { passwordRef: 'sec_NOT_CREATED' });
        mgr.markCommitted('sec_NOT_CREATED');
      }),
    ).toThrow(expect.objectContaining({ code: 'SECRET_STORE_FAILED' }));
    expect(repos.proxyRevisions.get(env.id, 1)).toBeNull();
    const ref = await mgr.createSecret('v-2', 'proxy', { kind: 'environment', id: env.id });
    repos.tx(() => mgr.orphan(ref));
    expect(() => repos.tx(() => mgr.markCommitted(ref))).toThrow(expect.objectContaining({ code: 'SECRET_STORE_FAILED' }));
  });

  test('store failure removes the pending row and propagates the error (recoverable, nothing committed)', async () => {
    const store = new MemorySecretStore();
    const { repos, mgr } = setup(store);
    store.injectFailure('put', 'other');
    const err = await mgr.createSecret('never-stored', 'account', { kind: 'account', id: 'env_1' }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'SECRET_STORE_FAILED', details: { reason: 'other' } });
    expect(repos.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM secret_refs')?.n).toBe(0);
    expect(store.size).toBe(0);
  });

  test('a write that landed before the failure is deleted from the store too', async () => {
    const inner = new MemorySecretStore();
    const store: SecretStore = {
      put: async (ref, value, kind) => {
        await inner.put(ref, value, kind);
        throw secretStoreError('put', 'other');
      },
      get: (ref) => inner.get(ref),
      delete: (ref) => inner.delete(ref),
    };
    const { repos, mgr } = setup(store);
    await expect(mgr.createSecret('landed', 'proxy', { kind: 'environment', id: 'e' })).rejects.toMatchObject({ details: { reason: 'other' } });
    expect(inner.size).toBe(0);
    expect(repos.secretRefs.listStalePending(new Date('2100-01-01'))).toEqual([]);
  });

  test('if cleanup also fails, the pending row stays for the sweeper', async () => {
    const store = new MemorySecretStore();
    const { repos, mgr, clock } = setup(store);
    store.injectFailure('put', 'other');
    store.injectFailure('delete', 'other');
    await expect(mgr.createSecret('v', 'proxy', { kind: 'environment', id: 'e' })).rejects.toMatchObject({ details: { reason: 'other' } });
    const pending = repos.secretRefs.listStalePending(new Date('2100-01-01'));
    expect(pending).toHaveLength(1);
    clock.advance(TEN_MIN + 1);
    const res = await mgr.sweep();
    expect(res.deleted).toEqual([pending[0]!.ref]);
    expect(repos.secretRefs.get(pending[0]!.ref)).toBeNull();
  });

  test('non-SfeError store failures are wrapped without details of the value', async () => {
    const store: SecretStore = {
      put: async (_ref, value) => {
        throw new Error(`raw failure including ${value}`);
      },
      get: async () => null,
      delete: async () => undefined,
    };
    const { mgr } = setup(store);
    const err = (await mgr.createSecret('Wrapped-Value-1', 'proxy', { kind: 'environment', id: 'e' }).catch((e: unknown) => e)) as Error;
    expect(err).toMatchObject({ code: 'SECRET_STORE_FAILED' });
    expect(err.message).not.toContain('Wrapped-Value-1');
    expect((err as Error & { cause?: unknown }).cause).toBeUndefined();
  });

  test('createSecret refuses to run inside a database transaction', async () => {
    const { repos, mgr } = setup();
    let promise: Promise<string> | null = null;
    repos.tx(() => {
      promise = mgr.createSecret('v', 'proxy', { kind: 'environment', id: 'e' });
    });
    await expect(promise!).rejects.toThrow(/transaction/);
  });
});

describe('reference-counted reclamation', () => {
  test('ARCHITECTURE §4: host changed with password kept shares the ref; retiring the old revision keeps the secret', async () => {
    const { repos, store, mgr } = setup();
    seedFront(repos);
    const env = seedEnvironment(repos);
    const pw = await mgr.createSecret('shared-pw-1', 'proxy', { kind: 'environment', id: env.id });
    repos.tx(() => {
      seedRevision(repos, env, 1, { passwordRef: pw, passwordFp: 'f1', state: 'deployed' });
      mgr.markCommitted(pw);
    });
    // r2：只改地址，密码 keep → 沿用同一引用
    repos.tx(() => {
      seedRevision(repos, env, 2, { host: '203.0.113.99', passwordRef: pw, passwordFp: 'f1', state: 'desired' });
      repos.proxyRevisions.updateState(env.id, 1, 'retired');
      expect(mgr.orphanIfUnreferenced(pw)).toBe(false);
      // 即使调用方保守地标记了 orphaned，清扫也按引用判断
      mgr.orphan(pw);
    });
    const res = await mgr.sweep();
    expect(res).toEqual({ deleted: [], kept: [pw], failed: [] });
    expect(await store.get(pw)).toBe('shared-pw-1');
    expect(repos.secretRefs.get(pw)?.state).toBe('committed');

    // r2 也退役后才回收
    repos.tx(() => {
      repos.proxyRevisions.updateState(env.id, 2, 'retired');
      expect(mgr.orphanIfUnreferenced(pw)).toBe(true);
    });
    expect((await mgr.sweep()).deleted).toEqual([pw]);
    expect(await store.get(pw)).toBeNull();
    expect(repos.secretRefs.get(pw)).toBeNull();
  });

  test('superseded revisions (rollback targets) still keep their secrets', async () => {
    const store = new MemorySecretStore();
    const { repos, mgr } = setup(store);
    seedFront(repos);
    const env = seedEnvironment(repos);
    const pw = await mgr.createSecret('old-pw', 'proxy', { kind: 'environment', id: env.id });
    repos.tx(() => {
      seedRevision(repos, env, 1, { passwordRef: pw, state: 'superseded' });
      mgr.markCommitted(pw);
      mgr.orphan(pw);
    });
    expect((await mgr.sweep()).kept).toEqual([pw]);
    expect(store.has(pw)).toBe(true);
  });

  test('account password replace orphans the old ref in the same transaction; sweep deletes it', async () => {
    const store = new MemorySecretStore();
    const { repos, mgr } = setup(store);
    const env = seedEnvironment(repos);
    const oldRef = await mgr.createSecret('login-old', 'account', { kind: 'account', id: env.id });
    repos.tx(() => {
      repos.accounts.insert({ environmentId: env.id, label: null, loginIdentifier: 'buyer01@example.test', passwordRef: oldRef, passwordFp: 'o' });
      mgr.markCommitted(oldRef);
    });
    const newRef = await mgr.createSecret('login-new', 'account', { kind: 'account', id: env.id });
    repos.tx(() => {
      repos.accounts.update(env.id, { passwordRef: newRef, passwordFp: 'n', changedSincePageCheck: true });
      mgr.markCommitted(newRef);
      mgr.orphan(oldRef);
    });
    expect(repos.secretRefs.get(oldRef)?.state).toBe('orphaned');
    const res = await mgr.sweep();
    expect(res.deleted).toEqual([oldRef]);
    expect(store.has(oldRef)).toBe(false);
    expect(store.has(newRef)).toBe(true);
    // 账号密码保存在本机后台资料中，服务可以读出（登录填充按 §6.10 把关后使用）
    expect(await store.get(newRef)).toBe('login-new');
  });

  test('account password clear: orphaned and reclaimed', async () => {
    const store = new MemorySecretStore();
    const { repos, mgr } = setup(store);
    const env = seedEnvironment(repos);
    const ref = await mgr.createSecret('login-x', 'account', { kind: 'account', id: env.id });
    repos.tx(() => {
      repos.accounts.insert({ environmentId: env.id, label: null, loginIdentifier: null, passwordRef: ref, passwordFp: 'x' });
      mgr.markCommitted(ref);
    });
    repos.tx(() => {
      repos.accounts.update(env.id, { passwordRef: null, passwordFp: null });
      mgr.orphan(ref);
    });
    expect((await mgr.sweep()).deleted).toEqual([ref]);
    expect(store.size).toBe(0);
  });

  test('stale pending refs (older than 10 minutes) are swept; fresh ones are left alone', async () => {
    const store = new MemorySecretStore();
    const { mgr, clock, repos } = setup(store);
    const stale = await mgr.createSecret('a', 'proxy', { kind: 'environment', id: 'e' });
    clock.advance(TEN_MIN - 1000);
    const fresh = await mgr.createSecret('b', 'proxy', { kind: 'environment', id: 'e' });
    clock.advance(2000);
    const res = await mgr.sweep();
    expect(res.deleted).toEqual([stale]);
    expect(repos.secretRefs.get(fresh)?.state).toBe('pending');
    expect(store.has(fresh)).toBe(true);
    // 自定义阈值
    expect((await mgr.sweep({ pendingOlderThanMs: 0, now: new Date(clock.now().getTime() + 1) })).deleted).toEqual([fresh]);
  });

  test('a stale pending ref that is actually referenced is healed to committed, not deleted', async () => {
    const { repos, store, mgr, clock } = setup();
    seedFront(repos);
    const env = seedEnvironment(repos);
    const ref = await mgr.createSecret('v', 'proxy', { kind: 'environment', id: env.id });
    seedRevision(repos, env, 1, { usernameRef: ref });
    clock.advance(TEN_MIN + 1);
    expect((await mgr.sweep()).kept).toEqual([ref]);
    expect(repos.secretRefs.get(ref)?.state).toBe('committed');
    expect(await store.get(ref)).toBe('v');
  });

  test('store delete failure keeps the row for the next sweep', async () => {
    const store = new MemorySecretStore();
    const { repos, mgr } = setup(store);
    const ref = await mgr.createSecret('v', 'proxy', { kind: 'environment', id: 'e' });
    repos.tx(() => mgr.orphan(ref));
    store.injectFailure('delete', 'other');
    expect(await mgr.sweep()).toEqual({ deleted: [], kept: [], failed: [ref] });
    expect(repos.secretRefs.get(ref)?.state).toBe('orphaned');
    expect((await mgr.sweep()).deleted).toEqual([ref]);
  });

  test('sweep refuses to run inside a transaction', async () => {
    const { repos, mgr } = setup();
    let p: Promise<unknown> | null = null;
    repos.tx(() => {
      p = mgr.sweep();
    });
    await expect(p!).rejects.toThrow(/transaction/);
  });
});

describe('discard', () => {
  test('removes an unused pending ref from store and table', async () => {
    const store = new MemorySecretStore();
    const { repos, mgr } = setup(store);
    const ref = await mgr.createSecret('v', 'proxy', { kind: 'environment', id: 'e' });
    expect(await mgr.discard(ref)).toBe(true);
    expect(store.has(ref)).toBe(false);
    expect(repos.secretRefs.get(ref)).toBeNull();
  });

  test('refuses to discard a referenced ref', async () => {
    const { repos, mgr, store } = setup();
    const env = seedEnvironment(repos);
    const ref = await mgr.createSecret('v', 'account', { kind: 'account', id: env.id });
    repos.accounts.insert({ environmentId: env.id, label: null, loginIdentifier: null, passwordRef: ref, passwordFp: null });
    await expect(mgr.discard(ref)).rejects.toMatchObject({ code: 'INTERNAL' });
    expect((store as MemorySecretStore).has(ref)).toBe(true);
  });

  test('store failure marks the ref orphaned for later sweep and does not throw', async () => {
    const store = new MemorySecretStore();
    const { repos, mgr } = setup(store);
    const ref = await mgr.createSecret('v', 'proxy', { kind: 'environment', id: 'e' });
    store.injectFailure('delete', 'other');
    expect(await mgr.discard(ref)).toBe(false);
    expect(repos.secretRefs.get(ref)?.state).toBe('orphaned');
    expect((await mgr.sweep()).deleted).toEqual([ref]);
  });
});
