// 服务配置（docs/ARCHITECTURE.md §3、§10、§11）。数据目录、套接字、端口，以及只来自 0600 安装配置
// （<数据目录>/install.json）的 Surge CLI 路径、钥匙串工具路径与原语实现清单。
// 演示模式使用新建的临时数据目录，从不读取安装配置，也就拿不到真实 Surge 路径。

import { closeSync, constants as fsConstants, fstatSync, mkdtempSync, openSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { DEFAULT_HTTP_PORT, SfeError } from '@sfe/contract';
import { assertUnixSocketPathLength, classifyDirectoryRisk, isInsideGitWorkTree } from './util/secure-files.js';

export const DEFAULT_BRIDGE_PORT = 61848;
export const APP_DIR_NAME_DARWIN = 'SafariProfileSurge';
export const APP_DIR_NAME_XDG = 'safari-profile-surge';
const MAX_INSTALL_CONFIG_BYTES = 64 * 1024;

/** SurgeAdapter 上的全部原语（ports.ts），每个固定到一种实现。 */
export const SURGE_ADAPTER_PRIMITIVES = [
  'getVersion',
  'getRuntimeInfo',
  'getCurrentProfile',
  'getTakeoverState',
  'getAutoReloadSetting',
  'checkProfile',
  'listPolicies',
  'getPolicyDetail',
  'getGroupMembers',
  'getGroupSelection',
  'selectGroupPolicy',
  'testPolicy',
  'listRules',
  'listActiveRequests',
  'listRecentRequests',
  'killRequest',
  'listExternalResources',
  'updateExternalResource',
  'listTempRules',
  'addTempRule',
  'removeTempRule',
] as const;
/** 只在 MaintenanceSurge 上的原语。 */
export const MAINTENANCE_PRIMITIVES = ['reloadProfile'] as const;
export const ALL_SURGE_PRIMITIVES = [...SURGE_ADAPTER_PRIMITIVES, ...MAINTENANCE_PRIMITIVES] as const;
export type SurgePrimitive = (typeof ALL_SURGE_PRIMITIVES)[number];
export type PrimitiveMechanism = 'cli' | 'http' | 'unavailable';

export type BridgeConfig =
  | { transport: 'tcp'; host: '127.0.0.1'; port: number; tokenFile: string }
  | { transport: 'unix'; path: string; tokenFile: string };

export interface ServiceConfig {
  platform: NodeJS.Platform;
  homedir: string;
  demo: boolean;
  dataDir: string;
  /** 含秘密的 --check 候选副本，用后即删。 */
  tmpDir: string;
  backupsDir: string;
  databasePath: string;
  logFile: string;
  agentSocketPath: string;
  maintenanceSocketPath: string;
  bridge: BridgeConfig;
  httpPort: number;
  /** 网页静态文件目录；null 表示不提供网页。 */
  webRoot: string | null;
  /** 只在演示模式下可用：扩展界面演示页的静态文件目录。 */
  extensionHarnessRoot: string | null;
  installConfigPath: string;
  /** 只来自 0600 安装配置；其他情况为 null。 */
  surgeCliPath: string | null;
  keychainHelperPath: string | null;
  nodeVersionPin: string | null;
  adapterMechanism: Record<SurgePrimitive, PrimitiveMechanism>;
  /** 安装配置被忽略或部分字段无效的原因（简体中文，不含配置内容）。 */
  installConfigIssues: string[];
}

export interface LoadConfigOptions {
  /** 不含 node 与脚本路径（process.argv.slice(2)）。 */
  argv: string[];
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  homedir: string;
  cwd: string;
}

interface ParsedArgs {
  demo: boolean;
  dataDir: string | null;
  httpPort: number | null;
  webRoot: string | null;
  extensionHarnessRoot: string | null;
}

const VALUE_FLAGS = new Set(['--data-dir', '--http-port', '--web-root', '--extension-harness-root']);

function badArg(message: string): SfeError {
  return new SfeError('BAD_REQUEST', `启动失败：${message}`);
}

function parseArgs(argv: string[], cwd: string): ParsedArgs {
  const out: ParsedArgs = { demo: false, dataDir: null, httpPort: null, webRoot: null, extensionHarnessRoot: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--demo') {
      out.demo = true;
      continue;
    }
    const eq = arg.indexOf('=');
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    if (!VALUE_FLAGS.has(flag)) throw badArg(arg.startsWith('-') ? `未知参数 ${flag}` : '不接受位置参数');
    let value: string | undefined;
    if (eq !== -1) value = arg.slice(eq + 1);
    else value = argv[++i];
    if (value === undefined || value.length === 0) throw badArg(`参数 ${flag} 缺少值`);
    switch (flag) {
      case '--data-dir':
        out.dataDir = resolve(cwd, value);
        break;
      case '--http-port':
        out.httpPort = parsePort(value, flag, true);
        break;
      case '--web-root':
        out.webRoot = resolve(cwd, value);
        break;
      case '--extension-harness-root':
        out.extensionHarnessRoot = resolve(cwd, value);
        break;
    }
  }
  return out;
}

