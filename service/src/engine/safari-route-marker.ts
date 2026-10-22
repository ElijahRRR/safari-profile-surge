// 持久标记（引擎键值，跨服务重启）：Safari 可能经 SFE-ROUTE 发出、仍可能有经买家出口的连接（docs/ARCHITECTURE.md §6.5）。
// 激活写入 VERIFY_ONLY/ACTIVE 之前设置；只在一次普通模式确认结束了全部 Safari 连接、且结束前后的入口（阻断与 NORMAL）都经
// 运行时求值确认之后清除——否则 Surge 可能仍加载着写前的入口，Safari 在结束之后又经 SFE-ROUTE 建立新连接。路由记录不能代替
// 它：失败的回滚可能按入口切换报告的最后确认状态把入口记为 NORMAL（§6.3 第 14 步），普通模式未能确认结束连接之后路由记录也
// 已是空闲的普通模式，而之前经 SFE-ROUTE 建立的 Safari 长连接仍在买家出口上。
// 标记同时记下设置以来配置过的 Safari 进程路径：之后确认的进程归属提议可能换掉这些路径，普通模式另按被换掉的路径结束其中可能
// 经买家出口的连接（只有这些：按新的确认它们不再是配置的 Safari 进程）。

import type { RouteStateRecord } from '../db/index.js';
import type { Engine } from './context.js';

const KEY = 'route:safariMayUseRoute';

interface SafariMayUseRouteMarker {
  operationId: string | null;
  at: string;
  /** 标记设置以来配置过的 Safari 进程路径（早先的标记没有这一项）。 */
  processPaths?: string[];
}

function read(engine: Engine): SafariMayUseRouteMarker | null {
  return engine.kv.get<SafariMayUseRouteMarker>(KEY);
}

function pathsOf(marker: SafariMayUseRouteMarker | null): string[] {
  return Array.isArray(marker?.processPaths) ? marker.processPaths.filter((p): p is string => typeof p === 'string') : [];
}

/**
 * 设置标记（已存在时保留原记录），并并入给定的 Safari 进程路径。激活在写入 VERIFY_ONLY/ACTIVE 之前以当前路径调用；确认
 * 进程归属提议换掉路径、而 Safari 可能经 SFE-ROUTE 时以被换掉的路径调用。
 */
export function markSafariMayUseRoute(engine: Engine, operationId: string | null, processPaths: readonly string[]): void {
  const prev = read(engine);
  const paths = [...new Set([...pathsOf(prev), ...processPaths])];
  engine.kv.set(KEY, { operationId: prev?.operationId ?? operationId, at: prev?.at ?? engine.nowIso(), processPaths: paths });
}

export function clearSafariMayUseRoute(engine: Engine): void {
  engine.kv.delete(KEY);
}

export function safariMayUseRouteMarked(engine: Engine): boolean {
  return read(engine) !== null;
}

/** 标记中记下、当前已不在配置中的 Safari 进程路径（被之后确认的进程归属提议换掉）。 */
export function retiredSafariPaths(engine: Engine, current: readonly string[]): string[] {
  return pathsOf(read(engine)).filter((p) => !current.includes(p));
}

/**
 * Safari 是否可能仍有经 SFE-ROUTE 的连接：路由记录不是空闲的普通模式、仍有使用中的环境或激活快照（上一次切换没有回到已确认
 * 的状态），或持久标记仍在。都不成立时 Safari 的连接已按原规则发出。
 */
export function safariMayUseRoute(engine: Engine, route: RouteStateRecord): boolean {
  return (
    route.entryMode !== 'NORMAL' ||
    route.phase !== 'idle' ||
    route.activeEnvironmentId !== null ||
    route.activationSnapshot !== null ||
    safariMayUseRouteMarked(engine)
  );
}
