import { describe, expect, test } from 'vitest';
import type { EnvironmentRecord, FrontProxyRecord, OperationRecord, ProbeRecord, ProxyRevisionRecord, RouteStateRecord } from '../../src/db/index.js';
import { defaultRouteState } from '../../src/db/index.js';
import { newRoutePayload } from '../../src/domain/operations.js';
import { evaluateControl, safariProbeCurrent } from '../../src/domain/route-rules.js';
import {
  buildEnvironmentView,
  buildOperationView,
  buildRouteSummary,
  buildRouteView,
  probeView,
  publishStateFor,
  type EnvironmentViewData,
  type EnvironmentViewContext,
} from '../../src/domain/views.js';

const NOW = new Date('2026-10-21T00:00:00.000Z');
const T = NOW.toISOString();
const LATER = new Date(NOW.getTime() + 600_000).toISOString();
const EARLIER = new Date(NOW.getTime() - 600_000).toISOString();

function env(patch: Partial<EnvironmentRecord> = {}): EnvironmentRecord {
  return {
    id: 'env_1',
    seq: 1,
    code: 'E0001',
    nodeTag: 'US01',
    displayName: 'US-Buyer-01',
    site: 'US',
    autoOpenOrders: true,
    autoFillLogin: false,
    revision: 3,
    desiredProxyRevision: 1,
    deployedProxyRevision: 1,
    lastVerifiedProxyRevision: null,
    expectedExitIp: null,
    bindingStage: null,
    deletedAt: null,
    createdAt: T,
    updatedAt: T,
    ...patch,
  };
}

function rev(n: number, patch: Partial<ProxyRevisionRecord> = {}): ProxyRevisionRecord {
  return {
    environmentId: 'env_1',
    revision: n,
    protocol: 'socks5',
    host: '203.0.113.10',
    port: 1080,
    usernameRef: 'sec_u',
    usernameFp: 'fpu',
    passwordRef: null,
    passwordFp: null,
    frontProxyId: 'front_1',
    nodeName: `SFE-N-E0001-US01-v00${n}`,
    state: 'deployed',
    createdAt: T,
    retiredAt: null,
    ...patch,
  };
}

const front: FrontProxyRecord = { id: 'front_1', surgeName: 'Front-A', kind: 'node', state: 'ok', isDefault: true, retired: false, lastCheckedAt: null, createdAt: T };

function probe(patch: Partial<ProbeRecord> = {}): ProbeRecord {
  return {
    id: 'probe_1',
    environmentId: 'env_1',
    kind: 'safari',
    outcome: 'ok',
    exitIp: '192.0.2.50',
    proxyRevision: 1,
    nodeName: 'SFE-N-E0001-US01-v001',
    routeEpoch: 2,
    configurationGeneration: 1,
    entryMode: 'VERIFY_ONLY',
    testId: 't',
    operationId: 'op_1',
    surgeRequestId: '7',
    surgeRemoteHost: 'verify.example.test',
    surgeRule: 'RULE-SET,sfe-entry-verify.list,SFE-ROUTE',
    surgePolicy: 'SFE-ROUTE',
    surgeStartedAt: T,
    surgeNewConnection: null,
    chainEvidence: null,
    browserHttpStatus: 200,
    browserStartedAt: T,
    browserFinishedAt: T,
    browserError: null,
    message: null,
    observedAt: T,
    expiresAt: LATER,
    ...patch,
  };
}

function op(patch: Partial<OperationRecord> = {}): OperationRecord {
  return {
    id: 'op_1',
    requestId: 'r1',
    requestDigest: 'd',
    kind: 'environment.update',
    environmentId: 'env_1',
    initiatorKind: 'web',
    initiatorProfileId: null,
    expectedRevision: null,
    resultRevision: null,
    routeEpoch: null,
    probeKind: null,
    phase: 'SAVED',
    status: 'queued',
    supersededBy: null,
    payload: { targets: [{ environmentId: 'env_1', proxyRevision: 2 }] },
    result: null,
    error: null,
    createdAt: T,
    updatedAt: T,
    ...patch,
  };
}

function route(patch: Partial<RouteStateRecord> = {}): RouteStateRecord {
  return { ...defaultRouteState(T), ...patch };
}

