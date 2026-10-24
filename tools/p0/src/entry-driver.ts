// 入口模式驱动：用服务的入口策略（EntryController）依次切换目标模式，记录每一步的写入区间与位组合
// （供放行窗口分析），每个模式确认后调用 afterMode 做停留与观察。任何一步失败即停止，保留已确认的更严格状态，
// 不尝试退回更宽松状态；是否进入普通模式由操作员决定。另含优先级测试、临时规则插入位置探测与见证规则形式核对。
// 本文件中 rule match 的目标一律是文档地址 ENTRY_PROBE_IPV4（IP 字面量，不触发 DNS），进程一律是 /var/empty 下的合成路径。

import { ENTRY_MODE_BITS, ENTRY_PLACEHOLDER_PROCESS_PATH, ENTRY_PROBE_IPV4, ENTRY_RULESET_FILES, SfeError, type EntryBits, type EntryMode, type KnownEntryMode } from '@sfe/contract';
import type { EntryTimeline } from './analysis/entry-window.js';
import { isEntryRule, outcomeOfPolicy } from './analysis/rule-match.js';
import {
  REJECT_POLICIES,
  entryWitnessProcessPath,
  normalizeRuleText,
  parseCondition,
  parseRule,
  sameRuleText,
  type EntryController,
  type EntryReadback,
  type EntryStep,
  type SurgeAdapter,
  type SurgeRuleRecord,
} from './deps.js';

export interface StepRecord {
  from: number;
  to: number;
  step: EntryStep;
}

export interface ModeRecord {
  target: KnownEntryMode;
  startedAt: number;
  confirmedAt: number | null;
  readbackMode: EntryMode | null;
  ok: boolean;
  error: { code: string; message: string; lastConfirmedBits: EntryBits | null } | null;
  steps: StepRecord[];
  evidence: string[];
}

export interface EntryRunDeps {
  controller: EntryController;
  now: () => number;
  onStep?: (r: StepRecord) => void;
  afterMode?: (m: ModeRecord, readback: EntryReadback) => Promise<void>;
}

export interface EntryRun {
  initial: EntryReadback;
  modes: ModeRecord[];
  timeline: EntryTimeline;
  stoppedEarly: boolean;
}

function errorInfo(e: unknown): ModeRecord['error'] {
  if (e instanceof SfeError) {
    const bits = (e.details?.lastConfirmedBits ?? null) as EntryBits | null;
    return { code: e.code, message: e.message, lastConfirmedBits: bits };
  }
  return { code: 'INTERNAL', message: '切换入口失败：内部错误', lastConfirmedBits: null };
}

export async function runEntrySequence(deps: EntryRunDeps, targets: readonly KnownEntryMode[]): Promise<EntryRun> {
  const initial = await deps.controller.read();
  const initialBits = initial.bits ?? ENTRY_MODE_BITS.NORMAL;
  const timeline: EntryTimeline = { initial: initialBits, steps: [] };
  let prev: EntryBits = initialBits;
  const modes: ModeRecord[] = [];
  for (const target of targets) {
    const rec: ModeRecord = { target, startedAt: deps.now(), confirmedAt: null, readbackMode: null, ok: false, error: null, steps: [], evidence: [] };
    modes.push(rec);
    let last = rec.startedAt;
    try {
      await deps.controller.transition(target, (step) => {
        const t = deps.now();
        const r: StepRecord = { from: last, to: t, step };
        rec.steps.push(r);
        timeline.steps.push({ from: last, to: t, before: prev, after: step.bits });
        prev = step.bits;
        last = t;
        deps.onStep?.(r);
      });
      const rb = await deps.controller.read();
      rec.confirmedAt = deps.now();
      rec.readbackMode = rb.mode;
      rec.evidence = rb.evidence;
      rec.ok = rb.mode === target;
      await deps.afterMode?.(rec, rb);
      if (!rec.ok) return { initial, modes, timeline, stoppedEarly: true };
    } catch (e) {
      rec.error = errorInfo(e);
      return { initial, modes, timeline, stoppedEarly: true };
    }
  }
  return { initial, modes, timeline, stoppedEarly: false };
}

export interface PrecedenceOutcome {
  /** 切换到 VERIFY_ONLY 被拒绝且错误为 PRECEDENCE_VIOLATION。 */
  refused: boolean;
  code: string | null;
  /** 读回中列出的阻断项数量。 */
  blockingIssues: number;
  /** 测试后的读回模式（应为 NORMAL）。 */
  modeAfter: EntryMode | null;
}

