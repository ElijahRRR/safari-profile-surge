// 准备页：在目标场景中表示“已到达”，等入口到达 VERIFY_ONLY（或重测时的 ACTIVE）后，
// 由本场景请求固定的检测服务并提交结果，再等待操作结束。成功之前从不导航到 Amazon；
// 成功后按环境设置（或用户从“打开订单页”发起）在服务确认“受控”时打开或定位订单页。

import { reactive } from 'vue';
import { VERIFY_ENDPOINTS, type BeginVerificationResponse, type OperationView, type SiteCode } from '@sfe/contract';
import type { WebExtBrowser } from '../shared/browser';
import type { PageClient } from '../shared/messages';
import { openOrLocateOrders, type OrdersResult } from '../shared/orders';
import type { PrepareIntent } from '../shared/pages';
import { statusIsTerminal } from '../shared/text';

export const PREPARE_POLL_MS = 1000;
const VERIFY_TIMEOUT_MAX_MS = 20000;
const VERIFY_TIMEOUT_MIN_MS = 1000;

export type PrepareStage =
  | 'invalid'
  | 'arriving'
  | 'pending'
  | 'verifying'
  | 'submitting'
  | 'waiting_result'
  | 'succeeded'
  | 'failed'
  | 'parked'
  | 'error';

export interface VerificationResult {
  observed_ip: string | null;
  http_status: number | null;
  error: string | null;
  started_at: string;
  finished_at: string;
}

export interface PrepareState {
  stage: PrepareStage;
  operationId: string | null;
  intent: PrepareIntent;
  phase: string | null;
  message: string | null;
  operation: OperationView | null;
  verification: VerificationResult | null;
  error: string | null;
  exitIp: string | null;
  ordersResult: OrdersResult | null;
  ordersBlockedReason: string | null;
  ordersOfferable: boolean;
  now: Date;
}

export type VerifyFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface PrepareDeps {
  browser: WebExtBrowser;
  client: PageClient;
  fetchImpl: VerifyFetch;
  navigate: (url: string) => void;
  pollMs?: number;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

/** 只允许请求构建时固定的检测服务（https、主机完全一致、无用户信息与端口）。 */
export function isAllowedVerifyUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
  return VERIFY_ENDPOINTS.some((e) => e.host === url.hostname);
}

const IPV4_RE = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const IPV6_RE = /^[0-9A-Fa-f:.]{2,45}$/;

export function extractIp(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const ip = (body as { ip?: unknown }).ip;
  if (typeof ip !== 'string') return null;
  if (IPV4_RE.test(ip)) return ip;
  if (ip.includes(':') && IPV6_RE.test(ip)) return ip;
  return null;
}

const FAILED_STATUSES = new Set(['failed', 'needs_attention', 'superseded']);
const FAILED_PHASES = new Set(['FAILED', 'BLOCKED_NEEDS_ATTENTION', 'SUPERSEDED']);

