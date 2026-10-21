// 网页状态：只保存服务端快照与按序号应用的事件，不是第二套配置源。
// 事件序号必须大于已应用的序号才生效（旧事件忽略）；重新读取快照期间到达的事件先缓存，
// 快照落定后只重放序号更大的部分，避免丢失或倒退。

import { computed, reactive } from 'vue';
import type {
  CapabilityProposalView,
  CapabilityView,
  EnvironmentView,
  FrontProxyView,
  OperationView,
  RouteStateView,
  ServiceEvent,
  SessionInfo,
  SettingsView,
  Snapshot,
  SurgeStatusView,
} from '@sfe/contract';
import { hasPendingDeploy, isUsing, needsAttention, sortByCode } from '../lib/environments';
import type { StreamState } from '../api/event-stream';

export type SessionStatus = 'checking' | 'none' | 'expired' | 'error' | 'authenticated';

export interface ConsoleState {
  session: { status: SessionStatus; info: SessionInfo | null; message: string | null };
  snapshot: Snapshot | null;
  /** 已应用的最大事件序号。 */
  sequence: number;
  /** 最近操作（新的在前）；来自操作列表接口与 operation.updated 事件。 */
  operations: OperationView[];
  operationsLoaded: boolean;
  stream: StreamState;
  /** 用于相对时间与实测有效期判断的时钟（毫秒）。 */
  now: number;
}

const ACTIVE_STATUSES = new Set(['queued', 'running', 'waiting']);
const MAX_OPERATIONS = 300;