/**
 * 优先级测试：注入一条可能抢先匹配 Safari 流量的非 REJECT 规则后尝试进入 VERIFY_ONLY，必须被拒绝。
 * 无论结果如何都清理注入的规则；之后不是 NORMAL 时回到 NORMAL。
 */
export async function precedenceTest(controller: EntryController, inject: () => Promise<void>, cleanup: () => Promise<void>): Promise<PrecedenceOutcome> {
  let refused = false;
  let code: string | null = null;
  let blocking = 0;
  try {
    await inject();
    const rb = await controller.read();
    blocking = rb.precedenceIssues.filter((i) => i.severity === 'blocking').length;
    try {
      await controller.transition('VERIFY_ONLY');
    } catch (e) {
      code = e instanceof SfeError ? e.code : 'INTERNAL';
      refused = code === 'PRECEDENCE_VIOLATION';
    }
  } finally {
    await cleanup();
  }
  let after = await controller.read();
  if (after.mode !== 'NORMAL') {
    try {
      await controller.transition('NORMAL');
    } catch {
      /* 由调用方报告 */
    }
    after = await controller.read();
  }
  return { refused, code, blockingIssues: blocking, modeAfter: after.mode };
}

/**
 * 插入探测请求的合成进程路径：应用的可执行文件不会放在 /var/empty 下，真实请求通常不会以它为来源（TODO(P0)：属主与内容由
 * P0-RUNBOOK §1.6 记录）；与服务的见证规则同一做法（ARCHITECTURE §5.5）。rule match 是否接受不存在的进程路径没有写入文档
 * （TODO(P0)：由 probeWitnessForm 在测试 Mac 上实测）。
 */
export const INSERTION_PROBE_PROCESS_PATH = '/var/empty/sfe-p0-insert-probe';

/**
 * 两条文本不同、都命中同一合成请求（`rule match <ENTRY_PROBE_IPV4> process-path=<INSERTION_PROBE_PROCESS_PATH>`）的 REJECT 临时
 * 规则。只有进程条件，不含主机或 IP 条件：第一条是完整路径，第二条在完整路径模式中用一个 “?” 通配符。进程规则文档：“If the
 * expression starts with `/` (and does not end with `/`), it matches the executable's full absolute path.”、“Wildcards `*` and
 * `?` are supported in this mode as well.”（https://manual.nssurge.com/rules/process.html）。两条都限定在 /var/empty 下，
 * Safari、Chrome 与其他应用的真实请求都不会命中。rule match 返回先求值的一条，所以除了有效规则列表中的先后，还能直接看到
 * Surge 的求值顺序。之前的 `DOMAIN,p0-insert-N.invalid,REJECT` 不能这样求值：目标是合成域名时，求值走到用户的 IP 规则（没有
 * no-resolve）要先解析，`.invalid` 解析失败，rule match 退出 1（2026-10-24 测试 Mac，docs/verification/2026-10-24-mac-p0-increment.md）。
 */
export const INSERTION_PROBE_RULES = [`PROCESS-NAME,${INSERTION_PROBE_PROCESS_PATH},REJECT`, `PROCESS-NAME,${INSERTION_PROBE_PROCESS_PATH.slice(0, -1)}?,REJECT`] as const;

/**
 * 一次 rule match 的原始结果：目标总是文档地址 ENTRY_PROBE_IPV4（IP 规则文档：“If the request targets an IP literal, the rule
 * matches it directly; GEOIP and IP-ASN perform their database lookup without a DNS query.”，https://manual.nssurge.com/rules/ip.html），
 * 协议 TCP、端口 443。失败时记录错误码、适配层已脱敏的错误文字与退出码（非零退出是确定的回答，无法连接等不是）。
 */
export interface MatchObservation {
  /** 用途说明（中文）。 */
  label: string;
  host: string;
  processPath: string;
  rule: string | null;
  policy: string | null;
  error: string | null;
  message: string | null;
  exitCode: number | null;
}

/** 求值一次（只读，“without creating a connection”）；失败不抛出，原样记录。 */
export async function observeMatch(adapter: Pick<SurgeAdapter, 'matchRule'>, label: string, processPath: string): Promise<MatchObservation> {
  const base = { label, host: ENTRY_PROBE_IPV4, processPath };
  try {
    const r = await adapter.matchRule({ host: ENTRY_PROBE_IPV4, processPath, protocol: 'TCP', port: 443 });
    return { ...base, rule: r.rule, policy: r.policy, error: null, message: null, exitCode: null };
  } catch (e) {
    const exitCode = e instanceof SfeError && typeof e.details?.exitCode === 'number' ? e.details.exitCode : null;
    return { ...base, rule: null, policy: null, error: codeOf(e), message: e instanceof SfeError ? e.message : null, exitCode };
  }
}

