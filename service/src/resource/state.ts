// 本机资源服务的持久状态（engine.kv，存放在 meta 表，键带 engine: 前缀，见 engine/kv.ts）。只存代数、序号、时间与原因代码，
// 从不存令牌、地址或资源内容：
//   resource:served        已提交与候选的配置代数（代数 0 为只含占位行的资源）——启动加载、重新合并恢复、回滚目标与保留的唯一来源；
//   resource:needsRefresh  Surge 可能载入了未提交的版本、或与已提交版本不一致：下一次发布必须单 key 更新并读回；
//   resource:audit         最近 64 次令牌正确的 200 响应（写出前记一次、写完再记一次）与下一个序号；404 从不保存；
//   resource:auditState    上次审计确认过的更新时间、资源错误、已核对到的记录序号与审计窗口的起点；
//   resource:tokenSuspect  读取令牌可能已泄露：只能由重新合并的“轮换资源地址”清除。
// 读取时校验形状：指针形状不对按不存在处理（启动时重新初始化）；needsRefresh 与 tokenSuspect 只要有这一行、而值无法解析、
// 是 JSON null 或形状不对，就按“已设置”处理（fail closed，包括 D10 之前发布写下的 {operationId} 刷新记录）。写入 null
// 时删除键。事务由调用方负责。

import { SfeError } from '@sfe/contract';
import type { EngineKv } from '../engine/kv.js';
import type { ResourceAuditState } from './audit.js';
import { RESOURCE_AUDIT_LIMIT, type ResourceAuditRecord } from './host.js';

export const RESOURCE_KV_KEYS = Object.freeze({
  served: 'resource:served',
  needsRefresh: 'resource:needsRefresh',
  audit: 'resource:audit',
  auditState: 'resource:auditState',
  tokenSuspect: 'resource:tokenSuspect',
} as const);

export interface ResourceServedPointer {
  committed: { generation: number };
  candidate: { generation: number } | null;
}

export interface ResourceNeedsRefresh {
  generation: number;
  reason: string;
}

export interface ResourceTokenSuspect {
  since: string;
  reason: string;
}

/** 持久的审计记录：at 为 ISO 时间。 */
export interface StoredResourceAuditRecord {
  seq: number;
  at: string;
  generation: number;
  complete: boolean;
}

export interface ResourceAuditLog {
  records: ResourceAuditRecord[];
  nextSeq: number;
}

/** needsRefresh 存储值无法识别时的读取结果（fail closed：仍需刷新）。 */
export const UNREADABLE_NEEDS_REFRESH: Readonly<ResourceNeedsRefresh> = Object.freeze({ generation: 0, reason: 'unreadable' });
/** tokenSuspect 存储值无法识别时的读取结果（fail closed：仍按可能泄露处理）。 */
export const UNREADABLE_TOKEN_SUSPECT: Readonly<ResourceTokenSuspect> = Object.freeze({ since: '1970-01-01T00:00:00.000Z', reason: 'unreadable' });

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isGeneration = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isSeq = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 1;
const isText = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isIso = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v));

function invalid(what: string): SfeError {
  return new SfeError('INTERNAL', `服务内部错误：${what}不正确`);
}

function parsePointer(v: unknown): ResourceServedPointer | null {
  if (!isObject(v) || !isObject(v.committed) || !isGeneration(v.committed.generation)) return null;
  if (v.candidate !== null && (!isObject(v.candidate) || !isGeneration(v.candidate.generation))) return null;
  return { committed: { generation: v.committed.generation }, candidate: v.candidate === null ? null : { generation: (v.candidate as { generation: number }).generation } };
}

// ---------- resource:served ----------

/** 已提交/候选指针；不存在或形状不对为 null（由启动按已发布记录重新初始化）。 */
export function readServedPointer(kv: EngineKv): ResourceServedPointer | null {
  return parsePointer(kv.get<unknown>(RESOURCE_KV_KEYS.served));
}

