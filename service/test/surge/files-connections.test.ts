import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { SfeError } from '@sfe/contract';
import { createProfileFiles } from '../../src/surge/files.js';
import { killSafariConnections } from '../../src/surge/safari-connections.js';
import type { SurgeAdapter, SurgeRequestRecord } from '../../src/ports.js';
import { FAKE_CHROME_PATH, FAKE_SAFARI_PATH, FakeSurge, createFakeSurgeEnvironment } from '../../src/surge/fake.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sfe-surge-files-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('createProfileFiles', () => {
  const key = 'example-hmac-key';

  test('creates a new file only when expected digest is null and the file is absent', async () => {
    const f = createProfileFiles({ directory: dir, hmacKey: key });
    await f.writeAtomic('sfe-nodes.list', 'a\n', null);
    expect(readFileSync(join(dir, 'sfe-nodes.list'), 'utf8')).toBe('a\n');
    expect(statSync(join(dir, 'sfe-nodes.list')).mode & 0o777).toBe(0o600);
    await expect(f.writeAtomic('sfe-nodes.list', 'b\n', null)).rejects.toMatchObject({ code: 'BASELINE_CHANGED' });
  });

  test('replaces only when the current keyed digest matches', async () => {
    const f = createProfileFiles({ directory: dir, hmacKey: key });
    await f.writeAtomic('x.list', 'one\n', null);
    const d1 = await f.digest('x.list');
    expect(d1).toBe(f.digestContent('one\n'));
    await f.writeAtomic('x.list', 'two\n', d1);
    expect(await f.read('x.list')).toBe('two\n');
    await expect(f.writeAtomic('x.list', 'three\n', d1)).rejects.toMatchObject({ code: 'BASELINE_CHANGED' });
    writeFileSync(join(dir, 'x.list'), 'edited\n');
    await expect(f.writeAtomic('x.list', 'three\n', f.digestContent('two\n'))).rejects.toMatchObject({ code: 'BASELINE_CHANGED' });
    await expect(f.writeAtomic('missing.list', 'z', 'abc')).rejects.toMatchObject({ code: 'BASELINE_CHANGED' });
  });

  test('digest is keyed: same content, different key → different digest', async () => {
    const a = createProfileFiles({ directory: dir, hmacKey: 'k1' });
    const b = createProfileFiles({ directory: dir, hmacKey: 'k2' });
    expect(a.digestContent('same')).not.toBe(b.digestContent('same'));
    expect(a.digestContent('same')).toMatch(/^[0-9a-f]{64}$/);
  });

  test('leaves no temporary files behind', async () => {
    const f = createProfileFiles({ directory: dir, hmacKey: key });
    await f.writeAtomic('x.list', '1', null);
    await f.writeAtomic('x.list', '2', await f.digest('x.list'));
    expect(readdirSync(dir)).toEqual(['x.list']);
  });

  test.each(['../x', 'a/b', '.hidden', '', '..', 'a\0b'])('refuses unsafe file name %j', async (name) => {
    const f = createProfileFiles({ directory: dir, hmacKey: key });
    await expect(f.read(name)).rejects.toBeInstanceOf(SfeError);
    await expect(f.writeAtomic(name, 'x', null)).rejects.toMatchObject({ code: 'UNSAFE_LOCATION' });
  });

  test('read, exists and digest of a missing file', async () => {
    const f = createProfileFiles({ directory: dir, hmacKey: key });
    expect(await f.read('none.list')).toBeNull();
    expect(await f.exists('none.list')).toBe(false);
    expect(await f.digest('none.list')).toBeNull();
  });
});

