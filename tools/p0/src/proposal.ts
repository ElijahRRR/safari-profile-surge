// 能力提议的构造与校验（纯函数）。提议只携带上下文、脱敏摘要与原始证据摘要；确认只能在网页完成。
// 规则：supported 必须有通过的测量结果；测量后上下文变化必须重测；依赖工作配置身份的能力必须显式声明
// working-profile any（在测试配置上测得）；归属与 UDP 提议带逐协议覆盖（门槛项 + DNS/WebRTC/系统服务）；
// 归属提议带进程完整路径；入口模式提议带入口策略。声明的自动重载/接管方式/签名身份必须有测量证据：
// 具体值必须等于测量时的值；any 需要本能力在每个取值下都有同样结论的测量（自动重载开与关；接管 enhanced、
// system_proxy、both），且这些测量与当前上下文的其余依赖字段一致；任一取值下另有相反结论的测量（不论先后）即拒绝，
// 用作证据的测量写入摘要。依赖 Surge 版本/构建的能力在提议时与测量时都必须读到格式正确的版本，读不到即拒绝。
// 摘要不超过服务的 4000 字上限。

import {
  CAPABILITY_CONTEXT_DEPS,
  CAPABILITY_CRITERIA,
  type CapabilityContext,
  type CapabilityContextField,
  type CapabilityKey,
  type ProposeCapabilityRequest,
  type ProtocolCoverage,
  type ProtocolCoverageItem,
} from '@sfe/contract';
import { PROPOSAL_SUMMARY_MAX_CHARS } from './constants.js';
import { contextDrift, type ContextOverrides } from './context.js';
import { coverageAllowsSupported, validateSafariProcessPaths, versionContextErrors } from './deps.js';
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
  /** 本能力在本次运行中的全部历史测量结果（含当前结果）：声明 any 时检查每个取值下都有证据。 */
  history: readonly CapabilityResult[];
  note?: string | null;
  home?: string | null;
  exists?: (path: string) => boolean;
}

export function completeCoverage(c: ProtocolCoverage | undefined): ProtocolCoverage {
  const out: ProtocolCoverage = {};
  for (const item of ALL_COVERAGE_ITEMS) out[item] = c?.[item] ?? { result: 'not_tested', note: null };
  return out;
}

const AUTO_RELOAD_VALUES = ['on', 'off'] as const;
const TAKEOVER_VALUES = ['enhanced', 'system_proxy', 'both'] as const;
const AUTO_RELOAD_LABEL: Record<(typeof AUTO_RELOAD_VALUES)[number], string> = { on: '自动重载开', off: '自动重载关' };

/** 测量时的自动重载设置：refresh 的声明值，否则为测量时读到的值；读不到为 null。 */
export function measuredAutoReload(r: CapabilityResult): 'on' | 'off' | null {
  if (r.declaredAutoReload) return r.declaredAutoReload;
  return r.context.autoReload === 'on' || r.context.autoReload === 'off' ? r.context.autoReload : null;
}

/** 测量时读到的接管方式；读不到为 null。 */
export function measuredTakeover(r: CapabilityResult): (typeof TAKEOVER_VALUES)[number] | null {
  const t = r.context.takeoverMode;
  return t === 'enhanced' || t === 'system_proxy' || t === 'both' ? t : null;
}

interface AnyEvidence<T extends string> {
  /** 没有与提议同样结论的测量的取值。 */
  missing: T[];
  /** 有相反结论测量的取值（与先后无关）。 */
  conflicting: Array<{ value: T; at: string }>;
  /** 写入摘要：每个取值下用作证据的测量次数与最近时间。 */
  lines: string[];
}

/** 声明 any 时逐个取值核对本能力的测量：只看本能力、且其余依赖上下文与当前一致的测量。每个取值都要有与提议同样结论的
 * 测量，且不能有相反结论的测量——不论先后（例如先用较短等待得到“通过”、再用较长等待观察到重新读取；或反过来，
 * 观察到失败后重测时没看到）：矛盾时以更严格的结论为准，拒绝 any。 */
function anyEvidence<T extends string>(input: ProposalInput, values: readonly T[], measured: (r: CapabilityResult) => T | null, declared: ReadonlySet<string>, label: (v: T) => string): AnyEvidence<T> {
  const agrees = (r: CapabilityResult): boolean => (input.status === 'supported' ? r.verdict === 'pass' : r.verdict !== 'pass');
  const opposes = (r: CapabilityResult): boolean => (input.status === 'supported' ? r.verdict === 'fail' : r.verdict === 'pass');
  const sameContext = (r: CapabilityResult): boolean => contextDrift(input.key, r.context, input.current).every((f: CapabilityContextField) => declared.has(f));
  const relevant = input.history.filter((r) => r.key === input.key && sameContext(r));
  const out: AnyEvidence<T> = { missing: [], conflicting: [], lines: [] };
  for (const v of values) {
    const under = relevant.filter((r) => measured(r) === v);
    const ok = under.filter(agrees);
    const bad = under.filter(opposes);
    if (ok.length === 0) out.missing.push(v);
    if (bad.length > 0) out.conflicting.push({ value: v, at: bad.map((r) => r.at).sort().at(-1)! });
    if (ok.length > 0) out.lines.push(`${label(v)} ${ok.length} 次（最近 ${ok.map((r) => r.at).sort().at(-1)!}）`);
  }
  return out;
}