function describeObservation(o: MatchObservation): string {
  return o.error !== null ? `读取失败 ${o.error}${o.exitCode !== null ? `（退出 ${o.exitCode}）` : ''}${o.message ? `：${o.message}` : ''}` : `命中「${o.rule}」，策略 ${o.policy}`;
}

export interface ProfileBoundary {
  /** 测试配置第一条规则在有效规则列表中的位置；null = 无法确定（见 note）。 */
  index: number | null;
  note: string | null;
}

/**
 * 配置规则在有效规则列表中的起点。真实的 CLI/HTTP 解析不报告规则来源（source 只有 module/unknown），
 * 所以不依赖 source，而是用本工具生成的测试配置自己的 [Rule] 文本定位：第一条规则必须恰好出现一次，
 * 且其他只出现一次的配置规则都不在它之前；否则如实报告无法确定。
 */
export function profileBoundary(rules: readonly SurgeRuleRecord[], profileRules: readonly string[] | null | undefined): ProfileBoundary {
  if (!profileRules || profileRules.length === 0) {
    return { index: null, note: '没有测试配置的规则文本（CLI 不报告规则来源），无法确定配置规则的起点' };
  }
  const listed = rules.map((r) => normalizeRuleText(r.text));
  const hitsOf = (text: string): number[] => {
    const want = normalizeRuleText(text);
    return listed.flatMap((t, i) => (t === want ? [i] : []));
  };
  const first = hitsOf(profileRules[0]!);
  if (first.length !== 1) {
    return { index: null, note: first.length === 0 ? '有效规则中找不到测试配置的第一条规则，无法确定配置规则的起点' : '测试配置的第一条规则在有效规则中出现多次，无法确定配置规则的起点' };
  }
  const index = first[0]!;
  for (const text of profileRules.slice(1)) {
    const hits = hitsOf(text);
    if (hits.length === 1 && hits[0]! < index) return { index: null, note: '有效规则中测试配置规则的顺序与配置文件不一致，无法确定配置规则的起点' };
  }
  return { index, note: null };
}

export interface InsertionProbeResult {
  insertion: 'head' | 'tail' | null;
  /** 两条探测规则是否都排在配置规则之前；null = 无法判断（原因见 boundaryNote）。 */
  beforeProfileRules: boolean | null;
  boundaryNote: string | null;
  /**
   * 正向确认 listTempRules：添加后的临时规则列表必须列出两条探测规则。
   * - true：列出了，输出格式与内容都可信；
   * - false：只在读取成功、有效规则中能看到两条探测规则、临时规则列表却没有全部列出时（该原语映射不可用，
   *   依赖它的读回、同步与回退都不能信任）；
   * - null：无法确认（读取失败、添加没有生效、读不到有效规则而无法区分原因、未探测），原因见 tempListNote。
   *   null 不等于映射不可用，也不能当作可用。
   */
  tempListConfirmed: boolean | null;
  /** tempListConfirmed 不为 true 时的原因。 */
  tempListNote: string | null;
  /** 添加后读取 listTempRules 失败的错误码（此时 tempListConfirmed 为 null）。 */
  tempListReadError: string | null;
  /**
   * addTempRule 是否生效：两条探测规则出现在临时规则列表或有效规则中为 true；有效规则可读、两处都没有（全部）
   * 看到为 false（归咎于 addTempRule，不归咎于 listTempRules）；读不到有效规则且临时规则列表没有列出时为 null。
   */
  addConfirmed: boolean | null;
  /**
   * rule match 看到的求值顺序：合成请求命中先添加的一条为 tail、后添加的一条为 head；null = 未求值、读取失败或没有命中
   * 任何一条探测规则（原因见 matchNote；没有命中可能说明 rule match 不包含临时规则，TODO(P0)）。
   */
  matchInsertion: 'head' | 'tail' | null;
  /** 求值顺序没有得到结论、与有效规则列表中的先后不一致，或删除后仍命中探测规则时的说明。 */
  matchNote: string | null;
  /** rule match 的原始结果：两条都添加之后一次、全部删除之后一次。 */
  matchObservations: MatchObservation[];
  skipped?: string;
}

function codeOf(e: unknown): string {
  return e instanceof SfeError ? e.code : 'ERROR';
}

/** rule match 的回显是哪一条探测规则（允许带或不带策略、空白不同）；都不是为 -1。 */
function probeRuleIndex(rule: string | null): number {
  if (rule === null) return -1;
  return INSERTION_PROBE_RULES.findIndex((r) => sameRuleText(rule, r));
}

