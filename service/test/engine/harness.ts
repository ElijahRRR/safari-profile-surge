// 引擎测试夹具：FakeSurge（合成工作配置）+ 内存秘密存储 + 可控时钟 + 内存日志。只用合成数据：
// 文档地址（203.0.113.0/24 等）、example.test 账号与检测主机。能力记录在夹具中直接写入（测试专用）。
// 本机资源服务（D10）：引擎经进程内的 virtualBinder 监听固定的范围内端口（RESOURCE_TEST_PORT，启动前写入设置），FakeSurge 的
// 每次远端下载都经 binder.request 到达引擎资源服务的真实 handle()；h.resourceFault 在请求外层注入故障（服务端答复出错、连接
// 被拒绝、端口被他人占用）。缺省 nodeResource 'loopback'：工作配置的 SFE-ROUTE 指向 engine.resourceUrl()（启动前按产品的
// loadResourceToken 建好令牌并写入已提交第 0 代的指针，等同于初始化早已完成）；'legacy' 只用于迁移与旧组行停泊的测试。

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CAPABILITY_CONTEXT_FIELDS,
  CAPABILITY_KEYS,
  ENTRY_RULESET_FILES,
  NATIVE_PROTOCOL_VERSION,
  SfeError,
  WORKING_PROFILE_NAME,
  nodeResourceUrl,
  type Accepted,
  type CapabilityContext,
  type CapabilityKey,
  type EnvironmentInput,
  type NativeRequest,
  type NativeResponse,
  type ServiceEvent,
  type VerifyEndpoint,
} from '@sfe/contract';
import type { Actor } from '../../src/app.js';
import { openRepositories, type Repositories } from '../../src/db/index.js';
import { createAppService, type EngineAppService } from '../../src/engine/app-service.js';
import { READBACK_COVERAGE_KEYS } from '../../src/engine/capabilities.js';
import type { LivenessPrimitive } from '../../src/engine/context.js';
import { createEngineKv } from '../../src/engine/kv.js';
import { registerInitialObjects } from '../../src/engine/ownership.js';
import { loadResourceToken, virtualBinder, writeServedPointer, type VirtualResourceBinder } from '../../src/resource/index.js';
import { MemorySecretStore } from '../../src/secrets/memory-store.js';
import { loadPepper, pepperKey } from '../../src/secrets/pepper.js';
import {
  FAKE_SAFARI_PATH,
  FAKE_VERIFY_HOST,
  FakeSurge,
  createFakeSurgeEnvironment,
  loopbackRemoteSource,
  loopbackResourceRequest,
  type FakeRemoteResponse,
  type FakeRemoteSource,
  type FakeSurgeOptions,
} from '../../src/surge/fake.js';
import { createProfileFiles, type ManagedProfileFiles } from '../../src/surge/files.js';
import { resourceBody } from '../../src/surge/generate.js';
import { FakeClock } from '../../src/util/clock.js';
import { createIdGenerator } from '../../src/util/ids.js';
import { createLogger, createMemorySink } from '../../src/util/logger.js';
import { createScrubber } from '../../src/util/scrubber.js';
import type { SurgeAdapter } from '../../src/ports.js';

export const WEB: Actor = { kind: 'web', sessionId: 'web_test0001' };
export const AGENT: Actor = { kind: 'agent' };
export const ADMIN: Actor = { kind: 'admin' };
export const PROFILE_A = 'profile-aaaa-0001';
export const PROFILE_B = 'profile-bbbb-0002';
export const PROFILE_C = 'profile-cccc-0003';
export const TEST_ENDPOINT: VerifyEndpoint = { id: 'ipify', url: 'https://verify.example.test/?format=json', host: FAKE_VERIFY_HOST, label: '测试检测服务' };
export const ALL_CAPS: readonly CapabilityKey[] = CAPABILITY_KEYS;
/**
 * 四项回环资源补测（发布门槛与 resourceServe 门槛共有，CAPABILITY_GATES.publish / resourceServe）：缺省与其余能力一起授予，
 * withholdLoopbackCapabilities 时不授予（门槛中的 external_node_underlying_proxy 与 connection_continuity 也是激活等门槛的
 * 一部分，要撤销它们请用 capabilities 或 h.revoke）。
 */
