// AppService 实现：HTTP、agent/maintenance 套接字与原生桥共用的业务入口。受理在请求内同步完成并返回 202；
// Surge 写入只在唯一执行器中发生。启动顺序：pepper → 主机事实 → 对账 → 恢复未完成操作 → 执行器 → 周期任务。
// 停止只停执行器与计时器，从不改变入口状态或 SFE-ROUTE 选择。

import { basename } from 'node:path';
import {
  ENTRY_RULESET_FILES,
  NODE_RESOURCE_FILE,
  SfeError,
  WORKING_PROFILE_NAME,
  type AccountDetail,
  type CapabilityView,
  type ImportCommitResult,
  type ImportPreview,
  type LoginCodeResponse,
  type NativeResponse,
  type OperationView,
  type SettingsView,
  type Snapshot,
  type SurgeStatusView,
} from '@sfe/contract';
import type { Actor, AppService, SurgePolicyCandidates } from '../app.js';
import { importTemplateCsv } from '../importer/index.js';
import { sweepProfileTempFiles } from '../surge/files.js';
import { BUILTIN_POLICIES } from '../surge/rules.js';
import { sweepTempFiles } from '../util/secure-files.js';
import {
  acceptAcknowledgeAccount,
  acceptAcknowledgeWindows,
  acceptActivate,
  acceptCancel,
  acceptCreate,
  acceptDelete,
  acceptNormal,
  acceptProbe,
  acceptPublishPending,
  acceptUnbind,
  acceptUpdate,
  getEnvironment,
  insertOperation,
  type AcceptDeps,
} from './accept.js';
import {
  confirmCapability,
  proposeCapability,
  registerFrontProxy,
  replaceFrontCommit,
  replaceFrontPreview,
  updateFrontProxy,
  updateSettings,
  verifyFrontProxy,
} from './admin-ops.js';
import { sweepCandidateDirs } from './candidate.js';
import { Engine, type AppServiceDeps } from './context.js';
import { createDispatcher } from './dispatch.js';
import { Executor } from './executor.js';
import { failOrphanedOperations } from './handlers/publish.js';
import { importCommit, importPreview } from './import.js';
import { initCommit, initPreview, remergeCommit, remergePreview } from './maintenance.js';
import { resourceOwnershipUnsettled, settleResourceDigests } from './ownership.js';
import { handleNative } from './native.js';
import { controlAfterReconcile, reconcile, surgeStatus } from './reconcile.js';
import { createViewService, type ViewService } from './view-service.js';
import type { PrecheckEvaluation } from '../domain/route-rules.js';

export type { AppServiceDeps } from './context.js';

const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_PRECHECK_TIMEOUT_MS = 5_000;

export interface EngineAppService extends AppService {
  /** 测试与组装用：引擎内部（只读访问）。 */
  readonly engine: Engine;
  readonly executor: Executor;
  readonly views: ViewService;
  /** 等待执行器处理完所有到期任务。 */
  idle(): Promise<void>;
  /** 立即运行一次周期对账（测试用）。 */
  runPeriodicReconcile(): Promise<void>;
  ensureInControl(opts?: { maxAgeMs?: number }): Promise<PrecheckEvaluation>;
}

function requireWebOrAdmin(actor: Actor, action: string): void {
  if (actor.kind !== 'web' && actor.kind !== 'admin') throw new SfeError('BAD_REQUEST', `${action}失败：该通道无权执行此操作`);
}

