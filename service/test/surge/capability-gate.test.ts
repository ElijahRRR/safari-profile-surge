import { describe, expect, test } from 'vitest';
import {
  CAPABILITY_CONTEXT_DEPS,
  CAPABILITY_CONTEXT_FIELDS,
  CAPABILITY_KEYS,
  SfeError,
  type CapabilityContext,
  type CapabilityKey,
} from '@sfe/contract';
import {
  computeCapabilityViews,
  contextFieldMatches,
  coverageAllowsSupported,
  createCapabilityGate,
  mechanismFingerprint,
  type CapabilityRecordInput,
} from '../../src/surge/capability-gate.js';

const MECH = JSON.stringify({
  selectGroupPolicy: 'http',
  getGroupSelection: 'http',
  getCurrentProfile: 'http',
  listRules: 'http',
  listTempRules: 'cli',
  addTempRule: 'cli',
  removeTempRule: 'cli',
  listExternalResources: 'cli',
  updateExternalResource: 'cli',
  getGroupMembers: 'http',
  testPolicy: 'http',
  getTakeoverState: 'http',
});

const CTX: CapabilityContext = {
  surgeVersion: '6.5.0',
  surgeBuild: '10960',
  macosBuild: '24A335',
  safariVersion: '18.0',
  entryStrategy: 'ruleset_resource',
  processPathsDigest: 'pp-1',
  workingProfileId: 'wp-1',
  autoReload: 'off',
  takeoverMode: 'enhanced',
  signingIdentity: 'TEAM000001',
  adapterMechanism: MECH,
};

const record = (key: CapabilityKey, over: Partial<CapabilityRecordInput> = {}): CapabilityRecordInput => ({
  key,
  status: 'supported',
  context: { ...CTX },
  proposalId: 'prop_1',
  verifiedAt: '2026-10-21T00:00:00Z',
  note: null,
  ...over,
});

const ALT: Record<string, string> = {
  surgeVersion: '6.6.0',
  surgeBuild: '11000',
  macosBuild: '24B83',
  safariVersion: '18.1',
  entryStrategy: 'temp_rule',
  processPathsDigest: 'pp-2',
  workingProfileId: 'wp-2',
  autoReload: 'on',
  takeoverMode: 'system_proxy',
  signingIdentity: 'TEAM000002',
  adapterMechanism: MECH.replace(/"http"/g, '"cli"'),
};

describe('computeCapabilityViews', () => {
  test('one view per capability key; missing records are unverified', () => {
    const views = computeCapabilityViews([], CTX);
    expect(views.map((v) => v.key)).toEqual([...CAPABILITY_KEYS]);
    expect(views.every((v) => v.effectiveStatus === 'unverified' && v.staleReasons.length === 0)).toBe(true);
  });

  test('matching context keeps the recorded status', () => {
    const v = computeCapabilityViews([record('runtime_entry_modes'), record('profile_batch_create', { status: 'unsupported' })], CTX);
    expect(v.find((x) => x.key === 'runtime_entry_modes')!.effectiveStatus).toBe('supported');
    expect(v.find((x) => x.key === 'profile_batch_create')!.effectiveStatus).toBe('unsupported');
  });

  test('a record without context is stale on all its dependencies', () => {
    const v = computeCapabilityViews([record('native_profile_id', { context: null })], CTX);
    const view = v.find((x) => x.key === 'native_profile_id')!;
    expect(view.effectiveStatus).toBe('unverified');
    expect(view.staleReasons).toEqual([...CAPABILITY_CONTEXT_DEPS.native_profile_id]);
  });

  // 每项能力 × 每个上下文字段：依赖的字段变化 → 过期；不依赖的字段变化 → 不影响。
  for (const key of CAPABILITY_KEYS) {
    for (const field of CAPABILITY_CONTEXT_FIELDS) {
      const depends = CAPABILITY_CONTEXT_DEPS[key].includes(field);
      test(`${key} with changed ${field} → ${depends ? 'stale' : 'unchanged'}`, () => {
        const current = { ...CTX, [field]: ALT[field] } as CapabilityContext;
        const view = computeCapabilityViews([record(key)], current).find((x) => x.key === key)!;
        if (depends && field === 'adapterMechanism' && mechanismFingerprint(key, JSON.parse(MECH)) === mechanismFingerprint(key, JSON.parse(ALT.adapterMechanism!))) {
          expect(view.effectiveStatus).toBe('supported');
          return;
        }
        expect(view.effectiveStatus).toBe(depends ? 'unverified' : 'supported');
        expect(view.staleReasons).toEqual(depends ? [field] : []);
      });
    }
  }

  test('unsupported records also become unverified when stale', () => {
    const view = computeCapabilityViews([record('open_profile_by_id', { status: 'unsupported' })], { ...CTX, macosBuild: '25A1' }).find((x) => x.key === 'open_profile_by_id')!;
    expect(view.key).toBe('open_profile_by_id');
    expect(view.effectiveStatus).toBe('unverified');
  });
});

