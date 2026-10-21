// 每项能力的测量结果（<运行目录>/results/<能力>.json，另存历史）。结论由检查项推出：
// 任何一项失败 → fail；有未运行的项 → incomplete；全部通过 → pass。提议 supported 时必须是 pass。

import type { CapabilityContext, CapabilityKey, EntryStrategy, ProtocolCoverage } from '@sfe/contract';
import { ACTIONS_LOG } from './constants.js';
import type { RunDir } from './run-dir.js';

export type Verdict = 'pass' | 'fail' | 'incomplete';

export interface CheckItem {
  name: string;
  /** null：未运行或无法判断。 */
  ok: boolean | null;
  note: string;
}

export interface CapabilityResult {
  key: CapabilityKey;
  command: string;
  at: string;
  verdict: Verdict;
  checks: CheckItem[];
  /** 已脱敏的摘要行（提议摘要的来源）。 */
  summary: string[];
  context: CapabilityContext;
  coverage?: ProtocolCoverage;
  processPaths?: string[];
  entryStrategy?: EntryStrategy;
  /** 测量时声明的自动重载设置（refresh）。 */
  declaredAutoReload?: 'on' | 'off';
}

export function verdictOf(checks: readonly CheckItem[]): Verdict {
  if (checks.length === 0) return 'incomplete';
  if (checks.some((c) => c.ok === false)) return 'fail';
  if (checks.some((c) => c.ok === null)) return 'incomplete';
  return 'pass';
}

export function verdictLabel(v: Verdict): string {
  return v === 'pass' ? '通过' : v === 'fail' ? '不通过' : '不完整';
}

export function check(name: string, ok: boolean | null, note = ''): CheckItem {
  return { name, ok, note };
}

export function writeResult(dir: RunDir, result: Omit<CapabilityResult, 'verdict'> & { verdict?: Verdict }): CapabilityResult {
  const full: CapabilityResult = { ...result, verdict: result.verdict ?? verdictOf(result.checks) };
  dir.writeJson(`results/${full.key}.json`, full);
  dir.writeJson(`results/history/${full.key}-${full.at.replace(/[:.]/g, '')}.json`, full);
  return full;
}

export function readResult(dir: RunDir, key: CapabilityKey): CapabilityResult | null {
  return dir.readJson<CapabilityResult>(`results/${key}.json`);
}

/** 本能力在本次运行中的全部历史结果（按写入时间）。 */
export function readResultHistory(dir: RunDir, key: CapabilityKey): CapabilityResult[] {
  return dir
    .listFiles('results/history')
    .filter((f) => (f.split('/').pop() ?? '').startsWith(`${key}-`))
    .map((f) => dir.readJson<CapabilityResult>(f))
    .filter((r): r is CapabilityResult => r !== null && r.key === key);
}

export interface ActionEntry {
  at: string;
  command: string;
  action: string;
  detail?: Record<string, unknown>;
}

export function logAction(dir: RunDir, entry: ActionEntry): void {
  dir.appendJsonl(ACTIONS_LOG, entry);
}
