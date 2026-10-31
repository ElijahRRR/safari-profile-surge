import { createHash, createHmac } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { MemorySecretStore } from '../../src/secrets/memory-store.js';
import { fingerprint, loadPepper, PEPPER_REF, pepperKey } from '../../src/secrets/pepper.js';
import { createIdGenerator } from '../../src/util/ids.js';
import { makeRepos } from '../db/fixtures.js';

const ids = createIdGenerator();

describe('loadPepper', () => {
  test('first start creates a 32-byte system secret and sets the flag; later loads return the same pepper', async () => {
    const { repos } = makeRepos();
    const store = new MemorySecretStore();
    const p1 = await loadPepper(store, repos.meta, ids);
    expect(p1).toHaveLength(32);
    expect(store.kindOf(PEPPER_REF)).toBe('system');
    expect(repos.meta.pepperCreated()).toBe(true);
    const p2 = await loadPepper(store, repos.meta, ids);
    expect(p2.equals(p1)).toBe(true);
    expect(store.calls.filter((c) => c.op === 'put')).toHaveLength(1);
  });

  test('fails closed when the flag is set but the secret is missing, and never regenerates', async () => {
    const { repos } = makeRepos();
    const store = new MemorySecretStore();
    await loadPepper(store, repos.meta, ids);
    await store.delete(PEPPER_REF);
    await expect(loadPepper(store, repos.meta, ids)).rejects.toMatchObject({ code: 'SECRET_STORE_FAILED', details: { reason: 'not_found' } });
    expect(store.has(PEPPER_REF)).toBe(false);
    expect(store.calls.filter((c) => c.op === 'put')).toHaveLength(1);
  });

  test('an existing pepper with a missing flag (crash after the write, before the flag) is adopted', async () => {
    const a = makeRepos();
    const store = new MemorySecretStore();
    const original = await loadPepper(store, a.repos.meta, ids);
    const b = makeRepos();
    expect(b.repos.meta.pepperCreated()).toBe(false);
    const adopted = await loadPepper(store, b.repos.meta, ids);
    expect(adopted.equals(original)).toBe(true);
    expect(b.repos.meta.pepperCreated()).toBe(true);
  });

  test('a failed read propagates and creates nothing', async () => {
    const { repos } = makeRepos();
    const store = new MemorySecretStore();
    store.injectFailure('get', 'other');
    await expect(loadPepper(store, repos.meta, ids)).rejects.toMatchObject({ code: 'SECRET_STORE_FAILED', details: { reason: 'other' } });
    expect(store.size).toBe(0);
    expect(repos.meta.pepperCreated()).toBe(false);
  });

  test('a failed first write does not set the flag, so a retry may create it', async () => {
    const { repos } = makeRepos();
    const store = new MemorySecretStore();
    store.injectFailure('put', 'other');
    await expect(loadPepper(store, repos.meta, ids)).rejects.toMatchObject({ details: { reason: 'other' } });
    expect(repos.meta.pepperCreated()).toBe(false);
    await expect(loadPepper(store, repos.meta, ids)).resolves.toHaveLength(32);
  });

  test('a malformed stored pepper fails closed', async () => {
    const { repos } = makeRepos();
    const store = new MemorySecretStore();
    await store.put(PEPPER_REF, 'too-short', 'system');
    await expect(loadPepper(store, repos.meta, ids)).rejects.toMatchObject({ code: 'SECRET_STORE_FAILED' });
  });
});

describe('fingerprint', () => {
  const pepper = Buffer.alloc(32, 3);

  test('deterministic keyed hex digest that depends on the pepper', () => {
    const f = fingerprint(pepper, 'proxy-user-1');
    expect(f).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprint(pepper, 'proxy-user-1')).toBe(f);
    expect(fingerprint(Buffer.alloc(32, 4), 'proxy-user-1')).not.toBe(f);
    expect(fingerprint(pepper, 'proxy-user-2')).not.toBe(f);
  });

  test('is neither an unkeyed hash nor an HMAC with the raw pepper', () => {
    const f = fingerprint(pepper, 'v');
    expect(f).not.toBe(createHash('sha256').update('v').digest('hex'));
    expect(f).not.toBe(createHmac('sha256', pepper).update('v').digest('hex'));
  });

  test('purpose keys are distinct', () => {
    const keys = (['fp', 'request', 'file', 'preview', 'session'] as const).map((p) => pepperKey(pepper, p).toString('hex'));
    expect(new Set(keys).size).toBe(keys.length);
  });
});
