// 回环测试资源（D10）的公共操作：识别测试资源（位置摘要等于测试地址摘要、policy-group、不是本地、不来自模块，恰好一个）、
// 产品的 key 安全检查（resourceUpdateRoute：key 可能含读取令牌时只能经 HTTP）、经状态文件让 resource-server 提供某一代并
// 等它应用、等待 Surge 结束更新，以及与产品相同的发布与读回：
// - publishGeneration：发布前严格校验 → 暂存候选（resource_generation_served）→ 恰好一次单 key 更新（从不 update all，结果不明
//   时从不重放）→ 等 updating 结束、稳定延时后读两次 → assessResourceReadback（与产品同一规则：错误为空、成员 REJECT 在首位且
//   与期望相同、选择不变、更新时间对应本服务记下的一次完整的 200、可读时逐个核对节点参数）→ 通过才提交
//   （node_publication_verified，detail.resource 'loopback'）；否则撤回候选，Surge 可能已持有候选时再执行一次更新并按已提交
//   版本读回；
// - confirmCommitted：重新提供已提交版本，一次单 key 更新并读回（恢复与重启后的核对）。
// 退出码 0、success、downloaded 与 ready=true 都只是必要条件，结论只看读回。

import { EMPTY_PLACEHOLDER_NODE, ROUTE_GROUP_NAME } from '@sfe/contract';
import { RESOURCE_UPDATE_WAIT } from '../constants.js';
import {
  DEFAULT_RESOURCE_AUDIT_TOLERANCE_MS,
  RESOURCE_MAX_BYTES,
  assessResourceReadback,
  canUseCliForResourceKey,
  parseProxyLine,
  resourceBody,
  resourceUpdateRoute,
  type ResourceNodeDetail,
  type ResourceReadbackAssessment,
  type ResourceReadbackDetails,
  type ResourceSnapshot,
  type SurgeExternalResource,
} from '../deps.js';
import { refused } from '../errors.js';
import {
  auditMarkOf,
  readAuditRecords,
  readServed,
  readServerStatus,
  requestsBetween,
  serverRunning,
  testResourceUrl,
  updateServed,
  type ResourceScenario,
  type ResourceServedFile,
  type ResourceServerStatus,
  type ServedGeneration,
} from '../loopback-state.js';
import type { ProxyAddress } from '../http-client.js';
import { readResourceToken } from '../loopback-state.js';
import type { ServersInfo } from '../state.js';
import { resourcesForUrl } from '../surge-access.js';
import { TEST_PROFILE_FILE, routeLineState, type TestPorts } from '../test-profile.js';
import { loadCredentials, openRun, openSession, proxyOf, requireServers, tryRead, type Ctx, type Session, type TestCredentials } from './common.js';
import { TestOps, type UpdateRecord } from './test-ops.js';

const RESERVED_NAMES = new Set(['REJECT', 'DIRECT', ROUTE_GROUP_NAME, EMPTY_PLACEHOLDER_NODE].map((n) => n.toUpperCase()));

/**
 * 发布前的严格校验（与产品的发布前校验同一原则，适用于测试节点）：每行能解析为“名称 = 类型, 服务器, 端口, …”、名称合法且
 * 不重复（含大小写不同的重复）、不是 REJECT/DIRECT/SFE-ROUTE/SFE-EMPTY、显式写出 underlying-proxy、不以“[”开头；整份内容不超过
 * 1 MiB。返回错误说明（不含行内容）；为空即通过。dupC（只差用户名的重名）在这里被拒绝——读回无法区分它。
 */
