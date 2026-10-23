// 受理（docs/ARCHITECTURE.md §4 秘密生命周期、§6.1）：校验 → 版本检查 → 幂等 → 秘密四步协议 → 一个主事务
// （期望数据 + 操作 + outbox）。同步拒绝（校验、版本冲突、NEEDS_CONFIRMATION、ROUTE_BUSY、绑定不符、能力不足）
// 不创建操作、不占用 request_id。纯数据修改（展示名、站点、选项、账号、预期出口）在同一事务中完成为 COMPLETED，
// 不碰 Surge；只有节点行字段变化才产生新代理版本与发布。

import {
  SfeError,
  readinessAllowsActivation,
  type Accepted,
  type AcknowledgeAccountRequest,
  type AcknowledgeWindowsRequest,
  type ActivateRequest,
  type CancelOperationRequest,
  type CreateEnvironmentRequest,
  type DeleteEnvironmentRequest,
  type EnvironmentChanges,
  type EnvironmentInput,
  type FieldError,
  type NormalModeRequest,
  type OldSessionPolicy,
  type OperationKind,
  type ProbeRequest,
  type PublishPendingRequest,
  type RouteWarning,
  type SecretChange,
  type UnbindRequest,
  type UpdateEnvironmentRequest,
} from '@sfe/contract';
import type { Actor } from '../app.js';
import type { AccountRecord, EnvironmentRecord, OperationRecord, ProxyRevisionRecord } from '../db/index.js';
import { environmentDiff, type EnvironmentDiffState } from '../domain/diff.js';
import { allocateEnvironmentNaming, labelOf, revisionNodeName } from '../domain/naming.js';
import { nodeLineChanged, type NodeLineFields } from '../domain/node-line.js';
import { newRoutePayload, payloadOf, type OperationPayload } from '../domain/operations.js';
import { LOSS_OF_CONTROL_WARNINGS, hasAny } from '../domain/route-rules.js';
import { LIMITS, validateEnvironmentChanges, validateEnvironmentInput } from '../domain/validate.js';
import { fingerprint } from '../secrets/pepper.js';
import type { Engine } from './context.js';
import { acceptedOf, commitOperation, findDuplicateOperation, findLedger, recordLedger, requestDigest, requireRequestId } from './ledger.js';
import { confirmationNeeded, needsConfirmationError, routeBusyError, routeOps, supersedeWaiting } from './route-control.js';
import type { ViewService } from './view-service.js';

export interface AcceptDeps {
  engine: Engine;
  views: ViewService;
  kick: () => void;
}

// ---------- 通用 ----------

export function initiatorOf(actor: Actor): { initiatorKind: OperationRecord['initiatorKind']; initiatorProfileId: string | null } {
  return { initiatorKind: actor.kind, initiatorProfileId: actor.kind === 'bridge' ? actor.profileId : null };
}

/** 代理用户名/密码的长度上限（与 SURGE_SAFE_CREDENTIAL_RE 一致）。 */
const PROXY_CREDENTIAL_MAX = 128;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 一个秘密字段的值：SecretChange 的替换值；格式不对的请求也可能把秘密直接写成字符串。 */
function secretFieldValue(field: unknown): string | null {
  if (typeof field === 'string') return field;
  return isRecord(field) && field.action === 'replace' && typeof field.value === 'string' ? field.value : null;
}

/**
 * 请求中的秘密值立即登记到脱敏器（日志、错误、步骤都不会回显）。登记在校验之前进行，因此只看已知的秘密
 * 位置：新建的 environment、修改的 changes 下的代理用户名/密码与账号密码，每个请求至多 3 个值；只登记不超过
 * 字段上限的值（更长的值必然被校验拒绝、从不写入秘密存储）。不遍历请求中的任意键：被拒绝的请求无法借此
 * 往脱敏器里塞入大量值（登记表另有容量上限）。
 */
export function registerRequestSecrets(engine: Engine, req: unknown): void {
  if (!isRecord(req)) return;
  for (const holder of [req.environment, req.changes]) {
    if (!isRecord(holder)) continue;
    const fields: Array<[unknown, number]> = [];
    if (isRecord(holder.proxy)) fields.push([holder.proxy.username, PROXY_CREDENTIAL_MAX], [holder.proxy.password, PROXY_CREDENTIAL_MAX]);
    if (isRecord(holder.account)) fields.push([holder.account.password, LIMITS.accountPassword]);
    for (const [field, max] of fields) {
      const v = secretFieldValue(field);
      if (v !== null && v.length <= max) engine.scrubber.register(v);
    }
  }
}

function validationError(action: string, fieldErrors: FieldError[]): SfeError {
  return new SfeError('VALIDATION_FAILED', `${action}失败：字段校验未通过`, { fieldErrors });
}

function notFound(action: string): SfeError {
  return new SfeError('NOT_FOUND', `${action}失败：环境不存在`);
}

function requireRevision(value: unknown, action: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw validationError(action, [{ field: 'expected_revision', message: '必须是当前版本号' }]);
  }
  return value;
}

export function getEnvironment(engine: Engine, id: unknown, action: string): EnvironmentRecord {
  if (typeof id !== 'string' || id.length === 0) throw notFound(action);
  const env = engine.repos.environments.get(id);
  if (!env || env.deletedAt) throw notFound(action);
  return env;
}

export function insertOperation(
  engine: Engine,
  rec: {
    kind: OperationKind;
    requestId: string;
    digest: string;
    actor: Actor;
    environmentId?: string | null;
    expectedRevision?: number | null;
    resultRevision?: number | null;
    payload?: OperationPayload;
    phase?: OperationRecord['phase'];
    status?: OperationRecord['status'];
    probeKind?: OperationRecord['probeKind'];
    step?: string;
    enqueue?: boolean;
  },
): OperationRecord {
  const { repos } = engine;
  const op = repos.operations.insert({
    id: engine.ids.next('op'),
    requestId: rec.requestId,
    requestDigest: rec.digest,
    kind: rec.kind,
    ...initiatorOf(rec.actor),
    environmentId: rec.environmentId ?? null,
    expectedRevision: rec.expectedRevision ?? null,
    resultRevision: rec.resultRevision ?? null,
    probeKind: rec.probeKind ?? null,
    phase: rec.phase ?? 'SAVED',
    status: rec.status ?? 'queued',
    payload: rec.payload ?? {},
  });
  repos.operations.appendStep(op.id, op.phase, rec.step ?? '已保存');
  if (rec.enqueue ?? op.status === 'queued') repos.outbox.enqueue(op.id, null, engine.now());
  return repos.operations.get(op.id)!;
}

