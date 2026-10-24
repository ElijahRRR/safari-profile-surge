// 引擎测试夹具：FakeSurge（合成工作配置）+ 内存秘密存储 + 可控时钟 + 内存日志。只用合成数据：
// 文档地址（203.0.113.0/24 等）、example.test 账号与检测主机。能力记录在夹具中直接写入（测试专用）。

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CAPABILITY_CONTEXT_FIELDS,
  CAPABILITY_KEYS,
  ENTRY_RULESET_FILES,
  NATIVE_PROTOCOL_VERSION,
  WORKING_PROFILE_NAME,
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
import type { LivenessPrimitive } from '../../src/engine/context.js';
import { registerInitialObjects } from '../../src/engine/ownership.js';
import { MemorySecretStore } from '../../src/secrets/memory-store.js';
import { loadPepper, pepperKey } from '../../src/secrets/pepper.js';
import { FAKE_SAFARI_PATH, FAKE_VERIFY_HOST, FakeSurge, createFakeSurgeEnvironment } from '../../src/surge/fake.js';
import { createProfileFiles, type ManagedProfileFiles } from '../../src/surge/files.js';
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

export interface HarnessOptions {
  capabilities?: readonly CapabilityKey[];
  entryStrategy?: 'ruleset_resource' | 'temp_rule';
  dbFile?: boolean;
  autoReload?: boolean;
  /** 读回不完整的覆盖声明（写进三项能力的说明）。 */
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
  /**
   * 发布写入本地节点资源后等待 Surge 重新读取的时限与轮询间隔。缺省 { timeoutMs: 0 }：只读一次（FakeClock 不会自动推进，
   * 非零时限的测试需要自己推进时钟）；FakeSurge 的监视延迟缺省为 0，写入后的下一次调用即重新读取。
   */
  resourceReloadWait?: { timeoutMs: number; pollMs: number };
  rulesetWatch?: { timeoutMs: number; pollMs: number };
  /**
   * FakeSurge 是否监视本地 policy-path 文件（文档未说明，需 P0 实测）。缺省跟随 policy_path_reread 能力记录：
   * 夹具授予该能力时打开、撤销时关闭（h.grant/h.revoke 同样跟随）；显式给出时固定为该值，用于“记录说支持、Surge 却没有
   * 重新读取”的情形。
   */
  watchLocalPolicyPaths?: boolean;
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
  /** 模拟服务崩溃：旧实例放弃（不等待其挂起的写入），在同一数据库与 FakeSurge 上启动新实例。 */
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
  let profilePath: string;
  if (opts.sourceProfile !== undefined) {
    mkdirSync(surgeDir, { recursive: true, mode: 0o700 });
    profilePath = join(surgeDir, 'Daily.conf');
    writeFileSync(profilePath, opts.sourceProfile, { mode: 0o600 });
  } else {
    profilePath = createFakeSurgeEnvironment(surgeDir, { entryStrategy: strategy, processPaths: [FAKE_SAFARI_PATH], verifyHost: FAKE_VERIFY_HOST, ...(opts.userRules ? { userRules: opts.userRules } : {}) }).profilePath;
  }
  const clock = new FakeClock('2026-10-21T00:00:00.000Z');
  const fake = new FakeSurge({
    directory: surgeDir,
    now: () => clock.now(),
    autoReload: opts.autoReload ?? false,
    tempRuleInsertion: 'tail',
    ...(opts.sourceProfile !== undefined ? { profileFileName: 'Daily.conf' } : {}),
  });
  // 本地 policy-path 监视只与 policy_path_reread 记录一起打开（演示与测试专用的假设，不代表真实 Surge）
  const followWatch = (keys: readonly CapabilityKey[], on: boolean) => {
    if (opts.watchLocalPolicyPaths === undefined && keys.includes('policy_path_reread')) fake.watchLocalPolicyPaths = on;
  };
  if (opts.watchLocalPolicyPaths !== undefined) fake.watchLocalPolicyPaths = opts.watchLocalPolicyPaths;
  const scrubber = createScrubber();
  const mem = createMemorySink();
  const logger = createLogger({ sink: mem.sink, scrubber, level: 'debug', now: () => clock.now() });
  const ids = createIdGenerator({ now: () => clock.now().getTime() });
  const repos = openRepositories(opts.dbFile ? join(dir, 'sfe.sqlite') : ':memory:', { clock, ids, scrubber });
  const store = new MemorySecretStore();
  repos.tx(() => {
    if (opts.sourceProfile === undefined) {
      repos.settings.set('workingProfilePath', profilePath);
      repos.settings.set('workingProfileName', WORKING_PROFILE_NAME);
    }
    repos.settings.set('entryStrategy', strategy);
    repos.settings.set('safariProcessPaths', [FAKE_SAFARI_PATH]);
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
      const covers = opts.readbackCovers && ['policy_path_reread', 'targeted_resource_refresh', 'external_node_underlying_proxy'].includes(key);
      repos.capabilities.upsert({
        key,
        status: 'supported',
        context: instanceContext(fake),
        verifiedAt: clock.now().toISOString(),
        note: note ?? (covers ? 'readback-covers: server, port, underlying-proxy' : '测试记录'),
      });
    }
    followWatch(keys, true);
  };
  const revoke = (keys: readonly CapabilityKey[]) => {
    for (const key of keys) repos.capabilities.upsert({ key, status: 'unverified' });
    followWatch(keys, false);
  };
  grant(opts.capabilities ?? ALL_CAPS);
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
    resourceReloadWait: opts.resourceReloadWait ?? { timeoutMs: 0, pollMs: 0 },
    // 入口规则集的监视等待用真实定时器：假 Surge 的监视延迟为 0，见证在第一次读取时即命中；撤销入口的退路按时限等满
    rulesetWatch: opts.rulesetWatch ?? { timeoutMs: 40, pollMs: 10 },
    ...(opts.livenessPrimitive === 'auto' ? {} : { livenessPrimitive: opts.livenessPrimitive === undefined ? 'getCurrentProfile' : opts.livenessPrimitive }),
  });
  const events: ServiceEvent[] = [];
  const attach = (a: EngineAppService) =>
    a.events.subscribe((e) => {
      events.push(e);
    });
  let app = makeApp();
  attach(app);
  const responses: unknown[] = [];
  if (opts.start !== false) await app.start();
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
    grant,
    revoke,
    async crash() {
      // 旧实例的执行器可能挂在一次 Surge 调用上：只停止计时器，不等待
      void app.stop();
      app = makeApp();
      attach(app);
      h.app = app;
      await app.start();
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
