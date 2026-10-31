// 弹窗状态与动作。打开期间约 1 秒轮询 getCurrentState（以及正在跟踪的操作），关闭即停止。
// 激活与普通模式只由这里的用户点击发起；需要确认时用同一个 request_id 带上选择重发。
// 秘密字段不经过这里保存：表单组件提交时直接把载荷交给 createEnvironment/updateEnvironment。

import { reactive } from 'vue';
import type {
  ApiErrorBody,
  BindableEnvironment,
  CurrentStateResponse,
  EnvironmentChanges,
  EnvironmentInput,
  NeedsConfirmationDetails,
  OldSessionPolicy,
  OperationView,
} from '@sfe/contract';
import type { WebExtBrowser } from '../shared/browser';
import { newRequestId } from '../shared/ids';
import type { PageClient, ProfileStateReport } from '../shared/messages';
import type { RequestOf } from '../shared/native';
import { openOrLocateOrders } from '../shared/orders';
import { openPreparePage, type PrepareIntent } from '../shared/pages';
import { SAVED_NOTICE, statusIsTerminal } from '../shared/text';

export const POPUP_POLL_MS = 1000;

export type RouteMessage = RequestOf<'activateCurrentEnvironment'> | RequestOf<'enterNormalMode'>;

export interface ConfirmState {
  kind: 'activate' | 'normal';
  message: RouteMessage;
  details: NeedsConfirmationDetails;
  intent: PrepareIntent;
}

export interface PopupState {
  loading: boolean;
  loadError: string | null;
  current: CurrentStateResponse | null;
  profile: ProfileStateReport | null;
  busy: string | null;
  actionError: string | null;
  notice: string | null;
  trackedOperationId: string | null;
  operation: OperationView | null;
  confirm: ConfirmState | null;
  now: Date;
}

export type ActionResult = { ok: true } | { ok: false; error: ApiErrorBody };

export interface PopupDeps {
  browser: WebExtBrowser;
  client: PageClient;
  newRequestId?: () => string;
  pollMs?: number;
  now?: () => Date;
  closeWindow?: () => void;
}

function isNeedsConfirmationDetails(value: unknown): value is NeedsConfirmationDetails {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<NeedsConfirmationDetails>;
  return typeof v.reason === 'string' && Array.isArray(v.options) && Array.isArray(v.otherProfilesOpen);
}

