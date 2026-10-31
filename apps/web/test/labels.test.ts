import { describe, expect, it } from 'vitest';
import { OPERATION_KINDS, OPERATION_PHASES, type EnvironmentReadiness, type NodeResourceState, type RouteWarning } from '@sfe/contract';
import {
  ENTRY_MODE_LABELS,
  NODE_RESOURCE_NEEDS_REFRESH_TEXT,
  NODE_RESOURCE_STATE_DETAILS,
  NODE_RESOURCE_STATE_LABELS,
  NODE_RESOURCE_TOKEN_SUSPECT_TEXT,
  OPERATION_KIND_LABELS,
  OPERATION_PHASE_LABELS,
  READINESS_LABELS,
  ROUTE_WARNING_TEXT,
  warningText,
} from '../src/lib/labels';
import { formatHostPort, formatNumber, formatRelative, formatSeconds, isExpired } from '../src/lib/format';
import { cancelActionLabel, hasPendingDeploy, isCancellableRouteOperation, isEnvironmentInUse, matchesFilter, needsAttention, probeDisplay, proxyAddress } from '../src/lib/environments';
import { environment, operation, revision, route } from './fixtures';

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
  'node_resource_unverified',
];

const ALL_NODE_RESOURCE_STATES: NodeResourceState[] = ['serving', 'not_listening', 'token_unavailable', 'legacy_line', 'not_installed'];

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

  it('lists exactly the contract warnings (a new warning needs its text here)', () => {
    expect(Object.keys(ROUTE_WARNING_TEXT).sort()).toEqual([...ALL_WARNINGS].sort());
  });

  it('says what node_resource_unverified means and shows it as danger (D10)', () => {
    expect(warningText('node_resource_unverified')).toBe('节点资源未确认：Surge 中的节点无法证明来自本机资源服务的已提交版本');
    expect(ROUTE_WARNING_TEXT.node_resource_unverified.severity).toBe('danger');
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

describe('local resource server labels (D10)', () => {
  it('cover every state; only serving is green; texts never carry an address, port or token', () => {
    expect(Object.keys(NODE_RESOURCE_STATE_LABELS).sort()).toEqual([...ALL_NODE_RESOURCE_STATES].sort());
    expect(Object.keys(NODE_RESOURCE_STATE_DETAILS).sort()).toEqual([...ALL_NODE_RESOURCE_STATES].sort());
    expect(ALL_NODE_RESOURCE_STATES.filter((st) => NODE_RESOURCE_STATE_LABELS[st].variant === 'success')).toEqual(['serving']);
    const texts = [
      ...ALL_NODE_RESOURCE_STATES.map((st) => NODE_RESOURCE_STATE_LABELS[st].label),
      ...Object.values(NODE_RESOURCE_STATE_DETAILS),
      NODE_RESOURCE_TOKEN_SUSPECT_TEXT,
      NODE_RESOURCE_NEEDS_REFRESH_TEXT,
    ];
    for (const t of texts) {
      expect(t).toMatch(/[一-龥]/);
      expect(t).not.toMatch(/[!！]/);
      expect(t).not.toMatch(/127\.0\.0\.1:\d|[0-9a-f]{32,}/i);
    }
  });

  it('names the error code and the remerge where the user has to act', () => {
    expect(NODE_RESOURCE_STATE_DETAILS.not_listening).toContain('RESOURCE_SERVER_UNAVAILABLE');
    expect(NODE_RESOURCE_STATE_DETAILS.token_unavailable).toContain('SECRET_STORE_FAILED');
    expect(NODE_RESOURCE_STATE_DETAILS.token_unavailable).toContain('普通模式不受影响');
    expect(NODE_RESOURCE_STATE_DETAILS.legacy_line).toContain('需要重新合并以改用本机资源服务');
    expect(NODE_RESOURCE_STATE_DETAILS.not_installed).toContain('需要重新合并');
    expect(NODE_RESOURCE_TOKEN_SUSPECT_TEXT).toContain('更换本机资源地址');
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
  it('an environment whose node SFE-ROUTE still selects while the entry is not normal counts as in use (delete and unbind ask for normal mode first)', () => {
    const env = environment();
    const node = env.proxy.deployed!.nodeName;
    // 交给普通模式、已写入使用中模式的切换目标，普通模式失败：路由的使用中环境是另一个
    expect(isEnvironmentInUse(env, route({ entryMode: 'ACTIVE', phase: 'attention', activeEnvironmentId: 'env_9', selectedNode: node }))).toBe(true);
    expect(isEnvironmentInUse(env, route({ entryMode: 'BLOCKED', phase: 'failed', activeEnvironmentId: 'env_9', selectedNode: node }))).toBe(true);
    // 普通模式下删除会先改选 REJECT：不算使用中
    expect(isEnvironmentInUse(env, route({ entryMode: 'NORMAL', phase: 'idle', selectedNode: node }))).toBe(false);
    expect(isEnvironmentInUse(env, route({ entryMode: 'BLOCKED', phase: 'failed', activeEnvironmentId: 'env_9', selectedNode: 'SFE-N-E0009-US09-v001' }))).toBe(false);
  });

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
    // 活动环境发布进入切换之后的 VERIFY_ONLY 等待：与激活相同，可以取消切换（与弹窗一致）
    for (const kind of ['environment.update', 'deploy.publish'] as const) {
      const op = operation({ kind, phase: 'VERIFY_ONLY', status: 'waiting' });
      expect(isCancellableRouteOperation(op)).toBe(true);
      expect(cancelActionLabel(op)).toBe('取消切换');
      expect(isCancellableRouteOperation(operation({ kind, phase: 'VERIFY_ONLY', status: 'running' }))).toBe(false);
    }
  });

  it('names the cancel action by its effect (a bare 取消 only dismisses)', () => {
    expect(cancelActionLabel(operation({ kind: 'route.activate', phase: 'VERIFY_ONLY' }))).toBe('取消切换');
    expect(cancelActionLabel(operation({ kind: 'deploy.publish', phase: 'WAITING_ROUTE' }))).toBe('取消等待');
    expect(cancelActionLabel(operation({ kind: 'probe.safari', phase: 'VERIFY_ONLY' }))).toBe('取消重测');
    // 激活第 1 步复用时改为的重测：操作仍是 route.activate，服务端记 probeKind safari
    expect(cancelActionLabel(operation({ kind: 'route.activate', phase: 'VALIDATING', probeKind: 'safari' }))).toBe('取消重测');
  });
});
