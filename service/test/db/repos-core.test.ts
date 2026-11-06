import { describe, expect, test } from 'vitest';
import { makeRepos, seedEnvironment, seedFront, seedRevision, T0 } from './fixtures.js';

describe('environments', () => {
  test('insert/get round-trip with booleans, nulls and timestamps', () => {
    const { repos } = makeRepos();
    const env = seedEnvironment(repos, { expectedExitIp: '198.51.100.20', bindingStage: 'awaiting_profile', autoFillLogin: true });
    expect(repos.environments.get(env.id)).toEqual({
      id: env.id,
      seq: 1,
      code: 'E0001',
      nodeTag: 'US01',
      displayName: 'US-买家01',
      site: 'US',
      autoOpenOrders: true,
      autoFillLogin: true,
      revision: 1,
      desiredProxyRevision: null,
      deployedProxyRevision: null,
      lastVerifiedProxyRevision: null,
      expectedExitIp: '198.51.100.20',
      bindingStage: 'awaiting_profile',
      deletedAt: null,
      createdAt: T0,
      updatedAt: T0,
    });
    expect(repos.environments.byCode('E0001')?.id).toBe(env.id);
    expect(repos.environments.get('missing')).toBeNull();
  });

  test('update sets updatedAt automatically; list excludes deleted by default', () => {
    const { repos, clock } = makeRepos();
    const a = seedEnvironment(repos);
    const b = seedEnvironment(repos);
    clock.advance(5000);
    expect(repos.environments.update(a.id, { displayName: '新名称', desiredProxyRevision: 2 })).toBe(true);
    const updated = repos.environments.get(a.id)!;
    expect(updated.displayName).toBe('新名称');
    expect(updated.desiredProxyRevision).toBe(2);
    expect(updated.updatedAt).toBe('2026-10-21T00:00:05.000Z');
    repos.environments.update(b.id, { deletedAt: clock.now().toISOString() });
    expect(repos.environments.list().map((e) => e.id)).toEqual([a.id]);
    expect(repos.environments.list({ includeDeleted: true }).map((e) => e.id)).toEqual([a.id, b.id]);
    expect(repos.environments.update('missing', { displayName: 'x' })).toBe(false);
  });

  test('updateIfRevision enforces optimistic concurrency', () => {
    const { repos } = makeRepos();
    const env = seedEnvironment(repos);
    expect(repos.environments.updateIfRevision(env.id, 1, { revision: 2, displayName: 'r2' })).toBe(true);
    expect(repos.environments.updateIfRevision(env.id, 1, { revision: 2, displayName: 'stale' })).toBe(false);
    expect(repos.environments.get(env.id)?.displayName).toBe('r2');
  });

  test('listByDisplayName finds non-deleted exact matches only', () => {
    const { repos } = makeRepos();
    const a = seedEnvironment(repos, { displayName: '同名' });
    const b = seedEnvironment(repos, { displayName: '同名' });
    seedEnvironment(repos, { displayName: '同名 ' });
    repos.environments.update(b.id, { deletedAt: T0 });
    expect(repos.environments.listByDisplayName('同名').map((e) => e.id)).toEqual([a.id]);
  });

  test('unique constraints on seq, code and node tag', () => {
    const { repos } = makeRepos();
    seedEnvironment(repos, { seq: 7 });
    expect(() => seedEnvironment(repos, { seq: 7 })).toThrow(/UNIQUE/);
  });
});

