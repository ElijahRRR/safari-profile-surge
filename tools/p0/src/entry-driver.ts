// 入口模式驱动：用服务的入口策略（EntryController）依次切换目标模式，记录每一步的写入区间与位组合
// （供放行窗口分析），每个模式确认后调用 afterMode 做停留与观察。任何一步失败即停止，保留已确认的更严格状态，
// 不尝试退回更宽松状态；是否进入普通模式由操作员决定。另含优先级测试与临时规则插入位置探测。

import { ENTRY_MODE_BITS, SfeError, type EntryBits, type EntryMode, type KnownEntryMode } from '@sfe/contract';
import type { EntryTimeline } from './analysis/entry-window.js';
import { normalizeRuleText, type EntryController, type EntryReadback, type EntryStep, type SurgeAdapter, type SurgeRuleRecord } from './deps.js';

export interface StepRecord {
  from: number;
  to: number;
  step: EntryStep;
}

export interface ModeRecord {
  target: KnownEntryMode;
  startedAt: number;
  confirmedAt: number | null;
  readbackMode: EntryMode | null;
  ok: boolean;
  error: { code: string; message: string; lastConfirmedBits: EntryBits | null } | null;
  steps: StepRecord[];
  evidence: string[];
}

export interface EntryRunDeps {
  controller: EntryController;
  now: () => number;
  onStep?: (r: StepRecord) => void;
  afterMode?: (m: ModeRecord, readback: EntryReadback) => Promise<void>;
}

export interface EntryRun {
  initial: EntryReadback;
  modes: ModeRecord[];
  timeline: EntryTimeline;
  stoppedEarly: boolean;
}

function errorInfo(e: unknown): ModeRecord['error'] {
  if (e instanceof SfeError) {
    const bits = (e.details?.lastConfirmedBits ?? null) as EntryBits | null;
    return { code: e.code, message: e.message, lastConfirmedBits: bits };
  }
  return { code: 'INTERNAL', message: '切换入口失败：内部错误', lastConfirmedBits: null };
}

export async function runEntrySequence(deps: EntryRunDeps, targets: readonly KnownEntryMode[]): Promise<EntryRun> {
  const initial = await deps.controller.read();
  const initialBits = initial.bits ?? ENTRY_MODE_BITS.NORMAL;
  const timeline: EntryTimeline = { initial: initialBits, steps: [] };
  let prev: EntryBits = initialBits;
  const modes: ModeRecord[] = [];
  for (const target of targets) {
    const rec: ModeRecord = { target, startedAt: deps.now(), confirmedAt: null, readbackMode: null, ok: false, error: null, steps: [], evidence: [] };
    modes.push(rec);
    let last = rec.startedAt;
    try {
      await deps.controller.transition(target, (step) => {
        const t = deps.now();
        const r: StepRecord = { from: last, to: t, step };
        rec.steps.push(r);
        timeline.steps.push({ from: last, to: t, before: prev, after: step.bits });
        prev = step.bits;
        last = t;
        deps.onStep?.(r);
      });
      const rb = await deps.controller.read();
      rec.confirmedAt = deps.now();
      rec.readbackMode = rb.mode;
      rec.evidence = rb.evidence;
      rec.ok = rb.mode === target;
      await deps.afterMode?.(rec, rb);
      if (!rec.ok) return { initial, modes, timeline, stoppedEarly: true };
    } catch (e) {
      rec.error = errorInfo(e);
      return { initial, modes, timeline, stoppedEarly: true };
    }
  }
  return { initial, modes, timeline, stoppedEarly: false };
}

export interface PrecedenceOutcome {
  /** 切换到 VERIFY_ONLY 被拒绝且错误为 PRECEDENCE_VIOLATION。 */
  refused: boolean;
  code: string | null;
  /** 读回中列出的阻断项数量。 */
  blockingIssues: number;
  /** 测试后的读回模式（应为 NORMAL）。 */
  modeAfter: EntryMode | null;
}

/**
 * 优先级测试：注入一条可能抢先匹配 Safari 流量的非 REJECT 规则后尝试进入 VERIFY_ONLY，必须被拒绝。
 * 无论结果如何都清理注入的规则；之后不是 NORMAL 时回到 NORMAL。
 */