export const LOOPBACK_CAPS: readonly CapabilityKey[] = ['loopback_resource_update', 'loopback_resource_auth', 'loopback_resource_restart', 'loopback_publish_crash'];
/** 夹具中本机资源服务的端口（[RESOURCE_PORT_MIN, RESOURCE_PORT_MAX) 内的固定值，启动前经 settings.setResourcePort 写入）。 */
export const RESOURCE_TEST_PORT = 23456;

/**
 * 包在 FakeSurge 下载请求外层的故障（h.resourceFault）：
 * - http / reset / truncated / no_response：请求到达引擎的资源服务并被它校验、记录（令牌正确的 200 留下 complete=false 的
 *   审计记录，从不调用 finished），之后答复出错——改答这个状态码（内容缺省为空）、连接被重置、响应被截断或不答复。引擎的资源
 *   服务没有在该端口监听时与没有故障相同（连接被拒绝）；
 * - refused：请求没有到达任何处理程序（端口上无人监听）；
 * - squat：另一个进程占用了该端口，绕过引擎的资源服务直接答复（不留审计记录）。要让引擎自己的监听也因端口被占用而失败，
 *   在启动前往 h.binderRegistry 放入任意值。
 */
export type ResourceFault =
  | { kind: 'http'; status: number; body?: string }
  | { kind: 'reset' }
  | { kind: 'truncated' }
  | { kind: 'no_response' }
  | { kind: 'refused' }
  | { kind: 'squat'; status: number; body: string };

/** FakeSurge 发出的每个下载请求（不含路径与令牌）。 */
export interface ResourceRequestLog {
  at: Date;
  /** 请求的本机端口；地址不是 http://127.0.0.1:<端口>/… 时为 null。 */
  port: number | null;
  fault: ResourceFault['kind'] | null;
  /** Surge 看到的结果。 */
  result: FakeRemoteResponse['kind'];
  status: number | null;
}

export interface HarnessOptions {
  capabilities?: readonly CapabilityKey[];
  entryStrategy?: 'ruleset_resource' | 'temp_rule';
  dbFile?: boolean;
  autoReload?: boolean;
  /** 读回不完整的覆盖声明（写进 READBACK_COVERAGE_KEYS 两项能力的说明）。 */
  readbackCovers?: boolean;
  start?: boolean;
  userRules?: string[];
  /** 未初始化：Surge 当前配置是这份源配置（Daily.conf），尚无固定工作配置。 */
  sourceProfile?: string;
  /** Surge 配置目录（相对临时目录），缺省 surge。 */
  surgeSubdir?: string;
  /**
   * 可达性检测原语。缺省固定为 getCurrentProfile（读取事实本来就读它，测试没有向它注入故障或谎言），避免检测读取
   * 消耗测试向 listExternalResources、listPolicies 等注入的故障；'auto' 按 mechanism() 选择（与服务一致）。
   */
  livenessPrimitive?: LivenessPrimitive | null | 'auto';
  /** 引擎使用的 Surge 适配器（缺省就是 FakeSurge）；维护端口始终是 FakeSurge。 */
  surge?: (fake: FakeSurge) => SurgeAdapter;
  /** false：不提供 host.surgeInstance（使用引擎的缺省值：非 macOS 为 not_darwin，否则 unavailable）。 */
  surgeInstance?: false;
  rulesetWatch?: { timeoutMs: number; pollMs: number };
  /** FakeSurge 是否监视本地 policy-path 文件（缺省关闭，与自动重载关闭时的真实 Surge 相同；只作阴性回归开关，从不跟随能力记录）。 */
  watchLocalPolicyPaths?: boolean;
  /**
   * 节点资源模型：loopback（缺省；工作配置的 SFE-ROUTE 指向 engine.resourceUrl()，D10）或 legacy（指向本地 sfe-nodes.list 的
   * D7 组行：发布停泊、需要重新合并；只用于迁移与旧组行的测试）。两种模式都有 virtualBinder、固定端口与接到它的 FakeSurge
   * 下载来源。
   */
  nodeResource?: 'legacy' | 'loopback';
  /**
   * 启动前的已提交/候选指针（resource:served）：committed（loopback 模式缺省）如同初始化已完成——已提交第 0 代、没有候选，
   * 启动时不设 needsRefresh；absent（legacy 模式缺省）由引擎首次启动按发布记录初始化（没有可用的发布时设 pointer_init）。
   */
  servedPointer?: 'committed' | 'absent';
  /** 单 key 更新之后的等待（AppServiceDeps.resourceUpdateWait）；缺省 { timeoutMs: 0, pollMs: 0, settleMs: 0 }：只读一次。 */
  resourceUpdateWait?: { timeoutMs: number; pollMs: number; settleMs: number };
  /** 审计容差（AppServiceDeps.resourceAuditToleranceMs）；缺省用引擎的缺省值。 */
  resourceAuditToleranceMs?: number;
  /** 缺省授予时不授予 LOOPBACK_CAPS（四项回环资源补测）；给出 capabilities 时不起作用。 */
  withholdLoopbackCapabilities?: boolean;
  /**
   * loopback 模式下 Surge 启动时的资源缓存：placeholder（缺省）如同初始化时重载配置已下载过第 0 代（只含占位行，更新时间为
   * 夹具时钟起点之前 60 秒），构造时不下载；empty 为从未下载过（构造时下载一次，无人监听而被拒绝，资源未就绪）。
   */
  surgeCache?: 'placeholder' | 'empty';
  /** FakeSurge 的远端资源选项（定时刷新、重启缓存、更新时间分辨率、慢更新、URL 形式的 key、节点行接受规则）。 */
  fakeRemote?: Pick<FakeSurgeOptions, 'remoteRefreshIntervalMs' | 'remoteCacheOnRestart' | 'updatedAtResolution' | 'slowUpdate' | 'urlKeys' | 'acceptNodeLine'>;
}