// ---------- 环境状态（差异与比较用） ----------

export function diffStateOf(engine: Engine, env: EnvironmentRecord): EnvironmentDiffState {
  const rev = env.desiredProxyRevision !== null ? engine.repos.proxyRevisions.get(env.id, env.desiredProxyRevision) : null;
  const account = engine.repos.accounts.get(env.id);
  const front = rev ? engine.repos.frontProxies.get(rev.frontProxyId) : null;
  return {
    displayName: env.displayName,
    site: env.site,
    autoOpenOrders: env.autoOpenOrders,
    autoFillLogin: env.autoFillLogin,
    protocol: rev?.protocol ?? 'socks5',
    host: rev?.host ?? '',
    port: rev?.port ?? 0,
    usernameFp: rev?.usernameFp ?? null,
    passwordFp: rev?.passwordFp ?? null,
    frontProxyName: front?.surgeName ?? null,
    expectedExitIp: env.expectedExitIp,
    accountLabel: account?.label ?? null,
    loginIdentifier: account?.loginIdentifier ?? null,
    accountPasswordFp: account?.passwordFp ?? null,
  };
}

function revisionConflict(engine: Engine, env: EnvironmentRecord, expected: number, requested: EnvironmentDiffState | null): SfeError {
  const current = diffStateOf(engine, env);
  return new SfeError('REVISION_CONFLICT', '保存失败：环境已被其他界面修改，请刷新后合并修改', {
    details: {
      currentRevision: env.revision,
      expectedRevision: expected,
      diff: requested ? environmentDiff(current, requested) : [],
    },
  });
}

/** 解析前置：null → 当前默认前置（保存为具体 id）；id → 必须已登记且未停用。 */
export function resolveFront(engine: Engine, frontProxyId: string | null | undefined, field = 'proxy.frontProxyId'): string {
  const id = frontProxyId ?? engine.repos.settings.defaultFrontProxyId();
  if (!id) throw validationError('保存', [{ field, message: '没有可用的前置代理：请先在设置中登记并设为默认，或为该环境选择前置' }]);
  const f = engine.repos.frontProxies.get(id);
  if (!f || f.retired) throw validationError('保存', [{ field, message: '前置代理未登记或已停用' }]);
  return f.id;
}

// ---------- 秘密 ----------

interface PendingSecret {
  ref: string;
  fp: string;
}

async function createSecrets(
  engine: Engine,
  items: Array<{ key: string; value: string; kind: 'proxy' | 'account' }>,
  owner: { kind: string; id: string },
): Promise<Map<string, PendingSecret>> {
  const out = new Map<string, PendingSecret>();
  const keys = await engine.keys();
  try {
    for (const item of items) {
      engine.scrubber.register(item.value);
      const ref = await engine.secrets.createSecret(item.value, item.kind, owner);
      out.set(item.key, { ref, fp: fingerprint(keys.pepper, item.value) });
    }
  } catch (err) {
    await discardSecrets(engine, out);
    throw err;
  }
  return out;
}

async function discardSecrets(engine: Engine, secrets: Map<string, PendingSecret>): Promise<void> {
  for (const s of secrets.values()) {
    try {
      if (!engine.repos.secretRefs.isReferenced(s.ref)) await engine.secrets.discard(s.ref);
    } catch {
      // 清扫会处理残留
    }
  }
}

function replaceValue(change: SecretChange | undefined): string | null {
  return change && change.action === 'replace' ? change.value : null;
}

// ---------- 创建 ----------

export interface CreateOptions {
  /** 原生桥“在此创建并关联”：同一事务内写入绑定。 */
  bindProfileId?: string;
  bindingState?: 'bound' | 'bound_unverified_id';
}

