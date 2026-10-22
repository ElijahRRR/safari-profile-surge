// 能力提议与确认（docs/ARCHITECTURE.md §5.2）、设置、前置代理（§6.8）。
// 提议只来自 P0 工具/agent 或维护通道；supported/unsupported 只能由网页会话确认一个提议。进程路径与入口策略
// 只来自已确认的提议，确认新值时入口必须是 NORMAL，并让依赖它们的能力回到待验证。演示模式不能记录能力。

import {
  CAPABILITY_CONTEXT_DEPS,
  CAPABILITY_CONTEXT_FIELDS,
  CAPABILITY_KEYS,
  ENTRY_STRATEGIES,
  SfeError,
  isSfeName,
  type Accepted,
  type CapabilityContext,
  type CapabilityKey,
  type CapabilityView,
  type ConfirmCapabilityRequest,
  type FrontProxyView,
  type ProposeCapabilityRequest,
  type RegisterFrontProxyRequest,
  type ReplaceFrontCommitRequest,
  type ReplaceFrontPreview,
  type ReplaceFrontPreviewRequest,
  type SettingsView,
  type UpdateFrontProxyRequest,
  type UpdateSettingsRequest,
  type VerifyFrontProxyRequest,
} from '@sfe/contract';
import type { Actor } from '../app.js';
import type { EnvironmentRecord } from '../db/index.js';
import { isSurgeReferenceName } from '../domain/validate.js';
import { labelOf, revisionNodeName } from '../domain/naming.js';
import { nodeLineChanged } from '../domain/node-line.js';
import { BUILTIN_POLICIES } from '../surge/rules.js';
import { coverageAllowsSupported, hostContextErrors, versionContextErrors } from '../surge/capability-gate.js';
import { validateSafariProcessPaths } from '../surge/generate.js';
import { keyedRequestDigest } from '../util/keyed-digest.js';
import { insertOperation, type AcceptDeps } from './accept.js';
import type { Engine } from './context.js';
import { acceptedOf, commitOperation, findDuplicateOperation, findLedger, recordLedger, requestDigest, requireRequestId } from './ledger.js';
import { expireSafariProbe } from './handlers/probes.js';
import { markSafariMayUseRoute, safariMayUseRoute } from './safari-route-marker.js';

function forbidden(message: string): SfeError {
  return new SfeError('BAD_REQUEST', message);
}

function requireWeb(actor: Actor, action: string): void {
  if (actor.kind !== 'web') throw forbidden(`${action}失败：只能在网页后台完成`);
}

function requireWebOrAdmin(actor: Actor, action: string): void {
  if (actor.kind !== 'web' && actor.kind !== 'admin') throw forbidden(`${action}失败：该通道无权执行此操作`);
}

// ---------- 能力 ----------

const COVERAGE_REQUIRED: readonly CapabilityKey[] = ['safari_process_attribution', 'safari_udp_quic_handling'];

function validContext(ctx: unknown): ctx is CapabilityContext {
  if (typeof ctx !== 'object' || ctx === null || Array.isArray(ctx)) return false;
  const obj = ctx as Record<string, unknown>;
  return CAPABILITY_CONTEXT_FIELDS.every((f) => obj[f] === null || (typeof obj[f] === 'string' && (obj[f] as string).length <= 4096));
}

