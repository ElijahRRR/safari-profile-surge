import type { ActivationSnapshot, CapabilityContext } from '@sfe/contract';
import { describe, expect, test } from 'vitest';
import { assertNoSecretMaterial, SETTING_DEFAULTS } from '../../src/db/index.js';
import { makeRepos, seedEnvironment, seedFront, seedOperation, seedRevision, T0 } from './fixtures.js';

const ctx: CapabilityContext = {
  surgeVersion: '6.5.0',
  surgeBuild: '10960',
  macosBuild: '25A100',
  safariVersion: '26.0',
  entryStrategy: 'temp_rule',
  processPathsDigest: 'c'.repeat(64),
  workingProfileId: 'wp-1',
  autoReload: 'off',
  takeoverMode: 'enhanced',
  signingIdentity: 'TEAMID0001',
  adapterMechanism: '{"selectGroupPolicy":"http"}',
};

describe('deployments', () => {
  test('round-trip with manifest and unchecked fields; latest and latestWithState', () => {
    const { repos, clock } = makeRepos();
    const env = seedEnvironment(repos);
    const d1 = repos.deployments.insert({
      generation: 1,
      workingProfileDigest: 'w'.repeat(64),
      resourceDigest: 'r'.repeat(64),
      nodeManifest: [{ nodeName: 'SFE-N-E0001-US01-v001', environmentId: env.id, proxyRevision: 1, frontProxyName: 'HK-01' }],
      selectionBefore: 'REJECT',
      state: 'verified',
      operationId: null,
    });
    expect(d1).toEqual({
      generation: 1,
      workingProfileDigest: 'w'.repeat(64),
      resourceDigest: 'r'.repeat(64),
      nodeManifest: [{ nodeName: 'SFE-N-E0001-US01-v001', environmentId: env.id, proxyRevision: 1, frontProxyName: 'HK-01' }],
      selectionBefore: 'REJECT',
      state: 'verified',
      readbackLevel: null,
      uncheckedFields: [],
      operationId: null,
      createdAt: T0,
      updatedAt: T0,
    });
    clock.advance(1000);
    repos.deployments.insert({ generation: 2, workingProfileDigest: null, resourceDigest: 'x', nodeManifest: [], selectionBefore: null, state: 'candidate', operationId: 'op_x' });
    expect(repos.deployments.update(2, { state: 'published', readbackLevel: 'partial', uncheckedFields: ['underlying-proxy'] })).toBe(true);
    expect(repos.deployments.get(2)).toMatchObject({ state: 'published', readbackLevel: 'partial', uncheckedFields: ['underlying-proxy'], updatedAt: '2026-10-21T00:00:01.000Z' });
    expect(repos.deployments.latest()?.generation).toBe(2);
    expect(repos.deployments.latestWithState(['verified'])?.generation).toBe(1);
    expect(repos.deployments.latestWithState([])).toBeNull();
    expect(repos.deployments.list().map((d) => d.generation)).toEqual([2, 1]);
  });

  test('deployment operations', () => {
    const { repos } = makeRepos();
    repos.deployments.insert({ generation: 5, workingProfileDigest: null, resourceDigest: 'x', nodeManifest: [], selectionBefore: null, state: 'candidate', operationId: null });
    repos.deployments.addOperation({ generation: 5, operationId: 'op_a', environmentId: 'env_a', proxyRevision: 2 });
    repos.deployments.addOperation({ generation: 5, operationId: 'op_b' });
    expect(repos.deployments.setOperationOutcome(5, 'op_a', 'deployed')).toBe(true);
    expect(repos.deployments.listOperations(5)).toEqual([
      { generation: 5, operationId: 'op_a', environmentId: 'env_a', proxyRevision: 2, outcome: 'deployed' },
      { generation: 5, operationId: 'op_b', environmentId: null, proxyRevision: null, outcome: null },
    ]);
    expect(repos.deployments.listByOperation('op_b')).toHaveLength(1);
    expect(() => repos.deployments.addOperation({ generation: 99, operationId: 'op_c' })).toThrow(/FOREIGN KEY/);
  });

  test('manifest entries must not carry credentials', () => {
    const { repos } = makeRepos();
    expect(() =>
      repos.deployments.insert({
        generation: 1,
        workingProfileDigest: null,
        resourceDigest: 'x',
        nodeManifest: [{ nodeName: 'n', environmentId: 'e', proxyRevision: 1, password: 'Leak-1' }],
        selectionBefore: null,
        state: 'candidate',
        operationId: null,
      }),
    ).toThrow(expect.objectContaining({ code: 'INTERNAL' }));
  });
});