function data(patch: Partial<EnvironmentViewData> = {}): EnvironmentViewData {
  return {
    env: env(),
    revisions: [rev(1)],
    binding: { profileId: 'profile-aaaa-0001', environmentId: 'env_1', state: 'bound', boundAt: T },
    report: null,
    account: { environmentId: 'env_1', label: 'buyer', loginIdentifier: 'buyer01@example.test', passwordRef: 'sec_a', passwordFp: 'fpa', changedSincePageCheck: false, updatedAt: T },
    preflight: probe({ kind: 'preflight', exitIp: null, routeEpoch: null }),
    safari: null,
    operations: [],
    routeOps: [],
    ...patch,
  };
}

function ctx(patch: Partial<EnvironmentViewContext> = {}): EnvironmentViewContext {
  return { now: NOW, route: route(), fronts: new Map([[front.id, front]]), publishMissing: [], activateMissing: [], ...patch };
}

describe('buildEnvironmentView facets', () => {
  test('deployed + bound + preflight ok → ready / activate', () => {
    const v = buildEnvironmentView(data(), ctx());
    expect(v.facets).toEqual({ input: 'valid', binding: 'bound', deployment: 'deployed', preflight: 'ok', route: 'inactive' });
    expect(v.readiness).toBe('ready');
    expect(v.nextActions[0]!.kind).toBe('activate');
  });

  test('account identifier masked; secrets only as booleans', () => {
    const v = buildEnvironmentView(data(), ctx());
    expect(v.account.loginIdentifierMasked).toBe('b*****1@example.test');
    expect(JSON.stringify(v)).not.toContain('buyer01@');
    expect(JSON.stringify(v)).not.toContain('sec_');
    expect(v.proxy.deployed!.hasUsername).toBe(true);
    expect(v.proxy.deployed!.hasPassword).toBe(false);
    expect(v.account.pageIdentity).toBe('unverified');
  });

  test('unbound → needs_binding', () => {
    const v = buildEnvironmentView(data({ binding: null, env: env({ bindingStage: 'awaiting_profile' }) }), ctx());
    expect(v.readiness).toBe('needs_binding');
    expect(v.binding.stage).toBe('awaiting_profile');
  });

  test('never deployed and parked for capability → waiting_deployment with verify_capability', () => {
    const v = buildEnvironmentView(
      data({
        env: env({ deployedProxyRevision: null, desiredProxyRevision: 1 }),
        revisions: [rev(1, { state: 'desired' })],
        preflight: null,
        operations: [op({ phase: 'WAITING_DEPLOYMENT', status: 'parked', payload: { targets: [{ environmentId: 'env_1', proxyRevision: 1 }] }, error: { code: 'CAPABILITY_UNVERIFIED', message: 'x' } })],
      }),
      ctx({ publishMissing: ['policy_path_reread'] }),
    );
    expect(v.facets.deployment).toBe('blocked_by_capability');
    expect(v.readiness).toBe('waiting_deployment');
    expect(v.nextActions[0]).toMatchObject({ kind: 'verify_capability', capabilities: ['policy_path_reread'] });
  });

  test('published with unaccepted partial readback → sync_failed', () => {
    const v = buildEnvironmentView(data({ env: env({ deployedProxyRevision: null }), revisions: [rev(1, { state: 'deployed' })], preflight: null }), ctx());
    expect(v.facets.deployment).toBe('readback_partial');
    expect(v.readiness).toBe('sync_failed');
    expect(v.nextActions[0]!.kind).toBe('verify_capability');
  });

  test('newer desired revision keeps the deployed one usable with publish_pending as extra action', () => {
    const v = buildEnvironmentView(
      data({ env: env({ desiredProxyRevision: 2 }), revisions: [rev(1), rev(2, { state: 'desired', host: '203.0.113.20' })], operations: [op({ phase: 'WAITING_DEPLOYMENT', status: 'parked' })] }),
      ctx(),
    );
    expect(v.readiness).toBe('ready');
    expect(v.proxy.desired!.revision).toBe(2);
    expect(v.proxy.deployed!.revision).toBe(1);
    expect(v.nextActions.map((a) => a.kind)).toContain('publish_pending');
  });

  test('failed preflight → proxy_unavailable', () => {
    const v = buildEnvironmentView(data({ preflight: probe({ kind: 'preflight', outcome: 'failed' }) }), ctx());
    expect(v.readiness).toBe('proxy_unavailable');
  });

  test('expired preflight → expired facet and deployed_unverified', () => {
    const v = buildEnvironmentView(data({ preflight: probe({ kind: 'preflight', expiresAt: EARLIER }) }), ctx());
    expect(v.facets.preflight).toBe('expired');
    expect(v.readiness).toBe('deployed_unverified');
  });

  test('active env with current probe → open_orders; expired probe → probe_safari', () => {
    const r = route({ activeEnvironmentId: 'env_1', activeProxyRevision: 1, phase: 'active_verified', entryMode: 'ACTIVE', routeEpoch: 2, selectedNode: 'SFE-N-E0001-US01-v001' });
    const ok = buildEnvironmentView(data({ safari: probe() }), ctx({ route: r }));
    expect(ok.facets.route).toBe('active');
    expect(ok.nextActions[0]!.kind).toBe('open_orders');
    expect(ok.proxy.active!.revision).toBe(1);
    const stale = buildEnvironmentView(data({ safari: probe({ expiresAt: EARLIER }) }), ctx({ route: r }));
    expect(stale.nextActions[0]!.kind).toBe('probe_safari');
  });

  test('active env under attention → primary action is activate (re-take control)', () => {
    const r = route({ activeEnvironmentId: 'env_1', activeProxyRevision: 1, phase: 'attention', entryMode: 'UNKNOWN', warnings: ['surge_restarted'] });
    const v = buildEnvironmentView(data({ safari: probe() }), ctx({ route: r }));
    expect(v.facets.route).toBe('active');
    expect(v.nextActions[0]!.kind).toBe('activate');
    expect(v.nextActions.map((a) => a.kind)).not.toContain('open_orders');
  });

  test('rolled back env → needs_reverify', () => {
    const r = route({ activeEnvironmentId: 'env_1', activeProxyRevision: 1, phase: 'failed', entryMode: 'BLOCKED', warnings: ['rollback_needs_reverify'] });
    const v = buildEnvironmentView(data(), ctx({ route: r }));
    expect(v.facets.route).toBe('rolled_back');
    expect(v.readiness).toBe('needs_reverify');
  });

  test('waiting route ops → waiting_route / verifying / activating', () => {
    const p = newRoutePayload({ targetEnvironmentId: 'env_1', proxyRevision: 1, nodeName: 'n', purpose: 'activate' });
    const waitingRoute = buildEnvironmentView(data({ routeOps: [op({ status: 'waiting', phase: 'WAITING_ROUTE', payload: { route: { ...p, stage: 'waiting_route' } } })] }), ctx());
    expect(waitingRoute.facets.route).toBe('waiting_route');
    const verifying = buildEnvironmentView(data({ routeOps: [op({ kind: 'route.activate', status: 'waiting', phase: 'VERIFY_ONLY', payload: { route: { ...p, stage: 'verify_only' } } })] }), ctx());
    expect(verifying.facets.route).toBe('verifying');
    expect(verifying.readiness).toBe('activating');
    const queued = buildEnvironmentView(data({ routeOps: [op({ kind: 'route.activate', status: 'queued', payload: { route: p } })] }), ctx());
    expect(queued.facets.route).toBe('activating');
  });

  test('retired front → invalid input', () => {
    const v = buildEnvironmentView(data(), ctx({ fronts: new Map([[front.id, { ...front, retired: true }]]) }));
    expect(v.facets.input).toBe('invalid');
    expect(v.readiness).toBe('invalid');
  });

  test('account changed since page check adds acknowledge action', () => {
    const d = data();
    const v = buildEnvironmentView({ ...d, account: { ...d.account!, changedSincePageCheck: true } }, ctx());
    expect(v.nextActions.map((a) => a.kind)).toContain('acknowledge_account_change');
    expect(v.account.changedSincePageCheck).toBe(true);
  });
});

