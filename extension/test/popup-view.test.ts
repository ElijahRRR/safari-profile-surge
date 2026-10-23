import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import type { RouteWarning } from '@sfe/contract';
import App from '../src/popup/App.vue';
import EditForm from '../src/popup/EditForm.vue';
import CreateForm from '../src/popup/CreateForm.vue';
import { createPopupController } from '../src/popup/controller';
import { WARNING_TEXT } from '../src/shared/text';
import { NOW, accepted, currentState, environment, iso, mockBrowser, mockClient, ok, operation as operationView, revision, route, safariProbe } from './fixtures';

const SECRET_PROXY_PASSWORD = 'syn-proxy-pass-1';
const SECRET_ACCOUNT_PASSWORD = 'syn-account-pass-2';

let wrappers: VueWrapper[] = [];
afterEach(() => {
  for (const w of wrappers) w.unmount();
  wrappers = [];
  document.body.innerHTML = '';
});

async function mountPopup(state = currentState(), handlers: Parameters<typeof mockClient>[0] = {}, profile?: Parameters<typeof mockClient>[1]) {
  const browser = mockBrowser();
  const mc = mockClient({ getCurrentState: () => ok(state), ...handlers }, profile);
  let n = 0;
  const controller = createPopupController({ browser, client: mc.client, newRequestId: () => `req_${++n}`, now: () => NOW });
  const wrapper = mount(App, { props: { controller }, attachTo: document.body });
  wrappers.push(wrapper);
  await flushPromises();
  return { wrapper, controller, browser, ...mc };
}

describe('popup states', () => {
  it('explains an unidentified profile and offers no actions', async () => {
    const { wrapper } = await mountPopup(currentState({ profile: { identified: false, profileIdShort: null }, environment: null, route: null, relation: 'none_active' }));
    expect(wrapper.find('[data-test="unidentified"]').text()).toContain('未识别当前场景');
    expect(wrapper.find('[data-test="activate"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="open-create"]').exists()).toBe(false);
  });

  it('without a profile identifier (e.g. the default profile) explains that only a named Safari profile can be bound', async () => {
    const state = currentState({
      profile: { identified: false, profileIdShort: null },
      environment: null,
      route: null,
      relation: 'other_active',
      otherActiveLabel: null,
      bindable: [],
    });
    const { wrapper, calls } = await mountPopup(state);
    const hint = wrapper.find('[data-test="named-profile-required"]').text();
    expect(hint).toContain('环境只能关联在已命名的 Safari 场景中（默认场景可能拿不到场景标识）');
    // 默认场景是否提供场景标识由 P0 native_profile_id 实测，不写成定论
    expect(hint).not.toContain('默认场景不能关联');
    expect(hint).toContain('新建一个场景并为它启用本扩展');
    // Apple：Safari 17 起网站授权对所有场景生效（Managing Safari web extension permissions），不要求每个新场景重新授权
    expect(hint).toContain('www.amazon.com 的网站授权已对所有场景生效，授权过就不必重复');
    expect(hint).not.toMatch(/启用本扩展并允许/);
    expect(wrapper.find('[data-test="unbound-view"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="end-current"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="normal"]').exists()).toBe(false);
    expect(wrapper.findAll('button').map((b) => b.text())).toEqual([]);
    expect(calls.map((m) => m.type)).toEqual(['getCurrentState']);
  });

  it('shows the load error when the first read fails', async () => {
    const { wrapper } = await mountPopup(currentState(), {
      getCurrentState: () => ({ ok: false, error: { code: 'INTERNAL', message: '连接本机服务失败：原生桥不可用' } }),
    });
    expect(wrapper.find('[data-test="load-error"]').text()).toContain('连接本机服务失败：原生桥不可用');
  });

  it('unbound: lists bindable environments, confirms before binding', async () => {
    const state = currentState({
      environment: null,
      route: null,
      relation: 'none_active',
      bindable: [{ id: 'env_3', label: 'US-买家03 · E0003', site: 'US', revision: 2 }],
    });
    const { wrapper, calls } = await mountPopup(state, { bindCurrentProfile: () => accepted('op_b') });
    expect(wrapper.text()).toContain('当前场景未绑定');
    await wrapper.find('[data-test="bind-env_3"]').trigger('click');
    expect(calls.some((m) => m.type === 'bindCurrentProfile')).toBe(false);
    expect(wrapper.text()).toContain('确定要关联此环境吗？');
    await wrapper.find('[data-test="confirm-bind"]').trigger('click');
    await flushPromises();
    expect(calls.find((m) => m.type === 'bindCurrentProfile')).toMatchObject({ environment_id: 'env_3', expected_revision: 2 });
  });

  it('unbound with another environment active offers ending it', async () => {
    const state = currentState({ environment: null, route: null, relation: 'other_active', otherActiveLabel: 'US-买家09 · E0009' });
    const { wrapper, calls } = await mountPopup(state, { enterNormalMode: () => accepted('op_n') });
    const box = wrapper.find('[data-test="other-active"]');
    expect(box.text()).toContain('US-买家09 · E0009');
    await wrapper.find('[data-test="end-current"]').trigger('click');
    await flushPromises();
    expect(calls.find((m) => m.type === 'enterNormalMode')).toEqual({ type: 'enterNormalMode', request_id: 'req_1' });
  });

  it('unbound without another active environment does not offer normal mode', async () => {
    const { wrapper } = await mountPopup(currentState({ environment: null, route: null, relation: 'none_active', routeSummary: { routeEpoch: 1, entryMode: 'NORMAL', phase: 'idle', buyerExitConnectionsUnconfirmed: false, normalModeOffered: false } }));
    expect(wrapper.find('[data-test="end-current"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="normal"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="buyer-exit-unconfirmed"]').exists()).toBe(false);
    expect(wrapper.text()).toContain('没有可关联的环境');
  });

  it('unbound, idle normal mode that could not confirm Safari left the buyer exit: shows the warning and offers 进入普通模式 again', async () => {
    const state = currentState({ environment: null, route: null, relation: 'none_active', routeSummary: { routeEpoch: 3, entryMode: 'NORMAL', phase: 'idle', buyerExitConnectionsUnconfirmed: true, normalModeOffered: true } });
    const { wrapper, calls } = await mountPopup(state, { enterNormalMode: () => accepted('op_n') });
    expect(wrapper.find('[data-test="buyer-exit-unconfirmed"]').text()).toContain(WARNING_TEXT.buyer_exit_connections_unconfirmed);
    await wrapper.find('[data-test="normal"]').trigger('click');
    await flushPromises();
    expect(calls.find((m) => m.type === 'enterNormalMode')).toEqual({ type: 'enterNormalMode', request_id: 'req_1' });
  });
});

