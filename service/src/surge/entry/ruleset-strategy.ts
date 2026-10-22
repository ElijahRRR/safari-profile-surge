// ruleset_resource 入口策略：四个本地规则集文件（udp > verify > block > active，顺序固定在工作配置中）。
// 文档：本地规则集“Local files are watched and reloaded automatically when they change.”（规则集文档）；外部资源更新
// “Local resources are skipped.”（HTTP API 文档，Mac 6.10.0+）——所以从不对本地入口文件调用 updateExternalResource，
// 也从不把它当作刷新。每一步：读取自动重载设置并与实测条件比对 → 确认 Surge 中恰好一个资源指向该文件 → 比较并替换地
// 原子写入单个文件（带新的见证标记，期望上次摘要）→ 在有限时间内轮询 `rule match <见证主机>`，直到 Surge 已加载这一版
// 内容 → 有效规则顺序与 Safari/对照探测读回 → 确认归属，才进行下一步。超时按未知处理（不声称更宽松的状态）。
// 从不重载配置、更新全部或 flush。见 docs/ARCHITECTURE.md §5.5。

import { randomBytes } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ENTRY_MODE_BITS,
  ENTRY_PLACEHOLDER_RULE,
  ENTRY_RULESET_FILES,
  ENTRY_WITNESS_PROCESS_PATH,
  LEGACY_ENTRY_PLACEHOLDER_RULE,
  SfeError,
  type EntryBits,
  type KnownEntryMode,
  type PrecedenceIssue,
} from '@sfe/contract';
import type { EntryController, EntryReadback, EntryStep, ProfileFiles, SurgeExternalResource, SurgeRuleRecord } from '../../ports.js';
import type { EntryOwnedRecord } from './ownership.js';
import {
  ENTRY_BITS_IN_ORDER,
  ENTRY_BIT_POLICY,
  entryRuleSetFileContent,
  entryRules,
  entryWitnessHost,
  entryWitnessRule,
  parseEntryRuleSetFile,
  type EntryBit,
} from '../generate.js';
import { classifyPrecedence, hasBlockingIssue } from '../precedence.js';
import { normalizeRuleText, parseCondition, parseRule } from '../rules.js';
import {
  bitCovers,
  judgeProbes,
  isRuleMatchUnavailable,
  policyFits,
  probeReadFailure,
  runProbes,
  runtimeProbes,
  sameRuleText,
  stepFailure,
  withLastConfirmed,
  type EntryClass,
  type EntryConfig,
  type EntryStrategyDeps,
  type Outcome,
  type ProbeIdentity,
  type ProbeJudgement,
} from './common.js';
import { knownModeOfBits, planFromBits } from './plan.js';

export type AutoReloadCondition = 'on' | 'off' | 'any' | null;

/** 每一位“更宽松”的取值（已加载内容未确认时按它规划）。 */
const PERMISSIVE_SIDE: EntryBits = { udp: false, verify: true, block: false, active: true };

const BIT_OUTCOME: Record<EntryBit, Outcome> = { udp: 'reject', verify: 'route', block: 'reject', active: 'route' };

/**
 * 等待文件监视重新加载的缺省值（毫秒）。文档只说本地文件“are watched and reloaded automatically”，没有给出延迟：
 * TODO(P0)：按测试 Mac 上实测的监视延迟设定（能力记录 runtime_entry_modes / auto_reload_atomic_replace）。
 */
export const DEFAULT_RULESET_WATCH = { timeoutMs: 5000, pollMs: 200 } as const;

/**
 * 见证探测用的合成进程路径（contract 的 ENTRY_WITNESS_PROCESS_PATH）：不存在的可执行文件，见证规则与占位规则都限定它，
 * 所以只有见证探测命中，Safari、Chrome 与其他应用的真实请求都不会（DOMAIN 规则按主机名匹配、不做 DNS 查询，`.invalid`
 * 不解析并不能挡住真实请求，见 generate.ts）。排在入口之前、能命中它的规则会让见证一直读不到（超时，失败即关闭）。
 */
export const WITNESS_PROBE_PROCESS_PATH = ENTRY_WITNESS_PROCESS_PATH;

/** 关闭的位的占位规则（规范化）：当前格式与旧格式（不限定进程，只识别、从不写入）。 */
const LEGACY_PLACEHOLDER_N = normalizeRuleText(LEGACY_ENTRY_PLACEHOLDER_RULE);
const PLACEHOLDERS_N = [normalizeRuleText(ENTRY_PLACEHOLDER_RULE), LEGACY_PLACEHOLDER_N];

/** 仍带旧格式占位规则的位（旧版本写入、没有见证的文件；下一次切换按未知重写）。 */
function legacyPlaceholderBits(files: Record<EntryBit, { bodies: string[] }>): EntryBit[] {
  return ENTRY_BITS_IN_ORDER.filter((b) => files[b].bodies.includes(LEGACY_PLACEHOLDER_N));
}
/** 占位规则中的主机（对照探测：Chrome 请求它也不得命中入口规则或 SFE-ROUTE）。 */
const PLACEHOLDER_HOST = 'sfe-disabled.invalid';

export interface RulesetStrategyDeps extends EntryStrategyDeps {
  files: NonNullable<EntryStrategyDeps['files']>;
  /** 能力记录中验证时的自动重载条件；null 表示没有记录（拒绝写入）。 */
  autoReloadCondition: () => AutoReloadCondition | Promise<AutoReloadCondition>;
  /** 每一步等待文件监视重新加载的上限与轮询间隔（毫秒）；缺省 DEFAULT_RULESET_WATCH。 */
  watch?: { timeoutMs?: number; pollMs?: number };
  /** 测试注入：等待与时钟。 */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** 测试注入：每次写入的见证标记（缺省 8 位随机十六进制）。 */
  witnessToken?: () => string;
}

/** 某一位已加载内容的确认情况：confirmed 见证读回一致；stale 已加载的不是文件中的这一版；unwitnessed 文件没有见证；unread 无法读回。 */
type LoadedState = 'confirmed' | 'stale' | 'unwitnessed' | 'unread';

interface FileState {
  bit: EntryBit;
  name: string;
  path: string;
  value: boolean | null;
  digest: string | null;
  witness: string | null;
  /** 文件中的规则行（不含注释与见证行），用于识别 rule match 回显的子规则。 */
  bodies: string[];
}

