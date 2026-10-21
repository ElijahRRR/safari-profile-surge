import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NeedsConfirmationDetails } from '@sfe/contract';
import { createPopupController } from '../src/popup/controller';
import { accepted, currentState, environment, flush, mockBrowser, mockClient, ok, operation, route } from './fixtures';

const NEEDS_CONFIRMATION: NeedsConfirmationDetails = {
  reason: 'other_environment_active',
  currentEnvironmentId: 'env_9',
  currentEnvironmentLabel: 'US-买家09 · E0009',
  otherProfilesOpen: [{ profileIdShort: '9b8a7c6d', environmentLabel: 'US-买家09 · E0009' }],
  options: ['closed_confirmed', 'keep_open_acknowledged'],
  limitation: '首请求与旧连接处理尚未通过实测：建议保存工作后退出并重开 Safari。',
};

function needsConfirmation(details = NEEDS_CONFIRMATION) {
  return { ok: false as const, error: { code: 'NEEDS_CONFIRMATION' as const, message: '需要确认旧窗口处理方式', details: details as unknown as Record<string, unknown> } };
}

let ids = 0;
function controller(handlers: Parameters<typeof mockClient>[0], browser = mockBrowser(), profile?: Parameters<typeof mockClient>[1]) {
  const mc = mockClient(handlers, profile);
  ids = 0;
  const c = createPopupController({ browser, client: mc.client, newRequestId: () => `req_${++ids}`, pollMs: 1000, closeWindow: vi.fn() });
  return { c, browser, ...mc };
}

describe('popup polling', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('reports profile state once, reads state, then polls about every second until stopped', async () => {
    const { c, calls, profileCalls } = controller({ getCurrentState: () => ok(currentState()) });
    await c.start();
    expect(profileCalls).toEqual([true]);
    expect(calls.filter((m) => m.type === 'getCurrentState')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls.filter((m) => m.type === 'getCurrentState')).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(3000);
    expect(calls.filter((m) => m.type === 'getCurrentState')).toHaveLength(5);
    c.stop();
    await vi.advanceTimersByTimeAsync(10000);
    expect(calls.filter((m) => m.type === 'getCurrentState')).toHaveLength(5);
  });

  it('also polls the tracked operation until it is terminal', async () => {
    let status: 'waiting' | 'succeeded' = 'waiting';
    const { c, calls } = controller({
      getCurrentState: () => ok(currentState()),
      probeCurrentEnvironment: () => accepted('op_7'),
      getOperation: () => ok(operation({ id: 'op_7', status, phase: status === 'waiting' ? 'DEPLOYING' : 'COMPLETED' })),
    });
    await c.start();
    await c.probe();
    await vi.advanceTimersByTimeAsync(1000);
    expect(c.state.operation?.phase).toBe('DEPLOYING');
    status = 'succeeded';
    await vi.advanceTimersByTimeAsync(1000);
    expect(c.state.operation?.phase).toBe('COMPLETED');
    const before = calls.filter((m) => m.type === 'getOperation').length;
    await vi.advanceTimersByTimeAsync(3000);
    expect(calls.filter((m) => m.type === 'getOperation')).toHaveLength(before);
    c.stop();
  });

  it('keeps the last state and records the error when a poll fails', async () => {
    let fail = false;
    const { c } = controller({
      getCurrentState: () => (fail ? { ok: false, error: { code: 'INTERNAL', message: '连接本机服务失败' } } : ok(currentState())),
    });
    await c.start();
    fail = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(c.state.current).not.toBeNull();
    expect(c.state.loadError).toBe('连接本机服务失败');
    c.stop();
  });
});

