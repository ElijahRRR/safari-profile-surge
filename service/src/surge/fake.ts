// 假 Surge：引擎测试与演示模式使用。工作配置从目录读取；“已加载状态”与文件分开——
// policy-path 成员与 RULE-SET 内容只在 updateExternalResource(key) 或 reloadProfile() 时（重新）加载，
// 可选的 autoReload 在文件变化时整体重载并计数。演示中的“已生效”不代表任何网络事实。

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import {
  ENTRY_RULESET_FILES,
  NODE_RESOURCE_FILE,
  SfeError,
  WORKING_PROFILE_NAME,
  type TakeoverState,
} from '@sfe/contract';
import type {
  MaintenanceSurge,
  SurgeAdapter,
  SurgeCheckResult,
  SurgeExternalResource,
  SurgePolicies,
  SurgePolicyDetail,
  SurgePolicyTestResult,
  SurgeProfileInfo,
  SurgeRequestRecord,
  SurgeRuleRecord,
  SurgeRuntimeInfo,
  SurgeVersion,
} from '../ports.js';
import { ENTRY_BITS_IN_ORDER, entryRuleSetFileContent, entryRuleSetBlockLines, groupBlockLines, resourceFile } from './generate.js';
import { SURGE_PRIMITIVES, type MechanismMap } from './primitives.js';
import { findSections, parseProfile } from './profile.js';
import { parseProxyLine } from './proxy-line.js';
import { redactProxyLine } from './redact-profile.js';
import {
  BUILTIN_POLICIES,
  REJECT_POLICIES,
  evaluateCondition,
  isCommentLine,
  parseCondition,
  parseRule,
  type RuleCondition,
} from './rules.js';

export const FAKE_SAFARI_PATH = '/Applications/Safari.app/Contents/MacOS/Safari';
export const FAKE_CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export const FAKE_VERIFY_HOST = 'verify.example.test';

export interface FakeSurgeOptions {
  directory: string;
  profileFileName?: string;
  /** 模拟“自动重载”：在任一被引用文件变化后的下一次调用时整体重载。 */
  autoReload?: boolean;
  /** getAutoReloadSetting 报告的值；缺省等于 autoReload。 */
  reportedAutoReload?: boolean | null;
  /** 新临时规则插入位置。 */
  tempRuleInsertion?: 'head' | 'tail';
  /** 外部节点的 underlying-proxy 缺失时：跳过节点，或（危险情形）直接连接。 */
  frontResolution?: 'skip' | 'direct';
  /** 重载配置时是否清空临时规则（P0 待测，缺省保留）。 */
  reloadClearsTempRules?: boolean;
  version?: string;
  build?: string | null;
  now?: () => Date;
}

interface LoadedNode {
  name: string;
  line: string;
  type: string;
  server: string | null;
  port: number | null;
  front: string | null;
  frontMissing: boolean;
}

interface LoadedGroup {
  name: string;
  type: string;
  explicit: string[];
  policyPaths: string[];
}

interface LoadedResource {
  key: string;
  type: 'policy-path' | 'ruleset';
  value: string;
  location: string;
  local: boolean;
  content: string | null;
  conditions: RuleCondition[];
  lastUpdatedAt: Date | null;
  error: string | null;
}

export interface SimulatedRequest extends SurgeRequestRecord {
  /** 策略链：组 → 节点 → 前置；前置缺失且按 direct 处理时以 DIRECT 结尾。 */
  chain: string[];
  frontMissing: boolean;
}

interface Fault {
  error: Error;
  afterEffect: boolean;
}

function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function commandFailed(message: string): SfeError {
  return new SfeError('SURGE_COMMAND_FAILED', message);
}

export class FakeSurge implements SurgeAdapter, MaintenanceSurge {
  readonly directory: string;
  readonly profileFileName: string;
  /** 每个原语（含 reloadProfile）的调用次数。 */
  readonly calls: Record<string, number> = {};
  /** 整体重载次数（reloadProfile 与自动重载）。 */
  reloadCount = 0;
  autoReloadCount = 0;

