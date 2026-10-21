// 能力门槛的当前上下文与判定（docs/ARCHITECTURE.md §5.2）。上下文来自：Surge 版本与构建、接管、自动重载
// （对账缓存的事实）、sw_vers 构建号、Safari 版本、设置中的入口策略与进程路径、工作配置、签名身份与原语实现。
// 进程路径摘要与工作配置身份用规范形式的 SHA-256：它们不含秘密，P0 工具需要算出同样的值写进提议。

import { createHash } from 'node:crypto';
import {
  CAPABILITY_GATES,
  type CapabilityContext,
  type CapabilityKey,
  type CapabilityView,
  type EntryStrategy,
  type TakeoverState,
} from '@sfe/contract';
import type { CapabilityRecord } from '../db/index.js';
import { computeCapabilityViews } from '../surge/capability-gate.js';
import { canonicalJson } from '../util/keyed-digest.js';

/** Safari 进程路径摘要：sha256(规范 JSON(去重排序后的路径数组))，十六进制。没有路径时为 null。 */
export function processPathsDigest(paths: readonly string[]): string | null {
  if (paths.length === 0) return null;
  const sorted = [...new Set(paths)].sort();
  return createHash('sha256').update(canonicalJson(sorted), 'utf8').digest('hex');
}

/** 工作配置身份：sha256("sfe-working-profile\0" + 绝对路径)，十六进制。未初始化时为 null。 */
export function workingProfileIdentity(path: string | null): string | null {
  if (!path) return null;
  return createHash('sha256').update(`sfe-working-profile\0${path}`, 'utf8').digest('hex');
}

export function takeoverModeOf(t: TakeoverState): CapabilityContext['takeoverMode'] {
  if (t.enhancedMode === true && t.systemProxy === true) return 'both';
  if (t.enhancedMode === true) return 'enhanced';
  if (t.systemProxy === true) return 'system_proxy';
  return null;
}

export interface ContextSources {
  surgeVersion: string | null;
  surgeBuild: string | null;
  macosBuild: string | null;
  safariVersion: string | null;
  entryStrategy: EntryStrategy | null;
  processPaths: readonly string[];
  workingProfilePath: string | null;
  autoReload: boolean | null;
  takeover: TakeoverState;
  signingIdentity: string | null;
  mechanism: Record<string, string>;
}

export function buildCapabilityContext(s: ContextSources): CapabilityContext {
  return {
    surgeVersion: s.surgeVersion,
    surgeBuild: s.surgeBuild,
    macosBuild: s.macosBuild,
    safariVersion: s.safariVersion,
    entryStrategy: s.entryStrategy,
    processPathsDigest: processPathsDigest(s.processPaths),
    workingProfileId: workingProfileIdentity(s.workingProfilePath),
    autoReload: s.autoReload === null ? null : s.autoReload ? 'on' : 'off',
    takeoverMode: takeoverModeOf(s.takeover),
    signingIdentity: s.signingIdentity,
    adapterMechanism: canonicalJson(s.mechanism),
  };
}

export function capabilityViews(records: readonly CapabilityRecord[], current: CapabilityContext): CapabilityView[] {
  return computeCapabilityViews(records, current);
}

export function missingFrom(views: readonly CapabilityView[], keys: readonly CapabilityKey[]): CapabilityKey[] {
  return keys.filter((k) => views.find((v) => v.key === k)?.effectiveStatus !== 'supported');
}

export function unmeasuredFrom(views: readonly CapabilityView[], keys: readonly CapabilityKey[]): CapabilityKey[] {
  return keys.filter((k) => (views.find((v) => v.key === k)?.effectiveStatus ?? 'unverified') === 'unverified');
}

/** 激活门槛：基础项 + ruleset_resource 策略的附加项。 */
export function activationGate(strategy: EntryStrategy | null): CapabilityKey[] {
  const keys: CapabilityKey[] = [...CAPABILITY_GATES.activate];
  if (strategy === 'ruleset_resource') for (const k of CAPABILITY_GATES.activateRulesetStrategy) if (!keys.includes(k)) keys.push(k);
  return keys;
}

/**
 * 读回不完整时，P0 记录覆盖的未核对字段。约定：policy_path_reread、targeted_resource_refresh、
 * external_node_underlying_proxy 的说明中含一行 `readback-covers: server, port, underlying-proxy`
 * （逗号分隔）。三项都声明覆盖的字段才算覆盖；没有声明时一律不覆盖（部署停在 published）。
 */
export const READBACK_COVERAGE_MARKER = 'readback-covers:';
export const READBACK_COVERAGE_KEYS: readonly CapabilityKey[] = ['policy_path_reread', 'targeted_resource_refresh', 'external_node_underlying_proxy'];

function coveredFields(note: string | null): Set<string> {
  const out = new Set<string>();
  if (!note) return out;
  for (const line of note.split(/\r?\n/)) {
    const i = line.toLowerCase().indexOf(READBACK_COVERAGE_MARKER);
    if (i < 0) continue;
    for (const f of line.slice(i + READBACK_COVERAGE_MARKER.length).split(',')) {
      const t = f.trim().toLowerCase();
      if (t) out.add(t);
    }
  }
  return out;
}

/** 未核对字段是否全部被三项 P0 记录（有效状态 supported）覆盖。 */
export function readbackCovered(views: readonly CapabilityView[], uncheckedFields: readonly string[]): boolean {
  if (uncheckedFields.length === 0) return true;
  for (const key of READBACK_COVERAGE_KEYS) {
    const v = views.find((x) => x.key === key);
    if (!v || v.effectiveStatus !== 'supported') return false;
    const covered = coveredFields(v.note);
    if (!uncheckedFields.every((f) => covered.has(f.toLowerCase()))) return false;
  }
  return true;
}
