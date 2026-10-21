// 操作、操作步骤与 outbox。payload 只含引用（写入时拒绝秘密字段）；步骤消息与错误消息写入前脱敏。

import type { ApiErrorBody, OperationKind, OperationPhase, OperationStatus, ProbeKind } from '@sfe/contract';
import { col, mapper, nowIso, placeholders, toIso, type InsertOf, type RepoContext } from './common.js';

export type InitiatorKind = 'web' | 'agent' | 'admin' | 'bridge' | 'service';

export interface OperationRecord {
  id: string;
  requestId: string;
  /** 对秘密值先做 HMAC 再规范化的带密钥摘要。 */
  requestDigest: string;
  kind: OperationKind;
  environmentId: string | null;
  initiatorKind: InitiatorKind;
  initiatorProfileId: string | null;
  expectedRevision: number | null;
  resultRevision: number | null;
  routeEpoch: number | null;
  probeKind: ProbeKind | null;
  phase: OperationPhase;
  status: OperationStatus;
  supersededBy: string | null;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: ApiErrorBody | null;
  createdAt: string;
  updatedAt: string;
}

const opMap = mapper<OperationRecord>('operations', {
  id: col.text('id'),
  requestId: col.text('request_id'),
  requestDigest: col.text('request_digest'),
  kind: col.text<OperationKind>('kind'),
  environmentId: col.textNull('environment_id'),
  initiatorKind: col.text<InitiatorKind>('initiator_kind'),
  initiatorProfileId: col.textNull('initiator_profile_id'),
  expectedRevision: col.intNull('expected_revision'),
  resultRevision: col.intNull('result_revision'),
  routeEpoch: col.intNull('route_epoch'),
  probeKind: col.textNull<ProbeKind>('probe_kind'),
  phase: col.text<OperationPhase>('phase'),
  status: col.text<OperationStatus>('status'),
  supersededBy: col.textNull('superseded_by'),
  payload: col.json<Record<string, unknown>>('payload', {}),
  result: col.jsonNull<Record<string, unknown>>('result'),
  error: col.jsonNull<ApiErrorBody>('error'),
  createdAt: col.time('created_at'),
  updatedAt: col.time('updated_at'),
});

export interface OperationStepRecord {
  operationId: string;
  seq: number;
  at: string;
  phase: OperationPhase;
  message: string;
}

const stepMap = mapper<OperationStepRecord>('operation_steps', {
  operationId: col.text('operation_id'),
  seq: col.int('seq'),
  at: col.time('at'),
  phase: col.text<OperationPhase>('phase'),
  message: col.text('message'),
});

export type OperationInsert = InsertOf<
  OperationRecord,
  | 'createdAt'
  | 'updatedAt'
  | 'environmentId'
  | 'initiatorProfileId'
  | 'expectedRevision'
  | 'resultRevision'
  | 'routeEpoch'
  | 'probeKind'
  | 'supersededBy'
  | 'result'
  | 'error'
  | 'payload'
>;

export type OperationPatch = Partial<Omit<OperationRecord, 'id' | 'requestId' | 'requestDigest' | 'kind' | 'createdAt'>>;

export interface OperationsRepo {
  insert(rec: OperationInsert): OperationRecord;
  get(id: string): OperationRecord | null;
  byRequestId(requestId: string): OperationRecord | null;
  /** 按创建时间正序。可选再按 kind 过滤。 */
  listByStatus(statuses: OperationStatus[], opts?: { kinds?: OperationKind[] }): OperationRecord[];
  /** 最近的操作，按创建时间倒序。 */
  listRecent(limit: number): OperationRecord[];
  listForEnvironment(environmentId: string, limit?: number): OperationRecord[];
  /** 错误消息写入前脱敏；updatedAt 自动更新。 */
  update(id: string, patch: OperationPatch): boolean;
  setPhase(id: string, phase: OperationPhase, status: OperationStatus, patch?: OperationPatch): boolean;
  /** 自动分配步骤序号（从 1 开始）；消息写入前脱敏。 */
  appendStep(operationId: string, phase: OperationPhase, message: string, at?: Date | string): OperationStepRecord;
  listSteps(operationId: string): OperationStepRecord[];
}

