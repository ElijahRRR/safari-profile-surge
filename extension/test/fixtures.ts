// 合成测试数据：只用文档地址段（RFC 5737）与 example.test 域名。
import { vi } from 'vitest';
import type {
  CurrentStateResponse,
  EnvironmentView,
  NativeResponse,
  OperationView,
  ProbeView,
  ProxyRevisionView,
  RouteStateView,
} from '@sfe/contract';
import type { BrowserAlarm, BrowserTab, MessageSender, RuntimeMessageListener, WebExtBrowser } from '../src/shared/browser';
import type { PageClient, ProfileStateReport } from '../src/shared/messages';

export const NOW = new Date('2026-10-21T08:00:00.000Z');

export function iso(offsetSec: number): string {
  return new Date(NOW.getTime() + offsetSec * 1000).toISOString();
}

export function revision(overrides: Partial<ProxyRevisionView> = {}): ProxyRevisionView {
  return {
    revision: 3,
    protocol: 'socks5',
    host: '203.0.113.10',
    port: 1080,
    hasUsername: true,
    hasPassword: true,
    frontProxyId: 'front_1',
    frontProxyName: 'Front-HK-01',
    nodeName: 'SFE-N-E0001-US01-v003',
    createdAt: iso(-3600),
    ...overrides,
  };
}

export function safariProbe(overrides: Partial<ProbeView> = {}): ProbeView {
  return {
    id: 'probe_1',
    kind: 'safari',
    outcome: 'ok',
    exitIp: '198.51.100.7',
    proxyRevision: 3,
    nodeName: 'SFE-N-E0001-US01-v003',
    routeEpoch: 7,
    configurationGeneration: 4,
    entryMode: 'VERIFY_ONLY',
    testId: 'test_1',
    surgeRequest: null,
    chainEvidence: null,
    browser: null,
    observedAt: iso(-30),
    expiresAt: iso(600),
    message: null,
    ...overrides,
  };
}

export function environment(overrides: Partial<EnvironmentView> = {}): EnvironmentView {
  const rev = revision();
  return {
    id: 'env_1',
    code: 'E0001',
    nodeTag: 'US01',
    displayName: 'US-买家01',
    site: 'US',
    autoOpenOrders: true,
    autoFillLogin: true,
    expectedExitIp: null,
    revision: 5,
    binding: { state: 'bound', stage: null, profileIdShort: '3fa2c1d0', boundAt: iso(-86400), sitePermissionGranted: true },
    proxy: { desired: rev, deployed: rev, active: rev, lastVerified: rev },
    account: {
      label: '买家01',
      loginIdentifierMasked: 'b*****1@example.test',
      hasLoginIdentifier: true,
      hasPassword: true,
      pageIdentity: 'unverified',
      changedSincePageCheck: false,
    },
    facets: { input: 'valid', binding: 'bound', deployment: 'deployed', preflight: 'ok', route: 'active' },
    readiness: 'active',
    nextActions: [{ kind: 'open_orders', message: '环境使用中，可以打开订单页' }],
    probes: { preflight: null, safari: safariProbe() },
    lastOperation: null,
    lastError: null,
    createdAt: iso(-86400),
    updatedAt: iso(-60),
    ...overrides,
  };
}

export function route(overrides: Partial<RouteStateView> = {}): RouteStateView {
  return {
    routeEpoch: 7,
    entryMode: 'ACTIVE',
    entryModeVerifiedAt: iso(-30),
    phase: 'active_verified',
    activeEnvironmentId: 'env_1',
    activeProxyRevision: 3,
    selectedNode: 'SFE-N-E0001-US01-v003',
    oldSessionPolicy: null,
    lastSafariProbe: safariProbe(),
    operationId: 'op_prev',
    awaitingDeadline: null,
    warnings: [],
    normalModeOffered: true,
    lastReconciledAt: iso(-10),
    updatedAt: iso(-10),
    ...overrides,
  };
}

export function currentState(overrides: Partial<CurrentStateResponse> = {}): CurrentStateResponse {
  return {
    profile: { identified: true, profileIdShort: '3fa2c1d0' },
    environment: environment(),
    route: route(),
    routeSummary: { routeEpoch: 7, entryMode: 'ACTIVE', phase: 'active_verified', buyerExitConnectionsUnconfirmed: false, normalModeOffered: true },
    relation: 'this_active',
    otherActiveLabel: null,
    pendingVerification: null,
    bindable: [],
    activationAvailable: true,
    activationBlockedReason: null,
    ordersAllowed: true,
    ordersBlockedReason: null,
    ...overrides,
  };
}

export function operation(overrides: Partial<OperationView> = {}): OperationView {
  return {
    id: 'op_1',
    kind: 'route.activate',
    phase: 'VERIFY_ONLY',
    status: 'waiting',
    error: null,
    updatedAt: iso(-1),
    requestId: 'req_x',
    environmentId: 'env_1',
    initiator: 'bridge',
    expectedRevision: null,
    resultRevision: null,
    routeEpoch: 8,
    probeKind: null,
    supersededBy: null,
    steps: [{ at: iso(-2), phase: 'SAFARI_BLOCKED', message: '入口已阻断' }],
    effective: { desiredProxyRevision: 3, deployedProxyRevision: 3, activeProxyRevision: 3, configurationGeneration: 4, routeEpoch: 8 },
    result: null,
    createdAt: iso(-5),
    ...overrides,
  };
}

export function ok<T>(data: T): NativeResponse<T> {
  return { ok: true, data };
}

export function accepted(operationId = 'op_1') {
  return ok({ operation_id: operationId, environment_id: 'env_1', revision: 5, duplicate: false });
}

