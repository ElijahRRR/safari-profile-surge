import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import type { BeginVerificationResponse, OperationView } from '@sfe/contract';
import App from '../src/prepare/App.vue';
import { createPrepareController, extractIp, isAllowedVerifyUrl, type PrepareDeps } from '../src/prepare/controller';
import { readPrepareParams } from '../src/shared/pages';
import { NOW, currentState, environment, iso, mockBrowser, mockClient, ok, operation } from './fixtures';

const READY: BeginVerificationResponse = {
  status: 'ready',
  test_id: 'test_abc',
  route_epoch: 8,
  verify_url: 'https://api.ipify.org/?format=json&sfe_test=test_abc',
  deadline: iso(60),
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

interface Scenario {
  begin?: BeginVerificationResponse[];
  operations?: OperationView[];
  state?: ReturnType<typeof currentState>;
  fetchImpl?: PrepareDeps['fetchImpl'];
  tabs?: Array<{ id: number; url: string; windowId?: number }>;
  intent?: 'orders' | null;
}

function scenario(s: Scenario = {}) {
  const begins = [...(s.begin ?? [READY])];
  const ops = [...(s.operations ?? [operation({ phase: 'ACTIVE_VERIFIED', status: 'succeeded' })])];
  const events: string[] = [];
  const mc = mockClient({
    beginSafariVerification: () => {
      events.push('begin');
      return ok(begins.length > 1 ? begins.shift()! : begins[0]!);
    },
    submitSafariVerification: () => {
      events.push('submit');
      return ok({ accepted: true });
    },
    getOperation: () => {
      events.push('getOperation');
      return ok(ops.length > 1 ? ops.shift()! : ops[0]!);
    },
    getCurrentState: () => {
      events.push('getCurrentState');
      return ok(s.state ?? currentState());
    },
  });
  const browser = mockBrowser({ tabs: s.tabs ?? [] });
  const navigate = vi.fn((url: string) => events.push(`navigate:${url}`));
  const fetchImpl = vi.fn(
    s.fetchImpl ??
      (async () => {
        events.push('fetch');
        return jsonResponse({ ip: '198.51.100.7' });
      }),
  );
  const controller = createPrepareController('op_1', s.intent ?? null, {
    browser,
    client: mc.client,
    fetchImpl,
    navigate,
    pollMs: 1000,
    now: () => NOW,
    sleep: () => Promise.resolve(),
  });
  return { controller, events, navigate, fetchImpl, browser, ...mc };
}

describe('prepare page flow', () => {
  it('pending → ready → fetch → submit → wait → ACTIVE_VERIFIED → orders', async () => {
    const s = scenario({
      begin: [{ status: 'pending', phase: 'SAFARI_BLOCKED', message: '正在结束 Safari 旧连接' }, READY],
      operations: [operation({ phase: 'VERIFY_ONLY', status: 'waiting' }), operation({ phase: 'ACTIVE_VERIFIED', status: 'succeeded' })],
    });
    await s.controller.start();
    expect(s.events).toEqual([
      'begin',
      'begin',
      'fetch',
      'submit',
      'getOperation',
      'getOperation',
      'getCurrentState',
      'navigate:https://www.amazon.com/gp/css/order-history',
    ]);
    expect(s.controller.state.stage).toBe('succeeded');
    expect(s.controller.state.ordersResult).toBe('navigated');
  });

  it('declares arrival with amazon_tabs_open from the profile state', async () => {
    const s = scenario();
    await s.controller.start();
    expect(s.calls.find((m) => m.type === 'beginSafariVerification')).toEqual({
      type: 'beginSafariVerification',
      operation_id: 'op_1',
      amazon_tabs_open: false,
    });
    expect(s.profileCalls).toEqual([false]);
  });

  it('fetches the verify url without cache or credentials and submits the result with timings', async () => {
    const s = scenario();
    await s.controller.start();
    const [url, init] = s.fetchImpl.mock.calls[0]!;
    expect(url).toBe(READY.verify_url);
    expect(init).toMatchObject({ method: 'GET', cache: 'no-store', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' });
    expect(s.calls.find((m) => m.type === 'submitSafariVerification')).toEqual({
      type: 'submitSafariVerification',
      operation_id: 'op_1',
      test_id: 'test_abc',
      route_epoch: 8,
      observed_ip: '198.51.100.7',
      http_status: 200,
      error: null,
      started_at: NOW.toISOString(),
      finished_at: NOW.toISOString(),
    });
  });

  it('never navigates before the operation succeeds', async () => {
    let releaseFetch!: () => void;
    const fetchGate = new Promise<void>((r) => (releaseFetch = r));
    const s = scenario({
      fetchImpl: async () => {
        await fetchGate;
        return jsonResponse({ ip: '198.51.100.7' });
      },
    });
    const p = s.controller.start();
    await flushPromises();
    expect(s.controller.state.stage).toBe('verifying');
    expect(s.navigate).not.toHaveBeenCalled();
    expect(s.browser.tabs!.create).not.toHaveBeenCalled();
    releaseFetch();
    await p;
    expect(s.navigate).toHaveBeenCalledTimes(1);
  });

  it('does not open orders when autoOpenOrders is off, but offers a button', async () => {
    const s = scenario({ state: currentState({ environment: environment({ autoOpenOrders: false }) }) });
    await s.controller.start();
    expect(s.navigate).not.toHaveBeenCalled();
    expect(s.controller.state.ordersOfferable).toBe(true);
    await s.controller.openOrders();
    expect(s.navigate).toHaveBeenCalledWith('https://www.amazon.com/gp/css/order-history');
  });

  it('opens orders for an orders intent even when autoOpenOrders is off', async () => {
    const s = scenario({ state: currentState({ environment: environment({ autoOpenOrders: false }) }), intent: 'orders' });
    await s.controller.start();
    expect(s.navigate).toHaveBeenCalledTimes(1);
  });

  it('does not open orders when the service says orders are not allowed', async () => {
    const s = scenario({ state: currentState({ ordersAllowed: false, ordersBlockedReason: '实测出口与预期出口不一致' }) });
    await s.controller.start();
    expect(s.navigate).not.toHaveBeenCalled();
    expect(s.controller.state.ordersBlockedReason).toBe('实测出口与预期出口不一致');
  });

  it('focuses an existing orders tab instead of navigating', async () => {
    const s = scenario({ tabs: [{ id: 5, windowId: 2, url: 'https://www.amazon.com/your-orders/orders' }] });
    await s.controller.start();
    expect(s.navigate).not.toHaveBeenCalled();
    expect(s.browser.tabs!.update).toHaveBeenCalledWith(5, { active: true });
    expect(s.controller.state.ordersResult).toBe('focused');
  });

  it('shows failure and the rollback result without navigating', async () => {
    const failed = operation({
      phase: 'FAILED',
      status: 'failed',
      error: { code: 'SAFARI_VERIFY_FAILED', message: 'Safari 实测失败：Surge 中没有找到对应的检测请求' },
      result: {
        rollback: {
          previousEnvironmentId: 'env_9',
          previousProxyRevision: 2,
          previousProbe: null,
          restoredSelection: 'SFE-N-E0009-US09-v002',
          entryModeAfter: 'BLOCKED',
          failedProxyRevision: 3,
          failureError: { code: 'SAFARI_VERIFY_FAILED', message: 'x' },
          needsReverify: true,
        },
      },
    });
    const s = scenario({ operations: [failed] });
    await s.controller.start();
    expect(s.controller.state.stage).toBe('failed');
    expect(s.navigate).not.toHaveBeenCalled();
    expect(s.browser.tabs!.create).not.toHaveBeenCalled();
    expect(s.events).not.toContain('getCurrentState');

    const wrapper = mount(App, { props: { controller: s.controller } });
    expect(wrapper.find('[data-test="failure"]').text()).toContain('Surge 中没有找到对应的检测请求');
    expect(wrapper.find('[data-test="rollback"]').text()).toContain('已恢复原节点 SFE-N-E0009-US09-v002');
    expect(wrapper.find('[data-test="rollback"]').text()).toContain('Safari 保持阻断');
    wrapper.unmount();
  });

  it('treats a superseded or attention operation as failure', async () => {
    for (const op of [operation({ phase: 'SUPERSEDED', status: 'superseded' }), operation({ phase: 'BLOCKED_NEEDS_ATTENTION', status: 'needs_attention' })]) {
      const s = scenario({ operations: [op] });
      await s.controller.start();
      expect(s.controller.state.stage).toBe('failed');
      expect(s.navigate).not.toHaveBeenCalled();
    }
  });

  it('a parked result (ready for next open) is neither success nor failure', async () => {
    const s = scenario({ begin: [{ status: 'not_needed', message: '新版本已部署，下次打开时生效' }], operations: [operation({ phase: 'READY_FOR_NEXT_OPEN', status: 'parked' })] });
    await s.controller.start();
    expect(s.controller.state.stage).toBe('parked');
    expect(s.fetchImpl).not.toHaveBeenCalled();
    expect(s.navigate).not.toHaveBeenCalled();
  });

  it('not_needed skips the fetch and still waits for the operation', async () => {
    const s = scenario({ begin: [{ status: 'not_needed', message: '当前环境已在使用' }] });
    await s.controller.start();
    expect(s.fetchImpl).not.toHaveBeenCalled();
    expect(s.events.filter((e) => e === 'submit')).toHaveLength(0);
    expect(s.controller.state.stage).toBe('succeeded');
  });

  it('refuses to fetch a verify url outside the fixed endpoints and reports the error', async () => {
    const s = scenario({ begin: [{ ...READY, verify_url: 'https://www.amazon.com/?sfe_test=x' }], operations: [operation({ phase: 'FAILED', status: 'failed' })] });
    await s.controller.start();
    expect(s.fetchImpl).not.toHaveBeenCalled();
    expect(s.calls.find((m) => m.type === 'submitSafariVerification')).toMatchObject({ observed_ip: null, error: 'verify_url_not_allowed', http_status: null });
  });

  it('reports http errors and invalid bodies', async () => {
    const http = scenario({ fetchImpl: async () => jsonResponse({}, 503), operations: [operation({ phase: 'FAILED', status: 'failed' })] });
    await http.controller.start();
    expect(http.calls.find((m) => m.type === 'submitSafariVerification')).toMatchObject({ http_status: 503, error: 'http_503', observed_ip: null });
    const bad = scenario({ fetchImpl: async () => jsonResponse({ ip: '<script>' }), operations: [operation({ phase: 'FAILED', status: 'failed' })] });
    await bad.controller.start();
    expect(bad.calls.find((m) => m.type === 'submitSafariVerification')).toMatchObject({ http_status: 200, error: 'invalid_response', observed_ip: null });
  });

  it('reports a network error (e.g. rejected by Surge)', async () => {
    const s = scenario({ fetchImpl: async () => Promise.reject(new TypeError('Load failed')), operations: [operation({ phase: 'FAILED', status: 'failed' })] });
    await s.controller.start();
    expect(s.calls.find((m) => m.type === 'submitSafariVerification')).toMatchObject({ error: 'network_error', observed_ip: null });
  });

  it('when begin fails, reads the operation once to show its final state', async () => {
    const mc = mockClient({
      beginSafariVerification: () => ({ ok: false, error: { code: 'SAFARI_VERIFY_TIMEOUT', message: '等待场景到达超时' } }),
      getOperation: () => ok(operation({ phase: 'FAILED', status: 'failed', error: { code: 'SAFARI_VERIFY_TIMEOUT', message: '等待场景到达超时，已回滚' } })),
    });
    const navigate = vi.fn();
    const c = createPrepareController('op_1', null, { browser: mockBrowser(), client: mc.client, fetchImpl: vi.fn(), navigate, sleep: async () => undefined });
    await c.start();
    expect(c.state.stage).toBe('failed');
    expect(c.state.error).toBe('等待场景到达超时，已回滚');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('shows an error stage when begin fails and the operation is not terminal', async () => {
    const mc = mockClient({
      beginSafariVerification: () => ({ ok: false, error: { code: 'BINDING_MISMATCH', message: '检测失败：当前场景不是该环境绑定的场景' } }),
      getOperation: () => ok(operation({ status: 'waiting' })),
    });
    const c = createPrepareController('op_1', null, { browser: mockBrowser(), client: mc.client, fetchImpl: vi.fn(), navigate: vi.fn(), sleep: async () => undefined });
    await c.start();
    expect(c.state.stage).toBe('error');
    expect(c.state.error).toBe('检测失败：当前场景不是该环境绑定的场景');
  });

  it('does nothing without an operation id', async () => {
    const mc = mockClient({});
    const c = createPrepareController(null, null, { browser: mockBrowser(), client: mc.client, fetchImpl: vi.fn(), navigate: vi.fn() });
    await c.start();
    expect(c.state.stage).toBe('invalid');
    expect(mc.calls).toHaveLength(0);
  });
});

describe('prepare polling with timers', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('re-declares arrival about every second while pending and stops when stopped', async () => {
    const mc = mockClient({ beginSafariVerification: () => ok({ status: 'pending', phase: 'WAITING_ROUTE', message: '等待切换开始' }) });
    const c = createPrepareController('op_1', null, { browser: mockBrowser(), client: mc.client, fetchImpl: vi.fn(), navigate: vi.fn() });
    void c.start();
    await vi.advanceTimersByTimeAsync(10);
    const count = () => mc.calls.filter((m) => m.type === 'beginSafariVerification').length;
    expect(count()).toBe(1);
    expect(c.state.stage).toBe('pending');
    await vi.advanceTimersByTimeAsync(3000);
    expect(count()).toBe(4);
    c.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(count()).toBe(4);
  });

  it('aborts the verify fetch at the deadline and reports a timeout', async () => {
    const mc = mockClient({
      beginSafariVerification: () => ok({ ...READY, deadline: new Date(Date.now() + 5000).toISOString() }),
      submitSafariVerification: () => ok({ accepted: true }),
      getOperation: () => ok(operation({ phase: 'FAILED', status: 'failed' })),
    });
    const fetchImpl = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    const c = createPrepareController('op_1', null, { browser: mockBrowser(), client: mc.client, fetchImpl, navigate: vi.fn() });
    const p = c.start();
    await vi.advanceTimersByTimeAsync(6000);
    await p;
    expect(mc.calls.find((m) => m.type === 'submitSafariVerification')).toMatchObject({ error: 'timeout', observed_ip: null, http_status: null });
  });
});

describe('helpers', () => {
  it('allows only the fixed verify endpoints', () => {
    expect(isAllowedVerifyUrl('https://api.ipify.org/?format=json&sfe_test=1')).toBe(true);
    expect(isAllowedVerifyUrl('https://api64.ipify.org/?format=json')).toBe(true);
    expect(isAllowedVerifyUrl('http://api.ipify.org/')).toBe(false);
    expect(isAllowedVerifyUrl('https://api.ipify.org:8443/')).toBe(false);
    expect(isAllowedVerifyUrl('https://user:pw@api.ipify.org/')).toBe(false);
    expect(isAllowedVerifyUrl('https://api.ipify.org.example.invalid/')).toBe(false);
    expect(isAllowedVerifyUrl('https://www.amazon.com/')).toBe(false);
    expect(isAllowedVerifyUrl('not a url')).toBe(false);
  });

  it('extracts only well-formed IPs', () => {
    expect(extractIp({ ip: '198.51.100.7' })).toBe('198.51.100.7');
    expect(extractIp({ ip: '2001:db8::7' })).toBe('2001:db8::7');
    expect(extractIp({ ip: '999.1.1.1' })).toBeNull();
    expect(extractIp({ ip: 7 })).toBeNull();
    expect(extractIp(null)).toBeNull();
    expect(extractIp({ ip: 'abc' })).toBeNull();
  });

  it('reads op and intent from the page url', () => {
    expect(readPrepareParams('?op=op_123&intent=orders')).toEqual({ operationId: 'op_123', intent: 'orders' });
    expect(readPrepareParams('?op=op_123')).toEqual({ operationId: 'op_123', intent: null });
    expect(readPrepareParams('?op=../../x')).toEqual({ operationId: null, intent: null });
    expect(readPrepareParams('')).toEqual({ operationId: null, intent: null });
  });
});
