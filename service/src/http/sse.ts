// /api/events 事件流（docs/ARCHITECTURE.md §7.1）。客户端用 fetch 流式读取（需要带 Authorization 头）。
// 先订阅再补读，补读期间到达的新事件暂存后按序号去重发送，避免续读与实时之间出现空洞。
// 补读起点超出缓冲、晚于当前序号（服务重启后序号从头开始）或格式不正确时发送 snapshot.required。
// 心跳时检查会话（不续期）；会话撤销或过期即结束事件流。

import type { ServerResponse } from 'node:http';
import { SSE_HEARTBEAT_MS, type ServiceEvent } from '@sfe/contract';
import type { EventBus } from '../ports.js';

/** 慢客户端积压超过此值即断开，由客户端按 Last-Event-ID 续读。 */
export const SSE_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

export interface EventStreamOptions {
  events: EventBus;
  /** Last-Event-ID 请求头优先，其次 ?since=；都没有为 null（只推送之后的新事件）。 */
  resumeFrom: string | null;
  heartbeatMs?: number;
  /** 心跳时调用；返回 false 时结束事件流。 */
  isSessionValid: () => boolean;
  onClose: (reason: EventStreamCloseReason) => void;
}

export type EventStreamCloseReason = 'client_closed' | 'session_ended' | 'server_closed' | 'backpressure' | 'error';

export interface EventStreamHandle {
  close(reason: EventStreamCloseReason): void;
}

export function parseResumePoint(raw: string | null): { kind: 'none' } | { kind: 'seq'; seq: number } | { kind: 'invalid' } {
  if (raw === null) return { kind: 'none' };
  const v = raw.trim();
  if (v === '') return { kind: 'none' };
  if (!/^\d{1,15}$/.test(v)) return { kind: 'invalid' };
  return { kind: 'seq', seq: Number(v) };
}

export function formatSseEvent(event: ServiceEvent): string {
  // JSON.stringify 会转义换行，所以 data 只占一行
  return `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export function formatSnapshotRequired(reason: string): string {
  return `event: snapshot.required\ndata: ${JSON.stringify({ type: 'snapshot.required', reason })}\n\n`;
}

export function openEventStream(res: ServerResponse, opts: EventStreamOptions): EventStreamHandle {
  const { events } = opts;
  let closed = false;
  let replaying = true;
  const pending: ServiceEvent[] = [];
  let lastSent = events.currentSequence();

  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const write = (chunk: string): void => {
    if (closed) return;
    res.write(chunk);
    if (res.writableLength > SSE_MAX_BUFFERED_BYTES) handle.close('backpressure');
  };

  const send = (event: ServiceEvent): void => {
    if (event.sequence <= lastSent) return;
    lastSent = event.sequence;
    write(formatSseEvent(event));
  };

  const unsubscribe = events.subscribe((event) => {
    if (closed) return;
    if (replaying) pending.push(event);
    else send(event);
  });

  const timer = setInterval(() => {
    if (closed) return;
    let valid = false;
    try {
      valid = opts.isSessionValid();
    } catch {
      valid = false;
    }
    if (!valid) {
      handle.close('session_ended');
      return;
    }
    write(': heartbeat\n\n');
  }, opts.heartbeatMs ?? SSE_HEARTBEAT_MS);

  const handle: EventStreamHandle = {
    close(reason) {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      unsubscribe();
      try {
        res.end();
      } catch {
        // 连接已断开
      }
      opts.onClose(reason);
    },
  };

  res.on('close', () => handle.close('client_closed'));
  res.on('error', () => handle.close('error'));

  write(': connected\n\n');
  const resume = parseResumePoint(opts.resumeFrom);
  if (resume.kind === 'invalid') {
    write(formatSnapshotRequired('invalid_last_event_id'));
  } else if (resume.kind === 'seq') {
    if (resume.seq > events.currentSequence()) {
      write(formatSnapshotRequired('sequence_ahead'));
    } else {
      const missed = events.since(resume.seq);
      if (missed === null) {
        write(formatSnapshotRequired('events_expired'));
      } else {
        lastSent = resume.seq;
        for (const e of missed) send(e);
      }
    }
  }
  replaying = false;
  for (const e of pending.splice(0)) send(e);
  return handle;
}
