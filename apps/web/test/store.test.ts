import { describe, expect, it } from 'vitest';
import type { ServiceEvent } from '@sfe/contract';
import { createConsoleStore } from '../src/store/console';
import { createToastQueue } from '../src/store/toasts';
import { environment, manualTimers, operation, route, snapshot } from './fixtures';

function storeWith(seq = 10) {
  const store = createConsoleStore(() => 0);
  store.setSnapshot(snapshot({ sequence: seq }));
  return store;
}

const routeUpdated = (sequence: number, activeEnvironmentId: string | null): ServiceEvent => ({
  type: 'route.updated',
  sequence,
  route: route({ activeEnvironmentId, routeEpoch: sequence }),
});

describe('console store', () => {
  it('applies events in sequence order', () => {
    const store = storeWith(10);
    expect(store.applyEvent(routeUpdated(11, 'env_1'))).toBe(true);
    expect(store.applyEvent(routeUpdated(12, null))).toBe(true);
    expect(store.state.sequence).toBe(12);
    expect(store.route.value?.activeEnvironmentId).toBeNull();
  });

  it('ignores events at or below the applied sequence', () => {
    const store = storeWith(10);
    expect(store.applyEvent(routeUpdated(10, 'env_1'))).toBe(false);
    expect(store.applyEvent(routeUpdated(9, 'env_1'))).toBe(false);
    store.applyEvent(routeUpdated(15, 'env_1'));
    expect(store.applyEvent(routeUpdated(14, null))).toBe(false);
    expect(store.route.value?.activeEnvironmentId).toBe('env_1');
  });

  it('ignores events before any snapshot is loaded', () => {
    const store = createConsoleStore();
    expect(store.applyEvent(routeUpdated(1, 'env_1'))).toBe(false);
  });

  it('upserts and deletes environments', () => {
    const store = storeWith();
    store.applyEvent({ type: 'environment.updated', sequence: 11, environment: environment({ id: 'env_2', code: 'E0002', displayName: 'US-买家02' }) });
    store.applyEvent({ type: 'environment.updated', sequence: 12, environment: environment({ displayName: 'US-改名' }) });
    expect(store.environments.value.map((e) => e.displayName)).toEqual(['US-改名', 'US-买家02']);
    store.applyEvent({ type: 'environment.deleted', sequence: 13, environmentId: 'env_1' });
    expect(store.environments.value.map((e) => e.id)).toEqual(['env_2']);
  });

  it('replaces surge, settings, front proxies and capabilities from events', () => {
    const store = storeWith();
    const snap = snapshot();
    store.applyEvent({ type: 'surge.status', sequence: 11, surge: { ...snap.surge, reachable: false } });
    store.applyEvent({ type: 'settings.updated', sequence: 12, settings: { ...snap.settings, probeTtlSec: 60 } });
    store.applyEvent({ type: 'frontProxies.updated', sequence: 13, frontProxies: [] });
    store.applyEvent({ type: 'capabilities.updated', sequence: 14, capabilities: [], proposals: [] });
    expect(store.surge.value?.reachable).toBe(false);
    expect(store.settings.value?.probeTtlSec).toBe(60);
    expect(store.frontProxies.value).toEqual([]);
    expect(store.capabilities.value).toEqual([]);
  });

  it('tracks operations and keeps pendingOperations to active ones', () => {
    const store = storeWith();
    store.applyEvent({ type: 'operation.updated', sequence: 11, operation: operation({ status: 'waiting' }) });
    expect(store.state.snapshot?.pendingOperations.map((o) => o.id)).toEqual(['op_1']);
    expect(store.operationById('op_1')?.phase).toBe('VERIFY_ONLY');
    store.applyEvent({ type: 'operation.updated', sequence: 12, operation: operation({ status: 'succeeded', phase: 'ACTIVE_VERIFIED' }) });
    expect(store.state.snapshot?.pendingOperations).toEqual([]);
    expect(store.operationById('op_1')?.phase).toBe('ACTIVE_VERIFIED');
    expect(store.state.operations).toHaveLength(1);
  });

  it('keeps the newer copy when the list endpoint returns an older operation', () => {
    const store = storeWith();
    store.applyEvent({ type: 'operation.updated', sequence: 11, operation: operation({ phase: 'ACTIVE_VERIFIED', updatedAt: '2026-10-21T09:00:00.000Z' }) });
    store.setOperations([operation({ phase: 'VERIFY_ONLY', updatedAt: '2026-10-21T08:30:00.000Z' })]);
    expect(store.operationById('op_1')?.phase).toBe('ACTIVE_VERIFIED');
  });

  it('a new snapshot is authoritative, even with a smaller sequence (service restart)', () => {
    const store = storeWith(50);
    store.setSnapshot(snapshot({ sequence: 3 }));
    expect(store.state.sequence).toBe(3);
    expect(store.applyEvent(routeUpdated(4, 'env_1'))).toBe(true);
  });

  it('buffers events during a snapshot reload and replays only newer ones', () => {
    const store = storeWith(10);
    store.beginReload();
    expect(store.applyEvent(routeUpdated(19, 'env_x'))).toBe(false);
    expect(store.applyEvent(routeUpdated(21, 'env_1'))).toBe(false);
    store.finishReload(snapshot({ sequence: 20 }));
    expect(store.state.sequence).toBe(21);
    expect(store.route.value?.activeEnvironmentId).toBe('env_1');
  });

  it('computes stats from readiness', () => {
    const store = createConsoleStore();
    store.setSnapshot(
      snapshot({
        environments: [
          environment({ id: 'a', code: 'E0001', readiness: 'active' }),
          environment({ id: 'b', code: 'E0002', readiness: 'sync_failed' }),
          environment({ id: 'c', code: 'E0003', readiness: 'waiting_deployment', proxy: { desired: null, deployed: null, active: null, lastVerified: null }, facets: { input: 'valid', binding: 'bound', deployment: 'pending', preflight: 'none', route: 'inactive' } }),
        ],
      }),
    );
    expect(store.stats.value).toEqual({ total: 3, using: 1, pending: 1, attention: 1 });
  });
});

describe('toast queue', () => {
  it('auto-dismisses after the duration and caps visible toasts', () => {
    const timers = manualTimers();
    const toasts = createToastQueue(timers);
    const id = toasts.success('设置已保存');
    expect(toasts.items).toHaveLength(1);
    expect(timers.queue[0]?.ms).toBe(4000);
    timers.runNext();
    expect(toasts.items.find((t) => t.id === id)).toBeUndefined();
    for (let i = 0; i < 8; i++) toasts.info(`第 ${i} 条`);
    expect(toasts.items).toHaveLength(5);
  });

  it('error toasts stay longer and can be dismissed manually', () => {
    const timers = manualTimers();
    const toasts = createToastQueue(timers);
    const id = toasts.error('保存失败：版本冲突');
    expect(timers.queue[0]?.ms).toBe(8000);
    toasts.dismiss(id);
    expect(toasts.items).toHaveLength(0);
    expect(timers.queue).toHaveLength(0);
  });
});