export function validateGenerationLines(lines: readonly string[]): string[] {
  const errors: string[] = [];
  const names = new Set<string>();
  lines.forEach((line, i) => {
    const at = `第 ${i + 1} 行`;
    if (typeof line !== 'string' || /[\r\n\0]/.test(line)) return void errors.push(`${at}含换行`);
    if (line.trim().startsWith('[')) return void errors.push(`${at}以“[”开头`);
    const p = parseProxyLine(line);
    if (!p || p.name === '' || /[,=]/.test(p.name)) return void errors.push(`${at}无法解析为节点`);
    if (RESERVED_NAMES.has(p.name.toUpperCase())) errors.push(`${at}使用了保留名称`);
    if (names.has(p.name.toUpperCase())) errors.push(`${at}与之前的节点重名`);
    names.add(p.name.toUpperCase());
    if (p.server === null || p.port === null) errors.push(`${at}缺少服务器或端口`);
    if (!p.params['underlying-proxy']) errors.push(`${at}没有显式的前置（underlying-proxy）`);
  });
  if (errors.length === 0 && Buffer.byteLength(resourceBody(0, lines), 'utf8') > RESOURCE_MAX_BYTES) errors.push('内容超过 1 MiB');
  return errors;
}

/** 节点行中的名称（按顺序；无法解析的行跳过）。 */
export function namesOf(lines: readonly string[]): string[] {
  return lines.map((l) => parseProxyLine(l)?.name ?? null).filter((n): n is string => n !== null && n !== '');
}

/** 一代内容中的节点行（去掉注释与空行）与名称；只有占位行时名称为空。 */
export function generationLines(content: string): { lines: string[]; names: string[] } {
  const lines = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#') && !l.startsWith('//') && !l.startsWith(';'));
  const nodes = lines.filter((l) => parseProxyLine(l)?.name !== EMPTY_PLACEHOLDER_NODE);
  return { lines: nodes, names: namesOf(nodes) };
}

/** 资源 key 的形式判定（只记判定，不记 key 本身）。 */
export interface KeyForm {
  length: number;
  hex32: boolean;
  hasSlash: boolean;
  hasColon: boolean;
  hasPercent: boolean;
  containsToken: boolean;
  partOfToken: boolean;
  /** 产品的 CLI 安全条件（canUseCliForResourceKey）。 */
  cliSafe: boolean;
}

export function describeKeyForm(key: string, token: string): KeyForm {
  return {
    length: key.length,
    hex32: /^[0-9a-f]{32}$/.test(key),
    hasSlash: key.includes('/'),
    hasColon: key.includes(':'),
    hasPercent: key.includes('%'),
    containsToken: key.includes(token),
    partOfToken: key.length > 0 && token.includes(key),
    cliSafe: canUseCliForResourceKey(key, token),
  };
}

export function keyFormText(f: KeyForm): string {
  return `长度 ${f.length}，${f.hex32 ? '32 位小写十六进制' : '不是 32 位小写十六进制'}${f.hasSlash ? '，含 /' : ''}${f.hasColon ? '，含 :' : ''}${f.hasPercent ? '，含 %' : ''}${f.containsToken ? '，含读取令牌' : ''}${f.partOfToken ? '，是读取令牌的一段' : ''}；${f.cliSafe ? '可以经 CLI 更新' : '只能经 HTTP 更新'}`;
}

/** 测试资源在 Surge 中的识别结果。 */
export type Discovery =
  | { kind: 'found'; resource: SurgeExternalResource }
  | { kind: 'missing' }
  | { kind: 'ambiguous'; count: number }
  | { kind: 'unexpected'; why: string }
  | { kind: 'unreadable' };

export function discoverIn(resources: readonly SurgeExternalResource[] | null, url: string): Discovery {
  if (resources === null) return { kind: 'unreadable' };
  const ours = resourcesForUrl(resources, url);
  if (ours.length === 0) return { kind: 'missing' };
  if (ours.length > 1) return { kind: 'ambiguous', count: ours.length };
  const r = ours[0]!;
  if (r.type !== 'policy-group') return { kind: 'unexpected', why: `类型为 ${r.type.slice(0, 20)}` };
  if (r.local !== false) return { kind: 'unexpected', why: r.local === true ? '被报告为本地资源' : '没有报告是否本地' };
  if (r.fromModule !== null) return { kind: 'unexpected', why: '来自模块' };
  return { kind: 'found', resource: r };
}

