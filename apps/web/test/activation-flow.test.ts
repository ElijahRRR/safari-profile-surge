import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import type { NeedsConfirmationDetails } from '@sfe/contract';
import { formatClock } from '../src/lib/format';
import { ApiError } from '../src/api/client';
import { createRouteActions } from '../src/store/route-actions';
import EnvironmentsView from '../src/views/EnvironmentsView.vue';
import RouteActionHost from '../src/components/RouteActionHost.vue';
import RouteCard from '../src/components/RouteCard.vue';
import { allSupported, byText, capabilities, click, environment, flush, mountWith, operation, route, snapshot, testContext, type Call } from './fixtures';

const details: NeedsConfirmationDetails = {
  reason: 'other_environment_active',
  currentEnvironmentId: 'env_2',
  currentEnvironmentLabel: 'US-买家02 · E0002',
  otherProfilesOpen: [
    { profileIdShort: 'f00dbabe', environmentLabel: null },
    { profileIdShort: '', environmentLabel: null, unidentified: true },
  ],
  options: ['closed_confirmed', 'keep_open_acknowledged'],
  limitation: '首请求与旧连接处理尚未通过实测：建议保存工作后退出并重开 Safari。',
};

const accepted = { operation_id: 'op_1', environment_id: 'env_1', revision: 3, duplicate: false };

function controller(responses: Array<() => unknown>) {
  const activate = vi.fn(async () => {
    const r = responses.shift()!();
    if (r instanceof Error) throw r;
    return r as typeof accepted;
  });
  const normal = vi.fn(async () => {
    const r = responses.shift()!();
    if (r instanceof Error) throw r;
    return r as typeof accepted;
  });
  const toasts = { info: vi.fn(), error: vi.fn() };
  const onAccepted = vi.fn();
  let n = 0;
  const ra = createRouteActions({ api: { activate, normal } as never, toasts, onAccepted, newRequestId: () => `req-${++n}` });
  return { ra, activate, normal, toasts, onAccepted };
}

const needsConfirmation = () => new ApiError(409, { code: 'NEEDS_CONFIRMATION', message: '切换失败：需要确认旧窗口', details: details as unknown as Record<string, unknown> });

