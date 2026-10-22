// 引擎的共享状态与基础工具：依赖、pepper 派生密钥、Surge 事实缓存、能力上下文、入口控制器、
// 操作状态更新与事件发布。处理器、对账器、受理与原生桥都通过它访问这些能力。

import { dirname, resolve } from 'node:path';
import {
  CAPABILITY_CONTEXT_DEPS,
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
  SurgeVersion,
} from '../ports.js';
import { SecretRefManager } from '../secrets/secret-ref-manager.js';
import { loadPepper, pepperKey } from '../secrets/pepper.js';
import { createProfileFiles, type ManagedProfileFiles } from '../surge/files.js';
import { createRulesetStrategy } from '../surge/entry/ruleset-strategy.js';
import { createTempRuleStrategy } from '../surge/entry/temp-rule-strategy.js';
import type { EntryConfig } from '../surge/entry/common.js';
import type { EntryOwnership } from '../surge/entry/ownership.js';
import { parseHttpApiLine } from '../surge/http-adapter.js';
import { SURGE_BUILD_RE, SURGE_VERSION_RE } from '../surge/capability-gate.js';
import { isUnsupportedCommandError } from '../surge/cli-adapter.js';
import {
  RUNNING_INSTANCE_FAILURE_TEXT,
  SERVICE_INSTANCE_READ_BUDGET_MS,
  SURGE_VERSION_CHECK_FAILURE_TEXT,
  crossCheckSurgeVersion,
  isRunningInstanceFailure,
  meetsSurgeMinimumVersion,
  type RunningInstanceResult,
} from '../surge/running-instance.js';
import type { SurgePrimitive } from '../surge/primitives.js';
import { classifyDirectoryRisk } from '../util/secure-files.js';
import { emptySurgeFacts, type SurgeFacts, type SurgeVersionIssue } from '../domain/views.js';
import { activationGate, buildCapabilityContext, capabilityViews, missingFrom } from './capabilities.js';
import { createEventBus } from './events.js';
import { createEngineKv, type EngineKv } from './kv.js';
import { createDbEntryOwnership } from './ownership.js';
import { readFile } from 'node:fs/promises';

// ---------- Surge 可达性（docs/ARCHITECTURE.md §5.2、§6.6） ----------

/**
 * 可达性检测使用的只读原语，按顺序取第一个已映射到 cli、http 或 fake 的。选择在引擎创建时静态完成，从不按成败
 * 换用另一个。getVersion 不用于可达性：它只是版本的旁证（与运行实例交叉核对，见 readVersion），版本读不到不等于
 * 无法连接。原语只有在 P0 实测读取成功后才会被映射；只配置 HTTP API 时落到 getCurrentProfile 或 listPolicies。
 * 不含 listTempRules：`--raw dump temp-rule` 的空输出就是“没有临时规则”，与 Surge 未运行时可能的空输出无法区分，
 * 不能证明连接（HTTP 实现也没有它）。TODO(P0)：V7 记录 Surge 未运行时的输出后再评估。
 */
export const LIVENESS_PRIMITIVES = ['listExternalResources', 'getCurrentProfile', 'listPolicies'] as const satisfies readonly SurgePrimitive[];
export type LivenessPrimitive = (typeof LIVENESS_PRIMITIVES)[number];

export function chooseLivenessPrimitive(mechanism: Readonly<Record<string, string>>): LivenessPrimitive | null {
  return LIVENESS_PRIMITIVES.find((p) => mechanism[p] === 'cli' || mechanism[p] === 'http' || mechanism[p] === 'fake') ?? null;
}

/** 检测读取：解析成功且结构正确才算可达（适配器返回意外的值也按无法确认处理）。 */
const LIVENESS_READ: Record<LivenessPrimitive, (s: SurgeAdapter) => Promise<boolean>> = {
  listExternalResources: async (s) => Array.isArray(await s.listExternalResources()),
  getCurrentProfile: async (s) => {
    const p: unknown = await s.getCurrentProfile();
    return typeof p === 'object' && p !== null && typeof (p as { name?: unknown }).name === 'string';
  },
  listPolicies: async (s) => {
    const p: unknown = await s.listPolicies();
    return typeof p === 'object' && p !== null && Array.isArray((p as { proxies?: unknown }).proxies) && Array.isArray((p as { groups?: unknown }).groups);
  },
};

