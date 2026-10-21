// 排队执行的其他操作：删除环境、解除绑定（docs/ARCHITECTURE.md §6.7）、单独的代理预检、核验前置（§6.8）。
// 删除/解除绑定从不删除 Safari 场景、Cookie 或登录资料；入口为 NORMAL 且 SFE-ROUTE 仍选着该环境的节点时
// 先改选 REJECT 并读回（此时 Safari 不经 SFE-ROUTE）。节点由之后的发布在满足移除条件时合批移除。

import { CAPABILITY_GATES, NODE_RESOURCE_FILE, ROUTE_GROUP_NAME, SfeError } from '@sfe/contract';
import type { OperationRecord } from '../../db/index.js';
import { payloadOf } from '../../domain/operations.js';
import type { Engine } from '../context.js';
import { routeOps } from '../route-control.js';
import { resourceNodeNames } from '../resource.js';
import { expireSafariProbe, recordPreflight } from './probes.js';

function envIdOf(op: OperationRecord): string | null {
  return op.environmentId ?? (typeof payloadOf(op).environmentId === 'string' ? (payloadOf(op).environmentId as string) : null);
}

function environmentInUse(engine: Engine, environmentId: string): boolean {
  const route = engine.repos.routeState.get();
  if (route.activeEnvironmentId === environmentId && route.entryMode !== 'NORMAL') return true;
  const ops = routeOps(engine);
  return [...ops.busy, ...ops.waitingVerification].some((o) => payloadOf(o).route?.targetEnvironmentId === environmentId);
}

export async function runDelete(engine: Engine, op: OperationRecord): Promise<void> {
  const { repos } = engine;
  const envId = envIdOf(op);
  engine.updateOp(op.id, { status: 'running', phase: 'VALIDATING' }, '开始删除环境');
  const env = envId ? repos.environments.get(envId) : null;
  if (!env || env.deletedAt) {
    engine.updateOp(op.id, { phase: 'COMPLETED', status: 'succeeded' }, '环境已删除');
    return;
  }
  if (environmentInUse(engine, env.id)) {
    const body = { code: 'ENVIRONMENT_ACTIVE' as const, message: '删除失败：环境正在使用或正在验证，请先进入普通模式' };
    engine.updateOp(op.id, { phase: 'FAILED', status: 'failed', error: body }, body.message);
    return;
  }
  const revisions = repos.proxyRevisions.listByEnvironment(env.id);
  const names = new Set(revisions.map((r) => r.nodeName));
  const route = repos.routeState.get();
  try {
    if (route.entryMode === 'NORMAL') {
      const sel = await engine.surge.getGroupSelection(ROUTE_GROUP_NAME);
      if (sel !== null && names.has(sel)) {
        await engine.surge.selectGroupPolicy(ROUTE_GROUP_NAME, 'REJECT');
        const after = await engine.surge.getGroupSelection(ROUTE_GROUP_NAME);
        if (after !== 'REJECT') throw new SfeError('READBACK_MISMATCH', '删除失败：SFE-ROUTE 改选 REJECT 后读回不一致');
        repos.routeState.update({ selectedNode: after });
        engine.step(op.id, 'SFE-ROUTE 原选择为该环境的节点：已改选 REJECT（读回确认）');
      }
    }
  } catch (err) {
    const body = engine.errorBody(err, '删除失败：调用 Surge 失败');
    engine.updateOp(op.id, { phase: 'FAILED', status: 'failed', error: body }, body.message);
    return;
  }
  // 仍在节点资源中的版本留给之后的发布移除；不在资源中的版本立即 retired 并回收秘密
  const files = engine.profileFiles();
  const inResource = new Set(resourceNodeNames(files ? await files.read(NODE_RESOURCE_FILE).catch(() => null) : null));
  repos.tx(() => {
    for (const r of revisions) {
      if (r.state === 'retired') continue;
      if (inResource.has(r.nodeName)) repos.proxyRevisions.updateState(env.id, r.revision, 'superseded');
      else {
        repos.proxyRevisions.updateState(env.id, r.revision, 'retired');
        for (const ref of [r.usernameRef, r.passwordRef]) if (ref) engine.secrets.orphanIfUnreferenced(ref);
      }
    }
    const account = repos.accounts.get(env.id);
    if (account?.passwordRef) engine.secrets.orphan(account.passwordRef);
    repos.accounts.delete(env.id);
    repos.profileBindings.deleteByEnvironment(env.id);
    repos.environments.update(env.id, { deletedAt: engine.nowIso(), revision: env.revision + 1 });
    repos.operations.update(op.id, { phase: 'COMPLETED', status: 'succeeded', resultRevision: env.revision + 1 });
    repos.operations.appendStep(op.id, 'COMPLETED', '环境已删除：映射与账号已清除，节点将在之后的发布中移除；Safari 场景、Cookie 与登录资料未改动');
  });
  engine.emit({ operations: [op.id], deletedEnvironments: [env.id], fronts: true, route: true });
}

