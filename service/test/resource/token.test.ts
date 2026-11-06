// 读取令牌：首次创建、沿用、找不到或格式不对时 fail closed（从不静默重新生成）、轮换。用内存秘密存储与真实 meta 仓库。
import { describe, expect, test } from 'vitest';
import { RESOURCE_TOKEN_RE, SfeError } from '@sfe/contract';
import { loadResourceToken, resourceTokenRefIndex, resourceTokenRefOf, rotateResourceToken, type ResourceTokenMeta } from '../../src/resource/index.js';
import { MemorySecretStore } from '../../src/secrets/memory-store.js';
import { makeRepos } from '../db/fixtures.js';

function fresh() {
  const { repos } = makeRepos();
  return { store: new MemorySecretStore(), meta: repos.meta };
}

async function failure(p: Promise<unknown>): Promise<SfeError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(SfeError);
    return err as SfeError;
  }
  throw new Error('expected a failure');
}

describe('loadResourceToken', () => {
  test('creates sfe.resource-token.1 (system kind, 64 hex) once, records the ref, then reuses it', async () => {
    const { store, meta } = fresh();
    const token = await loadResourceToken(store, meta);
    expect(token).toMatch(RESOURCE_TOKEN_RE);
    expect(meta.resourceTokenRef()).toBe('sfe.resource-token.1');
    expect(store.kindOf('sfe.resource-token.1')).toBe('system');
    expect(await loadResourceToken(store, meta)).toBe(token);
    expect(store.calls.filter((c) => c.op === 'put')).toEqual([{ op: 'put', ref: 'sfe.resource-token.1', kind: 'system' }]);
  });

  test('tokens are random', async () => {
    const a = await loadResourceToken(fresh().store, fresh().meta);
    const b = await loadResourceToken(fresh().store, fresh().meta);
    expect(a).not.toBe(b);
  });

  test('a value written before the ref was recorded (crash) is adopted, not overwritten', async () => {
    const { store, meta } = fresh();
    await store.put('sfe.resource-token.1', 'c'.repeat(64), 'system');
    expect(await loadResourceToken(store, meta)).toBe('c'.repeat(64));
    expect(meta.resourceTokenRef()).toBe('sfe.resource-token.1');
    expect(store.calls.filter((c) => c.op === 'put')).toHaveLength(1);
  });

  test('a malformed leftover value is refused', async () => {
    const { store, meta } = fresh();
    await store.put('sfe.resource-token.1', 'not-a-token', 'system');
    const err = await failure(loadResourceToken(store, meta));
    expect(err.code).toBe('SECRET_STORE_FAILED');
    expect(err.details).toEqual({ reason: 'bad_format' });
    expect(meta.resourceTokenRef()).toBeNull();
  });

  test('ref recorded but the value is missing → not_found, never regenerated', async () => {
    const { store, meta } = fresh();
    meta.setResourceTokenRef('sfe.resource-token.3');
    const err = await failure(loadResourceToken(store, meta));
    expect(err.code).toBe('SECRET_STORE_FAILED');
    expect(err.details).toEqual({ reason: 'not_found' });
    expect(store.calls.filter((c) => c.op === 'put')).toEqual([]);
    expect(store.size).toBe(0);
    expect(meta.resourceTokenRef()).toBe('sfe.resource-token.3');
  });

  test('a stored value with the wrong format → bad_format (and the value is not echoed)', async () => {
    const { store, meta } = fresh();
    const bad = 'A'.repeat(64);
    await store.put('sfe.resource-token.1', bad, 'system');
    meta.setResourceTokenRef('sfe.resource-token.1');
    const err = await failure(loadResourceToken(store, meta));
    expect(err.details).toEqual({ reason: 'bad_format' });
    expect(err.message).not.toContain(bad);
    expect(JSON.stringify(err.details)).not.toContain(bad);
  });

  test('a malformed ref → bad_format', async () => {
    const store = new MemorySecretStore();
    const meta: ResourceTokenMeta = { resourceTokenRef: () => 'sfe.pepper', setResourceTokenRef: () => undefined };
    expect((await failure(loadResourceToken(store, meta))).details).toEqual({ reason: 'bad_format' });
    expect(store.calls).toEqual([]);
  });

  test('secret store failures propagate; nothing is recorded when the write fails', async () => {
    const { store, meta } = fresh();
    store.injectFailure('put', 'other');
    expect((await failure(loadResourceToken(store, meta))).details).toEqual({ reason: 'other' });
    expect(meta.resourceTokenRef()).toBeNull();
    store.injectFailure('get', 'other');
    expect((await failure(loadResourceToken(store, meta))).code).toBe('SECRET_STORE_FAILED');
    // 之后正常创建
    expect(await loadResourceToken(store, meta)).toMatch(RESOURCE_TOKEN_RE);
  });
});

describe('rotateResourceToken', () => {
  test('creates the next ref and returns it with the new token; the current ref stays until the caller commits', async () => {
    const { store, meta } = fresh();
    const first = await loadResourceToken(store, meta);
    const next = await rotateResourceToken(store, meta);
    expect(next.ref).toBe('sfe.resource-token.2');
    expect(next.token).toMatch(RESOURCE_TOKEN_RE);
    expect(next.token).not.toBe(first);
    expect(store.kindOf('sfe.resource-token.2')).toBe('system');
    expect(meta.resourceTokenRef()).toBe('sfe.resource-token.1');
    expect(await loadResourceToken(store, meta)).toBe(first);
    // 调用方提交：改写引用，再删除旧值
    meta.setResourceTokenRef(next.ref);
    await store.delete('sfe.resource-token.1');
    expect(await loadResourceToken(store, meta)).toBe(next.token);
  });

  test('a ref left behind by an interrupted rotation is never reused', async () => {
    const { store, meta } = fresh();
    await loadResourceToken(store, meta);
    await store.put('sfe.resource-token.2', 'd'.repeat(64), 'system');
    const next = await rotateResourceToken(store, meta);
    expect(next.ref).toBe('sfe.resource-token.3');
    expect(next.token).not.toBe('d'.repeat(64));
  });

  test('refuses to rotate without a current token or with a malformed ref', async () => {
    const { store, meta } = fresh();
    expect((await failure(rotateResourceToken(store, meta))).details).toEqual({ reason: 'not_found' });
    const badMeta: ResourceTokenMeta = { resourceTokenRef: () => 'sfe.resource-token.x', setResourceTokenRef: () => undefined };
    expect((await failure(rotateResourceToken(store, badMeta))).details).toEqual({ reason: 'bad_format' });
    expect(store.size).toBe(0);
  });
});

describe('ref helpers', () => {
  test('format and parse', () => {
    expect(resourceTokenRefOf(1)).toBe('sfe.resource-token.1');
    expect(resourceTokenRefOf(42)).toBe('sfe.resource-token.42');
    expect(() => resourceTokenRefOf(0)).toThrow(RangeError);
    expect(resourceTokenRefIndex('sfe.resource-token.42')).toBe(42);
    for (const bad of ['sfe.resource-token.0', 'sfe.resource-token.01', 'sfe.resource-token.', 'sfe.pepper', 'sfe.resource-token.1 ']) {
      expect(resourceTokenRefIndex(bad)).toBeNull();
    }
  });
});
