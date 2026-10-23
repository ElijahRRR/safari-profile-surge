// 准备页的到达与实测提交（docs/ARCHITECTURE.md §6.3 第 10–12 步、§6.4）。到达与签发检测编号是同步的
// （只读 SFE-ROUTE 选择）；提交只做编号、epoch、场景、截止时间的同步核对并消费编号，Surge 侧核对与入口写入
// 交给执行器（verify_submitted）。检测编号 ≥128 位随机、单次使用、绑定操作/环境/场景/epoch/截止时间。

import { isIP } from 'node:net';
import { SfeError, buildVerifyUrl, type BeginVerificationResponse, type NativeRequest } from '@sfe/contract';
import type { OperationRecord } from '../db/index.js';
import { payloadOf, type RoutePayload, type VerificationSubmission } from '../domain/operations.js';
import type { Engine } from './context.js';
import { currentSelection } from './handlers/route.js';

type SubmitMessage = Extract<NativeRequest, { type: 'submitSafariVerification' }>;

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
/** 浏览器与服务时钟的容差。 */
const CLOCK_GRACE_MS = 60_000;

function savePayload(engine: Engine, op: OperationRecord, patch: Partial<RoutePayload>): RoutePayload {
  const route = { ...payloadOf(op).route!, ...patch };
  engine.repos.operations.update(op.id, { payload: { ...payloadOf(op), route } });
  return route;
}

function opError(op: OperationRecord): SfeError {
  if (op.error) return new SfeError(op.error.code, op.error.message);
  return new SfeError('SUPERSEDED', '检测已结束：该操作不再等待检测');
}

export interface ArrivalContext {
  profileId: string;
  amazonTabsOpen: boolean;
  /** 执行器唤醒（新的 outbox 条目）。 */
  kick: () => void;
}

/**
 * 排队或执行中（含等待中但尚未进入检测阶段）的操作：按它实际要做的说明。重新检测（含激活复用时改为的重测，flow probe）从不切换、
 * 不阻断 Safari（§6.4），准备页不能说「正在切换出口」或「切换期间 Safari 的其他请求会被暂时拒绝」；激活与活动环境发布的切换才是。
 */
function inProgress(op: OperationRecord, p: RoutePayload): BeginVerificationResponse {
  if (p.flow === 'probe') return { status: 'pending', phase: op.phase, message: '正在开始重新检测，请稍候（不切换、不阻断 Safari）', switching: false };
  return { status: 'pending', phase: op.phase, message: '正在切换出口，请稍候', switching: true };
}