  autoReload: boolean;
  reportedAutoReload: boolean | null | undefined;
  tempRuleInsertion: 'head' | 'tail';
  frontResolution: 'skip' | 'direct';
  reloadClearsTempRules: boolean;
  reachable = true;
  version: string;
  build: string | null;
  takeover: TakeoverState = { enhancedMode: true, systemProxy: true, outboundMode: 'rule', checkedAt: null };
  currentProfile: SurgeProfileInfo;
  startedAt: Date;

  private readonly now: () => Date;
  private userProxies = new Map<string, LoadedNode>();
  private externalNodes = new Map<string, LoadedNode>();
  private groups = new Map<string, LoadedGroup>();
  private profileRules: string[] = [];
  private resources = new Map<string, LoadedResource>();
  private watched = new Map<string, string | null>();
  private selection = new Map<string, string | null>();
  private temps: string[] = [];
  private modules: Array<{ text: string; moduleName: string }> = [];
  private recent: SimulatedRequest[] = [];
  private active = new Map<string, SimulatedRequest>();
  private nextId = 1;
  private faults = new Map<string, Fault[]>();
  private lies = new Map<string, Array<{ value: unknown }>>();
  private policyTests = new Map<string, SurgePolicyTestResult>();
  private checkResults = new Map<string, SurgeCheckResult>();

  constructor(opts: FakeSurgeOptions) {
    this.directory = resolve(opts.directory);
    this.profileFileName = opts.profileFileName ?? `${WORKING_PROFILE_NAME}.conf`;
    this.autoReload = opts.autoReload ?? false;
    this.reportedAutoReload = opts.reportedAutoReload;
    this.tempRuleInsertion = opts.tempRuleInsertion ?? 'tail';
    this.frontResolution = opts.frontResolution ?? 'skip';
    this.reloadClearsTempRules = opts.reloadClearsTempRules ?? false;
    this.version = opts.version ?? '6.5.0';
    this.build = opts.build === undefined ? '10960' : opts.build;
    this.now = opts.now ?? (() => new Date());
    this.startedAt = this.now();
    this.currentProfile = { name: this.profileFileName.replace(/\.conf$/, ''), path: this.profilePath };
    this.loadAll();
  }

  get profilePath(): string {
    return join(this.directory, this.profileFileName);
  }

  // ---------- 模拟控制 ----------

  /** 下一次调用该原语时抛出 error；afterEffect 为 true 时先生效再抛（结果未知）。 */
  failNext(primitive: string, error: Error = commandFailed('调用 Surge 失败：模拟失败'), opts: { afterEffect?: boolean } = {}): void {
    if (!this.faults.has(primitive)) this.faults.set(primitive, []);
    this.faults.get(primitive)!.push({ error, afterEffect: opts.afterEffect ?? false });
  }

  /** 下一次调用该原语时“说谎”：读原语返回 value；写原语不生效但报告成功。 */
  lieOnNext(primitive: string, value?: unknown): void {
    if (!this.lies.has(primitive)) this.lies.set(primitive, []);
    this.lies.get(primitive)!.push({ value });
  }

  setModuleRules(rules: Array<{ text: string; moduleName: string }>): void {
    this.modules = rules.map((r) => ({ ...r }));
  }

  setPolicyTestResult(policy: string, result: SurgePolicyTestResult): void {
    this.policyTests.set(policy, result);
  }

  setCheckResult(path: string, result: SurgeCheckResult): void {
    this.checkResults.set(resolve(path), result);
  }

  /** Surge 重启：临时规则清空、整体加载、启动时间变化、活动连接清空。 */
  restart(): void {
    this.temps = [];
    this.active.clear();
    const t = this.now();
    this.startedAt = t.getTime() > this.startedAt.getTime() ? t : new Date(this.startedAt.getTime() + 1);
    this.loadAll();
  }