export async function precedenceTest(controller: EntryController, inject: () => Promise<void>, cleanup: () => Promise<void>): Promise<PrecedenceOutcome> {
  let refused = false;
  let code: string | null = null;
  let blocking = 0;
  try {
    await inject();
    const rb = await controller.read();
    blocking = rb.precedenceIssues.filter((i) => i.severity === 'blocking').length;
    try {
      await controller.transition('VERIFY_ONLY');
    } catch (e) {
      code = e instanceof SfeError ? e.code : 'INTERNAL';
      refused = code === 'PRECEDENCE_VIOLATION';
    }
  } finally {
    await cleanup();
  }
  let after = await controller.read();
  if (after.mode !== 'NORMAL') {
    try {
      await controller.transition('NORMAL');
    } catch {
      /* 由调用方报告 */
    }
    after = await controller.read();
  }
  return { refused, code, blockingIssues: blocking, modeAfter: after.mode };
}

export const INSERTION_PROBE_RULES = ['DOMAIN,p0-insert-1.invalid,REJECT', 'DOMAIN,p0-insert-2.invalid,REJECT'] as const;

export interface ProfileBoundary {
  /** 测试配置第一条规则在有效规则列表中的位置；null = 无法确定（见 note）。 */
  index: number | null;
  note: string | null;
}

/**
 * 配置规则在有效规则列表中的起点。真实的 CLI/HTTP 解析不报告规则来源（source 只有 module/unknown），
 * 所以不依赖 source，而是用本工具生成的测试配置自己的 [Rule] 文本定位：第一条规则必须恰好出现一次，
 * 且其他只出现一次的配置规则都不在它之前；否则如实报告无法确定。
 */
export function profileBoundary(rules: readonly SurgeRuleRecord[], profileRules: readonly string[] | null | undefined): ProfileBoundary {
  if (!profileRules || profileRules.length === 0) {
    return { index: null, note: '没有测试配置的规则文本（CLI 不报告规则来源），无法确定配置规则的起点' };
  }
  const listed = rules.map((r) => normalizeRuleText(r.text));
  const hitsOf = (text: string): number[] => {
    const want = normalizeRuleText(text);
    return listed.flatMap((t, i) => (t === want ? [i] : []));
  };
  const first = hitsOf(profileRules[0]!);
  if (first.length !== 1) {
    return { index: null, note: first.length === 0 ? '有效规则中找不到测试配置的第一条规则，无法确定配置规则的起点' : '测试配置的第一条规则在有效规则中出现多次，无法确定配置规则的起点' };
  }
  const index = first[0]!;
  for (const text of profileRules.slice(1)) {
    const hits = hitsOf(text);
    if (hits.length === 1 && hits[0]! < index) return { index: null, note: '有效规则中测试配置规则的顺序与配置文件不一致，无法确定配置规则的起点' };
  }
  return { index, note: null };
}

export interface InsertionProbeResult {
  insertion: 'head' | 'tail' | null;
  /** 两条探测规则是否都排在配置规则之前；null = 无法判断（原因见 boundaryNote）。 */
  beforeProfileRules: boolean | null;
  boundaryNote: string | null;
  /**
   * 正向确认 listTempRules：添加后的临时规则列表必须列出两条探测规则。
   * - true：列出了，输出格式与内容都可信；
   * - false：只在读取成功、有效规则中能看到两条探测规则、临时规则列表却没有全部列出时（该原语映射不可用，
   *   依赖它的读回、同步与回退都不能信任）；
   * - null：无法确认（读取失败、添加没有生效、读不到有效规则而无法区分原因、未探测），原因见 tempListNote。
   *   null 不等于映射不可用，也不能当作可用。
   */
  tempListConfirmed: boolean | null;
  /** tempListConfirmed 不为 true 时的原因。 */
  tempListNote: string | null;
  /** 添加后读取 listTempRules 失败的错误码（此时 tempListConfirmed 为 null）。 */
  tempListReadError: string | null;
  /**
   * addTempRule 是否生效：两条探测规则出现在临时规则列表或有效规则中为 true；有效规则可读、两处都没有（全部）
   * 看到为 false（归咎于 addTempRule，不归咎于 listTempRules）；读不到有效规则且临时规则列表没有列出时为 null。
   */
  addConfirmed: boolean | null;
  skipped?: string;
}

function codeOf(e: unknown): string {
  return e instanceof SfeError ? e.code : 'ERROR';
}

