// 视图组装（纯函数）：数据库记录 → 契约视图。各面独立计算（facets），再由契约的 deriveReadiness 按固定优先级
// 得出汇总状态与下一步。视图从不含秘密：账号只给打码值，代理凭据只给“是否已配置”。

import {
  deriveReadiness,
  maskLoginIdentifier,
  shortProfileId,
  type ApiErrorBody,
  type CapabilityKey,
  type EnvironmentFacets,
  type EnvironmentView,
  type FrontProxyView,
  type NextAction,
  type OperationSummary,
  type OperationView,
  type PrecedenceIssue,
  type ProbeView,
  type ProxyRevisionView,
  type RouteStateView,
  type RouteSummaryView,
  type SurgeStatusView,
  type TakeoverState,
} from '@sfe/contract';
import type { RunningInstanceFailure, SurgeVersionCheckFailure } from '../surge/running-instance.js';
import type {
  AccountRecord,
  EnvironmentRecord,
  FrontProxyRecord,
  OperationRecord,
  OperationStepRecord,
  ProbeRecord,
  ProfileBindingRecord,
  ProfileReportRecord,
  ProxyRevisionRecord,
  RouteStateRecord,
} from '../db/index.js';
import { isPublishKind, payloadOf, type PublishTarget } from './operations.js';
import { safariProbeCurrent } from './route-rules.js';

// ---------- 基础视图 ----------

export function probeView(p: ProbeRecord): ProbeView {
  return {
    id: p.id,
    kind: p.kind,
    outcome: p.outcome,
    exitIp: p.exitIp,
    proxyRevision: p.proxyRevision,
    nodeName: p.nodeName,
    routeEpoch: p.routeEpoch,
    configurationGeneration: p.configurationGeneration,
    entryMode: p.entryMode,
    testId: p.testId,
    surgeRequest:
      p.surgeRequestId === null
        ? null
        : {
            id: p.surgeRequestId,
            remoteHost: p.surgeRemoteHost,
            rule: p.surgeRule,
            policyName: p.surgePolicy,
            startedAt: p.surgeStartedAt,
            newConnection: p.surgeNewConnection,
          },
    chainEvidence: p.chainEvidence,
    browser:
      p.browserHttpStatus === null && p.browserStartedAt === null && p.browserFinishedAt === null && p.browserError === null
        ? null
        : { httpStatus: p.browserHttpStatus, startedAt: p.browserStartedAt, finishedAt: p.browserFinishedAt, error: p.browserError },
    observedAt: p.observedAt,
    expiresAt: p.expiresAt,
    message: p.message,
  };
}

export function revisionView(rev: ProxyRevisionRecord, fronts: ReadonlyMap<string, FrontProxyRecord>): ProxyRevisionView {
  return {
    revision: rev.revision,
    protocol: rev.protocol,
    host: rev.host,
    port: rev.port,
    hasUsername: rev.usernameRef !== null,
    hasPassword: rev.passwordRef !== null,
    frontProxyId: rev.frontProxyId,
    frontProxyName: fronts.get(rev.frontProxyId)?.surgeName ?? '',
    nodeName: rev.nodeName,
    createdAt: rev.createdAt,
  };
}

export function operationSummary(op: OperationRecord): OperationSummary {
  return { id: op.id, kind: op.kind, phase: op.phase, status: op.status, error: op.error, updatedAt: op.updatedAt };
}

export interface OperationViewContext {
  env: EnvironmentRecord | null;
  route: RouteStateRecord;
  configurationGeneration: number;
}

export function buildOperationView(op: OperationRecord, steps: readonly OperationStepRecord[], ctx: OperationViewContext): OperationView {
  const env = ctx.env;
  return {
    ...operationSummary(op),
    requestId: op.requestId,
    environmentId: op.environmentId,
    initiator: op.initiatorKind,
    expectedRevision: op.expectedRevision,
    resultRevision: op.resultRevision,
    routeEpoch: op.routeEpoch,
    probeKind: op.probeKind,
    supersededBy: op.supersededBy,
    steps: steps.map((s) => ({ at: s.at, phase: s.phase, message: s.message })),
    effective: {
      desiredProxyRevision: env?.desiredProxyRevision ?? null,
      deployedProxyRevision: env?.deployedProxyRevision ?? null,
      activeProxyRevision: env && ctx.route.activeEnvironmentId === env.id ? ctx.route.activeProxyRevision : null,
      configurationGeneration: ctx.configurationGeneration,
      routeEpoch: op.routeEpoch,
    },
    result: (op.result as OperationView['result']) ?? null,
    createdAt: op.createdAt,
  };
}