  get tempRules(): string[] {
    return [...this.temps];
  }

  /** 已加载（而不是文件中）的资源内容。 */
  loadedContent(key: string): string | null {
    return this.resources.get(key)?.content ?? null;
  }

  checkFileChanges(): boolean {
    if (!this.autoReload) return false;
    for (const [path, snapshot] of this.watched) {
      if (readOrNull(path) !== snapshot) {
        this.reloadCount++;
        this.autoReloadCount++;
        this.loadAll();
        if (this.reloadClearsTempRules) this.temps = [];
        return true;
      }
    }
    return false;
  }

  /**
   * 模拟一次请求：模块规则 → 临时规则 → 配置规则（RULE-SET 展开）求值，记录命中的规则、策略与叶节点。
   * longLived 的请求保留在活动列表中，直到被结束。
   */
  simulateRequest(req: { processPath: string | null; host: string; protocol: 'tcp' | 'udp'; longLived?: boolean }): SimulatedRequest {
    this.checkFileChanges();
    const facts = { processPath: req.processPath, host: req.host, protocol: req.protocol };
    const ctx = { ruleSet: (value: string) => this.resources.get(`ruleset:${value}`)?.conditions ?? null };
    let matchedRule = 'FINAL,DIRECT';
    let policy = 'DIRECT';
    const ordered = [...this.modules.map((m) => m.text), ...this.temps, ...this.profileRules];
    for (const text of ordered) {
      const r = parseRule(text);
      if (!r || !r.policy) continue;
      if (evaluateCondition(r.condition, facts, ctx)) {
        matchedRule = text;
        policy = r.policy;
        break;
      }
    }
    const resolved = this.resolvePolicy(policy, 0);
    const rec: SimulatedRequest = {
      id: String(this.nextId++),
      processPath: req.processPath,
      remoteHost: req.host,
      policyName: policy,
      leafPolicyName: this.groups.has(policy) ? resolved.leaf : null,
      rule: matchedRule,
      protocol: req.protocol,
      startedAt: this.now(),
      completed: !req.longLived,
      failed: resolved.rejected,
      chain: resolved.chain,
      frontMissing: resolved.frontMissing,
    };
    this.recent.push(rec);
    if (this.recent.length > 500) this.recent.shift();
    if (req.longLived && !resolved.rejected) this.active.set(rec.id, rec);
    return { ...rec, chain: [...rec.chain] };
  }

  // ---------- 加载 ----------

  private loadAll(): void {
    const raw = readOrNull(this.profilePath);
    const parsed = parseProfile(raw ?? '');
    this.userProxies.clear();
    this.groups.clear();
    this.profileRules = [];
    const previous = this.resources;
    this.resources = new Map();
    this.watched = new Map([[this.profilePath, raw]]);
    const linesOf = (name: string): string[] =>
      findSections(parsed, name).flatMap((s) => parsed.lines.slice((s.header ?? s.start) + 1, s.end).map((l) => l.text));

    for (const line of linesOf('Proxy')) {
      if (isCommentLine(line)) continue;
      const p = parseProxyLine(line);
      if (p) this.userProxies.set(p.name, { name: p.name, line, type: p.type, server: p.server, port: p.port, front: p.params['underlying-proxy'] ?? null, frontMissing: false });
    }
    for (const line of linesOf('Proxy Group')) {
      if (isCommentLine(line)) continue;
      const m = /^\s*([^=]+?)\s*=\s*(.+)$/.exec(line);
      if (!m) continue;
      const parts = m[2]!.split(',').map((s) => s.trim());
      const group: LoadedGroup = { name: m[1]!, type: parts[0]!.toLowerCase(), explicit: [], policyPaths: [] };
      for (const part of parts.slice(1)) {
        const eq = part.indexOf('=');
        if (eq < 0) group.explicit.push(part);
        else if (part.slice(0, eq).trim().toLowerCase() === 'policy-path') {
          const value = part.slice(eq + 1).trim();
          group.policyPaths.push(value);
          this.registerResource('policy-path', value, previous);
        }
      }
      this.groups.set(group.name, group);
    }
    for (const line of linesOf('Rule')) {
      if (isCommentLine(line)) continue;
      const r = parseRule(line);
      if (!r) continue;
      this.profileRules.push(line.trim());
      if (r.condition.type === 'RULE-SET') this.registerResource('ruleset', r.condition.value!, previous);
    }
    for (const res of this.resources.values()) this.loadResource(res);
    this.rebuildExternalNodes();
  }

