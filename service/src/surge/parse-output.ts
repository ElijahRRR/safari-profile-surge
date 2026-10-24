// CLI 与 HTTP 输出的解析（目标 Surge Mac 6.10.0）。字段名以官方文档为准：HTTP API 文档定义的外部资源字段、
// 随包技能写明的 status 的 profile-path；文档没有定义的 --raw 键名（只能从 6.10 包内 surge-cli 的校验文字推断）
// 逐项标 TODO(P0)，键名或类型不对时整体报错。只取识别所需的字段，URL、请求头、节点参数等一律不保留。
// 失败即关闭：只接受已知的外层结构；列表中任何一项无法识别时整体报“输出格式无法识别”，从不静默跳过
// （漏掉一条规则、一个资源或一条请求会让读回把“存在”误判为“不存在”）。

import { SURGE_BUILD_RE, SURGE_VERSION_RE, SfeError } from '@sfe/contract';
import type {
  SurgeExternalResource,
  SurgeProfileInfo,
  SurgeRequestRecord,
  SurgeResourceUpdateResult,
  SurgeRuleMatchResult,
  SurgeRuleRecord,
  SurgeVersion,
} from '../ports.js';
import { redactUrls } from './redact-profile.js';

export function parseJsonLoose(text: string): unknown {
  const t = text.trim();
  if (!t || (t[0] !== '{' && t[0] !== '[')) return undefined;
  try {
    return JSON.parse(t) as unknown;
  } catch {
    return undefined;
  }
}

export function unrecognized(what: string): SfeError {
  return new SfeError('SURGE_COMMAND_FAILED', `读取${what}失败：Surge 输出格式无法识别`);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function pick(o: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k];
  return undefined;
}