describe('context comparison rules', () => {
  test("recorded 'any' matches everything including null", () => {
    expect(contextFieldMatches('auto_reload_atomic_replace', 'autoReload', 'any', 'on')).toBe(true);
    expect(contextFieldMatches('auto_reload_atomic_replace', 'autoReload', 'any', null)).toBe(true);
  });
  test('unreadable current value only matches a recorded null', () => {
    expect(contextFieldMatches('runtime_entry_modes', 'takeoverMode', null, null)).toBe(true);
    expect(contextFieldMatches('runtime_entry_modes', 'takeoverMode', 'enhanced', null)).toBe(false);
    expect(contextFieldMatches('runtime_entry_modes', 'takeoverMode', null, 'enhanced')).toBe(false);
  });
  test('stale reason lists the unreadable field', () => {
    const v = computeCapabilityViews([record('takeover_state_readable')], { ...CTX, surgeBuild: null }).find((x) => x.key === 'takeover_state_readable')!;
    expect(v.staleReasons).toEqual(['surgeBuild']);
  });
  test('adapterMechanism compares only the primitives the capability depends on', () => {
    const current = JSON.stringify({ ...JSON.parse(MECH), killRequest: 'http', listActiveRequests: 'cli' });
    expect(contextFieldMatches('runtime_entry_modes', 'adapterMechanism', MECH, current)).toBe(true);
    const changed = JSON.stringify({ ...JSON.parse(MECH), addTempRule: 'http' });
    expect(contextFieldMatches('runtime_entry_modes', 'adapterMechanism', MECH, changed)).toBe(false);
    expect(contextFieldMatches('independent_node_preflight', 'adapterMechanism', MECH, changed)).toBe(true);
  });
  test('recorded fingerprint form compares equal to the full current map', () => {
    const recorded = mechanismFingerprint('takeover_state_readable', JSON.parse(MECH));
    expect(recorded).toBe('{"getTakeoverState":"http"}');
    expect(contextFieldMatches('takeover_state_readable', 'adapterMechanism', recorded, MECH)).toBe(true);
  });
  test('fingerprint is canonical and marks missing primitives unavailable', () => {
    expect(mechanismFingerprint('connection_continuity', { selectGroupPolicy: 'http' })).toBe('{"selectGroupPolicy":"http","updateExternalResource":"unavailable"}');
    expect(mechanismFingerprint('native_profile_id', { selectGroupPolicy: 'http' })).toBe('{}');
  });
});

describe('createCapabilityGate', () => {
  const gate = (records: CapabilityRecordInput[], ctx = CTX) => createCapabilityGate({ list: () => records, currentContext: async () => ctx });

  test('require passes when all keys are effectively supported', async () => {
    await expect(gate([record('runtime_entry_modes'), record('fixed_profile_no_switch')]).require(['runtime_entry_modes', 'fixed_profile_no_switch'])).resolves.toBeUndefined();
  });

  test('require throws CAPABILITY_UNVERIFIED with missing keys and stale reasons', async () => {
    const g = gate([record('runtime_entry_modes'), record('fixed_profile_no_switch')], { ...CTX, surgeBuild: '99999' });
    const err = await g.require(['runtime_entry_modes', 'native_bridge_ipc']).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SfeError);
    expect((err as SfeError).code).toBe('CAPABILITY_UNVERIFIED');
    expect((err as SfeError).message).toMatch(/尚未通过实测$/);
    expect((err as SfeError).details).toEqual({
      missing: [
        { key: 'native_bridge_ipc', staleReasons: [] },
        { key: 'runtime_entry_modes', staleReasons: ['surgeBuild'] },
      ],
    });
  });

  test('missing returns keys that are not supported', async () => {
    expect(await gate([record('runtime_entry_modes')]).missing(['runtime_entry_modes', 'native_bridge_ipc'])).toEqual(['native_bridge_ipc']);
  });

  test('requireMeasured accepts supported or unsupported, refuses unverified', async () => {
    const g = gate([record('same_profile_reload_impact', { status: 'unsupported', note: '重置 3 条连接' })]);
    await expect(g.requireMeasured(['same_profile_reload_impact'])).resolves.toBeUndefined();
    await expect(gate([]).requireMeasured(['same_profile_reload_impact'])).rejects.toMatchObject({ code: 'CAPABILITY_UNVERIFIED' });
  });
});

describe('coverageAllowsSupported', () => {
  test('null coverage misses every gating item', () => {
    expect(coverageAllowsSupported(null)).toEqual({ ok: false, missing: ['ipv4', 'ipv6', 'http1', 'http2', 'http3_quic', 'websocket', 'extension_page_fetch'] });
  });
  test('pass or explained limitation is enough; dns/webrtc are not gating', () => {
    const pass = { result: 'pass' as const, note: null };
    expect(
      coverageAllowsSupported({
        ipv4: pass,
        ipv6: { result: 'limitation', note: '本机无 IPv6，未覆盖' },
        http1: pass,
        http2: pass,
        http3_quic: pass,
        websocket: pass,
        extension_page_fetch: pass,
        dns: { result: 'not_tested', note: null },
      }),
    ).toEqual({ ok: true, missing: [] });
  });
  test('fail, not_tested or limitation without note are missing', () => {
    const pass = { result: 'pass' as const, note: null };
    const r = coverageAllowsSupported({
      ipv4: pass,
      ipv6: { result: 'limitation', note: ' ' },
      http1: { result: 'fail', note: 'x' },
      http2: { result: 'not_tested', note: null },
      http3_quic: pass,
      websocket: pass,
    });
    expect(r).toEqual({ ok: false, missing: ['ipv6', 'http1', 'http2', 'extension_page_fetch'] });
  });
});