export async function acceptCreate(deps: AcceptDeps, req: CreateEnvironmentRequest, actor: Actor, opts: CreateOptions = {}): Promise<Accepted> {
  const { engine } = deps;
  registerRequestSecrets(engine, req);
  const requestId = requireRequestId(req?.request_id);
  const digest = await requestDigest(engine, 'createEnvironment', opts.bindProfileId ? `bind:${opts.bindProfileId}` : null, req);
  const dup = findDuplicateOperation(engine, requestId, digest);
  if (dup) return acceptedOf(dup, true);
  const input = req.environment as EnvironmentInput;
  const errors = validateEnvironmentInput(input);
  if (errors.length > 0) throw validationError('新建环境', errors);
  const frontId = resolveFront(engine, input.proxy.frontProxyId);
  const keys = await engine.keys();

  const items: Array<{ key: string; value: string; kind: 'proxy' | 'account' }> = [];
  const u = replaceValue(input.proxy.username);
  const p = replaceValue(input.proxy.password);
  const ap = replaceValue(input.account?.password);
  if (u !== null) items.push({ key: 'username', value: u, kind: 'proxy' });
  if (p !== null) items.push({ key: 'password', value: p, kind: 'proxy' });
  if (ap !== null) items.push({ key: 'account', value: ap, kind: 'account' });
  const secrets = await createSecrets(engine, items, { kind: 'environment', id: 'new' });
  void keys;
  let committed: { op: OperationRecord; duplicate: boolean };
  try {
    // 幂等在主事务内再核对一次：并发的同一请求可能在写秘密存储期间已提交
    committed = commitOperation(engine, requestId, digest, () => {
      if (opts.bindProfileId) {
        if (engine.repos.profileBindings.byProfile(opts.bindProfileId)) throw new SfeError('PROFILE_ALREADY_BOUND', '新建并关联失败：当前场景已关联其他环境');
      }
      const naming = allocateEnvironmentNaming(engine.repos.meta, input.site);
      const id = engine.ids.next('env');
      const env = engine.repos.environments.insert({
        id,
        seq: naming.seq,
        code: naming.code,
        nodeTag: naming.nodeTag,
        displayName: input.displayName,
        site: input.site,
        autoOpenOrders: input.autoOpenOrders ?? true,
        autoFillLogin: input.autoFillLogin ?? false,
        revision: 1,
        desiredProxyRevision: 1,
        deployedProxyRevision: null,
        lastVerifiedProxyRevision: null,
        expectedExitIp: input.proxy.expectedExitIp ?? null,
        bindingStage: opts.bindProfileId ? null : 'awaiting_profile',
      });
      engine.repos.proxyRevisions.insert({
        environmentId: id,
        revision: 1,
        protocol: 'socks5',
        host: input.proxy.host,
        port: input.proxy.port,
        usernameRef: secrets.get('username')?.ref ?? null,
        usernameFp: secrets.get('username')?.fp ?? null,
        passwordRef: secrets.get('password')?.ref ?? null,
        passwordFp: secrets.get('password')?.fp ?? null,
        frontProxyId: frontId,
        nodeName: revisionNodeName(env, 1),
        state: 'desired',
      });
      if (input.account) {
        engine.repos.accounts.insert({
          environmentId: id,
          label: input.account.label ?? null,
          loginIdentifier: input.account.loginIdentifier ?? null,
          passwordRef: secrets.get('account')?.ref ?? null,
          passwordFp: secrets.get('account')?.fp ?? null,
        });
      }
      for (const s of secrets.values()) engine.secrets.markCommitted(s.ref);
      if (opts.bindProfileId) {
        engine.repos.profileBindings.insert({ profileId: opts.bindProfileId, environmentId: id, state: opts.bindingState ?? 'bound_unverified_id' });
      }
      return insertOperation(engine, {
        kind: 'environment.create',
        requestId,
        digest,
        actor,
        environmentId: id,
        resultRevision: 1,
        payload: { targets: [{ environmentId: id, proxyRevision: 1 }] },
        step: opts.bindProfileId ? '已保存环境并关联当前场景，等待同步到 Surge' : '已保存环境，等待同步到 Surge',
      });
    });
  } catch (err) {
    await discardSecrets(engine, secrets);
    throw err;
  }
  const { op } = committed;
  if (committed.duplicate) {
    await discardSecrets(engine, secrets);
    return acceptedOf(op, true);
  }
  deps.kick();
  engine.emit({ operations: [op.id], environments: [op.environmentId!] });
  return acceptedOf(op, false);
}

// ---------- 修改 ----------

interface ProxyPlan {
  next: NodeLineFields;
  usernameRef: string | null;
  passwordRef: string | null;
  changed: boolean;
}

