// 时钟：生产用系统时钟，测试用可控时钟。业务代码只通过 Clock 取时间与定时，便于确定性测试。

import type { Clock } from '../ports.js';

/**
 * 系统时钟。定时器 unref：服务存活由 HTTP/IPC 监听维持，停止服务时不会被未到期的
 * 等待截止（例如 600 秒的场景到达超时）拖住退出。
 */
export const systemClock: Clock = {
  now: () => new Date(),
  setTimeout(fn: () => void, ms: number): () => void {
    const handle = setTimeout(fn, Math.max(0, ms));
    handle.unref?.();
    return () => clearTimeout(handle);
  },
};

interface FakeTimer {
  id: number;
  at: number;
  fn: () => void;
}

/** 防止回调里不断安排 0 毫秒定时器造成死循环。 */
const MAX_TIMERS_PER_ADVANCE = 100_000;

/**
 * 测试时钟。advance(ms) 按到期时间顺序（同一时刻按安排顺序）触发定时器，回调执行时 now()
 * 等于该定时器的到期时间；回调中新安排且在推进范围内到期的定时器也会触发。
 * set(date) 只改变当前时间（与 vi.setSystemTime 一致），不触发定时器；已到期的定时器在下一次
 * advance（含 advance(0)）时触发。
 */
export class FakeClock implements Clock {
  private current: number;
  private timers: FakeTimer[] = [];
  private nextId = 1;

  constructor(start: Date | string | number = '2026-01-01T00:00:00.000Z') {
    this.current = toMillis(start);
  }

  now(): Date {
    return new Date(this.current);
  }

  setTimeout(fn: () => void, ms: number): () => void {
    const timer: FakeTimer = { id: this.nextId++, at: this.current + Math.max(0, Number.isFinite(ms) ? ms : 0), fn };
    this.timers.push(timer);
    return () => {
      this.timers = this.timers.filter((t) => t.id !== timer.id);
    };
  }

  /** 推进时间并同步触发到期的定时器。 */
  advance(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) throw new RangeError(`advance(${ms}): ms must be a finite non-negative number`);
    const target = this.current + ms;
    let fired = 0;
    for (;;) {
      const next = this.takeDue(target);
      if (!next) break;
      if (++fired > MAX_TIMERS_PER_ADVANCE) throw new Error('FakeClock: too many timers fired in one advance');
      this.current = Math.max(this.current, next.at);
      next.fn();
    }
    this.current = Math.max(this.current, target);
  }

  /**
   * 与 advance 相同，但每触发一个定时器后让出事件循环，使回调中启动的异步工作（Promise 链、
   * I/O 回调）有机会推进。适合测试执行器这类“定时器 → 异步处理”的流程。
   */
  async advanceAsync(ms: number): Promise<void> {
    if (!Number.isFinite(ms) || ms < 0) throw new RangeError(`advanceAsync(${ms}): ms must be a finite non-negative number`);
    const target = this.current + ms;
    let fired = 0;
    await flushMacrotask();
    for (;;) {
      const next = this.takeDue(target);
      if (!next) break;
      if (++fired > MAX_TIMERS_PER_ADVANCE) throw new Error('FakeClock: too many timers fired in one advance');
      this.current = Math.max(this.current, next.at);
      next.fn();
      await flushMacrotask();
    }
    this.current = Math.max(this.current, target);
  }

  set(date: Date | string | number): void {
    this.current = toMillis(date);
  }

  /** 尚未触发的定时器数量。 */
  pendingTimers(): number {
    return this.timers.length;
  }

  /** 最早的未触发定时器的到期时间；没有时为 null。 */
  nextTimerAt(): Date | null {
    if (this.timers.length === 0) return null;
    return new Date(Math.min(...this.timers.map((t) => t.at)));
  }

  private takeDue(target: number): FakeTimer | null {
    let best: FakeTimer | null = null;
    for (const t of this.timers) {
      if (t.at > target) continue;
      if (!best || t.at < best.at || (t.at === best.at && t.id < best.id)) best = t;
    }
    if (best) {
      const id = best.id;
      this.timers = this.timers.filter((t) => t.id !== id);
    }
    return best;
  }
}

function toMillis(value: Date | string | number): number {
  const ms = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ms)) throw new RangeError(`invalid time: ${String(value)}`);
  return ms;
}

function flushMacrotask(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