  private registerResource(type: 'policy-path' | 'ruleset', value: string, previous: Map<string, LoadedResource>): void {
    const key = `${type}:${value}`;
    if (this.resources.has(key)) return;
    const local = !/^[a-z][a-z0-9+.-]*:\/\//i.test(value);
    const prev = previous.get(key);
    this.resources.set(key, {
      key,
      type,
      value,
      location: local ? (isAbsolute(value) ? value : join(this.directory, value)) : value,
      local,
      content: null,
      conditions: [],
      lastUpdatedAt: prev?.lastUpdatedAt ?? null,
      error: null,
    });
  }

  private bumpTime(prev: Date | null): Date {
    const t = this.now();
    return prev && t.getTime() <= prev.getTime() ? new Date(prev.getTime() + 1) : t;
  }

  private loadResource(res: LoadedResource): void {
    if (!res.local) {
      res.content = '';
      res.conditions = [];
      return;
    }
    const content = readOrNull(res.location);
    this.watched.set(res.location, content);
    res.content = content;
    res.error = content === null ? 'file not found' : null;
    res.lastUpdatedAt = this.bumpTime(res.lastUpdatedAt);
    res.conditions =
      res.type === 'ruleset' && content !== null
        ? content
            .split(/\r?\n/)
            .filter((l) => !isCommentLine(l))
            .map((l) => parseCondition(l))
            .filter((c): c is RuleCondition => c !== null)
        : [];
  }

  private rebuildExternalNodes(): void {
    this.externalNodes.clear();
    for (const res of this.resources.values()) {
      if (res.type !== 'policy-path' || res.content === null) continue;
      for (const line of res.content.split(/\r?\n/)) {
        if (isCommentLine(line)) continue;
        const p = parseProxyLine(line);
        if (!p || this.externalNodes.has(p.name) || this.userProxies.has(p.name)) continue;
        const front = p.params['underlying-proxy'] ?? null;
        const frontMissing = front !== null && !this.userProxies.has(front);
        if (frontMissing && this.frontResolution === 'skip') continue;
        this.externalNodes.set(p.name, { name: p.name, line, type: p.type, server: p.server, port: p.port, front, frontMissing });
      }
    }
    for (const g of this.groups.values()) {
      const members = this.membersOf(g.name);
      const sel = this.selection.get(g.name);
      // select 组的选择失效时回落到首成员（REJECT）。
      if (sel === undefined || sel === null || !members.includes(sel)) this.selection.set(g.name, members[0] ?? null);
    }
  }

  private membersOf(groupName: string): string[] {
    const g = this.groups.get(groupName);
    if (!g) return [];
    const out = [...g.explicit];
    for (const value of g.policyPaths) {
      const res = this.resources.get(`policy-path:${value}`);
      if (!res?.content) continue;
      for (const line of res.content.split(/\r?\n/)) {
        if (isCommentLine(line)) continue;
        const p = parseProxyLine(line);
        if (p && this.externalNodes.has(p.name) && !out.includes(p.name)) out.push(p.name);
      }
    }
    return out;
  }

