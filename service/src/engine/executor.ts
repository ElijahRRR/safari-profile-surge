// 唯一执行器（docs/ARCHITECTURE.md §6.1）：串行领取 outbox，所有 Surge 写入都在这里发生（全局写锁）。
// 等待场景到达或实测的操作状态为 waiting，不占用执行器；原生桥消息或计时器（outbox 的可用时间）重新入队。
// 内部任务（对账、秘密回收）也排在同一条通道上，路由或发布写入进行中时自动延后。

import type { OperationRecord, OutboxRecord } from '../db/index.js';
import { OPEN_STATUSES, isRouteOperation } from '../domain/operations.js';
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
      const row = this.engine.repos.outbox.claimNext(this.engine.now(), this.claimPreference());
      if (!row) return;
      this.busy = true;
      try {
        await this.dispatchRow(row);
      } finally {
        this.busy = false;
      }
    }
  }

  /**
   * 领取顺序（§6.1），按优先级排列的操作组，各组内仍按可用时间与 id（受理顺序）：
   * 1. 崩溃恢复：状态仍是 running 的操作。串行执行器在两次领取之间没有执行中的操作，只有上一次进程在执行中退出时才有（启动时
   *    releaseClaims 放回了它的条目，可用时间不晚于启动时间）：它在退出前持有全局写锁，Surge 可能停在它半途的写入上，先由它按
   *    事实恢复（回滚或重新执行），之后的操作才从恢复后的状态开始。否则排队的普通模式会先执行并报告成功，之后恢复的切换再按快照
   *    回滚或重新执行、重新阻断 Safari——旧请求的结果覆盖了新请求（方案 1 设计「多环境争抢」）。优先只在可以领取的条目之间起作用：
   *    计时器以外的条目一律可以领取（claimNext），墙上时钟回拨不会让恢复或排队的普通模式领取不到。
   * 2. 有未完成的普通模式（排队中；崩溃恢复中的已在第 1 组）时，路由操作（isRouteOperation：激活、普通模式、重测，以及已进入
   *    切换或 WAITING_ROUTE 的活动环境发布）先于发布、预检等其他操作：进入普通模式永远可用（§5.2），被它取代或把路由交给它的
   *    激活（handlers/route.ts yieldToQueuedNormal）之后它立即执行，不排在受理更早的无关操作之后，过渡中的路由（阻断、已写入的
   *    ACTIVE）不因此多停留。路由操作之间仍按受理顺序：排在它之前的激活开始执行时就会停下，把路由交给它。
   */
  private claimPreference(): string[][] {
    const open = this.engine.repos.operations.listByStatus([...OPEN_STATUSES]);
    const recovering = open.filter((o) => o.status === 'running').map((o) => o.id);
    const normalOpen = open.some((o) => o.kind === 'route.normal' && (o.status === 'queued' || o.status === 'running'));
    const routeFirst = normalOpen ? open.filter((o) => o.status !== 'running' && isRouteOperation(o)).map((o) => o.id) : [];
    return [recovering, routeFirst];
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
    const next = this.engine.repos.outbox.nextAvailableAt(this.engine.now());
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
      const next = this.engine.repos.outbox.nextAvailableAt(this.engine.now());
      const due = next !== null && Date.parse(next) <= this.engine.now().getTime();
      if (due || this.internal.length > 0) {
        this.kick();
        continue;
      }
      return;
    }
  }
}
