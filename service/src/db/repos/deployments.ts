// 发布记录（按配置代数）、发布包含的操作、本应用拥有的对象清单（归属判断的唯一依据）。

import { col, mapper, nowIso, placeholders, type InsertOf, type RepoContext } from './common.js';

/** 资源中的一个节点（不含任何凭据）。 */
export interface NodeManifestEntry {
  nodeName: string;
  environmentId: string;
  proxyRevision: number;
  [key: string]: unknown;
}

export type DeploymentState = 'candidate' | 'published' | 'verified' | 'failed' | 'rolled_back';

export interface DeploymentRecord {
  generation: number;
  /**
   * 工作配置的核对值：本进程随机密钥下的 HMAC 与进程标记（engine/handlers/publish.ts profileCheckOf），只在同一进程内用于变化
   * 提示；从不保存工作配置的 pepper 派生摘要（迁移 6 清除升级前保存的）。
   */
  workingProfileDigest: string | null;
  resourceDigest: string;
  nodeManifest: NodeManifestEntry[];
  selectionBefore: string | null;
  state: DeploymentState;
  readbackLevel: 'full' | 'partial' | null;
  uncheckedFields: string[];
  operationId: string | null;
  createdAt: string;
  updatedAt: string;
}

const deploymentMap = mapper<DeploymentRecord>('deployments', {
  generation: col.int('generation'),
  workingProfileDigest: col.textNull('working_profile_digest'),
  resourceDigest: col.text('resource_digest'),
  nodeManifest: col.json<NodeManifestEntry[]>('node_manifest', []),
  selectionBefore: col.textNull('selection_before'),
  state: col.text<DeploymentState>('state'),
  readbackLevel: col.textNull<'full' | 'partial'>('readback_level'),
  uncheckedFields: col.json<string[]>('unchecked_fields', []),
  operationId: col.textNull('operation_id'),
  createdAt: col.time('created_at'),
  updatedAt: col.time('updated_at'),
});

export interface DeploymentOperationRecord {
  generation: number;
  operationId: string;
  environmentId: string | null;
  proxyRevision: number | null;
  outcome: string | null;
}

const deploymentOpMap = mapper<DeploymentOperationRecord>('deployment_operations', {
  generation: col.int('generation'),
  operationId: col.text('operation_id'),
  environmentId: col.textNull('environment_id'),
  proxyRevision: col.intNull('proxy_revision'),
  outcome: col.textNull('outcome'),
});

export interface DeploymentsRepo {
  insert(rec: InsertOf<DeploymentRecord, 'createdAt' | 'updatedAt' | 'uncheckedFields' | 'readbackLevel'>): DeploymentRecord;
  get(generation: number): DeploymentRecord | null;
  /** 代数最大的一条。 */
  latest(): DeploymentRecord | null;
  /** 代数最大的、状态属于 states 的一条（例如回滚目标：上一份 verified）。 */
  latestWithState(states: DeploymentState[]): DeploymentRecord | null;
  /** 按代数倒序。 */
  list(limit?: number): DeploymentRecord[];
  update(generation: number, patch: Partial<Omit<DeploymentRecord, 'generation' | 'createdAt'>>): boolean;
  addOperation(rec: InsertOf<DeploymentOperationRecord, 'outcome' | 'environmentId' | 'proxyRevision'>): void;
  listOperations(generation: number): DeploymentOperationRecord[];
  listByOperation(operationId: string): DeploymentOperationRecord[];
  setOperationOutcome(generation: number, operationId: string, outcome: string | null): boolean;
}

export function createDeploymentsRepo(ctx: RepoContext): DeploymentsRepo {
  const { db } = ctx;
  const repo: DeploymentsRepo = {
    insert(rec) {
      const now = nowIso(ctx);
      deploymentMap.insert(db, {
        ...rec,
        readbackLevel: rec.readbackLevel ?? null,
        uncheckedFields: rec.uncheckedFields ?? [],
        createdAt: rec.createdAt ?? now,
        updatedAt: rec.updatedAt ?? now,
      });
      return repo.get(rec.generation)!;
    },
    get(generation) {
      const row = db.get('SELECT * FROM deployments WHERE generation = ?', [generation]);
      return row ? deploymentMap.fromRow(row) : null;
    },
    latest() {
      const row = db.get('SELECT * FROM deployments ORDER BY generation DESC LIMIT 1');
      return row ? deploymentMap.fromRow(row) : null;
    },
    latestWithState(states) {
      if (states.length === 0) return null;
      const row = db.get(`SELECT * FROM deployments WHERE state IN (${placeholders(states.length)}) ORDER BY generation DESC LIMIT 1`, states);
      return row ? deploymentMap.fromRow(row) : null;
    },
    list(limit = 50) {
      return db.all('SELECT * FROM deployments ORDER BY generation DESC LIMIT ?', [limit]).map(deploymentMap.fromRow);
    },
    update(generation, patch) {
      return deploymentMap.update(db, { ...patch, updatedAt: patch.updatedAt ?? nowIso(ctx) }, 'generation = ?', [generation]) > 0;
    },
    addOperation(rec) {
      deploymentOpMap.insert(db, { ...rec, environmentId: rec.environmentId ?? null, proxyRevision: rec.proxyRevision ?? null, outcome: rec.outcome ?? null });
    },
    listOperations(generation) {
      return db.all('SELECT * FROM deployment_operations WHERE generation = ? ORDER BY operation_id', [generation]).map(deploymentOpMap.fromRow);
    },
    listByOperation(operationId) {
      return db.all('SELECT * FROM deployment_operations WHERE operation_id = ? ORDER BY generation', [operationId]).map(deploymentOpMap.fromRow);
    },
    setOperationOutcome(generation, operationId, outcome) {
      return deploymentOpMap.update(db, { outcome }, 'generation = ? AND operation_id = ?', [generation, operationId]) > 0;
    },
  };
  return repo;
}

