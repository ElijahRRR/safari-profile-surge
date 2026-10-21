// 从数据库组装契约视图（快照、环境、操作、路由、前置、能力、设置）与事件。所有视图都是脱敏的：
// 账号只给打码值；代理凭据只给“是否已配置”；不含摘要与秘密引用。

import {
  CAPABILITY_GATES,
  type CapabilityProposalView,
  type EnvironmentView,
  type FrontProxyView,
  type OperationView,
  type RouteStateView,
  type ServiceEventPayload,
  type SettingsView,
  type Snapshot,
} from '@sfe/contract';
import type { CapabilityProposalRecord, EnvironmentRecord, OperationRecord, ProbeRecord } from '../db/index.js';
import { OPEN_STATUSES, PUBLISH_KINDS, payloadOf, routeTargetOf } from '../domain/operations.js';
import { buildEnvironmentView, buildFrontProxyViews, buildOperationView, buildRouteView, buildSurgeStatus } from '../domain/views.js';
import { missingFrom } from './capabilities.js';
import type { EmitSpec, Engine } from './context.js';

export interface ViewService {
  environmentView(id: string): EnvironmentView | null;
  environmentViews(): EnvironmentView[];
  operationView(id: string): OperationView | null;
  operationViews(ops: readonly OperationRecord[]): OperationView[];
  routeView(): RouteStateView;
  frontProxyViews(): FrontProxyView[];
  proposalViews(): CapabilityProposalView[];
  settingsView(): SettingsView;
  snapshot(serviceVersion: string, demo: boolean): Snapshot;
  lastSafariProbe(): ProbeRecord | null;
  /** 一组环境的 id → 依赖它的前置。 */
  frontDependents(): Map<string, string[]>;
  build(spec: EmitSpec): ServiceEventPayload[];
}

export function proposalView(p: CapabilityProposalRecord): CapabilityProposalView {
  return {
    id: p.id,
    key: p.key,
    proposedStatus: p.proposedStatus,
    context: p.context,
    protocolCoverage: p.protocolCoverage,
    summary: p.summary,
    evidenceDigest: p.evidenceDigest,
    submittedAt: p.submittedAt,
    submittedBy: p.submittedBy,
  };
}

