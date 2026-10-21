// /api/events 事件流：用 fetch 流式读取（EventSource 不能带 Authorization 头）。断线后按
// Last-Event-ID 续读，指数退避重连；收到 snapshot.required 时交给调用方重新读取完整快照。
// 15 秒心跳之外再加空闲看门狗，长时间没有任何字节时主动断开重连。

import { API_ROUTES, AUTH_SCHEME, type ServiceEvent } from '@sfe/contract';
import { SseParser, type SseMessage } from './sse';
import type { TokenStore } from './session-token';

export type StreamState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'stopped';

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const defaultTimers: Timers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface EventStreamOptions {
  tokens: TokenStore;
  onEvent(event: ServiceEvent): void;
  /** 事件已超出服务端缓冲：重新读取快照，再用 resumeFrom 设置续读位置。 */
  onSnapshotRequired(reason: string): void | Promise<void>;
  onUnauthorized?(): void;
  onStateChange?(state: StreamState): void;
  url?: string;
  fetch?: typeof fetch;
  timers?: Timers;
  initialDelayMs?: number;
  maxDelayMs?: number;
  /** 心跳是 15 秒；超过这个时间没有任何数据即视为断线。 */
  idleTimeoutMs?: number;
}

export class EventStream {
  private readonly opts: Required<Pick<EventStreamOptions, 'initialDelayMs' | 'maxDelayMs' | 'idleTimeoutMs'>> & EventStreamOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly timers: Timers;
  private lastId: string | null = null;
  private attempt = 0;
  private serverRetryMs: number | null = null;
  private abort: AbortController | null = null;
  private reconnectTimer: unknown = null;
  private idleTimer: unknown = null;
  private running = false;
  private generation = 0;
  private _state: StreamState = 'idle';

  constructor(opts: EventStreamOptions) {
    this.opts = { initialDelayMs: 1000, maxDelayMs: 30000, idleTimeoutMs: 45000, ...opts };
    this.fetchImpl = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.timers = opts.timers ?? defaultTimers;
  }

  get state(): StreamState {
    return this._state;
  }

  get lastEventId(): string | null {
    return this.lastId;
  }

  /** 开始读取；lastEventId 通常是刚读到的快照序号。 */
  start(lastEventId: string | null = null): void {
    this.stopInternal();
    this.running = true;
    this.lastId = lastEventId;
    this.attempt = 0;
    void this.connect();
  }

  stop(): void {
    this.stopInternal();
    this.setState('stopped');
  }

  /** 重新读取快照后设置续读位置（下一次连接时作为 Last-Event-ID）。 */
  resumeFrom(id: string | null): void {
    this.lastId = id;
  }

  /** 计算第 attempt 次重连的等待时间（服务端 retry 字段优先）。 */
  backoffDelay(attempt: number): number {
    if (this.serverRetryMs !== null) return this.serverRetryMs;
    return Math.min(this.opts.maxDelayMs, this.opts.initialDelayMs * 2 ** attempt);
  }

  private stopInternal(): void {
    this.running = false;
    this.generation++;
    if (this.reconnectTimer !== null) this.timers.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.clearIdle();
    this.abort?.abort();
    this.abort = null;
  }

  private setState(state: StreamState): void {
    if (this._state === state) return;
    this._state = state;
    this.opts.onStateChange?.(state);
  }

  private clearIdle(): void {
    if (this.idleTimer !== null) this.timers.clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private armIdle(controller: AbortController): void {
    this.clearIdle();
    this.idleTimer = this.timers.setTimeout(() => controller.abort(), this.opts.idleTimeoutMs);
  }

  private async connect(): Promise<void> {
    const gen = this.generation;
    const token = this.opts.tokens.get();
    if (!token) {
      this.running = false;
      this.setState('stopped');
      this.opts.onUnauthorized?.();
      return;
    }
    this.setState(this.attempt === 0 ? 'connecting' : 'reconnecting');
    const controller = new AbortController();
    this.abort = controller;
    const headers: Record<string, string> = { Accept: 'text/event-stream', Authorization: `${AUTH_SCHEME} ${token}` };
    if (this.lastId) headers['Last-Event-ID'] = this.lastId;

    try {
      const res = await this.fetchImpl(this.opts.url ?? API_ROUTES.events.path, {
        method: 'GET',
        headers,
        credentials: 'omit',
        cache: 'no-store',
        signal: controller.signal,
      });
      if (gen !== this.generation) return;
      if (res.status === 401) {
        this.running = false;
        this.setState('stopped');
        this.opts.onUnauthorized?.();
        return;
      }
      if (!res.ok || !res.body) throw new Error(`event stream status ${res.status}`);
      this.attempt = 0;
      this.setState('open');
      const reader = res.body.getReader();
      const parser = new SseParser({
        onMessage: (m) => this.handleMessage(m, gen),
        onRetry: (ms) => {
          this.serverRetryMs = Math.min(Math.max(ms, 500), this.opts.maxDelayMs);
        },
      });
      this.armIdle(controller);
      for (;;) {
        const { done, value } = await reader.read();
        if (gen !== this.generation) return;
        if (done) break;
        this.armIdle(controller);
        if (value) parser.pushBytes(value);
      }
      parser.end();
    } catch {
      if (gen !== this.generation) return;
    } finally {
      if (gen === this.generation) this.clearIdle();
    }
    if (gen === this.generation && this.running) this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    const delay = this.backoffDelay(this.attempt);
    this.attempt++;
    this.setState('reconnecting');
    this.reconnectTimer = this.timers.setTimeout(() => {
      this.reconnectTimer = null;
      if (this.running) void this.connect();
    }, delay);
  }

  private handleMessage(message: SseMessage, gen: number): void {
    if (gen !== this.generation) return;
    if (message.id !== '') this.lastId = message.id;
    let payload: unknown;
    try {
      payload = JSON.parse(message.data);
    } catch {
      return;
    }
    if (!payload || typeof payload !== 'object') return;
    const type = (payload as { type?: unknown }).type ?? (message.event !== 'message' ? message.event : undefined);
    if (typeof type !== 'string') return;
    if (type === 'snapshot.required') {
      const reason = (payload as { reason?: unknown }).reason;
      void this.opts.onSnapshotRequired(typeof reason === 'string' ? reason : '');
      return;
    }
    let sequence = (payload as { sequence?: unknown }).sequence;
    if (typeof sequence !== 'number' && /^\d+$/.test(message.id)) sequence = Number(message.id);
    if (typeof sequence !== 'number' || !Number.isFinite(sequence)) return;
    this.opts.onEvent({ ...(payload as object), type, sequence } as ServiceEvent);
  }
}