describe('normal mode offered by the server-side flag (§6.5)', () => {
  // 回滚失败记为 NORMAL（阶段 attention、快照保留）：入口看起来是普通模式，Safari 仍可能有经 SFE-ROUTE 的连接
  const attention = { routeEpoch: 4, entryMode: 'NORMAL' as const, phase: 'attention' as const, buyerExitConnectionsUnconfirmed: false, normalModeOffered: true };
  // 普通模式结束连接失败之后读回也失败：路由记为空闲的普通模式、没有警告，持久标记仍在
  const markerOnly = { routeEpoch: 5, entryMode: 'NORMAL' as const, phase: 'idle' as const, buyerExitConnectionsUnconfirmed: false, normalModeOffered: true };
  // 第一次激活被取消、没有切换前的环境：停在阻断
  const blocked = { routeEpoch: 2, entryMode: 'BLOCKED' as const, phase: 'failed' as const, buyerExitConnectionsUnconfirmed: false, normalModeOffered: true };

  it('bound, NORMAL with phase attention: offers 进入普通模式 and the header does not read as plain 普通模式', async () => {
    const { wrapper, calls } = await mountPopup(currentState({ relation: 'none_active', route: null, routeSummary: attention }), { enterNormalMode: () => accepted('op_n') });
    expect(wrapper.find('[data-test="entry-mode"]').text()).toBe('普通模式（未确认）');
    await wrapper.find('[data-test="normal"]').trigger('click');
    await flushPromises();
    expect(calls.find((m) => m.type === 'enterNormalMode')).toEqual({ type: 'enterNormalMode', request_id: 'req_1' });
  });

  it('bound, idle NORMAL without the buyer-exit warning but the server still offers normal mode: offers 进入普通模式', async () => {
    const { wrapper } = await mountPopup(currentState({ relation: 'none_active', route: null, routeSummary: markerOnly }));
    expect(wrapper.find('[data-test="normal"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="entry-mode"]').text()).toBe('普通模式（未确认）');
  });

  it.each([
    ['NORMAL with phase attention', attention],
    ['idle NORMAL with the persistent marker only', markerOnly],
    ['BLOCKED after the first activation was cancelled', blocked],
  ])('unbound, no environment in use, %s: explains why and offers 进入普通模式', async (_name, summary) => {
    const { wrapper, calls } = await mountPopup(currentState({ environment: null, route: null, relation: 'none_active', routeSummary: summary }), { enterNormalMode: () => accepted('op_n') });
    expect(wrapper.find('[data-test="open-create"]').exists()).toBe(true);
    const why = wrapper.find('[data-test="route-unsettled"]').text();
    expect(why).toContain('进入普通模式');
    if (summary.entryMode === 'BLOCKED') expect(why).toContain('Safari 已阻断');
    expect(wrapper.find('[data-test="buyer-exit-unconfirmed"]').exists()).toBe(false);
    await wrapper.find('[data-test="normal"]').trigger('click');
    await flushPromises();
    expect(calls.find((m) => m.type === 'enterNormalMode')).toEqual({ type: 'enterNormalMode', request_id: 'req_1' });
  });

  it('unbound, idle NORMAL and the server does not offer normal mode: no button, header 普通模式', async () => {
    const { wrapper } = await mountPopup(
      currentState({ environment: null, route: null, relation: 'none_active', routeSummary: { routeEpoch: 1, entryMode: 'NORMAL', phase: 'idle', buyerExitConnectionsUnconfirmed: false, normalModeOffered: false } }),
    );
    expect(wrapper.find('[data-test="normal"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="route-unsettled"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="entry-mode"]').text()).toBe('普通模式');
  });
});