  private resolvePolicy(policy: string, depth: number): { leaf: string; chain: string[]; rejected: boolean; frontMissing: boolean } {
    const up = policy.toUpperCase();
    if (REJECT_POLICIES.has(up)) return { leaf: up, chain: [up], rejected: true, frontMissing: false };
    if (up === 'DIRECT') return { leaf: 'DIRECT', chain: ['DIRECT'], rejected: false, frontMissing: false };
    if (depth > 8) return { leaf: 'REJECT', chain: ['REJECT'], rejected: true, frontMissing: false };
    if (this.groups.has(policy)) {
      const sel = this.selection.get(policy) ?? null;
      if (sel === null) return { leaf: 'REJECT', chain: [policy, 'REJECT'], rejected: true, frontMissing: false };
      const inner = this.resolvePolicy(sel, depth + 1);
      return { ...inner, chain: [policy, ...inner.chain] };
    }
    const node = this.userProxies.get(policy) ?? this.externalNodes.get(policy);
    if (!node) return { leaf: 'REJECT', chain: ['REJECT'], rejected: true, frontMissing: false };
    if (node.front === null) return { leaf: node.name, chain: [node.name], rejected: false, frontMissing: false };
    if (node.frontMissing) return { leaf: node.name, chain: [node.name, 'DIRECT'], rejected: false, frontMissing: true };
    const front = this.resolvePolicy(node.front, depth + 1);
    return { leaf: node.name, chain: [node.name, ...front.chain], rejected: front.rejected, frontMissing: front.frontMissing };
  }

  // ---------- 原语 ----------

  private async invoke<T>(name: string, effect: () => T): Promise<T> {
    this.calls[name] = (this.calls[name] ?? 0) + 1;
    if (!this.reachable) throw new SfeError('SURGE_UNREACHABLE', '连接 Surge 失败：模拟不可达');
    this.checkFileChanges();
    const fault = this.faults.get(name)?.shift();
    if (fault && !fault.afterEffect) throw fault.error;
    const lie = this.lies.get(name)?.shift();
    if (lie) return lie.value as T;
    const result = effect();
    if (fault) throw fault.error;
    return result;
  }

  mechanism(): MechanismMap {
    return Object.fromEntries(SURGE_PRIMITIVES.map((p) => [p, 'fake' as const]));
  }

  reloadProfile(): Promise<void> {
    return this.invoke('reloadProfile', () => {
      this.reloadCount++;
      this.loadAll();
      if (this.reloadClearsTempRules) this.temps = [];
    });
  }

  getVersion(): Promise<SurgeVersion> {
    return this.invoke('getVersion', () => ({ version: this.version, build: this.build }));
  }

  getRuntimeInfo(): Promise<SurgeRuntimeInfo> {
    return this.invoke('getRuntimeInfo', () => ({ startedAt: new Date(this.startedAt) }));
  }

  getCurrentProfile(): Promise<SurgeProfileInfo> {
    return this.invoke('getCurrentProfile', () => ({ ...this.currentProfile }));
  }

  getTakeoverState(): Promise<TakeoverState> {
    return this.invoke('getTakeoverState', () => ({ ...this.takeover, checkedAt: this.now().toISOString() }));
  }

  getAutoReloadSetting(): Promise<boolean | null> {
    return this.invoke('getAutoReloadSetting', () => (this.reportedAutoReload === undefined ? this.autoReload : this.reportedAutoReload));
  }

  checkProfile(profilePath: string): Promise<SurgeCheckResult> {
    return this.invoke('checkProfile', () => {
      const override = this.checkResults.get(resolve(profilePath));
      if (override) return { ...override };
      const text = readOrNull(profilePath);
      if (text === null) return { ok: false, message: '配置文件不存在' };
      const parsed = parseProfile(text);
      if (findSections(parsed, 'Rule').length !== 1) return { ok: false, message: '缺少 [Rule] 段' };
      return { ok: true, message: 'OK' };
    });
  }

