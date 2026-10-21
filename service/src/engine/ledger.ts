// 请求幂等（docs/ARCHITECTURE.md §6.1）：同一 request_id 的带密钥规范摘要相同 → 返回原结果（duplicate: true）；
// 不同 → 409 DUPLICATE_REQUEST_MISMATCH。创建操作的请求以 operations.request_id 为准；不创建操作的请求
// （取消、设置、前置、能力）记在引擎键值台账中。同步拒绝不占用 request_id。

import { SfeError, type Accepted } from '@sfe/contract';
import type { OperationRecord } from '../db/index.js';
import { keyedRequestDigest } from '../util/keyed-digest.js';
import type { Engine } from './context.js';

// eslint-disable-next-line no-control-regex
const REQUEST_ID_RE = /^[^\u0000-\u001f\u007f]{1,128}$/;

export function requireRequestId(value: unknown): string {
  if (typeof value !== 'string' || !REQUEST_ID_RE.test(value) || value.trim() !== value) {
    throw new SfeError('VALIDATION_FAILED', '请求失败：缺少 request_id 或格式不正确', { fieldErrors: [{ field: 'request_id', message: '必须是 1–128 个字符的唯一编号' }] });
  }
  return value;
}

export async function requestDigest(engine: Engine, method: string, target: string | null, body: unknown): Promise<string> {
  const keys = await engine.keys();
  return keyedRequestDigest(keys.request, { method, target, body });
}

function mismatch(): SfeError {
  return new SfeError('DUPLICATE_REQUEST_MISMATCH', '请求失败：request_id 已用于内容不同的请求');
}

interface LedgerEntry {
  digest: string;
  ref: unknown;
}

/** 已存在且摘要相同 → 原操作；摘要不同 → 抛 409；不存在 → null。 */
export function findDuplicateOperation(engine: Engine, requestId: string, digest: string): OperationRecord | null {
  const op = engine.repos.operations.byRequestId(requestId);
  if (op) {
    if (op.requestDigest !== digest) throw mismatch();
    return op;
  }
  const entry = engine.kv.get<LedgerEntry>(`req:${requestId}`);
  if (entry) throw mismatch();
  return null;
}

/** 不创建操作的请求：已登记且摘要相同 → 返回登记的引用；不同 → 409；未登记 → null。 */
export function findLedger<T>(engine: Engine, requestId: string, digest: string): { ref: T } | null {
  const entry = engine.kv.get<LedgerEntry>(`req:${requestId}`);
  if (entry) {
    if (entry.digest !== digest) throw mismatch();
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
