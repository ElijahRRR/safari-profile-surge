import { describe, expect, test } from 'vitest';
import { ENTRY_MODE_BITS, effectiveEntryMode, type EntryBits, type KnownEntryMode } from '@sfe/contract';
import { bitsEqual, knownModeOfBits, planEntryTransition, planFromBits } from '../../src/surge/entry/plan.js';

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
