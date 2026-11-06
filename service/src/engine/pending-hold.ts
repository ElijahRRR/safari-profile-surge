// 推迟的 REJECT 保持（docs/ARCHITECTURE.md §0「配置身份与失败即关闭」、§6.6「推迟的改选」）：路由操作的结束点（以及回滚、普通模式、
// 执行器兜底、REJECT 保持）要改选 SFE-ROUTE 的 REJECT，而 Surge 不可连接、当前不是或无法确认是固定工作配置，或不能确认改选落在
// 固定工作配置上、无法确认中断之前是否已改选时，从不改动其他配置中的同名组——记下 route:pendingHold，路由按未确认的保持记下
// （attention 与相应警告）。之后第一次确认是固定工作配置的对账：
// - 记下的是中断或配置变动的改选意图（kind 'intent'）而读回 REJECT：按本应用中断之前的改选记下 selectedNode（不当作外部修改）；
// - 否则入口仍可能让 Safari 经 SFE-ROUTE、而选择既不是 REJECT 也不是使用中环境已验证的出口：排入一次服务的 REJECT 保持
//   （route.hold，payload.endHoldDeferred；与 D11 相同的领取顺序，排队的普通模式先执行），由执行器在固定工作配置上改选。
// 对账本身从不写 Surge。另：步骤 8 的目标节点、回滚恢复的节点与发布回滚改回的节点改选期间配置变了（route:unconfirmedWrite）时，
// 之后对账发现选择与记录不一致而与这次未确认的写入一致，照样记 external_selection_change（失败即关闭），说明写明不是外部修改。

import type { RouteWarning } from '@sfe/contract';
import type { RouteStateRecord } from '../db/index.js';
import { payloadOf, type EndHoldIntent } from '../domain/operations.js';
import { routeNotConfirmedNormal } from '../domain/route-rules.js';
import { readForgedNodes } from '../resource/index.js';
import type { Engine } from './context.js';
import type { RouteGuardBlock } from './route-guard.js';

export const PENDING_HOLD_KEY = 'route:pendingHold';
export const UNCONFIRMED_WRITE_KEY = 'route:unconfirmedWrite';

/** 结束点的 REJECT 保持没有在固定工作配置上确认的原因：守卫拒绝的原因，或（崩溃恢复中）读取 SFE-ROUTE 失败。 */
export type HoldBlock = RouteGuardBlock | 'selection_unreadable';

export const HOLD_BLOCK_TEXT: Record<HoldBlock, string> = {
  surge_unreachable: '无法连接 Surge',
  external_profile: 'Surge 当前配置不是固定工作配置',
  profile_unknown: '无法确认 Surge 当前配置是否是固定工作配置',
  selection_unreadable: '读取 SFE-ROUTE 失败',
};

/**
 * route:pendingHold：最多一条（新的覆盖旧的，旧的那条在它的来源操作中写明不再核对）。kind 'intent'：改选意图已记下（崩溃恢复中
 * 无法核对、改选期间配置变了），之后读回 REJECT 时按本应用的改选记下；'skipped'：守卫拒绝、没有改选（或意图已在确认是固定工作
 * 配置的对账中读回不是 REJECT：意图已解决为没有生效，之后的 REJECT 不再按它记下）。routeEpoch、routeOperationId 与 selectedNode
 * 是这次结束留下的路由：之后任何路由操作改写了路由，记录即作废（stale）。
 */
export interface PendingHold {
  kind: 'intent' | 'skipped';
  operationId: string;
  cause?: 'node_resource_forged';
  intent?: EndHoldIntent;
  block: HoldBlock;
  /**
   * 来源操作的保持没有确认的阶段（RejectHold.guard.stage）：interrupted 崩溃恢复中无法核对中断之前的改选；profile_changed 改选期间
   * 配置变了（没有中断）；not_attempted 守卫拒绝。只用于说明（没有时按 interrupted 写）。
   */
  stage?: 'not_attempted' | 'profile_changed' | 'interrupted';
  routeEpoch: number;
  routeOperationId: string | null;
  selectedNode: string | null;
  recordedAt: string;
  /** 已在来源操作中写明服务排入了改选（maybeEnqueueDeferredHold 实际排入时写，不重复写）。 */
  notified?: boolean;
  /** 已在来源操作中写明已有排队或执行中的 REJECT 保持、由它改选（不重复写）。 */
  otherHoldNoted?: boolean;
}

