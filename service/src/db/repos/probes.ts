// 预检与 Safari 实测记录；一次性 Safari 实测编号（test_id）。

import type { EntryMode, ProbeKind, ProbeOutcome } from '@sfe/contract';
import { col, mapper, nowIso, toIso, type InsertOf, type RepoContext } from './common.js';

export interface ProbeRecord {
  id: string;
  environmentId: string;
  kind: ProbeKind;
  outcome: ProbeOutcome;
  exitIp: string | null;
  proxyRevision: number;
  nodeName: string;
  routeEpoch: number | null;
  configurationGeneration: number | null;
  entryMode: EntryMode | null;
  testId: string | null;
  operationId: string | null;
  surgeRequestId: string | null;
  surgeRemoteHost: string | null;
  surgeRule: string | null;
  surgePolicy: string | null;
  surgeStartedAt: string | null;
  surgeNewConnection: boolean | null;
  chainEvidence: string | null;
  browserHttpStatus: number | null;
  browserStartedAt: string | null;
  browserFinishedAt: string | null;
  browserError: string | null;
  message: string | null;
  observedAt: string;
  expiresAt: string;
}

const probeMap = mapper<ProbeRecord>('probes', {
  id: col.text('id'),
  environmentId: col.text('environment_id'),
  kind: col.text<ProbeKind>('kind'),
  outcome: col.text<ProbeOutcome>('outcome'),
  exitIp: col.textNull('exit_ip'),
  proxyRevision: col.int('proxy_revision'),
  nodeName: col.text('node_name'),
  routeEpoch: col.intNull('route_epoch'),
  configurationGeneration: col.intNull('configuration_generation'),
  entryMode: col.textNull<EntryMode>('entry_mode'),
  testId: col.textNull('test_id'),
  operationId: col.textNull('operation_id'),
  surgeRequestId: col.textNull('surge_request_id'),
  surgeRemoteHost: col.textNull('surge_remote_host'),
  surgeRule: col.textNull('surge_rule'),
  surgePolicy: col.textNull('surge_policy'),
  surgeStartedAt: col.timeNull('surge_started_at'),
  surgeNewConnection: col.boolNull('surge_new_connection'),
  chainEvidence: col.textNull('chain_evidence'),
  browserHttpStatus: col.intNull('browser_http_status'),
  browserStartedAt: col.timeNull('browser_started_at'),
  browserFinishedAt: col.timeNull('browser_finished_at'),
  browserError: col.textNull('browser_error'),
  message: col.textNull('message'),
  observedAt: col.time('observed_at'),
  expiresAt: col.time('expires_at'),
});

type ProbeOptional =
  | 'exitIp'
  | 'routeEpoch'
  | 'configurationGeneration'
  | 'entryMode'
  | 'testId'
  | 'operationId'
  | 'surgeRequestId'
  | 'surgeRemoteHost'
  | 'surgeRule'
  | 'surgePolicy'
  | 'surgeStartedAt'
  | 'surgeNewConnection'
  | 'chainEvidence'
  | 'browserHttpStatus'
  | 'browserStartedAt'
  | 'browserFinishedAt'
  | 'browserError'
  | 'message';

export interface ProbesRepo {
  insert(rec: InsertOf<ProbeRecord, ProbeOptional>): ProbeRecord;
  get(id: string): ProbeRecord | null;
  /** 该环境该类最近的一条（按观测时间）。 */
  latest(environmentId: string, kind: ProbeKind): ProbeRecord | null;
  listForEnvironment(environmentId: string, limit?: number): ProbeRecord[];
  /** 例如提前标记过期（expiresAt）。消息写入前脱敏。 */
  update(id: string, patch: Partial<Omit<ProbeRecord, 'id' | 'environmentId' | 'kind'>>): boolean;
}