export function discoveryText(d: Discovery): string {
  switch (d.kind) {
    case 'found':
      return '恰好一个外部资源指向测试资源地址（policy-group、不是本地、来自配置）';
    case 'missing':
      return 'Surge 中没有指向测试资源地址的外部资源';
    case 'ambiguous':
      return `有 ${d.count} 个外部资源指向测试资源地址`;
    case 'unexpected':
      return `指向测试资源地址的外部资源不符合预期：${d.why}`;
    case 'unreadable':
      return '读不到外部资源列表';
  }
}

export interface PublishOptions {
  label: string;
  /**
   * 子集模式：读回的成员（REJECT 之外）只要包含 required、其余都是这一代提供的节点即可（Surge 可能跳过某些节点：前置缺失、
   * 凭据字符）；缺省要求成员恰好是这一代的全部节点。
   */
  required?: readonly string[];
  /** 发布前严格校验（缺省开）。只有 charset 关闭它：它刻意提供产品校验会拒绝的字符。 */
  prevalidate?: boolean;
}

export interface ReadbackRun {
  update: UpdateRecord;
  /** 读回时 Surge 仍在更新（到时限）：没有读回，也不再更新。 */
  stillUpdating: boolean;
  before: ResourceSnapshot;
  after: ResourceSnapshot | null;
  afterRepeat: ResourceSnapshot | null;
  assessment: ResourceReadbackAssessment;
  /** 这一窗口内测试资源服务记下的请求（Surge 的下载与重试）。 */
  requests: number;
}

export interface PublishOutcome extends ReadbackRun {
  generation: number;
  committed: boolean;
  rollback: { attempted: boolean; confirmed: boolean | null; failed: string[] } | null;
}

const NOT_READ: ResourceReadbackAssessment = { ok: false, level: 'partial', failed: ['resource_updating'] };
const NOT_RUN: UpdateRecord = { ok: false, ms: 0, code: 'NOT_RUN', result: null, reason: 'still_updating' };

export class Loopback {
  /** 已通过 key 安全检查并登记到写入守卫的测试资源 key（只在内存中）。 */
  private key: string | null = null;

  constructor(
    readonly ops: TestOps,
    readonly port: number,
    readonly token: string,
  ) {
    ops.session.guard.secrets.add(token);
  }

  get url(): string {
    return testResourceUrl(this.port, this.token);
  }

  private get adapter() {
    return this.ops.session.adapter;
  }

  private now(): Date {
    return this.ops.ctx.deps.now();
  }

  // ---------- resource-server ----------

  serverStatus(): ResourceServerStatus | null {
    return readServerStatus(this.ops.dir);
  }

  /** resource-server 在本运行、同一端口运行（listening 时还要在监听）。 */
  requireServer(opts: { listening?: boolean } = {}): ResourceServerStatus {
    const s = this.serverStatus();
    if (!serverRunning(s)) throw refused('前置条件不满足：测试资源服务没有在运行（在另一个终端运行 resource-server，并保持运行）');
    if (s.port !== this.port) throw refused(`前置条件不满足：测试资源服务在端口 ${s.port} 运行，测试配置使用端口 ${this.port}`);
    if ((opts.listening ?? true) && !s.listening) throw refused('前置条件不满足：测试资源服务没有在监听（场景为 stop，或端口被占用）');
    return s;
  }

  served(): ResourceServedFile | null {
    return readServed(this.ops.dir);
  }

  /** 写状态文件并等 resource-server 应用（有界）；等不到即拒绝（之后的步骤没有意义）。 */
  async setServed(change: (s: ResourceServedFile) => Partial<ResourceServedFile>): Promise<ResourceServedFile> {
    const next = updateServed(this.ops.dir, this.now(), this.ops.ctx.args.command, change);
    for (let i = 0; i < 100; i++) {
      const s = this.serverStatus();
      if (serverRunning(s) && s.appliedRevision >= next.revision) return next;
      await this.ops.ctx.deps.sleep(50);
    }
    throw refused('测试资源服务没有在 5 秒内应用新的状态（resource-server 是否仍在运行？）');
  }