describe('proxy revisions', () => {
  test('round-trip, list, maxRevision and byNodeName', () => {
    const { repos } = makeRepos();
    seedFront(repos);
    const env = seedEnvironment(repos);
    const r1 = seedRevision(repos, env, 1, { usernameRef: 'sec_U1', usernameFp: 'f'.repeat(64), passwordRef: 'sec_P1', passwordFp: 'e'.repeat(64) });
    seedRevision(repos, env, 2, { host: '203.0.113.11' });
    expect(r1).toEqual({
      environmentId: env.id,
      revision: 1,
      protocol: 'socks5',
      host: '203.0.113.10',
      port: 1080,
      usernameRef: 'sec_U1',
      usernameFp: 'f'.repeat(64),
      passwordRef: 'sec_P1',
      passwordFp: 'e'.repeat(64),
      frontProxyId: 'front_01',
      nodeName: 'SFE-N-E0001-US01-v001',
      state: 'desired',
      createdAt: T0,
      retiredAt: null,
    });
    expect(repos.proxyRevisions.maxRevision(env.id)).toBe(2);
    expect(repos.proxyRevisions.maxRevision('none')).toBe(0);
    expect(repos.proxyRevisions.listByEnvironment(env.id).map((r) => r.revision)).toEqual([1, 2]);
    expect(repos.proxyRevisions.byNodeName('SFE-N-E0001-US01-v002')?.host).toBe('203.0.113.11');
  });

  test('updateState records retiredAt and list filters by state and front', () => {
    const { repos, clock } = makeRepos();
    seedFront(repos);
    seedFront(repos, 'front_02', 'JP-01');
    const env = seedEnvironment(repos);
    seedRevision(repos, env, 1);
    seedRevision(repos, env, 2, { frontProxyId: 'front_02' });
    clock.advance(1000);
    expect(repos.proxyRevisions.updateState(env.id, 1, 'retired')).toBe(true);
    expect(repos.proxyRevisions.get(env.id, 1)?.retiredAt).toBe('2026-10-21T00:00:01.000Z');
    expect(repos.proxyRevisions.updateState(env.id, 2, 'deployed')).toBe(true);
    expect(repos.proxyRevisions.get(env.id, 2)?.retiredAt).toBeNull();
    expect(repos.proxyRevisions.list({ state: 'retired' }).map((r) => r.revision)).toEqual([1]);
    expect(repos.proxyRevisions.list({ state: ['desired', 'deployed'] }).map((r) => r.revision)).toEqual([2]);
    expect(repos.proxyRevisions.list({ state: [] })).toEqual([]);
    expect(repos.proxyRevisions.list({ frontProxyId: 'front_02' }).map((r) => r.revision)).toEqual([2]);
  });

  test('foreign key to front proxy and unique node names', () => {
    const { repos } = makeRepos();
    seedFront(repos);
    const env = seedEnvironment(repos);
    expect(() => seedRevision(repos, env, 1, { frontProxyId: 'front_missing' })).toThrow(/FOREIGN KEY/);
    seedRevision(repos, env, 1);
    expect(() => seedRevision(repos, env, 2, { nodeName: 'SFE-N-E0001-US01-v001' })).toThrow(/UNIQUE/);
  });
});

describe('front proxies', () => {
  test('round-trip with defaults', () => {
    const { repos } = makeRepos();
    const f = repos.frontProxies.insert({ id: 'front_01', surgeName: '🇭🇰 香港 01', state: 'unverified' });
    expect(f).toEqual({ id: 'front_01', surgeName: '🇭🇰 香港 01', kind: 'node', state: 'unverified', isDefault: false, retired: false, lastCheckedAt: null, createdAt: T0 });
    expect(repos.frontProxies.byName('🇭🇰 香港 01')?.id).toBe('front_01');
  });

  test('setDefault clears the previous default in the same transaction', () => {
    const { repos } = makeRepos();
    seedFront(repos, 'front_01', 'A', true);
    seedFront(repos, 'front_02', 'B');
    expect(repos.frontProxies.getDefault()?.id).toBe('front_01');
    expect(repos.frontProxies.setDefault('front_02')).toBe(true);
    expect(repos.frontProxies.list().filter((f) => f.isDefault).map((f) => f.id)).toEqual(['front_02']);
    expect(repos.frontProxies.setDefault('missing')).toBe(false);
    expect(repos.frontProxies.getDefault()?.id).toBe('front_02');
    expect(repos.frontProxies.setDefault(null)).toBe(true);
    expect(repos.frontProxies.getDefault()).toBeNull();
  });

  test('insert/update with isDefault also clears the previous default', () => {
    const { repos } = makeRepos();
    seedFront(repos, 'front_01', 'A', true);
    seedFront(repos, 'front_02', 'B', true);
    expect(repos.frontProxies.getDefault()?.id).toBe('front_02');
    expect(repos.frontProxies.update('front_01', { isDefault: true, state: 'ok', lastCheckedAt: T0 })).toBe(true);
    expect(repos.frontProxies.getDefault()?.id).toBe('front_01');
    expect(repos.frontProxies.get('front_02')?.isDefault).toBe(false);
    expect(repos.frontProxies.update('missing', { retired: true })).toBe(false);
  });

  test('list can exclude retired', () => {
    const { repos } = makeRepos();
    seedFront(repos, 'front_01', 'A');
    seedFront(repos, 'front_02', 'B');
    repos.frontProxies.update('front_02', { retired: true });
    expect(repos.frontProxies.list({ includeRetired: false }).map((f) => f.id)).toEqual(['front_01']);
    expect(repos.frontProxies.list().map((f) => f.id)).toEqual(['front_01', 'front_02']);
  });
});