export interface Harness {
  dir: string;
  surgeDir: string;
  profilePath: string;
  fake: FakeSurge;
  store: MemorySecretStore;
  clock: FakeClock;
  repos: Repositories;
  app: EngineAppService;
  files: ManagedProfileFiles;
  logs: string[];
  events: ServiceEvent[];
  responses: unknown[];
  frontId: string;
  /**
   * 本机事实（macOS 构建号与补充版本、后台安全改进是否待重启、Safari 版本）；可在启动后修改，模拟服务运行期间 Safari 或
   * macOS 单独更新、装上后台安全改进。
   */
  host: { macosBuild: string; macosVersionExtra: string | null; macosRestartPending: CapabilityContext['macosRestartPending']; safariVersion: string };
  /** 节点资源模型（HarnessOptions.nodeResource）。 */
  nodeResource: 'legacy' | 'loopback';
  /** 引擎资源服务的进程内绑定方（AppServiceDeps.resourceBinder），所有实例共用（端口独占）。 */
  binder: VirtualResourceBinder;
  /** binder 的端口登记表：启动前放入任意值即模拟端口被其他进程占用（引擎监听失败 port_in_use，下载被拒绝）。 */
  binderRegistry: Map<number, unknown>;
  /** 启动前写入设置的资源服务端口（RESOURCE_TEST_PORT）。 */
  resourcePort: number;
  /** engine.resourceUrl()：资源服务尚未创建（令牌读不到、尚未接入）时为 null。含令牌，不要写进断言消息之外的地方。 */
  resourceUrl(): string | null;
  /** FakeSurge 中 resourceUrl() 对应的资源 key；没有地址时为 null。 */
  resourceKey(): string | null;
  /** loopback 模式下夹具写入工作配置的地址（启动前由同一令牌与端口得出）；legacy 模式或 sourceProfile 时为 null。 */
  profileResourceUrl: string | null;
  /** 设置（null 清除）包在下载请求外层的故障；times 为生效的请求数（缺省一直生效，直到清除）。 */
  resourceFault(fault: ResourceFault | null, opts?: { times?: number }): void;
  /** FakeSurge 发出的每个下载请求（含构造与加载配置时的下载）。 */
  resourceRequests: ResourceRequestLog[];
  /**
   * 模拟服务崩溃：旧实例放弃（不等待其挂起的写入），关闭它的资源服务（进程退出时操作系统关闭监听），在同一数据库与 FakeSurge
   * 上启动新实例。
   */
  crash(): Promise<EngineAppService>;
  grant(keys: readonly CapabilityKey[], note?: string | null): void;
  revoke(keys: readonly CapabilityKey[]): void;
  native(profileId: string | null, message: NativeRequest): Promise<NativeResponse>;
  record<T>(p: Promise<T>): Promise<T>;
  idle(): Promise<void>;
  close(): Promise<void>;
}