/**
 * 临时规则插入位置探测：依次添加两条只匹配合成进程的 REJECT 规则，先正向确认临时规则列表能列出它们，再按有效规则列表中的
 * 先后与 rule match 的求值顺序判断新规则插在前还是后（两者不一致时不下结论）、是否排在测试配置规则之前，最后逐条按原文
 * 删除（从不 flush），并再求值一次确认删除已生效。register 在每次添加前登记意图（回退只删登记过的规则）。当前临时规则中已有
 * 相同（规范化后）的规则或读不到列表时不探测：添加与删除都按文本，会删掉或接管用户自己的规则。listTempRules 没有列出探测
 * 规则时，用有效规则列表区分原因：只有确认添加已生效时才判定列表不可用。opts.ruleMatch 为 false（matchRule 没有可用实现）
 * 时不求值。
 */
export async function probeTempInsertion(
  adapter: SurgeAdapter,
  register: (rule: string) => Promise<void>,
  markRemoved: (rule: string) => Promise<void>,
  opts: { profileRules?: readonly string[] | null; ruleMatch?: boolean } = {},
): Promise<InsertionProbeResult> {
  let existing: string[] | null;
  try {
    existing = await adapter.listTempRules();
  } catch {
    existing = null;
  }
  const useMatch = opts.ruleMatch !== false;
  const none = {
    insertion: null,
    beforeProfileRules: null,
    boundaryNote: null,
    tempListConfirmed: null,
    tempListReadError: null,
    addConfirmed: null,
    matchInsertion: null,
    matchNote: null,
    matchObservations: [] as MatchObservation[],
  } as const;
  if (existing === null) return { ...none, matchObservations: [], tempListNote: '读不到当前临时规则，未探测', skipped: '读不到当前临时规则，未探测' };
  const present = new Set(existing.map(normalizeRuleText));
  if (INSERTION_PROBE_RULES.some((r) => present.has(normalizeRuleText(r)))) {
    return { ...none, matchObservations: [], tempListNote: '已存在相同的临时规则，未探测', skipped: '已存在相同的临时规则，未探测（不会删除它）' };
  }
  const added: string[] = [];
  const result = await (async (): Promise<InsertionProbeResult> => {
    try {
      for (const r of INSERTION_PROBE_RULES) {
        await register(r);
        await adapter.addTempRule(r);
        added.push(r);
      }
      let listed: string[] | null = null;
      let tempListReadError: string | null = null;
      try {
        listed = await adapter.listTempRules();
      } catch (e) {
        tempListReadError = codeOf(e);
      }
      let rules: SurgeRuleRecord[] | null;
      try {
        rules = await adapter.listRules();
      } catch {
        rules = null;
      }
      const listedN = new Set((listed ?? []).map(normalizeRuleText));
      const listedBoth = listed !== null && INSERTION_PROBE_RULES.every((r) => listedN.has(normalizeRuleText(r)));
      const idx = (r: string): number => (rules ?? []).findIndex((x) => normalizeRuleText(x.text) === normalizeRuleText(r));
      const i1 = idx(INSERTION_PROBE_RULES[0]);
      const i2 = idx(INSERTION_PROBE_RULES[1]);
      const found = i1 >= 0 && i2 >= 0;
      const addConfirmed = listedBoth || found ? true : rules === null ? null : false;

      let tempListConfirmed: boolean | null;
      let tempListNote: string | null;
      if (listed === null) {
        tempListConfirmed = null;
        tempListNote = `添加后读取临时规则失败（${tempListReadError ?? 'ERROR'}）：本次无法确认 listTempRules（不等于映射不可用）`;
      } else if (listedBoth) {
        tempListConfirmed = true;
        tempListNote = null;
      } else if (addConfirmed === true) {
        tempListConfirmed = false;
        tempListNote = 'listTempRules 没有列出刚添加的探测规则（有效规则中能看到它们）：该原语映射不可用';
      } else if (addConfirmed === false) {
        tempListConfirmed = null;
        tempListNote = '临时规则列表与有效规则中都没有（全部）刚添加的探测规则：addTempRule 可能没有生效，无法确认 listTempRules';
      } else {
        tempListConfirmed = null;
        tempListNote = 'listTempRules 没有列出刚添加的探测规则，且读不到有效规则列表：无法区分是添加没有生效还是列表映射不可用';
      }

      // rule match 的求值顺序：两条都命中同一合成请求，先求值的一条被返回。
      const matchObservations: MatchObservation[] = [];
      let matchInsertion: 'head' | 'tail' | null = null;
      let matchNote: string | null = useMatch ? null : 'matchRule 没有可用实现：没有用 rule match 核对求值顺序';
      if (useMatch) {
        const o = await observeMatch(adapter, '两条探测规则都已添加', INSERTION_PROBE_PROCESS_PATH);
        matchObservations.push(o);
        const hit = probeRuleIndex(o.rule);
        if (hit === 0) matchInsertion = 'tail';
        else if (hit === 1) matchInsertion = 'head';
        else if (o.error !== null) matchNote = `rule match ${describeObservation(o)}：没有得到求值顺序`;
        else matchNote = `rule match 没有命中任何一条探测规则（${describeObservation(o)}）：rule match 可能不包含临时规则，或添加没有生效（TODO(P0)）`;
      }
      const listInsertion = found ? (i2 < i1 ? 'head' : 'tail') : null;
      let insertion = listInsertion ?? matchInsertion;
      if (listInsertion !== null && matchInsertion !== null && listInsertion !== matchInsertion) {
        insertion = null;
        matchNote = `有效规则列表中的先后（${listInsertion}）与 rule match 的求值顺序（${matchInsertion}）不一致：无法判断插入位置`;
      }
      const base = { insertion, tempListConfirmed, tempListNote, tempListReadError, addConfirmed, matchInsertion, matchNote, matchObservations };

      if (rules === null) {
        return { ...base, beforeProfileRules: null, boundaryNote: '读不到有效规则列表，无法判断插入位置与配置规则的先后' };
      }
      const boundary = profileBoundary(rules, opts.profileRules);
      const beforeProfileRules = !found || boundary.index === null ? null : Math.max(i1, i2) < boundary.index;
      const boundaryNote = !found ? '有效规则中找不到探测规则，无法判断与配置规则的先后' : boundary.note;
      return { ...base, beforeProfileRules, boundaryNote };
    } finally {
      for (const r of [...added].reverse()) {
        try {
          await adapter.removeTempRule(r);
          await markRemoved(r);
        } catch {
          /* 由回退处理 */
        }
      }
    }
  })();
  // 全部删除之后再求值一次：仍命中探测规则说明删除没有生效（规则已登记，由 rollback 逐条删除）。
  if (useMatch && added.length > 0) {
    const o = await observeMatch(adapter, '两条探测规则都已删除', INSERTION_PROBE_PROCESS_PATH);
    result.matchObservations.push(o);
    if (probeRuleIndex(o.rule) >= 0) {
      const note = `删除后 rule match 仍命中探测规则「${o.rule}」：删除可能没有生效，运行 rollback --execute 并在 Surge 中核对`;
      result.matchNote = result.matchNote ? `${result.matchNote}；${note}` : note;
    }
  }
  return result;
}

