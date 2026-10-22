// CLI 与 HTTP 输出的解析。字段名以 Surge 6.5 实测为准（TODO(P0)：逐项核对）；
// 只取识别所需的字段，URL、请求头、节点参数等一律不保留。
// 失败即关闭：只接受已知的外层结构；列表中任何一项无法识别时整体报“输出格式无法识别”，从不静默跳过
// （漏掉一条规则、一个资源或一条请求会让读回把“存在”误判为“不存在”）。

import { SfeError } from '@sfe/contract';
import type { SurgeExternalResource, SurgeRequestRecord, SurgeRuleRecord } from '../ports.js';
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

/**
 * 外部资源：只接受 { defines|resources|…: [ … ] }、顶层数组，或每个值都是带位置字段对象的 { key: { … } }。
 * 缺 key 或位置的项、无法识别的外层结构一律报错。ready 不是 true 且没有错误文本时记为 not_ready（未加载的资源不算健康）。
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
    out.push({
      key,
      type: str(pick(item, ['type', 'kind'])) ?? 'unknown',
      location: redactUrls(location),
      lastUpdatedAt: toDate(pick(item, ['lastUpdatedAt', 'lastUpdated', 'last_updated', 'updatedAt', 'updated'])),
      // ready 存在但不是 true（false 或无法识别的值）都按未就绪处理。
      error: errorText !== null ? redactUrls(errorText) : item.ready !== undefined && item.ready !== true ? 'not_ready' : null,
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
