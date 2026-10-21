// 组装网页后台的运行时：API 客户端、事件流、状态、Toast、路由操作确认流程与操作详情弹窗。
// 通过 provide/inject 交给组件，测试可以注入假的 fetch 与令牌。

import { inject, type InjectionKey } from 'vue';
import type { Accepted } from '@sfe/contract';
import { ApiClient, SESSION_EXPIRED_MESSAGE, isApiError } from '../api/client';
import { EventStream, type Timers } from '../api/event-stream';
import { createLocalTokenStore, type TokenStore } from '../api/session-token';
import { createConsoleStore, type ConsoleStore } from './console';
import { createOperationViewer, type OperationViewer } from './operation-viewer';
import { createRouteActions, type RouteActions, type RouteActionTarget } from './route-actions';
import { createToastQueue, type ToastQueue } from './toasts';

export interface ConsoleContext {
  api: ApiClient;
  store: ConsoleStore;
  toasts: ToastQueue;
  routeActions: RouteActions;
  viewer: OperationViewer;
  stream: EventStream;
  bootstrap(): Promise<void>;
  reloadSnapshot(): Promise<void>;
  loadOperations(limit?: number): Promise<void>;
  logout(): Promise<void>;
  /** 202 受理后的统一提示：只代表已保存并创建任务，不代表 Surge 或网络已生效。 */
  accepted(accepted: Accepted, message: string, sceneName?: string | null): void;
  dispose(): void;
}

export const CONSOLE_KEY: InjectionKey<ConsoleContext> = Symbol('sfe-console');

export function useConsole(): ConsoleContext {
  const ctx = inject(CONSOLE_KEY);
  if (!ctx) throw new Error('console context missing');
  return ctx;
}

export interface ConsoleContextOptions {
  tokens?: TokenStore;
  fetch?: typeof fetch;
  timers?: Timers;
  now?: () => number;
}

export function createConsoleContext(opts: ConsoleContextOptions = {}): ConsoleContext {
  const tokens = opts.tokens ?? createLocalTokenStore();
  const store = createConsoleStore(opts.now);
  const toasts = createToastQueue(opts.timers);
  const viewer = createOperationViewer();

  function onUnauthorized() {
    // 令牌已失效：清除后显示登录说明；登录码只能从菜单栏 App 或 sfe open 重新签发。
    tokens.clear();
    stream.stop();
    store.reset();
    store.state.session.status = 'expired';
    store.state.session.info = null;
    store.state.session.message = SESSION_EXPIRED_MESSAGE;
  }

  const api = new ApiClient({ tokens, ...(opts.fetch ? { fetch: opts.fetch } : {}), onUnauthorized });

  async function reloadSnapshot(): Promise<void> {
    store.beginReload();
    let snapshot = null;
    try {
      snapshot = await api.snapshot();
    } catch (e) {
      store.finishReload(null);
      throw e;
    }
    store.finishReload(snapshot);
    stream.resumeFrom(String(store.state.sequence));
  }

  const stream: EventStream = new EventStream({
    tokens,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(opts.timers ? { timers: opts.timers } : {}),
    onEvent: (event) => {
      store.applyEvent(event);
    },
    onSnapshotRequired: async () => {
      try {
        await reloadSnapshot();
      } catch (e) {
        if (!isApiError(e) || e.status !== 401) toasts.error(e instanceof Error ? e.message : '读取状态失败');
      }
    },
    onUnauthorized,
    onStateChange: (s) => {
      store.state.stream = s;
    },
  });

  function accepted(acc: Accepted, message: string, sceneName: string | null = null) {
    toasts.info(acc.duplicate ? '该请求已提交过，显示的是原任务' : message);
    if (sceneName !== null) viewer.open(acc.operation_id, sceneName);
  }

  const routeActions = createRouteActions({
    api,
    toasts,
    onAccepted: (acc, target: RouteActionTarget) => {
      viewer.open(acc.operation_id, target.kind === 'activate' ? target.displayName : null);
    },
  });

  async function loadOperations(limit = 100): Promise<void> {
    const list = await api.listOperations(limit);
    store.setOperations(list);
  }

  async function bootstrap(): Promise<void> {
    if (!api.hasToken()) {
      store.state.session.status = 'none';
      return;
    }
    store.state.session.status = 'checking';
    store.state.session.message = null;
    try {
      const info = await api.session();
      store.state.session.info = info;
      await reloadSnapshot();
      store.state.session.status = 'authenticated';
      stream.start(String(store.state.sequence));
      loadOperations().catch(() => {
        // 操作列表读取失败不影响其余页面；操作记录页会提示重试。
      });
    } catch (e) {
      if (isApiError(e) && e.status === 401) return;
      store.state.session.status = 'error';
      store.state.session.message = e instanceof Error ? e.message : '连接本机服务失败';
    }
  }

  async function logout(): Promise<void> {
    try {
      await api.logout();
    } catch {
      // 登出失败（服务已停止或令牌已过期）也照样清除本地令牌。
    }
    tokens.clear();
    stream.stop();
    store.reset();
    store.state.session.status = 'none';
    store.state.session.info = null;
    store.state.session.message = null;
  }

  return {
    api,
    store,
    toasts,
    routeActions,
    viewer,
    stream,
    bootstrap,
    reloadSnapshot,
    loadOperations,
    logout,
    accepted,
    dispose: () => stream.stop(),
  };
}