describe('unidentified profile (e.g. the default profile) still shows the route state it receives', () => {
  const unidentified = { profile: { identified: false, profileIdShort: null }, environment: null, route: null, bindable: [], otherActiveLabel: null };

  it('buyer-exit warning: shown, with where normal mode can be entered; no action is sent from here', async () => {
    const { wrapper, calls } = await mountPopup(
      currentState({ ...unidentified, relation: 'none_active', routeSummary: { routeEpoch: 3, entryMode: 'NORMAL', phase: 'idle', buyerExitConnectionsUnconfirmed: true, normalModeOffered: true } }),
    );
    expect(wrapper.find('[data-test="unidentified"] [data-warning="buyer_exit_connections_unconfirmed"]').text()).toBe(WARNING_TEXT.buyer_exit_connections_unconfirmed);
    expect(wrapper.find('[data-test="unidentified-normal-hint"]').text()).toContain('网页后台');
    expect(wrapper.find('[data-test="entry-mode"]').text()).toBe('普通模式（未确认）');
    expect(wrapper.find('[data-test="normal"]').exists()).toBe(false);
    expect(calls.some((m) => m.type === 'enterNormalMode')).toBe(false);
  });

  it('another environment in use: says this profile\'s requests use its exit, without naming it', async () => {
    const { wrapper } = await mountPopup(
      currentState({ ...unidentified, relation: 'other_active', routeSummary: { routeEpoch: 7, entryMode: 'ACTIVE', phase: 'active_verified', buyerExitConnectionsUnconfirmed: false, normalModeOffered: true } }),
    );
    expect(wrapper.find('[data-test="unidentified-other-active"]').text()).toContain('此场景的请求也会经过它的出口');
    expect(wrapper.find('[data-test="unidentified-normal-hint"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="end-current"]').exists()).toBe(false);
  });

  it('route in plain idle normal mode: only the named-profile guidance', async () => {
    const { wrapper } = await mountPopup(
      currentState({ ...unidentified, relation: 'none_active', routeSummary: { routeEpoch: 1, entryMode: 'NORMAL', phase: 'idle', buyerExitConnectionsUnconfirmed: false, normalModeOffered: false } }),
    );
    expect(wrapper.find('[data-test="named-profile-required"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="unidentified-route"]').exists()).toBe(false);
  });
});