  /** 切换场景（保留提供的内容）。 */
  setScenario(scenario: ResourceScenario): Promise<ResourceServedFile> {
    return this.setServed(() => ({ scenario }));
  }

  committed(): ServedGeneration | null {
    return this.served()?.committed ?? null;
  }

  /** 提交一代内容而不经 Surge（只在接入之前用：Surge 第一次加载时下载它）。 */
  async commitInitial(lines: readonly string[]): Promise<ServedGeneration> {
    const s = this.served();
    const generation = (s?.lastGeneration ?? 0) + 1;
    const g = { generation, content: resourceBody(generation, lines) };
    await this.setServed(() => ({ committed: g, candidate: null, scenario: 'ok' }));
    return g;
  }

  // ---------- Surge ----------

  async discover(): Promise<Discovery> {
    return discoverIn(await tryRead(() => this.adapter.listExternalResources()), this.url);
  }

  /** 识别测试资源并通过产品的 key 安全检查后登记 key；任一不满足即拒绝。 */
  async ensureKey(): Promise<string> {
    if (this.key !== null) return this.key;
    const d = await this.discover();
    if (d.kind !== 'found') throw refused(`前置条件不满足：${discoveryText(d)}（先运行 loopback --setup 并手动重新加载测试配置）`);
    const key = d.resource.key;
    const route = resourceUpdateRoute(this.ops.session.mechanism, key, this.token);
    if (route.kind === 'park') throw refused(`前置条件不满足：${route.message}`);
    this.ops.session.guard.refreshableKeys.add(key);
    this.key = key;
    return key;
  }

  keyForm(): KeyForm | null {
    return this.key === null ? null : describeKeyForm(this.key, this.token);
  }

  /** 测试资源与 SFE-ROUTE 的状态（与产品读回同一形状；找不到测试资源时 key 为空串）。 */
  async snapshot(): Promise<ResourceSnapshot> {
    const list = await tryRead(() => this.adapter.listExternalResources());
    const d = discoverIn(list, this.url);
    const r = d.kind === 'found' ? d.resource : null;
    return {
      key: r?.key ?? '',
      locationHash: r?.locationHash ?? null,
      updatedAt: r?.lastUpdatedAt ?? null,
      error: r ? r.error : 'unreadable',
      updating: r?.updating ?? null,
      members: await tryRead(() => this.adapter.getGroupMembers(ROUTE_GROUP_NAME)),
      selection: await tryRead(() => this.adapter.getGroupSelection(ROUTE_GROUP_NAME)),
    };
  }

  /** 等 Surge 不再报告 updating（有界）。 */
  async waitNotUpdating(timeoutMs: number = RESOURCE_UPDATE_WAIT.timeoutMs): Promise<{ ok: boolean; snapshot: ResourceSnapshot | null }> {
    const w = await this.ops.poll(() => this.snapshot(), (s) => s.updating !== true, timeoutMs, RESOURCE_UPDATE_WAIT.pollMs);
    return { ok: w.ok, snapshot: w.value };
  }

  /** 对测试资源恰好一次单 key 更新（产品的 key 安全检查已在 ensureKey 完成）。 */
  async update(label: string, detail: Record<string, unknown> = {}): Promise<UpdateRecord> {
    const key = await this.ensureKey();
    return this.ops.recordUpdate(key, label, { resource: 'loopback', ...detail });
  }

  /** 可读时逐个读节点参数（getPolicyDetail）；未映射为 null（读回最多 partial）。 */
  async details(lines: readonly string[]): Promise<ResourceReadbackDetails | null> {
    if (this.ops.session.mechanism.getPolicyDetail === 'unavailable') return null;
    const expected = new Map<string, ResourceNodeDetail>();
    const actual = new Map<string, ResourceNodeDetail | null>();
    for (const line of lines) {
      const p = parseProxyLine(line);
      if (!p) continue;
      expected.set(p.name, { server: p.server, port: p.port, underlyingProxy: p.params['underlying-proxy'] ?? null });
      const d = await tryRead(() => this.adapter.getPolicyDetail(p.name));
      actual.set(p.name, d ? { server: d.server, port: d.port, underlyingProxy: d.underlyingProxy } : null);
    }
    return { expected, actual };
  }

