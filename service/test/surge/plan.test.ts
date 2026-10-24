import { describe, expect, test } from 'vitest';
import { ENTRY_MODE_BITS, effectiveEntryMode, type EntryBits, type KnownEntryMode } from '@sfe/contract';
import {
  applyTempStep,
  bitsEqual,
  knownModeOfBits,
  planEntryTransition,
  planFromBits,
  planTempKinds,
  planTempKindsByInsertion,
  predictableTempPlan,
  safeForAnyOrder,
  type TempInsertion,
} from '../../src/surge/entry/plan.js';
import { allowedModes, modeOfSemantic, modesOfKindsAnyOrder, orderIndependentMode, semanticOfKinds, semanticOfMode } from '../../src/surge/entry/common.js';
import { TEMP_ENTRY_KINDS, TEMP_ENTRY_MODE_KINDS, type TempEntryKind } from '../../src/surge/generate.js';

const MODES: KnownEntryMode[] = ['NORMAL', 'BLOCKED', 'VERIFY_ONLY', 'ACTIVE'];
const ALL_BITS: EntryBits[] = Array.from({ length: 16 }, (_, n) => ({
  udp: Boolean(n & 1),
  verify: Boolean(n & 2),
  block: Boolean(n & 4),
  active: Boolean(n & 8),
}));

const udpSafe = (b: EntryBits): boolean => !(b.verify || b.active) || b.udp;

describe('planEntryTransition: all 4×4 known pairs', () => {
  for (const from of MODES) {
    for (const to of MODES) {
      test(`${from} → ${to}`, () => {
        const steps = planEntryTransition(from, to);
        const start = ENTRY_MODE_BITS[from];
        if (from === to) {
          expect(steps).toEqual([]);
          return;
        }
        // 单个位逐步变化，每步记录的位组合与前一步只差这一位。
        let prev = start;
        for (const s of steps) {
          expect(s.bits[s.bit]).toBe(s.value);
          const diff = (Object.keys(prev) as Array<keyof EntryBits>).filter((k) => prev[k] !== s.bits[k]);
          expect(diff).toEqual([s.bit]);
          prev = s.bits;
        }
        expect(steps.at(-1)!.bits).toEqual(ENTRY_MODE_BITS[to]);
        // 从第一步起到最后一个 block 步骤之前，block 一直开着。
        steps.forEach((s, i) => {
          const isFinalBlockStep = i === steps.length - 1 && s.bit === 'block';
          if (!isFinalBlockStep) expect(s.bits.block).toBe(true);
        });
        // verify 或 active 打开时 udp 必为打开。
        for (const s of steps) expect(udpSafe(s.bits)).toBe(true);
        // 中间有效模式只能是 BLOCKED、VERIFY_ONLY、起点或终点；不会出现非目标的 ACTIVE 或 NORMAL。
        for (const s of steps.slice(0, -1)) {
          expect(['BLOCKED', 'VERIFY_ONLY', from, to]).toContain(s.effective);
          if (s.effective === 'ACTIVE') expect(to).toBe('ACTIVE');
          if (s.effective === 'NORMAL') expect(to).toBe('NORMAL');
          expect(s.effective).toBe(effectiveEntryMode(s.bits));
        }
        expect(steps.at(-1)!.effective).toBe(to);
      });
    }
  }

  test('leaving NORMAL opens block first, then udp', () => {
    const steps = planEntryTransition('NORMAL', 'ACTIVE');
    expect(steps.map((s) => `${s.bit}${s.value ? '+' : '-'}`)).toEqual(['block+', 'udp+', 'active+', 'block-']);
  });

  test('ACTIVE → VERIFY_ONLY blocks before swapping verify/active', () => {
    expect(planEntryTransition('ACTIVE', 'VERIFY_ONLY').map((s) => `${s.bit}${s.value ? '+' : '-'}`)).toEqual([
      'block+',
      'active-',
      'verify+',
    ]);
  });

  test('VERIFY_ONLY → ACTIVE keeps block until the last step', () => {
    expect(planEntryTransition('VERIFY_ONLY', 'ACTIVE').map((s) => `${s.bit}${s.value ? '+' : '-'}`)).toEqual([
      'verify-',
      'active+',
      'block-',
    ]);
  });
});