export async function acceptUpdate(deps: AcceptDeps, id: string, req: UpdateEnvironmentRequest, actor: Actor): Promise<Accepted> {
  const { engine } = deps;
  const { repos } = engine;
  registerRequestSecrets(engine, req);
  const requestId = requireRequestId(req?.request_id);
  const digest = await requestDigest(engine, 'updateEnvironment', id, req);
  const dup = findDuplicateOperation(engine, requestId, digest);
  if (dup) return acceptedOf(dup, true);
  const changes = req.changes as EnvironmentChanges;
  const errors = validateEnvironmentChanges(changes);
  if (errors.length > 0) throw validationError('保存', errors);
  const expected = requireRevision(req.expected_revision, '保存');
  let env = getEnvironment(engine, id, '保存');
  const keys = await engine.keys();
  const fp = (v: string) => fingerprint(keys.pepper, v);

  const requestedState = (): EnvironmentDiffState => {
    const cur = diffStateOf(engine, env);
    const next: EnvironmentDiffState = { ...cur };
    if (changes.displayName !== undefined) next.displayName = changes.displayName;
    if (changes.site !== undefined) next.site = changes.site;
    if (changes.autoOpenOrders !== undefined) next.autoOpenOrders = changes.autoOpenOrders;
    if (changes.autoFillLogin !== undefined) next.autoFillLogin = changes.autoFillLogin;
    const px = changes.proxy;
    if (px) {
      if (px.host !== undefined) next.host = px.host;
      if (px.port !== undefined) next.port = px.port;
      if (px.username?.action === 'replace') next.usernameFp = fp(px.username.value);
      if (px.username?.action === 'clear') next.usernameFp = null;
      if (px.password?.action === 'replace') next.passwordFp = fp(px.password.value);
      if (px.password?.action === 'clear') next.passwordFp = null;
      if (px.expectedExitIp !== undefined) next.expectedExitIp = px.expectedExitIp ?? null;
      if (px.frontProxyId !== undefined) {
        const fid = px.frontProxyId ?? repos.settings.defaultFrontProxyId();
        next.frontProxyName = fid ? (repos.frontProxies.get(fid)?.surgeName ?? null) : null;
      }
    }
    const ac = changes.account;
    if (ac) {
      if (ac.label !== undefined) next.accountLabel = ac.label ?? null;
      if (ac.loginIdentifier !== undefined) next.loginIdentifier = ac.loginIdentifier ?? null;
      if (ac.password?.action === 'replace') next.accountPasswordFp = fp(ac.password.value);
      if (ac.password?.action === 'clear') next.accountPasswordFp = null;
    }
    return next;
  };
  if (env.revision !== expected) throw revisionConflict(engine, env, expected, requestedState());

  // 节点行：协议、地址、端口、用户名/密码指纹、解析后的前置 id
  const plan = (): ProxyPlan | null => {
    const curRev = env.desiredProxyRevision !== null ? repos.proxyRevisions.get(env.id, env.desiredProxyRevision) : null;
    if (!curRev) return null;
    const px = changes.proxy ?? {};
    const cur: NodeLineFields = { protocol: curRev.protocol, host: curRev.host, port: curRev.port, usernameFp: curRev.usernameFp, passwordFp: curRev.passwordFp, frontProxyId: curRev.frontProxyId };
    const next: NodeLineFields = { ...cur };
    let usernameRef = curRev.usernameRef;
    let passwordRef = curRev.passwordRef;
    if (px.protocol !== undefined) next.protocol = px.protocol;
    if (px.host !== undefined) next.host = px.host;
    if (px.port !== undefined) next.port = px.port;
    if (px.username?.action === 'clear') {
      next.usernameFp = null;
      usernameRef = null;
    } else if (px.username?.action === 'replace') next.usernameFp = fp(px.username.value);
    if (px.password?.action === 'clear') {
      next.passwordFp = null;
      passwordRef = null;
    } else if (px.password?.action === 'replace') next.passwordFp = fp(px.password.value);
    if (px.frontProxyId !== undefined) next.frontProxyId = resolveFront(engine, px.frontProxyId);
    return { next, usernameRef, passwordRef, changed: nodeLineChanged(cur, next) };
  };
  const proxyPlan = plan();

  // 需要写入新秘密项的值：值与当前指纹不同的替换
  const items: Array<{ key: string; value: string; kind: 'proxy' | 'account' }> = [];
  const curRev = env.desiredProxyRevision !== null ? repos.proxyRevisions.get(env.id, env.desiredProxyRevision) : null;
  const account = repos.accounts.get(env.id);
  const pu = replaceValue(changes.proxy?.username);
  const pp = replaceValue(changes.proxy?.password);
  const ap = replaceValue(changes.account?.password);
  if (proxyPlan?.changed && pu !== null && fp(pu) !== curRev?.usernameFp) items.push({ key: 'username', value: pu, kind: 'proxy' });
  if (proxyPlan?.changed && pp !== null && fp(pp) !== curRev?.passwordFp) items.push({ key: 'password', value: pp, kind: 'proxy' });
  if (ap !== null && fp(ap) !== (account?.passwordFp ?? null)) items.push({ key: 'account', value: ap, kind: 'account' });
  const secrets = await createSecrets(engine, items, { kind: 'environment', id: env.id });

  let committed: { op: OperationRecord; duplicate: boolean };
  const routeChanged = { value: false };
  try {
    // 幂等在主事务内、版本检查之前再核对一次：并发的同一请求可能在写秘密存储期间已提交（否则会误报版本冲突）
    committed = commitOperation(engine, requestId, digest, () => {
      env = getEnvironment(engine, id, '保存');
      if (env.revision !== expected) throw revisionConflict(engine, env, expected, requestedState());
      const newRevision = env.revision + 1;
      const patch: Partial<EnvironmentRecord> = { revision: newRevision };
      if (changes.displayName !== undefined) patch.displayName = changes.displayName;
      if (changes.site !== undefined) patch.site = changes.site;
      if (changes.autoOpenOrders !== undefined) patch.autoOpenOrders = changes.autoOpenOrders;
      if (changes.autoFillLogin !== undefined) patch.autoFillLogin = changes.autoFillLogin;
      if (changes.bindingStage !== undefined) patch.bindingStage = changes.bindingStage;
      const exitChanged = changes.proxy?.expectedExitIp !== undefined && (changes.proxy.expectedExitIp ?? null) !== env.expectedExitIp;
      if (changes.proxy?.expectedExitIp !== undefined) patch.expectedExitIp = changes.proxy.expectedExitIp ?? null;

      // 账号（纯数据）：登录账号或密码变化 → 页面登录状态未核对
      if (changes.account) {
        const ac = changes.account;
        const cur = repos.accounts.get(env.id);
        const next: Partial<AccountRecord> = {};
        let identityChanged = false;
        if (ac.label !== undefined) next.label = ac.label ?? null;
        if (ac.loginIdentifier !== undefined && (ac.loginIdentifier ?? null) !== (cur?.loginIdentifier ?? null)) {
          next.loginIdentifier = ac.loginIdentifier ?? null;
          identityChanged = true;
        }
        const newPw = secrets.get('account');
        if (newPw) {
          if (cur?.passwordRef) engine.secrets.orphan(cur.passwordRef);
          next.passwordRef = newPw.ref;
          next.passwordFp = newPw.fp;
          engine.secrets.markCommitted(newPw.ref);
          identityChanged = true;
        } else if (ac.password?.action === 'clear' && cur?.passwordRef) {
          engine.secrets.orphan(cur.passwordRef);
          next.passwordRef = null;
          next.passwordFp = null;
          identityChanged = true;
        }
        if (identityChanged) next.changedSincePageCheck = true;
        if (cur) repos.accounts.update(env.id, next);
        else repos.accounts.insert({ environmentId: env.id, label: next.label ?? null, loginIdentifier: next.loginIdentifier ?? null, passwordRef: next.passwordRef ?? null, passwordFp: next.passwordFp ?? null, changedSincePageCheck: next.changedSincePageCheck ?? false });
      }

      let newProxyRevision: number | null = null;
      if (proxyPlan?.changed) {
        const prev = env.desiredProxyRevision !== null ? repos.proxyRevisions.get(env.id, env.desiredProxyRevision) : null;
        newProxyRevision = repos.proxyRevisions.maxRevision(env.id) + 1;
        const u = secrets.get('username');
        const p = secrets.get('password');
        repos.proxyRevisions.insert({
          environmentId: env.id,
          revision: newProxyRevision,
          protocol: proxyPlan.next.protocol,
          host: proxyPlan.next.host,
          port: proxyPlan.next.port,
          // keep：沿用旧引用（共享引用按“是否仍被引用”回收）
          usernameRef: u ? u.ref : proxyPlan.next.usernameFp === null ? null : proxyPlan.usernameRef,
          usernameFp: proxyPlan.next.usernameFp,
          passwordRef: p ? p.ref : proxyPlan.next.passwordFp === null ? null : proxyPlan.passwordRef,
          passwordFp: proxyPlan.next.passwordFp,
          frontProxyId: proxyPlan.next.frontProxyId,
          nodeName: revisionNodeName(env, newProxyRevision),
          state: 'desired',
        });
        if (u) engine.secrets.markCommitted(u.ref);
        if (p) engine.secrets.markCommitted(p.ref);
        // 尚未部署的旧期望版本被取代（是否移除由执行器在发布时判断）
        if (prev && prev.state === 'desired' && prev.revision !== env.deployedProxyRevision && prev.revision !== env.lastVerifiedProxyRevision) {
          repos.proxyRevisions.updateState(env.id, prev.revision, 'superseded');
        }
        patch.desiredProxyRevision = newProxyRevision;
      }
      repos.environments.update(env.id, patch);

      // 活动环境的预期出口：立即与最近一次 ok 的 Safari 实测比较（不切换）
      if (exitChanged) routeChanged.value = reevaluateExitIp(engine, env.id, patch.expectedExitIp ?? null);

      if (newProxyRevision !== null) {
        return insertOperation(engine, {
          kind: 'environment.update',
          requestId,
          digest,
          actor,
          environmentId: env.id,
          expectedRevision: expected,
          resultRevision: newRevision,
          payload: { targets: [{ environmentId: env.id, proxyRevision: newProxyRevision }] },
          step: `已保存代理新版本 v${String(newProxyRevision).padStart(3, '0')}，等待同步到 Surge`,
        });
      }
      return insertOperation(engine, {
        kind: 'environment.update',
        requestId,
        digest,
        actor,
        environmentId: env.id,
        expectedRevision: expected,
        resultRevision: newRevision,
        phase: 'COMPLETED',
        status: 'succeeded',
        enqueue: false,
        step: '已保存（不涉及 Surge 节点，未发布、未切换）',
      });
    });
  } catch (err) {
    await discardSecrets(engine, secrets);
    throw err;
  }
  const { op } = committed;
  if (committed.duplicate) {
    await discardSecrets(engine, secrets);
    return acceptedOf(op, true);
  }
  if (op.status === 'queued') deps.kick();
  engine.emit({ operations: [op.id], environments: [env.id], route: routeChanged.value });
  return acceptedOf(op, false);
}