/** 检测失败的分类：not_configured 没有可用实现；unreachable 无法连接；unconfirmed 命令失败或输出无法识别。 */
export type LivenessFailure = 'not_configured' | 'unreachable' | 'unconfirmed';

export const LIVENESS_FAILURE_TEXT: Record<LivenessFailure, string> = {
  not_configured: '无法连接 Surge：尚未配置可用的命令行工具或 HTTP API',
  unreachable: '无法连接 Surge',
  unconfirmed: '无法确认 Surge 连接：只读检测失败或输出无法识别',
};

/**
 * 运行实例读取的总时限（毫秒）。读取在执行器通道上进行（周期对账、刷新、动作前检查都经 readBasicFacts）：ps、plutil、
 * lsof、codesign 各自的超时加起来可达数十秒，排队的操作（包括进入普通模式）不能被它拖住。超过时限按 read_failed
 * （版本为 null，依赖版本的能力按待验证处理）；读取本身继续完成并更新读取器的缓存，下一次读取通常直接命中；它失败时
 * 另记原因（surge.version_read_late）。值定义在 surge/running-instance.ts，P0 按同一时限核对读取。
 */
export const DEFAULT_INSTANCE_READ_BUDGET_MS = SERVICE_INSTANCE_READ_BUDGET_MS;

const INSTANCE_READ_TIMED_OUT = Symbol('instance-read-timed-out');

/**
 * 版本不被接受时的提示。低于最低支持版本（6.10.0 / 12500 / Controller 协议 22）单独说明：依赖版本的动作拒绝，
 * 进入普通模式仍可用，但低于 6.9 时 rule match 不可用、入口撤销无法经运行时确认（ARCHITECTURE §0 的冲突）；
 * detected 是运行实例报告的版本与构建号（只用于说明，不进入能力上下文）。
 */
export function versionUnknownMessage(issue: SurgeVersionIssue, detected: { version: string; build: string } | null = null): string {
  if (issue === 'surge_version_unsupported') {
    const running = detected ? `运行中的 Surge 为 ${detected.version}（${detected.build}）。` : '';
    return `${running}${SURGE_VERSION_CHECK_FAILURE_TEXT.surge_version_unsupported}：发布、切换出口、维护写入等依赖 Surge 版本的动作已停用；进入普通模式仍可用（低于 6.9 的 Surge 不支持 rule match，入口撤销只能按写入与等待完成，标为“入口规则未能读回确认”）`;
  }
  const text = isRunningInstanceFailure(issue) ? RUNNING_INSTANCE_FAILURE_TEXT[issue] : SURGE_VERSION_CHECK_FAILURE_TEXT[issue];
  return `无法确认运行中的 Surge 版本（${text}）：依赖 Surge 版本的能力按待验证处理`;
}

/**
 * 引擎启动时间的容差（毫秒）：startedAt 由“读取时刻 − 运行时长”换算到整秒（surge/cli-commands.ts、http-adapter.ts），
 * 两次读取之间可能相差约 1 秒，再加上命令执行的延迟。超过容差的向后移动才算重启。
 */
export const SURGE_START_JITTER_MS = 2_000;

export interface SurgeRuntimeSample {
  startedAt: string | null;
  uptimeSeconds: number | null;
}

/** 读一次引擎运行时长与启动时间（getRuntimeInfo）；读不到或两项都无法识别时为 null。只读。 */
export async function readRuntimeSample(surge: Pick<SurgeAdapter, 'getRuntimeInfo'>): Promise<SurgeRuntimeSample | null> {
  try {
    const info = await surge.getRuntimeInfo();
    const startedAt = info.startedAt instanceof Date && Number.isFinite(info.startedAt.getTime()) ? info.startedAt.toISOString() : null;
    const uptimeSeconds = typeof info.uptimeSeconds === 'number' && Number.isFinite(info.uptimeSeconds) && info.uptimeSeconds >= 0 ? info.uptimeSeconds : null;
    return startedAt === null && uptimeSeconds === null ? null : { startedAt, uptimeSeconds };
  } catch {
    return null;
  }
}

