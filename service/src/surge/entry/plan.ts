// 入口切换规划（纯函数）。
// ruleset_resource：单个位逐步变更：先开 block（离开 NORMAL 时紧接着开 udp），再把 udp/verify/active 设为目标值
// （block 仍开），最后把 block 设为目标值（规则集的先后由工作配置固定）。
// temp_rule：条件互不相交的五种临时规则，按集合规划（planTempKinds），每步之后不论先后都没有放行窗口。
// 不变量见 docs/ARCHITECTURE.md §5.5，由穷举测试保证。

import { ENTRY_MODE_BITS, effectiveEntryMode, type EntryBits, type KnownEntryMode } from '@sfe/contract';
import type { EntryStep } from '../../ports.js';
import { TEMP_ENTRY_KINDS, TEMP_ENTRY_MODE_KINDS, type TempEntryKind } from '../generate.js';
import { modeOfSemantic, modesOfKindsAnyOrder, semanticOfKinds } from './common.js';

export function bitsEqual(a: EntryBits, b: EntryBits): boolean {
  return a.udp === b.udp && a.verify === b.verify && a.block === b.block && a.active === b.active;
}

/** 位组合对应的已知模式；不对应四种模式之一时返回 null。 */
export function knownModeOfBits(bits: EntryBits): KnownEntryMode | null {
  for (const mode of Object.keys(ENTRY_MODE_BITS) as KnownEntryMode[]) {
    if (bitsEqual(ENTRY_MODE_BITS[mode], bits)) return mode;
  }
  return null;
}

function stepEffective(bits: EntryBits): KnownEntryMode {
  const e = effectiveEntryMode(bits);
  if (e === 'ACTIVE_WITHOUT_UDP_BLOCK' || e === 'VERIFY_WITHOUT_BLOCK') {
    // 规划保证 block 打开期间不会出现；出现即为规划错误。
    throw new Error(`entry plan produced an uncontrolled state: ${JSON.stringify(bits)}`);
  }
  return e;
}

/** 从任意当前位组合（含 16 种中非标准的组合）规划到目标模式。 */
export function planFromBits(current: EntryBits, to: KnownEntryMode): EntryStep[] {
  const target = ENTRY_MODE_BITS[to];
  const bits: EntryBits = { ...current };
  const steps: EntryStep[] = [];
  if (bitsEqual(bits, target)) return steps;
  const push = (bit: keyof EntryBits, value: boolean): void => {
    bits[bit] = value;
    steps.push({ bit, value, bits: { ...bits }, effective: stepEffective(bits) });
  };
  if (!bits.block) push('block', true);
  // verify/active 打开时 udp 必须打开；起点违反时在 block 之后立即补上。
  if (!bits.udp && (target.udp || bits.verify || bits.active)) push('udp', true);
  for (const bit of ['verify', 'active'] as const) if (bits[bit] && !target[bit]) push(bit, false);
  for (const bit of ['verify', 'active'] as const) if (!bits[bit] && target[bit]) push(bit, true);
  if (bits.udp && !target.udp) push('udp', false);
  if (bits.block !== target.block) push('block', target.block);
  return steps;
}

export function planEntryTransition(from: KnownEntryMode, to: KnownEntryMode): EntryStep[] {
  return planFromBits(ENTRY_MODE_BITS[from], to);
}

// ---------- temp_rule：按规则集合规划，与插入位置无关 ----------

/** temp_rule 的一步：加入或移除一整条某种临时规则；kinds 为这一步之后的集合（规范顺序）。 */
export interface TempKindStep {
  kind: TempEntryKind;
  add: boolean;
  kinds: TempEntryKind[];
}

/**
 * 广度优先时的候选次序（决定同样长度的计划中选哪一条）：先移除路由规则，再加入拒绝规则，然后移除多余的拒绝规则，
 * 最后加入路由规则——路由规则尽量晚加、早撤。
 */
const TEMP_TOGGLES: ReadonlyArray<readonly [TempEntryKind, boolean]> = [
  ['active', false],
  ['verify', false],
  ['block', true],
  ['udp', true],
  ['blockOther', true],
  ['blockOther', false],
  ['udp', false],
  ['block', false],
  ['verify', true],
  ['active', true],
];

interface PlanLink {
  from: string;
  kind: TempEntryKind;
  add: boolean;
  kinds: TempEntryKind[];
}

function canonicalKinds(kinds: Iterable<TempEntryKind>): TempEntryKind[] {
  const set = new Set(kinds);
  return TEMP_ENTRY_KINDS.filter((k) => set.has(k));
}

function kindsKey(kinds: readonly TempEntryKind[]): string {
  return canonicalKinds(kinds).join('+');
}

/** 集合在任何先后下的语义都属于 allowed（与新规则排在最前、最后或中间都无关）。 */
export function safeForAnyOrder(kinds: readonly TempEntryKind[], allowed: ReadonlySet<KnownEntryMode>): boolean {
  return modesOfKindsAnyOrder(kinds).every((m) => m !== null && allowed.has(m));
}

