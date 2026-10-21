// 对账（docs/ARCHITECTURE.md §6.6）：只读 Surge 事实，按规则设置路由警告与阶段；从不写 Surge、从不抢回控制。
// 失控类警告是粘性的：恢复需要用户显式激活或进入普通模式。只有改变了路由状态或警告时才记录一条
// maintenance.reconcile 操作，避免周期任务刷屏。启动恢复在这里整理未完成的意图行与操作。

import { readFile } from 'node:fs/promises';
import { NODE_RESOURCE_FILE, ROUTE_GROUP_NAME, type EntryMode, type RoutePhase, type RouteWarning } from '@sfe/contract';
import type { RouteStateRecord } from '../db/index.js';
import { ATTENTION_WARNINGS, evaluateControl, type ControlEvaluation } from '../domain/route-rules.js';
import { buildSurgeStatus } from '../domain/views.js';
import { entryBlockIsFirstRule, parseProfile } from '../surge/profile.js';
import type { Engine } from './context.js';
import { checkSegments } from './ownership.js';
import { expireSafariProbe } from './handlers/probes.js';

export type ReconcileKind = 'startup' | 'periodic' | 'refresh' | 'precheck';

export interface ReconcileResult {
  changed: boolean;
  route: RouteStateRecord;
  /** 本次新增的警告。 */
  added: RouteWarning[];
}

const IN_PROGRESS: readonly RoutePhase[] = ['switching', 'rolling_back'];

interface ExtraFacts {
  selection: string | null | undefined;
  entryMode: EntryMode | null;
  precedenceBlocking: boolean;
  /** null：未初始化或无法判断。 */
  segmentsChanged: boolean | null;
  frontsMissing: Set<string>;
  frontsPresent: Set<string>;
}

/**
 * 受管理段或本应用文件（以 managed_objects 为准）是否被外部修改；未初始化或 pepper 未加载时为 null。
 * 对账与撤销本应用入口的路由操作（普通模式、回滚）共用：后者会改写被修改的入口文件，但保留警告
 * （空闲且入口为 NORMAL 时，对账在检查不再成立后清除它）。
 */
export async function managedSegmentsChanged(engine: Engine): Promise<boolean | null> {
  const { repos } = engine;
  const wp = engine.workingProfile();
  const files = engine.profileFiles();
  if (!wp || !files) return null;
  let changed = false;
  try {
    const text = await readFile(wp.path, 'utf8');
    const parsed = parseProfile(text);
    const segs = checkSegments(repos, parsed, files.digestContent);
    if (segs.some((s) => s.state !== 'ok')) changed = true;
    if (repos.settings.get('entryStrategy') === 'ruleset_resource' && repos.managedObjects.get('entry_segment', 'entry') && !entryBlockIsFirstRule(parsed)) changed = true;
  } catch {
    changed = true;
  }
  const rec = repos.managedObjects.get('resource_file', NODE_RESOURCE_FILE);
  if (rec && rec.state === 'present') {
    const d = await files.digest(NODE_RESOURCE_FILE).catch(() => null);
    if (d !== rec.contentDigest) changed = true;
  }
  for (const r of repos.managedObjects.listByKind('entry_ruleset_file')) {
    if (r.state !== 'present') continue;
    const d = await files.digest(r.identity).catch(() => null);
    if (d !== r.contentDigest) changed = true;
  }
  return changed;
}

async function readExtraFacts(engine: Engine): Promise<ExtraFacts> {
  const { repos } = engine;
  const out: ExtraFacts = { selection: undefined, entryMode: null, precedenceBlocking: false, segmentsChanged: null, frontsMissing: new Set(), frontsPresent: new Set() };
  try {
    out.selection = await engine.surge.getGroupSelection(ROUTE_GROUP_NAME);
  } catch {
    out.selection = undefined;
  }
  const ctrl = engine.entryController(() => null);
  if (ctrl) {
    try {
      const rb = await ctrl.read();
      out.entryMode = rb.mode;
      out.precedenceBlocking = rb.precedenceIssues.some((i) => i.severity === 'blocking');
      engine.facts.precedenceIssues = rb.precedenceIssues;
    } catch {
      out.entryMode = 'UNKNOWN';
    }
  }
  const changed = await managedSegmentsChanged(engine);
  out.segmentsChanged = changed;
  if (changed !== null) engine.facts.managedSectionsIntact = !changed;
  // 已登记前置是否仍存在
  try {
    const policies = await engine.surge.listPolicies();
    const proxies = new Set(policies.proxies);
    for (const f of repos.frontProxies.list({ includeRetired: false })) {
      if (proxies.has(f.surgeName) && !policies.groups.includes(f.surgeName)) out.frontsPresent.add(f.id);
      else out.frontsMissing.add(f.id);
    }
  } catch {
    // 读不到策略列表：不改变前置状态
  }
  return out;
}

