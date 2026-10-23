// 路由操作（docs/ARCHITECTURE.md §6.3–§6.5）：激活（受控切换）、Safari 重测、普通模式、活动环境改代理后的
// WAITING_ROUTE，以及等待、核对、回滚。所有 Surge 写入在执行器内发生：入口经配置的 EntryController 逐位切换
// 并读回，结束 Safari 连接只按已确认的进程路径。失败、超时、取消一律回滚到切换前的已验证节点并保持阻断，
// 从不回退到 NORMAL、DIRECT 或其他买家出口；回滚无法确认 → BLOCKED_NEEDS_ATTENTION（回到阻断未经运行时求值确认时不恢复
// 切换前节点，SFE-ROUTE 改选 REJECT，见 holdUnconfirmedRollback）。路由操作结束时 Surge 仍可能加载着检测或使用中入口、
// 而 SFE-ROUTE 的选择不是使用中环境已验证的出口（回滚、普通模式失败或撤销未经运行时确认、处理器意外异常，以及其余每条结束
// 路径——例如对账已把路由改为 attention 之后在写入之前失败的激活，见 holdAtRouteEnd）：一律尽力改选 REJECT 并读回，如实写明
// 是否确认（selectRejectBestEffort）。

import {
  CAPABILITY_GATES,
  ROUTE_GROUP_NAME,
  SfeError,
  buildVerifyUrl,
  type ActivationSnapshot,
  type ApiErrorBody,
  type CapabilityKey,
  type EntryMode,
  type KillResult,
  type RollbackResult,
  type RouteWarning,
} from '@sfe/contract';
import { isIP } from 'node:net';
import type { OperationRecord, RouteStateRecord } from '../../db/index.js';
import { PUBLISH_KINDS, newRoutePayload, payloadOf, type EndHoldIntent, type ProbeVerdict, type RouteEnding, type RoutePayload, type SafariProbeEvidence } from '../../domain/operations.js';
import { LOSS_OF_CONTROL_WARNINGS, REUSE_BLOCKING_WARNINGS, hasAny, safariProbeCurrent } from '../../domain/route-rules.js';
import { labelOf } from '../../domain/naming.js';
import { probeView } from '../../domain/views.js';
import type { EntryController, EntryReadback, EntryTransitionOptions } from '../../ports.js';
import { findVerificationRequest } from '../../surge/correlate.js';
import { knownModeOfBits } from '../../surge/entry/plan.js';
import { hasBlockingIssue } from '../../surge/precedence.js';
import { killSafariConnections } from '../../surge/safari-connections.js';
import type { EmitSpec, Engine } from '../context.js';
import { managedSegmentsChanged, reconcile } from '../reconcile.js';
import { confirmationNeeded, entrySettingsKey, needsConfirmationError, routeOps, supersedeWaiting, waitingEnvironments } from '../route-control.js';
import { clearSafariMayUseRoute, markSafariMayUseRoute, retiredSafariPaths, safariMayUseRoute } from '../safari-route-marker.js';
import { currentPreflight, recordPreflight } from './probes.js';

// ---------- 小工具 ----------

/**
 * 撤销本应用入口（普通模式、回滚）的入口切换选项：只有这些方向可以改写被外部修改的本应用入口文件、逐条清理无法按位确定的
 * 本应用临时规则（§5.5）。清理的每一步（运行时读回确认之后）写入一条操作步骤，并累积到操作结果 entryCleanup（脱敏），
 * 之后失败也保留。
 */
function undoOptions(engine: Engine, opId: string): EntryTransitionOptions {
  return {
    undo: true,
    onCleanup: (c) => {
      const { repos } = engine;
      const safe = engine.scrubber.scrubDeep({ ...c });
      repos.tx(() => {
        const cur = repos.operations.get(opId)!;
        const prev = cur.result?.entryCleanup;
        repos.operations.update(opId, { result: { ...(cur.result ?? {}), entryCleanup: [...(Array.isArray(prev) ? prev : []), safe] } });
      });
      const kind = c.kind === 'unrecognized' ? '无法识别的规则' : c.kind;
      engine.step(opId, `撤销入口时逐条清理本应用的临时规则：${c.action === 'add' ? '加入' : '移除'} ${kind}「${c.rule}」（运行时读回确认）`);
    },
  };
}

/** 撤销入口时 rule match 读不到或不可用（EntryReadback.runtimeConfirmed 为 false）的步骤说明。 */
const UNCONFIRMED_ENTRY_TEXT = 'rule match 读不到或当前 Surge 不支持，入口按结构读回或写入并等待完成，未经运行时求值确认';

/**
 * 入口写入未经运行时求值确认时，按入口策略写明还剩什么不确定（§5.5）：ruleset_resource 的退路只是写入文件并等满文件监视上限，
 * 监视比上限慢时 Surge 仍加载着写入之前的入口（before 写明那意味着什么）；temp_rule 没有加载延迟，每一步已按 Surge 的临时规则
 * 列表与有效规则顺序读回，只是 Surge 实际如何匹配 Safari 请求没有经 rule match 求值确认。
 */
function unconfirmedLoadText(strategy: EntryController['strategy'], before: string): string {
  return strategy === 'temp_rule'
    ? '临时规则已按 Surge 的临时规则列表与有效规则顺序读回，但 Surge 实际如何匹配 Safari 请求未经 rule match 求值确认'
    : `Surge 可能仍加载着写入之前的入口（${before}）`;
}

function routePayload(op: OperationRecord): RoutePayload {
  const r = payloadOf(op).route;
  if (!r) throw new SfeError('INTERNAL', '路由操作缺少参数');
  return r;
}

function savePayload(engine: Engine, opId: string, patch: Partial<RoutePayload>): RoutePayload {
  const op = engine.repos.operations.get(opId)!;
  const next = { ...routePayload(op), ...patch };
  engine.repos.operations.update(opId, { payload: { ...payloadOf(op), route: next } });
  return next;
}

function addSeconds(engine: Engine, sec: number): string {
  return new Date(engine.now().getTime() + sec * 1000).toISOString();
}

/** 入口错误中的“最后确认状态”。 */
function confirmedModeFrom(err: unknown, fallback: EntryMode): EntryMode {
  if (err instanceof SfeError && err.details && 'lastConfirmedBits' in err.details) {
    const bits = err.details.lastConfirmedBits as Parameters<typeof knownModeOfBits>[0] | null;
    if (bits === null) return 'UNKNOWN';
    return knownModeOfBits(bits) ?? 'UNKNOWN';
  }
  return fallback;
}

/**
 * 入口错误中最后经运行时求值确认的状态：错误带 runtimeConfirmed: false（rule match 不可用的退路：ruleset_resource 退路中因有
 * 规则排在入口之前而报告的 PRECEDENCE_VIOLATION 把位记为目标模式，但只是按计划写入并等满文件监视上限）时，记下的位未经运行时
 * 求值，监视比上限慢时 Surge 仍加载着写入之前的入口——按 UNKNOWN，不当作已阻断。
 */
function runtimeConfirmedModeFrom(err: unknown, fallback: EntryMode): EntryMode {
  if (err instanceof SfeError && err.details?.runtimeConfirmed === false) return 'UNKNOWN';
  return confirmedModeFrom(err, fallback);
}

/**
 * 入口切换只因有规则排在本应用入口之前而不能确认（PRECEDENCE_VIOLATION）时随错误返回的这些规则；其他错误为 null。入口位可能
 * 已读回为目标模式，但被这些规则匹配的 Safari 请求按它们发出，不能声称已阻断。
 */
function precedenceIssuesOf(err: unknown): EntryReadback['precedenceIssues'] | null {
  if (!(err instanceof SfeError) || err.code !== 'PRECEDENCE_VIOLATION') return null;
  return Array.isArray(err.details?.precedenceIssues) ? (err.details.precedenceIssues as EntryReadback['precedenceIssues']) : [];
}

/** SFE-ROUTE 改选 REJECT（失败即关闭）的结果：confirmed 只在读回就是 REJECT 时为 true。 */
interface RejectHold {
  confirmed: boolean;
  /** 读回的选择（读不到为 null）。 */
  readback: string | null;
  /** 改选或读回失败的原因（脱敏）；确认时为 null。 */
  error: string | null;
  /**
   * 崩溃恢复中重新结束的结束点读回 REJECT，而本操作在服务崩溃之前已记下改选的意图（OperationPayload.endHold）：改选是本操作做的，
   * 按改选（读回确认）记下（recordEndHold、heldEnd），不当作之前已是 REJECT。
   */
  recovered?: EndHoldIntent;
}

/**
 * 失败即关闭：SFE-ROUTE 尽力改选首成员 REJECT 并读回。SFE-ROUTE 只被本应用的 Safari 入口引用（Chrome 与其他应用不命中），
 * 改选后不论 Surge 加载的是哪一版本应用入口，经 SFE-ROUTE 的 Safari 新连接都被拒绝，从不回退到 DIRECT、NORMAL 或其他买家出口。
 * 选择组只在建立连接时生效：已建立的连接（keep-alive、H2、WebSocket）不受改选影响，仍在原来的出口上——调用方记下
 * buyer_exit_connections_unconfirmed（holdExistingConnections），由普通模式结束它们。
 * 从不抛出：改选或读回失败只如实返回，由调用方写明（不记为 REJECT）。
 */
async function selectRejectBestEffort(engine: Engine): Promise<RejectHold> {
  try {
    await engine.surge.selectGroupPolicy(ROUTE_GROUP_NAME, 'REJECT');
  } catch (err) {
    return { confirmed: false, readback: null, error: holdErrorText(engine, err, '改选失败') };
  }
  try {
    const sel = await engine.surge.getGroupSelection(ROUTE_GROUP_NAME);
    return sel === 'REJECT' ? { confirmed: true, readback: sel, error: null } : { confirmed: false, readback: sel, error: '改选后读回不一致' };
  } catch (err) {
    return { confirmed: false, readback: null, error: holdErrorText(engine, err, '改选后读回失败') };
  }
}

function holdErrorText(engine: Engine, err: unknown, fallback: string): string {
  try {
    return engine.errorBody(err, fallback).message;
  } catch {
    return fallback;
  }
}

/** 改选 REJECT 的说明（如实写明是否读回确认；改选只影响新连接）。 */
function rejectHoldText(hold: RejectHold): string {
  return hold.confirmed
    ? 'SFE-ROUTE 已改选 REJECT（读回确认）：Surge 即使仍加载着检测或使用中入口，经 SFE-ROUTE 的 Safari 新连接也都被拒绝，不会经任何买家出口建立'
    : `SFE-ROUTE 未能改选 REJECT（${hold.error ?? '原因未知'}）：Surge 若仍加载着检测或使用中入口，Safari 请求（至少检测主机）可能仍经 SFE-ROUTE 当前选择的买家出口发出，请立即进入普通模式`;
}

/** 改选 REJECT 不影响已建立的连接：与 holdExistingConnections 记下的警告一起写明。 */
const EXISTING_CONNECTIONS_TEXT = '已建立的 Safari 连接不受改选影响，可能仍在买家出口上（路由状态带“未能确认 Safari 已没有经买家出口的连接”警告），进入普通模式会结束它们';

/**
 * 回滚无法确认、处理器中断时尽力改选 REJECT 之后：Safari 已经经 SFE-ROUTE 建立的连接（检测主机的 keep-alive、ACTIVE 期间的
 * 站点长连接）不受改选影响、这些路径也不结束连接——在同一事务中补上持久标记并带 buyer_exit_connections_unconfirmed，由之后的
 * 普通模式结束（之后的激活第 7 步在已确认的阻断下结束全部 Safari 连接时同样清除，§6.3）。
 */
function holdExistingConnections(engine: Engine, opId: string, warnings: Set<RouteWarning>): void {
  markSafariMayUseRoute(engine, opId, engine.entryConfig().processPaths);
  warnings.add('buyer_exit_connections_unconfirmed');
}

/**
 * 本次切换已开始把入口写入使用中模式（RoutePayload.activeWriteStarted）之后回滚或中断（写入或读回失败、提交失败、写入期间服务
 * 崩溃、处理器意外异常）：Safari 的全部请求（含目标环境场景中已打开的窗口）可能已经过目标环境的出口——与让给排队普通模式的
 * 切换相同（yieldToQueuedNormal），而任何旧窗口确认都没有覆盖它的窗口：之后的普通模式只按那时路由记录的使用中环境确认。
 * 目标不是结束后路由记录的使用中环境（activeAfter）时返回它（label 是带引号的环境名，环境不存在时为空），调用方在结束事务中带
 * managed_windows_on_original_rules（之后的普通模式完成时保留并写明，用户确认旧窗口已关闭或之后的激活提交时清除）并按
 * activeWrittenNote 写明；否则为 null。
 */
function activeWrittenUncovered(engine: Engine, opId: string, activeAfter: string | null): { environmentId: string; label: string } | null {
  const op = engine.repos.operations.get(opId);
  const p = op ? payloadOf(op).route : undefined;
  if (!p?.activeWriteStarted || p.targetEnvironmentId === activeAfter) return null;
  const env = engine.repos.environments.get(p.targetEnvironmentId);
  return { environmentId: p.targetEnvironmentId, label: env ? `「${labelOf(env)}」` : '' };
}

function activeWrittenNote(t: { label: string }): string {
  return `切换目标环境${t.label}的入口已开始写入使用中模式，其窗口可能已经过它的出口、未经确认：路由带旧窗口警告，之后进入普通模式时其后续请求按 Surge 原规则发出（可能直连）`;
}

/**
 * 普通模式完成时改选 REJECT 的说明（收紧未经运行时求值确认；改选只影响新连接）。按入口策略写明还剩什么不确定
 * （unconfirmedLoadText）：ruleset_resource 是 Surge 加载撤销之前仍可能加载着检测或使用中入口；temp_rule 没有加载阶段，临时规则
 * 已按列表与有效规则顺序读回，只是 Surge 实际如何匹配 Safari 请求没有经 rule match 确认。
 */
function normalHoldText(hold: RejectHold, strategy: EntryController['strategy'] | undefined): string {
  if (strategy === 'temp_rule') {
    const cond = '临时规则已按 Surge 的临时规则列表与有效规则顺序读回，但 Surge 实际如何匹配 Safari 请求未经 rule match 求值确认';
    return hold.confirmed
      ? `SFE-ROUTE 已改选 REJECT（读回确认）：${cond}；即使仍有 Safari 请求经 SFE-ROUTE，新连接也都被拒绝，不会经任何买家出口建立`
      : `SFE-ROUTE 未能改选 REJECT（${hold.error ?? '原因未知'}）：${cond}；若仍有 Safari 请求经 SFE-ROUTE，可能经它当前选择的买家出口发出，再次进入普通模式会再改选`;
  }
  return hold.confirmed
    ? 'SFE-ROUTE 已改选 REJECT（读回确认）：Surge 加载撤销之前若仍加载着检测或使用中入口，经 SFE-ROUTE 的 Safari 新连接也都被拒绝，不会经任何买家出口建立'
    : `SFE-ROUTE 未能改选 REJECT（${hold.error ?? '原因未知'}）：Surge 加载撤销之前若仍加载着检测或使用中入口，Safari 请求（至少检测主机）可能仍经 SFE-ROUTE 当前选择的买家出口发出，再次进入普通模式会再改选`;
}

/**
 * SFE-ROUTE 当前的选择是否就是使用中环境已验证的出口：没有进行中或中断的切换（激活快照仍在时选择可能是半途切换写入的未验证
 * 节点，见 routeSnapshot），有使用中的环境，路由记录的选择等于其活动版本的节点且没有 external_selection_change，并且实际读回
 * 也等于它——选择可能在记录之外被改过（用户在 Surge 中改选别的买家节点、发布回滚无法确认选择），对账只加警告、不改记录，
 * 只看记录会把别的买家出口当作已验证的路由留给 Safari。读不到按不是。从不抛出。
 */
async function selectionIsVerifiedExit(engine: Engine, route: RouteStateRecord): Promise<boolean> {
  const node = verifiedExitNode(engine, route);
  if (node === null) return false;
  try {
    return (await engine.surge.getGroupSelection(ROUTE_GROUP_NAME)) === node;
  } catch {
    return false;
  }
}

/** 按路由记录，使用中环境已验证的出口节点（selectionIsVerifiedExit 的记录部分）；记录不能证明时为 null。 */
function verifiedExitNode(engine: Engine, route: RouteStateRecord): string | null {
  if (route.activationSnapshot !== null || route.activeEnvironmentId === null || route.activeProxyRevision === null) return null;
  if (route.warnings.includes('external_selection_change')) return null;
  const rev = engine.repos.proxyRevisions.get(route.activeEnvironmentId, route.activeProxyRevision);
  return rev && route.selectedNode === rev.nodeName ? rev.nodeName : null;
}

/**
 * 按路由记录，Surge 加载的本应用入口是否可能仍让 Safari 经 SFE-ROUTE：入口不是经运行时求值确认的阻断或普通模式（VERIFY_ONLY、
 * ACTIVE、UNKNOWN），或带 entry_unverified（读回未经运行时求值确认、退路写入、对账发现与记录不一致或能力过期），或阻断带
 * precedence_violation（排在入口之前的规则可能把 Safari 请求交给 SFE-ROUTE）。普通模式只看 entry_unverified：本应用入口已撤下时，
 * 排在它之前的规则与本应用入口无关。
 */
function entryMayUseRoute(route: RouteStateRecord): boolean {
  if (route.warnings.includes('entry_unverified')) return true;
  if (route.entryMode === 'NORMAL') return false;
  if (route.entryMode === 'BLOCKED') return route.warnings.includes('precedence_violation');
  return true;
}

/** holdAtRouteEnd 的输入：结束的操作自己在本次结束之前读到的情况。 */
interface EndHoldOptions {
  /**
   * 结束的操作刚刚自己读到的 SFE-ROUTE 选择（重测核对读到的选择、开始等待时读到的与记录不一致的选择；没有读到时不传）。结束点
   * 重读失败而它不是使用中环境已验证的出口时，它是选择已变的正面证据：照样改选 REJECT，不按「读取失败不说明选择变了」放过。
   */
  observedSelection?: string | null;
}

/**
 * 路由操作的结束点（失败即关闭，所有结束路径共用；在把操作记为结束之前调用）。路由操作结束之后不再有操作负责撤下当前入口，
 * 对账只读、从不写 Surge（§6.6）：结束时 Surge 加载的入口可能仍让 Safari 经 SFE-ROUTE（entryMayUseRoute），而 SFE-ROUTE 的选择
 * 不是使用中环境已验证的出口（例如半途切换写入的未验证节点、之前一次改选 REJECT 失败、选择在记录之外被改过）时，Safari（至少
 * 检测主机）会在没有任何实测进行中的情况下经它发出。与回滚无法确认同一规则：尽力改选 REJECT 并读回（selectRejectBestEffort），
 * 调用方用 recordEndHold 记下、用 endHoldNote/withEndHold 如实写明。
 * 典型来源是不由结束的操作写入、而由对账发现的状态：启动对账或周期对账把等待实测的路由改为 attention（例如有规则排在入口之前，
 * 入口改记为 UNKNOWN）之后，接手它的激活在第一次写入之前失败——它不负责非过渡中的路由（ownsTransition），不回滚。
 * 不改选（返回 null）：入口记录为经运行时求值确认的阻断或普通模式；选择读回已是 REJECT，或就是使用中环境已验证的出口（记录
 * 表明选着已验证的出口而选择读不到时同样不改选：结束的操作没有改选过 SFE-ROUTE，读取失败不说明选择变了——结束的操作自己
 * 刚读到选择已不是这个出口（EndHoldOptions.observedSelection：重测核对或开始等待时读到的不一致的选择）时除外，这是选择已变的
 * 正面证据，照样改选）；有排队或执行中的普通模式（执行器优先领取它，它接着从当前状态撤销入口，激活让给它时从不写入 Surge）；
 * 路由记在另一个未结束的操作名下（不论路由阶段——对账把等待实测的路由改为 attention 时不改负责的操作；由它结算）。读路由或
 * 操作出错时照样改选（失败即关闭）。从不抛出。
 * 回滚（rollbackActivation、holdUnconfirmedRollback）、普通模式（runNormal）与执行器兜底中负责过渡中路由的一支
 * （settleAbandonedTransition）按各自读回的入口另行改选，不经这里（它们在崩溃恢复中重新读回入口、重新改选，不看之前的选择）。
 * 改选之前在操作中记下意图（OperationPayload.endHold，markEndHoldIntent）：改选之后、记下改选之前服务崩溃时，崩溃恢复重新结束的
 * 结束点（recoverRoute：按 ending 重新结束、重测按已判定的失败重新结束、被取代的切换、执行器兜底）读回 REJECT——有这一记录就是
 * 本操作改选的，按改选（读回确认，RejectHold.recovered）记下并结束为需要处理，不按「之前已是 REJECT、路由未改变」结束。这一判断
 * 排在排队普通模式与另一负责者两项之前：本操作改选期间受理的普通模式（受理从不拒绝，排在本操作之后）在崩溃之后仍排着，
 * 否则恢复的结束会把本操作自己的改选当作「路由未改变」。
 */