export async function proposeCapability(deps: AcceptDeps, req: ProposeCapabilityRequest, actor: Actor): Promise<{ proposal_id: string }> {
  const { engine } = deps;
  if (actor.kind !== 'agent' && actor.kind !== 'admin') throw forbidden('提交能力证据失败：只能由 P0 工具、agent 或维护通道提交，网页只确认');
  if (engine.deps.demo) throw forbidden('提交能力证据失败：演示模式不能记录能力');
  const requestId = requireRequestId(req?.request_id);
  const digest = await requestDigest(engine, 'proposeCapability', null, req);
  const dup = findLedger<{ proposalId: string }>(engine, requestId, digest);
  if (dup) return { proposal_id: dup.ref.proposalId };
  const errors: Array<{ field: string; message: string }> = [];
  if (!(CAPABILITY_KEYS as readonly string[]).includes(req.key)) errors.push({ field: 'key', message: '能力项不存在' });
  if (req.proposed_status !== 'supported' && req.proposed_status !== 'unsupported') errors.push({ field: 'proposed_status', message: '只能是 supported 或 unsupported' });
  if (!validContext(req.context)) errors.push({ field: 'context', message: '验证上下文不完整' });
  if (typeof req.summary !== 'string' || req.summary.trim() === '' || req.summary.length > 4000) errors.push({ field: 'summary', message: '需要脱敏摘要（不超过 4000 字）' });
  if (typeof req.evidence_digest !== 'string' || !/^[A-Za-z0-9:_-]{8,256}$/.test(req.evidence_digest)) errors.push({ field: 'evidence_digest', message: '原始证据摘要格式不正确' });
  if (errors.length > 0) throw new SfeError('VALIDATION_FAILED', '提交能力证据失败：字段校验未通过', { fieldErrors: errors });
  const evidence: Array<{ field: string; message: string }> = [];
  // 依赖 Surge 版本/构建的能力必须带读到的具体版本：null 或 any 的记录在门槛中永远不会生效（读不到版本即待验证），
  // 格式不对的值（例如 CLI 交互模式输出的 127.0.0.1）不是版本。
  evidence.push(...versionContextErrors(req.key, req.context).map((e) => ({ field: `context.${e.field}`, message: e.message })));
  // 依赖 Safari 进程归属的能力：有待重启的后台安全改进（或无法确认）时测得的记录永远不会生效；补充版本读不到或为 any 时
  // 装上后台安全改进后记录不会过期。
  evidence.push(...hostContextErrors(req.key, req.context).map((e) => ({ field: `context.${e.field}`, message: e.message })));
  if (COVERAGE_REQUIRED.includes(req.key) && (typeof req.protocol_coverage !== 'object' || req.protocol_coverage === null)) {
    evidence.push({ field: 'protocol_coverage', message: '该能力的提议必须带逐协议覆盖' });
  }
  if (req.key === 'safari_process_attribution') {
    const pathErrors = validateSafariProcessPaths(req.safari_process_paths, { exists: (p) => engine.host.processPathExists(p) });
    evidence.push(...pathErrors.map((e) => ({ field: e.field.replace('safariProcessPaths', 'safari_process_paths'), message: e.message })));
  }
  if (req.key === 'runtime_entry_modes' && !(ENTRY_STRATEGIES as readonly unknown[]).includes(req.entry_strategy)) {
    evidence.push({ field: 'entry_strategy', message: '必须带所验证的入口策略' });
  }
  if (evidence.length > 0) throw new SfeError('EVIDENCE_REQUIRED', '提交能力证据失败：缺少必需的证据', { fieldErrors: evidence });
  const id = engine.ids.next('prop');
  engine.repos.tx(() => {
    // 同一能力较早的、永远不能确认的待确认提议（早于版本校验提交，带 null、any 或 127.0.0.1；或缺少可用的后台安全改进
    // 状态）随这次重测的提议作废，不再留在网页的待确认列表中；其他待确认提议不受影响。
    for (const old of engine.repos.proposals.list({ pending: true, key: req.key })) {
      if (proposalVersionErrors(old).length > 0 || hostContextErrors(old.key, old.context).length > 0) engine.repos.proposals.markRejected(old.id, engine.now());
    }
    engine.repos.proposals.insert({
      id,
      key: req.key,
      proposedStatus: req.proposed_status,
      context: req.context,
      summary: req.summary,
      evidenceDigest: req.evidence_digest,
      protocolCoverage: req.protocol_coverage ?? null,
      safariProcessPaths: req.key === 'safari_process_attribution' ? [...(req.safari_process_paths ?? [])] : null,
      entryStrategy: req.key === 'runtime_entry_modes' ? (req.entry_strategy ?? null) : null,
      submittedBy: actor.kind === 'agent' ? 'agent' : 'admin',
    });
    recordLedger(engine, requestId, digest, { proposalId: id });
  });
  engine.emit({ capabilities: true });
  return { proposal_id: id };
}

