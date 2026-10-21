import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import type { NeedsConfirmationDetails } from '@sfe/contract';
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
  otherProfilesOpen: [{ profileIdShort: 'f00dbabe', environmentLabel: null }],
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
    click(document.body.querySelector('[data-test="route-cancel"]'));
    await flush();
    expect(document.body.textContent).toContain('确定要取消此次切换吗？');
    expect(document.body.textContent).toContain('不会进入普通模式');
    click(byText('.modal-footer button', '取消切换'));
    await flush();
    const cancel = calls.find((c) => c.url === '/api/operations/op_1/cancel');
    expect(cancel?.method).toBe('POST');
    expect(typeof (cancel?.body as { request_id?: unknown }).request_id).toBe('string');
    expect(calls.some((c) => c.url === '/api/routing/normal')).toBe(false);
    m.unmount();
  });
});