describe('publishStateFor', () => {
  test('multi-target result per environment', () => {
    const o = op({
      kind: 'deploy.publish',
      environmentId: null,
      status: 'succeeded',
      phase: 'DEPLOYED_UNVERIFIED',
      payload: { targets: [{ environmentId: 'env_1', proxyRevision: 2 }, { environmentId: 'env_2', proxyRevision: 1 }] },
      result: { targets: [{ environmentId: 'env_1', proxyRevision: 2, outcome: 'invalid', error: { code: 'UNSAFE_CREDENTIAL_CHARS', message: 'x' } }] },
    });
    expect(publishStateFor([o], 'env_1', 2)).toMatchObject({ kind: 'invalid' });
    expect(publishStateFor([o], 'env_3', 1)).toEqual({ kind: 'none' });
  });

  test('queued → deploying', () => {
    expect(publishStateFor([op({ status: 'queued' })], 'env_1', 2)).toEqual({ kind: 'deploying' });
  });
});

describe('route views and control', () => {
  const r = route({ activeEnvironmentId: 'env_1', activeProxyRevision: 1, phase: 'active_verified', entryMode: 'ACTIVE', routeEpoch: 2, selectedNode: 'SFE-N-E0001-US01-v001' });

  test('summary hides probe, selection, operation id and warnings other than the buyer-exit one', () => {
    const s = buildRouteSummary(r, true);
    expect(Object.keys(s).sort()).toEqual(['buyerExitConnectionsUnconfirmed', 'entryMode', 'normalModeOffered', 'phase', 'routeEpoch']);
    expect(s.buyerExitConnectionsUnconfirmed).toBe(false);
    expect(s.normalModeOffered).toBe(true);
    expect(buildRouteSummary({ ...r, warnings: ['probe_failed'] }, true).buyerExitConnectionsUnconfirmed).toBe(false);
    expect(buildRouteSummary({ ...r, entryMode: 'NORMAL', phase: 'idle', activeEnvironmentId: null, warnings: ['buyer_exit_connections_unconfirmed'] }, true).buyerExitConnectionsUnconfirmed).toBe(true);
    const full = buildRouteView(r, probe(), true);
    expect(full.normalModeOffered).toBe(true);
    expect(full.lastSafariProbe!.exitIp).toBe('192.0.2.50');
    expect(full.selectedNode).toBe('SFE-N-E0001-US01-v001');
  });

  test('in control requires current-epoch, current-revision, unexpired ok probe and no blocking warnings', () => {
    expect(evaluateControl(r, probe(), NOW).ok).toBe(true);
    expect(evaluateControl(r, probe({ routeEpoch: 1 }), NOW).ok).toBe(false);
    expect(evaluateControl(r, probe({ proxyRevision: 2 }), NOW).ok).toBe(false);
    expect(evaluateControl(r, probe({ expiresAt: EARLIER }), NOW).ok).toBe(false);
    expect(evaluateControl(r, probe({ outcome: 'mismatch' }), NOW).ok).toBe(false);
    for (const w of ['takeover_lost', 'external_selection_change', 'probe_failed', 'exit_ip_mismatch', 'front_missing', 'managed_segments_changed'] as const) {
      expect(evaluateControl({ ...r, warnings: [w] }, probe(), NOW).ok).toBe(false);
    }
    // 提示类警告不破坏“受控”
    expect(evaluateControl({ ...r, warnings: ['launch_unverified', 'takeover_unknown'] }, probe(), NOW).ok).toBe(true);
    expect(evaluateControl({ ...r, entryMode: 'VERIFY_ONLY' }, probe(), NOW).ok).toBe(false);
    expect(safariProbeCurrent(r, null, NOW)).toBe(false);
  });

  test('probe view carries Surge evidence without secrets', () => {
    const v = probeView(probe());
    expect(v.surgeRequest).toMatchObject({ id: '7', policyName: 'SFE-ROUTE' });
    expect(v.browser).toMatchObject({ httpStatus: 200 });
  });

  test('operation view effective versions', () => {
    const v = buildOperationView(op({ routeEpoch: 2 }), [{ operationId: 'op_1', seq: 1, at: T, phase: 'SAVED', message: '已保存' }], {
      env: env({ desiredProxyRevision: 2 }),
      route: r,
      configurationGeneration: 4,
    });
    expect(v.effective).toEqual({ desiredProxyRevision: 2, deployedProxyRevision: 1, activeProxyRevision: 1, configurationGeneration: 4, routeEpoch: 2 });
    expect(v.steps).toEqual([{ at: T, phase: 'SAVED', message: '已保存' }]);
  });
});
