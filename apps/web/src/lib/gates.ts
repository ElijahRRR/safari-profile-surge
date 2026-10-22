// 能力门槛在界面上的计算：只看服务端给出的有效结论（effectiveStatus），从不提供“忽略/仍然执行”。
// 门槛不满足时按钮禁用并列出缺失的能力；服务端仍会再次拒绝。

import {
  CAPABILITY_CONTEXT_DEPS,
  CAPABILITY_GATES,
  CAPABILITY_KEYS,
  CAPABILITY_LABELS,
  CAPABILITY_MEASURED_GATES,
  GATING_COVERAGE_ITEMS,
  SURGE_BUILD_RE,
  SURGE_VERSION_RE,
  type CapabilityContextField,
  type CapabilityKey,
  type CapabilityProposalView,
  type CapabilityStatus,
  type CapabilityView,
  type EntryStrategy,
  type ProtocolCoverage,
  type SurgeStatusView,
} from '@sfe/contract';
import { CONTEXT_FIELD_LABELS } from './labels';

export type GateName = keyof typeof CAPABILITY_GATES;

export const GATE_LABELS: Record<GateName, string> = {
  publish: '发布节点',
  activate: '切换环境',
  activateRulesetStrategy: '规则集入口策略',
  killSafariConnections: '结束 Safari 旧连接',
  bind: '场景绑定',
  fillAndAutoOpen: '登录填充与自动打开订单',
  preflight: '候选节点独立预检',
  maintenanceWrite: '维护写入工作配置',
};

/** 概览里展示的门槛（activateRulesetStrategy 并入「切换环境」）。 */
export const SUMMARY_GATES: GateName[] = ['publish', 'activate', 'killSafariConnections', 'bind', 'fillAndAutoOpen', 'preflight', 'maintenanceWrite'];

export interface MissingCapability {
  key: CapabilityKey;
  label: string;
  status: CapabilityStatus;
  /** 已测量门槛只要求“不是待验证”。 */
  measured?: boolean;
}

export interface GateResult {
  met: boolean;
  missing: MissingCapability[];
}

function effectiveOf(caps: readonly CapabilityView[], key: CapabilityKey): CapabilityStatus {
  return caps.find((c) => c.key === key)?.effectiveStatus ?? 'unverified';
}

export function evaluateGate(caps: readonly CapabilityView[], gate: GateName, entryStrategy: EntryStrategy | null = null): GateResult {
  const keys: CapabilityKey[] = [...CAPABILITY_GATES[gate]];
  if (gate === 'activate' && entryStrategy === 'ruleset_resource') keys.push(...CAPABILITY_GATES.activateRulesetStrategy);
  const missing: MissingCapability[] = [];
  for (const key of new Set(keys)) {
    const status = effectiveOf(caps, key);
    if (status !== 'supported') missing.push({ key, label: CAPABILITY_LABELS[key], status });
  }
  if (gate === 'maintenanceWrite') {
    for (const key of CAPABILITY_MEASURED_GATES.maintenanceWrite) {
      const status = effectiveOf(caps, key);
      if (status === 'unverified') missing.push({ key, label: CAPABILITY_LABELS[key], status, measured: true });
    }
  }
  return { met: missing.length === 0, missing };
}

export function capabilityCounts(caps: readonly CapabilityView[]): Record<CapabilityStatus, number> {
  const counts: Record<CapabilityStatus, number> = { supported: 0, unsupported: 0, unverified: 0 };
  for (const key of CAPABILITY_KEYS) counts[effectiveOf(caps, key)]++;
  return counts;
}

/** 补齐服务端没有返回的能力（视为待验证），按契约顺序排列。 */
export function allCapabilities(caps: readonly CapabilityView[]): CapabilityView[] {
  return CAPABILITY_KEYS.map(
    (key) =>
      caps.find((c) => c.key === key) ?? {
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
      },
  );
}

export const COVERAGE_REQUIRED_KEYS: readonly CapabilityKey[] = ['safari_process_attribution', 'safari_udp_quic_handling'];

/**
 * 逐协议覆盖是否足以确认提议。返回不能确认的原因，可以确认时返回 null。
 * 两项能力的提议都必须带覆盖；确认为“已通过”时每个门槛协议项必须通过，或写明限制。
 */
