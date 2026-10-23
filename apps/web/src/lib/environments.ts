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

/**
 * 环境正在使用或正在验证：删除、解除绑定会被服务端以 ENVIRONMENT_ACTIVE 拒绝（§6.7）。另含入口不是普通模式而 SFE-ROUTE
 * 选着它的节点（例如交给普通模式、已写入使用中模式的切换目标，普通模式又失败了）：路由的使用中环境是另一个，Safari 却可能
 * 经它的出口发出。这里只看视图中的几个版本，服务端按全部版本判断，拒绝时同样提示先进入普通模式。
 */
export function isEnvironmentInUse(env: EnvironmentView, route: RouteStateView | null): boolean {
  if (route && route.activeEnvironmentId === env.id) return true;
  if (route && route.entryMode !== 'NORMAL' && route.selectedNode !== null) {
    const nodes = [env.proxy.desired, env.proxy.deployed, env.proxy.active, env.proxy.lastVerified].map((r) => r?.nodeName);
    if (nodes.includes(route.selectedNode)) return true;
  }
  return env.facets.route === 'active' || env.facets.route === 'activating' || env.facets.route === 'verifying' || env.facets.route === 'waiting_route';
}

/**
 * 提供「进入普通模式」：按服务端判定的 normalModeOffered（§6.5：入口不是普通模式、阶段不是 idle、仍有活动环境或激活快照、
 * Safari 可能仍有经买家出口的连接）。本地的几项只是同一判断中看得到的部分，不能代替它：例如回滚失败记为 NORMAL（阶段
 * attention），或普通模式结束连接失败之后读回也失败、路由已记为空闲的普通模式而持久标记仍在。
 */
export function normalModeOffered(route: RouteStateView | null | undefined): boolean {
  if (!route) return false;
  return (
    route.normalModeOffered === true ||
    route.entryMode !== 'NORMAL' ||
    route.phase !== 'idle' ||
    route.activeEnvironmentId !== null ||
    route.warnings.includes('buyer_exit_connections_unconfirmed')
  );
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

/**
 * 等待中的路由操作可以取消（回滚，从不进入普通模式）：激活与重测、停在 WAITING_ROUTE 的活动环境发布，以及活动环境发布进入
 * 切换之后的 VERIFY_ONLY 等待（操作类型仍是 environment.update / deploy.publish，§6.3 第 14 步「与激活相同」）。与弹窗、服务端
 * acceptCancel（等待中且带路由参数）一致。
 */
export function isCancellableRouteOperation(op: Pick<OperationView, 'status' | 'kind' | 'phase'>): boolean {
  if (op.status !== 'waiting') return false;
  return op.kind === 'route.activate' || op.kind === 'probe.safari' || op.phase === 'WAITING_ROUTE' || op.phase === 'VERIFY_ONLY';
}

/**
 * 当前环境的 Safari 重测（§6.4：不切换、不阻断、不回滚；超时或取消只结束检测）：重测操作本身，或激活第 1 步复用时改为重测的
 * 激活（环境已在使用中而实测过期：操作仍是 route.activate，服务端记 probeKind 'safari'）。
 */
export function isSafariRetest(op: Pick<OperationView, 'kind' | 'probeKind'>): boolean {
  return op.kind === 'probe.safari' || op.probeKind === 'safari';
}

/**
 * 取消等待中路由操作的按钮与确认文案：按效果命名（取消等待、取消重测、取消切换）。
 * 单独的「取消」在设计系统中只表示关闭弹窗、不做操作。
 */
export function cancelActionLabel(op: Pick<OperationView, 'kind' | 'phase' | 'probeKind'>): string {
  if (op.phase === 'WAITING_ROUTE') return '取消等待';
  if (isSafariRetest(op)) return '取消重测';
  return '取消切换';
}

export function sortByCode(list: EnvironmentView[]): EnvironmentView[] {
  return [...list].sort((a, b) => a.code.localeCompare(b.code, 'en', { numeric: true }));
}