export function buildRouteView(route: RouteStateRecord, lastSafariProbe: ProbeRecord | null): RouteStateView {
  return {
    routeEpoch: route.routeEpoch,
    entryMode: route.entryMode,
    entryModeVerifiedAt: route.entryModeVerifiedAt,
    phase: route.phase,
    activeEnvironmentId: route.activeEnvironmentId,
    activeProxyRevision: route.activeProxyRevision,
    selectedNode: route.selectedNode,
    oldSessionPolicy: route.oldSessionPolicy,
    lastSafariProbe: lastSafariProbe ? probeView(lastSafariProbe) : null,
    operationId: route.operationId,
    awaitingDeadline: route.awaitingDeadline,
    warnings: [...route.warnings],
    lastReconciledAt: route.lastReconciledAt,
    updatedAt: route.updatedAt,
  };
}

/** 非当前环境的场景只拿到路由摘要（不含实测、选择、操作 id）。 */
export function buildRouteSummary(route: RouteStateRecord): RouteSummaryView {
  return { routeEpoch: route.routeEpoch, entryMode: route.entryMode, phase: route.phase };
}

// ---------- Surge 状态 ----------

/**
 * Surge 可达、但运行中的版本与构建号不被接受的原因（内部；不进入契约视图，展示文字见 Engine.readBasicFacts）：
 * 运行实例读取（surge/running-instance.ts）的失败原因（例如 not_running、modified_after_start、running_image_mismatch），
 * 或与 `surge-cli --raw version` 交叉核对的结论：cli_version_unreadable、cli_bundle_mismatch、surge_version_unsupported
 * （低于最低支持版本 6.10.0 / 12500 / Controller 协议 22）。
 */
export type SurgeVersionIssue = RunningInstanceFailure | SurgeVersionCheckFailure;

export interface SurgeFacts {
  reachable: boolean;
  /**
   * 运行中 Surge 的版本与构建号：只有运行实例读取与 `surge-cli --raw version` 一致、且不低于最低支持版本时才填写；
   * 否则为 null（依赖版本的能力按待验证处理、相应动作拒绝，§5.2；进入普通模式不受影响）。
   */
  version: string | null;
  build: string | null;
  /** Controller 协议号（只来自 `surge-cli --raw version`，与版本、构建号一起接受或一起为 null）。 */
  controllerProtocol: number | null;
  /** 只在可达时填写：版本或构建号为 null 的原因；可达且都已确认时为 null。 */
  versionIssue: SurgeVersionIssue | null;
  /**
   * 引擎启动时间（getRuntimeInfo：`dump performance` 的 uptime 或 /v1/metrics 的 surge_uptime_seconds 换算，整秒）；
   * 读不到为 null。比较两次读取时用 surgeRestartedBetween（引擎 context.ts），不能直接比较字符串。
   */
  startedAt: string | null;
  /** 引擎运行时长（秒）；读不到为 null。 */
  uptimeSeconds: number | null;
  currentProfileName: string | null;
  currentProfilePath: string | null;
  onWorkingProfile: boolean | null;
  managedSectionsIntact: boolean | null;
  takeover: TakeoverState;
  autoReload: boolean | null;
  httpApi: { configured: boolean; loopbackOnly: boolean | null };
  profileDirectoryRisk: 'none' | 'synced' | 'protected' | null;
  precedenceIssues: PrecedenceIssue[];
  checkedAt: string | null;
  message: string | null;
}