/** 见证形式核对使用的位：任意一位都是同一形式，取 active。 */
export const WITNESS_CHECK_BIT = 'active' as const;

/**
 * 见证形式核对的一次求值与预期：
 * - witness / placeholder：必须命中对应的测试临时规则，策略为 REJECT 类；
 * - neither：不能命中任何一条测试临时规则（完整路径模式是精确匹配、大小写敏感、不做路径规范化）；
 * - clean：退出 0，且不命中测试规则、本应用入口规则或 SFE-ROUTE（求值不依赖 DNS，结果是用户规则或 FINAL）；“添加前”的一次
 *   另由 probeWitnessForm 按有效规则列表核对命中规则排在入口段之后（只看命中的是谁，看不出入口段之前的遮挡规则）；
 * - info：只记录（例如占位路径在 NORMAL 下是否经入口 RULE-SET 命中，即配置引用的本地规则集是否已加载）。
 */
export type WitnessExpect = 'witness' | 'placeholder' | 'neither' | 'clean' | 'info';

export interface WitnessFormProbe extends MatchObservation {
  phase: 'before' | 'added' | 'removed';
  expect: WitnessExpect;
  /** 是否符合预期；info 为 null；无法连接等不能当作回答的失败为 null，非零退出是确定的回答（false）。 */
  ok: boolean | null;
}

/**
 * 添加前见证探测命中的规则与入口段的先后。服务的见证行在入口规则集文件里，求值先到达的任何规则（模块、用户临时规则、
 * 入口段之前的配置规则）只要命中 192.0.2.1 的这一合成请求，见证就永远读不到；“clean” 只看命中的是谁，看不出这一点，
 * 所以另按有效规则列表比较位置。
 */