  listPolicies(): Promise<SurgePolicies> {
    return this.invoke('listPolicies', () => ({
      proxies: [...this.userProxies.keys(), ...this.externalNodes.keys()],
      groups: [...this.groups.keys()],
    }));
  }

  getPolicyDetail(name: string): Promise<SurgePolicyDetail> {
    return this.invoke('getPolicyDetail', () => {
      const node = this.userProxies.get(name) ?? this.externalNodes.get(name);
      if (node) {
        return { name, type: node.type, server: node.server, port: node.port, underlyingProxy: node.front, redactedRaw: redactProxyLine(node.line) };
      }
      const g = this.groups.get(name);
      if (g) return { name, type: g.type, server: null, port: null, underlyingProxy: null, redactedRaw: null };
      if (BUILTIN_POLICIES.has(name.toUpperCase())) return { name, type: 'builtin', server: null, port: null, underlyingProxy: null, redactedRaw: null };
      throw commandFailed('读取策略详情失败：策略不存在');
    });
  }

  getGroupMembers(group: string): Promise<string[]> {
    return this.invoke('getGroupMembers', () => {
      if (!this.groups.has(group)) throw commandFailed('读取策略组失败：组不存在');
      return this.membersOf(group);
    });
  }

  getGroupSelection(group: string): Promise<string | null> {
    return this.invoke('getGroupSelection', () => {
      if (!this.groups.has(group)) throw commandFailed('读取策略组失败：组不存在');
      return this.selection.get(group) ?? null;
    });
  }

  selectGroupPolicy(group: string, policy: string): Promise<void> {
    return this.invoke('selectGroupPolicy', () => {
      if (!this.groups.has(group)) throw commandFailed('选择策略失败：组不存在');
      if (!this.membersOf(group).includes(policy)) throw commandFailed('选择策略失败：不是组成员');
      this.selection.set(group, policy);
    });
  }

  testPolicy(policy: string, _url: string): Promise<SurgePolicyTestResult> {
    return this.invoke('testPolicy', () => {
      const override = this.policyTests.get(policy);
      if (override) return { ...override };
      const known = this.groups.has(policy) || this.userProxies.has(policy) || this.externalNodes.has(policy);
      if (!known) return { ok: false, latencyMs: null, error: '策略不存在' };
      const r = this.resolvePolicy(policy, 0);
      return r.rejected ? { ok: false, latencyMs: null, error: '策略拒绝连接' } : { ok: true, latencyMs: 42, error: null };
    });
  }

  listRules(): Promise<SurgeRuleRecord[]> {
    return this.invoke('listRules', () => [
      ...this.modules.map((m) => ({ text: m.text, source: 'module' as const, moduleName: m.moduleName })),
      ...this.temps.map((text) => ({ text, source: 'temp_rule' as const, moduleName: null })),
      ...this.profileRules.map((text) => ({ text, source: 'profile' as const, moduleName: null })),
    ]);
  }

  listActiveRequests(): Promise<SurgeRequestRecord[]> {
    return this.invoke('listActiveRequests', () => [...this.active.values()].map(({ chain: _c, frontMissing: _f, ...r }) => ({ ...r })));
  }

  listRecentRequests(): Promise<SurgeRequestRecord[]> {
    return this.invoke('listRecentRequests', () => this.recent.map(({ chain: _c, frontMissing: _f, ...r }) => ({ ...r })));
  }

  killRequest(id: string): Promise<void> {
    return this.invoke('killRequest', () => {
      const r = this.active.get(id);
      if (!r) throw commandFailed('结束请求失败：请求不存在');
      r.completed = true;
      this.active.delete(id);
    });
  }

  listExternalResources(): Promise<SurgeExternalResource[]> {
    return this.invoke('listExternalResources', () =>
      [...this.resources.values()].map((r) => ({
        key: r.key,
        type: r.type,
        location: r.location,
        lastUpdatedAt: r.lastUpdatedAt ? new Date(r.lastUpdatedAt) : null,
        error: r.error,
      })),
    );
  }