/** 已存提议的版本字段按提议校验再查一次；不为空时这条提议永远不能确认（提议的上下文不会再变）。 */
function proposalVersionErrors(p: { key: CapabilityKey; context: CapabilityContext | null }): ReturnType<typeof versionContextErrors> {
  return versionContextErrors(p.key, p.context ?? { surgeVersion: null, surgeBuild: null });
}

/** 依赖某个上下文字段的能力（不含正在确认的那一项）回到待验证。 */
function resetDependents(engine: Engine, field: 'entryStrategy' | 'processPathsDigest', except: CapabilityKey): CapabilityKey[] {
  const out: CapabilityKey[] = [];
  for (const key of CAPABILITY_KEYS) {
    if (key === except || !CAPABILITY_CONTEXT_DEPS[key].includes(field)) continue;
    const rec = engine.repos.capabilities.get(key);
    if (!rec || rec.status === 'unverified') continue;
    engine.repos.capabilities.upsert({ key, status: 'unverified', note: field === 'entryStrategy' ? '入口策略已更改，需要重新实测' : 'Safari 进程路径已更改，需要重新实测' });
    out.push(key);
  }
  return out;
}

export async function confirmCapability(deps: AcceptDeps, req: ConfirmCapabilityRequest, actor: Actor): Promise<CapabilityView> {
  const { engine } = deps;
  const { repos } = engine;
  requireWeb(actor, '确认能力');
  if (engine.deps.demo) throw forbidden('确认能力失败：演示模式不能记录能力');
  const requestId = requireRequestId(req?.request_id);
  const digest = await requestDigest(engine, 'confirmCapability', null, req);
  const dup = findLedger<{ key: CapabilityKey }>(engine, requestId, digest);
  if (dup) return engine.capabilityViews().find((v) => v.key === dup.ref.key)!;
  let key: CapabilityKey;
  let settingsChanged = false;
  if (req.action === 'reset') {
    if (!(CAPABILITY_KEYS as readonly string[]).includes(req.key)) throw new SfeError('VALIDATION_FAILED', '重置能力失败：能力项不存在', { fieldErrors: [{ field: 'key', message: '能力项不存在' }] });
    key = req.key;
    repos.tx(() => {
      repos.capabilities.upsert({ key, status: 'unverified', note: typeof req.note === 'string' ? req.note.slice(0, 2000) : null });
      recordLedger(engine, requestId, digest, { key });
    });
  } else if (req.action === 'confirm') {
    const proposal = typeof req.proposal_id === 'string' ? repos.proposals.get(req.proposal_id) : null;
    if (!proposal || proposal.confirmedAt || proposal.rejectedAt) throw new SfeError('NOT_FOUND', '确认能力失败：提议不存在或已处理');
    key = proposal.key;
    // 与提议时同一规则（早于该规则提交的提议可能带 null、any 或 127.0.0.1）：在改动设置、让其他能力回到待验证之前拒绝。
    // 提议的上下文不会再变，这条提议永远不能确认：标为已驳回（不再显示在待确认列表中），需要在能读取运行中 Surge 的
    // 版本后重测并重新提议。设置与能力记录不变。
    const versionErrors = proposalVersionErrors(proposal);
    if (versionErrors.length > 0) {
      if (repos.tx(() => repos.proposals.markRejected(proposal.id, engine.now()))) engine.emit({ capabilities: true });
      throw new SfeError('EVIDENCE_REQUIRED', '确认能力失败：提议中的 Surge 版本或构建号不可用，这条提议已移除；请在能读取运行中 Surge 的版本后重测并重新提议', {
        fieldErrors: versionErrors.map((e) => ({ field: `context.${e.field}`, message: e.message })),
      });
    }
    // 同一规则：后台安全改进待重启（或无法确认）时测得、或缺少补充版本的提议永远不能确认（早于该规则提交的提议没有这两个字段）。
    const hostErrors = hostContextErrors(proposal.key, proposal.context);
    if (hostErrors.length > 0) {
      if (repos.tx(() => repos.proposals.markRejected(proposal.id, engine.now()))) engine.emit({ capabilities: true });
      throw new SfeError('EVIDENCE_REQUIRED', '确认能力失败：提议缺少可用的后台安全改进状态（例如测量时 Mac 有待重启的后台安全改进），这条提议已移除；请重启 Mac 后重测并重新提议', {
        fieldErrors: hostErrors.map((e) => ({ field: `context.${e.field}`, message: e.message })),
      });
    }
    if (proposal.proposedStatus === 'supported' && COVERAGE_REQUIRED.includes(key)) {
      const cov = coverageAllowsSupported(proposal.protocolCoverage);
      if (!cov.ok) {
        throw new SfeError('EVIDENCE_REQUIRED', '确认能力失败：逐协议覆盖不完整，每项必须通过或写明限制', { details: { missing: cov.missing } });
      }
    }
    const route = repos.routeState.get();
    const s = engine.settings();
    const newPaths = key === 'safari_process_attribution' && proposal.proposedStatus === 'supported' ? (proposal.safariProcessPaths ?? []) : null;
    const newStrategy = key === 'runtime_entry_modes' && proposal.proposedStatus === 'supported' ? proposal.entryStrategy : null;
    const pathsChange = newPaths !== null && JSON.stringify([...newPaths].sort()) !== JSON.stringify([...s.safariProcessPaths].sort());
    const strategyChange = newStrategy !== null && newStrategy !== s.entryStrategy;
    if ((pathsChange || strategyChange) && route.entryMode !== 'NORMAL') {
      throw new SfeError('ENVIRONMENT_ACTIVE', '确认能力失败：入口不是普通模式，请先进入普通模式再更改进程路径或入口策略');
    }
    if (newPaths !== null) {
      const errs = validateSafariProcessPaths(newPaths, { exists: (p) => engine.host.processPathExists(p) });
      if (errs.length > 0) throw new SfeError('EVIDENCE_REQUIRED', '确认能力失败：提议中的进程路径不可用', { fieldErrors: errs });
    }
    repos.tx(() => {
      if (!repos.proposals.markConfirmed(proposal.id, engine.now())) throw new SfeError('NOT_FOUND', '确认能力失败：提议已处理');
      repos.capabilities.upsert({
        key,
        status: proposal.proposedStatus,
        context: proposal.context,
        protocolCoverage: proposal.protocolCoverage,
        proposalId: proposal.id,
        verifiedAt: engine.nowIso(),
        note: proposal.summary,
      });
      if (pathsChange) {
        // Safari 可能仍有经 SFE-ROUTE 的连接（普通模式尚未确认结束）：把被换掉的路径记入持久标记，下一次普通模式另按它们结束
        // 其中可能经买家出口的连接，再清除标记
        if (safariMayUseRoute(engine, route)) markSafariMayUseRoute(engine, null, s.safariProcessPaths);
        repos.settings.set('safariProcessPaths', [...newPaths!]);
        resetDependents(engine, 'processPathsDigest', key);
        settingsChanged = true;
      }
      if (strategyChange) {
        repos.settings.set('entryStrategy', newStrategy);
        resetDependents(engine, 'entryStrategy', key);
        settingsChanged = true;
      }
      recordLedger(engine, requestId, digest, { key });
    });
  } else {
    throw new SfeError('VALIDATION_FAILED', '确认能力失败：action 只能是 confirm 或 reset', { fieldErrors: [{ field: 'action', message: '只能是 confirm 或 reset' }] });
  }
  engine.emit({ capabilities: true, settings: settingsChanged, environments: repos.environments.list().map((e) => e.id) });
  return engine.capabilityViews().find((v) => v.key === key)!;
}

