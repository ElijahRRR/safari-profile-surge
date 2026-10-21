// 引擎的共享状态与基础工具：依赖、pepper 派生密钥、Surge 事实缓存、能力上下文、入口控制器、
// 操作状态更新与事件发布。处理器、对账器、受理与原生桥都通过它访问这些能力。

import { dirname, resolve } from 'node:path';
import {
  CAPABILITY_KEYS,
  SITES,
  SITE_CODES,
  SfeError,
  VERIFY_ENDPOINTS,
  type ApiErrorBody,
  type CapabilityContext,
  type CapabilityKey,
  type CapabilityView,
  type LoginCodeResponse,
  type OperationPhase,
  type OperationStatus,
  type ServiceEventPayload,
  type VerifyEndpoint,
} from '@sfe/contract';
import type { OperationPatch, OperationRecord, Repositories, SettingValues } from '../db/index.js';
import type {
  Clock,
  EntryController,
  EventBus,
  IdGenerator,
  Logger,
  MaintenanceSurge,
  Scrubber,
  SecretStore,
  SurgeAdapter,
} from '../ports.js';
import { SecretRefManager } from '../secrets/secret-ref-manager.js';
import { loadPepper, pepperKey } from '../secrets/pepper.js';
import { createProfileFiles, type ManagedProfileFiles } from '../surge/files.js';
import { createRulesetStrategy } from '../surge/entry/ruleset-strategy.js';
import { createTempRuleStrategy } from '../surge/entry/temp-rule-strategy.js';
import type { EntryConfig } from '../surge/entry/common.js';
import type { EntryOwnership } from '../surge/entry/ownership.js';
import { parseHttpApiLine } from '../surge/http-adapter.js';
import { classifyDirectoryRisk } from '../util/secure-files.js';
import { emptySurgeFacts, type SurgeFacts } from '../domain/views.js';
import { activationGate, buildCapabilityContext, capabilityViews, missingFrom } from './capabilities.js';
import { createEventBus } from './events.js';
import { createEngineKv, type EngineKv } from './kv.js';
import { createDbEntryOwnership } from './ownership.js';
import { readFile } from 'node:fs/promises';

export interface HostInfo {
  /** sw_vers 构建号；非 macOS 为 'unknown'；读不到为 null。 */
  macosBuild(): Promise<string | null>;
  /** Safari.app Info.plist 版本；非 macOS 为 'unknown'；读不到为 null。 */
  safariVersion(): Promise<string | null>;
  /** 宿主 App 上报的签名身份；未知为 null。 */
  signingIdentity(): string | null;
  /** 进程路径是否存在（能力提议与对账检查）。 */
  processPathExists(path: string): boolean;
}

export interface DemoHooks {
  /** 实测提交后、核对 Surge 请求记录之前：演示模式在 FakeSurge 中模拟 Safari 的检测请求。 */
  beforeVerificationCheck?(ctx: { verifyHost: string; processPaths: readonly string[] }): void | Promise<void>;
}

export interface EnginePaths {
  dataDir: string;
  /** 含秘密的 --check 候选副本（0700），用后即删。 */
  tmpDir: string;
  backupsDir: string;
  homedir: string;
}

export interface AppServiceDeps {
  repos: Repositories;
  clock: Clock;
  ids: IdGenerator;
  logger: Logger;
  scrubber: Scrubber;
  secretStore: SecretStore;
  surge: SurgeAdapter;
  /** 只注入维护处理器（init/remerge）。 */
  maintenanceSurge: MaintenanceSurge;
  paths: EnginePaths;
  surgeCliPath: string | null;
  demo: boolean;
  host?: Partial<HostInfo>;
  events?: EventBus;
  /** 签发网页登录链接（HTTP 未绑定时抛错）。 */
  loginUrl?: () => LoginCodeResponse;
  /** 检测服务清单（默认 contract 中的固定清单）。 */
  verifyEndpoints?: readonly VerifyEndpoint[];
  /** temp_rule 策略的新规则插入位置（P0 实测）；未知时两种位置都必须安全。 */
  tempRuleInsertion?: 'head' | 'tail';
  serviceVersion?: string;
  demoHooks?: DemoHooks;
  /** 动作前短超时对账的超时（毫秒）。 */
  precheckTimeoutMs?: number;
  /** 发布基线检查的最多重试次数。 */
  baselineRetries?: number;
}

export interface EngineKeys {
  pepper: Buffer;
  request: Buffer;
  preview: Buffer;
  file: Buffer;
}

export interface EmitSpec {
  operations?: Iterable<string>;
  environments?: Iterable<string>;
  deletedEnvironments?: Iterable<string>;
  route?: boolean;
  surge?: boolean;
  capabilities?: boolean;
  fronts?: boolean;
  settings?: boolean;
}