describe('activation and confirmation', () => {
  it('sends activateCurrentEnvironment with environment id and amazon_tabs_open, then opens the prepare page', async () => {
    const { c, calls, browser } = controller(
      { getCurrentState: () => ok(currentState({ relation: 'none_active', route: null })), activateCurrentEnvironment: () => accepted('op_42') },
      mockBrowser(),
      { windows_open: 1, amazon_tabs_open: true, site_permission_granted: true },
    );
    await c.refresh();
    await c.activate();
    expect(calls.find((m) => m.type === 'activateCurrentEnvironment')).toEqual({
      type: 'activateCurrentEnvironment',
      request_id: 'req_1',
      environment_id: 'env_1',
      amazon_tabs_open: true,
    });
    expect(browser.tabs!.create).toHaveBeenCalledWith({ url: 'safari-web-extension://ext-uuid/prepare.html?op=op_42', active: true });
    expect(c.state.trackedOperationId).toBe('op_42');
  });

  it('shows the confirmation on NEEDS_CONFIRMATION and resends the same request_id with the chosen policy', async () => {
    let first = true;
    const { c, calls, browser } = controller({
      getCurrentState: () => ok(currentState({ relation: 'other_active', route: null })),
      activateCurrentEnvironment: () => {
        if (first) {
          first = false;
          return needsConfirmation();
        }
        return accepted('op_5');
      },
    });
    await c.refresh();
    await c.activate();
    expect(c.state.confirm?.kind).toBe('activate');
    expect(c.state.confirm?.details.currentEnvironmentLabel).toBe('US-买家09 · E0009');
    expect(browser.tabs!.create).not.toHaveBeenCalled();

    await c.confirmPolicy('keep_open_acknowledged');
    const sends = calls.filter((m) => m.type === 'activateCurrentEnvironment');
    expect(sends).toHaveLength(2);
    expect(sends[1]!.request_id).toBe(sends[0]!.request_id);
    expect(sends[1]).toEqual({
      ...sends[0],
      old_session_policy: 'keep_open_acknowledged',
      confirmed_environment_id: 'env_9',
    });
    expect(c.state.confirm).toBeNull();
    expect(browser.tabs!.create).toHaveBeenCalledWith({ url: 'safari-web-extension://ext-uuid/prepare.html?op=op_5', active: true });
  });

  it('cancelling the confirmation sends nothing more', async () => {
    const { c, calls } = controller({
      getCurrentState: () => ok(currentState()),
      activateCurrentEnvironment: () => needsConfirmation(),
    });
    await c.refresh();
    await c.activate();
    c.dismissConfirm();
    expect(c.state.confirm).toBeNull();
    expect(calls.filter((m) => m.type === 'activateCurrentEnvironment')).toHaveLength(1);
  });

  it('ignores a policy the service did not offer', async () => {
    const { c, calls } = controller({
      getCurrentState: () => ok(currentState()),
      activateCurrentEnvironment: () => needsConfirmation({ ...NEEDS_CONFIRMATION, options: ['closed_confirmed'] }),
    });
    await c.refresh();
    await c.activate();
    await c.confirmPolicy('keep_open_acknowledged');
    expect(calls.filter((m) => m.type === 'activateCurrentEnvironment')).toHaveLength(1);
  });

  it('a second NEEDS_CONFIRMATION after resend shows the new details with the same request id', async () => {
    let n = 0;
    const { c, calls } = controller({
      getCurrentState: () => ok(currentState()),
      activateCurrentEnvironment: () => (++n === 1 ? needsConfirmation() : needsConfirmation({ ...NEEDS_CONFIRMATION, currentEnvironmentId: 'env_10', currentEnvironmentLabel: 'B' })),
    });
    await c.refresh();
    await c.activate();
    await c.confirmPolicy('closed_confirmed');
    expect(c.state.confirm?.details.currentEnvironmentId).toBe('env_10');
    expect(c.state.confirm?.message.request_id).toBe('req_1');
    await c.confirmPolicy('closed_confirmed');
    const sends = calls.filter((m) => m.type === 'activateCurrentEnvironment');
    expect(sends.map((s) => s.request_id)).toEqual(['req_1', 'req_1', 'req_1']);
    expect(sends[2]!.confirmed_environment_id).toBe('env_10');
  });

  it('enterNormalMode follows the same confirmation flow and does not open a page', async () => {
    let first = true;
    const { c, calls, browser } = controller({
      getCurrentState: () => ok(currentState()),
      enterNormalMode: () => {
        if (first) {
          first = false;
          return needsConfirmation({ ...NEEDS_CONFIRMATION, reason: 'managed_environment_active', currentEnvironmentId: 'env_1' });
        }
        return accepted('op_n');
      },
    });
    await c.refresh();
    await c.enterNormal();
    expect(c.state.confirm?.kind).toBe('normal');
    await c.confirmPolicy('closed_confirmed');
    const sends = calls.filter((m) => m.type === 'enterNormalMode');
    expect(sends).toEqual([
      { type: 'enterNormalMode', request_id: 'req_1' },
      { type: 'enterNormalMode', request_id: 'req_1', old_session_policy: 'closed_confirmed', confirmed_environment_id: 'env_1' },
    ]);
    expect(browser.tabs!.create).not.toHaveBeenCalled();
    expect(c.state.trackedOperationId).toBe('op_n');
  });

  it('shows other errors as the action error', async () => {
    const { c } = controller({
      getCurrentState: () => ok(currentState()),
      activateCurrentEnvironment: () => ({ ok: false, error: { code: 'ROUTE_BUSY', message: '切换失败：另一个切换正在进行' } }),
    });
    await c.refresh();
    await c.activate();
    expect(c.state.actionError).toBe('切换失败：另一个切换正在进行');
    expect(c.state.confirm).toBeNull();
  });

  it('treats an unreadable profile state as Amazon tabs open', async () => {
    const mc = mockClient({ getCurrentState: () => ok(currentState()), activateCurrentEnvironment: () => accepted() });
    (mc.client.profileState as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, error: { code: 'INTERNAL', message: 'x' } });
    const c = createPopupController({ browser: mockBrowser(), client: mc.client, newRequestId: () => 'req_a' });
    await c.refresh();
    await c.activate();
    expect(mc.calls.find((m) => m.type === 'activateCurrentEnvironment')?.amazon_tabs_open).toBe(true);
  });
});

