// ruleset_resource 入口策略：四个规则集文件（udp > verify > block > active，顺序固定在工作配置中）。
// 每一步：读取自动重载设置并与实测条件比对 → 原子写入单个文件（期望上次摘要）→ 重新枚举找到
// 位置指向该文件的唯一 key → updateExternalResource(key) → 运行时读回 → 确认。
// 从不重载配置、更新全部或 flush。见 docs/ARCHITECTURE.md §5.5。

import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENTRY_MODE_BITS, ENTRY_PLACEHOLDER_RULE, ENTRY_RULESET_FILES, SfeError, type EntryBits, type KnownEntryMode } from '@sfe/contract';
import type { EntryController, EntryReadback, EntryStep, ProfileFiles, SurgeExternalResource, SurgeRuleRecord } from '../../ports.js';
import type { EntryOwnedRecord } from './ownership.js';
import { ENTRY_BITS_IN_ORDER, ENTRY_BIT_POLICY, entryRuleSetFileContent, entryRules, type EntryBit } from '../generate.js';
import { classifyPrecedence, hasBlockingIssue } from '../precedence.js';
import { isCommentLine, normalizeRuleText, parseRule } from '../rules.js';
import { stepFailure, withLastConfirmed, type EntryConfig, type EntryStrategyDeps } from './common.js';
import { knownModeOfBits, planFromBits } from './plan.js';

export type AutoReloadCondition = 'on' | 'off' | 'any' | null;

/** 每一位“更宽松”的取值（未确认时按它规划）。 */
const PERMISSIVE_SIDE: EntryBits = { udp: false, verify: true, block: false, active: true };

export interface RulesetStrategyDeps extends EntryStrategyDeps {
  files: NonNullable<EntryStrategyDeps['files']>;
  /** 能力记录中验证时的自动重载条件；null 表示没有记录（拒绝写入）。 */
  autoReloadCondition: () => AutoReloadCondition | Promise<AutoReloadCondition>;
}

interface FileState {
  bit: EntryBit;
  name: string;
  path: string;
  value: boolean | null;
  digest: string | null;
}

interface RulesetState {
  cfg: EntryConfig;
  files: Record<EntryBit, FileState>;
  resources: SurgeExternalResource[];
  rules: SurgeRuleRecord[];
  bits: EntryBits | null;
  anomalies: string[];
}

function ruleBodies(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => !isCommentLine(l))
    .map(normalizeRuleText);
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

