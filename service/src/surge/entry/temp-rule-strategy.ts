// temp_rule 入口策略：每个位对应一条本应用记录的精确临时规则，逐条增删，从不 flush。
// 规则先后由 Surge 的插入位置决定（P0 实测）：写入前按插入位置预测每一步的实际语义，
// 会出现放行窗口或无法到达目标时在写入前拒绝；写入后按有效规则顺序运行时读回。
// 同文的临时规则已存在但无本应用记录时停止（NAME_COLLISION），不收编。
// 撤销本应用入口（普通模式、回滚）遇到重复、无法识别或不在有效规则中的本应用记录时，逐条清理本应用记录的规则，
// 只走从不放宽的步骤（cleanupForUndo）。见 docs/ARCHITECTURE.md §5.5。

import { SfeError, type EntryBits, type KnownEntryMode } from '@sfe/contract';
import type { EntryCleanupStep, EntryController, EntryReadback, EntryStep, SurgeRuleRecord } from '../../ports.js';
import { ENTRY_BITS_IN_ORDER, ENTRY_BIT_POLICY, tempRuleText, type EntryBit } from '../generate.js';
import { classifyPrecedence, hasBlockingIssue } from '../precedence.js';
import { normalizeRuleText, parseRule, type RuleCondition } from '../rules.js';
import {
  allowedModes,
  bitsFromOrder,
  modeOfSemantic,
  semanticOfOrder,
  stepFailure,
  withLastConfirmed,
  type EntryConfig,
  type EntryStrategyDeps,
} from './common.js';
import type { EntryOwnedRecord } from './ownership.js';
import { knownModeOfBits, planFromBits } from './plan.js';

export type TempRuleInsertion = 'head' | 'tail';

export interface TempRuleStrategyDeps extends EntryStrategyDeps {
  /** P0 实测的新临时规则插入位置；未知时要求两种位置下都安全才写入。 */
  insertion?: TempRuleInsertion;
}

function isProcessExpr(c: RuleCondition): boolean {
  if (c.type === 'PROCESS-NAME') return true;
  return c.type === 'OR' && (c.operands ?? []).length > 0 && c.operands!.every((o) => o.type === 'PROCESS-NAME');
}

/** 按结构识别本应用记录的临时规则属于哪一位（配置中的进程路径可能已变化）。 */
export function classifyEntryTempRule(text: string): EntryBit | null {
  const r = parseRule(text);
  if (!r) return null;
  const policy = (r.policy ?? '').toUpperCase();
  const c = r.condition;
  if (c.type === 'AND' && c.operands?.length === 2 && isProcessExpr(c.operands[0]!)) {
    const second = c.operands[1]!;
    if (second.type === 'PROTOCOL' && second.value?.toUpperCase() === 'UDP' && policy === ENTRY_BIT_POLICY.udp) return 'udp';
    if (second.type === 'DOMAIN' && r.policy === ENTRY_BIT_POLICY.verify) return 'verify';
    return null;
  }
  if (isProcessExpr(c)) {
    if (policy === ENTRY_BIT_POLICY.block) return 'block';
    if (r.policy === ENTRY_BIT_POLICY.active) return 'active';
  }
  return null;
}

/** 本应用记录的临时规则属于哪一位：先按当前配置的期望文本，再按结构识别；都不是时为 null。 */
function bitOfRecord(identity: string, expected: Record<EntryBit, string>): EntryBit | null {
  const n = normalizeRuleText(identity);
  return ENTRY_BITS_IN_ORDER.find((b) => normalizeRuleText(expected[b]) === n) ?? classifyEntryTempRule(identity);
}

/** 让入口状态无法按位确定的异常：只有撤销本应用入口时才逐条清理（cleanupForUndo），其他切换一律拒绝。 */
function isAmbiguous(anomalies: readonly string[]): boolean {
  return anomalies.some((a) => a.startsWith('duplicate_') || a === 'unrecognized_record' || a === 'not_in_effective_rules');
}

type CleanupKind = EntryCleanupStep['kind'];