  /**
   * 一次单 key 更新与读回：等 updating 结束（到时限仍在更新：不读回、不再更新）、稳定延时后读两次，按 expected 与本服务的
   * 审计记录（序号不小于 mark、代为 generation）核对。
   */
  async updateAndRead(input: {
    label: string;
    before: ResourceSnapshot;
    mark: number;
    generation: number;
    expect: (members: readonly string[] | null) => { names: string[]; lines: string[] };
    detail?: Record<string, unknown>;
    /** 已经发出的更新（例如 loopback-crash 在更新进行中做别的事）；缺省这里发出。 */
    update?: Promise<UpdateRecord>;
  }): Promise<ReadbackRun> {
    const t0 = this.now().getTime();
    const update = await (input.update ?? this.update(input.label, { generation: input.generation, ...input.detail }));
    const wait = await this.waitNotUpdating();
    const requests = (): number => requestsBetween(this.ops.dir, t0 - 1000, this.now().getTime() + 1000, 'server').length;
    if (!wait.ok) return { update, stillUpdating: true, before: input.before, after: wait.snapshot, afterRepeat: null, assessment: NOT_READ, requests: requests() };
    await this.ops.ctx.deps.sleep(RESOURCE_UPDATE_WAIT.settleMs);
    const after = await this.snapshot();
    await this.ops.ctx.deps.sleep(RESOURCE_UPDATE_WAIT.settleMs);
    const afterRepeat = await this.snapshot();
    const expected = input.expect(after.members);
    const assessment = assessResourceReadback({
      url: this.url,
      before: input.before,
      after,
      afterRepeat,
      expectedMembers: expected.names,
      selectionBefore: input.before.selection,
      records: readAuditRecords(this.ops.dir),
      mark: input.mark,
      expectedGeneration: input.generation,
      toleranceMs: DEFAULT_RESOURCE_AUDIT_TOLERANCE_MS,
      details: await this.details(expected.lines),
    });
    return { update, stillUpdating: false, before: input.before, after, afterRepeat, assessment, requests: requests() };
  }