/** 由 view-service 注入，避免循环依赖。 */
export interface EventViews {
  build(spec: EmitSpec): ServiceEventPayload[];
}

export class Engine {
  readonly repos: Repositories;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
  readonly scrubber: Scrubber;
  readonly secrets: SecretRefManager;
  readonly store: SecretStore;
  readonly surge: SurgeAdapter;
  readonly maintenanceSurge: MaintenanceSurge;
  readonly events: EventBus;
  readonly kv: EngineKv;
  readonly ownership: EntryOwnership;
  readonly deps: AppServiceDeps;
  readonly host: HostInfo;
  facts: SurgeFacts = emptySurgeFacts();
  hostFacts: { macosBuild: string | null; safariVersion: string | null } = { macosBuild: null, safariVersion: null };
  views: EventViews | null = null;
  private keysCache: EngineKeys | null = null;
  private keysLoading: Promise<EngineKeys> | null = null;

  constructor(deps: AppServiceDeps) {
    this.deps = deps;
    this.repos = deps.repos;
    this.clock = deps.clock;
    this.ids = deps.ids;
    this.logger = deps.logger.child('engine');
    this.scrubber = deps.scrubber;
    this.store = deps.secretStore;
    this.surge = deps.surge;
    this.maintenanceSurge = deps.maintenanceSurge;
    this.secrets = new SecretRefManager(deps.repos, deps.secretStore, deps.ids, deps.clock);
    this.events =
      deps.events ??
      createEventBus({
        meta: deps.repos.meta,
        onListenerError: () => this.logger.log('warn', 'event.listener_failed'),
      });
    this.kv = createEngineKv(deps.repos.db);
    this.ownership = createDbEntryOwnership(deps.repos, this.kv);
    const off = process.platform !== 'darwin';
    this.host = {
      macosBuild: deps.host?.macosBuild ?? (async () => (off ? 'unknown' : null)),
      safariVersion: deps.host?.safariVersion ?? (async () => (off ? 'unknown' : null)),
      signingIdentity: deps.host?.signingIdentity ?? (() => null),
      processPathExists: deps.host?.processPathExists ?? (() => true),
    };
  }

  now(): Date {
    return this.clock.now();
  }

  nowIso(): string {
    return this.clock.now().toISOString();
  }

  // ---------- 密钥 ----------

  /** pepper 派生密钥；读不到 pepper 时 fail closed（SECRET_STORE_FAILED），从不重新生成。 */
  async keys(): Promise<EngineKeys> {
    if (this.keysCache) return this.keysCache;
    if (!this.keysLoading) {
      this.keysLoading = (async () => {
        const pepper = await loadPepper(this.store, this.repos.meta, this.ids);
        const k: EngineKeys = { pepper, request: pepperKey(pepper, 'request'), preview: pepperKey(pepper, 'preview'), file: pepperKey(pepper, 'file') };
        this.keysCache = k;
        return k;
      })().finally(() => {
        this.keysLoading = null;
      });
    }
    return this.keysLoading;
  }

  keysLoaded(): EngineKeys | null {
    return this.keysCache;
  }

  // ---------- 设置与配置 ----------

  settings(): SettingValues {
    return this.repos.settings.getAll();
  }

  verifyEndpoints(): readonly VerifyEndpoint[] {
    return this.deps.verifyEndpoints ?? VERIFY_ENDPOINTS;
  }

  verifyEndpoint(): VerifyEndpoint {
    const list = this.verifyEndpoints();
    const id = this.repos.settings.get('verifyEndpointId');
    return list.find((e) => e.id === id) ?? list[0]!;
  }

  siteHosts(): string[] {
    return SITE_CODES.map((c) => SITES[c].host);
  }

  entryConfig(): EntryConfig {
    return { processPaths: [...this.repos.settings.get('safariProcessPaths')], verifyHost: this.verifyEndpoint().host, siteHosts: this.siteHosts() };
  }