/** 活动环境的预期出口被修改：与最近一次 ok 的 Safari 实测比较；不符 → exit_ip_mismatch，相符或清空 → 清除。 */
export function reevaluateExitIp(engine: Engine, environmentId: string, expected: string | null): boolean {
  const { repos } = engine;
  const route = repos.routeState.get();
  if (route.activeEnvironmentId !== environmentId) return false;
  const probe = repos.probes.listForEnvironment(environmentId, 20).find((p) => p.kind === 'safari' && p.outcome === 'ok') ?? null;
  const mismatch = expected !== null && probe !== null && probe.exitIp !== null && probe.exitIp !== expected;
  const has = route.warnings.includes('exit_ip_mismatch');
  if (mismatch && !has) {
    repos.routeState.update({ warnings: [...route.warnings, 'exit_ip_mismatch'] });
    return true;
  }
  if (!mismatch && has) {
    repos.routeState.update({ warnings: route.warnings.filter((w) => w !== 'exit_ip_mismatch') });
    return true;
  }
  return false;
}

// ---------- 删除与解除绑定 ----------

function environmentBusy(engine: Engine, envId: string): boolean {
  const route = engine.repos.routeState.get();
  if (route.activeEnvironmentId === envId && route.entryMode !== 'NORMAL') return true;
  const ops = routeOps(engine);
  return [...ops.busy, ...ops.waitingVerification].some((o) => payloadOf(o).route?.targetEnvironmentId === envId);
}

export async function acceptDelete(deps: AcceptDeps, id: string, req: DeleteEnvironmentRequest, actor: Actor): Promise<Accepted> {
  const { engine } = deps;
  const requestId = requireRequestId(req?.request_id);
  const digest = await requestDigest(engine, 'deleteEnvironment', id, req);
  const dup = findDuplicateOperation(engine, requestId, digest);
  if (dup) return acceptedOf(dup, true);
  const expected = requireRevision(req.expected_revision, '删除');
  const env = getEnvironment(engine, id, '删除');
  if (env.revision !== expected) throw revisionConflict(engine, env, expected, null);
  if (environmentBusy(engine, env.id)) throw new SfeError('ENVIRONMENT_ACTIVE', '删除失败：环境正在使用或正在验证，请先进入普通模式');
  const op = engine.repos.tx(() =>
    insertOperation(engine, { kind: 'environment.delete', requestId, digest, actor, environmentId: env.id, expectedRevision: expected, step: '已受理删除' }),
  );
  deps.kick();
  engine.emit({ operations: [op.id] });
  return acceptedOf(op, false);
}

export async function acceptUnbind(deps: AcceptDeps, id: string, req: UnbindRequest, actor: Actor): Promise<Accepted> {
  const { engine } = deps;
  const requestId = requireRequestId(req?.request_id);
  const digest = await requestDigest(engine, 'unbind', id, req);
  const dup = findDuplicateOperation(engine, requestId, digest);
  if (dup) return acceptedOf(dup, true);
  const expected = requireRevision(req.expected_revision, '解除绑定');
  const env = getEnvironment(engine, id, '解除绑定');
  if (env.revision !== expected) throw revisionConflict(engine, env, expected, null);
  if (!engine.repos.profileBindings.byEnvironment(env.id)) throw new SfeError('PROFILE_UNBOUND', '解除绑定失败：环境尚未关联 Safari 场景');
  if (environmentBusy(engine, env.id)) throw new SfeError('ENVIRONMENT_ACTIVE', '解除绑定失败：环境正在使用或正在验证，请先进入普通模式');
  const op = engine.repos.tx(() =>
    insertOperation(engine, { kind: 'binding.unbind', requestId, digest, actor, environmentId: env.id, expectedRevision: expected, step: '已受理解除绑定' }),
  );
  deps.kick();
  engine.emit({ operations: [op.id] });
  return acceptedOf(op, false);
}

