// 测试用 AppService：记录每次调用（方法名、参数、actor），可按方法配置返回值或抛出的 SfeError；
// events 是真实的内存环形缓冲事件总线（与契约 EVENT_BUFFER_SIZE 一致）。只用合成数据。

import { EVENT_BUFFER_SIZE, SfeError, type Accepted, type ServiceEventPayload } from '@sfe/contract';
import type { AppService } from '../../src/app.js';
import type { EventBus } from '../../src/ports.js';

export type AppMethod = Exclude<keyof AppService, 'events'>;

export const APP_METHODS: readonly AppMethod[] = [
  'snapshot',
  'listEnvironments',
  'getEnvironment',
  'createEnvironment',
  'updateEnvironment',
  'deleteEnvironment',
  'accountDetail',
  'acknowledgeAccount',
  'unbind',
  'activate',
  'enterNormal',
  'probe',
  'publishPending',
  'getOperation',
  'cancelOperation',
  'acknowledgeWindows',
  'listOperations',
  'importPreview',
  'importCommit',
  'importTemplateCsv',
  'listCapabilities',
  'proposeCapability',
  'confirmCapability',
  'getSettings',
  'updateSettings',
  'listFrontProxies',
  'registerFrontProxy',
  'updateFrontProxy',
  'verifyFrontProxy',
  'replaceFrontPreview',
  'replaceFrontCommit',
  'surgePolicies',
  'refreshSurge',
  'initPreview',
  'initCommit',
  'remergePreview',
  'remergeCommit',
  'issueLoginCode',
  'handleNative',
  'start',
  'stop',
];

export interface RecordedCall {
  method: AppMethod;
  args: unknown[];
}

export type MemoryEventBus = EventBus & { readonly size: number };

export function createMemoryEventBus(capacity = EVENT_BUFFER_SIZE): MemoryEventBus {
  let seq = 0;
  const buffer: Array<ServiceEventPayload & { sequence: number }> = [];
  const listeners = new Set<(e: ServiceEventPayload & { sequence: number }) => void>();
  return {
    publish(event) {
      seq += 1;
      const stored = { ...event, sequence: seq } as ServiceEventPayload & { sequence: number };
      buffer.push(stored);
      if (buffer.length > capacity) buffer.shift();
      for (const l of [...listeners]) l(stored);
      return seq;
    },
    since(sinceSequence) {
      if (sinceSequence >= seq) return [];
      const oldest = buffer[0]?.sequence ?? seq + 1;
      // 需要的第一条（sinceSequence + 1）已被挤出缓冲
      if (sinceSequence + 1 < oldest) return null;
      return buffer.filter((e) => e.sequence > sinceSequence);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    currentSequence() {
      return seq;
    },
    get size() {
      return buffer.length;
    },
  };
}

export function stubAccepted(overrides: Partial<Accepted> = {}): Accepted {
  return { operation_id: 'op_stub0001', environment_id: null, revision: null, duplicate: false, ...overrides };
}

type Handler = (...args: any[]) => unknown;

const DEFAULTS: Partial<Record<AppMethod, Handler>> = {
  snapshot: () => ({ sequence: 0, serviceVersion: '0.0.0-test', demoMode: false, environments: [] }),
  listEnvironments: () => [],
  listOperations: () => [],
  listCapabilities: () => [],
  listFrontProxies: () => [],
  surgePolicies: () => ({ proxies: [], groups: [] }),
  importTemplateCsv: () => 'display_name,proxy_host,proxy_port\nUS-Buyer-01,203.0.113.10,1080\n',
  issueLoginCode: () => ({ url: 'http://127.0.0.1:61847/auth/exchange?code=stub', expiresAt: '2026-10-21T00:01:00.000Z' }),
  handleNative: () => ({ ok: true, data: { stub: true } }),
  proposeCapability: () => ({ proposal_id: 'prop_stub0001' }),
  start: () => undefined,
  stop: () => undefined,
};

const ACCEPTED_METHODS = new Set<AppMethod>([
  'createEnvironment',
  'updateEnvironment',
  'deleteEnvironment',
  'acknowledgeAccount',
  'unbind',
  'activate',
  'enterNormal',
  'probe',
  'publishPending',
  'cancelOperation',
  'acknowledgeWindows',
  'verifyFrontProxy',
  'replaceFrontCommit',
  'initCommit',
  'remergeCommit',
]);

export type StubApp = AppService & {
  readonly events: MemoryEventBus;
  readonly calls: RecordedCall[];
  /** 设置某方法的返回值（或按参数计算的函数）。 */
  respond(method: AppMethod, value: unknown): void;
  /** 让某方法抛出给定错误（通常是 SfeError）。 */
  throwOn(method: AppMethod, error: unknown): void;
  callsTo(method: AppMethod): RecordedCall[];
  reset(): void;
};

export function createStubApp(overrides: Partial<Record<AppMethod, Handler>> = {}): StubApp {
  const events = createMemoryEventBus();
  const calls: RecordedCall[] = [];
  const handlers = new Map<AppMethod, Handler>(Object.entries(overrides) as Array<[AppMethod, Handler]>);

  const invoke = (method: AppMethod, args: unknown[]): unknown => {
    calls.push({ method, args });
    const h = handlers.get(method) ?? DEFAULTS[method];
    if (h) return h(...args);
    if (ACCEPTED_METHODS.has(method)) {
      const envId = typeof args[0] === 'string' ? args[0] : null;
      return stubAccepted({ environment_id: envId });
    }
    return { stub: method };
  };

  const app: Record<string, unknown> = {
    events,
    calls,
    respond(method: AppMethod, value: unknown) {
      handlers.set(method, typeof value === 'function' ? (value as Handler) : () => value);
    },
    throwOn(method: AppMethod, error: unknown) {
      handlers.set(method, () => {
        throw error;
      });
    },
    callsTo(method: AppMethod) {
      return calls.filter((c) => c.method === method);
    },
    reset() {
      calls.length = 0;
      handlers.clear();
      for (const [k, v] of Object.entries(overrides)) handlers.set(k as AppMethod, v as Handler);
    },
  };
  for (const method of APP_METHODS) {
    if (method === 'importTemplateCsv') {
      app[method] = (...args: unknown[]) => invoke(method, args);
    } else {
      app[method] = async (...args: unknown[]) => invoke(method, args);
    }
  }
  return app as unknown as StubApp;
}

export function sfeError(code: ConstructorParameters<typeof SfeError>[0], message = '操作失败：测试错误', details?: Record<string, unknown>): SfeError {
  return new SfeError(code, message, details ? { details } : undefined);
}
