import { describe, expect, it, vi } from 'vitest';
import type { ServiceEvent } from '@sfe/contract';
import { EventStream } from '../src/api/event-stream';
import { createMemoryTokenStore } from '../src/api/session-token';
import { TOKEN, flush, manualTimers, route } from './fixtures';

const enc = new TextEncoder();

/** 可控的流式响应：push 推送字节，close 结束流，fail 让读取失败。 */
function controllableStream(status = 200) {
  const pending: Array<(r: ReadableStreamReadResult<Uint8Array>) => void> = [];
  const failures: Array<(e: unknown) => void> = [];
  const buffered: Array<ReadableStreamReadResult<Uint8Array>> = [];
  let error: unknown = null;
  const reader = {
    read(): Promise<ReadableStreamReadResult<Uint8Array>> {
      if (error) return Promise.reject(error);
      const b = buffered.shift();
      if (b) return Promise.resolve(b);
      return new Promise((resolve, reject) => {
        pending.push(resolve);
        failures.push(reject);
      });
    },
  };
  const deliver = (r: ReadableStreamReadResult<Uint8Array>) => {
    const p = pending.shift();
    failures.shift();
    if (p) p(r);
    else buffered.push(r);
  };
  return {
    response: { status, ok: status >= 200 && status < 300, body: { getReader: () => reader } } as unknown as Response,
    push: (text: string) => deliver({ done: false, value: enc.encode(text) }),
    close: () => deliver({ done: true, value: undefined }),
    fail: (e: unknown) => {
      error = e;
      failures.shift()?.(e);
      pending.shift();
    },
  };
}

function setup(statuses: number[] = []) {
  const streams: Array<ReturnType<typeof controllableStream>> = [];
  const requests: Array<{ url: string; headers: Record<string, string>; signal: AbortSignal | undefined }> = [];
  const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const s = controllableStream(statuses[requests.length] ?? 200);
    const signal = init?.signal ?? undefined;
    requests.push({ url: String(url), headers: { ...(init?.headers as Record<string, string>) }, signal });
    signal?.addEventListener('abort', () => s.fail(new DOMException('aborted', 'AbortError')));
    streams.push(s);
    return s.response;
  });
  const timers = manualTimers();
  const events: ServiceEvent[] = [];
  const onSnapshotRequired = vi.fn();
  const onUnauthorized = vi.fn();
  const states: string[] = [];
  const stream = new EventStream({
    tokens: createMemoryTokenStore(TOKEN),
    fetch: fetch as unknown as typeof globalThis.fetch,
    timers,
    onEvent: (e) => events.push(e),
    onSnapshotRequired,
    onUnauthorized,
    onStateChange: (s) => states.push(s),
  });
  return { stream, fetch, streams, requests, timers, events, onSnapshotRequired, onUnauthorized, states };
}

const routeEvent = (seq: number) => `id: ${seq}\nevent: route.updated\ndata: ${JSON.stringify({ type: 'route.updated', sequence: seq, route: route() })}\n\n`;