/**
 * 两次读取之间引擎是否重启（surge_restarted、发布读回的提示、维护重载后的报告共用）：运行时长变小，或启动时间向后
 * 移动超过 SURGE_START_JITTER_MS。只重启引擎（restart-engine，或 6.9+ 的重载自动升级为完整重启）时进程不变，
 * 运行实例的进程启动时间看不出来，所以只看引擎运行时长（Mac 6.9.0+：`dump performance` 的 uptime、/v1/metrics 的
 * surge_uptime_seconds）。任一次读不到时为 false：不能证明重启（调用方按各自的规则处理“读不到”）。
 */
export function surgeRestartedBetween(prev: SurgeRuntimeSample | null, next: SurgeRuntimeSample | null): boolean {
  if (!prev || !next) return false;
  if (prev.uptimeSeconds !== null && next.uptimeSeconds !== null && next.uptimeSeconds < prev.uptimeSeconds) return true;
  if (prev.startedAt === null || next.startedAt === null) return false;
  const a = Date.parse(prev.startedAt);
  const b = Date.parse(next.startedAt);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return prev.startedAt !== next.startedAt;
  return b - a > SURGE_START_JITTER_MS;
}

export interface HostInfo {
  /** sw_vers 构建号；非 macOS 为 'unknown'；读不到为 null。 */
  macosBuild(): Promise<string | null>;
  /**
   * `sw_vers -productVersionExtra`（后台安全改进的补充版本，engine/capabilities.ts 的 versionExtraFromSwVers）；没有安装时
   * 为 'none'，非 macOS 为 'unknown'，读不到为 null。
   */
  macosVersionExtra(): Promise<string | null>;
  /**
   * 是否有已安装、要重启 Mac 才完全生效的后台安全改进（暂存位置 STAGED_CRYPTEX_PATH，restartPendingFrom）；非 macOS 为
   * 'unknown'，无法确认为 null。只有 'no' 能让依赖进程归属的能力生效。
   */
  macosRestartPending(): Promise<CapabilityContext['macosRestartPending']>;
  /** Safari.app Info.plist 版本；非 macOS 为 'unknown'；读不到为 null。 */
  safariVersion(): Promise<string | null>;
  /** 宿主 App 上报的签名身份；未知为 null。 */
  signingIdentity(): string | null;
  /** 进程路径是否存在（能力提议与对账检查）。 */
  processPathExists(path: string): boolean;
  /**
   * 运行中的 Surge 实例（版本与构建号的唯一来源，surge/running-instance.ts）。缺省：非 macOS 为 not_darwin，
   * 否则 unavailable——版本为 null，依赖版本的能力按待验证处理。
   */
  surgeInstance(): Promise<RunningInstanceResult>;
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
  /**
   * 固定可达性检测原语（null 表示没有）；缺省按 surge.mechanism() 选择（chooseLivenessPrimitive）。
   * 测试夹具用它固定检测读取，避免检测消耗测试注入的故障。
   */
  livenessPrimitive?: LivenessPrimitive | null;
  /** 运行实例读取的总时限（毫秒，缺省 DEFAULT_INSTANCE_READ_BUDGET_MS）。 */
  instanceReadBudgetMs?: number;
  /**
   * 写入本地节点资源后等待 Surge 自动重新读取（文件监视）的时限与轮询间隔（毫秒，缺省 DEFAULT_RESOURCE_RELOAD_WAIT）。
   * 外部资源更新会跳过本地文件（HTTP API 文档：“Local resources are skipped.”），发布从不把它当作刷新。
   */
  resourceReloadWait?: { timeoutMs: number; pollMs: number };
  /**
   * ruleset_resource 每一步等待文件监视加载入口规则集文件的时限与轮询间隔（毫秒，缺省 DEFAULT_RULESET_WATCH）；撤销入口时
   * rule match 不可用的退路按时限等满（见 ruleset-strategy.ts 的 UnwitnessedUndo）。
   */
  rulesetWatch?: { timeoutMs: number; pollMs: number };
}