export function createViewService(engine: Engine): ViewService {
  const { repos } = engine;

  const recentPublishOps = (): OperationRecord[] =>
    repos.operations.listRecent(300).filter((op) => PUBLISH_KINDS.includes(op.kind) && op.environmentId === null);

  const openRouteOps = (): OperationRecord[] =>
    repos.operations.listByStatus([...OPEN_STATUSES]).filter((op) => payloadOf(op).route !== undefined);

  function envViewWith(env: EnvironmentRecord, shared: { publishOps: OperationRecord[]; routeOps: OperationRecord[] }): EnvironmentView {
    const route = repos.routeState.get();
    const fronts = new Map(repos.frontProxies.list().map((f) => [f.id, f]));
    const views = engine.capabilityViews();
    const own = repos.operations.listForEnvironment(env.id, 50);
    const multi = shared.publishOps.filter((op) => (payloadOf(op).targets ?? []).some((t) => t.environmentId === env.id));
    const operations = [...own, ...multi].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? 1 : -1));
    const binding = repos.profileBindings.byEnvironment(env.id);
    return buildEnvironmentView(
      {
        env,
        revisions: repos.proxyRevisions.listByEnvironment(env.id),
        binding,
        report: binding ? repos.profileReports.get(binding.profileId) : null,
        account: repos.accounts.get(env.id),
        preflight: repos.probes.latest(env.id, 'preflight'),
        safari: repos.probes.latest(env.id, 'safari'),
        operations,
        routeOps: shared.routeOps.filter((op) => routeTargetOf(op) === env.id),
      },
      {
        now: engine.now(),
        route,
        fronts,
        publishMissing: missingFrom(views, CAPABILITY_GATES.publish),
        activateMissing: engine.activationMissing(views),
      },
    );
  }

  const service: ViewService = {
    environmentView(id) {
      const env = repos.environments.get(id);
      if (!env || env.deletedAt) return null;
      return envViewWith(env, { publishOps: recentPublishOps(), routeOps: openRouteOps() });
    },
    environmentViews() {
      const shared = { publishOps: recentPublishOps(), routeOps: openRouteOps() };
      return repos.environments.list().map((env) => envViewWith(env, shared));
    },
    operationView(id) {
      const op = repos.operations.get(id);
      return op ? service.operationViews([op])[0]! : null;
    },
    operationViews(ops) {
      const route = repos.routeState.get();
      const generation = repos.meta.configurationGeneration();
      return ops.map((op) =>
        buildOperationView(op, repos.operations.listSteps(op.id), {
          env: op.environmentId ? repos.environments.get(op.environmentId) : null,
          route,
          configurationGeneration: generation,
        }),
      );
    },
    lastSafariProbe() {
      const route = repos.routeState.get();
      return route.activeEnvironmentId ? repos.probes.latest(route.activeEnvironmentId, 'safari') : null;
    },
    routeView() {
      return buildRouteView(repos.routeState.get(), service.lastSafariProbe());
    },
    frontDependents() {
      const map = new Map<string, string[]>();
      const route = repos.routeState.get();
      for (const env of repos.environments.list()) {
        const revs = new Set<number>();
        for (const n of [env.desiredProxyRevision, env.deployedProxyRevision, env.lastVerifiedProxyRevision]) if (n !== null) revs.add(n);
        if (route.activeEnvironmentId === env.id && route.activeProxyRevision !== null) revs.add(route.activeProxyRevision);
        const fronts = new Set<string>();
        for (const n of revs) {
          const r = repos.proxyRevisions.get(env.id, n);
          if (r) fronts.add(r.frontProxyId);
        }
        for (const f of fronts) map.set(f, [...(map.get(f) ?? []), env.id]);
      }
      return map;
    },
    frontProxyViews() {
      return buildFrontProxyViews(repos.frontProxies.list(), service.frontDependents());
    },
    proposalViews() {
      return repos.proposals.list({ pending: true }).map(proposalView);
    },
    settingsView() {
      return repos.settings.view(engine.deps.surgeCliPath);
    },
    snapshot(serviceVersion, demo) {
      const sequence = engine.events.currentSequence();
      return {
        sequence,
        serviceVersion,
        demoMode: demo,
        environments: service.environmentViews(),
        route: service.routeView(),
        capabilities: engine.capabilityViews(),
        capabilityProposals: service.proposalViews(),
        surge: buildSurgeStatus(engine.facts, repos.meta.configurationGeneration()),
        frontProxies: service.frontProxyViews(),
        settings: service.settingsView(),
        pendingOperations: service.operationViews(repos.operations.listByStatus([...OPEN_STATUSES])),
      };
    },
    build(spec) {
      const out: ServiceEventPayload[] = [];
      const opIds = new Set(spec.operations ?? []);
      for (const id of opIds) {
        const v = service.operationView(id);
        if (v) out.push({ type: 'operation.updated', operation: v });
      }
      const envIds = new Set(spec.environments ?? []);
      const deleted = new Set(spec.deletedEnvironments ?? []);
      if (envIds.size > 0) {
        const shared = { publishOps: recentPublishOps(), routeOps: openRouteOps() };
        for (const id of envIds) {
          if (deleted.has(id)) continue;
          const env = repos.environments.get(id);
          if (!env) continue;
          if (env.deletedAt) {
            deleted.add(id);
            continue;
          }
          out.push({ type: 'environment.updated', environment: envViewWith(env, shared) });
        }
      }
      for (const id of deleted) out.push({ type: 'environment.deleted', environmentId: id });
      if (spec.route) out.push({ type: 'route.updated', route: service.routeView() });
      if (spec.surge) out.push({ type: 'surge.status', surge: buildSurgeStatus(engine.facts, repos.meta.configurationGeneration()) });
      if (spec.capabilities) out.push({ type: 'capabilities.updated', capabilities: engine.capabilityViews(), proposals: service.proposalViews() });
      if (spec.fronts) out.push({ type: 'frontProxies.updated', frontProxies: service.frontProxyViews() });
      if (spec.settings) out.push({ type: 'settings.updated', settings: service.settingsView() });
      return out;
    },
  };
  return service;
}
