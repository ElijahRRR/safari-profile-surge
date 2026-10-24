// 测试配置上的受控写入：只写本工具创建并登记过摘要的测试文件（摘要不符即拒绝，视为外部修改）、只选择 SFE-ROUTE。
// 本地文件写入后不调用 external-resource update（Surge 6.10：“Local resources are skipped.”）：节点资源与规则集由
// Surge 的文件监视自动重新读取，这里只做有界的轮询读回（waitForMembers、waitForRuleSetCanary）。update 只用于记录
// 它对本地资源的实际结果（recordUpdate），从不当作刷新。每个写入都记入动作时间线（continuity 据此标注）。

import { ROUTE_GROUP_NAME } from '@sfe/contract';
import type { ReloadSignals } from '../analysis/reload.js';
import { SERVER_LOGS } from '../constants.js';
import { createProfileFiles, type SurgeResourceUpdateResult } from '../deps.js';
import { refused } from '../errors.js';
import { proxyGet, type ProxyAddress } from '../http-client.js';
import { logAction } from '../results.js';
import type { RunDir } from '../run-dir.js';
import { createdFile, saveState, upsertCreatedFile, type RunState } from '../state.js';
import { surgeStartFingerprint } from '../system.js';
import { CANARY_FILE, CHAIN_HOST, TEST_PROFILE_FILE, TEST_PROXIES, armProfileCanary, canaryContent, canaryHost, profileCanaryHost } from '../test-profile.js';
import { tryRead, type Ctx, type Session } from './common.js';

/**
 * rule match 的合成来源进程（“other app”）：canary 规则只按域名匹配，与进程无关；`rule match` 只是求值，不要求该进程存在。
 */
export const SYNTHETIC_PROCESS_PATH = '/usr/bin/true';

/** 轮询读回的间隔：写入后等待 Surge 文件监视重新读取。 */
export const WATCH_POLL_MS = 500;

export interface WaitResult<T> {
  /** 在时限内读到期望的结果。 */
  ok: boolean;
  /** 最后一次读到的值（读不到为 null）。 */
  value: T | null;
  /** 从写入后开始等待到读到期望结果（或放弃）的实际毫秒数。 */
  ms: number;
  polls: number;
}

export interface UpdateRecord {
  ok: boolean;
  ms: number;
  code: string | null;
  /** Surge 报告的结果；本地资源应为 skipped（不算刷新）。 */
  result: SurgeResourceUpdateResult | null;
}

export class TestOps {
  readonly files: ReturnType<typeof createProfileFiles>;

  constructor(
    readonly ctx: Ctx,
    readonly dir: RunDir,
    readonly session: Session,
    public state: RunState,
  ) {
    if (!state.testDirectory) throw refused('前置条件不满足：还没有测试配置，请先运行 make-test-profile');
    this.files = createProfileFiles({ directory: state.testDirectory, hmacKey: dir.key() });
  }

  private now(): string {
    return this.ctx.deps.now().toISOString();
  }

  private save(): void {
    saveState(this.dir, this.state);
  }

  action(action: string, detail?: Record<string, unknown>): void {
    logAction(this.dir, { at: this.now(), command: this.ctx.args.command, action, detail });
  }

  /** 写本工具创建的测试文件：当前摘要必须等于上次写入后记录的摘要。 */
  async writeTestFile(name: string, content: string): Promise<void> {
    const path = `${this.state.testDirectory}/${name}`;
    const rec = createdFile(this.state, path);
    if (!rec) throw refused(`写入测试文件失败：${name} 不是本工具创建的文件`);
    await this.files.writeAtomic(name, content, rec.digest);
    this.state = upsertCreatedFile(this.state, { ...rec, digest: (await this.files.digest(name))! });
    this.save();
    this.action('test_file_written', { file: name });
  }

  /** 服务的入口策略写入入口规则集文件后（ruleset_resource），把运行状态中的摘要同步为当前内容。 */
  async syncDigest(name: string): Promise<void> {
    const path = `${this.state.testDirectory}/${name}`;
    const rec = createdFile(this.state, path);
    const digest = await this.files.digest(name);
    if (rec && digest) {
      this.state = upsertCreatedFile(this.state, { ...rec, digest });
      this.save();
    }
  }

  /**
   * 只用于测量：对单个本工具资源 key 调用一次 external-resource update，记录 Surge 报告的结构化结果。HTTP API 文档
   * （Mac 6.10.0+）：“Local resources are skipped.”——对本地资源这从不算刷新，调用方也从不据它判断文件已被读取。
   */
  async recordUpdate(key: string, label: string): Promise<UpdateRecord> {
    const t0 = Date.now();
    this.action('resource_update_call', { key, label });
    try {
      const result = await this.session.adapter.updateExternalResource(key);
      return { ok: true, ms: Date.now() - t0, code: null, result };
    } catch (e) {
      return { ok: false, ms: Date.now() - t0, code: (e as { code?: string }).code ?? 'ERROR', result: null };
    }
  }

