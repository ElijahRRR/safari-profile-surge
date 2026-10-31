// 两种入口策略共用的判断：按本应用入口规则在有效规则中的实际顺序求“语义模式”，`rule match` 运行时探测与其判断，
// 以及失败时附带最后确认状态的错误。

import { ENTRY_MODE_BITS, ENTRY_PROBE_IPV4, ROUTE_GROUP_NAME, SfeError, type EntryBits, type EntryMode, type ErrorCode, type KnownEntryMode, type PrecedenceIssue } from '@sfe/contract';
import type { EntryStep, ProfileFiles, SurgeAdapter, SurgeRuleMatchInput } from '../../ports.js';
import type { EntryBit, TempEntryKind } from '../generate.js';
import { REJECT_POLICIES, normalizeRuleText, parseRule } from '../rules.js';
import type { EntryOwnership } from './ownership.js';

export type Outcome = 'pass' | 'reject' | 'route';

/** 四类 Safari 流量各自的结果：TCP/UDP × 检测主机/其他主机。 */
export interface EntrySemantic {
  tcpVerify: Outcome;
  tcpOther: Outcome;
  udpVerify: Outcome;
  udpOther: Outcome;
}

export type EntryClass = keyof EntrySemantic;
export const ENTRY_CLASSES: readonly EntryClass[] = ['tcpVerify', 'tcpOther', 'udpVerify', 'udpOther'];

const BIT_OUTCOME: Record<EntryBit, Outcome> = { udp: 'reject', verify: 'route', block: 'reject', active: 'route' };

function classIsUdp(c: EntryClass): boolean {
  return c === 'udpVerify' || c === 'udpOther';
}
function classIsVerify(c: EntryClass): boolean {
  return c === 'tcpVerify' || c === 'udpVerify';
}

/** ruleset_resource 的位（规则集文件内容）覆盖的流量类别。 */
export function bitCovers(bit: EntryBit, c: EntryClass): boolean {
  if (bit === 'udp') return classIsUdp(c);
  if (bit === 'verify') return classIsVerify(c);
  return true;
}

/** 按入口规则的实际先后顺序（只含已出现的位）求每类流量的结果。 */
export function semanticOfOrder(order: readonly EntryBit[]): EntrySemantic {
  const first = (c: EntryClass): Outcome => {
    const bit = order.find((b) => bitCovers(b, c));
    return bit ? BIT_OUTCOME[bit] : 'pass';
  };
  return { tcpVerify: first('tcpVerify'), tcpOther: first('tcpOther'), udpVerify: first('udpVerify'), udpOther: first('udpOther') };
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

// ---------- temp_rule 的五种规则（generate.ts tempRuleText） ----------

/** 每种临时规则覆盖的流量类别与结果（条件见 generate.ts 的表）。 */
export const TEMP_KIND_COVER: Record<TempEntryKind, { classes: readonly EntryClass[]; outcome: Outcome }> = {
  block: { classes: ENTRY_CLASSES, outcome: 'reject' },
  udp: { classes: ['udpVerify', 'udpOther'], outcome: 'reject' },
  verify: { classes: ['tcpVerify'], outcome: 'route' },
  active: { classes: ['tcpVerify', 'tcpOther'], outcome: 'route' },
  blockOther: { classes: ['tcpOther'], outcome: 'reject' },
};

/** 每类流量命中的第一条本应用临时规则（按实际先后）；都不命中为 null。 */
export function firstKindFor(order: readonly TempEntryKind[], c: EntryClass): TempEntryKind | null {
  return order.find((k) => TEMP_KIND_COVER[k].classes.includes(c)) ?? null;
}

/** 按临时规则的实际先后求每类流量的结果。 */
export function semanticOfKinds(order: readonly TempEntryKind[]): EntrySemantic {
  const out = (c: EntryClass): Outcome => {
    const k = firstKindFor(order, c);
    return k ? TEMP_KIND_COVER[k].outcome : 'pass';
  };
  return { tcpVerify: out('tcpVerify'), tcpOther: out('tcpOther'), udpVerify: out('udpVerify'), udpOther: out('udpOther') };
}

function permutations<T>(xs: readonly T[]): T[][] {
  if (xs.length <= 1) return [[...xs]];
  return xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));
}