describe('route action controller', () => {
  it('first sends without a policy, then resends the same request_id with the chosen policy', async () => {
    const t = controller([needsConfirmation, () => accepted]);
    await t.ra.start({ kind: 'activate', environmentId: 'env_1', label: 'US-买家01 · E0001', displayName: 'US-买家01' });
    expect(t.activate).toHaveBeenCalledWith('env_1', { request_id: 'req-1' });
    expect(t.ra.state.phase).toBe('confirming');
    expect(t.ra.state.confirmation).toEqual(details);
    expect(t.ra.state.policy).toBeNull();

    await t.ra.confirm('keep_open_acknowledged');
    expect(t.activate).toHaveBeenLastCalledWith('env_1', {
      request_id: 'req-1',
      old_session_policy: 'keep_open_acknowledged',
      confirmed_environment_id: 'env_2',
    });
    expect(t.onAccepted).toHaveBeenCalledWith(accepted, expect.objectContaining({ kind: 'activate' }));
    expect(t.ra.state.phase).toBe('idle');
  });

  it('does nothing until a policy is explicitly chosen', async () => {
    const t = controller([needsConfirmation]);
    await t.ra.start({ kind: 'normal' });
    await t.ra.confirm(null);
    expect(t.normal).toHaveBeenCalledTimes(1);
    expect(t.ra.state.phase).toBe('confirming');
  });

  it('normal mode uses the same confirmation flow', async () => {
    const t = controller([needsConfirmation, () => accepted]);
    await t.ra.start({ kind: 'normal' });
    await t.ra.confirm('closed_confirmed');
    expect(t.normal).toHaveBeenNthCalledWith(1, { request_id: 'req-1' });
    expect(t.normal).toHaveBeenNthCalledWith(2, { request_id: 'req-1', old_session_policy: 'closed_confirmed', confirmed_environment_id: 'env_2' });
  });

  it('passes an explicit proxy_revision (return to the last verified version)', async () => {
    const t = controller([() => accepted]);
    await t.ra.start({ kind: 'activate', environmentId: 'env_1', label: 'x', displayName: 'x', proxyRevision: 17 });
    expect(t.activate).toHaveBeenCalledWith('env_1', { request_id: 'req-1', proxy_revision: 17 });
  });

  it('a new start uses a new request_id', async () => {
    const t = controller([() => accepted, () => accepted]);
    await t.ra.start({ kind: 'normal' });
    await t.ra.start({ kind: 'normal' });
    expect(t.normal.mock.calls.map((c) => (c as unknown as [{ request_id: string }])[0].request_id)).toEqual(['req-1', 'req-2']);
  });

  it('keeps the dialog open with the error when the resend fails', async () => {
    const t = controller([needsConfirmation, () => new ApiError(409, { code: 'ROUTE_BUSY', message: '切换失败：另一个切换正在进行' })]);
    await t.ra.start({ kind: 'normal' });
    await t.ra.confirm('closed_confirmed');
    expect(t.ra.state.phase).toBe('confirming');
    expect(t.ra.state.error).toBe('切换失败：另一个切换正在进行');
  });

  it('reports other errors as a toast without a dialog', async () => {
    const t = controller([() => new ApiError(412, { code: 'CAPABILITY_UNVERIFIED', message: '切换失败：能力尚未通过实测' })]);
    await t.ra.start({ kind: 'activate', environmentId: 'env_1', label: 'x', displayName: 'x' });
    expect(t.ra.state.phase).toBe('idle');
    expect(t.toasts.error).toHaveBeenCalledWith('切换失败：能力尚未通过实测');
  });
});