  updateExternalResource(key: string): Promise<void> {
    return this.invoke('updateExternalResource', () => {
      const res = this.resources.get(key);
      if (!res) throw commandFailed('更新外部资源失败：资源不存在');
      this.loadResource(res);
      if (res.type === 'policy-path') this.rebuildExternalNodes();
    });
  }

  listTempRules(): Promise<string[]> {
    return this.invoke('listTempRules', () => [...this.temps]);
  }

  addTempRule(rule: string): Promise<void> {
    return this.invoke('addTempRule', () => {
      if (this.temps.includes(rule)) throw commandFailed('添加临时规则失败：规则已存在');
      if (!parseRule(rule)) throw commandFailed('添加临时规则失败：规则无法解析');
      if (this.tempRuleInsertion === 'head') this.temps.unshift(rule);
      else this.temps.push(rule);
    });
  }

  removeTempRule(rule: string): Promise<void> {
    return this.invoke('removeTempRule', () => {
      const i = this.temps.indexOf(rule);
      if (i < 0) throw commandFailed('删除临时规则失败：规则不存在');
      this.temps.splice(i, 1);
    });
  }
}

export interface FakeEnvironmentOptions {
  entryStrategy?: 'ruleset_resource' | 'temp_rule';
  processPaths?: string[];
  verifyHost?: string;
  /** 额外写入 [Rule] 受管理段之后的用户规则（放在 FINAL 之前）。 */
  userRules?: string[];
}

export interface FakeEnvironment {
  directory: string;
  profileName: string;
  profilePath: string;
  /** 写入的本应用文件（相对配置目录）。 */
  files: string[];
}

/** 合成工作配置：用户节点（合成占位值）、FINAL 规则、SFE 受管理段与占位资源文件。 */
export function createFakeSurgeEnvironment(dir: string, opts: FakeEnvironmentOptions = {}): FakeEnvironment {
  const directory = resolve(dir);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const strategy = opts.entryStrategy ?? 'ruleset_resource';
  const entryOpts = { processPaths: opts.processPaths ?? [FAKE_SAFARI_PATH], verifyHost: opts.verifyHost ?? FAKE_VERIFY_HOST };
  const entryLines = strategy === 'ruleset_resource' ? entryRuleSetBlockLines() : [];
  const profile = [
    '[General]',
    'loglevel = notify',
    'skip-proxy = 127.0.0.1, localhost',
    '',
    '[Proxy]',
    'Front-A = socks5, 192.0.2.10, 1080, username=example-user, password=example-pass',
    'Front-B = http, 192.0.2.11, 8080',
    '',
    '[Proxy Group]',
    'Daily = select, Front-A, Front-B, DIRECT',
    '# SFE-BEGIN group v1',
    ...groupBlockLines(),
    '# SFE-END group',
    '',
    '[Rule]',
    '# SFE-BEGIN entry v1',
    ...entryLines,
    '# SFE-END entry',
    ...(opts.userRules ?? ['DOMAIN-SUFFIX,daily.example.test,Daily']),
    'FINAL,DIRECT',
    '',
  ].join('\n');
  const profileName = WORKING_PROFILE_NAME;
  const profilePath = join(directory, `${profileName}.conf`);
  writeFileSync(profilePath, profile, { mode: 0o600 });
  const files = [NODE_RESOURCE_FILE];
  writeFileSync(join(directory, NODE_RESOURCE_FILE), resourceFile(0, []), { mode: 0o600 });
  if (strategy === 'ruleset_resource') {
    for (const bit of ENTRY_BITS_IN_ORDER) {
      writeFileSync(join(directory, ENTRY_RULESET_FILES[bit]), entryRuleSetFileContent(bit, false, entryOpts), { mode: 0o600 });
      files.push(ENTRY_RULESET_FILES[bit]);
    }
  }
  return { directory, profileName, profilePath, files };
}
