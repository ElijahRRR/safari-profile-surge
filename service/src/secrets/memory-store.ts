// 内存秘密存储：测试与演示模式使用，行为与本机实现（local-store.ts）一致（任何种类都可读取、引用不覆盖）。

import type { SecretStore } from '../ports.js';
import type { SecretKind } from '../db/repos/secret-refs.js';
import { secretStoreError, type SecretStoreFailureReason } from './errors.js';

type Op = 'put' | 'get' | 'delete';

interface InjectedFailure {
  op: Op;
  reason: SecretStoreFailureReason;
  remaining: number;
}

export class MemorySecretStore implements SecretStore {
  private readonly items = new Map<string, { value: string; kind: SecretKind }>();
  private failures: InjectedFailure[] = [];
  /** 调用记录（不含值），供测试断言。 */
  readonly calls: Array<{ op: Op; ref: string; kind?: SecretKind }> = [];

  async put(ref: string, value: string, kind: SecretKind): Promise<void> {
    this.calls.push({ op: 'put', ref, kind });
    this.maybeFail('put');
    if (typeof value !== 'string') throw secretStoreError('put', 'other');
    // 引用从不复用：已存在即失败，避免覆盖仍在使用的秘密
    if (this.items.has(ref)) throw secretStoreError('put', 'other', '引用已存在');
    this.items.set(ref, { value, kind });
  }

  async get(ref: string): Promise<string | null> {
    this.calls.push({ op: 'get', ref });
    this.maybeFail('get');
    return this.items.get(ref)?.value ?? null;
  }

  async delete(ref: string): Promise<void> {
    this.calls.push({ op: 'delete', ref });
    this.maybeFail('delete');
    this.items.delete(ref);
  }

  has(ref: string): boolean {
    return this.items.has(ref);
  }

  kindOf(ref: string): SecretKind | null {
    return this.items.get(ref)?.kind ?? null;
  }

  get size(): number {
    return this.items.size;
  }

  refs(): string[] {
    return [...this.items.keys()];
  }

  /** 测试注入故障：接下来 times 次 op 调用以 reason 失败。 */
  injectFailure(op: Op, reason: SecretStoreFailureReason, times = 1): void {
    this.failures.push({ op, reason, remaining: times });
  }

  clearFailures(): void {
    this.failures = [];
  }

  private maybeFail(op: Op): void {
    const f = this.failures.find((x) => x.op === op && x.remaining > 0);
    if (!f) return;
    f.remaining--;
    if (f.remaining === 0) this.failures = this.failures.filter((x) => x !== f);
    throw secretStoreError(op, f.reason);
  }
}
