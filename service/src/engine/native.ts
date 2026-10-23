// 原生桥消息（docs/ARCHITECTURE.md §7.2、contract/native.ts）。场景身份只来自原生桥（令牌已由 ipc 层校验），
// 从不采信消息体中的身份字段。按 NATIVE_PERMISSIONS 矩阵与绑定关系授权：携带 environment_id 的请求先与场景绑定
// 比对（BINDING_MISMATCH，在版本检查与创建操作之前）；未识别场景只能读取状态（看不到其他环境名称）与上报窗口（只用于旧窗口确认）；
// 非活动环境的场景只拿到路由摘要。登录填充按 §6.10 逐项把关，全部通过后才从本机后台资料读出账号密码（登记到脱敏器）
// 交给已认证的原生桥，原生桥原样转给扩展；任何一项未通过都不读取、不返回值。

import {
  CAPABILITY_GATES,
  NATIVE_PERMISSIONS,
  SfeError,
  classifySiteUrl,
  readinessAllowsActivation,
  shortProfileId,
  type BridgeEnvelope,
  type CurrentStateResponse,
  type LoginFillServiceResponse,
  type NativeRequest,
  type NativeResponse,
  type OperationView,
} from '@sfe/contract';
import type { Actor } from '../app.js';
import type { OperationRecord } from '../db/index.js';
import { labelOf } from '../domain/naming.js';
import { OPEN_STATUSES, payloadOf } from '../domain/operations.js';
import { buildRouteSummary } from '../domain/views.js';
import {
  acceptAcknowledgeAccount,
  acceptActivate,
  acceptAcknowledgeWindows,
  acceptBind,
  acceptCancel,
  acceptCreate,
  acceptNormal,
  acceptProbe,
  acceptUpdate,
  type AcceptDeps,
} from './accept.js';
import type { Engine } from './context.js';
import type { ControlEvaluation } from '../domain/route-rules.js';
import { recordUnidentifiedProfileReport, routeOps } from './route-control.js';
import { normalModeOffered } from './safari-route-marker.js';
import { beginVerification, submitVerification } from './verification.js';

type ProfileState = 'unidentified' | 'unbound' | 'bound';

export interface NativeDeps extends AcceptDeps {
  /** 动作前短超时对账后的“受控”判定；maxAgeMs 内的缓存结果可复用。 */
  ensureInControl: (opts: { maxAgeMs: number }) => Promise<ControlEvaluation>;
}

function fillDenied(message: string, reason: string, extra: Record<string, unknown> = {}): SfeError {
  return new SfeError('FILL_NOT_ALLOWED', `填充失败：${message}`, { details: { reason, ...extra } });
}

/** 针对环境的请求：environment_id 必须等于场景绑定的环境。 */
function requireOwnEnvironment(boundEnvId: string, environmentId: unknown): void {
  if (environmentId !== boundEnvId) throw new SfeError('BINDING_MISMATCH', '请求失败：当前 Safari 场景没有关联这个环境');
}

export async function handleNative(deps: NativeDeps, envelope: BridgeEnvelope): Promise<NativeResponse> {
  try {
    return { ok: true, data: await dispatchNative(deps, envelope) };
  } catch (err) {
    return { ok: false, error: deps.engine.errorBody(err, '处理扩展请求失败：内部错误') };
  }
}