/** any 声明的证据核对结果转成拒绝（缺少或矛盾）或摘要行。 */
function requireAnyEvidence<T extends string>(flag: string, want: string, ev: AnyEvidence<T>, label: (v: T) => string, conclusion: string, opposite: string): string {
  if (ev.missing.length > 0) throw refused(`生成提议失败：${flag} any 需要${want}下本能力的测量${conclusion}（缺少：${ev.missing.map(label).join('、')}）`);
  if (ev.conflicting.length > 0) {
    throw refused(`生成提议失败：${flag} any 的证据有矛盾：${ev.conflicting.map((c) => `${label(c.value)}：另有${opposite}的测量（测量于 ${c.at}）`).join('；')}。以更严格的结论为准，先查明原因并重测`);
  }
  return `${flag} any 的证据（本能力、其余上下文与当前一致，没有相反结论）：${ev.lines.join('、')}`;
}

export function buildProposal(input: ProposalInput): ProposeCapabilityRequest {
  const { key, status, result } = input;
  if (!result) throw refused(`生成提议失败：本次运行没有 ${key} 的测量结果，请先运行对应的测试命令或检查清单`);
  if (status === 'supported' && result.verdict !== 'pass') throw refused(`生成提议失败：测量结论为「${verdictLabel(result.verdict)}」，不能提议支持`);
  if (status === 'unsupported' && result.verdict === 'pass') throw refused('生成提议失败：测量结论为「通过」，不能提议不支持');
  // 依赖 Surge 版本/构建的能力：提议时与测量时都必须读到格式正确的具体版本（与服务端同一校验）。读不到版本的
  // 记录在服务端永远不会生效（版本读不到即待验证），服务端也会以 EVIDENCE_REQUIRED 拒绝；先于漂移检查，
  // 避免把“读不到”说成“已变化”。
  const currentVersionErrors = versionContextErrors(key, input.current);
  if (currentVersionErrors.length > 0) {
    throw refused(`生成提议失败：${currentVersionErrors.map((e) => e.message).join('；')}。请在能读取运行中 Surge 的版本与构建号后重测`);
  }
  const measuredVersionErrors = versionContextErrors(key, result.context);
  if (measuredVersionErrors.length > 0) {
    throw refused(`生成提议失败：测量时（${result.at}）${measuredVersionErrors.map((e) => e.message).join('；')}。请重测`);
  }
  const deps = CAPABILITY_CONTEXT_DEPS[key];
  const overrides = input.overrides;
  const declared = new Set(Object.entries(overrides).filter(([, v]) => v !== undefined).map(([k]) => k));
  const conclusion = status === 'supported' ? '都已通过' : '都得到同样的结论';
  const opposite = status === 'supported' ? '不通过' : '通过';
  const evidenceLines: string[] = [];

  // 声明与限制：每个声明都必须有测量证据，否则拒绝（不能用声明绕过测量或漂移检查）。
  if (deps.includes('workingProfileId') && overrides.workingProfileId !== 'any') {
    throw refused('生成提议失败：该能力依赖工作配置身份。P0 在测试配置上测得，请显式加上 --working-profile any（确认后适用于初始化生成的工作配置）');
  }
  if (overrides.autoReload === 'any') {
    const label = (v: (typeof AUTO_RELOAD_VALUES)[number]): string => AUTO_RELOAD_LABEL[v];
    const ev = anyEvidence(input, AUTO_RELOAD_VALUES, measuredAutoReload, declared, label);
    evidenceLines.push(requireAnyEvidence('--auto-reload', '自动重载开、关两种设置', ev, label, conclusion, opposite));
  } else if (overrides.autoReload) {
    const m = measuredAutoReload(result);
    if (m === null) throw refused('生成提议失败：测量时没有记录自动重载设置，不能声明 --auto-reload on|off（不声明时记录测量时读到的值）');
    if (m !== overrides.autoReload) throw refused('生成提议失败：声明的自动重载设置与测量时不一致');
  }
  if (overrides.takeoverMode === 'any') {
    const label = (v: string): string => v;
    const ev = anyEvidence(input, TAKEOVER_VALUES, measuredTakeover, declared, label);
    evidenceLines.push(requireAnyEvidence('--takeover', ' enhanced、system_proxy、both 三种接管方式', ev, label, conclusion, opposite));
  } else if (overrides.takeoverMode) {
    const m = measuredTakeover(result);
    if (m === null) throw refused('生成提议失败：测量时读不到接管方式，不能声明 --takeover（不声明时记录测量时读到的值）');
    if (m !== overrides.takeoverMode) throw refused('生成提议失败：声明的接管方式与测量时不一致');
  }
  if (overrides.signingIdentity && result.context.signingIdentity !== null && result.context.signingIdentity !== overrides.signingIdentity) {
    throw refused('生成提议失败：声明的签名身份与测量时不一致');
  }
  const context: CapabilityContext = {
    ...input.current,
    ...(overrides.workingProfileId ? { workingProfileId: overrides.workingProfileId } : {}),
    ...(overrides.autoReload ? { autoReload: overrides.autoReload } : {}),
    ...(overrides.takeoverMode ? { takeoverMode: overrides.takeoverMode } : {}),
    ...(overrides.signingIdentity ? { signingIdentity: overrides.signingIdentity } : {}),
  };
  // 测量后上下文变化（例如中途升级）→ 重测。比较的是同一来源测得的两次值；显式声明的字段已在上面对照测量证据，
  // 这里不再比较（声明的值就是记录的值）。
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
        ...evidenceLines,
        ...(context.workingProfileId === 'any' ? ['工作配置身份记为 any：在 P0 测试配置（源配置副本）上测得'] : []),
        ...(input.note ? [`操作员说明：${input.note}`] : []),
      ],
      { home: input.home ?? null },
      PROPOSAL_SUMMARY_MAX_CHARS,
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