  /** 有界轮询（次数按时限与间隔计算，不依赖墙钟）：read 返回值被 accept 接受即成功。 */
  async poll<T>(read: () => Promise<T | null>, accept: (v: T) => boolean, timeoutMs: number, pollMs = WATCH_POLL_MS): Promise<WaitResult<T>> {
    const { now, sleep } = this.ctx.deps;
    const t0 = now().getTime();
    const polls = Math.max(1, Math.ceil(timeoutMs / pollMs) + 1);
    let value: T | null = null;
    for (let i = 0; i < polls; i++) {
      value = await read();
      if (value !== null && accept(value)) return { ok: true, value, ms: now().getTime() - t0, polls: i + 1 };
      if (i < polls - 1) await sleep(pollMs);
    }
    return { ok: false, value, ms: now().getTime() - t0, polls };
  }

  /** 写入节点资源后等待 Surge 自动重新读取（不调用 update）：轮询 SFE-ROUTE 的成员直到 accept 为真。 */
  async waitForMembers(accept: (members: readonly string[]) => boolean, timeoutMs: number): Promise<WaitResult<string[]>> {
    return this.poll(() => tryRead(() => this.session.adapter.getGroupMembers(ROUTE_GROUP_NAME)), accept, timeoutMs);
  }

  /**
   * 规则集 canary 是否已按第 index 号生效：优先用 `rule match`（只求值，不建立连接），读不到时经 Surge 代理实际请求一次。
   * 生效 → true；按后缀规则经 P0-Plain → false；无法判断 → null。
   */
  async ruleSetCanaryLoaded(proxy: ProxyAddress, echoPort: number, index: number): Promise<{ loaded: boolean | null; via: 'rule_match' | 'request' }> {
    const m = await tryRead(() => this.session.adapter.matchRule({ host: canaryHost(index), processPath: SYNTHETIC_PROCESS_PATH, protocol: 'TCP', port: 443 }));
    if (m !== null) return { loaded: m.policy === TEST_PROXIES.canary ? true : m.policy === TEST_PROXIES.plain ? false : null, via: 'rule_match' };
    return { loaded: await probeCanary(proxy, echoPort, index), via: 'request' };
  }

  /** 原子替换规则集 canary 后等待 Surge 文件监视重新读取（不调用 update），返回实际延迟。 */
  async waitForRuleSetCanary(proxy: ProxyAddress, echoPort: number, index: number, timeoutMs: number): Promise<WaitResult<boolean> & { via: 'rule_match' | 'request' | null }> {
    let via: 'rule_match' | 'request' | null = null;
    const r = await this.poll(
      async () => {
        const x = await this.ruleSetCanaryLoaded(proxy, echoPort, index);
        via = x.via;
        return x.loaded;
      },
      (loaded) => loaded,
      timeoutMs,
    );
    return { ...r, via };
  }

  async select(node: string): Promise<string | null> {
    const before = await tryRead(() => this.session.adapter.getGroupSelection(ROUTE_GROUP_NAME));
    this.action('select', { group: ROUTE_GROUP_NAME, node });
    await this.session.adapter.selectGroupPolicy(ROUTE_GROUP_NAME, node);
    const after = await tryRead(() => this.session.adapter.getGroupSelection(ROUTE_GROUP_NAME));
    this.state = { ...this.state, selections: [...this.state.selections, { group: ROUTE_GROUP_NAME, before, after: node, at: this.now() }] };
    this.save();
    return after;
  }

  /** 原子替换规则集 canary（本地 RULE-SET，由 Surge 文件监视自动重新读取；不调用 update）。 */
  async writeRuleSetCanary(index: number): Promise<void> {
    await this.writeTestFile(CANARY_FILE, canaryContent(index));
    this.action('ruleset_canary_written', { index });
  }

  /**
   * 布置配置 canary：原子替换测试配置中的配置 canary 行（主配置只在配置重载时被读取）。之后它生效即说明发生了配置重载。
   * 自动重载开启时这一次写入本身就可能触发重载（调用方据读回判断配置 canary 是否可用）。
   */
  async armProfileCanary(index: number): Promise<void> {
    const current = await this.files.read(TEST_PROFILE_FILE);
    if (current === null) throw refused('布置配置 canary 失败：测试配置不存在');
    await this.writeTestFile(TEST_PROFILE_FILE, armProfileCanary(current, index));
    this.action('profile_canary_armed', { index });
  }