// ---------- 设置 ----------

const TIMEOUT_BOUNDS: Record<'profileArrivalTimeoutSec' | 'safariVerifyTimeoutSec' | 'probeTtlSec' | 'reconcileIntervalSec', [number, number]> = {
  profileArrivalTimeoutSec: [30, 86_400],
  safariVerifyTimeoutSec: [15, 3_600],
  probeTtlSec: [60, 86_400],
  reconcileIntervalSec: [5, 3_600],
};

export async function updateSettings(deps: AcceptDeps, req: UpdateSettingsRequest, actor: Actor): Promise<SettingsView> {
  const { engine, views } = deps;
  const { repos } = engine;
  requireWebOrAdmin(actor, '修改设置');
  const requestId = requireRequestId(req?.request_id);
  const digest = await requestDigest(engine, 'updateSettings', null, req);
  if (findLedger(engine, requestId, digest)) return views.settingsView();
  const errors: Array<{ field: string; message: string }> = [];
  const route = repos.routeState.get();
  if (req.verifyEndpointId !== undefined) {
    if (!engine.verifyEndpoints().some((e) => e.id === req.verifyEndpointId)) errors.push({ field: 'verifyEndpointId', message: '检测服务不在固定清单中' });
  }
  if (req.defaultFrontProxyId !== undefined && req.defaultFrontProxyId !== null) {
    const f = repos.frontProxies.get(req.defaultFrontProxyId);
    if (!f || f.retired) errors.push({ field: 'defaultFrontProxyId', message: '前置代理未登记或已停用' });
  }
  for (const key of Object.keys(TIMEOUT_BOUNDS) as Array<keyof typeof TIMEOUT_BOUNDS>) {
    const v = req[key];
    if (v === undefined) continue;
    const [lo, hi] = TIMEOUT_BOUNDS[key];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < lo || v > hi) errors.push({ field: key, message: `必须是 ${lo}–${hi} 之间的整数（秒）` });
  }
  if (errors.length > 0) throw new SfeError('VALIDATION_FAILED', '修改设置失败：字段校验未通过', { fieldErrors: errors });
  const endpointChange = req.verifyEndpointId !== undefined && req.verifyEndpointId !== repos.settings.get('verifyEndpointId');
  if (endpointChange && route.entryMode !== 'NORMAL') {
    throw new SfeError('ENVIRONMENT_ACTIVE', '修改设置失败：检测服务只能在普通模式下修改，请先进入普通模式');
  }
  repos.tx(() => {
    if (endpointChange) {
      repos.settings.set('verifyEndpointId', req.verifyEndpointId!);
      // 修改检测服务后 Safari 实测全部视为过期
      for (const env of repos.environments.list()) expireSafariProbe(engine, env.id);
    }
    if (req.defaultFrontProxyId !== undefined) repos.settings.setDefaultFrontProxyId(req.defaultFrontProxyId);
    for (const key of Object.keys(TIMEOUT_BOUNDS) as Array<keyof typeof TIMEOUT_BOUNDS>) {
      const v = req[key];
      if (v !== undefined) repos.settings.set(key, v);
    }
    recordLedger(engine, requestId, digest, { settings: true });
  });
  engine.emit({ settings: true, fronts: req.defaultFrontProxyId !== undefined, environments: endpointChange ? repos.environments.list().map((e) => e.id) : [] });
  return views.settingsView();
}