/**
 * 不限的上下文。例外：后台安全改进的两个字段没有 any（待重启状态只有 'no' 与 'no' 匹配，提议拒绝补充版本为 any），
 * 记为测试本机事实的初始值（没有安装、没有待重启）。
 */
export function anyContext(): CapabilityContext {
  return {
    ...(Object.fromEntries(CAPABILITY_CONTEXT_FIELDS.map((f) => [f, 'any'])) as unknown as CapabilityContext),
    macosVersionExtra: 'none',
    macosRestartPending: 'no',
  };
}

/**
 * 记录能力用的上下文：Surge 版本与构建号取 FakeSurge 运行实例当前报告的值（门槛中 any 不匹配任何版本），其余字段不限。
 * 之后修改 h.fake.version/build 即让依赖版本的记录过期。
 */
export function instanceContext(fake: Pick<FakeSurge, 'version' | 'build'>): CapabilityContext {
  return { ...anyContext(), surgeVersion: fake.version, surgeBuild: fake.build };
}

/** 按当前本机事实（macOS 构建号与补充版本、待重启状态、Safari 版本）与 Surge 版本记录能力，其余字段不限：之后修改 h.host 即让这些记录过期。 */
export function grantForCurrentHost(h: Harness, keys: readonly CapabilityKey[]): void {
  for (const key of keys) {
    h.repos.capabilities.upsert({
      key,
      status: 'supported',
      context: {
        ...instanceContext(h.fake),
        macosBuild: h.host.macosBuild,
        macosVersionExtra: h.host.macosVersionExtra,
        macosRestartPending: h.host.macosRestartPending,
        safariVersion: h.host.safariVersion,
      },
      verifiedAt: h.clock.now().toISOString(),
      note: '测试记录',
    });
  }
}