describe('planFromBits: all 16 starting combinations × 4 targets', () => {
  for (const start of ALL_BITS) {
    for (const to of MODES) {
      const label = `${JSON.stringify(start)} → ${to}`;
      test(label, () => {
        const steps = planFromBits(start, to);
        const target = ENTRY_MODE_BITS[to];
        if (bitsEqual(start, target)) {
          expect(steps).toEqual([]);
          return;
        }
        expect(steps.at(-1)!.bits).toEqual(target);
        if (!start.block) expect(steps[0]).toMatchObject({ bit: 'block', value: true });
        steps.forEach((s, i) => {
          const isFinalBlockStep = i === steps.length - 1 && s.bit === 'block';
          if (!isFinalBlockStep) expect(s.bits.block).toBe(true);
        });
        // 起点已违反 udp 不变量时，只允许在开头的 block 步骤中暂时保留；之后必须成立。
        steps.forEach((s, i) => {
          const startViolates = !udpSafe(start);
          const allowedViolation = startViolates && i === 0 && !start.block && s.bit === 'block';
          if (!allowedViolation) expect(udpSafe(s.bits)).toBe(true);
        });
        const from = knownModeOfBits(start);
        for (const s of steps.slice(0, -1)) {
          const allowed: string[] = ['BLOCKED', 'VERIFY_ONLY', to];
          if (from) allowed.push(from);
          expect(allowed).toContain(s.effective);
          if (s.effective === 'ACTIVE') expect(to).toBe('ACTIVE');
          if (s.effective === 'NORMAL') expect(to).toBe('NORMAL');
        }
      });
    }
  }

  test('a non-standard ACTIVE without udp is blocked before anything else', () => {
    const steps = planFromBits({ udp: false, verify: false, block: false, active: true }, 'ACTIVE');
    expect(steps.map((s) => `${s.bit}${s.value ? '+' : '-'}`)).toEqual(['block+', 'udp+', 'block-']);
  });
});

describe('knownModeOfBits', () => {
  test('maps the four modes and rejects others', () => {
    for (const m of MODES) expect(knownModeOfBits(ENTRY_MODE_BITS[m])).toBe(m);
    expect(knownModeOfBits({ udp: false, verify: true, block: true, active: false })).toBeNull();
  });
});

// ---------- temp_rule：按集合规划（与插入位置无关） ----------

function permutations<T>(xs: readonly T[]): T[][] {
  if (xs.length <= 1) return [[...xs]];
  return xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));
}
const SUBSETS: TempEntryKind[][] = Array.from({ length: 1 << TEMP_ENTRY_KINDS.length }, (_, n) => TEMP_ENTRY_KINDS.filter((_k, i) => n & (1 << i)));
const fmt = (steps: ReadonlyArray<{ kind: string; add: boolean }>): string[] => steps.map((s) => `${s.add ? '+' : '-'}${s.kind}`);

describe('temp_rule rule sets: disjoint conditions make every mode order-independent', () => {
  test.each(MODES)('%s: the canonical rule set gives the same mode in every order', (m) => {
    const kinds = TEMP_ENTRY_MODE_KINDS[m];
    expect(orderIndependentMode(kinds)).toBe(m);
    for (const p of permutations(kinds)) expect(semanticOfKinds(p)).toEqual(semanticOfMode(m));
  });

  test('overlapping rules in a mode always share the policy (no rule set relies on order)', () => {
    for (const m of MODES) expect(modesOfKindsAnyOrder(TEMP_ENTRY_MODE_KINDS[m])).toEqual([m]);
  });

  test('without udp, Safari UDP/QUIC is never routed: active and verify exclude UDP in any order', () => {
    for (const kinds of SUBSETS) {
      if (kinds.includes('udp') || kinds.includes('block')) continue;
      for (const p of permutations(kinds)) {
        const sem = semanticOfKinds(p);
        expect(sem.udpVerify).toBe('pass');
        expect(sem.udpOther).toBe('pass');
      }
    }
  });
});

