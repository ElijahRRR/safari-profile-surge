import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick } from 'vue';
import EnvironmentsView from '../src/views/EnvironmentsView.vue';
import SettingsPageView from '../src/views/SettingsPageView.vue';
import BindingWizardView from '../src/views/BindingWizardView.vue';
import OverviewView from '../src/views/OverviewView.vue';
import RouteActionHost from '../src/components/RouteActionHost.vue';
import RouteCard from '../src/components/RouteCard.vue';
import AppLayout from '../src/components/AppLayout.vue';
import { byText, click, environment, flush, mountWith, operation, route, snapshot, testContext, type Call } from './fixtures';

afterEach(() => {
  document.body.innerHTML = '';
});

const NOT_FOUND = { status: 404, body: { error: { code: 'NOT_FOUND', message: '找不到' } } };

describe('environments page', () => {
  it('renders one row per environment with readiness badge and design-system cells', async () => {
    const { ctx } = testContext(() => NOT_FOUND, snapshot({ environments: [environment({ readiness: 'active' }), environment({ id: 'env_2', code: 'E0002', displayName: 'US-买家02', readiness: 'sync_failed' })] }));
    const m = await mountWith(EnvironmentsView, ctx, {}, '/environments');
    const rows = document.body.querySelectorAll('[data-test="env-table"] tbody tr');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.querySelector('.code')?.textContent).toBe('E0001');
    expect(rows[0]!.querySelector('[data-readiness="active"]')?.className).toContain('badge-success');
    expect(rows[1]!.querySelector('[data-readiness="sync_failed"]')?.className).toContain('badge-danger');
    expect(document.body.querySelector('[data-test="env-table"] th')?.className).toContain('px-3');
    for (const btn of rows[0]!.querySelectorAll('button')) expect(btn.getAttribute('aria-label')).toBeTruthy();
    m.unmount();
  });

  it('filters by tab and search', async () => {
    const { ctx } = testContext(() => NOT_FOUND, snapshot({
      environments: [
        environment({ readiness: 'active' }),
        environment({ id: 'env_2', code: 'E0002', displayName: 'US-买家02', binding: { state: 'unbound', stage: null, profileIdShort: null, boundAt: null, sitePermissionGranted: null } }),
      ],
    }));
    const m = await mountWith(EnvironmentsView, ctx, {}, '/environments');
    click(byText('button.tab', '待关联'));
    await flush();
    expect(document.body.querySelectorAll('[data-test="env-table"] tbody tr')).toHaveLength(1);
    expect(document.body.querySelector('[data-test="env-table"] tbody')?.textContent).toContain('US-买家02');
    click(byText('button.tab', '全部'));
    const search = document.body.querySelector<HTMLInputElement>('input[aria-label="搜索环境"]')!;
    search.value = 'E0001';
    search.dispatchEvent(new Event('input'));
    await flush();
    expect(document.body.querySelectorAll('[data-test="env-table"] tbody tr')).toHaveLength(1);
    expect(document.body.querySelector('[data-test="env-table"] tbody')?.textContent).toContain('US-买家01');
    m.unmount();
  });

  it('deleting an environment in use explains to enter normal mode first instead of deleting', async () => {
    const { ctx, calls } = testContext(() => NOT_FOUND, snapshot({ route: route({ activeEnvironmentId: 'env_1', entryMode: 'ACTIVE', phase: 'active_verified' }) }));
    const m = await mountWith(EnvironmentsView, ctx, {}, '/environments');
    click(document.body.querySelector('button[aria-label^="更多操作"]'));
    await flush();
    click(byText('[role="menuitem"]', '删除'));
    await flush();
    expect(document.body.textContent).toContain('正在使用或正在验证，不能删除');
    expect(document.body.textContent).toContain('请先进入普通模式');
    expect(byText('.modal-footer button', '进入普通模式')).not.toBeNull();
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    m.unmount();
  });

  it('handles a 409 ENVIRONMENT_ACTIVE from the service with the same explanation', async () => {
    const { ctx, calls } = testContext(
      (c: Call) => (c.method === 'POST' && c.url.endsWith('/unbind') ? { status: 409, body: { error: { code: 'ENVIRONMENT_ACTIVE', message: '解除绑定失败：环境正在使用' } } } : NOT_FOUND),
      snapshot(),
    );
    const m = await mountWith(EnvironmentsView, ctx, {}, '/environments');
    click(document.body.querySelector('button[aria-label^="更多操作"]'));
    await flush();
    click(byText('[role="menuitem"]', '解除绑定'));
    await flush();
    expect(document.body.textContent).toContain('确定要解除 US-买家01 · E0001 与 Safari 场景的绑定吗？');
    const confirm = document.body.querySelector<HTMLButtonElement>('.modal-footer [data-test="confirm"]')!;
    expect(confirm.className).toContain('btn-danger');
    click(confirm);
    await flush();
    const call = calls.find((c) => c.url === '/api/environments/env_1/unbind');
    expect(call?.body).toEqual({ request_id: expect.any(String), expected_revision: 3 });
    expect(document.body.textContent).toContain('不能解除绑定');
    m.unmount();
  });

  it('delete sends request_id + expected_revision after a btn-danger confirmation', async () => {
    const { ctx, calls } = testContext(
      (c: Call) => (c.method === 'DELETE' ? { status: 202, body: { operation_id: 'op_3', environment_id: 'env_1', revision: null, duplicate: false } } : NOT_FOUND),
      snapshot(),
    );
    const m = await mountWith(EnvironmentsView, ctx, {}, '/environments');
    click(document.body.querySelector('button[aria-label^="更多操作"]'));
    await flush();
    click(byText('[role="menuitem"]', '删除'));
    await flush();
    expect(document.body.textContent).toContain('确定要删除环境 US-买家01 · E0001 吗？');
    click(document.body.querySelector('.modal-footer [data-test="confirm"]'));
    await flush();
    expect(calls.find((c) => c.method === 'DELETE')?.body).toEqual({ request_id: expect.stringMatching(/^web-/), expected_revision: 3 });
    m.unmount();
  });

  it('opening the edit dialog never puts secrets into the page', async () => {
    const { ctx } = testContext(
      (c: Call) => (c.url === '/api/environments/env_1/account' ? { status: 200, body: { environment_id: 'env_1', label: 'buyer01', loginIdentifier: 'buyer01@example.test', hasPassword: true } } : NOT_FOUND),
      snapshot(),
    );
    const m = await mountWith(EnvironmentsView, ctx, {}, '/environments');
    click(document.body.querySelector('[data-test="edit-env"]'));
    await flush();
    expect(document.body.querySelector('[data-test="env-form"]')).not.toBeNull();
    expect(document.body.querySelectorAll('input[type="password"]')).toHaveLength(0);
    m.unmount();
  });
});

