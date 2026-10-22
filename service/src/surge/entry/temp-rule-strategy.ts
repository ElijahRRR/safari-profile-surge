// temp_rule 入口策略：五种条件互不相交的临时规则（generate.ts tempRuleText），按本应用记录的精确文本逐条增删，从不 flush。
// 文档：“rule temp add <rule> Add a temporary rule with the highest priority”（新规则排在最前；多条临时规则之间的顺序
// 没有写入文档）、“rule temp remove <rule> Remove one temporary rule by its exact text”、“Temporary rules take effect
// immediately, precede all profile rules, and are discarded when Surge stops.”（Mac 6.9.0+，协议 ≥20）。
// 四种模式各自的规则集合中，相交的规则策略相同，所以模式只取决于存在哪些规则；切换按集合规划（planTempKinds），
// 每步之后不论新规则排在哪里都只会是允许的模式（没有放行窗口）。中断的切换留下的集合没有这样的计划时，按实际先后与
// 插入位置模拟（planTempKindsByInsertion）。每步写入后用临时规则列表、有效规则顺序与 `rule match` 探测读回
// （Safari 每个进程路径 × 检测主机/其他主机 × TCP/UDP，对照进程不得命中本应用规则）。
// 同文的临时规则已存在但无本应用记录时停止（NAME_COLLISION），不收编。
// 撤销本应用入口（普通模式、回滚）遇到重复、旧文本（进程路径或检测主机变化后、或旧版本按顺序设计的 verify/active）、
// 无法识别或不在有效规则中的本应用记录时，逐条清理本应用记录的规则，只走从不放宽的步骤（cleanupForUndo）。
// 见 docs/ARCHITECTURE.md §5.5。

import { ENTRY_MODE_BITS, SfeError, type EntryBits, type KnownEntryMode, type PrecedenceIssue } from '@sfe/contract';
import type { EntryCleanupStep, EntryController, EntryReadback, EntryStep, SurgeRuleRecord } from '../../ports.js';
import {
  ENTRY_BIT_POLICY,
  TEMP_ENTRY_KINDS,
  TEMP_ENTRY_KIND_POLICY,
  TEMP_ENTRY_MODE_KINDS,
  entryBitOfTempKind,
  tempRuleText,
  type TempEntryKind,
} from '../generate.js';
import { classifyPrecedence, classifyPrecedenceAt, hasBlockingIssue, type PrecedenceContext } from '../precedence.js';
import { REJECT_POLICIES, normalizeRuleText, parseRule, type RuleCondition } from '../rules.js';
import {
  TEMP_KIND_COVER,
  allowedModes,
  firstKindFor,
  judgeProbes,
  modeOfSemantic,
  policyFits,
  probeReadFailure,
  runProbes,
  runtimeProbes,
  sameRuleText,
  semanticOfKinds,
  stepFailure,
  withLastConfirmed,
  type EntryClass,
  type EntryConfig,
  type EntryStrategyDeps,
  type ProbeIdentity,
  type ProbeJudgement,
} from './common.js';
import type { EntryOwnedRecord } from './ownership.js';
import { planTempKinds, planTempKindsByInsertion, predictableTempPlan, type TempKindStep } from './plan.js';

export type TempRuleInsertion = 'head' | 'tail';

export interface TempRuleStrategyDeps extends EntryStrategyDeps {
  /**
   * P0 实测的新临时规则插入位置（文档的 “highest priority” 指向 head，但多条临时规则之间的顺序没有写入文档）。
   * 只影响两件事：中断的切换留下的集合没有与先后无关的计划时的退路，以及其他规则位置的预测；未知时两种位置都要安全。
   */
  insertion?: TempRuleInsertion;
}

function isProcessExpr(c: RuleCondition): boolean {
  if (c.type === 'PROCESS-NAME') return true;
  return c.type === 'OR' && (c.operands ?? []).length > 0 && c.operands!.every((o) => o.type === 'PROCESS-NAME');
}

function isNotOf(c: RuleCondition, type: string, value?: string): boolean {
  const o = c.type === 'NOT' ? c.operands?.[0] : undefined;
  return o !== undefined && o.type === type && (value === undefined || o.value?.toUpperCase() === value);
}

/** 结构识别的结果：legacy 为旧版本（按顺序设计）的 verify/active 文本——verify 不排除 UDP，active 匹配 Safari 全部流量。 */
export interface EntryTempRuleClass {
  kind: TempEntryKind;
  legacy: boolean;
}

/** 按结构识别本应用记录的临时规则属于哪一种（配置中的进程路径或检测主机可能已变化）；都不是时为 null。 */
export function classifyEntryTempRule(text: string): EntryTempRuleClass | null {
  const r = parseRule(text);
  if (!r) return null;
  const policy = r.policy ?? '';
  const c = r.condition;
  if (isProcessExpr(c)) {
    if (policy === TEMP_ENTRY_KIND_POLICY.block) return { kind: 'block', legacy: false };
    if (policy === TEMP_ENTRY_KIND_POLICY.active) return { kind: 'active', legacy: true };
    return null;
  }
  if (c.type !== 'AND' || !c.operands || c.operands.length < 2 || !isProcessExpr(c.operands[0]!)) return null;
  const [, a, b] = c.operands;
  const n = c.operands.length;
  if (n === 2 && a!.type === 'PROTOCOL' && a!.value?.toUpperCase() === 'UDP' && policy === TEMP_ENTRY_KIND_POLICY.udp) return { kind: 'udp', legacy: false };
  if (n === 2 && a!.type === 'DOMAIN' && policy === ENTRY_BIT_POLICY.verify) return { kind: 'verify', legacy: true };
  if (!isNotOf(a!, 'PROTOCOL', 'UDP')) return null;
  if (n === 2 && policy === TEMP_ENTRY_KIND_POLICY.active) return { kind: 'active', legacy: false };
  if (n === 3 && b!.type === 'DOMAIN' && policy === TEMP_ENTRY_KIND_POLICY.verify) return { kind: 'verify', legacy: false };
  if (n === 3 && isNotOf(b!, 'DOMAIN') && policy === TEMP_ENTRY_KIND_POLICY.blockOther) return { kind: 'blockOther', legacy: false };
  return null;
}