describe('activation from the environments page', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('shows the confirmation, resends with the same request_id, then shows guidance and progress', async () => {
    let activateCalls = 0;
    const { ctx, calls } = testContext((call: Call) => {
      if (call.url === '/api/environments/env_1/activate') {
        activateCalls++;
        if (activateCalls === 1) return { status: 409, body: { error: { code: 'NEEDS_CONFIRMATION', message: '需要确认', details } } };
        return { status: 202, body: accepted };
      }
      if (call.url === '/api/operations/op_1') return { status: 200, body: operation() };
      return { status: 404, body: { error: { code: 'NOT_FOUND', message: '找不到' } } };
    }, snapshot({ capabilities: capabilities(allSupported()), environments: [environment({ readiness: 'ready' })] }));

    const Page = defineComponent({ render: () => [h(EnvironmentsView), h(RouteActionHost)] });
    const m = await mountWith(Page, ctx, {}, '/environments');
    click(document.body.querySelector('[data-test="open-env"]'));
    await flush();

    const dialog = document.body.querySelector('[data-test="route-confirm"]')!;
    expect(dialog).not.toBeNull();
    expect(dialog.querySelector('[data-test="current-env"]')?.textContent).toBe('US-买家02 · E0002');
    expect(dialog.textContent).toContain('f00dbabe');
    expect(dialog.textContent).toContain('未绑定场景');
    // 没有场景 ID 的场景（可能是默认场景）单独标明，不显示为空的编号加「未绑定场景」
    expect(dialog.querySelector('[data-test="unidentified-profile"]')?.textContent).toBe('未识别场景（可能是默认场景）');
    expect(dialog.textContent!.match(/未绑定场景/g)).toHaveLength(1);
    expect(dialog.querySelector('[data-test="limitation"]')?.textContent).toContain('保存工作后退出并重开 Safari');
    expect(dialog.textContent).toContain('我已关闭旧环境窗口');
    expect(dialog.textContent).toContain('不关闭，直接切换');
    expect(dialog.textContent).toContain('旧环境窗口之后发出的请求会经过新环境的出口');

    const submit = document.body.querySelector<HTMLButtonElement>('[data-test="route-confirm-submit"]')!;
    expect(submit.disabled).toBe(true);
    const radios = dialog.querySelectorAll<HTMLInputElement>('input[type="radio"]');
    expect(Array.from(radios).some((r) => r.checked)).toBe(false);

    click(dialog.querySelector('[data-option="closed_confirmed"] input'));
    await flush();
    expect(submit.disabled).toBe(false);
    click(submit);
    await flush();

    const activations = calls.filter((c) => c.url === '/api/environments/env_1/activate');
    expect(activations).toHaveLength(2);
    const first = activations[0]!.body as Record<string, unknown>;
    const second = activations[1]!.body as Record<string, unknown>;
    expect(first.old_session_policy).toBeUndefined();
    expect(second.request_id).toBe(first.request_id);
    expect(second.old_session_policy).toBe('closed_confirmed');
    expect(second.confirmed_environment_id).toBe('env_2');

    expect(document.body.querySelector('[data-test="route-confirm"]')).toBeNull();
    const detail = document.body.querySelector('[data-test="operation-detail"]')!;
    expect(detail).not.toBeNull();
    expect(detail.querySelector('[data-test="scene-guidance"]')?.textContent).toContain('在 Safari 切换到场景 US-买家01，点击扩展图标完成验证');
    expect(detail.querySelector('[data-test="phase-badge"]')?.textContent).toContain('等待 Safari 实测');
    expect(detail.querySelector('[data-test="steps"]')?.textContent).toContain('入口已阻断');

    ctx.store.applyEvent({ type: 'operation.updated', sequence: 99, operation: operation({ phase: 'ACTIVE_VERIFIED', status: 'succeeded', updatedAt: '2026-10-21T08:05:00.000Z' }) });
    await flush();
    expect(document.body.querySelector('[data-test="phase-badge"]')?.textContent).toContain('已生效');
    expect(document.body.querySelector('[data-test="scene-guidance"]')).toBeNull();
    m.unmount();
  });

  it('cancelling a waiting activation asks first and never offers normal mode as the fallback', async () => {
    const { ctx, calls } = testContext((call: Call) => {
      if (call.url === '/api/operations/op_1') return { status: 200, body: operation() };
      if (call.url === '/api/operations/op_1/cancel') return { status: 202, body: accepted };
      return { status: 404, body: { error: { code: 'NOT_FOUND', message: '找不到' } } };
    }, snapshot({ route: route({ operationId: 'op_1', phase: 'awaiting_safari_verify', entryMode: 'VERIFY_ONLY' }), pendingOperations: [operation()] }));
    const Page = defineComponent({ render: () => [h(RouteCard), h(RouteActionHost)] });
    const m = await mountWith(Page, ctx);
    expect(document.body.querySelector('[data-test="route-cancel"]')?.textContent?.trim()).toBe('取消切换');
    // 结果要到回滚读回之后才知道：只说尝试恢复，写明无法确认时改选 REJECT（§6.3 第 14 步）
    expect(document.body.textContent).toContain('取消会尝试恢复原节点并保持 Safari 阻断；无法确认时不恢复，改选 REJECT');
    expect(document.body.textContent).not.toContain('取消会恢复原节点');
    click(document.body.querySelector('[data-test="route-cancel"]'));
    await flush();
    expect(document.body.textContent).toContain('确定要取消此次切换吗？');
    expect(document.body.textContent).toContain('服务会尝试恢复切换前的节点选择并保持 Safari 阻断');
    expect(document.body.textContent).not.toContain('服务会恢复切换前的节点选择');
    expect(document.body.textContent).toContain('不会进入普通模式');
    click(byText('.modal-footer button', '取消切换'));
    await flush();
    const cancel = calls.find((c) => c.url === '/api/operations/op_1/cancel');
    expect(cancel?.method).toBe('POST');
    expect(typeof (cancel?.body as { request_id?: unknown }).request_id).toBe('string');
    expect(calls.some((c) => c.url === '/api/routing/normal')).toBe(false);
    m.unmount();
  });

  it('the waiting-for-Safari guidance states each operation\'s own timeout outcome: a retest never restores a node or blocks Safari', async () => {
    const deadline = '2026-10-21T08:02:00.000Z';
    const probeOp = operation({ kind: 'probe.safari', phase: 'VALIDATING', status: 'waiting', probeKind: 'safari', waitDeadline: deadline, steps: [{ at: '2026-10-21T08:00:00.000Z', phase: 'VALIDATING', message: '等待在绑定的 Safari 场景中完成出口检测（不切换、不断连）' }] });
    const switchOp = operation({ id: 'op_2', kind: 'environment.update', phase: 'VERIFY_ONLY', status: 'waiting', waitDeadline: deadline });
    const { ctx } = testContext((call: Call) => {
      if (call.url === '/api/operations/op_1') return { status: 200, body: probeOp };
      if (call.url === '/api/operations/op_2') return { status: 200, body: switchOp };
      return { status: 404, body: { error: { code: 'NOT_FOUND', message: '找不到' } } };
    }, snapshot({ route: route({ phase: 'active_verified', entryMode: 'ACTIVE', activeEnvironmentId: 'env_1', activeProxyRevision: 1, awaitingDeadline: deadline }), pendingOperations: [probeOp, switchOp] }));
    const Page = defineComponent({ render: () => [h(RouteCard), h(RouteActionHost)] });
    const m = await mountWith(Page, ctx);
    ctx.viewer.open('op_1', 'US-买家01');
    await flush();
    const retest = document.body.querySelector('[data-test="scene-guidance"]')?.textContent ?? '';
    // 重测超时只结束检测（§6.4）：不承诺恢复原节点、阻断 Safari 或改选 REJECT
    expect(retest).toContain('超时则本次重新检测失败，路由不变（不切换、不阻断 Safari）');
    expect(retest).not.toContain('恢复原节点');
    expect(retest).not.toContain('REJECT');
    ctx.viewer.close();
    await flush();
    // 活动环境发布进入切换后的 VERIFY_ONLY 等待：超时按第 14 步回滚
    ctx.viewer.open('op_2', 'US-买家01');
    await flush();
    expect(document.body.querySelector('[data-test="scene-guidance"]')?.textContent).toContain('超时会尝试恢复原节点并保持 Safari 阻断（无法确认时改选 REJECT 并要求处理）');
    m.unmount();
  });

  it('the waiting guidance shows the operation\'s own deadline, never a stale route deadline left by an earlier retest', async () => {
    const stale = '2026-10-21T00:02:00.000Z';
    const own = '2026-10-21T03:10:00.000Z';
    const probeOp = operation({ kind: 'probe.safari', phase: 'VALIDATING', status: 'waiting', probeKind: 'safari', waitDeadline: own });
    const waitOp = operation({ id: 'op_2', kind: 'environment.update', phase: 'WAITING_ROUTE', status: 'waiting', waitDeadline: own });
    const { ctx } = testContext((call: Call) => {
      if (call.url === '/api/operations/op_1') return { status: 200, body: probeOp };
      if (call.url === '/api/operations/op_2') return { status: 200, body: waitOp };
      return { status: 404, body: { error: { code: 'NOT_FOUND', message: '找不到' } } };
    }, snapshot({ route: route({ phase: 'active_verified', entryMode: 'ACTIVE', activeEnvironmentId: 'env_1', activeProxyRevision: 1, awaitingDeadline: stale }), pendingOperations: [probeOp, waitOp] }));
    const Page = defineComponent({ render: () => [h(RouteCard), h(RouteActionHost)] });
    const m = await mountWith(Page, ctx);
    ctx.viewer.open('op_1', 'US-买家01');
    await flush();
    const retest = document.body.querySelector('[data-test="scene-guidance"]')?.textContent ?? '';
    expect(retest).toContain(`请在 ${formatClock(own)} 前完成`);
    expect(retest).not.toContain(formatClock(stale));
    ctx.viewer.close();
    await flush();
    ctx.viewer.open('op_2', 'US-买家01');
    await flush();
    const waiting = document.body.querySelector('[data-test="waiting-route-guidance"]')?.textContent ?? '';
    expect(waiting).toContain(`截止 ${formatClock(own)}`);
    expect(waiting).not.toContain(formatClock(stale));
    m.unmount();
  });

  it('an activation that became a Safari retest (reused active environment, expired probe; kind stays route.activate, probeKind safari) gets the retest timeout and cancel texts, never the switch rollback promise', async () => {
    const deadline = '2026-10-21T08:02:00.000Z';
    const reuseOp = operation({
      kind: 'route.activate',
      phase: 'VALIDATING',
      status: 'waiting',
      probeKind: 'safari',
      waitDeadline: deadline,
      steps: [
        { at: '2026-10-21T08:00:00.000Z', phase: 'VALIDATING', message: '环境已在使用中，但实测已过期：改为 Safari 重测，不切换' },
        { at: '2026-10-21T08:00:01.000Z', phase: 'VALIDATING', message: '等待在绑定的 Safari 场景中完成出口检测（不切换、不断连）' },
      ],
    });
    const { ctx, calls } = testContext((call: Call) => {
      if (call.url === '/api/operations/op_1') return { status: 200, body: reuseOp };
      if (call.url === '/api/operations/op_1/cancel') return { status: 202, body: accepted };
      return { status: 404, body: { error: { code: 'NOT_FOUND', message: '找不到' } } };
    }, snapshot({ route: route({ operationId: 'op_1', phase: 'active_verified', entryMode: 'ACTIVE', activeEnvironmentId: 'env_1', activeProxyRevision: 1, awaitingDeadline: deadline }), pendingOperations: [reuseOp] }));
    const Page = defineComponent({ render: () => [h(RouteCard), h(RouteActionHost)] });
    const m = await mountWith(Page, ctx);
    // 路由卡：取消只结束检测，路由不变
    expect(document.body.querySelector('[data-test="route-cancel"]')?.textContent?.trim()).toBe('取消重测');
    expect(document.body.querySelector('[data-test="route-cancel-note"]')?.textContent).toContain('取消只结束本次检测，路由不变');
    expect(document.body.querySelector('[data-test="route-cancel-note"]')?.textContent).not.toContain('恢复原节点');
    ctx.viewer.open('op_1', 'US-买家01');
    await flush();
    const guidance = document.body.querySelector('[data-test="scene-guidance"]')?.textContent ?? '';
    expect(guidance).toContain('超时则本次重新检测失败，路由不变（不切换、不阻断 Safari）');
    expect(guidance).not.toContain('恢复原节点');
    expect(guidance).not.toContain('REJECT');
    expect(document.body.querySelector('[data-test="cancel-operation"]')?.textContent?.trim()).toBe('取消重测');
    click(document.body.querySelector('[data-test="cancel-operation"]'));
    await flush();
    expect(document.body.textContent).toContain('确定要取消这次 Safari 重测吗？');
    expect(document.body.textContent).toContain('只结束本次检测，路由不变（不切换、不阻断 Safari）');
    expect(document.body.textContent).not.toContain('确定要取消此次切换吗？');
    expect(document.body.textContent).not.toContain('服务会尝试恢复切换前的节点选择');
    click(byText('.modal-footer button', '取消重测'));
    await flush();
    expect(calls.some((c) => c.url === '/api/operations/op_1/cancel')).toBe(true);
    m.unmount();
  });
});