export async function acceptAcknowledgeAccount(deps: AcceptDeps, id: string, req: AcknowledgeAccountRequest, actor: Actor): Promise<Accepted> {
  const { engine } = deps;
  const requestId = requireRequestId(req?.request_id);
  const digest = await requestDigest(engine, 'acknowledgeAccount', id, req);
  const dup = findDuplicateOperation(engine, requestId, digest);
  if (dup) return acceptedOf(dup, true);
  const expected = requireRevision(req.expected_revision, '确认账号');
  const env = getEnvironment(engine, id, '确认账号');
  if (env.revision !== expected) throw revisionConflict(engine, env, expected, null);
  const op = engine.repos.tx(() => {
    const acc = engine.repos.accounts.get(env.id);
    if (acc) engine.repos.accounts.update(env.id, { changedSincePageCheck: false });
    engine.repos.environments.update(env.id, { revision: env.revision + 1 });
    return insertOperation(engine, {
      kind: 'environment.update',
      requestId,
      digest,
      actor,
      environmentId: env.id,
      expectedRevision: expected,
      resultRevision: env.revision + 1,
      phase: 'COMPLETED',
      status: 'succeeded',
      enqueue: false,
      step: '已确认账号变更提示（页面登录身份仍为未核对）',
    });
  });
  engine.emit({ operations: [op.id], environments: [env.id] });
  return acceptedOf(op, false);
}

/** 原生桥：把当前场景关联到一个未绑定的环境。 */
export async function acceptBind(
  deps: AcceptDeps,
  profileId: string,
  req: { request_id: string; environment_id: string; expected_revision: number },
  actor: Actor,
  state: 'bound' | 'bound_unverified_id',
): Promise<Accepted> {
  const { engine } = deps;
  const requestId = requireRequestId(req?.request_id);
  const digest = await requestDigest(engine, 'bindCurrentProfile', profileId, req);
  const dup = findDuplicateOperation(engine, requestId, digest);
  if (dup) return acceptedOf(dup, true);
  const expected = requireRevision(req.expected_revision, '关联');
  const env = getEnvironment(engine, req.environment_id, '关联');
  if (env.revision !== expected) throw revisionConflict(engine, env, expected, null);
  if (engine.repos.profileBindings.byProfile(profileId)) throw new SfeError('PROFILE_ALREADY_BOUND', '关联失败：当前场景已关联其他环境');
  if (engine.repos.profileBindings.byEnvironment(env.id)) throw new SfeError('ENVIRONMENT_ALREADY_BOUND', '关联失败：该环境已关联其他场景');
  const op = engine.repos.tx(() => {
    engine.repos.profileBindings.insert({ profileId, environmentId: env.id, state });
    engine.repos.environments.update(env.id, { revision: env.revision + 1, bindingStage: null });
    return insertOperation(engine, {
      kind: 'binding.bind',
      requestId,
      digest,
      actor,
      environmentId: env.id,
      expectedRevision: expected,
      resultRevision: env.revision + 1,
      phase: 'COMPLETED',
      status: 'succeeded',
      enqueue: false,
      step: state === 'bound' ? '已关联当前 Safari 场景' : '已关联当前 Safari 场景（场景编号稳定性尚未通过实测）',
    });
  });
  engine.emit({ operations: [op.id], environments: [env.id] });
  return acceptedOf(op, false);
}

// ---------- 路由 ----------

function oldSessionPolicyOf(v: unknown): OldSessionPolicy | null {
  if (v === undefined || v === null) return null;
  if (v === 'closed_confirmed' || v === 'keep_open_acknowledged') return v;
  throw validationError('请求', [{ field: 'old_session_policy', message: '只能是 closed_confirmed 或 keep_open_acknowledged' }]);
}

function confirmedIdOf(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string' && v.length > 0 && v.length <= 128) return v;
  throw validationError('请求', [{ field: 'confirmed_environment_id', message: '环境编号格式不正确' }]);
}

export interface ActivateExtra {
  amazonTabsOpen?: boolean | null;
}

