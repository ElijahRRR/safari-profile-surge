import { describe, expect, test } from 'vitest';
import {
  adminOpAllowed,
  buildVerifyUrl,
  CAPABILITY_CONTEXT_DEPS,
  CAPABILITY_GATES,
  CAPABILITY_KEYS,
  deriveReadiness,
  effectiveEntryMode,
  ENTRY_MODE_BITS,
  NATIVE_PERMISSIONS,
  readinessAllowsActivation,
  verifyEndpointById,
  VERIFY_ENDPOINTS,
  SITES,
  type EnvironmentFacets,
  type ReadinessInput,
} from '../src/index.js';

const facets = (f: Partial<EnvironmentFacets>): EnvironmentFacets => ({
  input: 'valid',
  binding: 'bound',
  deployment: 'deployed',
  preflight: 'ok',
  route: 'inactive',
  ...f,
});
const input = (f: Partial<EnvironmentFacets>, extra: Partial<ReadinessInput> = {}): ReadinessInput => ({
  facets: facets(f),
  hasDeployedRevision: true,
  pendingNewerRevision: false,
  publishMissing: [],
  activateMissing: [],
  accountChangedSincePageCheck: false,
  safariProbeExpired: false,
  ...extra,
});

describe('deriveReadiness precedence', () => {
  test('ready when bound, deployed and preflighted', () => {
    const r = deriveReadiness(input({}));
    expect(r.readiness).toBe('ready');
    expect(r.nextActions[0]?.kind).toBe('activate');
  });
  test('invalid wins over everything', () => {
    expect(deriveReadiness(input({ input: 'invalid', route: 'active' })).readiness).toBe('invalid');
  });
  test('active with expired probe asks for a safari re-probe, not a switch', () => {
    const r = deriveReadiness(input({ route: 'active' }, { safariProbeExpired: true }));
    expect(r.readiness).toBe('active');
    expect(r.nextActions[0]?.kind).toBe('probe_safari');
  });
  test('unbound and undeployed reports binding first with capability hint as extra', () => {
    const r = deriveReadiness(input({ binding: 'unbound', deployment: 'blocked_by_capability' }, { hasDeployedRevision: false, publishMissing: ['connection_continuity'] }));
    expect(r.readiness).toBe('needs_binding');
  });
  test('waiting deployment shows missing capabilities', () => {
    const r = deriveReadiness(input({ deployment: 'blocked_by_capability' }, { hasDeployedRevision: false, publishMissing: ['connection_continuity'] }));
    expect(r.readiness).toBe('waiting_deployment');
    expect(r.nextActions[0]).toMatchObject({ kind: 'verify_capability', capabilities: ['connection_continuity'] });
  });
  test('preflight failure is proxy_unavailable', () => {
    expect(deriveReadiness(input({ preflight: 'failed' })).readiness).toBe('proxy_unavailable');
  });
  test('no preflight capability gives deployed_unverified, still activatable', () => {
    const r = deriveReadiness(input({ preflight: 'inconclusive' }));
    expect(r.readiness).toBe('deployed_unverified');
    expect(readinessAllowsActivation(r.readiness)).toBe(true);
  });
  test('pending newer revision on usable env adds publish action without hiding readiness', () => {
    const r = deriveReadiness(input({}, { pendingNewerRevision: true }));
    expect(r.readiness).toBe('ready');
    expect(r.nextActions.map((a) => a.kind)).toContain('publish_pending');
  });
  test('rolled back requires reverify', () => {
    expect(deriveReadiness(input({ route: 'rolled_back' })).readiness).toBe('needs_reverify');
  });
  test('activation not allowed for unfinished states', () => {
    for (const r of ['invalid', 'needs_binding', 'waiting_deployment', 'deploying', 'sync_failed', 'proxy_unavailable', 'activating'] as const) {
      expect(readinessAllowsActivation(r)).toBe(false);
    }
  });
});

describe('entry bits', () => {
  test('mode table maps to itself', () => {
    for (const [mode, bits] of Object.entries(ENTRY_MODE_BITS)) expect(effectiveEntryMode(bits)).toBe(mode);
  });
  test('udp blocked in every managed mode', () => {
    expect(ENTRY_MODE_BITS.ACTIVE.udp && ENTRY_MODE_BITS.BLOCKED.udp && ENTRY_MODE_BITS.VERIFY_ONLY.udp).toBe(true);
    expect(ENTRY_MODE_BITS.NORMAL.udp).toBe(false);
  });
});

describe('capability tables', () => {
  test('every gate key and dependency key is a declared capability', () => {
    for (const keys of Object.values(CAPABILITY_GATES)) for (const k of keys) expect(CAPABILITY_KEYS).toContain(k);
    for (const k of CAPABILITY_KEYS) expect(CAPABILITY_CONTEXT_DEPS[k]).toBeDefined();
  });
  test('publish gate is the same for every publish path and includes continuity', () => {
    expect(CAPABILITY_GATES.publish).toContain('connection_continuity');
    expect(CAPABILITY_GATES.publish).toContain('external_node_underlying_proxy');
  });
});

describe('verify endpoints', () => {
  test('never point at a site host', () => {
    for (const e of VERIFY_ENDPOINTS) {
      expect(e.url.startsWith('https://')).toBe(true);
      expect(new URL(e.url).hostname).toBe(e.host);
      expect(e.host.includes('amazon')).toBe(false);
      expect(Object.values(SITES).some((s) => s.host === e.host)).toBe(false);
    }
    expect(verifyEndpointById('nope')).toBeNull();
    const url = buildVerifyUrl(VERIFY_ENDPOINTS[0]!, 'test_abc');
    expect(new URL(url).searchParams.get('sfe_test')).toBe('test_abc');
  });
});

describe('permission tables', () => {
  test('unidentified profiles may only read state', () => {
    const allowed = Object.entries(NATIVE_PERMISSIONS).filter(([, roles]) => roles.includes('unidentified')).map(([t]) => t);
    expect(allowed).toEqual(['getCurrentState']);
  });
  test('agent cannot get login codes, account detail or change settings', () => {
    expect(adminOpAllowed('issueLoginCode', 'agent')).toBe(false);
    expect(adminOpAllowed('accountDetail', 'agent')).toBe(false);
    expect(adminOpAllowed('updateSettings', 'agent')).toBe(false);
    expect(adminOpAllowed('issueLoginCode', 'maintenance')).toBe(true);
    expect(adminOpAllowed('confirmCapability', 'maintenance')).toBe(false);
    expect(adminOpAllowed('nonexistent', 'maintenance')).toBe(false);
  });
});
