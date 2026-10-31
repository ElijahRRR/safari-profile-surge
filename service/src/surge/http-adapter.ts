// HTTP API 实现（https://manual.nssurge.com/tools/http-api.html，目标 Surge Mac 6.10.0）：只连回环地址，密钥运行时从
// 工作配置读取（getKey），只放在 X-Key 请求头中，从不进入日志、错误或返回值。
// - 临时规则与规则求值：HTTP API 在任何版本都没有对应端点，只能经 CLI（rule temp、rule match），这里一律 CAPABILITY_UNVERIFIED；
// - 外部资源：Mac 6.10.0+ 才有（“External Resources (iOS 5.23.0+, Mac 6.10.0+)”），按单个 key 更新，从不 all；
// - 引擎运行时长：/v1/metrics 的 surge_uptime_seconds（Mac 6.9.0+，纯文本）；
// - 版本：没有能给出 Controller 协议号的端点，保持 CAPABILITY_UNVERIFIED。
// 文档没有给出响应结构的端点（/v1/policy_groups、/v1/rules、/v1/requests/*、/v1/profiles/current 的名称字段等）逐项标
// TODO(P0)，结构不对时报错。写入只有：SFE-ROUTE 的选择、结束单个请求、更新单个外部资源。见 docs/ARCHITECTURE.md §5.1。

import { isIP } from 'node:net';
import { SfeError, type TakeoverState } from '@sfe/contract';
import type { SurgeAdapter, SurgePolicyDetail, SurgePolicyTestResult, SurgeRuleRecord } from '../ports.js';
import { safeConnectionId, safeResourceKey, safeRouteSelection } from './cli-commands.js';
import { parseExternalResources, parseMetricsUptime, parsePolicyNames, parseRequestRecords, parseResourceUpdateMap, unrecognized } from './parse-output.js';
import {
  capabilityUnverified,
  maskKnown,
  resourceUpdateTimeoutError,
  truncate,
  validatePrimitiveTimeouts,
  type MechanismMap,
  type PrimitiveTimeouts,
  type SurgePrimitive,
} from './primitives.js';
import { parseProxyLine } from './proxy-line.js';
import { redactFreeText, redactProxyLine } from './redact-profile.js';
import { parseProfile, findSections } from './profile.js';

export interface HttpAdapterOptions {
  baseUrl: string;
  getKey: () => Promise<string>;
  mechanism: MechanismMap;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** 单个原语的超时，覆盖 timeoutMs（例如 updateExternalResource，见 primitives.ts SURGE_RESOURCE_UPDATE_TIMEOUT_MS）。 */
  timeoutsMs?: PrimitiveTimeouts;
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
  const timeouts = validatePrimitiveTimeouts(opts.timeoutsMs);
  const mechanism = { ...opts.mechanism };
  const now = opts.now ?? (() => new Date());

  function guard(p: SurgePrimitive): void {
    if (mechanism[p] !== 'http') throw capabilityUnverified(p);
  }