function str(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

/** 数字（秒或毫秒）或 ISO 字符串。 */
export function toDate(v: unknown): Date | null {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return new Date(v < 1e12 ? v * 1000 : v);
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return toDate(n);
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/** host:port、[v6]:port → 主机名。 */
export function stripPort(host: string): string {
  const v6 = /^\[([^\]]+)\](?::\d+)?$/.exec(host);
  if (v6) return v6[1]!;
  const m = /^([^:]+):\d+$/.exec(host);
  return m ? m[1]! : host;
}

function arrayFrom(json: unknown, keys: readonly string[]): unknown[] | null {
  if (Array.isArray(json)) return json;
  if (isObject(json)) {
    const v = pick(json, keys);
    if (Array.isArray(v)) return v;
  }
  return null;
}

export function parseRequestRecords(json: unknown): SurgeRequestRecord[] {
  const items = arrayFrom(json, ['requests', 'items', 'data']);
  if (!items) throw unrecognized('请求列表');
  const out: SurgeRequestRecord[] = [];
  for (const item of items) {
    if (!isObject(item)) throw unrecognized('请求列表');
    const id = str(pick(item, ['id', 'requestId', 'request_id']));
    if (id === null) throw unrecognized('请求列表');
    const hostRaw = str(pick(item, ['remoteHost', 'remote_host', 'host']));
    const proto = String(pick(item, ['protocol', 'method', 'type']) ?? '').toLowerCase();
    // 叶节点字段名未实测：notes 中的“policy decision path”只作候选。TODO(P0)
    let leaf = str(pick(item, ['leafPolicyName', 'policyLeaf', 'leaf']));
    const notes = pick(item, ['notes']);
    if (leaf === null && Array.isArray(notes)) {
      for (const n of notes) {
        const m = typeof n === 'string' ? /policy decision path[^:]*:\s*(.+)$/i.exec(n) : null;
        if (m) leaf = m[1]!.split(/->|→/).pop()!.trim() || null;
      }
    }
    out.push({
      id,
      processPath: str(pick(item, ['processPath', 'process_path', 'process'])),
      remoteHost: hostRaw === null ? null : stripPort(hostRaw),
      policyName: str(pick(item, ['policyName', 'policy_name', 'policy'])),
      leafPolicyName: leaf,
      rule: str(pick(item, ['rule'])),
      protocol: proto.includes('udp') || proto.includes('quic') ? 'udp' : proto ? 'tcp' : null,
      startedAt: toDate(pick(item, ['startDate', 'start_date', 'startedAt', 'time'])),
      completed: Boolean(pick(item, ['completed'])),
      failed: Boolean(pick(item, ['failed'])),
    });
  }
  return out;
}

const RESOURCE_ENVELOPES = ['defines', 'resources', 'external-resources', 'externalResources', 'items'] as const;
const RESOURCE_LOCATION_KEYS = ['location', 'path', 'url', 'source'] as const;

function nonEmptyString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

/** 可选的布尔字段：缺失或 null 为 null；存在但不是布尔值时报错。 */
function optionalBool(item: Record<string, unknown>, key: string, what: string): boolean | null {
  const v = item[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'boolean') throw unrecognized(what);
  return v;
}

/**
 * 外部资源：只接受 { defines|resources|…: [ … ] }、顶层数组，或每个值都是带位置字段对象的 { key: { … } }。
 * 缺 key 或位置的项、无法识别的外层结构一律报错。ready 不是 true 且没有错误文本时记为 not_ready（未加载的资源不算健康）。
 * Mac 6.10.0 的字段（HTTP API 文档，GET /v1/external_resources 返回 defines[]）：local、updating、fromModule、error；
 * 类型不对时报错。“Local resources have no `updatedAt` field.”：本地资源的更新时间一律为 null，从不据它推断刷新；
 * “`updatedAt` … 0 if the resource has never been downloaded”：0 也是 null。
 */
export function parseExternalResources(json: unknown): SurgeExternalResource[] {
  let items = arrayFrom(json, RESOURCE_ENVELOPES);
  if (!items && isObject(json) && !RESOURCE_ENVELOPES.some((k) => k in json)) {
    const entries = Object.entries(json);
    if (entries.length > 0 && entries.every(([, v]) => isObject(v) && nonEmptyString(pick(v, RESOURCE_LOCATION_KEYS)) !== null)) {
      items = entries.map(([key, v]) => ({ key, ...(v as Record<string, unknown>) }));
    }
  }
  if (!items) throw unrecognized('外部资源');
  const out: SurgeExternalResource[] = [];
  for (const item of items) {
    if (!isObject(item)) throw unrecognized('外部资源');
    const key = str(pick(item, ['key', 'name', 'id', 'identifier']));
    const location = nonEmptyString(pick(item, RESOURCE_LOCATION_KEYS));
    if (key === null || key.trim() === '' || location === null) throw unrecognized('外部资源');
    const errorText = nonEmptyString(pick(item, ['error', 'lastError', 'last_error']));
    const local = optionalBool(item, 'local', '外部资源');
    const updating = optionalBool(item, 'updating', '外部资源');
    const fromModuleRaw = item.fromModule;
    if (fromModuleRaw !== undefined && fromModuleRaw !== null && typeof fromModuleRaw !== 'string') throw unrecognized('外部资源');
    out.push({
      key,
      type: str(pick(item, ['type', 'kind'])) ?? 'unknown',
      location: redactUrls(location),
      lastUpdatedAt: local === true ? null : toDate(pick(item, ['lastUpdatedAt', 'lastUpdated', 'last_updated', 'updatedAt', 'updated'])),
      // ready 存在但不是 true（false 或无法识别的值）都按未就绪处理。
      error: errorText !== null ? redactUrls(errorText) : item.ready !== undefined && item.ready !== true ? 'not_ready' : null,
      local,
      updating,
      fromModule: typeof fromModuleRaw === 'string' ? fromModuleRaw : null,
    });
  }
  return out;
}

const RULE_TEXT_KEYS = ['rule', 'text', 'content'] as const;

/** 一项规则的文本：非空字符串，或带非空字符串 rule/text/content 字段的对象；其他一律为 null（调用方报错）。 */
function ruleTextOf(item: unknown): string | null {
  if (typeof item === 'string') return item.trim() === '' ? null : item;
  if (isObject(item)) return nonEmptyString(pick(item, RULE_TEXT_KEYS));
  return null;
}

/**
 * 有效规则列表（--raw dump rule）：只接受 JSON 数组或 { rules|items: [ … ] }；空白输出、非 JSON、
 * 无法识别的项都报错。有效规则至少含 FINAL，空列表同样视为无法识别（读成空会让优先级检查漏掉排在入口之前的规则）。
 */
export function parseRuleList(text: string, scrub: (s: string) => string): SurgeRuleRecord[] {
  const json = parseJsonLoose(text);
  if (json === undefined) throw unrecognized('规则列表');
  const items = arrayFrom(json, ['rules', 'items']);
  if (!items || items.length === 0) throw unrecognized('规则列表');
  return items.map((item) => {
    const raw = ruleTextOf(item);
    if (raw === null) throw unrecognized('规则列表');
    const mod = isObject(item) ? str(pick(item, ['module', 'moduleName'])) : null;
    return { text: scrub(raw), source: mod ? 'module' : 'unknown', moduleName: mod };
  });
}

/**
 * 临时规则（--raw dump temp-rule）：只接受 JSON 字符串数组/对象数组（可在 rules|temp-rules|tempRules|items 中）；
 * 只有空白的输出视为没有临时规则。非 JSON（人类可读输出）或任何一项无法识别都报错，不按行拆分、不跳过。
 */
export function parseTempRuleList(text: string): string[] {
  if (text.trim() === '') return [];
  const json = parseJsonLoose(text);
  if (json === undefined) throw unrecognized('临时规则');
  const items = arrayFrom(json, ['rules', 'temp-rules', 'tempRules', 'items']);
  if (!items) throw unrecognized('临时规则');
  return items.map((item) => {
    const raw = ruleTextOf(item);
    if (raw === null) throw unrecognized('临时规则');
    return raw.trim();
  });
}

export function parsePolicyNames(json: unknown): { proxies: string[]; groups: string[] } {
  if (!isObject(json)) throw unrecognized('策略列表');
  const proxies = pick(json, ['proxies', 'policies']);
  const groups = pick(json, ['policy-groups', 'policyGroups', 'groups']);
  if (!Array.isArray(proxies)) throw unrecognized('策略列表');
  // 组字段存在但不是数组、或任何一项没有名称时报错（漏掉名称会让重名与存在性检查误判）。
  if (groups !== undefined && !Array.isArray(groups)) throw unrecognized('策略列表');
  const names = (arr: unknown[]): string[] =>
    arr.map((v) => {
      const name = typeof v === 'string' ? v : isObject(v) ? str(pick(v, ['name'])) : null;
      if (!name) throw unrecognized('策略列表');
      return name;
    });
  return { proxies: names(proxies), groups: Array.isArray(groups) ? names(groups) : [] };
}

// ---------- Surge Mac 6.10 的读取与结果（--raw JSON；写命令的文字结果） ----------

function nonNegativeInt(v: unknown): number | null {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
}

/**
 * `--raw version`（Mac 6.8.0+；手册：“Show Surge, Core, Controller protocol, operating-system, and device versions.”）。
 * core-version 与 controller-protocol 两个键名与“都是数字”来自 6.10 包内 surge-cli 的校验文字（“core-version or
 * controller-protocol is not a number”）；App 版本与构建号的键名没有写入文档（渲染为 “Surge %@ (%@)”），这里按
 * version/build 读取——TODO(P0)：在测试 Mac 上记录 `surge-cli --raw version` 的键名（P0-RUNBOOK 版本核对）。
 * 键名或格式不对时整体报错（失败即关闭）。只返回四个字段：system-version、device-name、device-identifier 从不读取。
 */
export function parseSurgeVersion(json: unknown): SurgeVersion {
  if (!isObject(json)) throw unrecognized('Surge 版本');
  const version = json.version;
  const buildRaw = json.build;
  const build = typeof buildRaw === 'string' ? buildRaw : nonNegativeInt(buildRaw) !== null ? String(buildRaw) : null;
  const core = json['core-version'];
  const protocol = nonNegativeInt(json['controller-protocol']);
  if (typeof version !== 'string' || !SURGE_VERSION_RE.test(version) || build === null || !SURGE_BUILD_RE.test(build)) throw unrecognized('Surge 版本');
  if (typeof core !== 'number' || !Number.isFinite(core) || protocol === null) throw unrecognized('Surge 版本');
  return { version, build, coreVersion: core, controllerProtocol: protocol };
}

/**
 * `--raw status`（Mac 6.8.0+）的当前配置。随包技能 §3.14：“`status` displays the active profile's absolute path in
 * `profile-path`; profiles that do not originate from a local file report no path.”——没有路径时 path 为 null（调用方应
 * 按“不是工作配置”处理）。配置名的键 profile 来自 6.10 surge-cli 的校验文字；TODO(P0)：核对名称是否带扩展名。
 */
export function parseStatusProfile(json: unknown): SurgeProfileInfo {
  if (!isObject(json)) throw unrecognized('当前配置');
  const name = nonEmptyString(json.profile);
  if (name === null) throw unrecognized('当前配置');
  const rawPath = json['profile-path'];
  if (rawPath === undefined || rawPath === null) return { name, path: null };
  if (typeof rawPath !== 'string' || !rawPath.startsWith('/')) throw unrecognized('当前配置');
  return { name, path: rawPath };
}

/**
 * `--raw feature get <name>`（Mac 6.8.0+）。原始 JSON 未写入文档；按与 HTTP API 相同的 {"enabled": bool} 读取
 * （HTTP 文档：GET /v1/features/… 返回 {"enabled":true}），带 feature 名时必须是请求的那个。TODO(P0)：核对键名。
 */
export function parseFeatureEnabled(json: unknown, feature: string): boolean {
  if (!isObject(json) || typeof json.enabled !== 'boolean') throw unrecognized('功能状态');
  if (json.feature !== undefined && json.feature !== feature) throw unrecognized('功能状态');
  return json.enabled;
}

/**
 * `--raw mode get`（Mac 6.8.0+，“Usage: mode [get | set <rule|direct|proxy>]”）。按与 HTTP API 相同的 {"mode": …} 读取
 * （6.10 surge-cli 校验文字：“mode is not a string”）；不是 rule/direct/proxy 之一的字符串为 null（未知模式）。TODO(P0)：核对。
 */
export function parseOutboundMode(json: unknown): 'rule' | 'direct' | 'proxy' | null {
  if (!isObject(json) || typeof json.mode !== 'string') throw unrecognized('出站模式');
  const m = json.mode.toLowerCase();
  return m === 'rule' || m === 'direct' || m === 'proxy' ? m : null;
}

export interface ParsedPolicyGroup {
  /** 组名；policy-group get 的输出中可能没有。 */
  name: string | null;
  /** 当前选择；自动组没有覆盖时为 null。 */
  selected: string | null;
  /** 成员名，按 Surge 返回的顺序。 */
  options: string[];
}

function parseGroupDict(v: unknown): ParsedPolicyGroup {
  if (!isObject(v) || !Array.isArray(v.options)) throw unrecognized('策略组');
  if (v.name !== undefined && v.name !== null && typeof v.name !== 'string') throw unrecognized('策略组');
  if (v.selected !== undefined && v.selected !== null && typeof v.selected !== 'string') throw unrecognized('策略组');
  // 无法识别的成员不能静默丢弃：读回会把缺少的成员当作不存在。
  const options = v.options.map((o) => {
    const name = typeof o === 'string' ? nonEmptyString(o) : isObject(o) ? nonEmptyString(o.name) : null;
    if (name === null) throw unrecognized('策略组成员');
    return name;
  });
  return { name: typeof v.name === 'string' ? v.name : null, selected: typeof v.selected === 'string' ? v.selected : null, options };
}

/**
 * `--raw policy-group get <group>`（Mac 6.8.0+）。外层 {group: {…}}、组的 selected 与 options[].name 来自 6.10 surge-cli
 * 的校验文字（“policy group response is missing group or groups”）；未写入文档——TODO(P0)：核对，以及 policy-path 导入的
 * 外部节点是否出现在 options 中。带组名时必须是请求的那个。
 */
export function parsePolicyGroupGet(json: unknown, group: string): ParsedPolicyGroup {
  if (!isObject(json)) throw unrecognized('策略组');
  const g = parseGroupDict(json.group);
  if (g.name !== null && g.name !== group) throw unrecognized('策略组');
  return g;
}

/** `--raw policy-group list`（Mac 6.8.0+）：外层 {groups: [ … ]}，每个组必须有名称（同上，TODO(P0)）。 */
export function parsePolicyGroupList(json: unknown): ParsedPolicyGroup[] {
  if (!isObject(json) || !Array.isArray(json.groups)) throw unrecognized('策略组');
  return json.groups.map((g) => {
    const parsed = parseGroupDict(g);
    if (parsed.name === null || parsed.name.trim() === '') throw unrecognized('策略组');
    return parsed;
  });
}

/**
 * `--raw dump performance`（Mac 6.9.0+，协议 ≥22；手册：“Show engine memory usage, uptime, …”）的引擎运行时长。
 * 键名 uptime 来自 6.10 surge-cli 的校验文字；单位没有写入文档，按秒读取——TODO(P0)：在测试 Mac 上核对单位。
 */
export function parsePerformanceUptime(json: unknown): number {
  if (!isObject(json) || typeof json.uptime !== 'number' || !Number.isFinite(json.uptime) || json.uptime < 0) throw unrecognized('引擎运行时长');
  return json.uptime;
}

/** Prometheus 文本中的 surge_uptime_seconds（HTTP API 文档，Mac 6.9.0+：“Engine uptime”）；没有或不是数字时报错。 */
export function parseMetricsUptime(text: string): number {
  let found: number | null = null;
  for (const line of text.split(/\r?\n/)) {
    const m = /^surge_uptime_seconds(?:\{[^}]*\})?\s+(\S+)\s*$/.exec(line.trim());
    if (!m) continue;
    const n = Number(m[1]);
    if (found !== null || !Number.isFinite(n) || n < 0) throw unrecognized('引擎运行时长');
    found = n;
  }
  if (found === null) throw unrecognized('引擎运行时长');
  return found;
}

