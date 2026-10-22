import { describe, expect, it } from 'vitest';
import { OPERATION_KINDS, OPERATION_PHASES, type EnvironmentReadiness, type RouteWarning } from '@sfe/contract';
import {
  ENTRY_MODE_LABELS,
  OPERATION_KIND_LABELS,
  OPERATION_PHASE_LABELS,
  READINESS_LABELS,
  ROUTE_WARNING_TEXT,
  warningText,
} from '../src/lib/labels';
import { formatHostPort, formatNumber, formatRelative, formatSeconds, isExpired } from '../src/lib/format';
import { cancelActionLabel, hasPendingDeploy, isCancellableRouteOperation, matchesFilter, needsAttention, probeDisplay, proxyAddress } from '../src/lib/environments';
import { environment, operation, revision } from './fixtures';

const ALL_READINESS: EnvironmentReadiness[] = [
  'invalid',
  'needs_binding',
  'waiting_deployment',
  'deploying',
  'sync_failed',
  'proxy_unavailable',
  'deployed_unverified',
  'ready',
  'activating',
  'active',
  'needs_reverify',
];

const ALL_WARNINGS: RouteWarning[] = [
  'old_windows_kept_open',
  'managed_windows_on_original_rules',
  'old_session_unproven',
  'launch_unverified',
  'launch_order_unverified',
  'external_selection_change',
  'external_profile_change',
  'surge_unreachable',
  'surge_restarted',
  'takeover_lost',
  'takeover_unknown',
  'outbound_mode_changed',
  'entry_unverified',
  'precedence_violation',
  'front_missing',
  'managed_segments_changed',
  'rollback_needs_reverify',
  'probe_expired',
  'probe_failed',
  'exit_ip_mismatch',
  'buyer_exit_connections_unconfirmed',
];

describe('readiness labels', () => {
  it('cover every readiness with text and a badge variant', () => {
    for (const r of ALL_READINESS) {
      expect(READINESS_LABELS[r].label.length).toBeGreaterThan(0);
      expect(['primary', 'success', 'warning', 'danger', 'gray', 'purple']).toContain(READINESS_LABELS[r].variant);
    }
  });

  it('only active and ready are green; failures are red', () => {
    const green = ALL_READINESS.filter((r) => READINESS_LABELS[r].variant === 'success');
    expect(green.sort()).toEqual(['active', 'ready']);
    expect(READINESS_LABELS.sync_failed.variant).toBe('danger');
    expect(READINESS_LABELS.proxy_unavailable.variant).toBe('danger');
    expect(READINESS_LABELS.invalid.variant).toBe('danger');
  });
});

describe('route warning text', () => {
  it('covers every warning in readable Chinese', () => {
    for (const w of ALL_WARNINGS) {
      expect(ROUTE_WARNING_TEXT[w].text).toMatch(/[一-龥]/);
      expect(ROUTE_WARNING_TEXT[w].text).not.toMatch(/[!！]/);
    }
  });

  it('uses the agreed wording for the key warnings', () => {
    expect(warningText('old_windows_kept_open')).toBe('旧环境窗口未关闭，其后续请求将使用当前出口');
    expect(warningText('managed_windows_on_original_rules')).toBe('旧环境窗口未关闭，其后续请求将按 Surge 原规则发出（可能直连）');
    expect(warningText('launch_unverified')).toBe('本次打开未经启动验证');
    expect(warningText('takeover_unknown')).toBe('接管状态无法读取');
  });

  it('marks loss-of-control warnings as danger', () => {
    for (const w of ['takeover_lost', 'surge_unreachable', 'external_selection_change', 'precedence_violation', 'exit_ip_mismatch'] as const) {
      expect(ROUTE_WARNING_TEXT[w].severity).toBe('danger');
    }
    expect(ROUTE_WARNING_TEXT.takeover_unknown.severity).toBe('warning');
  });

  it('falls back to a visible text for an unknown warning', () => {
    expect(warningText('something_new' as RouteWarning)).toContain('something_new');
  });
});

describe('phase and kind labels', () => {
  it('cover every operation phase and kind', () => {
    for (const p of OPERATION_PHASES) expect(OPERATION_PHASE_LABELS[p]).toBeDefined();
    for (const k of OPERATION_KINDS) expect(OPERATION_KIND_LABELS[k]).toBeDefined();
    expect(ENTRY_MODE_LABELS.UNKNOWN.variant).toBe('danger');
    expect(OPERATION_PHASE_LABELS.BLOCKED_NEEDS_ATTENTION.variant).toBe('danger');
  });
});