export interface WitnessHitPosition {
  /** 命中规则在有效规则列表中的位置（按规范化文本的第一次出现）；null = 没有找到或读不到列表。 */
  hitIndex: number | null;
  /** 第一条入口 RULE-SET（指向 sfe-entry-*.list）的位置；null = 没有找到或读不到列表。 */
  entryIndex: number | null;
  /** listRules 报告的命中规则来源与模块名（真实 CLI/HTTP 解析只报告 module/unknown）；没有找到为 null。 */
  source: SurgeRuleRecord['source'] | null;
  moduleName: string | null;
  /** 命中规则是否排在入口段之前：true 即见证在这份配置上被挡住；null = 无法判断（原因见 note），按失败即关闭处理。 */
  beforeEntry: boolean | null;
  note: string | null;
}

/** 规则是否本应用的入口 RULE-SET（按文件名，与服务 ruleset-strategy 的 bitOfRuleSet 相同）。 */
function isEntryRuleSet(text: string): boolean {
  const c = parseRule(text)?.condition ?? parseCondition(text);
  if (!c || c.type !== 'RULE-SET' || !c.value) return false;
  const base = c.value.slice(c.value.lastIndexOf('/') + 1);
  return (Object.values(ENTRY_RULESET_FILES) as string[]).includes(base);
}

/**
 * 命中规则与入口段的先后：按有效规则列表的顺序比较（TODO(P0)：列表顺序即求值顺序，模块规则与临时规则之间的先后文档没有写明，
 * 只写临时规则 “precede all profile rules”，https://manual.nssurge.com/tools/cli.html；插入探测核对临时规则的这一部分）。
 * 命中的规则不在列表中（例如回显的是规则集中的子规则，TODO(P0)）或找不到入口 RULE-SET 时无法判断。
 */
export function locateWitnessHit(rules: readonly SurgeRuleRecord[], hitRule: string): WitnessHitPosition {
  const entryIndex = rules.findIndex((r) => isEntryRuleSet(r.text));
  const hitIndex = rules.findIndex((r) => sameRuleText(hitRule, r.text));
  const hit = hitIndex >= 0 ? rules[hitIndex]! : null;
  const base = { hitIndex: hitIndex >= 0 ? hitIndex : null, entryIndex: entryIndex >= 0 ? entryIndex : null, source: hit?.source ?? null, moduleName: hit?.moduleName ?? null };
  if (entryIndex < 0) return { ...base, beforeEntry: null, note: '有效规则中找不到入口 RULE-SET：无法判断命中规则是否排在入口段之前' };
  if (hitIndex < 0) return { ...base, beforeEntry: null, note: `有效规则中找不到添加前命中的规则「${hitRule}」（可能是规则集中的子规则，TODO(P0)）：无法判断它是否排在入口段之前` };
  if (hitIndex < entryIndex) {
    const from = hit!.source === 'module' ? `模块${hit!.moduleName ? ` ${hit!.moduleName}` : ''}` : `来源 ${hit!.source}`;
    return { ...base, beforeEntry: true, note: `添加前命中的规则「${hitRule}」（${from}）排在入口段之前：服务的见证在这份配置上被它挡住，一直读不到` };
  }
  return { ...base, beforeEntry: false, note: null };
}

export interface WitnessFormResult {
  /** 全部符合为 true；任一不符为 false；没有不符但有无法判断的项（或清理失败、未运行）为 null。 */
  ok: boolean | null;
  witnessPath: string;
  /** 两条测试临时规则（按原文添加与删除）。 */
  rules: { witness: string; placeholder: string };
  probes: WitnessFormProbe[];
  /** 添加前见证探测命中的规则与入口段的先后（只在该次探测得到回答时求出）；null = 未求出。 */
  beforeHit: WitnessHitPosition | null;
  /** 删除后临时规则列表中是否仍有测试规则；读不到为 null。 */
  leftInTempList: boolean | null;
  notes: string[];
  skipped: string | null;
}

/** 见证形式核对的两条测试临时规则：服务写入规则集文件的见证行与占位行（加上 REJECT 策略），见 service generate.ts。 */
export function witnessFormRules(token: string): { witnessPath: string; witness: string; placeholder: string } {
  const witnessPath = entryWitnessProcessPath(WITNESS_CHECK_BIT, token);
  return { witnessPath, witness: `PROCESS-NAME,${witnessPath},REJECT`, placeholder: `PROCESS-NAME,${ENTRY_PLACEHOLDER_PROCESS_PATH},REJECT` };
}

/** 同长度、只差最后一个字符的另一标记（精确匹配不能把它当作同一路径）。 */
function siblingToken(token: string): string {
  const last = token[token.length - 1]!;
  return `${token.slice(0, -1)}${last === '0' ? '1' : '0'}`;
}

