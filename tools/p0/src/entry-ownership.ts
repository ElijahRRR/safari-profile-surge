// P0 的入口归属记录：服务的内存实现 + 每次变化后写入运行目录（0600），使 entry 命令多次运行、崩溃后
// 仍以记录判断归属（从不按前缀或注释判断）。正式产品中这部分由 managed_objects 承担。

import { ENTRY_OWNERSHIP_FILE } from './constants.js';
import { createMemoryEntryOwnership, type EntryOwnership } from './deps.js';
import type { RunDir } from './run-dir.js';

type Records = ReturnType<ReturnType<typeof createMemoryEntryOwnership>['records']>;

export function loadEntryRecords(dir: RunDir): Records | null {
  const data = dir.readJson<{ records?: Records }>(ENTRY_OWNERSHIP_FILE);
  return Array.isArray(data?.records) ? data.records : null;
}

/** seed 只补充记录中还没有的对象（同类同名的已有记录优先，避免覆盖崩溃前的意图）。 */
export function createFileEntryOwnership(dir: RunDir, seed: Records = []): EntryOwnership & { records(): Records } {
  const loaded = loadEntryRecords(dir) ?? [];
  const merged = [...loaded, ...seed.filter((s) => !loaded.some((l) => l.kind === s.kind && l.identity === s.identity))];
  const mem = createMemoryEntryOwnership(merged);
  const save = (): void => {
    dir.writeJson(ENTRY_OWNERSHIP_FILE, { records: mem.records() });
  };
  save();
  return {
    records: () => mem.records(),
    getRecordedTempRules: () => mem.getRecordedTempRules(),
    getRecord: (kind, identity) => mem.getRecord(kind, identity),
    async recordIntent(kind, identity, digest, operationId, intent) {
      await mem.recordIntent(kind, identity, digest, operationId, intent);
      save();
    },
    async confirm(kind, identity, state, digest) {
      await mem.confirm(kind, identity, state, digest);
      save();
    },
  };
}