  /** 发布一代测试节点（见文件头）。发布前严格校验不通过、Surge 仍在更新时拒绝（什么也没有提供）。 */
  async publishGeneration(lines: readonly string[], opts: PublishOptions): Promise<PublishOutcome> {
    if (opts.prevalidate !== false) {
      const errors = validateGenerationLines(lines);
      if (errors.length > 0) throw refused(`发布测试节点失败：发布前校验未通过（${errors.join('；')}）`);
    }
    this.requireServer();
    await this.ensureKey();
    const idle = await this.waitNotUpdating();
    if (!idle.ok) throw refused('发布测试节点失败：Surge 仍在更新测试资源，没有提供新版本');
    const committedBefore = this.committed();
    if (committedBefore === null) throw refused('发布测试节点失败：测试资源服务还没有已提交的版本（先运行 loopback --setup）');
    const before = await this.snapshot();
    const servedNames = namesOf(lines);
    const generation = (this.served()?.lastGeneration ?? 0) + 1;
    const mark = auditMarkOf(this.ops.dir);
    await this.setServed(() => ({ candidate: { generation, content: resourceBody(generation, lines) } }));
    this.ops.action('resource_generation_served', { resource: 'loopback', generation, label: opts.label });
    const expect = (members: readonly string[] | null): { names: string[]; lines: string[] } => {
      const names = expectedNames(servedNames, opts.required, members);
      return { names, lines: lines.filter((l) => names.includes(parseProxyLine(l)?.name ?? '')) };
    };
    let run: ReadbackRun;
    try {
      run = await this.updateAndRead({ label: opts.label, before, mark, generation, expect });
    } catch (e) {
      // 更新之前就失败（例如写入守卫）：撤回候选，什么也没有发生
      await this.setServed(() => ({ candidate: null }));
      throw e;
    }
    if (run.assessment.ok) {
      // 资源服务在发布中途重启（与产品启动相同，候选被丢弃）：不提交，如实报告
      if (this.served()?.candidate?.generation !== generation) {
        throw refused('发布测试节点失败：测试资源服务在发布中途重启，候选版本已不在（没有提交）；Surge 可能持有这一版：确认 resource-server 在运行后重新运行本命令，它的恢复步骤会重新提供已提交版本并读回');
      }
      await this.setServed((s) => ({ committed: s.candidate, candidate: null }));
      this.ops.action('node_publication_verified', { resource: 'loopback', generation, level: run.assessment.level, label: opts.label });
      return { ...run, generation, committed: true, rollback: null };
    }
    // 撤回：重新提供已提交版本。Surge 可能已持有候选（更新报告已下载、有这一代的记录、更新时间或成员变了）时，再执行一次更新并
    // 按已提交版本读回；仍在更新时不再更新（结果不明，从不重放）。
    await this.setServed(() => ({ candidate: null }));
    const records = readAuditRecords(this.ops.dir);
    const held =
      run.update.result?.outcome === 'downloaded' ||
      records.some((r) => r.generation === generation && r.seq >= mark) ||
      (run.after !== null && (run.after.updatedAt?.getTime() ?? null) !== (before.updatedAt?.getTime() ?? null)) ||
      (run.after !== null && JSON.stringify(run.after.members) !== JSON.stringify(before.members));
    let rollback: PublishOutcome['rollback'] = { attempted: false, confirmed: null, failed: [] };
    if (run.stillUpdating) {
      rollback = { attempted: false, confirmed: null, failed: ['resource_updating'] };
    } else if (held) {
      const c = await this.confirmCommitted(`${opts.label}-rollback`);
      rollback = { attempted: true, confirmed: c.assessment.ok, failed: c.assessment.failed };
    } else {
      const now = await this.snapshot();
      const same = JSON.stringify(now.members) === JSON.stringify(before.members) && now.error === before.error;
      rollback = { attempted: false, confirmed: same, failed: same ? [] : ['members'] };
    }
    // 选择变了（例如选中的节点被跳过而回落到 REJECT）：只改回之前的选择，而且它必须仍是成员（从不改选其他节点）
    const sel = await tryRead(() => this.adapter.getGroupSelection(ROUTE_GROUP_NAME));
    const members = await tryRead(() => this.adapter.getGroupMembers(ROUTE_GROUP_NAME));
    if (before.selection !== null && sel !== before.selection && members?.includes(before.selection)) await this.ops.select(before.selection).catch(() => undefined);
    return { ...run, generation, committed: false, rollback };
  }

  /** 重新提供已提交版本，一次单 key 更新并按它读回（恢复、重启后的核对）。 */
  async confirmCommitted(label: string): Promise<ReadbackRun & { generation: number }> {
    const c = this.committed();
    if (c === null) throw refused('核对已提交版本失败：测试资源服务没有已提交的版本');
    if (this.served()?.candidate) await this.setServed(() => ({ candidate: null }));
    await this.ensureKey();
    const idle = await this.waitNotUpdating();
    const before = idle.snapshot ?? (await this.snapshot());
    // 仍在更新：不再更新（产品从不在更新进行中再次更新），如实报告
    if (!idle.ok) return { update: NOT_RUN, stillUpdating: true, before, after: idle.snapshot, afterRepeat: null, assessment: NOT_READ, requests: 0, generation: c.generation };
    const { lines, names } = generationLines(c.content);
    const mark = auditMarkOf(this.ops.dir);
    const run = await this.updateAndRead({ label, before, mark, generation: c.generation, expect: () => ({ names, lines }), detail: { committed: true } });
    return { ...run, generation: c.generation };
  }
}

/** 子集模式下读回应当等于的成员（见 PublishOptions.required）；条件不满足时返回这一代的全部节点（读回因此失败）。 */
export function expectedNames(served: readonly string[], required: readonly string[] | undefined, members: readonly string[] | null): string[] {
  if (required === undefined || members === null) return [...served];
  const rest = members.slice(1);
  const ok = required.every((n) => rest.includes(n)) && rest.every((n) => served.includes(n));
  return ok ? rest : [...served];
}