  async signals(proxy: ProxyAddress, echoPort: number, profileCanaryIndex: number | null): Promise<ReloadSignals> {
    const a = this.session.adapter;
    return {
      at: this.now(),
      profileCanaryLoaded: profileCanaryIndex === null ? null : await probeProfileCanary(proxy, echoPort, profileCanaryIndex),
      surgeStart: await surgeStartFingerprint(this.ctx.deps.exec),
      engineUptimeSeconds: (await tryRead(() => a.getRuntimeInfo()))?.uptimeSeconds ?? null,
      tempRules: await tryRead(() => a.listTempRules()),
      profileName: (await tryRead(() => a.getCurrentProfile()))?.name ?? null,
    };
  }
}

/** 新的配置 canary 编号：按秒取，并与上一次不同（同一秒内连续布置时）。 */
export function nextCanaryIndex(now: Date, previous: number | null = null): number {
  const n = Math.floor(now.getTime() / 1000) % 1_000_000;
  return n === previous ? (n + 1) % 1_000_000 : n;
}

/** 经 Surge 代理请求配置 canary 主机：配置已被重新读取 → 经 P0-Canary；否则按后缀规则经 P0-Plain。 */
export async function probeProfileCanary(proxy: ProxyAddress, echoPort: number, index: number): Promise<boolean | null> {
  const r = await proxyGet(proxy, `http://${profileCanaryHost(index)}:${echoPort}/ip?t=pcanary-${index}`);
  const via = (r.json as { via?: string | null } | null)?.via ?? null;
  return via === 'p0-canary' ? true : via === 'p0-plain' ? false : null;
}

/** 经 Surge 代理请求规则集 canary 主机：命中 canary 规则集 → 经 P0-Canary；否则按后缀规则经 P0-Plain。 */
export async function probeCanary(proxy: ProxyAddress, echoPort: number, index: number): Promise<boolean | null> {
  const r = await proxyGet(proxy, `http://${canaryHost(index)}:${echoPort}/ip?t=canary-${index}`);
  const via = (r.json as { via?: string | null } | null)?.via ?? null;
  return via === 'p0-canary' ? true : via === 'p0-plain' ? false : null;
}

/** 经 SFE-ROUTE（测试规则 DOMAIN,chain…）请求回显，返回实际经过的测试节点。 */
export async function requestViaRoute(proxy: ProxyAddress, echoPort: number, testId: string): Promise<{ ok: boolean; via: string | null; throughFront: boolean | null; ms: number }> {
  const r = await proxyGet(proxy, `http://${CHAIN_HOST}:${echoPort}/ip?t=${encodeURIComponent(testId)}`);
  const j = r.json as { via?: string | null; throughFront?: boolean | null } | null;
  return { ok: r.ok, via: j?.via ?? null, throughFront: j?.throughFront ?? null, ms: r.ms };
}

/** Chrome 测试页在时间窗内的上报：回显失败与 WebSocket 断开次数；没有上报时为 null。 */
export function chromeImpact(dir: RunDir, from: number, to: number): { events: number; failures: number; wsCloses: number } | null {
  const events = dir
    .readJsonl<{ app: string; events: Array<{ t?: number; kind?: string; ok?: boolean }> }>(SERVER_LOGS.page)
    .filter((b) => b.app === 'chrome')
    .flatMap((b) => (Array.isArray(b.events) ? b.events : []))
    .filter((e) => typeof e.t === 'number' && e.t >= from && e.t <= to);
  if (events.length === 0) return null;
  return {
    events: events.length,
    failures: events.filter((e) => e.kind === 'echo' && e.ok === false).length,
    wsCloses: events.filter((e) => e.kind === 'ws_close').length,
  };
}

/** 测试页（app）在时间窗内的上报事件。 */
export function pageEvents(dir: RunDir, app: string, from: number, to: number): Array<{ t: number; kind: string; ok: boolean; via?: string | null }> {
  return dir
    .readJsonl<{ app: string; events: Array<{ t?: number; kind?: string; ok?: boolean; via?: string | null }> }>(SERVER_LOGS.page)
    .filter((b) => b.app === app)
    .flatMap((b) => (Array.isArray(b.events) ? b.events : []))
    .filter((e): e is { t: number; kind: string; ok: boolean; via?: string | null } => typeof e.t === 'number' && e.t >= from && e.t <= to && typeof e.kind === 'string')
    .map((e) => ({ t: e.t, kind: e.kind, ok: Boolean(e.ok), via: e.via ?? null }));
}