/** route:unconfirmedWrite：改选买家节点期间配置变了（步骤 8 的目标、回滚恢复、发布回滚改回）：不记为路由的选择。 */
export interface UnconfirmedWrite {
  policy: string;
  operationId: string;
  routeEpoch: number;
}

export function readPendingHold(engine: Engine): PendingHold | null {
  const v = engine.kv.get<PendingHold>(PENDING_HOLD_KEY);
  return v && typeof v === 'object' && typeof v.operationId === 'string' && (v.kind === 'intent' || v.kind === 'skipped') ? v : null;
}

export function readUnconfirmedWrite(engine: Engine): UnconfirmedWrite | null {
  const v = engine.kv.get<UnconfirmedWrite>(UNCONFIRMED_WRITE_KEY);
  return v && typeof v === 'object' && typeof v.policy === 'string' && typeof v.routeEpoch === 'number' ? v : null;
}

/** 在调用方的事务中记下一次未确认的买家节点写入。 */
export function recordUnconfirmedWrite(engine: Engine, policy: string, operationId: string): void {
  engine.kv.set(UNCONFIRMED_WRITE_KEY, { policy, operationId, routeEpoch: engine.repos.routeState.get().routeEpoch } satisfies UnconfirmedWrite);
}

/**
 * 按路由记录，Surge 加载的本应用入口是否可能仍让 Safari 经 SFE-ROUTE：入口不是经运行时求值确认的阻断或普通模式（VERIFY_ONLY、
 * ACTIVE、UNKNOWN），或带 entry_unverified（读回未经运行时求值确认、退路写入、对账发现与记录不一致或能力过期），或阻断带
 * precedence_violation（排在入口之前的规则可能把 Safari 请求交给 SFE-ROUTE）。普通模式只看 entry_unverified：本应用入口已撤下时，
 * 排在它之前的规则与本应用入口无关。
 */
export function entryMayUseRoute(route: RouteStateRecord): boolean {
  if (route.warnings.includes('entry_unverified')) return true;
  if (route.entryMode === 'NORMAL') return false;
  if (route.entryMode === 'BLOCKED') return route.warnings.includes('precedence_violation');
  return true;
}

/**
 * 按路由记录，使用中环境已验证的出口节点；记录不能证明时为 null。节点资源可能被伪造时（resource:forgedNodes，用户决定 D11）任何
 * 买家节点都不算已验证的出口：为 null（结束点、普通模式失败与执行器兜底因此改选 REJECT）。
 */
export function verifiedExitNode(engine: Engine, route: RouteStateRecord): string | null {
  if (readForgedNodes(engine.kv) !== null) return null;
  return verifiedExitNodeIgnoringForged(engine, route);
}

/** verifiedExitNode 不看伪造标记的部分：只用于写明结束点的改选是否只因伪造标记（holdAtRouteEnd）。 */
export function verifiedExitNodeIgnoringForged(engine: Engine, route: RouteStateRecord): string | null {
  if (route.activationSnapshot !== null || route.activeEnvironmentId === null || route.activeProxyRevision === null) return null;
  if (route.warnings.includes('external_selection_change')) return null;
  const rev = engine.repos.proxyRevisions.get(route.activeEnvironmentId, route.activeProxyRevision);
  return rev && route.selectedNode === rev.nodeName ? rev.nodeName : null;
}

