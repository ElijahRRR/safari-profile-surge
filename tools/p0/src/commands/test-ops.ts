// 测试配置上的受控写入：只写本工具创建并登记过摘要的测试文件（摘要不符即拒绝，视为外部修改）、
// 只刷新这些文件对应的 key、只选择 SFE-ROUTE。每个写入都记入动作时间线（continuity 据此标注）。

import { ROUTE_GROUP_NAME } from '@sfe/contract';
import type { ReloadSignals } from '../analysis/reload.js';
import { SERVER_LOGS } from '../constants.js';
import { createProfileFiles } from '../deps.js';
import { refused } from '../errors.js';
import { proxyGet, type ProxyAddress } from '../http-client.js';
import { logAction } from '../results.js';
import type { RunDir } from '../run-dir.js';
import { createdFile, saveState, upsertCreatedFile, type RunState } from '../state.js';
import { surgeStartFingerprint } from '../system.js';
import { CANARY_FILE, CHAIN_HOST, canaryContent, canaryHost } from '../test-profile.js';
import { tryRead, type Ctx, type Session } from './common.js';

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

  async refresh(key: string, label: string): Promise<{ ok: boolean; ms: number; code: string | null }> {
    const t0 = Date.now();
    this.action('resource_refresh', { key, label });
    try {
      await this.session.adapter.updateExternalResource(key);
      return { ok: true, ms: Date.now() - t0, code: null };
    } catch (e) {
      return { ok: false, ms: Date.now() - t0, code: (e as { code?: string }).code ?? 'ERROR' };
    }
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

  async armCanary(index: number): Promise<void> {
    await this.writeTestFile(CANARY_FILE, canaryContent(index));
    this.action('canary_armed', { index });
  }

  async signals(proxy: ProxyAddress, echoPort: number, canaryIndex: number | null): Promise<ReloadSignals> {
    const a = this.session.adapter;
    return {
      at: this.now(),
      canaryLoaded: canaryIndex === null ? null : await probeCanary(proxy, echoPort, canaryIndex),
      surgeStart: await surgeStartFingerprint(this.ctx.deps.exec),
      tempRules: await tryRead(() => a.listTempRules()),
      profileName: (await tryRead(() => a.getCurrentProfile()))?.name ?? null,
    };
  }
}

/** 经 Surge 代理请求 canary 主机：命中 canary 规则集 → 经 P0-Canary；否则按后缀规则经 P0-Plain。 */
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