export async function createHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'sfe-engine-'));
  const surgeDir = join(dir, opts.surgeSubdir ?? 'surge');
  const strategy = opts.entryStrategy ?? 'ruleset_resource';
  const nodeResource = opts.nodeResource ?? 'loopback';
  const clock = new FakeClock('2026-10-21T00:00:00.000Z');
  const scrubber = createScrubber();
  const mem = createMemorySink();
  const logger = createLogger({ sink: mem.sink, scrubber, level: 'debug', now: () => clock.now() });
  const ids = createIdGenerator({ now: () => clock.now().getTime() });
  const repos = openRepositories(opts.dbFile ? join(dir, 'sfe.sqlite') : ':memory:', { clock, ids, scrubber });
  const store = new MemorySecretStore();

  // loopback：工作配置引用的地址由产品的令牌加载（loadResourceToken，引擎启动时读到同一令牌）与固定端口得出，如同初始化早已
  // 完成。令牌只在这里用来写配置，不注册到脱敏器（那是引擎的职责，测试要能发现它没有做）。
  const profileResourceUrl = nodeResource === 'loopback' && opts.sourceProfile === undefined ? nodeResourceUrl(RESOURCE_TEST_PORT, await loadResourceToken(store, repos.meta)) : null;
  let profilePath: string;
  if (opts.sourceProfile !== undefined) {
    mkdirSync(surgeDir, { recursive: true, mode: 0o700 });
    profilePath = join(surgeDir, 'Daily.conf');
    writeFileSync(profilePath, opts.sourceProfile, { mode: 0o600 });
  } else {
    profilePath = createFakeSurgeEnvironment(surgeDir, {
      entryStrategy: strategy,
      processPaths: [FAKE_SAFARI_PATH],
      verifyHost: FAKE_VERIFY_HOST,
      ...(opts.userRules ? { userRules: opts.userRules } : {}),
      ...(profileResourceUrl !== null ? { resource: { url: profileResourceUrl } } : { legacy: true }),
    }).profilePath;
  }

  // 本机资源服务的绑定方与 FakeSurge 的下载来源：每次下载经 binder.request 到达占用该端口的处理程序（引擎资源服务的 handle()）。
  // ref.app 在构造 FakeSurge 时尚不存在（surgeCache 'empty' 时构造时的那次下载因无人监听而被拒绝）。
  const binderRegistry = new Map<number, unknown>();
  const binder = virtualBinder(binderRegistry);
  const ref: { app: EngineAppService | null } = { app: null };
  const fault: { current: ResourceFault | null; remaining: number } = { current: null, remaining: 0 };
  const resourceRequests: ResourceRequestLog[] = [];
  const plain = loopbackRemoteSource((port, req) => binder.request(port, req));
  const remoteSource: FakeRemoteSource = (url) => {
    const target = loopbackResourceRequest(url);
    const f = fault.remaining > 0 ? fault.current : null;
    let applied = f !== null;
    let result: FakeRemoteResponse;
    if (f === null) result = plain(url);
    else if (f.kind === 'refused') result = { kind: 'refused' };
    else if (f.kind === 'squat') result = { kind: 'http', status: f.status, body: f.body };
    else {
      // 请求先到达引擎的资源服务（校验并记录；从不调用 finished：令牌正确的 200 留下 complete=false 的记录），之后答复出错
      const host = ref.app?.engine.resource ?? null;
      if (target === null || host === null || host.port() !== target.port) {
        applied = false;
        result = plain(url);
      } else {
        host.handle({ ...target.request, localPort: target.port });
        result = f.kind === 'http' ? { kind: 'http', status: f.status, body: f.body ?? '' } : { kind: f.kind };
      }
    }
    if (applied && --fault.remaining <= 0) fault.current = null;
    resourceRequests.push({ at: clock.now(), port: target?.port ?? null, fault: applied ? f!.kind : null, result: result.kind, status: result.kind === 'http' ? result.status : null });
    return result;
  };

  const seeded = profileResourceUrl !== null && (opts.surgeCache ?? 'placeholder') === 'placeholder';
  const fake = new FakeSurge({
    directory: surgeDir,
    now: () => clock.now(),
    autoReload: opts.autoReload ?? false,
    tempRuleInsertion: 'tail',
    remoteSource,
    ...(seeded ? { remoteCache: [{ url: profileResourceUrl, body: resourceBody(0, []), updatedAt: new Date(clock.now().getTime() - 60_000) }] } : {}),
    ...(opts.fakeRemote ?? {}),
    ...(opts.sourceProfile !== undefined ? { profileFileName: 'Daily.conf' } : {}),
  });
  if (opts.watchLocalPolicyPaths !== undefined) fake.watchLocalPolicyPaths = opts.watchLocalPolicyPaths;
  repos.tx(() => {
    if (opts.sourceProfile === undefined) {
      repos.settings.set('workingProfilePath', profilePath);
      repos.settings.set('workingProfileName', WORKING_PROFILE_NAME);
    }
    repos.settings.set('entryStrategy', strategy);
    repos.settings.set('safariProcessPaths', [FAKE_SAFARI_PATH]);
    // 启动前选定端口（与引擎首次启动选定之后相同）：引擎不再随机选择
    repos.settings.setResourcePort(RESOURCE_TEST_PORT);
    // 初始化已完成：已提交第 0 代（只含占位行），没有候选版本
    if ((opts.servedPointer ?? (profileResourceUrl !== null ? 'committed' : 'absent')) === 'committed') {
      writeServedPointer(createEngineKv(repos.db), { committed: { generation: 0 }, candidate: null });
    }
  });
  const pepper = await loadPepper(store, repos.meta, ids);
  const files = createProfileFiles({ directory: surgeDir, hmacKey: pepperKey(pepper, 'file') });
  if (opts.sourceProfile === undefined) {
    await registerInitialObjects(repos, { profileText: readFileSync(profilePath, 'utf8'), digestContent: files.digestContent, fileDigest: (n) => files.digest(n), operationId: null });
  }
  const frontId = 'front_test0001';
  repos.frontProxies.insert({ id: frontId, surgeName: 'Front-A', state: 'ok', isDefault: true });

  const grant = (keys: readonly CapabilityKey[], note: string | null = null) => {
    for (const key of keys) {
      const covers = opts.readbackCovers && READBACK_COVERAGE_KEYS.includes(key);
      repos.capabilities.upsert({
        key,
        status: 'supported',
        context: instanceContext(fake),
        verifiedAt: clock.now().toISOString(),
        note: note ?? (covers ? 'readback-covers: server, port, underlying-proxy' : '测试记录'),
      });
    }
  };
  const revoke = (keys: readonly CapabilityKey[]) => {
    for (const key of keys) repos.capabilities.upsert({ key, status: 'unverified' });
  };
  grant(opts.capabilities ?? (opts.withholdLoopbackCapabilities ? ALL_CAPS.filter((k) => !LOOPBACK_CAPS.includes(k)) : ALL_CAPS));
  const hostState: Harness['host'] = { macosBuild: '25A000', macosVersionExtra: 'none', macosRestartPending: 'no', safariVersion: '19.0' };

  const makeApp = () => createAppService({
    repos,
    clock,
    ids,
    logger,
    scrubber,
    secretStore: store,
    surge: opts.surge ? opts.surge(fake) : fake,
    maintenanceSurge: fake,
    paths: { dataDir: dir, tmpDir: join(dir, 'tmp'), backupsDir: join(dir, 'backups'), homedir: join(dir, 'home') },
    surgeCliPath: null,
    demo: false,
    host: {
      macosBuild: async () => hostState.macosBuild,
      macosVersionExtra: async () => hostState.macosVersionExtra,
      macosRestartPending: async () => hostState.macosRestartPending,
      safariVersion: async () => hostState.safariVersion,
      signingIdentity: () => 'TEAMTEST01',
      processPathExists: () => true,
      // 版本与构建号的来源：FakeSurge 模拟的运行实例（h.fake.version/build/instanceFailure）
      ...(opts.surgeInstance === false ? {} : { surgeInstance: () => fake.runningInstance() }),
    },
    verifyEndpoints: [TEST_ENDPOINT],
    loginUrl: () => ({ url: 'http://127.0.0.1:61847/auth/exchange?code=x', expiresAt: clock.now().toISOString() }),
    serviceVersion: '0.0.0-test',
    resourceBinder: binder,
    resourceUpdateWait: opts.resourceUpdateWait ?? { timeoutMs: 0, pollMs: 0, settleMs: 0 },
    ...(opts.resourceAuditToleranceMs !== undefined ? { resourceAuditToleranceMs: opts.resourceAuditToleranceMs } : {}),
    // 入口规则集的监视等待用真实定时器：假 Surge 的监视延迟为 0，见证在第一次读取时即命中；撤销入口的退路按时限等满
    rulesetWatch: opts.rulesetWatch ?? { timeoutMs: 40, pollMs: 10 },
    ...(opts.livenessPrimitive === 'auto' ? {} : { livenessPrimitive: opts.livenessPrimitive === undefined ? 'getCurrentProfile' : opts.livenessPrimitive }),
  });
  const events: ServiceEvent[] = [];
  const attach = (a: EngineAppService) =>
    a.events.subscribe((e) => {
      events.push(e);
    });
  /** 引擎得出的地址必须与夹具写进工作配置的相同（同一令牌与端口）；引擎尚未创建资源服务时为 null，不比较。 */
  const checkResourceUrl = (a: EngineAppService) => {
    const url = a.engine.resourceUrl();
    if (profileResourceUrl !== null && url !== null && url !== profileResourceUrl) throw new Error('harness: engine.resourceUrl() differs from the working profile');
  };
  let app = makeApp();
  ref.app = app;
  attach(app);
  const responses: unknown[] = [];
  if (opts.start !== false) {
    await app.start();
    checkResourceUrl(app);
  }
  const h: Harness = {
    dir,
    surgeDir,
    profilePath,
    fake,
    store,
    clock,
    repos,
    app,
    files,
    logs: mem.lines,
    events,
    responses,
    frontId,
    host: hostState,
    nodeResource,
    binder,
    binderRegistry,
    resourcePort: RESOURCE_TEST_PORT,
    resourceUrl: () => app.engine.resourceUrl(),
    resourceKey() {
      const url = app.engine.resourceUrl();
      return url === null ? null : fake.resourceKeyFor(url);
    },
    profileResourceUrl,
    resourceFault(next, faultOpts = {}) {
      const times = faultOpts.times ?? Number.POSITIVE_INFINITY;
      if (!(times === Number.POSITIVE_INFINITY || (Number.isSafeInteger(times) && times > 0))) throw new RangeError('resourceFault: times must be a positive integer');
      fault.current = next;
      fault.remaining = next === null ? 0 : times;
    },
    resourceRequests,
    grant,
    revoke,
    async crash() {
      // 旧实例的执行器可能挂在一次 Surge 调用上：只停止计时器，不等待
      void app.stop();
      // 进程退出时监听随之关闭：新实例才能在同一端口监听（virtualBinder 的端口独占）
      await app.engine.resource?.close();
      app = makeApp();
      ref.app = app;
      attach(app);
      h.app = app;
      await app.start();
      checkResourceUrl(app);
      return app;
    },
    async native(profileId, message) {
      const r = await app.handleNative({ v: NATIVE_PROTOCOL_VERSION, bridge: { profileId, bridgeVersion: 'test' }, message });
      responses.push(r);
      return r;
    },
    async record(p) {
      try {
        const v = await p;
        responses.push(v);
        return v;
      } catch (err) {
        responses.push(err);
        throw err;
      }
    },
    idle: () => app.idle(),
    async close() {
      await Promise.race([app.stop(), new Promise((r) => setTimeout(r, 200))]);
      // 与 main.ts 相同：执行器停止之后关闭资源服务
      await app.engine.resource?.close().catch(() => undefined);
      try {
        repos.db.close();
      } catch {
        // 已关闭
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return h;
}

let seq = 0;
export function rid(prefix = 'req'): string {
  seq += 1;
  return `${prefix}-${seq}-${Math.random().toString(36).slice(2, 8)}`;
}

export function envInput(name: string, host: string, extra: Partial<EnvironmentInput> & { username?: string; password?: string; accountPassword?: string; login?: string } = {}): EnvironmentInput {
  const { username, password, accountPassword, login, ...rest } = extra;
  return {
    displayName: name,
    site: 'US',
    autoOpenOrders: true,
    autoFillLogin: false,
    ...rest,
    proxy: {
      protocol: 'socks5',
      host,
      port: 1080,
      frontProxyId: null,
      ...(username ? { username: { action: 'replace' as const, value: username } } : {}),
      ...(password ? { password: { action: 'replace' as const, value: password } } : {}),
      ...(rest.proxy ?? {}),
    },
    account: { label: null, loginIdentifier: login ?? null, ...(accountPassword ? { password: { action: 'replace' as const, value: accountPassword } } : {}), ...(rest.account ?? {}) },
  };
}

export async function createEnv(h: Harness, name: string, host: string, extra: Parameters<typeof envInput>[2] = {}): Promise<Accepted> {
  const a = await h.record(h.app.createEnvironment({ request_id: rid('create'), environment: envInput(name, host, extra) }, WEB));
  await h.idle();
  return a;
}

export async function bind(h: Harness, profileId: string, envId: string): Promise<void> {
  const env = h.repos.environments.get(envId)!;
  const r = await h.native(profileId, { type: 'bindCurrentProfile', request_id: rid('bind'), environment_id: envId, expected_revision: env.revision });
  if (!r.ok) throw new Error(`bind failed: ${r.error.code} ${r.error.message}`);
}

/** 准备页：到达 → 签发检测编号；Safari 访问检测服务（经 FakeSurge 规则）→ 提交。 */
export async function verify(
  h: Harness,
  profileId: string,
  operationId: string,
  opts: { observedIp?: string; amazonTabs?: boolean; simulate?: boolean; httpStatus?: number } = {},
): Promise<NativeResponse> {
  const begin = await h.native(profileId, { type: 'beginSafariVerification', operation_id: operationId, amazon_tabs_open: opts.amazonTabs ?? false });
  if (!begin.ok) return begin;
  const data = begin.data as { status: string; test_id?: string; route_epoch?: number };
  if (data.status !== 'ready') return begin;
  const started = h.clock.now().toISOString();
  if (opts.simulate !== false) h.fake.simulateRequest({ processPath: FAKE_SAFARI_PATH, host: FAKE_VERIFY_HOST, protocol: 'tcp' });
  const finished = h.clock.now().toISOString();
  const r = await h.native(profileId, {
    type: 'submitSafariVerification',
    operation_id: operationId,
    test_id: data.test_id!,
    route_epoch: data.route_epoch!,
    observed_ip: opts.observedIp ?? '192.0.2.50',
    http_status: opts.httpStatus ?? 200,
    error: null,
    started_at: started,
    finished_at: finished,
  });
  await h.idle();
  return r;
}

/** 完整流程：创建 → 发布 → 关联 → 激活 → 实测，返回环境 id 与激活操作 id。 */
export async function activeEnv(h: Harness, name: string, host: string, profileId: string, extra: Parameters<typeof envInput>[2] = {}): Promise<{ envId: string; opId: string }> {
  const a = await createEnv(h, name, host, extra);
  const envId = a.environment_id!;
  await bind(h, profileId, envId);
  const route = h.repos.routeState.get();
  const act = await h.record(
    h.app.activate(envId, route.activeEnvironmentId && route.activeEnvironmentId !== envId ? { request_id: rid('act'), old_session_policy: 'closed_confirmed', confirmed_environment_id: route.activeEnvironmentId } : { request_id: rid('act') }, WEB),
  );
  await h.idle();
  const r = await verify(h, profileId, act.operation_id);
  if (!r.ok) throw new Error(`verify failed: ${r.error.code} ${r.error.message}`);
  const op = h.repos.operations.get(act.operation_id)!;
  if (op.phase !== 'ACTIVE_VERIFIED') throw new Error(`activation ended at ${op.phase}: ${JSON.stringify(op.error)}`);
  return { envId, opId: act.operation_id };
}

/** 模拟 Safari 与 Chrome 请求在当前已加载规则下的去向。 */
/**
 * 入口规则集文件的写入痕迹：四个 sfe-entry-*.list 的内容与文件监视重新加载它们的次数。ruleset_resource 的入口写入是
 * 原子写入文件、由 Surge 的文件监视生效，从不经 updateExternalResource——只数适配器写原语的“从不写 Surge”断言看不到它们。
 */
export function entryWrites(fake: FakeSurge): { entryFiles: Record<string, string | null>; entryReloads: number } {
  const read = (name: string): string | null => {
    try {
      return readFileSync(join(fake.directory, name), 'utf8');
    } catch {
      return null;
    }
  };
  return {
    entryFiles: Object.fromEntries(Object.values(ENTRY_RULESET_FILES).map((name) => [name, read(name)])),
    entryReloads: fake.watcherReloads.filter((r) => r.key.startsWith('ruleset:sfe-entry-')).length,
  };
}

export function safariOutcome(h: Harness, host = 'www.example.test', protocol: 'tcp' | 'udp' = 'tcp') {
  return h.fake.simulateRequest({ processPath: FAKE_SAFARI_PATH, host, protocol });
}

/** 日常路径不应调用的原语。 */
export const FORBIDDEN_DAILY = ['reloadProfile'];

/**
 * 让某个处理器中的下一次 SFE-ROUTE 成员读取失败一次（frame 为该处理器函数名，例如 checkSwitchPreconditions、
 * rollbackActivation）。D10 的节点资源检查（checkNodeResource）在对账与切换前同样读成员、但读不到时不下结论，failNext 会被它
 * 先消耗：按调用栈只让目标处理器自己的那一次读取失败。
 */
export function failMembersReadOnceIn(h: Harness, frame: string): { fired: () => boolean } {
  const fake = h.fake;
  const orig = fake.getGroupMembers.bind(fake);
  let fired = false;
  fake.getGroupMembers = async (group: string) => {
    const stack = new Error().stack ?? '';
    if (!fired && stack.includes(frame) && !stack.includes('checkNodeResource')) {
      fired = true;
      fake.getGroupMembers = orig;
      throw new SfeError('SURGE_COMMAND_FAILED', '调用 Surge 失败：模拟失败');
    }
    return orig(group);
  };
  return { fired: () => fired };
}