/** 记录是否已作废：之后的路由操作改写了路由（epoch、负责的操作或选择不同）。 */
export function pendingHoldStale(rec: PendingHold, route: RouteStateRecord): boolean {
  return rec.routeEpoch !== route.routeEpoch || rec.routeOperationId !== route.operationId || rec.selectedNode !== route.selectedNode;
}

/** 在来源操作中追加一步（只追加，不改状态与结果）；操作不在时什么也不做。 */
export function appendSourceStep(engine: Engine, opId: string, message: string): void {
  const op = engine.repos.operations.get(opId);
  if (op) engine.repos.operations.appendStep(opId, op.phase, message);
}

/** 记下的意图是改选期间配置变了（没有中断）的那次改选：说明不说「中断之前」。 */
function changedDuringWrite(rec: PendingHold): boolean {
  return rec.stage === 'profile_changed';
}

/** 记录作废时在来源操作中写明的说明。 */
export function staleText(rec: PendingHold): string {
  if (rec.kind !== 'intent') return '之后的路由操作已改写路由，不再按本操作排入改选';
  return changedDuringWrite(rec) ? '之后的路由操作已改写路由，不再核对本操作改选期间配置变了的那次改选' : '之后的路由操作已改写路由，不再核对中断之前的改选';
}

/**
 * 服务为这条记录排入的推迟改选（route.hold，payload.endHoldDeferred.sourceOperationId 为来源操作）仍在排队或执行中：记录由它结算
 * （finishDeferredHold 删除并写明结果）——对账不认定、不删除、不写步骤（否则服务崩溃之后，启动对账会先于它的恢复把它的 REJECT
 * 按来源操作中断之前的改选记下，或按「不是本操作改选的」删除记录，之后它的恢复又写明是它改选的）。
 */
export function deferredHoldOpenFor(engine: Engine, sourceOperationId: string): boolean {
  return engine.repos.operations
    .listByStatus(['queued', 'running'], { kinds: ['route.hold'] })
    .some((o) => payloadOf(o).endHoldDeferred?.sourceOperationId === sourceOperationId);
}

/**
 * 在调用方的事务中（路由已按这次结束更新之后）记下 route:pendingHold：hold 没有在固定工作配置上确认（guard，或带未解决的意图）
 * 而入口仍可能让 Safari 经 SFE-ROUTE 时。之前的记录属于另一个操作时在它的来源操作中写明不再核对。返回是否记下。
 */
export function recordPendingHold(
  engine: Engine,
  opId: string,
  hold: {
    confirmed: boolean;
    guard?: { block: HoldBlock; stage: 'not_attempted' | 'profile_changed' | 'interrupted' };
    unresolvedIntent?: EndHoldIntent;
    cause?: 'node_resource_forged';
  },
): boolean {
  if (hold.confirmed || !hold.guard) return false;
  const fresh = engine.repos.routeState.get();
  const forgedCause = hold.cause === 'node_resource_forged' || hold.unresolvedIntent?.cause === 'node_resource_forged';
  // 入口已不让 Safari 经 SFE-ROUTE：不需要之后的改选（REJECT 保持的伪造原因除外——它本来就不看入口，只看路由不是经确认的普通模式）
  if (!entryMayUseRoute(fresh) && !(forgedCause && routeNotConfirmedNormal(fresh))) return false;
  const prev = readPendingHold(engine);
  if (prev && prev.operationId !== opId) appendSourceStep(engine, prev.operationId, staleText(prev));
  const rec: PendingHold = {
    kind: hold.unresolvedIntent ? 'intent' : 'skipped',
    operationId: opId,
    ...(forgedCause ? { cause: 'node_resource_forged' as const } : {}),
    ...(hold.unresolvedIntent ? { intent: hold.unresolvedIntent } : {}),
    block: hold.guard.block,
    stage: hold.guard.stage,
    routeEpoch: fresh.routeEpoch,
    routeOperationId: fresh.operationId,
    selectedNode: fresh.selectedNode,
    recordedAt: engine.nowIso(),
  };
  engine.kv.set(PENDING_HOLD_KEY, rec);
  return true;
}

