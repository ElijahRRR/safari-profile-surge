// 能力门槛：记录的结论与当前上下文比较后的有效状态。任一依赖字段不匹配 → 待验证。
// 比较规则：记录为 any 匹配任何当前值；当前值读不到（null）时只匹配记录的 null 或 any；
// 例外：Surge 版本与构建（NEVER_NULL_FIELDS）只在记录与当前都是格式正确的同一具体值时匹配——任一侧为 null 不匹配，
// 记录为 any 或格式不对（早于提议校验确认的旧记录）也不匹配：版本读不到时依赖版本的能力一律待验证（失败即关闭），
// 升级后也一定过期；“后台安全改进待重启”（macosRestartPending）只有记录与当前都是 'no' 才匹配；adapterMechanism 只比较
// 该能力依赖的原语（规范 JSON）。见 docs/ARCHITECTURE.md §5.2。

import {
  CAPABILITY_CONTEXT_DEPS,
  CAPABILITY_KEYS,
  CAPABILITY_LABELS,
  CAPABILITY_PRIMITIVES,
  GATING_COVERAGE_ITEMS,
  SURGE_BUILD_RE,
  SURGE_VERSION_RE,
  SfeError,
  type CapabilityContext,
  type CapabilityContextField,
  type CapabilityKey,
  type CapabilityStatus,
  type CapabilityView,
  type ProtocolCoverage,
  type ProtocolCoverageItem,
} from '@sfe/contract';
import type { CapabilityGate } from '../ports.js';

export interface CapabilityRecordInput {
  key: CapabilityKey;
  status: CapabilityStatus;
  context: CapabilityContext | null;
  proposalId: string | null;
  verifiedAt: string | null;
  note: string | null;
  protocolCoverage?: ProtocolCoverage | null;
}

/** 该能力依赖的原语在映射中的实现，规范 JSON（键排序；缺失记为 unavailable）。 */
export function mechanismFingerprint(key: CapabilityKey, mechanismMap: Record<string, string>): string {
  const prims = [...(CAPABILITY_PRIMITIVES[key] ?? [])].sort();
  const obj: Record<string, string> = {};
  for (const p of prims) obj[p] = typeof mechanismMap[p] === 'string' ? mechanismMap[p]! : 'unavailable';
  return JSON.stringify(obj);
}

function parseMechanism(value: string): Record<string, string> | null {
  try {
    const v = JSON.parse(value) as unknown;
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
    return v as Record<string, string>;
  } catch {
    return null;
  }
}

/**
 * 读不到（null）就绝不匹配的上下文字段：Surge 版本与构建。null 不表示“与测量时相同”——可能是读取失败，也可能是
 * 运行中的 Surge 已被替换或升级；记录为 null 或 any 都不能让读不到版本的当前上下文通过。记录必须是格式正确的具体值
 * 才可能匹配：记录为 any（早于提议校验、经维护通道提议并确认的旧记录）会让升级不再使能力过期，按不匹配处理。
 */
export const NEVER_NULL_FIELDS: readonly CapabilityContextField[] = ['surgeVersion', 'surgeBuild'];

/** Surge 版本号与构建号的格式（定义在契约中，网页确认提议时用同一格式）；不接受 CLI 交互模式输出中的地址（例如 127.0.0.1）。 */
export { SURGE_BUILD_RE, SURGE_VERSION_RE };

/**
 * 能力提议中版本字段的校验（服务与 P0 共用）：该能力依赖 Surge 版本或构建时，上下文必须带格式正确的具体值——
 * null（读不到）、any 或格式不对都拒绝，因为这样的记录在门槛中永远不会匹配（any 会让升级不再使能力过期，门槛按不匹配处理）。
 * 不依赖版本的能力不检查。
 */