describe('settings page', () => {
  it('disables the verify endpoint select unless the entry mode is NORMAL and shows read-only paths', async () => {
    const { ctx } = testContext(() => NOT_FOUND, snapshot({ route: route({ entryMode: 'ACTIVE', activeEnvironmentId: 'env_1' }) }));
    const m = await mountWith(SettingsPageView, ctx, {}, '/settings');
    const select = document.body.querySelector<HTMLButtonElement>('[data-test="verify-endpoint"] .select-trigger')!;
    expect(select.disabled).toBe(true);
    expect(document.body.textContent).toContain('只能在普通模式下修改');
    const ro = document.body.querySelector('[data-test="readonly-settings"]')!;
    expect(ro.textContent).toContain('临时规则（temp_rule）');
    expect(ro.textContent).toContain('com.apple.WebKit.Networking');
    expect(ro.textContent).toContain('surge-cli');
    expect(ro.querySelectorAll('input')).toHaveLength(0);
    m.unmount();
  });

  it('enables the verify endpoint in NORMAL and saves only changed fields', async () => {
    const { ctx, calls } = testContext((c: Call) => (c.method === 'PATCH' ? { status: 200, body: { ...snapshot().settings, probeTtlSec: 600 } } : NOT_FOUND), snapshot());
    const m = await mountWith(SettingsPageView, ctx, {}, '/settings');
    expect(document.body.querySelector<HTMLButtonElement>('[data-test="verify-endpoint"] .select-trigger')!.disabled).toBe(false);
    const ttl = Array.from(document.body.querySelectorAll<HTMLInputElement>('input.input')).find((i) => i.value === '900')!;
    ttl.value = '600';
    ttl.dispatchEvent(new Event('input'));
    await nextTick();
    click(document.body.querySelector('[data-test="settings-save"]'));
    await flush();
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ request_id: expect.any(String), probeTtlSec: 600 });
    m.unmount();
  });
});

