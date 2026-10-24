// 本应用对象的归属记录（managed_objects）：入口策略使用的 EntryOwnership 实现、受管理段摘要，
// 以及初始化（与演示、测试夹具）登记全部本应用对象。归属只看记录，从不按前缀或注释判断。
// 意图行的“写前摘要”存放在引擎键值记录中（managed_objects 没有该列），用于崩溃后区分写前与写后。

import { ENTRY_RULESET_FILES, NODE_RESOURCE_FILE } from '@sfe/contract';
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

/** 资源文件意图（发布路径）：写前摘要同样记在键值记录中。 */
export function recordResourceIntent(repos: Repositories, kv: EngineKv, newDigest: string, operationId: string): void {
  repos.tx(() => {
    const prev = repos.managedObjects.get('resource_file', NODE_RESOURCE_FILE);
    const storedPrev = kv.get<{ digest: string | null }>(prevKey('resource_file', NODE_RESOURCE_FILE));
    const previousDigest = prev?.state === 'pending_add' ? (storedPrev?.digest ?? null) : (prev?.contentDigest ?? null);
    repos.managedObjects.upsertIntent({ kind: 'resource_file', identity: NODE_RESOURCE_FILE, contentDigest: newDigest, state: 'pending_add', createdByOperation: operationId });
    kv.set(prevKey('resource_file', NODE_RESOURCE_FILE), { digest: previousDigest });
  });
}

export function confirmResource(repos: Repositories, kv: EngineKv, digest: string): void {
  repos.tx(() => {
    if (!repos.managedObjects.get('resource_file', NODE_RESOURCE_FILE)) {
      repos.managedObjects.upsertIntent({ kind: 'resource_file', identity: NODE_RESOURCE_FILE, contentDigest: digest, state: 'pending_add' });
    }
    repos.managedObjects.setState('resource_file', NODE_RESOURCE_FILE, 'present', { contentDigest: digest });
    kv.delete(prevKey('resource_file', NODE_RESOURCE_FILE));
  });
}

/**
 * 退役代理版本（删除环境按节点资源文件的当前内容立即退役，handlers/misc.ts runDelete）之后：节点资源文件的归属记录只保留当前文件
 * 内容的摘要。意图摘要（pending_add 的 content_digest）与写前摘要（mo_prev）不是当前文件内容时，就是不在磁盘上的内容的 pepper
 * 派生摘要，可能含刚退役的版本的凭据行——凭据被清扫之后它们仍能离线核对猜测的旧值（docs/ARCHITECTURE.md §0「秘密的存放」）。
 * current 为当前文件的摘要（文件不存在为 null）。文件仍是意图或写前内容 → 按事实确认（与崩溃恢复 recoverPublish 相同）；
 * 否则删除写前摘要，与文件不一致的意图或记录摘要清除（SCRUBBED_RESOURCE_DIGEST）——与文件不一致的记录本来就按被外部修改
 * 处理（发布的基线检查失败、对账报告被修改），需要重新合并，清除不改变这一点。服务启动时对之前的版本留下的未结算归属同样
 * 处理（engine/app-service.ts）。
 */
export function settleResourceDigests(repos: Repositories, kv: EngineKv, current: string | null): void {
  repos.tx(() => {
    const rec = repos.managedObjects.get('resource_file', NODE_RESOURCE_FILE);
    const prev = kv.get<{ digest: string | null }>(prevKey('resource_file', NODE_RESOURCE_FILE));
    if (rec?.state === 'pending_add' && current !== null && (current === rec.contentDigest || current === (prev?.digest ?? null))) {
      confirmResource(repos, kv, current);
      return;
    }
    kv.delete(prevKey('resource_file', NODE_RESOURCE_FILE));
    // 置为不是任何摘要的占位（不置空：文件不存在时空摘要会与“读不到”相等，对账就不再报告文件被删除）
    if (rec && rec.contentDigest !== null && rec.contentDigest !== current && rec.contentDigest !== SCRUBBED_RESOURCE_DIGEST) {
      repos.managedObjects.setState('resource_file', NODE_RESOURCE_FILE, rec.state, { contentDigest: SCRUBBED_RESOURCE_DIGEST });
    }
  });
}

/** 清除后的摘要占位（与发布记录的 SCRUBBED_DIGEST 相同）：不等于任何文件的摘要，记录按与文件不一致处理。 */
export const SCRUBBED_RESOURCE_DIGEST = 'scrubbed';

/** 节点资源文件的归属尚未结算：未确认的意图，或留有写前摘要（settleResourceDigests 启动时按事实结算）。 */
export function resourceOwnershipUnsettled(repos: Repositories, kv: EngineKv): boolean {
  const rec = repos.managedObjects.get('resource_file', NODE_RESOURCE_FILE);
  return rec?.state === 'pending_add' || kv.get(prevKey('resource_file', NODE_RESOURCE_FILE)) !== null;
}

/** 资源文件意图的写前摘要（崩溃恢复：文件仍是写前内容时可安全回到 present）。 */
export function resourcePreviousDigest(kv: EngineKv): string | null {
  return kv.get<{ digest: string | null }>(prevKey('resource_file', NODE_RESOURCE_FILE))?.digest ?? null;
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
 * 登记初始化写入的全部本应用对象（present）：受管理段与本应用文件。maintenance.init、演示数据与测试夹具使用。
 * fileDigest(name) 返回文件当前的带密钥摘要（不存在为 null）。
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
  const resourceDigest = await opts.fileDigest(NODE_RESOURCE_FILE);
  if (resourceDigest !== null) files.push({ kind: 'resource_file', name: NODE_RESOURCE_FILE, digest: resourceDigest });
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