export function createPrepareController(operationId: string | null, intent: PrepareIntent, deps: PrepareDeps) {
  const client = deps.client;
  const pollMs = deps.pollMs ?? PREPARE_POLL_MS;
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const state = reactive<PrepareState>({
    stage: operationId ? 'arriving' : 'invalid',
    operationId,
    intent,
    phase: null,
    message: null,
    operation: null,
    verification: null,
    error: null,
    exitIp: null,
    ordersResult: null,
    ordersBlockedReason: null,
    ordersOfferable: false,
    now: now(),
  });

  let running = false;
  let ordersHandled = false;

  async function runVerification(url: string, deadline: string): Promise<VerificationResult> {
    const startedAt = now();
    const result: VerificationResult = {
      observed_ip: null,
      http_status: null,
      error: null,
      started_at: startedAt.toISOString(),
      finished_at: startedAt.toISOString(),
    };
    if (!isAllowedVerifyUrl(url)) {
      result.error = 'verify_url_not_allowed';
      return result;
    }
    const remaining = Date.parse(deadline) - startedAt.getTime();
    const timeoutMs = Number.isNaN(remaining)
      ? VERIFY_TIMEOUT_MAX_MS
      : Math.min(VERIFY_TIMEOUT_MAX_MS, Math.max(VERIFY_TIMEOUT_MIN_MS, remaining - 1000));
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await deps.fetchImpl(url, {
        method: 'GET',
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: ctrl.signal,
      });
      result.http_status = res.status;
      if (!res.ok) {
        result.error = `http_${res.status}`;
      } else {
        let body: unknown = null;
        try {
          body = await res.json();
        } catch {
          body = null;
        }
        result.observed_ip = extractIp(body);
        if (!result.observed_ip) result.error = 'invalid_response';
      }
    } catch {
      result.error = ctrl.signal.aborted ? 'timeout' : 'network_error';
    } finally {
      clearTimeout(timer);
    }
    result.finished_at = now().toISOString();
    return result;
  }

  async function readOrdersPermission(): Promise<{ site: SiteCode; autoOpen: boolean } | null> {
    const st = await client.call({ type: 'getCurrentState' });
    if (!st.ok) {
      state.ordersBlockedReason = st.error.message;
      return null;
    }
    const env = st.data.environment;
    state.exitIp = st.data.route?.lastSafariProbe?.exitIp ?? env?.probes.safari?.exitIp ?? state.exitIp;
    if (!env) {
      state.ordersBlockedReason = '当前场景未绑定环境';
      return null;
    }
    if (!st.data.ordersAllowed) {
      state.ordersBlockedReason = st.data.ordersBlockedReason ?? '订单页暂不可用';
      return null;
    }
    state.ordersBlockedReason = null;
    return { site: env.site, autoOpen: env.autoOpenOrders };
  }

  async function afterActiveVerified(): Promise<void> {
    if (ordersHandled) return;
    ordersHandled = true;
    const permission = await readOrdersPermission();
    if (!permission) return;
    if (permission.autoOpen || state.intent === 'orders') {
      state.ordersResult = await openOrLocateOrders(deps.browser, permission.site, { navigateCurrent: deps.navigate });
    } else {
      state.ordersOfferable = true;
    }
  }

  /** 用户在成功页点击“打开订单页”：重新确认受控后才打开。 */
  async function openOrders(): Promise<void> {
    if (state.stage !== 'succeeded') return;
    const permission = await readOrdersPermission();
    if (!permission) {
      state.ordersOfferable = false;
      return;
    }
    state.ordersResult = await openOrLocateOrders(deps.browser, permission.site, { navigateCurrent: deps.navigate });
  }

  async function finish(op: OperationView): Promise<void> {
    state.operation = op;
    if (FAILED_STATUSES.has(op.status) || FAILED_PHASES.has(op.phase)) {
      state.stage = 'failed';
      state.error = op.error?.message ?? null;
      return;
    }
    if (op.status === 'succeeded' || op.phase === 'ACTIVE_VERIFIED') {
      state.stage = 'succeeded';
      if (op.phase === 'ACTIVE_VERIFIED') await afterActiveVerified();
      return;
    }
    state.stage = 'parked';
  }

  async function waitForOperation(id: string): Promise<void> {
    state.stage = 'waiting_result';
    while (running) {
      const o = await client.call({ type: 'getOperation', operation_id: id });
      state.now = now();
      if (!running) return;
      if (o.ok) {
        state.operation = o.data;
        if (statusIsTerminal(o.data.status)) {
          await finish(o.data);
          return;
        }
      } else if (o.error.code === 'NOT_FOUND') {
        state.stage = 'error';
        state.error = o.error.message;
        return;
      }
      await sleep(pollMs);
    }
  }

  async function handleBeginError(id: string, message: string): Promise<void> {
    // 操作可能已结束（例如已超时回滚）：读一次操作给出最终结果。
    const o = await client.call({ type: 'getOperation', operation_id: id });
    if (o.ok && statusIsTerminal(o.data.status)) {
      await finish(o.data);
      return;
    }
    state.stage = 'error';
    state.error = message;
  }

  async function submit(id: string, ready: Extract<BeginVerificationResponse, { status: 'ready' }>): Promise<void> {
    state.stage = 'verifying';
    const verification = await runVerification(ready.verify_url, ready.deadline);
    state.verification = verification;
    if (!running) return;
    state.stage = 'submitting';
    const sub = await client.call({
      type: 'submitSafariVerification',
      operation_id: id,
      test_id: ready.test_id,
      route_epoch: ready.route_epoch,
      observed_ip: verification.observed_ip,
      http_status: verification.http_status,
      error: verification.error,
      started_at: verification.started_at,
      finished_at: verification.finished_at,
    });
    if (!sub.ok) state.error = sub.error.message;
  }

  async function start(): Promise<void> {
    const id = state.operationId;
    if (!id || running) return;
    running = true;
    state.stage = 'arriving';
    state.error = null;
    const ps = await client.profileState(false);
    // 读不到时按“已有 Amazon 标签页”处理，本次记为未经启动验证。
    const amazonTabsOpen = ps.ok ? ps.data.amazon_tabs_open : true;
    while (running) {
      const r = await client.call({ type: 'beginSafariVerification', operation_id: id, amazon_tabs_open: amazonTabsOpen });
      state.now = now();
      if (!running) return;
      if (!r.ok) {
        await handleBeginError(id, r.error.message);
        running = false;
        return;
      }
      const data = r.data;
      if (data.status === 'pending') {
        state.stage = 'pending';
        state.phase = data.phase;
        state.message = data.message;
        await sleep(pollMs);
        continue;
      }
      if (data.status === 'not_needed') {
        state.message = data.message;
      } else {
        await submit(id, data);
      }
      await waitForOperation(id);
      running = false;
      return;
    }
  }

  function stop(): void {
    running = false;
  }

  async function retry(): Promise<void> {
    if (state.stage !== 'error') return;
    ordersHandled = false;
    await start();
  }

  return { state, start, stop, retry, openOrders };
}

export type PrepareController = ReturnType<typeof createPrepareController>;