async function holdAtRouteEnd(engine: Engine, opId: string, opts: EndHoldOptions = {}): Promise<RejectHold | null> {
  const { repos } = engine;
  let externalSelectionBefore = false;
  const readSelection = async (): Promise<string | null | undefined> => {
    try {
      return await engine.surge.getGroupSelection(ROUTE_GROUP_NAME);
    } catch {
      return undefined;
    }
  };
  try {
    const route = repos.routeState.get();
    if (!entryMayUseRoute(route)) return null;
    // 本操作在服务崩溃之前已记下改选的意图：先读回——读回的 REJECT 就是它的改选（崩溃发生在改选之后、记下之前），按改选记下，
    // 不论之后是否有排队的普通模式或另一个负责者（它们在本操作改选期间受理，交给它们就会把本操作的结束记为「路由未改变」）
    const self = repos.operations.get(opId);
    const intent = self ? payloadOf(self).endHold : undefined;
    let sel: string | null | undefined;
    let selRead = false;
    if (intent) {
      sel = await readSelection();
      selRead = true;
      if (sel === 'REJECT') return { confirmed: true, readback: 'REJECT', error: null, recovered: intent };
    }
    const others = repos.operations.listByStatus(['queued', 'running', 'waiting']).filter((o) => o.id !== opId);
    if (others.some((o) => o.kind === 'route.normal' && (o.status === 'queued' || o.status === 'running'))) return null;
    // 路由记在另一个未结束的操作名下（不论阶段）：它会自己结算路由——等待中的激活经它的计时器、取消或核对（对账把等待实测的
    // 路由改为 attention 之后它照样负责，例如 Surge 短暂不可达之后它仍可能核对通过），排队或执行中的接手者经 failBeforeSwitch
    // 或切换。在这里改选会让一个无关操作的结束抢走仍在进行中的激活的路由（两个负责者），之后它的核对因选择已不是目标节点失败
    if (route.operationId !== null && others.some((o) => o.id === route.operationId)) return null;
    if (!selRead) sel = await readSelection();
    if (sel === 'REJECT') return null;
    const verified = verifiedExitNode(engine, route);
    if (verified !== null && sel === verified) return null;
    // 读不到选择、而记录表明选着使用中环境已验证的出口：结束的操作没有改选过 SFE-ROUTE，读取失败不能说明选择变了——不改选
    // （否则一次短暂的读取失败就会让已验证的路由降为需要处理）；Surge 不可达由对账记下。结束的操作自己刚读到选择已不是这个
    // 出口时除外（observedSelection）：那是选择已变的正面证据，一次读取失败不能把它变成「路由未改变」，照样改选
    if (verified !== null && sel === undefined && (opts.observedSelection === undefined || opts.observedSelection === verified)) return null;
    externalSelectionBefore = route.warnings.includes('external_selection_change');
  } catch (err) {
    engine.log('warn', 'route.end_hold_check_failed', { operationId: opId, error: err instanceof Error ? err.name : 'unknown' });
  }
  markEndHoldIntent(engine, opId, { externalSelectionBefore });
  return selectRejectBestEffort(engine);
}

/** holdAtRouteEnd 改选 REJECT 之前在操作中记下意图（OperationPayload.endHold）。写入失败只记日志：照样改选（失败即关闭）。 */
function markEndHoldIntent(engine: Engine, opId: string, intent: EndHoldIntent): void {
  const { repos } = engine;
  try {
    repos.tx(() => {
      const cur = repos.operations.get(opId);
      if (!cur) return;
      const prev = payloadOf(cur).endHold;
      // 已记下（例如崩溃恢复中再次改选）：保留最早的一次——它记下的是本操作第一次改选之前的路由警告
      if (prev) return;
      repos.operations.update(opId, { payload: { ...payloadOf(cur), endHold: intent } });
    });
  } catch (err) {
    engine.log('warn', 'route.end_hold_intent_failed', { operationId: opId, error: err instanceof Error ? err.name : 'unknown' });
  }
}

/**
 * 在调用方的事务中记下结束点的改选（holdAtRouteEnd 返回 null 时什么也不做）：与回滚无法确认相同——带 entry_unverified，已建立的
 * 连接不受改选影响（holdExistingConnections：持久标记与 buyer_exit_connections_unconfirmed），之前一次成功回滚留下的
 * rollback_needs_reverify 不再成立；只有读回确认才记为 REJECT。路由需要处理（attention）；空闲的普通模式（普通模式完成而撤销未经
 * 运行时求值确认）保持 idle，由警告与持久标记提供普通模式。
 * 崩溃恢复中记下的改选（RejectHold.recovered）：启动对账在恢复之前读到本操作的 REJECT、把它当作外部修改记下
 * external_selection_change——改选之前路由没有这一警告时去掉它（改选是本应用做的，路由仍因改选需要处理）。
 */
function recordEndHold(engine: Engine, opId: string, hold: RejectHold | null): void {
  if (!hold) return;
  const { repos } = engine;
  const fresh = repos.routeState.get();
  const warnings = new Set<RouteWarning>(
    fresh.warnings.filter((w) => w !== 'rollback_needs_reverify' && !(w === 'external_selection_change' && hold.recovered && !hold.recovered.externalSelectionBefore)),
  );
  warnings.add('entry_unverified');
  holdExistingConnections(engine, opId, warnings);
  repos.routeState.update({
    ...(fresh.phase === 'idle' ? {} : { phase: 'attention' as const, awaitingDeadline: null }),
    operationId: opId,
    ...(hold.confirmed ? { selectedNode: 'REJECT' } : {}),
    warnings: [...warnings],
  });
}

/**
 * 结束点改选的说明，附在结束说明之后（没有改选时为空）。路由因此需要处理：路由记录带 entry_unverified，自动打开订单与填充停止，
 * 需要进入普通模式或重新使用环境。
 */
function endHoldNote(hold: RejectHold | null): string {
  if (!hold) return '';
  return `；结束时路由仍未回到已确认的状态（入口可能仍让 Safari 经 SFE-ROUTE，而 SFE-ROUTE 选着的不是使用中环境已验证的出口），失败即关闭：${rejectHoldText(hold)}；${EXISTING_CONNECTIONS_TEXT}；路由需要处理（自动打开订单与填充已停止）：进入普通模式，或重新使用环境`;
}

/**
 * 结束点改选了 SFE-ROUTE（holdAtRouteEnd 返回非 null）时，结束说明不能再说「路由未改变」：去掉这一说法（结束说明的其余部分
 * 照旧，改选的说明由 endHoldNote 附上）。
 */
function withoutUnchangedClaim(text: string): string {
  return text.replace(/[，：；]路由未改变/g, '');
}

/** 错误说明附上结束点的改选（details.rejectSelected），并去掉「路由未改变」的说法。 */
function withEndHold(body: ApiErrorBody, hold: RejectHold | null): ApiErrorBody {
  if (!hold) return body;
  return { ...body, message: `${withoutUnchangedClaim(body.message)}${endHoldNote(hold)}`, details: { ...(body.details ?? {}), rejectSelected: hold.confirmed } };
}

type EndPatch = Parameters<Engine['updateOp']>[1];

/**
 * 重新检测要求路由是使用中且已验证的（§6.4：入口读回为 ACTIVE、路由阶段 active_verified）。等待期间对账发现失控（Surge 重启、
 * 出站模式改变、选择被外部修改等）时路由改为 attention 或 external_change——只有之后的激活提交 ACTIVE 才会设回已验证，而新的
 * 激活会取代这次重测：这次重测再也无法签发检测编号。
 */
export function retestRouteLost(route: Pick<RouteStateRecord, 'entryMode' | 'phase'>): boolean {
  return route.entryMode !== 'ACTIVE' || route.phase !== 'active_verified';
}

/** 重测等待期间使路由不再已验证的警告（写入说明用；按路由记录）。 */
const RETEST_LOST_TEXT: Partial<Record<RouteWarning, string>> = {
  surge_unreachable: '无法连接 Surge',
  surge_restarted: 'Surge 已重启',
  entry_unverified: '入口规则未能读回确认',
  takeover_lost: 'Surge 接管已关闭',
  outbound_mode_changed: 'Surge 出站模式不是规则模式',
  external_selection_change: 'SFE-ROUTE 的选择在 Surge 中被外部修改',
  external_profile_change: 'Surge 当前配置不是固定工作配置',
  precedence_violation: '有规则排在本应用入口之前',
  managed_segments_changed: '受管理段或本应用文件被外部修改',
};

/**
 * 已开始等待检测（stage probe_waiting：开始等待时路由是使用中且已验证的）的重新检测结束时，路由已不在已验证的使用中状态：
 * 返回路由记录的警告（结果 routeLeftVerified；准备页据此不说「路由与之前的检测结果都未改变」），否则为 null。结束点改选了
 * SFE-ROUTE（hold）时由改选的说明负责，这里为 null。
 */
function retestRouteLeftVerified(engine: Engine, rp: RoutePayload | undefined, hold: RejectHold | null): RouteWarning[] | null {
  if (hold || rp?.flow !== 'probe' || rp.stage !== 'probe_waiting') return null;
  const route = engine.repos.routeState.get();
  return retestRouteLost(route) ? [...route.warnings] : null;
}

/** 重测等待期间路由已不在已验证的使用中状态的说明（附在结束说明之后，并去掉「路由未改变」：路由确实变了，只是不是这次重测改的）。 */
function retestLostNote(warnings: readonly RouteWarning[]): string {
  const causes = warnings.map((w) => RETEST_LOST_TEXT[w]).filter((t): t is string => t !== undefined);
  return `；这次重新检测等待期间路由已不在已验证的使用中状态${causes.length > 0 ? `（${causes.join('、')}）` : ''}，不是这次重新检测改变的：自动打开订单与填充已停止，需要重新使用此环境或进入普通模式`;
}

/**
 * 结束点改选了 SFE-ROUTE 时的结束状态：不论原本要结束成什么（失败、取消，或 WAITING_ROUTE 的 READY_FOR_NEXT_OPEN 成功），一律
 * BLOCKED_NEEDS_ATTENTION / needs_attention——路由已改变（改选 REJECT 或改选失败），Safari 经本应用出口的新连接被拒绝、订单与
 * 填充停止，不能显示为成功或「路由未改变」。错误保留原来的代码（没有错误时 UNKNOWN_STATE），说明写明原本的结束与改选。
 */
function heldEnd(patch: EndPatch, step: string, hold: RejectHold): { patch: EndPatch; step: string } {
  const text = `${withoutUnchangedClaim(step)}${endHoldNote(hold)}`;
  const error: ApiErrorBody = patch.error ? withEndHold(patch.error, hold) : { code: 'UNKNOWN_STATE', message: text, details: { rejectSelected: hold.confirmed } };
  return { patch: { ...patch, phase: 'BLOCKED_NEEDS_ATTENTION', status: 'needs_attention', error }, step: text };
}

/**
 * 不负责过渡中路由的路由操作结束（engine.updateOp 的结束版本）：结束之前按 holdAtRouteEnd 失败即关闭，记下改选，再记下结束状态
 * （改选了就按 heldEnd 改为需要处理，结果带 rejectSelected）。cancelOutbox：同时取消本操作的计时器；observedSelection：本操作
 * 结束之前自己读到的 SFE-ROUTE 选择（见 EndHoldOptions）。
 * 等待中的操作（超时、取消、目标版本已被替换）在第一次读写 Surge 之前同步改为 running，并在 payload 中记下要结束成什么
 * （RoutePayload.ending）：结束点的 Surge 调用期间它不再是等待中——原生桥不再签发检测编号或记到达（beginVerification 按正在结束
 * 回答）、提交被拒绝、取消返回 ROUTE_BUSY、新的普通模式排在它之后、新的激活返回 ROUTE_BUSY、保存新版本不再结束它；否则它们会
 * 对一个马上就要结束的操作签发检测编号、提示「正在切换到新版本」，或把它记为 SUPERSEDED 之后又被这里覆盖。服务在这期间崩溃时
 * 崩溃恢复按 ending 重新结束（recoverRoute）。重测的检测截止时间在结束事务中按重读的 payload 清除（probeDeadlineCleared）。
 */
async function endRouteOp(
  engine: Engine,
  opId: string,
  patch: EndPatch,
  step: string,
  emit: EmitSpec = {},
  opts: { cancelOutbox?: boolean } & EndHoldOptions = {},
): Promise<void> {
  const { repos } = engine;
  markEnding(engine, opId, patch, step, opts.cancelOutbox === true);
  const hold = await holdAtRouteEnd(engine, opId, { observedSelection: opts.observedSelection });
  // 以下到 updateOp 都是同步的：重读之后没有其他处理器能在其间改动本操作
  const cur = repos.operations.get(opId);
  if (!cur || (cur.status !== 'running' && cur.status !== 'queued' && cur.status !== 'waiting')) {
    engine.log('warn', 'route.end_skipped', { operationId: opId, status: cur?.status ?? 'missing' });
    return;
  }
  const activeBefore = repos.routeState.get().activeEnvironmentId;
  let routeChanged = hold !== null;
  repos.tx(() => {
    recordEndHold(engine, opId, hold);
    const rp = payloadOf(cur).route;
    if (rp?.flow === 'probe') {
      const cleared = probeDeadlineCleared(repos.routeState.get(), rp);
      if ('awaitingDeadline' in cleared) {
        repos.routeState.update(cleared);
        routeChanged = true;
      }
    }
  });
  const left = retestRouteLeftVerified(engine, payloadOf(cur).route, hold);
  const final = hold
    ? heldEnd(patch, step, hold)
    : left
      ? {
          patch: { ...patch, ...(patch.error ? { error: { ...patch.error, message: `${withoutUnchangedClaim(patch.error.message)}${retestLostNote(left)}` } } : {}) },
          step: `${withoutUnchangedClaim(step)}${retestLostNote(left)}`,
        }
      : { patch, step };
  // 结束之后不再保留 ending（只在结束点进行中有意义）
  const endedRoute = payloadOf(cur).route;
  let payloadPatch: Pick<EndPatch, 'payload'> = {};
  if (endedRoute?.ending) {
    const next: RoutePayload = { ...endedRoute };
    delete next.ending;
    payloadPatch = { payload: { ...payloadOf(cur), route: next } };
  }
  engine.updateOp(
    opId,
    {
      ...final.patch,
      ...payloadPatch,
      ...(hold ? { result: { ...(patch.result ?? cur.result ?? {}), rejectSelected: hold.confirmed } } : {}),
      ...(left ? { result: { ...(patch.result ?? cur.result ?? {}), routeLeftVerified: left } } : {}),
    },
    final.step,
    { ...emit, ...(routeChanged ? { route: true } : {}), ...(hold ? { environments: [...(emit.environments ?? []), ...(activeBefore ? [activeBefore] : [])] } : {}) },
  );
  if (opts.cancelOutbox) repos.outbox.cancelForOperation(opId);
}

/** endRouteOp 的第一步：等待中的操作同步改为 running 并记下要结束成什么（RoutePayload.ending）；其他状态什么也不做。 */
function markEnding(engine: Engine, opId: string, patch: EndPatch, step: string, cancelOutbox: boolean): void {
  const { repos } = engine;
  repos.tx(() => {
    const cur = repos.operations.get(opId);
    const rp = cur ? payloadOf(cur).route : undefined;
    if (!cur || cur.status !== 'waiting' || !rp) return;
    const ending: RouteEnding = { phase: patch.phase ?? cur.phase, status: patch.status ?? cur.status, error: patch.error ?? null, step, cancelOutbox };
    repos.operations.update(opId, { status: 'running', payload: { ...payloadOf(cur), route: { ...rp, ending } } });
  });
}

export function isActiveEnvironment(engine: Engine, environmentId: string): boolean {
  const route = engine.repos.routeState.get();
  return route.activeEnvironmentId === environmentId && route.entryMode !== 'NORMAL';
}

/**
 * 新切换的激活快照（第 5 步）。激活快照只在路由回到已确认状态时清除（提交 ACTIVE、回滚成功恢复切换前节点、进入普通模式），
 * 所以它仍在就说明上一次切换没有回到已确认状态：切换进行中被取代，或已中断（对账发现无人负责、回滚无法确认 →
 * attention；之后的普通模式失败）。这时路由记录里的选择可能是半途切换写入的未验证节点，必须沿用最初的切换前状态
 * （最后一次已确认的路由），否则之后的回滚会把别的买家出口当作原环境的路由恢复。
 */
function routeSnapshot(route: RouteStateRecord): ActivationSnapshot {
  if (route.activationSnapshot) {
    return { ...route.activationSnapshot, previousRouteEpoch: route.routeEpoch };
  }
  return {
    previousEnvironmentId: route.activeEnvironmentId,
    previousProxyRevision: route.activeProxyRevision,
    previousSelectedNode: route.selectedNode,
    previousEntryMode: route.entryMode,
    previousSafariProbeId: null,
    previousRouteEpoch: route.routeEpoch,
    previousPhase: route.phase,
  };
}

class RouteFailure extends Error {
  /**
   * @param observedSelection 失败的检查自己读到的 SFE-ROUTE 选择（例如开始重测时读到与记录不一致的选择）：结束点重读失败时
   *   据此失败即关闭（EndHoldOptions.observedSelection）；没有读到时不传。
   */
  constructor(
    readonly body: ApiErrorBody,
    readonly observedSelection?: string | null,
  ) {
    super(body.message);
  }
}

/** 失败的检查自己读到的 SFE-ROUTE 选择（RouteFailure.observedSelection）；其他错误为 undefined。 */
function observedSelectionOf(err: unknown): string | null | undefined {
  return err instanceof RouteFailure ? err.observedSelection : undefined;
}

function failBody(engine: Engine, err: unknown, fallback: string): ApiErrorBody {
  if (err instanceof RouteFailure) return err.body;
  return engine.errorBody(err, fallback);
}

/** 激活门槛缺失（details.missing 列出缺失项与过期原因）。 */
function capabilityFailure(engine: Engine, missing: readonly CapabilityKey[], prefix: string, suffix: string): ApiErrorBody {
  const views = engine.capabilityViews();
  return {
    code: 'CAPABILITY_UNVERIFIED',
    message: `${prefix}${views.filter((v) => missing.includes(v.key)).map((v) => v.label).join('、')}${suffix}`,
    details: { missing: missing.map((k) => ({ key: k, staleReasons: views.find((v) => v.key === k)?.staleReasons ?? [] })) },
  };
}

/** 本应用文件或受管理段是否被外部修改（撤销入口会改写被修改的入口文件，但保留 managed_segments_changed）。 */
async function segmentsChangedBefore(engine: Engine, route: RouteStateRecord): Promise<boolean> {
  if (route.warnings.includes('managed_segments_changed')) return true;
  try {
    return (await managedSegmentsChanged(engine)) === true;
  } catch {
    return false;
  }
}

/**
 * 写入之前失败（第 1–3 步）：本操作经 supersedeWaiting 接手了过渡中的路由（被取代的激活停在 VERIFY_ONLY 等待，
 * 切换中或回滚中）时，没有其他操作负责它——按激活快照回滚（阻断并恢复切换前节点）；否则标为失败，不改写入口。
 * 后者同样是路由操作的结束点（endRouteOp → holdAtRouteEnd）：接手的路由已不在过渡中（例如启动对账或周期对账发现有规则排在
 * 入口之前，把等待实测的路由改为 attention、入口 UNKNOWN），Surge 仍加载着检测入口、SFE-ROUTE 选着未验证的节点时，失败即
 * 关闭改选 REJECT，从不把检测主机留在未验证的出口上。
 */
async function failBeforeSwitch(engine: Engine, opId: string, body: ApiErrorBody, observedSelection?: string | null): Promise<void> {
  const cur = engine.repos.operations.get(opId)!;
  if (cur.status !== 'running' && cur.status !== 'queued') return;
  const route = engine.repos.routeState.get();
  if (ownsTransition(route, opId)) {
    await rollbackActivation(engine, opId, body, engine.entryController(() => opId), route.entryMode);
    return;
  }
  await endRouteOp(engine, opId, { phase: 'FAILED', status: 'failed', error: body }, body.message, { route: true }, { observedSelection });
}

const TRANSITION_PHASES: readonly RouteStateRecord['phase'][] = ['switching', 'awaiting_safari_verify', 'rolling_back'];

/**
 * 路由处理器的兜底（dispatch.ts）：处理器应自行结算；意外异常（例如数据库错误）越过了它自己的回滚或失败处理时，执行器只会把
 * 操作标为失败，而本操作负责的过渡中路由（切换中、VERIFY_ONLY 等待、回滚中；含普通模式撤销入口时记下的切换中）就此无人负责：
 * Surge 可能仍加载着检测或使用中入口，SFE-ROUTE 选着未验证的节点，对账只标 attention、从不写 Surge（§6.6）。这里按回滚无法
 * 确认的同一规则失败即关闭：选择不是使用中环境已验证的出口时 SFE-ROUTE 尽力改选 REJECT 并读回（处理器中断在哪一步未知，记录的
 * 入口模式不能作为依据）；路由 attention、入口 UNKNOWN 并带 entry_unverified，操作 BLOCKED_NEEDS_ATTENTION，说明如实写明。
 * 本操作是不负责过渡中路由的路由操作时，这同样是它的结束点：按 holdAtRouteEnd 失败即关闭（需要时改选 REJECT 并记下），操作记为
 * 需要处理（BLOCKED_NEEDS_ATTENTION）、说明写明改选；不需要改选时什么也不做，交给执行器记录。其他操作什么也不做。从不抛出。
 */
