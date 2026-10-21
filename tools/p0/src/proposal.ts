// 能力提议的构造与校验（纯函数）。提议只携带上下文、脱敏摘要与原始证据摘要；确认只能在网页完成。
// 规则：supported 必须有通过的测量结果；测量后上下文变化必须重测；依赖工作配置身份的能力必须显式声明
// working-profile any（在测试配置上测得）；归属与 UDP 提议带逐协议覆盖（门槛项 + DNS/WebRTC/系统服务）；
// 归属提议带进程完整路径；入口模式提议带入口策略；自动重载条件 any 需要开、关两种设置下都已通过。

import {
  CAPABILITY_CONTEXT_DEPS,
  CAPABILITY_CRITERIA,
  type CapabilityContext,
  type CapabilityKey,
  type ProposeCapabilityRequest,
  type ProtocolCoverage,
  type ProtocolCoverageItem,
} from '@sfe/contract';
import { contextDrift, type ContextOverrides } from './context.js';
import { coverageAllowsSupported, validateSafariProcessPaths } from './deps.js';
import { refused } from './errors.js';
import { redactSummaryLines } from './redact.js';
import { verdictLabel, type CapabilityResult } from './results.js';

export const COVERAGE_KEYS: readonly CapabilityKey[] = ['safari_process_attribution', 'safari_udp_quic_handling'];
export const ALL_COVERAGE_ITEMS: readonly ProtocolCoverageItem[] = ['ipv4', 'ipv6', 'http1', 'http2', 'http3_quic', 'websocket', 'extension_page_fetch', 'webrtc', 'dns', 'system_services'];

export interface ProposalInput {
  key: CapabilityKey;
  status: 'supported' | 'unsupported';
  result: CapabilityResult | null;
  /** 提议时按服务同一来源测得的当前上下文（未应用声明）。 */
  current: CapabilityContext;
  overrides: ContextOverrides;
  evidenceDigest: string;
  runId: string;
  requestId: string;
  /** auto_reload_atomic_replace 在各声明设置下是否有通过的结果（来自历史结果）。 */
  autoReloadPassed: { on: boolean; off: boolean };
  note?: string | null;
  home?: string | null;
  exists?: (path: string) => boolean;
}

export function completeCoverage(c: ProtocolCoverage | undefined): ProtocolCoverage {
  const out: ProtocolCoverage = {};
  for (const item of ALL_COVERAGE_ITEMS) out[item] = c?.[item] ?? { result: 'not_tested', note: null };
  return out;
}

export function buildProposal(input: ProposalInput): ProposeCapabilityRequest {
  const { key, status, result } = input;
  if (!result) throw refused(`生成提议失败：本次运行没有 ${key} 的测量结果，请先运行对应的测试命令或检查清单`);
  if (status === 'supported' && result.verdict !== 'pass') throw refused(`生成提议失败：测量结论为「${verdictLabel(result.verdict)}」，不能提议支持`);
  if (status === 'unsupported' && result.verdict === 'pass') throw refused('生成提议失败：测量结论为「通过」，不能提议不支持');
  const deps = CAPABILITY_CONTEXT_DEPS[key];

  // 声明与限制。
  if (deps.includes('workingProfileId') && input.overrides.workingProfileId !== 'any') {
    throw refused('生成提议失败：该能力依赖工作配置身份。P0 在测试配置上测得，请显式加上 --working-profile any（确认后适用于初始化生成的工作配置）');
  }
  if (input.overrides.autoReload === 'any' && key === 'auto_reload_atomic_replace' && !(input.autoReloadPassed.on && input.autoReloadPassed.off)) {
    throw refused('生成提议失败：--auto-reload any 需要自动重载开、关两种设置下的 refresh 都已通过');
  }
  if (input.overrides.autoReload && input.overrides.autoReload !== 'any' && result.declaredAutoReload && result.declaredAutoReload !== input.overrides.autoReload) {
    throw refused('生成提议失败：声明的自动重载设置与测量时不一致');
  }
  const context: CapabilityContext = {
    ...input.current,
    ...(input.overrides.workingProfileId ? { workingProfileId: input.overrides.workingProfileId } : {}),
    ...(input.overrides.autoReload ? { autoReload: input.overrides.autoReload } : {}),
    ...(input.overrides.takeoverMode ? { takeoverMode: input.overrides.takeoverMode } : {}),
    ...(input.overrides.signingIdentity ? { signingIdentity: input.overrides.signingIdentity } : {}),
  };
  // 测量后上下文变化（例如中途升级）→ 重测。比较的是同一来源测得的两次值；显式声明的字段不比较。
  const declared = new Set(Object.entries(input.overrides).filter(([, v]) => v !== undefined).map(([k]) => k));
  const drift = contextDrift(key, result.context, input.current).filter((f) => !declared.has(f));
  if (drift.length > 0) throw refused(`生成提议失败：测量后这些上下文已变化：${drift.join('、')}，请重测`);
  if (deps.includes('signingIdentity') && !context.signingIdentity) throw refused('生成提议失败：读不到签名身份，请用 --signing-identity 提供宿主 App 的 Team ID');

  const req: ProposeCapabilityRequest = {
    request_id: input.requestId,
    key,
    proposed_status: status,
    context,
    summary: redactSummaryLines(
      [
        `P0 运行 ${input.runId} · 命令 ${result.command} · 结论 ${verdictLabel(result.verdict)} · 测量于 ${result.at}`,
        `通过条件：${CAPABILITY_CRITERIA[key]}`,
        ...result.checks.map((c) => `${c.ok === true ? '通过' : c.ok === false ? '不通过' : '未完成'} · ${c.name}${c.note ? `：${c.note}` : ''}`),
        ...result.summary.filter((l) => !l.startsWith('通过条件：')),
        ...(context.workingProfileId === 'any' ? ['工作配置身份记为 any：在 P0 测试配置（源配置副本）上测得'] : []),
        ...(input.note ? [`操作员说明：${input.note}`] : []),
      ],
      { home: input.home ?? null },
    ),
    evidence_digest: input.evidenceDigest,
  };
  if (COVERAGE_KEYS.includes(key)) {
    const coverage = completeCoverage(result.coverage);
    if (status === 'supported') {
      const g = coverageAllowsSupported(coverage);
      if (!g.ok) throw refused(`生成提议失败：门槛协议未全部通过或写明限制：${g.missing.join('、')}`);
    }
    req.protocol_coverage = coverage;
  }
  if (key === 'safari_process_attribution') {
    const paths = result.processPaths ?? [];
    if (status === 'supported') {
      const errs = validateSafariProcessPaths(paths, input.exists ? { exists: input.exists } : {});
      if (errs.length > 0) throw refused(`生成提议失败：进程路径不合格：${errs.map((e) => e.message).join('；')}`);
    }
    if (paths.length > 0) req.safari_process_paths = [...paths];
  }
  if (key === 'runtime_entry_modes') {
    if (!result.entryStrategy) throw refused('生成提议失败：入口模式提议必须带所验证的入口策略');
    req.entry_strategy = result.entryStrategy;
  }
  return req;
}