export function emptySurgeFacts(): SurgeFacts {
  return {
    reachable: false,
    version: null,
    build: null,
    controllerProtocol: null,
    versionIssue: null,
    startedAt: null,
    uptimeSeconds: null,
    currentProfileName: null,
    currentProfilePath: null,
    onWorkingProfile: null,
    managedSectionsIntact: null,
    takeover: { enhancedMode: null, systemProxy: null, outboundMode: null, checkedAt: null },
    autoReload: null,
    httpApi: { configured: false, loopbackOnly: null },
    profileDirectoryRisk: null,
    precedenceIssues: [],
    checkedAt: null,
    message: '尚未读取 Surge 状态',
  };
}

export function buildSurgeStatus(facts: SurgeFacts, configurationGeneration: number): SurgeStatusView {
  return {
    reachable: facts.reachable,
    version: facts.version,
    build: facts.build,
    currentProfileName: facts.currentProfileName,
    onWorkingProfile: facts.onWorkingProfile,
    managedSectionsIntact: facts.managedSectionsIntact,
    configurationGeneration,
    takeover: { ...facts.takeover },
    autoReload: facts.autoReload,
    httpApi: { ...facts.httpApi },
    profileDirectoryRisk: facts.profileDirectoryRisk,
    precedenceIssues: facts.precedenceIssues.map((i) => ({ ...i })),
    lastCheckedAt: facts.checkedAt,
    message: facts.message,
  };
}

// ---------- 前置 ----------

export function buildFrontProxyViews(fronts: readonly FrontProxyRecord[], dependents: ReadonlyMap<string, string[]>): FrontProxyView[] {
  return fronts.map((f) => ({
    id: f.id,
    surgeName: f.surgeName,
    kind: f.kind,
    state: f.state,
    isDefault: f.isDefault && !f.retired,
    retired: f.retired,
    dependentEnvironmentIds: [...(dependents.get(f.id) ?? [])],
    lastCheckedAt: f.lastCheckedAt,
  }));
}

// ---------- 环境 ----------

/** 发布类操作对单个环境的结果（多目标操作记录在 result.targets）。 */
export type PublishTargetOutcome = 'deployed' | 'partial' | 'excluded' | 'failed' | 'invalid' | 'waiting_deployment' | 'superseded';

export interface PublishTargetResult extends PublishTarget {
  outcome: PublishTargetOutcome;
  error?: ApiErrorBody | null;
}

export type PublishState =
  | { kind: 'none' }
  | { kind: 'deploying' }
  | { kind: 'waiting_deployment'; capability: boolean }
  | { kind: 'failed'; error: ApiErrorBody | null }
  | { kind: 'invalid'; error: ApiErrorBody | null }
  | { kind: 'deployed' };

const INVALID_CODES = new Set(['VALIDATION_FAILED', 'UNSAFE_CREDENTIAL_CHARS', 'FRONT_PROXY_MISSING', 'FRONT_PROXY_CYCLE']);

function targetsOf(op: OperationRecord): PublishTarget[] {
  return payloadOf(op).targets ?? [];
}

function resultTargets(op: OperationRecord): PublishTargetResult[] {
  const r = op.result as { targets?: PublishTargetResult[] } | null;
  return Array.isArray(r?.targets) ? r!.targets! : [];
}

/** 最近一次涉及该环境该版本的发布类操作的状态。ops 按时间倒序。 */
export function publishStateFor(ops: readonly OperationRecord[], environmentId: string, revision: number): PublishState {
  for (const op of ops) {
    if (!isPublishKind(op.kind)) continue;
    const targets = targetsOf(op);
    const matches = targets.some((t) => t.environmentId === environmentId && t.proxyRevision === revision);
    if (!matches && !(op.environmentId === environmentId && targets.length === 0 && op.kind !== 'deploy.publish')) continue;
    const outcome = resultTargets(op).find((t) => t.environmentId === environmentId && t.proxyRevision === revision);
    if (outcome) {
      switch (outcome.outcome) {
        case 'deployed':
          return { kind: 'deployed' };
        case 'partial':
          return { kind: 'deployed' };
        case 'invalid':
          return { kind: 'invalid', error: outcome.error ?? null };
        case 'waiting_deployment':
          return { kind: 'waiting_deployment', capability: outcome.error?.code === 'CAPABILITY_UNVERIFIED' };
        case 'failed':
        case 'excluded':
          return outcome.error && INVALID_CODES.has(outcome.error.code)
            ? { kind: 'invalid', error: outcome.error }
            : { kind: 'failed', error: outcome.error ?? null };
        case 'superseded':
          continue;
      }
    }
    if (op.status === 'queued' || op.status === 'running') return { kind: 'deploying' };
    if (op.phase === 'WAITING_DEPLOYMENT') return { kind: 'waiting_deployment', capability: op.error?.code === 'CAPABILITY_UNVERIFIED' };
    if (op.status === 'failed' || op.status === 'needs_attention') {
      return op.error && INVALID_CODES.has(op.error.code) ? { kind: 'invalid', error: op.error } : { kind: 'failed', error: op.error };
    }
    return { kind: 'deployed' };
  }
  return { kind: 'none' };
}