export function writeServedPointer(kv: EngineKv, pointer: ResourceServedPointer): void {
  const p = parsePointer(pointer);
  if (p === null) throw invalid('节点资源指针');
  kv.set(RESOURCE_KV_KEYS.served, p);
}

/** 记下候选代数，同时设 needsRefresh（同一事务由调用方保证）：之后任何中断都会让下一次发布重新更新并读回。 */
export function setCandidatePointer(kv: EngineKv, generation: number, reason = 'publish'): void {
  const p = readServedPointer(kv);
  if (p === null) throw invalid('节点资源指针');
  if (!isGeneration(generation)) throw invalid('候选代数');
  writeServedPointer(kv, { committed: p.committed, candidate: { generation } });
  writeNeedsRefresh(kv, { generation, reason });
}

/** 候选成为已提交版本，返回其代数（needsRefresh 由调用方按读回结论处理）。 */
export function commitCandidatePointer(kv: EngineKv): number {
  const p = readServedPointer(kv);
  if (p === null || p.candidate === null) throw invalid('节点资源候选指针');
  writeServedPointer(kv, { committed: { generation: p.candidate.generation }, candidate: null });
  return p.candidate.generation;
}

/** 清除候选（回滚与启动），不动 needsRefresh。 */
export function clearCandidatePointer(kv: EngineKv): void {
  const p = readServedPointer(kv);
  if (p === null || p.candidate === null) return;
  writeServedPointer(kv, { committed: p.committed, candidate: null });
}

// ---------- resource:needsRefresh ----------

/** 没有这一行时为 null；有这一行而值无法识别（含无法解析与 JSON null）时为 UNREADABLE_NEEDS_REFRESH。 */
export function readNeedsRefresh(kv: EngineKv): ResourceNeedsRefresh | null {
  const v = kv.get<unknown>(RESOURCE_KV_KEYS.needsRefresh);
  if (isObject(v) && isGeneration(v.generation) && isText(v.reason)) return { generation: v.generation, reason: v.reason };
  if (v === null && !kv.has(RESOURCE_KV_KEYS.needsRefresh)) return null;
  return { ...UNREADABLE_NEEDS_REFRESH };
}

export function writeNeedsRefresh(kv: EngineKv, value: ResourceNeedsRefresh | null): void {
  if (value === null) {
    kv.delete(RESOURCE_KV_KEYS.needsRefresh);
    return;
  }
  if (!isGeneration(value.generation) || !isText(value.reason)) throw invalid('节点资源刷新记录');
  kv.set(RESOURCE_KV_KEYS.needsRefresh, { generation: value.generation, reason: value.reason });
}

// ---------- resource:audit ----------

function parseRecord(v: unknown): ResourceAuditRecord | null {
  if (!isObject(v) || !isSeq(v.seq) || !isIso(v.at) || !isGeneration(v.generation) || typeof v.complete !== 'boolean') return null;
  return { seq: v.seq, at: new Date(v.at), generation: v.generation, complete: v.complete };
}

/** 持久的审计记录（按序号排列，最多 64 条）与下一个序号（不小于任何记录序号 + 1）。形状不对的记录忽略。 */
export function readAuditLog(kv: EngineKv): ResourceAuditLog {
  const v = kv.get<unknown>(RESOURCE_KV_KEYS.audit);
  const records: ResourceAuditRecord[] = [];
  let nextSeq = 1;
  if (isObject(v)) {
    if (Array.isArray(v.records)) {
      for (const raw of v.records) {
        const r = parseRecord(raw);
        if (r !== null) records.push(r);
      }
    }
    if (isSeq(v.nextSeq)) nextSeq = v.nextSeq;
  }
  records.sort((a, b) => a.seq - b.seq);
  const kept = records.slice(-RESOURCE_AUDIT_LIMIT);
  for (const r of records) nextSeq = Math.max(nextSeq, r.seq + 1);
  return { records: kept, nextSeq };
}