describe('orders button gating', () => {
  it('locates an existing orders tab when orders are allowed', async () => {
    const browser = mockBrowser({ tabs: [{ id: 12, windowId: 3, url: 'https://www.amazon.com/gp/css/order-history' }] });
    const { c, calls } = controller({ getCurrentState: () => ok(currentState({ ordersAllowed: true })) }, browser);
    await c.refresh();
    await c.openOrders();
    expect(browser.tabs!.query).toHaveBeenCalledWith({
      url: ['https://www.amazon.com/gp/css/order-history*', 'https://www.amazon.com/your-orders*'],
    });
    expect(browser.tabs!.update).toHaveBeenCalledWith(12, { active: true });
    expect(browser.windows!.update).toHaveBeenCalledWith(3, { focused: true });
    expect(browser.tabs!.create).not.toHaveBeenCalled();
    expect(calls.some((m) => m.type === 'activateCurrentEnvironment')).toBe(false);
  });

  it('opens the orders url in a new tab when none is open', async () => {
    const browser = mockBrowser({ tabs: [] });
    const { c } = controller({ getCurrentState: () => ok(currentState({ ordersAllowed: true })) }, browser);
    await c.refresh();
    await c.openOrders();
    expect(browser.tabs!.create).toHaveBeenCalledWith({ url: 'https://www.amazon.com/gp/css/order-history' });
  });

  it('runs the controlled entry instead of navigating when orders are not allowed', async () => {
    const browser = mockBrowser();
    const { c, calls } = controller(
      {
        getCurrentState: () => ok(currentState({ ordersAllowed: false, ordersBlockedReason: '实测出口已过期', activationAvailable: true })),
        activateCurrentEnvironment: () => accepted('op_o'),
      },
      browser,
    );
    await c.refresh();
    await c.openOrders();
    expect(calls.some((m) => m.type === 'activateCurrentEnvironment')).toBe(true);
    expect(browser.tabs!.create).toHaveBeenCalledTimes(1);
    expect(browser.tabs!.create).toHaveBeenCalledWith({ url: 'safari-web-extension://ext-uuid/prepare.html?op=op_o&intent=orders', active: true });
    expect(browser.tabs!.query).not.toHaveBeenCalled();
  });

  it('does nothing when neither orders nor activation are allowed', async () => {
    const browser = mockBrowser();
    const { c, calls } = controller(
      { getCurrentState: () => ok(currentState({ ordersAllowed: false, activationAvailable: false, ordersBlockedReason: '需要先部署' })) },
      browser,
    );
    await c.refresh();
    await c.openOrders();
    expect(browser.tabs!.create).not.toHaveBeenCalled();
    expect(calls.map((m) => m.type)).toEqual(['getCurrentState']);
  });
});