/** allowZero：0 表示由系统分配端口（测试用）。 */
function parsePort(value: string | number, label: string, allowZero: boolean): number {
  const n = typeof value === 'number' ? value : /^\d{1,5}$/.test(value) ? Number(value) : NaN;
  if (!Number.isInteger(n) || n > 65535 || n < (allowZero ? 0 : 1)) throw badArg(`${label} 必须是 ${allowZero ? 0 : 1}–65535 的整数`);
  return n;
}

export function defaultDataDir(platform: NodeJS.Platform, homedir: string, env: NodeJS.ProcessEnv): string {
  if (platform === 'darwin') return join(homedir, 'Library', 'Application Support', APP_DIR_NAME_DARWIN);
  const xdg = env.XDG_DATA_HOME;
  if (xdg && isAbsolute(xdg)) return join(xdg, APP_DIR_NAME_XDG);
  return join(homedir, '.local', 'share', APP_DIR_NAME_XDG);
}

function defaultMechanisms(): Record<SurgePrimitive, PrimitiveMechanism> {
  return Object.fromEntries(ALL_SURGE_PRIMITIVES.map((p) => [p, 'unavailable'])) as Record<SurgePrimitive, PrimitiveMechanism>;
}

interface InstallConfig {
  surgeCliPath: string | null;
  keychainHelperPath: string | null;
  nodeVersionPin: string | null;
  adapterMechanism: Record<SurgePrimitive, PrimitiveMechanism>;
  bridge: { transport: 'tcp'; port: number } | { transport: 'unix'; path: string } | null;
  httpPort: number | null;
  webRoot: string | null;
  issues: string[];
}

function emptyInstallConfig(issues: string[] = []): InstallConfig {
  return { surgeCliPath: null, keychainHelperPath: null, nodeVersionPin: null, adapterMechanism: defaultMechanisms(), bridge: null, httpPort: null, webRoot: null, issues };
}

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

function absolutePathField(raw: Record<string, unknown>, key: string, issues: string[]): string | null {
  const v = raw[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || !isAbsolute(v) || CONTROL_RE.test(v)) {
    issues.push(`安装配置字段 ${key} 不是有效的绝对路径，已忽略`);
    return null;
  }
  return v;
}

/**
 * 读取安装配置：必须是属于当前用户、权限只有所有者可读写（无组/其他用户位）的普通文件（不跟随符号链接）。
 * 不满足时整份忽略并给出原因；字段无效时只忽略该字段。
 */
export function readInstallConfig(path: string): InstallConfig {
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return emptyInstallConfig();
    if (code === 'ELOOP') return emptyInstallConfig(['安装配置是符号链接，已忽略']);
    return emptyInstallConfig(['读取安装配置失败，已忽略']);
  }
  let text: string;
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return emptyInstallConfig(['安装配置不是普通文件，已忽略']);
    const uid = process.getuid?.();
    if (uid !== undefined && st.uid !== uid) return emptyInstallConfig(['安装配置不属于当前用户，已忽略']);
    if ((st.mode & 0o077) !== 0) return emptyInstallConfig(['安装配置权限不是 0600，已忽略']);
    if (st.size > MAX_INSTALL_CONFIG_BYTES) return emptyInstallConfig(['安装配置过大，已忽略']);
    text = readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return emptyInstallConfig(['安装配置不是有效的 JSON，已忽略']);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return emptyInstallConfig(['安装配置格式不正确，已忽略']);
  const obj = raw as Record<string, unknown>;
  const cfg = emptyInstallConfig();
  const issues = cfg.issues;
  cfg.surgeCliPath = absolutePathField(obj, 'surgeCliPath', issues);
  cfg.keychainHelperPath = absolutePathField(obj, 'keychainHelperPath', issues);
  cfg.webRoot = absolutePathField(obj, 'webRoot', issues);
  if (obj.nodeVersionPin !== undefined && obj.nodeVersionPin !== null) {
    if (typeof obj.nodeVersionPin === 'string' && /^v?\d+\.\d+\.\d+$/.test(obj.nodeVersionPin)) cfg.nodeVersionPin = obj.nodeVersionPin;
    else issues.push('安装配置字段 nodeVersionPin 格式不正确，已忽略');
  }
  if (obj.httpPort !== undefined && obj.httpPort !== null) {
    if (typeof obj.httpPort === 'number' && Number.isInteger(obj.httpPort) && obj.httpPort >= 1 && obj.httpPort <= 65535) cfg.httpPort = obj.httpPort;
    else issues.push('安装配置字段 httpPort 不是 1–65535 的整数，已忽略');
  }
  if (obj.adapterMechanism !== undefined && obj.adapterMechanism !== null) {
    if (typeof obj.adapterMechanism !== 'object' || Array.isArray(obj.adapterMechanism)) {
      issues.push('安装配置字段 adapterMechanism 格式不正确，已忽略');
    } else {
      const known = new Set<string>(ALL_SURGE_PRIMITIVES);
      for (const [k, v] of Object.entries(obj.adapterMechanism as Record<string, unknown>)) {
        if (!known.has(k)) {
          issues.push(`安装配置中的原语 ${k.slice(0, 64)} 不存在，已忽略`);
          continue;
        }
        if (k === 'getVersion' && v !== 'unavailable') {
          // 版本只来自运行中的 Surge 实例（surge/running-instance.ts）；Surge 6.5 的 surge-cli 没有版本命令
          // （--version 进入交互模式），HTTP 实现也没有。名字保留在原语清单中只为兼容旧的 install.json。
          issues.push('安装配置中的原语 getVersion 已不再使用（版本改由运行中的 Surge 实例读取），按不可用处理');
          continue;
        }
        if (v === 'cli' || v === 'http' || v === 'unavailable') cfg.adapterMechanism[k as SurgePrimitive] = v;
        else issues.push(`安装配置中原语 ${k} 的实现不正确，按不可用处理`);
      }
    }
  }
  if (obj.bridge !== undefined && obj.bridge !== null) {
    const b = obj.bridge as Record<string, unknown>;
    if (typeof b === 'object' && b.transport === 'tcp') {
      if (b.port === undefined) cfg.bridge = { transport: 'tcp', port: DEFAULT_BRIDGE_PORT };
      else if (typeof b.port === 'number' && Number.isInteger(b.port) && b.port >= 1 && b.port <= 65535) cfg.bridge = { transport: 'tcp', port: b.port };
      else issues.push('安装配置字段 bridge.port 不是 1–65535 的整数，已忽略');
    } else if (typeof b === 'object' && b.transport === 'unix') {
      const p = absolutePathField(b, 'path', issues);
      if (p) cfg.bridge = { transport: 'unix', path: p };
    } else {
      issues.push('安装配置字段 bridge 格式不正确，已忽略');
    }
  }
  return cfg;
}