const TRANSITION_PHASES: readonly RouteStateRecord['phase'][] = ['switching', 'awaiting_safari_verify', 'rolling_back'];

/** 对账中的推迟改选：读取 Surge 之后（事务之前）的计划。 */
export interface PendingHoldPlan {
  record: PendingHold | null;
  /** 这次对账确认是固定工作配置（可连接、onWorkingProfile、读到选择，且读取之后再核对仍是固定工作配置）。 */
  confirmed: boolean;
  /** 计划按本应用中断之前的改选记下（不再比较选择）。 */
  credit: boolean;
  unconfirmedWrite: UnconfirmedWrite | null;
}

/**
 * 对账的计划部分（读完 Surge 之后、计算警告之前调用）：有记录、这次读到选择且确认是固定工作配置时，再核对一次当前配置
 * （profileStillWorking 由调用方传入的 postCheck 执行，只在需要时调用）。
 */
export async function planPendingHold(
  engine: Engine,
  input: { confirmedFacts: boolean; selection: string | null | undefined; before: RouteStateRecord; postCheck: () => Promise<boolean> },
): Promise<PendingHoldPlan> {
  const record = readPendingHold(engine);
  const unconfirmedWrite = readUnconfirmedWrite(engine);
  if ((record === null && unconfirmedWrite === null) || !input.confirmedFacts || input.selection === undefined) {
    return { record, confirmed: false, credit: false, unconfirmedWrite };
  }
  const confirmed = await input.postCheck();
  const credit =
    confirmed &&
    record !== null &&
    record.kind === 'intent' &&
    input.selection === 'REJECT' &&
    !pendingHoldStale(record, input.before) &&
    !TRANSITION_PHASES.includes(input.before.phase) &&
    // 服务为它排入的改选仍在排队或执行中：读到的 REJECT 可能是那次改选的（服务在它记下之前崩溃），由它结算
    !deferredHoldOpenFor(engine, record.operationId);
  return { record, confirmed, credit, unconfirmedWrite };
}

/** applyPendingHold 的结果。 */
export interface PendingHoldOutcome {
  /** 按本应用中断之前的改选记下的来源操作。 */
  credited: string | null;
  /** 需要排入一次推迟的改选（事务之后 maybeEnqueueDeferredHold）。 */
  enqueue: PendingHold | null;
  notes: string[];
  /** 路由记录改变了（选择、阶段或警告）。 */
  routeChanged: boolean;
  /** 追加了步骤的来源操作（发布更新）。 */
  touchedOps: string[];
}

/**
 * 对账提交事务中的推迟改选（重读的路由 fresh）：
 * - 服务为它排入的改选仍在排队或执行中（deferredHoldOpenFor）：不动记录，由那次改选结算；
 * - 记录已作废：删除并在来源操作中写明；
 * - 没有确认是固定工作配置、或路由在过渡中：保留；
 * - 意图 + 读回 REJECT（计划中已确认）：记 selectedNode = REJECT（阶段不能停在 active_verified），去掉因此而起的外部修改警告，
 *   在来源操作中写明，删除记录；
 * - 读回已是 REJECT（没有意图）：不需要改选，删除记录；
 * - 入口仍可能让 Safari 经 SFE-ROUTE、选择不是使用中环境已验证的出口：意图记录改为 skipped（意图已解决为没有生效，之后的 REJECT
 *   不再按它记下）并在来源操作中写明，返回需要排入的改选，保留记录（排入与否由 maybeEnqueueDeferredHold 在来源操作中写明）；
 * - 其余：不需要改选，删除记录。
 * 未确认的买家节点写入（route:unconfirmedWrite）在确认是固定工作配置的对账中处理之后删除（作废时同样删除）。
 */
