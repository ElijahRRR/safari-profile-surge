// 能力门槛的当前上下文与判定（docs/ARCHITECTURE.md §5.2）。上下文来自：Surge 版本与构建、接管、自动重载
// （对账缓存的事实）、sw_vers 构建号与补充版本、后台安全改进是否待重启、Safari 版本、设置中的入口策略与进程路径、
// 工作配置、签名身份与原语实现。
// 进程路径摘要与工作配置身份用规范形式的 SHA-256：它们不含秘密，P0 工具需要算出同样的值写进提议。补充版本与待重启
// 状态的读取规则也在这里，P0 直接复用。

import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
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

/** 补充版本中不能出现的值：它们是本应用自己的标记（没有安装、非 macOS、演示、不限）。 */
const RESERVED_VERSION_EXTRA = new Set(['none', 'unknown', 'demo', 'any']);

/**
 * `sw_vers -productVersionExtra` 的结果 → 能力上下文的 macosVersionExtra（服务与 P0 共用同一规则）。
 * 退出码 0 且输出为空：'none'（没有安装后台安全改进）；形如 `(a)` 或 `a`：原样记录；其他（启动失败、退出码非 0、
 * 不认识的输出）：null。Apple 的设备管理文档把补充版本与基础构建号分开记录（StatusDeviceOperatingSystemSupplementalExtraVersion：
 * “The operating system’s Background Security Improvement version in use on the device, for example, `a`.”），
 * 装上后台安全改进后基础构建号可能不变，所以单独记录。
 * TODO(P0)：`man sw_vers` 的原文，以及没有安装、已安装未重启、重启后三种状态下的实际输出（没有安装时是否为空），在测试 Mac
 * 上核对（P0-RUNBOOK §1.6）；不认识的输出按读不到处理，依赖它的能力不能提议。
 */
export function versionExtraFromSwVers(r: { code: number; stdout: string }): string | null {
  if (r.code !== 0) return null;
  const v = r.stdout.trim();
  if (v === '') return 'none';
  if (!/^(?:\([A-Za-z0-9]{1,8}\)|[A-Za-z0-9]{1,8})$/.test(v) || RESERVED_VERSION_EXTRA.has(v.toLowerCase())) return null;
  return v;
}

/**
 * 已安装、要重启 Mac 才完全生效的后台安全改进的暂存位置。Apple 只写到 Mac 上“applied content appears on the Preboot volume
 * (through symbolic links in /System/Cryptexes/ )”（部署指南）与“applying the Incoming Cryptex”（Apple 平台安全指南），
 * 没有写暂存路径。TODO(P0)：这是测试 Mac 上的观察，需按 P0-RUNBOOK §1.6 在安装前、安装后重启前、重启后各核对一次；
 * 核对之前它只能让依赖进程归属的能力更难通过（存在或无法确认即待验证），不能证明没有待重启的后台安全改进。
 */
export const STAGED_CRYPTEX_PATH = '/System/Volumes/Preboot/Cryptexes/Incoming';

export type PathPresence = 'present' | 'absent' | 'unknown';

/** 路径是否存在（lstat，不跟随符号链接）：存在 → present；ENOENT/ENOTDIR → absent；其他错误（例如没有权限）→ unknown。 */
export async function pathPresence(path: string, stat: (p: string) => Promise<unknown> = lstat): Promise<PathPresence> {
  try {
    await stat(path);
    return 'present';
  } catch (e) {
    const code = (e as NodeJS.ErrnoException | null)?.code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'absent' : 'unknown';
  }
}

/** 暂存位置的状态 → macosRestartPending：存在为 'yes'，不存在为 'no'，无法确认为 null（不匹配任何记录）。 */
export function restartPendingFrom(p: PathPresence): 'yes' | 'no' | null {
  return p === 'present' ? 'yes' : p === 'absent' ? 'no' : null;
}

export interface ContextSources {
  surgeVersion: string | null;
  surgeBuild: string | null;
  macosBuild: string | null;
  macosVersionExtra: string | null;
  macosRestartPending: CapabilityContext['macosRestartPending'];
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
    macosVersionExtra: s.macosVersionExtra,
    macosRestartPending: s.macosRestartPending,
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