/** 本应用记录的临时规则属于哪一种：先按当前配置的期望文本（exact），再按结构识别；都不是时为 null。 */
function kindOfRecord(identity: string, expected: Record<TempEntryKind, string>): { kind: TempEntryKind; exact: boolean; legacy: boolean } | null {
  const n = normalizeRuleText(identity);
  const exact = TEMP_ENTRY_KINDS.find((k) => normalizeRuleText(expected[k]) === n);
  if (exact) return { kind: exact, exact: true, legacy: false };
  const c = classifyEntryTempRule(identity);
  return c ? { kind: c.kind, exact: false, legacy: c.legacy } : null;
}

/**
 * 让入口状态无法按种类确定的异常：只有撤销本应用入口时才逐条清理（cleanupForUndo），其他切换一律拒绝。
 * stale：结构是当前格式、文本却不是当前配置的期望文本（进程路径或检测主机变化后）；legacy：旧版本按顺序设计的文本。
 */
function isAmbiguous(anomalies: readonly string[]): boolean {
  return anomalies.some(
    (a) => a.startsWith('duplicate_') || a.startsWith('stale_') || a.startsWith('legacy_') || a === 'unrecognized_record' || a === 'not_in_effective_rules',
  );
}

type CleanupKind = TempEntryKind | 'unrecognized';

/** 策略为 REJECT 的种类：加入它们不会让任何流量新经 SFE-ROUTE 发出。 */
const REJECT_KINDS: ReadonlySet<TempEntryKind> = new Set(TEMP_ENTRY_KINDS.filter((k) => REJECT_POLICIES.has(TEMP_ENTRY_KIND_POLICY[k].toUpperCase())));

/**
 * 撤销清理的移除次序（小的先移除）：先移除会路由的规则（active、verify，含旧版本文本），再移除策略不是 REJECT 类的
 * 无法识别规则（可能路由），之后是 udp、blockOther，然后是策略为 REJECT 类的无法识别规则（结构未知不等于会路由：保留到
 * 所有可能路由的规则移除之后），最后是 block（其他 block 文本在前，当前期望的 block 文本最后）。
 * 移除一条规则只会让它匹配的流量落到后面的规则：路由规则先走，之后移除的 REJECT 规则后面就不再有本应用的路由规则，
 * 原来被拒绝的流量不会因此经 SFE-ROUTE 发出。
 */
function cleanupRank(kind: CleanupKind, rejectPolicy: boolean, isExpectedBlock: boolean): number {
  switch (kind) {
    case 'active':
      return 0;
    case 'verify':
      return 1;
    case 'unrecognized':
      return rejectPolicy ? 5 : 2;
    case 'udp':
      return 3;
    case 'blockOther':
      return 4;
    case 'block':
      return isExpectedBlock ? 7 : 6;
  }
}

/** 撤销清理的一步（opts.onCleanup、最终读回证据与错误 details.undoCleanup）。 */
type CleanupEntry = EntryCleanupStep;

interface CleanupItem {
  kind: CleanupKind;
  /** 临时规则列表中的原文（删除时用 Surge 列出的文本）。 */
  text: string;
  textN: string;
  /** 归一化后同文的全部本应用记录。 */
  identities: string[];
}

function cleanupKindLabel(kind: CleanupKind): EntryCleanupStep['kind'] {
  return kind === 'unrecognized' ? 'unrecognized' : entryBitOfTempKind(kind);
}

/** 撤销清理中的错误不声称任何已确认状态；清理之后常规步骤的错误保留它们自己的最后确认状态。都附上已做的清理步骤。 */
function withCleanupTrail(e: unknown, trail: readonly CleanupEntry[]): SfeError {
  const base = e instanceof SfeError && e.details !== undefined && 'lastConfirmedBits' in e.details ? e : withLastConfirmed(e, null, null);
  return new SfeError(base.code, base.message, {
    fieldErrors: base.fieldErrors,
    details: { ...(base.details ?? {}), undoCleanup: trail.map((t) => ({ ...t })) },
    cause: base,
  });
}

function cleanupEvidence(trail: readonly CleanupEntry[]): string {
  const label = (k: EntryCleanupStep['kind']): string => (k === 'unrecognized' ? '无法识别' : k);
  return `撤销入口时逐条清理了本应用的临时规则：${trail.map((t) => `${t.action === 'add' ? '加入' : '移除'} ${label(t.kind)}「${t.rule}」`).join('；')}`;
}

/** 写入之前预测的一次写入：加入或移除一整条临时规则（按文本）。 */
interface RuleWrite {
  add: boolean;
  text: string;
}

/** 预测中的一条有效规则；orig 是它在读到的有效规则中的位置（本次计划加入的规则为 -1）。 */
interface PredictedRule {
  rule: SurgeRuleRecord;
  orig: number;
}

interface TempState {
  cfg: EntryConfig;
  expected: Record<TempEntryKind, string>;
  records: EntryOwnedRecord[];
  /** 临时规则列表原文。 */
  temps: string[];
  tempsN: Set<string>;
  rules: SurgeRuleRecord[];
  /** 文本等于当前期望文本、已记录且出现在临时规则列表中的种类。 */
  presentText: Partial<Record<TempEntryKind, string>>;
  /** 这些种类在有效规则中的先后；有规则不在有效规则中时为 null。 */
  order: TempEntryKind[] | null;
  /** 期望文本已存在于临时规则但没有本应用记录。 */
  foreign: TempEntryKind[];
  anomalies: string[];
  ourTextsN: Set<string>;
}