describe('managed objects', () => {
  test('upsertIntent creates with generated id, then updates the same row', () => {
    const { repos, clock } = makeRepos();
    const created = repos.managedObjects.upsertIntent({ kind: 'resource_file', identity: 'sfe-nodes.list', contentDigest: 'd1', state: 'pending_add', createdByOperation: 'op_1' });
    expect(created).toMatchObject({ kind: 'resource_file', identity: 'sfe-nodes.list', contentDigest: 'd1', version: 1, state: 'pending_add', createdByOperation: 'op_1', updatedAt: T0 });
    expect(created.id).toMatch(/^mo_/);
    expect(repos.managedObjects.setState('resource_file', 'sfe-nodes.list', 'present')).toBe(true);
    clock.advance(1000);
    const again = repos.managedObjects.upsertIntent({ kind: 'resource_file', identity: 'sfe-nodes.list', contentDigest: 'd2', state: 'pending_add', createdByOperation: 'op_2' });
    expect(again).toMatchObject({ id: created.id, contentDigest: 'd2', state: 'pending_add', createdByOperation: 'op_1', updatedAt: '2026-10-21T00:00:01.000Z' });
    expect(repos.managedObjects.setState('resource_file', 'sfe-nodes.list', 'present', { contentDigest: 'd2-actual', version: 2 })).toBe(true);
    expect(repos.managedObjects.getById(created.id)).toMatchObject({ state: 'present', contentDigest: 'd2-actual', version: 2 });
  });

  test('listByKind, list and delete', () => {
    const { repos } = makeRepos();
    repos.managedObjects.upsertIntent({ kind: 'temp_rule', identity: 'PROCESS-NAME,/x,REJECT', contentDigest: null, state: 'pending_add' });
    repos.managedObjects.upsertIntent({ kind: 'temp_rule', identity: 'AND,((PROCESS-NAME,/x),(PROTOCOL,UDP)),REJECT', contentDigest: null, state: 'pending_add' });
    repos.managedObjects.upsertIntent({ kind: 'group_segment', identity: 'SFE-ROUTE', contentDigest: 'g', state: 'pending_add' });
    expect(repos.managedObjects.listByKind('temp_rule')).toHaveLength(2);
    expect(repos.managedObjects.list()).toHaveLength(3);
    expect(repos.managedObjects.setState('temp_rule', 'missing', 'removed')).toBe(false);
    expect(repos.managedObjects.delete('group_segment', 'SFE-ROUTE')).toBe(true);
    expect(repos.managedObjects.get('group_segment', 'SFE-ROUTE')).toBeNull();
  });
});

