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

  it('does not auto-open orders when the service does not allow automatic opening (fillAndAutoOpen gate), but offers the manual button with the reason', async () => {
    const reason = '自动打开订单页所需能力尚未通过实测（Safari 场景 ID 稳定性、首请求与旧连接），可以手动打开';
    const s = scenario({ state: currentState({ autoOpenAllowed: false, autoOpenBlockedReason: reason }) });
    await s.controller.start();
    expect(s.navigate).not.toHaveBeenCalled();
    expect(s.browser.tabs!.create).not.toHaveBeenCalled();
    expect(s.controller.state.ordersOfferable).toBe(true);
    expect(s.controller.state.autoOpenNotice).toBe(reason);
    // 手动打开只需 ordersAllowed（§6.10）
    await s.controller.openOrders();
    expect(s.navigate).toHaveBeenCalledWith('https://www.amazon.com/gp/css/order-history');
    // 页面写明未自动打开的原因并提供按钮
    const v = scenario({ state: currentState({ autoOpenAllowed: false, autoOpenBlockedReason: reason }) });
    const wrapper = mount(App, { props: { controller: v.controller } });
    await flushPromises();
    expect(v.navigate).not.toHaveBeenCalled();
    expect(wrapper.find('[data-test="auto-open-blocked"]').text()).toContain(reason);
    expect(wrapper.find('[data-test="open-orders"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it('a service reply without autoOpenAllowed (older service) never auto-opens', async () => {
    const st = currentState();
    delete (st as Partial<typeof st>).autoOpenAllowed;
    delete (st as Partial<typeof st>).autoOpenBlockedReason;
    const s = scenario({ state: st });
    await s.controller.start();
    expect(s.navigate).not.toHaveBeenCalled();
    expect(s.controller.state.ordersOfferable).toBe(true);
    expect(s.controller.state.autoOpenNotice).toBe('自动打开订单页暂不可用，可以手动打开');
  });

  it('an orders intent (the user clicked the orders button) still opens when only automatic opening is not allowed', async () => {
    const s = scenario({ state: currentState({ autoOpenAllowed: false, autoOpenBlockedReason: 'x' }), intent: 'orders' });
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

  it('a failure page states "never DIRECT or another environment\'s exit" only after a rollback read back as blocked; superseded and attention outcomes get their own truthful wording', async () => {
    const GUARANTEE = '不会改用直连或其他环境的出口';
    const rollback = {
      previousEnvironmentId: 'env_9',
      previousProxyRevision: 2,
      previousProbe: null,
      restoredSelection: 'SFE-N-E0009-US09-v002',
      entryModeAfter: 'BLOCKED' as const,
      failedProxyRevision: 3,
      failureError: { code: 'SAFARI_VERIFY_FAILED' as const, message: 'x' },
      needsReverify: true,
    };
    const cases = [
      {
        op: operation({ phase: 'FAILED', status: 'failed', error: { code: 'SAFARI_VERIFY_FAILED', message: 'Safari 实测失败' }, result: { rollback } }),
        outcome: 'rolled_back',
        title: '出口检测未通过',
        guarantee: true,
      },
      {
        op: operation({ phase: 'SUPERSEDED', status: 'superseded', error: { code: 'SUPERSEDED', message: '已被进入普通模式取代' } }),
        outcome: 'superseded',
        title: '切换未完成：已被之后的请求取代',
        guarantee: false,
        note: '进入普通模式后按 Surge 原规则发出（可能直连）',
      },
      {
        op: operation({
          phase: 'BLOCKED_NEEDS_ATTENTION',
          status: 'needs_attention',
          error: { code: 'UNKNOWN_STATE', message: '回滚无法确认：…Safari 请求（至少检测主机）可能仍经 SFE-ROUTE 当前选择的买家出口发出，请立即进入普通模式' },
        }),
        outcome: 'attention',
        title: '切换未能确认，需要处理',
        guarantee: false,
        note: '不能确认 Safari 的出口状态',
      },
      {
        op: operation({ phase: 'FAILED', status: 'failed', error: { code: 'PREFLIGHT_FAILED', message: '代理预检失败：前置或 SOCKS5 不可用，路由未改变' } }),
        outcome: 'failed',
        title: '切换未完成',
        guarantee: false,
      },
      // 取消与超时只结束这次重测：服务不加警告，路由与之前的检测结果都不变，自动打开订单与填充照旧——不能说已停止
      {
        op: operation({ phase: 'FAILED', status: 'failed', probeKind: 'safari', error: { code: 'SUPERSEDED', message: '已取消重新检测：路由未改变' } }),
        outcome: 'probe_failed',
        title: '已取消重新检测',
        guarantee: false,
        note: '路由与之前的检测结果都未改变',
        notNote: '已停止自动打开订单与填充',
      },
      // 取消排在已提交的结果之前受理、而提交的出口 IP 与预期出口不一致：服务照样记下不符（probeWarning），订单与填充已停止
      {
        op: operation({
          phase: 'FAILED',
          status: 'failed',
          probeKind: 'safari',
          error: { code: 'SUPERSEDED', message: '已取消重新检测：路由未改变；已提交的检测结果中的出口 IP 与预期出口不一致…' },
          result: { probeWarning: 'exit_ip_mismatch' },
        }),
        outcome: 'probe_failed',
        title: '已取消重新检测',
        guarantee: false,
        note: '已提交的出口 IP 与预期出口不一致，服务已记下出口不符：路由未改变，已停止自动打开订单与填充',
        notNote: '路由与之前的检测结果都未改变',
      },
      {
        op: operation({ phase: 'FAILED', status: 'failed', probeKind: 'safari', error: { code: 'SAFARI_VERIFY_TIMEOUT', message: 'Safari 实测超时：未在截止时间内完成出口检测' } }),
        outcome: 'probe_failed',
        title: '重新检测超时',
        guarantee: false,
        note: '路由与之前的检测结果都未改变',
        notNote: '已停止自动打开订单与填充',
      },
      // 结束时服务改选了 SFE-ROUTE（result.rejectSelected：等待期间 SFE-ROUTE 在 Surge 中被改选到别的买家节点）：路由已改变，
      // 订单与填充已停止——不能说「路由与之前的检测结果都未改变」
      {
        op: operation({
          phase: 'BLOCKED_NEEDS_ATTENTION',
          status: 'needs_attention',
          probeKind: 'safari',
          error: { code: 'SUPERSEDED', message: '已取消重新检测；结束时路由仍未回到已确认的状态（…），失败即关闭：SFE-ROUTE 已改选 REJECT（读回确认）' },
          result: { rejectSelected: true },
        }),
        outcome: 'attention',
        title: '重新检测已结束，路由需要处理',
        guarantee: false,
        note: '服务已把它改选 REJECT',
        notNote: '未改变',
      },
      // 同一结果以失败（旧版服务的形状）给出时同样按 rejectSelected 说明
      {
        op: operation({
          phase: 'FAILED',
          status: 'failed',
          probeKind: 'safari',
          error: { code: 'SAFARI_VERIFY_TIMEOUT', message: 'Safari 实测超时：绑定场景未在截止时间内到达；…SFE-ROUTE 已改选 REJECT（读回确认）' },
          result: { rejectSelected: true },
        }),
        outcome: 'probe_failed',
        title: '重新检测超时',
        guarantee: false,
        note: '自动打开订单与填充已停止',
        notNote: '不受这次重新检测影响',
      },
      {
        op: operation({
          kind: 'environment.update',
          phase: 'BLOCKED_NEEDS_ATTENTION',
          status: 'needs_attention',
          error: { code: 'UNKNOWN_STATE', message: '已取消切换：新版本已部署；结束时路由仍未回到已确认的状态（…），失败即关闭：SFE-ROUTE 未能改选 REJECT（改选失败）' },
          result: { rejectSelected: false },
        }),
        outcome: 'attention',
        title: '操作已结束，路由需要处理',
        guarantee: false,
        note: '请立即进入普通模式',
        notNote: '未改变',
      },
      // 等待期间路由已不在已验证的使用中状态（result.routeLeftVerified：例如 Surge 重启，不是这次重测改变的）：不能说「路由与之前
      // 的检测结果都未改变」或「不受这次重新检测影响」
      {
        op: operation({
          phase: 'FAILED',
          status: 'failed',
          probeKind: 'safari',
          error: { code: 'UNKNOWN_STATE', message: '重新检测已结束：绑定场景已到达，但无法开始检测；这次重新检测等待期间路由已不在已验证的使用中状态（Surge 已重启），…' },
          result: { routeLeftVerified: ['surge_restarted', 'probe_expired'] },
        }),
        outcome: 'probe_failed',
        title: '重新检测已结束，路由需要处理',
        guarantee: false,
        note: 'Surge 已重启',
        notNote: '未改变',
      },
      {
        op: operation({
          phase: 'FAILED',
          status: 'failed',
          probeKind: 'safari',
          error: { code: 'SAFARI_VERIFY_TIMEOUT', message: 'Safari 实测超时：绑定场景未在截止时间内到达；这次重新检测等待期间路由已不在已验证的使用中状态（…）' },
          result: { routeLeftVerified: ['outbound_mode_changed'] },
        }),
        outcome: 'probe_failed',
        title: '重新检测已结束，路由需要处理',
        guarantee: false,
        note: '自动打开订单与填充已停止',
        notNote: '不受这次重新检测影响',
      },
      // 核对后失败：服务把 probe_failed 加到路由上（result.probeWarning），自动打开订单与填充确实已停止
      {
        op: operation({
          phase: 'FAILED',
          status: 'failed',
          probeKind: 'safari',
          error: { code: 'SAFARI_VERIFY_FAILED', message: 'Safari 实测失败：浏览器检测请求失败' },
          result: { probeWarning: 'probe_failed' },
        }),
        outcome: 'probe_failed',
        title: '出口检测未通过',
        guarantee: false,
        note: '路由未改变，已停止自动打开订单与填充',
      },
      // 读取请求记录出错等其他代码：以服务记下的警告为准
      {
        op: operation({
          phase: 'FAILED',
          status: 'failed',
          probeKind: 'safari',
          error: { code: 'SURGE_UNREACHABLE', message: 'Safari 实测失败：读取 Surge 请求记录失败' },
          result: { probeWarning: 'probe_failed' },
        }),
        outcome: 'probe_failed',
        title: '重新检测未完成',
        guarantee: false,
        note: '已停止自动打开订单与填充',
      },
    ];
    for (const c of cases) {
      const s = scenario({ operations: [c.op] });
      await s.controller.start();
      expect(s.controller.state.stage).toBe('failed');
      expect(s.controller.state.outcome).toBe(c.outcome);
      const wrapper = mount(App, { props: { controller: s.controller } });
      expect(wrapper.find('[data-test="stage-title"]').text()).toBe(c.title);
      expect(wrapper.find('[data-test="failure"]').text()).toBe(c.op.error!.message);
      const note = wrapper.find('[data-test="failed-note"]').text();
      expect(note.includes(GUARANTEE), c.outcome).toBe(c.guarantee);
      if (c.note) expect(note).toContain(c.note);
      if ('notNote' in c && c.notNote) expect(note).not.toContain(c.notNote);
      if (c.outcome === 'attention') expect(note).not.toContain('可以关闭此页面');
      wrapper.unmount();
    }
  });

  it('a switch that ended READY_FOR_NEXT_OPEN (status succeeded, as the service writes it) without any check is not shown as a passed check', async () => {
    const parked = operation({
      kind: 'environment.update',
      phase: 'READY_FOR_NEXT_OPEN',
      status: 'succeeded',
      steps: [{ at: iso(-1), phase: 'READY_FOR_NEXT_OPEN', message: '新版本已部署，未切换：已有进入普通模式的请求（在第一次写入 Surge 之前停下），路由未改变' }],
    });
    const s = scenario({
      begin: [{ status: 'pending', phase: 'WAITING_ROUTE', message: '已到达，正在切换到新版本' }, { status: 'not_needed', message: '等待已结束：新版本已部署，请重新使用此环境以切换' }],
      operations: [parked],
    });
    await s.controller.start();
    expect(s.controller.state.stage).toBe('parked');
    expect(s.controller.state.outcome).toBe('not_checked');
    expect(s.fetchImpl).not.toHaveBeenCalled();
    expect(s.navigate).not.toHaveBeenCalled();
    expect(s.events).not.toContain('getCurrentState');
    const wrapper = mount(App, { props: { controller: s.controller } });
    expect(wrapper.find('[data-test="stage-title"]').text()).not.toBe('出口检测通过');
    expect(wrapper.find('.text-green-500').exists()).toBe(false);
    expect(wrapper.find('[data-test="stage-message"]').text()).toContain('新版本已部署，未切换');
    expect(wrapper.find('[data-test="not-checked"]').text()).toContain('这次没有进行出口检测');
    expect(wrapper.find('[data-test="exit-ip"]').exists()).toBe(false);
    wrapper.unmount();
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

describe('prepare page while pending', () => {
  async function pendingPage(reply: BeginVerificationResponse) {
    const mc = mockClient({ beginSafariVerification: () => ok(reply) });
    // 停在第一次 pending（不再轮询）
    const c = createPrepareController('op_1', null, { browser: mockBrowser(), client: mc.client, fetchImpl: vi.fn(), navigate: vi.fn(), sleep: () => new Promise(() => undefined) });
    const wrapper = mount(App, { props: { controller: c } });
    await flushPromises();
    expect(c.state.stage).toBe('pending');
    return wrapper;
  }

  it.each([
    ['a retest that is still queued', { status: 'pending', phase: 'SAVED', message: '正在开始重新检测，请稍候（不切换、不阻断 Safari）', switching: false }],
    ['a cancelled WAITING_ROUTE wait', { status: 'pending', phase: 'WAITING_ROUTE', message: '已请求取消，正在处理', switching: false }],
    ['a retest whose route is no longer verified (ending)', { status: 'pending', phase: 'VALIDATING', message: '路由已不在已验证的使用中状态，无法开始检测：正在结束本次重新检测（不切换、不阻断 Safari）', switching: false }],
    ['an older service without the switching flag', { status: 'pending', phase: 'SAVED', message: '正在切换出口，请稍候' }],
  ] as const)('%s: never claims that Safari is being rejected', async (_name, reply) => {
    const wrapper = await pendingPage(reply as BeginVerificationResponse);
    expect(wrapper.find('[data-test="stage-message"]').text()).toBe(reply.message);
    expect(wrapper.find('[data-test="pending-note"]').text()).toBe('请保持此页面打开。');
    expect(wrapper.text()).not.toContain('暂时拒绝');
    wrapper.unmount();
  });

  it('an actual switch says Safari\'s other requests are rejected while it runs', async () => {
    const wrapper = await pendingPage({ status: 'pending', phase: 'SAVED', message: '正在切换出口，请稍候', switching: true });
    expect(wrapper.find('[data-test="pending-note"]').text()).toBe('请保持此页面打开。切换期间 Safari 的其他请求会被暂时拒绝，Chrome 不受影响。');
    wrapper.unmount();
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