export function createRulesetStrategy(deps: RulesetStrategyDeps): EntryController {
  const files = deps.files;
  const dir = files.directory;

  const locate = (location: string): string => {
    if (location.startsWith('file://')) return fileURLToPath(location);
    return isAbsolute(location) ? resolve(location) : resolve(dir, location);
  };
  const resourcesFor = (resources: readonly SurgeExternalResource[], path: string): SurgeExternalResource[] =>
    resources.filter((r) => !/^[a-z][a-z0-9+.-]*:\/\//i.test(r.location) || r.location.startsWith('file://')).filter((r) => locate(r.location) === path);

  const isOurRule = (r: SurgeRuleRecord): boolean => {
    const p = parseRule(r.text);
    if (!p || p.condition.type !== 'RULE-SET') return false;
    const v = p.condition.value!;
    const base = v.slice(v.lastIndexOf('/') + 1);
    return Object.values(ENTRY_RULESET_FILES).includes(base as never);
  };

  /** 四条 RULE-SET 必须各出现一次、策略正确、顺序为 udp > verify > block > active。 */
  function rulesetOrderOk(rules: readonly SurgeRuleRecord[]): boolean {
    const idx = ENTRY_BITS_IN_ORDER.map((bit) => {
      const hits = rules
        .map((r, i) => ({ i, p: parseRule(r.text) }))
        .filter(({ p }) => p?.condition.type === 'RULE-SET' && p.condition.value!.slice(p.condition.value!.lastIndexOf('/') + 1) === ENTRY_RULESET_FILES[bit]);
      if (hits.length !== 1 || hits[0]!.p!.policy !== ENTRY_BIT_POLICY[bit]) return -1;
      return hits[0]!.i;
    });
    return idx.every((i) => i >= 0) && idx.every((i, k) => k === 0 || i > idx[k - 1]!);
  }

  async function load(): Promise<RulesetState> {
    const cfg = deps.config();
    const anomalies: string[] = [];
    const fileStates = {} as Record<EntryBit, FileState>;
    for (const bit of ENTRY_BITS_IN_ORDER) {
      const name = ENTRY_RULESET_FILES[bit];
      const content = await files.read(name);
      const digest = await files.digest(name);
      let value: boolean | null = null;
      if (content === null) anomalies.push(`file_missing_${bit}`);
      else {
        const bodies = ruleBodies(content);
        if (sameList(bodies, [ENTRY_PLACEHOLDER_RULE])) value = false;
        else if (sameList(bodies, entryRules(bit, true, cfg).map(normalizeRuleText))) value = true;
        else anomalies.push(`file_unrecognized_${bit}`);
      }
      const rec = await deps.ownership.getRecord('entry_ruleset_file', name);
      if (!rec || rec.state === 'removed' || rec.state === 'pending_remove') anomalies.push(`not_owned_${bit}`);
      else if (rec.state === 'pending_add') {
        // 未确认的意图：文件只能是写前或写后内容之一，否则视为外部修改。
        if (digest !== rec.digest && (rec.previousDigest == null || digest !== rec.previousDigest)) anomalies.push(`file_changed_${bit}`);
        else anomalies.push(`pending_${bit}`);
      } else if (rec.digest === null || rec.digest !== digest) anomalies.push(`file_changed_${bit}`);
      fileStates[bit] = { bit, name, path: resolve(dir, name), value, digest };
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
    const values = ENTRY_BITS_IN_ORDER.map((b) => fileStates[b].value);
    const bits = values.some((v) => v === null)
      ? null
      : { udp: values[0]!, verify: values[1]!, block: values[2]!, active: values[3]! };
    return { cfg, files: fileStates, resources, rules, bits, anomalies };
  }

  function readbackOf(s: RulesetState): EntryReadback {
    const issues = classifyPrecedence(s.rules, {
      isOurRule,
      processPaths: s.cfg.processPaths,
      siteHosts: s.cfg.siteHosts,
      verifyHost: s.cfg.verifyHost,
    });
    const known = s.bits ? knownModeOfBits(s.bits) : null;
    const evidence = [
      `规则集文件：${s.bits ? ENTRY_BITS_IN_ORDER.filter((b) => s.bits![b]).join('、') || '全部为占位规则' : '无法识别'}`,
      ...ENTRY_BITS_IN_ORDER.map((b) => {
        const r = resourcesFor(s.resources, s.files[b].path)[0];
        return `资源 ${b}：${r ? `更新时间 ${r.lastUpdatedAt ? r.lastUpdatedAt.toISOString() : '不可得'}` : '未找到'}`;
      }),
      '已加载的规则集内容无法直接读取，以定向刷新后的资源状态为准',
      ...s.anomalies.map((a) => `异常：${a}`),
    ];
    let mode: EntryReadback['mode'] = s.anomalies.length === 0 && known !== null ? known : 'UNKNOWN';
    if (mode !== 'NORMAL' && mode !== 'UNKNOWN' && hasBlockingIssue(issues)) {
      mode = 'UNKNOWN';
      evidence.push('有规则排在入口之前');
    }
    return { mode, bits: s.bits, evidence, precedenceIssues: issues };
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

  async function runStep(step: EntryStep, s: RulesetState, lastConfirmed: EntryBits): Promise<void> {
    const f = s.files[step.bit];
    await checkAutoReload(lastConfirmed, step);
    // 写入前先确认 Surge 中恰好有一个资源指向该文件；否则不写。
    uniqueKey(await deps.adapter.listExternalResources(), f.path, lastConfirmed, step);
    const content = entryRuleSetFileContent(step.bit, step.value, s.cfg);
    const previousContent = await files.read(f.name);
    const currentDigest = await files.digest(f.name);
    const expected = await expectedPrevious(f.name, currentDigest);
    const newDigest = files.digestContent ? files.digestContent(content) : null;
    await deps.ownership.recordIntent('entry_ruleset_file', f.name, newDigest, deps.operationId(), 'add');
    try {
      await files.writeAtomic(f.name, content, expected);
    } catch (e) {
      // 原子替换失败时文件未变：恢复记录为写前状态。
      if (currentDigest !== null && expected === currentDigest) {
        await deps.ownership.confirm('entry_ruleset_file', f.name, 'present', currentDigest).catch(() => undefined);
      }
      throw e;
    }
    // 写入之后、刷新确认之前，已加载状态可能是写前或写后：出错时不再声称上一状态已确认。
    try {
      const writtenDigest = await files.digest(f.name);
      const before = uniqueKey(await deps.adapter.listExternalResources(), f.path, null, step);
      let updateError: unknown = null;
      try {
        await deps.adapter.updateExternalResource(before.key);
      } catch (e) {
        updateError = e;
      }
      // 超时等未知结果：先读事实再判断，不重复写。
      const after = resourcesFor(await deps.adapter.listExternalResources(), f.path);
      const advanced =
        after.length === 1 &&
        after[0]!.key === before.key &&
        after[0]!.lastUpdatedAt !== null &&
        (before.lastUpdatedAt === null || after[0]!.lastUpdatedAt.getTime() > before.lastUpdatedAt.getTime());
      if (!advanced || after[0]?.error) {
        // 确认刷新没有发生时，把文件改回写前内容，使文件与已加载状态一致；无法判断时保持 pending。
        const notApplied = after.length === 1 && after[0]!.lastUpdatedAt !== null && !advanced;
        let restored = false;
        if (notApplied && previousContent !== null && writtenDigest !== null && currentDigest !== null) {
          try {
            await files.writeAtomic(f.name, previousContent, writtenDigest);
            await deps.ownership.confirm('entry_ruleset_file', f.name, 'present', currentDigest);
            restored = true;
          } catch {
            /* 保持 pending，由对账处理 */
          }
        }
        if (updateError !== null) throw withLastConfirmed(updateError, restored ? lastConfirmed : null, step);
        throw stepFailure('READBACK_MISMATCH', '切换入口失败：规则集资源刷新后读回不一致', restored ? lastConfirmed : null, {
          failedStep: { bit: step.bit, value: step.value },
          resourceError: Boolean(after[0]?.error),
        });
      }
      // 刷新之后规则顺序必须仍然成立（例如自动重载可能换入了外部修改的配置）。
      if (!rulesetOrderOk(await deps.adapter.listRules())) {
        throw stepFailure('READBACK_MISMATCH', '切换入口失败：入口规则集不在有效规则中或顺序不对', null, { failedStep: { bit: step.bit, value: step.value } });
      }
    } catch (e) {
      if (e instanceof SfeError && e.details && 'lastConfirmedBits' in e.details) throw e;
      throw withLastConfirmed(e, null, step);
    }
    await deps.ownership.confirm('entry_ruleset_file', f.name, 'present', await files.digest(f.name));
  }

  /**
   * 意图未确认（例如崩溃在写入与刷新之间）的文件，其已加载内容未知：按更宽松的一侧规划
   * （需要变化时第一步总是开 block）；规划没有写到的未确认位在最后一个 block 步骤之前按目标值重写一次。
   */
  function planWithPending(s: RulesetState, to: KnownEntryMode): EntryStep[] {
    const pending = ENTRY_BITS_IN_ORDER.filter((b) => s.anomalies.includes(`pending_${b}`));
    if (pending.length === 0) return planFromBits(s.bits!, to);
    const start: EntryBits = { ...s.bits! };
    for (const b of pending) start[b] = PERMISSIVE_SIDE[b];
    start.block = false;
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

    async transition(to, onStep) {
      let s: RulesetState;
      try {
        s = await load();
      } catch (e) {
        throw withLastConfirmed(e, null, null);
      }
      if (!s.bits) {
        throw stepFailure('UNKNOWN_STATE', '切换入口失败：入口规则集文件无法识别', null, { anomalies: s.anomalies });
      }
      // 被外部修改或不属于本应用记录的规则集文件从不被采纳：停止，等待维护流程恢复。
      const foreign = s.anomalies.filter((a) => a.startsWith('file_changed_') || a.startsWith('not_owned_'));
      if (foreign.length > 0) {
        throw stepFailure('BASELINE_CHANGED', '切换入口失败：入口规则集文件已被外部修改或不属于本应用', null, { anomalies: foreign });
      }
      if (s.anomalies.includes('ruleset_order')) {
        throw stepFailure('UNKNOWN_STATE', '切换入口失败：入口规则集不在有效规则中或顺序不对', s.bits, { anomalies: s.anomalies });
      }
      let lastConfirmed: EntryBits = { ...s.bits };
      if (to === 'VERIFY_ONLY' || to === 'ACTIVE') {
        const pre = readbackOf(s);
        if (hasBlockingIssue(pre.precedenceIssues)) {
          throw stepFailure('PRECEDENCE_VIOLATION', '切换入口失败：有规则排在入口之前，可能抢先匹配 Safari 流量', lastConfirmed, {
            precedenceIssues: pre.precedenceIssues,
          });
        }
      }
      for (const step of planWithPending(s, to)) {
        try {
          await runStep(step, s, lastConfirmed);
        } catch (e) {
          if (e instanceof SfeError && e.details && 'lastConfirmedBits' in e.details) throw e;
          throw withLastConfirmed(e, lastConfirmed, step);
        }
        lastConfirmed = { ...step.bits };
        onStep?.(step);
      }
      let final: EntryReadback;
      try {
        final = readbackOf(await load());
      } catch (e) {
        throw withLastConfirmed(e, lastConfirmed, null);
      }
      if (final.mode !== to) {
        const code = hasBlockingIssue(final.precedenceIssues) && to !== 'NORMAL' ? 'PRECEDENCE_VIOLATION' : 'READBACK_MISMATCH';
        throw new SfeError(code, '切换入口失败：最终读回不是目标模式', {
          details: { lastConfirmedBits: lastConfirmed, observedMode: final.mode, precedenceIssues: final.precedenceIssues },
        });
      }
      return final;
    },
  };
}