export const PROFILE_STATE: ProfileStateReport = { windows_open: 1, amazon_tabs_open: false, site_permission_granted: true };

type Handler = (message: { type: string } & Record<string, unknown>) => NativeResponse<unknown> | Promise<NativeResponse<unknown>>;

/** 页面客户端替身：按类型返回应答，记录每次调用。 */
export function mockClient(handlers: Partial<Record<string, Handler>>, profile: ProfileStateReport = PROFILE_STATE) {
  const calls: Array<{ type: string } & Record<string, unknown>> = [];
  const profileCalls: boolean[] = [];
  const client: PageClient = {
    call: vi.fn(async (message: unknown) => {
      const m = message as { type: string } & Record<string, unknown>;
      calls.push(structuredClone(m));
      const h = handlers[m.type];
      if (!h) return { ok: false, error: { code: 'NOT_FOUND', message: `未处理：${m.type}` } };
      return h(m);
    }) as unknown as PageClient['call'],
    profileState: vi.fn(async (report: boolean) => {
      profileCalls.push(report);
      return ok(profile);
    }),
  };
  return { client, calls, profileCalls };
}

export interface MockBrowser extends WebExtBrowser {
  listeners: Record<string, Array<(...args: unknown[]) => unknown>>;
  /** 浏览器一侧保存的闹钟（后台页卸载后仍在）。 */
  pendingAlarms: Map<string, BrowserAlarm>;
  /** 让闹钟到点：从 pendingAlarms 移除并派发给当前注册的 onAlarm 监听器；没有这个闹钟时返回 false。 */
  fireAlarm(name: string): boolean;
  /** 模拟非持久后台页被卸载：页面里注册的监听器全部失效，浏览器一侧的闹钟保留。 */
  unloadBackground(): void;
}

function event(name: string, listeners: MockBrowser['listeners']) {
  listeners[name] = [];
  return {
    addListener: (fn: (...args: never[]) => unknown) => {
      listeners[name]!.push(fn as (...args: unknown[]) => unknown);
    },
  };
}

export function mockBrowser(opts: { tabs?: BrowserTab[]; permission?: boolean; windows?: number; alarms?: boolean } = {}): MockBrowser {
  const listeners: MockBrowser['listeners'] = {};
  const pendingAlarms = new Map<string, BrowserAlarm>();
  // 闹钟由测试用 fireAlarm 手动到点，替身本身不用计时器（便于断言后台从不用 setTimeout 安排上报）。
  const alarms = opts.alarms === false ? undefined : {
    create: vi.fn((name: string, info: { when?: number; delayInMinutes?: number }) => {
      const scheduledTime = info.when ?? Date.now() + (info.delayInMinutes ?? 0) * 60_000;
      pendingAlarms.set(name, { name, scheduledTime });
    }),
    clear: vi.fn(async (name: string) => pendingAlarms.delete(name)),
    get: vi.fn(async (name: string) => pendingAlarms.get(name)),
    onAlarm: event('alarms.onAlarm', listeners),
  };
  const b = {
    listeners,
    pendingAlarms,
    fireAlarm(name: string): boolean {
      const alarm = pendingAlarms.get(name);
      if (!alarm) return false;
      pendingAlarms.delete(name);
      for (const fn of [...(listeners['alarms.onAlarm'] ?? [])]) fn({ ...alarm });
      return true;
    },
    unloadBackground() {
      for (const fns of Object.values(listeners)) fns.length = 0;
    },
    runtime: {
      id: 'ext-id-1',
      getURL: (p: string) => `safari-web-extension://ext-uuid/${p.replace(/^\//, '')}`,
      sendMessage: vi.fn(async () => undefined),
      sendNativeMessage: vi.fn(async () => ({ ok: true, data: { recorded: true } })),
      onMessage: event('runtime.onMessage', listeners) as unknown as WebExtBrowser['runtime']['onMessage'],
      onStartup: event('runtime.onStartup', listeners),
      onInstalled: event('runtime.onInstalled', listeners),
    },
    tabs: {
      query: vi.fn(async () => opts.tabs ?? []),
      create: vi.fn(async ({ url }: { url: string }) => ({ id: 99, url })),
      update: vi.fn(async (id: number) => ({ id })),
      onCreated: event('tabs.onCreated', listeners),
      onRemoved: event('tabs.onRemoved', listeners),
      onUpdated: event('tabs.onUpdated', listeners),
      onActivated: event('tabs.onActivated', listeners),
    },
    windows: {
      getAll: vi.fn(async () => Array.from({ length: opts.windows ?? 1 }, () => ({}))),
      update: vi.fn(async () => ({})),
      onCreated: event('windows.onCreated', listeners),
      onRemoved: event('windows.onRemoved', listeners),
      onFocusChanged: event('windows.onFocusChanged', listeners),
    },
    permissions: { contains: vi.fn(async () => opts.permission ?? true) },
    ...(alarms ? { alarms } : {}),
  };
  return b as unknown as MockBrowser;
}

export const PAGE_SENDER: MessageSender = { id: 'ext-id-1', url: 'safari-web-extension://ext-uuid/popup.html' };

export function contentSender(url = 'https://www.amazon.com/ap/signin?openid.return_to=x', frameId = 0): MessageSender {
  return { id: 'ext-id-1', url, frameId, tab: { id: 4, url, windowId: 1 } };
}

export function onMessageListener(b: MockBrowser): RuntimeMessageListener {
  const l = b.listeners['runtime.onMessage']?.[0];
  if (!l) throw new Error('no onMessage listener');
  return l as unknown as RuntimeMessageListener;
}

/** 让挂起的 Promise 链跑完（不推进计时器）。 */
export async function flush(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}
