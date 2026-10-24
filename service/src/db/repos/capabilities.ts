// 能力记录与待确认提议。supported/unsupported 只能由网页确认一个提议后写入（业务层负责）。

import type { CapabilityContext, CapabilityKey, CapabilityStatus, EntryStrategy, ProtocolCoverage } from '@sfe/contract';
import { col, mapper, nowIso, toIso, type InsertOf, type RepoContext } from './common.js';

export interface CapabilityRecord {
  key: CapabilityKey;
  status: CapabilityStatus;
  context: CapabilityContext | null;
  protocolCoverage: ProtocolCoverage | null;
  proposalId: string | null;
  verifiedAt: string | null;
  note: string | null;
}

const capMap = mapper<CapabilityRecord>('capabilities', {
  key: col.text<CapabilityKey>('key'),
  status: col.text<CapabilityStatus>('status'),
  context: col.jsonNull<CapabilityContext>('context'),
  protocolCoverage: col.jsonNull<ProtocolCoverage>('protocol_coverage'),
  proposalId: col.textNull('proposal_id'),
  verifiedAt: col.timeNull('verified_at'),
  note: col.textNull('note'),
});

export interface CapabilitiesRepo {
  /** 只返回已有记录的项（未记录的项由业务层视为 unverified）。按 key 排序。 */
  list(): CapabilityRecord[];
  get(key: CapabilityKey): CapabilityRecord | null;
  upsert(rec: InsertOf<CapabilityRecord, 'context' | 'protocolCoverage' | 'proposalId' | 'verifiedAt' | 'note'>): CapabilityRecord;
}

export function createCapabilitiesRepo(ctx: RepoContext): CapabilitiesRepo {
  const { db } = ctx;
  const repo: CapabilitiesRepo = {
    list: () => db.all('SELECT * FROM capabilities ORDER BY key').map(capMap.fromRow),
    get(key) {
      const row = db.get('SELECT * FROM capabilities WHERE key = ?', [key]);
      return row ? capMap.fromRow(row) : null;
    },
    upsert(rec) {
      capMap.insert(
        db,
        {
          key: rec.key,
          status: rec.status,
          context: rec.context ?? null,
          protocolCoverage: rec.protocolCoverage ?? null,
          proposalId: rec.proposalId ?? null,
          verifiedAt: rec.verifiedAt ?? null,
          note: rec.note === null || rec.note === undefined ? null : ctx.scrub(rec.note),
        },
        'OR REPLACE',
      );
      return repo.get(rec.key)!;
    },
  };
  return repo;
}

// ---------- 提议 ----------

export interface CapabilityProposalRecord {
  id: string;
  key: CapabilityKey;
  proposedStatus: Exclude<CapabilityStatus, 'unverified'>;
  context: CapabilityContext;
  summary: string;
  evidenceDigest: string;
  protocolCoverage: ProtocolCoverage | null;
  safariProcessPaths: string[] | null;
  entryStrategy: EntryStrategy | null;
  submittedBy: 'agent' | 'admin';
  submittedAt: string;
  confirmedAt: string | null;
  rejectedAt: string | null;
}

const proposalMap = mapper<CapabilityProposalRecord>('capability_proposals', {
  id: col.text('id'),
  key: col.text<CapabilityKey>('key'),
  proposedStatus: col.text<Exclude<CapabilityStatus, 'unverified'>>('proposed_status'),
  context: col.json<CapabilityContext>('context', null as unknown as CapabilityContext),
  summary: col.text('summary'),
  evidenceDigest: col.text('evidence_digest'),
  protocolCoverage: col.jsonNull<ProtocolCoverage>('protocol_coverage'),
  safariProcessPaths: col.jsonNull<string[]>('safari_process_paths'),
  entryStrategy: col.textNull<EntryStrategy>('entry_strategy'),
  submittedBy: col.text<'agent' | 'admin'>('submitted_by'),
  submittedAt: col.time('submitted_at'),
  confirmedAt: col.timeNull('confirmed_at'),
  rejectedAt: col.timeNull('rejected_at'),
});

export interface CapabilityProposalsRepo {
  insert(rec: InsertOf<CapabilityProposalRecord, 'submittedAt' | 'confirmedAt' | 'rejectedAt' | 'protocolCoverage' | 'safariProcessPaths' | 'entryStrategy'>): CapabilityProposalRecord;
  get(id: string): CapabilityProposalRecord | null;
  /** pending: true 只返回未确认也未拒绝的；可按 key 过滤。按提交时间正序。 */
  list(opts?: { pending?: boolean; key?: CapabilityKey }): CapabilityProposalRecord[];
  /** 只有待确认的提议才能确认；返回是否由本次调用确认。 */
  markConfirmed(id: string, at?: Date | string): boolean;
  markRejected(id: string, at?: Date | string): boolean;
}

export function createCapabilityProposalsRepo(ctx: RepoContext): CapabilityProposalsRepo {
  const { db } = ctx;
  const repo: CapabilityProposalsRepo = {
    insert(rec) {
      proposalMap.insert(db, {
        protocolCoverage: null,
        safariProcessPaths: null,
        entryStrategy: null,
        confirmedAt: null,
        rejectedAt: null,
        ...rec,
        // 摘要应由提交方脱敏；这里再按值与规则兜底一次
        summary: ctx.scrub(rec.summary),
        submittedAt: rec.submittedAt ?? nowIso(ctx),
      });
      return repo.get(rec.id)!;
    },
    get(id) {
      const row = db.get('SELECT * FROM capability_proposals WHERE id = ?', [id]);
      return row ? proposalMap.fromRow(row) : null;
    },
    list(opts) {
      const where: string[] = [];
      const params: string[] = [];
      if (opts?.pending) where.push('confirmed_at IS NULL AND rejected_at IS NULL');
      if (opts?.key) {
        where.push('key = ?');
        params.push(opts.key);
      }
      return db
        .all(`SELECT * FROM capability_proposals ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY submitted_at, id`, params)
        .map(proposalMap.fromRow);
    },
    markConfirmed(id, at) {
      const t = at === undefined ? nowIso(ctx) : toIso(at);
      return db.run('UPDATE capability_proposals SET confirmed_at = ? WHERE id = ? AND confirmed_at IS NULL AND rejected_at IS NULL', [t, id]).changes === 1;
    },
    markRejected(id, at) {
      const t = at === undefined ? nowIso(ctx) : toIso(at);
      return db.run('UPDATE capability_proposals SET rejected_at = ? WHERE id = ? AND confirmed_at IS NULL AND rejected_at IS NULL', [t, id]).changes === 1;
    },
  };
  return repo;
}