describe('format helpers', () => {
  it('formats numbers with thousands separators and relative times with units', () => {
    expect(formatNumber(1284)).toBe('1,284');
    const now = Date.parse('2026-10-21T08:10:00.000Z');
    expect(formatRelative('2026-10-21T08:09:58.000Z', now)).toBe('刚刚');
    expect(formatRelative('2026-10-21T08:09:30.000Z', now)).toBe('30 秒前');
    expect(formatRelative('2026-10-21T08:00:00.000Z', now)).toBe('10 分钟前');
    expect(formatRelative('2026-10-21T06:10:00.000Z', now)).toBe('2 小时前');
    expect(formatRelative(null, now)).toBe('—');
    expect(formatSeconds(90)).toBe('1 分钟 30 秒');
  });

  it('brackets IPv6 hosts', () => {
    expect(formatHostPort('2001:db8::10', 1080)).toBe('[2001:db8::10]:1080');
    expect(proxyAddress(revision(1, { host: '198.51.100.7', port: 7890 }))).toBe('SOCKS5 198.51.100.7:7890');
  });

  it('treats missing or past expiry as expired', () => {
    const now = Date.parse('2026-10-21T08:10:00.000Z');
    expect(isExpired(null, now)).toBe(true);
    expect(isExpired('2026-10-21T08:09:00.000Z', now)).toBe(true);
    expect(isExpired('2026-10-21T08:11:00.000Z', now)).toBe(false);
  });
});

describe('environment helpers', () => {
  it('shows an expired probe as last result, never as live', () => {
    const now = Date.parse('2026-10-21T09:00:00.000Z');
    const probe = {
      id: 'p1',
      kind: 'safari' as const,
      outcome: 'ok' as const,
      exitIp: '192.0.2.44',
      proxyRevision: 1,
      nodeName: 'SFE-N-E0001-US01-v001',
      routeEpoch: 1,
      configurationGeneration: 4,
      entryMode: 'VERIFY_ONLY' as const,
      testId: null,
      surgeRequest: null,
      chainEvidence: null,
      browser: null,
      observedAt: '2026-10-21T08:00:00.000Z',
      expiresAt: '2026-10-21T08:15:00.000Z',
      message: null,
    };
    expect(probeDisplay(probe, now)).toMatchObject({ exitIp: '192.0.2.44', expired: true, ok: true });
  });

  it('classifies pending deploys and attention', () => {
    const pending = environment({ proxy: { desired: revision(2), deployed: revision(1), active: null, lastVerified: null } });
    expect(hasPendingDeploy(pending)).toBe(true);
    expect(hasPendingDeploy(environment())).toBe(false);
    expect(needsAttention(environment({ readiness: 'needs_reverify' }))).toBe(true);
    expect(matchesFilter(environment({ binding: { state: 'unbound', stage: null, profileIdShort: null, boundAt: null, sitePermissionGranted: null } }), 'unbound')).toBe(true);
  });

  it('only waiting route operations are cancellable', () => {
    expect(isCancellableRouteOperation(operation({ kind: 'route.activate', status: 'waiting' }))).toBe(true);
    expect(isCancellableRouteOperation(operation({ kind: 'route.activate', status: 'running' }))).toBe(false);
    expect(isCancellableRouteOperation(operation({ kind: 'deploy.publish', phase: 'WAITING_ROUTE', status: 'waiting' }))).toBe(true);
    expect(isCancellableRouteOperation(operation({ kind: 'route.normal', status: 'waiting', phase: 'SAFARI_BLOCKED' }))).toBe(false);
  });

  it('names the cancel action by its effect (a bare 取消 only dismisses)', () => {
    expect(cancelActionLabel(operation({ kind: 'route.activate', phase: 'VERIFY_ONLY' }))).toBe('取消切换');
    expect(cancelActionLabel(operation({ kind: 'deploy.publish', phase: 'WAITING_ROUTE' }))).toBe('取消等待');
    expect(cancelActionLabel(operation({ kind: 'probe.safari', phase: 'VERIFY_ONLY' }))).toBe('取消重测');
  });
});