function judgeWitnessProbe(o: MatchObservation, expect: WitnessExpect, rules: { witness: string; placeholder: string }, safariPaths: readonly string[]): boolean | null {
  if (expect === 'info') return null;
  if (o.error !== null) return o.exitCode !== null ? false : null;
  const rule = o.rule ?? '';
  const policy = o.policy ?? '';
  const isWitness = sameRuleText(rule, rules.witness);
  const isPlaceholder = sameRuleText(rule, rules.placeholder);
  switch (expect) {
    case 'witness':
      return isWitness && REJECT_POLICIES.has(policy.trim().toUpperCase());
    case 'placeholder':
      return isPlaceholder && REJECT_POLICIES.has(policy.trim().toUpperCase());
    case 'neither':
      return !isWitness && !isPlaceholder;
    case 'clean':
      return !isWitness && !isPlaceholder && !isEntryRule(rule, safariPaths) && outcomeOfPolicy(policy) !== 'route';
  }
}

/**
 * 在真实 Surge 上核对服务入口读回依赖的见证形式（ARCHITECTURE §5.5；设计复核 p0Confirmations 2–4）：
 * 1. 添加前：`rule match <ENTRY_PROBE_IPV4> process-path=<见证路径>` 必须退出 0、得到非本应用的回答（不存在的路径被接受，
 *    求值不依赖 DNS），且命中的规则在有效规则列表中排在第一条入口 RULE-SET 之后（locateWitnessHit：排在之前为不符，
 *    读不到列表或找不到该规则为无法判断；记录它的来源）；
 * 2. 按原文添加 `PROCESS-NAME,<见证路径>,REJECT` 与 `PROCESS-NAME,<占位路径>,REJECT` 两条临时规则后：见证路径与占位路径各自
 *    命中自己的规则；另一标记、前缀延长、/private/var 形式、大写 /VAR 形式、对照进程（Chrome）、/usr/bin/true 与 Safari 路径
 *    都不能命中任何一条（完整路径模式精确匹配、“Matching is case-sensitive in all modes.”，rules/process.html）；
 * 3. 逐条按原文删除（从不 flush）后：同一见证探测再次退出 0、得到非本应用的回答。
 * 前置：能读到当前临时规则，且其中没有相同（规范化后）的规则（添加与删除都按文本，会删掉或接管用户自己的规则）。
 * 任何一步的原始结果都记入 probes；结论失败即关闭：不符为 false，无法判断为 null。TODO(P0)：Surge 是否把 /var 规范化为
 * /private/var、是否拒绝不存在的路径——都由本核对如实记录，服务在两种情况下见证都读不到（超时，失败即关闭）。
 */