describe('route state', () => {
  test('get() initialises the default row once', () => {
    const { repos } = makeRepos();
    expect(repos.routeState.get()).toEqual({
      routeEpoch: 0,
      entryMode: 'NORMAL',
      entryModeVerifiedAt: null,
      phase: 'idle',
      activeEnvironmentId: null,
      activeProxyRevision: null,
      selectedNode: null,
      oldSessionPolicy: null,
      operationId: null,
      awaitingDeadline: null,
      warnings: [],
      activationSnapshot: null,
      lastReconciledAt: null,
      surgeStartedAt: null,
      updatedAt: T0,
    });
    expect(repos.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM route_state')?.n).toBe(1);
    repos.routeState.get();
    expect(repos.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM route_state')?.n).toBe(1);
  });

  test('save round-trips warnings (deduplicated) and activation snapshot', () => {
    const { repos, clock } = makeRepos();
    const env = seedEnvironment(repos);
    const snapshot: ActivationSnapshot = {
      previousEnvironmentId: null,
      previousProxyRevision: null,
      previousSelectedNode: 'REJECT',
      previousEntryMode: 'NORMAL',
      previousSafariProbeId: null,
      previousRouteEpoch: 0,
      previousPhase: 'idle',
    };
    clock.advance(1000);
    const saved = repos.routeState.save({
      ...repos.routeState.get(),
      routeEpoch: 1,
      entryMode: 'BLOCKED',
      phase: 'switching',
      activeEnvironmentId: env.id,
      activeProxyRevision: 2,
      oldSessionPolicy: 'keep_open_acknowledged',
      warnings: ['old_windows_kept_open', 'launch_unverified', 'old_windows_kept_open'],
      activationSnapshot: snapshot,
      awaitingDeadline: '2026-10-21T00:10:00.000Z',
    });
    expect(saved).toMatchObject({
      routeEpoch: 1,
      entryMode: 'BLOCKED',
      phase: 'switching',
      activeEnvironmentId: env.id,
      warnings: ['old_windows_kept_open', 'launch_unverified'],
      activationSnapshot: snapshot,
      updatedAt: '2026-10-21T00:00:01.000Z',
    });
    expect(repos.routeState.get()).toEqual(saved);
  });

  test('update merges a patch; the active environment must exist', () => {
    const { repos } = makeRepos();
    expect(repos.routeState.update({ entryMode: 'UNKNOWN', warnings: ['entry_unverified'] })).toMatchObject({ entryMode: 'UNKNOWN', warnings: ['entry_unverified'], phase: 'idle' });
    expect(() => repos.routeState.update({ activeEnvironmentId: 'env_missing' })).toThrow(/FOREIGN KEY/);
    expect(repos.routeState.get().activeEnvironmentId).toBeNull();
  });
});

describe('capabilities and proposals', () => {
  test('capability upsert round-trip with parsed context and coverage', () => {
    const { repos } = makeRepos();
    expect(repos.capabilities.get('runtime_entry_modes')).toBeNull();
    const rec = repos.capabilities.upsert({
      key: 'safari_process_attribution',
      status: 'supported',
      context: ctx,
      protocolCoverage: { ipv4: { result: 'pass', note: null }, http3_quic: { result: 'limitation', note: 'H3 已拒绝并回落 TCP' } },
      proposalId: 'prop_1',
      verifiedAt: T0,
      note: 'IPv6 未验证',
    });
    expect(rec).toEqual({
      key: 'safari_process_attribution',
      status: 'supported',
      context: ctx,
      protocolCoverage: { ipv4: { result: 'pass', note: null }, http3_quic: { result: 'limitation', note: 'H3 已拒绝并回落 TCP' } },
      proposalId: 'prop_1',
      verifiedAt: T0,
      note: 'IPv6 未验证',
    });
    repos.capabilities.upsert({ key: 'safari_process_attribution', status: 'unverified' });
    expect(repos.capabilities.get('safari_process_attribution')).toEqual({ key: 'safari_process_attribution', status: 'unverified', context: null, protocolCoverage: null, proposalId: null, verifiedAt: null, note: null });
    expect(repos.capabilities.list()).toHaveLength(1);
  });

  test('proposal summary and capability note are scrubbed before storage', () => {
    const { repos } = makeRepos();
    const p = repos.proposals.insert({ id: 'prop_s', key: 'native_bridge_ipc', proposedStatus: 'supported', context: ctx, summary: 'ok via http://u:pw@127.0.0.1:61848/x', evidenceDigest: 'e', submittedBy: 'agent' });
    expect(p.summary).toBe('ok via http://‹已隐藏›@127.0.0.1:61848/x');
    const c = repos.capabilities.upsert({ key: 'native_bridge_ipc', status: 'supported', note: 'Bearer abc' });
    expect(c.note).toBe('Bearer ‹已隐藏›');
  });

  test('proposals: insert, list pending, confirm/reject only once', () => {
    const { repos, clock } = makeRepos();
    const p = repos.proposals.insert({
      id: 'prop_1',
      key: 'safari_process_attribution',
      proposedStatus: 'supported',
      context: ctx,
      summary: 'Safari 命中，Chrome 不命中',
      evidenceDigest: 'e'.repeat(64),
      protocolCoverage: { ipv4: { result: 'pass', note: null } },
      safariProcessPaths: ['/Applications/Safari.app/Contents/MacOS/Safari'],
      submittedBy: 'agent',
    });
    expect(p).toEqual({
      id: 'prop_1',
      key: 'safari_process_attribution',
      proposedStatus: 'supported',
      context: ctx,
      summary: 'Safari 命中，Chrome 不命中',
      evidenceDigest: 'e'.repeat(64),
      protocolCoverage: { ipv4: { result: 'pass', note: null } },
      safariProcessPaths: ['/Applications/Safari.app/Contents/MacOS/Safari'],
      entryStrategy: null,
      submittedBy: 'agent',
      submittedAt: T0,
      confirmedAt: null,
      rejectedAt: null,
    });
    clock.advance(1000);
    repos.proposals.insert({ id: 'prop_2', key: 'runtime_entry_modes', proposedStatus: 'unsupported', context: ctx, summary: 's', evidenceDigest: 'x', entryStrategy: 'temp_rule', submittedBy: 'admin' });
    expect(repos.proposals.list({ pending: true }).map((x) => x.id)).toEqual(['prop_1', 'prop_2']);
    expect(repos.proposals.list({ key: 'runtime_entry_modes' }).map((x) => x.id)).toEqual(['prop_2']);
    expect(repos.proposals.markConfirmed('prop_1')).toBe(true);
    expect(repos.proposals.markConfirmed('prop_1')).toBe(false);
    expect(repos.proposals.markRejected('prop_1')).toBe(false);
    expect(repos.proposals.markRejected('prop_2')).toBe(true);
    expect(repos.proposals.list({ pending: true })).toEqual([]);
    expect(repos.proposals.list()).toHaveLength(2);
  });
});

describe('backups', () => {
  test('round-trip and listing', () => {
    const { repos, clock } = makeRepos();
    const b = repos.backups.insert({
      id: 'bak_1',
      reason: 'init',
      sourcePath: '/Users/tester/Library/Application Support/Surge/Profiles/Default.conf',
      backupDirectory: '/data/backups/bak_1',
      files: [{ relativePath: 'Default.conf', digest: 'h'.repeat(64) }],
      runtimeSwitches: { enhancedMode: true, systemProxy: false, outboundMode: 'rule', autoReload: null, httpApi: { configured: false } },
    });
    expect(repos.backups.get('bak_1')).toEqual(b);
    expect(b.createdAt).toBe(T0);
    clock.advance(1000);
    repos.backups.insert({ id: 'bak_2', reason: 'remerge', sourcePath: '/x', backupDirectory: '/y', files: [], runtimeSwitches: {} });
    expect(repos.backups.list().map((x) => x.id)).toEqual(['bak_2', 'bak_1']);
    expect(repos.backups.list({ reason: 'init' }).map((x) => x.id)).toEqual(['bak_1']);
    expect(repos.backups.delete('bak_2')).toBe(true);
  });
});

describe('web sessions and login codes', () => {
  test('sessions: insert, touch, revoke, listActive, deleteExpired', () => {
    const { repos, clock } = makeRepos();
    repos.webSessions.insert({ tokenHash: 'h1', expiresAt: '2026-10-21T12:00:00.000Z' });
    repos.webSessions.insert({ tokenHash: 'h2', expiresAt: '2026-10-21T00:30:00.000Z' });
    expect(repos.webSessions.get('h1')).toEqual({ tokenHash: 'h1', createdAt: T0, lastSeenAt: T0, expiresAt: '2026-10-21T12:00:00.000Z', revokedAt: null });
    clock.advance(60_000);
    expect(repos.webSessions.touch('h1')).toBe(true);
    expect(repos.webSessions.get('h1')?.lastSeenAt).toBe('2026-10-21T00:01:00.000Z');
    expect(repos.webSessions.revoke('h1')).toBe(true);
    expect(repos.webSessions.revoke('h1')).toBe(false);
    expect(repos.webSessions.touch('h1')).toBe(false);
    expect(repos.webSessions.listActive(clock.now()).map((s) => s.tokenHash)).toEqual(['h2']);
    expect(repos.webSessions.deleteExpired('2026-10-21T01:00:00.000Z')).toBe(2);
    repos.webSessions.insert({ tokenHash: 'h3', expiresAt: '2026-10-21T12:00:00.000Z' });
    expect(repos.webSessions.revokeAll()).toBe(1);
  });

  test('login codes: single use and expiry', () => {
    const { repos } = makeRepos();
    repos.loginCodes.insert({ codeHash: 'c1', expiresAt: '2026-10-21T00:01:00.000Z' });
    repos.loginCodes.insert({ codeHash: 'c2', expiresAt: '2026-10-21T00:01:00.000Z' });
    expect(repos.loginCodes.consume('c1', '2026-10-21T00:00:30.000Z')).toBe(true);
    expect(repos.loginCodes.consume('c1', '2026-10-21T00:00:31.000Z')).toBe(false);
    expect(repos.loginCodes.consume('c2', '2026-10-21T00:01:00.000Z')).toBe(false);
    expect(repos.loginCodes.get('c1')?.usedAt).toBe('2026-10-21T00:00:30.000Z');
    expect(repos.loginCodes.deleteExpired('2026-10-21T00:00:59.000Z')).toBe(1);
    expect(repos.loginCodes.deleteExpired('2026-10-21T00:02:00.000Z')).toBe(1);
  });
});

describe('settings', () => {
  test('defaults for every field', () => {
    const { repos } = makeRepos();
    expect(repos.settings.getAll()).toEqual({
      workingProfilePath: null,
      workingProfileName: null,
      safariProcessPaths: [],
      entryStrategy: null,
      verifyEndpointId: 'ipify',
      profileArrivalTimeoutSec: 600,
      safariVerifyTimeoutSec: 120,
      probeTtlSec: 900,
      reconcileIntervalSec: 30,
    });
    expect(repos.settings.view(null)).toEqual({
      surgeCliPath: null,
      workingProfilePath: null,
      entryStrategy: null,
      safariProcessPaths: [],
      verifyEndpointId: 'ipify',
      defaultFrontProxyId: null,
      profileArrivalTimeoutSec: 600,
      safariVerifyTimeoutSec: 120,
      probeTtlSec: 900,
      reconcileIntervalSec: 30,
    });
  });

  test('set/get/reset round-trip and runtime validation', () => {
    const { repos } = makeRepos();
    repos.settings.set('workingProfilePath', '/Users/tester/Library/Application Support/Surge/Profiles/日常-Safari环境.conf');
    repos.settings.set('workingProfileName', '日常-Safari环境');
    repos.settings.set('safariProcessPaths', ['/Applications/Safari.app/Contents/MacOS/Safari']);
    repos.settings.set('entryStrategy', 'temp_rule');
    repos.settings.set('probeTtlSec', 300);
    expect(repos.settings.get('safariProcessPaths')).toEqual(['/Applications/Safari.app/Contents/MacOS/Safari']);
    expect(repos.settings.get('entryStrategy')).toBe('temp_rule');
    expect(repos.settings.get('probeTtlSec')).toBe(300);
    expect(() => repos.settings.set('probeTtlSec', 0)).toThrow(TypeError);
    expect(() => repos.settings.set('probeTtlSec', 1.5)).toThrow(TypeError);
    expect(() => repos.settings.set('entryStrategy', 'dns' as 'temp_rule')).toThrow(TypeError);
    expect(() => repos.settings.set('safariProcessPaths', [''])).toThrow(TypeError);
    repos.settings.reset('probeTtlSec');
    expect(repos.settings.get('probeTtlSec')).toBe(900);
  });

  test('corrupt stored values fall back to defaults; defaults are not shared mutable objects', () => {
    const { repos } = makeRepos();
    repos.db.run("INSERT INTO settings(key, value) VALUES('reconcileIntervalSec', '\"thirty\"')");
    expect(repos.settings.get('reconcileIntervalSec')).toBe(30);
    const paths = repos.settings.get('safariProcessPaths');
    paths.push('/mutated');
    expect(repos.settings.get('safariProcessPaths')).toEqual([]);
    expect(SETTING_DEFAULTS.safariProcessPaths).toEqual([]);
  });

  test('default front proxy comes from front_proxies.is_default', () => {
    const { repos } = makeRepos();
    seedFront(repos, 'front_01', 'A');
    seedFront(repos, 'front_02', 'B');
    expect(repos.settings.defaultFrontProxyId()).toBeNull();
    expect(repos.settings.setDefaultFrontProxyId('front_02')).toBe(true);
    expect(repos.settings.defaultFrontProxyId()).toBe('front_02');
    expect(repos.frontProxies.getDefault()?.id).toBe('front_02');
    expect(repos.settings.view('/Applications/Surge.app/Contents/Applications/surge-cli').defaultFrontProxyId).toBe('front_02');
    repos.frontProxies.update('front_02', { retired: true });
    expect(repos.settings.defaultFrontProxyId()).toBeNull();
  });
});

describe('meta', () => {
  test('environment and site sequences are monotonic and never reused', () => {
    const { repos } = makeRepos();
    expect(repos.meta.nextEnvironmentSeq()).toBe(1);
    expect(repos.meta.nextEnvironmentSeq()).toBe(2);
    expect(repos.meta.nextSiteSeq('US')).toBe(1);
    expect(repos.meta.nextSiteSeq('US')).toBe(2);
    expect(repos.meta.nextSiteSeq('JP')).toBe(1);
  });

  test('sequences start after existing rows when the counter is missing', () => {
    const { repos } = makeRepos();
    seedEnvironment(repos, { seq: 41, code: 'E0041', nodeTag: 'US07' });
    repos.db.run("DELETE FROM meta WHERE key IN ('environment_seq', 'site_seq:US')");
    expect(repos.meta.nextEnvironmentSeq()).toBe(42);
    expect(repos.meta.nextSiteSeq('US')).toBe(8);
  });

  test('configuration generation, event sequence, pepper flag and schema version', () => {
    const { repos } = makeRepos();
    expect(repos.meta.configurationGeneration()).toBe(0);
    expect(repos.meta.bumpConfigurationGeneration()).toBe(1);
    expect(repos.meta.bumpConfigurationGeneration()).toBe(2);
    expect(repos.meta.configurationGeneration()).toBe(2);
    expect(repos.meta.eventSequence()).toBe(0);
    repos.meta.setEventSequence(1234);
    expect(repos.meta.eventSequence()).toBe(1234);
    expect(() => repos.meta.setEventSequence(-1)).toThrow(RangeError);
    expect(repos.meta.pepperCreated()).toBe(false);
    repos.meta.markPepperCreated();
    expect(repos.meta.pepperCreated()).toBe(true);
    expect(repos.meta.schemaVersion()).toBeGreaterThanOrEqual(1);
  });
});

describe('secret refs repository', () => {
  test('state transitions and listings', () => {
    const { repos, clock } = makeRepos();
    repos.secretRefs.insertPending({ ref: 'sec_A', kind: 'proxy', ownerKind: 'environment', ownerId: 'env_1' });
    expect(repos.secretRefs.get('sec_A')).toEqual({ ref: 'sec_A', kind: 'proxy', ownerKind: 'environment', ownerId: 'env_1', state: 'pending', createdAt: T0 });
    clock.advance(11 * 60 * 1000);
    repos.secretRefs.insertPending({ ref: 'sec_B', kind: 'account', ownerKind: 'account', ownerId: 'env_1' });
    expect(repos.secretRefs.listStalePending(new Date(clock.now().getTime() - 10 * 60 * 1000)).map((r) => r.ref)).toEqual(['sec_A']);
    expect(repos.secretRefs.markCommitted('sec_A')).toBe(true);
    expect(repos.secretRefs.markCommitted('sec_A')).toBe(false);
    expect(repos.secretRefs.markOrphaned('sec_A')).toBe(true);
    expect(repos.secretRefs.markOrphaned('sec_A')).toBe(false);
    expect(repos.secretRefs.listOrphaned().map((r) => r.ref)).toEqual(['sec_A']);
    expect(repos.secretRefs.restoreCommitted('sec_A')).toBe(true);
    expect(repos.secretRefs.listByOwner('account', 'env_1').map((r) => r.ref)).toEqual(['sec_B']);
    expect(repos.secretRefs.delete('sec_B')).toBe(true);
  });

  test('isReferenced checks non-retired revisions, accounts and settings', () => {
    const { repos } = makeRepos();
    seedFront(repos);
    const env = seedEnvironment(repos);
    seedRevision(repos, env, 1, { usernameRef: 'sec_U', passwordRef: 'sec_P' });
    repos.accounts.insert({ environmentId: env.id, label: null, loginIdentifier: null, passwordRef: 'sec_ACC', passwordFp: null });
    repos.db.run("INSERT INTO settings(key, value) VALUES('x.ref', '\"sec_SET\"')");
    for (const ref of ['sec_U', 'sec_P', 'sec_ACC', 'sec_SET']) expect(repos.secretRefs.isReferenced(ref)).toBe(true);
    expect(repos.secretRefs.isReferenced('sec_NONE')).toBe(false);
    repos.proxyRevisions.updateState(env.id, 1, 'superseded');
    expect(repos.secretRefs.isReferenced('sec_P')).toBe(true);
    repos.proxyRevisions.updateState(env.id, 1, 'retired');
    expect(repos.secretRefs.isReferenced('sec_P')).toBe(false);
    expect(repos.secretRefs.isReferenced('sec_U')).toBe(false);
  });
});

describe('JSON secret guard', () => {
  test.each([
    [{ password: 'x' }, '$.password'],
    [{ a: [{ token: 'x' }] }, '$.a[0].token'],
    [{ proxy: { username: 'u' } }, '$.proxy.username'],
    [{ value: { action: 'replace', value: 'x' } }, '$.value.value'],
    [{ Authorization: 'Bearer x' }, '$.Authorization'],
  ])('rejects %j', (value, field) => {
    expect(() => assertNoSecretMaterial(value)).toThrow(expect.objectContaining({ details: { field } }));
  });

  test.each([{ passwordRef: 'sec_1' }, { hasPassword: true }, { password: null }, { password: '' }, { password: { action: 'keep' } }, { token_hash: 'h' }, { code: 'X' }])('accepts %j', (value) => {
    expect(() => assertNoSecretMaterial(value)).not.toThrow();
  });

  test('route state activation snapshot and operation results are guarded too', () => {
    const { repos } = makeRepos();
    expect(() => repos.routeState.update({ activationSnapshot: { secret: 'x' } as unknown as ActivationSnapshot })).toThrow(expect.objectContaining({ code: 'INTERNAL' }));
    const op = seedOperation(repos);
    expect(() => repos.operations.update(op.id, { result: { login_password: 'x' } })).toThrow(expect.objectContaining({ code: 'INTERNAL' }));
  });
});