export function createAppService(deps: AppServiceDeps): EngineAppService {
  const engine = new Engine(deps);
  const views = createViewService(engine);
  engine.views = views;
  let executor: Executor;
  const kick = () => executor.kick();
  const acceptDeps: AcceptDeps = { engine, views, kick };
  const dispatch = createDispatcher(engine, {
    enqueuePublish: () => {
      const op = engine.repos.tx(() =>
        insertOperation(engine, {
          kind: 'deploy.publish',
          requestId: `remerge:${engine.ids.token(16)}`,
          digest: 'service',
          actor: { kind: 'admin' },
          // 恢复的资源名称与上次发布相同：强制写入、等待 Surge 重新读取并逐节点读回，不走“没有修改”的捷径
          payload: { environmentIds: null, forceRefresh: true },
          step: '重新合并后发布节点资源',
        }),
      );
      engine.emit({ operations: [op.id] });
      kick();
    },
  });
  executor = new Executor(engine, dispatch);
  const serviceVersion = deps.serviceVersion ?? '0.0.0-dev';

  // ---------- 受控判定（动作前短超时对账） ----------

  type PrecheckOutcome = 'done' | 'busy' | 'failed';
  /** 进行中（已开始读 Surge）的动作前对账：可复用之前对账的检查共用它（超时之后它仍在后台完成），不因它占着通道而返回“正忙”。 */
  let precheckRun: Promise<PrecheckOutcome> | null = null;
  /** 排在进行中的对账之后、尚未开始的一次对账：不复用之前对账的检查（fresh）共用它——它在它们全部到达之后才开始读 Surge。 */
  let precheckNext: Promise<PrecheckOutcome> | null = null;

  function startPrecheck(): Promise<PrecheckOutcome> {
    const run: Promise<PrecheckOutcome> = executor
      .tryRunExclusive(async () => {
        await reconcile(engine, 'precheck');
        return 'done' as const;
      })
      .then((r) => r ?? ('busy' as const))
      .catch(() => 'failed' as const)
      .finally(() => {
        if (precheckRun === run) precheckRun = null;
      });
    precheckRun = run;
    return run;
  }

  /**
   * fresh：只接受在本次调用之后才开始读 Surge 的对账（填充等动作前检查不复用之前的对账，§6.6）。进行中的对账可能在调用之前
   * 就读过出站模式、接管等事实，之后的变化它看不到：等它结束再开始新的一次（失败即关闭：期间执行器开始执行操作 → 正忙）。
   * 否则共用进行中的对账。
   */
  function runPrecheck(fresh: boolean): Promise<PrecheckOutcome> {
    if (!precheckRun) return startPrecheck();
    if (!fresh) return precheckRun;
    precheckNext ??= precheckRun.then(() => {
      precheckNext = null;
      // 其间已开始的对账（例如可复用对账的检查在进行中的对账结束后开始的）同样开始于本次调用之后
      return precheckRun ?? startPrecheck();
    });
    return precheckNext;
  }

  /**
   * 动作前检查：maxAgeMs 内完成过对账（任何来源：动作前、周期、刷新、提交 ACTIVE 之后的对账，按路由记录的 lastReconciledAt）
   * 时不再读 Surge；否则在执行器空闲时短超时对账一次。maxAgeMs 为 0（缺省：填充）时不复用任何之前的对账，也不共用调用之前
   * 已开始读 Surge 的对账（runPrecheck fresh）。判定总是在返回时按当前的路由记录与实测重新计算（controlAfterReconcile，
   * 不读 Surge），从不复用之前的判定结果——期间的对账、路由操作或受理可能已改写路由。没有完成对账（执行器正忙、超时、失败）
   * 时 checked 为 false、ok 为 false，结果不缓存。
   */
  async function ensureInControl(opts: { maxAgeMs?: number } = {}): Promise<PrecheckEvaluation> {
    const maxAge = opts.maxAgeMs ?? 0;
    const last = engine.repos.routeState.get().lastReconciledAt;
    if (maxAge > 0 && last !== null && engine.now().getTime() - Date.parse(last) <= maxAge) return { ...controlAfterReconcile(engine), checked: true };
    const timeoutMs = deps.precheckTimeoutMs ?? DEFAULT_PRECHECK_TIMEOUT_MS;
    let cancelTimer: () => void = () => undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      cancelTimer = engine.clock.setTimeout(() => resolve('timeout'), timeoutMs);
    });
    const outcome = await Promise.race([runPrecheck(maxAge === 0), timeout]);
    cancelTimer();
    if (outcome === 'done') return { ...controlAfterReconcile(engine), checked: true };
    const reason = outcome === 'busy' ? '正在切换出口，请稍后再试' : outcome === 'timeout' ? '读取 Surge 状态超时' : '读取 Surge 状态失败';
    return { ok: false, reason, checked: false };
  }

  // ---------- 周期任务 ----------

  let reconcileTimer: (() => void) | null = null;
  let sweepTimer: (() => void) | null = null;
  let stopped = true;

  function scheduleReconcile(): void {
    reconcileTimer?.();
    if (stopped) return;
    const sec = engine.repos.settings.get('reconcileIntervalSec');
    reconcileTimer = engine.clock.setTimeout(() => {
      void runPeriodicReconcile().finally(() => scheduleReconcile());
    }, sec * 1000);
  }

  async function runPeriodicReconcile(): Promise<void> {
    const route = engine.repos.routeState.get();
    // 只在路由阶段不是 idle 或入口不是 NORMAL 时对账；作为执行器内部任务，写入进行中时自动延后
    if (route.phase === 'idle' && route.entryMode === 'NORMAL') return;
    try {
      await executor.runInternal('reconcile', () => reconcile(engine, 'periodic'));
    } catch (err) {
      engine.log('warn', 'reconcile.failed', { error: err instanceof Error ? err.name : 'unknown' });
    }
  }

  function scheduleSweep(): void {
    sweepTimer?.();
    if (stopped) return;
    sweepTimer = engine.clock.setTimeout(() => {
      void runSweep().finally(() => scheduleSweep());
    }, SWEEP_INTERVAL_MS);
  }

  async function runSweep(): Promise<void> {
    try {
      const r = await executor.runInternal('secret-sweep', () => engine.secrets.sweep());
      if (r.deleted.length + r.failed.length > 0) engine.log('info', 'secrets.swept', { deleted: r.deleted.length, kept: r.kept.length, failed: r.failed.length });
    } catch (err) {
      engine.log('warn', 'secrets.sweep_failed', { error: err instanceof Error ? err.name : 'unknown' });
    }
  }

  // ---------- 服务 ----------

  const service: EngineAppService = {
    engine,
    get executor() {
      return executor;
    },
    views,
    events: engine.events,

    async snapshot(_actor) {
      return views.snapshot(serviceVersion, deps.demo) satisfies Snapshot;
    },
    async listEnvironments(_actor) {
      return views.environmentViews();
    },
    async getEnvironment(id, _actor) {
      const v = typeof id === 'string' ? views.environmentView(id) : null;
      if (!v) throw new SfeError('NOT_FOUND', '读取环境失败：环境不存在');
      return v;
    },
    createEnvironment: (req, actor) => acceptCreate(acceptDeps, req, actor),
    updateEnvironment: (id, req, actor) => acceptUpdate(acceptDeps, id, req, actor),
    deleteEnvironment: (id, req, actor) => acceptDelete(acceptDeps, id, req, actor),
    async accountDetail(id, actor): Promise<AccountDetail> {
      requireWebOrAdmin(actor, '读取账号');
      const env = getEnvironment(engine, id, '读取账号');
      const acc = engine.repos.accounts.get(env.id);
      return { environment_id: env.id, label: acc?.label ?? null, loginIdentifier: acc?.loginIdentifier ?? null, hasPassword: Boolean(acc?.passwordRef) };
    },
    acknowledgeAccount: (id, req, actor) => acceptAcknowledgeAccount(acceptDeps, id, req, actor),
    unbind: (id, req, actor) => acceptUnbind(acceptDeps, id, req, actor),
    activate: (id, req, actor) => acceptActivate(acceptDeps, id, req, actor),
    enterNormal: (req, actor) => acceptNormal(acceptDeps, req, actor),
    probe: (id, req, actor) => acceptProbe(acceptDeps, id, req, actor),
    publishPending: (req, actor) => acceptPublishPending(acceptDeps, req, actor),
    async getOperation(id, _actor): Promise<OperationView> {
      const v = typeof id === 'string' ? views.operationView(id) : null;
      if (!v) throw new SfeError('NOT_FOUND', '读取操作失败：操作不存在');
      return v;
    },
    cancelOperation: (id, req, actor) => acceptCancel(acceptDeps, id, req, actor),
    async acknowledgeWindows(req, actor) {
      return (await acceptAcknowledgeWindows(acceptDeps, req, actor)).accepted;
    },
    async listOperations(limit, _actor) {
      const n = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 500) : 50;
      return views.operationViews(engine.repos.operations.listRecent(n));
    },
    importPreview: (req, actor): Promise<ImportPreview> => importPreview(acceptDeps, req, actor),
    importCommit: (req, actor): Promise<ImportCommitResult> => importCommit(acceptDeps, req, actor),
    importTemplateCsv: () => importTemplateCsv(),
    async listCapabilities(): Promise<CapabilityView[]> {
      return engine.capabilityViews();
    },
    proposeCapability: (req, actor) => proposeCapability(acceptDeps, req, actor),
    confirmCapability: (req, actor) => confirmCapability(acceptDeps, req, actor),
    async getSettings(): Promise<SettingsView> {
      return views.settingsView();
    },
    updateSettings: (req, actor) => updateSettings(acceptDeps, req, actor),
    async listFrontProxies() {
      return views.frontProxyViews();
    },
    registerFrontProxy: (req, actor) => registerFrontProxy(acceptDeps, req, actor),
    updateFrontProxy: (id, req, actor) => updateFrontProxy(acceptDeps, id, req, actor),
    verifyFrontProxy: (id, req, actor) => verifyFrontProxy(acceptDeps, id, req, actor),
    replaceFrontPreview: (id, req, actor) => replaceFrontPreview(acceptDeps, id, req, actor),
    replaceFrontCommit: (id, req, actor) => replaceFrontCommit(acceptDeps, id, req, actor),
    async surgePolicies(): Promise<SurgePolicyCandidates> {
      const p = await engine.surge.listPolicies();
      const groups = new Set(p.groups);
      return {
        proxies: p.proxies.filter((n) => !/^SFE-/i.test(n) && !BUILTIN_POLICIES.has(n.toUpperCase()) && !groups.has(n)),
        groups: p.groups.filter((n) => !/^SFE-/i.test(n)),
      };
    },
    async refreshSurge(_actor): Promise<SurgeStatusView> {
      await executor.runInternal('refresh', () => reconcile(engine, 'refresh'));
      return surgeStatus(engine);
    },
    initPreview: (req, actor) => initPreview(acceptDeps, req, actor),
    initCommit: (req, actor) => initCommit(acceptDeps, req, actor),
    remergePreview: (actor) => remergePreview(acceptDeps, actor),
    remergeCommit: (req, actor) => remergeCommit(acceptDeps, req, actor),
    async issueLoginCode(actor): Promise<LoginCodeResponse> {
      if (actor.kind !== 'admin') throw new SfeError('BAD_REQUEST', '签发登录链接失败：只能由维护通道签发');
      if (!deps.loginUrl) throw new SfeError('INTERNAL', '签发登录链接失败：网页服务尚未启动');
      return deps.loginUrl();
    },
    async handleNative(envelope): Promise<NativeResponse> {
      return handleNative({ ...acceptDeps, ensureInControl: (o) => ensureInControl(o) }, envelope);
    },
    async start() {
      if (!stopped) return;
      stopped = false;
      try {
        await engine.keys();
      } catch {
        engine.log('error', 'pepper.unavailable');
      }
      await sweepTempFiles(deps.paths.tmpDir).catch(() => []);
      // 上次进程在 --check 期间被终止时遗留的候选目录（含明文代理凭据的节点资源副本）：执行器开始之前删除
      try {
        const removed = await sweepCandidateDirs(deps.paths.tmpDir);
        if (removed.length > 0) engine.log('warn', 'startup.candidate_dirs_removed', { count: removed.length });
      } catch (err) {
        engine.log('error', 'startup.candidate_sweep_failed', { error: err instanceof Error ? err.name : 'unknown' });
      }
      // 上次进程在原子写入 Surge 配置目录中的文件期间被终止时遗留的临时文件（节点资源的含明文买家凭据，工作配置的含用户自己
      // 节点的凭据）：执行器开始之前删除（surge/files.ts sweepProfileTempFiles）
      const wp = engine.workingProfile();
      if (wp) {
        try {
          const removed = await sweepProfileTempFiles(wp.directory, [NODE_RESOURCE_FILE, ...Object.values(ENTRY_RULESET_FILES), basename(wp.path), `${WORKING_PROFILE_NAME}.conf`]);
          if (removed.length > 0) engine.log('warn', 'startup.profile_temp_files_removed', { count: removed.length });
        } catch (err) {
          engine.log('error', 'startup.profile_temp_sweep_failed', { error: err instanceof Error ? err.name : 'unknown' });
        }
      }
      await engine.refreshHostFacts();
      // 启动：放回上次未完成的领取，读 Surge 事实对账，再开始执行器（未完成操作由执行器按事实恢复）
      const released = engine.repos.outbox.releaseClaims(engine.now());
      if (released > 0) engine.log('warn', 'startup.released_claims', { count: released });
      failOrphanedOperations(engine);
      // 节点资源文件未结算的归属（之前的版本在发布回滚的读回失败时留下未确认的意图与写前摘要 mo_prev；其中的内容可能含之后已
      // 退役、凭据已清扫的版本的节点行）：按事实确认或清除，只保留当前文件内容的摘要（ownership.ts settleResourceDigests；与
      // 崩溃恢复 recoverPublish 对写前或写后内容的确认相同）
      const resourceFiles = engine.profileFiles();
      if (resourceFiles && resourceOwnershipUnsettled(engine.repos, engine.kv)) {
        try {
          settleResourceDigests(engine.repos, engine.kv, await resourceFiles.digest(NODE_RESOURCE_FILE));
        } catch (err) {
          engine.log('warn', 'startup.resource_ownership_unsettled', { error: err instanceof Error ? err.name : 'unknown' });
        }
      }
      try {
        await reconcile(engine, 'startup');
      } catch (err) {
        engine.log('warn', 'startup.reconcile_failed', { error: err instanceof Error ? err.name : 'unknown' });
      }
      executor.start();
      void runSweep();
      scheduleReconcile();
      scheduleSweep();
    },
    async stop() {
      stopped = true;
      reconcileTimer?.();
      sweepTimer?.();
      reconcileTimer = null;
      sweepTimer = null;
      await executor.stop();
    },
    idle: () => executor.idle(),
    runPeriodicReconcile,
    ensureInControl,
  };
  return service;
}
