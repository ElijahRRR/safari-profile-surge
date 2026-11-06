// 事件总线：内存环形缓冲（EVENT_BUFFER_SIZE），序号持久化在 meta 中，跨重启单调递增。
// since() 在请求的序号已被挤出缓冲、或早于本进程第一条事件时返回 null（客户端改读完整快照）。
// 事件只含脱敏视图；发布方负责在事务提交之后再发布。

import { EVENT_BUFFER_SIZE, type ServiceEvent, type ServiceEventPayload } from '@sfe/contract';
import type { MetaRepo } from '../db/index.js';
import type { EventBus } from '../ports.js';

export interface EventBusOptions {
  meta: Pick<MetaRepo, 'eventSequence' | 'setEventSequence'>;
  capacity?: number;
  /** 订阅者抛错时的报告（不影响其他订阅者）。 */
  onListenerError?: (err: unknown) => void;
}

export interface ServiceEventBus extends EventBus {
  /** 本进程发布的第一条事件之前的序号（此前的事件不在缓冲中）。 */
  readonly baseSequence: number;
  readonly size: number;
}

export function createEventBus(opts: EventBusOptions): ServiceEventBus {
  const capacity = opts.capacity ?? EVENT_BUFFER_SIZE;
  let seq = opts.meta.eventSequence();
  const base = seq;
  const buffer: ServiceEvent[] = [];
  const listeners = new Set<(e: ServiceEvent) => void>();

  return {
    get baseSequence() {
      return base;
    },
    get size() {
      return buffer.length;
    },
    publish(event: ServiceEventPayload): number {
      seq += 1;
      try {
        opts.meta.setEventSequence(seq);
      } catch {
        // 序号持久化失败只影响重启后的续读（客户端会改读快照），不影响本次发布
      }
      const stored = { ...event, sequence: seq } as ServiceEvent;
      buffer.push(stored);
      if (buffer.length > capacity) buffer.shift();
      for (const l of [...listeners]) {
        try {
          l(stored);
        } catch (err) {
          opts.onListenerError?.(err);
        }
      }
      return seq;
    },
    since(sinceSequence: number): ServiceEvent[] | null {
      if (!Number.isInteger(sinceSequence) || sinceSequence < 0) return null;
      if (sinceSequence >= seq) return [];
      // 早于本进程第一条事件：中间的事件属于上一个进程，已不可补读
      if (sinceSequence < base) return null;
      const oldest = buffer[0]?.sequence ?? seq + 1;
      if (sinceSequence + 1 < oldest) return null;
      return buffer.filter((e) => e.sequence > sinceSequence);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    currentSequence(): number {
      return seq;
    },
  };
}
