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

/**
 * 计时器条目的恢复原因（handlers/route.ts handleTimeout）：只有它们要等可用时间（截止时间）到达才能领取，处理时再按截止时间
 * 判断；其余条目按受理时的墙上时间入队、本应立即执行（claimNext）。
 */
export const TIMER_RESUME_REASONS = ['arrival_timeout', 'verify_timeout'] as const;

const NOT_TIMER = `(resume_reason IS NULL OR resume_reason NOT IN (${TIMER_RESUME_REASONS.map((r) => `'${r}'`).join(', ')}))`;

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
  /**
   * 原子领取：一条 UPDATE … RETURNING，可以领取且未领取、未完成的条目中最早的一条；没有则 null。只有计时器条目
   * （TIMER_RESUME_REASONS：到达或实测截止时间）要等可用时间到达；其余条目（新受理的操作、取消、提交的实测、场景到达、重测失去
   * 路由）按受理时的墙上时间入队、本应立即执行，一律可以领取——否则墙上时钟在入队之后回拨（例如 NTP 校正）时它们要多等回拨的
   * 时长，排队的普通模式停在买家出口上、崩溃恢复中的操作领取不到（§6.1 领取顺序）。prefer 为按优先级排列的操作 id 组：属于
   * 前面一组的条目先于后面的组与其他条目（各组内仍按可用时间与 id 排序；空组忽略）。
   */
  claimNext(now: Date | string, prefer?: readonly (readonly string[])[] | null): OutboxRecord | null;
  markDone(id: number, at?: Date | string): boolean;
  get(id: number): OutboxRecord | null;
  /** 未完成的条目（含已领取），按可用时间排序。 */
  listPending(): OutboxRecord[];
  pendingForOperation(operationId: string): OutboxRecord[];
  /**
   * 启动恢复：把已领取但未完成的条目放回队列（上一次进程在执行中退出）。返回条数。操作仍是 running（崩溃恢复，§6.1 领取顺序
   * 第 ①组）的条目可用时间不晚于 now：上一次进程领取时它已到期（计时器条目也一样），恢复不因墙上时钟在重启前回拨而推迟。其他
   * 操作的计时器条目保持原截止时间——提前领取时截止时间未到，处理器什么也不做，条目却已完成、截止时间就此丢失。
   */
  releaseClaims(now?: Date | string): number;
  /** 结束某操作的全部未完成条目（例如操作被取代）。返回条数。 */
  cancelForOperation(operationId: string, at?: Date | string): number;
  /** 最早的未领取条目的可用时间（用于安排下一次唤醒）；非计时器条目一律按不晚于 now 计（claimNext 立即可以领取）。 */
  nextAvailableAt(now?: Date | string): string | null;
}

export function createOutboxRepo(ctx: RepoContext): OutboxRepo {
  const { db } = ctx;
  const repo: OutboxRepo = {
    enqueue(operationId, reason, availableAt) {
      return db.run('INSERT INTO outbox (operation_id, resume_reason, available_at) VALUES (?, ?, ?)', [operationId, reason, toIso(availableAt)]).lastInsertRowid;
    },
    claimNext(now, prefer) {
      const t = toIso(now);
      const groups = (prefer ?? []).filter((g) => g.length > 0);
      const order =
        groups.length > 0
          ? `ORDER BY CASE ${groups.map((g, i) => `WHEN operation_id IN (${g.map(() => '?').join(', ')}) THEN ${i}`).join(' ')} ELSE ${groups.length} END, available_at, id`
          : 'ORDER BY available_at, id';
      const row = db.get(
        `UPDATE outbox SET claimed_at = ?
         WHERE id = (SELECT id FROM outbox WHERE done_at IS NULL AND claimed_at IS NULL AND (available_at <= ? OR ${NOT_TIMER}) ${order} LIMIT 1)
           AND claimed_at IS NULL
         RETURNING *`,
        [t, t, ...groups.flat()],
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
    releaseClaims(now) {
      const t = now === undefined ? nowIso(ctx) : toIso(now);
      return db.run(
        `UPDATE outbox SET claimed_at = NULL,
           available_at = CASE WHEN available_at > ? AND operation_id IN (SELECT id FROM operations WHERE status = 'running') THEN ? ELSE available_at END
         WHERE done_at IS NULL AND claimed_at IS NOT NULL`,
        [t, t],
      ).changes;
    },
    cancelForOperation(operationId, at) {
      return db.run('UPDATE outbox SET done_at = ? WHERE operation_id = ? AND done_at IS NULL', [at === undefined ? nowIso(ctx) : toIso(at), operationId]).changes;
    },
    nextAvailableAt(now) {
      const t = now === undefined ? nowIso(ctx) : toIso(now);
      const row = db.get<{ t: string | null }>(
        `SELECT MIN(CASE WHEN ${NOT_TIMER} AND available_at > ? THEN ? ELSE available_at END) AS t FROM outbox WHERE done_at IS NULL AND claimed_at IS NULL`,
        [t, t],
      );
      return row?.t ?? null;
    },
  };
  return repo;
}