  /** primitive 决定超时（timeoutsMs 覆盖缺省值）与超时的分类。 */
  async function request(primitive: SurgePrimitive, method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    const key = await opts.getKey();
    const clean = (s: string): string => opts.scrub(redactFreeText(maskKnown(s, [key])));
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeouts[primitive] ?? timeoutMs);
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
      // 更新单个外部资源的请求已经发出：超时之后 Surge 可能仍在下载或已经载入——结果未知，不是“无法连接”。
      if (timedOut && primitive === 'updateExternalResource') throw resourceUpdateTimeoutError();
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
      const json = await request('getTakeoverState', 'GET', path);
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
      // /v1/metrics 的 surge_build_info 只有版本与构建号，没有 Controller 协议号（版本门槛需要它）。
      throw capabilityUnverified('getVersion');
    },
    async getRuntimeInfo() {
      guard('getRuntimeInfo');
      // Prometheus 文本（“`/v1/metrics` returns plain text instead of JSON”）：surge_uptime_seconds “Engine uptime”。
      const body = await request('getRuntimeInfo', 'GET', '/v1/metrics');
      if (typeof body !== 'string') throw unrecognized('引擎运行时长');
      const uptimeSeconds = parseMetricsUptime(body);
      const at = now().getTime();
      return { uptimeSeconds, startedAt: new Date(Math.floor((at - uptimeSeconds * 1000) / 1000) * 1000) };
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
      // sensitive=0；只取名称，配置正文立即丢弃。文档只说明该端点返回配置正文（“Obtain the text content of the current
      // profile.”），name 字段未写入文档，也没有路径——TODO(P0)：确认有 name 字段才保留这个实现；路径用 CLI 的 status。
      const json = await request('getCurrentProfile', 'GET', '/v1/profiles/current?sensitive=0');
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
        const json = await request('getTakeoverState', 'GET', '/v1/outbound');
        const mode = isObject(json) ? json.mode : null;
        outboundMode = mode === 'rule' || mode === 'direct' || mode === 'proxy' ? mode : null;
      } catch (e) {
        if (e instanceof SfeError && e.code === 'SURGE_UNREACHABLE') throw e;
      }
      return { enhancedMode, systemProxy, outboundMode, checkedAt: now().toISOString() };
    },

    async listPolicies() {
      guard('listPolicies');
      return parsePolicyNames(await request('listPolicies', 'GET', '/v1/policies'));
    },

    async getPolicyDetail(name: string): Promise<SurgePolicyDetail> {
      guard('getPolicyDetail');
      const json = await request('getPolicyDetail', 'GET', `/v1/policies/detail?policy_name=${q(name)}`);
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
      // “List all policy groups and their options.”——结构未写入文档（TODO(P0)）。
      const json = await request('getGroupMembers', 'GET', '/v1/policy_groups');
      const members = isObject(json) ? json[group] : undefined;
      if (!Array.isArray(members)) throw new SfeError('SURGE_COMMAND_FAILED', '读取策略组失败：组不存在', { details: { group } });
      // 无法识别的成员不能静默丢弃：读回会把缺少的成员当作不存在。
      return members.map((m) => {
        const name = typeof m === 'string' ? m : isObject(m) && typeof m.name === 'string' ? m.name : null;
        if (!name) throw unrecognized('策略组成员');
        return name;
      });
    },

    async getGroupSelection(group: string) {
      guard('getGroupSelection');
      const json = await request('getGroupSelection', 'GET', `/v1/policy_groups/select?group_name=${q(group)}`);
      return isObject(json) && typeof json.policy === 'string' ? json.policy : null;
    },

    async selectGroupPolicy(group: string, policy: string) {
      guard('selectGroupPolicy');
      // 只选择 SFE-ROUTE，选项不能是 auto（与 CLI 相同的限制）。
      const [g, p] = safeRouteSelection(group, policy);
      await request('selectGroupPolicy', 'POST', '/v1/policy_groups/select', { group_name: g, policy: p });
    },

    async testPolicy(policy: string, url: string): Promise<SurgePolicyTestResult> {
      guard('testPolicy');
      const json = await request('testPolicy', 'POST', '/v1/policies/test', { policy_names: [policy], url });
      const r = isObject(json) ? json[policy] : undefined;
      if (!isObject(r)) return { ok: false, latencyMs: null, error: '没有返回测试结果' };
      const latency = [r.receive, r.tcp, r.latency].find((v) => typeof v === 'number' && v >= 0) as number | undefined;
      const err = typeof r.error === 'string' && r.error ? truncate(opts.scrub(redactFreeText(r.error))) : null;
      return { ok: err === null && latency !== undefined, latencyMs: latency ?? null, error: err };
    },

    async listRules(): Promise<SurgeRuleRecord[]> {
      guard('listRules');
      const json = await request('listRules', 'GET', '/v1/rules');
      const rules = isObject(json) ? json.rules : Array.isArray(json) ? json : null;
      // 与 CLI 解析一致：空列表（总有 FINAL）或无法识别的条目都是误读，不能静默丢弃（被丢弃的规则可能排在入口之前）。
      if (!Array.isArray(rules) || rules.length === 0) throw unrecognized('规则列表');
      // TODO(P0)：/v1/rules 是否包含模块与临时规则、能否区分来源。
      return rules.map((text) => {
        if (typeof text !== 'string' || text.trim() === '') throw unrecognized('规则列表');
        return { text: opts.scrub(redactFreeText(text)), source: 'unknown' as const, moduleName: null };
      });
    },

    async listActiveRequests() {
      guard('listActiveRequests');
      return parseRequestRecords(await request('listActiveRequests', 'GET', '/v1/requests/active'));
    },
    async listRecentRequests() {
      guard('listRecentRequests');
      return parseRequestRecords(await request('listRecentRequests', 'GET', '/v1/requests/recent'));
    },
    async killRequest(id: string) {
      guard('killRequest');
      // 文档：POST /v1/requests/kill，{"id": 100}——只结束一个请求，只接受数字 id。
      const n = Number(safeConnectionId(id));
      if (!Number.isSafeInteger(n)) throw new SfeError('VALIDATION_FAILED', '执行 Surge 命令失败：连接编号不合法');
      await request('killRequest', 'POST', '/v1/requests/kill', { id: n });
    },

    async matchRule() {
      guard('matchRule');
      // HTTP API 没有规则求值端点（rule match 只在 CLI，Mac 6.9.0+）。
      throw capabilityUnverified('matchRule');
    },

    async listExternalResources() {
      guard('listExternalResources');
      // Mac 6.10.0+：GET /v1/external_resources → {"defines": [...]}（与 CLI 用同一解析）。
      return parseExternalResources(await request('listExternalResources', 'GET', '/v1/external_resources'));
    },
    async updateExternalResource(key: string) {
      guard('updateExternalResource');
      // Mac 6.10.0+：POST /v1/external_resources/update {"key": …}。“Local resources are skipped.”；结果是键到 "success"
      // 或错误文字的映射，键不存在时 400（request 按命令失败抛出）。从不使用 "all"。
      const k = safeResourceKey(key);
      return parseResourceUpdateMap(await request('updateExternalResource', 'POST', '/v1/external_resources/update', { key: k }), k, (t) => opts.scrub(redactFreeText(t)));
    },
    // HTTP API 没有临时规则端点（任何版本）：只能经 CLI 的 rule temp。
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