// ---------- 前置代理 ----------

function isRegistrableNode(name: string, policies: { proxies: string[]; groups: string[] }): string | null {
  if (!isSurgeReferenceName(name)) return '节点名格式不正确';
  if (/^SFE-/i.test(name) || isSfeName(name)) return '不能使用本应用的 SFE- 节点';
  if (BUILTIN_POLICIES.has(name.toUpperCase())) return '不能使用 DIRECT、REJECT 等内置策略';
  if (policies.groups.includes(name)) return '不能使用策略组：组选择变化会同时影响多个环境';
  if (!policies.proxies.includes(name)) return 'Surge 中没有这个代理节点';
  return null;
}

export async function registerFrontProxy(deps: AcceptDeps, req: RegisterFrontProxyRequest, actor: Actor): Promise<FrontProxyView> {
  const { engine, views } = deps;
  const { repos } = engine;
  requireWebOrAdmin(actor, '登记前置');
  const requestId = requireRequestId(req?.request_id);
  const digest = await requestDigest(engine, 'registerFrontProxy', null, req);
  const dup = findLedger<{ frontId: string }>(engine, requestId, digest);
  if (dup) return views.frontProxyViews().find((f) => f.id === dup.ref.frontId)!;
  if (typeof req.surgeName !== 'string') throw new SfeError('VALIDATION_FAILED', '登记前置失败：缺少节点名', { fieldErrors: [{ field: 'surgeName', message: '必填' }] });
  const policies = await engine.surge.listPolicies();
  const problem = isRegistrableNode(req.surgeName, policies);
  if (problem) throw new SfeError('VALIDATION_FAILED', `登记前置失败：${problem}`, { fieldErrors: [{ field: 'surgeName', message: problem }] });
  const existing = repos.frontProxies.byName(req.surgeName);
  let id: string;
  repos.tx(() => {
    if (existing) {
      if (!existing.retired) throw new SfeError('NAME_COLLISION', '登记前置失败：该节点已登记');
      repos.frontProxies.update(existing.id, { retired: false, state: 'ok', lastCheckedAt: engine.nowIso() });
      id = existing.id;
    } else {
      id = engine.ids.next('front');
      repos.frontProxies.insert({ id, surgeName: req.surgeName, state: 'ok', lastCheckedAt: engine.nowIso() });
    }
    if (req.makeDefault === true || repos.settings.defaultFrontProxyId() === null) repos.frontProxies.setDefault(id);
    recordLedger(engine, requestId, digest, { frontId: id });
  });
  engine.emit({ fronts: true, settings: true });
  return views.frontProxyViews().find((f) => f.id === id!)!;
}