/**
 * `--raw rule match …`（Mac 6.9.0+，协议 ≥20）：随包技能 §3.9 “return the matched rule and final policy”。键名 rule 与
 * policy 来自 6.10 surge-cli 的校验文字（“rule or policy is not a string”）——TODO(P0)：核对。规则文本经脱敏。
 */
export function parseRuleMatch(json: unknown, scrub: (s: string) => string): SurgeRuleMatchResult {
  if (!isObject(json)) throw unrecognized('规则求值');
  const rule = nonEmptyString(json.rule);
  const policy = nonEmptyString(json.policy);
  if (rule === null || policy === null) throw unrecognized('规则求值');
  return { rule: scrub(rule), policy };
}

/** 6.10 surge-cli 在没有更新任何远端资源时打印的文字（本地资源被跳过时也是它）。 */
export const NO_REMOTE_RESOURCE_UPDATED_TEXT = 'No remote external resource needed updating.';

function resourceUpdateFailed(detail: string, scrub: (s: string) => string): SfeError {
  const clean = scrub(redactUrls(detail)).replace(/\s+/g, ' ').trim().slice(0, 240);
  return new SfeError('SURGE_COMMAND_FAILED', `更新外部资源失败：${clean || 'Surge 报告失败'}`);
}

/**
 * `external-resource update <key>` 的文字结果（不加 --raw，保留命令行工具的命令校验）。HTTP API 文档对同一操作的说明：
 * “The response maps each updated key to "success" or an error message.” 与 “Local resources are skipped.”。
 * 文字形式未写入文档，按 6.10 surge-cli 的渲染（每个 key 一行 “<key>: <结果>”；没有更新任何远端资源时只打印
 * NO_REMOTE_RESOURCE_UPDATED_TEXT）读取——TODO(P0)：核对。只有恰好一行 “<key>: success” 才算已重新下载；
 * 跳过从不算刷新；该 key 的其他结果是失败；其余输出无法识别（失败即关闭）。
 */