export async function probeWitnessForm(
  adapter: SurgeAdapter,
  register: (rule: string) => Promise<void>,
  markRemoved: (rule: string) => Promise<void>,
  opts: { token: string; safariPaths: readonly string[]; controlPaths: readonly string[] },
): Promise<WitnessFormResult> {
  const { witnessPath, witness, placeholder } = witnessFormRules(opts.token);
  const rules = { witness, placeholder };
  const result: WitnessFormResult = { ok: null, witnessPath, rules, probes: [], beforeHit: null, leftInTempList: null, notes: [], skipped: null };
  let existing: string[] | null;
  try {
    existing = await adapter.listTempRules();
  } catch {
    existing = null;
  }
  if (existing === null) return { ...result, skipped: '读不到当前临时规则，未核对' };
  const present = new Set(existing.map(normalizeRuleText));
  if ([witness, placeholder].some((r) => present.has(normalizeRuleText(r)))) return { ...result, skipped: '已存在相同的临时规则，未核对（不会删除它）' };

  const probe = async (phase: WitnessFormProbe['phase'], label: string, processPath: string, expect: WitnessExpect): Promise<void> => {
    const o = await observeMatch(adapter, label, processPath);
    result.probes.push({ ...o, phase, expect, ok: judgeWitnessProbe(o, expect, rules, opts.safariPaths) });
  };

  await probe('before', '添加前：见证路径（不存在的进程）', witnessPath, 'clean');
  // 命中的规则必须排在入口段之后：之前的规则（不论策略）会挡住服务的见证。后面“添加后”的见证探测看不出这一点——测试规则是
  // 临时规则，它与模块规则谁先求值文档没有写明（TODO(P0)），用户的临时规则又可能排在新规则之后。
  const first = result.probes[0]!;
  if (first.rule !== null) {
    let listed: SurgeRuleRecord[] | null;
    try {
      listed = await adapter.listRules();
    } catch {
      listed = null;
    }
    result.beforeHit =
      listed === null
        ? { hitIndex: null, entryIndex: null, source: null, moduleName: null, beforeEntry: null, note: '读不到有效规则列表：无法判断添加前命中的规则是否排在入口段之前' }
        : locateWitnessHit(listed, first.rule);
    if (first.ok === true && result.beforeHit.beforeEntry !== false) first.ok = result.beforeHit.beforeEntry === true ? false : null;
    if (result.beforeHit.note !== null) result.notes.push(result.beforeHit.note);
  }
  await probe('before', '添加前：占位路径（NORMAL 下应经入口规则集命中，说明本地规则集已加载）', ENTRY_PLACEHOLDER_PROCESS_PATH, 'info');

  const added: string[] = [];
  let cleanupFailed = false;
  try {
    for (const r of [witness, placeholder]) {
      await register(r);
      await adapter.addTempRule(r);
      added.push(r);
    }
    await probe('added', '见证路径', witnessPath, 'witness');
    await probe('added', '占位路径', ENTRY_PLACEHOLDER_PROCESS_PATH, 'placeholder');
    const sibling = siblingToken(opts.token);
    await probe('added', '另一标记的见证路径', entryWitnessProcessPath(WITNESS_CHECK_BIT, sibling), 'neither');
    await probe('added', '前缀延长的见证路径', `${witnessPath}0`, 'neither');
    await probe('added', '/private/var 形式的见证路径', `/private${witnessPath}`, 'neither');
    await probe('added', '大写 /VAR 形式的见证路径', `/VAR${witnessPath.slice('/var'.length)}`, 'neither');
    await probe('added', '/private/var 形式的占位路径', `/private${ENTRY_PLACEHOLDER_PROCESS_PATH}`, 'neither');
    for (const p of opts.controlPaths) await probe('added', '对照进程', p, 'neither');
    await probe('added', '其他进程 /usr/bin/true', '/usr/bin/true', 'neither');
    for (const p of opts.safariPaths) await probe('added', 'Safari 进程', p, 'neither');
  } catch (e) {
    result.notes.push(`添加测试临时规则失败（${codeOf(e)}）：没有完成核对`);
  } finally {
    for (const r of [...added].reverse()) {
      try {
        await adapter.removeTempRule(r);
        await markRemoved(r);
      } catch (e) {
        cleanupFailed = true;
        result.notes.push(`按原文删除 ${r} 失败（${codeOf(e)}）：规则已登记，运行 rollback --execute 并在 Surge 中核对`);
      }
    }
  }
  if (added.length > 0) {
    let after: string[] | null;
    try {
      after = await adapter.listTempRules();
    } catch {
      after = null;
    }
    result.leftInTempList = after === null ? null : after.some((t) => [witness, placeholder].some((r) => normalizeRuleText(t) === normalizeRuleText(r)));
    if (result.leftInTempList === true) result.notes.push('删除后临时规则列表中仍有测试规则：运行 rollback --execute 并在 Surge 中核对');
    await probe('removed', '删除后：见证路径', witnessPath, 'clean');
    await probe('removed', '删除后：占位路径', ENTRY_PLACEHOLDER_PROCESS_PATH, 'info');
  }

  const judged = result.probes.filter((p) => p.expect !== 'info');
  const complete = added.length === 2 && !cleanupFailed && result.leftInTempList !== true;
  if (judged.some((p) => p.ok === false) || result.leftInTempList === true) result.ok = false;
  else if (complete && judged.every((p) => p.ok === true)) result.ok = true;
  else result.ok = null;
  return result;
}

/** 见证形式核对的一行说明（检查项的备注与摘要）。 */
export function describeWitnessForm(r: WitnessFormResult): string {
  if (r.skipped !== null) return r.skipped;
  const judged = r.probes.filter((p) => p.expect !== 'info');
  const bad = judged.filter((p) => p.ok === false);
  const unknown = judged.filter((p) => p.ok === null);
  const info = r.probes.filter((p) => p.expect === 'info').map((p) => `${p.label}：${describeObservation(p)}`);
  const first = r.probes.find((p) => p.phase === 'before' && p.expect === 'clean');
  return [
    `核对 ${judged.length} 次求值（目标 ${ENTRY_PROBE_IPV4}）`,
    ...(first ? [`添加前见证路径${describeObservation(first)}`] : []),
    ...(bad.length > 0 ? [`不符 ${bad.length} 次：${bad.slice(0, 3).map((p) => `${p.label}（预期 ${p.expect}）${describeObservation(p)}`).join('；')}`] : []),
    ...(unknown.length > 0 ? [`无法判断 ${unknown.length} 次`] : []),
    ...info.slice(0, 2),
    ...r.notes,
  ].join('；');
}
