// 入口切换规划（纯函数）。单个位逐步变更：先开 block（离开 NORMAL 时紧接着开 udp），
// 再把 udp/verify/active 设为目标值（block 仍开），最后把 block 设为目标值。
// 不变量见 docs/ARCHITECTURE.md §5.5，由穷举测试保证。

import { ENTRY_MODE_BITS, effectiveEntryMode, type EntryBits, type KnownEntryMode } from '@sfe/contract';
import type { EntryStep } from '../../ports.js';

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