export function loadConfig(opts: LoadConfigOptions): ServiceConfig {
  const args = parseArgs(opts.argv, opts.cwd);
  if (args.demo && args.dataDir) throw badArg('演示模式使用独立的临时数据目录，不能同时指定 --data-dir');
  if (!args.demo && args.extensionHarnessRoot) throw badArg('--extension-harness-root 只能在演示模式下使用');

  let dataDir: string;
  if (args.demo) {
    const base = opts.env.TMPDIR && isAbsolute(opts.env.TMPDIR) ? opts.env.TMPDIR : tmpdir();
    dataDir = mkdtempSync(join(base, 'sfe-demo-'));
  } else {
    dataDir = args.dataDir ?? defaultDataDir(opts.platform, opts.homedir, opts.env);
  }

  if (isInsideGitWorkTree(dataDir)) {
    throw new SfeError('UNSAFE_LOCATION', '启动失败：数据目录位于 Git 工作树内，可能把含凭据的备份提交到仓库', { details: { dataDir } });
  }
  const risk = classifyDirectoryRisk(dataDir, opts.homedir);
  if (risk !== 'none') {
    throw new SfeError(
      'UNSAFE_LOCATION',
      risk === 'synced' ? '启动失败：数据目录位于 iCloud 或云盘同步位置' : '启动失败：数据目录位于文稿、桌面或下载等受保护位置',
      { details: { dataDir, risk } },
    );
  }

  const installConfigPath = join(dataDir, 'install.json');
  const install = args.demo ? emptyInstallConfig() : readInstallConfig(installConfigPath);
  const tokenFile = join(dataDir, 'bridge.token');
  const bridge: BridgeConfig =
    install.bridge?.transport === 'unix'
      ? { transport: 'unix', path: install.bridge.path, tokenFile }
      : { transport: 'tcp', host: '127.0.0.1', port: install.bridge?.port ?? DEFAULT_BRIDGE_PORT, tokenFile };

  const agentSocketPath = join(dataDir, 'agent.sock');
  const maintenanceSocketPath = join(dataDir, 'maintenance.sock');
  assertUnixSocketPathLength(agentSocketPath);
  assertUnixSocketPathLength(maintenanceSocketPath);
  if (bridge.transport === 'unix') assertUnixSocketPathLength(bridge.path);

  return {
    platform: opts.platform,
    homedir: opts.homedir,
    demo: args.demo,
    dataDir,
    tmpDir: join(dataDir, 'tmp'),
    backupsDir: join(dataDir, 'backups'),
    databasePath: join(dataDir, 'sfe.sqlite'),
    logFile: join(dataDir, 'service.log'),
    agentSocketPath,
    maintenanceSocketPath,
    bridge,
    httpPort: args.httpPort ?? install.httpPort ?? DEFAULT_HTTP_PORT,
    webRoot: args.webRoot ?? install.webRoot,
    extensionHarnessRoot: args.demo ? args.extensionHarnessRoot : null,
    installConfigPath,
    surgeCliPath: install.surgeCliPath,
    keychainHelperPath: install.keychainHelperPath,
    nodeVersionPin: install.nodeVersionPin,
    adapterMechanism: install.adapterMechanism,
    installConfigIssues: install.issues,
  };
}