interface RulesetState {
  cfg: EntryConfig;
  files: Record<EntryBit, FileState>;
  resources: SurgeExternalResource[];
  rules: SurgeRuleRecord[];
  issues: PrecedenceIssue[];
  bits: EntryBits | null;
  anomalies: string[];
  loaded: Record<EntryBit, LoadedState>;
  /** 已加载内容已知的位（见证确认；NORMAL 时没有见证的占位文件按文件内容并由探测核对）；未知为 null。 */
  known: Record<EntryBit, boolean | null>;
  /** Safari 与对照探测；文件内容无法识别时为 null。 */
  judgement: ProbeJudgement | null;
  /** rule match 在当前 Surge 上不可用（原语未映射、Unknown command）：见证与探测都读不到（isRuleMatchUnavailable）。 */
  ruleMatchUnavailable: boolean;
  /** 未确认的意图（pending_<位>）中，文件已是写入后内容（摘要等于意图的摘要，不是写前内容）的位。 */
  intentWritten: EntryBit[];
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * 初始化（maintenance.init）写入占位规则集文件后应登记的归属记录：四个文件，状态 present，带当前摘要。
 * 文件缺失时不登记（之后读回为 UNKNOWN）。
 */
export async function ownedRulesetRecords(files: ProfileFiles, operationId: string | null = null): Promise<EntryOwnedRecord[]> {
  const out: EntryOwnedRecord[] = [];
  for (const bit of ENTRY_BITS_IN_ORDER) {
    const name = ENTRY_RULESET_FILES[bit];
    const digest = await files.digest(name);
    if (digest !== null) out.push({ kind: 'entry_ruleset_file', identity: name, digest, state: 'present', operationId });
  }
  return out;
}

/** 每类流量在规则集先后（udp > verify > block > active）下命中的第一位；未知的位两种取值都考虑。 */
function acceptableFirstBits(known: Record<EntryBit, boolean | null>, c: EntryClass): Array<EntryBit | null> {
  const unknown = ENTRY_BITS_IN_ORDER.filter((b) => known[b] === null);
  const out = new Set<EntryBit | null>();
  for (let mask = 0; mask < 1 << unknown.length; mask++) {
    const value = (b: EntryBit): boolean => (known[b] === null ? (mask & (1 << unknown.indexOf(b))) !== 0 : known[b]!);
    out.add(ENTRY_BITS_IN_ORDER.find((b) => value(b) && bitCovers(b, c)) ?? null);
  }
  return [...out];
}

/**
 * 撤销本应用入口（普通模式、回滚；目标 BLOCKED/NORMAL）时 rule match 不可用的退路：原语未映射（安装配置早于 matchRule、
 * HTTP 没有对应接口）或 Surge 低于 Mac 6.9.0 回答 Unknown command（例如降级之后，入口文件仍在、Surge 启动时已加载）。
 * 用户决定 1 要求进入普通模式永远可用，而见证与探测都依赖 rule match——没有退路时每一步都停在阻断，普通模式永远无法完成。
 * 退路：照常按计划逐位写入（同样的从不放宽的顺序、同样的自动重载与资源检查、比较并替换），每步写入后等满文件监视的上限
 * （watch.timeoutMs，TODO(P0)：按实测的监视延迟设定）再写下一步，并核对有效规则中四条 RULE-SET 的顺序；结果标为未经运行时
 * 确认（EntryReadback.runtimeConfirmed: false），之后的读回仍为 UNKNOWN。规划时本应用记录已确认的文件按文件内容视为已加载
 * （它们由带见证的写入或同样等满上限的写入产生，或在 Surge 启动时加载）；未确认的意图与外部修改的文件按更宽松的一侧规划。
 * 冲突（ARCHITECTURE §0）：等待不是证明——监视比上限慢时，后一步可能先于前一步加载；从不用于 VERIFY_ONLY/ACTIVE。
 */
interface UnwitnessedUndo {
  /** 允许改用退路（撤销入口）。 */
  allowed: boolean;
  /** 已改用退路：之后的步骤写入后等满上限，不读见证与探测。 */
  active: boolean;
  evidence: string[];
}

export function createRulesetStrategy(deps: RulesetStrategyDeps): EntryController {
  const files = deps.files;
  const dir = files.directory;
  const timeoutMs = deps.watch?.timeoutMs ?? DEFAULT_RULESET_WATCH.timeoutMs;
  const pollMs = deps.watch?.pollMs ?? DEFAULT_RULESET_WATCH.pollMs;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => Date.now());
  const newToken = deps.witnessToken ?? (() => randomBytes(4).toString('hex'));

