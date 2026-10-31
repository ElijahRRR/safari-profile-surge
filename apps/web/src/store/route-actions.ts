// 激活（打开环境）与进入普通模式的确认流程。首次提交不带旧窗口选择；服务端返回 409
// NEEDS_CONFIRMATION 时显示确认弹窗，用户显式选择后用同一个 request_id 带上 old_session_policy 与
// confirmed_environment_id 重发（同步拒绝不占用 request_id）。从不默认替用户选择「不关闭」。

import { reactive } from 'vue';
import type { Accepted, ActivateRequest, NeedsConfirmationDetails, NormalModeRequest, OldSessionPolicy } from '@sfe/contract';
import { isApiError, type ApiClient } from '../api/client';
import { newRequestId } from '../lib/request-id';
import type { ToastQueue } from './toasts';

export type RouteActionTarget =
  | { kind: 'activate'; environmentId: string; label: string; displayName: string; proxyRevision?: number }
  | { kind: 'normal' };

export interface RouteActionState {
  phase: 'idle' | 'sending' | 'confirming';
  target: RouteActionTarget | null;
  requestId: string | null;
  confirmation: NeedsConfirmationDetails | null;
  /** 用户在确认弹窗中的显式选择；没有默认值。 */
  policy: OldSessionPolicy | null;
  error: string | null;
}

export interface RouteActionDeps {
  api: Pick<ApiClient, 'activate' | 'normal'>;
  toasts: Pick<ToastQueue, 'info' | 'error'>;
  /** 受理后展示操作进度。 */
  onAccepted(accepted: Accepted, target: RouteActionTarget): void;
  newRequestId?: () => string;
}

export function isNeedsConfirmationDetails(value: unknown): value is NeedsConfirmationDetails {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.reason === 'string' && Array.isArray(v.options) && Array.isArray(v.otherProfilesOpen);
}

export function createRouteActions(deps: RouteActionDeps) {
  const makeId = deps.newRequestId ?? newRequestId;
  const state = reactive<RouteActionState>({ phase: 'idle', target: null, requestId: null, confirmation: null, policy: null, error: null });

  function reset() {
    state.phase = 'idle';
    state.target = null;
    state.requestId = null;
    state.confirmation = null;
    state.policy = null;
    state.error = null;
  }

  async function send(policy: OldSessionPolicy | null): Promise<void> {
    const target = state.target;
    const requestId = state.requestId;
    if (!target || !requestId) return;
    const hadConfirmation = state.confirmation !== null;
    state.phase = 'sending';
    state.error = null;
    try {
      let accepted: Accepted;
      if (target.kind === 'activate') {
        const req: ActivateRequest = { request_id: requestId };
        if (policy) {
          req.old_session_policy = policy;
          req.confirmed_environment_id = state.confirmation?.currentEnvironmentId ?? null;
        }
        if (target.proxyRevision !== undefined) req.proxy_revision = target.proxyRevision;
        accepted = await deps.api.activate(target.environmentId, req);
      } else {
        const req: NormalModeRequest = { request_id: requestId };
        if (policy) {
          req.old_session_policy = policy;
          req.confirmed_environment_id = state.confirmation?.currentEnvironmentId ?? null;
        }
        accepted = await deps.api.normal(req);
      }
      reset();
      deps.toasts.info(target.kind === 'activate' ? '已受理：正在切换环境，结果以 Safari 实测为准' : '已受理：正在进入普通模式');
      deps.onAccepted(accepted, target);
    } catch (e) {
      if (isApiError(e) && e.code === 'NEEDS_CONFIRMATION' && isNeedsConfirmationDetails(e.details)) {
        state.confirmation = e.details;
        state.policy = null;
        state.phase = 'confirming';
        return;
      }
      const message = e instanceof Error ? e.message : '提交失败：未知错误';
      if (hadConfirmation) {
        state.phase = 'confirming';
        state.error = message;
      } else {
        reset();
        deps.toasts.error(message);
      }
    }
  }

  /** 开始一次新的激活或普通模式请求（新的 request_id）。 */
  async function start(target: RouteActionTarget): Promise<void> {
    if (state.phase === 'sending') return;
    reset();
    state.target = target;
    state.requestId = makeId();
    await send(null);
  }

  /** 用户在确认弹窗中选择后重发：同一个 request_id。 */
  async function confirm(policy: OldSessionPolicy | null = state.policy): Promise<void> {
    if (!policy || state.phase !== 'confirming') return;
    state.policy = policy;
    await send(policy);
  }

  function dismiss() {
    if (state.phase === 'sending') return;
    reset();
  }

  return { state, start, confirm, dismiss };
}

export type RouteActions = ReturnType<typeof createRouteActions>;