async function dispatchNative(deps: NativeDeps, envelope: BridgeEnvelope): Promise<unknown> {
  const { engine } = deps;
  const { repos } = engine;
  const msg = envelope?.message as NativeRequest | undefined;
  if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string' || !Object.hasOwn(NATIVE_PERMISSIONS, msg.type)) {
    throw new SfeError('BAD_REQUEST', '处理扩展请求失败：消息类型不受支持');
  }
  const profileId = envelope.bridge?.profileId ?? null;
  const binding = profileId ? repos.profileBindings.byProfile(profileId) : null;
  const boundEnv = binding ? repos.environments.get(binding.environmentId) : null;
  const state: ProfileState = profileId === null ? 'unidentified' : binding && boundEnv && !boundEnv.deletedAt ? 'bound' : 'unbound';
  if (!NATIVE_PERMISSIONS[msg.type].includes(state)) {
    if (state === 'unidentified') throw new SfeError('PROFILE_UNBOUND', '请求失败：无法识别当前 Safari 场景');
    if (state === 'bound') throw new SfeError('PROFILE_ALREADY_BOUND', '请求失败：当前场景已关联环境');
    throw new SfeError('PROFILE_UNBOUND', '请求失败：当前 Safari 场景尚未关联环境');
  }
  const actor: Actor = { kind: 'bridge', profileId };
  const envId = state === 'bound' ? boundEnv!.id : null;

  switch (msg.type) {
    case 'getCurrentState':
      return currentState(deps, profileId, envId);
    case 'reportProfileState': {
      const windows = Number.isInteger(msg.windows_open) && msg.windows_open >= 0 ? Math.min(msg.windows_open, 10_000) : 0;
      const report = { windowsOpen: windows, amazonTabsOpen: msg.amazon_tabs_open === true, sitePermissionGranted: msg.site_permission_granted === true };
      // 未识别场景（可能是默认场景）同样计入旧窗口确认的“其他场景有打开的窗口”，记入共用的一条记录
      if (profileId === null) recordUnidentifiedProfileReport(engine, report);
      else repos.profileReports.upsert({ profileId, ...report });
      if (envId) engine.emit({ environments: [envId] });
      return { recorded: true };
    }
    case 'bindCurrentProfile': {
      engine.requireCapabilities(CAPABILITY_GATES.bind, '关联场景');
      const verified = engine.missing(['native_profile_id']).length === 0;
      return acceptBind(deps, profileId!, msg, actor, verified ? 'bound' : 'bound_unverified_id');
    }
    case 'createAndBindEnvironment': {
      engine.requireCapabilities(CAPABILITY_GATES.bind, '新建并关联');
      const verified = engine.missing(['native_profile_id']).length === 0;
      return acceptCreate(deps, { request_id: msg.request_id, environment: msg.environment }, actor, { bindProfileId: profileId!, bindingState: verified ? 'bound' : 'bound_unverified_id' });
    }
    case 'updateCurrentEnvironment':
      requireOwnEnvironment(envId!, msg.environment_id);
      return acceptUpdate(deps, envId!, { request_id: msg.request_id, expected_revision: msg.expected_revision, changes: msg.changes }, actor);
    case 'activateCurrentEnvironment': {
      requireOwnEnvironment(envId!, msg.environment_id);
      const req: Parameters<typeof acceptActivate>[2] = { request_id: msg.request_id };
      if (msg.old_session_policy !== undefined) req.old_session_policy = msg.old_session_policy;
      if (msg.confirmed_environment_id !== undefined) req.confirmed_environment_id = msg.confirmed_environment_id;
      if (msg.proxy_revision !== undefined) req.proxy_revision = msg.proxy_revision;
      return acceptActivate(deps, envId!, req, actor, { amazonTabsOpen: msg.amazon_tabs_open === true });
    }
    case 'enterNormalMode': {
      const req: Parameters<typeof acceptNormal>[1] = { request_id: msg.request_id };
      if (msg.old_session_policy !== undefined) req.old_session_policy = msg.old_session_policy;
      if (msg.confirmed_environment_id !== undefined) req.confirmed_environment_id = msg.confirmed_environment_id;
      return acceptNormal(deps, req, actor);
    }
    case 'probeCurrentEnvironment':
      requireOwnEnvironment(envId!, msg.environment_id);
      return acceptProbe(deps, envId!, { request_id: msg.request_id, kind: msg.kind }, actor);
    case 'acknowledgeAccountChange':
      requireOwnEnvironment(envId!, msg.environment_id);
      return acceptAcknowledgeAccount(deps, envId!, { request_id: msg.request_id, expected_revision: msg.expected_revision }, actor);
    case 'getOperation':
      return scopedOperation(deps, msg.operation_id, profileId!, envId);
    case 'cancelOperation':
      return acceptCancel(deps, msg.operation_id, { request_id: msg.request_id }, actor, (op) => operationVisible(op, profileId!, envId));
    case 'acknowledgeWindowsClosed': {
      const r = await acceptAcknowledgeWindows(deps, { request_id: msg.request_id }, actor);
      return { cleared: r.cleared };
    }
    case 'beginSafariVerification': {
      const op = ownRouteOperation(deps, msg.operation_id, envId!);
      return beginVerification(engine, op, { profileId: profileId!, amazonTabsOpen: msg.amazon_tabs_open === true, kick: deps.kick });
    }
    case 'submitSafariVerification': {
      ownRouteOperation(deps, msg.operation_id, envId!);
      return submitVerification(engine, msg, { profileId: profileId!, environmentId: envId!, kick: deps.kick });
    }
    case 'requestLoginFill':
      return loginFill(deps, msg, envId!);
    default:
      throw new SfeError('BAD_REQUEST', '处理扩展请求失败：消息类型不受支持');
  }
}

