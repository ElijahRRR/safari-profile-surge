// 能力验证上下文（CapabilityContext）的构造。字段来源与服务运行时一致（ARCHITECTURE §5.2）：
// sw_vers 构建号、Safari.app Info.plist、运行中的 Surge 实例（surge/running-instance.ts，与服务同一读取器；
// 从不经 getVersion）、getTakeoverState、getAutoReloadSetting、
// 已确认的进程路径与入口策略、原语实现映射。读不到的字段记 null（服务运行时同样读不到才会匹配）；
// 例外：Surge 版本与构建读不到时永远不匹配（NEVER_NULL_FIELDS），依赖它们的能力不能提议。

import type { CapabilityContext, CapabilityContextField, CapabilityKey, EntryStrategy, TakeoverState } from '@sfe/contract';
import { staleReasonsFor } from './deps.js';
import { processPathsDigest as serviceProcessPathsDigest, takeoverModeOf as serviceTakeoverModeOf } from '../../../service/src/engine/capabilities.js';

/** 进程路径摘要：与服务端同一公式（直接复用服务实现，避免两处漂移）。 */
export function processPathsDigest(paths: readonly string[]): string | null {
  return serviceProcessPathsDigest(paths);
}

/** 接管方式：与服务端同一公式；两者都关闭或读不到时为 null。 */
export function takeoverModeOf(t: TakeoverState | null): CapabilityContext['takeoverMode'] {
  return t ? serviceTakeoverModeOf(t) : null;
}

export function autoReloadOf(setting: boolean | null): 'on' | 'off' | null {
  return setting === null ? null : setting ? 'on' : 'off';
}

/** 原语实现映射的规范 JSON（键排序）。 */
export function canonicalMechanism(map: Record<string, string> | null): string | null {
  if (!map) return null;
  const sorted = Object.fromEntries(Object.keys(map).sort().map((k) => [k, map[k]!]));
  return JSON.stringify(sorted);
}

export interface ContextInputs {
  surgeVersion: { version: string | null; build: string | null } | null;
  macosBuild: string | null;
  safariVersion: string | null;
  entryStrategy: EntryStrategy | null;
  processPaths: readonly string[];
  autoReloadSetting: boolean | null;
  takeover: TakeoverState | null;
  signingIdentity: string | null;
  mechanism: Record<string, string> | null;
}

export interface ContextOverrides {
  /** 只能显式声明为 any：P0 在测试配置上测得，确认后适用于初始化生成的工作配置。 */
  workingProfileId?: 'any';
  autoReload?: 'on' | 'off' | 'any';
  takeoverMode?: 'enhanced' | 'system_proxy' | 'both' | 'any';
  signingIdentity?: string;
}

export function buildContext(inputs: ContextInputs, overrides: ContextOverrides = {}): CapabilityContext {
  return {
    surgeVersion: inputs.surgeVersion?.version ?? null,
    surgeBuild: inputs.surgeVersion?.build ?? null,
    macosBuild: inputs.macosBuild,
    safariVersion: inputs.safariVersion,
    entryStrategy: inputs.entryStrategy,
    processPathsDigest: processPathsDigest(inputs.processPaths),
    workingProfileId: overrides.workingProfileId ?? null,
    autoReload: overrides.autoReload ?? autoReloadOf(inputs.autoReloadSetting),
    takeoverMode: overrides.takeoverMode ?? takeoverModeOf(inputs.takeover),
    signingIdentity: overrides.signingIdentity ?? inputs.signingIdentity,
    adapterMechanism: canonicalMechanism(inputs.mechanism),
  };
}

/** 测量时与提议时上下文中该能力依赖的字段有差异（例如中途升级了 Safari）。 */
export function contextDrift(key: CapabilityKey, measured: CapabilityContext, current: CapabilityContext): CapabilityContextField[] {
  return staleReasonsFor(key, measured, current);
}