describe('other actions', () => {
  it('probe uses safari for the active environment and opens the prepare page', async () => {
    const browser = mockBrowser();
    const { c, calls } = controller({ getCurrentState: () => ok(currentState()), probeCurrentEnvironment: () => accepted('op_p') }, browser);
    await c.refresh();
    await c.probe();
    expect(calls.find((m) => m.type === 'probeCurrentEnvironment')).toMatchObject({ kind: 'safari', environment_id: 'env_1' });
    expect(browser.tabs!.create).toHaveBeenCalledWith({ url: 'safari-web-extension://ext-uuid/prepare.html?op=op_p', active: true });
  });

  it('probe uses preflight when another environment is active and stays in the popup', async () => {
    const browser = mockBrowser();
    const { c, calls } = controller({ getCurrentState: () => ok(currentState({ relation: 'other_active', route: null })), probeCurrentEnvironment: () => accepted('op_p') }, browser);
    await c.refresh();
    await c.probe();
    expect(calls.find((m) => m.type === 'probeCurrentEnvironment')).toMatchObject({ kind: 'preflight' });
    expect(browser.tabs!.create).not.toHaveBeenCalled();
    expect(c.state.trackedOperationId).toBe('op_p');
  });

  it('continue verification opens the pending operation', async () => {
    const browser = mockBrowser();
    const pending = { operation_id: 'op_w', kind: 'apply_new_revision' as const, deadline: null };
    const { c } = controller({ getCurrentState: () => ok(currentState({ pendingVerification: pending })) }, browser);
    await c.refresh();
    await c.continueVerification();
    expect(browser.tabs!.create).toHaveBeenCalledWith({ url: 'safari-web-extension://ext-uuid/prepare.html?op=op_w', active: true });
  });

  it('cancel sends cancelOperation for the pending operation', async () => {
    const pending = { operation_id: 'op_w', kind: 'activate' as const, deadline: null };
    const { c, calls } = controller({ getCurrentState: () => ok(currentState({ pendingVerification: pending })), cancelOperation: () => accepted('op_w') });
    await c.refresh();
    await c.cancelPending();
    expect(calls.find((m) => m.type === 'cancelOperation')).toEqual({ type: 'cancelOperation', request_id: 'req_1', operation_id: 'op_w' });
  });

  it('acknowledge account change sends the current revision', async () => {
    const { c, calls } = controller({
      getCurrentState: () => ok(currentState({ environment: environment({ revision: 11 }) })),
      acknowledgeAccountChange: () => accepted(),
    });
    await c.refresh();
    await c.acknowledgeAccount();
    expect(calls.find((m) => m.type === 'acknowledgeAccountChange')).toEqual({
      type: 'acknowledgeAccountChange',
      request_id: 'req_1',
      environment_id: 'env_1',
      expected_revision: 11,
    });
  });

  it('acknowledge windows sends acknowledgeWindowsClosed', async () => {
    const { c, calls } = controller({
      getCurrentState: () => ok(currentState({ route: route({ warnings: ['old_windows_kept_open'] }) })),
      acknowledgeWindowsClosed: () => ok({ cleared: true }),
    });
    await c.refresh();
    await c.acknowledgeWindows();
    expect(calls.find((m) => m.type === 'acknowledgeWindowsClosed')).toEqual({ type: 'acknowledgeWindowsClosed', request_id: 'req_1' });
    expect(c.state.notice).toBe('已清除旧窗口警告');
  });

  it('bind sends the environment id and revision', async () => {
    const { c, calls } = controller({
      getCurrentState: () => ok(currentState({ environment: null, route: null, bindable: [{ id: 'env_3', label: 'US-买家03 · E0003', site: 'US', revision: 2 }] })),
      bindCurrentProfile: () => accepted('op_b'),
    });
    await c.refresh();
    await c.bind(c.state.current!.bindable[0]!);
    expect(calls.find((m) => m.type === 'bindCurrentProfile')).toEqual({
      type: 'bindCurrentProfile',
      request_id: 'req_1',
      environment_id: 'env_3',
      expected_revision: 2,
    });
  });

  it('update sends expected_revision and changes', async () => {
    const { c, calls } = controller({ getCurrentState: () => ok(currentState()), updateCurrentEnvironment: () => accepted('op_u') });
    await c.refresh();
    const r = await c.updateEnvironment({ displayName: '新名称' }, 4);
    expect(r).toEqual({ ok: true });
    // 带的是表单打开时的版本，而不是轮询读到的最新版本。
    expect(calls.find((m) => m.type === 'updateCurrentEnvironment')).toEqual({
      type: 'updateCurrentEnvironment',
      request_id: 'req_1',
      environment_id: 'env_1',
      expected_revision: 4,
      changes: { displayName: '新名称' },
    });
  });

  it('ignores clicks while another action is running', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { c, calls } = controller({
      getCurrentState: () => ok(currentState()),
      probeCurrentEnvironment: async () => {
        await gate;
        return accepted();
      },
      activateCurrentEnvironment: () => accepted(),
    });
    await c.refresh();
    const p = c.probe();
    await flush();
    await c.activate();
    release();
    await p;
    expect(calls.some((m) => m.type === 'activateCurrentEnvironment')).toBe(false);
  });
});