export async function beginVerification(engine: Engine, op: OperationRecord, ctx: ArrivalContext): Promise<BeginVerificationResponse> {
  const { repos } = engine;
  const p = payloadOf(op).route!;
  switch (op.phase) {
    case 'ACTIVE_VERIFIED':
    case 'NORMAL_RESTORED':
    case 'COMPLETED':
      return { status: 'not_needed', message: '已完成，不需要再次检测' };
    case 'READY_FOR_NEXT_OPEN': {
      // 目标版本已被之后保存的修改替换（§6.3 第 2 步）：不切换到它，也不提示「重新使用此环境」——那会选用已部署的这一版
      const env = repos.environments.get(p.targetEnvironmentId);
      if (p.purpose === 'apply_new_revision' && env && !env.deletedAt && env.desiredProxyRevision !== p.proxyRevision) {
        return { status: 'not_needed', message: '等待已结束：之后又修改了代理，不切换到这一版本，当前出口不变' };
      }
      return { status: 'not_needed', message: '等待已结束：新版本已部署，请重新使用此环境以切换' };
    }
    default:
      break;
  }
  if (op.status === 'failed' || op.status === 'superseded' || op.status === 'needs_attention' || op.status === 'succeeded' || op.status === 'parked') {
    throw opError(op);
  }
  if (op.status === 'queued' || op.status === 'running') return inProgress(op, p);
  // waiting
  if (op.phase === 'WAITING_ROUTE') {
    // 已受理取消（执行器忙时排在之后处理）：不再记到达、不排入 profile_arrived，等取消结束本操作（READY_FOR_NEXT_OPEN，当前出口不变）
    if (p.cancelRequested) return { status: 'pending', phase: op.phase, message: '已请求取消，正在处理', switching: false };
    if (p.arrivedAt === null) {
      repos.tx(() => {
        savePayload(engine, op, { arrivedAt: engine.nowIso(), arrivedProfileId: ctx.profileId, amazonTabsAtVerify: ctx.amazonTabsOpen });
        repos.operations.appendStep(op.id, op.phase, '绑定场景已到达');
      });
    }
    if (!repos.outbox.pendingForOperation(op.id).some((r) => r.resumeReason === 'profile_arrived')) {
      repos.outbox.enqueue(op.id, 'profile_arrived', engine.now());
    }
    ctx.kick();
    engine.emit({ operations: [op.id] });
    return { status: 'pending', phase: op.phase, message: '已到达，正在切换到新版本', switching: true };
  }
  if (p.stage !== 'verify_only' && p.stage !== 'probe_waiting') return inProgress(op, p);
  // 已受理取消（执行器忙时排在之后处理）：不再签发检测编号，等取消结束本操作
  if (p.cancelRequested) return { status: 'pending', phase: op.phase, message: '已请求取消，正在处理', switching: false };
  const route = repos.routeState.get();
  if (op.routeEpoch !== route.routeEpoch) throw new SfeError('STALE_ROUTE_EPOCH', '检测失败：路由已变化，请重新开始');
  if (p.stage === 'probe_waiting' && (route.entryMode !== 'ACTIVE' || route.phase !== 'active_verified')) {
    return { status: 'pending', phase: op.phase, message: '等待路由恢复到使用中状态', switching: false };
  }
  const now = engine.now();
  if (p.verifyDeadline !== null && Date.parse(p.verifyDeadline) <= now.getTime()) {
    throw new SfeError('SAFARI_VERIFY_TIMEOUT', 'Safari 实测超时：请重新开始');
  }
  // 签发前重读选择：必须仍是目标节点
  const sel = await currentSelection(engine);
  if (sel !== p.nodeName) throw new SfeError('SAFARI_VERIFY_FAILED', '检测失败：SFE-ROUTE 选择已不是目标节点');

  // 读取选择（一次 Surge 调用）期间执行器可能已结束本操作：开始执行的普通模式结束停在等待中的切换与重测（epoch 递增、路由交给
  // 它），取消、超时或回滚。签发在事务中重读操作与路由，任何一项变化都不签发——不给已结束的操作追加步骤、不在别的操作负责的
  // 路由上写等待截止时间、不安排计时器（§6.3 并发矩阵：取代使 test_id 失效）。
  const endpoint = engine.verifyEndpoint();
  const issued = repos.tx(() => {
    const fresh = repos.operations.get(op.id)!;
    const fp = payloadOf(fresh).route!;
    const fr = repos.routeState.get();
    if (fresh.status !== 'waiting' || (fp.stage !== 'verify_only' && fp.stage !== 'probe_waiting')) throw opError(fresh);
    if (fp.cancelRequested) return 'cancel_requested' as const;
    if (fresh.routeEpoch !== fr.routeEpoch || fr.routeEpoch !== route.routeEpoch) throw new SfeError('STALE_ROUTE_EPOCH', '检测失败：路由已变化，请重新开始');
    // 切换的 VERIFY_ONLY 等待由本操作负责路由；重测不写路由，只要求路由仍是使用中且已验证
    if (fp.stage === 'verify_only' && fr.operationId !== op.id) throw new SfeError('SUPERSEDED', '检测已结束：路由已由其他操作接手');
    if (fp.stage === 'probe_waiting' && (fr.entryMode !== 'ACTIVE' || fr.phase !== 'active_verified')) return null;
    const at = engine.now();
    if (fp.verifyDeadline !== null && Date.parse(fp.verifyDeadline) <= at.getTime()) throw new SfeError('SAFARI_VERIFY_TIMEOUT', 'Safari 实测超时：请重新开始');
    const existing = repos.verificationTests
      .listForOperation(op.id)
      .find((t) => t.consumedAt === null && t.profileId === ctx.profileId && t.routeEpoch === fr.routeEpoch && Date.parse(t.deadline) > at.getTime());
    if (existing) return { testId: existing.testId, routeEpoch: existing.routeEpoch, deadline: existing.deadline, first: false };
    const deadline = fp.verifyDeadline ?? new Date(at.getTime() + repos.settings.get('safariVerifyTimeoutSec') * 1000).toISOString();
    const testId = engine.ids.token(24);
    const first = fp.verifyDeadline === null;
    repos.verificationTests.insert({
      testId,
      operationId: op.id,
      environmentId: fp.targetEnvironmentId,
      profileId: ctx.profileId,
      routeEpoch: fr.routeEpoch,
      purpose: fp.purpose,
      deadline,
    });
    savePayload(engine, fresh, {
      verifyDeadline: deadline,
      arrivedAt: fp.arrivedAt ?? at.toISOString(),
      arrivedProfileId: ctx.profileId,
      amazonTabsAtVerify: fp.amazonTabsAtVerify ?? ctx.amazonTabsOpen,
    });
    if (first) {
      repos.routeState.update({ awaitingDeadline: deadline });
      repos.operations.appendStep(op.id, fresh.phase, ctx.amazonTabsOpen ? '绑定场景已到达（已有 Amazon 标签页：本次打开记为未经启动验证）' : '绑定场景已到达，开始出口检测');
      repos.outbox.enqueue(op.id, 'verify_timeout', deadline);
    }
    return { testId, routeEpoch: fr.routeEpoch, deadline, first };
  });
  if (issued === 'cancel_requested') return { status: 'pending', phase: op.phase, message: '已请求取消，正在处理', switching: false };
  if (!issued) return { status: 'pending', phase: op.phase, message: '等待路由恢复到使用中状态', switching: false };
  if (issued.first) {
    ctx.kick();
    engine.emit({ operations: [op.id], route: true });
  }
  return { status: 'ready', test_id: issued.testId, route_epoch: issued.routeEpoch, verify_url: buildVerifyUrl(endpoint, issued.testId), deadline: issued.deadline };
}