/**
 * 撤销清理的移除顺序：先移除会路由的规则（active、verify），再移除语义未知的规则，最后移除 REJECT 规则（udp、block）。
 * 移除一条规则只会让它匹配的流量落到后面的规则：路由规则先走，之后移除的 REJECT 规则后面就不再有本应用的路由规则，
 * 原来被拒绝的流量不会因此经 SFE-ROUTE 发出（无法识别的规则可能路由，所以排在 udp 之前）。
 */
const CLEANUP_ORDER: readonly CleanupKind[] = ['active', 'verify', 'unrecognized', 'udp', 'block'];

/** 撤销清理的一步（opts.onCleanup、最终读回证据与错误 details.undoCleanup）。 */
type CleanupEntry = EntryCleanupStep;

interface CleanupItem {
  kind: CleanupKind;
  /** 临时规则列表中的原文（删除时用 Surge 列出的文本）。 */
  text: string;
  textN: string;
  /** 归一化后同文的全部本应用记录。 */
  identities: string[];
}

/** 撤销清理中的错误不声称任何已确认状态；清理之后常规步骤的错误保留它们自己的最后确认状态。都附上已做的清理步骤。 */
function withCleanupTrail(e: unknown, trail: readonly CleanupEntry[]): SfeError {
  const base = e instanceof SfeError && e.details !== undefined && 'lastConfirmedBits' in e.details ? e : withLastConfirmed(e, null, null);
  return new SfeError(base.code, base.message, {
    fieldErrors: base.fieldErrors,
    details: { ...(base.details ?? {}), undoCleanup: trail.map((t) => ({ ...t })) },
    cause: base,
  });
}

function cleanupEvidence(trail: readonly CleanupEntry[]): string {
  const label = (k: CleanupKind): string => (k === 'unrecognized' ? '无法识别' : k);
  return `撤销入口时逐条清理了本应用的临时规则：${trail.map((t) => `${t.action === 'add' ? '加入' : '移除'} ${label(t.kind)}「${t.rule}」`).join('；')}`;
}

interface TempState {
  cfg: EntryConfig;
  expected: Record<EntryBit, string>;
  records: EntryOwnedRecord[];
  /** 临时规则列表原文。 */
  temps: string[];
  tempsN: Set<string>;
  rules: SurgeRuleRecord[];
  /** 已记录且出现在临时规则列表中的规则文本。 */
  presentText: Partial<Record<EntryBit, string>>;
  bits: EntryBits;
  /** 本应用规则在有效规则中的先后；有规则缺席时为 null。 */
  order: EntryBit[] | null;
  /** 期望文本已存在于临时规则但没有本应用记录。 */
  foreign: EntryBit[];
  anomalies: string[];
  ourTextsN: Set<string>;
}