export async function reconcile(engine: Engine, kind: ReconcileKind): Promise<ReconcileResult> {
  const { repos } = engine;
  const facts = await engine.readBasicFacts();
  const before = repos.routeState.get();
  const managed = before.phase !== 'idle' || before.entryMode !== 'NORMAL';
  const extra = facts.reachable ? await readExtraFacts(engine) : null;
  const now = engine.nowIso();

  const warnings = new Set<RouteWarning>(before.warnings);
  const added: RouteWarning[] = [];
  const removed: RouteWarning[] = [];
  const add = (w: RouteWarning) => {
    if (!warnings.has(w)) {
      warnings.add(w);
      added.push(w);
    }
  };
  let phase: RoutePhase = before.phase;
  let entryMode: EntryMode = before.entryMode;
  let expireActive = false;
  const notes: string[] = [];

  // 前置状态（数据）：消失 → missing；重新出现 → ok
  const frontChanges: Array<{ id: string; state: 'ok' | 'missing' }> = [];
  if (extra) {
    for (const f of repos.frontProxies.list({ includeRetired: false })) {
      if (extra.frontsMissing.has(f.id) && f.state !== 'missing') frontChanges.push({ id: f.id, state: 'missing' });
      if (extra.frontsPresent.has(f.id) && f.state === 'missing') frontChanges.push({ id: f.id, state: 'ok' });
    }
  }

  if (managed) {
    // 切换或回滚中断：没有进行中的操作负责当前的过渡阶段（例如崩溃恢复失败）。入口按读回记录（不一致为 UNKNOWN），
    // 要求处理；从不写 Surge，恢复需要用户显式激活或进入普通模式。
    if (IN_PROGRESS.includes(before.phase)) {
      const owner = before.operationId ? repos.operations.get(before.operationId) : null;
      if (!owner || (owner.status !== 'running' && owner.status !== 'queued')) {
        add('entry_unverified');
        phase = 'attention';
        if (!extra || extra.entryMode !== before.entryMode) entryMode = 'UNKNOWN';
        expireActive = true;
        notes.push('切换或回滚已中断：没有进行中的操作负责当前路由状态');
      }
    }
    if (!facts.reachable) {
      add('surge_unreachable');
      notes.push('无法连接 Surge');
    } else {
      if (facts.startedAt && before.surgeStartedAt && facts.startedAt !== before.surgeStartedAt) {
        add('surge_restarted');
        expireActive = true;
        notes.push('Surge 已重启');
      }
      if (facts.onWorkingProfile === false) {
        add('external_profile_change');
        notes.push('Surge 当前配置不是固定工作配置');
      }
      if (extra) {
        if (extra.selection !== undefined && before.selectedNode !== null && extra.selection !== before.selectedNode && !IN_PROGRESS.includes(before.phase)) {
          add('external_selection_change');
          notes.push('SFE-ROUTE 的选择被外部修改');
        }
        if (extra.segmentsChanged) {
          add('managed_segments_changed');
          notes.push('受管理段或本应用文件被修改');
        }
        if (extra.entryMode !== null && before.entryMode !== 'UNKNOWN' && extra.entryMode !== before.entryMode && !IN_PROGRESS.includes(before.phase)) {
          add('entry_unverified');
          entryMode = 'UNKNOWN';
          expireActive = true;
          notes.push(`入口读回与记录不一致（记录 ${before.entryMode}，读回 ${extra.entryMode}）`);
        }
        if (extra.precedenceBlocking) {
          add('precedence_violation');
          notes.push('有规则排在本应用入口之前');
        }
        const route = before;
        if (route.activeEnvironmentId && route.activeProxyRevision !== null) {
          const rev = repos.proxyRevisions.get(route.activeEnvironmentId, route.activeProxyRevision);
          if (rev && extra.frontsMissing.has(rev.frontProxyId)) {
            add('front_missing');
            expireActive = true;
            notes.push('使用中环境的前置节点已不在 Surge 中');
          }
        }
      }
      const t = facts.takeover;
      if (t.enhancedMode === false && t.systemProxy === false) {
        add('takeover_lost');
        notes.push('Surge 增强模式与系统代理都已关闭');
      }
      if (t.outboundMode !== null && t.outboundMode !== 'rule') {
        add('outbound_mode_changed');
        notes.push('Surge 出站模式不是规则模式');
      }
      if (t.enhancedMode === null && t.systemProxy === null) {
        // 不阻断，但要求一次新的 Safari 实测
        if (!warnings.has('takeover_unknown')) expireActive = true;
        add('takeover_unknown');
      }
      // 版本或进程路径变化让激活能力过期
      if (before.entryMode !== 'NORMAL' && engine.activationMissing().length > 0) {
        add('entry_unverified');
        notes.push('激活所需能力已过期或不再满足');
      }
      const paths = repos.settings.get('safariProcessPaths');
      if (paths.length > 0 && paths.some((p) => !engine.host.processPathExists(p))) {
        add('entry_unverified');
        notes.push('Safari 进程路径不存在');
      }
    }
    // 实测有效期
    if (before.activeEnvironmentId) {
      const probe = repos.probes.latest(before.activeEnvironmentId, 'safari');
      if (probe && Date.parse(probe.expiresAt) <= engine.now().getTime() && before.phase === 'active_verified') add('probe_expired');
    }
    if (added.some((w) => ATTENTION_WARNINGS.includes(w))) phase = 'attention';
    else if (added.some((w) => w === 'external_selection_change' || w === 'external_profile_change') && phase !== 'attention') phase = 'external_change';
  } else if (extra && extra.segmentsChanged === false && warnings.has('managed_segments_changed')) {
    // 空闲且入口为 NORMAL：撤销入口时保留的 managed_segments_changed 在受管理段与本应用文件重新一致后清除
    // （例如普通模式已改写入口文件、maintenance.remerge 已恢复受管理段）；托管状态下它是粘性的，由下一次激活清除。
    warnings.delete('managed_segments_changed');
    removed.push('managed_segments_changed');
    notes.push('受管理段与本应用文件已恢复一致');
  }

  if (expireActive && before.activeEnvironmentId) {
    if (expireSafariProbe(engine, before.activeEnvironmentId)) add('probe_expired');
  }
  // 读取事实期间，受理与原生桥处理器可能已在执行器之外改过路由警告（预期出口重新比较、确认窗口已关闭）：
  // 在提交事务中重读路由，只合并本次新增的警告；阶段与入口（以及空闲时的清除）只在它们仍是读取开始时的值时才改。
  const changed = repos.tx(() => {
    const fresh = repos.routeState.get();
    const sameState = fresh.phase === before.phase && fresh.entryMode === before.entryMode;
    const nextPhase = sameState ? phase : fresh.phase;
    const nextEntryMode = sameState ? entryMode : fresh.entryMode;
    const dropped = sameState ? removed.filter((w) => fresh.warnings.includes(w)) : [];
    const changed = added.length > 0 || dropped.length > 0 || nextPhase !== fresh.phase || nextEntryMode !== fresh.entryMode || frontChanges.length > 0;
    repos.routeState.update({
      warnings: [...new Set<RouteWarning>([...fresh.warnings.filter((w) => !dropped.includes(w)), ...added])],
      phase: nextPhase,
      entryMode: nextEntryMode,
      lastReconciledAt: now,
      surgeStartedAt: facts.startedAt ?? fresh.surgeStartedAt,
    });
    for (const fc of frontChanges) repos.frontProxies.update(fc.id, { state: fc.state, lastCheckedAt: now });
    if (changed) {
      const op = repos.operations.insert({
        id: engine.ids.next('op'),
        requestId: `reconcile:${engine.ids.token(16)}`,
        requestDigest: 'service',
        kind: 'maintenance.reconcile',
        initiatorKind: 'service',
        phase: 'COMPLETED',
        status: 'succeeded',
        routeEpoch: before.routeEpoch,
        payload: { trigger: kind, added: [...added], ...(dropped.length > 0 ? { removed: dropped } : {}) },
      });
      repos.operations.appendStep(op.id, 'COMPLETED', notes.length > 0 ? `对账发现变化：${notes.join('；')}` : '对账更新了路由状态');
      engine.emit({ operations: [op.id] });
    }
    return changed;
  });
  const route = repos.routeState.get();
  const envs = before.activeEnvironmentId ? [before.activeEnvironmentId] : [];
  engine.emit({ route: changed, surge: true, environments: changed ? envs : [], fronts: frontChanges.length > 0 });
  if (changed) engine.log('info', 'reconcile.changed', { trigger: kind, added });
  return { changed, route, added };
}

export function surgeStatus(engine: Engine) {
  return buildSurgeStatus(engine.facts, engine.repos.meta.configurationGeneration());
}

/** “受控”判定（复用、填充、自动打开订单共用）：先做一次对账，再按状态判定。 */
export function controlAfterReconcile(engine: Engine): ControlEvaluation {
  const route = engine.repos.routeState.get();
  const probe = route.activeEnvironmentId ? engine.repos.probes.latest(route.activeEnvironmentId, 'safari') : null;
  if (!engine.facts.reachable) return { ok: false, reason: '无法连接 Surge' };
  if (engine.facts.onWorkingProfile !== true) return { ok: false, reason: 'Surge 当前配置不是固定工作配置' };
  return evaluateControl(route, probe, engine.now());
}