export function versionContextErrors(key: CapabilityKey, context: Pick<CapabilityContext, 'surgeVersion' | 'surgeBuild'>): Array<{ field: 'surgeVersion' | 'surgeBuild'; message: string }> {
  const deps = CAPABILITY_CONTEXT_DEPS[key] ?? [];
  const out: Array<{ field: 'surgeVersion' | 'surgeBuild'; message: string }> = [];
  const check = (field: 'surgeVersion' | 'surgeBuild', label: string, re: RegExp, example: string): void => {
    if (!deps.includes(field)) return;
    const v = context[field];
    if (v === null || v === undefined) out.push({ field, message: `该能力依赖 ${label}，但读不到（这样的记录永远不会生效）` });
    else if (v === 'any') out.push({ field, message: `该能力依赖 ${label}，不能记为 any` });
    else if (typeof v !== 'string' || !re.test(v)) out.push({ field, message: `${label}格式不正确（应为 ${example}），读到的可能不是版本信息` });
  };
  check('surgeVersion', 'Surge 版本', SURGE_VERSION_RE, '6.5.0 这样的版本号');
  check('surgeBuild', 'Surge 构建号', SURGE_BUILD_RE, '10960 这样的数字');
  return out;
}

/**
 * 依赖 Safari 进程归属的能力还要求的本机上下文（服务与 P0 共用；网页确认时按同一规则判断）：
 * - macosRestartPending 必须是 'no'。'yes' 时已安装的后台安全改进要重启 Mac 才完全生效：“After Safari has been relaunched,
 *   it uses the framework and library content from the new cryptexes. The rest of the operating system remains unaffected
 *   and doesn't make use of the new content until the system restarts.”（Apple 平台安全指南）这期间测得的路径可能只是暂时
 *   只属于 Safari，重启后不再成立；null 或 'unknown'（无法确认）同样拒绝。门槛中这个字段只有 'no' 与 'no' 匹配，这样的记录
 *   永远不会生效。
 * - macosVersionExtra 必须是读到的具体值（没有安装时为 'none'）：null 或 any 的记录在装上后台安全改进后不会过期（基础构建号
 *   可能不变）。
 * 不依赖这两个字段的能力不检查。
 */
export function hostContextErrors(
  key: CapabilityKey,
  context: Partial<Pick<CapabilityContext, 'macosVersionExtra' | 'macosRestartPending'>> | null,
): Array<{ field: 'macosVersionExtra' | 'macosRestartPending'; message: string }> {
  const deps = CAPABILITY_CONTEXT_DEPS[key] ?? [];
  const out: Array<{ field: 'macosVersionExtra' | 'macosRestartPending'; message: string }> = [];
  if (deps.includes('macosRestartPending')) {
    const v: unknown = context?.macosRestartPending;
    if (v === 'yes') {
      out.push({ field: 'macosRestartPending', message: '有已安装、尚未重启生效的后台安全改进（Safari 已在使用新的 WebKit，系统其余部分要到重启后才用），这时测得的进程归属不能沿用；请重启 Mac 后重测' });
    } else if (v !== 'no') {
      out.push({ field: 'macosRestartPending', message: '无法确认是否有待重启的后台安全改进（这样的记录永远不会生效）' });
    }
  }
  if (deps.includes('macosVersionExtra')) {
    const v: unknown = context?.macosVersionExtra;
    if (v === null || v === undefined || v === '') out.push({ field: 'macosVersionExtra', message: '该能力依赖 macOS 补充版本（sw_vers -productVersionExtra），但读不到（这样的记录在装上后台安全改进后不会过期）' });
    else if (v === 'any') out.push({ field: 'macosVersionExtra', message: '该能力依赖 macOS 补充版本，不能记为 any' });
  }
  return out;
}

export function contextFieldMatches(
  key: CapabilityKey,
  field: CapabilityContextField,
  recorded: string | null,
  current: string | null,
): boolean {
  // 没有 any：只有记录与当前都确认没有待重启的后台安全改进才匹配（'yes'、'unknown'、null 与旧记录缺少该字段都不匹配）
  if (field === 'macosRestartPending') return recorded === 'no' && current === 'no';
  if (NEVER_NULL_FIELDS.includes(field)) {
    // 只有格式正确的同一具体值才匹配：null、any 与格式不对的旧值（例如 127.0.0.1）都按不匹配（过期原因列出该字段）
    const re = field === 'surgeVersion' ? SURGE_VERSION_RE : SURGE_BUILD_RE;
    return recorded !== null && current !== null && re.test(recorded) && recorded === current;
  }
  if (recorded === 'any') return true;
  if (current === null) return recorded === null;
  if (recorded === null) return false;
  if (field === 'adapterMechanism') {
    const r = parseMechanism(recorded);
    const c = parseMechanism(current);
    if (!r || !c) return recorded === current;
    return mechanismFingerprint(key, r) === mechanismFingerprint(key, c);
  }
  return recorded === current;
}

