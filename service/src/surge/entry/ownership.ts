// 入口对象的归属记录：任何写入前先记录意图，运行时读回后再确认。正式实现落在 managed_objects
// （由 engine/db 提供）；这里定义接口与测试用的内存实现。归属只看记录，从不按前缀或注释判断。

export type EntryOwnedKind = 'temp_rule' | 'entry_ruleset_file';
export type EntryOwnedState = 'pending_add' | 'present' | 'pending_remove' | 'removed';

export interface EntryOwnedRecord {
  kind: EntryOwnedKind;
  /** temp_rule 为精确规则文本；entry_ruleset_file 为文件名。 */
  identity: string;
  /** 带密钥摘要（文件）；临时规则为 null。 */
  digest: string | null;
  state: EntryOwnedState;
  operationId: string | null;
  /** pending_add 时写入前的摘要（崩溃恢复时区分“已写入”与“未写入”）；实现可以不保存。 */
  previousDigest?: string | null;
}

export interface EntryOwnership {
  /** 尚未标为 removed 的临时规则记录。 */
  getRecordedTempRules(): Promise<EntryOwnedRecord[]>;
  getRecord(kind: EntryOwnedKind, identity: string): Promise<EntryOwnedRecord | null>;
  /**
   * 写入前提交意图：add → pending_add（文件写入时 digest 为将要写入内容的摘要），remove → pending_remove。
   */
  recordIntent(kind: EntryOwnedKind, identity: string, digest: string | null, operationId: string | null, intent?: 'add' | 'remove'): Promise<void>;
  /** 读回后确认实际状态；文件确认时带上读回的摘要。 */
  confirm(kind: EntryOwnedKind, identity: string, state: 'present' | 'removed', digest?: string | null): Promise<void>;
}

export interface MemoryEntryOwnership extends EntryOwnership {
  records(): EntryOwnedRecord[];
}

export function createMemoryEntryOwnership(initial: readonly EntryOwnedRecord[] = []): MemoryEntryOwnership {
  const map = new Map<string, EntryOwnedRecord>();
  const k = (kind: EntryOwnedKind, identity: string): string => `${kind}\0${identity}`;
  for (const r of initial) map.set(k(r.kind, r.identity), { ...r });
  return {
    records: () => [...map.values()].map((r) => ({ ...r })),
    async getRecordedTempRules() {
      return [...map.values()].filter((r) => r.kind === 'temp_rule' && r.state !== 'removed').map((r) => ({ ...r }));
    },
    async getRecord(kind, identity) {
      const r = map.get(k(kind, identity));
      return r ? { ...r } : null;
    },
    async recordIntent(kind, identity, digest, operationId, intent = 'add') {
      const prev = map.get(k(kind, identity));
      map.set(k(kind, identity), {
        kind,
        identity,
        digest: intent === 'add' ? digest : (prev?.digest ?? digest),
        state: intent === 'add' ? 'pending_add' : 'pending_remove',
        operationId,
        previousDigest: prev?.state === 'pending_add' ? (prev.previousDigest ?? null) : (prev?.digest ?? null),
      });
    },
    async confirm(kind, identity, state, digest) {
      const prev = map.get(k(kind, identity));
      map.set(k(kind, identity), {
        kind,
        identity,
        digest: digest === undefined ? (prev?.digest ?? null) : digest,
        state,
        operationId: prev?.operationId ?? null,
        previousDigest: null,
      });
    },
  };
}