/** 按序号写入或更新一条记录（ResourceHost.onServed 的写出前与完成两次调用都经这里，同步保存）。 */
export function recordAuditEntry(kv: EngineKv, record: ResourceAuditRecord): void {
  if (!isSeq(record.seq) || !(record.at instanceof Date) || !Number.isFinite(record.at.getTime()) || !isGeneration(record.generation)) {
    throw invalid('审计记录');
  }
  const log = readAuditLog(kv);
  const others = log.records.filter((r) => r.seq !== record.seq);
  const merged = [...others, { seq: record.seq, at: new Date(record.at.getTime()), generation: record.generation, complete: record.complete === true }]
    .sort((a, b) => a.seq - b.seq)
    .slice(-RESOURCE_AUDIT_LIMIT);
  const stored: StoredResourceAuditRecord[] = merged.map((r) => ({ seq: r.seq, at: r.at.toISOString(), generation: r.generation, complete: r.complete }));
  kv.set(RESOURCE_KV_KEYS.audit, { records: stored, nextSeq: Math.max(log.nextSeq, record.seq + 1) });
}

// ---------- resource:auditState ----------

const isCursor = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/** 没有或形状不对（含缺少 windowSeq）时为 null：与第一次审计相同，按快照初始化。 */
export function readAuditState(kv: EngineKv): ResourceAuditState | null {
  const v = kv.get<unknown>(RESOURCE_KV_KEYS.auditState);
  if (!isObject(v)) return null;
  const okTime = v.verifiedUpdatedAt === null || typeof v.verifiedUpdatedAt === 'string';
  const okError = v.verifiedError === null || typeof v.verifiedError === 'string';
  if (!okTime || !okError || !isCursor(v.auditedSeq) || !isCursor(v.windowSeq)) return null;
  return {
    verifiedUpdatedAt: v.verifiedUpdatedAt as string | null,
    verifiedError: v.verifiedError as string | null,
    auditedSeq: v.auditedSeq,
    windowSeq: v.windowSeq,
  };
}

export function writeAuditState(kv: EngineKv, state: ResourceAuditState | null): void {
  if (state === null) {
    kv.delete(RESOURCE_KV_KEYS.auditState);
    return;
  }
  const okTime = state.verifiedUpdatedAt === null || typeof state.verifiedUpdatedAt === 'string';
  const okError = state.verifiedError === null || typeof state.verifiedError === 'string';
  if (!okTime || !okError || !isCursor(state.auditedSeq) || !isCursor(state.windowSeq)) throw invalid('审计状态');
  kv.set(RESOURCE_KV_KEYS.auditState, {
    verifiedUpdatedAt: state.verifiedUpdatedAt,
    verifiedError: state.verifiedError,
    auditedSeq: state.auditedSeq,
    windowSeq: state.windowSeq,
  });
}

// ---------- resource:tokenSuspect ----------

/** 没有这一行时为 null；有这一行而值无法识别（含无法解析与 JSON null）时为 UNREADABLE_TOKEN_SUSPECT（仍按可能泄露处理）。 */
export function readTokenSuspect(kv: EngineKv): ResourceTokenSuspect | null {
  const v = kv.get<unknown>(RESOURCE_KV_KEYS.tokenSuspect);
  if (isObject(v) && isIso(v.since) && isText(v.reason)) return { since: v.since, reason: v.reason };
  if (v === null && !kv.has(RESOURCE_KV_KEYS.tokenSuspect)) return null;
  return { ...UNREADABLE_TOKEN_SUSPECT };
}

export function writeTokenSuspect(kv: EngineKv, value: ResourceTokenSuspect | null): void {
  if (value === null) {
    kv.delete(RESOURCE_KV_KEYS.tokenSuspect);
    return;
  }
  if (!isIso(value.since) || !isText(value.reason)) throw invalid('令牌可疑记录');
  kv.set(RESOURCE_KV_KEYS.tokenSuspect, { since: value.since, reason: value.reason });
}
