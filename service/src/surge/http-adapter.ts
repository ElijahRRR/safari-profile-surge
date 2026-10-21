// HTTP API 实现：只连回环地址，密钥运行时从工作配置读取（getKey），只放在 X-Key 请求头中，
// 从不进入日志、错误或返回值。端点在 6.5 上均未核对（TODO(P0)）；外部资源与临时规则的 HTTP 版本
// 标注为 6.9+/6.10+，这里一律 CAPABILITY_UNVERIFIED。见 docs/ARCHITECTURE.md §5.1。

import { isIP } from 'node:net';
import { SfeError, type TakeoverState } from '@sfe/contract';
import type { SurgeAdapter, SurgePolicyDetail, SurgePolicyTestResult, SurgeRuleRecord } from '../ports.js';
import { parsePolicyNames, parseRequestRecords, unrecognized } from './parse-output.js';
import { capabilityUnverified, maskKnown, truncate, type MechanismMap, type SurgePrimitive } from './primitives.js';
import { parseProxyLine } from './proxy-line.js';
import { redactFreeText, redactProxyLine } from './redact-profile.js';
import { parseProfile, findSections } from './profile.js';

export interface HttpAdapterOptions {
  baseUrl: string;
  getKey: () => Promise<string>;
  mechanism: MechanismMap;
  fetch?: typeof fetch;
  timeoutMs?: number;
  scrub: (s: string) => string;
  now?: () => Date;
}

export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h === '::1') return true;
  return isIP(h) === 4 && h.startsWith('127.');
}

function assertLoopbackBase(baseUrl: string): URL {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new SfeError('UNSAFE_LOCATION', '连接 Surge HTTP API 失败：地址不正确');
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password || !isLoopbackHost(url.hostname)) {
    throw new SfeError('UNSAFE_LOCATION', '连接 Surge HTTP API 失败：只允许本机回环地址');
  }
  return url;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 在内存中从详情响应里找出节点行。 */
function findProxyLine(json: unknown, name: string): string | null {
  if (typeof json === 'string') return json;
  if (!isObject(json)) return null;
  for (const k of [name, 'policy', 'line', 'detail', 'content']) {
    const v = json[k];
    if (typeof v === 'string' && v.includes('=')) return v;
  }
  for (const v of Object.values(json)) if (typeof v === 'string' && v.includes('=') && v.includes(',')) return v;
  return null;
}