export async function settleAbandonedTransition(engine: Engine, opId: string, err: unknown): Promise<void> {
  const { repos } = engine;
  try {
    const route = repos.routeState.get();
    if (route.operationId !== opId || !TRANSITION_PHASES.includes(route.phase)) {
      await settleAbandonedRouteOp(engine, opId, err);
      return;
    }
    const hold = (await selectionIsVerifiedExit(engine, route)) ? null : await selectRejectBestEffort(engine);
    const cause = holdErrorText(engine, err, '内部错误');
    const written = activeWrittenUncovered(engine, opId, repos.routeState.get().activeEnvironmentId);
    const body: ApiErrorBody = {
      code: 'UNKNOWN_STATE',
      message: `切换中断：处理中出现意外错误（${cause}），入口状态未知，需要处理${hold ? `；${rejectHoldText(hold)}；${EXISTING_CONNECTIONS_TEXT}` : ''}${written ? `；${activeWrittenNote(written)}` : ''}`,
      details: hold ? { rejectSelected: hold.confirmed } : {},
    };
    // 视图随之改变的环境：本操作的目标（切换中、检测中 → 未使用）、路由记录的使用中环境（→ 路由状态需要处理），以及普通模式
    // 接手的、已写入 ACTIVE 而未提交的切换目标。与其他结束路由操作的路径一样一起发布（网页后台只在 environment.updated 中更新
    // 环境，否则一直显示它「切换中」、算作使用中）
    const envs = new Set<string>();
    repos.tx(() => {
      const fresh = repos.routeState.get();
      if (fresh.operationId !== opId || !TRANSITION_PHASES.includes(fresh.phase)) return;
      const self = repos.operations.get(opId);
      const target = self ? (payloadOf(self).route?.targetEnvironmentId ?? self.environmentId) : null;
      if (target) envs.add(target);
      if (fresh.activeEnvironmentId) envs.add(fresh.activeEnvironmentId);
      const handedOver = self ? payloadOf(self).normal?.handedOverActiveTarget : undefined;
      if (handedOver) envs.add(handedOver);
      // 之前一次成功回滚留下的 rollback_needs_reverify（「已恢复原节点并保持阻断」）已不成立：之后又开始了切换，这里不恢复节点
      const warnings = new Set<RouteWarning>(fresh.warnings.filter((w) => w !== 'rollback_needs_reverify'));
      warnings.add('entry_unverified');
      if (hold) holdExistingConnections(engine, opId, warnings);
      if (written) warnings.add('managed_windows_on_original_rules');
      repos.routeState.update({
        phase: 'attention',
        entryMode: 'UNKNOWN',
        awaitingDeadline: null,
        ...(hold?.confirmed ? { selectedNode: 'REJECT' } : {}),
        warnings: [...warnings],
      });
      const cur = repos.operations.get(opId);
      if (cur && (cur.status === 'running' || cur.status === 'queued' || cur.status === 'waiting')) {
        repos.operations.update(opId, { phase: 'BLOCKED_NEEDS_ATTENTION', status: 'needs_attention', error: body });
        repos.operations.appendStep(opId, 'BLOCKED_NEEDS_ATTENTION', body.message);
        repos.outbox.cancelForOperation(opId);
      }
    });
    engine.emit({ operations: [opId], route: true, environments: [...envs] });
  } catch (e) {
    engine.log('error', 'route.settle_failed', { operationId: opId, error: e instanceof Error ? e.name : 'unknown' });
  }
}

/**
 * settleAbandonedTransition 中不负责过渡中路由的路由操作（激活、普通模式、重测，或带路由参数的发布）：处理器的意外异常越过了它
 * 自己的结束点，按 holdAtRouteEnd 失败即关闭；改选了就在这里结束为需要处理（heldEnd；执行器看到已结束，不再覆盖），否则交给
 * 执行器记录。
 */
async function settleAbandonedRouteOp(engine: Engine, opId: string, err: unknown): Promise<void> {
  const { repos } = engine;
  const op = repos.operations.get(opId);
  if (!op || (op.status !== 'running' && op.status !== 'queued' && op.status !== 'waiting')) return;
  const isRoute = op.kind === 'route.activate' || op.kind === 'route.normal' || op.kind === 'probe.safari' || payloadOf(op).route !== undefined;
  if (!isRoute) return;
  const hold = await holdAtRouteEnd(engine, opId);
  if (!hold) return;
  const failure = engine.errorBody(err, '执行失败：内部错误');
  const end = heldEnd({ phase: 'FAILED', status: 'failed', error: failure }, failure.message, hold);
  const activeBefore = repos.routeState.get().activeEnvironmentId;
  repos.tx(() => {
    // 在事务中重读：改选的 Surge 调用期间本操作可能已由其他路径结束（不覆盖）
    const cur = repos.operations.get(opId);
    if (!cur || (cur.status !== 'running' && cur.status !== 'queued' && cur.status !== 'waiting')) return;
    recordEndHold(engine, opId, hold);
    repos.operations.update(opId, { ...end.patch, result: { ...(cur.result ?? {}), rejectSelected: hold.confirmed } });
    repos.operations.appendStep(opId, 'BLOCKED_NEEDS_ATTENTION', end.step);
    repos.outbox.cancelForOperation(opId);
  });
  engine.emit({ operations: [opId], route: true, environments: [...(op.environmentId ? [op.environmentId] : []), ...(activeBefore ? [activeBefore] : [])] });
}

/** 本操作负责一个过渡中的路由（切换中、VERIFY_ONLY 等待、回滚中，且有激活快照）：失败或中断都只能按快照回滚。 */
function ownsTransition(route: RouteStateRecord, opId: string): boolean {
  return (
    route.operationId === opId &&
    (route.phase === 'switching' || route.phase === 'awaiting_safari_verify' || route.phase === 'rolling_back') &&
    route.activationSnapshot !== null
  );
}

/**
 * 进入普通模式永远可用（docs/ARCHITECTURE.md §5.2）；多个请求按显式请求串行处理，旧请求的结果不能覆盖新请求（方案 1 设计
 * 「多环境争抢」一行）：路由操作执行中受理的普通模式排在它之后（accept.ts acceptNormal）。执行中的激活（含活动环境发布的切换
 * 与崩溃恢复中重新执行的激活）在第一次写入 Surge（阻断）之前、每一次放宽入口（VERIFY_ONLY、ACTIVE）之前与提交 ACTIVE 之前
 * 调用：有排队的普通模式时就此停下——与受理时取代等待中的激活相同，记为 SUPERSEDED（不回滚），过渡中的路由（激活快照、已确认
 * 的入口）交给普通模式，由它从当前状态撤销本应用入口并结束 Safari 连接；使用中的环境不变，普通模式受理时的旧窗口确认对它仍然成立。
 * 停在提交 ACTIVE 之前（opts.activeWrittenTarget）时 Safari 已经过目标环境的出口，受理时的确认没有覆盖目标环境的窗口：记入普通
 * 模式（normal.handedOverActiveTarget），由它完成时带旧窗口警告（runNormal）。
 * routePatch：停下之前已读回确认、尚未记入路由的入口（例如 ACTIVE 已写入、未提交）；where 写明停在哪里，tail 写明之后由普通模式
 * 做什么。返回是否已停下。
 */
function yieldToQueuedNormal(
  engine: Engine,
  opId: string,
  where: string,
  routePatch: Partial<RouteStateRecord> = {},
  tail = '由普通模式撤销本应用入口并结束 Safari 连接',
  opts: { beforeFirstWrite?: boolean; activeWrittenTarget?: string } = {},
): boolean {
  const { repos } = engine;
  const normal = repos.operations.listByStatus(['queued']).find((o) => o.kind === 'route.normal' && o.id !== opId);
  if (!normal) return false;
  const self = repos.operations.get(opId)!;
  // 活动环境发布的切换在第一次写入 Surge 之前停下：新版本已部署、路由未改变，与它停在 WAITING_ROUTE 时被受理的普通模式结束
  // 一样记为 READY_FOR_NEXT_OPEN（succeeded，没有错误；§6.1 并发矩阵），不把已部署的编辑显示成被取代的失败
  const deployedNotSwitched = opts.beforeFirstWrite === true && PUBLISH_KINDS.includes(self.kind);
  repos.tx(() => {
    if (deployedNotSwitched) {
      repos.operations.update(opId, { phase: 'READY_FOR_NEXT_OPEN', status: 'succeeded', supersededBy: normal.id });
      repos.operations.appendStep(opId, 'READY_FOR_NEXT_OPEN', `新版本已部署，未切换：已有进入普通模式的请求（${where}），路由未改变`);
    } else {
      repos.operations.update(opId, {
        phase: 'SUPERSEDED',
        status: 'superseded',
        supersededBy: normal.id,
        error: { code: 'SUPERSEDED', message: '已被进入普通模式取代' },
      });
      repos.operations.appendStep(opId, 'SUPERSEDED', `已被进入普通模式取代：${where}，${tail}`);
    }
    repos.outbox.cancelForOperation(opId);
    // 入口已写入 ACTIVE（未提交）：目标环境的窗口已经过它的出口，记入普通模式，完成时按它的窗口处理（runNormal）
    if (opts.activeWrittenTarget !== undefined) {
      const cur = repos.operations.get(normal.id)!;
      const np = payloadOf(cur).normal;
      if (np) repos.operations.update(normal.id, { payload: { ...payloadOf(cur), normal: { ...np, handedOverActiveTarget: opts.activeWrittenTarget } } });
    }
    const route = repos.routeState.get();
    if (route.operationId === opId) repos.routeState.update({ ...routePatch, operationId: normal.id, awaitingDeadline: null });
  });
  // 目标环境的视图随之改变（切换中 → 未使用；发布 → 下次打开时切换）：一起发布，否则网页后台一直显示它切换中、使用中
  const target = payloadOf(self).route?.targetEnvironmentId ?? self.environmentId;
  engine.emit({ operations: [opId, normal.id], route: true, environments: target ? [target] : [] });
  return true;
}

/**
 * 第一次写入 Surge 之前的停止点：受理之后仍在排队（含崩溃恢复中重新执行的激活、绑定场景到达后继续的活动环境发布），或在第
 * 1–3 步的读取与独立预检期间受理的普通模式。本操作还没有阻断 Safari、结束连接或改选节点——不碰 Surge 就停下，否则它会先阻断
 * Safari、结束全部 Safari 连接（从普通模式出发时包括按原规则发出的连接）、选中未验证的节点并经 SFE-ROUTE 做推迟的预检，然后才
 * 把路由交给普通模式。经取代接手的过渡中路由（切换中、VERIFY_ONLY 等待）照常交给普通模式。
 */
function yieldBeforeFirstWrite(engine: Engine, opId: string): boolean {
  return yieldToQueuedNormal(
    engine,
    opId,
    '在第一次写入 Surge 之前停下（没有阻断 Safari、没有结束连接、没有改选节点）',
    {},
    '由普通模式从当前状态进入普通模式',
    { beforeFirstWrite: true },
  );
}

// ---------- 活动环境发布 → WAITING_ROUTE ----------

function revisionLabel(n: number | null): string {
  return n === null ? '—' : `v${String(n).padStart(3, '0')}`;
}

/**
 * 切换目标版本是否已被之后的修改替换（返回说明，没有被替换时为 null）。从不切到用户已替换的版本（§6.1、§6.3）：活动环境发布
 * （apply_new_revision）的目标必须仍是环境的期望版本（最近一次保存的代理）且已部署——之后又改了代理（单项修改、导入、更换前置）
 * 就是用户已替换的出口（可能正是被更正的、指向另一个买家代理的那一次修改），无论更新的版本是否已部署：它的发布失败、读回不完整
 * 或暂停待部署时，旧的等待也不能把 Safari 切到被替换的出口上（弹窗显示的「修改后」是更新的版本）。激活的目标必须仍是已部署或
 * 最近一次验证通过的版本（与受理时相同，acceptActivate）。期望版本只在保存事务中改变，已部署的版本只在执行器内的发布结算时改变。
 * Safari 重测不切换，不检查。
 */
function replacedTarget(engine: Engine, p: RoutePayload): string | null {
  if (p.flow === 'probe') return null;
  const env = engine.repos.environments.get(p.targetEnvironmentId);
  if (!env || env.deletedAt) return null;
  if (p.purpose === 'apply_new_revision') {
    if (env.desiredProxyRevision !== p.proxyRevision) {
      const saved = env.desiredProxyRevision;
      const deployed = saved !== null && env.deployedProxyRevision === saved;
      return `代理版本 ${revisionLabel(p.proxyRevision)} 已被之后的修改替换（已保存 ${revisionLabel(saved)}${deployed ? '，已部署' : '，尚未部署'}）`;
    }
    return env.deployedProxyRevision === p.proxyRevision
      ? null
      : `代理版本 ${revisionLabel(p.proxyRevision)} 已被之后的修改替换（已部署 ${revisionLabel(env.deployedProxyRevision)}）`;
  }
  return p.proxyRevision === env.deployedProxyRevision || p.proxyRevision === env.lastVerifiedProxyRevision
    ? null
    : `代理版本 ${revisionLabel(p.proxyRevision)} 已被之后的修改替换`;
}

/**
 * 第 2 步的版本核对（replacedTarget）：开始执行时与第一次写入 Surge 之前各做一次（第 1–3 步的读取与独立预检期间又改了代理）。
 * 已被替换时不碰 Surge：活动环境发布结束为 READY_FOR_NEXT_OPEN（返回 true），激活失败（RouteFailure），路由未改变；经取代接手了
 * 过渡中的路由时由 failBeforeSwitch 按快照回滚。
 */
async function stopIfReplaced(engine: Engine, opId: string): Promise<boolean> {
  const { repos } = engine;
  const op = repos.operations.get(opId)!;
  const replaced = replacedTarget(engine, routePayload(op));
  if (!replaced) return false;
  if (PUBLISH_KINDS.includes(op.kind) && !ownsTransition(repos.routeState.get(), opId)) {
    await endReplacedPublish(engine, opId, replaced);
    return true;
  }
  throw new RouteFailure({ code: 'NODE_NOT_DEPLOYED', message: `激活失败：${replaced}，路由未改变，请重新使用此环境` });
}

/**
 * 活动环境发布的目标版本已被替换（replacedTarget），而本操作还没有写入 Surge、也不负责过渡中的路由：不切换，结束为
 * READY_FOR_NEXT_OPEN（succeeded，没有错误；更新的版本由它自己的发布在下次打开时切换），路由未改变（结束点照常按 holdAtRouteEnd
 * 失败即关闭）。
 */
async function endReplacedPublish(engine: Engine, opId: string, why: string): Promise<void> {
  const op = engine.repos.operations.get(opId)!;
  const target = payloadOf(op).route?.targetEnvironmentId ?? op.environmentId;
  await endRouteOp(
    engine,
    opId,
    { phase: 'READY_FOR_NEXT_OPEN', status: 'succeeded' },
    `${why}：不切换到这一版本，路由未改变`,
    { environments: target ? [target] : [] },
    { cancelOutbox: true },
  );
}

/** 停在 WAITING_ROUTE 的发布的目标版本已被替换：结束为 READY_FOR_NEXT_OPEN，返回是否已结束。 */
async function endReplacedWaitingRoute(engine: Engine, op: OperationRecord): Promise<boolean> {
  const why = replacedTarget(engine, routePayload(op));
  if (!why) return false;
  await endReplacedPublish(engine, op.id, why);
  return true;
}

/**
 * 活动环境的新版本已部署：同一操作停在 WAITING_ROUTE，等待绑定场景到达（不阻断 Safari）。同一环境之前停在 WAITING_ROUTE 的
 * 发布（等待期间又改了代理）在同一事务中结束为 READY_FOR_NEXT_OPEN（superseded_by 为本操作）：它的版本已被用户替换，之后不再
 * 切到它（弹窗与网页只提示更新的这一次）。发布期间又保存了更新的版本（已部署的这一版已被替换，replacedTarget）：不进入等待，
 * 直接结束为 READY_FOR_NEXT_OPEN，路由未改变，更新的版本由它自己的发布切换。
 */
export function enterWaitingRoute(engine: Engine, opId: string, environmentId: string, proxyRevision: number): void {
  const { repos } = engine;
  const rev = repos.proxyRevisions.get(environmentId, proxyRevision)!;
  const route = repos.routeState.get();
  const deadline = addSeconds(engine, repos.settings.get('profileArrivalTimeoutSec'));
  const op = repos.operations.get(opId)!;
  const older = routeOps(engine).waitingRoute.filter((o) => o.id !== opId && payloadOf(o).route?.targetEnvironmentId === environmentId);
  const desired = repos.environments.get(environmentId)?.desiredProxyRevision ?? null;
  if (desired !== proxyRevision) {
    repos.tx(() => {
      repos.operations.update(opId, { phase: 'READY_FOR_NEXT_OPEN', status: 'succeeded', environmentId: op.environmentId ?? environmentId });
      repos.operations.appendStep(
        opId,
        'READY_FOR_NEXT_OPEN',
        `新版本 ${revisionLabel(proxyRevision)} 已部署，未切换：发布期间又修改了代理（已保存 ${revisionLabel(desired)}），不切换到这一版本，路由未改变`,
      );
      repos.outbox.cancelForOperation(opId);
      for (const o of older) {
        repos.operations.update(o.id, { phase: 'READY_FOR_NEXT_OPEN', status: 'succeeded', supersededBy: opId });
        repos.operations.appendStep(o.id, 'READY_FOR_NEXT_OPEN', `新版本已部署，未切换：之后又修改了代理（已保存 ${revisionLabel(desired)}），不切换到这一版本，路由未改变`);
        repos.outbox.cancelForOperation(o.id);
      }
    });
    engine.emit({ operations: [opId, ...older.map((o) => o.id)], environments: [environmentId] });
    return;
  }
  const payload = newRoutePayload({
    targetEnvironmentId: environmentId,
    proxyRevision,
    nodeName: rev.nodeName,
    purpose: 'apply_new_revision',
    expectedActiveEnvironmentId: route.activeEnvironmentId,
    oldSessionPolicy: route.oldSessionPolicy,
    stage: 'waiting_route',
    arrivalDeadline: deadline,
  });
  repos.tx(() => {
    repos.operations.update(opId, {
      payload: { ...payloadOf(op), route: payload },
      phase: 'WAITING_ROUTE',
      status: 'waiting',
      environmentId: op.environmentId ?? environmentId,
    });
    repos.operations.appendStep(opId, 'WAITING_ROUTE', '新版本已部署：在绑定的 Safari 场景中打开扩展即可切换，期间旧版本继续使用');
    repos.outbox.enqueue(opId, 'arrival_timeout', deadline);
    for (const o of older) {
      repos.operations.update(o.id, { phase: 'READY_FOR_NEXT_OPEN', status: 'succeeded', supersededBy: opId });
      repos.operations.appendStep(o.id, 'READY_FOR_NEXT_OPEN', `新版本已部署，未切换：之后又修改了代理，更新的版本 ${revisionLabel(proxyRevision)} 已部署，改为等待切换到它`);
      repos.outbox.cancelForOperation(o.id);
    }
  });
  engine.emit({ operations: [opId, ...older.map((o) => o.id)], environments: [environmentId] });
}

// ---------- 执行入口 ----------

export async function runActivation(engine: Engine, op: OperationRecord): Promise<void> {
  const p = routePayload(op);
  engine.updateOp(op.id, { status: 'running', phase: 'VALIDATING' }, '开始检查激活条件');
  try {
    await prepareAndSwitch(engine, op.id, { allowReuse: p.flow === 'activate' });
  } catch (err) {
    // 复用改为重测时开始等待读到的不一致选择（observedSelectionOf）随结束点传入
    await failBeforeSwitch(engine, op.id, failBody(engine, err, '激活失败：内部错误'), observedSelectionOf(err));
  }
}

/** 第 1–3 步（复用、受控检查、预检）后进入切换；任何失败都不碰路由。 */
async function prepareAndSwitch(engine: Engine, opId: string, opts: { allowReuse: boolean }): Promise<void> {
  const { repos } = engine;
  // 受理之后排在本操作之后的普通模式（本操作仍在排队时受理）：开始执行之前就停下，不读也不写 Surge
  if (yieldBeforeFirstWrite(engine, opId)) return;
  let op = repos.operations.get(opId)!;
  let p = routePayload(op);
  const env = repos.environments.get(p.targetEnvironmentId);
  const rev = repos.proxyRevisions.get(p.targetEnvironmentId, p.proxyRevision);
  if (!env || env.deletedAt || !rev) throw new RouteFailure({ code: 'NOT_FOUND', message: '激活失败：环境或版本不存在' });
  // 受理之后目标版本已被之后的修改替换（排队期间、停在 WAITING_ROUTE 期间、崩溃恢复时又改了代理）：不读也不写 Surge。活动环境
  // 发布结束为 READY_FOR_NEXT_OPEN（更新的版本由它自己的发布切换）；激活失败，路由未改变。经取代接手了过渡中的路由时由
  // failBeforeSwitch 按快照回滚
  if (await stopIfReplaced(engine, opId)) return;
  await engine.readBasicFacts();
  const missing = engine.activationMissing();
  if (missing.length > 0) throw new RouteFailure(capabilityFailure(engine, missing, '激活失败：', '尚未通过实测'));
  const ctrl = engine.entryController(() => opId);
  if (!ctrl) throw new RouteFailure({ code: 'CAPABILITY_UNVERIFIED', message: '激活失败：入口策略或 Safari 进程路径尚未确认' });
  // 建立控制器时的入口设置：第一次写入之前再比较（executeSwitch）
  const settingsKey = entrySettingsKey(engine);

  // 1. 复用（只读）
  if (opts.allowReuse) {
    const reused = await tryReuse(engine, opId, p, ctrl);
    if (reused) return;
    op = repos.operations.get(opId)!;
    p = routePayload(op);
    if (p.flow === 'probe') return;
  }

  // 2. 受控检查（写入之前）
  await checkSwitchPreconditions(engine, p, ctrl);

  // 3. 预检：independent_node_preflight 通过时在阻断之前；否则推迟到选择之后经 SFE-ROUTE
  const preflightOk = engine.missing(CAPABILITY_GATES.preflight).length === 0;
  if (preflightOk) {
    let probe = currentPreflight(engine, env.id, rev.revision);
    if (!probe) {
      probe = await recordPreflight(engine, { environmentId: env.id, revision: rev, operationId: opId, allowed: true, generation: repos.meta.configurationGeneration() });
      engine.emit({ environments: [env.id] });
      if (probe.outcome !== 'ok') throw new RouteFailure({ code: 'PREFLIGHT_FAILED', message: '代理预检失败：前置或 SOCKS5 不可用，路由未改变' });
    }
    engine.updateOp(opId, { phase: 'PREFLIGHT_OK' }, '代理预检通过');
  } else {
    p = savePayload(engine, opId, { preflightDeferred: true });
    engine.step(opId, '独立预检能力未通过：预检推迟到阻断 Safari 并选择节点之后经 SFE-ROUTE 执行');
  }
  await executeSwitch(engine, opId, ctrl, settingsKey);
}