export function parseResourceUpdateText(stdout: string, key: string, scrub: (s: string) => string): SurgeResourceUpdateResult {
  const lines = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '');
  if (lines.length === 1 && lines[0] === NO_REMOTE_RESOURCE_UPDATED_TEXT) return { key, refreshed: false, outcome: 'skipped' };
  if (lines.length === 1 && lines[0]!.startsWith(`${key}: `)) {
    const value = lines[0]!.slice(key.length + 2).trim();
    if (value === 'success') return { key, refreshed: true, outcome: 'downloaded' };
    throw resourceUpdateFailed(value, scrub);
  }
  throw unrecognized('外部资源更新结果');
}

/** POST /v1/external_resources/update 的结果（HTTP API 文档，Mac 6.10.0+）：键到 "success" 或错误文字的映射；空映射为跳过。 */
export function parseResourceUpdateMap(json: unknown, key: string, scrub: (s: string) => string): SurgeResourceUpdateResult {
  if (!isObject(json)) throw unrecognized('外部资源更新结果');
  const keys = Object.keys(json);
  if (keys.length === 0) return { key, refreshed: false, outcome: 'skipped' };
  const value = json[key];
  if (keys.length !== 1 || typeof value !== 'string') throw unrecognized('外部资源更新结果');
  if (value === 'success') return { key, refreshed: true, outcome: 'downloaded' };
  throw resourceUpdateFailed(value, scrub);
}
