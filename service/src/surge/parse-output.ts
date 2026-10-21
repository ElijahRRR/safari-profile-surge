// CLI 与 HTTP 输出的宽松解析。字段名以 Surge 6.5 实测为准（TODO(P0)：逐项核对）；
// 只取识别所需的字段，URL、请求头、节点参数等一律不保留。

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
    if (!isObject(item)) continue;
    const id = str(pick(item, ['id', 'requestId', 'request_id']));
    if (id === null) continue;
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

export function parseExternalResources(json: unknown): SurgeExternalResource[] {
  let items = arrayFrom(json, ['resources', 'external-resources', 'externalResources', 'items']);
  if (!items && isObject(json)) {
    // 也接受 { key: { … } } 形式。
    items = Object.entries(json).map(([key, v]) => (isObject(v) ? { key, ...v } : null)).filter((v) => v !== null);
  }
  if (!items) throw unrecognized('外部资源');
  const out: SurgeExternalResource[] = [];
  for (const item of items) {
    if (!isObject(item)) continue;
    const key = str(pick(item, ['key', 'name', 'id', 'identifier']));
    const location = str(pick(item, ['location', 'path', 'url', 'source']));
    if (key === null || location === null) continue;
    const error = pick(item, ['error', 'lastError', 'last_error']);
    out.push({
      key,
      type: str(pick(item, ['type', 'kind'])) ?? 'unknown',
      location: redactUrls(location),
      lastUpdatedAt: toDate(pick(item, ['lastUpdatedAt', 'lastUpdated', 'last_updated', 'updatedAt', 'updated'])),
      error: typeof error === 'string' && error.trim() ? error : null,
    });
  }
  return out;
}

/** 规则列表：JSON 数组/对象，或每行一条的纯文本（跳过注释与空行）。 */
export function parseRuleList(text: string, scrub: (s: string) => string): SurgeRuleRecord[] {
  const json = parseJsonLoose(text);
  let items: unknown[] | null = null;
  if (json !== undefined) {
    items = arrayFrom(json, ['rules', 'items']);
    if (!items) throw unrecognized('规则列表');
  } else {
    items = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  }
  const out: SurgeRuleRecord[] = [];
  for (const item of items) {
    const raw = typeof item === 'string' ? item : isObject(item) ? str(pick(item, ['rule', 'text', 'content'])) : null;
    if (!raw) continue;
    const mod = isObject(item) ? str(pick(item, ['module', 'moduleName'])) : null;
    out.push({ text: scrub(raw), source: mod ? 'module' : 'unknown', moduleName: mod });
  }
  return out;
}

/** 临时规则：JSON 字符串数组/对象数组，或每行一条。 */
export function parseTempRuleList(text: string): string[] {
  const json = parseJsonLoose(text);
  if (json !== undefined) {
    const items = arrayFrom(json, ['rules', 'temp-rules', 'tempRules', 'items']);
    if (!items) throw unrecognized('临时规则');
    return items
      .map((i) => (typeof i === 'string' ? i : isObject(i) ? str(pick(i, ['rule', 'content', 'text'])) : null))
      .filter((v): v is string => typeof v === 'string' && v.trim() !== '')
      .map((v) => v.trim());
  }
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

export function parsePolicyNames(json: unknown): { proxies: string[]; groups: string[] } {
  if (!isObject(json)) throw unrecognized('策略列表');
  const proxies = pick(json, ['proxies', 'policies']);
  const groups = pick(json, ['policy-groups', 'policyGroups', 'groups']);
  if (!Array.isArray(proxies)) throw unrecognized('策略列表');
  const names = (arr: unknown[]): string[] =>
    arr.map((v) => (typeof v === 'string' ? v : isObject(v) ? str(pick(v, ['name'])) : null)).filter((v): v is string => !!v);
  return { proxies: names(proxies), groups: Array.isArray(groups) ? names(groups) : [] };
}
