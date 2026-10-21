// 入口模式驱动：用服务的入口策略（EntryController）依次切换目标模式，记录每一步的写入区间与位组合
// （供放行窗口分析），每个模式确认后调用 afterMode 做停留与观察。任何一步失败即停止，保留已确认的更严格状态，
// 不尝试退回更宽松状态；是否进入普通模式由操作员决定。另含优先级测试与临时规则插入位置探测。

import { ENTRY_MODE_BITS, SfeError, type EntryBits, type EntryMode, type KnownEntryMode } from '@sfe/contract';
import type { EntryTimeline } from './analysis/entry-window.js';
import { normalizeRuleText, type EntryController, type EntryReadback, type EntryStep, type SurgeAdapter } from './deps.js';

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

/**
 * 临时规则插入位置探测：依次添加两条永不命中的 REJECT 规则，按有效规则列表中的先后判断新规则插在前还是后，
 * 再逐条删除。register 在每次添加前登记意图（回退只删登记过的规则）。
 */
export async function probeTempInsertion(
  adapter: SurgeAdapter,
  register: (rule: string) => Promise<void>,
  markRemoved: (rule: string) => Promise<void>,
): Promise<{ insertion: 'head' | 'tail' | null; beforeProfileRules: boolean | null }> {
  const added: string[] = [];
  try {
    for (const r of INSERTION_PROBE_RULES) {
      await register(r);
      await adapter.addTempRule(r);
      added.push(r);
    }
    const rules = await adapter.listRules();
    const idx = (r: string): number => rules.findIndex((x) => normalizeRuleText(x.text) === normalizeRuleText(r));
    const i1 = idx(INSERTION_PROBE_RULES[0]);
    const i2 = idx(INSERTION_PROBE_RULES[1]);
    const firstProfile = rules.findIndex((x) => x.source === 'profile');
    const insertion = i1 < 0 || i2 < 0 ? null : i2 < i1 ? 'head' : 'tail';
    const beforeProfileRules = i1 < 0 || i2 < 0 || firstProfile < 0 ? null : Math.max(i1, i2) < firstProfile;
    return { insertion, beforeProfileRules };
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