  workingProfile(): { path: string; name: string; directory: string } | null {
    const path = this.repos.settings.get('workingProfilePath');
    if (!path) return null;
    const name = this.repos.settings.get('workingProfileName') ?? path.replace(/^.*\//, '').replace(/\.conf$/, '');
    return { path, name, directory: dirname(path) };
  }

  /** 本应用文件（工作配置目录）；未初始化或 pepper 未加载时为 null。 */
  profileFiles(): ManagedProfileFiles | null {
    const wp = this.workingProfile();
    const keys = this.keysCache;
    if (!wp || !keys) return null;
    return createProfileFiles({ directory: wp.directory, hmacKey: keys.file });
  }

  /** 当前入口策略的控制器；未确认入口策略或缺少进程路径时为 null。 */
  entryController(operationId: () => string | null): EntryController | null {
    const strategy = this.repos.settings.get('entryStrategy');
    const paths = this.repos.settings.get('safariProcessPaths');
    if (strategy === null || paths.length === 0) return null;
    const config = () => this.entryConfig();
    if (strategy === 'temp_rule') {
      const deps = { adapter: this.surge, ownership: this.ownership, config, operationId };
      return createTempRuleStrategy(this.deps.tempRuleInsertion ? { ...deps, insertion: this.deps.tempRuleInsertion } : deps);
    }
    const files = this.profileFiles();
    if (!files) return null;
    return createRulesetStrategy({
      adapter: this.surge,
      files,
      ownership: this.ownership,
      config,
      operationId,
      autoReloadCondition: () => this.autoReloadCondition(),
    });
  }

  /** 自动重载与原子替换能力记录中实测时的自动重载条件；没有已确认记录时为 null（拒绝写入）。 */
  autoReloadCondition(): 'on' | 'off' | 'any' | null {
    const rec = this.repos.capabilities.get('auto_reload_atomic_replace');
    if (!rec || rec.status === 'unverified') return null;
    return rec.context?.autoReload ?? null;
  }

  // ---------- Surge 事实与能力上下文 ----------

  /** 只读 Surge 基础事实（版本、启动时间、当前配置、接管、自动重载）；从不写。 */
  async readBasicFacts(): Promise<SurgeFacts> {
    // 从空事实开始，但清掉“尚未读取”的占位提示：本次读取的结论会重新填写 message。
    const facts: SurgeFacts = {
      ...emptySurgeFacts(),
      message: null,
      precedenceIssues: this.facts.precedenceIssues,
      managedSectionsIntact: this.facts.managedSectionsIntact,
    };
    facts.checkedAt = this.nowIso();
    try {
      const v = await this.surge.getVersion();
      facts.reachable = true;
      facts.version = v.version;
      facts.build = v.build;
    } catch (err) {
      const code = err instanceof SfeError ? err.code : null;
      // 读版本的原语没有可用实现（安装配置未选定命令行工具或 HTTP API）等同于无法连接
      facts.reachable = !(code === 'SURGE_UNREACHABLE' || code === 'CAPABILITY_UNVERIFIED');
      facts.message = facts.reachable ? '读取 Surge 版本失败' : code === 'CAPABILITY_UNVERIFIED' ? '无法连接 Surge：尚未配置可用的命令行工具或 HTTP API' : '无法连接 Surge';
      if (!facts.reachable) {
        this.facts = facts;
        return facts;
      }
    }
    const wp = this.workingProfile();
    try {
      const info = await this.surge.getRuntimeInfo();
      facts.startedAt = info.startedAt ? info.startedAt.toISOString() : null;
    } catch {
      facts.startedAt = null;
    }
    try {
      const p = await this.surge.getCurrentProfile();
      facts.currentProfileName = p.name;
      facts.currentProfilePath = p.path;
      facts.onWorkingProfile = wp ? profileMatches(p, wp) : null;
    } catch {
      facts.onWorkingProfile = null;
    }
    try {
      facts.takeover = await this.surge.getTakeoverState();
    } catch {
      facts.takeover = { enhancedMode: null, systemProxy: null, outboundMode: null, checkedAt: null };
    }
    try {
      facts.autoReload = await this.surge.getAutoReloadSetting();
    } catch {
      facts.autoReload = null;
    }
    if (wp) {
      facts.profileDirectoryRisk = classifyDirectoryRisk(wp.directory, this.deps.paths.homedir);
      try {
        const text = await readFile(wp.path, 'utf8');
        const api = parseHttpApiLine(text);
        facts.httpApi = api ? { configured: true, loopbackOnly: api.loopbackOnly } : { configured: false, loopbackOnly: null };
      } catch {
        facts.httpApi = { configured: false, loopbackOnly: null };
      }
    }
    if (facts.message === null && facts.onWorkingProfile === false) facts.message = 'Surge 当前配置不是固定工作配置';
    this.facts = facts;
    return facts;
  }

  async refreshHostFacts(): Promise<void> {
    try {
      this.hostFacts.macosBuild = await this.host.macosBuild();
    } catch {
      this.hostFacts.macosBuild = null;
    }
    try {
      this.hostFacts.safariVersion = await this.host.safariVersion();
    } catch {
      this.hostFacts.safariVersion = null;
    }
  }

  capabilityContext(): CapabilityContext {
    const s = this.settings();
    return buildCapabilityContext({
      surgeVersion: this.facts.version,
      surgeBuild: this.facts.build,
      macosBuild: this.hostFacts.macosBuild,
      safariVersion: this.hostFacts.safariVersion,
      entryStrategy: s.entryStrategy,
      processPaths: s.safariProcessPaths,
      workingProfilePath: s.workingProfilePath,
      autoReload: this.facts.autoReload,
      takeover: this.facts.takeover,
      signingIdentity: this.host.signingIdentity(),
      mechanism: this.surge.mechanism(),
    });
  }

  capabilityViews(): CapabilityView[] {
    return capabilityViews(this.repos.capabilities.list(), this.capabilityContext());
  }

  missing(keys: readonly CapabilityKey[]): CapabilityKey[] {
    return missingFrom(this.capabilityViews(), keys);
  }

  /** 激活门槛缺失项；入口策略或进程路径尚未由已确认的提议设置时，对应能力也算缺失。 */
  activationMissing(views: readonly CapabilityView[] = this.capabilityViews()): CapabilityKey[] {
    const strategy = this.repos.settings.get('entryStrategy');
    const miss = missingFrom(views, activationGate(strategy));
    if (strategy === null && !miss.includes('runtime_entry_modes')) miss.push('runtime_entry_modes');
    if (this.repos.settings.get('safariProcessPaths').length === 0 && !miss.includes('safari_process_attribution')) miss.push('safari_process_attribution');
    return miss;
  }

  /** 门槛不满足时抛 CAPABILITY_UNVERIFIED（details.missing 列出缺失项与过期原因）。 */
  requireCapabilities(keys: readonly CapabilityKey[], action: string): void {
    const views = this.capabilityViews();
    const miss = missingFrom(views, keys);
    if (miss.length === 0) return;
    throw capabilityError(views, miss, action);
  }

  // ---------- 操作 ----------

  /** 更新操作并（可选）追加步骤；提交后发布操作与相关环境事件。 */
  updateOp(
    opId: string,
    patch: OperationPatch & { phase?: OperationPhase; status?: OperationStatus },
    step?: string,
    emit: EmitSpec = {},
  ): OperationRecord {
    const op = this.repos.tx(() => {
      this.repos.operations.update(opId, patch);
      const cur = this.repos.operations.get(opId)!;
      if (step) this.repos.operations.appendStep(opId, cur.phase, step);
      return cur;
    });
    const envs = new Set(emit.environments ?? []);
    if (op.environmentId) envs.add(op.environmentId);
    this.emit({ ...emit, operations: [opId, ...(emit.operations ?? [])], environments: envs });
    this.logger.log(op.status === 'failed' || op.status === 'needs_attention' ? 'warn' : 'info', 'operation.updated', {
      operationId: op.id,
      kind: op.kind,
      phase: op.phase,
      status: op.status,
      errorCode: op.error?.code,
    });
    return op;
  }

  step(opId: string, message: string, emit = true): void {
    const op = this.repos.operations.get(opId);
    if (!op) return;
    this.repos.operations.appendStep(opId, op.phase, message);
    if (emit) this.emit({ operations: [opId] });
  }

  errorBody(err: unknown, fallback = '执行失败：内部错误'): ApiErrorBody {
    if (err instanceof SfeError) {
      const body = err.toBody();
      return this.scrubber.scrubDeep({ ...body, message: this.scrubber.scrub(body.message) });
    }
    return { code: 'INTERNAL', message: fallback };
  }

  emit(spec: EmitSpec): void {
    if (!this.views) return;
    let events: ServiceEventPayload[];
    try {
      events = this.views.build(spec);
    } catch (err) {
      this.logger.log('error', 'event.build_failed', { error: err instanceof Error ? err.name : 'unknown' });
      return;
    }
    for (const e of events) this.events.publish(e);
  }

  log(level: 'debug' | 'info' | 'warn' | 'error', msg: string, fields?: Record<string, unknown>): void {
    this.logger.log(level, msg, fields);
  }
}

export function profileMatches(p: { name: string; path: string | null }, wp: { path: string; name: string }): boolean {
  if (p.path) return resolve(p.path) === resolve(wp.path);
  return p.name === wp.name;
}

export function capabilityError(views: readonly CapabilityView[], miss: readonly CapabilityKey[], action: string): SfeError {
  const items = views.filter((v) => miss.includes(v.key));
  const labels = items.map((v) => v.label).join('、');
  return new SfeError('CAPABILITY_UNVERIFIED', `${action}失败：${labels}尚未通过实测`, {
    details: { missing: items.map((v) => ({ key: v.key, staleReasons: v.staleReasons })) },
  });
}

export const ALL_CAPABILITY_KEYS: readonly CapabilityKey[] = CAPABILITY_KEYS;