describe('planTempKinds: all 16 from → to pairs', () => {
  for (const from of MODES) {
    for (const to of MODES) {
      test(`${from} → ${to}: single-rule steps, safe in every order, reaches the target under head and tail insertion`, () => {
        const allowed = allowedModes(from, to);
        const steps = planTempKinds(TEMP_ENTRY_MODE_KINDS[from], to, allowed)!;
        expect(steps).not.toBeNull();
        if (from === to) {
          expect(steps).toEqual([]);
          return;
        }
        let kinds: TempEntryKind[] = [...TEMP_ENTRY_MODE_KINDS[from]];
        for (const st of steps) {
          // 每步只加入或移除一条
          expect(kinds.includes(st.kind)).toBe(!st.add);
          kinds = st.add ? [...kinds, st.kind] : kinds.filter((k) => k !== st.kind);
          expect([...st.kinds].sort()).toEqual([...kinds].sort());
          // 每步之后不论先后（新规则排在最前、最后或中间）都只能是允许的模式：没有放行窗口
          expect(safeForAnyOrder(kinds, allowed)).toBe(true);
          for (const m of modesOfKindsAnyOrder(kinds)) {
            expect(m).not.toBeNull();
            if (m === 'ACTIVE') expect([from, to]).toContain('ACTIVE');
            if (m === 'NORMAL') expect([from, to]).toContain('NORMAL');
          }
        }
        expect(orderIndependentMode(kinds)).toBe(to);
        // 原有的按插入位置逐步预测（predictable）在 head 与 tail 下都通过，从规范先后与任何先后的起点出发都一样
        for (const insertion of ['head', 'tail'] as const) {
          for (const start of permutations(TEMP_ENTRY_MODE_KINDS[from])) expect(predictableTempPlan(start, steps, insertion, allowed, to)).toBe(true);
        }
      });
    }
  }

  test('the plans: reject rules go in before route rules, route rules come out first', () => {
    expect(fmt(planTempKinds([], 'ACTIVE', allowedModes('NORMAL', 'ACTIVE'))!)).toEqual(['+block', '+udp', '+active', '-block']);
    expect(fmt(planTempKinds([], 'VERIFY_ONLY', allowedModes('NORMAL', 'VERIFY_ONLY'))!)).toEqual(['+block', '+udp', '+blockOther', '+verify', '-block']);
    expect(fmt(planTempKinds(['udp', 'verify', 'blockOther'], 'ACTIVE', allowedModes('VERIFY_ONLY', 'ACTIVE'))!)).toEqual(['+active', '-verify', '-blockOther']);
    expect(fmt(planTempKinds(['udp', 'active'], 'VERIFY_ONLY', allowedModes('ACTIVE', 'VERIFY_ONLY'))!)).toEqual(['+blockOther', '+verify', '-active']);
    expect(fmt(planTempKinds(['udp', 'active'], 'NORMAL', allowedModes('ACTIVE', 'NORMAL'))!)).toEqual(['+block', '-active', '-udp', '-block']);
    expect(fmt(planTempKinds(['block'], 'NORMAL', allowedModes('BLOCKED', 'NORMAL'))!)).toEqual(['-block']);
  });

  test('the old ordered design could not reach ACTIVE under head insertion; the disjoint design can', () => {
    // 旧设计：active 匹配 Safari 全部流量，head 插入时新加的 active 排在 udp 之前 → UDP 经 SFE-ROUTE。
    // 新设计：active 排除 UDP，任何先后都一样。
    const steps = planTempKinds(['block'], 'ACTIVE', allowedModes('BLOCKED', 'ACTIVE'))!;
    let order: TempEntryKind[] = ['block'];
    for (const st of steps) {
      order = applyTempStep(order, st.kind, st.add, 'head');
      expect(semanticOfKinds(order).udpOther).toBe('reject');
      expect(semanticOfKinds(order).udpVerify).toBe('reject');
    }
    expect(modeOfSemantic(semanticOfKinds(order))).toBe('ACTIVE');
  });
});

describe('temp_rule plans from every interrupted state', () => {
  // 每个集合 × 每种先后（含中断的切换留下的非规范集合）× 4 个目标。
  const cases = SUBSETS.flatMap((kinds) => permutations(kinds)).flatMap((order) => MODES.map((to) => ({ order, to })));

  const plan = (order: TempEntryKind[], to: KnownEntryMode, insertions: readonly TempInsertion[]) => {
    const from = modeOfSemantic(semanticOfKinds(order)) ?? 'UNKNOWN';
    const allowed = allowedModes(from, to);
    return { from, allowed, steps: planTempKinds(order, to, allowed) ?? planTempKindsByInsertion(order, to, allowed, insertions) };
  };

  test('head insertion (the documented "highest priority"): every state reaches every target without a permissive step', () => {
    for (const { order, to } of cases) {
      const { steps, allowed } = plan(order, to, ['head']);
      expect(steps, `${order.join(',')} → ${to}`).not.toBeNull();
      expect(predictableTempPlan(order, steps!, 'head', allowed, to)).toBe(true);
    }
  });

  test('insertion unknown (head and tail both checked): every state whose effect is a known mode has a plan', () => {
    for (const { order, to } of cases) {
      const { steps, allowed, from } = plan(order, to, ['head', 'tail']);
      if (from === 'UNKNOWN') continue; // 已经放行的状态：撤销入口时逐条清理（cleanupForUndo）
      expect(steps, `${order.join(',')} → ${to}`).not.toBeNull();
      for (const insertion of ['head', 'tail'] as const) expect(predictableTempPlan(order, steps!, insertion, allowed, to)).toBe(true);
    }
  });

  test('an interrupted ACTIVE → VERIFY_ONLY ({udp, active, blockOther}) still has a way back to NORMAL', () => {
    for (const order of permutations(['udp', 'active', 'blockOther'] as TempEntryKind[])) {
      const { steps } = plan(order, 'NORMAL', ['head', 'tail']);
      expect(steps).not.toBeNull();
      expect(steps!.at(-1)!.kinds).toEqual([]);
    }
  });
});