/**
 * 第 1 步复用：完全受控且实测有效 → 直接完成；实测过期或不是 ok → 改为 Safari 重测（不切换）。
 * 判定之前同步对账一次（§6.6「激活复用之前，同步做一次短超时对账；失败即拒绝」，只读 Surge）：路由记录的警告可能还没有反映
 * Surge 的变化（例如出站模式刚改为直连、Surge 重启、当前配置被换掉），只看记录会把这时的激活报告为「已在使用中且实测有效」，
 * 准备页随即按 5 秒内的对账允许打开订单页。对账失败或发现失控类警告 → 不复用，改为完整切换，由第 2 步受控检查按刚读到的
 * 事实拒绝（路由未改变）或继续。
 */
async function tryReuse(engine: Engine, opId: string, p: RoutePayload, ctrl: EntryController): Promise<boolean> {
  const { repos } = engine;
  const target = (r: RouteStateRecord): boolean =>
    r.activeEnvironmentId === p.targetEnvironmentId && r.activeProxyRevision === p.proxyRevision && r.phase === 'active_verified';
  if (!target(repos.routeState.get())) return false;
  try {
    await reconcile(engine, 'precheck');
  } catch {
    engine.step(opId, '复用之前的对账未能完成：不复用，按完整切换重新检查');
    return false;
  }
  const route = repos.routeState.get();
  if (!target(route)) return false;
  if (hasAny(route.warnings, REUSE_BLOCKING_WARNINGS).length > 0) return false;
  const f = engine.facts;
  if (!f.reachable || f.onWorkingProfile !== true) return false;
  if (f.takeover.enhancedMode === false && f.takeover.systemProxy === false) return false;
  if (f.takeover.outboundMode !== null && f.takeover.outboundMode !== 'rule') return false;
  let mode: EntryMode = 'UNKNOWN';
  let selection: string | null = null;
  try {
    mode = (await ctrl.read()).mode;
    selection = await engine.surge.getGroupSelection(ROUTE_GROUP_NAME);
  } catch {
    return false;
  }
  if (mode !== 'ACTIVE' || selection !== p.nodeName) return false;
  const probe = repos.probes.latest(p.targetEnvironmentId, 'safari');
  const probeOk =
    safariProbeCurrent(route, probe, engine.now()) && !route.warnings.includes('probe_failed') && !route.warnings.includes('exit_ip_mismatch');
  if (probeOk) {
    engine.updateOp(opId, { phase: 'ACTIVE_VERIFIED', status: 'succeeded', resultRevision: p.proxyRevision, result: { reused: true }, routeEpoch: route.routeEpoch }, '环境已在使用中且实测有效：直接复用，未切换、未断连', { route: true });
    repos.outbox.cancelForOperation(opId);
    return true;
  }
  // 实测过期：改为当前环境的 Safari 重测（不递增 epoch、不阻断、不断连）
  savePayload(engine, opId, { flow: 'probe', purpose: 'probe_safari' });
  repos.operations.update(opId, { probeKind: 'safari' });
  engine.step(opId, '环境已在使用中，但实测已过期：改为 Safari 重测，不切换');
  await startProbeWaiting(engine, opId, ctrl);
  return true;
}

/** 第 2 步受控检查：任一不满足 → 失败且不碰路由。 */
async function checkSwitchPreconditions(engine: Engine, p: RoutePayload, ctrl: EntryController): Promise<void> {
  const { repos } = engine;
  const route = repos.routeState.get();
  if ((route.activeEnvironmentId ?? null) !== (p.expectedActiveEnvironmentId ?? null)) {
    const details = confirmationNeeded(engine, p.targetEnvironmentId) ?? {
      reason: 'other_environment_active' as const,
      currentEnvironmentId: route.activeEnvironmentId,
      currentEnvironmentLabel: null,
      otherProfilesOpen: [],
      options: ['closed_confirmed', 'keep_open_acknowledged'] as const,
      limitation: null,
    };
    throw new RouteFailure(needsConfirmationError('激活', { ...details, options: [...details.options] }).toBody());
  }
  const f = engine.facts;
  if (!f.reachable) throw new RouteFailure({ code: 'SURGE_UNREACHABLE', message: '激活失败：无法连接 Surge，路由未改变' });
  if (f.onWorkingProfile !== true) throw new RouteFailure({ code: 'EXTERNAL_PROFILE', message: '激活失败：Surge 当前配置不是固定工作配置，路由未改变' });
  if (f.takeover.enhancedMode === false && f.takeover.systemProxy === false) {
    throw new RouteFailure({ code: 'TAKEOVER_LOST', message: '激活失败：Surge 增强模式与系统代理都已关闭，路由未改变' });
  }
  if (f.takeover.outboundMode !== null && f.takeover.outboundMode !== 'rule') {
    throw new RouteFailure({ code: 'TAKEOVER_LOST', message: '激活失败：Surge 出站模式不是规则模式，路由未改变' });
  }
  const readback = await ctrl.read();
  // 本应用入口尚未写入工作配置（例如更改入口策略之后尚未重新合并，EntryReadback.notInstalled）：没有可切换的入口，写入之前停止
  if (readback.notInstalled) {
    throw new RouteFailure({ code: 'RESOURCE_MISSING', message: '激活失败：本应用入口尚未写入工作配置（更改入口策略之后需要先在维护中重新合并），路由未改变' });
  }
  // 入口段不完整、重复或顺序不对（ruleset_resource 的四条 RULE-SET，EntryReadback.segmentDamaged；例如用户在 Surge 中编辑或恢复了
  // 工作配置）：按位先后的切换无法规划、读回无法确认，写入之前停止。普通模式会把入口文件改写为占位规则，之后重新合并恢复受管理段
  if (readback.segmentDamaged) {
    throw new RouteFailure({
      code: 'RESOURCE_MISSING',
      message: '激活失败：本应用入口的 RULE-SET 不在有效规则中、重复或顺序不对（工作配置被外部修改），路由未改变；请先进入普通模式，再在维护中重新合并',
    });
  }
  if (readback.precedenceIssues.some((i) => i.severity === 'blocking')) {
    throw new RouteFailure({
      code: 'PRECEDENCE_VIOLATION',
      message: '激活失败：有规则排在本应用入口之前，可能抢先匹配 Safari 流量',
      details: { precedenceIssues: readback.precedenceIssues },
    });
  }
  // 被外部修改的本应用入口文件从不被激活采纳或悄悄改写（§5.5）：写入之前停止，由普通模式（会改写它们）或维护流程恢复
  if (readback.changedOwnedFiles && readback.changedOwnedFiles.length > 0) {
    throw new RouteFailure({
      code: 'BASELINE_CHANGED',
      message: '激活失败：本应用的入口文件已被外部修改，路由未改变；进入普通模式会改写这些文件',
      details: { files: readback.changedOwnedFiles },
    });
  }
  const rev = repos.proxyRevisions.get(p.targetEnvironmentId, p.proxyRevision)!;
  const front = repos.frontProxies.get(rev.frontProxyId);
  const policies = await engine.surge.listPolicies();
  if (!front || front.retired || !policies.proxies.includes(front.surgeName)) {
    throw new RouteFailure({ code: 'FRONT_PROXY_MISSING', message: '激活失败：前置节点不在 Surge 中，路由未改变' });
  }
  const members = await engine.surge.getGroupMembers(ROUTE_GROUP_NAME);
  if (!members.includes(p.nodeName)) throw new RouteFailure({ code: 'NODE_NOT_DEPLOYED', message: '激活失败：目标节点不在 SFE-ROUTE 中，路由未改变' });
}

/**
 * 第 5–9 步：epoch 递增与快照 → BLOCKED → 结束 Safari 连接 → 选择并读回 →（推迟的预检）→ VERIFY_ONLY 等待。
 * settingsKey：第 1 步建立入口控制器时的入口设置（entrySettingsKey）。
 */
async function executeSwitch(engine: Engine, opId: string, ctrl: EntryController, settingsKey: string): Promise<void> {
  const { repos } = engine;
  // 第 1–3 步的读取与独立预检期间受理的普通模式：递增 epoch、阻断之前停下
  if (yieldBeforeFirstWrite(engine, opId)) return;
  // 第二道防线（受理已拒绝，见 entrySettingsChangeRefusal）：第 1–3 步期间入口策略、Safari 进程路径或检测服务变了，或激活门槛
  // 已不满足——本操作的控制器按旧设置写入，之后的回滚、取消与普通模式按新设置另建控制器，看不到它写入的入口。第一次写入之前
  // 停止，路由未改变（经取代接手了过渡中的路由时由 failBeforeSwitch 按快照回滚）
  if (entrySettingsKey(engine) !== settingsKey) {
    throw new RouteFailure({ code: 'CAPABILITY_UNVERIFIED', message: '激活失败：入口策略、Safari 进程路径或检测服务在检查期间已变化，路由未改变，请重新使用此环境' });
  }
  const missingNow = engine.activationMissing();
  if (missingNow.length > 0) throw new RouteFailure(capabilityFailure(engine, missingNow, '激活失败：', '在检查期间已不再满足，路由未改变'));
  // 第 1–3 步的读取与独立预检期间又改了代理（保存了更新的版本）：第一次写入之前停下，不阻断、不断连、不改选到被替换的节点
  if (await stopIfReplaced(engine, opId)) return;
  const before = repos.routeState.get();
  const snapshot = routeSnapshot(before);
  snapshot.previousSafariProbeId =
    snapshot.previousEnvironmentId !== null ? (repos.probes.latest(snapshot.previousEnvironmentId, 'safari')?.id ?? null) : null;
  const epoch = before.routeEpoch + 1;
  repos.tx(() => {
    repos.routeState.update({ routeEpoch: epoch, phase: 'switching', operationId: opId, activationSnapshot: snapshot, awaitingDeadline: null });
    const op = repos.operations.get(opId)!;
    repos.operations.update(opId, { routeEpoch: epoch, payload: { ...payloadOf(op), route: { ...routePayload(op), stage: 'switching' } } });
  });
  engine.emit({ route: true, operations: [opId] });
  let confirmed: EntryMode = before.entryMode;
  let killResults: KillResult[] = [];
  try {
    // 6. 阻断
    await ctrl.transition('BLOCKED');
    confirmed = 'BLOCKED';
    repos.routeState.update({ entryMode: 'BLOCKED', entryModeVerifiedAt: engine.nowIso() });
    engine.updateOp(opId, { phase: 'SAFARI_BLOCKED' }, '已阻断 Safari 新请求（读回确认），暂停自动打开订单与填充', { route: true });
    // 7. 结束 Safari 连接：按已确认的进程路径，另按持久标记中被换掉的进程路径结束其中可能经买家出口的连接（之前一次普通
    // 模式未能确认结束时它们仍可能在之前买家的出口上；按新的确认它们不再是配置的 Safari 进程，其余连接不碰）
    const cfg = engine.entryConfig();
    try {
      killResults = await killSafariConnections(engine.surge, {
        processPaths: cfg.processPaths,
        retiredProcessPaths: retiredSafariPaths(engine, cfg.processPaths),
        verifyHost: cfg.verifyHost,
        now: () => engine.now(),
        bestEffort: false,
      });
    } catch (err) {
      if (err instanceof SfeError && Array.isArray(err.details?.killResults)) killResults = err.details.killResults as KillResult[];
      throw err;
    } finally {
      const cur = repos.operations.get(opId)!;
      repos.operations.update(opId, { result: { ...(cur.result ?? {}), killResults } });
    }
    const killed = repos.operations.get(opId)!;
    repos.operations.update(opId, { payload: { ...payloadOf(killed), route: { ...routePayload(killed), safariConnectionsEnded: true } } });
    engine.step(opId, `已结束 Safari 连接 ${killResults.filter((k) => k.ok).length} 条`);
    // 8. 选择目标节点并读回
    const p = routePayload(repos.operations.get(opId)!);
    await engine.surge.selectGroupPolicy(ROUTE_GROUP_NAME, p.nodeName);
    const sel = await engine.surge.getGroupSelection(ROUTE_GROUP_NAME);
    if (sel !== p.nodeName) throw new SfeError('READBACK_MISMATCH', '切换失败：SFE-ROUTE 选择读回与目标不一致');
    repos.routeState.update({ selectedNode: sel });
    engine.step(opId, '已选择目标节点（读回确认）');
    if (p.preflightDeferred) {
      const rev = repos.proxyRevisions.get(p.targetEnvironmentId, p.proxyRevision)!;
      const probe = await recordPreflight(engine, {
        environmentId: p.targetEnvironmentId,
        revision: rev,
        operationId: opId,
        allowed: true,
        generation: repos.meta.configurationGeneration(),
        viaRoute: { group: ROUTE_GROUP_NAME, routeEpoch: epoch },
      });
      if (probe.outcome !== 'ok') throw new SfeError('PREFLIGHT_FAILED', '代理预检失败：经 SFE-ROUTE 测试不通过');
      engine.updateOp(opId, { phase: 'PREFLIGHT_OK' }, '经 SFE-ROUTE 的预检通过（Safari 已阻断，Chrome 不命中 SFE-ROUTE）', { environments: [p.targetEnvironmentId] });
    }
    // 执行中受理的普通模式排在本操作之后：放宽入口之前停下，路由（已确认阻断）交给它
    if (yieldToQueuedNormal(engine, opId, '在只开放检测服务（VERIFY_ONLY）之前停下，Safari 保持已确认的阻断')) return;
    // 9. 只开放检测服务（写入之前记下：从此 Safari 可能经 SFE-ROUTE 发出，直到普通模式确认结束连接）
    markSafariMayUseRoute(engine, opId, engine.entryConfig().processPaths);
    await ctrl.transition('VERIFY_ONLY');
    confirmed = 'VERIFY_ONLY';
    const deadline = addSeconds(engine, repos.settings.get('profileArrivalTimeoutSec'));
    repos.tx(() => {
      repos.routeState.update({ entryMode: 'VERIFY_ONLY', entryModeVerifiedAt: engine.nowIso(), phase: 'awaiting_safari_verify', awaitingDeadline: deadline });
      const op = repos.operations.get(opId)!;
      repos.operations.update(opId, {
        phase: 'VERIFY_ONLY',
        status: 'waiting',
        payload: { ...payloadOf(op), route: { ...routePayload(op), stage: 'verify_only', arrivalDeadline: deadline } },
      });
      repos.operations.appendStep(opId, 'VERIFY_ONLY', '只开放检测服务：请在绑定的 Safari 场景中打开扩展完成出口检测');
      repos.outbox.enqueue(opId, 'arrival_timeout', deadline);
    });
    engine.emit({ route: true, operations: [opId], environments: [p.targetEnvironmentId] });
  } catch (err) {
    // 只按最后经运行时求值确认的状态回滚：入口错误带 runtimeConfirmed: false（temp_rule 起点只按结构读回而 rule match 读不到、
    // ruleset_resource 退路）时记下的位不算确认，按 UNKNOWN 回到阻断，不跳过回到阻断就恢复切换前的节点
    const mode = runtimeConfirmedModeFrom(err, confirmed);
    await rollbackActivation(engine, opId, engine.errorBody(err, '切换失败：内部错误'), ctrl, mode);
  }
}

// ---------- Safari 重测 ----------

export async function runProbeSafari(engine: Engine, op: OperationRecord): Promise<void> {
  engine.updateOp(op.id, { status: 'running', phase: 'VALIDATING' }, '开始检查重测条件');
  try {
    await engine.readBasicFacts();
    const ctrl = engine.entryController(() => op.id);
    if (!ctrl) throw new RouteFailure({ code: 'CAPABILITY_UNVERIFIED', message: '重新检测失败：入口策略或 Safari 进程路径尚未确认' });
    await startProbeWaiting(engine, op.id, ctrl);
  } catch (err) {
    const body = failBody(engine, err, '重新检测失败：内部错误');
    // 开始等待时读到 SFE-ROUTE 选择与记录不一致：结束点重读失败时据此改选（observedSelectionOf）
    await endRouteOp(engine, op.id, { phase: 'FAILED', status: 'failed', error: body }, body.message, {}, { observedSelection: observedSelectionOf(err) });
  }
}

/** §6.4：只针对当前 epoch 中 ACTIVE_VERIFIED 的活动环境，读回入口为 ACTIVE、无失控类警告；不写入任何东西。 */
async function startProbeWaiting(engine: Engine, opId: string, ctrl: EntryController): Promise<void> {
  const { repos } = engine;
  const p = routePayload(repos.operations.get(opId)!);
  const route = repos.routeState.get();
  if (route.activeEnvironmentId !== p.targetEnvironmentId || route.phase !== 'active_verified') {
    throw new RouteFailure({ code: 'VALIDATION_FAILED', message: '重新检测失败：该环境不是当前使用中且已验证的环境' });
  }
  const lost = hasAny(route.warnings, LOSS_OF_CONTROL_WARNINGS);
  if (lost.length > 0) throw new RouteFailure({ code: 'UNKNOWN_STATE', message: '重新检测失败：路由已失去控制，请重新使用此环境或进入普通模式', details: { warnings: lost } });
  const readback = await ctrl.read();
  if (readback.mode !== 'ACTIVE') throw new RouteFailure({ code: 'UNKNOWN_STATE', message: '重新检测失败：Safari 入口读回不是使用中模式' });
  const sel = await engine.surge.getGroupSelection(ROUTE_GROUP_NAME);
  if (sel !== route.selectedNode || sel === null) throw new RouteFailure({ code: 'READBACK_MISMATCH', message: '重新检测失败：SFE-ROUTE 选择与记录不一致' }, sel);
  const deadline = addSeconds(engine, repos.settings.get('profileArrivalTimeoutSec'));
  repos.tx(() => {
    const op = repos.operations.get(opId)!;
    repos.operations.update(opId, {
      phase: 'VALIDATING',
      status: 'waiting',
      probeKind: 'safari',
      routeEpoch: route.routeEpoch,
      payload: {
        ...payloadOf(op),
        route: { ...routePayload(op), flow: 'probe', purpose: 'probe_safari', stage: 'probe_waiting', arrivalDeadline: deadline, nodeName: sel, proxyRevision: route.activeProxyRevision ?? p.proxyRevision },
      },
    });
    repos.operations.appendStep(opId, 'VALIDATING', '等待在绑定的 Safari 场景中完成出口检测（不切换、不断连）');
    repos.outbox.enqueue(opId, 'arrival_timeout', deadline);
  });
  engine.emit({ operations: [opId], environments: [p.targetEnvironmentId] });
}

// ---------- 恢复（原生桥消息、计时器、取消） ----------

export async function resumeRoute(engine: Engine, op: OperationRecord, reason: string): Promise<void> {
  if (op.status !== 'waiting') return;
  const p = payloadOf(op).route;
  if (!p) return;
  switch (reason) {
    case 'profile_arrived':
      if (op.phase === 'WAITING_ROUTE') await continueWaitingRoute(engine, op);
      return;
    case 'verify_submitted':
      await completeVerification(engine, op);
      return;
    case 'route_lost':
      await endLostRetest(engine, op);
      return;
    case 'arrival_timeout':
    case 'verify_timeout':
      await handleTimeout(engine, op, reason);
      return;
    case 'cancel':
      await handleCancel(engine, op);
      return;
    default:
      return;
  }
}

async function continueWaitingRoute(engine: Engine, op: OperationRecord): Promise<void> {
  const { repos } = engine;
  // 已受理的取消优先于排在它之前的到达（§6.1）：准备页的到达只把 profile_arrived 排入执行器，操作仍停在 WAITING_ROUTE；执行器忙
  // （周期对账、其他环境的发布或预检）时取消照常受理（202）并排在到达之后。旧请求不能覆盖新请求——看到取消请求就不检查、不切换、
  // 不读也不写 Surge，按取消结束为 READY_FOR_NEXT_OPEN：新版本保持已部署，当前出口不变（弹窗与网页的取消说明据此）
  const latest = repos.operations.get(op.id) ?? op;
  if (latest.status !== 'waiting' || latest.phase !== 'WAITING_ROUTE') return;
  if (routePayload(latest).cancelRequested) {
    engine.step(op.id, '绑定场景已到达，但之后已受理取消：不切换，按取消处理');
    await handleCancel(engine, latest);
    return;
  }
  // 目标版本已被之后的修改替换：不切换到用户已替换的出口
  if (await endReplacedWaitingRoute(engine, latest)) return;
  // 路由忙（其他切换进行中或等待中）：继续等待，从不取代已开始的切换
  const others = repos.operations
    .listByStatus(['queued', 'running', 'waiting'])
    .filter((o) => o.id !== op.id && (o.kind === 'route.activate' || o.kind === 'route.normal' || o.kind === 'probe.safari' || (payloadOf(o).route && !(o.status === 'waiting' && o.phase === 'WAITING_ROUTE'))));
  if (others.length > 0) {
    engine.step(op.id, '场景已到达，等待当前切换完成后再切换到新版本');
    return;
  }
  const p = routePayload(latest);
  const route = repos.routeState.get();
  savePayload(engine, op.id, { stage: 'arrived', expectedActiveEnvironmentId: route.activeEnvironmentId === p.targetEnvironmentId ? p.targetEnvironmentId : p.expectedActiveEnvironmentId });
  engine.updateOp(op.id, { status: 'running', phase: 'VALIDATING' }, '绑定场景已到达：重新检查后切换到新版本');
  try {
    await prepareAndSwitch(engine, op.id, { allowReuse: false });
  } catch (err) {
    await failBeforeSwitch(engine, op.id, failBody(engine, err, '切换到新版本失败：内部错误'));
  }
}