// ---------- 本应用拥有的对象 ----------

export type ManagedObjectKind = 'group_segment' | 'entry_segment' | 'general_segment' | 'resource_file' | 'entry_ruleset_file' | 'temp_rule';
export type ManagedObjectState = 'pending_add' | 'present' | 'pending_remove' | 'removed';

export interface ManagedObjectRecord {
  id: string;
  kind: ManagedObjectKind;
  identity: string;
  /** 带密钥摘要（HMAC）。 */
  contentDigest: string | null;
  version: number;
  state: ManagedObjectState;
  createdByOperation: string | null;
  updatedAt: string;
}

const managedMap = mapper<ManagedObjectRecord>('managed_objects', {
  id: col.text('id'),
  kind: col.text<ManagedObjectKind>('kind'),
  identity: col.text('identity'),
  contentDigest: col.textNull('content_digest'),
  version: col.int('version'),
  state: col.text<ManagedObjectState>('state'),
  createdByOperation: col.textNull('created_by_operation'),
  updatedAt: col.time('updated_at'),
});

export interface ManagedIntentInput {
  kind: ManagedObjectKind;
  identity: string;
  /** 写入后预期的内容摘要（pending_remove 时可为 null）。 */
  contentDigest: string | null;
  state: 'pending_add' | 'pending_remove';
  createdByOperation?: string | null;
  version?: number;
}

export interface ManagedObjectsRepo {
  get(kind: ManagedObjectKind, identity: string): ManagedObjectRecord | null;
  getById(id: string): ManagedObjectRecord | null;
  listByKind(kind: ManagedObjectKind): ManagedObjectRecord[];
  list(): ManagedObjectRecord[];
  /**
   * 写入前提交意图行：不存在则新建（id 自动生成），存在则更新状态与预期摘要。
   * createdByOperation 只在新建时写入，之后保持首次创建它的操作。
   */
  upsertIntent(input: ManagedIntentInput): ManagedObjectRecord;
  /** 读回确认后更新状态（present / removed 等）与可选的实际摘要、版本。 */
  setState(kind: ManagedObjectKind, identity: string, state: ManagedObjectState, patch?: { contentDigest?: string | null; version?: number }): boolean;
  delete(kind: ManagedObjectKind, identity: string): boolean;
}

export function createManagedObjectsRepo(ctx: RepoContext): ManagedObjectsRepo {
  const { db } = ctx;
  const repo: ManagedObjectsRepo = {
    get(kind, identity) {
      const row = db.get('SELECT * FROM managed_objects WHERE kind = ? AND identity = ?', [kind, identity]);
      return row ? managedMap.fromRow(row) : null;
    },
    getById(id) {
      const row = db.get('SELECT * FROM managed_objects WHERE id = ?', [id]);
      return row ? managedMap.fromRow(row) : null;
    },
    listByKind: (kind) => db.all('SELECT * FROM managed_objects WHERE kind = ? ORDER BY identity', [kind]).map(managedMap.fromRow),
    list: () => db.all('SELECT * FROM managed_objects ORDER BY kind, identity').map(managedMap.fromRow),
    upsertIntent(input) {
      return db.tx(() => {
        const existing = repo.get(input.kind, input.identity);
        const now = nowIso(ctx);
        if (!existing) {
          managedMap.insert(db, {
            id: ctx.ids.next('mo'),
            kind: input.kind,
            identity: input.identity,
            contentDigest: input.contentDigest,
            version: input.version ?? 1,
            state: input.state,
            createdByOperation: input.createdByOperation ?? null,
            updatedAt: now,
          });
        } else {
          const patch: Partial<ManagedObjectRecord> = { contentDigest: input.contentDigest, state: input.state, updatedAt: now };
          if (input.version !== undefined) patch.version = input.version;
          managedMap.update(db, patch, 'id = ?', [existing.id]);
        }
        return repo.get(input.kind, input.identity)!;
      });
    },
    setState(kind, identity, state, patch) {
      const p: Partial<ManagedObjectRecord> = { state, updatedAt: nowIso(ctx) };
      if (patch?.contentDigest !== undefined) p.contentDigest = patch.contentDigest;
      if (patch?.version !== undefined) p.version = patch.version;
      return managedMap.update(db, p, 'kind = ? AND identity = ?', [kind, identity]) > 0;
    },
    delete: (kind, identity) => db.run('DELETE FROM managed_objects WHERE kind = ? AND identity = ?', [kind, identity]).changes > 0,
  };
  return repo;
}
