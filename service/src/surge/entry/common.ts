// 两种入口策略共用的判断：按本应用入口规则在有效规则中的实际顺序求“语义模式”，
// 以及失败时附带最后确认状态的错误。

import { ENTRY_MODE_BITS, SfeError, type EntryBits, type EntryMode, type ErrorCode, type KnownEntryMode } from '@sfe/contract';
import type { EntryStep, ProfileFiles, SurgeAdapter } from '../../ports.js';
import type { EntryBit } from '../generate.js';
import type { EntryOwnership } from './ownership.js';

export type Outcome = 'pass' | 'reject' | 'route';

/** 四类 Safari 流量各自的结果：TCP/UDP × 检测主机/其他主机。 */
export interface EntrySemantic {
  tcpVerify: Outcome;
  tcpOther: Outcome;
  udpVerify: Outcome;
  udpOther: Outcome;
}

const BIT_OUTCOME: Record<EntryBit, Outcome> = { udp: 'reject', verify: 'route', block: 'reject', active: 'route' };

function bitMatches(bit: EntryBit, udp: boolean, verifyHost: boolean): boolean {
  if (bit === 'udp') return udp;
  if (bit === 'verify') return verifyHost;
  return true;
}

/** 按入口规则的实际先后顺序（只含已出现的位）求每类流量的结果。 */
export function semanticOfOrder(order: readonly EntryBit[]): EntrySemantic {
  const first = (udp: boolean, verifyHost: boolean): Outcome => {
    const bit = order.find((b) => bitMatches(b, udp, verifyHost));
    return bit ? BIT_OUTCOME[bit] : 'pass';
  };
  return { tcpVerify: first(false, true), tcpOther: first(false, false), udpVerify: first(true, true), udpOther: first(true, false) };
}

const CANONICAL: readonly EntryBit[] = ['udp', 'verify', 'block', 'active'];

export function semanticOfMode(mode: KnownEntryMode): EntrySemantic {
  const bits = ENTRY_MODE_BITS[mode];
  return semanticOfOrder(CANONICAL.filter((b) => bits[b]));
}

function sameSemantic(a: EntrySemantic, b: EntrySemantic): boolean {
  return a.tcpVerify === b.tcpVerify && a.tcpOther === b.tcpOther && a.udpVerify === b.udpVerify && a.udpOther === b.udpOther;
}

/** 语义对应的已知模式；不对应任何模式（存在放行或 UDP 泄漏的组合）返回 null。 */
export function modeOfSemantic(s: EntrySemantic): KnownEntryMode | null {
  for (const mode of Object.keys(ENTRY_MODE_BITS) as KnownEntryMode[]) {
    if (sameSemantic(semanticOfMode(mode), s)) return mode;
  }
  return null;
}

export function bitsFromOrder(order: readonly EntryBit[]): EntryBits {
  return { udp: order.includes('udp'), verify: order.includes('verify'), block: order.includes('block'), active: order.includes('active') };
}

/** 切换过程中允许出现的语义模式：BLOCKED、VERIFY_ONLY、起点与终点。 */
export function allowedModes(from: EntryMode, to: KnownEntryMode): Set<KnownEntryMode> {
  const s = new Set<KnownEntryMode>(['BLOCKED', 'VERIFY_ONLY', to]);
  if (from !== 'UNKNOWN') s.add(from);
  return s;
}

export function stepFailure(code: ErrorCode, message: string, lastConfirmedBits: EntryBits | null, extra: Record<string, unknown> = {}): SfeError {
  return new SfeError(code, message, { details: { ...extra, lastConfirmedBits } });
}

/** 把步骤中抛出的错误补上最后确认的位；未知错误不回显原文。 */
export function withLastConfirmed(e: unknown, lastConfirmedBits: EntryBits | null, step: EntryStep | null): SfeError {
  const stepInfo = step ? { failedStep: { bit: step.bit, value: step.value } } : {};
  if (e instanceof SfeError) {
    return new SfeError(e.code, e.message, { fieldErrors: e.fieldErrors, details: { ...(e.details ?? {}), ...stepInfo, lastConfirmedBits }, cause: e });
  }
  return new SfeError('INTERNAL', '切换入口失败：内部错误', { details: { ...stepInfo, lastConfirmedBits } });
}

export interface EntryConfig {
  processPaths: string[];
  verifyHost: string;
  siteHosts: string[];
}

export interface EntryStrategyDeps {
  adapter: SurgeAdapter;
  /** ruleset_resource 必需；带 digestContent 时意图记录写入目标内容的摘要。 */
  files?: ProfileFiles & { digestContent?: (content: string) => string };
  ownership: EntryOwnership;
  config: () => EntryConfig;
  operationId: () => string | null;
}