async function handleTimeout(engine: Engine, op: OperationRecord, reason: string): Promise<void> {
  const p = routePayload(op);
  const now = engine.now().getTime();
  if (reason === 'arrival_timeout') {
    // 到达截止时间只在签发检测编号之前有效：签发时写入 verifyDeadline 并安排 verify_timeout，之后由它负责。不按 arrivedAt 判断——
    // 活动环境发布在 WAITING_ROUTE 到达时就写了 arrivedAt，进入切换后的 VERIFY_ONLY 等待（新的到达截止时间）若准备页在签发
    // 之前停下（关闭标签页、开始检测出错），就没有任何截止时间，Safari 一直阻断、检测主机经未验证的新节点发出（§6.3 第 10、14 步）
    if (op.phase !== 'WAITING_ROUTE' && p.verifyDeadline !== null) return;
    if (p.arrivalDeadline === null || Date.parse(p.arrivalDeadline) > now) return;
  } else {
    if (p.verifyDeadline === null || Date.parse(p.verifyDeadline) > now) return;
  }
  if (op.phase === 'WAITING_ROUTE') {
    await endRouteOp(engine, op.id, { phase: 'READY_FOR_NEXT_OPEN', status: 'succeeded' }, '场景未在截止时间内到达：新版本已部署，路由未改变，下次打开时切换');
    return;
  }
  const body: ApiErrorBody = {
    code: 'SAFARI_VERIFY_TIMEOUT',
    message: reason === 'arrival_timeout' ? 'Safari 实测超时：绑定场景未在截止时间内到达' : 'Safari 实测超时：未在截止时间内完成出口检测',
  };
  if (p.flow === 'probe') {
    // 检测截止时间由结束事务按重读的 payload 清除（endRouteOp）
    await endRouteOp(engine, op.id, { phase: 'FAILED', status: 'failed', error: body }, body.message);
    return;
  }
  await rollbackFromWaiting(engine, op.id, body);
}

async function handleCancel(engine: Engine, op: OperationRecord): Promise<void> {
  const p = routePayload(op);
  if (op.phase === 'WAITING_ROUTE') {
    await endRouteOp(engine, op.id, { phase: 'READY_FOR_NEXT_OPEN', status: 'succeeded' }, '已取消切换：新版本已部署，路由未改变', {}, { cancelOutbox: true });
    return;
  }
  const body: ApiErrorBody = { code: 'SUPERSEDED', message: '已取消：切换未完成' };
  if (p.flow === 'probe') {
    await endRouteOp(
      engine,
      op.id,
      { phase: 'FAILED', status: 'failed', error: { ...body, message: '已取消重新检测：路由未改变' } },
      '已取消重新检测，路由未改变',
      {},
      { cancelOutbox: true },
    );
    return;
  }
  // 只写明请求本身：回滚能否恢复原节点并保持阻断要到回滚读回之后才知道（无法确认时改选 REJECT 并要求处理，第 14 步）
  await rollbackFromWaiting(engine, op.id, { ...body, message: '已取消切换' });
}

/**
 * 绑定场景已到达，而等待中的重新检测的路由已不在已验证的使用中状态（verification.ts 排入 route_lost）：这次重测再也无法签发检测
 * 编号（retestRouteLost），立即结束（FAILED），不等到达截止时间、不说「场景未到达」；结束说明与结果按 endRouteOp 写明路由在
 * 等待期间已不在已验证的状态（routeLeftVerified）。已受理的取消优先；路由又已是已验证的（不会发生）时继续等待。
 */
async function endLostRetest(engine: Engine, op: OperationRecord): Promise<void> {
  const latest = engine.repos.operations.get(op.id) ?? op;
  const p = routePayload(latest);
  if (latest.status !== 'waiting' || p.flow !== 'probe' || p.stage !== 'probe_waiting') return;
  if (p.cancelRequested) {
    await handleCancel(engine, latest);
    return;
  }
  if (!retestRouteLost(engine.repos.routeState.get())) return;
  const body: ApiErrorBody = { code: 'UNKNOWN_STATE', message: '重新检测已结束：绑定场景已到达，但无法开始检测' };
  await endRouteOp(engine, op.id, { phase: 'FAILED', status: 'failed', error: body }, body.message, {}, { cancelOutbox: true });
}

async function rollbackFromWaiting(engine: Engine, opId: string, failure: ApiErrorBody): Promise<void> {
  const ctrl = engine.entryController(() => opId);
  const route = engine.repos.routeState.get();
  engine.updateOp(opId, { status: 'running' });
  await rollbackActivation(engine, opId, failure, ctrl, route.entryMode);
}

// ---------- 实测 ----------

/** 签发检测编号前与提交后都要重读 SFE-ROUTE 选择。 */
export async function currentSelection(engine: Engine): Promise<string | null> {
  return engine.surge.getGroupSelection(ROUTE_GROUP_NAME);
}

function browserFailure(p: RoutePayload): string | null {
  const s = p.submission!;
  if (s.error) return `浏览器检测请求失败：${s.error}`;
  if (s.httpStatus === null || s.httpStatus < 200 || s.httpStatus > 299) return '浏览器检测请求失败：检测服务没有返回成功状态';
  if (s.observedIp === null || isIP(s.observedIp) === 0) return '浏览器检测请求失败：没有读到出口 IP';
  return null;
}

async function completeVerification(engine: Engine, op: OperationRecord): Promise<void> {
  const { repos } = engine;
  const p = routePayload(op);
  const sub = p.submission;
  if (!sub) return;
  // 已受理的取消优先于排在它之前的检测结果：提交只把结果排入执行器，操作仍在等待中，执行器忙（对账、其他操作）时取消照常
  // 受理（202）并排在结果之后。旧请求的结果不能覆盖新请求——不核对、不写入 ACTIVE，按取消处理（切换按第 14 步回滚，
  // 重测只结束检测、路由不变）。核对开始后操作已不在等待中，取消按 ROUTE_BUSY 拒绝。
  const latest = repos.operations.get(op.id) ?? op;
  if (routePayload(latest).cancelRequested) {
    engine.step(op.id, '已收到出口检测结果，但之后已受理取消：不核对、不提交，按取消处理');
    await handleCancel(engine, latest);
    return;
  }
  engine.updateOp(op.id, { status: 'running' }, '收到出口检测结果，开始核对');
  const env = repos.environments.get(p.targetEnvironmentId);
  const cfg = engine.entryConfig();
  let failure: ApiErrorBody | null = null;
  let evidence: ReturnType<typeof findVerificationRequest>['match'] = null;
  // 核对读到的 SFE-ROUTE 选择（读不到为 undefined）：重测失败时随结束点传入（EndHoldOptions.observedSelection）
  let observedSelection: string | null | undefined;
  try {
    const sel = await currentSelection(engine);
    observedSelection = sel;
    if (sel !== p.nodeName) failure = { code: 'SAFARI_VERIFY_FAILED', message: 'Safari 实测失败：提交后 SFE-ROUTE 选择已不是目标节点' };
    if (!failure) {
      const bf = browserFailure(p);
      if (bf) failure = { code: 'SAFARI_VERIFY_FAILED', message: bf };
    }
    if (!failure) {
      await engine.deps.demoHooks?.beforeVerificationCheck?.({ verifyHost: cfg.verifyHost, processPaths: cfg.processPaths });
      const records = await engine.surge.listRecentRequests();
      const found = findVerificationRequest(records, {
        processPaths: cfg.processPaths,
        verifyHost: cfg.verifyHost,
        from: new Date(sub.startedAt),
        to: new Date(sub.finishedAt),
        expectedRule: p.flow === 'probe' ? 'active' : 'verify',
        expectedPolicy: 'SFE-ROUTE',
        expectedLeaf: p.nodeName,
      });
      evidence = found.match;
      if (!found.match) failure = { code: 'SAFARI_VERIFY_FAILED', message: `Safari 实测失败：${found.reason}` };
    }
    if (!failure && env?.expectedExitIp && sub.observedIp !== env.expectedExitIp) {
      failure = { code: 'EXIT_IP_MISMATCH', message: 'Safari 实测失败：实际出口与预期出口不一致' };
    }
  } catch (err) {
    failure = engine.errorBody(err, 'Safari 实测失败：读取 Surge 请求记录失败');
  }

  if (p.flow === 'probe') {
    if (!failure) {
      // 通过时出口刚经实测，不改选；记下是同步的
      finishProbe(engine, op.id, p, null, probeEvidence(evidence), null);
      return;
    }
    // 重测失败同样是路由操作的结束点（holdAtRouteEnd），结束点还要读写 Surge：先记下判定（RoutePayload.verdict），期间服务崩溃时
    // 崩溃恢复按它重新结束（recoverRoute），不重新开始检测——否则不符或失败的结果丢失，订单与填充继续
    const verdict: ProbeVerdict = { failure, evidence: probeEvidence(evidence), ...(observedSelection !== undefined ? { observedSelection } : {}) };
    savePayload(engine, op.id, { verdict });
    const hold = await holdAtRouteEnd(engine, op.id, { observedSelection });
    finishProbe(engine, op.id, p, failure, verdict.evidence, hold);
    return;
  }
  if (failure) {
    await rollbackFromWaitingRunning(engine, op.id, failure);
    return;
  }
  // 13. 入口 → ACTIVE（读回）→ 提交
  // 等待期间激活门槛可能已失效（能力被重置、Surge/Safari/macOS 更新使记录过期）：写入 ACTIVE 之前重新检查。
  // 这里的意外异常（读取事实、数据库读取等）同样按第 14 步回滚：否则执行器只把操作标为失败，路由停在
  // awaiting_safari_verify、无人负责，也不会超时。
  let ctrl: EntryController | null = null;
  let precheckFailure: ApiErrorBody | null = null;
  try {
    // 等待期间目标版本已被之后的修改替换（又改了代理、更新的版本已部署）：不把 Safari 放到用户已替换的出口上，按第 14 步回滚
    const replaced = replacedTarget(engine, p);
    if (replaced) {
      precheckFailure = { code: 'NODE_NOT_DEPLOYED', message: `切换失败：${replaced}，未进入使用中模式` };
    } else {
      await engine.readBasicFacts();
      const missing = engine.activationMissing();
      if (missing.length > 0) {
        precheckFailure = capabilityFailure(engine, missing, '切换失败：', '在等待期间已不再满足激活条件');
      } else {
        ctrl = engine.entryController(() => op.id);
        if (!ctrl) precheckFailure = { code: 'CAPABILITY_UNVERIFIED', message: '切换失败：入口策略已变化' };
      }
    }
  } catch (err) {
    precheckFailure = engine.errorBody(err, '切换失败：写入使用中模式之前重新检查激活条件出错');
  }
  if (precheckFailure || !ctrl) {
    await rollbackFromWaitingRunning(engine, op.id, precheckFailure ?? { code: 'CAPABILITY_UNVERIFIED', message: '切换失败：入口策略已变化' });
    return;
  }
  // 核对期间受理的普通模式排在本操作之后：不写入 ACTIVE、不提交（否则普通模式受理时针对的使用中环境已被换掉），路由交给它
  if (yieldToQueuedNormal(engine, op.id, '实测已通过核对，但在进入使用中模式（ACTIVE）之前停下，未提交')) return;
  try {
    // 写入之前记下（同一事务）：从此 Safari 可能经 SFE-ROUTE 发出（持久标记），目标环境的窗口可能经过它的出口——之后回滚时据此
    // 带旧窗口警告（activeWrittenUncovered）
    repos.tx(() => {
      markSafariMayUseRoute(engine, op.id, engine.entryConfig().processPaths);
      savePayload(engine, op.id, { activeWriteStarted: true });
    });
    await ctrl.transition('ACTIVE');
  } catch (err) {
    await rollbackActivation(engine, op.id, engine.errorBody(err, '切换失败：进入使用中模式失败'), ctrl, runtimeConfirmedModeFrom(err, 'VERIFY_ONLY'));
    return;
  }
  // 写入 ACTIVE 期间受理的普通模式：同样不提交；入口已读回确认为 ACTIVE，记入路由后交给普通模式。此时 Safari 的全部请求
  // （含目标场景中已打开的窗口）已经过目标环境的出口，而普通模式受理时的旧窗口确认针对的是当时的使用中环境：把目标环境记入
  // 普通模式，完成时它的窗口按 Surge 原规则发出、路由带警告（runNormal）
  if (
    yieldToQueuedNormal(
      engine,
      op.id,
      '入口已进入使用中模式（ACTIVE，读回确认），在提交之前停下，未提交',
      { entryMode: 'ACTIVE', entryModeVerifiedAt: engine.nowIso() },
      '由普通模式撤销本应用入口并结束 Safari 连接；目标环境的窗口已经过它的出口，普通模式完成后其后续请求按 Surge 原规则发出（可能直连）',
      { activeWrittenTarget: p.targetEnvironmentId },
    )
  )
    return;
  try {
    commitActive(engine, op.id, p, evidence);
  } catch (err) {
    // 提交事务失败（例如数据库错误）：入口已读回为 ACTIVE 但没有记录。仍负责过渡中的路由时按快照回滚并保持阻断；
    // 提交已生效（之后的事件发布出错）时不回滚已验证的路由。
    if (!ownsTransition(engine.repos.routeState.get(), op.id)) throw err;
    await rollbackActivation(engine, op.id, engine.errorBody(err, '切换失败：提交使用中状态失败'), ctrl, 'ACTIVE');
    return;
  }
  // 提交清除了失控类警告（显式激活重新建立控制）：立即对账一次，让仍然成立的事实类警告马上重新出现
  try {
    await reconcile(engine, 'precheck');
  } catch (err) {
    engine.log('warn', 'reconcile.failed', { error: err instanceof Error ? err.name : 'unknown' });
  }
}

async function rollbackFromWaitingRunning(engine: Engine, opId: string, failure: ApiErrorBody): Promise<void> {
  const ctrl = engine.entryController(() => opId);
  await rollbackActivation(engine, opId, failure, ctrl, engine.repos.routeState.get().entryMode);
}

function probeEvidence(evidence: ReturnType<typeof findVerificationRequest>['match']): SafariProbeEvidence {
  if (!evidence) return {};
  return {
    surgeRequestId: evidence.id,
    surgeRemoteHost: evidence.remoteHost,
    surgeRule: evidence.rule,
    surgePolicy: evidence.policyName,
    surgeStartedAt: evidence.startedAt ? evidence.startedAt.toISOString() : null,
    // 6.5 能否区分新连接由 P0 确认；此处只记录未知
    surgeNewConnection: null,
  };
}

function insertSafariProbe(
  engine: Engine,
  opId: string,
  p: RoutePayload,
  outcome: 'ok' | 'failed' | 'mismatch',
  entryMode: EntryMode,
  routeEpoch: number,
  evidence: SafariProbeEvidence,
  message: string | null,
) {
  const now = engine.now();
  const sub = p.submission!;
  return engine.repos.probes.insert({
    id: engine.ids.next('probe'),
    environmentId: p.targetEnvironmentId,
    kind: 'safari',
    outcome,
    exitIp: sub.observedIp,
    proxyRevision: p.proxyRevision,
    nodeName: p.nodeName,
    routeEpoch,
    configurationGeneration: engine.repos.meta.configurationGeneration(),
    entryMode,
    testId: sub.testId,
    operationId: opId,
    ...evidence,
    chainEvidence: '出口由 Safari 场景实测；前置链路依赖 external_node_underlying_proxy 实测，不以出口 IP 作为链路证明',
    browserHttpStatus: sub.httpStatus,
    browserStartedAt: sub.startedAt,
    browserFinishedAt: sub.finishedAt,
    browserError: sub.error,
    message,
    observedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + engine.repos.settings.get('probeTtlSec') * 1000).toISOString(),
  });
}

/**
 * Safari 重测开始检测时把实测截止时间写入路由记录（beginVerification），但重测不负责路由：结束（通过、失败、超时、取消）时清除
 * 这一次写入的值，否则路由视图之后一直带着这个早已过去的时间。只清除与本次实测截止时间相同的值（不碰其他操作写入的截止时间）。
 */
function probeDeadlineCleared(route: RouteStateRecord, p: RoutePayload): { awaitingDeadline?: null } {
  return p.verifyDeadline !== null && route.awaitingDeadline === p.verifyDeadline ? { awaitingDeadline: null } : {};
}

function finishProbe(
  engine: Engine,
  opId: string,
  p: RoutePayload,
  failure: ApiErrorBody | null,
  evidence: SafariProbeEvidence,
  hold: RejectHold | null = null,
): void {
  const { repos } = engine;
  const route = repos.routeState.get();
  if (!failure) {
    repos.tx(() => {
      insertSafariProbe(engine, opId, p, 'ok', 'ACTIVE', route.routeEpoch, evidence, 'Safari 重测通过');
      const warnings = route.warnings.filter((w) => w !== 'probe_expired' && w !== 'probe_failed' && w !== 'exit_ip_mismatch');
      repos.routeState.update({ warnings, ...probeDeadlineCleared(route, p) });
      repos.operations.update(opId, { phase: 'ACTIVE_VERIFIED', status: 'succeeded', resultRevision: p.proxyRevision });
      repos.operations.appendStep(opId, 'ACTIVE_VERIFIED', 'Safari 重测通过：实测已更新');
      repos.outbox.cancelForOperation(opId);
    });
    engine.emit({ operations: [opId], environments: [p.targetEnvironmentId], route: true });
    return;
  }
  // 失败或不符：记录、加警告、停止填充与自动打开；从不自动切换、阻断或进入 NORMAL
  const mismatch = failure.code === 'EXIT_IP_MISMATCH';
  repos.tx(() => {
    if (p.submission) insertSafariProbe(engine, opId, p, mismatch ? 'mismatch' : 'failed', 'ACTIVE', route.routeEpoch, evidence, failure.message);
    const w: RouteWarning = mismatch ? 'exit_ip_mismatch' : 'probe_failed';
    repos.routeState.update({ warnings: [...route.warnings, w], ...probeDeadlineCleared(route, p) });
    // 记下加到路由上的警告：准备页只在有它时说「已停止自动打开订单与填充」（取消、超时与开始等待之前的失败不加警告，路由与
    // 之前的检测结果都不变）
    // 结束点改选了 SFE-ROUTE（holdAtRouteEnd）：路由已改变，按 heldEnd 结束为需要处理
    recordEndHold(engine, opId, hold);
    const cur = repos.operations.get(opId)!;
    // 核对期间对账已把路由改为不再已验证（Surge 重启、出站模式改变等）：不说「路由未改变」，写明路由的状态（routeLeftVerified）
    const left = retestRouteLeftVerified(engine, p, hold);
    const end = hold
      ? heldEnd({ phase: 'FAILED', status: 'failed', error: failure }, `${failure.message}；已停止自动打开订单与填充，路由未改变`, hold)
      : {
          patch: { phase: 'FAILED' as const, status: 'failed' as const, error: failure },
          step: left ? `${failure.message}${retestLostNote(left)}` : `${failure.message}；已停止自动打开订单与填充，路由未改变`,
        };
    repos.operations.update(opId, {
      ...end.patch,
      result: { ...(cur.result ?? {}), probeWarning: w, ...(hold ? { rejectSelected: hold.confirmed } : {}), ...(left ? { routeLeftVerified: left } : {}) },
    });
    repos.operations.appendStep(opId, end.patch.phase!, end.step);
    repos.outbox.cancelForOperation(opId);
  });
  engine.emit({ operations: [opId], environments: [...new Set([p.targetEnvironmentId, ...(route.activeEnvironmentId ? [route.activeEnvironmentId] : [])])], route: true });
}

