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
  segmentsChanged: boolean;
  frontsMissing: Set<string>;
  frontsPresent: Set<string>;
}

async function readExtraFacts(engine: Engine): Promise<ExtraFacts> {
  const { repos } = engine;
  const out: ExtraFacts = { selection: undefined, entryMode: null, precedenceBlocking: false, segmentsChanged: false, frontsMissing: new Set(), frontsPresent: new Set() };
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
  // 受管理段与本应用文件（以 managed_objects 为准）
  const wp = engine.workingProfile();
  const files = engine.profileFiles();
  if (wp && files) {
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
    out.segmentsChanged = changed;
    engine.facts.managedSectionsIntact = !changed;
  }
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
  }

  if (expireActive && before.activeEnvironmentId) {
    if (expireSafariProbe(engine, before.activeEnvironmentId)) add('probe_expired');
  }
  const changed = added.length > 0 || phase !== before.phase || entryMode !== before.entryMode || frontChanges.length > 0;
  repos.tx(() => {
    repos.routeState.update({
      warnings: [...warnings],
      phase,
      entryMode,
      lastReconciledAt: now,
      surgeStartedAt: facts.startedAt ?? before.surgeStartedAt,
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
        payload: { trigger: kind, added: [...added] },
      });
      repos.operations.appendStep(op.id, 'COMPLETED', notes.length > 0 ? `对账发现变化：${notes.join('；')}` : '对账更新了路由状态');
      engine.emit({ operations: [op.id] });
    }
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
