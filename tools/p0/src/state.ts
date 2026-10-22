// 运行状态（<运行目录>/state.json，0600）：盘点结论、原语实现、写入前快照、本工具创建的文件与
// 添加的临时规则（先登记意图再写入，回退只删除这里记录的精确规则）。

import type { CapabilityContext } from '@sfe/contract';
import type { RunDir } from './run-dir.js';

export type MechanismValue = 'cli' | 'http' | 'unavailable';

export interface CreatedFile {
  /** 绝对路径。 */
  path: string;
  /** 本工具最后一次写入后的带密钥摘要（运行密钥 HMAC）。 */
  digest: string;
  kind: 'test_profile' | 'node_resource' | 'entry_ruleset' | 'canary' | 'module' | 'reference_copy';
  createdAt: string;
}

export interface TempRuleRecord {
  rule: string;
  /** intent：写入前登记；present：读回确认存在；removed：读回确认已删除。 */
  state: 'intent' | 'present' | 'removed';
  purpose: string;
  at: string;
}

export interface SelectionRecord {
  group: string;
  before: string | null;
  after: string;
  at: string;
}

export interface InventorySummary {
  at: string;
  macos: { productVersion: string | null; buildVersion: string | null };
  safari: { version: string | null; build: string | null };
  surgeApp: { version: string | null; build: string | null };
  surgeVersion: { version: string | null; build: string | null };
  cliVerified: { ok: boolean; reason: string };
  httpApi: { configured: boolean; loopbackOnly: boolean | null };
  currentProfileName: string | null;
  profileDirectoryRisk: 'none' | 'synced' | 'protected' | null;
  autoReload: boolean | null;
  takeover: { enhancedMode: boolean | null; systemProxy: boolean | null; outboundMode: string | null } | null;
  webkitSafariProcesses: string[];
}

export interface ServersInfo {
  echoPort: number;
  exitPort: number;
  frontPort: number;
  deadFrontPort: number;
  startedAt: string;
  allowUpstream: string[];
  h3Host: string;
}

export interface RunState {
  version: 1;
  runId: string;
  createdAt: string;
  surgeCliPath: string | null;
  sourceProfilePath: string | null;
  sourceProfileName: string | null;
  testProfilePath: string | null;
  testDirectory: string | null;
  mechanism: Record<string, MechanismValue> | null;
  inventory: InventorySummary | null;
  servers: ServersInfo | null;
  createdFiles: CreatedFile[];
  tempRules: TempRuleRecord[];
  selections: SelectionRecord[];
  /** 已测得的新临时规则插入位置（entry --probe-insertion）。 */
  tempRuleInsertion: 'head' | 'tail' | null;
  /**
   * entry --probe-insertion 对 listTempRules 的正向确认：添加的探测规则是否出现在列表中。false 时该列表不可信：
   * 不据此把登记的规则标为已删除，回退按“列表无法读取”逐条删除。null = 未确认。
   */
  tempListConfirmed: boolean | null;
  /** 归因确认的 Safari 进程完整路径（attribution）。 */
  processPaths: string[];
  /** 最近一次测量时的上下文（供提议时比较是否已变化）。 */
  lastContext: CapabilityContext | null;
}

export function emptyState(runId: string, now: Date): RunState {
  return {
    version: 1,
    runId,
    createdAt: now.toISOString(),
    surgeCliPath: null,
    sourceProfilePath: null,
    sourceProfileName: null,
    testProfilePath: null,
    testDirectory: null,
    mechanism: null,
    inventory: null,
    servers: null,
    createdFiles: [],
    tempRules: [],
    selections: [],
    tempRuleInsertion: null,
    tempListConfirmed: null,
    processPaths: [],
    lastContext: null,
  };
}

const STATE_FILE = 'state.json';

export function loadState(dir: RunDir, now: Date): RunState {
  const s = dir.readJson<RunState>(STATE_FILE);
  if (!s || s.version !== 1) return emptyState(dir.id, now);
  // 旧版本字段缺失时补默认值。
  return { ...emptyState(dir.id, now), ...s };
}

export function saveState(dir: RunDir, state: RunState): void {
  dir.writeJson(STATE_FILE, state);
}

/** 先登记意图再写入；返回登记后的状态。 */
export function recordTempRuleIntent(state: RunState, rule: string, purpose: string, now: Date): RunState {
  return { ...state, tempRules: [...state.tempRules, { rule, state: 'intent', purpose, at: now.toISOString() }] };
}

export function markTempRule(state: RunState, rule: string, to: 'present' | 'removed', now: Date): RunState {
  let done = false;
  const tempRules = [...state.tempRules]
    .reverse()
    .map((r) => {
      if (!done && r.rule === rule && r.state !== 'removed') {
        done = true;
        return { ...r, state: to, at: now.toISOString() };
      }
      return r;
    })
    .reverse();
  return { ...state, tempRules };
}

export function upsertCreatedFile(state: RunState, file: CreatedFile): RunState {
  const others = state.createdFiles.filter((f) => f.path !== file.path);
  return { ...state, createdFiles: [...others, file] };
}

export function createdFile(state: RunState, path: string): CreatedFile | null {
  return state.createdFiles.find((f) => f.path === path) ?? null;
}