/**
 * 写入本地节点资源后等待 Surge 重新读取的缺省时限与轮询间隔（毫秒）。等待在执行器通道上进行，排队的操作（包括进入普通
 * 模式）要等它结束：发布与回滚各最多等这么久。TODO(P0)：按 policy_path_reread 实测的监视延迟调整。
 */
export const DEFAULT_RESOURCE_RELOAD_WAIT = { timeoutMs: 10_000, pollMs: 500 } as const;

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
  hostFacts: {
    macosBuild: string | null;
    macosVersionExtra: string | null;
    macosRestartPending: CapabilityContext['macosRestartPending'];
    safariVersion: string | null;
  } = { macosBuild: null, macosVersionExtra: null, macosRestartPending: null, safariVersion: null };
  views: EventViews | null = null;
  /** 可达性检测原语：创建时静态选定，之后不变。 */
  readonly livenessPrimitive: LivenessPrimitive | null;
  /** 上一次检测与版本读取的结论（只在变化时记日志）；undefined 表示尚未读取。 */
  private lastLiveness: LivenessFailure | null | undefined = undefined;
  private lastVersionIssue: SurgeVersionIssue | null | undefined = undefined;
  private lastLateInstanceFailure: SurgeVersionIssue | null = null;
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
      macosVersionExtra: deps.host?.macosVersionExtra ?? (async () => (off ? 'unknown' : null)),
      macosRestartPending: deps.host?.macosRestartPending ?? (async () => (off ? 'unknown' : null)),
      safariVersion: deps.host?.safariVersion ?? (async () => (off ? 'unknown' : null)),
      signingIdentity: deps.host?.signingIdentity ?? (() => null),
      processPathExists: deps.host?.processPathExists ?? (() => true),
      surgeInstance: deps.host?.surgeInstance ?? (async () => ({ ok: false, reason: off ? 'not_darwin' : 'unavailable' })),
    };
    this.livenessPrimitive = deps.livenessPrimitive !== undefined ? deps.livenessPrimitive : chooseLivenessPrimitive(this.surge.mechanism());
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
      ...(this.deps.rulesetWatch ? { watch: this.deps.rulesetWatch } : {}),
    });
  }

  /** 自动重载与原子替换能力记录中实测时的自动重载条件；没有已确认记录时为 null（拒绝写入）。 */
  autoReloadCondition(): 'on' | 'off' | 'any' | null {
    const rec = this.repos.capabilities.get('auto_reload_atomic_replace');
    if (!rec || rec.status === 'unverified') return null;
    return rec.context?.autoReload ?? null;
  }

  // ---------- Surge 事实与能力上下文 ----------

  /**
   * 只读 Surge 基础事实（可达性、版本、启动时间、当前配置、接管、自动重载）；从不写。同时重读本机事实（macOS 构建号与
   * 补充版本、后台安全改进是否待重启、Safari 版本）：服务常驻运行，Safari 可单独经软件更新升级而不重启，后台安全改进装上
   * 后 Safari 重开即使用新的 WebKit，能力门槛（激活前、写入 ACTIVE 前、对账）必须按当前状态判定，不能沿用启动时的值。
   *
   * 可达性只看固定的检测原语（livenessPrimitive）一次读取是否解析成功；其他任何结果都是不可达（失败即关闭），
   * 不可达时不再读取其他事实。版本与构建号来自运行中的 Surge 实例（host.surgeInstance），并与 `surge-cli --raw version`
   * 交叉核对（readVersion），与可达性无关：无法证明、两者不一致或低于最低支持版本时为 null，原因记在 versionIssue，
   * 依赖版本的能力按待验证处理、相应动作拒绝；进入普通模式不依赖版本。
   * 提示按优先级取第一条：无法连接 > 版本低于最低支持版本 > 不是工作配置 > 版本无法确认 > 目录位置无法确认。
   */
  async readBasicFacts(): Promise<SurgeFacts> {
    await this.refreshHostFacts();
    // 从空事实开始，但清掉“尚未读取”的占位提示：本次读取的结论会重新填写 message。
    const facts: SurgeFacts = {
      ...emptySurgeFacts(),
      message: null,
      precedenceIssues: this.facts.precedenceIssues,
      managedSectionsIntact: this.facts.managedSectionsIntact,
    };
    facts.checkedAt = this.nowIso();
    const liveness = await this.checkLiveness();
    this.noteLiveness(liveness);
    if (liveness !== null) {
      facts.message = LIVENESS_FAILURE_TEXT[liveness];
      this.facts = facts;
      return facts;
    }
    facts.reachable = true;
    const { issue: versionIssue, detected } = await this.readVersion(facts);
    facts.versionIssue = versionIssue;
    this.noteVersionIssue(versionIssue);
    const wp = this.workingProfile();
    const runtime = await readRuntimeSample(this.surge);
    facts.startedAt = runtime?.startedAt ?? null;
    facts.uptimeSeconds = runtime?.uptimeSeconds ?? null;
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
    let directoryUnknown = false;
    if (wp) {
      try {
        facts.profileDirectoryRisk = classifyDirectoryRisk(wp.directory, this.deps.paths.homedir);
      } catch {
        // 工作配置目录或 home 的真实位置无法确认（链接循环、没有权限等）：风险未知，提示而不让读取事实失败——
        // 对账、激活与核对都依赖读取事实不抛出（该字段只做展示，不是激活门槛）。
        facts.profileDirectoryRisk = null;
        directoryUnknown = true;
      }
      try {
        const text = await readFile(wp.path, 'utf8');
        const api = parseHttpApiLine(text);
        facts.httpApi = api ? { configured: true, loopbackOnly: api.loopbackOnly } : { configured: false, loopbackOnly: null };
      } catch {
        facts.httpApi = { configured: false, loopbackOnly: null };
      }
    }
    if (facts.message === null && versionIssue === 'surge_version_unsupported') facts.message = versionUnknownMessage(versionIssue, detected);
    if (facts.message === null && facts.onWorkingProfile === false) facts.message = 'Surge 当前配置不是固定工作配置';
    if (facts.message === null && versionIssue !== null) facts.message = versionUnknownMessage(versionIssue, detected);
    if (facts.message === null && directoryUnknown) facts.message = '无法确认固定工作配置所在目录的真实位置：可能位于同步或受保护位置，请检查目录权限与链接';
    this.facts = facts;
    return facts;
  }

  /** 一次检测读取：null 表示可达。 */
  private async checkLiveness(): Promise<LivenessFailure | null> {
    const primitive = this.livenessPrimitive;
    if (primitive === null) return 'not_configured';
    try {
      return (await LIVENESS_READ[primitive](this.surge)) ? null : 'unconfirmed';
    } catch (err) {
      const code = err instanceof SfeError ? err.code : null;
      // CAPABILITY_UNVERIFIED：原语映射到的实现不存在（命令行工具未通过签名校验、HTTP API 不是只监听回环地址等）
      if (code === 'CAPABILITY_UNVERIFIED') return 'not_configured';
      if (code === 'SURGE_UNREACHABLE') return 'unreachable';
      // 命令失败、交互模式提示、输出无法识别、HTTP 401 等：不能证明连接可用
      return 'unconfirmed';
    }
  }

  /**
   * 运行中 Surge 的版本、构建号与 Controller 协议号（只决定版本，从不决定可达性），一起接受或一起为 null：
   * 1. 运行实例读取（证明磁盘上的包就是运行中的那一份）；读取器已经校验过格式，这里再按 A0 的格式核对一次（注入的实现
   *    返回其他值时按 version_malformed）。总时限（instanceReadBudgetMs）到达时不再等待，按 read_failed。
   * 2. 运行实例低于最低支持版本（6.10.0 / 12500）→ surge_version_unsupported，不再调用 CLI。
   * 3. `surge-cli --raw version`（Mac 6.8.0+；手册：“Show Surge, Core, Controller protocol, operating-system, and device
   *    versions.”）与运行实例交叉核对（surge/running-instance.ts 的 crossCheckSurgeVersion）：版本或构建号不同 →
   *    cli_bundle_mismatch；命令不被支持（旧核心回答 Unknown command、6.5 进入交互模式）或协议 < 22 →
   *    surge_version_unsupported；读不到（未映射、无法连接、输出无法识别）→ cli_version_unreadable。
   * detected 是运行实例报告的版本与构建号（只用于提示文字）。
   */
  private async readVersion(facts: SurgeFacts): Promise<{ issue: SurgeVersionIssue | null; detected: { version: string; build: string } | null }> {
    let r: RunningInstanceResult;
    let cancelBudget: () => void = () => undefined;
    const budget = new Promise<typeof INSTANCE_READ_TIMED_OUT>((resolve) => {
      cancelBudget = this.clock.setTimeout(() => resolve(INSTANCE_READ_TIMED_OUT), this.deps.instanceReadBudgetMs ?? DEFAULT_INSTANCE_READ_BUDGET_MS);
    });
    try {
      const read = this.host.surgeInstance();
      const v = await Promise.race([read, budget]);
      if (v === INSTANCE_READ_TIMED_OUT) {
        this.noteLateInstanceRead(read);
        return { issue: 'read_failed', detected: null };
      }
      this.lastLateInstanceFailure = null;
      r = v;
    } catch {
      return { issue: 'read_failed', detected: null };
    } finally {
      cancelBudget();
    }
    if (typeof r !== 'object' || r === null) return { issue: 'read_failed', detected: null };
    if (r.ok !== true) {
      const reason: unknown = (r as { reason?: unknown }).reason;
      return { issue: isRunningInstanceFailure(reason) ? reason : 'read_failed', detected: null };
    }
    const inst: { version?: unknown; build?: unknown } = typeof r.instance === 'object' && r.instance !== null ? r.instance : {};
    if (typeof inst.version !== 'string' || !SURGE_VERSION_RE.test(inst.version) || typeof inst.build !== 'string' || !SURGE_BUILD_RE.test(inst.build)) {
      return { issue: 'version_malformed', detected: null };
    }
    const detected = { version: inst.version, build: inst.build };
    if (!meetsSurgeMinimumVersion(detected)) return { issue: 'surge_version_unsupported', detected };
    const check = crossCheckSurgeVersion(detected, await this.readCliVersion());
    if (!check.ok) return { issue: check.reason, detected };
    facts.version = check.version;
    facts.build = check.build;
    facts.controllerProtocol = check.controllerProtocol;
    return { issue: null, detected };
  }

  /**
   * `surge-cli --raw version` 的结果：'unsupported' 表示命令不被支持（Unknown command 或交互模式提示）；
   * 读不到或结构不对为 null。只保留版本、构建号、Core 版本与 Controller 协议号（适配器已丢弃系统与设备字段）。
   */
  private async readCliVersion(): Promise<SurgeVersion | 'unsupported' | null> {
    let v: unknown;
    try {
      v = await this.surge.getVersion();
    } catch (err) {
      return isUnsupportedCommandError(err) ? 'unsupported' : null;
    }
    if (typeof v !== 'object' || v === null) return null;
    const o = v as Record<string, unknown>;
    if (typeof o.version !== 'string' || typeof o.build !== 'string' || typeof o.controllerProtocol !== 'number' || typeof o.coreVersion !== 'number') return null;
    return { version: o.version, build: o.build, controllerProtocol: o.controllerProtocol, coreVersion: o.coreVersion };
  }

  /**
   * 总时限到达后读取仍在进行：它失败时记下原因（例如服务的 codesign 超时得到的 signature_invalid），否则日志中只有
   * read_failed，看不出是哪一步失败。成功时不记（结果已进入读取器的缓存）。同一原因连续出现只记一次；只含原因代码。
   */
  private noteLateInstanceRead(read: Promise<RunningInstanceResult>): void {
    void Promise.resolve(read).then(
      (late: unknown) => {
        const reason: unknown = typeof late === 'object' && late !== null && (late as { ok?: unknown }).ok !== true ? (late as { reason?: unknown }).reason : null;
        const failure = isRunningInstanceFailure(reason) ? reason : null;
        if (failure === this.lastLateInstanceFailure) return;
        this.lastLateInstanceFailure = failure;
        if (failure !== null) this.logger.log('warn', 'surge.version_read_late', { reason: failure });
      },
      () => undefined,
    );
  }

  /** 只在结论变化时记日志；不记录任何输出内容。 */
  private noteLiveness(failure: LivenessFailure | null): void {
    const prev = this.lastLiveness;
    if (failure === prev) return;
    this.lastLiveness = failure;
    if (failure !== null) this.logger.log('warn', 'surge.liveness_failed', { primitive: this.livenessPrimitive, reason: failure });
    else if (prev !== undefined) this.logger.log('info', 'surge.liveness_restored', { primitive: this.livenessPrimitive });
  }

  private noteVersionIssue(issue: SurgeVersionIssue | null): void {
    const prev = this.lastVersionIssue;
    if (issue === prev) return;
    this.lastVersionIssue = issue;
    if (issue !== null) this.logger.log('warn', 'surge.version_unknown', { reason: issue });
    else if (prev !== undefined) this.logger.log('info', 'surge.version_known');
  }

  async refreshHostFacts(): Promise<void> {
    try {
      this.hostFacts.macosBuild = await this.host.macosBuild();
    } catch {
      this.hostFacts.macosBuild = null;
    }
    try {
      this.hostFacts.macosVersionExtra = await this.host.macosVersionExtra();
    } catch {
      this.hostFacts.macosVersionExtra = null;
    }
    try {
      this.hostFacts.macosRestartPending = await this.host.macosRestartPending();
    } catch {
      this.hostFacts.macosRestartPending = null;
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
      macosVersionExtra: this.hostFacts.macosVersionExtra,
      macosRestartPending: this.hostFacts.macosRestartPending,
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
    throw capabilityError(views, miss, action, this.versionGateNote(miss));
  }

  /**
   * 缺失项中有依赖 Surge 版本的能力、且版本因低于最低支持版本或无法确认而不被接受时，给门槛错误附上的原因说明
   * （否则为 null）：能力记录本身可能已通过，拒绝的原因是当前 Surge 版本。
   */
  versionGateNote(miss: readonly CapabilityKey[]): string | null {
    const issue = this.facts.versionIssue;
    if (!this.facts.reachable || issue === null) return null;
    if (!miss.some((k) => CAPABILITY_CONTEXT_DEPS[k].includes('surgeVersion'))) return null;
    return versionUnknownMessage(issue);
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

/**
 * Surge 当前配置是否是固定工作配置：只按绝对路径比较。没有路径时不是（文档：`status` 的 profile-path 是当前配置的绝对
 * 路径，“profiles that do not originate from a local file report no path”；工作配置总是本地文件），从不只按名称认定。
 */
export function profileMatches(p: { name: string; path: string | null }, wp: { path: string; name: string }): boolean {
  if (typeof p.path !== 'string' || p.path === '') return false;
  return resolve(p.path) === resolve(wp.path);
}

/** versionNote：当前 Surge 版本不被接受时的说明（Engine.versionGateNote），放在缺失能力之前。 */
export function capabilityError(views: readonly CapabilityView[], miss: readonly CapabilityKey[], action: string, versionNote: string | null = null): SfeError {
  const items = views.filter((v) => miss.includes(v.key));
  const labels = items.map((v) => v.label).join('、');
  const message = versionNote ? `${action}失败：${versionNote}；${labels}在当前 Surge 版本下尚未通过实测` : `${action}失败：${labels}尚未通过实测`;
  return new SfeError('CAPABILITY_UNVERIFIED', message, {
    details: { missing: items.map((v) => ({ key: v.key, staleReasons: v.staleReasons })) },
  });
}

export const ALL_CAPABILITY_KEYS: readonly CapabilityKey[] = CAPABILITY_KEYS;
