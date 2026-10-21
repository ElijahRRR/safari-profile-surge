// 能力门槛在界面上的计算：只看服务端给出的有效结论（effectiveStatus），从不提供“忽略/仍然执行”。
// 门槛不满足时按钮禁用并列出缺失的能力；服务端仍会再次拒绝。

import {
  CAPABILITY_GATES,
  CAPABILITY_KEYS,
  CAPABILITY_LABELS,
  CAPABILITY_MEASURED_GATES,
  GATING_COVERAGE_ITEMS,
  type CapabilityKey,
  type CapabilityProposalView,
  type CapabilityStatus,
  type CapabilityView,
  type EntryStrategy,
  type ProtocolCoverage,
} from '@sfe/contract';

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
