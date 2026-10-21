// 环境列表的筛选与展示辅助。汇总状态只读服务端给出的 readiness（与插件、服务共用 deriveReadiness），
// 这里不再自行推导“是否可用”。

import { SITES, environmentLabel, type EnvironmentView, type OperationView, type ProbeView, type ProxyRevisionView, type RouteStateView } from '@sfe/contract';
import { formatHostPort, formatRelative, isExpired } from './format';

export type EnvironmentFilter = 'all' | 'using' | 'pending' | 'unbound' | 'attention';

export function envLabel(env: Pick<EnvironmentView, 'displayName' | 'code'>): string {
  return environmentLabel(env.displayName, env.code);
}

export function siteLabel(env: Pick<EnvironmentView, 'site'>): string {
  return SITES[env.site]?.label ?? env.site;
}

export function proxyAddress(rev: ProxyRevisionView | null | undefined): string {
  if (!rev) return '—';
  return `SOCKS5 ${formatHostPort(rev.host, rev.port)}`;
}

export function isUsing(env: EnvironmentView): boolean {
  return env.readiness === 'active' || env.readiness === 'activating';
}

export function hasPendingDeploy(env: EnvironmentView): boolean {
  const { desired, deployed } = env.proxy;
  if (env.facets.deployment === 'pending' || env.facets.deployment === 'blocked_by_capability' || env.facets.deployment === 'deploying') return true;
  if (!desired) return false;
  return !deployed || desired.revision > deployed.revision;
}

export function needsAttention(env: EnvironmentView): boolean {
  return (
    env.readiness === 'invalid' ||
    env.readiness === 'sync_failed' ||
    env.readiness === 'proxy_unavailable' ||
    env.readiness === 'needs_reverify' ||
    env.facets.deployment === 'failed' ||
    env.lastError !== null
  );
}

export function matchesFilter(env: EnvironmentView, filter: EnvironmentFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'using':
      return isUsing(env);
    case 'pending':
      return hasPendingDeploy(env);
    case 'unbound':
      return env.binding.state === 'unbound';
    case 'attention':
      return needsAttention(env);
  }
}

export function matchesSearch(env: EnvironmentView, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const rev = env.proxy.desired ?? env.proxy.deployed;
  const hay = [env.displayName, env.code, env.nodeTag, env.account.label ?? '', rev?.host ?? '', rev?.frontProxyName ?? '', env.binding.profileIdShort ?? '']
    .join('\n')
    .toLowerCase();
  return hay.includes(q);
}

/** 环境正在使用或正在验证：删除、解除绑定会被服务端以 ENVIRONMENT_ACTIVE 拒绝。 */
export function isEnvironmentInUse(env: EnvironmentView, route: RouteStateView | null): boolean {
  if (route && route.activeEnvironmentId === env.id) return true;
  return env.facets.route === 'active' || env.facets.route === 'activating' || env.facets.route === 'verifying' || env.facets.route === 'waiting_route';
}

export interface ProbeDisplay {
  exitIp: string | null;
  when: string;
  expired: boolean;
  ok: boolean;
}

/** Safari 实测展示：过期后显示「上次结果」，不当作实时。 */
export function probeDisplay(probe: ProbeView | null | undefined, now: number): ProbeDisplay | null {
  if (!probe) return null;
  return {
    exitIp: probe.exitIp,
    when: formatRelative(probe.observedAt, now),
    expired: isExpired(probe.expiresAt, now),
    ok: probe.outcome === 'ok',
  };
}

/** 等待中的路由操作可以取消（回滚，从不进入普通模式）。 */
export function isCancellableRouteOperation(op: Pick<OperationView, 'status' | 'kind' | 'phase'>): boolean {
  if (op.status !== 'waiting') return false;
  return op.kind === 'route.activate' || op.kind === 'probe.safari' || op.phase === 'WAITING_ROUTE';
}

export function sortByCode(list: EnvironmentView[]): EnvironmentView[] {
  return [...list].sort((a, b) => a.code.localeCompare(b.code, 'en', { numeric: true }));
}