describe('bound popup', () => {
  it('shows the environment rows without any password', async () => {
    const { wrapper } = await mountPopup();
    const text = wrapper.text();
    expect(wrapper.find('[data-test="env-name"]').text()).toBe('US-买家01');
    expect(wrapper.find('[data-test="row-binding"]').text()).toContain('3fa2c1d0');
    expect(wrapper.find('[data-test="row-account"]').text()).toContain('b*****1@example.test');
    expect(wrapper.find('[data-test="row-page-identity"]').text()).toContain('未核对');
    expect(wrapper.find('[data-test="row-site"]').text()).toContain('Amazon 美国站');
    expect(wrapper.find('[data-test="row-proxy"]').text()).toContain('SOCKS5 203.0.113.10:1080');
    expect(wrapper.find('[data-test="row-front"]').text()).toContain('Front-HK-01');
    expect(wrapper.find('[data-test="row-exit"]').text()).toContain('198.51.100.7');
    expect(wrapper.find('[data-test="row-exit"]').text()).toContain('30 秒前');
    expect(wrapper.find('[data-test="probe-stale"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="row-sync"]').text()).toContain('已同步');
    expect(text).not.toMatch(/密码[:：]/);
    expect(wrapper.find('[data-test="env-status"]').text()).toContain('使用中');
  });

  it('labels an expired probe as 上次结果', async () => {
    const env = environment({ probes: { preflight: null, safari: safariProbe({ observedAt: iso(-7200), expiresAt: iso(-60) }) } });
    const { wrapper } = await mountPopup(currentState({ environment: env }));
    expect(wrapper.find('[data-test="probe-stale"]').text()).toBe('上次结果');
    expect(wrapper.find('[data-test="row-exit"]').text()).toContain('2 小时前');
  });

  it('shows a pending new revision next to the address in use', async () => {
    const env = environment({ proxy: { desired: revision({ revision: 4, host: '203.0.113.20' }), deployed: revision(), active: revision(), lastVerified: revision() } });
    const { wrapper } = await mountPopup(currentState({ environment: env }));
    const row = wrapper.find('[data-test="row-proxy"]').text();
    expect(row).toContain('203.0.113.10:1080');
    expect(row).toContain('修改后：SOCKS5 203.0.113.20:1080（未生效）');
  });

  it('renders every route warning as readable text and never a plain green status', async () => {
    const all = Object.keys(WARNING_TEXT) as RouteWarning[];
    const { wrapper } = await mountPopup(currentState({ route: route({ warnings: all }) }));
    const items = wrapper.findAll('[data-warning]');
    expect(items).toHaveLength(all.length);
    for (const w of all) expect(wrapper.find(`[data-warning="${w}"]`).text()).toBe(WARNING_TEXT[w]);
    expect(wrapper.find('[data-test="env-status"]').attributes('data-status')).toBe('warning');
  });

  it('offers 我已关闭旧窗口 for window warnings and confirms first', async () => {
    const { wrapper, calls } = await mountPopup(currentState({ route: route({ warnings: ['old_windows_kept_open'] }) }), {
      acknowledgeWindowsClosed: () => ok({ cleared: true }),
    });
    await wrapper.find('[data-test="ack-windows"]').trigger('click');
    expect(calls.some((m) => m.type === 'acknowledgeWindowsClosed')).toBe(false);
    await wrapper.find('[data-test="confirm-ack-windows"]').trigger('click');
    await flushPromises();
    expect(calls.some((m) => m.type === 'acknowledgeWindowsClosed')).toBe(true);
  });

  it('shows the account-changed notice with 我已核对', async () => {
    const env = environment({ account: { ...environment().account, changedSincePageCheck: true } });
    const { wrapper, calls } = await mountPopup(currentState({ environment: env }), { acknowledgeAccountChange: () => accepted() });
    expect(wrapper.find('[data-test="account-changed"]').text()).toBe('配置账号已更换，网页登录状态未核对');
    await wrapper.find('[data-test="ack-account"]').trigger('click');
    await flushPromises();
    expect(calls.some((m) => m.type === 'acknowledgeAccountChange')).toBe(true);
  });

  it('warns that Amazon pages in a non-active bound profile were not launch-verified', async () => {
    const { wrapper } = await mountPopup(currentState({ relation: 'other_active', route: null }), {}, { windows_open: 1, amazon_tabs_open: true, site_permission_granted: true });
    expect(wrapper.find('[data-test="amazon-unverified"]').text()).toBe('本场景的 Amazon 页面未经启动验证，正按当前路由规则发送请求');
  });

  it('does not show that warning for the active environment', async () => {
    const { wrapper } = await mountPopup(currentState(), {}, { windows_open: 1, amazon_tabs_open: true, site_permission_granted: true });
    expect(wrapper.find('[data-test="amazon-unverified"]').exists()).toBe(false);
  });

  it('hints when the site permission is missing', async () => {
    const { wrapper } = await mountPopup(currentState(), {}, { windows_open: 1, amazon_tabs_open: false, site_permission_granted: false });
    expect(wrapper.find('[data-test="site-permission"]').text()).toContain('www.amazon.com');
  });

  it('disables the orders button with the reason when neither orders nor activation are allowed', async () => {
    const { wrapper } = await mountPopup(
      currentState({ ordersAllowed: false, ordersBlockedReason: '实测出口已过期', activationAvailable: false, activationBlockedReason: '切换出口所需能力尚未通过实测' }),
    );
    const btn = wrapper.find('[data-test="orders"]');
    expect(btn.attributes('disabled')).toBeDefined();
    expect(wrapper.find('[data-test="orders-blocked"]').text()).toBe('实测出口已过期');
    expect(wrapper.find('[data-test="activate"]').attributes('disabled')).toBeDefined();
    expect(wrapper.find('[data-test="activation-blocked"]').text()).toBe('切换出口所需能力尚未通过实测');
  });

  it('explains the controlled entry when orders are not yet allowed but activation is', async () => {
    const { wrapper } = await mountPopup(currentState({ ordersAllowed: false, ordersBlockedReason: '实测出口已过期' }));
    expect(wrapper.find('[data-test="orders"]').attributes('disabled')).toBeUndefined();
    expect(wrapper.find('[data-test="orders-blocked"]').text()).toContain('通过后打开订单页');
  });

  it('shows the pending banner with 继续验证 and cancel', async () => {
    const pending = { operation_id: 'op_w', kind: 'activate' as const, deadline: iso(120) };
    const { wrapper, browser, calls } = await mountPopup(currentState({ pendingVerification: pending }), { cancelOperation: () => accepted('op_w') });
    expect(wrapper.find('[data-test="pending-banner"]').text()).toContain('切换到此环境');
    await wrapper.find('[data-test="continue-verify"]').trigger('click');
    await flushPromises();
    expect(browser.tabs!.create).toHaveBeenCalledWith({ url: 'safari-web-extension://ext-uuid/prepare.html?op=op_w', active: true });
    await wrapper.find('[data-test="cancel-pending"]').trigger('click');
    expect(wrapper.text()).toContain('不会进入普通模式');
    await wrapper.find('[data-test="confirm-cancel"]').trigger('click');
    await flushPromises();
    expect(calls.find((m) => m.type === 'cancelOperation')).toMatchObject({ operation_id: 'op_w' });
  });

  it('confirmation dialog shows both options with consequences and resends on choice', async () => {
    let first = true;
    const { wrapper, calls } = await mountPopup(currentState({ relation: 'other_active', route: null }), {
      activateCurrentEnvironment: () => {
        if (first) {
          first = false;
          return {
            ok: false,
            error: {
              code: 'NEEDS_CONFIRMATION',
              message: '需要确认',
              details: {
                reason: 'other_environment_active',
                currentEnvironmentId: 'env_9',
                currentEnvironmentLabel: 'US-买家09 · E0009',
                otherProfilesOpen: [
                  { profileIdShort: '9b8a7c6d', environmentLabel: null },
                  { profileIdShort: '', environmentLabel: null, unidentified: true },
                ],
                options: ['closed_confirmed', 'keep_open_acknowledged'],
                limitation: '建议保存工作后退出并重开 Safari。',
              },
            },
          };
        }
        return accepted('op_c');
      },
    });
    await wrapper.find('[data-test="activate"]').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('确定要切换到此环境吗？');
    expect(wrapper.find('[data-test="confirm-reason"]').text()).toContain('US-买家09 · E0009');
    // 没有场景 ID 的场景（可能是默认场景）同样列出，不显示为空的场景编号
    expect(wrapper.text()).toContain('场景 9b8a7c6d');
    expect(wrapper.find('[data-test="unidentified-profile"]').text()).toBe('未识别场景（可能是默认场景）');
    expect(wrapper.findAll('li').some((li) => /场景\s*$/.test(li.text()))).toBe(false);
    expect(wrapper.find('[data-test="consequence-closed_confirmed"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="consequence-keep_open_acknowledged"]').text()).toContain('新环境出口');
    expect(wrapper.find('[data-test="confirm-limitation"]').text()).toContain('重开 Safari');
    await wrapper.find('[data-test="choose-closed_confirmed"]').trigger('click');
    await flushPromises();
    const sends = calls.filter((m) => m.type === 'activateCurrentEnvironment');
    expect(sends).toHaveLength(2);
    expect(sends[1]).toMatchObject({ request_id: sends[0]!.request_id, old_session_policy: 'closed_confirmed', confirmed_environment_id: 'env_9' });
  });

  it('only offers 进入普通模式 when there is something to undo', async () => {
    const idle = await mountPopup(currentState({ relation: 'none_active', route: null, routeSummary: { routeEpoch: 1, entryMode: 'NORMAL', phase: 'idle', buyerExitConnectionsUnconfirmed: false, normalModeOffered: false } }));
    expect(idle.wrapper.find('[data-test="normal"]').exists()).toBe(false);
    expect(idle.wrapper.find('[data-test="warnings"]').exists()).toBe(false);
    const blocked = await mountPopup(currentState({ relation: 'none_active', route: null, routeSummary: { routeEpoch: 2, entryMode: 'BLOCKED', phase: 'failed', buyerExitConnectionsUnconfirmed: false, normalModeOffered: true } }));
    expect(blocked.wrapper.find('[data-test="normal"]').exists()).toBe(true);
  });

  it('idle normal mode that could not confirm Safari left the buyer exit: shows the warning and offers 进入普通模式 again', async () => {
    const state = currentState({ relation: 'none_active', route: null, routeSummary: { routeEpoch: 3, entryMode: 'NORMAL', phase: 'idle', buyerExitConnectionsUnconfirmed: true, normalModeOffered: true } });
    const { wrapper, calls } = await mountPopup(state, { enterNormalMode: () => accepted('op_n') });
    expect(wrapper.find('[data-warning="buyer_exit_connections_unconfirmed"]').text()).toBe(WARNING_TEXT.buyer_exit_connections_unconfirmed);
    await wrapper.find('[data-test="normal"]').trigger('click');
    await flushPromises();
    expect(calls.find((m) => m.type === 'enterNormalMode')).toEqual({ type: 'enterNormalMode', request_id: 'req_1' });
  });
});