export function coverageBlockReason(proposal: Pick<CapabilityProposalView, 'key' | 'proposedStatus' | 'protocolCoverage'>): string | null {
  if (!COVERAGE_REQUIRED_KEYS.includes(proposal.key)) return null;
  const coverage: ProtocolCoverage | null = proposal.protocolCoverage;
  if (!coverage) return '缺少逐协议覆盖记录，不能确认';
  if (proposal.proposedStatus !== 'supported') return null;
  const incomplete = GATING_COVERAGE_ITEMS.filter((item) => {
    const entry = coverage[item];
    if (!entry) return true;
    if (entry.result === 'pass') return false;
    return !(entry.result === 'limitation' && entry.note !== null && entry.note.trim() !== '');
  });
  if (incomplete.length === 0) return null;
  return `逐协议覆盖不完整：${incomplete.length} 项未通过或未写明限制`;
}

/**
 * Surge 版本与构建：服务端比较时任一侧为 null 都不匹配（读不到版本即待验证，记录为 null 或 any 也不例外）。
 * 值为 Surge 状态里对应的当前值字段（与能力上下文同一来源）。
 */
const VERSION_FIELDS: Partial<Record<CapabilityContextField, 'version' | 'build'>> = { surgeVersion: 'version', surgeBuild: 'build' };

function fieldList(fields: readonly CapabilityContextField[]): string {
  return fields.map((f) => CONTEXT_FIELD_LABELS[f] ?? f).join('、');
}

/**
 * 提议中的 Surge 版本与构建能否确认（与服务端确认时的 versionContextErrors 同一规则）：该能力依赖版本或构建时，上下文
 * 必须带格式正确的具体值；null（读不到）、any 或格式不对（例如旧解析器取到的 127.0.0.1）都不能确认，服务端同样拒绝。
 * 可以确认时返回 null。
 */
export function versionBlockReason(proposal: Pick<CapabilityProposalView, 'key' | 'context'>): string | null {
  const deps = CAPABILITY_CONTEXT_DEPS[proposal.key] ?? [];
  const checks: Array<[CapabilityContextField, RegExp]> = [
    ['surgeVersion', SURGE_VERSION_RE],
    ['surgeBuild', SURGE_BUILD_RE],
  ];
  const bad: CapabilityContextField[] = [];
  for (const [field, re] of checks) {
    if (!deps.includes(field)) continue;
    const v: unknown = proposal.context?.[field];
    if (typeof v !== 'string' || !re.test(v)) bad.push(field);
  }
  if (bad.length === 0) return null;
  return `提议中的 ${fieldList(bad)}读不到或格式不正确，不能确认；请在能读取运行中 Surge 的版本后重测并重新提议`;
}

/**
 * 过期原因的说明。版本字段区分三种情况，不把“读不到”说成“已变化”：当前读不到 Surge 版本（依赖版本的能力一律
 * 按待验证处理，重测之前要先能读到版本）；验证记录没有版本（需要重测）；确实变了。其他字段沿用“已变化”。
 * surge 为 null（尚未拿到状态）时版本字段只说“与当前不一致”。
 */
export function staleReasonText(cap: Pick<CapabilityView, 'staleReasons' | 'context'>, surge: Pick<SurgeStatusView, 'version' | 'build'> | null): string {
  if (cap.staleReasons.length === 0) return '';
  if (!cap.context) return '没有验证上下文，需要重测';
  const changed: CapabilityContextField[] = [];
  const unreadable: CapabilityContextField[] = [];
  const missing: CapabilityContextField[] = [];
  const unknown: CapabilityContextField[] = [];
  for (const f of cap.staleReasons) {
    const statusKey = VERSION_FIELDS[f];
    if (!statusKey) changed.push(f);
    else if (!surge) unknown.push(f);
    else if (surge[statusKey] === null) unreadable.push(f);
    else if (cap.context[f] === null) missing.push(f);
    else changed.push(f);
  }
  const parts: string[] = [];
  if (unreadable.length) parts.push(`读不到当前的 ${fieldList(unreadable)}，依赖版本的能力按待验证处理`);
  if (missing.length) parts.push(`验证记录缺少 ${fieldList(missing)}，需要重测`);
  if (unknown.length) parts.push(`${fieldList(unknown)}与当前不一致`);
  if (changed.length) parts.push(`${fieldList(changed)}已变化`);
  return parts.join('；');
}