function commitActive(engine: Engine, opId: string, p: RoutePayload, evidence: ReturnType<typeof findVerificationRequest>['match']): void {
  const { repos } = engine;
  const route = repos.routeState.get();
  const firstRequestOk = engine.missing(['first_request_and_old_connections']).length === 0;
  const takeoverUnknown = engine.facts.takeover.enhancedMode === null && engine.facts.takeover.systemProxy === null;
  // 受控激活重新建立了控制：清除之前的失控、回滚与窗口类警告，再按本次情况重新附加
  const cleared: RouteWarning[] = route.warnings.filter((w) => w === 'launch_unverified');
  const warnings: RouteWarning[] = [];
  const amazon = p.amazonTabsAtLaunch === true || p.amazonTabsAtVerify === true;
  const reportedClean = p.amazonTabsAtLaunch === false || p.amazonTabsAtVerify === false;
  if (amazon || (cleared.includes('launch_unverified') && !reportedClean)) warnings.push('launch_unverified');
  if (!firstRequestOk) warnings.push('launch_order_unverified');
  if (p.crossEnvironment && !firstRequestOk) warnings.push('old_session_unproven');
  if (p.oldSessionPolicy === 'keep_open_acknowledged') warnings.push('old_windows_kept_open');
  if (takeoverUnknown) warnings.push('takeover_unknown');
  // 普通模式未能确认 Safari 已离开买家出口的警告：只有本次激活第 7 步在已确认的阻断下结束了全部 Safari 连接（含持久标记中
  // 被换掉的进程路径上可能经买家出口的连接）时才清除；否则（升级前已在进行中的激活）之前买家出口上的连接仍可能存在
  if (route.warnings.includes('buyer_exit_connections_unconfirmed') && p.safariConnectionsEnded !== true) warnings.push('buyer_exit_connections_unconfirmed');
  repos.tx(() => {
    repos.routeState.update({
      activeEnvironmentId: p.targetEnvironmentId,
      activeProxyRevision: p.proxyRevision,
      phase: 'active_verified',
      entryMode: 'ACTIVE',
      entryModeVerifiedAt: engine.nowIso(),
      selectedNode: p.nodeName,
      oldSessionPolicy: p.oldSessionPolicy,
      operationId: opId,
      awaitingDeadline: null,
      activationSnapshot: null,
      warnings,
    });
    const after = repos.routeState.get();
    insertSafariProbe(engine, opId, p, 'ok', 'VERIFY_ONLY', after.routeEpoch, probeEvidence(evidence), 'Safari 实测通过');
    repos.environments.update(p.targetEnvironmentId, { lastVerifiedProxyRevision: p.proxyRevision });
    repos.operations.update(opId, { phase: 'ACTIVE_VERIFIED', status: 'succeeded', resultRevision: p.proxyRevision, payload: { ...payloadOf(repos.operations.get(opId)!), route: { ...p, stage: 'done' } } });
    repos.operations.appendStep(opId, 'ACTIVE_VERIFIED', `已切换并通过 Safari 实测${warnings.length ? `（警告：${warnings.join('、')}）` : ''}`);
    repos.outbox.cancelForOperation(opId);
  });
  const envs = [p.targetEnvironmentId];
  if (route.activeEnvironmentId && route.activeEnvironmentId !== p.targetEnvironmentId) envs.push(route.activeEnvironmentId);
  engine.emit({ operations: [opId], environments: envs, route: true });
}

// ---------- 回滚（§6.3 第 14 步） ----------

export async function rollbackActivation(engine: Engine, opId: string, failure: ApiErrorBody, ctrl: EntryController | null, confirmed: EntryMode): Promise<void> {
  const { repos } = engine;
  const op = repos.operations.get(opId)!;
  const p = routePayload(op);
  const before = repos.routeState.get();
  const snapshot = before.activationSnapshot;
  // 回到阻断会改写被外部修改的本应用入口文件（§5.5），但不清除这一事实
  const segmentsChanged = await segmentsChangedBefore(engine, before);
  repos.routeState.update({ phase: 'rolling_back', entryMode: confirmed });
  engine.updateOp(
    opId,
    { phase: 'ROLLING_BACK', status: 'running' },
    `${failure.message}；开始回滚：尝试回到阻断并恢复切换前的节点（回到阻断无法确认时不恢复，SFE-ROUTE 改选 REJECT，并要求处理）`,
    { route: true },
  );
  try {
    if (!ctrl) throw new SfeError('UNKNOWN_STATE', '回滚失败：入口控制器不可用');
    let needsBlock = confirmed !== 'BLOCKED';
    if (!needsBlock) {
      // 记下的阻断来自之前的读回：之后可能有规则排到了本应用入口之前（用户启用或模块自动更新、其他工具 `rule temp add`，
      // 抢先匹配的 Safari 请求按它们发出，可能直连），或 rule match 已读不到。恢复切换前的节点、声称 Safari 保持阻断之前重新读回；
      // 不再是经运行时求值确认、没有规则排在入口之前的阻断（或读不到）时，与下面一样按撤销入口回到阻断——它的最终读回如实
      // 报告：只因有规则排在入口之前而不能确认（PRECEDENCE_VIOLATION，失败处理列出这些规则并改选 REJECT），或未经运行时求值
      // 确认（holdUnconfirmedRollback）
      const now = await ctrl.read().catch(() => null);
      needsBlock = now === null || now.mode !== 'BLOCKED' || now.runtimeConfirmed === false;
      if (needsBlock) {
        const why =
          now === null
            ? '读回失败'
            : hasBlockingIssue(now.precedenceIssues)
              ? `有 ${blockingCount(now.precedenceIssues)} 条规则排在本应用入口之前`
              : `读回为 ${now.mode}${now.runtimeConfirmed === false ? '（未经运行时求值确认）' : ''}`;
        engine.step(opId, `恢复切换前的节点之前重新读回入口：已不能确认阻断（${why}），按撤销入口重新回到阻断`);
      }
    }
    if (needsBlock) {
      // 从 VERIFY_ONLY/未知状态回到阻断（撤销入口：可改写被外部修改的本应用入口文件）；绝不走向 NORMAL
      const rb = await ctrl.transition('BLOCKED', undefined, undoOptions(engine, opId));
      // 撤销入口时 rule match 读不到：阻断只按结构读回或写入与等待完成（EntryReadback.runtimeConfirmed），不能当作已阻断
      if (rb.runtimeConfirmed === false) {
        await holdUnconfirmedRollback(engine, opId, failure, segmentsChanged, ctrl.strategy);
        return;
      }
    }
    repos.routeState.update({ entryMode: 'BLOCKED', entryModeVerifiedAt: engine.nowIso() });
    const hasPrevious = snapshot !== null && snapshot.previousEnvironmentId !== null && snapshot.previousSelectedNode !== null;
    let restored: string | null;
    if (hasPrevious) {
      const members = await engine.surge.getGroupMembers(ROUTE_GROUP_NAME);
      if (!members.includes(snapshot!.previousSelectedNode!)) throw new SfeError('READBACK_MISMATCH', '回滚失败：切换前的节点已不在 SFE-ROUTE 中');
      await engine.surge.selectGroupPolicy(ROUTE_GROUP_NAME, snapshot!.previousSelectedNode!);
      restored = await engine.surge.getGroupSelection(ROUTE_GROUP_NAME);
      if (restored !== snapshot!.previousSelectedNode) throw new SfeError('READBACK_MISMATCH', '回滚失败：恢复后的选择读回不一致');
    } else {
      restored = await engine.surge.getGroupSelection(ROUTE_GROUP_NAME);
    }
    const prevProbe = snapshot?.previousSafariProbeId ? repos.probes.get(snapshot.previousSafariProbeId) : null;
    const rollback: RollbackResult = {
      previousEnvironmentId: hasPrevious ? snapshot!.previousEnvironmentId : null,
      previousProxyRevision: hasPrevious ? snapshot!.previousProxyRevision : null,
      previousProbe: prevProbe ? probeView(prevProbe) : null,
      restoredSelection: restored,
      entryModeAfter: 'BLOCKED',
      failedProxyRevision: p.proxyRevision,
      failureError: failure,
      needsReverify: hasPrevious,
    };
    const written = activeWrittenUncovered(engine, opId, hasPrevious ? snapshot!.previousEnvironmentId : null);
    repos.tx(() => {
      // 普通模式未能确认 Safari 已离开买家出口的警告随持久标记保留：回滚不结束连接，第 7 步之后 Safari 可能已经经 SFE-ROUTE
      // 建立连接（检测），第 7 步也可能没有完成；由下一次普通模式结束。在事务中重读：回滚的 Surge 调用期间受理处理器可能已改过
      // 警告（例如确认旧窗口已关闭）
      const keep: RouteWarning[] = repos.routeState
        .get()
        .warnings.filter((w) => w === 'managed_windows_on_original_rules' || w === 'takeover_unknown' || w === 'buyer_exit_connections_unconfirmed');
      if (segmentsChanged) keep.push('managed_segments_changed');
      if (written && !keep.includes('managed_windows_on_original_rules')) keep.push('managed_windows_on_original_rules');
      repos.routeState.update({
        phase: 'failed',
        entryMode: 'BLOCKED',
        activeEnvironmentId: hasPrevious ? snapshot!.previousEnvironmentId : null,
        activeProxyRevision: hasPrevious ? snapshot!.previousProxyRevision : null,
        selectedNode: restored,
        awaitingDeadline: null,
        operationId: opId,
        // 切换前状态已恢复并成为路由记录：快照用完即清除（快照仍在表示上一次切换没有回到已确认状态，见 routeSnapshot）
        activationSnapshot: null,
        warnings: hasPrevious ? [...keep, 'rollback_needs_reverify'] : keep,
      });
      const cur = repos.operations.get(opId)!;
      repos.operations.update(opId, { phase: 'FAILED', status: 'failed', error: failure, result: { ...(cur.result ?? {}), rollback } });
      repos.operations.appendStep(
        opId,
        'FAILED',
        `${hasPrevious ? '已回滚：恢复切换前的节点，Safari 保持阻断，需要重新核验' : '切换失败：切换前没有已验证的路由，Safari 保持阻断'}${written ? `；${activeWrittenNote(written)}` : ''}`,
      );
      repos.outbox.cancelForOperation(opId);
    });
    const envs = [p.targetEnvironmentId];
    if (hasPrevious) envs.push(snapshot!.previousEnvironmentId!);
    engine.emit({ operations: [opId], environments: envs, route: true });
  } catch (err) {
    const current = repos.routeState.get();
    const mode = runtimeConfirmedModeFrom(err, current.entryMode === 'NORMAL' ? 'UNKNOWN' : current.entryMode);
    // 回到阻断的最终读回只因有规则排在本应用入口之前而不能确认（PRECEDENCE_VIOLATION；入口位已读回为阻断）：Safari 中被这些规则
    // 匹配的请求按它们发出（可能直连），不能声称 Safari 保持阻断；如实写明并带 precedence_violation（与普通模式的中间阻断相同）
    const precedence = precedenceIssuesOf(err);
    // 只说读回确认过的：最后确认的可能不是阻断（例如回到阻断的第一步就失败，停在 VERIFY_ONLY）
    const where = precedence
      ? `入口${mode === 'BLOCKED' ? '位已读回为阻断' : '状态未知'}，但有${blockingCount(precedence) > 0 ? ` ${blockingCount(precedence)} 条` : ''}规则排在本应用入口之前（见操作结果）：Safari 中被这些规则匹配的请求按它们发出（可能直连），不能确认 Safari 保持阻断`
      : mode === 'BLOCKED'
        ? 'Safari 保持已确认的阻断'
        : mode === 'UNKNOWN'
          ? '入口状态未知'
          : `入口停在最后读回确认的状态（${mode}）`;
    // 最后经运行时求值确认的不是阻断或普通模式（回到阻断失败或超时——例如比时限慢的文件监视、入口控制器不可用）：Surge 可能
    // 仍加载着 VERIFY_ONLY/ACTIVE，而 SFE-ROUTE 选着本次切换写入的未验证节点，Safari（至少检测主机）会在切换结束之后经它发出。
    // 与 holdUnconfirmedRollback 相同，失败即关闭：尽力改选 REJECT 并读回（从不抛出），只有读回确认才记为 REJECT，说明如实写明；
    // 已建立的连接不受改选影响，带 buyer_exit_connections_unconfirmed（holdExistingConnections）。
    // 不恢复切换前的节点，激活快照保留（之后的激活与回滚仍从最初的切换前状态出发）。有规则排在入口之前时同样改选：入口位即使
    // 已是阻断，排在它之前的规则也可能把 Safari 请求交给 SFE-ROUTE，而它选着本次切换写入的未验证节点。
    const hold = (mode === 'BLOCKED' || mode === 'NORMAL') && !precedence ? null : await selectRejectBestEffort(engine);
    const written = activeWrittenUncovered(engine, opId, repos.routeState.get().activeEnvironmentId);
    const body: ApiErrorBody = {
      code: 'UNKNOWN_STATE',
      message: `回滚无法确认：${where}，需要处理${hold ? `；${rejectHoldText(hold)}；${EXISTING_CONNECTIONS_TEXT}` : ''}${written ? `；${activeWrittenNote(written)}` : ''}`,
      details: { cause: failure.code, ...(hold ? { rejectSelected: hold.confirmed } : {}) },
    };
    repos.tx(() => {
      // 在事务中重读路由：改选 REJECT 的 Surge 调用期间，受理处理器可能已改过警告（确认旧窗口已关闭、预期出口重新比较）
      const fresh = repos.routeState.get();
      // 之前一次成功回滚留下的 rollback_needs_reverify（「已恢复原节点并保持阻断」）已不成立：之后又开始了切换，这次没有恢复节点
      const warnings = new Set<RouteWarning>(fresh.warnings.filter((w) => w !== 'rollback_needs_reverify'));
      warnings.add('entry_unverified');
      if (precedence) warnings.add('precedence_violation');
      if (segmentsChanged) warnings.add('managed_segments_changed');
      if (hold) holdExistingConnections(engine, opId, warnings);
      if (written) warnings.add('managed_windows_on_original_rules');
      repos.routeState.update({
        phase: 'attention',
        entryMode: mode,
        awaitingDeadline: null,
        operationId: opId,
        ...(hold?.confirmed ? { selectedNode: 'REJECT' } : {}),
        warnings: [...warnings],
      });
      const cur = repos.operations.get(opId)!;
      repos.operations.update(opId, {
        phase: 'BLOCKED_NEEDS_ATTENTION',
        status: 'needs_attention',
        error: body,
        result: { ...(cur.result ?? {}), failure, ...(precedence ? { precedenceIssues: engine.scrubber.scrubDeep(precedence) } : {}) },
      });
      repos.operations.appendStep(opId, 'BLOCKED_NEEDS_ATTENTION', body.message);
      repos.outbox.cancelForOperation(opId);
    });
    engine.emit({ operations: [opId], environments: [p.targetEnvironmentId], route: true });
  }
}

/**
 * 回滚回到阻断未经运行时求值确认（EntryReadback.runtimeConfirmed: false：rule match 读不到或当前 Surge 不支持；ruleset_resource
 * 的退路只是按计划写入并等满文件监视上限，监视比上限慢时 Surge 仍加载着写入之前的入口——VERIFY_ONLY/ACTIVE，或切换前的
 * 普通模式；temp_rule 的每一步已按临时规则列表与有效规则顺序读回，只是 Surge 实际如何匹配没有经求值确认）。这时不能声称 Safari
 * 保持阻断，也不能恢复切换前的节点：仍加载的 VERIFY_ONLY/ACTIVE 会让 Safari（至少检测主机）经之前买家的出口发出（§6.3 第 14 步：
 * 从不回退到其他买家出口）。SFE-ROUTE 改选首成员 REJECT 并读回——不论 Surge 加载的是哪一版本应用入口，经 SFE-ROUTE 的 Safari
 * 新连接都被拒绝（已建立的连接不受影响：holdExistingConnections）；不恢复切换前的节点，激活快照保留（之后的激活与回滚仍从最初的
 * 切换前状态出发），路由 attention、入口记为 UNKNOWN（文件已写入阻断，Surge 加载的是哪一版未知；不记为 BLOCKED——之后的激活在
 * 写入失败时会把记录的 BLOCKED 当作已确认，跳过回到阻断就恢复切换前的节点）并带 entry_unverified，操作 BLOCKED_NEEDS_ATTENTION，
 * 说明如实写明（按入口策略，unconfirmedLoadText）。之前一次成功回滚留下的 rollback_needs_reverify 不再成立，去掉。
 * 改选或读回失败不抛出（selectRejectBestEffort）：不记为 REJECT，说明写明 Safari 请求可能仍经 SFE-ROUTE 当前选择的买家出口发出。
 */
async function holdUnconfirmedRollback(
  engine: Engine,
  opId: string,
  failure: ApiErrorBody,
  segmentsChanged: boolean,
  strategy: EntryController['strategy'],
): Promise<void> {
  const { repos } = engine;
  const load = unconfirmedLoadText(strategy, '之前是普通模式时 Safari 仍按原规则发出');
  engine.step(opId, `回到阻断：入口已按计划写入阻断，但${UNCONFIRMED_ENTRY_TEXT}，${load}`);
  const hold = await selectRejectBestEffort(engine);
  const p = routePayload(repos.operations.get(opId)!);
  const written = activeWrittenUncovered(engine, opId, repos.routeState.get().activeEnvironmentId);
  const body: ApiErrorBody = {
    code: 'UNKNOWN_STATE',
    message:
      `回滚未能确认：入口已按计划写入阻断，但未经运行时求值确认，${load}；` +
      (hold.confirmed
        ? '未恢复切换前的节点，SFE-ROUTE 已改选 REJECT（读回确认），经 SFE-ROUTE 的 Safari 新连接都被拒绝、不会经任何买家出口建立'
        : `未恢复切换前的节点，但 SFE-ROUTE 未能改选 REJECT（${hold.error ?? '原因未知'}），Safari 请求（至少检测主机）可能仍经 SFE-ROUTE 当前选择的买家出口发出`) +
      `；${EXISTING_CONNECTIONS_TEXT}${written ? `；${activeWrittenNote(written)}` : ''}。需要处理：进入普通模式，或等 rule match 可用后重新使用环境`,
    details: { cause: failure.code, rejectSelected: hold.confirmed },
  };
  repos.tx(() => {
    const current = repos.routeState.get();
    const warnings = new Set<RouteWarning>(current.warnings.filter((w) => w !== 'rollback_needs_reverify'));
    if (segmentsChanged) warnings.add('managed_segments_changed');
    warnings.add('entry_unverified');
    holdExistingConnections(engine, opId, warnings);
    if (written) warnings.add('managed_windows_on_original_rules');
    repos.routeState.update({
      phase: 'attention',
      entryMode: 'UNKNOWN',
      ...(hold.confirmed ? { selectedNode: 'REJECT' } : {}),
      awaitingDeadline: null,
      operationId: opId,
      warnings: [...warnings],
    });
    const cur = repos.operations.get(opId)!;
    repos.operations.update(opId, { phase: 'BLOCKED_NEEDS_ATTENTION', status: 'needs_attention', error: body, result: { ...(cur.result ?? {}), failure } });
    repos.operations.appendStep(opId, 'BLOCKED_NEEDS_ATTENTION', body.message);
    repos.outbox.cancelForOperation(opId);
  });
  const envs = [p.targetEnvironmentId];
  const prev = repos.routeState.get().activationSnapshot?.previousEnvironmentId;
  if (prev && prev !== p.targetEnvironmentId) envs.push(prev);
  engine.emit({ operations: [opId], environments: envs, route: true });
}

// ---------- 普通模式（§6.5） ----------

