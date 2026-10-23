// 秘密引用的四步协议与回收（docs/ARCHITECTURE.md §4）：
// 1. 小事务插入 pending 引用；2. 写秘密存储（新引用，从不覆盖）；3. 调用方主事务写引用该 ref 的行并
//    markCommitted；4. 失败则删除秘密项与 pending 行。回收只按“是否仍被引用”判断，宁可晚删不可错删。
// createSecret/discard/sweep 会 await 秘密存储，不得在事务内调用；markCommitted/orphan 必须在调用方事务内调用。

import { SfeError } from '@sfe/contract';
import type { Clock, IdGenerator, SecretStore } from '../ports.js';
import type { Repositories } from '../db/index.js';
import type { SecretKind } from '../db/repos/secret-refs.js';
import { secretStoreError } from './errors.js';

export const DEFAULT_PENDING_TTL_MS = 10 * 60 * 1000;

export interface SecretOwner {
  kind: string;
  id: string;
}

export interface SweepResult {
  /** 秘密项与引用行都已删除。 */
  deleted: string[];
  /** 仍被引用，保留（并恢复为 committed）。 */
  kept: string[];
  /** 秘密项删除失败，保留引用行等待下次清扫。 */
  failed: string[];
}

export class SecretRefManager {
  constructor(
    private readonly repos: Repositories,
    private readonly store: SecretStore,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  /**
   * 第 1、2 步：先在独立小事务中登记 pending 引用，再写秘密存储。写入失败时尝试删除秘密项
   * （写入结果未知时可能已写入），删除成功才删除 pending 行；删除也失败则留给清扫重试。
   * 返回的引用在调用方 markCommitted 之前不可用。
   */
  async createSecret(value: string, kind: SecretKind, owner: SecretOwner): Promise<string> {
    if (this.repos.db.inTransaction()) throw new Error('createSecret must not be called inside a database transaction');
    const ref = this.ids.next('sec');
    this.repos.tx(() => {
      this.repos.secretRefs.insertPending({ ref, kind, ownerKind: owner.kind, ownerId: owner.id, createdAt: this.clock.now().toISOString() });
    });
    try {
      await this.store.put(ref, value, kind);
    } catch (err) {
      await this.cleanupFailedPut(ref);
      if (err instanceof SfeError) throw err;
      throw secretStoreError('put', 'other');
    }
    return ref;
  }

  private async cleanupFailedPut(ref: string): Promise<void> {
    try {
      await this.store.delete(ref);
    } catch {
      // 秘密项可能残留：保留 pending 行，由清扫在超时后重试删除
      return;
    }
    this.repos.tx(() => {
      this.repos.secretRefs.delete(ref);
    });
  }

  /**
   * 第 3 步：在调用方的主事务中调用。只有 pending 的引用可以提交；引用已被清扫或不存在时抛错，
   * 使主事务回滚——从不把未写入的引用标为可用。
   */
  markCommitted(ref: string): void {
    const row = this.repos.secretRefs.get(ref);
    if (row?.state === 'committed') return;
    if (!row || !this.repos.secretRefs.markCommitted(ref)) {
      throw new SfeError('SECRET_STORE_FAILED', '保存秘密失败：秘密引用已失效，请重试', { details: { reason: 'other' } });
    }
  }

  /** 在调用方事务中把引用标为 orphaned（例如账号密码被替换或清除），之后由清扫按引用情况删除。 */
  orphan(ref: string): void {
    this.repos.secretRefs.markOrphaned(ref);
  }

  /** 在调用方事务中：没有任何引用时标为 orphaned（例如版本 retired 之后）。返回是否标记。 */
  orphanIfUnreferenced(ref: string): boolean {
    if (this.repos.secretRefs.isReferenced(ref)) return false;
    return this.repos.secretRefs.markOrphaned(ref);
  }

  /**
   * 丢弃一个尚未被使用的引用（例如 createSecret 之后主事务失败）。仍被引用时拒绝。
   * 秘密项删除失败时把引用标为 orphaned 留给清扫，返回 false；不抛错。
   */
  async discard(ref: string): Promise<boolean> {
    if (this.repos.db.inTransaction()) throw new Error('discard must not be called inside a database transaction');
    const referenced = this.repos.tx(() => this.repos.secretRefs.isReferenced(ref));
    if (referenced) throw new SfeError('INTERNAL', '删除秘密失败：引用仍在使用');
    try {
      await this.store.delete(ref);
    } catch {
      this.repos.tx(() => {
        this.repos.secretRefs.markOrphaned(ref);
      });
      return false;
    }
    this.repos.tx(() => {
      if (!this.repos.secretRefs.isReferenced(ref)) this.repos.secretRefs.delete(ref);
    });
    return true;
  }

  /**
   * 回收：orphaned 引用与超过 pendingOlderThanMs 的 pending 引用，只在没有任何引用时删除。
   * 仍被引用的恢复为 committed（共享的 keep 引用）。应在执行器内串行调用（启动时与每小时）。
   */
  async sweep(opts: { now?: Date; pendingOlderThanMs?: number } = {}): Promise<SweepResult> {
    if (this.repos.db.inTransaction()) throw new Error('sweep must not be called inside a database transaction');
    const now = opts.now ?? this.clock.now();
    const ttl = opts.pendingOlderThanMs ?? DEFAULT_PENDING_TTL_MS;
    const before = new Date(now.getTime() - ttl);
    const candidates = this.repos.tx(() => [...this.repos.secretRefs.listOrphaned(), ...this.repos.secretRefs.listStalePending(before)]);
    const result: SweepResult = { deleted: [], kept: [], failed: [] };
    for (const cand of candidates) {
      const keep = this.repos.tx(() => {
        if (!this.repos.secretRefs.isReferenced(cand.ref)) return false;
        this.repos.secretRefs.restoreCommitted(cand.ref);
        return true;
      });
      if (keep) {
        result.kept.push(cand.ref);
        continue;
      }
      try {
        await this.store.delete(cand.ref);
      } catch {
        result.failed.push(cand.ref);
        continue;
      }
      // 删除秘密项后再次确认未被引用；期间如被引用（不应发生）则保留行，以便追查
      const removed = this.repos.tx(() => {
        if (this.repos.secretRefs.isReferenced(cand.ref)) return false;
        return this.repos.secretRefs.delete(cand.ref);
      });
      if (removed) result.deleted.push(cand.ref);
      else result.kept.push(cand.ref);
    }
    // 之前的删除因其他程序持有读快照而推迟的 -wal 截断：每次清扫（启动时与每小时）再试一次
    await this.store.flush?.();
    return result;
  }
}
