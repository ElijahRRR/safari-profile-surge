// temp_rule 入口策略：每个位对应一条本应用记录的精确临时规则，逐条增删，从不 flush。
// 规则先后由 Surge 的插入位置决定（P0 实测）：写入前按插入位置预测每一步的实际语义，
// 会出现放行窗口或无法到达目标时在写入前拒绝；写入后按有效规则顺序运行时读回。
// 同文的临时规则已存在但无本应用记录时停止（NAME_COLLISION），不收编。见 docs/ARCHITECTURE.md §5.5。

import { SfeError, type EntryBits, type KnownEntryMode } from '@sfe/contract';
import type { EntryController, EntryReadback, EntryStep, SurgeRuleRecord } from '../../ports.js';
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

interface TempState {
  cfg: EntryConfig;
  expected: Record<EntryBit, string>;
  records: EntryOwnedRecord[];
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
      const bit = (ENTRY_BITS_IN_ORDER.find((b) => normalizeRuleText(expected[b]) === n) ?? classifyEntryTempRule(rec.identity)) as EntryBit | null;
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
    return { cfg, expected, records, tempsN, rules, presentText, bits, order, foreign, anomalies, ourTextsN };
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

  return {
    strategy: 'temp_rule',

    async read() {
      return readbackOf(await load());
    },

    async transition(to, onStep) {
      let s: TempState;
      try {
        s = await load();
        await normalizeOwnership(s);
        s = await load();
      } catch (e) {
        throw withLastConfirmed(e, null, null);
      }
      if (s.anomalies.some((a) => a.startsWith('duplicate_') || a === 'unrecognized_record' || a === 'not_in_effective_rules')) {
        throw stepFailure('UNKNOWN_STATE', '切换入口失败：无法确定当前入口状态', null, { anomalies: s.anomalies });
      }
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
    },
  };
}
