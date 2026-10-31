// 合成测试数据：只用文档地址段（203.0.113.0/24、198.51.100.0/24、192.0.2.0/24、2001:db8::/32）与 example.test。

import { CAPABILITY_KEYS, CAPABILITY_LABELS, DEFAULT_VERIFY_ENDPOINT_ID } from '@sfe/contract';
import type {
  CapabilityKey,
  CapabilityStatus,
  CapabilityView,
  EnvironmentView,
  NodeResourceStatusView,
  OperationView,
  ProxyRevisionView,
  RouteStateView,
  ServiceEvent,
  Snapshot,
} from '@sfe/contract';
import { createApp, defineComponent, h, type Component } from 'vue';
import { createMemoryHistory } from 'vue-router';
import { createMemoryTokenStore } from '../src/api/session-token';
import { CONSOLE_KEY, createConsoleContext, type ConsoleContext } from '../src/store/context';
import { createConsoleRouter } from '../src/router';

export const T0 = '2026-10-21T08:00:00.000Z';
export const TOKEN = 'test-session-token-0123456789abcdef';

export function revision(n: number, over: Partial<ProxyRevisionView> = {}): ProxyRevisionView {
  return {
    revision: n,
    protocol: 'socks5',
    host: '203.0.113.10',
    port: 1080,
    hasUsername: true,
    hasPassword: true,
    frontProxyId: 'front_1',
    frontProxyName: 'HK-Front',
    nodeName: `SFE-N-E0001-US01-v${String(n).padStart(3, '0')}`,
    createdAt: T0,
    ...over,
  };
}

export function environment(over: Partial<EnvironmentView> = {}): EnvironmentView {
  const rev = revision(1);
  return {
    id: 'env_1',
    code: 'E0001',
    nodeTag: 'US01',
    displayName: 'US-买家01',
    site: 'US',
    autoOpenOrders: true,
    autoFillLogin: false,
    expectedExitIp: null,
    revision: 3,
    binding: { state: 'bound', stage: null, profileIdShort: 'a1b2c3d4', boundAt: T0, sitePermissionGranted: true },
    proxy: { desired: rev, deployed: rev, active: null, lastVerified: null },
    account: {
      label: 'buyer01',
      loginIdentifierMasked: 'b*****1@example.test',
      hasLoginIdentifier: true,
      hasPassword: true,
      pageIdentity: 'unverified',
      changedSincePageCheck: false,
    },
    facets: { input: 'valid', binding: 'bound', deployment: 'deployed', preflight: 'none', route: 'inactive' },
    readiness: 'deployed_unverified',
    nextActions: [{ kind: 'activate', message: '已部署，未独立预检，将由 Safari 实测验证' }],
    probes: { preflight: null, safari: null },
    lastOperation: null,
    lastError: null,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

export function route(over: Partial<RouteStateView> = {}): RouteStateView {
  return {
    routeEpoch: 1,
    entryMode: 'NORMAL',
    entryModeVerifiedAt: T0,
    phase: 'idle',
    activeEnvironmentId: null,
    activeProxyRevision: null,
    selectedNode: 'REJECT',
    oldSessionPolicy: null,
    lastSafariProbe: null,
    operationId: null,
    awaitingDeadline: null,
    warnings: [],
    normalModeOffered: false,
    lastReconciledAt: T0,
    updatedAt: T0,
    ...over,
  };
}

export function capabilities(status: Partial<Record<CapabilityKey, CapabilityStatus>> = {}): CapabilityView[] {
  return CAPABILITY_KEYS.map((key) => ({
    key,
    label: CAPABILITY_LABELS[key],
    status: status[key] ?? 'unverified',
    effectiveStatus: status[key] ?? 'unverified',
    staleReasons: [],
    context: null,
    protocolCoverage: null,
    verifiedAt: null,
    proposalId: null,
    note: null,
  }));
}

export function allSupported(): Partial<Record<CapabilityKey, CapabilityStatus>> {
  return Object.fromEntries(CAPABILITY_KEYS.map((k) => [k, 'supported']));
}

export function operation(over: Partial<OperationView> = {}): OperationView {
  return {
    id: 'op_1',
    kind: 'route.activate',
    phase: 'VERIFY_ONLY',
    status: 'waiting',
    error: null,
    updatedAt: T0,
    requestId: 'web-req-1',
    environmentId: 'env_1',
    initiator: 'web',
    expectedRevision: null,
    resultRevision: null,
    routeEpoch: 2,
    probeKind: null,
    supersededBy: null,
    waitDeadline: null,
    steps: [{ at: T0, phase: 'SAFARI_BLOCKED', message: '入口已阻断' }],
    effective: { desiredProxyRevision: 1, deployedProxyRevision: 1, activeProxyRevision: null, configurationGeneration: 4, routeEpoch: 2 },
    result: null,
    createdAt: T0,
    ...over,
  };
}

export function snapshot(over: Partial<Snapshot> = {}): Snapshot {
  return {
    sequence: 10,
    serviceVersion: '0.1.0',
    demoMode: false,
    environments: [environment()],
    route: route(),
    capabilities: capabilities(),
    capabilityProposals: [],
    surge: {
      reachable: true,
      version: '6.5.0',
      build: '3000',
      currentProfileName: '日常-Safari环境',
      onWorkingProfile: true,
      managedSectionsIntact: true,
      configurationGeneration: 4,
      takeover: { enhancedMode: true, systemProxy: false, outboundMode: 'rule', checkedAt: T0 },
      autoReload: false,
      httpApi: { configured: false, loopbackOnly: null },
      profileDirectoryRisk: 'none',
      precedenceIssues: [],
      lastCheckedAt: T0,
      message: null,
    },
    frontProxies: [
      { id: 'front_1', surgeName: 'HK-Front', kind: 'node', state: 'ok', isDefault: true, retired: false, dependentEnvironmentIds: ['env_1'], lastCheckedAt: T0 },
      { id: 'front_2', surgeName: 'JP-Front', kind: 'node', state: 'unverified', isDefault: false, retired: false, dependentEnvironmentIds: [], lastCheckedAt: null },
    ],
    settings: {
      surgeCliPath: '/Applications/Surge.app/Contents/Applications/surge-cli',
      workingProfilePath: '/Users/test/Library/Application Support/Surge/Profiles/日常-Safari环境.conf',
      entryStrategy: 'temp_rule',
      safariProcessPaths: ['/System/Volumes/Preboot/Cryptexes/App/System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.Networking.xpc/Contents/MacOS/com.apple.WebKit.Networking'],
      verifyEndpointId: DEFAULT_VERIFY_ENDPOINT_ID,
      defaultFrontProxyId: 'front_1',
      profileArrivalTimeoutSec: 120,
      safariVerifyTimeoutSec: 60,
      probeTtlSec: 900,
      reconcileIntervalSec: 30,
    },
    pendingOperations: [],
    ...over,
  };
}

/** 本机资源服务（D10）的状态：默认正在提供，没有标志。只有状态码，从不带地址、端口或令牌。 */
export function nodeResource(over: Partial<NodeResourceStatusView> = {}): NodeResourceStatusView {
  return { state: 'serving', tokenSuspect: false, needsRefresh: false, ...over };
}

/** 带本机资源服务状态的快照（null：尚未初始化固定工作配置）。 */
export function snapshotWithNodeResource(nr: NodeResourceStatusView | null, over: Partial<Snapshot> = {}): Snapshot {
  const base = snapshot(over);
  return { ...base, surge: { ...base.surge, nodeResource: nr } };
}

export function event<E extends ServiceEvent>(e: E): E {
  return e;
}

// ---------- 假的 fetch ----------

export interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export type Responder = (call: Call) => { status: number; body?: unknown; text?: string } | Promise<{ status: number; body?: unknown; text?: string }>;

export function jsonResponse(status: number, body?: unknown, text?: string): Response {
  const payload = text ?? (body === undefined ? '' : JSON.stringify(body));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers({ 'content-type': 'application/json' }),
    text: async () => payload,
    json: async () => JSON.parse(payload),
    body: null,
  } as unknown as Response;
}

export function fakeFetch(responder: Responder) {
  const calls: Call[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    const h = init?.headers;
    if (h && typeof h === 'object' && !(h instanceof Headers) && !Array.isArray(h)) Object.assign(headers, h);
    const call: Call = { url: String(input), method: init?.method ?? 'GET', headers, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined };
    calls.push(call);
    if (call.url.startsWith('/api/events')) return new Promise<Response>(() => {});
    const r = await responder(call);
    return jsonResponse(r.status, r.body, r.text);
  }) as typeof fetch;
  return { fetch: fn, calls };
}