describe('popup polling lifecycle', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('starts polling on mount and stops on unmount', async () => {
    const { wrapper, calls } = await mountPopup();
    const count = () => calls.filter((m) => m.type === 'getCurrentState').length;
    expect(count()).toBe(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(count()).toBe(3);
    wrapper.unmount();
    wrappers = wrappers.filter((w) => w !== wrapper);
    await vi.advanceTimersByTimeAsync(5000);
    expect(count()).toBe(3);
  });

  it('opening and polling never sends a routing request or opens a page, even with a pending verification', async () => {
    const pending = { operation_id: 'op_w', kind: 'activate' as const, deadline: null };
    const { calls, browser } = await mountPopup(currentState({ pendingVerification: pending, relation: 'other_active', route: null }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(new Set(calls.map((m) => m.type))).toEqual(new Set(['getCurrentState']));
    expect(browser.tabs!.create).not.toHaveBeenCalled();
  });

  it('shows operation progress with steps while polling', async () => {
    const state = currentState({ environment: environment({ lastOperation: { id: 'op_d', kind: 'deploy.publish', phase: 'DEPLOYING', status: 'running', error: null, updatedAt: iso(-1) } }) });
    const { wrapper } = await mountPopup(state, {
      getOperation: () => ok({ ...operationView(), id: 'op_d', kind: 'deploy.publish', phase: 'DEPLOYING', status: 'running', steps: [{ at: iso(-3), phase: 'VALIDATING', message: '候选配置校验通过' }] }),
    });
    await vi.advanceTimersByTimeAsync(1000);
    const box = wrapper.find('[data-test="operation-progress"]');
    expect(box.find('[data-test="operation-phase"]').text()).toBe('正在同步到 Surge');
    expect(box.text()).toContain('候选配置校验通过');
  });

  it('stops polling on pagehide', async () => {
    const { calls } = await mountPopup();
    window.dispatchEvent(new Event('pagehide'));
    const before = calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls.length).toBe(before);
  });
});

function storageSpies() {
  const spies = [
    vi.spyOn(Storage.prototype, 'setItem'),
    vi.spyOn(window.localStorage, 'setItem'),
    vi.spyOn(window.sessionStorage, 'setItem'),
  ];
  const storageSet = vi.fn();
  (globalThis as { browser?: unknown }).browser = { storage: { local: { set: storageSet }, sync: { set: storageSet }, session: { set: storageSet } } };
  return {
    assertUntouched() {
      for (const s of spies) expect(s).not.toHaveBeenCalled();
      expect(storageSet).not.toHaveBeenCalled();
    },
    restore() {
      for (const s of spies) s.mockRestore();
      delete (globalThis as { browser?: unknown }).browser;
    },
  };
}

async function mountEdit(handlers: Parameters<typeof mockClient>[0] = {}) {
  const mc = mockClient({ getCurrentState: () => ok(currentState()), updateCurrentEnvironment: () => accepted('op_u'), ...handlers });
  const controller = createPopupController({ browser: mockBrowser(), client: mc.client, newRequestId: () => 'req_e' });
  await controller.refresh();
  const wrapper = mount(EditForm, { props: { controller, environment: controller.state.current!.environment! }, attachTo: document.body });
  wrappers.push(wrapper);
  return { wrapper, controller, ...mc };
}

describe('edit form secrets', () => {
  it('sends only changed fields with SecretChange keep/replace/clear semantics', async () => {
    const storage = storageSpies();
    const { wrapper, calls } = await mountEdit();
    await wrapper.find('[data-test="edit-host"]').setValue('203.0.113.20');
    // 代理用户名保留（不发送）、代理密码替换、登录密码清除。
    await wrapper.find('[data-test="proxy-password-replace"]').trigger('click');
    await wrapper.find('[data-test="proxy-password-input"]').setValue(SECRET_PROXY_PASSWORD);
    await wrapper.find('[data-test="account-password-clear"]').trigger('click');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    const sent = calls.find((m) => m.type === 'updateCurrentEnvironment');
    expect(sent).toEqual({
      type: 'updateCurrentEnvironment',
      request_id: 'req_e',
      environment_id: 'env_1',
      expected_revision: 5,
      changes: {
        proxy: { host: '203.0.113.20', password: { action: 'replace', value: SECRET_PROXY_PASSWORD } },
        account: { password: { action: 'clear' } },
      },
    });
    expect(wrapper.emitted('saved')).toHaveLength(1);
    storage.assertUntouched();
    storage.restore();
  });

  it('clears secret inputs right after submit, even when saving fails', async () => {
    const { wrapper } = await mountEdit({
      updateCurrentEnvironment: () => ({
        ok: false,
        error: { code: 'UNSAFE_CREDENTIAL_CHARS', message: '保存失败：凭据含有不能安全表达的字符', fieldErrors: [{ field: 'proxy.password', message: '只能包含字母、数字和 . _ ~ -' }] },
      }),
    });
    await wrapper.find('[data-test="proxy-password-replace"]').trigger('click');
    await wrapper.find('[data-test="proxy-password-input"]').setValue(SECRET_PROXY_PASSWORD);
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(wrapper.find('[data-test="form-error"]').text()).toContain('保存失败');
    expect(wrapper.find('[data-test="proxy-password-input"]').exists()).toBe(false);
    expect(wrapper.html()).not.toContain(SECRET_PROXY_PASSWORD);
    expect(wrapper.text()).toContain('只能包含字母、数字和 . _ ~ -');
  });

  it('cancel clears the secret drafts and sends nothing', async () => {
    const { wrapper, calls } = await mountEdit();
    await wrapper.find('[data-test="account-password-replace"]').trigger('click');
    await wrapper.find('[data-test="account-password-input"]').setValue(SECRET_ACCOUNT_PASSWORD);
    await wrapper.find('[data-test="edit-cancel"]').trigger('click');
    expect(wrapper.emitted('close')).toHaveLength(1);
    expect(wrapper.html()).not.toContain(SECRET_ACCOUNT_PASSWORD);
    expect(calls.some((m) => m.type === 'updateCurrentEnvironment')).toBe(false);
  });

  it('refuses to submit when nothing changed', async () => {
    const { wrapper, calls } = await mountEdit();
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(wrapper.find('[data-test="form-error"]').text()).toBe('没有需要保存的修改');
    expect(calls.some((m) => m.type === 'updateCurrentEnvironment')).toBe(false);
  });

  it('replacing the login identifier and clearing the proxy username', async () => {
    const { wrapper, calls } = await mountEdit();
    await wrapper.find('[data-test="login-identifier-replace"]').trigger('click');
    await wrapper.find('[data-test="login-identifier-input"]').setValue('buyer02@example.test');
    await wrapper.find('[data-test="proxy-username-clear"]').trigger('click');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(calls.find((m) => m.type === 'updateCurrentEnvironment')?.changes).toEqual({
      proxy: { username: { action: 'clear' } },
      account: { loginIdentifier: 'buyer02@example.test' },
    });
  });

  it('keeps the revision the form was opened at even after polling sees a newer one', async () => {
    let rev = 5;
    const { wrapper, controller, calls } = await mountEdit({ getCurrentState: () => ok(currentState({ environment: environment({ revision: rev }) })) });
    rev = 6;
    await controller.refresh();
    expect(controller.state.current?.environment?.revision).toBe(6);
    await wrapper.find('[data-test="edit-name"]').setValue('US-买家01-改');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(calls.find((m) => m.type === 'updateCurrentEnvironment')?.expected_revision).toBe(5);
  });

  it('changing only the expected exit IP sends only that field', async () => {
    const { wrapper, calls } = await mountEdit();
    await wrapper.find('[data-test="edit-exit-ip"]').setValue('198.51.100.7');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(calls.find((m) => m.type === 'updateCurrentEnvironment')?.changes).toEqual({ proxy: { expectedExitIp: '198.51.100.7' } });
  });
});

describe('create form secrets', () => {
  async function mountCreate(handlers: Parameters<typeof mockClient>[0] = {}) {
    const mc = mockClient({ getCurrentState: () => ok(currentState({ environment: null, route: null })), createAndBindEnvironment: () => accepted('op_c'), ...handlers });
    const controller = createPopupController({ browser: mockBrowser(), client: mc.client, newRequestId: () => 'req_c' });
    const wrapper = mount(CreateForm, { props: { controller }, attachTo: document.body });
    wrappers.push(wrapper);
    return { wrapper, ...mc };
  }

  it('builds the environment input, sends secrets as replace, and clears them', async () => {
    const storage = storageSpies();
    const { wrapper, calls } = await mountCreate();
    await wrapper.find('[data-test="create-name"]').setValue('US-买家05');
    await wrapper.find('[data-test="create-site"]').setValue('US');
    await wrapper.find('[data-test="create-host"]').setValue('203.0.113.50');
    await wrapper.find('[data-test="create-port"]').setValue('1080');
    await wrapper.find('[data-test="create-proxy-username"]').setValue('synuser');
    await wrapper.find('[data-test="create-proxy-password"]').setValue(SECRET_PROXY_PASSWORD);
    await wrapper.find('[data-test="create-login-identifier"]').setValue('buyer05@example.test');
    await wrapper.find('[data-test="create-account-password"]').setValue(SECRET_ACCOUNT_PASSWORD);
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(calls.find((m) => m.type === 'createAndBindEnvironment')).toEqual({
      type: 'createAndBindEnvironment',
      request_id: 'req_c',
      environment: {
        displayName: 'US-买家05',
        site: 'US',
        autoOpenOrders: true,
        autoFillLogin: false,
        proxy: {
          protocol: 'socks5',
          host: '203.0.113.50',
          port: 1080,
          frontProxyId: null,
          expectedExitIp: null,
          username: { action: 'replace', value: 'synuser' },
          password: { action: 'replace', value: SECRET_PROXY_PASSWORD },
        },
        account: { label: null, loginIdentifier: 'buyer05@example.test', password: { action: 'replace', value: SECRET_ACCOUNT_PASSWORD } },
      },
    });
    expect((wrapper.find('[data-test="create-proxy-password"]').element as HTMLInputElement).value).toBe('');
    expect((wrapper.find('[data-test="create-account-password"]').element as HTMLInputElement).value).toBe('');
    storage.assertUntouched();
    storage.restore();
  });

  it('says the login password is kept by the local service, not in the extension (no Keychain)', async () => {
    const { wrapper } = await mountCreate();
    expect(wrapper.text()).toContain('保存在本机后台，不在扩展中保存。');
    expect(wrapper.text()).not.toContain('钥匙串');
  });

  it('requires an explicit site and a valid port before sending', async () => {
    const { wrapper, calls } = await mountCreate();
    await wrapper.find('[data-test="create-name"]').setValue('US-买家05');
    await wrapper.find('[data-test="create-host"]').setValue('203.0.113.50');
    await wrapper.find('[data-test="create-port"]').setValue('99999');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(wrapper.text()).toContain('站点必须明确选择');
    expect(wrapper.text()).toContain('端口必须是 1–65535 的整数');
    expect(calls.some((m) => m.type === 'createAndBindEnvironment')).toBe(false);
  });

  it('closing the form clears typed secrets', async () => {
    const { wrapper } = await mountCreate();
    await wrapper.find('[data-test="create-proxy-password"]').setValue(SECRET_PROXY_PASSWORD);
    await wrapper.find('[data-test="create-cancel"]').trigger('click');
    expect((wrapper.find('[data-test="create-proxy-password"]').element as HTMLInputElement).value).toBe('');
    expect(wrapper.emitted('close')).toHaveLength(1);
  });
});