export async function acceptActivate(deps: AcceptDeps, id: string, req: ActivateRequest, actor: Actor, extra: ActivateExtra = {}): Promise<Accepted> {
  const { engine, views } = deps;
  const { repos } = engine;
  const requestId = requireRequestId(req?.request_id);
  const digest = await requestDigest(engine, 'activate', id, { ...req, amazon_tabs_open: extra.amazonTabsOpen ?? null });
  const dup = findDuplicateOperation(engine, requestId, digest);
  if (dup) return acceptedOf(dup, true);
  const policy = oldSessionPolicyOf(req.old_session_policy);
  const confirmed = confirmedIdOf(req.confirmed_environment_id);
  const env = getEnvironment(engine, id, '激活');
  if (!repos.profileBindings.byEnvironment(env.id)) throw new SfeError('PROFILE_UNBOUND', '激活失败：环境尚未关联 Safari 场景');

  // 目标版本：只能是已部署（读回可接受）或最近一次验证通过的版本
  if (req.proxy_revision !== undefined && (typeof req.proxy_revision !== 'number' || !Number.isInteger(req.proxy_revision))) {
    throw validationError('激活', [{ field: 'proxy_revision', message: '版本号不正确' }]);
  }
  const revision = req.proxy_revision ?? env.deployedProxyRevision;
  if (revision === null || (revision !== env.deployedProxyRevision && revision !== env.lastVerifiedProxyRevision)) {
    throw new SfeError('NODE_NOT_DEPLOYED', '激活失败：目标版本尚未部署或读回不完整，不能使用');
  }
  const rev = repos.proxyRevisions.get(env.id, revision);
  if (!rev || rev.state === 'retired') throw new SfeError('NODE_NOT_DEPLOYED', '激活失败：目标版本已不在 Surge 中');

  // 汇总状态（显式返回上一验证版本时不受新版本预检失败影响）
  const view = views.environmentView(env.id)!;
  const explicitLastVerified = req.proxy_revision !== undefined && revision === env.lastVerifiedProxyRevision && revision !== env.deployedProxyRevision;
  if (!explicitLastVerified && !readinessAllowsActivation(view.readiness) && view.readiness !== 'activating') {
    const code = view.readiness === 'proxy_unavailable' ? 'PREFLIGHT_FAILED' : view.readiness === 'invalid' ? 'VALIDATION_FAILED' : view.readiness === 'needs_binding' ? 'PROFILE_UNBOUND' : 'NODE_NOT_DEPLOYED';
    throw new SfeError(code, `激活失败：${view.nextActions[0]?.message ?? '环境当前不能使用'}`);
  }
  // 能力门槛（412）
  const missing = engine.activationMissing();
  if (missing.length > 0) {
    const all = engine.capabilityViews();
    throw new SfeError('CAPABILITY_UNVERIFIED', `激活失败：${all.filter((v) => missing.includes(v.key)).map((v) => v.label).join('、')}尚未通过实测`, {
      details: { missing: missing.map((k) => ({ key: k, staleReasons: all.find((v) => v.key === k)?.staleReasons ?? [] })) },
    });
  }
  // 并发矩阵
  const state = routeOps(engine);
  if (state.busy.length > 0) throw routeBusyError('激活');
  // 旧窗口确认
  const route = repos.routeState.get();
  const need = confirmationNeeded(engine, env.id);
  let expectedActive: string | null = route.activeEnvironmentId;
  if (need) {
    if (policy === null) throw needsConfirmationError('激活', need);
    if (confirmed !== route.activeEnvironmentId) throw needsConfirmationError('激活', need);
    expectedActive = confirmed;
  } else if (policy !== null && confirmed !== route.activeEnvironmentId) {
    const details = confirmationNeeded(engine, null) ?? { reason: 'other_environment_active' as const, currentEnvironmentId: route.activeEnvironmentId, currentEnvironmentLabel: null, otherProfilesOpen: [], options: ['closed_confirmed' as const, 'keep_open_acknowledged' as const], limitation: null };
    throw needsConfirmationError('激活', { ...details, options: [...details.options] });
  }
  const purpose = route.activeEnvironmentId === env.id && route.warnings.includes('rollback_needs_reverify') ? 'reverify' : 'activate';
  const payload = newRoutePayload({
    targetEnvironmentId: env.id,
    proxyRevision: revision,
    nodeName: rev.nodeName,
    purpose,
    oldSessionPolicy: policy,
    expectedActiveEnvironmentId: expectedActive,
    crossEnvironment: route.activeEnvironmentId !== null && route.activeEnvironmentId !== env.id,
    amazonTabsAtLaunch: extra.amazonTabsOpen ?? null,
  });
  if (actor.kind === 'bridge' && actor.profileId) {
    payload.arrivedProfileId = actor.profileId;
  }
  const touched: string[] = [];
  const op = repos.tx(() => {
    const created = insertOperation(engine, {
      kind: 'route.activate',
      requestId,
      digest,
      actor,
      environmentId: env.id,
      resultRevision: revision,
      payload: { route: payload },
      step: purpose === 'reverify' ? '已受理重新核验' : `已受理激活「${labelOf(env)}」`,
    });
    touched.push(...supersedeWaiting(engine, created.id, state));
    return created;
  });
  deps.kick();
  engine.emit({ operations: [op.id, ...touched], environments: [env.id], route: touched.length > 0 });
  return acceptedOf(op, false);
}

export async function acceptNormal(deps: AcceptDeps, req: NormalModeRequest, actor: Actor): Promise<Accepted> {
  const { engine } = deps;
  const { repos } = engine;
  const requestId = requireRequestId(req?.request_id);
  const digest = await requestDigest(engine, 'normal', null, req);
  const dup = findDuplicateOperation(engine, requestId, digest);
  if (dup) return acceptedOf(dup, true);
  const policy = oldSessionPolicyOf(req.old_session_policy);
  const confirmed = confirmedIdOf(req.confirmed_environment_id);
  const state = routeOps(engine);
  if (state.busy.length > 0) throw routeBusyError('进入普通模式');
  const route = repos.routeState.get();
  const need = confirmationNeeded(engine, null);
  if (need && (policy === null || confirmed !== route.activeEnvironmentId)) throw needsConfirmationError('进入普通模式', need);
  const touched: string[] = [];
  const op = repos.tx(() => {
    const created = insertOperation(engine, {
      kind: 'route.normal',
      requestId,
      digest,
      actor,
      payload: { normal: { oldSessionPolicy: policy, expectedActiveEnvironmentId: route.activeEnvironmentId, hadManagedEnvironment: route.activeEnvironmentId !== null } },
      step: '已受理进入普通模式',
    });
    touched.push(...supersedeWaiting(engine, created.id, state));
    return created;
  });
  deps.kick();
  engine.emit({ operations: [op.id, ...touched], route: touched.length > 0 });
  return acceptedOf(op, false);
}