export function staleReasonsFor(key: CapabilityKey, recorded: CapabilityContext | null, current: CapabilityContext): CapabilityContextField[] {
  const deps = CAPABILITY_CONTEXT_DEPS[key];
  if (!recorded) return [...deps];
  return deps.filter((f) => !contextFieldMatches(key, f, recorded[f], current[f]));
}

/** 全部能力（按 CAPABILITY_KEYS 顺序）的视图；没有记录的项为待验证。 */
export function computeCapabilityViews(records: readonly CapabilityRecordInput[], current: CapabilityContext): CapabilityView[] {
  const byKey = new Map(records.map((r) => [r.key, r]));
  return CAPABILITY_KEYS.map((key) => {
    const r = byKey.get(key);
    if (!r) {
      return {
        key,
        label: CAPABILITY_LABELS[key],
        status: 'unverified',
        effectiveStatus: 'unverified',
        staleReasons: [],
        context: null,
        protocolCoverage: null,
        verifiedAt: null,
        proposalId: null,
        note: null,
      } satisfies CapabilityView;
    }
    const staleReasons = r.status === 'unverified' ? [] : staleReasonsFor(key, r.context, current);
    return {
      key,
      label: CAPABILITY_LABELS[key],
      status: r.status,
      effectiveStatus: r.status === 'unverified' || staleReasons.length > 0 ? 'unverified' : r.status,
      staleReasons,
      context: r.context,
      protocolCoverage: r.protocolCoverage ?? null,
      verifiedAt: r.verifiedAt,
      proposalId: r.proposalId,
      note: r.note,
    } satisfies CapabilityView;
  });
}

/** 确认 supported 前的逐协议覆盖检查：每个门槛项必须 pass，或写明说明的 limitation。 */
export function coverageAllowsSupported(coverage: ProtocolCoverage | null): { ok: boolean; missing: ProtocolCoverageItem[] } {
  const missing = GATING_COVERAGE_ITEMS.filter((item) => {
    const e = coverage?.[item];
    if (!e) return true;
    if (e.result === 'pass') return false;
    return !(e.result === 'limitation' && typeof e.note === 'string' && e.note.trim() !== '');
  });
  return { ok: missing.length === 0, missing };
}

export interface CapabilityGateOptions {
  list: () => readonly CapabilityRecordInput[] | Promise<readonly CapabilityRecordInput[]>;
  currentContext: () => Promise<CapabilityContext>;
}

export interface ExtendedCapabilityGate extends CapabilityGate {
  /** 有效状态不能是 unverified（supported 或带影响记录的 unsupported 均可）。 */
  requireMeasured(keys: readonly CapabilityKey[]): Promise<void>;
  views(): Promise<CapabilityView[]>;
}

function missingError(views: CapabilityView[], keys: readonly CapabilityKey[], suffix: string): SfeError {
  const items = views.filter((v) => keys.includes(v.key));
  return new SfeError('CAPABILITY_UNVERIFIED', `执行失败：${items.map((v) => v.label).join('、')}${suffix}`, {
    details: { missing: items.map((v) => ({ key: v.key, staleReasons: v.staleReasons })) },
  });
}

export function createCapabilityGate(opts: CapabilityGateOptions): ExtendedCapabilityGate {
  const views = async (): Promise<CapabilityView[]> => computeCapabilityViews(await opts.list(), await opts.currentContext());
  const missing = async (keys: readonly CapabilityKey[]): Promise<CapabilityKey[]> => {
    const v = await views();
    return keys.filter((k) => v.find((x) => x.key === k)?.effectiveStatus !== 'supported');
  };
  return {
    views,
    missing,
    async require(keys) {
      const v = await views();
      const miss = keys.filter((k) => v.find((x) => x.key === k)?.effectiveStatus !== 'supported');
      if (miss.length > 0) throw missingError(v, miss, '尚未通过实测');
    },
    async requireMeasured(keys) {
      const v = await views();
      const miss = keys.filter((k) => (v.find((x) => x.key === k)?.effectiveStatus ?? 'unverified') === 'unverified');
      if (miss.length > 0) throw missingError(v, miss, '尚未实测');
    },
  };
}