describe('EventStream', () => {
  it('connects with the bearer token and Last-Event-ID from the snapshot sequence', async () => {
    const t = setup();
    t.stream.start('10');
    await flush();
    expect(t.requests[0]?.url).toBe('/api/events');
    expect(t.requests[0]?.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(t.requests[0]?.headers['Last-Event-ID']).toBe('10');
    expect(t.requests[0]?.headers.Accept).toBe('text/event-stream');
    expect(t.states).toContain('open');
  });

  it('delivers parsed events with their sequence', async () => {
    const t = setup();
    t.stream.start(null);
    await flush();
    t.streams[0]!.push(routeEvent(11));
    t.streams[0]!.push(': heartbeat\n\n');
    await flush();
    expect(t.events).toHaveLength(1);
    expect(t.events[0]).toMatchObject({ type: 'route.updated', sequence: 11 });
    expect(t.stream.lastEventId).toBe('11');
  });

  it('falls back to the SSE id when the payload has no sequence', async () => {
    const t = setup();
    t.stream.start(null);
    await flush();
    t.streams[0]!.push(`id: 21\ndata: ${JSON.stringify({ type: 'environment.deleted', environmentId: 'env_9' })}\n\n`);
    await flush();
    expect(t.events[0]).toMatchObject({ type: 'environment.deleted', sequence: 21 });
  });

  it('reconnects after the stream ends and resumes from the last received id', async () => {
    const t = setup();
    t.stream.start('10');
    await flush();
    t.streams[0]!.push(routeEvent(11) + routeEvent(12));
    t.streams[0]!.close();
    await flush();
    expect(t.timers.queue.some((q) => q.ms === 1000)).toBe(true);
    const reconnect = t.timers.queue.find((q) => q.ms === 1000)!;
    t.timers.clearTimeout(reconnect.id);
    reconnect.fn();
    await flush();
    expect(t.requests).toHaveLength(2);
    expect(t.requests[1]?.headers['Last-Event-ID']).toBe('12');
  });

  it('backs off exponentially on repeated failures and caps the delay', () => {
    const t = setup();
    expect([0, 1, 2, 3, 4, 5, 6].map((a) => t.stream.backoffDelay(a))).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  });

  it('uses increasing delays when the server keeps failing, and resets after success', async () => {
    const t = setup([503, 503, 200]);
    t.stream.start('1');
    await flush();
    const delays: number[] = [];
    for (let i = 0; i < 2; i++) {
      const timer = t.timers.queue.find((q) => q.ms >= 1000)!;
      delays.push(timer.ms);
      t.timers.clearTimeout(timer.id);
      timer.fn();
      await flush();
    }
    expect(delays).toEqual([1000, 2000]);
    expect(t.requests).toHaveLength(3);
    expect(t.states[t.states.length - 1]).toBe('open');
    t.streams[2]!.close();
    await flush();
    expect(t.timers.queue.some((q) => q.ms === 1000)).toBe(true);
  });

  it('asks for a snapshot reload on snapshot.required and resumes from the given id', async () => {
    const t = setup();
    t.stream.start('5');
    await flush();
    t.streams[0]!.push(`id: 2000\ndata: ${JSON.stringify({ type: 'snapshot.required', reason: 'buffer_overflow', sequence: 2000 })}\n\n`);
    await flush();
    expect(t.onSnapshotRequired).toHaveBeenCalledWith('buffer_overflow');
    expect(t.events).toHaveLength(0);
    t.stream.resumeFrom('2500');
    t.streams[0]!.close();
    await flush();
    const timer = t.timers.queue.find((q) => q.ms === 1000)!;
    timer.fn();
    await flush();
    expect(t.requests[1]?.headers['Last-Event-ID']).toBe('2500');
  });

  it('stops without reconnecting on 401', async () => {
    const t = setup([401]);
    t.stream.start('1');
    await flush();
    expect(t.onUnauthorized).toHaveBeenCalledTimes(1);
    expect(t.timers.queue.filter((q) => q.ms >= 1000 && q.ms <= 30000)).toHaveLength(0);
    expect(t.stream.state).toBe('stopped');
  });

  it('aborts and reconnects when nothing arrives within the idle timeout', async () => {
    const t = setup();
    t.stream.start('1');
    await flush();
    const idle = t.timers.queue.find((q) => q.ms === 45000)!;
    expect(idle).toBeDefined();
    t.timers.clearTimeout(idle.id);
    idle.fn();
    await flush();
    expect(t.requests[0]?.signal?.aborted).toBe(true);
    expect(t.timers.queue.some((q) => q.ms === 1000)).toBe(true);
  });

  it('stop() aborts the request and never reconnects', async () => {
    const t = setup();
    t.stream.start('1');
    await flush();
    t.stream.stop();
    await flush();
    expect(t.requests[0]?.signal?.aborted).toBe(true);
    expect(t.timers.queue.filter((q) => q.ms === 1000)).toHaveLength(0);
    expect(t.stream.state).toBe('stopped');
  });

  it('ignores malformed payloads', async () => {
    const t = setup();
    t.stream.start(null);
    await flush();
    t.streams[0]!.push('data: not json\n\ndata: {"no":"type"}\n\n');
    await flush();
    expect(t.events).toHaveLength(0);
  });
});