export function applyPendingHold(engine: Engine, plan: PendingHoldPlan, selection: string | null | undefined): PendingHoldOutcome {
  const { repos, kv } = engine;
  const out: PendingHoldOutcome = { credited: null, enqueue: null, notes: [], routeChanged: false, touchedOps: [] };
  const fresh = repos.routeState.get();
  const uw = readUnconfirmedWrite(engine);
  if (uw !== null && (uw.routeEpoch !== fresh.routeEpoch || plan.confirmed)) kv.delete(UNCONFIRMED_WRITE_KEY);
  const rec = readPendingHold(engine);
  if (rec === null || plan.record === null || rec.operationId !== plan.record.operationId || rec.recordedAt !== plan.record.recordedAt) return out;
  if (deferredHoldOpenFor(engine, rec.operationId)) return out;
  if (pendingHoldStale(rec, fresh)) {
    kv.delete(PENDING_HOLD_KEY);
    appendSourceStep(engine, rec.operationId, staleText(rec));
    out.touchedOps.push(rec.operationId);
    engine.log('info', 'route.pending_hold_stale', { operationId: rec.operationId });
    return out;
  }
  if (!plan.confirmed || selection === undefined || TRANSITION_PHASES.includes(fresh.phase)) return out;
  if (rec.kind === 'intent' && selection === 'REJECT' && plan.credit) {
    const intent = rec.intent;
    const warnings = fresh.warnings.filter((w) => !(w === 'external_selection_change' && intent && !intent.externalSelectionBefore));
    repos.routeState.update({
      selectedNode: 'REJECT',
      warnings: warnings as RouteWarning[],
      ...(fresh.phase === 'active_verified' ? { phase: 'attention' as const } : {}),
    });
    if (rec.cause === 'node_resource_forged') kv.delete('resource:forgedHold');
    kv.delete(PENDING_HOLD_KEY);
    appendSourceStep(
      engine,
      rec.operationId,
      changedDuringWrite(rec)
        ? 'Surge 回到固定工作配置之后读回 SFE-ROUTE 为 REJECT，与本操作改选期间配置变了的那次改选意图一致：按本应用的改选记下，不当作外部修改'
        : 'Surge 回到固定工作配置之后读回 SFE-ROUTE 为 REJECT，与中断之前本操作记下的改选意图一致：按本应用的改选记下，不当作外部修改',
    );
    out.credited = rec.operationId;
    out.routeChanged = true;
    out.touchedOps.push(rec.operationId);
    out.notes.push(
      changedDuringWrite(rec)
        ? '改选期间配置变了的 REJECT 改选在固定工作配置上读回确认，按本应用的改选记下'
        : '中断之前操作的 REJECT 改选在固定工作配置上读回确认，按本应用的改选记下',
    );
    return out;
  }
  if (selection === 'REJECT') {
    kv.delete(PENDING_HOLD_KEY);
    appendSourceStep(engine, rec.operationId, 'Surge 回到固定工作配置之后读回 SFE-ROUTE 已是 REJECT：不需要再改选（不是本操作改选的，与记录不一致由对账按外部修改报告）');
    out.touchedOps.push(rec.operationId);
    return out;
  }
  const notApplied =
    rec.kind === 'intent'
      ? changedDuringWrite(rec)
        ? 'Surge 回到固定工作配置之后读回 SFE-ROUTE 不是 REJECT：本操作改选期间配置变了的那次改选没有落在固定工作配置上'
        : 'Surge 回到固定工作配置之后读回 SFE-ROUTE 不是 REJECT：中断之前本操作的改选没有生效'
      : null;
  const mayUse = entryMayUseRoute(fresh) || (rec.cause === 'node_resource_forged' && routeNotConfirmedNormal(fresh));
  if (mayUse && selection !== verifiedExitNode(engine, fresh)) {
    let next = rec;
    if (rec.kind === 'intent') {
      // 意图已解决为没有生效：改记为 skipped（之后读到的 REJECT——服务排入的改选或用户的改选——不再按本操作的意图记下）
      next = { ...rec, kind: 'skipped' };
      delete next.intent;
      kv.set(PENDING_HOLD_KEY, next);
      appendSourceStep(engine, rec.operationId, `${notApplied}；路由仍需要改选 REJECT`);
      out.touchedOps.push(rec.operationId);
    }
    out.enqueue = next;
    return out;
  }
  kv.delete(PENDING_HOLD_KEY);
  appendSourceStep(
    engine,
    rec.operationId,
    `${notApplied !== null ? `${notApplied}；` : 'Surge 回到固定工作配置：'}入口已不让 Safari 经 SFE-ROUTE，或 SFE-ROUTE 选着使用中环境已验证的出口：不需要再改选`,
  );
  out.touchedOps.push(rec.operationId);
  return out;
}