export async function runNormal(engine: Engine, op: OperationRecord): Promise<void> {
  const { repos } = engine;
  const np = payloadOf(op).normal;
  engine.updateOp(op.id, { status: 'running', phase: 'VALIDATING' }, '开始进入普通模式');
  const initial = repos.routeState.get();
  // 受理之后使用中的环境换成了另一个环境：旧窗口确认针对的不是它，要求重新确认。已没有使用中的环境（例如受理时排在其后的
  // 回滚没有可恢复的切换前路由）时不需要确认，照常执行。
  if (initial.activeEnvironmentId !== null && initial.activeEnvironmentId !== (np?.expectedActiveEnvironmentId ?? null)) {
    const details = confirmationNeeded(engine, null);
    const body = details
      ? needsConfirmationError('进入普通模式', details).toBody()
      : { code: 'NEEDS_CONFIRMATION' as const, message: '进入普通模式需要重新确认：使用中的环境已变化' };
    // 不碰入口；这同样是路由操作的结束点（holdAtRouteEnd）
    await endRouteOp(engine, op.id, { phase: 'FAILED', status: 'failed', error: body }, body.message);
    return;
  }
  // 受理时排在正在执行的路由操作之后（§6.3 并发矩阵）：其间停在等待中的激活与重测（VERIFY_ONLY 等待、重测等待）、WAITING_ROUTE
  // 与受理时一样结束（SUPERSEDED / READY_FOR_NEXT_OPEN），由本次普通模式从当前状态撤销本应用入口；否则之后提交的实测会让已被
  // 普通模式撤销的切换重新写入 ACTIVE。受理时已结束的不在其中。
  const waiting = routeOps(engine);
  if (waiting.waitingVerification.length > 0 || waiting.waitingRoute.length > 0) {
    const touched = repos.tx(() => supersedeWaiting(engine, op.id, { busy: [], waitingVerification: waiting.waitingVerification, waitingRoute: waiting.waitingRoute }));
    engine.step(op.id, '结束受理之后停在等待中的切换或检测（检测编号作废），由本次普通模式撤销本应用入口');
    engine.emit({ operations: touched, route: true, environments: waitingEnvironments(waiting) });
  }
  endQueuedBefore(engine, op);
  const route = repos.routeState.get();
  const ctrl = engine.entryController(() => op.id);
  let confirmed: EntryMode = route.entryMode;
  /** 撤销入口时 rule match 读不到，NORMAL 只按写入与等待完成（EntryReadback.runtimeConfirmed）：路由状态带 entry_unverified。 */
  let normalUnconfirmed = false;
  /** 入口已不确定阻断 Safari 时是否仍要结束 Safari 连接（safariMayUseRoute）。 */
  const mayUseRoute = safariMayUseRoute(engine, route);
  /** 本次普通模式结束过 Safari 连接（killForNormal 已执行）。 */
  let killAttempted = false;
  /** 结束连接确认完成：没有失败、没有未能确认结束的连接。 */
  let killsEnded = false;
  /** 结束连接时本应用入口经运行时求值确认（阻断，或已是普通模式）：否则 Surge 可能仍加载着写前的入口。 */
  let entryConfirmedAtKill = false;
  /**
   * 收紧（verify/active 关闭）没有经运行时求值确认、而 Safari 可能经过 SFE-ROUTE：rule match 不可用的退路只是写入并等满文件
   * 监视上限，监视比上限慢时 Surge 在普通模式完成之后仍可能加载着检测或使用中入口。
   */
  let tighteningUnconfirmed = false;
  /** 中间阻断时有规则排在本应用入口之前（读回不能确认完全阻断）：失败时路由带 precedence_violation 与 entry_unverified。 */
  let precedenceSeen = false;
  /**
   * 本次写入的中间阻断未经运行时求值确认（confirmed 记为 UNKNOWN）：之后撤销入口失败时，错误中的最后确认位（例如 temp_rule
   * 的起点只按临时规则列表与有效规则顺序读出、没有经 rule match 求值）不能把它升级为已确认的 BLOCKED（§6.5）。
   */
  let blockUnconfirmed = false;
  const kill = async (entryBlocksSafari: boolean, entryConfirmed: boolean): Promise<void> => {
    killAttempted = true;
    entryConfirmedAtKill = entryConfirmed;
    killsEnded = await killForNormal(engine, op.id, entryBlocksSafari);
  };
  // 撤销入口会改写被外部修改的本应用入口文件（§5.5），但保留 managed_segments_changed
  const segmentsChanged = await segmentsChangedBefore(engine, route);
  try {
    if (ctrl) {
      const readback = await ctrl.read();
      if (readback.mode !== 'NORMAL') {
        repos.routeState.update({ phase: 'switching', operationId: op.id });
        const changedFiles = readback.changedOwnedFiles ?? [];
        if (changedFiles.length > 0) {
          const cur = repos.operations.get(op.id)!;
          repos.operations.update(op.id, { result: { ...(cur.result ?? {}), changedEntryFiles: changedFiles } });
          engine.step(op.id, `本应用的入口文件已被外部修改（${changedFiles.join('、')}）：撤销入口时按读到的内容比较后改写`);
        }
        const blocked = await blockForNormal(ctrl, undoOptions(engine, op.id));
        const { precedenceIssues, runtimeConfirmed: blockConfirmed, alreadyNormal, blockKeptOff } = blocked;
        precedenceSeen = precedenceIssues !== null;
        const recordPrecedence = (): void => {
          if (!precedenceIssues) return;
          const cur = repos.operations.get(op.id)!;
          repos.operations.update(op.id, { result: { ...(cur.result ?? {}), precedenceIssues: engine.scrubber.scrubDeep(precedenceIssues) } });
        };
        if (blockKeptOff) {
          // 上一次普通模式在 NORMAL 一段写入、超时后保留的 block 关闭尚未加载（EntryReadback.keptTowardNormal）：本应用入口的
          // verify/active 已由见证确认关闭；Surge 已加载的是阻断或已是普通模式，不记录为 BLOCKED，也不重新打开 block（重新收紧会让
          // 比时限慢的监视在每次重试之间来回写入）。有规则排在入口之前时与下面的 BLOCKED 一样记入结果，步骤不声称 Safari 新请求
          // 不会经 SFE-ROUTE。照常结束 Safari 可能经买家出口的旧连接（入口不确定阻断 Safari：按原规则发出、重连的连接不碰），再撤销入口。
          recordPrecedence();
          engine.step(
            op.id,
            precedenceIssues
              ? `中间阻断不再写入：本应用入口的 verify/active 已确认关闭，上一次保留的 block 关闭尚未确认加载（Surge 已加载的是阻断或已是普通模式），不重新打开 block；但有 ${blockingCount(precedenceIssues)} 条规则排在本应用入口之前、读回不能确认 Safari 新请求不经这些规则发出（可能经 SFE-ROUTE）；仍结束 Safari 可能经买家出口的旧连接（按原规则发出的连接不在买家出口上，不结束），继续撤销本应用入口`
              : '中间阻断不再写入：verify/active 已确认关闭（Safari 新请求不会经 SFE-ROUTE），上一次保留的 block 关闭尚未确认加载（Surge 已加载的是阻断或已是普通模式），不重新打开 block；仍结束 Safari 可能经买家出口的旧连接（按原规则发出的连接不在买家出口上，不结束）',
          );
          await kill(false, blockConfirmed);
        } else if (alreadyNormal) {
          tighteningUnconfirmed = mayUseRoute && !blockConfirmed;
          // 本应用入口已不在 Surge 中：不需要阻断、不写入。但“没有本应用规则”不等于 Surge 重启过：临时规则也可能在 Surge
          // 运行中被移除（`rule temp remove`、`rule temp flush`——随包技能把后者列为常规操作，别的工具或代理可能执行），
          // 之前经 SFE-ROUTE 建立的 Safari 长连接仍在买家出口上。路由记录或持久标记表明 Safari 可能经过 SFE-ROUTE 时照常结束
          // Safari 连接（门槛不满足时尽力而为；新连接已按原规则发出，不算失败）；否则不结束按原规则发出的连接。
          engine.step(op.id, alreadyNormalStep(ctrl.strategy, blocked, mayUseRoute));
          if (mayUseRoute) await kill(false, blockConfirmed);
        } else {
          // 阻断未经运行时求值确认（rule match 不可用的退路）时不记为 BLOCKED：Surge 可能仍加载着写入之前的入口；之后失败时
          // 记下的 BLOCKED 会被当作已确认（例如之后的激活回滚跳过回到阻断就恢复切换前的节点）
          confirmed = blockConfirmed ? 'BLOCKED' : 'UNKNOWN';
          blockUnconfirmed = !blockConfirmed;
          tighteningUnconfirmed = !blockConfirmed;
          repos.routeState.update(blockConfirmed ? { entryMode: 'BLOCKED', entryModeVerifiedAt: engine.nowIso() } : { entryMode: 'UNKNOWN' });
          recordPrecedence();
          // 阶段 SAFARI_BLOCKED（界面显示「Safari 已阻断」）只用于读回确认、没有规则排在入口之前的阻断；否则停在当前阶段，只记一步
          const blockStep = precedenceIssues
            ? `入口已切换到阻断${blockConfirmed ? '' : `（${UNCONFIRMED_ENTRY_TEXT}）`}，但有 ${blockingCount(precedenceIssues)} 条规则排在本应用入口之前、读回不能确认完全阻断：继续撤销本应用入口`
            : blockConfirmed
              ? '已阻断 Safari 新请求（读回确认）'
              : `入口已按计划写入阻断：${UNCONFIRMED_ENTRY_TEXT}，${unconfirmedLoadText(ctrl.strategy, 'Safari 可能仍按原规则发出')}；只结束 Safari 可能经买家出口的连接`;
          engine.updateOp(op.id, blockConfirmed && !precedenceIssues ? { phase: 'SAFARI_BLOCKED' } : {}, blockStep, { route: true });
          // 入口不确定阻断 Safari 时（有规则排在入口之前；或阻断未经运行时求值确认——rule match 不可用的退路只是写入并等满
          // 文件监视上限，监视比上限慢时 Surge 仍加载着写前的入口，Safari 按原规则发出、重连），按原规则发出的连接不在买家出口
          // 上，不结束，重连也是预期的；只结束、只核对可能经买家出口的连接
          await kill(!precedenceIssues && blockConfirmed, blockConfirmed);
        }
        const normal = await ctrl.transition('NORMAL', undefined, undoOptions(engine, op.id));
        normalUnconfirmed = normal.runtimeConfirmed === false;
        if (normalUnconfirmed) engine.step(op.id, `撤销本应用入口：${UNCONFIRMED_ENTRY_TEXT}（路由状态带“入口规则未能读回确认”警告）`);
        confirmed = 'NORMAL';
      } else if (mayUseRoute) {
        // 入口读回已是普通模式，但 Safari 可能仍有经 SFE-ROUTE 的连接（safariMayUseRoute）：之前的一次切换（失败的普通模式、激活
        // 或回滚——失败的回滚可能把入口记为 NORMAL，或其间服务崩溃）已按事实确认归属（temp_rule 把消失的本应用规则标为已移除）
        // 而没有结束连接，或上一次普通模式未能确认结束连接；控制器已看不到本应用记录，不能靠它判断。照常结束（门槛不满足时尽力
        // 而为；新连接已按原规则发出，不算失败）。路由记录已是空闲的普通模式、持久标记已清除时不结束——Safari 的连接已按原规则发出。
        engine.step(op.id, alreadyNormalStep(ctrl.strategy, readback, true));
        tighteningUnconfirmed = readback.runtimeConfirmed === false;
        await kill(false, readback.runtimeConfirmed !== false);
      } else if (readback.notInstalled) {
        // 本应用入口尚未写入工作配置（例如更改入口策略之后尚未重新合并）：没有可撤销的入口，不写入、不结束连接，写明依据
        engine.step(op.id, alreadyNormalStep(ctrl.strategy, readback, false));
      }
    } else if (route.entryMode !== 'NORMAL') {
      throw new SfeError('CAPABILITY_UNVERIFIED', '进入普通模式失败：入口策略或 Safari 进程路径不可用，无法撤销入口');
    }
  } catch (err) {
    // 只记经运行时求值确认的状态：中间阻断未经确认时，错误带回的阻断位（只按结构读回）同样记为 UNKNOWN
    const errMode = runtimeConfirmedModeFrom(err, confirmed);
    const mode: EntryMode = blockUnconfirmed && errMode === 'BLOCKED' ? 'UNKNOWN' : errMode;
    const body = engine.errorBody(err, '进入普通模式失败：内部错误');
    // 与完成路径同一规则：Safari 可能经 SFE-ROUTE，而本次没有在经运行时求值确认的入口下确认结束全部 Safari 连接时，保留（没有时
    // 补上）持久标记并带 buyer_exit_connections_unconfirmed。否则失败之后路由可能记为空闲的普通模式（撤销已确认 NORMAL、之后的
    // 读回失败），看起来不需要普通模式，而之前经 SFE-ROUTE 建立的 Safari 连接仍在买家出口上（对账不处理空闲的普通模式）。
    // 失败路径从不清除标记：撤销入口没有读回完成。
    const connectionsUnconfirmed = mayUseRoute && !(killAttempted && killsEnded && entryConfirmedAtKill);
    // 失败即关闭（与回滚无法确认同一规则，§6.3 第 14 步）：最后经运行时求值确认的不是阻断或普通模式，Surge 可能仍加载着检测或
    // 使用中入口，而 SFE-ROUTE 的选择不是使用中环境已验证的出口（受理时或执行前取代、接手的切换写入的未验证节点，或没有使用中
    // 的环境；或选择在记录之外被改过，见 selectionIsVerifiedExit）——Safari 会在普通模式失败之后经它发出。尽力改选 REJECT 并读回
    // （从不抛出），只有读回确认才记为 REJECT。选择读回就是使用中环境已验证的出口时不改（普通模式失败，Safari 停在原来已验证的
    // 路由上）。
    // 有规则排在入口之前时（中间阻断读回不能确认完全阻断）记下的阻断只是入口位：排在它之前的规则可能把 Safari 请求交给 SFE-ROUTE
    const loosened = (mode !== 'BLOCKED' && mode !== 'NORMAL') || (precedenceSeen && mode !== 'NORMAL');
    const verifiedExitKept = loosened && (await selectionIsVerifiedExit(engine, repos.routeState.get()));
    const hold = loosened && !verifiedExitKept ? await selectRejectBestEffort(engine) : null;
    // 只写读回确认过的：「未回退到其他出口」只在入口确认阻断或已是普通模式、或选择读回就是使用中环境已验证的出口时成立
    const stateNote =
      mode === 'UNKNOWN'
        ? '入口状态未知'
        : precedenceSeen && mode === 'BLOCKED'
          ? '入口位停在读回确认的阻断，但有规则排在本应用入口之前（见操作结果），不能确认 Safari 完全阻断'
          : `入口停在最后经运行时求值确认的状态（${mode}）`;
    const routeNote = hold
      ? `${rejectHoldText(hold)}；${EXISTING_CONNECTIONS_TEXT}`
      : verifiedExitKept
        ? 'SFE-ROUTE 的选择读回就是使用中环境已验证的出口：Safari 停在原来已验证的路由上，未回退到其他出口'
        : '未回退到其他出口';
    // 交给本次普通模式的切换已把入口写入使用中模式（ACTIVE 读回确认、未提交，yieldToQueuedNormal）而受理时的确认没有覆盖它的
    // 窗口：这一事实只记在本操作中，普通模式失败后之后的普通模式看不到——路由带旧窗口警告（之后的普通模式完成时保留、说明写明，
    // 之后的激活提交时按它自己的旧窗口确认清除，用户确认旧窗口已关闭时清除；§6.1、§6.5）
    const handedOverFail = handedOverUnconfirmedTarget(engine, op);
    const handedOverFailNote = handedOverFail
      ? `；切换目标环境${handedOverFail.label}的入口已写入使用中模式（在提交之前交给本次普通模式），其窗口已经过它的出口、未经确认：路由带旧窗口警告，之后进入普通模式时其后续请求按 Surge 原规则发出（可能直连）`
      : '';
    // 路由需要处理（attention，与回滚无法确认、处理器中断同一规则）：改选过 REJECT（入口未确认阻断或普通模式，而选择不是使用中
    // 环境已验证的出口——例如交给本次普通模式、已写入 ACTIVE 而未提交的切换选着的目标节点），或入口状态未知、有规则排在入口之前。
    // 否则使用中的环境（路由记录仍是它）会显示为托管中、可以使用，而 Safari 用的是别的买家出口或 REJECT
    const attention = hold !== null || mode === 'UNKNOWN' || (precedenceSeen && mode !== 'NORMAL');
    repos.tx(() => {
      if (connectionsUnconfirmed) markSafariMayUseRoute(engine, op.id, engine.entryConfig().processPaths);
      const fresh = repos.routeState.get();
      // 之前一次成功回滚留下的 rollback_needs_reverify（「已恢复原节点并保持阻断」）只在入口仍是读回确认、没有规则排在入口之前的
      // 阻断时成立：撤销入口已开始、入口状态未知或不是阻断时去掉（与回滚无法确认、处理器中断相同）
      const keepReverify = mode === 'BLOCKED' && !precedenceSeen && hold === null;
      const warnings = new Set<RouteWarning>(keepReverify ? fresh.warnings : fresh.warnings.filter((w) => w !== 'rollback_needs_reverify'));
      if (connectionsUnconfirmed) warnings.add('buyer_exit_connections_unconfirmed');
      // 中间阻断时有规则排在本应用入口之前、普通模式没有完成：记下的阻断只是入口位，被这些规则匹配的 Safari 请求按它们发出
      // （与回滚无法确认相同，不声称 Safari 已阻断）
      if (precedenceSeen && mode !== 'NORMAL') {
        warnings.add('precedence_violation');
        warnings.add('entry_unverified');
      }
      // 入口状态未知（没有经运行时求值确认的状态，与回滚无法确认相同）：带 entry_unverified，不声称任何已确认的入口
      if (mode === 'UNKNOWN') warnings.add('entry_unverified');
      // 改选过 REJECT：记下的入口不是使用中环境已验证的路由；已建立的连接不受改选影响（holdExistingConnections）
      if (hold) {
        warnings.add('entry_unverified');
        holdExistingConnections(engine, op.id, warnings);
      }
      if (handedOverFail) warnings.add('managed_windows_on_original_rules');
      repos.routeState.update({
        entryMode: mode,
        phase: mode === 'NORMAL' ? 'idle' : attention ? 'attention' : 'failed',
        operationId: op.id,
        // 开始时已结束停在等待中的切换与重测：之前的等待截止时间不再属于任何操作
        awaitingDeadline: null,
        warnings: [...warnings],
        ...(hold?.confirmed ? { selectedNode: 'REJECT' } : {}),
      });
      const cur = repos.operations.get(op.id)!;
      repos.operations.update(op.id, {
        phase: 'FAILED',
        status: 'failed',
        error: body,
        ...(hold ? { result: { ...(cur.result ?? {}), rejectSelected: hold.confirmed } } : {}),
      });
      repos.operations.appendStep(
        op.id,
        'FAILED',
        `${body.message}；${stateNote}；${routeNote}${
          connectionsUnconfirmed
            ? `；未能确认 Safari 已没有经买家出口的连接（${killAttempted ? '未能确认结束 Safari 连接，或结束时入口未经运行时求值确认' : '未结束 Safari 连接'}）：路由状态带警告，再次进入普通模式会再结束 Safari 可能经买家出口的连接`
            : ''
        }${handedOverFailNote}`,
      );
    });
    const failEnvs = new Set<string>(route.activeEnvironmentId ? [route.activeEnvironmentId] : []);
    if (handedOverFail) failEnvs.add(handedOverFail.environmentId);
    engine.emit({ operations: [op.id], route: true, environments: [...failEnvs] });
    return;
  }
  const keepOpen = np?.oldSessionPolicy === 'keep_open_acknowledged' && np.hadManagedEnvironment;
  // 交给本次普通模式的切换已把入口写入使用中模式（ACTIVE 读回确认、未提交，yieldToQueuedNormal）：Safari 的全部请求（含目标
  // 场景中已打开的窗口）已经过目标环境的出口，而受理时的旧窗口确认只能针对当时的使用中环境——确认没有针对它时，与选择不关闭
  // 旧窗口相同：路由带 managed_windows_on_original_rules，完成说明写明它的窗口之后按 Surge 原规则发出（§6.1、§6.5）。在执行时重读
  // 操作：停下的切换在受理之后才把目标记入本操作
  const npNow = payloadOf(repos.operations.get(op.id) ?? op).normal ?? np;
  const handedOver = npNow?.handedOverActiveTarget ?? null;
  const handedOverUnconfirmed = handedOverUnconfirmedTarget(engine, op);
  const handedOverNote = handedOverUnconfirmed
    ? `切换目标环境${handedOverUnconfirmed.label}的入口已写入使用中模式（在提交之前被本次普通模式取代），其窗口已经过它的出口、未经确认，后续请求将按 Surge 原规则发出（可能直连）`
    : null;
  const windowNotes = [...(keepOpen ? ['旧环境窗口未关闭，其后续请求将按 Surge 原规则发出（可能直连）'] : []), ...(handedOverNote ? [handedOverNote] : [])];
  // 不含旧窗口警告：它按提交事务中重读的路由合并（见下）
  const warnings: RouteWarning[] = [];
  if (segmentsChanged) warnings.push('managed_segments_changed');
  if (normalUnconfirmed) warnings.push('entry_unverified');
  // 持久标记：确认结束了全部 Safari 连接、且结束前后的入口（阻断或已是普通模式，以及 NORMAL）都经运行时求值确认时清除——
  // 之后再进入普通模式不必结束按原规则发出的连接。否则 Safari 可能仍有（或在 Surge 加载撤销之前又建立了）经买家出口的连接：
  // 保留标记（路由记录表明 Safari 可能经过 SFE-ROUTE 而还没有标记时补上），路由状态带警告，完成说明写明，下一次普通模式再结束。
  const clearMarker = killAttempted && killsEnded && entryConfirmedAtKill && !normalUnconfirmed;
  const unconfirmedReason = clearMarker || !(killAttempted || mayUseRoute)
    ? null
    : !killAttempted
      ? '入口策略或 Safari 进程路径不可用，未结束 Safari 连接'
      : !killsEnded
        ? '未能确认结束 Safari 连接'
        : ctrl?.strategy === 'temp_rule'
          ? '入口未经运行时求值确认（临时规则已按列表与有效规则顺序读回，Surge 实际如何匹配 Safari 请求未经 rule match 确认），不能确认 Safari 在结束之后没有又经 SFE-ROUTE 建立连接'
          : '入口未经运行时求值确认，Surge 可能仍加载着写前的入口，Safari 在结束之后可能又经 SFE-ROUTE 建立连接';
  if (unconfirmedReason) warnings.push('buyer_exit_connections_unconfirmed');
  // 失败即关闭（与回滚、普通模式失败同一规则）：收紧没有经运行时求值确认时，Surge 加载撤销之前仍可能加载着检测或使用中入口，
  // 而普通模式完成之后没有使用中的环境——SFE-ROUTE 选着的任何买家出口都不是已验证的路由。尽力改选 REJECT 并读回（从不抛出），
  // 只有读回确认才记为 REJECT；入口确认之后 SFE-ROUTE 不再被 Safari 使用，选择不变（§6.5）。
  const hold = tighteningUnconfirmed ? await selectRejectBestEffort(engine) : null;
  repos.tx(() => {
    if (clearMarker) clearSafariMayUseRoute(engine);
    else if (unconfirmedReason) markSafariMayUseRoute(engine, op.id, engine.entryConfig().processPaths);
    // 之前一次普通模式留下的旧窗口警告按事务中重读的路由保留：本次的 Surge 调用期间用户可能已确认旧窗口已关闭
    // （acknowledgeWindows 不等待路由操作），不能按开始时读到的路由把它加回来
    const carriedWindows = repos.routeState.get().warnings.includes('managed_windows_on_original_rules');
    if (keepOpen || handedOverNote !== null || carriedWindows) warnings.unshift('managed_windows_on_original_rules');
    // 之前的普通模式（含交给它的切换已写入 ACTIVE、它失败了）留下的旧窗口警告：完成说明同样写明，不声称 Safari 全部按原规则
    const notes = windowNotes.length === 0 && carriedWindows ? ['之前记下的旧环境窗口未关闭，其后续请求将按 Surge 原规则发出（可能直连）'] : windowNotes;
    repos.routeState.update({
      entryMode: 'NORMAL',
      entryModeVerifiedAt: engine.nowIso(),
      phase: 'idle',
      activeEnvironmentId: null,
      activeProxyRevision: null,
      oldSessionPolicy: np?.oldSessionPolicy ?? null,
      operationId: op.id,
      awaitingDeadline: null,
      activationSnapshot: null,
      warnings,
      ...(hold?.confirmed ? { selectedNode: 'REJECT' } : {}),
    });
    const cur = repos.operations.get(op.id)!;
    repos.operations.update(op.id, { phase: 'NORMAL_RESTORED', status: 'succeeded', ...(hold ? { result: { ...(cur.result ?? {}), rejectSelected: hold.confirmed } } : {}) });
    repos.operations.appendStep(
      op.id,
      'NORMAL_RESTORED',
      unconfirmedReason
        ? `已进入普通模式，但未能确认 Safari 已没有经买家出口的连接（${unconfirmedReason}）：路由状态带警告，再次进入普通模式会再结束 Safari 可能经买家出口的连接${hold ? `；${normalHoldText(hold, ctrl?.strategy)}` : ''}${notes.map((n) => `；${n}`).join('')}`
        : notes.length > 0
          ? `已进入普通模式：${notes.join('；')}`
          : '已进入普通模式：Safari 按 Surge 原规则发出请求',
    );
  });
  const envs = new Set<string>(route.activeEnvironmentId ? [route.activeEnvironmentId] : []);
  if (handedOver !== null) envs.add(handedOver);
  engine.emit({ operations: [op.id], route: true, environments: [...envs] });
}

