// 唯一执行器（docs/ARCHITECTURE.md §6.1）：串行领取 outbox，所有 Surge 写入都在这里发生（全局写锁）。
// 等待场景到达或实测的操作状态为 waiting，不占用执行器；原生桥消息或计时器（outbox 的可用时间）重新入队。
// 内部任务（对账、秘密回收）也排在同一条通道上，路由或发布写入进行中时自动延后。

import type { OperationRecord, OutboxRecord } from '../db/index.js';
import type { Engine } from './context.js';

export type DispatchFn = (op: OperationRecord, row: OutboxRecord) => Promise<void>;

interface InternalTask {
  name: string;
  run: () => Promise<void>;
}

export class Executor {
  private stopped = true;
  private loopPromise: Promise<void> | null = null;
  private again = false;
  private busy = false;
  private exclusive = false;
  private wakeCancel: (() => void) | null = null;
  private readonly internal: InternalTask[] = [];
  currentOperationId: string | null = null;

  constructor(
    private readonly engine: Engine,
    private readonly dispatch: DispatchFn,
  ) {}

  start(): void {
    this.stopped = false;
    this.kick();
  }

  /** 停止领取新任务并等待当前任务结束；从不改变入口或选择。 */
  async stop(): Promise<void> {
    this.stopped = true;
    this.wakeCancel?.();
    this.wakeCancel = null;
    if (this.loopPromise) await this.loopPromise.catch(() => undefined);
  }

  get running(): boolean {
    return !this.stopped;
  }

  /** 有任务正在执行（或独占任务进行中）。 */
  isBusy(): boolean {
    return this.busy || this.exclusive;
  }

  kick(): void {
    if (this.stopped) return;
    if (this.loopPromise) {
      this.again = true;
      return;
    }
    this.loopPromise = this.loop()
      .catch((err: unknown) => {
        this.engine.log('error', 'executor.loop_failed', { error: err instanceof Error ? err.name : 'unknown' });
      })
      .finally(() => {
        this.loopPromise = null;
        if (this.again && !this.stopped) {
          this.again = false;
          this.kick();
        } else {
          this.again = false;
          this.scheduleWake();
        }
      });
  }

  /** 在执行器通道上运行内部任务（对账、清扫）；返回其结果。 */
  runInternal<T>(name: string, fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.internal.push({
        name,
        run: async () => {
          try {
            resolve(await fn());
          } catch (err) {
            reject(err);
          }
        },
      });
      if (this.stopped) {
        // 未启动（例如测试或启动早期）：直接在通道外串行执行
        void this.drainInternalWhileStopped();
        return;
      }
      this.kick();
    });
  }

  private draining = false;

  private async drainInternalWhileStopped(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.stopped && !this.busy && !this.exclusive) {
        const task = this.internal.shift();
        if (!task) break;
        this.busy = true;
        try {
          await task.run();
        } finally {
          this.busy = false;
        }
      }
    } finally {
      this.draining = false;
    }
  }

  /**
   * 动作前的同步检查：执行器空闲时独占通道运行 fn；正在写入时立即返回 null（调用方按“未受控”拒绝）。
   */
  async tryRunExclusive<T>(fn: () => Promise<T>): Promise<T | null> {
    if (this.busy || this.exclusive || this.internal.length > 0) return null;
    this.exclusive = true;
    try {
      return await fn();
    } finally {
      this.exclusive = false;
      if (!this.stopped) this.kick();
    }
  }

  private async loop(): Promise<void> {
    // 让调用方先完成同步部分（例如受理事务后的事件发布）
    await Promise.resolve();
    for (;;) {
      if (this.stopped || this.exclusive) return;
      const task = this.internal.shift();
      if (task) {
        this.busy = true;
        try {
          await task.run();
        } finally {
          this.busy = false;
        }
        continue;
      }
      const row = this.engine.repos.outbox.claimNext(this.engine.now());
      if (!row) return;
      this.busy = true;
      try {
        await this.dispatchRow(row);
      } finally {
        this.busy = false;
      }
    }
  }

  private async dispatchRow(row: OutboxRecord): Promise<void> {
    const op = this.engine.repos.operations.get(row.operationId);
    if (!op) {
      this.engine.repos.outbox.markDone(row.id);
      return;
    }
    this.currentOperationId = op.id;
    try {
      await this.dispatch(op, row);
    } catch (err) {
      // 处理器应自行结算；这里只兜底，避免操作永远停在 running
      const cur = this.engine.repos.operations.get(op.id);
      if (cur && (cur.status === 'running' || cur.status === 'queued')) {
        this.engine.updateOp(op.id, { phase: 'FAILED', status: 'failed', error: this.engine.errorBody(err, '执行失败：内部错误') }, '执行失败：内部错误');
      }
      this.engine.log('error', 'executor.dispatch_failed', { operationId: op.id, kind: op.kind, error: err instanceof Error ? err.name : 'unknown' });
    } finally {
      this.engine.repos.outbox.markDone(row.id);
      this.currentOperationId = null;
    }
  }

  private scheduleWake(): void {
    this.wakeCancel?.();
    this.wakeCancel = null;
    if (this.stopped) return;
    const next = this.engine.repos.outbox.nextAvailableAt();
    if (next === null) return;
    const delay = Math.max(0, Date.parse(next) - this.engine.now().getTime());
    this.wakeCancel = this.engine.clock.setTimeout(() => {
      this.wakeCancel = null;
      this.kick();
    }, delay);
  }

  /** 测试与停止：等到没有可执行的任务（到期的 outbox 与内部任务）。 */
  async idle(): Promise<void> {
    for (let i = 0; i < 10_000; i++) {
      if (this.loopPromise) {
        await this.loopPromise.catch(() => undefined);
        continue;
      }
      if (this.stopped) return;
      const next = this.engine.repos.outbox.nextAvailableAt();
      const due = next !== null && Date.parse(next) <= this.engine.now().getTime();
      if (due || this.internal.length > 0) {
        this.kick();
        continue;
      }
      return;
    }
  }
}