describe('binding wizard', () => {
  it('lists pending environments with step progress and records the confirmed stage', async () => {
    const unbound = environment({ binding: { state: 'unbound', stage: 'awaiting_extension', profileIdShort: null, boundAt: null, sitePermissionGranted: null } });
    const { ctx, calls } = testContext(
      (c: Call) => (c.method === 'PATCH' ? { status: 202, body: { operation_id: 'op_5', environment_id: 'env_1', revision: 4, duplicate: false } } : NOT_FOUND),
      snapshot({ environments: [unbound] }),
    );
    const m = await mountWith(BindingWizardView, ctx, {}, '/binding');
    const steps = document.body.querySelectorAll('[data-test="binding-steps"] [data-step-state]');
    expect(Array.from(steps).map((s) => s.getAttribute('data-step-state'))).toEqual(['done', 'current', 'current', 'upcoming']);
    expect(steps[0]!.textContent).toContain('在 Safari 中创建名为「US-买家01」的场景');
    expect(steps[2]!.textContent).toContain('www.amazon.com');
    expect(document.body.textContent).toContain('1 / 4 步');
    click(document.body.querySelector('[data-test="mark-step"]'));
    await flush();
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ request_id: expect.any(String), expected_revision: 3, changes: { bindingStage: 'awaiting_association' } });
    m.unmount();
  });
});

describe('overview and route card', () => {
  it('renders every route warning as readable text and never a green state while warnings exist', async () => {
    const { ctx } = testContext(() => NOT_FOUND, snapshot({
      route: route({ activeEnvironmentId: 'env_1', entryMode: 'ACTIVE', phase: 'active_verified', warnings: ['old_windows_kept_open', 'launch_unverified', 'takeover_unknown'] }),
    }));
    const m = await mountWith(RouteCard, ctx);
    const card = document.body.querySelector('[data-test="route-card"]')!;
    expect(card.textContent).toContain('旧环境窗口未关闭，其后续请求将使用当前出口');
    expect(card.textContent).toContain('本次打开未经启动验证');
    expect(card.textContent).toContain('接管状态无法读取');
    expect(card.querySelector('.card-header .bg-green-500')).toBeNull();
    expect(card.querySelector('[data-test="ack-windows"]')).not.toBeNull();
    m.unmount();
  });

  it('「我已关闭旧窗口」 asks for confirmation and only acknowledges the warning', async () => {
    const { ctx, calls } = testContext(
      (c: Call) => (c.url === '/api/routing/acknowledge-windows' ? { status: 202, body: { operation_id: 'op_8', environment_id: null, revision: null, duplicate: false } } : NOT_FOUND),
      snapshot({ route: route({ entryMode: 'NORMAL', warnings: ['managed_windows_on_original_rules'] }) }),
    );
    const Page = defineComponent({ render: () => [h(RouteCard), h(RouteActionHost)] });
    const m = await mountWith(Page, ctx);
    expect(document.body.textContent).toContain('旧环境窗口未关闭，其后续请求将按 Surge 原规则发出（可能直连）');
    click(document.body.querySelector('[data-test="ack-windows"]'));
    await flush();
    expect(document.body.textContent).toContain('确定旧环境的 Safari 窗口都已关闭吗？');
    click(document.body.querySelector('.modal-footer [data-test="confirm"]'));
    await flush();
    expect(calls.map((c) => c.url)).toEqual(['/api/routing/acknowledge-windows']);
    m.unmount();
  });

  it('shows the stat cards and an expired probe as 上次结果', async () => {
    const probe = {
      id: 'p1', kind: 'safari' as const, outcome: 'ok' as const, exitIp: '192.0.2.44', proxyRevision: 1, nodeName: 'SFE-N-E0001-US01-v001',
      routeEpoch: 1, configurationGeneration: 4, entryMode: 'VERIFY_ONLY' as const, testId: null, surgeRequest: null, chainEvidence: null, browser: null,
      observedAt: '2026-10-21T07:00:00.000Z', expiresAt: '2026-10-21T07:15:00.000Z', message: null,
    };
    const { ctx } = testContext(() => NOT_FOUND, snapshot({
      environments: [environment({ readiness: 'active' })],
      route: route({ activeEnvironmentId: 'env_1', entryMode: 'ACTIVE', phase: 'active_verified', lastSafariProbe: probe, warnings: ['probe_expired'] }),
      pendingOperations: [operation({ status: 'succeeded', phase: 'ACTIVE_VERIFIED' })],
    }));
    const m = await mountWith(OverviewView, ctx);
    const values = Array.from(document.body.querySelectorAll('.stat-card .stat-value')).map((e) => e.textContent);
    expect(values).toEqual(['1', '1', '0', '0']);
    expect(document.body.querySelector('[data-test="route-card"]')?.textContent).toContain('上次结果');
    expect(document.body.querySelector('[data-test="surge-card"]')?.textContent).toContain('规则模式');
    expect(document.body.querySelector('[data-test="gate-card"]')?.textContent).toContain('受阻');
    m.unmount();
  });
});