describe('killSafariConnections', () => {
  const now = () => new Date('2026-10-21T08:00:00Z');
  const setup = () => {
    createFakeSurgeEnvironment(dir, { userRules: ['DOMAIN-SUFFIX,example.test,DIRECT'] });
    const fake = new FakeSurge({ directory: dir });
    const safariA = fake.simulateRequest({ processPath: FAKE_SAFARI_PATH, host: 'www.example.test', protocol: 'tcp', longLived: true });
    const safariV = fake.simulateRequest({ processPath: FAKE_SAFARI_PATH, host: 'verify.example.test', protocol: 'tcp', longLived: true });
    const chrome = fake.simulateRequest({ processPath: FAKE_CHROME_PATH, host: 'www.example.test', protocol: 'tcp', longLived: true });
    return { fake, safariA, safariV, chrome };
  };

  test('kills only Safari requests and records results without other remote hosts', async () => {
    const { fake, safariA, safariV, chrome } = setup();
    const results = await killSafariConnections(fake, { processPaths: [FAKE_SAFARI_PATH], verifyHost: 'verify.example.test', now, bestEffort: false });
    expect(results).toEqual([
      { surgeRequestId: safariA.id, processPath: FAKE_SAFARI_PATH, toVerifyHost: false, ok: true, error: null, at: '2026-10-21T08:00:00.000Z' },
      { surgeRequestId: safariV.id, processPath: FAKE_SAFARI_PATH, toVerifyHost: true, ok: true, error: null, at: '2026-10-21T08:00:00.000Z' },
    ]);
    expect(JSON.stringify(results)).not.toContain('www.example.test');
    expect((await fake.listActiveRequests()).map((r) => r.id)).toEqual([chrome.id]);
  });

  test('a failed kill throws with results unless best effort', async () => {
    const { fake } = setup();
    fake.failNext('killRequest');
    const err = (await killSafariConnections(fake, { processPaths: [FAKE_SAFARI_PATH], verifyHost: 'verify.example.test', now, bestEffort: false }).catch((e: unknown) => e)) as SfeError;
    expect(err.code).toBe('READBACK_MISMATCH');
    expect((err.details!.killResults as unknown[]).length).toBe(2);
  });

  test('retired process paths: only their connections that may use a buyer exit are ended; Chrome and their other connections are untouched', async () => {
    const stp = '/Applications/Safari Technology Preview.app/Contents/MacOS/Safari Technology Preview';
    const rec = (id: string, processPath: string, policyName: string | null, leafPolicyName: string | null = null): SurgeRequestRecord => ({
      id,
      processPath,
      remoteHost: 'www.example.test',
      policyName,
      leafPolicyName,
      rule: null,
      protocol: 'tcp',
      startedAt: null,
      completed: false,
      failed: false,
    });
    const active = new Map(
      [
        rec('1', FAKE_SAFARI_PATH, 'SFE-ROUTE', 'SFE-N-E0001-US01-v001'),
        rec('2', FAKE_SAFARI_PATH, 'DIRECT'),
        rec('3', FAKE_SAFARI_PATH, null, null),
        rec('4', stp, 'DIRECT'),
        rec('5', FAKE_CHROME_PATH, 'SFE-ROUTE', 'SFE-N-E0001-US01-v001'),
      ].map((r) => [r.id, r] as const),
    );
    const killed: string[] = [];
    const adapter = {
      listActiveRequests: async () => [...active.values()],
      killRequest: async (id: string) => {
        killed.push(id);
        active.delete(id);
      },
    } as unknown as SurgeAdapter;
    const results = await killSafariConnections(adapter, {
      processPaths: [stp],
      retiredProcessPaths: [FAKE_SAFARI_PATH, stp],
      verifyHost: 'verify.example.test',
      now,
      bestEffort: false,
      entryBlocksSafari: false,
    });
    // 当前路径的连接照常结束；被换掉的路径只结束经 SFE-ROUTE/出口节点或读不到策略的连接
    expect(killed.sort()).toEqual(['1', '3', '4']);
    expect(results.every((r) => r.ok)).toBe(true);
    expect([...active.keys()].sort()).toEqual(['2', '5']);
  });

  test('entry not known to block Safari: a new connection on the original rules is expected; one that may use the buyer exit is not', async () => {
    const rec = (id: string, policyName: string | null, leafPolicyName: string | null = null): SurgeRequestRecord => ({
      id,
      processPath: FAKE_SAFARI_PATH,
      remoteHost: 'www.example.test',
      policyName,
      leafPolicyName,
      rule: null,
      protocol: 'tcp',
      startedAt: null,
      completed: false,
      failed: false,
    });
    // Safari 在每次结束之后立即重连（next）
    const reconnecting = (next: SurgeRequestRecord): SurgeAdapter => {
      const active = new Map([['1', rec('1', 'SFE-ROUTE', 'SFE-N-E0001-US01-v001')]]);
      return {
        listActiveRequests: async () => [...active.values()],
        killRequest: async (id: string) => {
          active.delete(id);
          active.set(next.id, next);
        },
      } as unknown as SurgeAdapter;
    };
    const opts = { processPaths: [FAKE_SAFARI_PATH], verifyHost: 'verify.example.test', now, bestEffort: false };
    // 入口应已阻断（缺省）：任何新连接都记为失败
    const strict = (await killSafariConnections(reconnecting(rec('2', 'DIRECT')), opts).catch((e: unknown) => e)) as SfeError;
    expect(strict.code).toBe('READBACK_MISMATCH');
    expect(strict.details!.killResults).toContainEqual(expect.objectContaining({ surgeRequestId: '2', ok: false, error: '结束后出现的新连接' }));
    // 入口不确定阻断：按原规则（DIRECT、用户自己的策略组）重连是预期的
    for (const next of [rec('2', 'DIRECT'), rec('2', 'Daily', 'Front-A')]) {
      const results = await killSafariConnections(reconnecting(next), { ...opts, entryBlocksSafari: false });
      expect(results).toEqual([expect.objectContaining({ surgeRequestId: '1', ok: true })]);
    }
    // 经 SFE-ROUTE、叶节点是本应用出口节点、或读不到策略（无法判断）：可能在买家出口上，仍记为失败
    for (const next of [rec('2', 'SFE-ROUTE', 'SFE-N-E0001-US01-v001'), rec('2', 'User-Group', 'SFE-N-E0001-US01-v001'), rec('2', null, null)]) {
      const err = (await killSafariConnections(reconnecting(next), { ...opts, entryBlocksSafari: false }).catch((e: unknown) => e)) as SfeError;
      expect(err.code).toBe('READBACK_MISMATCH');
      expect(err.details!.killResults).toContainEqual(expect.objectContaining({ surgeRequestId: '2', ok: false, error: '结束后出现的新连接（可能经买家出口）' }));
    }
  });

  test('best effort reports failures and requests that are still present', async () => {
    const { fake, safariA } = setup();
    fake.lieOnNext('killRequest');
    const results = await killSafariConnections(fake, { processPaths: [FAKE_SAFARI_PATH], verifyHost: 'verify.example.test', now, bestEffort: true });
    expect(results.find((r) => r.surgeRequestId === safariA.id)).toMatchObject({ ok: false, error: '结束后仍然存在' });
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });
});