export function createPopupController(deps: PopupDeps) {
  const b = deps.browser;
  const client = deps.client;
  const rid = deps.newRequestId ?? newRequestId;
  const pollMs = deps.pollMs ?? POPUP_POLL_MS;
  const now = deps.now ?? (() => new Date());

  const state = reactive<PopupState>({
    loading: true,
    loadError: null,
    current: null,
    profile: null,
    busy: null,
    actionError: null,
    notice: null,
    trackedOperationId: null,
    operation: null,
    confirm: null,
    now: now(),
  });

  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let refreshing: Promise<void> | null = null;

  function progressOperationId(): string | null {
    if (state.trackedOperationId) return state.trackedOperationId;
    const last = state.current?.environment?.lastOperation;
    if (last && !statusIsTerminal(last.status)) return last.id;
    return null;
  }

  async function doRefresh(): Promise<void> {
    const r = await client.call({ type: 'getCurrentState' });
    state.now = now();
    if (r.ok) {
      state.current = r.data;
      state.loadError = null;
    } else {
      state.loadError = r.error.message;
    }
    const opId = progressOperationId();
    if (!opId) {
      state.operation = null;
    } else if (!(state.operation?.id === opId && statusIsTerminal(state.operation.status))) {
      const o = await client.call({ type: 'getOperation', operation_id: opId });
      if (o.ok) state.operation = o.data;
    }
    state.loading = false;
  }

  function refresh(): Promise<void> {
    if (!refreshing) {
      refreshing = doRefresh().finally(() => {
        refreshing = null;
      });
    }
    return refreshing;
  }

  function schedule(): void {
    if (!running) return;
    timer = setTimeout(() => {
      timer = null;
      void refresh().then(schedule);
    }, pollMs);
  }

  async function start(): Promise<void> {
    if (running) return;
    running = true;
    // 场景状态上报（提示性质）与首次读取并行，避免拖慢首屏。
    await Promise.all([
      client.profileState(true).then((ps) => {
        if (ps.ok) state.profile = ps.data;
      }),
      refresh(),
    ]);
    schedule();
  }

  function stop(): void {
    running = false;
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  async function run<T>(key: string, fn: () => Promise<T>): Promise<T | undefined> {
    if (state.busy) return undefined;
    state.busy = key;
    state.actionError = null;
    state.notice = null;
    try {
      return await fn();
    } finally {
      state.busy = null;
    }
  }

  function track(operationId: string): void {
    state.trackedOperationId = operationId;
    state.operation = null;
  }

  function env() {
    return state.current?.environment ?? null;
  }

  async function sendRoute(kind: 'activate' | 'normal', message: RouteMessage, intent: PrepareIntent): Promise<void> {
    const r = await client.call(message);
    if (!r.ok) {
      if (r.error.code === 'NEEDS_CONFIRMATION' && isNeedsConfirmationDetails(r.error.details)) {
        state.confirm = { kind, message, details: r.error.details, intent };
        return;
      }
      state.confirm = null;
      state.actionError = r.error.message;
      return;
    }
    state.confirm = null;
    track(r.data.operation_id);
    if (kind === 'activate') {
      try {
        await openPreparePage(b, r.data.operation_id, intent);
      } catch {
        state.actionError = '打开准备页失败：无法创建标签页，请点击「继续验证」';
      }
    }
    void refresh();
  }

  async function activate(intent: PrepareIntent = null): Promise<void> {
    await run('activate', async () => {
      const e = env();
      if (!e) return;
      const ps = await client.profileState(false);
      if (ps.ok) state.profile = ps.data;
      // 读不到时按“已有 Amazon 标签页”处理：本次打开记为未经启动验证，而不是假定干净启动。
      const amazonTabsOpen = ps.ok ? ps.data.amazon_tabs_open : true;
      await sendRoute(
        'activate',
        { type: 'activateCurrentEnvironment', request_id: rid(), environment_id: e.id, amazon_tabs_open: amazonTabsOpen },
        intent,
      );
    });
  }

  async function enterNormal(): Promise<void> {
    await run('normal', () => sendRoute('normal', { type: 'enterNormalMode', request_id: rid() }, null));
  }

  /** 用户在确认弹窗中选择后，用同一个 request_id 重发。 */
  async function confirmPolicy(policy: OldSessionPolicy): Promise<void> {
    const c = state.confirm;
    if (!c || !c.details.options.includes(policy)) return;
    const message: RouteMessage = { ...c.message, old_session_policy: policy, confirmed_environment_id: c.details.currentEnvironmentId };
    await run(c.kind, () => sendRoute(c.kind, message, c.intent));
  }

  function dismissConfirm(): void {
    state.confirm = null;
  }

  async function bind(target: BindableEnvironment): Promise<void> {
    await run('bind', async () => {
      const r = await client.call({ type: 'bindCurrentProfile', request_id: rid(), environment_id: target.id, expected_revision: target.revision });
      if (!r.ok) {
        state.actionError = r.error.message;
        return;
      }
      track(r.data.operation_id);
      state.notice = '已提交关联';
      void refresh();
    });
  }

  async function createEnvironment(input: EnvironmentInput): Promise<ActionResult> {
    const result = await run<ActionResult>('create', async () => {
      const r = await client.call({ type: 'createAndBindEnvironment', request_id: rid(), environment: input });
      if (!r.ok) return { ok: false, error: r.error };
      track(r.data.operation_id);
      state.notice = SAVED_NOTICE;
      void refresh();
      return { ok: true };
    });
    return result ?? { ok: false, error: { code: 'ROUTE_BUSY', message: '保存失败：另一个操作正在进行' } };
  }

  /** expectedRevision 是表单打开时看到的版本：期间被网页或其他界面修改会得到版本冲突，而不是覆盖。 */
  async function updateEnvironment(changes: EnvironmentChanges, expectedRevision: number): Promise<ActionResult> {
    const e = env();
    if (!e) return { ok: false, error: { code: 'PROFILE_UNBOUND', message: '保存失败：当前场景未绑定环境' } };
    const result = await run<ActionResult>('update', async () => {
      const r = await client.call({
        type: 'updateCurrentEnvironment',
        request_id: rid(),
        environment_id: e.id,
        expected_revision: expectedRevision,
        changes,
      });
      if (!r.ok) return { ok: false, error: r.error };
      track(r.data.operation_id);
      state.notice = SAVED_NOTICE;
      void refresh();
      return { ok: true };
    });
    return result ?? { ok: false, error: { code: 'ROUTE_BUSY', message: '保存失败：另一个操作正在进行' } };
  }

  async function openOrders(): Promise<void> {
    const cur = state.current;
    const e = env();
    if (!cur || !e) return;
    if (cur.ordersAllowed) {
      await run('orders', async () => {
        try {
          await openOrLocateOrders(b, e.site);
          deps.closeWindow?.();
        } catch {
          state.actionError = '打开订单页失败：无法创建标签页';
        }
      });
      return;
    }
    // 未“受控”时按钮执行受控入口：先激活并在准备页实测，通过后再打开订单页。
    if (cur.activationAvailable) await activate('orders');
  }

  async function probe(): Promise<void> {
    await run('probe', async () => {
      const cur = state.current;
      const e = env();
      if (!cur || !e) return;
      const kind = cur.relation === 'this_active' ? 'safari' : 'preflight';
      const r = await client.call({ type: 'probeCurrentEnvironment', request_id: rid(), environment_id: e.id, kind });
      if (!r.ok) {
        state.actionError = r.error.message;
        return;
      }
      track(r.data.operation_id);
      if (kind === 'safari') {
        try {
          await openPreparePage(b, r.data.operation_id, null);
        } catch {
          state.actionError = '打开准备页失败：无法创建标签页，请点击「继续验证」';
        }
      }
      void refresh();
    });
  }

  async function continueVerification(): Promise<void> {
    const pending = state.current?.pendingVerification;
    if (!pending) return;
    await run('continue', async () => {
      try {
        await openPreparePage(b, pending.operation_id, null);
      } catch {
        state.actionError = '打开准备页失败：无法创建标签页';
      }
    });
  }

  async function cancelPending(): Promise<void> {
    const pending = state.current?.pendingVerification;
    if (!pending) return;
    await run('cancel', async () => {
      const r = await client.call({ type: 'cancelOperation', request_id: rid(), operation_id: pending.operation_id });
      if (!r.ok) {
        state.actionError = r.error.message;
        return;
      }
      track(pending.operation_id);
      state.notice = '已提交取消';
      void refresh();
    });
  }

  async function acknowledgeAccount(): Promise<void> {
    const e = env();
    if (!e) return;
    await run('ack_account', async () => {
      const r = await client.call({ type: 'acknowledgeAccountChange', request_id: rid(), environment_id: e.id, expected_revision: e.revision });
      if (!r.ok) {
        state.actionError = r.error.message;
        return;
      }
      state.notice = '已记录核对';
      void refresh();
    });
  }

  async function acknowledgeWindows(): Promise<void> {
    await run('ack_windows', async () => {
      const r = await client.call({ type: 'acknowledgeWindowsClosed', request_id: rid() });
      if (!r.ok) {
        state.actionError = r.error.message;
        return;
      }
      state.notice = r.data.cleared ? '已清除旧窗口警告' : '没有需要清除的旧窗口警告';
      void refresh();
    });
  }

  function clearMessages(): void {
    state.actionError = null;
    state.notice = null;
  }

  return {
    state,
    start,
    stop,
    refresh,
    activate,
    enterNormal,
    confirmPolicy,
    dismissConfirm,
    bind,
    createEnvironment,
    updateEnvironment,
    openOrders,
    probe,
    continueVerification,
    cancelPending,
    acknowledgeAccount,
    acknowledgeWindows,
    clearMessages,
  };
}

export type PopupController = ReturnType<typeof createPopupController>;