export async function updateFrontProxy(deps: AcceptDeps, id: string, req: UpdateFrontProxyRequest, actor: Actor): Promise<FrontProxyView> {
  const { engine, views } = deps;
  const { repos } = engine;
  requireWebOrAdmin(actor, '修改前置');
  const requestId = requireRequestId(req?.request_id);
  const digest = await requestDigest(engine, 'updateFrontProxy', id, req);
  if (findLedger(engine, requestId, digest)) {
    const v = views.frontProxyViews().find((f) => f.id === id);
    if (v) return v;
  }
  const front = repos.frontProxies.get(id);
  if (!front) throw new SfeError('NOT_FOUND', '修改前置失败：前置不存在');
  if (req.retire === true) {
    const deps2 = views.frontDependents().get(id) ?? [];
    if (deps2.length > 0) throw new SfeError('VALIDATION_FAILED', '停用前置失败：仍有环境依赖该前置', { details: { dependentEnvironmentIds: deps2 } });
  }
  if (req.makeDefault === true && (front.retired || req.retire === true)) throw new SfeError('VALIDATION_FAILED', '设为默认失败：前置已停用');
  repos.tx(() => {
    if (req.retire === true) {
      repos.frontProxies.update(id, { retired: true, isDefault: false });
    }
    if (req.makeDefault === true) repos.frontProxies.setDefault(id);
    recordLedger(engine, requestId, digest, { frontId: id });
  });
  engine.emit({ fronts: true, settings: true });
  return views.frontProxyViews().find((f) => f.id === id)!;
}