describe('accounts', () => {
  test('insert/get/update/upsert/delete', () => {
    const { repos, clock } = makeRepos();
    const env = seedEnvironment(repos);
    const a = repos.accounts.insert({ environmentId: env.id, label: '买家 01', loginIdentifier: 'buyer01@example.test', passwordRef: 'sec_A', passwordFp: 'a'.repeat(64) });
    expect(a).toEqual({ environmentId: env.id, label: '买家 01', loginIdentifier: 'buyer01@example.test', passwordRef: 'sec_A', passwordFp: 'a'.repeat(64), changedSincePageCheck: false, updatedAt: T0 });
    clock.advance(1000);
    expect(repos.accounts.update(env.id, { changedSincePageCheck: true, passwordRef: null, passwordFp: null })).toBe(true);
    expect(repos.accounts.get(env.id)).toMatchObject({ changedSincePageCheck: true, passwordRef: null, updatedAt: '2026-10-21T00:00:01.000Z' });
    repos.accounts.upsert({ environmentId: env.id, label: null, loginIdentifier: 'buyer02@example.test', passwordRef: 'sec_B', passwordFp: 'b'.repeat(64) });
    expect(repos.accounts.get(env.id)).toMatchObject({ label: null, loginIdentifier: 'buyer02@example.test', passwordRef: 'sec_B' });
    expect(repos.accounts.delete(env.id)).toBe(true);
    expect(repos.accounts.get(env.id)).toBeNull();
    const env2 = seedEnvironment(repos);
    expect(repos.accounts.upsert({ environmentId: env2.id, label: 'x', loginIdentifier: null, passwordRef: null, passwordFp: null }).label).toBe('x');
  });
});

describe('profile bindings and reports', () => {
  test('bindings are one-to-one and round-trip', () => {
    const { repos } = makeRepos();
    const a = seedEnvironment(repos);
    const b = seedEnvironment(repos);
    const bound = repos.profileBindings.insert({ profileId: 'PROFILE-AAAA-1111', environmentId: a.id, state: 'bound_unverified_id' });
    expect(bound).toEqual({ profileId: 'PROFILE-AAAA-1111', environmentId: a.id, state: 'bound_unverified_id', boundAt: T0 });
    expect(repos.profileBindings.byEnvironment(a.id)?.profileId).toBe('PROFILE-AAAA-1111');
    expect(() => repos.profileBindings.insert({ profileId: 'PROFILE-AAAA-1111', environmentId: b.id, state: 'bound' })).toThrow(/UNIQUE|PRIMARY/);
    expect(() => repos.profileBindings.insert({ profileId: 'PROFILE-BBBB-2222', environmentId: a.id, state: 'bound' })).toThrow(/UNIQUE/);
    expect(repos.profileBindings.updateState('PROFILE-AAAA-1111', 'bound')).toBe(true);
    expect(repos.profileBindings.list()).toHaveLength(1);
    expect(repos.profileBindings.delete('PROFILE-AAAA-1111')).toBe(true);
    expect(repos.profileBindings.byProfile('PROFILE-AAAA-1111')).toBeNull();
    repos.profileBindings.insert({ profileId: 'PROFILE-CCCC', environmentId: b.id, state: 'bound' });
    expect(repos.profileBindings.deleteByEnvironment(b.id)).toBe(true);
  });

  test('reports upsert and listSince', () => {
    const { repos, clock } = makeRepos();
    repos.profileReports.upsert({ profileId: 'P1', windowsOpen: 2, amazonTabsOpen: true, sitePermissionGranted: false });
    clock.advance(11 * 60 * 1000);
    repos.profileReports.upsert({ profileId: 'P2', windowsOpen: 0, amazonTabsOpen: false, sitePermissionGranted: true });
    repos.profileReports.upsert({ profileId: 'P1', windowsOpen: 3, amazonTabsOpen: false, sitePermissionGranted: true, reportedAt: T0 });
    expect(repos.profileReports.get('P1')).toEqual({ profileId: 'P1', windowsOpen: 3, amazonTabsOpen: false, sitePermissionGranted: true, reportedAt: T0 });
    const since = new Date(clock.now().getTime() - 10 * 60 * 1000);
    expect(repos.profileReports.listSince(since).map((r) => r.profileId)).toEqual(['P2']);
    expect(repos.profileReports.list()).toHaveLength(2);
    expect(repos.profileReports.delete('P2')).toBe(true);
  });
});
