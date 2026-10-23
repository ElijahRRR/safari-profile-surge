// sfe-service 组装根（docs/ARCHITECTURE.md §3、§10、§11）：版本断言 → 配置 → 日志与脱敏 → 旧版数据目录检查（使用钥匙串的
// 旧版数据目录在迁移之前 fail closed，不改动数据库）→ 迁移 → 秘密存储（本机数据库，不使用钥匙串）→
// Surge 适配（按原语固定实现；演示模式为 FakeSurge）→ AppService 启动（对账、恢复、执行器）→ HTTP、原生桥、
// agent/maintenance 套接字。收到 SIGINT/SIGTERM 时只关闭监听与执行器，从不改变 Surge 的入口或选择。

import { randomBytes } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SfeError } from '@sfe/contract';
import { loadConfig, type ServiceConfig } from './config.js';
import { createRepositories, openDatabase, type Repositories } from './db/index.js';
import { createAppService, type EngineAppService } from './engine/app-service.js';
import { STAGED_CRYPTEX_PATH, pathPresence, restartPendingFrom, versionExtraFromSwVers } from './engine/capabilities.js';
import type { HostInfo } from './engine/context.js';
import { createHttpServer, type HttpServerHandle } from './http/server.js';
import { issueLoginUrl } from './http/login.js';
import { createSessionStore } from './http/sessions.js';
import { createAdminServer, type AdminServerHandle } from './ipc/admin-server.js';
import { createBridgeServer, type BridgeServerHandle } from './ipc/bridge-server.js';
import { createBridgeTokenSource, readBridgeTokenFile } from './ipc/bridge-token.js';
import type { Logger, MaintenanceSurge, SecretStore, SurgeAdapter } from './ports.js';
import { LEGACY_KEYCHAIN_DATA_MESSAGE, LocalSecretStore, assertNoLegacyKeychainData } from './secrets/local-store.js';
import { createCliAdapter, defaultCodesignRunner, verifyCliPath } from './surge/cli-adapter.js';
import { createCompositeAdapter } from './surge/composite.js';
import { createHttpAdapter, parseHttpApiLine } from './surge/http-adapter.js';
import { SERVICE_CODESIGN_TIMEOUT_MS, createDefaultSurgeInstanceReader } from './surge/running-instance.js';
import { capabilityUnverified, SURGE_PRIMITIVES, type MechanismMap } from './surge/primitives.js';
import { DEMO_RESOURCE_RELOAD_WAIT, DEMO_RULESET_WATCH, createDemoSurge, prepareDemoState, seedDemoData } from './demo/index.js';
import { systemClock } from './util/clock.js';
import { execFixed } from './util/exec-fixed.js';
import { createIdGenerator } from './util/ids.js';
import { createLogger, fileSink, type FileSink } from './util/logger.js';
import { createScrubber } from './util/scrubber.js';
import { createExclusivePrivateFile, ensurePrivateDirSync } from './util/secure-files.js';
import { loadPepper } from './secrets/pepper.js';

export const SERVICE_VERSION = '0.1.0';

export interface StartOptions {
  argv: string[];
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  homedir: string;
  cwd: string;
  /** 日志额外输出（测试用）；缺省只写日志文件。 */
  extraLogSink?: (line: string) => void;
  /** 演示模式是否写入合成数据（默认 true）。 */
  seedDemo?: boolean;
  /** 是否启动原生桥（默认非演示模式启动；演示模式使用 /dev/native）。 */
  bridge?: boolean;
}

export interface RunningService {
  config: ServiceConfig;
  app: EngineAppService;
  repos: Repositories;
  http: HttpServerHandle;
  url: string;
  bridge: BridgeServerHandle | null;
  admin: AdminServerHandle[];
  stop(): Promise<void>;
}

/** 断言 Node 版本等于打包版本（安装配置中有记录时）以及 node:sqlite 可用。 */
export function assertRuntime(pin: string | null, version = process.version): void {
  if (pin) {
    const want = pin.startsWith('v') ? pin : `v${pin}`;
    if (version !== want) throw new SfeError('INTERNAL', `启动失败：Node 版本 ${version} 与打包版本 ${want} 不一致`);
  }
  const [major, minor] = version.replace(/^v/, '').split('.').map(Number);
  if ((major ?? 0) < 22 || ((major ?? 0) === 22 && (minor ?? 0) < 13)) throw new SfeError('INTERNAL', '启动失败：需要 Node 22.13 或更新版本（node:sqlite）');
}

