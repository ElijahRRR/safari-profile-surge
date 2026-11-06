// 路由状态（单行）。首次读取时初始化为 epoch 0、NORMAL、idle。

import type { ActivationSnapshot, EntryMode, OldSessionPolicy, RoutePhase, RouteWarning } from '@sfe/contract';
import { col, mapper, nowIso, type RepoContext } from './common.js';

export interface RouteStateRecord {
  routeEpoch: number;
  entryMode: EntryMode;
  entryModeVerifiedAt: string | null;
  phase: RoutePhase;
  activeEnvironmentId: string | null;
  activeProxyRevision: number | null;
  selectedNode: string | null;
  oldSessionPolicy: OldSessionPolicy | null;
  operationId: string | null;
  awaitingDeadline: string | null;
  warnings: RouteWarning[];
  activationSnapshot: ActivationSnapshot | null;
  lastReconciledAt: string | null;
  surgeStartedAt: string | null;
  updatedAt: string;
}

const routeMap = mapper<RouteStateRecord & { id: number }>('route_state', {
  id: col.int('id'),
  routeEpoch: col.int('route_epoch'),
  entryMode: col.text<EntryMode>('entry_mode'),
  entryModeVerifiedAt: col.timeNull('entry_mode_verified_at'),
  phase: col.text<RoutePhase>('phase'),
  activeEnvironmentId: col.textNull('active_environment_id'),
  activeProxyRevision: col.intNull('active_proxy_revision'),
  selectedNode: col.textNull('selected_node'),
  oldSessionPolicy: col.textNull<OldSessionPolicy>('old_session_policy'),
  operationId: col.textNull('operation_id'),
  awaitingDeadline: col.timeNull('awaiting_deadline'),
  warnings: col.json<RouteWarning[]>('warnings', []),
  activationSnapshot: col.jsonNull<ActivationSnapshot>('activation_snapshot'),
  lastReconciledAt: col.timeNull('last_reconciled_at'),
  surgeStartedAt: col.timeNull('surge_started_at'),
  updatedAt: col.time('updated_at'),
});

export interface RouteStateRepo {
  /** 读取单行；不存在时以默认值初始化。 */
  get(): RouteStateRecord;
  /** 整行保存（警告去重并保持顺序，updatedAt 设为当前时间）。返回保存后的记录。 */
  save(rec: RouteStateRecord): RouteStateRecord;
  /** 读取 → 合并 patch → 保存。 */
  update(patch: Partial<Omit<RouteStateRecord, 'updatedAt'>>): RouteStateRecord;
}

export function defaultRouteState(now: string): RouteStateRecord {
  return {
    routeEpoch: 0,
    entryMode: 'NORMAL',
    entryModeVerifiedAt: null,
    phase: 'idle',
    activeEnvironmentId: null,
    activeProxyRevision: null,
    selectedNode: null,
    oldSessionPolicy: null,
    operationId: null,
    awaitingDeadline: null,
    warnings: [],
    activationSnapshot: null,
    lastReconciledAt: null,
    surgeStartedAt: null,
    updatedAt: now,
  };
}

export function createRouteStateRepo(ctx: RepoContext): RouteStateRepo {
  const { db } = ctx;
  const read = (): RouteStateRecord | null => {
    const row = db.get('SELECT * FROM route_state WHERE id = 1');
    if (!row) return null;
    const { id: _id, ...rec } = routeMap.fromRow(row);
    return rec;
  };
  const repo: RouteStateRepo = {
    get() {
      const existing = read();
      if (existing) return existing;
      routeMap.insert(db, { id: 1, ...defaultRouteState(nowIso(ctx)) }, 'OR IGNORE');
      return read()!;
    },
    save(rec) {
      const full = { id: 1, ...rec, warnings: [...new Set(rec.warnings)], updatedAt: nowIso(ctx) };
      return db.tx(() => {
        repo.get();
        const { id: _id, ...patch } = full;
        routeMap.update(db, patch, 'id = 1', []);
        return read()!;
      });
    },
    update(patch) {
      return db.tx(() => repo.save({ ...repo.get(), ...patch }));
    },
  };
  return repo;
}