export function createOperationsRepo(ctx: RepoContext): OperationsRepo {
  const { db } = ctx;
  const scrubError = (error: ApiErrorBody | null | undefined): ApiErrorBody | null | undefined => {
    if (!error) return error;
    const safe: ApiErrorBody = { ...error, message: ctx.scrub(error.message) };
    if (error.fieldErrors) safe.fieldErrors = error.fieldErrors.map((f) => ({ field: f.field, message: ctx.scrub(f.message) }));
    if (error.details) safe.details = ctx.scrubber.scrubDeep(error.details);
    return safe;
  };
  const repo: OperationsRepo = {
    insert(rec) {
      const now = nowIso(ctx);
      const full: OperationRecord = {
        ...rec,
        environmentId: rec.environmentId ?? null,
        initiatorProfileId: rec.initiatorProfileId ?? null,
        expectedRevision: rec.expectedRevision ?? null,
        resultRevision: rec.resultRevision ?? null,
        routeEpoch: rec.routeEpoch ?? null,
        probeKind: rec.probeKind ?? null,
        supersededBy: rec.supersededBy ?? null,
        payload: rec.payload ?? {},
        result: rec.result ?? null,
        error: scrubError(rec.error ?? null) ?? null,
        createdAt: rec.createdAt ?? now,
        updatedAt: rec.updatedAt ?? now,
      };
      opMap.insert(db, full);
      return repo.get(full.id)!;
    },
    get(id) {
      const row = db.get('SELECT * FROM operations WHERE id = ?', [id]);
      return row ? opMap.fromRow(row) : null;
    },
    byRequestId(requestId) {
      const row = db.get('SELECT * FROM operations WHERE request_id = ?', [requestId]);
      return row ? opMap.fromRow(row) : null;
    },
    listByStatus(statuses, opts) {
      if (statuses.length === 0) return [];
      let sql = `SELECT * FROM operations WHERE status IN (${placeholders(statuses.length)})`;
      const params: string[] = [...statuses];
      if (opts?.kinds) {
        if (opts.kinds.length === 0) return [];
        sql += ` AND kind IN (${placeholders(opts.kinds.length)})`;
        params.push(...opts.kinds);
      }
      return db.all(`${sql} ORDER BY created_at, id`, params).map(opMap.fromRow);
    },
    listRecent(limit) {
      return db.all('SELECT * FROM operations ORDER BY created_at DESC, id DESC LIMIT ?', [limit]).map(opMap.fromRow);
    },
    listForEnvironment(environmentId, limit = 50) {
      return db.all('SELECT * FROM operations WHERE environment_id = ? ORDER BY created_at DESC, id DESC LIMIT ?', [environmentId, limit]).map(opMap.fromRow);
    },
    update(id, patch) {
      const p: OperationPatch = { ...patch, updatedAt: patch.updatedAt ?? nowIso(ctx) };
      if (patch.error !== undefined) p.error = scrubError(patch.error) ?? null;
      return opMap.update(db, p, 'id = ?', [id]) > 0;
    },
    setPhase(id, phase, status, patch) {
      return repo.update(id, { ...patch, phase, status });
    },
    appendStep(operationId, phase, message, at) {
      return db.tx(() => {
        const row = db.get<{ m: number | null }>('SELECT MAX(seq) AS m FROM operation_steps WHERE operation_id = ?', [operationId]);
        const step: OperationStepRecord = {
          operationId,
          seq: (row?.m ?? 0) + 1,
          at: at === undefined ? nowIso(ctx) : toIso(at),
          phase,
          message: ctx.scrub(message),
        };
        stepMap.insert(db, step);
        return step;
      });
    },
    listSteps(operationId) {
      return db.all('SELECT * FROM operation_steps WHERE operation_id = ? ORDER BY seq', [operationId]).map(stepMap.fromRow);
    },
  };
  return repo;
}