/**
 * 从当前存在的本应用临时规则（任意集合，含中断的切换留下的非规范集合）规划到目标模式的规范集合：每步只加入或移除一条，
 * 每步之后的集合在任何先后下都只能是 allowed 中的模式（起点本身不检查）。找最短的计划；没有这样的计划时返回 null（调用方
 * 在写入之前拒绝）。条件互不相交的设计保证四种模式两两之间都有计划（穷举测试）。
 */
export function planTempKinds(start: readonly TempEntryKind[], to: KnownEntryMode, allowed: ReadonlySet<KnownEntryMode>): TempKindStep[] | null {
  const goal = kindsKey(TEMP_ENTRY_MODE_KINDS[to]);
  const startKinds = canonicalKinds(start);
  const startKey = kindsKey(startKinds);
  if (startKey === goal) return [];
  const prev = new Map<string, PlanLink | null>([[startKey, null]]);
  let frontier: TempEntryKind[][] = [startKinds];
  while (frontier.length > 0) {
    const next: TempEntryKind[][] = [];
    for (const cur of frontier) {
      const curKey = kindsKey(cur);
      for (const [kind, add] of TEMP_TOGGLES) {
        if (cur.includes(kind) === add) continue;
        const kinds = canonicalKinds(add ? [...cur, kind] : cur.filter((k) => k !== kind));
        const key = kindsKey(kinds);
        if (prev.has(key) || !safeForAnyOrder(kinds, allowed)) continue;
        prev.set(key, { from: curKey, kind, add, kinds });
        if (key === goal) {
          const steps: TempKindStep[] = [];
          for (let k: string | undefined = key; k !== undefined && k !== startKey; ) {
            const p: PlanLink = prev.get(k)!;
            steps.unshift({ kind: p.kind, add: p.add, kinds: p.kinds });
            k = p.from;
          }
          return steps;
        }
        next.push(kinds);
      }
    }
    frontier = next;
  }
  return null;
}

export type TempInsertion = 'head' | 'tail';

/** 按插入位置模拟一步之后本应用临时规则的先后：加入时排在最前（head）或最后（tail），移除时去掉。 */
export function applyTempStep(order: readonly TempEntryKind[], kind: TempEntryKind, add: boolean, insertion: TempInsertion): TempEntryKind[] {
  if (!add) return order.filter((k) => k !== kind);
  return insertion === 'head' ? [kind, ...order] : [...order, kind];
}

/**
 * 退路：从中断的切换留下的集合出发，没有与先后无关的计划时（例如 {udp, active, blockOther}），按实际先后与插入位置模拟。
 * 每个插入位置模型各自模拟先后，每步之后在每个模型下都必须是 allowed 中的模式（插入位置未知时同时检查 head 与 tail）。
 */
export function planTempKindsByInsertion(
  startOrder: readonly TempEntryKind[],
  to: KnownEntryMode,
  allowed: ReadonlySet<KnownEntryMode>,
  insertions: readonly TempInsertion[],
): TempKindStep[] | null {
  const goal = kindsKey(TEMP_ENTRY_MODE_KINDS[to]);
  if (kindsKey(startOrder) === goal) return [];
  type Node = TempEntryKind[][];
  const keyOf = (n: Node): string => n.map((o) => o.join('>')).join('|');
  const start: Node = insertions.map(() => [...startOrder]);
  const prev = new Map<string, PlanLink | null>([[keyOf(start), null]]);
  let frontier: Node[] = [start];
  while (frontier.length > 0) {
    const next: Node[] = [];
    for (const cur of frontier) {
      const curKey = keyOf(cur);
      for (const [kind, add] of TEMP_TOGGLES) {
        if (cur[0]!.includes(kind) === add) continue;
        const node = cur.map((o, i) => applyTempStep(o, kind, add, insertions[i]!));
        const key = keyOf(node);
        if (prev.has(key)) continue;
        if (!node.every((o) => {
          const m = modeOfSemantic(semanticOfKinds(o));
          return m !== null && allowed.has(m);
        })) continue;
        const kinds = canonicalKinds(node[0]!);
        prev.set(key, { from: curKey, kind, add, kinds });
        if (kindsKey(kinds) === goal) {
          const steps: TempKindStep[] = [];
          for (let k: string = key; k !== keyOf(start); ) {
            const p: PlanLink = prev.get(k)!;
            steps.unshift({ kind: p.kind, add: p.add, kinds: p.kinds });
            k = p.from;
          }
          return steps;
        }
        next.push(node);
      }
    }
    frontier = next;
  }
  return null;
}

/**
 * 按插入位置预测一段计划（与原有的 predictable 相同的检查）：每步之后的语义都是 allowed 中的模式，最后是目标模式。
 * 与先后无关的计划在 head 与 tail 下都必然通过；测试与策略用它复核。
 */
export function predictableTempPlan(
  startOrder: readonly TempEntryKind[],
  steps: readonly TempKindStep[],
  insertion: TempInsertion,
  allowed: ReadonlySet<KnownEntryMode>,
  to: KnownEntryMode,
): boolean {
  let order = [...startOrder];
  for (const step of steps) {
    order = applyTempStep(order, step.kind, step.add, insertion);
    const mode = modeOfSemantic(semanticOfKinds(order));
    if (mode === null || !allowed.has(mode)) return false;
  }
  return modeOfSemantic(semanticOfKinds(order)) === to;
}