/**
 * 受理时排在本次普通模式之前、到它开始执行时仍在排队（尚未开始，从未写入 Surge）的激活、重测与带路由参数的发布
 * （normal.queuedBehind）：按受理顺序它们应先执行，并在第一次写入之前让给排队的普通模式（yieldBeforeFirstWrite）——普通模式
 * 先开始执行只可能是领取顺序被打乱（同组内按可用时间排序，墙上时钟在两次受理之间回拨时受理在后的普通模式反而更早；可用时间
 * 未到的条目也不能领取）。旧请求的结果不能覆盖新请求（方案 1 设计「多环境争抢」）：在这里按它们本来的结局结束——激活与重测
 * SUPERSEDED（superseded_by 为本次普通模式），活动环境发布 READY_FOR_NEXT_OPEN（新版本已部署、未切换）——否则它们会在普通模式
 * 完成之后执行，重新阻断 Safari、写入检测入口。排队的普通模式不在其中（之后再执行一次只是重复撤销）。
 */
function endQueuedBefore(engine: Engine, op: OperationRecord): void {
  const { repos } = engine;
  const behind = payloadOf(repos.operations.get(op.id) ?? op).normal?.queuedBehind ?? [];
  const ended: OperationRecord[] = [];
  repos.tx(() => {
    for (const id of behind) {
      const o = repos.operations.get(id);
      if (!o || o.id === op.id || o.status !== 'queued' || o.kind === 'route.normal') continue;
      if (PUBLISH_KINDS.includes(o.kind)) {
        repos.operations.update(o.id, { phase: 'READY_FOR_NEXT_OPEN', status: 'succeeded', supersededBy: op.id });
        repos.operations.appendStep(o.id, 'READY_FOR_NEXT_OPEN', '新版本已部署，未切换：受理在后的进入普通模式已先开始执行（本操作尚未开始、没有写入 Surge），路由未改变');
      } else {
        repos.operations.update(o.id, { phase: 'SUPERSEDED', status: 'superseded', supersededBy: op.id, error: { code: 'SUPERSEDED', message: '已被进入普通模式取代' } });
        repos.operations.appendStep(o.id, 'SUPERSEDED', '已被进入普通模式取代：受理在后的普通模式已先开始执行（本操作尚未开始，没有写入 Surge），由普通模式从当前状态进入普通模式');
      }
      repos.outbox.cancelForOperation(o.id);
      ended.push(o);
    }
  });
  if (ended.length === 0) return;
  engine.step(op.id, '结束受理在前、仍在排队的切换或检测（尚未开始，没有写入 Surge），由本次普通模式从当前状态进入普通模式');
  const envs = ended.map((o) => payloadOf(o).route?.targetEnvironmentId ?? o.environmentId).filter((e): e is string => e !== null && e !== undefined);
  engine.emit({ operations: ended.map((o) => o.id), environments: envs });
}

/**
 * 交给本次普通模式、已把入口写入使用中模式（ACTIVE 读回确认、未提交）的切换目标（normal.handedOverActiveTarget，
 * yieldToQueuedNormal），且受理时的旧窗口确认针对的不是它：它的窗口已经过它的出口、未经确认。在执行时重读操作——停下的切换
 * 在受理之后才把目标记入本操作。label 是带引号的环境名（环境不存在时为空）。
 */
function handedOverUnconfirmedTarget(engine: Engine, op: OperationRecord): { environmentId: string; label: string } | null {
  const np = payloadOf(engine.repos.operations.get(op.id) ?? op).normal;
  const target = np?.handedOverActiveTarget ?? null;
  if (target === null || target === (np?.expectedActiveEnvironmentId ?? null)) return null;
  const env = engine.repos.environments.get(target);
  return { environmentId: target, label: env ? `「${labelOf(env)}」` : '' };
}

/**
 * 普通模式的中间阻断。优先级问题只阻止 VERIFY_ONLY/ACTIVE（§5.2、§5.5）：入口位已全部确认为 BLOCKED、
 * 只因有规则排在入口之前而最终读回不能宣称受控时，返回这些规则并继续撤销入口；其他失败照常抛出。
 * 标为 towardNormal：之后进入 NORMAL 本来就把 Safari 流量交给原规则，temp_rule 不因移除本应用规则会暴露其后的其他规则而
 * 在写入前拒绝（回滚不设置，照常拒绝，§5.5）。
 */
async function blockForNormal(
  ctrl: EntryController,
  undo: EntryTransitionOptions,
): Promise<{
  precedenceIssues: EntryReadback['precedenceIssues'] | null;
  runtimeConfirmed: boolean;
  witnessConfirmed: boolean;
  alreadyNormal: boolean;
  blockKeptOff: boolean;
  notInstalled: boolean;
  segmentDamaged: boolean;
  rewrote: string[] | undefined;
}> {
  try {
    const rb = await ctrl.transition('BLOCKED', undefined, { ...undo, towardNormal: true });
    // 起点已是 NORMAL 时控制器不写入、返回 NORMAL（EntryTransitionOptions.towardNormal）。阻断已经成立而不写入时（ruleset_resource
    // 上一次普通模式已关闭 udp），有规则排在入口之前随读回返回，与下面的 PRECEDENCE_VIOLATION 一样继续撤销入口。上一次 NORMAL
    // 一段保留的 block 关闭尚未加载时（blockKeptOff）这一段同样已满足，但不能宣称已阻断；有规则排在入口之前时同样返回。
    const blockKeptOff = rb.mode === 'BLOCKED' && (rb.keptTowardNormal ?? []).includes('block');
    const issues = rb.mode === 'BLOCKED' && hasBlockingIssue(rb.precedenceIssues) ? rb.precedenceIssues : null;
    return {
      precedenceIssues: issues,
      runtimeConfirmed: rb.runtimeConfirmed !== false,
      witnessConfirmed: rb.witnessConfirmed !== false,
      alreadyNormal: rb.mode === 'NORMAL',
      blockKeptOff,
      notInstalled: rb.notInstalled === true,
      segmentDamaged: rb.segmentDamaged === true,
      rewrote: rb.rewrote,
    };
  } catch (err) {
    if (err instanceof SfeError && err.code === 'PRECEDENCE_VIOLATION' && confirmedModeFrom(err, 'UNKNOWN') === 'BLOCKED') {
      const issues = Array.isArray(err.details?.precedenceIssues) ? (err.details.precedenceIssues as EntryReadback['precedenceIssues']) : [];
      // 退路（rule match 不可用）中同样以 PRECEDENCE_VIOLATION 报告：确认程度随错误返回，不当作已确认
      return {
        precedenceIssues: issues,
        runtimeConfirmed: err.details?.runtimeConfirmed !== false,
        witnessConfirmed: err.details?.witnessConfirmed !== false,
        alreadyNormal: false,
        blockKeptOff: false,
        notInstalled: false,
        segmentDamaged: false,
        rewrote: undefined,
      };
    }
    throw err;
  }
}

function blockingCount(issues: EntryReadback['precedenceIssues']): number {
  return issues.filter((i) => i.severity === 'blocking').length;
}

/**
 * 入口已是普通模式（不需要阻断、不写入）时的步骤说明，按入口策略与读回证据写明依据：temp_rule 是 Surge 中没有本应用的
 * 临时规则；ruleset_resource 的四条 RULE-SET 仍在有效规则中，只是入口文件已全部为占位规则——见证与探测读回确认 Surge 已加载；
 * 旧格式文件没有见证规则时只由探测确认（witnessConfirmed 为 false）；rule match 不可用时只按文件内容判断、未经运行时确认
 * （runtimeConfirmed 为 false）。kill 写明是否仍结束 Safari 连接（safariMayUseRoute）。
 */
function alreadyNormalStep(
  strategy: EntryController['strategy'],
  rb: { runtimeConfirmed?: boolean; witnessConfirmed?: boolean; notInstalled?: boolean; segmentDamaged?: boolean; rewrote?: string[] },
  kill: boolean,
): string {
  const files = '入口 RULE-SET 仍在有效规则中，本应用入口规则集文件已全部为占位规则';
  const confirmation = rb.runtimeConfirmed === false ? `只按有效规则列表与文件内容判断：${UNCONFIRMED_ENTRY_TEXT}` : 'Safari 与对照的运行时探测读回确认';
  const cause =
    strategy === 'temp_rule'
      ? 'Surge 中没有本应用的入口规则，例如重启时已丢弃或已被移除'
      : rb.segmentDamaged === true
        ? `本应用入口的 RULE-SET 在 Surge 的有效规则中不完整或顺序不对（工作配置被外部修改）：${
            rb.rewrote && rb.rewrote.length > 0
              ? `已把入口规则集文件改写为占位规则（${rb.rewrote.join('、')}；只关闭位，在有效规则中的${
                  rb.runtimeConfirmed === false ? '未经见证确认已加载（rule match 不可用时按文件监视上限等满）' : '由见证确认已加载'
                }，不在其中的 Surge 不加载）`
              : '入口规则集文件已全部为占位规则'
          }，${
            // 未经见证与运行时求值确认：文件监视比上限慢时 Surge 仍加载着改写之前的入口（只关闭位，从不新开经 SFE-ROUTE 的路径）
            rb.runtimeConfirmed === false ? 'Surge 加载占位规则之后 Safari 按原规则发出（文件监视比上限慢时可能仍加载着改写之前的入口）' : 'Safari 按原规则发出'
          }；${confirmation}；需要在维护中重新合并恢复受管理段`
        : rb.notInstalled === true
          ? `本应用入口尚未写入工作配置：四条入口 RULE-SET 都不在 Surge 的有效规则中，例如更改入口策略之后尚未重新合并${
              rb.rewrote && rb.rewrote.length > 0 ? `，或工作配置中的入口段被外部删去（已把入口规则集文件改写为占位规则：${rb.rewrote.join('、')}，重新合并恢复入口段之后 Surge 加载的也是普通模式）` : ''
            }；${rb.runtimeConfirmed === false ? `只按有效规则列表判断：${UNCONFIRMED_ENTRY_TEXT}` : 'Safari 与对照的运行时探测读回确认'}`
          : rb.runtimeConfirmed === false
            ? `${files}，只按文件内容判断：${UNCONFIRMED_ENTRY_TEXT}`
            : rb.witnessConfirmed === false
              ? `${files}，有文件没有见证规则（旧格式）：只由 Safari 与对照的运行时探测读回确认，未经见证确认 Surge 已加载的是文件中的这一版`
              : `${files}，见证与运行时探测读回确认 Surge 已加载`;
  const tail = kill
    ? '仍结束 Safari 可能经买家出口的旧连接（按原规则发出的连接不在买家出口上，不结束）'
    : '路由记录是空闲的普通模式，且没有 Safari 可能经 SFE-ROUTE 的记录（从未激活，或上一次确认结束 Safari 连接、入口经运行时求值确认的普通模式之后本应用没有写入检测或使用中入口）：不结束 Safari 连接';
  return `入口已是普通模式（${cause}）：不需要阻断，${rb.rewrote && rb.rewrote.length > 0 ? '未写入阻断' : '未写入'}；${tail}`;
}

/**
 * 普通模式中结束 Safari 连接：门槛满足时严格核对，否则尽力而为；无论哪种，列出或结束连接失败都只记录并报告，
 * 不中止普通模式（它只依赖入口写入与读回，§5.2、§6.5）。entryBlocksSafari 为 false（入口已是普通模式、保留的 block 关闭尚未
 * 加载、有规则排在入口之前、阻断未经运行时求值确认）时，Safari 按原规则立即重连是预期的，只有可能经买家出口的新连接记为未能结束。返回是否确认结束了
 * 全部 Safari 连接（没有错误、每条都已确认结束）。
 */
async function killForNormal(engine: Engine, opId: string, entryBlocksSafari: boolean): Promise<boolean> {
  const { repos } = engine;
  const cfg = engine.entryConfig();
  const strict = engine.missing(CAPABILITY_GATES.killSafariConnections).length === 0;
  let killResults: KillResult[] = [];
  let killError: ApiErrorBody | null = null;
  try {
    killResults = await killSafariConnections(engine.surge, {
      processPaths: cfg.processPaths,
      // Safari 可能经 SFE-ROUTE 期间被换掉的进程路径：只结束其中可能经买家出口的连接
      retiredProcessPaths: retiredSafariPaths(engine, cfg.processPaths),
      verifyHost: cfg.verifyHost,
      now: () => engine.now(),
      bestEffort: !strict,
      entryBlocksSafari,
    });
  } catch (err) {
    if (err instanceof SfeError && Array.isArray(err.details?.killResults)) killResults = err.details.killResults as KillResult[];
    const body = engine.errorBody(err, '结束 Safari 连接失败：内部错误');
    killError = { code: body.code, message: body.message };
  }
  const cur = repos.operations.get(opId)!;
  repos.operations.update(opId, { result: { ...(cur.result ?? {}), killResults, killBestEffort: !strict, ...(killError ? { killError } : {}) } });
  const ok = killResults.filter((k) => k.ok).length;
  if (killError) engine.step(opId, `未能确认结束 Safari 连接（${killError.message}，已结束 ${ok}/${killResults.length} 条）：继续撤销本应用入口`);
  else engine.step(opId, strict ? `已结束 Safari 连接 ${ok} 条` : `进程归属能力未通过：尽力结束 Safari 连接，结果 ${ok}/${killResults.length}`);
  return killError === null && ok === killResults.length;
}

// ---------- 崩溃恢复 ----------

/**
 * 服务重启时仍在执行中的路由操作：按路由阶段与 epoch 判断（操作阶段在切换中可能仍是 VALIDATING/PREFLIGHT_OK，
 * 推迟的预检之后也会回到 PREFLIGHT_OK，不能用来判断）。尚未递增 epoch、也不负责过渡中路由的重新执行；其余按快照
 * 回滚（先读事实）。经 supersedeWaiting 接手了过渡中路由的激活（路由 epoch 已递增，但它自己的 routeEpoch 仍为空、
 * stage 仍是 pending）以及已开始回滚的操作也属于后者：从不把一次已开始的回滚重放成切换。
 * 已开始写入、而路由已记在另一个操作名下（route.operationId 不是它）：路由已由之后的操作接手（例如受理在后的普通模式已从
 * 当时的状态撤销本应用入口）——不回滚、不改写入口，记为 SUPERSEDED，否则旧操作的回滚会覆盖新请求的结果（重新阻断已进入
 * 普通模式的 Safari，方案 1 设计「多环境争抢」）；接手的操作已结束而 Safari 仍可能经未验证的出口时，按 §6.3 第 14 步的结束点
 * 改选 REJECT（supersededAfterCrash → holdAtRouteEnd）。执行器先领取崩溃恢复中的操作（executor.ts claimPreference），正常不会
 * 走到这里；这是第二道防线。
 * 等待中的操作已开始结束（RoutePayload.ending：超时、取消或目标已被替换，结束点读写 Surge 期间崩溃）：按记下的结束重新结束
 * （endRouteOp，结束点照常重新判断），不重新开始等待或检测。Safari 重测的核对已开始（有提交的检测结果）：按已判定的失败重新
 * 结束或按提交的结果重新核对（recoverProbeCheck），不重新开始等待。结束点读回 REJECT 而本操作已记下改选意图
 * （OperationPayload.endHold）时按本操作的改选记下（holdAtRouteEnd）。
 */
export async function recoverRoute(engine: Engine, op: OperationRecord): Promise<void> {
  const ending = payloadOf(op).route?.ending;
  if (ending) {
    await endRouteOp(engine, op.id, { phase: ending.phase, status: ending.status, error: ending.error }, ending.step, {}, { cancelOutbox: ending.cancelOutbox });
    return;
  }
  if (op.kind === 'route.normal') {
    await runNormal(engine, { ...op, status: 'queued' });
    return;
  }
  const p = routePayload(op);
  if (p.flow === 'probe') {
    // 核对已开始（提交的检测结果已排入执行器，completeVerification 已把操作改为 running）：检测编号已消费，准备页只轮询操作、
    // 不会再提交——不重新开始等待（重新开始的等待只会按超时结束、不加警告，不符或失败的结果就此丢失，订单与填充继续）
    if (p.submission) {
      await recoverProbeCheck(engine, op, p);
      return;
    }
    // 尚未开始等待检测（开始检查或读回入口时崩溃）：Safari 重测从不写入，重新执行
    await runProbeSafari(engine, op);
    return;
  }
  const route = engine.repos.routeState.get();
  const owns = op.phase === 'ROLLING_BACK' || ownsTransition(route, op.id);
  if (!owns && (p.stage === 'pending' || p.stage === 'arrived') && op.routeEpoch === null) {
    if (p.stage === 'arrived') await continueAfterCrash(engine, op);
    else await runActivation(engine, op);
    return;
  }
  if (route.operationId !== null && route.operationId !== op.id) {
    await supersededAfterCrash(engine, op.id, route.operationId);
    return;
  }
  // 已开始写入（epoch 已递增：切换中、VERIFY_ONLY 之后的核对或回滚）或负责过渡中的路由：按激活快照回滚，不重放写入
  const body: ApiErrorBody = { code: 'UNKNOWN_STATE', message: '切换中断：服务重启时切换未完成' };
  const ctrl = engine.entryController(() => op.id);
  let mode: EntryMode = 'UNKNOWN';
  try {
    mode = ctrl ? (await ctrl.read()).mode : 'UNKNOWN';
  } catch {
    mode = 'UNKNOWN';
  }
  await rollbackActivation(engine, op.id, body, ctrl, mode);
}

/**
 * 崩溃恢复：路由已由之后的操作接手（recoverRoute），本操作不回滚、不改写入口，记为 SUPERSEDED。接手的操作仍未结束（排队或执行中的
 * 普通模式、负责过渡中路由的操作）时由它结算；它已结束而 Surge 仍可能让 Safari 经未验证的出口时，这同样是结束点，按
 * holdAtRouteEnd 失败即关闭。
 */
async function supersededAfterCrash(engine: Engine, opId: string, ownerId: string): Promise<void> {
  const { repos } = engine;
  const op = repos.operations.get(opId)!;
  const hold = await holdAtRouteEnd(engine, opId);
  const activeBefore = repos.routeState.get().activeEnvironmentId;
  repos.tx(() => {
    recordEndHold(engine, opId, hold);
    const cur = repos.operations.get(opId)!;
    repos.operations.update(opId, {
      phase: 'SUPERSEDED',
      status: 'superseded',
      supersededBy: ownerId,
      error: withEndHold({ code: 'SUPERSEDED', message: '已被之后接手路由的操作取代' }, hold),
      ...(hold ? { result: { ...(cur.result ?? {}), rejectSelected: hold.confirmed } } : {}),
    });
    repos.operations.appendStep(
      opId,
      'SUPERSEDED',
      // 结束点改选了 SFE-ROUTE 时路由已不是接手的操作留下的结果：不再说「路由保持它的结果」
      `切换中断：服务重启时切换未完成，而路由已由之后的操作接手：不回滚、不改写入口${hold ? endHoldNote(hold) : '，路由保持它的结果'}`,
    );
    repos.outbox.cancelForOperation(opId);
  });
  const envs = [...(op.environmentId ? [op.environmentId] : []), ...(hold && activeBefore ? [activeBefore] : [])];
  engine.emit({ operations: [opId, ownerId], route: true, environments: envs });
}

/**
 * 崩溃恢复：Safari 重测的核对已开始（RoutePayload.submission）。已判定失败或不符（RoutePayload.verdict，结束点读写 Surge 期间
 * 崩溃）→ 按已判定的结果重新结束（结束点照常重新判断：holdAtRouteEnd，本操作已记下改选意图而读回 REJECT 时按改选记下）；
 * 尚未判定（读取选择或请求记录期间崩溃）→ 按已提交的检测结果重新核对（completeVerification 重读选择与 Surge 请求记录，出口 IP
 * 用提交的值比较，读不到即失败）。从不重新开始等待。
 */
async function recoverProbeCheck(engine: Engine, op: OperationRecord, p: RoutePayload): Promise<void> {
  if (p.verdict) {
    engine.step(op.id, '服务重启时重新检测的核对已判定失败、尚未结束：按已判定的结果结束，不重新开始检测');
    const hold = await holdAtRouteEnd(engine, op.id, { observedSelection: p.verdict.observedSelection });
    finishProbe(engine, op.id, p, p.verdict.failure, p.verdict.evidence, hold);
    return;
  }
  engine.step(op.id, '服务重启时重新检测的核对未完成：按已提交的检测结果重新核对，不重新开始检测');
  await completeVerification(engine, op);
}

async function continueAfterCrash(engine: Engine, op: OperationRecord): Promise<void> {
  try {
    await prepareAndSwitch(engine, op.id, { allowReuse: false });
  } catch (err) {
    await failBeforeSwitch(engine, op.id, failBody(engine, err, '切换到新版本失败：内部错误'));
  }
}

export { buildVerifyUrl };