const unavailableMaintenance: MaintenanceSurge = {
  // 本仓库的 CLI/HTTP 实现都没有提供重载原语：维护重载保持不可用，直到 P0 确认并实现
  reloadProfile: async () => {
    throw capabilityUnverified('reloadProfile');
  },
};

async function execText(file: string, args: string[]): Promise<string> {
  const r = await execFixed(file, args, { timeout: 10_000 });
  if (r.error) throw r.error;
  return r.stdout.trim();
}

/** `sw_vers -productVersionExtra` → 补充版本（与 P0 同一规则；退出码非 0 或启动失败按读不到）。 */
async function macosVersionExtra(): Promise<string | null> {
  const r = await execFixed('/usr/bin/sw_vers', ['-productVersionExtra'], { timeout: 10_000 });
  return versionExtraFromSwVers({ code: r.error ? -1 : 0, stdout: r.stdout });
}

/** 非演示模式的本机事实（导出只为测试接线）。 */
export function macHost(platform: NodeJS.Platform): Partial<HostInfo> {
  if (platform !== 'darwin') {
    return {
      macosBuild: async () => 'unknown',
      macosVersionExtra: async () => 'unknown',
      macosRestartPending: async () => 'unknown',
      safariVersion: async () => 'unknown',
      surgeInstance: async () => ({ ok: false, reason: 'not_darwin' }),
    };
  }
  // 运行中 Surge 的版本：一个常驻的读取器（缓存包信息与签名结果，同时到来的读取共用一次）；Team ID 未知，与 CLI 路径校验
  // 一致只做 --verify --strict；codesign 用较短的服务超时（读取在执行器通道上进行，引擎另有总时限）
  const instance = createDefaultSurgeInstanceReader({ platform, uid: process.getuid?.() ?? -1, teamId: null, codesignTimeoutMs: SERVICE_CODESIGN_TIMEOUT_MS });
  return {
    surgeInstance: () => instance.read(),
    macosBuild: async () => (await execText('/usr/bin/sw_vers', ['-buildVersion'])) || null,
    macosVersionExtra,
    // 暂存的加密卷宗存在 → 已安装的后台安全改进要重启才完全生效（TODO(P0)：暂存位置是测试 Mac 上的观察，见 STAGED_CRYPTEX_PATH）
    macosRestartPending: async () => restartPendingFrom(await pathPresence(STAGED_CRYPTEX_PATH)),
    safariVersion: async () => (await execText('/usr/bin/defaults', ['read', '/Applications/Safari.app/Contents/Info', 'CFBundleShortVersionString'])) || null,
    processPathExists: (p) => {
      try {
        realpathSync(p);
        return true;
      } catch {
        return false;
      }
    },
  };
}

async function buildRealSurge(config: ServiceConfig, repos: Repositories, logger: Logger, scrub: (s: string) => string): Promise<SurgeAdapter> {
  const mechanism: MechanismMap = {};
  for (const p of SURGE_PRIMITIVES) mechanism[p] = config.adapterMechanism[p] ?? 'unavailable';
  let cli: SurgeAdapter | undefined;
  if (config.surgeCliPath && Object.values(mechanism).includes('cli')) {
    const v = await verifyCliPath(config.surgeCliPath, { realpath, runCodesign: defaultCodesignRunner, teamId: null, platform: config.platform });
    if (v.ok) cli = createCliAdapter({ cliPath: config.surgeCliPath, mechanism, scrub });
    else logger.log('error', 'surge.cli_unverified', { reason: v.reason });
  }
  let http: SurgeAdapter | undefined;
  const workingProfile = repos.settings.get('workingProfilePath');
  if (workingProfile && Object.values(mechanism).includes('http')) {
    try {
      const api = parseHttpApiLine(readFileSync(workingProfile, 'utf8'));
      if (api && api.loopbackOnly) {
        http = createHttpAdapter({
          baseUrl: `http://127.0.0.1:${api.port}`,
          // 密钥在每次调用时从工作配置读取，不落库
          getKey: async () => {
            const cur = parseHttpApiLine(readFileSync(workingProfile, 'utf8'));
            if (!cur || !cur.loopbackOnly) throw new SfeError('CAPABILITY_UNVERIFIED', '调用 Surge 失败：工作配置中的 HTTP API 不是只监听回环地址');
            return cur.key;
          },
          mechanism,
          scrub,
        });
      } else if (api) logger.log('error', 'surge.http_not_loopback');
    } catch {
      logger.log('warn', 'surge.http_unavailable');
    }
  }
  const parts: Parameters<typeof createCompositeAdapter>[0] = { mechanism };
  if (cli) parts.cli = cli;
  if (http) parts.http = http;
  return createCompositeAdapter(parts);
}

