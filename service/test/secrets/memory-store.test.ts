import { describe, expect, test } from 'vitest';
import { MemorySecretStore } from '../../src/secrets/memory-store.js';
import { isSecretStoreFailure } from '../../src/secrets/errors.js';

describe('MemorySecretStore', () => {
  test('put/get/delete round-trip for proxy and system secrets', async () => {
    const s = new MemorySecretStore();
    await s.put('sec_1', 'proxy-pw-1', 'proxy');
    await s.put('sfe.pepper', 'pep', 'system');
    expect(await s.get('sec_1')).toBe('proxy-pw-1');
    expect(await s.get('sfe.pepper')).toBe('pep');
    await s.delete('sec_1');
    expect(await s.get('sec_1')).toBeNull();
    expect(s.size).toBe(1);
  });

  test('account secrets are readable through get(), like the local store (login fill reads them after §6.10 gating)', async () => {
    const s = new MemorySecretStore();
    await s.put('sec_acc', 'login-pw-1', 'account');
    expect(await s.get('sec_acc')).toBe('login-pw-1');
    expect(s.kindOf('sec_acc')).toBe('account');
  });

  test('refs are never overwritten', async () => {
    const s = new MemorySecretStore();
    await s.put('sec_1', 'a-value', 'proxy');
    await expect(s.put('sec_1', 'b-value', 'proxy')).rejects.toMatchObject({ code: 'SECRET_STORE_FAILED' });
    expect(await s.get('sec_1')).toBe('a-value');
  });

  test('delete of a missing ref is a no-op', async () => {
    await expect(new MemorySecretStore().delete('nope')).resolves.toBeUndefined();
  });

  test('injected failures carry a reason and never the value', async () => {
    const s = new MemorySecretStore();
    s.injectFailure('put', 'other');
    const err = await s.put('sec_1', 'value-not-in-error', 'proxy').catch((e: unknown) => e);
    expect(isSecretStoreFailure(err, 'other')).toBe(true);
    expect(JSON.stringify({ m: (err as Error).message, d: (err as { details?: unknown }).details })).not.toContain('value-not-in-error');
    await expect(s.put('sec_1', 'v', 'proxy')).resolves.toBeUndefined();
    s.injectFailure('get', 'not_found', 2);
    await expect(s.get('sec_1')).rejects.toMatchObject({ details: { reason: 'not_found' } });
    await expect(s.get('sec_1')).rejects.toMatchObject({ details: { reason: 'not_found' } });
    expect(await s.get('sec_1')).toBe('v');
  });

  test('records calls without values', async () => {
    const s = new MemorySecretStore();
    await s.put('sec_1', 'never-recorded', 'proxy');
    await s.get('sec_1');
    expect(s.calls).toEqual([
      { op: 'put', ref: 'sec_1', kind: 'proxy' },
      { op: 'get', ref: 'sec_1' },
    ]);
    expect(JSON.stringify(s.calls)).not.toContain('never-recorded');
  });
});