// ---------- outbox ----------

export interface OutboxRecord {
  id: number;
  operationId: string;
  resumeReason: string | null;
  availableAt: string;
  claimedAt: string | null;
  doneAt: string | null;
}

const outboxMap = mapper<OutboxRecord>('outbox', {
  id: col.int('id'),
  operationId: col.text('operation_id'),
  resumeReason: col.textNull('resume_reason'),
  availableAt: col.time('available_at'),
  claimedAt: col.timeNull('claimed_at'),
  doneAt: col.timeNull('done_at'),
});

export interface OutboxRepo {
  /** 返回新条目 id。 */
  enqueue(operationId: string, reason: string | null, availableAt: Date | string): number;
  /** 原子领取：一条 UPDATE … RETURNING，最早可用且未领取、未完成的一条；没有则 null。 */
  claimNext(now: Date | string): OutboxRecord | null;
  markDone(id: number, at?: Date | string): boolean;
  get(id: number): OutboxRecord | null;
  /** 未完成的条目（含已领取），按可用时间排序。 */
  listPending(): OutboxRecord[];
  pendingForOperation(operationId: string): OutboxRecord[];
  /** 启动恢复：把已领取但未完成的条目放回队列（上一次进程在执行中退出）。返回条数。 */
  releaseClaims(): number;
  /** 结束某操作的全部未完成条目（例如操作被取代）。返回条数。 */
  cancelForOperation(operationId: string, at?: Date | string): number;
  /** 最早的未领取条目的可用时间（用于安排下一次唤醒）。 */
  nextAvailableAt(): string | null;
}

export function createOutboxRepo(ctx: RepoContext): OutboxRepo {
  const { db } = ctx;
  const repo: OutboxRepo = {
    enqueue(operationId, reason, availableAt) {
      return db.run('INSERT INTO outbox (operation_id, resume_reason, available_at) VALUES (?, ?, ?)', [operationId, reason, toIso(availableAt)]).lastInsertRowid;
    },
    claimNext(now) {
      const t = toIso(now);
      const row = db.get(
        `UPDATE outbox SET claimed_at = ?
         WHERE id = (SELECT id FROM outbox WHERE done_at IS NULL AND claimed_at IS NULL AND available_at <= ? ORDER BY available_at, id LIMIT 1)
           AND claimed_at IS NULL
         RETURNING *`,
        [t, t],
      );
      return row ? outboxMap.fromRow(row) : null;
    },
    markDone(id, at) {
      return db.run('UPDATE outbox SET done_at = ? WHERE id = ? AND done_at IS NULL', [at === undefined ? nowIso(ctx) : toIso(at), id]).changes > 0;
    },
    get(id) {
      const row = db.get('SELECT * FROM outbox WHERE id = ?', [id]);
      return row ? outboxMap.fromRow(row) : null;
    },
    listPending: () => db.all('SELECT * FROM outbox WHERE done_at IS NULL ORDER BY available_at, id').map(outboxMap.fromRow),
    pendingForOperation: (operationId) =>
      db.all('SELECT * FROM outbox WHERE operation_id = ? AND done_at IS NULL ORDER BY available_at, id', [operationId]).map(outboxMap.fromRow),
    releaseClaims: () => db.run('UPDATE outbox SET claimed_at = NULL WHERE done_at IS NULL AND claimed_at IS NOT NULL').changes,
    cancelForOperation(operationId, at) {
      return db.run('UPDATE outbox SET done_at = ? WHERE operation_id = ? AND done_at IS NULL', [at === undefined ? nowIso(ctx) : toIso(at), operationId]).changes;
    },
    nextAvailableAt() {
      const row = db.get<{ t: string | null }>('SELECT MIN(available_at) AS t FROM outbox WHERE done_at IS NULL AND claimed_at IS NULL');
      return row?.t ?? null;
    },
  };
  return repo;
}