export interface EnvironmentViewData {
  env: EnvironmentRecord;
  revisions: readonly ProxyRevisionRecord[];
  binding: ProfileBindingRecord | null;
  report: ProfileReportRecord | null;
  account: AccountRecord | null;
  preflight: ProbeRecord | null;
  safari: ProbeRecord | null;
  /** 与该环境相关的最近操作（倒序）：自己的操作与目标包含它的多目标发布。 */
  operations: readonly OperationRecord[];
  /** 进行中的、以该环境为目标的路由类操作。 */
  routeOps: readonly OperationRecord[];
}

export interface EnvironmentViewContext {
  now: Date;
  route: RouteStateRecord;
  fronts: ReadonlyMap<string, FrontProxyRecord>;
  publishMissing: readonly CapabilityKey[];
  activateMissing: readonly CapabilityKey[];
}

function routeFacet(d: EnvironmentViewData, route: RouteStateRecord): EnvironmentFacets['route'] {
  for (const op of d.routeOps) {
    const stage = payloadOf(op).route?.stage;
    if (op.status === 'waiting' && op.phase === 'WAITING_ROUTE') return 'waiting_route';
    if (op.status === 'waiting' && stage === 'verify_only') return 'verifying';
    if (op.kind === 'probe.safari' || payloadOf(op).route?.flow === 'probe') continue;
    if (op.status === 'queued' || op.status === 'running') return 'activating';
  }
  if (route.activeEnvironmentId === d.env.id) {
    if (route.warnings.includes('rollback_needs_reverify')) return 'rolled_back';
    if (route.phase === 'active_verified' || route.phase === 'attention' || route.phase === 'external_change') return 'active';
  }
  return 'inactive';
}

function preflightFacet(d: EnvironmentViewData, now: Date): EnvironmentFacets['preflight'] {
  const p = d.preflight;
  if (!p || d.env.deployedProxyRevision === null || p.proxyRevision !== d.env.deployedProxyRevision) return 'none';
  if (p.outcome === 'failed' || p.outcome === 'mismatch') return 'failed';
  if (Date.parse(p.expiresAt) <= now.getTime()) return 'expired';
  return p.outcome === 'ok' ? 'ok' : 'inconclusive';
}