  const locate = (location: string): string => {
    if (location.startsWith('file://')) return fileURLToPath(location);
    return isAbsolute(location) ? resolve(location) : resolve(dir, location);
  };
  const resourcesFor = (resources: readonly SurgeExternalResource[], path: string): SurgeExternalResource[] =>
    resources.filter((r) => !/^[a-z][a-z0-9+.-]*:\/\//i.test(r.location) || r.location.startsWith('file://')).filter((r) => locate(r.location) === path);

  /** RULE-SET 行指向哪个入口文件；rule match 回显时可能不带策略（TODO(P0)：核对实际写法），两种都接受。 */
  const bitOfRuleSet = (text: string): EntryBit | null => {
    const c = parseRule(text)?.condition ?? parseCondition(text);
    if (!c || c.type !== 'RULE-SET') return null;
    const v = c.value!;
    const base = v.slice(v.lastIndexOf('/') + 1);
    return ENTRY_BITS_IN_ORDER.find((b) => ENTRY_RULESET_FILES[b] === base) ?? null;
  };
  const isOurRule = (r: SurgeRuleRecord): boolean => bitOfRuleSet(r.text) !== null;

  /** 四条 RULE-SET 必须各出现一次、策略正确、顺序为 udp > verify > block > active。 */
  function rulesetOrderOk(rules: readonly SurgeRuleRecord[]): boolean {
    const idx = ENTRY_BITS_IN_ORDER.map((bit) => {
      const hits = rules.map((r, i) => ({ i, b: bitOfRuleSet(r.text), p: parseRule(r.text) })).filter(({ b }) => b === bit);
      if (hits.length !== 1 || hits[0]!.p!.policy !== ENTRY_BIT_POLICY[bit]) return -1;
      return hits[0]!.i;
    });
    return idx.every((i) => i >= 0) && idx.every((i, k) => k === 0 || i > idx[k - 1]!);
  }

  function precedenceIssues(cfg: EntryConfig, rules: readonly SurgeRuleRecord[]): PrecedenceIssue[] {
    return classifyPrecedence(rules, { isOurRule, processPaths: cfg.processPaths, siteHosts: cfg.siteHosts, verifyHost: cfg.verifyHost });
  }

  /**
   * rule match 回显的规则是哪一位：RULE-SET 行按文件名；回显子规则时按各文件的规则行（含见证行）识别，
   * block 与 active 的子规则相同时按策略区分。TODO(P0)：核对命中规则集时 rule 字段的实际写法。
   */
  function identify(fileStates: Record<EntryBit, FileState>): (rule: string, policy: string) => ProbeIdentity | null {
    return (rule, policy) => {
      const set = bitOfRuleSet(rule);
      const candidates = set
        ? [set]
        : ENTRY_BITS_IN_ORDER.filter((b) => {
            const f = fileStates[b];
            const lines = [...f.bodies, ...(f.witness ? [entryWitnessRule(b, f.witness)] : [])];
            return lines.some((l) => !PLACEHOLDERS_N.includes(l) && sameRuleText(rule, l));
          });
      if (candidates.length === 0) return null;
      const fitting = candidates.filter((b) => policyFits(BIT_OUTCOME[b], policy));
      if (fitting.length >= 1) return { id: fitting[0]!, outcome: BIT_OUTCOME[fitting[0]!] };
      return { id: `${candidates[0]!}（最终策略 ${policy}）`, outcome: BIT_OUTCOME[candidates[0]!] };
    };
  }

  /**
   * 见证读回：Surge 已加载的这一位内容是不是带 token 的那一版。命中该位的 RULE-SET 行，或回显子规则时就是这条唯一的
   * 见证行（其他文件不可能含有这一主机）；最终策略须与该位一致。读取失败抛出。
   */
  async function witnessLoaded(bit: EntryBit, token: string): Promise<boolean> {
    const host = entryWitnessHost(bit, token);
    const r = await deps.adapter.matchRule({ host, processPath: WITNESS_PROBE_PROCESS_PATH, protocol: 'TCP', port: 443 });
    const set = bitOfRuleSet(r.rule);
    const hit = set === bit || (set === null && sameRuleText(r.rule, entryWitnessRule(bit, token)));
    return hit && policyFits(BIT_OUTCOME[bit], r.policy);
  }

  /**
   * Safari 与对照探测（runtimeProbes），另加对照进程对各文件当前见证主机与占位主机的探测：见证与占位规则限定合成进程，
   * Chrome 请求这些主机也不得命中本应用入口规则或 SFE-ROUTE（DOMAIN 规则只看主机名，见 generate.ts）。
   * 例外：还有文件带旧格式占位规则（不限定进程，旧版本写入）时不探测占位主机——那是已知、只涉及这一个 `.invalid` 主机的
   * 旧格式问题（读回证据写明），切换会按未知重写这些文件；探测它只会让改写旧文件的每一步都失败。
   */
  async function probeRuntime(s: Pick<RulesetState, 'cfg' | 'files'>, known: Record<EntryBit, boolean | null>, issues: readonly PrecedenceIssue[]): Promise<ProbeJudgement> {
    const witnessHosts = ENTRY_BITS_IN_ORDER.flatMap((b) => (s.files[b].witness ? [entryWitnessHost(b, s.files[b].witness!)] : []));
    const controlHosts = legacyPlaceholderBits(s.files).length > 0 ? witnessHosts : [...witnessHosts, PLACEHOLDER_HOST];
    try {
      const results = await runProbes(deps.adapter, runtimeProbes(s.cfg, controlHosts), identify(s.files));
      return judgeProbes(results, (c) => acceptableFirstBits(known, c), issues);
    } catch (e) {
      return probeReadFailure(e);
    }
  }

  async function load(): Promise<RulesetState> {
    const cfg = deps.config();
    const anomalies: string[] = [];
    const intentWritten: EntryBit[] = [];
    const fileStates = {} as Record<EntryBit, FileState>;
    for (const bit of ENTRY_BITS_IN_ORDER) {
      const name = ENTRY_RULESET_FILES[bit];
      const content = await files.read(name);
      const digest = await files.digest(name);
      let value: boolean | null = null;
      let witness: string | null = null;
      let bodies: string[] = [];
      if (content === null) anomalies.push(`file_missing_${bit}`);
      else {
        const parsed = parseEntryRuleSetFile(bit, content);
        witness = parsed.witness;
        bodies = parsed.bodies;
        if (bodies.length === 1 && PLACEHOLDERS_N.includes(bodies[0]!)) value = false;
        else if (sameList(bodies, entryRules(bit, true, cfg).map(normalizeRuleText))) value = true;
        else anomalies.push(`file_unrecognized_${bit}`);
      }
      const rec = await deps.ownership.getRecord('entry_ruleset_file', name);
      if (!rec || rec.state === 'removed' || rec.state === 'pending_remove') anomalies.push(`not_owned_${bit}`);
      else if (rec.state === 'pending_add') {
        // 未确认的意图：文件只能是写前或写后内容之一，否则视为外部修改。
        if (digest !== rec.digest && (rec.previousDigest == null || digest !== rec.previousDigest)) anomalies.push(`file_changed_${bit}`);
        else {
          anomalies.push(`pending_${bit}`);
          if (digest !== null && digest === rec.digest) intentWritten.push(bit);
        }
      } else if (rec.digest === null || rec.digest !== digest) anomalies.push(`file_changed_${bit}`);
      fileStates[bit] = { bit, name, path: resolve(dir, name), value, digest, witness, bodies };
    }
    const resources = await deps.adapter.listExternalResources();
    for (const bit of ENTRY_BITS_IN_ORDER) {
      const found = resourcesFor(resources, fileStates[bit].path);
      if (found.length === 0) anomalies.push(`resource_missing_${bit}`);
      else if (found.length > 1) anomalies.push(`resource_ambiguous_${bit}`);
      else if (found[0]!.error) anomalies.push(`resource_error_${bit}`);
    }
    const rules = await deps.adapter.listRules();
    if (!rulesetOrderOk(rules)) anomalies.push('ruleset_order');
    const issues = precedenceIssues(cfg, rules);
    const values = ENTRY_BITS_IN_ORDER.map((b) => fileStates[b].value);
    const bits = values.some((v) => v === null) ? null : { udp: values[0]!, verify: values[1]!, block: values[2]!, active: values[3]! };

    // 已加载内容：每个带见证的文件读回一次见证。rule match 不可用（未映射、Unknown command）时不再逐个尝试。
    const loaded = {} as Record<EntryBit, LoadedState>;
    let unavailable: unknown = null;
    for (const bit of ENTRY_BITS_IN_ORDER) {
      const f = fileStates[bit];
      if (f.value === null || unavailable !== null) loaded[bit] = 'unread';
      else if (f.witness === null) loaded[bit] = 'unwitnessed';
      else {
        try {
          loaded[bit] = (await witnessLoaded(bit, f.witness)) ? 'confirmed' : 'stale';
        } catch (e) {
          loaded[bit] = 'unread';
          if (isRuleMatchUnavailable(e)) unavailable = e;
        }
      }
    }
    // 没有见证的文件（旧格式）按文件内容假设，由探测核对；只有全部为占位规则（NORMAL）时才可能因此被确认。
    const assumed = Object.fromEntries(
      ENTRY_BITS_IN_ORDER.map((b) => [b, loaded[b] === 'confirmed' || loaded[b] === 'unwitnessed' ? fileStates[b].value : null]),
    ) as Record<EntryBit, boolean | null>;
    const judgement = unavailable !== null ? probeReadFailure(unavailable) : bits === null ? null : await probeRuntime({ cfg, files: fileStates }, assumed, issues);
    const allOff = bits !== null && ENTRY_BITS_IN_ORDER.every((b) => !bits[b]);
    const known = Object.fromEntries(
      ENTRY_BITS_IN_ORDER.map((b) => {
        if (loaded[b] === 'confirmed') return [b, fileStates[b].value];
        if (loaded[b] === 'unwitnessed' && allOff && judgement?.ok === true && ENTRY_BITS_IN_ORDER.every((x) => loaded[x] === 'confirmed' || loaded[x] === 'unwitnessed')) {
          return [b, false];
        }
        return [b, null];
      }),
    ) as Record<EntryBit, boolean | null>;
    for (const bit of ENTRY_BITS_IN_ORDER) if (loaded[bit] === 'stale') anomalies.push(`not_loaded_${bit}`);
    return {
      cfg,
      files: fileStates,
      resources,
      rules,
      issues,
      bits,
      anomalies,
      loaded,
      known,
      judgement,
      ruleMatchUnavailable: judgement?.ruleMatchUnavailable === true,
      intentWritten,
    };
  }

  /** 运行时已确认的模式（不看文件归属与资源异常）：每一位已加载内容已知、探测一致；否则为 null。 */
  function runtimeMode(s: RulesetState): KnownEntryMode | null {
    if (ENTRY_BITS_IN_ORDER.some((b) => s.known[b] === null) || !s.judgement?.ok) return null;
    return knownModeOfBits({ udp: s.known.udp!, verify: s.known.verify!, block: s.known.block!, active: s.known.active! });
  }

  /** 只看文件、资源、已加载内容与探测（不看优先级）得到的模式。 */
  function baseModeOf(s: RulesetState): EntryReadback['mode'] {
    const known = s.bits ? knownModeOfBits(s.bits) : null;
    return s.anomalies.length === 0 && known !== null && runtimeMode(s) === known ? known : 'UNKNOWN';
  }

  /**
   * 撤销本应用入口的方向（BLOCKED/NORMAL）可以改写的文件：本应用记录拥有、但被外部修改、无法识别或缺失。
   * 不属于本应用记录的文件从不改写。
   */
  function overwritableBits(s: RulesetState): EntryBit[] {
    return ENTRY_BITS_IN_ORDER.filter(
      (b) =>
        !s.anomalies.includes(`not_owned_${b}`) &&
        (s.anomalies.includes(`file_changed_${b}`) || s.anomalies.includes(`file_unrecognized_${b}`) || s.anomalies.includes(`file_missing_${b}`)),
    );
  }

  const LOADED_LABEL: Record<LoadedState, string> = { confirmed: '已加载（见证一致）', stale: '已加载的不是文件中的这一版', unwitnessed: '文件没有见证规则', unread: '无法读回' };

  function readbackOf(s: RulesetState): EntryReadback {
    const issues = s.issues;
    const evidence = [
      `规则集文件：${s.bits ? ENTRY_BITS_IN_ORDER.filter((b) => s.bits![b]).join('、') || '全部为占位规则' : '无法识别'}`,
      ...ENTRY_BITS_IN_ORDER.map((b) => `规则集 ${b}：${LOADED_LABEL[s.loaded[b]]}`),
      ...s.anomalies.map((a) => `异常：${a}`),
      ...legacyPlaceholderBits(s.files).map((b) => `规则集 ${b}：旧格式占位规则（不限定进程，任何进程请求 ${PLACEHOLDER_HOST} 都会命中），下一次切换时改写`),
      ...(s.judgement?.evidence ?? []),
    ];
    let mode = baseModeOf(s);
    if (mode !== 'NORMAL' && mode !== 'UNKNOWN' && hasBlockingIssue(issues)) {
      mode = 'UNKNOWN';
      evidence.push('有规则排在入口之前');
    }
    // 旧格式文件没有见证：已加载内容只由探测核对（EntryReadback.witnessConfirmed）
    const witnessConfirmed = ENTRY_BITS_IN_ORDER.some((b) => s.loaded[b] === 'unwitnessed') ? { witnessConfirmed: false } : {};
    return { mode, bits: s.bits, evidence, precedenceIssues: issues, changedOwnedFiles: overwritableBits(s).map((b) => s.files[b].name), ...witnessConfirmed };
  }

  /** 只看文件与归属、资源、规则顺序（不看已加载内容与探测）的模式；有任何异常为 null。 */
  function filesAtMode(s: RulesetState): KnownEntryMode | null {
    return s.anomalies.length === 0 && s.bits !== null ? knownModeOfBits(s.bits) : null;
  }

  /**
   * 退路（UnwitnessedUndo）的最终读回：文件已是目标模式（BLOCKED/NORMAL）、没有异常、四条 RULE-SET 顺序正确时报告该模式，
   * 标为未经运行时确认；BLOCKED 仍按优先级问题处理。
   */
  function unwitnessedReadbackOf(s: RulesetState, to: KnownEntryMode, notes: readonly string[]): EntryReadback {
    const base = readbackOf(s);
    let mode: EntryReadback['mode'] = (to === 'BLOCKED' || to === 'NORMAL') && filesAtMode(s) === to ? to : 'UNKNOWN';
    const evidence = [
      ...base.evidence,
      `撤销入口：rule match 不可用，入口文件按计划写入并等满文件监视上限（${(timeoutMs / 1000).toFixed(1)} 秒）后视为已加载，未经见证与运行时求值确认`,
      ...(notes.length > 0 ? notes : ['入口文件已是目标内容，未写入']),
    ];
    if (mode === 'BLOCKED' && hasBlockingIssue(s.issues)) {
      mode = 'UNKNOWN';
      evidence.push('有规则排在入口之前');
    }
    return { ...base, mode, evidence, runtimeConfirmed: false };
  }

  /**
   * 上一次普通模式在 NORMAL 一段写入、超时后保留的关闭（udp/block，撤销入口中放宽的一步，见 runStep 的 keptTowardTarget）：
   * 文件已是这次写入的关闭内容（意图未确认、摘要等于意图的摘要），Surge 已加载的还不是这一版。
   */
  function keptTowardNormal(s: RulesetState, bit: 'udp' | 'block'): boolean {
    return s.files[bit].value === false && s.intentWritten.includes(bit) && s.loaded[bit] === 'stale';
  }

  /**
   * 普通模式的中间阻断已经满足、而且比 BLOCKED 更接近 NORMAL：探测一致，见证确认 verify/active 关（Safari 新请求不会经
   * SFE-ROUTE），udp 已关、block 开；或者其中一位是上一次 NORMAL 一段保留的关闭、尚未加载（keptTowardNormal：udp 关闭时
   * block 已确认开着，Safari 的全部流量仍被拒绝；block 关闭只在 udp 已确认关闭之后写入，已加载的是写前的阻断或已是这次的
   * 关闭）。异常只能是这些保留写入的 pending_/not_loaded_。照常规划会把未加载的位按更宽松的一侧重新收紧（udp 开、block 开），
   * 比时限慢的监视就会在每次普通模式中、或在相隔短于监视延迟的重试之间来回写入，普通模式永远无法完成。返回保留写入的位；
   * 不满足时为 null。退路（rule match 不可用）每步都等满上限后确认、不会超时，不需要这一判断。
   */
  function blockedOnWayToNormal(s: RulesetState): Array<'udp' | 'block'> | null {
    if (s.judgement?.ok !== true || s.known.verify !== false || s.known.active !== false) return null;
    const kept = (['udp', 'block'] as const).filter((b) => keptTowardNormal(s, b));
    const udpOff = s.known.udp === false || kept.includes('udp');
    const blockOk = s.known.block === true || (kept.includes('block') && s.known.udp === false);
    const allowed = kept.flatMap((b) => [`pending_${b}`, `not_loaded_${b}`]);
    return udpOff && blockOk && s.anomalies.every((a) => allowed.includes(a)) ? kept : null;
  }

  /**
   * blockedOnWayToNormal 的读回：中间阻断这一段已满足（bits 如实报告文件内容，keptTowardNormal 列出尚未加载的保留写入）；
   * 有规则排在入口之前时随附，普通模式照常继续撤销入口。
   */
  function blockedOnWayToNormalReadback(s: RulesetState, kept: Array<'udp' | 'block'>): EntryReadback {
    const base = readbackOf(s);
    // 有规则排在入口之前时，入口之外的规则仍可能让 Safari 新请求经 SFE-ROUTE：只说本应用入口不会
    const notViaRoute = hasBlockingIssue(s.issues) ? '本应用入口不会让 Safari 新请求经 SFE-ROUTE，但有规则排在入口之前' : 'Safari 新请求不会经 SFE-ROUTE';
    const note = kept.includes('block')
      ? `普通模式的中间阻断不再写入：verify/active 已关（${notViaRoute}），udp 已关；上一次保留的 block 关闭尚未加载（Surge 已加载的是写前的阻断或已是这次的关闭），不重新打开，由 NORMAL 一段再写入`
      : kept.includes('udp')
        ? '普通模式的中间阻断已成立：block 已开、verify/active 已关（Safari 全部流量仍被 block 拒绝）；上一次保留的 udp 关闭尚未加载，不重新打开，由 NORMAL 一段再写入，未写入'
        : '普通模式的中间阻断已成立：block 已开、verify/active 已关，udp 已按普通模式关闭（Safari 全部流量仍被 block 拒绝），未写入';
    const evidence = [...base.evidence, note];
    if (hasBlockingIssue(s.issues)) evidence.push('有规则排在入口之前');
    return { ...base, mode: 'BLOCKED', evidence, ...(kept.length > 0 ? { keptTowardNormal: kept } : {}) };
  }

  async function checkAutoReload(lastConfirmed: EntryBits | null, step: EntryStep): Promise<void> {
    const cond = await deps.autoReloadCondition();
    let setting: boolean | null;
    try {
      setting = await deps.adapter.getAutoReloadSetting();
    } catch {
      setting = null;
    }
    const ok = cond === 'any' || (setting !== null && ((cond === 'on' && setting) || (cond === 'off' && !setting)));
    if (!ok) {
      throw stepFailure('CAPABILITY_UNVERIFIED', '切换入口失败：自动重载设置与实测条件不一致或无法读取', lastConfirmed, {
        failedStep: { bit: step.bit, value: step.value },
        autoReload: setting,
        verifiedCondition: cond,
      });
    }
  }

  function uniqueKey(resources: readonly SurgeExternalResource[], path: string, lastConfirmed: EntryBits | null, step: EntryStep): SurgeExternalResource {
    const found = resourcesFor(resources, path);
    if (found.length === 0) {
      throw stepFailure('RESOURCE_MISSING', '切换入口失败：Surge 中找不到该入口规则集资源', lastConfirmed, { failedStep: { bit: step.bit, value: step.value } });
    }
    if (found.length > 1) {
      throw stepFailure('NAME_COLLISION', '切换入口失败：多个外部资源指向同一个入口规则集文件', lastConfirmed, {
        failedStep: { bit: step.bit, value: step.value },
      });
    }
    return found[0]!;
  }

  /** 写入前的期望摘要：只接受记录的摘要（或崩溃前意图的写前/写后摘要之一）。 */
  async function expectedPrevious(name: string, current: string | null): Promise<string | null> {
    const rec = await deps.ownership.getRecord('entry_ruleset_file', name);
    if (!rec || rec.state === 'removed' || rec.state === 'pending_remove') return null;
    if (rec.state === 'pending_add' && current !== null && (current === rec.digest || current === rec.previousDigest)) return current;
    return rec.digest;
  }

  /** 撤销入口的退路：写入后等满文件监视的上限（不读见证）。 */
  async function waitFullLimit(): Promise<{ loaded: boolean; waitedMs: number }> {
    const start = now();
    await sleep(timeoutMs);
    return { loaded: true, waitedMs: Math.max(timeoutMs, now() - start) };
  }

  /** 轮询见证直到 Surge 加载了带 token 的这一版，或到达时限。读取失败抛出（结果未知）。 */
  async function awaitWitness(bit: EntryBit, token: string): Promise<{ loaded: boolean; waitedMs: number }> {
    const start = now();
    for (;;) {
      if (await witnessLoaded(bit, token)) return { loaded: true, waitedMs: now() - start };
      if (now() - start >= timeoutMs) return { loaded: false, waitedMs: now() - start };
      await sleep(pollMs);
    }
  }

  /**
   * 一步。overwrite：本次切换中第一次改写一个被外部修改、无法识别或缺失的本应用文件——只与载入时读到的摘要比较
   * （比较并替换），失败或恢复时从不把外部内容确认为记录（之后仍按外部修改处理）。cur：切换中各文件的当前内容（见证与规则行，
   * 用于识别 rule match 的回显）；known：切换中已加载内容已知的位。两者在这一步确认后更新。
   */
  async function runStep(
    step: EntryStep,
    s: RulesetState,
    cur: Record<EntryBit, FileState>,
    lastConfirmed: EntryBits | null,
    overwrite: boolean,
    known: Record<EntryBit, boolean | null>,
    unwitnessed: UnwitnessedUndo,
    undoing: boolean,
  ): Promise<void> {
    const f = cur[step.bit];
    await checkAutoReload(lastConfirmed, step);
    // 写入前先确认 Surge 中恰好有一个资源指向该文件；否则不写。
    uniqueKey(await deps.adapter.listExternalResources(), f.path, lastConfirmed, step);
    const token = newToken();
    const content = entryRuleSetFileContent(step.bit, step.value, s.cfg, token);
    const previousContent = await files.read(f.name);
    const previousWitness = previousContent === null ? null : parseEntryRuleSetFile(step.bit, previousContent).witness;
    const currentDigest = await files.digest(f.name);
    // 第一次改写外部修改的文件只与载入时读到的摘要比较。
    const expected = overwrite ? s.files[step.bit].digest : await expectedPrevious(f.name, currentDigest);
    const newDigest = files.digestContent ? files.digestContent(content) : null;
    await deps.ownership.recordIntent('entry_ruleset_file', f.name, newDigest, deps.operationId(), 'add');
    try {
      await files.writeAtomic(f.name, content, expected);
    } catch (e) {
      // 原子替换失败时文件未变：恢复记录为写前状态（外部修改的文件保持未确认的意图，仍读作外部修改）。
      if (!overwrite && currentDigest !== null && expected === currentDigest) {
        await deps.ownership.confirm('entry_ruleset_file', f.name, 'present', currentDigest).catch(() => undefined);
      }
      throw e;
    }
    // 写入之后、读回确认之前，已加载状态可能是写前或写后（两者都在计划允许之内）：出错时不再声称上一状态已确认。
    const written: FileState = { ...f, witness: token, bodies: parseEntryRuleSetFile(step.bit, content).bodies, value: step.value };
    const fileStates = { ...cur, [step.bit]: written };
    try {
      const writtenDigest = await files.digest(f.name);
      let waited: { loaded: boolean; waitedMs: number };
      if (unwitnessed.active) waited = await waitFullLimit();
      else {
        try {
          waited = await awaitWitness(step.bit, token);
        } catch (e) {
          // 撤销入口时 rule match 不可用（未映射、Unknown command）：改用退路（见 UnwitnessedUndo），其余读取失败照常停止。
          if (!unwitnessed.allowed || !isRuleMatchUnavailable(e)) throw e;
          unwitnessed.active = true;
          waited = await waitFullLimit();
        }
      }
      if (!waited.loaded) {
        // 文件监视没有在时限内加载新内容：结果未知，不声称更宽松的状态。
        // - 激活中放宽的一步（verify/active 打开、udp/block 关闭）：能证明 Surge 仍是写前内容时，把文件改回写前内容（比较并
        //   替换），并再次读回写前的见证；能确认时上一确认状态仍然成立。
        // - 收紧的一步（udp/block 打开、verify/active 关闭）：保留新内容、意图保持 pending——监视赶上之后加载的是更严格的内容；
        //   改回写前内容会让比时限慢的监视永远加载不到收紧，普通模式与回滚每次重试都写入又改回，Safari 一直停在买家出口。
        // - 撤销入口（undoing：普通模式、回滚，目标 BLOCKED/NORMAL）中放宽的一步（只出现在走向 NORMAL 时：udp/block 关闭，
        //   路由位已关闭并确认之后）：同样保留新内容——它只走向用户要求的普通模式；改回会让比时限慢的监视永远加载不到
        //   udp/block 关闭，普通模式每次重试都写入又改回，永远停在 BLOCKED（用户决定 1：进入普通模式永远可用）。
        //   两种保留都在下一次切换时由见证读到这一版、按事实确认归属（settleWitnessedIntents）。
        const loosening = step.value === PERMISSIVE_SIDE[step.bit];
        const restore = loosening && !undoing;
        let restored = false;
        if (restore && previousWitness !== null && previousContent !== null && writtenDigest !== null && currentDigest !== null) {
          try {
            if (await witnessLoaded(step.bit, previousWitness)) {
              await files.writeAtomic(f.name, previousContent, writtenDigest);
              if (await witnessLoaded(step.bit, previousWitness)) {
                if (!overwrite) await deps.ownership.confirm('entry_ruleset_file', f.name, 'present', currentDigest);
                restored = true;
              }
            }
          } catch {
            /* 保持 pending，由对账处理 */
          }
        }
        // 保留新内容时提示等待：监视赶上之前重试只会再写入同样的内容、再次超时
        const message = restore
          ? '切换入口失败：规则集文件写入后 Surge 没有在时限内重新加载（结果未知）'
          : '切换入口失败：规则集文件写入后 Surge 没有在时限内重新加载（结果未知）；已写入的内容保留，请等 Surge 的文件监视加载之后再重试';
        throw stepFailure('READBACK_MISMATCH', message, restored ? lastConfirmed : null, {
          failedStep: { bit: step.bit, value: step.value },
          reason: 'watch_timeout',
          waitedMs: waited.waitedMs,
          restored,
          ...(restore ? {} : loosening ? { keptTowardTarget: true } : { keptStricter: true }),
        });
      }
      const after = { ...known, [step.bit]: step.value };
      // 重新加载之后规则顺序必须仍然成立（例如自动重载可能换入了外部修改的配置），运行时探测与已加载内容一致。
      const rules = await deps.adapter.listRules();
      if (!rulesetOrderOk(rules)) {
        throw stepFailure('READBACK_MISMATCH', '切换入口失败：入口规则集不在有效规则中或顺序不对', null, { failedStep: { bit: step.bit, value: step.value } });
      }
      if (unwitnessed.active) {
        unwitnessed.evidence.push(`${step.bit}${step.value ? '+' : '-'}：写入后按文件监视上限等待 ${(waited.waitedMs / 1000).toFixed(1)} 秒，未经见证与运行时求值确认`);
        known[step.bit] = step.value;
        const digest = await files.digest(f.name);
        await deps.ownership.confirm('entry_ruleset_file', f.name, 'present', digest);
        cur[step.bit] = { ...written, digest };
        return;
      }
      const judgement = await probeRuntime({ cfg: s.cfg, files: fileStates }, after, precedenceIssues(s.cfg, rules));
      if (!judgement.ok) {
        throw stepFailure('READBACK_MISMATCH', '切换入口失败：规则集重新加载后运行时规则求值与预期不一致', null, {
          failedStep: { bit: step.bit, value: step.value },
          runtime: judgement.evidence,
          controlHit: judgement.controlHit,
        });
      }
      known[step.bit] = step.value;
    } catch (e) {
      if (e instanceof SfeError && e.details && 'lastConfirmedBits' in e.details) throw e;
      throw withLastConfirmed(e, null, step);
    }
    const digest = await files.digest(f.name);
    await deps.ownership.confirm('entry_ruleset_file', f.name, 'present', digest);
    cur[step.bit] = { ...written, digest };
  }

  /**
   * 未确认的意图（pending_<位>：文件只能是写前或写后内容之一）已由见证证明 Surge 加载了文件中的这一版：按事实确认归属
   * （与 temp_rule 切换前的 normalizeOwnership 相同）。例如比时限慢的文件监视在收紧的一步超时之后赶上。返回是否有改动。
   */
  async function settleWitnessedIntents(s: RulesetState): Promise<boolean> {
    let changed = false;
    for (const bit of ENTRY_BITS_IN_ORDER) {
      const f = s.files[bit];
      if (!s.anomalies.includes(`pending_${bit}`) || s.loaded[bit] !== 'confirmed' || f.digest === null) continue;
      await deps.ownership.confirm('entry_ruleset_file', f.name, 'present', f.digest);
      changed = true;
    }
    return changed;
  }

  /**
   * 意图未确认（例如崩溃在写入与重新加载之间）、已加载内容未确认（见证读不到、已加载的不是文件中的这一版、旧格式文件）
   * 与要改写的外部修改文件，其已加载内容未知：按更宽松的一侧规划（block 未知时按关闭规划，需要变化时第一步总是开 block；
   * block 已知时按其实际值，已开着则不必再开）；规划没有写到的未知位在最后一个 block 步骤之前按目标值重写一次——
   * 被 block 遮住的位也由见证确认加载，之后撤下 block 不会暴露未加载的内容。
   */
  function planWithPending(s: RulesetState, to: KnownEntryMode, unknown: readonly EntryBit[]): EntryStep[] {
    const pending = ENTRY_BITS_IN_ORDER.filter((b) => s.anomalies.includes(`pending_${b}`) || unknown.includes(b));
    if (pending.length === 0) return planFromBits(s.bits!, to);
    const bitOf = (b: EntryBit): boolean => (pending.includes(b) ? PERMISSIVE_SIDE[b] : s.files[b].value!);
    const start: EntryBits = { udp: bitOf('udp'), verify: bitOf('verify'), block: bitOf('block'), active: bitOf('active') };
    const steps = planFromBits(start, to);
    const written = new Set(steps.map((st) => st.bit));
    const target = ENTRY_MODE_BITS[to];
    const last = steps[steps.length - 1];
    const at = last && last.bit === 'block' && !last.value ? steps.length - 1 : steps.length;
    const bitsAt = at > 0 ? steps[at - 1]!.bits : start;
    const reassert = pending
      .filter((b) => !written.has(b))
      .map((b): EntryStep => ({ bit: b, value: target[b], bits: { ...bitsAt }, effective: steps[at - 1]?.effective ?? to }));
    return [...steps.slice(0, at), ...reassert, ...steps.slice(at)];
  }

  return {
    strategy: 'ruleset_resource',

    async read() {
      return readbackOf(await load());
    },

    async transition(to, onStep, opts) {
      let s: RulesetState;
      try {
        s = await load();
        if (await settleWitnessedIntents(s)) s = await load();
      } catch (e) {
        throw withLastConfirmed(e, null, null);
      }
      // 运行时已确认的状态（见证与探测）；文件或资源的异常不影响它。
      const confirmedMode = runtimeMode(s);
      // 撤销本应用入口（opts.undo：普通模式、回滚；目标 BLOCKED/NORMAL）：本应用拥有、但被外部修改、无法识别或缺失的
      // 规则集文件按载入时读到的摘要比较后改写（已加载内容未知，按更宽松的一侧规划）；否则一个被编辑的文件会让普通模式
      // 永远无法完成。激活中的阻断步骤不改写（照常拒绝），从不悄悄覆盖用户的修改后继续走向 VERIFY_ONLY/ACTIVE。
      const overwrite = opts?.undo === true && (to === 'NORMAL' || to === 'BLOCKED') ? overwritableBits(s) : [];
      if (ENTRY_BITS_IN_ORDER.some((b) => s.files[b].value === null && !overwrite.includes(b))) {
        throw stepFailure('UNKNOWN_STATE', '切换入口失败：入口规则集文件无法识别', null, { anomalies: s.anomalies });
      }
      // 被外部修改或不属于本应用记录的规则集文件从不被采纳为基线：撤销入口以外的切换（激活）停止
      // （先进入普通模式或经维护流程恢复）；不属于本应用的文件任何方向都不改写。
      const foreign = s.anomalies.filter(
        (a) => a.startsWith('not_owned_') || (a.startsWith('file_changed_') && !overwrite.includes(a.slice('file_changed_'.length) as EntryBit)),
      );
      if (foreign.length > 0) {
        throw stepFailure('BASELINE_CHANGED', '切换入口失败：入口规则集文件已被外部修改或不属于本应用', null, { anomalies: foreign });
      }
      // 要改写的文件已加载的内容未知：第一步确认之前不声称任何已确认状态。
      let lastConfirmed: EntryBits | null = overwrite.length > 0 || confirmedMode === null ? null : { ...ENTRY_MODE_BITS[confirmedMode] };
      if (s.anomalies.includes('ruleset_order')) {
        throw stepFailure('UNKNOWN_STATE', '切换入口失败：入口规则集不在有效规则中或顺序不对', lastConfirmed, { anomalies: s.anomalies });
      }
      if (to === 'VERIFY_ONLY' || to === 'ACTIVE') {
        if (hasBlockingIssue(s.issues)) {
          throw stepFailure('PRECEDENCE_VIOLATION', '切换入口失败：有规则排在入口之前，可能抢先匹配 Safari 流量', lastConfirmed, {
            precedenceIssues: s.issues,
          });
        }
      }
      // 撤销入口时 rule match 不可用：改用退路（UnwitnessedUndo），不声称任何已确认状态。
      const undoing = opts?.undo === true && (to === 'NORMAL' || to === 'BLOCKED');
      const unwitnessed: UnwitnessedUndo = { allowed: undoing, active: undoing && s.ruleMatchUnavailable, evidence: [] };
      if (unwitnessed.active) lastConfirmed = null;
      // 普通模式的中间阻断从 NORMAL 出发（EntryTransitionOptions.towardNormal）：没有需要阻断的本应用入口，不写入。退路中
      // 只看文件与归属（全部为占位规则、没有异常）。
      if (to === 'BLOCKED' && opts?.undo === true && opts.towardNormal === true && overwrite.length === 0) {
        if (unwitnessed.active && filesAtMode(s) === 'NORMAL') return unwitnessedReadbackOf(s, 'NORMAL', ['入口文件已全部为占位规则：入口已是普通模式，不需要阻断，未写入']);
        if (!unwitnessed.active && s.anomalies.length === 0 && confirmedMode === 'NORMAL') return readbackOf(s);
        const kept = unwitnessed.active ? null : blockedOnWayToNormal(s);
        if (kept) return blockedOnWayToNormalReadback(s, kept);
      }
      // 规划：已加载内容没有见证确认的位（含旧格式文件——NORMAL 时它们的效果已由探测核对，但之后被遮住时无法再核对）
      // 按未知处理，在切换中带见证重写一次。退路中本应用记录已确认、没有异常的文件按文件内容视为已加载。
      const known = { ...s.known };
      if (unwitnessed.active) {
        for (const b of ENTRY_BITS_IN_ORDER) known[b] = s.files[b].value !== null && !s.anomalies.some((a) => a.endsWith(`_${b}`)) ? s.files[b].value : null;
      }
      for (const b of overwrite) known[b] = null;
      const unknown = ENTRY_BITS_IN_ORDER.filter((b) => known[b] === null || (!unwitnessed.active && s.loaded[b] !== 'confirmed'));
      const toOverwrite = new Set<EntryBit>(overwrite);
      const cur = { ...s.files };
      for (const step of planWithPending(s, to, unknown)) {
        try {
          await runStep(step, s, cur, lastConfirmed, toOverwrite.has(step.bit), known, unwitnessed, undoing);
        } catch (e) {
          if (e instanceof SfeError && e.details && 'lastConfirmedBits' in e.details) throw e;
          throw withLastConfirmed(e, lastConfirmed, step);
        }
        // 第一次改写成功后记录已确认，同一位之后的步骤按记录的摘要比较。
        toOverwrite.delete(step.bit);
        lastConfirmed = unwitnessed.active ? null : { ...step.bits };
        onStep?.(step);
      }
      let finalState: RulesetState;
      let final: EntryReadback;
      try {
        finalState = await load();
        // 退路中途才发现 rule match 不可用（载入时没有调用它）时，最终读回同样按退路报告。
        if (unwitnessed.allowed && finalState.ruleMatchUnavailable) unwitnessed.active = true;
        final = unwitnessed.active ? unwitnessedReadbackOf(finalState, to, unwitnessed.evidence) : readbackOf(finalState);
      } catch (e) {
        throw withLastConfirmed(e, lastConfirmed, null);
      }
      if (overwrite.length > 0) final.evidence.push(`已改写被外部修改的本应用入口规则集文件：${overwrite.join('、')}`);
      if (final.mode !== to) {
        // 只有文件、已加载内容与探测都已是目标模式、仅因有规则排在入口之前而不能宣称受控时，才是 PRECEDENCE_VIOLATION
        // （退路：文件已是目标模式、没有异常）。
        const atTarget = unwitnessed.active ? filesAtMode(finalState) === to : baseModeOf(finalState) === to;
        const code = atTarget && hasBlockingIssue(final.precedenceIssues) ? 'PRECEDENCE_VIOLATION' : 'READBACK_MISMATCH';
        const confirmedBits = code === 'PRECEDENCE_VIOLATION' && unwitnessed.active ? { ...ENTRY_MODE_BITS[to] } : lastConfirmed;
        throw new SfeError(code, '切换入口失败：最终读回不是目标模式', {
          details: { lastConfirmedBits: confirmedBits, observedMode: final.mode, precedenceIssues: final.precedenceIssues, evidence: final.evidence },
        });
      }
      return final;
    },
  };
}