function operationVisible(op: OperationRecord, profileId: string, envId: string | null): boolean {
  if (envId !== null && (op.environmentId === envId || payloadOf(op).route?.targetEnvironmentId === envId)) return true;
  return op.initiatorKind === 'bridge' && op.initiatorProfileId === profileId;
}

function scopedOperation(deps: NativeDeps, id: unknown, profileId: string, envId: string | null): OperationView {
  const op = typeof id === 'string' ? deps.engine.repos.operations.get(id) : null;
  if (!op || !operationVisible(op, profileId, envId)) throw new SfeError('NOT_FOUND', '读取操作失败：操作不存在');
  return deps.views.operationView(op.id)!;
}

function ownRouteOperation(deps: NativeDeps, id: unknown, envId: string): OperationRecord {
  const op = typeof id === 'string' ? deps.engine.repos.operations.get(id) : null;
  const target = op ? payloadOf(op).route?.targetEnvironmentId : undefined;
  if (!op || target === undefined) throw new SfeError('NOT_FOUND', '检测失败：操作不存在');
  if (target !== envId) throw new SfeError('BINDING_MISMATCH', '检测失败：当前 Safari 场景没有关联该操作的环境');
  return op;
}

async function currentState(deps: NativeDeps, profileId: string | null, envId: string | null): Promise<CurrentStateResponse> {
  const { engine, views } = deps;
  const { repos } = engine;
  const route = repos.routeState.get();
  const active = route.activeEnvironmentId;
  const relation: CurrentStateResponse['relation'] = active === null ? 'none_active' : active === envId ? 'this_active' : 'other_active';
  const activeEnv = active ? repos.environments.get(active) : null;
  const environment = envId ? views.environmentView(envId) : null;

  let pendingVerification: CurrentStateResponse['pendingVerification'] = null;
  if (envId) {
    const open = repos.operations
      .listByStatus([...OPEN_STATUSES])
      .filter((op) => payloadOf(op).route?.targetEnvironmentId === envId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    const op = open[0];
    if (op) {
      const p = payloadOf(op).route!;
      const kind = p.flow === 'probe' ? 'probe_safari' : p.purpose === 'apply_new_revision' ? 'apply_new_revision' : p.purpose === 'reverify' ? 'reverify' : 'activate';
      pendingVerification = { operation_id: op.id, kind, deadline: p.verifyDeadline ?? p.arrivalDeadline };
    }
  }

  let activationAvailable = false;
  let activationBlockedReason: string | null = null;
  let ordersAllowed = false;
  let ordersBlockedReason: string | null = null;
  if (!envId || !environment) {
    activationBlockedReason = profileId === null ? '无法识别当前 Safari 场景' : '当前场景尚未关联环境';
    ordersBlockedReason = activationBlockedReason;
  } else {
    const missing = engine.activationMissing();
    const ops = routeOps(engine);
    if (!readinessAllowsActivation(environment.readiness)) activationBlockedReason = environment.nextActions[0]?.message ?? '环境当前不能使用';
    else if (missing.length > 0) activationBlockedReason = '切换出口所需能力尚未通过实测';
    else if (ops.busy.length > 0) activationBlockedReason = '正在切换出口或检测，请稍后再试';
    else activationAvailable = true;
    if (relation !== 'this_active') {
      ordersBlockedReason = relation === 'other_active' ? '其他环境正在使用' : '当前没有使用中的环境';
    } else {
      const control = await deps.ensureInControl({ maxAgeMs: 5_000 });
      if (control.ok) ordersAllowed = true;
      else ordersBlockedReason = control.reason;
    }
  }
  return {
    profile: { identified: profileId !== null, profileIdShort: shortProfileId(profileId) },
    environment,
    route: relation === 'this_active' ? views.routeView() : null,
    routeSummary: buildRouteSummary(route, normalModeOffered(engine, route)),
    relation,
    // 未识别场景不返回其他环境名称
    otherActiveLabel: relation === 'other_active' && profileId !== null && activeEnv ? labelOf(activeEnv) : null,
    pendingVerification,
    bindable:
      profileId !== null && envId === null
        ? repos.environments
            .list()
            .filter((e) => !repos.profileBindings.byEnvironment(e.id))
            .map((e) => ({ id: e.id, label: labelOf(e), site: e.site, revision: e.revision }))
        : [],
    activationAvailable,
    activationBlockedReason,
    ordersAllowed,
    ordersBlockedReason,
  };
}

/**
 * §6.10：逐项把关；全部通过后读出账号标识与密码直接给值（密码从本机后台资料读出，立即登记到脱敏器；
 * 日志只记字段名）。读取之后再次确认 epoch 与活动环境，期间变化则不返回任何值。
 */
async function loginFill(deps: NativeDeps, msg: Extract<NativeRequest, { type: 'requestLoginFill' }>, envId: string): Promise<LoginFillServiceResponse> {
  const { engine } = deps;
  const { repos } = engine;
  const missing = engine.missing(CAPABILITY_GATES.fillAndAutoOpen);
  if (missing.length > 0) throw fillDenied('登录填充所需能力尚未通过实测', 'capability', { missing });
  if (msg.frame_is_top !== true) throw fillDenied('只在顶层页面填充', 'frame');
  const env = repos.environments.get(envId)!;
  if (typeof msg.top_url !== 'string' || classifySiteUrl(env.site, msg.top_url) !== 'signin') throw fillDenied('当前页面不是该站点的登录页', 'page');
  let action: URL;
  let top: URL;
  try {
    if (typeof msg.form_action !== 'string') throw new Error('missing');
    top = new URL(msg.top_url);
    action = new URL(msg.form_action, top);
  } catch {
    throw fillDenied('表单目标无效', 'form_action');
  }
  if (action.protocol !== 'https:' || action.origin !== top.origin) throw fillDenied('表单目标不是同源 HTTPS 地址', 'form_action');
  if (!env.autoFillLogin) throw fillDenied('该环境没有开启登录填充', 'disabled');
  const route = repos.routeState.get();
  if (route.activeEnvironmentId !== env.id) throw fillDenied('当前场景关联的环境不是使用中的环境', 'not_active');
  if (msg.route_epoch !== route.routeEpoch) throw fillDenied('路由已变化，请刷新页面后重试', 'epoch');
  const fields = Array.isArray(msg.fields) ? [...new Set(msg.fields)].filter((f) => f === 'identifier' || f === 'password') : [];
  if (fields.length === 0) throw fillDenied('页面上没有可以填充的字段', 'fields');
  const account = repos.accounts.get(env.id);
  if (!account) throw fillDenied('该环境没有配置账号', 'account');
  const control = await deps.ensureInControl({ maxAgeMs: 0 });
  if (!control.ok) throw fillDenied(`路由不受控：${control.reason ?? '状态未知'}`, 'control');
  // 对账之后再次确认 epoch 与活动环境（对账不会改变它们，但切换可能在此期间完成）
  const after = repos.routeState.get();
  if (after.routeEpoch !== msg.route_epoch || after.activeEnvironmentId !== env.id) throw fillDenied('路由已变化，请刷新页面后重试', 'epoch');
  const fills: LoginFillServiceResponse['fills'] = [];
  for (const f of fields) {
    if (f === 'identifier') {
      if (!account.loginIdentifier) throw fillDenied('没有配置登录账号', 'identifier');
      fills.push({ field: 'identifier', value: account.loginIdentifier });
    } else {
      if (!account.passwordRef) throw fillDenied('没有配置登录密码', 'password');
      fills.push({ field: 'password', value: await readAccountPassword(engine, account.passwordRef) });
    }
  }
  // 读取跨越了 await：返回之前再确认一次，路由在此期间变化则不交出任何值
  const final = repos.routeState.get();
  if (final.routeEpoch !== msg.route_epoch || final.activeEnvironmentId !== env.id) throw fillDenied('路由已变化，请刷新页面后重试', 'epoch');
  engine.log('info', 'login_fill.allowed', { environmentId: env.id, fields });
  return { fills };
}

/** 从本机后台资料读出账号密码并登记到脱敏器；读不到时失败（错误中不含引用或值）。 */
async function readAccountPassword(engine: Engine, ref: string): Promise<string> {
  const value = await engine.store.get(ref);
  if (value === null) throw new SfeError('SECRET_STORE_FAILED', '填充失败：本机后台资料中找不到登录密码', { details: { reason: 'not_found' } });
  engine.scrubber.register(value);
  return value;
}