export function createTempRuleStrategy(deps: TempRuleStrategyDeps): EntryController {
  async function load(): Promise<TempState> {
    const cfg = deps.config();
    const expected = Object.fromEntries(ENTRY_BITS_IN_ORDER.map((b) => [b, tempRuleText(b, cfg)])) as Record<EntryBit, string>;
    const records = await deps.ownership.getRecordedTempRules();
    const temps = await deps.adapter.listTempRules();
    const rules = await deps.adapter.listRules();
    const tempsN = new Set(temps.map(normalizeRuleText));
    const anomalies: string[] = [];
    const presentText: Partial<Record<EntryBit, string>> = {};
    const ourTextsN = new Set<string>();
    for (const rec of records) {
      const n = normalizeRuleText(rec.identity);
      ourTextsN.add(n);
      const bit = bitOfRecord(rec.identity, expected);
      if (!bit) {
        anomalies.push('unrecognized_record');
        continue;
      }
      const inList = tempsN.has(n);
      if (rec.state === 'pending_add' || rec.state === 'pending_remove') anomalies.push(`pending_${bit}`);
      if (rec.state === 'present' && !inList) anomalies.push(`missing_${bit}`);
      if (inList) {
        if (presentText[bit] !== undefined) anomalies.push(`duplicate_${bit}`);
        presentText[bit] = rec.identity;
      }
    }
    const foreign = ENTRY_BITS_IN_ORDER.filter((b) => {
      const n = normalizeRuleText(expected[b]);
      return tempsN.has(n) && !records.some((r) => normalizeRuleText(r.identity) === n);
    });
    for (const b of foreign) anomalies.push(`foreign_${b}`);
    const presentBits = ENTRY_BITS_IN_ORDER.filter((b) => presentText[b] !== undefined);
    const positions = presentBits.map((b) => {
      const n = normalizeRuleText(presentText[b]!);
      return { b, i: rules.findIndex((r) => normalizeRuleText(r.text) === n) };
    });
    const order = positions.some((p) => p.i < 0) ? null : positions.sort((x, y) => x.i - y.i).map((p) => p.b);
    if (order === null) anomalies.push('not_in_effective_rules');
    const bits = bitsFromOrder(presentBits);
    return { cfg, expected, records, temps, tempsN, rules, presentText, bits, order, foreign, anomalies, ourTextsN };
  }

  function precedenceOf(s: TempState) {
    return classifyPrecedence(s.rules, {
      isOurRule: (r) => s.ourTextsN.has(normalizeRuleText(r.text)),
      processPaths: s.cfg.processPaths,
      siteHosts: s.cfg.siteHosts,
      verifyHost: s.cfg.verifyHost,
    });
  }

  function semanticMode(order: readonly EntryBit[] | null): KnownEntryMode | null {
    return order === null ? null : modeOfSemantic(semanticOfOrder(order));
  }

  /** 只看临时规则与有效顺序（不看优先级）得到的模式。 */
  function baseModeOf(s: TempState): EntryReadback['mode'] {
    const known = knownModeOfBits(s.bits);
    return s.anomalies.length === 0 && known !== null && semanticMode(s.order) === known ? known : 'UNKNOWN';
  }

  function readbackOf(s: TempState): EntryReadback {
    const issues = precedenceOf(s);
    const known = knownModeOfBits(s.bits);
    const sem = semanticMode(s.order);
    const evidence = [
      `临时规则：${ENTRY_BITS_IN_ORDER.filter((b) => s.bits[b]).join('、') || '无'}`,
      `有效规则顺序：${s.order ? s.order.join(' > ') || '无' : '无法确定'}`,
      ...s.anomalies.map((a) => `异常：${a}`),
    ];
    let mode = baseModeOf(s);
    if (mode !== 'UNKNOWN' && known !== sem) evidence.push('规则顺序与位组合不一致');
    if (mode !== 'NORMAL' && mode !== 'UNKNOWN' && hasBlockingIssue(issues)) {
      mode = 'UNKNOWN';
      evidence.push('有规则排在入口之前');
    }
    const ambiguous = s.anomalies.some((a) => a.startsWith('duplicate_') || a === 'unrecognized_record');
    return { mode, bits: ambiguous ? null : s.bits, evidence, precedenceIssues: issues };
  }

  /** 按插入位置预测整段计划；任何一步出现放行或无法到达目标即拒绝。 */
  function predictable(start: EntryBit[], steps: EntryStep[], insertion: TempRuleInsertion, allowed: Set<KnownEntryMode>, to: KnownEntryMode): boolean {
    let order = [...start];
    for (const step of steps) {
      if (step.value) order = insertion === 'head' ? [step.bit, ...order] : [...order, step.bit];
      else order = order.filter((b) => b !== step.bit);
      const mode = semanticMode(order);
      if (mode === null || !allowed.has(mode)) return false;
    }
    return semanticMode(order) === to;
  }

  async function normalizeOwnership(s: TempState): Promise<void> {
    for (const rec of s.records) {
      const inList = s.tempsN.has(normalizeRuleText(rec.identity));
      if (rec.state === 'pending_add' || rec.state === 'pending_remove') {
        await deps.ownership.confirm('temp_rule', rec.identity, inList ? 'present' : 'removed');
      } else if (rec.state === 'present' && !inList) {
        // 例如 Surge 重启后临时规则消失：按事实记为已移除。
        await deps.ownership.confirm('temp_rule', rec.identity, 'removed');
      }
    }
  }

  /** 规则已在临时规则列表中，并且出现在有效规则中。 */
  function inEffect(s: TempState, textN: string): boolean {
    return s.tempsN.has(textN) && s.rules.some((r) => normalizeRuleText(r.text) === textN);
  }

  /**
   * 撤销清理要移除的本应用规则：在临时规则列表中、有本应用记录（不属于本应用记录的规则从不出现）；目标 BLOCKED 时
   * 不含期望的 block 规则。按 CLEANUP_ORDER 排序，同为 block 时当前期望的文本最后移除。
   */
  function cleanupPlan(s: TempState, to: 'BLOCKED' | 'NORMAL'): CleanupItem[] {
    const blockN = normalizeRuleText(s.expected.block);
    const groups = new Map<string, CleanupItem>();
    for (const rec of s.records) {
      const textN = normalizeRuleText(rec.identity);
      if ((to === 'BLOCKED' && textN === blockN) || !s.tempsN.has(textN)) continue;
      const g = groups.get(textN);
      if (g) {
        g.identities.push(rec.identity);
        continue;
      }
      const text = s.temps.find((t) => normalizeRuleText(t) === textN) ?? rec.identity;
      groups.set(textN, { kind: bitOfRecord(rec.identity, s.expected) ?? 'unrecognized', text, textN, identities: [rec.identity] });
    }
    const rank = (i: CleanupItem): number => CLEANUP_ORDER.indexOf(i.kind) * 2 + (i.textN === blockN ? 1 : 0);
    return [...groups.values()].sort((a, b) => rank(a) - rank(b));
  }

  /**
   * 撤销本应用入口（opts.undo：普通模式、回滚；目标 BLOCKED/NORMAL）时，本应用记录的临时规则重复、无法识别或不在有效规则中
   * （例如进程路径或站点变化后期望文本变了，旧文本的记录仍在）：无法按位规划，改为逐条清理本应用记录的规则，只走从不放宽的步骤。
   * - 目标 BLOCKED：先确保期望的 block 规则存在（加入一条 REJECT 规则在任何插入位置都不会放宽；同文规则无本应用记录 →
   *   NAME_COLLISION）并出现在有效规则中，否则不移除任何规则；然后在它一直生效的前提下按 CLEANUP_ORDER 移除其余本应用规则，
   *   Safari 全程不会经 SFE-ROUTE 新放行，也不会落到原规则。
   * - 目标 NORMAL：按 CLEANUP_ORDER 移除全部本应用规则，block 最后移除（block 移除之前已没有本应用的路由规则）。
   * 每步与常规步骤一样：先记录意图、写入、运行时读回、按读到的事实确认归属；任一步失败即停止，不声称已确认状态。
   * 这些步骤不是单个位的变更，不经 onStep 报告：每步确认之后经 note 报告（opts.onCleanup——路由操作写入操作步骤与结果
   * entryCleanup；同时记入最终读回证据与错误 details.undoCleanup）。
   * 返回清理后的状态：之后按常规计划补齐目标位并做最终读回。
   */
  async function cleanupForUndo(start: TempState, to: 'BLOCKED' | 'NORMAL', note: (c: CleanupEntry) => void): Promise<TempState> {
    let s = start;
    const blockN = normalizeRuleText(s.expected.block);
    const reload = async (writeError: unknown): Promise<TempState> => {
      try {
        return await load();
      } catch (e) {
        throw withLastConfirmed(writeError ?? e, null, null);
      }
    };
    if (to === 'BLOCKED') {
      if (s.foreign.includes('block')) {
        throw stepFailure('NAME_COLLISION', '切换入口失败：已有同文的临时规则，但不是本应用添加的', null, { bit: 'block' });
      }
      if (!s.tempsN.has(blockN)) {
        const text = s.expected.block;
        let writeError: unknown = null;
        try {
          await deps.ownership.recordIntent('temp_rule', text, null, deps.operationId(), 'add');
          await deps.adapter.addTempRule(text);
        } catch (e) {
          writeError = e;
        }
        const after = await reload(writeError);
        if (!after.tempsN.has(blockN)) {
          await deps.ownership.confirm('temp_rule', text, 'removed').catch(() => undefined);
          throw writeError !== null
            ? withLastConfirmed(writeError, null, null)
            : stepFailure('READBACK_MISMATCH', '切换入口失败：运行时读回与预期不一致', null, { failedRule: { action: 'add', kind: 'block', rule: text } });
        }
        await deps.ownership.confirm('temp_rule', text, 'present');
        note({ action: 'add', kind: 'block', rule: text });
        s = after;
      }
      if (!inEffect(s, blockN)) {
        // 阻断规则没有出现在有效规则中：此时移除任何规则都可能让 Safari 落到原规则，停止。
        throw stepFailure('UNKNOWN_STATE', '切换入口失败：阻断规则不在有效规则中，无法在保持阻断的前提下撤销本应用的其他临时规则', null, {
          anomalies: s.anomalies,
        });
      }
    }
    for (const item of cleanupPlan(s, to)) {
      let writeError: unknown = null;
      try {
        for (const id of item.identities) await deps.ownership.recordIntent('temp_rule', id, null, deps.operationId(), 'remove');
        await deps.adapter.removeTempRule(item.text);
      } catch (e) {
        writeError = e;
      }
      const after = await reload(writeError);
      if (after.tempsN.has(item.textN)) {
        // 超时等未知结果或报告成功却未生效：按读到的事实确认，停止。
        for (const id of item.identities) await deps.ownership.confirm('temp_rule', id, 'present').catch(() => undefined);
        throw writeError !== null
          ? withLastConfirmed(writeError, null, null)
          : stepFailure('READBACK_MISMATCH', '切换入口失败：运行时读回与预期不一致', null, {
              failedRule: { action: 'remove', kind: item.kind, rule: item.text },
            });
      }
      for (const id of item.identities) await deps.ownership.confirm('temp_rule', id, 'removed');
      note({ action: 'remove', kind: item.kind, rule: item.text });
      s = after;
      if (to === 'BLOCKED' && !inEffect(s, blockN)) {
        // 阻断规则被移除或不再出现在有效规则中：不再移除任何规则。
        throw stepFailure('READBACK_MISMATCH', '切换入口失败：清理中阻断规则不再生效', null, { anomalies: s.anomalies });
      }
    }
    return s;
  }

  /** 从无歧义的状态按单个位逐步切换（planFromBits），每步写入后运行时读回，最后读回目标模式。 */
  async function runPlan(start: TempState, to: KnownEntryMode, onStep?: (step: EntryStep) => void): Promise<EntryReadback> {
    let s = start;
    let lastConfirmed: EntryBits = { ...s.bits };
    const fromMode = semanticMode(s.order) ?? 'UNKNOWN';
    if ((to === 'VERIFY_ONLY' || to === 'ACTIVE') && hasBlockingIssue(precedenceOf(s))) {
      throw stepFailure('PRECEDENCE_VIOLATION', '切换入口失败：有规则排在入口之前，可能抢先匹配 Safari 流量', lastConfirmed, {
        precedenceIssues: precedenceOf(s),
      });
    }
    const steps = planFromBits(s.bits, to);
    const collision = steps.find((st) => st.value && s.foreign.includes(st.bit));
    if (collision) {
      throw stepFailure('NAME_COLLISION', '切换入口失败：已有同文的临时规则，但不是本应用添加的', lastConfirmed, { bit: collision.bit });
    }
    const allowed = allowedModes(fromMode, to);
    const insertions: TempRuleInsertion[] = deps.insertion ? [deps.insertion] : ['head', 'tail'];
    for (const ins of insertions) {
      if (!predictable(s.order ?? [], steps, ins, allowed, to)) {
        throw stepFailure('CAPABILITY_UNVERIFIED', '切换入口失败：临时规则的插入位置无法保证入口规则顺序', lastConfirmed, {
          insertion: ins,
          to,
        });
      }
    }

    for (const step of steps) {
      const text = step.value ? s.expected[step.bit] : s.presentText[step.bit]!;
      let writeError: unknown = null;
      try {
        await deps.ownership.recordIntent('temp_rule', text, null, deps.operationId(), step.value ? 'add' : 'remove');
        if (step.value) await deps.adapter.addTempRule(text);
        else await deps.adapter.removeTempRule(text);
      } catch (e) {
        writeError = e;
      }
      let after: TempState;
      try {
        after = await load();
      } catch (e) {
        // 写入结果与当前状态都无法读到：不再声称任何已确认状态。
        throw withLastConfirmed(writeError ?? e, null, step);
      }
      const textPresent = after.tempsN.has(normalizeRuleText(text));
      if (writeError !== null && (step.value ? !textPresent : textPresent)) {
        // 超时等未知结果：读到的事实表明这一步没有生效，上一确认状态仍然成立。
        await deps.ownership.confirm('temp_rule', text, textPresent ? 'present' : 'removed').catch(() => undefined);
        throw withLastConfirmed(writeError, lastConfirmed, step);
      }
      const mode = semanticMode(after.order);
      const bitsOk = (Object.keys(step.bits) as EntryBit[]).every((b) => after.bits[b] === step.bits[b]);
      if (!bitsOk || mode === null || !allowed.has(mode)) {
        let present = textPresent;
        if (step.value && textPresent) {
          // 刚加入的规则造成了放行或顺序不符：移除它回到上一确认状态（更严格），不再继续。
          try {
            await deps.adapter.removeTempRule(text);
            present = (await deps.adapter.listTempRules()).map(normalizeRuleText).includes(normalizeRuleText(text));
          } catch {
            present = true;
          }
        }
        await deps.ownership.confirm('temp_rule', text, present ? 'present' : 'removed').catch(() => undefined);
        // 本条规则回到了步骤之前的状态时，上一确认状态仍然成立；否则无法确定。
        const unchanged = step.value ? !present : present;
        throw stepFailure('READBACK_MISMATCH', '切换入口失败：运行时读回与预期不一致', unchanged ? lastConfirmed : null, {
          failedStep: { bit: step.bit, value: step.value },
          observedMode: mode ?? 'UNKNOWN',
        });
      }
      await deps.ownership.confirm('temp_rule', text, step.value ? 'present' : 'removed');
      lastConfirmed = { ...step.bits };
      s = after;
      onStep?.(step);
    }

    let finalState: TempState;
    let final: EntryReadback;
    try {
      finalState = await load();
      final = readbackOf(finalState);
    } catch (e) {
      throw withLastConfirmed(e, lastConfirmed, null);
    }
    if (final.mode !== to) {
      // 只有入口规则已是目标模式、仅因有规则排在入口之前而不能宣称受控时，才是 PRECEDENCE_VIOLATION。
      const code = baseModeOf(finalState) === to && hasBlockingIssue(final.precedenceIssues) ? 'PRECEDENCE_VIOLATION' : 'READBACK_MISMATCH';
      throw new SfeError(code, '切换入口失败：最终读回不是目标模式', {
        details: { lastConfirmedBits: lastConfirmed, observedMode: final.mode, precedenceIssues: final.precedenceIssues },
      });
    }
    return final;
  }

  return {
    strategy: 'temp_rule',

    async read() {
      return readbackOf(await load());
    },

    async transition(to, onStep, opts) {
      let s: TempState;
      try {
        s = await load();
        await normalizeOwnership(s);
        s = await load();
      } catch (e) {
        throw withLastConfirmed(e, null, null);
      }
      if (!isAmbiguous(s.anomalies)) return runPlan(s, to, onStep);
      // 重复、无法识别或不在有效规则中的本应用记录：只有撤销本应用入口（普通模式、回滚）逐条清理（§5.2 进入普通模式永远可用）；
      // 激活方向与未标为撤销的切换照常拒绝，从不在无法确定的状态上走向 VERIFY_ONLY/ACTIVE。
      if (!(opts?.undo === true && (to === 'BLOCKED' || to === 'NORMAL'))) {
        throw stepFailure('UNKNOWN_STATE', '切换入口失败：无法确定当前入口状态', null, { anomalies: s.anomalies });
      }
      const trail: CleanupEntry[] = [];
      const onCleanup = opts.onCleanup;
      const note = (c: CleanupEntry): void => {
        trail.push(c);
        onCleanup?.({ ...c });
      };
      try {
        s = await cleanupForUndo(s, to, note);
        if (isAmbiguous(s.anomalies)) {
          throw stepFailure('UNKNOWN_STATE', '切换入口失败：清理后仍无法确定当前入口状态', null, { anomalies: s.anomalies });
        }
        const final = await runPlan(s, to, onStep);
        if (trail.length > 0) final.evidence.push(cleanupEvidence(trail));
        return final;
      } catch (e) {
        throw withCleanupTrail(e, trail);
      }
    },
  };
}