/**
 * 临时规则插入位置探测：依次添加两条永不命中的 REJECT 规则，先正向确认临时规则列表能列出它们，再按有效规则列表中的
 * 先后判断新规则插在前还是后、是否排在测试配置规则之前，最后逐条删除。register 在每次添加前登记意图（回退只删
 * 登记过的规则）。当前临时规则中已有相同（规范化后）的规则或读不到列表时不探测：添加与删除都按文本，会删掉或接管
 * 用户自己的规则。listTempRules 没有列出探测规则时，用有效规则列表区分原因：只有确认添加已生效时才判定列表不可用。
 */
export async function probeTempInsertion(
  adapter: SurgeAdapter,
  register: (rule: string) => Promise<void>,
  markRemoved: (rule: string) => Promise<void>,
  opts: { profileRules?: readonly string[] | null } = {},
): Promise<InsertionProbeResult> {
  let existing: string[] | null;
  try {
    existing = await adapter.listTempRules();
  } catch {
    existing = null;
  }
  const none = { insertion: null, beforeProfileRules: null, boundaryNote: null, tempListConfirmed: null, tempListReadError: null, addConfirmed: null } as const;
  if (existing === null) return { ...none, tempListNote: '读不到当前临时规则，未探测', skipped: '读不到当前临时规则，未探测' };
  const present = new Set(existing.map(normalizeRuleText));
  if (INSERTION_PROBE_RULES.some((r) => present.has(normalizeRuleText(r)))) {
    return { ...none, tempListNote: '已存在相同的临时规则，未探测', skipped: '已存在相同的临时规则，未探测（不会删除它）' };
  }
  const added: string[] = [];
  try {
    for (const r of INSERTION_PROBE_RULES) {
      await register(r);
      await adapter.addTempRule(r);
      added.push(r);
    }
    let listed: string[] | null = null;
    let tempListReadError: string | null = null;
    try {
      listed = await adapter.listTempRules();
    } catch (e) {
      tempListReadError = codeOf(e);
    }
    let rules: SurgeRuleRecord[] | null;
    try {
      rules = await adapter.listRules();
    } catch {
      rules = null;
    }
    const listedN = new Set((listed ?? []).map(normalizeRuleText));
    const listedBoth = listed !== null && INSERTION_PROBE_RULES.every((r) => listedN.has(normalizeRuleText(r)));
    const idx = (r: string): number => (rules ?? []).findIndex((x) => normalizeRuleText(x.text) === normalizeRuleText(r));
    const i1 = idx(INSERTION_PROBE_RULES[0]);
    const i2 = idx(INSERTION_PROBE_RULES[1]);
    const found = i1 >= 0 && i2 >= 0;
    const addConfirmed = listedBoth || found ? true : rules === null ? null : false;

    let tempListConfirmed: boolean | null;
    let tempListNote: string | null;
    if (listed === null) {
      tempListConfirmed = null;
      tempListNote = `添加后读取临时规则失败（${tempListReadError ?? 'ERROR'}）：本次无法确认 listTempRules（不等于映射不可用）`;
    } else if (listedBoth) {
      tempListConfirmed = true;
      tempListNote = null;
    } else if (addConfirmed === true) {
      tempListConfirmed = false;
      tempListNote = 'listTempRules 没有列出刚添加的探测规则（有效规则中能看到它们）：该原语映射不可用';
    } else if (addConfirmed === false) {
      tempListConfirmed = null;
      tempListNote = '临时规则列表与有效规则中都没有（全部）刚添加的探测规则：addTempRule 可能没有生效，无法确认 listTempRules';
    } else {
      tempListConfirmed = null;
      tempListNote = 'listTempRules 没有列出刚添加的探测规则，且读不到有效规则列表：无法区分是添加没有生效还是列表映射不可用';
    }

    if (rules === null) {
      return { insertion: null, beforeProfileRules: null, boundaryNote: '读不到有效规则列表，无法判断插入位置与配置规则的先后', tempListConfirmed, tempListNote, tempListReadError, addConfirmed };
    }
    const insertion = found ? (i2 < i1 ? 'head' : 'tail') : null;
    const boundary = profileBoundary(rules, opts.profileRules);
    const beforeProfileRules = !found || boundary.index === null ? null : Math.max(i1, i2) < boundary.index;
    const boundaryNote = !found ? '有效规则中找不到探测规则，无法判断与配置规则的先后' : boundary.note;
    return { insertion, beforeProfileRules, boundaryNote, tempListConfirmed, tempListNote, tempListReadError, addConfirmed };
  } finally {
    for (const r of [...added].reverse()) {
      try {
        await adapter.removeTempRule(r);
        await markRemoved(r);
      } catch {
        /* 由回退处理 */
      }
    }
  }
}