export async function verifyFrontProxy(deps: AcceptDeps, id: string, req: VerifyFrontProxyRequest, actor: Actor): Promise<Accepted> {
  const { engine } = deps;
  requireWebOrAdmin(actor, '核验前置');
  const requestId = requireRequestId(req?.request_id);
  const digest = await requestDigest(engine, 'verifyFrontProxy', id, req);
  const dup = findDuplicateOperation(engine, requestId, digest);
  if (dup) return acceptedOf(dup, true);
  if (!engine.repos.frontProxies.get(id)) throw new SfeError('NOT_FOUND', '核验前置失败：前置不存在');
  const op = engine.repos.tx(() => insertOperation(engine, { kind: 'front.verify', requestId, digest, actor, payload: { frontProxyId: id }, step: '已受理核验前置' }));
  deps.kick();
  engine.emit({ operations: [op.id] });
  return acceptedOf(op, false);
}

function currentFrontOf(engine: Engine, env: EnvironmentRecord): string | null {
  const rev = env.desiredProxyRevision !== null ? engine.repos.proxyRevisions.get(env.id, env.desiredProxyRevision) : null;
  return rev?.frontProxyId ?? null;
}

async function replaceDigest(engine: Engine, fromId: string, toId: string, envIds: readonly string[]): Promise<string> {
  const keys = await engine.keys();
  const items = [...envIds].sort().map((id) => {
    const env = engine.repos.environments.get(id);
    return { id, front: env ? currentFrontOf(engine, env) : null, deleted: !env || env.deletedAt !== null };
  });
  return keyedRequestDigest(keys.preview, { kind: 'front.replace', fromId, toId, items });
}

function replaceItems(engine: Engine, fromId: string, envIds: readonly string[]): ReplaceFrontPreview['items'] {
  const route = engine.repos.routeState.get();
  return envIds.map((id) => {
    const env = engine.repos.environments.get(id);
    if (!env || env.deletedAt) throw new SfeError('NOT_FOUND', '更换前置失败：环境不存在');
    const cur = currentFrontOf(engine, env);
    if (cur !== fromId) throw new SfeError('VALIDATION_FAILED', '更换前置失败：环境当前不使用该前置', { fieldErrors: [{ field: 'environment_ids', message: `${labelOf(env)} 当前不使用该前置` }] });
    return { environment_id: env.id, label: labelOf(env), revision: env.revision, currentFrontName: engine.repos.frontProxies.get(cur)?.surgeName ?? '', isActive: route.activeEnvironmentId === env.id };
  });
}

function validateReplace(engine: Engine, fromId: string, req: ReplaceFrontPreviewRequest): string[] {
  const from = engine.repos.frontProxies.get(fromId);
  if (!from) throw new SfeError('NOT_FOUND', '更换前置失败：原前置不存在');
  const to = typeof req.to_front_id === 'string' ? engine.repos.frontProxies.get(req.to_front_id) : null;
  if (!to || to.retired) throw new SfeError('VALIDATION_FAILED', '更换前置失败：新前置未登记或已停用', { fieldErrors: [{ field: 'to_front_id', message: '前置未登记或已停用' }] });
  if (to.id === from.id) throw new SfeError('VALIDATION_FAILED', '更换前置失败：新旧前置相同', { fieldErrors: [{ field: 'to_front_id', message: '新旧前置相同' }] });
  if (!Array.isArray(req.environment_ids) || req.environment_ids.length === 0 || req.environment_ids.some((x) => typeof x !== 'string')) {
    throw new SfeError('VALIDATION_FAILED', '更换前置失败：请选择环境', { fieldErrors: [{ field: 'environment_ids', message: '至少选择一个环境' }] });
  }
  return [...new Set(req.environment_ids)];
}

export async function replaceFrontPreview(deps: AcceptDeps, fromId: string, req: ReplaceFrontPreviewRequest, actor: Actor): Promise<ReplaceFrontPreview> {
  const { engine } = deps;
  requireWebOrAdmin(actor, '更换前置');
  const ids = validateReplace(engine, fromId, req);
  const items = replaceItems(engine, fromId, ids);
  return { preview_digest: await replaceDigest(engine, fromId, req.to_front_id, ids), items };
}