export function createProbesRepo(ctx: RepoContext): ProbesRepo {
  const { db } = ctx;
  const scrubText = (v: string | null | undefined) => (v === null || v === undefined ? v : ctx.scrub(v));
  const repo: ProbesRepo = {
    insert(rec) {
      const full: ProbeRecord = {
        exitIp: null,
        routeEpoch: null,
        configurationGeneration: null,
        entryMode: null,
        testId: null,
        operationId: null,
        surgeRequestId: null,
        surgeRemoteHost: null,
        surgeRule: null,
        surgePolicy: null,
        surgeStartedAt: null,
        surgeNewConnection: null,
        chainEvidence: null,
        browserHttpStatus: null,
        browserStartedAt: null,
        browserFinishedAt: null,
        browserError: null,
        message: null,
        ...rec,
      };
      full.message = scrubText(full.message) ?? null;
      full.browserError = scrubText(full.browserError) ?? null;
      full.chainEvidence = scrubText(full.chainEvidence) ?? null;
      full.surgeRule = scrubText(full.surgeRule) ?? null;
      probeMap.insert(db, full);
      return repo.get(full.id)!;
    },
    get(id) {
      const row = db.get('SELECT * FROM probes WHERE id = ?', [id]);
      return row ? probeMap.fromRow(row) : null;
    },
    latest(environmentId, kind) {
      const row = db.get('SELECT * FROM probes WHERE environment_id = ? AND kind = ? ORDER BY observed_at DESC, rowid DESC LIMIT 1', [environmentId, kind]);
      return row ? probeMap.fromRow(row) : null;
    },
    listForEnvironment(environmentId, limit = 50) {
      return db.all('SELECT * FROM probes WHERE environment_id = ? ORDER BY observed_at DESC, rowid DESC LIMIT ?', [environmentId, limit]).map(probeMap.fromRow);
    },
    update(id, patch) {
      const p = { ...patch };
      for (const k of ['message', 'browserError', 'chainEvidence', 'surgeRule'] as const) {
        if (typeof p[k] === 'string') p[k] = ctx.scrub(p[k]);
      }
      return probeMap.update(db, p, 'id = ?', [id]) > 0;
    },
  };
  return repo;
}

// ---------- 一次性实测编号 ----------

export type VerificationPurpose = 'activate' | 'apply_new_revision' | 'reverify' | 'probe_safari';

export interface VerificationTestRecord {
  testId: string;
  operationId: string;
  environmentId: string;
  profileId: string;
  routeEpoch: number;
  purpose: VerificationPurpose;
  issuedAt: string;
  deadline: string;
  consumedAt: string | null;
}

const testMap = mapper<VerificationTestRecord>('verification_tests', {
  testId: col.text('test_id'),
  operationId: col.text('operation_id'),
  environmentId: col.text('environment_id'),
  profileId: col.text('profile_id'),
  routeEpoch: col.int('route_epoch'),
  purpose: col.text<VerificationPurpose>('purpose'),
  issuedAt: col.time('issued_at'),
  deadline: col.time('deadline'),
  consumedAt: col.timeNull('consumed_at'),
});

export interface VerificationTestsRepo {
  insert(rec: InsertOf<VerificationTestRecord, 'issuedAt' | 'consumedAt'>): VerificationTestRecord;
  get(testId: string): VerificationTestRecord | null;
  /** 只有尚未使用时才标记为已使用；返回是否由本次调用使用。 */
  consume(testId: string, at?: Date | string): boolean;
  listForOperation(operationId: string): VerificationTestRecord[];
}

export function createVerificationTestsRepo(ctx: RepoContext): VerificationTestsRepo {
  const { db } = ctx;
  const repo: VerificationTestsRepo = {
    insert(rec) {
      testMap.insert(db, { ...rec, issuedAt: rec.issuedAt ?? nowIso(ctx), consumedAt: rec.consumedAt ?? null });
      return repo.get(rec.testId)!;
    },
    get(testId) {
      const row = db.get('SELECT * FROM verification_tests WHERE test_id = ?', [testId]);
      return row ? testMap.fromRow(row) : null;
    },
    consume(testId, at) {
      return db.run('UPDATE verification_tests SET consumed_at = ? WHERE test_id = ? AND consumed_at IS NULL', [at === undefined ? nowIso(ctx) : toIso(at), testId]).changes === 1;
    },
    listForOperation: (operationId) => db.all('SELECT * FROM verification_tests WHERE operation_id = ? ORDER BY issued_at', [operationId]).map(testMap.fromRow),
  };
  return repo;
}