export function createHttpAdapter(opts: HttpAdapterOptions): SurgeAdapter {
  const base = assertLoopbackBase(opts.baseUrl);
  const doFetch = opts.fetch ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const mechanism = { ...opts.mechanism };
  const now = opts.now ?? (() => new Date());

  function guard(p: SurgePrimitive): void {
    if (mechanism[p] !== 'http') throw capabilityUnverified(p);
  }

  async function request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    const key = await opts.getKey();
    const clean = (s: string): string => opts.scrub(redactFreeText(maskKnown(s, [key])));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await doFetch(new URL(path, base), {
        method,
        headers: { 'X-Key': key, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
        redirect: 'error',
      });
    } catch {
      throw new SfeError('SURGE_UNREACHABLE', '连接 Surge HTTP API 失败：无响应或超时');
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text().catch(() => '');
    if (res.status === 401 || res.status === 403) {
      throw new SfeError('SURGE_COMMAND_FAILED', '调用 Surge HTTP API 失败：认证被拒绝', { details: { status: res.status } });
    }
    if (!res.ok) {
      throw new SfeError('SURGE_COMMAND_FAILED', `调用 Surge HTTP API 失败：${truncate(clean(text)) || `状态 ${res.status}`}`, {
        details: { status: res.status },
      });
    }
    if (!text.trim()) return {};
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }

  const q = (v: string): string => encodeURIComponent(v);

  async function feature(path: string): Promise<boolean | null> {
    try {
      const json = await request('GET', path);
      return isObject(json) && typeof json.enabled === 'boolean' ? json.enabled : null;
    } catch (e) {
      if (e instanceof SfeError && e.code === 'SURGE_UNREACHABLE') throw e;
      return null;
    }
  }

  const adapter: SurgeAdapter = {
    mechanism: () => ({ ...mechanism }),

    async getVersion() {
      guard('getVersion');
      throw capabilityUnverified('getVersion');
    },
    async getRuntimeInfo() {
      guard('getRuntimeInfo');
      throw capabilityUnverified('getRuntimeInfo');
    },
    async getAutoReloadSetting() {
      guard('getAutoReloadSetting');
      throw capabilityUnverified('getAutoReloadSetting');
    },
    async checkProfile() {
      guard('checkProfile');
      throw capabilityUnverified('checkProfile');
    },

    async getCurrentProfile() {
      guard('getCurrentProfile');
      // sensitive=0；只取名称，配置正文立即丢弃。
      const json = await request('GET', '/v1/profiles/current?sensitive=0');
      const name = isObject(json) && typeof json.name === 'string' ? json.name : null;
      if (name === null) throw unrecognized('当前配置');
      return { name, path: null };
    },

    async getTakeoverState(): Promise<TakeoverState> {
      guard('getTakeoverState');
      const enhancedMode = await feature('/v1/features/enhanced_mode');
      const systemProxy = await feature('/v1/features/system_proxy');
      let outboundMode: TakeoverState['outboundMode'] = null;
      try {
        const json = await request('GET', '/v1/outbound');
        const mode = isObject(json) ? json.mode : null;
        outboundMode = mode === 'rule' || mode === 'direct' || mode === 'proxy' ? mode : null;
      } catch (e) {
        if (e instanceof SfeError && e.code === 'SURGE_UNREACHABLE') throw e;
      }
      return { enhancedMode, systemProxy, outboundMode, checkedAt: now().toISOString() };
    },

    async listPolicies() {
      guard('listPolicies');
      return parsePolicyNames(await request('GET', '/v1/policies'));
    },

    async getPolicyDetail(name: string): Promise<SurgePolicyDetail> {
      guard('getPolicyDetail');
      const json = await request('GET', `/v1/policies/detail?policy_name=${q(name)}`);
      const line = findProxyLine(json, name);
      if (line === null) return { name, type: null, server: null, port: null, underlyingProxy: null, redactedRaw: null };
      const parsed = parseProxyLine(line);
      const key = await opts.getKey();
      return {
        name,
        type: parsed?.type ?? null,
        server: parsed?.server ?? null,
        port: parsed?.port ?? null,
        underlyingProxy: parsed?.params['underlying-proxy'] ?? null,
        redactedRaw: opts.scrub(maskKnown(redactProxyLine(line), [key])),
      };
    },

    async getGroupMembers(group: string) {
      guard('getGroupMembers');
      const json = await request('GET', '/v1/policy_groups');
      const members = isObject(json) ? json[group] : undefined;
      if (!Array.isArray(members)) throw new SfeError('SURGE_COMMAND_FAILED', '读取策略组失败：组不存在', { details: { group } });
      return members
        .map((m) => (typeof m === 'string' ? m : isObject(m) && typeof m.name === 'string' ? m.name : null))
        .filter((m): m is string => m !== null);
    },

    async getGroupSelection(group: string) {
      guard('getGroupSelection');
      const json = await request('GET', `/v1/policy_groups/select?group_name=${q(group)}`);
      return isObject(json) && typeof json.policy === 'string' ? json.policy : null;
    },

    async selectGroupPolicy(group: string, policy: string) {
      guard('selectGroupPolicy');
      await request('POST', '/v1/policy_groups/select', { group_name: group, policy });
    },

    async testPolicy(policy: string, url: string): Promise<SurgePolicyTestResult> {
      guard('testPolicy');
      const json = await request('POST', '/v1/policies/test', { policy_names: [policy], url });
      const r = isObject(json) ? json[policy] : undefined;
      if (!isObject(r)) return { ok: false, latencyMs: null, error: '没有返回测试结果' };
      const latency = [r.receive, r.tcp, r.latency].find((v) => typeof v === 'number' && v >= 0) as number | undefined;
      const err = typeof r.error === 'string' && r.error ? truncate(opts.scrub(redactFreeText(r.error))) : null;
      return { ok: err === null && latency !== undefined, latencyMs: latency ?? null, error: err };
    },

    async listRules(): Promise<SurgeRuleRecord[]> {
      guard('listRules');
      const json = await request('GET', '/v1/rules');
      const rules = isObject(json) ? json.rules : Array.isArray(json) ? json : null;
      if (!Array.isArray(rules)) throw unrecognized('规则列表');
      // TODO(P0)：/v1/rules 是否包含模块与临时规则、能否区分来源。
      return rules
        .filter((r): r is string => typeof r === 'string')
        .map((text) => ({ text: opts.scrub(redactFreeText(text)), source: 'unknown' as const, moduleName: null }));
    },

    async listActiveRequests() {
      guard('listActiveRequests');
      return parseRequestRecords(await request('GET', '/v1/requests/active'));
    },
    async listRecentRequests() {
      guard('listRecentRequests');
      return parseRequestRecords(await request('GET', '/v1/requests/recent'));
    },
    async killRequest(id: string) {
      guard('killRequest');
      const n = Number(id);
      await request('POST', '/v1/requests/kill', { id: Number.isSafeInteger(n) ? n : id });
    },

    async listExternalResources() {
      guard('listExternalResources');
      throw capabilityUnverified('listExternalResources');
    },
    async updateExternalResource() {
      guard('updateExternalResource');
      throw capabilityUnverified('updateExternalResource');
    },
    async listTempRules() {
      guard('listTempRules');
      throw capabilityUnverified('listTempRules');
    },
    async addTempRule() {
      guard('addTempRule');
      throw capabilityUnverified('addTempRule');
    },
    async removeTempRule() {
      guard('removeTempRule');
      throw capabilityUnverified('removeTempRule');
    },
  };
  return adapter;
}

export interface HttpApiLine {
  /** 只在内存中使用，从不记录或返回给界面。 */
  key: string;
  host: string;
  port: number;
  loopbackOnly: boolean;
}

/** 解析工作配置 [General] 中的 `http-api = key@host:port`。 */
export function parseHttpApiLine(profileText: string): HttpApiLine | null {
  const parsed = parseProfile(profileText);
  const general = findSections(parsed, 'General');
  for (const section of general) {
    for (let i = section.start; i < section.end; i++) {
      const m = /^\s*http-api\s*=\s*(.+?)\s*$/i.exec(parsed.lines[i]!.text);
      if (!m) continue;
      const value = m[1]!;
      const at = value.lastIndexOf('@');
      if (at <= 0) return null;
      const key = value.slice(0, at);
      const hostPort = value.slice(at + 1);
      const hp = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/.exec(hostPort);
      if (!hp) return null;
      const port = Number(hp[2]);
      if (port < 1 || port > 65535) return null;
      const host = hp[1]!.replace(/^\[|\]$/g, '');
      return { key, host, port, loopbackOnly: isLoopbackHost(host) };
    }
  }
  return null;
}
