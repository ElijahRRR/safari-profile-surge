// 操作的分类与 payload 结构（只含引用与非秘密参数；数据库写入时还会再拒绝秘密字段）。
// 路由类操作（激活、普通模式、Safari 重测，以及继续进入 WAITING_ROUTE 的活动环境发布）共用一套并发矩阵。

import type { OldSessionPolicy, OperationKind, OperationPhase, OperationStatus } from '@sfe/contract';
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
}

export interface NormalPayload {
  oldSessionPolicy: OldSessionPolicy | null;
  expectedActiveEnvironmentId: string | null;
  hadManagedEnvironment: boolean;
}

export interface OperationPayload {
  targets?: PublishTarget[];
  environmentIds?: string[] | null;
  children?: string[];
  parentOperationId?: string;
  route?: RoutePayload;
  normal?: NormalPayload;
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