export async function runUnbind(engine: Engine, op: OperationRecord): Promise<void> {
  const { repos } = engine;
  const envId = envIdOf(op);
  engine.updateOp(op.id, { status: 'running', phase: 'VALIDATING' }, '开始解除绑定');
  const env = envId ? repos.environments.get(envId) : null;
  if (!env || env.deletedAt) {
    engine.updateOp(op.id, { phase: 'FAILED', status: 'failed', error: { code: 'NOT_FOUND', message: '解除绑定失败：环境不存在' } });
    return;
  }
  if (environmentInUse(engine, env.id)) {
    const body = { code: 'ENVIRONMENT_ACTIVE' as const, message: '解除绑定失败：环境正在使用或正在验证，请先进入普通模式' };
    engine.updateOp(op.id, { phase: 'FAILED', status: 'failed', error: body }, body.message);
    return;
  }
  repos.tx(() => {
    repos.profileBindings.deleteByEnvironment(env.id);
    repos.environments.update(env.id, { revision: env.revision + 1 });
    repos.operations.update(op.id, { phase: 'COMPLETED', status: 'succeeded', resultRevision: env.revision + 1 });
    repos.operations.appendStep(op.id, 'COMPLETED', '已解除绑定：只删除映射，Safari 场景、Cookie 与登录资料未改动');
  });
  engine.emit({ operations: [op.id], environments: [env.id] });
}

export async function runPreflightOp(engine: Engine, op: OperationRecord): Promise<void> {
  const { repos } = engine;
  const envId = envIdOf(op);
  engine.updateOp(op.id, { status: 'running', phase: 'VALIDATING' }, '开始代理预检');
  const env = envId ? repos.environments.get(envId) : null;
  if (!env || env.deletedAt || env.deployedProxyRevision === null) {
    engine.updateOp(op.id, { phase: 'FAILED', status: 'failed', error: { code: 'NODE_NOT_DEPLOYED', message: '预检失败：环境没有已部署的版本' } });
    return;
  }
  await engine.readBasicFacts();
  if (engine.missing(CAPABILITY_GATES.preflight).length > 0) {
    const body = { code: 'CAPABILITY_UNVERIFIED' as const, message: '预检失败：候选节点独立预检尚未通过实测' };
    engine.updateOp(op.id, { phase: 'FAILED', status: 'failed', error: body }, body.message);
    return;
  }
  const rev = repos.proxyRevisions.get(env.id, env.deployedProxyRevision)!;
  const probe = await recordPreflight(engine, { environmentId: env.id, revision: rev, operationId: op.id, allowed: true, generation: repos.meta.configurationGeneration() });
  if (probe.outcome === 'ok') {
    repos.operations.appendStep(op.id, 'PREFLIGHT_OK', '代理预检通过');
    engine.updateOp(op.id, { phase: 'COMPLETED', status: 'succeeded', resultRevision: rev.revision }, '预检完成（预检不返回出口 IP）', { environments: [env.id] });
  } else {
    const body = { code: 'PREFLIGHT_FAILED' as const, message: probe.message ?? '代理预检失败' };
    engine.updateOp(op.id, { phase: 'FAILED', status: 'failed', error: body }, body.message, { environments: [env.id] });
  }
}

export async function runFrontVerify(engine: Engine, op: OperationRecord): Promise<void> {
  const { repos } = engine;
  const frontId = payloadOf(op).frontProxyId;
  engine.updateOp(op.id, { status: 'running', phase: 'VALIDATING' }, '开始核验前置');
  const front = frontId ? repos.frontProxies.get(frontId) : null;
  if (!front) {
    engine.updateOp(op.id, { phase: 'FAILED', status: 'failed', error: { code: 'NOT_FOUND', message: '核验前置失败：前置不存在' } });
    return;
  }
  let exists = false;
  try {
    const policies = await engine.surge.listPolicies();
    exists = policies.proxies.includes(front.surgeName) && !policies.groups.includes(front.surgeName);
  } catch (err) {
    const body = engine.errorBody(err, '核验前置失败：读取 Surge 策略失败');
    repos.frontProxies.update(front.id, { state: 'failed', lastCheckedAt: engine.nowIso() });
    engine.updateOp(op.id, { phase: 'FAILED', status: 'failed', error: body }, body.message, { fronts: true });
    return;
  }
  repos.frontProxies.update(front.id, { state: exists ? 'ok' : 'missing', lastCheckedAt: engine.nowIso() });
  const route = repos.routeState.get();
  const dependents = repos.environments.list().filter((e) => {
    if (e.deployedProxyRevision === null) return false;
    return repos.proxyRevisions.get(e.id, e.deployedProxyRevision)?.frontProxyId === front.id;
  });
  // 活动环境：实测标为过期（需要重新检测）；非活动环境：门槛允许时重新预检
  const touched: string[] = [];
  await engine.readBasicFacts();
  const preflightAllowed = engine.missing(CAPABILITY_GATES.preflight).length === 0;
  for (const e of dependents) {
    if (route.activeEnvironmentId === e.id) {
      if (expireSafariProbe(engine, e.id)) {
        repos.routeState.update({ warnings: [...repos.routeState.get().warnings, 'probe_expired'] });
      }
      touched.push(e.id);
      continue;
    }
    if (!exists) continue;
    const rev = repos.proxyRevisions.get(e.id, e.deployedProxyRevision!)!;
    await recordPreflight(engine, { environmentId: e.id, revision: rev, operationId: op.id, allowed: preflightAllowed, generation: repos.meta.configurationGeneration() });
    touched.push(e.id);
  }
  if (!exists) {
    const body = { code: 'FRONT_PROXY_MISSING' as const, message: '核验前置失败：前置节点不在 Surge 中' };
    engine.updateOp(op.id, { phase: 'FAILED', status: 'failed', error: body }, body.message, { fronts: true, environments: touched, route: true });
    return;
  }
  engine.updateOp(op.id, { phase: 'COMPLETED', status: 'succeeded' }, `前置存在；已处理依赖环境 ${touched.length} 个`, { fronts: true, environments: touched, route: true });
}