export const manualTimers = () => {
  const queue: Array<{ fn: () => void; ms: number; id: number }> = [];
  let next = 1;
  return {
    queue,
    setTimeout: (fn: () => void, ms: number) => {
      const id = next++;
      queue.push({ fn, ms, id });
      return id;
    },
    clearTimeout: (h: unknown) => {
      const i = queue.findIndex((q) => q.id === h);
      if (i >= 0) queue.splice(i, 1);
    },
    runNext() {
      const t = queue.shift();
      t?.fn();
      return t;
    },
  };
};

/** 建一个带假 fetch 的运行时，并直接放入快照（不发起 bootstrap）。 */
export function testContext(responder: Responder, snap: Snapshot | null = snapshot()) {
  const { fetch, calls } = fakeFetch(responder);
  const ctx = createConsoleContext({ tokens: createMemoryTokenStore(TOKEN), fetch, timers: manualTimers(), now: () => Date.parse(T0) + 60_000 });
  if (snap) {
    ctx.store.setSnapshot(snap);
    ctx.store.state.session.status = 'authenticated';
  }
  return { ctx, calls };
}

/** 挂载需要运行时与路由的组件。 */
export async function mountWith(component: Component, ctx: ConsoleContext, props: Record<string, unknown> = {}, path = '/') {
  const router = createConsoleRouter(createMemoryHistory());
  await router.push(path);
  await router.isReady();
  const host = document.createElement('div');
  document.body.appendChild(host);
  const app = createApp(defineComponent({ render: () => h(component, props) }));
  app.provide(CONSOLE_KEY, ctx);
  app.use(router);
  app.mount(host);
  return {
    app,
    router,
    host,
    unmount() {
      app.unmount();
      host.remove();
    },
  };
}

export async function flush(times = 5) {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

export function click(el: Element | null | undefined) {
  if (!el) throw new Error('element not found');
  (el as HTMLElement).click();
}

export function byText(selector: string, text: string, root: ParentNode = document.body): HTMLElement | null {
  return (Array.from(root.querySelectorAll<HTMLElement>(selector)).find((el) => el.textContent?.trim().includes(text)) ?? null);
}