/**
 * 启动服务。启动期间持有一个引用的定时器，直到监听建立：系统时钟的定时器都 unref（服务存活由 HTTP/IPC 监听维持，见
 * util/clock.ts），监听建立之前的等待（例如演示数据经真实流程发布时等待 Surge 重新读取节点资源）若只剩这些定时器，
 * 事件循环会提前排空，`void main()` 结束、进程无输出地以 0 退出。
 */
export async function startService(opts: StartOptions): Promise<RunningService> {
  const startupHold = setInterval(() => undefined, 60_000);
  try {
    return await startServiceHeld(opts);
  } finally {
    clearInterval(startupHold);
  }
}

async function startServiceHeld(opts: StartOptions): Promise<RunningService> {
  const config = loadConfig({ argv: opts.argv, env: opts.env, platform: opts.platform, homedir: opts.homedir, cwd: opts.cwd });
  assertRuntime(config.nodeVersionPin);
  ensurePrivateDirSync(config.dataDir);
  ensurePrivateDirSync(config.tmpDir);
  ensurePrivateDirSync(config.backupsDir);

  const scrubber = createScrubber();
  const sink: FileSink = fileSink(config.logFile);
  const logger = createLogger({
    sink: (line) => {
      sink(line);
      opts.extraLogSink?.(line);
    },
    scrubber,
  });
  for (const issue of config.installConfigIssues) logger.log('warn', 'config.install_issue', { issue });
  const ids = createIdGenerator();
  const clock = systemClock;
  const db = openDatabase(config.databasePath);
  if (!config.demo) {
    // 旧版（钥匙串）数据目录：在迁移之前拒绝启动，拒绝时数据库保持旧版本的结构（装回旧版本仍能打开它、进入普通模式；
    // 旧服务需要的 install.json keychainHelperPath 由宿主 App 合并时保留）；
    // 也在加载 pepper、清扫引用或接受任何请求之前。从不读取钥匙串迁移。launchd 丢弃 stderr，所以中文说明也写进日志
    try {
      assertNoLegacyKeychainData(db);
    } catch (err) {
      if (err instanceof SfeError && err.details?.reason === 'legacy_keychain_data') {
        logger.log('error', 'secrets.legacy_keychain_data', {
          pepperMissing: err.details.pepperMissing === true,
          missingCommittedRefs: err.details.missingCommittedRefs ?? null,
          message: LEGACY_KEYCHAIN_DATA_MESSAGE,
        });
      }
      db.close();
      sink.close();
      throw err;
    }
  }
  db.migrate();
  const repos = createRepositories(db, { clock, ids, scrubber });

  let store: SecretStore;
  let surge: SurgeAdapter;
  let maintenance: MaintenanceSurge = unavailableMaintenance;
  let demoSurge: ReturnType<typeof createDemoSurge> | null = null;
  if (config.demo) {
    demoSurge = createDemoSurge(config.dataDir);
    store = demoSurge.store;
    surge = demoSurge.fake;
    maintenance = demoSurge.fake;
    const pepper = await loadPepper(store, repos.meta, ids);
    await prepareDemoState(repos, demoSurge, pepper);
  } else {
    store = new LocalSecretStore({ db: repos.db, clock, scrubber });
    surge = await buildRealSurge(config, repos, logger, (s) => scrubber.scrub(s));
  }

  const sessions = createSessionStore(repos.db.raw, { now: () => clock.now(), random: (n) => randomBytes(n) });
  let http: HttpServerHandle | null = null;
  const app = createAppService({
    repos,
    clock,
    ids,
    logger,
    scrubber,
    secretStore: store,
    surge,
    maintenanceSurge: maintenance,
    paths: { dataDir: config.dataDir, tmpDir: config.tmpDir, backupsDir: config.backupsDir, homedir: config.homedir },
    surgeCliPath: config.surgeCliPath,
    demo: config.demo,
    host: config.demo
      ? {
          macosBuild: async () => 'demo',
          macosVersionExtra: async () => 'demo',
          macosRestartPending: async () => 'no',
          safariVersion: async () => 'demo',
          processPathExists: () => true,
          surgeInstance: () => demoSurge!.fake.runningInstance(),
        }
      : macHost(config.platform),
    loginUrl: () => {
      if (!http) throw new SfeError('INTERNAL', '签发登录链接失败：网页服务尚未启动');
      return issueLoginUrl(sessions, http);
    },
    serviceVersion: SERVICE_VERSION,
    // 演示的等待按演示 FakeSurge 的监视延迟轮询（演示专用；真实 Surge 用缺省值，TODO(P0) 按实测设定）
    ...(demoSurge ? { demoHooks: demoSurge.hooks, resourceReloadWait: DEMO_RESOURCE_RELOAD_WAIT, rulesetWatch: DEMO_RULESET_WATCH } : {}),
  });
  await app.start();
  if (demoSurge && opts.seedDemo !== false) {
    try {
      await seedDemoData(app, demoSurge);
    } catch (err) {
      logger.log('error', 'demo.seed_failed', { error: err instanceof Error ? err.message : 'unknown' });
    }
  }

  http = createHttpServer({
    app,
    sessions,
    port: config.httpPort,
    webRoot: config.webRoot,
    demo: config.demo,
    extensionHarnessRoot: config.extensionHarnessRoot,
    logger,
    serviceVersion: SERVICE_VERSION,
  });
  const { url } = await http.listen();

  let bridge: BridgeServerHandle | null = null;
  if (opts.bridge ?? !config.demo) {
    // 启动时文件不安全则拒绝启动；不存在时新建（宿主 App 之后会用 App Group 中的令牌覆盖它）。
    if (readBridgeTokenFile(config.bridge.tokenFile).kind === 'missing') {
      await createExclusivePrivateFile(config.bridge.tokenFile, `${ids.token(32)}\n`);
    }
    bridge = createBridgeServer({
      app,
      transport: config.bridge.transport === 'unix' ? { kind: 'unix', path: config.bridge.path } : { kind: 'tcp', host: '127.0.0.1', port: config.bridge.port },
      // 每个连接重新检查令牌文件：宿主 App 运行期间改写令牌后无需重启服务
      token: createBridgeTokenSource(config.bridge.tokenFile, {
        onChange: (state) => (state === 'loaded' ? logger.log('info', 'bridge.token_loaded') : logger.log('warn', 'bridge.token_unavailable', { issue: state })),
      }),
      logger,
    });
    await bridge.listen();
  }

  const admin = [
    createAdminServer({ app, path: config.agentSocketPath, role: 'agent', logger }),
    createAdminServer({ app, path: config.maintenanceSocketPath, role: 'maintenance', logger }),
  ];
  for (const a of admin) await a.listen();
  logger.log('info', 'service.started', { demo: config.demo, url });

  let stopping: Promise<void> | null = null;
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      // 只关闭监听与执行器：从不改变 Surge 的入口状态或 SFE-ROUTE 选择
      for (const a of admin) await a.close().catch(() => undefined);
      await bridge?.close().catch(() => undefined);
      await http?.close().catch(() => undefined);
      await app.stop();
      logger.log('info', 'service.stopped');
      repos.db.close();
      sink.close();
    })();
    return stopping;
  };
  return { config, app, repos, http, url, bridge, admin, stop };
}

async function main(): Promise<void> {
  let service: RunningService;
  try {
    service = await startService({ argv: process.argv.slice(2), env: process.env, platform: process.platform, homedir: homedir(), cwd: process.cwd() });
  } catch (err) {
    const message = err instanceof SfeError ? err.message : '启动失败：内部错误';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${service.config.demo ? '演示模式：' : ''}本机管理服务已启动 ${service.url}\n`);
  if (service.config.demo) process.stdout.write(`演示数据目录：${join(service.config.dataDir)}\n`);
  const shutdown = () => {
    void service.stop().then(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) void main();