function presentKinds(s: TempState): TempEntryKind[] {
  return TEMP_ENTRY_KINDS.filter((k) => s.presentText[k] !== undefined);
}

function sameKinds(a: readonly TempEntryKind[], b: readonly TempEntryKind[]): boolean {
  return a.length === b.length && a.every((k) => b.includes(k));
}

/** 规范集合对应的模式（与先后无关）；不是四种模式之一的规范集合时为 null。 */
function canonicalModeOf(kinds: readonly TempEntryKind[]): KnownEntryMode | null {
  return (Object.keys(TEMP_ENTRY_MODE_KINDS) as KnownEntryMode[]).find((m) => sameKinds(TEMP_ENTRY_MODE_KINDS[m], kinds)) ?? null;
}

function semanticMode(order: readonly TempEntryKind[] | null): KnownEntryMode | null {
  return order === null ? null : modeOfSemantic(semanticOfKinds(order));
}

export function createTempRuleStrategy(deps: TempRuleStrategyDeps): EntryController {
  async function load(): Promise<TempState> {
    const cfg = deps.config();
    const expected = Object.fromEntries(TEMP_ENTRY_KINDS.map((k) => [k, tempRuleText(k, cfg)])) as Record<TempEntryKind, string>;
    const records = await deps.ownership.getRecordedTempRules();
    const temps = await deps.adapter.listTempRules();
    const rules = await deps.adapter.listRules();
    const tempsN = new Set(temps.map(normalizeRuleText));
    const anomalies: string[] = [];
    const presentText: Partial<Record<TempEntryKind, string>> = {};
    const presentCount = new Map<TempEntryKind, number>();
    const ourTextsN = new Set<string>();
    for (const rec of records) {
      const n = normalizeRuleText(rec.identity);
      ourTextsN.add(n);
      const k = kindOfRecord(rec.identity, expected);
      if (!k) {
        anomalies.push('unrecognized_record');
        continue;
      }
      const inList = tempsN.has(n);
      if (rec.state === 'pending_add' || rec.state === 'pending_remove') anomalies.push(`pending_${k.kind}`);
      if (rec.state === 'present' && !inList) anomalies.push(`missing_${k.kind}`);
      if (!inList) continue;
      presentCount.set(k.kind, (presentCount.get(k.kind) ?? 0) + 1);
      if (presentCount.get(k.kind)! > 1) anomalies.push(`duplicate_${k.kind}`);
      if (k.exact) presentText[k.kind] = rec.identity;
      else anomalies.push(`${k.legacy ? 'legacy' : 'stale'}_${k.kind}`);
    }
    const foreign = TEMP_ENTRY_KINDS.filter((k) => {
      const n = normalizeRuleText(expected[k]);
      return tempsN.has(n) && !records.some((r) => normalizeRuleText(r.identity) === n);
    });
    for (const k of foreign) anomalies.push(`foreign_${k}`);
    const positions = TEMP_ENTRY_KINDS.filter((k) => presentText[k] !== undefined).map((k) => {
      const n = normalizeRuleText(presentText[k]!);
      return { k, i: rules.findIndex((r) => normalizeRuleText(r.text) === n) };
    });
    const order = positions.some((p) => p.i < 0) ? null : positions.sort((x, y) => x.i - y.i).map((p) => p.k);
    if (order === null) anomalies.push('not_in_effective_rules');
    return { cfg, expected, records, temps, tempsN, rules, presentText, order, foreign, anomalies, ourTextsN };
  }

  /** 当前期望文本能证明覆盖的 Safari 流量类别（只认当前配置的文本；旧文本与无法识别的为 null）。 */
  function coverageOf(s: TempState): (r: SurgeRuleRecord) => readonly EntryClass[] | null {
    return (r) => {
      const n = normalizeRuleText(r.text);
      const k = TEMP_ENTRY_KINDS.find((kind) => normalizeRuleText(s.expected[kind]) === n);
      return k ? TEMP_KIND_COVER[k].classes : null;
    };
  }

  function precedenceContext(s: TempState, ourTextsN: ReadonlySet<string>): PrecedenceContext {
    return {
      isOurRule: (r) => ourTextsN.has(normalizeRuleText(r.text)),
      processPaths: s.cfg.processPaths,
      siteHosts: s.cfg.siteHosts,
      verifyHost: s.cfg.verifyHost,
      coverageOf: coverageOf(s),
    };
  }

  function precedenceOf(s: TempState): PrecedenceIssue[] {
    return classifyPrecedence(s.rules, precedenceContext(s, s.ourTextsN));
  }

  /** 只看临时规则与有效顺序（不看优先级与探测）得到的模式：没有异常、集合是某个模式的规范集合。 */
  function baseModeOf(s: TempState): EntryReadback['mode'] {
    const kinds = presentKinds(s);
    const canonical = canonicalModeOf(kinds);
    return s.anomalies.length === 0 && canonical !== null && semanticMode(s.order) === canonical ? canonical : 'UNKNOWN';
  }

  /** rule match 回显的规则是本应用的哪一种（只认存在的当前文本；其他本应用记录的文本记为 recorded）。 */
  function identify(s: TempState): (rule: string, policy: string) => ProbeIdentity | null {
    return (rule, policy) => {
      for (const k of TEMP_ENTRY_KINDS) {
        const text = s.presentText[k];
        if (text === undefined || !sameRuleText(rule, text)) continue;
        const outcome = TEMP_KIND_COVER[k].outcome;
        return policyFits(outcome, policy) ? { id: k, outcome } : { id: `${k}（最终策略 ${policy}）`, outcome };
      }
      for (const rec of s.records) {
        if (sameRuleText(rule, rec.identity)) return { id: 'recorded', outcome: 'pass' };
      }
      return null;
    };
  }

  /**
   * 运行时探测（rule match）：没有任何本应用规则在临时规则列表中时不需要（NORMAL 不可能命中本应用规则），返回 null；
   * 状态有歧义时预期无法确定，也返回 null（读回照样是 UNKNOWN）。读取失败按不一致处理（失败即关闭，readFailed）。
   */
  async function observe(s: TempState, issues: readonly PrecedenceIssue[]): Promise<ProbeJudgement | null> {
    if (s.order === null || s.order.length === 0 || isAmbiguous(s.anomalies)) return null;
    const order = s.order;
    try {
      const results = await runProbes(deps.adapter, runtimeProbes(s.cfg), identify(s));
      return judgeProbes(results, (cls) => [firstKindFor(order, cls)], issues);
    } catch (e) {
      return probeReadFailure(e);
    }
  }

  /**
   * 读回。tolerateReadFailure（只用于撤销本应用入口的最终读回）：rule match 读不到时不把结构读回改为 UNKNOWN，
   * 按临时规则列表与有效规则顺序报告，标为未经运行时确认（runtimeConfirmed: false）——与 rule match 之前的结构读回相同；
   * 求值读到了却不一致、对照进程命中时照常为 UNKNOWN。
   */
  function readbackOf(s: TempState, judgement: ProbeJudgement | null, tolerateReadFailure = false): EntryReadback {
    const issues = precedenceOf(s);
    const kinds = presentKinds(s);
    const sem = semanticMode(s.order);
    const evidence = [
      `临时规则：${kinds.join('、') || '无'}`,
      `有效规则顺序：${s.order ? s.order.join(' > ') || '无' : '无法确定'}`,
      ...s.anomalies.map((a) => `异常：${a}`),
      ...(judgement?.evidence ?? []),
    ];
    let mode = baseModeOf(s);
    let runtimeConfirmed = true;
    if (mode === 'UNKNOWN' && s.anomalies.length === 0 && sem !== null) evidence.push(`本应用规则的实际效果为 ${sem}，但规则集合不是该模式的规范集合（切换未完成）`);
    if (mode !== 'UNKNOWN' && judgement !== null && !judgement.ok) {
      if (tolerateReadFailure && judgement.readFailed === true && (mode === 'BLOCKED' || mode === 'NORMAL')) {
        runtimeConfirmed = false;
        evidence.push('撤销入口：rule match 读不到，按临时规则列表与有效规则顺序读回，未经运行时求值确认');
      } else {
        mode = 'UNKNOWN';
        evidence.push(judgement.readFailed === true ? '运行时规则求值读不到' : '运行时规则求值与本应用规则不一致');
      }
    }
    if (mode !== 'NORMAL' && mode !== 'UNKNOWN' && hasBlockingIssue(issues)) {
      mode = 'UNKNOWN';
      evidence.push('有规则排在入口之前');
    }
    const bits = isAmbiguous(s.anomalies) || sem === null ? null : { ...ENTRY_MODE_BITS[sem] };
    return { mode, bits, evidence, precedenceIssues: issues, ...(runtimeConfirmed ? {} : { runtimeConfirmed: false }) };
  }

  async function readback(s: TempState): Promise<EntryReadback> {
    return readbackOf(s, await observe(s, precedenceOf(s)));
  }

  /**
   * 按插入位置预测一串写入之后每一步的有效规则（含其他规则的位置）：新的临时规则排在有效规则中已有临时规则之首（head）
   * 或之尾（tail：排在已有的用户临时规则之后）；有效规则中还没有临时规则时排在第一条非模块规则之前（文档：临时规则
   * “precede all profile rules”）。移除按归一化文本。
   */
  function predictRules(s: TempState, writes: readonly RuleWrite[], insertion: TempRuleInsertion): PredictedRule[][] {
    let cur: PredictedRule[] = s.rules.map((rule, orig) => ({ rule, orig }));
    const temps = new Set(s.tempsN);
    const states: PredictedRule[][] = [];
    for (const w of writes) {
      const n = normalizeRuleText(w.text);
      if (w.add) {
        const at = cur.flatMap((p, i) => (temps.has(normalizeRuleText(p.rule.text)) ? [i] : []));
        const firstNonModule = cur.findIndex((p) => p.rule.source !== 'module');
        const i = at.length > 0 ? (insertion === 'head' ? at[0]! : at[at.length - 1]! + 1) : firstNonModule >= 0 ? firstNonModule : cur.length;
        cur = [...cur.slice(0, i), { rule: { text: w.text, source: 'temp_rule', moduleName: null }, orig: -1 }, ...cur.slice(i)];
        temps.add(n);
      } else {
        const i = cur.findIndex((p) => normalizeRuleText(p.rule.text) === n);
        if (i >= 0) cur = [...cur.slice(0, i), ...cur.slice(i + 1)];
        temps.delete(n);
      }
      states.push(cur);
    }
    return states;
  }

  /**
   * 写入之前按插入位置检查优先级（§5.5「优先级检查」）：预测每一步写入之后的有效规则并分类，返回要拒绝的问题（无则为空）。
   * - strict（目标 VERIFY_ONLY/ACTIVE）：任何一步之后有规则可能抢先匹配 Safari 流量并放行（blocking）即拒绝。例如尾部插入时
   *   新入口排在已有的用户临时规则之后，移除原来覆盖 Safari 全部流量的 block 后，这些规则就排在新入口之前。
   * - 否则（BLOCKED、撤销清理）：某一步移除的本应用规则排在一条其他规则之前，而这条规则在这一步或之后的预测中可能匹配
   *   Safari 流量并放行，即拒绝——被移除的规则原来拦下的 Safari 流量此后会落到它（可能直连或经其他出口）。早已排在被移除的
   *   本应用规则之前的规则不是这些写入造成的，由读回照常报告。
   */
  function predictedPrecedence(s: TempState, writes: readonly RuleWrite[], insertion: TempRuleInsertion, strict: boolean): PrecedenceIssue[] {
    const ours = new Set(s.ourTextsN);
    for (const w of writes) if (w.add) ours.add(normalizeRuleText(w.text));
    const ctx = precedenceContext(s, ours);
    const states = predictRules(s, writes, insertion);
    /** 排在某条已移除的本应用规则之后的其他规则（按读到的位置）。 */
    const behindRemoved = new Set<number>();
    const found = new Map<number, PrecedenceIssue>();
    let prev: PredictedRule[] = s.rules.map((rule, orig) => ({ rule, orig }));
    writes.forEach((w, k) => {
      const state = states[k]!;
      if (!w.add) {
        const n = normalizeRuleText(w.text);
        const i = prev.findIndex((p) => normalizeRuleText(p.rule.text) === n);
        if (i >= 0) for (const p of prev.slice(i + 1)) if (p.orig >= 0 && !ours.has(normalizeRuleText(p.rule.text))) behindRemoved.add(p.orig);
      }
      for (const { index, issue } of classifyPrecedenceAt(
        state.map((p) => p.rule),
        ctx,
      )) {
        const orig = state[index]!.orig;
        if (issue.severity === 'blocking' && (strict || behindRemoved.has(orig))) found.set(orig, issue);
      }
      prev = state;
    });
    return [...found.entries()].sort((a, b) => a[0] - b[0]).map(([, issue]) => issue);
  }

  async function normalizeOwnership(s: TempState): Promise<void> {
    for (const rec of s.records) {
      const inList = s.tempsN.has(normalizeRuleText(rec.identity));
      if (rec.state === 'pending_add' || rec.state === 'pending_remove') {
        await deps.ownership.confirm('temp_rule', rec.identity, inList ? 'present' : 'removed');
      } else if (rec.state === 'present' && !inList) {
        // 例如 Surge 重启后临时规则消失（“discarded when Surge stops”）：按事实记为已移除。
        await deps.ownership.confirm('temp_rule', rec.identity, 'removed');
      }
    }
  }

  /** 规则已在临时规则列表中，并且出现在有效规则中。 */
  function inEffect(s: TempState, textN: string): boolean {
    return s.tempsN.has(textN) && s.rules.some((r) => normalizeRuleText(r.text) === textN);
  }

  /**
   * 撤销清理要移除的本应用规则：在临时规则列表中、有本应用记录（不属于本应用记录的规则从不出现）；目标 BLOCKED 时
   * 不含期望的 block 规则。按 cleanupRank 排序。
   */
  function cleanupPlan(s: TempState, to: 'BLOCKED' | 'NORMAL'): CleanupItem[] {
    const blockN = normalizeRuleText(s.expected.block);
    const groups = new Map<string, CleanupItem>();
    for (const rec of s.records) {
      const textN = normalizeRuleText(rec.identity);
      if ((to === 'BLOCKED' && textN === blockN) || !s.tempsN.has(textN)) continue;
      const g = groups.get(textN);
      if (g) {
        g.identities.push(rec.identity);
        continue;
      }
      const text = s.temps.find((t) => normalizeRuleText(t) === textN) ?? rec.identity;
      groups.set(textN, { kind: kindOfRecord(rec.identity, s.expected)?.kind ?? 'unrecognized', text, textN, identities: [rec.identity] });
    }
    // 结构未知不等于会路由：保留其中的拒绝规则，直到所有可能路由的规则已移除；否则先删除同一匹配范围的拒绝规则，
    // 会短暂暴露后面的旧 SFE-ROUTE 规则。
    const rank = (i: CleanupItem): number => cleanupRank(i.kind, REJECT_POLICIES.has((parseRule(i.text)?.policy ?? '').toUpperCase()), i.textN === blockN);
    return [...groups.values()].sort((a, b) => rank(a) - rank(b));
  }

  /**
   * 撤销本应用入口（opts.undo：普通模式、回滚；目标 BLOCKED/NORMAL）时，本应用记录的临时规则重复、是旧文本、无法识别或
   * 不在有效规则中，或者从中断的切换留下的集合出发没有安全的计划：无法按种类规划，改为逐条清理本应用记录的规则，
   * 只走从不放宽的步骤。
   * - 目标 BLOCKED：先确保期望的 block 规则（匹配 Safari 全部流量的 REJECT）存在（加入一条 REJECT 规则在任何插入位置都不会
   *   放宽；同文规则无本应用记录 → NAME_COLLISION）并出现在有效规则中，否则不移除任何规则；然后在它一直生效的前提下按
   *   cleanupRank 移除其余本应用规则，Safari 全程不会经 SFE-ROUTE 新放行，也不会落到原规则。不属于本应用、可能放行 Safari
   *   流量的规则夹在要移除的本应用规则与 block 之间时（排在后面的 block 之前的用户临时规则），移除会让 Safari 流量落到它：
   *   写入之前按插入位置预测，这种情况在任何写入之前以 PRECEDENCE_VIOLATION 拒绝（回滚停在需要处理）；普通模式的中间阻断
   *   （towardNormal）除外——NORMAL 本来就把这些流量交给原规则，普通模式永远可用。
   * - 目标 NORMAL：按 cleanupRank 移除全部本应用规则，block 最后移除（block 移除之前已没有本应用的路由规则）。
   * 每步与常规步骤一样：先记录意图、写入、运行时读回、按读到的事实确认归属；任一步失败即停止，不声称已确认状态。
   * 这些步骤不是单个种类按计划的变更，不经 onStep 报告：每步确认之后经 note 报告（opts.onCleanup——路由操作写入操作步骤
   * 与结果 entryCleanup；同时记入最终读回证据与错误 details.undoCleanup）。
   * 返回清理后的状态：之后按常规计划补齐目标并做最终读回。
   */
  async function cleanupForUndo(start: TempState, to: 'BLOCKED' | 'NORMAL', note: (c: CleanupEntry) => void, towardNormal: boolean): Promise<TempState> {
    let s = start;
    const blockN = normalizeRuleText(s.expected.block);
    const reload = async (writeError: unknown): Promise<TempState> => {
      try {
        return await load();
      } catch (e) {
        throw withLastConfirmed(writeError ?? e, null, null);
      }
    };
    if (to === 'BLOCKED') {
      if (s.foreign.includes('block')) {
        throw stepFailure('NAME_COLLISION', '切换入口失败：已有同文的临时规则，但不是本应用添加的', null, { bit: 'block' });
      }
      // block 已在临时规则中却不在有效规则中时，下面照旧以 UNKNOWN_STATE 停止（不写入）。
      if (!towardNormal && (!s.tempsN.has(blockN) || inEffect(s, blockN))) {
        const writes: RuleWrite[] = [
          ...(s.tempsN.has(blockN) ? [] : [{ add: true, text: s.expected.block }]),
          ...cleanupPlan(s, 'BLOCKED').map((i) => ({ add: false, text: i.text })),
        ];
        for (const ins of insertionsToCheck()) {
          const issues = predictedPrecedence(s, writes, ins, false);
          if (issues.length > 0) {
            throw stepFailure('PRECEDENCE_VIOLATION', '切换入口失败：撤销清理会让 Safari 流量落到排在本应用规则之后、可能放行的其他规则，未写入', null, {
              precedenceIssues: issues,
              insertion: ins,
            });
          }
        }
      }
      if (!s.tempsN.has(blockN)) {
        const text = s.expected.block;
        let writeError: unknown = null;
        try {
          await deps.ownership.recordIntent('temp_rule', text, null, deps.operationId(), 'add');
          await deps.adapter.addTempRule(text);
        } catch (e) {
          writeError = e;
        }
        const after = await reload(writeError);
        if (!after.tempsN.has(blockN)) {
          await deps.ownership.confirm('temp_rule', text, 'removed').catch(() => undefined);
          throw writeError !== null
            ? withLastConfirmed(writeError, null, null)
            : stepFailure('READBACK_MISMATCH', '切换入口失败：运行时读回与预期不一致', null, { failedRule: { action: 'add', kind: 'block', rule: text } });
        }
        await deps.ownership.confirm('temp_rule', text, 'present');
        note({ action: 'add', kind: 'block', rule: text });
        s = after;
      }
      if (!inEffect(s, blockN)) {
        // 阻断规则没有出现在有效规则中：此时移除任何规则都可能让 Safari 落到原规则，停止。
        throw stepFailure('UNKNOWN_STATE', '切换入口失败：阻断规则不在有效规则中，无法在保持阻断的前提下撤销本应用的其他临时规则', null, {
          anomalies: s.anomalies,
        });
      }
    }
    for (const item of cleanupPlan(s, to)) {
      let writeError: unknown = null;
      try {
        for (const id of item.identities) await deps.ownership.recordIntent('temp_rule', id, null, deps.operationId(), 'remove');
        await deps.adapter.removeTempRule(item.text);
      } catch (e) {
        writeError = e;
      }
      const after = await reload(writeError);
      if (after.tempsN.has(item.textN)) {
        // 超时等未知结果或报告成功却未生效：按读到的事实确认，停止。
        for (const id of item.identities) await deps.ownership.confirm('temp_rule', id, 'present').catch(() => undefined);
        throw writeError !== null
          ? withLastConfirmed(writeError, null, null)
          : stepFailure('READBACK_MISMATCH', '切换入口失败：运行时读回与预期不一致', null, {
              failedRule: { action: 'remove', kind: cleanupKindLabel(item.kind), rule: item.text },
            });
      }
      for (const id of item.identities) await deps.ownership.confirm('temp_rule', id, 'removed');
      note({ action: 'remove', kind: cleanupKindLabel(item.kind), rule: item.text });
      s = after;
      if (to === 'BLOCKED' && !inEffect(s, blockN)) {
        // 阻断规则被移除或不再出现在有效规则中：不再移除任何规则。
        throw stepFailure('READBACK_MISMATCH', '切换入口失败：清理中阻断规则不再生效', null, { anomalies: s.anomalies });
      }
    }
    // 最后一次 load 发生在 confirm 之前；重新读取归属，避免最后移除的未知规则仍以 pending_remove 造成异常。
    return load();
  }

  /** 按插入位置预测时要检查的位置：P0 实测的位置，未知时两种都要安全。 */
  function insertionsToCheck(): TempRuleInsertion[] {
    return deps.insertion ? [deps.insertion] : ['head', 'tail'];
  }

  /** 从无歧义的状态出发的计划：先找与先后无关的计划，没有时按实际先后与插入位置模拟；都没有为 null。 */
  function planFor(s: TempState, to: KnownEntryMode): { steps: TempKindStep[]; allowed: Set<KnownEntryMode>; fromMode: KnownEntryMode | 'UNKNOWN'; byInsertion: boolean } | null {
    const fromMode = semanticMode(s.order) ?? 'UNKNOWN';
    const allowed = allowedModes(fromMode, to);
    const any = planTempKinds(presentKinds(s), to, allowed);
    if (any) return { steps: any, allowed, fromMode, byInsertion: false };
    const byInsertion = planTempKindsByInsertion(s.order ?? [], to, allowed, insertionsToCheck());
    return byInsertion ? { steps: byInsertion, allowed, fromMode, byInsertion: true } : null;
  }

  /**
   * 从无歧义的状态按计划逐条增删，每步写入后运行时读回（列表、有效顺序、rule match），最后读回目标模式。
   * undo（撤销本应用入口：普通模式、回滚，目标 BLOCKED/NORMAL）：rule match 读不到时按结构读回继续（记作证据，
   * 最终读回标为未经运行时确认）；刚加入的 REJECT 类规则（block、udp、blockOther）不会让任何流量新经 SFE-ROUTE 发出，
   * 只因探测读不到或与预期不一致（不是对照进程命中）而失败时保留，不再移除——移除它会让 Safari 回到切换前的路由状态，
   * 普通模式与回滚因此永远无法完成。
   */
  async function runPlan(
    start: TempState,
    to: KnownEntryMode,
    plan: NonNullable<ReturnType<typeof planFor>>,
    onStep: ((step: EntryStep) => void) | undefined,
    towardNormal: boolean,
    undo: boolean,
  ): Promise<EntryReadback> {
    let s = start;
    const { steps, allowed, fromMode } = plan;
    let lastConfirmed: EntryBits | null = fromMode === 'UNKNOWN' ? null : { ...ENTRY_MODE_BITS[fromMode] };
    /** 撤销入口中 rule match 读不到、只按结构读回确认的步骤（证据）。 */
    const unconfirmedSteps: string[] = [];
    if ((to === 'VERIFY_ONLY' || to === 'ACTIVE') && hasBlockingIssue(precedenceOf(s))) {
      throw stepFailure('PRECEDENCE_VIOLATION', '切换入口失败：有规则排在入口之前，可能抢先匹配 Safari 流量', lastConfirmed, {
        precedenceIssues: precedenceOf(s),
      });
    }
    const collision = steps.find((st) => st.add && s.foreign.includes(st.kind));
    if (collision) {
      throw stepFailure('NAME_COLLISION', '切换入口失败：已有同文的临时规则，但不是本应用添加的', lastConfirmed, { bit: entryBitOfTempKind(collision.kind) });
    }
    // 复核：按插入位置逐步预测（与先后无关的计划在 head 与 tail 下都必然通过）。
    for (const ins of insertionsToCheck()) {
      if (!predictableTempPlan(s.order ?? [], steps, ins, allowed, to)) {
        throw stepFailure('CAPABILITY_UNVERIFIED', '切换入口失败：临时规则的插入位置无法保证入口规则顺序', lastConfirmed, { insertion: ins, to });
      }
    }
    // 只看本应用规则的预测不够：已有的其他规则可能因本计划的写入排到入口之前（目标 NORMAL 与普通模式的中间阻断除外）。
    if (to !== 'NORMAL' && !towardNormal) {
      const writes: RuleWrite[] = steps.map((st) => ({ add: st.add, text: st.add ? s.expected[st.kind] : (s.presentText[st.kind] ?? s.expected[st.kind]) }));
      const strict = to === 'VERIFY_ONLY' || to === 'ACTIVE';
      for (const ins of insertionsToCheck()) {
        const issues = predictedPrecedence(s, writes, ins, strict);
        if (issues.length > 0) {
          throw stepFailure(
            'PRECEDENCE_VIOLATION',
            strict
              ? '切换入口失败：按插入位置预测，写入过程中会有规则排在入口之前，可能抢先匹配 Safari 流量'
              : '切换入口失败：移除本应用规则会让 Safari 流量落到排在其后、可能放行的其他规则，未写入',
            lastConfirmed,
            { precedenceIssues: issues, insertion: ins, to },
          );
        }
      }
    }

    for (const st of steps) {
      const text = st.add ? s.expected[st.kind] : s.presentText[st.kind]!;
      const textN = normalizeRuleText(text);
      const stepInfo = { bit: entryBitOfTempKind(st.kind), value: st.add };
      let writeError: unknown = null;
      try {
        await deps.ownership.recordIntent('temp_rule', text, null, deps.operationId(), st.add ? 'add' : 'remove');
        if (st.add) await deps.adapter.addTempRule(text);
        else await deps.adapter.removeTempRule(text);
      } catch (e) {
        writeError = e;
      }
      let after: TempState;
      try {
        after = await load();
      } catch (e) {
        // 写入结果与当前状态都无法读到：不再声称任何已确认状态。
        throw withLastConfirmed(writeError ?? e, null, stepInfo);
      }
      const textPresent = after.tempsN.has(textN);
      if (writeError !== null && (st.add ? !textPresent : textPresent)) {
        // 超时等未知结果：读到的事实表明这一步没有生效，上一确认状态仍然成立。
        await deps.ownership.confirm('temp_rule', text, textPresent ? 'present' : 'removed').catch(() => undefined);
        throw withLastConfirmed(writeError, lastConfirmed, stepInfo);
      }
      const mode = semanticMode(after.order);
      const kindsOk = sameKinds(presentKinds(after), st.kinds);
      const structuralOk = kindsOk && mode !== null && allowed.has(mode);
      const judgement = structuralOk ? await observe(after, precedenceOf(after)) : null;
      // 撤销入口时 rule match 读不到不是停止的理由（结构读回照常，见 runPlan 注释）；对照进程命中从不容忍。
      const toleratedRead = undo && (!st.add || REJECT_KINDS.has(st.kind)) && judgement !== null && judgement.readFailed === true && !judgement.controlHit;
      if (toleratedRead) unconfirmedSteps.push(`${st.kind}${st.add ? '+' : '-'}`);
      if (!structuralOk || (judgement !== null && !judgement.ok && !toleratedRead)) {
        let present = textPresent;
        // 撤销入口中刚加入的 REJECT 类规则：结构读回是允许的模式、只是探测不符（不是对照进程命中）时保留（见 runPlan 注释）。
        const keepReject = undo && st.add && textPresent && structuralOk && REJECT_KINDS.has(st.kind) && judgement !== null && !judgement.controlHit;
        if (st.add && textPresent && !keepReject) {
          // 刚加入的规则造成了放行、集合或运行时求值不符：移除它回到上一确认状态，不再继续。
          try {
            await deps.adapter.removeTempRule(text);
            present = (await deps.adapter.listTempRules()).map(normalizeRuleText).includes(textN);
          } catch {
            present = true;
          }
        }
        await deps.ownership.confirm('temp_rule', text, present ? 'present' : 'removed').catch(() => undefined);
        // 本条规则回到了步骤之前的状态时，上一确认状态仍然成立；否则无法确定（保留的 REJECT 规则：不声称任何已确认状态）。
        const unchanged = st.add ? !present : present;
        throw stepFailure('READBACK_MISMATCH', '切换入口失败：运行时读回与预期不一致', unchanged ? lastConfirmed : null, {
          failedStep: { bit: stepInfo.bit, value: st.add, kind: st.kind },
          observedMode: mode ?? 'UNKNOWN',
          ...(keepReject ? { keptRejectRule: true } : {}),
          ...(judgement && !judgement.ok ? { runtime: judgement.evidence, controlHit: judgement.controlHit } : {}),
        });
      }
      await deps.ownership.confirm('temp_rule', text, st.add ? 'present' : 'removed');
      lastConfirmed = { ...ENTRY_MODE_BITS[mode] };
      s = after;
      onStep?.({ bit: stepInfo.bit, value: st.add, bits: { ...lastConfirmed }, effective: mode });
    }

    let finalState: TempState;
    let judgement: ProbeJudgement | null;
    let final: EntryReadback;
    try {
      finalState = await load();
      judgement = await observe(finalState, precedenceOf(finalState));
      final = readbackOf(finalState, judgement, undo);
    } catch (e) {
      throw withLastConfirmed(e, lastConfirmed, null);
    }
    if (unconfirmedSteps.length > 0) {
      final.runtimeConfirmed = false;
      final.evidence.push(`撤销入口：这些步骤写入后 rule match 读不到，只按临时规则列表与有效规则顺序确认：${unconfirmedSteps.join('、')}`);
    }
    if (final.mode !== to) {
      // 只有入口规则已是目标模式、仅因有规则排在入口之前而不能宣称受控时，才是 PRECEDENCE_VIOLATION。
      const onlyPrecedence =
        baseModeOf(finalState) === to && hasBlockingIssue(final.precedenceIssues) && (judgement === null || judgement.ok || (undo && judgement.readFailed === true && !judgement.controlHit));
      throw new SfeError(onlyPrecedence ? 'PRECEDENCE_VIOLATION' : 'READBACK_MISMATCH', '切换入口失败：最终读回不是目标模式', {
        details: {
          lastConfirmedBits: lastConfirmed,
          observedMode: final.mode,
          precedenceIssues: final.precedenceIssues,
          evidence: final.evidence,
          // 未经运行时确认的读回（EntryReadback.runtimeConfirmed）：普通模式据此不把这一次阻断当作已确认
          ...(final.runtimeConfirmed === false ? { runtimeConfirmed: false } : {}),
        },
      });
    }
    return final;
  }

  return {
    strategy: 'temp_rule',

    async read() {
      return readback(await load());
    },

    async transition(to, onStep, opts) {
      let s: TempState;
      try {
        s = await load();
        await normalizeOwnership(s);
        s = await load();
      } catch (e) {
        throw withLastConfirmed(e, null, null);
      }
      // 普通模式的中间阻断：之后撤销全部本应用入口（见 EntryTransitionOptions.towardNormal）。
      const towardNormal = opts?.undo === true && opts.towardNormal === true && to === 'BLOCKED';
      const undoing = opts?.undo === true && (to === 'BLOCKED' || to === 'NORMAL');
      if (towardNormal && s.anomalies.length === 0 && presentKinds(s).length === 0) {
        // 临时规则列表中已没有本应用规则（例如 Surge 重启或降级时丢弃了它们，归属已按事实确认为移除）：Safari 已按原规则
        // 发出，不需要阻断——不写入（降级后的 Surge 也不支持 rule temp add）。
        const rb = readbackOf(s, null);
        rb.evidence.push('临时规则列表中没有本应用规则：入口已是普通模式，不需要阻断，未写入');
        return rb;
      }
      if (!isAmbiguous(s.anomalies)) {
        const plan = planFor(s, to);
        if (plan) return runPlan(s, to, plan, onStep, towardNormal, undoing);
        if (!undoing) {
          const from = semanticMode(s.order);
          throw stepFailure('CAPABILITY_UNVERIFIED', '切换入口失败：从当前临时规则出发没有不经放行状态的单条增删计划，未写入', from ? { ...ENTRY_MODE_BITS[from] } : null, {
            to,
            present: presentKinds(s),
          });
        }
      } else if (!undoing) {
        // 重复、旧文本、无法识别或不在有效规则中的本应用记录：只有撤销本应用入口（普通模式、回滚）逐条清理（§5.2 进入普通模式
        // 永远可用）；激活方向与未标为撤销的切换照常拒绝，从不在无法确定的状态上走向 VERIFY_ONLY/ACTIVE。
        throw stepFailure('UNKNOWN_STATE', '切换入口失败：无法确定当前入口状态', null, { anomalies: s.anomalies });
      }
      const trail: CleanupEntry[] = [];
      const onCleanup = opts?.onCleanup;
      const note = (c: CleanupEntry): void => {
        trail.push(c);
        onCleanup?.({ ...c });
      };
      try {
        s = await cleanupForUndo(s, to as 'BLOCKED' | 'NORMAL', note, towardNormal);
        if (isAmbiguous(s.anomalies)) {
          throw stepFailure('UNKNOWN_STATE', '切换入口失败：清理后仍无法确定当前入口状态', null, { anomalies: s.anomalies });
        }
        const plan = planFor(s, to);
        if (!plan) throw stepFailure('UNKNOWN_STATE', '切换入口失败：清理后仍无法规划', null, { present: presentKinds(s) });
        const final = await runPlan(s, to, plan, onStep, towardNormal, true);
        if (trail.length > 0) final.evidence.push(cleanupEvidence(trail));
        return final;
      } catch (e) {
        throw withCleanupTrail(e, trail);
      }
    },
  };
}