/** 读回失败代码的说明（只写分类）。 */
export function readbackText(a: ResourceReadbackAssessment): string {
  if (a.ok) return a.level === 'full' ? '读回一致（含节点参数）' : '读回一致（节点参数读不到：partial）';
  return `读回不一致：${a.failed.join('、')}`;
}

/** Surge 资源错误的分类（只写分类，不写原文：原文可能含地址）。 */
export function errorClass(error: string | null): string {
  if (error === null) return '无错误';
  if (error === 'not_ready') return '未就绪';
  if (error === 'unreadable') return '读不到';
  if (/-1004|无法连接/.test(error)) return '无法连接（-1004）';
  if (/-1001|超时|timed out/i.test(error)) return '超时（-1001）';
  if (/-1005|连接已中断|connection was lost/i.test(error)) return '连接中断（-1005）';
  const m = /异常状态码[:：]\s*(\d{3})/.exec(error) ?? /\b(\d{3})\b/.exec(error);
  if (/异常状态码/.test(error) && m) return `HTTP ${m[1]}`;
  if (/未返回任何数据/.test(error)) return '空内容';
  if (/Failed to parse/i.test(error)) return '无法解析';
  return '其他错误';
}

export interface OpenedLoopback {
  dir: import('../run-dir.js').RunDir;
  session: Session;
  ops: TestOps;
  lb: Loopback;
  servers: ServersInfo;
  creds: TestCredentials;
  ports: TestPorts;
  proxy: ProxyAddress;
}

/**
 * 回环命令共用的前置条件：test-servers 在运行、合成测试凭据、当前是测试配置、resource-server 在本运行同一端口运行并监听、
 * 读取令牌在运行目录中；requireSetup 时测试配置的 SFE-ROUTE 行必须正是测试资源地址（loopback --setup 之后）。
 */
export async function openLoopback(ctx: Ctx, opts: { requireSetup: boolean; listening?: boolean }): Promise<OpenedLoopback> {
  const { dir, state } = openRun(ctx);
  const servers = await requireServers(ctx, state);
  const creds = loadCredentials(dir);
  if (!creds) throw refused('前置条件不满足：缺少合成测试凭据，请先运行 test-servers');
  const token = readResourceToken(dir);
  if (token === null) throw refused('前置条件不满足：还没有测试资源的读取令牌，请在另一个终端运行 resource-server');
  const status = readServerStatus(dir);
  const port = state.loopback?.port ?? status?.port ?? null;
  if (port === null) throw refused('前置条件不满足：测试资源服务没有在运行（在另一个终端运行 resource-server）');
  const session = await openSession(ctx, dir, state, { needTestProfile: true });
  for (const p of ['listExternalResources', 'getGroupMembers', 'getGroupSelection', 'updateExternalResource'] as const) {
    if (session.mechanism[p] === 'unavailable') throw refused(`前置条件不满足：原语 ${p} 没有可用实现`);
  }
  const ops = new TestOps(ctx, dir, session, state);
  const lb = new Loopback(ops, port, token);
  if (opts.listening !== false) lb.requireServer({ listening: opts.listening ?? true });
  if (opts.requireSetup) {
    const text = await ops.files.read(TEST_PROFILE_FILE);
    if (text === null) throw refused('前置条件不满足：测试配置不存在');
    const line = routeLineState(text);
    if (line.kind !== 'loopback' || line.url !== lb.url) {
      throw refused('前置条件不满足：测试配置的 SFE-ROUTE 还没有指向本运行的测试资源（先运行 loopback --setup，并在 Surge 中手动重新加载一次）');
    }
  }
  const ports: TestPorts = { echo: servers.echoPort, exit: servers.exitPort, front: servers.frontPort, deadFront: servers.deadFrontPort };
  return { dir, session, ops, lb, servers, creds, ports, proxy: proxyOf(ctx) };
}