function parseIso(v: unknown): string | null {
  if (typeof v !== 'string' || !ISO_RE.test(v)) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

export function submitVerification(engine: Engine, msg: SubmitMessage, ctx: { profileId: string; environmentId: string; kick: () => void }): { accepted: boolean } {
  const { repos } = engine;
  const test = typeof msg.test_id === 'string' ? repos.verificationTests.get(msg.test_id) : null;
  if (!test || test.operationId !== msg.operation_id || test.profileId !== ctx.profileId || test.environmentId !== ctx.environmentId) {
    throw new SfeError('SAFARI_VERIFY_FAILED', '提交检测结果失败：检测编号无效');
  }
  if (test.consumedAt !== null) throw new SfeError('SAFARI_VERIFY_FAILED', '提交检测结果失败：检测编号已使用');
  const op = repos.operations.get(test.operationId);
  const p = op ? payloadOf(op).route : undefined;
  if (!op || !p || op.status !== 'waiting' || (p.stage !== 'verify_only' && p.stage !== 'probe_waiting')) {
    throw new SfeError('SUPERSEDED', '提交检测结果失败：该检测已结束或已被取代');
  }
  // 已受理取消：结果不能覆盖之后的取消（执行器同样按取消处理已排入的结果，completeVerification）
  if (p.cancelRequested) throw new SfeError('SUPERSEDED', '提交检测结果失败：已请求取消');
  const route = repos.routeState.get();
  if (msg.route_epoch !== test.routeEpoch || test.routeEpoch !== route.routeEpoch || op.routeEpoch !== route.routeEpoch) {
    throw new SfeError('STALE_ROUTE_EPOCH', '提交检测结果失败：路由已变化，结果不能用于当前切换');
  }
  const now = engine.now();
  if (Date.parse(test.deadline) <= now.getTime()) throw new SfeError('SAFARI_VERIFY_TIMEOUT', '提交检测结果失败：已超过检测截止时间');
  const startedAt = parseIso(msg.started_at);
  const finishedAt = parseIso(msg.finished_at);
  const fieldErrors: Array<{ field: string; message: string }> = [];
  if (!startedAt) fieldErrors.push({ field: 'started_at', message: '时间格式不正确' });
  if (!finishedAt) fieldErrors.push({ field: 'finished_at', message: '时间格式不正确' });
  if (startedAt && finishedAt) {
    const s = Date.parse(startedAt);
    const f = Date.parse(finishedAt);
    if (f < s) fieldErrors.push({ field: 'finished_at', message: '结束时间早于开始时间' });
    if (s < Date.parse(test.issuedAt) - CLOCK_GRACE_MS || f > now.getTime() + CLOCK_GRACE_MS) fieldErrors.push({ field: 'started_at', message: '检测时间不在本次检测的时间范围内' });
  }
  if (msg.observed_ip !== null && (typeof msg.observed_ip !== 'string' || isIP(msg.observed_ip) === 0)) fieldErrors.push({ field: 'observed_ip', message: '不是有效的 IP 地址' });
  if (msg.http_status !== null && (typeof msg.http_status !== 'number' || !Number.isInteger(msg.http_status) || msg.http_status < 100 || msg.http_status > 599)) {
    fieldErrors.push({ field: 'http_status', message: 'HTTP 状态码不正确' });
  }
  if (msg.error !== null && typeof msg.error !== 'string') fieldErrors.push({ field: 'error', message: '错误说明格式不正确' });
  if (fieldErrors.length > 0) throw new SfeError('VALIDATION_FAILED', '提交检测结果失败：字段不正确', { fieldErrors });
  if (!repos.verificationTests.consume(test.testId, now)) throw new SfeError('SAFARI_VERIFY_FAILED', '提交检测结果失败：检测编号已使用');
  const submission: VerificationSubmission = {
    testId: test.testId,
    observedIp: msg.observed_ip,
    httpStatus: msg.http_status,
    error: msg.error === null ? null : engine.scrubber.scrub(String(msg.error).slice(0, 300)),
    startedAt: startedAt!,
    finishedAt: finishedAt!,
    submittedAt: now.toISOString(),
  };
  repos.tx(() => {
    const fresh = repos.operations.get(op.id)!;
    repos.operations.update(op.id, { payload: { ...payloadOf(fresh), route: { ...payloadOf(fresh).route!, submission } } });
    repos.operations.appendStep(op.id, op.phase, '已收到出口检测结果');
    repos.outbox.enqueue(op.id, 'verify_submitted', now);
  });
  ctx.kick();
  engine.emit({ operations: [op.id] });
  return { accepted: true };
}