export function buildEnvironmentView(d: EnvironmentViewData, ctx: EnvironmentViewContext): EnvironmentView {
  const { env } = d;
  const revs = new Map(d.revisions.map((r) => [r.revision, r]));
  const rv = (n: number | null): ProxyRevisionView | null => {
    if (n === null) return null;
    const r = revs.get(n);
    return r ? revisionView(r, ctx.fronts) : null;
  };
  const desired = env.desiredProxyRevision !== null ? (revs.get(env.desiredProxyRevision) ?? null) : null;
  const publish = desired ? publishStateFor(d.operations, env.id, desired.revision) : ({ kind: 'none' } as PublishState);

  const front = desired ? ctx.fronts.get(desired.frontProxyId) : undefined;
  const frontInvalid = desired !== null && (front === undefined || front.retired);
  const input: EnvironmentFacets['input'] = publish.kind === 'invalid' || frontInvalid ? 'invalid' : 'valid';

  let deployment: EnvironmentFacets['deployment'];
  if (desired === null) deployment = 'none';
  else if (env.deployedProxyRevision === desired.revision) deployment = 'deployed';
  else if (desired.state === 'deployed') deployment = 'readback_partial';
  else if (publish.kind === 'deploying') deployment = 'deploying';
  else if (publish.kind === 'waiting_deployment') deployment = publish.capability || ctx.publishMissing.length > 0 ? 'blocked_by_capability' : 'pending';
  else if (publish.kind === 'failed' || publish.kind === 'invalid') deployment = 'failed';
  else deployment = ctx.publishMissing.length > 0 ? 'blocked_by_capability' : 'pending';

  const binding = d.binding;
  const facets: EnvironmentFacets = {
    input,
    binding: binding ? binding.state : 'unbound',
    deployment,
    preflight: preflightFacet(d, ctx.now),
    route: routeFacet(d, ctx.route),
  };

  const isActive = ctx.route.activeEnvironmentId === env.id;
  const safariProbeExpired = isActive && !safariProbeCurrent(ctx.route, d.safari, ctx.now);
  const derived = deriveReadiness({
    facets,
    hasDeployedRevision: env.deployedProxyRevision !== null,
    pendingNewerRevision: env.desiredProxyRevision !== null && env.desiredProxyRevision !== env.deployedProxyRevision,
    publishMissing: ctx.publishMissing,
    activateMissing: ctx.activateMissing,
    accountChangedSincePageCheck: d.account?.changedSincePageCheck ?? false,
    safariProbeExpired,
  });
  let nextActions: NextAction[] = derived.nextActions;
  if (facets.route === 'active' && (ctx.route.phase === 'attention' || ctx.route.phase === 'external_change')) {
    // 失控后不能“重新检测”了事：需要显式重新使用此环境（重新接管）或进入普通模式。
    const primary: NextAction = { kind: 'activate', message: '路由状态需要处理：请重新使用此环境或进入普通模式' };
    nextActions = [primary, ...nextActions.filter((a) => a.kind !== 'probe_safari' && a.kind !== 'open_orders' && a.kind !== 'activate')];
  }

  const last = d.operations[0] ?? null;
  const lastError: ApiErrorBody | null =
    last && (last.status === 'failed' || last.status === 'needs_attention' || last.phase === 'WAITING_DEPLOYMENT') ? last.error : null;

  return {
    id: env.id,
    code: env.code,
    nodeTag: env.nodeTag,
    displayName: env.displayName,
    site: env.site,
    autoOpenOrders: env.autoOpenOrders,
    autoFillLogin: env.autoFillLogin,
    expectedExitIp: env.expectedExitIp,
    revision: env.revision,
    binding: {
      state: binding ? binding.state : 'unbound',
      stage: binding ? null : env.bindingStage,
      profileIdShort: binding ? shortProfileId(binding.profileId) : null,
      boundAt: binding ? binding.boundAt : null,
      sitePermissionGranted: d.report ? d.report.sitePermissionGranted : null,
    },
    proxy: {
      desired: rv(env.desiredProxyRevision),
      deployed: rv(env.deployedProxyRevision),
      active: isActive ? rv(ctx.route.activeProxyRevision) : null,
      lastVerified: rv(env.lastVerifiedProxyRevision),
    },
    account: {
      label: d.account?.label ?? null,
      loginIdentifierMasked: maskLoginIdentifier(d.account?.loginIdentifier ?? null),
      hasLoginIdentifier: Boolean(d.account?.loginIdentifier),
      hasPassword: Boolean(d.account?.passwordRef),
      pageIdentity: 'unverified',
      changedSincePageCheck: d.account?.changedSincePageCheck ?? false,
    },
    facets,
    readiness: derived.readiness,
    nextActions,
    probes: {
      preflight: d.preflight ? probeView(d.preflight) : null,
      safari: d.safari ? probeView(d.safari) : null,
    },
    lastOperation: last ? operationSummary(last) : null,
    lastError,
    createdAt: env.createdAt,
    updatedAt: env.updatedAt,
  };
}