/**
 * 排入一次推迟的 REJECT 保持（route.hold，payload.endHoldDeferred，发起方 service）：已有排队或执行中的 route.hold 时不另排（它
 * 同样改选 REJECT；记录保留，之后的对账再判断）。从不写 Surge。在同一事务中在来源操作中写明实际发生的事（第一次）：排入了改选，
 * 或已有排队或执行中的 REJECT 保持、由它改选。返回排入的操作 id；不需要或已有时为 null。
 */
export function maybeEnqueueDeferredHold(engine: Engine, rec: PendingHold): string | null {
  const { repos, kv } = engine;
  let touched = false;
  const id = repos.tx(() => {
    // 记录在事务之前可能已被改写或删除（另一个对账、刚结束的改选）：只为仍是同一条的记录排入
    const cur = readPendingHold(engine);
    if (cur === null || cur.operationId !== rec.operationId || cur.recordedAt !== rec.recordedAt) return null;
    const open = repos.operations.listByStatus(['queued', 'running'], { kinds: ['route.hold'] });
    if (open.length > 0) {
      if (cur.otherHoldNoted !== true && !open.some((o) => payloadOf(o).endHoldDeferred?.sourceOperationId === cur.operationId)) {
        kv.set(PENDING_HOLD_KEY, { ...cur, otherHoldNoted: true } satisfies PendingHold);
        appendSourceStep(engine, cur.operationId, 'Surge 回到固定工作配置：已有排队或执行中的 SFE-ROUTE REJECT 保持，由它改选（没有另排改选；之后的对账再核对）');
        touched = true;
      }
      return null;
    }
    const inserted = repos.operations.insert({
      id: engine.ids.next('op'),
      requestId: `deferred-hold:${engine.ids.token(16)}`,
      requestDigest: 'service',
      kind: 'route.hold',
      initiatorKind: 'service',
      phase: 'SAVED',
      status: 'queued',
      payload: { endHoldDeferred: { sourceOperationId: rec.operationId, ...(rec.cause ? { cause: rec.cause } : {}) } },
    });
    repos.operations.appendStep(
      inserted.id,
      'SAVED',
      `Surge 回到固定工作配置：之前的路由操作没有在固定工作配置上确认改选 REJECT（${HOLD_BLOCK_TEXT[rec.block]}），排入一次改选（失败即关闭；有排队的普通模式时它先执行）`,
    );
    repos.outbox.enqueue(inserted.id, null, engine.now());
    if (cur.notified !== true) {
      kv.set(PENDING_HOLD_KEY, { ...cur, notified: true } satisfies PendingHold);
      appendSourceStep(engine, cur.operationId, 'Surge 回到固定工作配置：服务排入一次 SFE-ROUTE 改选 REJECT（失败即关闭；有排队的普通模式时它先执行）');
      touched = true;
    }
    return inserted.id;
  });
  if (id === null) {
    if (touched) engine.emit({ operations: [rec.operationId] });
    return null;
  }
  engine.log('info', 'route.deferred_hold_enqueued', { sourceOperationId: rec.operationId });
  engine.emit({ operations: touched ? [id, rec.operationId] : [id] });
  engine.kick();
  return id;
}