export function createConsoleStore(now: () => number = () => Date.now()) {
  const state = reactive<ConsoleState>({
    session: { status: 'checking', info: null, message: null },
    snapshot: null,
    sequence: 0,
    operations: [],
    operationsLoaded: false,
    stream: 'idle',
    now: now(),
  });

  let reloading = false;
  let buffered: ServiceEvent[] = [];

  function upsertOperation(op: OperationView) {
    const list = state.operations;
    const i = list.findIndex((o) => o.id === op.id);
    if (i >= 0) list.splice(i, 1, op);
    else {
      list.unshift(op);
      list.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
      if (list.length > MAX_OPERATIONS) list.splice(MAX_OPERATIONS);
    }
    const snap = state.snapshot;
    if (snap) {
      const j = snap.pendingOperations.findIndex((o) => o.id === op.id);
      const active = ACTIVE_STATUSES.has(op.status);
      if (j >= 0 && active) snap.pendingOperations.splice(j, 1, op);
      else if (j >= 0) snap.pendingOperations.splice(j, 1);
      else if (active) snap.pendingOperations.push(op);
    }
  }

  function setOperations(list: OperationView[]) {
    const byId = new Map(state.operations.map((o) => [o.id, o]));
    for (const op of list) {
      const existing = byId.get(op.id);
      // 事件可能比列表接口更新：保留更新时间更晚的那份。
      if (!existing || existing.updatedAt <= op.updatedAt) byId.set(op.id, op);
    }
    state.operations = [...byId.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0)).slice(0, MAX_OPERATIONS);
    state.operationsLoaded = true;
  }

  function apply(event: ServiceEvent) {
    const snap = state.snapshot!;
    switch (event.type) {
      case 'operation.updated':
        upsertOperation(event.operation);
        break;
      case 'environment.updated': {
        const i = snap.environments.findIndex((e) => e.id === event.environment.id);
        if (i >= 0) snap.environments.splice(i, 1, event.environment);
        else snap.environments.push(event.environment);
        break;
      }
      case 'environment.deleted': {
        const i = snap.environments.findIndex((e) => e.id === event.environmentId);
        if (i >= 0) snap.environments.splice(i, 1);
        break;
      }
      case 'route.updated':
        snap.route = event.route;
        break;
      case 'surge.status':
        snap.surge = event.surge;
        break;
      case 'capabilities.updated':
        snap.capabilities = event.capabilities;
        snap.capabilityProposals = event.proposals;
        break;
      case 'frontProxies.updated':
        snap.frontProxies = event.frontProxies;
        break;
      case 'settings.updated':
        snap.settings = event.settings;
        break;
      case 'snapshot.required':
        break;
    }
  }

  /** 按序号应用事件；返回是否生效。 */
  function applyEvent(event: ServiceEvent): boolean {
    if (reloading) {
      buffered.push(event);
      return false;
    }
    if (!state.snapshot) return false;
    if (!Number.isFinite(event.sequence) || event.sequence <= state.sequence) return false;
    state.sequence = event.sequence;
    apply(event);
    return true;
  }

  /** 快照是权威状态：序号以它为准（服务重启后序号可能变小）。 */
  function setSnapshot(snapshot: Snapshot) {
    state.snapshot = snapshot;
    state.sequence = snapshot.sequence;
    for (const op of snapshot.pendingOperations) {
      const i = state.operations.findIndex((o) => o.id === op.id);
      if (i >= 0) state.operations.splice(i, 1, op);
      else state.operations.unshift(op);
    }
  }

  function beginReload() {
    reloading = true;
    buffered = [];
  }

  function finishReload(snapshot: Snapshot | null) {
    reloading = false;
    const pending = buffered.sort((a, b) => a.sequence - b.sequence);
    buffered = [];
    if (snapshot) setSnapshot(snapshot);
    for (const e of pending) applyEvent(e);
  }

  function setSettings(settings: SettingsView) {
    if (state.snapshot) state.snapshot.settings = settings;
  }

  function setSurge(surge: SurgeStatusView) {
    if (state.snapshot) state.snapshot.surge = surge;
  }

  function setFrontProxy(front: FrontProxyView) {
    const snap = state.snapshot;
    if (!snap) return;
    const i = snap.frontProxies.findIndex((f) => f.id === front.id);
    if (i >= 0) snap.frontProxies.splice(i, 1, front);
    else snap.frontProxies.push(front);
  }

  function setCapability(cap: CapabilityView) {
    const snap = state.snapshot;
    if (!snap) return;
    const i = snap.capabilities.findIndex((c) => c.key === cap.key);
    if (i >= 0) snap.capabilities.splice(i, 1, cap);
    else snap.capabilities.push(cap);
  }

  function reset() {
    state.snapshot = null;
    state.sequence = 0;
    state.operations = [];
    state.operationsLoaded = false;
    reloading = false;
    buffered = [];
  }

  function tick() {
    state.now = now();
  }

  // ---------- 选择器 ----------
  const environments = computed<EnvironmentView[]>(() => sortByCode(state.snapshot?.environments ?? []));
  const environmentsById = computed(() => new Map(environments.value.map((e) => [e.id, e])));
  const route = computed<RouteStateView | null>(() => state.snapshot?.route ?? null);
  const activeEnvironment = computed(() => {
    const id = route.value?.activeEnvironmentId;
    return id ? (environmentsById.value.get(id) ?? null) : null;
  });
  const capabilities = computed<CapabilityView[]>(() => state.snapshot?.capabilities ?? []);
  const proposals = computed<CapabilityProposalView[]>(() => state.snapshot?.capabilityProposals ?? []);
  const frontProxies = computed<FrontProxyView[]>(() => state.snapshot?.frontProxies ?? []);
  const settings = computed<SettingsView | null>(() => state.snapshot?.settings ?? null);
  const surge = computed<SurgeStatusView | null>(() => state.snapshot?.surge ?? null);
  const demoMode = computed(() => state.snapshot?.demoMode ?? state.session.info?.demoMode ?? false);
  const pendingDeploy = computed(() => environments.value.filter(hasPendingDeploy));
  const attention = computed(() => environments.value.filter(needsAttention));
  const unbound = computed(() => environments.value.filter((e) => e.binding.state === 'unbound'));
  const stats = computed(() => ({
    total: environments.value.length,
    using: environments.value.filter(isUsing).length,
    pending: pendingDeploy.value.length,
    attention: attention.value.length,
  }));

  function operationById(id: string | null | undefined): OperationView | null {
    if (!id) return null;
    return state.operations.find((o) => o.id === id) ?? state.snapshot?.pendingOperations.find((o) => o.id === id) ?? null;
  }

  return {
    state,
    applyEvent,
    setSnapshot,
    beginReload,
    finishReload,
    setOperations,
    upsertOperation,
    setSettings,
    setSurge,
    setFrontProxy,
    setCapability,
    reset,
    tick,
    environments,
    environmentsById,
    route,
    activeEnvironment,
    capabilities,
    proposals,
    frontProxies,
    settings,
    surge,
    demoMode,
    pendingDeploy,
    attention,
    unbound,
    stats,
    operationById,
  };
}

export type ConsoleStore = ReturnType<typeof createConsoleStore>;
