import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick } from 'vue';
import type { InitPreviewResponse, ProbeView } from '@sfe/contract';
import EnvironmentsView from '../src/views/EnvironmentsView.vue';
import OperationsView from '../src/views/OperationsView.vue';
import SettingsPageView from '../src/views/SettingsPageView.vue';
import BindingWizardView from '../src/views/BindingWizardView.vue';
import OverviewView from '../src/views/OverviewView.vue';
import PublishView from '../src/views/PublishView.vue';
import InitWizardCard from '../src/components/InitWizardCard.vue';
import RouteActionHost from '../src/components/RouteActionHost.vue';
import RouteCard from '../src/components/RouteCard.vue';
import AppLayout from '../src/components/AppLayout.vue';
import { byText, click, environment, flush, mountWith, nodeResource, operation, route, snapshot, snapshotWithNodeResource, testContext, type Call } from './fixtures';

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

  it('falls back to the last page when rows leave the current page instead of showing an empty table', async () => {
    const envs = Array.from({ length: 21 }, (_, i) => environment({ id: `env_${i + 1}`, code: `E${String(i + 1).padStart(4, '0')}`, displayName: `US-买家${i + 1}` }));
    const { ctx } = testContext(() => NOT_FOUND, snapshot({ environments: envs }));
    const m = await mountWith(EnvironmentsView, ctx, {}, '/environments');
    click(document.body.querySelector('nav[aria-label="分页"] button[aria-label="下一页"]'));
    await flush();
    expect(document.body.querySelectorAll('[data-test="env-table"] tbody tr')).toHaveLength(1);
    // 第 2 页唯一的一行在别处被删除
    ctx.store.applyEvent({ type: 'environment.deleted', sequence: 11, environmentId: 'env_21' });
    await flush();
    expect(document.body.querySelectorAll('[data-test="env-table"] tbody tr')).toHaveLength(20);
    expect(document.body.textContent).not.toContain('没有符合条件的环境');
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
    expect(document.body.textContent).toContain('账号密码从本机后台资料中删除');
    expect(document.body.textContent).not.toContain('钥匙串');
    click(document.body.querySelector('.modal-footer [data-test="confirm"]'));
    await flush();
    expect(calls.find((c) => c.method === 'DELETE')?.body).toEqual({ request_id: expect.stringMatching(/^web-/), expected_revision: 3 });
    m.unmount();
  });

  it('a corrected password resubmitted after a lost response is refused by the service (same request_id): the dialog says the earlier save took effect and this one did not, never "修改已保存"', async () => {
    let puts = 0;
    const { ctx, calls } = testContext((c: Call) => {
      if (c.url === '/api/environments/env_1/account') return { status: 200, body: { environment_id: 'env_1', label: 'buyer01', loginIdentifier: 'buyer01@example.test', hasPassword: true } };
      if (c.method !== 'GET' && c.url === '/api/environments/env_1') {
        puts++;
        if (puts === 1) throw new TypeError('Failed to fetch');
        return { status: 409, body: { error: { code: 'DUPLICATE_REQUEST_MISMATCH', message: '请求失败：request_id 已用于内容不同的请求' } } };
      }
      return NOT_FOUND;
    }, snapshot());
    const m = await mountWith(EnvironmentsView, ctx, {}, '/environments');
    click(document.body.querySelector('[data-test="edit-env"]'));
    await flush();
    const secret = () => document.body.querySelector<HTMLElement>('[data-secret="账号密码"]')!;
    const type = async (value: string) => {
      const el = secret().querySelector<HTMLInputElement>('input')!;
      el.value = value;
      el.dispatchEvent(new Event('input'));
      await nextTick();
    };
    secret().querySelector<HTMLButtonElement>('[data-action="replace"]')!.click();
    await nextTick();
    await type('P1-typo');
    click(document.body.querySelector('[data-test="env-save"]'));
    await flush();
    expect(document.body.querySelector('[data-test="env-form"]')).not.toBeNull();
    await type('P2-correct');
    click(document.body.querySelector('[data-test="env-save"]'));
    await flush();
    const sent = calls.filter((c) => c.url === '/api/environments/env_1' && c.method !== 'GET').map((c) => c.body as { request_id: string });
    expect(sent).toHaveLength(2);
    expect(sent[1]!.request_id).toBe(sent[0]!.request_id);
    const form = document.body.querySelector('[data-test="env-form"]');
    expect(form).not.toBeNull();
    expect(form!.textContent).toContain('之前一次提交（例如连接中断或服务重新启动之前）已经生效，这次的修改没有保存');
    expect(document.body.textContent).not.toContain('修改已保存');
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

describe('operations page', () => {
  it('falls back to the last page when operations leave the 进行中 filter', async () => {
    const ops = Array.from({ length: 21 }, (_, i) => operation({ id: `op_${i}`, createdAt: `2026-10-21T08:${String(i).padStart(2, '0')}:00.000Z` }));
    const { ctx } = testContext((c: Call) => (c.url.startsWith('/api/operations?') ? { status: 200, body: ops } : NOT_FOUND), snapshot({ pendingOperations: ops }));
    const m = await mountWith(OperationsView, ctx, {}, '/operations');
    await flush();
    click(byText('button.tab', '进行中'));
    await flush();
    click(document.body.querySelector('nav[aria-label="分页"] button[aria-label="下一页"]'));
    await flush();
    expect(document.body.querySelectorAll('tbody tr')).toHaveLength(1);
    // 第 2 页上最早的操作结束，离开「进行中」
    ctx.store.applyEvent({ type: 'operation.updated', sequence: 11, operation: { ...ops[0]!, status: 'succeeded', phase: 'ACTIVE_VERIFIED', updatedAt: '2026-10-21T09:00:00.000Z' } });
    await flush();
    expect(document.body.querySelectorAll('tbody tr')).toHaveLength(20);
    expect(document.body.textContent).not.toContain('没有符合条件的操作');
    m.unmount();
  });
});

describe('settings page', () => {
  it('disables the verify endpoint select unless the entry mode is NORMAL and shows read-only paths', async () => {
    const { ctx } = testContext(() => NOT_FOUND, snapshot({ route: route({ entryMode: 'ACTIVE', activeEnvironmentId: 'env_1' }) }));
    const m = await mountWith(SettingsPageView, ctx, {}, '/settings');
    const select = document.body.querySelector<HTMLButtonElement>('[data-test="verify-endpoint"] .select-trigger')!;
    expect(select.disabled).toBe(true);
    expect(document.body.textContent).toContain('只能在空闲的普通模式下修改');
    const ro = document.body.querySelector('[data-test="readonly-settings"]')!;
    expect(ro.textContent).toContain('临时规则（temp_rule）');
    expect(ro.textContent).toContain('com.apple.WebKit.Networking');
    expect(ro.textContent).toContain('surge-cli');
    expect(ro.querySelectorAll('input')).toHaveLength(0);
    m.unmount();
  });

  it('disables the verify endpoint while the route is NORMAL but not idle (same rule as the service)', async () => {
    const { ctx } = testContext(() => NOT_FOUND, snapshot({ route: route({ entryMode: 'NORMAL', phase: 'failed', activeEnvironmentId: null }) }));
    const m = await mountWith(SettingsPageView, ctx, {}, '/settings');
    expect(document.body.querySelector<HTMLButtonElement>('[data-test="verify-endpoint"] .select-trigger')!.disabled).toBe(true);
    expect(document.body.textContent).toContain('只能在空闲的普通模式下修改');
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
    // Safari 17 起网站授权对所有场景共用，只有扩展开关按场景分开；默认场景可能没有场景 ID
    expect(steps[2]!.textContent).toContain('Safari 17 起网站授权对所有场景共用');
    expect(steps[2]!.textContent).not.toContain('只申请这一个站点');
    expect(steps[1]!.textContent).toContain('新场景的扩展默认关闭，每个场景都要单独启用');
    expect(steps[0]!.textContent).toContain('不要使用默认场景');
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

describe('overview reconcile time', () => {
  it('uses the latest surge check when route.updated was not re-sent by an unchanged reconcile', async () => {
    const snap = snapshot({ route: route({ lastReconciledAt: '2026-10-21T07:20:00.000Z' }) });
    const { ctx } = testContext(() => NOT_FOUND, { ...snap, surge: { ...snap.surge, lastCheckedAt: '2026-10-21T08:00:30.000Z' } });
    const m = await mountWith(OverviewView, ctx);
    expect(document.body.querySelector('.page-description')?.textContent).toContain('最近对账于 30 秒前');
    m.unmount();
  });
});

describe('route card control state', () => {
  const probe = (expiresAt: string): ProbeView => ({
    id: 'p1', kind: 'safari', outcome: 'ok', exitIp: '192.0.2.44', proxyRevision: 1, nodeName: 'SFE-N-E0001-US01-v001',
    routeEpoch: 1, configurationGeneration: 4, entryMode: 'VERIFY_ONLY', testId: null, surgeRequest: null, chainEvidence: null, browser: null,
    observedAt: '2026-10-21T07:45:00.000Z', expiresAt, message: null,
  });

  it('never shows a green 受控 once the probe is shown as expired, even before the reconcile adds probe_expired', async () => {
    // 本机时钟 08:01；实测 08:00:30 过期，服务端还没对账，warnings 为空
    const { ctx } = testContext(() => NOT_FOUND, snapshot({
      environments: [environment({ readiness: 'active' })],
      route: route({ activeEnvironmentId: 'env_1', entryMode: 'ACTIVE', phase: 'active_verified', lastSafariProbe: probe('2026-10-21T08:00:30.000Z'), warnings: [] }),
    }));
    const m = await mountWith(RouteCard, ctx);
    const card = document.body.querySelector('[data-test="route-card"]')!;
    expect(card.textContent).toContain('上次结果');
    expect(card.querySelector('.bg-green-500')).toBeNull();
    expect(card.querySelector('.card-header .bg-yellow-500')).not.toBeNull();
    expect(card.querySelector('.card-header')?.textContent).not.toContain('受控');
    expect(card.querySelector('[data-warning="probe_expired"]')?.textContent).toContain('Safari 实测已过期');
    const entry = card.querySelector('[data-test="entry-badge"]')!;
    expect(entry.className).toContain('badge-warning');
    expect(entry.textContent).toBe('受控（实测已过期）');
    m.unmount();
  });

  it('shows 受控 in green only while the probe is ok and unexpired', async () => {
    const { ctx } = testContext(() => NOT_FOUND, snapshot({
      environments: [environment({ readiness: 'active' })],
      route: route({ activeEnvironmentId: 'env_1', entryMode: 'ACTIVE', phase: 'active_verified', lastSafariProbe: probe('2026-10-21T08:15:00.000Z'), warnings: [] }),
    }));
    const m = await mountWith(RouteCard, ctx);
    const card = document.body.querySelector('[data-test="route-card"]')!;
    expect(card.querySelector('.card-header .bg-green-500')).not.toBeNull();
    expect(card.querySelector('.card-header')?.textContent).toContain('受控');
    expect(card.querySelector('[data-test="entry-badge"]')?.className).toContain('badge-success');
    expect(card.querySelector('[data-warning]')).toBeNull();
    m.unmount();
  });

  it('labels the cancel action with its effect, never a bare 取消', async () => {
    const { ctx } = testContext(() => NOT_FOUND, snapshot({
      route: route({ operationId: 'op_9', phase: 'active_verified', entryMode: 'ACTIVE', activeEnvironmentId: 'env_1' }),
      pendingOperations: [operation({ id: 'op_9', kind: 'deploy.publish', phase: 'WAITING_ROUTE', status: 'waiting' })],
    }));
    const m = await mountWith(RouteCard, ctx);
    expect(document.body.querySelector('[data-test="route-cancel"]')?.textContent?.trim()).toBe('取消等待');
    m.unmount();
  });

  it('an active-environment publish waiting in VERIFY_ONLY after its switch can be cancelled from the route card and the operation dialog, like an activation (same as the popup)', async () => {
    for (const kind of ['environment.update', 'deploy.publish'] as const) {
      const op = operation({ id: 'op_9', kind, phase: 'VERIFY_ONLY', status: 'waiting' });
      const { ctx } = testContext((c: Call) => (c.url === '/api/operations/op_9' ? { status: 200, body: op } : NOT_FOUND), snapshot({
        route: route({ operationId: 'op_9', phase: 'awaiting_safari_verify', entryMode: 'VERIFY_ONLY', activeEnvironmentId: 'env_1' }),
        pendingOperations: [op],
      }));
      const card = await mountWith(RouteCard, ctx);
      expect(document.body.querySelector('[data-test="route-cancel"]')?.textContent?.trim()).toBe('取消切换');
      expect(document.body.querySelector('[data-test="route-cancel-note"]')?.textContent).toContain('取消会尝试恢复原节点并保持 Safari 阻断');
      card.unmount();
      const host = await mountWith(RouteActionHost, ctx);
      ctx.viewer.open('op_9', 'US-买家01');
      await flush();
      expect(document.body.querySelector('[data-test="cancel-operation"]')?.textContent?.trim()).toBe('取消切换');
      host.unmount();
    }
  });

  it('the operation dialog keeps 关闭 for dismissing and names the cancel action', async () => {
    const op = operation({ status: 'waiting' });
    const { ctx } = testContext((c: Call) => (c.url === '/api/operations/op_1' ? { status: 200, body: op } : NOT_FOUND), snapshot({ pendingOperations: [op] }));
    const m = await mountWith(RouteActionHost, ctx);
    ctx.viewer.open('op_1', 'US-买家01');
    await flush();
    const footer = Array.from(document.body.querySelectorAll('.modal-footer button')).map((b) => b.textContent?.trim());
    expect(footer).toContain('关闭');
    expect(footer).not.toContain('取消');
    expect(document.body.querySelector('[data-test="cancel-operation"]')?.textContent?.trim()).toBe('取消切换');
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

  it('is offered, with the route card button, after a normal mode that could not confirm Safari left the buyer exit (idle NORMAL with buyer_exit_connections_unconfirmed)', async () => {
    const { ctx, calls } = testContext(
      (c: Call) => (c.url === '/api/routing/normal' ? { status: 202, body: { operation_id: 'op_n', environment_id: null, revision: null, duplicate: false } } : NOT_FOUND),
      snapshot({ route: route({ entryMode: 'NORMAL', phase: 'idle', activeEnvironmentId: null, warnings: ['buyer_exit_connections_unconfirmed'] }) }),
    );
    const Page = defineComponent({ render: () => [h(AppLayout), h(RouteCard), h(RouteActionHost)] });
    const m = await mountWith(Page, ctx);
    const card = document.body.querySelector('[data-test="route-card"]')!;
    expect(card.textContent).toContain('未能确认 Safari 已没有经买家出口的连接');
    expect(card.querySelector('.card-header')?.textContent).toContain('需要处理');
    expect(byText('[data-test="route-card"] .card-footer button', '进入普通模式')).not.toBeNull();
    click(document.body.querySelector('[data-test="header-normal-mode"]'));
    await flush();
    expect(calls.filter((c) => c.url === '/api/routing/normal').map((c) => c.body)).toEqual([{ request_id: expect.any(String) }]);
    m.unmount();
  });

  it.each([
    ['NORMAL with phase attention after a failed rollback (entry_unverified only)', { entryMode: 'NORMAL' as const, phase: 'attention' as const, warnings: ['entry_unverified' as const], normalModeOffered: true }],
    ['idle NORMAL after a failed normal mode, persistent marker only (server flag)', { entryMode: 'NORMAL' as const, phase: 'idle' as const, warnings: [], normalModeOffered: true }],
  ])('is offered in the header and on the route card: %s', async (_name, over) => {
    const { ctx, calls } = testContext(
      (c: Call) => (c.url === '/api/routing/normal' ? { status: 202, body: { operation_id: 'op_n', environment_id: null, revision: null, duplicate: false } } : NOT_FOUND),
      snapshot({ route: route({ activeEnvironmentId: null, ...over }) }),
    );
    const Page = defineComponent({ render: () => [h(AppLayout), h(RouteCard), h(RouteActionHost)] });
    const m = await mountWith(Page, ctx);
    expect(byText('[data-test="route-card"] .card-footer button', '进入普通模式')).not.toBeNull();
    expect(document.body.querySelector('[data-test="route-card"] .card-header')?.textContent).not.toMatch(/普通模式(?!（未确认）)/);
    click(document.body.querySelector('[data-test="header-normal-mode"]'));
    await flush();
    expect(calls.filter((c) => c.url === '/api/routing/normal').map((c) => c.body)).toEqual([{ request_id: expect.any(String) }]);
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

describe('init wizard', () => {
  const initPreview: InitPreviewResponse = {
    preview_digest: 'hmac:init-1',
    sourceProfileName: '默认',
    sourceProfilePath: '/Users/test/Library/Application Support/Surge/Profiles/默认.conf',
    workingProfilePath: '/Users/test/Library/Application Support/Surge/Profiles/日常-Safari环境.conf',
    backupDirectory: '/Users/test/Library/Application Support/SafariProfileSurge/backups/init',
    managedDiff: '',
    referencedFiles: [],
    managedConfigDetected: false,
    profileDirectoryRisk: 'none',
    autoReloadEnabled: false,
    takeover: { enhancedMode: true, systemProxy: false, outboundMode: 'rule', checkedAt: '2026-10-21T08:00:00.000Z' },
    httpApi: { configured: false, loopbackOnly: null },
    remoteSources: [],
    remoteUpdatesNotice: null,
    checks: [],
    nameCollisions: [],
  };
  const initOp = operation({ id: 'op_init', kind: 'maintenance.init', phase: 'VALIDATING', status: 'running', environmentId: null, steps: [] });

  async function commitInit() {
    const { ctx, calls } = testContext((c: Call) => {
      if (c.url === '/api/maintenance/init/preview') return { status: 200, body: initPreview };
      if (c.url === '/api/maintenance/init/commit') return { status: 202, body: { operation_id: 'op_init', environment_id: null, revision: null, duplicate: false } };
      if (c.url === '/api/operations/op_init') return { status: 200, body: initOp };
      return NOT_FOUND;
    }, snapshot());
    const m = await mountWith(InitWizardCard, ctx);
    click(byText('button', '生成预览'));
    await flush();
    click(document.body.querySelector('[data-test="init-commit"]'));
    await flush();
    return { ctx, calls, m };
  }

  it('202 only shows progress; the next-step notice waits for the operation to succeed', async () => {
    const { ctx, calls, m } = await commitInit();
    expect(calls.find((c) => c.url === '/api/maintenance/init/commit')?.body).toEqual({ request_id: expect.any(String), preview_digest: 'hmac:init-1' });
    expect(document.body.querySelector('[data-test="init-running"]')).not.toBeNull();
    expect(document.body.querySelector('[data-test="init-done"]')).toBeNull();
    ctx.store.applyEvent({ type: 'operation.updated', sequence: 11, operation: { ...initOp, phase: 'COMPLETED', status: 'succeeded', updatedAt: '2026-10-21T08:02:00.000Z' } });
    await flush();
    expect(document.body.querySelector('[data-test="init-done"]')?.textContent).toContain('日常-Safari环境');
    m.unmount();
  });

  it('the manual-switch instruction outlives the wizard once the server records the working profile', async () => {
    // 成功时服务端连续发出 operation.updated(succeeded)、surge.status、settings.updated（已设置 workingProfilePath）；
    // 初始化卡片随之卸载，下一步提示必须仍然可见。
    const base = snapshot();
    const before = snapshot({
      settings: { ...base.settings, workingProfilePath: null },
      surge: { ...base.surge, currentProfileName: '默认', onWorkingProfile: null },
    });
    const { ctx } = testContext((c: Call) => {
      if (c.url === '/api/maintenance/init/preview') return { status: 200, body: initPreview };
      if (c.url === '/api/maintenance/init/commit') return { status: 202, body: { operation_id: 'op_init', environment_id: null, revision: null, duplicate: false } };
      if (c.url === '/api/operations/op_init') return { status: 200, body: initOp };
      return NOT_FOUND;
    }, before);
    const m = await mountWith(PublishView, ctx, {}, '/publish');
    expect(document.body.querySelector('[data-test="manual-switch"]')).toBeNull();
    click(byText('button', '生成预览'));
    await flush();
    click(document.body.querySelector('[data-test="init-commit"]'));
    await flush();
    expect(document.body.querySelector('[data-test="init-running"]')?.textContent).toContain('手动切换');
    ctx.store.applyEvent({ type: 'operation.updated', sequence: 11, operation: { ...initOp, phase: 'COMPLETED', status: 'succeeded', updatedAt: '2026-10-21T08:02:00.000Z' } });
    // 初始化不刷新 Surge 事实：此时仍无法确认当前配置
    ctx.store.applyEvent({ type: 'surge.status', sequence: 12, surge: before.surge });
    ctx.store.applyEvent({ type: 'settings.updated', sequence: 13, settings: base.settings });
    await flush();
    expect(document.body.querySelector('[data-test="init-wizard"]')).toBeNull();
    const hint = document.body.querySelector('[data-test="manual-switch"]');
    expect(hint?.textContent).toContain('在 Surge 中手动切换一次');
    expect(hint?.textContent).toContain('日常-Safari环境');
    expect(hint?.textContent).toContain('本应用从不切换配置');
    // 下一次对账读到仍不是工作配置：提示保留并说明当前配置
    ctx.store.applyEvent({ type: 'surge.status', sequence: 14, surge: { ...before.surge, onWorkingProfile: false } });
    await flush();
    expect(document.body.querySelector('[data-test="manual-switch"]')?.textContent).toContain('Surge 当前配置是「默认」');
    expect(document.body.querySelector('[data-test="manual-switch"]')?.className).toContain('bg-amber-50');
    // 你切换后对账读到工作配置：提示消失
    ctx.store.applyEvent({ type: 'surge.status', sequence: 15, surge: base.surge });
    await flush();
    expect(document.body.querySelector('[data-test="manual-switch"]')).toBeNull();
    m.unmount();
  });

  it('a failed init shows the error and restores preview and commit', async () => {
    const { ctx, m } = await commitInit();
    ctx.store.applyEvent({
      type: 'operation.updated',
      sequence: 11,
      operation: { ...initOp, phase: 'FAILED', status: 'failed', error: { code: 'NAME_COLLISION', message: '初始化失败：目标文件已存在' }, updatedAt: '2026-10-21T08:02:00.000Z' },
    });
    await flush();
    expect(document.body.querySelector('[data-test="init-done"]')).toBeNull();
    expect(document.body.querySelector('[data-test="init-running"]')).toBeNull();
    expect(document.body.querySelector('[data-test="init-failed"]')?.textContent).toContain('初始化失败：目标文件已存在');
    expect(document.body.querySelector('[data-test="init-commit"]')).not.toBeNull();
    expect(byText('button', '生成预览')).not.toBeNull();
    m.unmount();
  });
});

describe('local resource server status (D10)', () => {
  /** 页面上不能出现资源地址、端口或令牌的样子。 */
  function expectNoResourceSecrets() {
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/127\.0\.0\.1:\d/);
    expect(text).not.toMatch(/[0-9a-f]{32,}/i);
    expect(text).not.toContain('/sfe-nodes.list');
  }

  it('shows the state and both flags on the publish page with the explanation, and follows surge.status events', async () => {
    const snap = snapshotWithNodeResource(nodeResource());
    const { ctx } = testContext(() => NOT_FOUND, snap);
    const m = await mountWith(PublishView, ctx, {}, '/publish');
    const state = document.body.querySelector('[data-test="node-resource-state"]')!;
    expect(state.textContent).toContain('正在提供');
    expect(state.querySelector('.badge-success')).not.toBeNull();
    expect(document.body.querySelector('[data-test="node-resource-notes"]')).toBeNull();
    ctx.store.applyEvent({ type: 'surge.status', sequence: 11, surge: { ...snap.surge, nodeResource: nodeResource({ state: 'not_listening', tokenSuspect: true, needsRefresh: true }) } });
    await flush();
    expect(state.textContent).toContain('未监听');
    expect(state.textContent).toContain('令牌可能已泄露');
    expect(state.textContent).toContain('待重新同步');
    expect(state.querySelector('.badge-success')).toBeNull();
    const notes = document.body.querySelector('[data-test="node-resource-notes"]')!;
    expect(notes.textContent).toContain('RESOURCE_SERVER_UNAVAILABLE');
    expect(notes.textContent).toContain('更换本机资源地址');
    expect(notes.textContent).toContain('单 key 更新并读回');
    expect(notes.className).toContain('bg-red-50');
    expectNoResourceSecrets();
    m.unmount();
  });

  it('explains the legacy local-file line as needing a remerge', async () => {
    const { ctx } = testContext(() => NOT_FOUND, snapshotWithNodeResource(nodeResource({ state: 'legacy_line' })));
    const m = await mountWith(PublishView, ctx, {}, '/publish');
    expect(document.body.querySelector('[data-test="node-resource-state"]')?.textContent).toContain('仍引用本地节点文件');
    const notes = document.body.querySelector('[data-test="node-resource-notes"]')!;
    expect(notes.textContent).toContain('需要重新合并以改用本机资源服务');
    expect(notes.textContent).toContain('已保存，待部署');
    expect(notes.className).toContain('bg-amber-50');
    expectNoResourceSecrets();
    m.unmount();
  });

  it('shows no row for an older service that reports no resource status', async () => {
    const { ctx } = testContext(() => NOT_FOUND, snapshot());
    const m = await mountWith(PublishView, ctx, {}, '/publish');
    expect(document.body.querySelector('[data-test="node-resource-state"]')).toBeNull();
    const labels = Array.from(document.body.querySelectorAll('[data-test="working-profile"] dt')).map((d) => d.textContent);
    expect(labels).toContain('受管理段');
    expect(labels).not.toContain('本机资源服务');
    expect(document.body.querySelector('[data-test="node-resource-notes"]')).toBeNull();
    m.unmount();
  });

  it('the overview Surge card shows the state without address details', async () => {
    const { ctx } = testContext(() => NOT_FOUND, snapshotWithNodeResource(nodeResource({ state: 'token_unavailable' })));
    const m = await mountWith(OverviewView, ctx);
    const card = document.body.querySelector('[data-test="surge-card"]')!;
    expect(card.textContent).toContain('本机资源服务');
    expect(card.textContent).toContain('读取令牌不可用');
    expectNoResourceSecrets();
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
