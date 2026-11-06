// 请求幂等（docs/ARCHITECTURE.md §6.1）：同一 request_id 的带密钥规范摘要相同 → 返回原结果（duplicate: true）；
// 不同 → 409 DUPLICATE_REQUEST_MISMATCH。创建操作的请求以 operations.request_id 为准；不创建操作的请求
// （取消、设置、前置、能力）记在引擎键值台账中。同步拒绝不占用 request_id。

import { SfeError, type Accepted } from '@sfe/contract';
import type { OperationRecord } from '../db/index.js';
import { requestDigestParts } from '../util/keyed-digest.js';
import type { Engine } from './context.js';

// eslint-disable-next-line no-control-regex
const REQUEST_ID_RE = /^[^\u0000-\u001f\u007f]{1,128}$/;

export function requireRequestId(value: unknown): string {
  if (typeof value !== 'string' || !REQUEST_ID_RE.test(value) || value.trim() !== value) {
    throw new SfeError('VALIDATION_FAILED', '请求失败：缺少 request_id 或格式不正确', { fieldErrors: [{ field: 'request_id', message: '必须是 1–128 个字符的唯一编号' }] });
  }
  return value;
}

/**
 * 幂等判断用的请求摘要（持久保存在 operations.request_digest 与请求台账中）：`v2:<shape>:<进程标记>:<full>`，带秘密值的请求另加
 * `:s`。两部分都不能用来离线核对秘密（util/keyed-digest.ts requestDigestParts）。
 */
export async function requestDigest(engine: Engine, method: string, target: string | null, body: unknown): Promise<string> {
  const keys = await engine.keys();
  const eph = engine.requestEphemeral;
  const { shape, full, secret } = requestDigestParts(keys.request, eph.key, { method, target, body });
  return `v2:${shape}:${eph.epoch}:${full}${secret ? ':s' : ''}`;
}

function parseDigest(d: string): { shape: string; epoch: string; full: string; secret: boolean } | null {
  const m = /^v2:([0-9a-f]{64}):([0-9a-f]{16}):([0-9a-f]{64})(:s)?$/.exec(d);
  return m ? { shape: m[1]!, epoch: m[2]!, full: m[3]!, secret: m[4] !== undefined } : null;
}

/**
 * 记下的请求摘要与这一次的是否表示同一请求：除秘密以外的内容（shape）必须相同；同一进程内记下的再比较秘密部分（full）。
 * 服务重新启动之后，之前进程的秘密部分无从比较（它的密钥从不持久保存）：不带秘密值的请求只比较 shape（相同即按重复返回原操作）；
 * 带秘密值的请求无法判断两次带的是否是同一个秘密，一律按内容不同（409）——客户端可能在提交结果未知（连接中断、服务重新启动）
 * 之后改正了密码、用同一编号重新提交，按重复返回原操作会悄悄丢掉改正的密码（网页提示之前的提交已生效，重新打开查看）。
 * shape 相同说明两次请求的秘密位置相同，所以任一方带秘密值即两方都带（升级前没有 `:s` 标记的记录同样由这一次的请求判断）。
 * 旧格式（升级前记下、迁移 3 已改写为不可核对的值）与新的摘要从不相同。
 */
export function sameRequestDigest(stored: string, current: string): boolean {
  const a = parseDigest(stored);
  const b = parseDigest(current);
  if (!a || !b) return stored === current;
  if (a.shape !== b.shape) return false;
  if (a.epoch === b.epoch) return a.full === b.full;
  return !a.secret && !b.secret;
}

function mismatch(): SfeError {
  return new SfeError(
    'DUPLICATE_REQUEST_MISMATCH',
    '请求失败：request_id 已用于之前一次内容不同的请求（服务重新启动之后，带密码的请求无法核对是否相同，同样按不同处理）：之前那次请求已经生效，这一次没有执行，请刷新查看当前状态',
  );
}

interface LedgerEntry {
  digest: string;
  ref: unknown;
}

/** 已存在且摘要相同 → 原操作；摘要不同 → 抛 409；不存在 → null。 */
export function findDuplicateOperation(engine: Engine, requestId: string, digest: string): OperationRecord | null {
  const op = engine.repos.operations.byRequestId(requestId);
  if (op) {
    if (!sameRequestDigest(op.requestDigest, digest)) throw mismatch();
    return op;
  }
  const entry = engine.kv.get<LedgerEntry>(`req:${requestId}`);
  if (entry) throw mismatch();
  return null;
}

/**
 * 在主事务内再核对一次幂等后创建操作。受理在首次核对与主事务之间有 await（秘密写入、预览重算）时，
 * 并发的同一请求可能已先提交：此时返回原操作（duplicate: true），摘要不同仍为 409，不会撞 request_id
 * 唯一约束或误报版本冲突。create 在同一事务内同步执行。
 */
export function commitOperation(engine: Engine, requestId: string, digest: string, create: () => OperationRecord): { op: OperationRecord; duplicate: boolean } {
  return engine.repos.tx(() => {
    const again = findDuplicateOperation(engine, requestId, digest);
    if (again) return { op: again, duplicate: true };
    return { op: create(), duplicate: false };
  });
}

/** 不创建操作的请求：已登记且摘要相同 → 返回登记的引用；不同 → 409；未登记 → null。 */
export function findLedger<T>(engine: Engine, requestId: string, digest: string): { ref: T } | null {
  const entry = engine.kv.get<LedgerEntry>(`req:${requestId}`);
  if (entry) {
    if (!sameRequestDigest(entry.digest, digest)) throw mismatch();
    return { ref: entry.ref as T };
  }
  if (engine.repos.operations.byRequestId(requestId)) throw mismatch();
  return null;
}

export function recordLedger(engine: Engine, requestId: string, digest: string, ref: unknown): void {
  engine.kv.set(`req:${requestId}`, { digest, ref });
}

export function acceptedOf(op: OperationRecord, duplicate: boolean): Accepted {
  const a: Accepted = {
    operation_id: op.id,
    environment_id: op.environmentId,
    revision: op.resultRevision,
    duplicate,
  };
  if (op.probeKind) a.probe_kind = op.probeKind;
  return a;
}