export async function replaceFrontCommit(deps: AcceptDeps, fromId: string, req: ReplaceFrontCommitRequest, actor: Actor): Promise<Accepted> {
  const { engine } = deps;
  const { repos } = engine;
  requireWebOrAdmin(actor, '更换前置');
  const requestId = requireRequestId(req?.request_id);
  const digest = await requestDigest(engine, 'replaceFrontCommit', fromId, req);
  const dup = findDuplicateOperation(engine, requestId, digest);
  if (dup) return acceptedOf(dup, true);
  const ids = validateReplace(engine, fromId, req);
  if (req.preview_digest !== (await replaceDigest(engine, fromId, req.to_front_id, ids))) {
    throw new SfeError('PREVIEW_STALE', '更换前置失败：环境或前置已变化，请重新预览');
  }
  const expected = req.expected_revisions ?? {};
  const { op, duplicate } = commitOperation(engine, requestId, digest, () => {
    const targets: Array<{ environmentId: string; proxyRevision: number }> = [];
    const items: Array<{ environment_id: string; status: 'replaced' | 'revision_conflict' | 'unchanged'; revision: number }> = [];
    for (const id of ids) {
      const env = repos.environments.get(id)!;
      if (expected[id] !== env.revision) {
        items.push({ environment_id: id, status: 'revision_conflict', revision: env.revision });
        continue;
      }
      const cur = repos.proxyRevisions.get(env.id, env.desiredProxyRevision!)!;
      const next = { protocol: cur.protocol, host: cur.host, port: cur.port, usernameFp: cur.usernameFp, passwordFp: cur.passwordFp, frontProxyId: req.to_front_id };
      if (!nodeLineChanged({ ...next, frontProxyId: cur.frontProxyId }, next)) {
        items.push({ environment_id: id, status: 'unchanged', revision: env.revision });
        continue;
      }
      const newRev = repos.proxyRevisions.maxRevision(env.id) + 1;
      repos.proxyRevisions.insert({
        environmentId: env.id,
        revision: newRev,
        protocol: cur.protocol,
        host: cur.host,
        port: cur.port,
        usernameRef: cur.usernameRef,
        usernameFp: cur.usernameFp,
        passwordRef: cur.passwordRef,
        passwordFp: cur.passwordFp,
        frontProxyId: req.to_front_id,
        nodeName: revisionNodeName(env, newRev),
        state: 'desired',
      });
      if (cur.state === 'desired' && cur.revision !== env.deployedProxyRevision && cur.revision !== env.lastVerifiedProxyRevision) {
        repos.proxyRevisions.updateState(env.id, cur.revision, 'superseded');
      }
      repos.environments.update(env.id, { revision: env.revision + 1, desiredProxyRevision: newRev });
      targets.push({ environmentId: env.id, proxyRevision: newRev });
      items.push({ environment_id: id, status: 'replaced', revision: env.revision + 1 });
    }
    const created = insertOperation(engine, {
      kind: 'front.replace',
      requestId,
      digest,
      actor,
      payload: { targets, frontProxyId: req.to_front_id },
      status: targets.length > 0 ? 'queued' : 'succeeded',
      phase: targets.length > 0 ? 'SAVED' : 'COMPLETED',
      enqueue: targets.length > 0,
      step: `已为 ${targets.length} 个环境生成使用新前置的版本${items.some((i) => i.status === 'revision_conflict') ? '；部分环境版本冲突未更换' : ''}`,
    });
    repos.operations.update(created.id, { result: { items } });
    return repos.operations.get(created.id)!;
  });
  if (duplicate) return acceptedOf(op, true);
  if (op.status === 'queued') deps.kick();
  engine.emit({ operations: [op.id], environments: ids, fronts: true });
  return acceptedOf(op, false);
}
