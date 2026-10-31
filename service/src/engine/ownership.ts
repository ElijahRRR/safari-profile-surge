// 本应用对象的归属记录（managed_objects）：入口策略使用的 EntryOwnership 实现、受管理段摘要，
// 以及初始化（与演示、测试夹具）登记全部本应用对象。归属只看记录，从不按前缀或注释判断。
// 意图行的“写前摘要”存放在引擎键值记录中（managed_objects 没有该列），用于崩溃后区分写前与写后。
// 节点资源（D10）不再是本应用写入的文件：它由本机资源服务提供，归属与恢复以 resource:served 指针为准（resource/state.ts），
// 不登记 resource_file。D7 留下的 resource_file 记录只用于对仍引用本地节点文件的旧工作配置的修改检查（engine/reconcile.ts），
// 由重新合并改用本机资源服务时清除。

import { ENTRY_RULESET_FILES } from '@sfe/contract';
import type { ManagedObjectKind, Repositories } from '../db/index.js';
import type { EntryOwnedKind, EntryOwnedRecord, EntryOwnership } from '../surge/entry/ownership.js';
import { findManagedBlock, parseProfile, type ParsedProfile } from '../surge/profile.js';
import type { EngineKv } from './kv.js';

const prevKey = (kind: string, identity: string): string => `mo_prev:${kind}:${identity}`;

export function createDbEntryOwnership(repos: Repositories, kv: EngineKv): EntryOwnership {
  const toRecord = (kind: EntryOwnedKind, identity: string): EntryOwnedRecord | null => {
    const r = repos.managedObjects.get(kind as ManagedObjectKind, identity);
    if (!r) return null;
    const prev = kv.get<{ digest: string | null }>(prevKey(kind, identity));
    return {
      kind,
      identity,
      digest: r.contentDigest,
      state: r.state,
      operationId: r.createdByOperation,
      previousDigest: prev ? prev.digest : null,
    };
  };
  return {
    async getRecordedTempRules() {
      return repos.managedObjects
        .listByKind('temp_rule')
        .filter((r) => r.state !== 'removed')
        .map((r) => toRecord('temp_rule', r.identity)!)
        .filter((r): r is EntryOwnedRecord => r !== null);
    },
    async getRecord(kind, identity) {
      return toRecord(kind, identity);
    },
    async recordIntent(kind, identity, digest, operationId, intent = 'add') {
      repos.tx(() => {
        const prev = repos.managedObjects.get(kind as ManagedObjectKind, identity);
        const storedPrev = kv.get<{ digest: string | null }>(prevKey(kind, identity));
        const previousDigest = prev?.state === 'pending_add' ? (storedPrev?.digest ?? null) : (prev?.contentDigest ?? null);
        repos.managedObjects.upsertIntent({
          kind: kind as ManagedObjectKind,
          identity,
          contentDigest: intent === 'add' ? digest : (prev?.contentDigest ?? digest),
          state: intent === 'add' ? 'pending_add' : 'pending_remove',
          createdByOperation: operationId,
        });
        kv.set(prevKey(kind, identity), { digest: previousDigest });
      });
    },
    async confirm(kind, identity, state, digest) {
      repos.tx(() => {
        const existing = repos.managedObjects.get(kind as ManagedObjectKind, identity);
        if (!existing) {
          repos.managedObjects.upsertIntent({ kind: kind as ManagedObjectKind, identity, contentDigest: digest ?? null, state: 'pending_add' });
        }
        const patch: { contentDigest?: string | null } = {};
        if (digest !== undefined) patch.contentDigest = digest;
        repos.managedObjects.setState(kind as ManagedObjectKind, identity, state, patch);
        kv.delete(prevKey(kind, identity));
      });
    },
  };
}

// ---------- 受管理段 ----------

export type SegmentName = 'group' | 'entry' | 'general';
export const SEGMENT_KIND: Record<SegmentName, ManagedObjectKind> = { group: 'group_segment', entry: 'entry_segment', general: 'general_segment' };

/** 受管理段内容的带密钥摘要（含段名与版本）。 */
export function segmentDigest(digestContent: (s: string) => string, name: SegmentName, version: number, lines: readonly string[]): string {
  return digestContent(`segment\0${name}\0v${version}\0${lines.join('\n')}`);
}

export interface SegmentState {
  name: SegmentName;
  state: 'ok' | 'missing' | 'ambiguous' | 'changed' | 'unrecorded';
  digest: string | null;
}

/** 按 managed_objects 记录逐段核对内容与位置；只返回段名与状态，不含内容。 */
export function checkSegments(
  repos: Repositories,
  parsed: ParsedProfile,
  digestContent: (s: string) => string,
): SegmentState[] {
  const out: SegmentState[] = [];
  for (const name of ['group', 'entry', 'general'] as const) {
    const rec = repos.managedObjects.get(SEGMENT_KIND[name], name);
    const block = findManagedBlock(parsed, name);
    if (!rec || rec.state === 'removed') {
      // 没有记录的段不应出现；出现视为非本应用对象（由冲突检查报告）
      if (typeof block === 'object') out.push({ name, state: 'unrecorded', digest: null });
      continue;
    }
    if (block === 'missing' || block === 'ambiguous') {
      out.push({ name, state: block, digest: null });
      continue;
    }
    const digest = segmentDigest(digestContent, name, block.version, block.lines);
    out.push({ name, state: digest === rec.contentDigest ? 'ok' : 'changed', digest });
  }
  return out;
}

/**
 * 登记初始化写入的全部本应用对象（present）：受管理段与入口规则集文件（节点资源不是文件，不登记）。maintenance.init、演示
 * 数据与测试夹具使用。fileDigest(name) 返回文件当前的带密钥摘要（不存在为 null）。
 */
export async function registerInitialObjects(
  repos: Repositories,
  opts: {
    profileText: string;
    digestContent: (s: string) => string;
    fileDigest: (name: string) => Promise<string | null>;
    operationId: string | null;
  },
): Promise<void> {
  const parsed = parseProfile(opts.profileText);
  const segments: Array<{ name: SegmentName; digest: string }> = [];
  for (const name of ['group', 'entry', 'general'] as const) {
    const block = findManagedBlock(parsed, name);
    if (typeof block === 'object') segments.push({ name, digest: segmentDigest(opts.digestContent, name, block.version, block.lines) });
  }
  const files: Array<{ kind: ManagedObjectKind; name: string; digest: string }> = [];
  for (const name of Object.values(ENTRY_RULESET_FILES)) {
    const d = await opts.fileDigest(name);
    if (d !== null) files.push({ kind: 'entry_ruleset_file', name, digest: d });
  }
  repos.tx(() => {
    for (const s of segments) {
      repos.managedObjects.upsertIntent({ kind: SEGMENT_KIND[s.name], identity: s.name, contentDigest: s.digest, state: 'pending_add', createdByOperation: opts.operationId });
      repos.managedObjects.setState(SEGMENT_KIND[s.name], s.name, 'present', { contentDigest: s.digest });
    }
    for (const f of files) {
      repos.managedObjects.upsertIntent({ kind: f.kind, identity: f.name, contentDigest: f.digest, state: 'pending_add', createdByOperation: opts.operationId });
      repos.managedObjects.setState(f.kind, f.name, 'present', { contentDigest: f.digest });
    }
  });
}