describe('header normal-mode entry', () => {
  it('is offered while a managed environment is active and uses the confirmation flow', async () => {
    const { ctx, calls } = testContext(
      (c: Call) =>
        c.url === '/api/routing/normal'
          ? { status: 409, body: { error: { code: 'NEEDS_CONFIRMATION', message: '需要确认', details: { reason: 'managed_environment_active', currentEnvironmentId: 'env_1', currentEnvironmentLabel: 'US-买家01 · E0001', otherProfilesOpen: [], options: ['closed_confirmed', 'keep_open_acknowledged'], limitation: null } } } }
          : NOT_FOUND,
      snapshot({ route: route({ activeEnvironmentId: 'env_1', entryMode: 'ACTIVE', phase: 'active_verified' }) }),
    );
    const Page = defineComponent({ render: () => [h(AppLayout), h(RouteActionHost)] });
    const m = await mountWith(Page, ctx);
    click(document.body.querySelector('[data-test="header-normal-mode"]'));
    await flush();
    expect(calls.find((c) => c.url === '/api/routing/normal')?.body).toEqual({ request_id: expect.any(String) });
    const dialog = document.body.querySelector('[data-test="route-confirm"]')!;
    expect(dialog.textContent).toContain('不关闭，直接进入普通模式');
    expect(dialog.textContent).toContain('按 Surge 原规则发出（可能直连）');
    expect(dialog.querySelector('[data-test="limitation"]')).toBeNull();
    m.unmount();
  });

  it('is hidden when Safari already follows the original rules', async () => {
    const { ctx } = testContext(() => NOT_FOUND, snapshot());
    const m = await mountWith(AppLayout, ctx);
    expect(document.body.querySelector('[data-test="header-normal-mode"]')).toBeNull();
    expect(document.body.querySelector('header.glass')).not.toBeNull();
    m.unmount();
  });
});

describe('operation progress without the event stream', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('polls the operation while the stream is down and stops once it is back', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let reads = 0;
    const { ctx } = testContext((c: Call) => {
      if (c.url === '/api/operations/op_1') {
        reads++;
        return { status: 200, body: operation() };
      }
      return NOT_FOUND;
    }, snapshot({ pendingOperations: [operation()] }));
    ctx.store.state.stream = 'reconnecting';
    const m = await mountWith(RouteActionHost, ctx);
    ctx.viewer.open('op_1', 'US-买家01');
    await flush();
    expect(reads).toBe(1);
    vi.advanceTimersByTime(3000);
    await flush();
    expect(reads).toBe(2);
    ctx.store.state.stream = 'open';
    await flush();
    vi.advanceTimersByTime(9000);
    await flush();
    expect(reads).toBe(2);
    m.unmount();
  });
});
