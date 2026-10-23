// 操作的分类与 payload 结构（只含引用与非秘密参数；数据库写入时还会再拒绝秘密字段）。
// 路由类操作（激活、普通模式、Safari 重测，以及继续进入 WAITING_ROUTE 的活动环境发布）共用一套并发矩阵。

import type { ApiErrorBody, OldSessionPolicy, OperationKind, OperationPhase, OperationStatus } from '@sfe/contract';
import type { OperationRecord, VerificationPurpose } from '../db/index.js';

export const PUBLISH_KINDS: readonly OperationKind[] = ['environment.create', 'environment.update', 'deploy.publish', 'front.replace', 'import.batch'];
export const ROUTE_KINDS: readonly OperationKind[] = ['route.activate', 'route.normal', 'probe.safari'];
export const OPEN_STATUSES: readonly OperationStatus[] = ['queued', 'running', 'waiting'];

export interface PublishTarget {
  environmentId: string;
  proxyRevision: number;
}

/** 浏览器侧提交的实测结果（不含秘密）。 */
export interface VerificationSubmission {
  testId: string;
  observedIp: string | null;
  httpStatus: number | null;
  error: string | null;
  startedAt: string;
  finishedAt: string;
  submittedAt: string;
}

export type RouteStage =
  /** 已受理，执行器尚未开始写入。 */
  | 'pending'
  /** 活动环境发布完成，等待绑定场景到达（不阻断 Safari）。 */
  | 'waiting_route'
  /** 场景已到达，等待执行器继续切换。 */
  | 'arrived'
  /** 已递增 epoch 并开始写入入口/选择。 */
  | 'switching'
  /** 入口为 VERIFY_ONLY，等待场景到达与实测。 */
  | 'verify_only'
  /** Safari 重测：入口保持 ACTIVE，等待实测。 */
  | 'probe_waiting'
  | 'done';

export interface RoutePayload {
  targetEnvironmentId: string;
  proxyRevision: number;
  nodeName: string;
  purpose: VerificationPurpose;
  /** probe：不切换，只做 Safari 重测（激活复用时也可能转为 probe）。 */
  flow: 'activate' | 'probe';
  oldSessionPolicy: OldSessionPolicy | null;
  /** 执行时活动环境必须等于它，否则失败并要求重新确认。 */
  expectedActiveEnvironmentId: string | null;
  /** 跨环境切换（目标与切换前活动环境不同）。 */
  crossEnvironment: boolean;
  /** 发起时或开始实测时本场景已有 Amazon 标签页。 */
  amazonTabsAtLaunch: boolean | null;
  amazonTabsAtVerify: boolean | null;
  stage: RouteStage;
  arrivalDeadline: string | null;
  verifyDeadline: string | null;
  arrivedAt: string | null;
  arrivedProfileId: string | null;
  submission: VerificationSubmission | null;
  cancelRequested: boolean;
  /** 预检推迟到选择之后（independent_node_preflight 未通过）。 */
  preflightDeferred: boolean;
  /**
   * 第 7 步在已确认的阻断下结束并重新列出确认了 Safari 的全部连接，含持久标记中被换掉的进程路径上可能经买家出口的连接
   * （safari-route-marker.ts）：提交时据此清除 buyer_exit_connections_unconfirmed。缺省（升级前已在进行中的激活）不清除。
   */
  safariConnectionsEnded?: boolean;
  /**
   * 等待中的操作已开始结束（超时、取消、目标版本已被替换；handlers/route.ts endRouteOp）：结束点还要读写 Surge（holdAtRouteEnd），
   * 期间操作已同步改为 running，这里记下要结束成什么。原生桥、受理与保存处理器据此不再签发检测编号、记到达、取消或取代它；
   * 服务在结束点崩溃时，崩溃恢复按它重新结束（recoverRoute），不重新开始等待。
   */
  ending?: RouteEnding;
  /**
   * Safari 重测的核对已判定失败或不符（handlers/route.ts completeVerification）：结束点还要读写 Surge（holdAtRouteEnd）才记下
   * 警告与实测记录，期间服务崩溃时崩溃恢复按它重新结束（recoverRoute），不重新开始检测——检测编号已消费，准备页只轮询操作，
   * 不会再提交；重新开始的等待只会按超时结束、不加警告，不符的出口仍被当作已验证的路由。
   */
  verdict?: ProbeVerdict;
  /**
   * 激活核对通过、开始把入口写入使用中模式（ACTIVE）：写入之前记下（与持久标记同一事务）。之后 Safari 的全部请求（含目标环境
   * 场景中已打开的窗口）可能已经过目标环境的出口；这次写入之后回滚（写入或读回失败、提交失败、写入期间崩溃）时据此带旧窗口
   * 警告（managed_windows_on_original_rules），与让给排队普通模式的切换相同（§6.1、§6.5）。
   */
  activeWriteStarted?: boolean;
}

/** 重测核对的判定（RoutePayload.verdict）：失败原因与 Surge 请求记录中的证据（写入实测记录的字段，不含秘密）。 */
export interface ProbeVerdict {
  failure: ApiErrorBody;
  evidence: SafariProbeEvidence;
  /**
   * 核对读到的 SFE-ROUTE 选择（读不到时没有这一项）：崩溃恢复重新结束时同样随结束点传入（holdAtRouteEnd 的 observedSelection），
   * 结束点重读失败时不把「选择已不是目标节点」的判定当作路由未改变。早先的记录没有这一项。
   */
  observedSelection?: string | null;
}