export async function acceptProbe(deps: AcceptDeps, id: string, req: ProbeRequest, actor: Actor): Promise<Accepted> {
  const { engine } = deps;
  const { repos } = engine;
  const requestId = requireRequestId(req?.request_id);
  const digest = await requestDigest(engine, 'probe', id, req);
  const dup = findDuplicateOperation(engine, requestId, digest);
  if (dup) return acceptedOf(dup, true);
  if (req.kind !== 'preflight' && req.kind !== 'safari') throw validationError('检测', [{ field: 'kind', message: '只能是 preflight 或 safari' }]);
  const env = getEnvironment(engine, id, '检测');
  if (req.kind === 'preflight') {
    if (env.deployedProxyRevision === null) throw new SfeError('NODE_NOT_DEPLOYED', '预检失败：环境没有已部署的版本');
    engine.requireCapabilities(['independent_node_preflight'], '预检');
    const op = repos.tx(() =>
      insertOperation(engine, { kind: 'probe.preflight', requestId, digest, actor, environmentId: env.id, probeKind: 'preflight', resultRevision: env.deployedProxyRevision, step: '已受理代理预检' }),
    );
    deps.kick();
    engine.emit({ operations: [op.id] });
    return acceptedOf(op, false);
  }
  // Safari 重测：只针对当前 epoch 中 ACTIVE_VERIFIED 的活动环境
  const route = repos.routeState.get();
  if (route.activeEnvironmentId !== env.id || route.phase !== 'active_verified' || route.entryMode !== 'ACTIVE' || route.activeProxyRevision === null) {
    throw new SfeError('VALIDATION_FAILED', '重新检测失败：该环境不是当前使用中且已验证的环境', { fieldErrors: [{ field: 'kind', message: '只能对使用中的环境做 Safari 重测' }] });
  }
  const lost = hasAny(route.warnings, LOSS_OF_CONTROL_WARNINGS);
  if (lost.length > 0) {
    const code = lost.includes('takeover_lost') || lost.includes('outbound_mode_changed') ? 'TAKEOVER_LOST' : lost.includes('precedence_violation') ? 'PRECEDENCE_VIOLATION' : lost.includes('surge_unreachable') ? 'SURGE_UNREACHABLE' : 'UNKNOWN_STATE';
    throw new SfeError(code, '重新检测失败：路由已失去控制，请重新使用此环境或进入普通模式', { details: { warnings: lost } });
  }
  const state = routeOps(engine);
  if (state.busy.length > 0 || state.waitingVerification.length > 0) throw routeBusyError('重新检测');
  const rev = repos.proxyRevisions.get(env.id, route.activeProxyRevision)!;
  const op = repos.tx(() =>
    insertOperation(engine, {
      kind: 'probe.safari',
      requestId,
      digest,
      actor,
      environmentId: env.id,
      probeKind: 'safari',
      resultRevision: rev.revision,
      payload: { route: newRoutePayload({ targetEnvironmentId: env.id, proxyRevision: rev.revision, nodeName: rev.nodeName, purpose: 'probe_safari', flow: 'probe', expectedActiveEnvironmentId: env.id }) },
      step: '已受理 Safari 重测（不切换、不断连）',
    }),
  );
  deps.kick();
  engine.emit({ operations: [op.id] });
  return acceptedOf(op, false);
}

export async function acceptPublishPending(deps: AcceptDeps, req: PublishPendingRequest, actor: Actor): Promise<Accepted> {
  const { engine } = deps;
  const requestId = requireRequestId(req?.request_id);
  const digest = await requestDigest(engine, 'publishPending', null, req);
  const dup = findDuplicateOperation(engine, requestId, digest);
  if (dup) return acceptedOf(dup, true);
  let ids: string[] | null = null;
  if (req.environment_ids !== undefined) {
    if (!Array.isArray(req.environment_ids) || req.environment_ids.some((x) => typeof x !== 'string')) {
      throw validationError('发布', [{ field: 'environment_ids', message: '必须是环境编号列表' }]);
    }
    ids = [...new Set(req.environment_ids)];
    for (const id of ids) getEnvironment(engine, id, '发布');
  }
  const op = engine.repos.tx(() =>
    insertOperation(engine, { kind: 'deploy.publish', requestId, digest, actor, payload: { environmentIds: ids }, step: '已受理发布待部署的修改' }),
  );
  deps.kick();
  engine.emit({ operations: [op.id] });
  return acceptedOf(op, false);
}

export async function acceptCancel(deps: AcceptDeps, id: string, req: CancelOperationRequest, actor: Actor, scope?: (op: OperationRecord) => boolean): Promise<Accepted> {
  const { engine } = deps;
  const { repos } = engine;
  const requestId = requireRequestId(req?.request_id);
  const digest = await requestDigest(engine, 'cancelOperation', id, req);
  const dup = findLedger<{ operationId: string }>(engine, requestId, digest);
  if (dup) {
    const op = repos.operations.get(dup.ref.operationId);
    if (op) return acceptedOf(op, true);
  }
  const op = repos.operations.get(id);
  if (!op || (scope && !scope(op))) throw new SfeError('NOT_FOUND', '取消失败：操作不存在');
  const p = payloadOf(op).route;
  if (op.status !== 'waiting' || !p) throw new SfeError('ROUTE_BUSY', '取消失败：只能取消等待中的切换或检测');
  repos.tx(() => {
    repos.operations.update(op.id, { payload: { ...payloadOf(op), route: { ...p, cancelRequested: true } } });
    repos.operations.appendStep(op.id, op.phase, `${actor.kind === 'bridge' ? '扩展' : '用户'}请求取消`);
    repos.outbox.enqueue(op.id, 'cancel', engine.now());
    recordLedger(engine, requestId, digest, { operationId: op.id });
  });
  deps.kick();
  engine.emit({ operations: [op.id] });
  return acceptedOf(repos.operations.get(op.id)!, false);
}

export const WINDOW_WARNINGS: readonly RouteWarning[] = ['old_windows_kept_open', 'managed_windows_on_original_rules'];

export async function acceptAcknowledgeWindows(deps: AcceptDeps, req: AcknowledgeWindowsRequest, actor: Actor): Promise<{ accepted: Accepted; cleared: boolean }> {
  const { engine } = deps;
  const { repos } = engine;
  const requestId = requireRequestId(req?.request_id);
  const digest = await requestDigest(engine, 'acknowledgeWindows', null, req);
  const dup = findDuplicateOperation(engine, requestId, digest);
  if (dup) return { accepted: acceptedOf(dup, true), cleared: Boolean((dup.result as { cleared?: boolean } | null)?.cleared) };
  let cleared = false;
  const op = repos.tx(() => {
    const route = repos.routeState.get();
    const remaining = route.warnings.filter((w) => !WINDOW_WARNINGS.includes(w));
    cleared = remaining.length !== route.warnings.length;
    if (cleared) repos.routeState.update({ warnings: remaining });
    const created = insertOperation(engine, {
      kind: 'maintenance.reconcile',
      requestId,
      digest,
      actor,
      phase: 'COMPLETED',
      status: 'succeeded',
      enqueue: false,
      payload: { action: 'acknowledge_windows' },
      step: cleared ? '用户确认旧环境窗口已关闭：已清除窗口警告，路由未改变' : '没有需要清除的窗口警告',
    });
    repos.operations.update(created.id, { result: { cleared } });
    return repos.operations.get(created.id)!;
  });
  engine.emit({ operations: [op.id], route: cleared });
  return { accepted: acceptedOf(op, false), cleared };
}

export { diffStateOf as environmentDiffState };
export type { ProxyRevisionRecord };