/** 一组临时规则在任何先后下可能出现的模式（去重；含 null 表示某个先后下不对应任何模式）。 */
export function modesOfKindsAnyOrder(kinds: readonly TempEntryKind[]): Array<KnownEntryMode | null> {
  const out = new Set<KnownEntryMode | null>();
  for (const p of permutations(kinds)) out.add(modeOfSemantic(semanticOfKinds(p)));
  return [...out];
}

/** 一组临时规则不论先后都只对应同一个模式时返回它（与插入位置无关），否则为 null。 */
export function orderIndependentMode(kinds: readonly TempEntryKind[]): KnownEntryMode | null {
  const modes = modesOfKindsAnyOrder(kinds);
  return modes.length === 1 ? modes[0]! : null;
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
export function withLastConfirmed(e: unknown, lastConfirmedBits: EntryBits | null, step: Pick<EntryStep, 'bit' | 'value'> | null): SfeError {
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
  /**
   * 对照进程路径（rule match 的 process-path）：必须永远不命中本应用入口规则。缺省为 Chrome 的标准路径
   * （CONTROL_PROCESS_PATH；rule match 只是求值，不要求该进程存在）。
   */
  controlProcessPaths?: string[];
}

export interface EntryStrategyDeps {
  adapter: SurgeAdapter;
  /** ruleset_resource 必需；带 digestContent 时意图记录写入目标内容的摘要。 */
  files?: ProfileFiles & { digestContent?: (content: string) => string };
  ownership: EntryOwnership;
  config: () => EntryConfig;
  operationId: () => string | null;
}

// ---------- 运行时探测（rule match） ----------

/** 对照：Chrome 的标准可执行路径。Chrome 永远不应被 Safari 规则命中。 */
export const CONTROL_PROCESS_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
/**
 * 没有站点主机时，“其他主机”类别用的合成主机：文档地址 IP 字面量（contract ENTRY_PROBE_IPV4，RFC 5737）。不用合成域名：
 * 求值走到用户的 IP 规则时会对域名做 DNS 查询，“If the DNS lookup fails, rule evaluation aborts and the request fails with
 * a DNS error”（https://manual.nssurge.com/rules/ip.html）——2026-10-24 测试 Mac 上 `.invalid` 主机的 rule match 退出 1。
 * IP 字面量不查询 DNS（“If the request targets an IP literal, the rule matches it directly”）。对 temp_rule 而言它照样是
 * “其他主机”：NOT(DOMAIN,检测主机) 对 IP 字面量成立。检测主机与站点主机是真实域名，保留：它们用来发现遮住这些域名的用户规则。
 */
export const ENTRY_PROBE_OTHER_HOST = ENTRY_PROBE_IPV4;

/**
 * 一次 `rule match <host> process-path=<path> protocol=<TCP|UDP> dest-port=443`（Mac 6.9.0+，协议 ≥20）：
 * CLI 帮助：“Evaluate the active rule set without creating a connection, then show the matched rule and final policy.”；
 * “process-path=<path> Source process path; affects PROCESS-NAME rules”；“protocol=<name> Protocol, such as TCP, UDP, HTTP, HTTPS, QUIC, or STUN”。
 * TODO(P0)：rule match 是否包含临时规则、命中规则集时 rule 字段是 RULE-SET 行还是子规则、“final policy” 是组名还是组内选择——
 * 下面的识别对这些写法都接受；都不符合时按不一致处理（失败即关闭）。
 */
export interface RuntimeProbe {
  processPath: string;
  host: string;
  protocol: 'TCP' | 'UDP';
  /** Safari 流量类别；对照（Chrome）探测为 null。 */
  cls: EntryClass | null;
}

/**
 * Safari 每个进程路径 × {检测主机, 其他主机} × {TCP, UDP}，加上对照路径的同样四个组合。其他主机：第一个不同于检测主机的
 * 站点主机，没有时为 ENTRY_PROBE_OTHER_HOST（文档地址 IP 字面量）。
 */
export function runtimeProbes(cfg: EntryConfig): RuntimeProbe[] {
  const verify = cfg.verifyHost;
  const other = cfg.siteHosts.find((h) => typeof h === 'string' && h.length > 0 && h.toLowerCase() !== verify.toLowerCase()) ?? ENTRY_PROBE_OTHER_HOST;
  const controls = (cfg.controlProcessPaths ?? [CONTROL_PROCESS_PATH]).filter((p) => !cfg.processPaths.includes(p));
  const out: RuntimeProbe[] = [];
  const add = (processPath: string, safari: boolean): void => {
    for (const [host, isVerify] of [
      [verify, true],
      [other, false],
    ] as const) {
      for (const protocol of ['TCP', 'UDP'] as const) {
        const cls: EntryClass = protocol === 'UDP' ? (isVerify ? 'udpVerify' : 'udpOther') : isVerify ? 'tcpVerify' : 'tcpOther';
        out.push({ processPath, host, protocol, cls: safari ? cls : null });
      }
    }
  };
  for (const p of cfg.processPaths) add(p, true);
  for (const p of controls) add(p, false);
  return out;
}

/** 本应用规则的识别结果：id 为种类/位，outcome 为该规则的结果。 */
export interface ProbeIdentity {
  id: string;
  outcome: Outcome;
}

export interface ProbeResult {
  probe: RuntimeProbe;
  rule: string;
  policy: string;
  /** 命中的是本应用哪条入口规则；不是本应用的为 null。 */
  ours: ProbeIdentity | null;
}

/** 依次执行探测（只读）；任何一次失败都抛出（调用方按“无法读回”处理）。 */
export async function runProbes(
  adapter: SurgeAdapter,
  probes: readonly RuntimeProbe[],
  identify: (rule: string, policy: string) => ProbeIdentity | null,
): Promise<ProbeResult[]> {
  const out: ProbeResult[] = [];
  for (const probe of probes) {
    const input: SurgeRuleMatchInput = { host: probe.host, processPath: probe.processPath, protocol: probe.protocol, port: 443 };
    const r = await adapter.matchRule(input);
    out.push({ probe, rule: r.rule, policy: r.policy, ours: identify(r.rule, r.policy) });
  }
  return out;
}

/** 规则文本去掉末尾策略（“…,POLICY” → “…”）。 */
function withoutPolicy(text: string): string | null {
  const p = parseRule(text);
  if (!p || p.policy === null) return null;
  const n = normalizeRuleText(text);
  const i = n.lastIndexOf(',');
  return i > 0 ? n.slice(0, i) : null;
}

/** rule match 回显的规则文本是否就是 text（允许带或不带策略、空白不同）。 */
export function sameRuleText(observed: string, text: string): boolean {
  const o = normalizeRuleText(observed);
  const t = normalizeRuleText(text);
  return o === t || o === withoutPolicy(t) || withoutPolicy(o) === t;
}

/**
 * 策略与本应用规则的结果一致：REJECT 类规则的最终策略必须是 REJECT 类；SFE-ROUTE 规则的“final policy”可能是组名、
 * 组内选择的本应用节点（SFE- 前缀），或组的首成员 REJECT（未选择时），都算经本应用路由组。TODO(P0)：核对实际回显。
 */
export function policyFits(outcome: Outcome, policy: string): boolean {
  const p = policy.trim();
  if (outcome === 'reject') return REJECT_POLICIES.has(p.toUpperCase());
  if (outcome === 'route') return p === ROUTE_GROUP_NAME || /^SFE-/.test(p) || REJECT_POLICIES.has(p.toUpperCase());
  return false;
}

/** 已知的优先级问题中与命中规则相同的一条。 */
function issueFor(rule: string, issues: readonly PrecedenceIssue[]): PrecedenceIssue | null {
  return issues.find((i) => sameRuleText(rule, i.rule)) ?? null;
}

export interface ProbeJudgement {
  /** Safari 探测都与本应用规则的预期一致（被已知的 REJECT 类优先级规则遮住的算一致），对照探测没有命中本应用规则。 */
  ok: boolean;
  /** Safari 探测命中了排在入口之前、可能放行的已知规则（优先级问题：读回不能宣称受控，但不是运行时与预期不一致）。 */
  shadowedByBlocking: boolean;
  /** 对照（Chrome）探测命中了本应用入口规则或 SFE-ROUTE。 */
  controlHit: boolean;
  /**
   * rule match 读取失败（超时、不可达、命令不被支持或原语未映射），不是求值与预期不一致：ok 为 false。撤销本应用入口
   * （普通模式、回滚）只把它记作证据，不因此停止（用户决定 D5、D6：进入普通模式永远可用，不依赖未经验证的原语；docs/ARCHITECTURE.md §0）。
   */
  readFailed?: boolean;
  /** 读取失败的原因是 rule match 在当前 Surge 上不可用（isRuleMatchUnavailable），而不是超时等结果未知的失败。 */
  ruleMatchUnavailable?: boolean;
  evidence: string[];
}

/** rule match 读取失败时的判断：失败即关闭（ok 为 false），并标明是读不到而不是不一致。错误原文不进入证据。 */
export function probeReadFailure(e: unknown): ProbeJudgement {
  const code = e instanceof SfeError ? e.code : 'INTERNAL';
  const unavailable = isRuleMatchUnavailable(e);
  return {
    ok: false,
    shadowedByBlocking: false,
    controlHit: false,
    readFailed: true,
    ...(unavailable ? { ruleMatchUnavailable: true } : {}),
    evidence: [unavailable ? `规则求值不可用（${code}：rule match 未映射或当前 Surge 不支持）：无法确认运行时入口规则` : `规则求值读回失败（${code}）：无法确认运行时入口规则`],
  };
}

/**
 * rule match 在当前 Surge 上不可用：原语未映射（安装配置中没有 matchRule，CAPABILITY_UNVERIFIED），或 Surge 回答
 * Unknown command（`rule match` 是 Mac 6.9.0+、协议 ≥20 的命令；随包技能：“An older core answers `Unknown command`”），
 * 或命令行工具进入交互模式。超时等其他读取失败不算（结果未知，照常失败即关闭）。
 */
export function isRuleMatchUnavailable(e: unknown): boolean {
  if (!(e instanceof SfeError)) return false;
  const primitive = e.details?.primitive;
  if (primitive !== undefined && primitive !== 'matchRule') return false;
  if (e.code === 'CAPABILITY_UNVERIFIED') return primitive === 'matchRule';
  const reason = e.code === 'SURGE_COMMAND_FAILED' ? e.details?.reason : undefined;
  return reason === 'unsupported_command' || reason === 'interactive_mode';
}

const CLASS_LABEL: Record<EntryClass, string> = { tcpVerify: '检测主机 TCP', tcpOther: '其他主机 TCP', udpVerify: '检测主机 UDP', udpOther: '其他主机 UDP' };

/**
 * 判断探测结果。expected(cls) 给出该类流量可以接受的命中（本应用规则的 id，或 null 表示不应命中本应用规则）；
 * 有多种可能时（例如某一位已加载的内容尚未确认）任一即可。
 */
export function judgeProbes(
  results: readonly ProbeResult[],
  expected: (cls: EntryClass) => ReadonlyArray<string | null>,
  issues: readonly PrecedenceIssue[],
): ProbeJudgement {
  const evidence: string[] = [];
  let ok = true;
  let shadowedByBlocking = false;
  let controlHit = false;
  for (const r of results) {
    if (r.probe.cls === null) {
      if (r.ours !== null || r.policy.trim() === ROUTE_GROUP_NAME) {
        controlHit = true;
        ok = false;
        evidence.push(`规则求值：对照进程（${r.probe.protocol}）命中了本应用入口规则或 ${ROUTE_GROUP_NAME}`);
      }
      continue;
    }
    const want = expected(r.probe.cls);
    const label = `${CLASS_LABEL[r.probe.cls]}`;
    if (r.ours !== null) {
      if (!want.includes(r.ours.id)) {
        ok = false;
        evidence.push(`规则求值不一致：Safari ${label} 命中本应用 ${r.ours.id}，预期 ${want.map((w) => w ?? '不命中本应用规则').join(' 或 ')}`);
      }
      continue;
    }
    if (want.includes(null)) continue;
    const issue = issueFor(r.rule, issues);
    if (issue?.severity === 'warning') continue;
    if (issue?.severity === 'blocking') {
      shadowedByBlocking = true;
      evidence.push(`规则求值：Safari ${label} 先命中排在入口之前的规则`);
      continue;
    }
    ok = false;
    evidence.push(`规则求值不一致：Safari ${label} 没有命中本应用入口规则（命中「${r.rule}」，策略 ${r.policy}）`);
  }
  return { ok, shadowedByBlocking, controlHit, evidence };
}