/** Safari 实测记录中来自 Surge 请求记录的证据字段（没有匹配的请求记录时为空对象）。 */
export interface SafariProbeEvidence {
  surgeRequestId?: string | null;
  surgeRemoteHost?: string | null;
  surgeRule?: string | null;
  surgePolicy?: string | null;
  surgeStartedAt?: string | null;
  surgeNewConnection?: boolean | null;
}

/**
 * 路由操作的结束点即将改选 REJECT（handlers/route.ts holdAtRouteEnd）：改选之前记下。改选之后、记下改选之前服务崩溃时，崩溃恢复
 * 重新结束的结束点读回 REJECT——没有这一记录就分不清是本操作改选的还是之前已是 REJECT，会按没有改选结束（「路由未改变」）。
 * externalSelectionBefore：记下时路由是否已带 external_selection_change（之后才出现的是启动对账把本操作的改选当作外部修改）。
 */
export interface EndHoldIntent {
  externalSelectionBefore: boolean;
}

/** RoutePayload.ending：结束点要记下的结束状态（结束点改选 REJECT 时另按 holdAtRouteEnd 改为需要处理）。 */
export interface RouteEnding {
  phase: OperationPhase;
  status: OperationStatus;
  error: ApiErrorBody | null;
  step: string;
  cancelOutbox: boolean;
}

export interface NormalPayload {
  oldSessionPolicy: OldSessionPolicy | null;
  expectedActiveEnvironmentId: string | null;
  hadManagedEnvironment: boolean;
  /** 受理时已排队或正在执行的路由操作（普通模式排在它们之后，§6.3 并发矩阵）；早先的记录没有这一项。 */
  queuedBehind?: string[];
  /**
   * 交给本次普通模式的切换已把入口写入使用中模式（ACTIVE 已读回确认、未提交）的目标环境：Safari 的全部请求（含该环境场景中
   * 已打开的窗口）已经过它的出口，而受理时的旧窗口确认针对的是当时的使用中环境（或没有）。完成时它的窗口同样按 Surge 原规则
   * 发出，确认没有覆盖它时路由带 managed_windows_on_original_rules（§6.1、§6.5）。
   */
  handedOverActiveTarget?: string;
}

export interface OperationPayload {
  targets?: PublishTarget[];
  environmentIds?: string[] | null;
  children?: string[];
  parentOperationId?: string;
  route?: RoutePayload;
  normal?: NormalPayload;
  /** 路由操作的结束点即将改选 REJECT（holdAtRouteEnd）：见 EndHoldIntent。 */
  endHold?: EndHoldIntent;
  frontProxyId?: string;
  [key: string]: unknown;
}

export function newRoutePayload(
  init: Pick<RoutePayload, 'targetEnvironmentId' | 'proxyRevision' | 'nodeName' | 'purpose'> & Partial<RoutePayload>,
): RoutePayload {
  return {
    flow: 'activate',
    oldSessionPolicy: null,
    expectedActiveEnvironmentId: null,
    crossEnvironment: false,
    amazonTabsAtLaunch: null,
    amazonTabsAtVerify: null,
    stage: 'pending',
    arrivalDeadline: null,
    verifyDeadline: null,
    arrivedAt: null,
    arrivedProfileId: null,
    submission: null,
    cancelRequested: false,
    preflightDeferred: false,
    ...init,
  };
}

export function payloadOf(op: Pick<OperationRecord, 'payload'>): OperationPayload {
  return (op.payload ?? {}) as OperationPayload;
}

export function isPublishKind(kind: OperationKind): boolean {
  return PUBLISH_KINDS.includes(kind);
}

export function isOpen(op: Pick<OperationRecord, 'status'>): boolean {
  return OPEN_STATUSES.includes(op.status);
}

/** 该操作当前是否处于路由阶段（参与路由并发矩阵）。 */
export function isRouteOperation(op: Pick<OperationRecord, 'kind' | 'payload' | 'status' | 'phase'>): boolean {
  if (!isOpen(op)) return false;
  if (ROUTE_KINDS.includes(op.kind)) return true;
  return payloadOf(op).route !== undefined;
}

/** 路由操作所针对的环境（普通模式为 null）。 */
export function routeTargetOf(op: Pick<OperationRecord, 'payload'>): string | null {
  return payloadOf(op).route?.targetEnvironmentId ?? null;
}

/** 活动环境发布后停在 WAITING_ROUTE（尚未开始切换，旧版本继续使用）。 */
export function isWaitingRoute(op: Pick<OperationRecord, 'status' | 'phase' | 'payload'>): boolean {
  return op.status === 'waiting' && op.phase === 'WAITING_ROUTE';
}

/** 等待场景到达或实测的激活/重测（VERIFY_ONLY 或重测等待）。 */
export function isWaitingVerification(op: Pick<OperationRecord, 'status' | 'phase' | 'payload' | 'kind'>): boolean {
  if (op.status !== 'waiting') return false;
  const stage = payloadOf(op).route?.stage;
  return stage === 'verify_only' || stage === 'probe_waiting';
}

export const PHASES_BEFORE_ROUTE_WRITES: readonly OperationPhase[] = ['SAVED', 'VALIDATING', 'PREFLIGHT_OK'];
