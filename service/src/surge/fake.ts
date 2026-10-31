// 假 Surge：引擎测试与演示模式使用，按 Surge Mac 6.10.0 的文档语义建模（不代表任何网络事实）。工作配置从目录读取；
// “已加载状态”与文件分开：
// - updateExternalResource(key) 跳过本地资源，从不重新读取本地文件（HTTP API 文档：“Local resources are skipped.”），
//   本地资源没有更新时间（“Local resources have no `updatedAt` field.”），报告 local: true；
// - 远端资源（policy-path 与 RULE-SET 的 http(s) 地址）经 remoteSource 下载（缺省一律“连接被拒绝”：假 Surge 不访问网络；
//   测试夹具与演示把它接到本机资源服务的进程内绑定方，每次下载都经真实的 host.handle()）。按回环矩阵的真机证据建模
//   （docs/verification/2026-10-25-loopback-main-witness-matrix.md、2026-10-25-resource-error-classification.md）：
//   updateExternalResource(远端 key) 只下载这一项资源，从不重载配置（磁盘上改过、未加载的主配置不会因此被加载），不碰其他
//   资源；下载失败时保留已缓存的节点与选择、仍然就绪、错误为证据中的文字、更新时间不变，并像真实适配器一样经
//   parseResourceUpdateText 抛出 SURGE_COMMAND_FAILED（真机上命令退出 0）；成功时只保留能解析的行、同名取第一条（`名称 = reject`
//   也是有效节点）、重建成员（选择不再是成员时回落到首成员）、推进更新时间、清空错误。没有真机证据、做成选项或假设的部分：
//   只含占位行的列表被接受（TODO(P0)）、Surge 自己的定时刷新（remoteRefreshIntervalMs）、重启后是否保留缓存
//   （remoteCacheOnRestart）、更新时间的分辨率（updatedAtResolution）、Surge 报告 updating 的时长（slowUpdate）、“适配器
//   超时而更新仍然生效”（timeoutNextUpdate）、加载配置时对未就绪资源的一次下载、远端资源 key 的形状（缺省不透明，urlKeys）；
// - 本地 RULE-SET 文件变化后由文件监视自动重新加载（规则集文档：“Local files are watched and reloaded automatically when
//   they change.”），只重新加载该规则集、不重载配置，延迟可配置（localWatchLatencyMs）；
// - 本地 policy-path 文件是否被监视没有写入文档（自动重载关闭时实测不被重新读取，2026-10-24-fixed-profile-live.md）：
//   watchLocalPolicyPaths 只是旧版本地文件模型的阴性回归开关，缺省关闭（成员只在 reloadProfile 时变化），从不影响远端资源；
// - 资源类型按文档记为 policy-group / ruleset；新临时规则排在最前（“Add a temporary rule with the highest priority”，
//   多条之间的顺序未写入文档，tempRuleInsertion 可改）；
// - matchRule 与 simulateRequest 用同一套求值（模块规则 → 临时规则 → 配置规则）；求值走到 IP 规则（没有 no-resolve）而目标是
//   域名时按 IP 规则文档做一次假 DNS 查询（见 resolveHost）：查询失败时求值中止（“rule evaluation aborts and the request fails
//   with a DNS error”，rules/ip.html），FINAL 带 dns-failed 时改用 FINAL 的策略；matchRule 因此以与 CLI 退出 1 相同的错误
//   拒绝（2026-10-24 测试 Mac：`.invalid` 主机的 rule match 退出 1，DNS 空回答），simulateRequest 记为失败的请求；
// - getVersion 报告版本、构建号、Core 版本与 Controller 协议号（缺省 6.10.0 / 12500）；
// - `rule match` 与 `rule temp add/remove` 是 Mac 6.9.0+、协议 ≥20 的命令：低于它们时回答 Unknown command（随包技能：
//   “An older core answers `Unknown command`”）；`--raw dump temp-rule` 与 `--raw dump rule` 不受影响。改版本用
//   changeVersion（升级或降级需要退出并重新打开 Surge，临时规则随之丢弃）。
// 可选的 autoReload 模拟“配置被外部修改时自动重载”：任一被引用文件变化后整体重载并计数。

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import {
  ENTRY_RULESET_FILES,
  NODE_RESOURCE_FILE,
  NODE_RESOURCE_HOST,
  SfeError,
  WORKING_PROFILE_NAME,
  type TakeoverState,
} from '@sfe/contract';
import type { ResourceRequest, ResourceResponse } from '../resource/host.js';
import type {
  MaintenanceSurge,
  SurgeAdapter,
  SurgeCheckResult,
  SurgeExternalResource,
  SurgePolicies,
  SurgePolicyDetail,
  SurgePolicyTestResult,
  SurgeProfileInfo,
  SurgeRequestRecord,
  SurgeResourceUpdateResult,
  SurgeRuleMatchInput,
  SurgeRuleMatchResult,
  SurgeRuleRecord,
  SurgeRuntimeInfo,
  SurgeVersion,
} from '../ports.js';
import { commandExitError, unsupportedCommandError } from './cli-adapter.js';
import { ruleMatchArgs } from './cli-commands.js';
import { parseResourceUpdateText, sha256Hex, unrecognized } from './parse-output.js';
import {
  ENTRY_BITS_IN_ORDER,
  entryRuleSetFileContent,
  entryRuleSetBlockLines,
  groupBlockLines,
  loopbackGroupBlockLines,
  resourceFile,
} from './generate.js';
import { SURGE_PRIMITIVES, resourceUpdateTimeoutError, type MechanismMap, type SurgePrimitive } from './primitives.js';
import { SURGE_APP_BUNDLE, SURGE_BUNDLE_IDS, compareSurgeVersions, type RunningInstanceFailure, type RunningInstanceResult } from './running-instance.js';
import { SURGE_BUILD_RE, SURGE_VERSION_RE } from './capability-gate.js';
import { findSections, parseProfile } from './profile.js';
import { parseProxyLine } from './proxy-line.js';
import { redactProxyLine, redactUrls } from './redact-profile.js';
import {
  BUILTIN_POLICIES,
  DnsLookupFailure,
  REJECT_POLICIES,
  evaluateCondition,
  isCommentLine,
  parseCondition,
  parseRule,
  type ResolvedAddresses,
  type RuleCondition,
} from './rules.js';
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';

export const FAKE_SAFARI_PATH = '/Applications/Safari.app/Contents/MacOS/Safari';
export const FAKE_CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export const FAKE_VERIFY_HOST = 'verify.example.test';
/**
 * 合成工作配置中排在入口段与用户规则之后、FINAL 之前的 IP 规则（不带 no-resolve）：真实配置里常见的这类规则让求值走到它时
 * 对域名做 DNS 查询（rules/ip.html）。放进缺省配置，本应用的 rule match 探测一旦用了无法解析的合成域名就会像真实 Surge 一样失败。
 */
export const FAKE_IP_RULE = 'IP-CIDR,203.0.113.0/24,DIRECT';

/**
 * 假 DNS 查询失败的 rule match：与 CLI 适配器对非零退出的分类相同（commandExitError：SURGE_COMMAND_FAILED，details 只有
 * primitive 与 exitCode 1，没有 reason），不是“rule match 不可用”。
 */
export function fakeRuleMatchDnsError(): SfeError {
  return commandExitError('matchRule', 1, 'DNS 查询失败（模拟：DNS 空回答）');
}

/**
 * 假 DNS 的缺省答案：RFC 6761 的 `.invalid` 名称总是失败（“Name resolution APIs and libraries SHOULD recognize "invalid" names
 * as special and SHOULD always return immediate negative responses.”，RFC 6761 §6.4；测试 Mac 上的 DNS 空回答）；其他名称（测试用的
 * `example.test` 代表真实域名）得到稳定的合成文档地址（198.51.100.0/24 与 2001:db8::/32）。dnsRecords 与 dnsFailures 可覆盖。
 */
function syntheticAddresses(host: string): ResolvedAddresses | null {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (h === 'invalid' || h.endsWith('.invalid')) return null;
  const n = createHash('sha256').update(h).digest().readUInt16BE(0);
  return { v4: `198.51.100.${(n % 254) + 1}`, v6: `2001:db8::${((n % 0xfffe) + 1).toString(16)}` };
}

/**
 * 一次下载尝试（Surge 发出的一个请求）的结果：http（任何状态码与内容）、连接被重置、响应被截断（Content-Length 未满足）、
 * 服务不答复（超时）、连接被拒绝（端口上无人监听）。
 */
export type FakeRemoteResponse =
  | { kind: 'http'; status: number; body: string | Buffer }
  | { kind: 'reset' }
  | { kind: 'truncated' }
  | { kind: 'no_response' }
  | { kind: 'refused' };

/**
 * 远端资源的下载来源。参数是工作配置中的原样地址（本机资源服务的地址含读取令牌：来源不得把它写入日志或错误）。同步返回：
 * 定时刷新也会在 simulateRequest 中触发。
 */
export type FakeRemoteSource = (url: string) => FakeRemoteResponse;

/**
 * 真机证据中的资源错误文字（Surge Mac 6.10.0 (12500)，2026-10-25 合成回环矩阵；与 adapters.test.ts 的退出 0 失败文字表相同）。
 * HTTP 4xx/5xx 一律为“异常状态码”文字；连接重置与响应截断都是 -1005；服务不答复是 -1001；无人监听是 -1004。
 */
export const FAKE_REMOTE_ERRORS = Object.freeze({
  status: (status: number): string => `服务器返回了异常状态码：${status}。`,
  empty: '服务器未返回任何数据。',
  parse: 'Failed to parse remote resource data',
  interrupted: '网络连接已中断。 (NSURLErrorDomain:-1005) [未能完成操作。（kCFErrorDomainCFNetwork错误-1005。） (kCFErrorDomainCFNetwork:-1005)]',
  timeout: '请求超时。 (NSURLErrorDomain:-1001) [未能完成操作。（kCFErrorDomainCFNetwork错误-1001。） (kCFErrorDomainCFNetwork:-1001)]',
  refused: '无法连接服务器。 (NSURLErrorDomain:-1004) [未能完成操作。（kCFErrorDomainCFNetwork错误-1004。） (kCFErrorDomainCFNetwork:-1004)]',
});

/**
 * 一次下载中 Surge 最多发出的请求数（回环矩阵：一次命令触发连接重置 6 次、响应截断 2 次、服务不答复 2 次下载请求，其余 1 次）。
 * 按最近一次尝试的结果判断是否再试：重试中得到其他结果时按那个结果的次数停止。
 */
export const FAKE_REMOTE_ATTEMPTS: Readonly<Record<FakeRemoteResponse['kind'], number>> = Object.freeze({
  http: 1,
  reset: 6,
  truncated: 2,
  no_response: 2,
  refused: 1,
});

/** 一次下载（含重试）的记录：不含地址中的令牌（location 已遮盖）；Surge 的定时刷新与加载配置时的下载也在这里，不计入 calls。 */
export interface FakeRemoteFetch {
  key: string;
  location: string;
  at: Date;
  trigger: 'update' | 'scheduled' | 'load';
  /** Surge 发出的请求数（含重试）。 */
  attempts: number;
  outcome: 'downloaded' | 'failed';
  /** 失败时的资源错误（证据文字）。 */
  error: string | null;
  /** 成功时接受的行数（节点或规则）。 */
  accepted: number;
}

const REMOTE_VALUE_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

function keyPrefix(type: 'policy-group' | 'ruleset'): string {
  return type === 'policy-group' ? 'policy-path' : 'ruleset';
}

/**
 * 远端资源的不透明 key：sha1('<policy-path|ruleset>:<地址>') 的前 32 位十六进制（合成形状，满足 CLI 的 key 安全守卫；
 * 真实形状 TODO(P0)：loopback_resource_update 记录）。
 */
export function fakeOpaqueResourceKey(type: 'policy-group' | 'ruleset', value: string): string {
  return createHash('sha1').update(`${keyPrefix(type)}:${value}`, 'utf8').digest('hex').slice(0, 32);
}

/** Surge 接受的节点类型（假设：只为让“坏行被跳过”有确定的含义；Surge 真实的接受规则不只看类型，见 acceptNodeLine 选项）。 */
const NODE_TYPES_WITHOUT_SERVER: ReadonlySet<string> = new Set(['direct', 'reject', 'reject-tinygif', 'reject-drop', 'reject-no-drop']);
const NODE_TYPES_WITH_SERVER: ReadonlySet<string> = new Set([
  'http',
  'https',
  'socks5',
  'socks5-tls',
  'ss',
  'vmess',
  'trojan',
  'snell',
  'tuic',
  'tuic-v5',
  'hysteria2',
  'wireguard',
  'ssh',
  'anytls',
]);

/**
 * 缺省的节点行接受规则：能解析为“名称 = 类型, …”，类型已知；需要服务器的类型带主机与 1-65535 的端口。`名称 = reject`
 * 是有效节点（本应用的占位行 SFE-EMPTY = reject）。
 */
export function fakeAcceptsNodeLine(line: string): boolean {
  const p = parseProxyLine(line);
  if (!p || p.name === '' || /[,=]/.test(p.name)) return false;
  if (NODE_TYPES_WITHOUT_SERVER.has(p.type)) return true;
  return NODE_TYPES_WITH_SERVER.has(p.type) && p.server !== null && p.port !== null;
}

/** 进程内的请求函数（virtualBinder 的 request）：端口无人绑定时抛 code 为 ECONNREFUSED 的错误，处理程序不答复时抛 ECONNRESET。 */
export type LoopbackRequest = (port: number, req: Omit<ResourceRequest, 'localPort'>) => ResourceResponse;

/**
 * Surge 对本机资源服务地址发出的下载请求：GET 原样路径，唯一的 Host 为 127.0.0.1:<端口>，两端都是回环地址，不带浏览器请求头
 * （TODO(P0)：loopback_resource_auth 记录 Surge 实际发出的请求头名称）。不是 http://127.0.0.1:<端口>/… 时为 null（假 Surge
 * 的网络上没有别的服务，按连接被拒绝处理）。
 */
export function loopbackResourceRequest(url: string): { port: number; request: Omit<ResourceRequest, 'localPort'> } | null {
  const m = /^http:\/\/127\.0\.0\.1:([0-9]{1,5})(\/[^#]*)?(?:#.*)?$/.exec(url);
  if (!m) return null;
  const port = Number(m[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return {
    port,
    request: {
      method: 'GET',
      rawPath: m[2] ?? '/',
      rawHeaders: ['Host', `${NODE_RESOURCE_HOST}:${port}`, 'User-Agent', 'Surge'],
      remoteAddress: NODE_RESOURCE_HOST,
      localAddress: NODE_RESOURCE_HOST,
    },
  };
}

/**
 * 把进程内的请求函数（通常是 virtualBinder.request）接成 remoteSource：每次下载都经占用该端口的处理程序（本机资源服务的
 * host.handle()）；抛出的 ECONNREFUSED 记为连接被拒绝，ECONNRESET 记为连接被重置，其他错误照原样抛出（测试错误）。
 */
export function loopbackRemoteSource(request: LoopbackRequest): FakeRemoteSource {
  return (url) => {
    const target = loopbackResourceRequest(url);
    if (target === null) return { kind: 'refused' };
    try {
      const r = request(target.port, target.request);
      return { kind: 'http', status: r.status, body: r.body };
    } catch (err) {
      const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
      if (code === 'ECONNREFUSED') return { kind: 'refused' };
      if (code === 'ECONNRESET') return { kind: 'reset' };
      throw err;
    }
  };
}

/** 假 Surge 的网络上什么也没有：一律连接被拒绝。 */
const refusedSource: FakeRemoteSource = () => ({ kind: 'refused' });

/**
 * 慢更新：每次远端下载（单 key 更新、定时刷新、加载配置时的下载）开始后，该资源报告 updating: true 共 durationMs 毫秒（按 now），
 * 到时（之后的第一次原语调用或 simulateRequest）才经 remoteSource 下载并应用结果。单 key 更新不等下载就答复：reply 为
 * downloaded（缺省，报告成功）或 timeout（适配器等待超时，结果未知）。这是假设（TODO(P0)：loopback_publish_crash 记录答复
 * 时机与更新进行中再次更新的行为），用来检验发布从不把答复当作已下载、并等待 updating 结束再读回。
 */
export interface FakeSlowUpdate {
  durationMs: number;
  reply?: 'downloaded' | 'timeout';
}

export interface FakeSurgeOptions {
  directory: string;
  profileFileName?: string;
  /** 模拟“自动重载”：在任一被引用文件变化后的下一次调用时整体重载。 */
  autoReload?: boolean;
  /** getAutoReloadSetting 报告的值；缺省等于 autoReload。 */
  reportedAutoReload?: boolean | null;
  /** 新临时规则插入位置；缺省 head（文档：“Add a temporary rule with the highest priority”）。 */
  tempRuleInsertion?: 'head' | 'tail';
  /** 本地文件变化后到监视器重新加载之间的延迟（毫秒，按 now 计）；缺省 0：变化后的下一次调用即重新加载。 */
  localWatchLatencyMs?: number;
  /**
   * 本地 policy-path 文件是否像本地 RULE-SET 一样被监视（文档未说明；自动重载关闭时实测不被重新读取）。缺省关闭，只作为旧版
   * 本地文件模型的阴性回归开关，从不影响远端资源。
   */
  watchLocalPolicyPaths?: boolean;
  /** 远端资源的下载来源；缺省一律连接被拒绝。 */
  remoteSource?: FakeRemoteSource;
  /**
   * true：远端资源的 key 为 `policy-path:<地址>` / `ruleset:<地址>`（含读取令牌，只用于 key 安全守卫的测试）；缺省为不透明的
   * 32 位十六进制（fakeOpaqueResourceKey）。本地资源的 key 始终是 `policy-path:<值>` / `ruleset:<值>`。
   */
  urlKeys?: boolean;
  /**
   * Surge 自己的定时刷新间隔（毫秒，按 now 计，在每次原语调用与 simulateRequest 时检查）：距上次下载尝试满这么久的远端资源经同一
   * 下载路径再下载一次，不计入 calls（记入 remoteFetches，trigger 'scheduled'）。缺省 null：不刷新（真实间隔 TODO(P0)）。
   */
  remoteRefreshIntervalMs?: number | null;
  /** Surge 重启后远端资源的缓存：keep（缺省）沿用；drop 丢弃，之后像从未下载过一样再下载一次。TODO(P0)：loopback_resource_restart。 */
  remoteCacheOnRestart?: 'keep' | 'drop';
  /** 远端资源更新时间的分辨率：ms（缺省，严格递增）或 s（取整到秒，同一秒内的两次下载更新时间相同）。TODO(P0)：实测。 */
  updatedAtResolution?: 'ms' | 's';
  /** 见 FakeSurge.slowUpdate。 */
  slowUpdate?: FakeSlowUpdate | null;
  /** 节点行的接受规则（缺省 fakeAcceptsNodeLine）；Surge 真实的接受规则与 parseProxyLine 不同。 */
  acceptNodeLine?: (line: string) => boolean;
  /**
   * 构造前已有的远端缓存（如同之前的运行中已下载过，见 seedRemoteCache）：这些资源在第一次加载时已就绪，不下载。
   */
  remoteCache?: ReadonlyArray<{ url: string; body: string; type?: 'policy-group' | 'ruleset'; updatedAt?: Date }>;
  /** getVersion 报告的 Controller 协议号（合成值；真实值由 P0 读取）。 */
  controllerProtocol?: number;
  /** getVersion 报告的 Core 版本（合成值）。 */
  coreVersion?: number;
  /** 外部节点的 underlying-proxy 缺失时：跳过节点，或（危险情形）直接连接。 */
  frontResolution?: 'skip' | 'direct';
  /** 重载配置时是否清空临时规则（P0 待测，缺省保留）。 */
  reloadClearsTempRules?: boolean;
  version?: string;
  build?: string | null;
  now?: () => Date;
}

interface LoadedNode {
  name: string;
  line: string;
  type: string;
  server: string | null;
  port: number | null;
  front: string | null;
  frontMissing: boolean;
}

interface LoadedGroup {
  name: string;
  type: string;
  explicit: string[];
  policyPaths: string[];
}

interface PendingFetch {
  trigger: FakeRemoteFetch['trigger'];
  /** 下载完成（真正调用 remoteSource 并应用结果）的时刻（毫秒，按 now）。 */
  completesAt: number;
  /** 进行中再次单 key 更新时的答复（与开始这次下载的答复相同）。 */
  reply: 'downloaded' | 'timeout';
}

/**
 * Surge 对一项远端资源的缓存（按 key 保存，跨配置重载保留；重启按 remoteCacheOnRestart）。content 为 null 表示从未成功下载
 * （未就绪：列表报告 error 'not_ready'、没有更新时间、组中没有它的节点）。
 */
interface RemoteState {
  /** 工作配置中的原样地址（含读取令牌）：只交给 remoteSource，从不出现在列表、记录或错误中。 */
  readonly url: string;
  readonly type: 'policy-group' | 'ruleset';
  /** 已接受的行（只含能解析的行，同名只留第一条）。 */
  content: string | null;
  conditions: RuleCondition[];
  updatedAt: Date | null;
  /** 最近一次下载失败的资源错误；成功时清空。 */
  error: string | null;
  /** 最近一次下载尝试的时刻（毫秒），定时刷新据此计算。 */
  lastAttemptAt: number | null;
  pending: PendingFetch | null;
}

interface LoadedResource {
  key: string;
  /** HTTP API 文档的资源类型（policy-path 的类型是 policy-group）。 */
  type: 'policy-group' | 'ruleset';
  value: string;
  /** 列表中的位置：本地资源为绝对路径，远端资源为 redactUrls 遮盖后的地址（与 parse-output 相同）。 */
  location: string;
  /** 遮盖之前原样位置的 SHA-256（与 parse-output 的 locationHash 相同）。 */
  locationHash: string;
  local: boolean;
  /** 本地资源的已加载内容；远端资源的内容在 remote 中。 */
  content: string | null;
  conditions: RuleCondition[];
  /** 本地资源的错误（文件不存在）；远端资源的错误在 remote 中。 */
  error: string | null;
  /** 监视器第一次看到文件与已加载内容不同的时刻（毫秒）；没有待处理的变化为 null。 */
  changeSeenAt: number | null;
  /** 远端资源的缓存（本地资源为 null）。 */
  remote: RemoteState | null;
}

export interface SimulatedRequest extends SurgeRequestRecord {
  /** 策略链：组 → 节点 → 前置；前置缺失且按 direct 处理时以 DIRECT 结尾。 */
  chain: string[];
  frontMissing: boolean;
}

interface Fault {
  error: Error;
  afterEffect: boolean;
}

function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function commandFailed(message: string): SfeError {
  return new SfeError('SURGE_COMMAND_FAILED', message);
}

export class FakeSurge implements SurgeAdapter, MaintenanceSurge {
  readonly directory: string;
  readonly profileFileName: string;
  /** 每个原语（含 reloadProfile）的调用次数。 */
  readonly calls: Record<string, number> = {};
  /** 整体重载次数（reloadProfile 与自动重载）。 */
  reloadCount = 0;
  autoReloadCount = 0;

  autoReload: boolean;
  reportedAutoReload: boolean | null | undefined;
  tempRuleInsertion: 'head' | 'tail';
  localWatchLatencyMs: number;
  watchLocalPolicyPaths: boolean;
  /** 文件监视器重新加载单个资源的记录（不是配置重载，不计入 reloadCount）。 */
  readonly watcherReloads: Array<{ key: string; at: Date }> = [];
  /** 远端资源的下载来源（可随时替换）。 */
  remoteSource: FakeRemoteSource;
  readonly urlKeys: boolean;
  remoteRefreshIntervalMs: number | null;
  remoteCacheOnRestart: 'keep' | 'drop';
  updatedAtResolution: 'ms' | 's';
  /** 慢更新（见 FakeSlowUpdate）；null 时下载立即完成。可随时修改，只影响之后开始的下载。 */
  slowUpdate: FakeSlowUpdate | null;
  acceptNodeLine: (line: string) => boolean;
  /** 每次远端下载（含 Surge 自己的定时刷新与加载配置时的下载）的记录。 */
  readonly remoteFetches: FakeRemoteFetch[] = [];
  /** updateExternalResource('all') 等更新全部资源的尝试次数（本应用从不这样做；假 Surge 拒绝并计数）。 */
  updateAllAttempts = 0;
  frontResolution: 'skip' | 'direct';
  reloadClearsTempRules: boolean;
  reachable = true;
  /** 运行实例（HostInfo.surgeInstance）报告的版本与构建号；格式不对时运行实例读取失败。 */
  version: string;
  build: string | null;
  controllerProtocol: number;
  coreVersion: number;
  /** 模拟运行实例读取失败（例如 modified_after_start）；null 表示按 version/build 正常报告。 */
  instanceFailure: RunningInstanceFailure | null = null;
  /** runningInstance() 的调用次数（不是 Surge 原语，不计入 calls）。 */
  instanceReads = 0;
  takeover: TakeoverState = { enhancedMode: true, systemProxy: true, outboundMode: 'rule', checkedAt: null };
  currentProfile: SurgeProfileInfo;
  startedAt: Date;

  private readonly now: () => Date;
  private userProxies = new Map<string, LoadedNode>();
  private externalNodes = new Map<string, LoadedNode>();
  private groups = new Map<string, LoadedGroup>();
  private profileRules: string[] = [];
  private resources = new Map<string, LoadedResource>();
  /** 远端资源的缓存，按 key（不随配置重载清空）。 */
  private remote = new Map<string, RemoteState>();
  /** timeoutNextUpdate 排队的“适配器超时而更新仍然生效”。 */
  private updateTimeouts: Array<{ applyAfterMs: number }> = [];
  private watched = new Map<string, string | null>();
  private selection = new Map<string, string | null>();
  private temps: string[] = [];
  private modules: Array<{ text: string; moduleName: string }> = [];
  private recent: SimulatedRequest[] = [];
  private active = new Map<string, SimulatedRequest>();
  private nextId = 1;
  private faults = new Map<string, Fault[]>();
  private lies = new Map<string, Array<{ value: unknown }>>();
  private policyTests = new Map<string, SurgePolicyTestResult>();
  private checkResults = new Map<string, SurgeCheckResult>();
  /** 假 DNS：指定域名的答案（覆盖合成答案）。 */
  readonly dnsRecords = new Map<string, ResolvedAddresses>();
  /** 假 DNS：查询总是失败的域名（小写）。 */
  readonly dnsFailures = new Set<string>();
  /** 假 DNS 的查询记录（域名，按求值顺序；不含 IP 字面量，它们从不查询）。 */
  readonly dnsQueries: string[] = [];

  constructor(opts: FakeSurgeOptions) {
    this.directory = resolve(opts.directory);
    this.profileFileName = opts.profileFileName ?? `${WORKING_PROFILE_NAME}.conf`;
    this.autoReload = opts.autoReload ?? false;
    this.reportedAutoReload = opts.reportedAutoReload;
    this.tempRuleInsertion = opts.tempRuleInsertion ?? 'head';
    this.localWatchLatencyMs = opts.localWatchLatencyMs ?? 0;
    this.watchLocalPolicyPaths = opts.watchLocalPolicyPaths ?? false;
    this.remoteSource = opts.remoteSource ?? refusedSource;
    this.urlKeys = opts.urlKeys ?? false;
    this.remoteRefreshIntervalMs = opts.remoteRefreshIntervalMs ?? null;
    this.remoteCacheOnRestart = opts.remoteCacheOnRestart ?? 'keep';
    this.updatedAtResolution = opts.updatedAtResolution ?? 'ms';
    this.slowUpdate = opts.slowUpdate ?? null;
    this.acceptNodeLine = opts.acceptNodeLine ?? fakeAcceptsNodeLine;
    const interval = this.remoteRefreshIntervalMs;
    if (interval !== null && !(Number.isFinite(interval) && interval > 0)) throw new RangeError('remoteRefreshIntervalMs must be a positive number or null');
    if (this.slowUpdate !== null && !(Number.isFinite(this.slowUpdate.durationMs) && this.slowUpdate.durationMs >= 0)) {
      throw new RangeError('slowUpdate.durationMs must be a finite non-negative number');
    }
    this.frontResolution = opts.frontResolution ?? 'skip';
    this.reloadClearsTempRules = opts.reloadClearsTempRules ?? false;
    this.version = opts.version ?? '6.10.0';
    this.build = opts.build === undefined ? '12500' : opts.build;
    // 合成值：6.10 随包技能写明 `plugin` 需要协议 ≥24 且 6.10 带有 plugin 命令；真实协议号由 P0 读取。
    this.controllerProtocol = opts.controllerProtocol ?? 24;
    this.coreVersion = opts.coreVersion ?? 6100;
    this.now = opts.now ?? (() => new Date());
    this.startedAt = this.now();
    this.currentProfile = { name: this.profileFileName.replace(/\.conf$/, ''), path: this.profilePath };
    for (const c of opts.remoteCache ?? []) this.seedRemoteCache(c.url, c.body, { ...(c.type ? { type: c.type } : {}), ...(c.updatedAt ? { updatedAt: c.updatedAt } : {}) });
    this.loadAll();
  }

  get profilePath(): string {
    return join(this.directory, this.profileFileName);
  }

  // ---------- 模拟控制 ----------

  /** 下一次调用该原语时抛出 error；afterEffect 为 true 时先生效再抛（结果未知）。 */
  failNext(primitive: string, error: Error = commandFailed('调用 Surge 失败：模拟失败'), opts: { afterEffect?: boolean } = {}): void {
    if (!this.faults.has(primitive)) this.faults.set(primitive, []);
    this.faults.get(primitive)!.push({ error, afterEffect: opts.afterEffect ?? false });
  }

  /** 下一次调用该原语时“说谎”：读原语返回 value；写原语不生效但报告成功。 */
  lieOnNext(primitive: string, value?: unknown): void {
    if (!this.lies.has(primitive)) this.lies.set(primitive, []);
    this.lies.get(primitive)!.push({ value });
  }

  setModuleRules(rules: Array<{ text: string; moduleName: string }>): void {
    this.modules = rules.map((r) => ({ ...r }));
  }

  setPolicyTestResult(policy: string, result: SurgePolicyTestResult): void {
    this.policyTests.set(policy, result);
  }

  setCheckResult(path: string, result: SurgeCheckResult): void {
    this.checkResults.set(resolve(path), result);
  }

  /**
   * 下一次远端资源的单 key 更新：适配器等待超时（抛 SURGE_COMMAND_FAILED，details.reason update_timeout，与真实适配器相同），
   * 而 Surge 端的更新仍然生效——applyAfterMs 为 0（缺省）时立即下载并应用，否则 updating 持续这么久之后才下载并应用。
   * 计入 calls；与 failNext 一样只作用一次（可排多次）。
   */
  timeoutNextUpdate(opts: { applyAfterMs?: number } = {}): void {
    const applyAfterMs = opts.applyAfterMs ?? 0;
    if (!Number.isFinite(applyAfterMs) || applyAfterMs < 0) throw new RangeError('applyAfterMs must be a finite non-negative number');
    this.updateTimeouts.push({ applyAfterMs });
  }

  /**
   * 立即触发 Surge 自己的一次刷新（与定时刷新相同的下载路径；不计入 calls，trigger 'scheduled'）：给出 key 时只刷新该项，
   * 否则刷新每个远端资源。进行中的下载不另起。slowUpdate 生效时只开始下载（updating 为 true）。
   */
  runScheduledRefresh(key?: string): void {
    const targets = key === undefined ? [...this.resources.values()] : [this.resources.get(key)].filter((r): r is LoadedResource => r !== undefined);
    if (key !== undefined && targets.length === 0) throw new Error('runScheduledRefresh: unknown resource key');
    let changed = false;
    for (const res of targets) {
      if (!res.remote || res.remote.pending !== null) continue;
      if (this.startFetch(res, 'scheduled').fetched) changed = true;
    }
    if (changed) this.rebuildExternalNodes();
  }

  /**
   * 预置 Surge 对某个地址的缓存，如同之前的运行中已经下载过（测试用：例如 Surge 带着旧缓存重启）。不经 remoteSource、不记入
   * remoteFetches；内容按与下载相同的规则接受，没有可接受的行时抛错（测试错误）。之后加载配置时该资源已就绪。
   */
  seedRemoteCache(url: string, body: string, opts: { type?: 'policy-group' | 'ruleset'; updatedAt?: Date } = {}): void {
    const type = opts.type ?? 'policy-group';
    if (!REMOTE_VALUE_RE.test(url)) throw new Error('seedRemoteCache: not a remote address');
    const accepted = this.acceptRemote(type, { kind: 'http', status: 200, body });
    if (!accepted.ok) throw new Error(`seedRemoteCache: body not accepted (${accepted.error})`);
    const key = this.resourceKeyFor(url, type);
    const st = this.remote.get(key) ?? this.newRemoteState(url, type);
    st.content = accepted.content;
    st.conditions = accepted.conditions;
    st.error = null;
    st.updatedAt = opts.updatedAt ? new Date(opts.updatedAt) : this.stampUpdatedAt(st.updatedAt);
    st.lastAttemptAt = this.now().getTime();
    this.remote.set(key, st);
    const res = this.resources.get(key);
    if (res) {
      res.remote = st;
      this.rebuildExternalNodes();
    }
  }

  /** 假 Surge 给这个 policy-path（或 RULE-SET）值的资源 key：本地值与 urlKeys 时为 `<policy-path|ruleset>:<值>`，否则不透明。 */
  resourceKeyFor(value: string, type: 'policy-group' | 'ruleset' = 'policy-group'): string {
    if (!REMOTE_VALUE_RE.test(value) || this.urlKeys) return `${keyPrefix(type)}:${value}`;
    return fakeOpaqueResourceKey(type, value);
  }

  /** 该远端资源是否有进行中的下载（listExternalResources 的 updating）。不是远端资源时为 false。 */
  isUpdating(key: string): boolean {
    return this.resources.get(key)?.remote?.pending != null;
  }

  /**
   * 升级或降级 Surge：改版本需要退出并重新打开 Surge，等同于 restart()（临时规则“are discarded when Surge stops”）。
   * 只改字段而不重启的测试会让旧版本仍然保留新版本添加的临时规则，与真实情形不符。
   */
  changeVersion(v: { version: string; build: string | null; controllerProtocol?: number }): void {
    this.version = v.version;
    this.build = v.build;
    if (v.controllerProtocol !== undefined) this.controllerProtocol = v.controllerProtocol;
    this.restart();
  }

  /** `rule match`、`rule temp add/remove`：Mac 6.9.0+、协议 ≥20；更旧的 Surge 回答 Unknown command。 */
  private requireRuleCommands(primitive: SurgePrimitive): void {
    if (compareSurgeVersions(this.version, '6.9.0') < 0 || this.controllerProtocol < 20) throw unsupportedCommandError(primitive);
  }

  /**
   * Surge 重启：临时规则清空、整体加载、启动时间变化、活动连接清空。进行中的远端下载中断；远端缓存按 remoteCacheOnRestart
   * 保留或丢弃（TODO(P0)：loopback_resource_restart），未就绪的资源在加载时下载一次。
   */
  restart(): void {
    this.temps = [];
    this.active.clear();
    const t = this.now();
    this.startedAt = t.getTime() > this.startedAt.getTime() ? t : new Date(this.startedAt.getTime() + 1);
    for (const st of this.remote.values()) st.pending = null;
    if (this.remoteCacheOnRestart === 'drop') this.remote.clear();
    this.loadAll();
  }

  get tempRules(): string[] {
    return [...this.temps];
  }

  /** 已加载（而不是文件中或资源服务正在提供）的资源内容：远端资源为 Surge 缓存中被接受的行，未就绪为 null。 */
  loadedContent(key: string): string | null {
    const res = this.resources.get(key);
    return res ? this.contentOf(res) : null;
  }

  checkFileChanges(): boolean {
    let reloaded = false;
    if (this.autoReload) {
      for (const [path, snapshot] of this.watched) {
        if (readOrNull(path) !== snapshot) {
          this.reloadCount++;
          this.autoReloadCount++;
          this.loadAll();
          if (this.reloadClearsTempRules) this.temps = [];
          reloaded = true;
          break;
        }
      }
    }
    if (!reloaded) this.runWatchers();
    this.runRemote();
    return reloaded;
  }

  /**
   * 远端资源的后台进度（每次原语调用与 simulateRequest 时）：到期的进行中下载经 remoteSource 完成并应用；打开定时刷新时，距上次
   * 下载尝试满 remoteRefreshIntervalMs 的资源再下载一次（时钟一次跳过多个间隔也只下载一次）。都不计入 calls。
   */
  private runRemote(): void {
    const t = this.now().getTime();
    let changed = false;
    for (const res of this.resources.values()) {
      const st = res.remote;
      if (!st || st.pending === null || t < st.pending.completesAt) continue;
      const trigger = st.pending.trigger;
      st.pending = null;
      this.fetchNow(res, trigger);
      changed = true;
    }
    const interval = this.remoteRefreshIntervalMs;
    if (interval !== null && Number.isFinite(interval) && interval > 0) {
      for (const res of this.resources.values()) {
        const st = res.remote;
        if (!st || st.pending !== null) continue;
        if (st.lastAttemptAt !== null && t - st.lastAttemptAt < interval) continue;
        if (this.startFetch(res, 'scheduled').fetched) changed = true;
      }
    }
    if (changed) this.rebuildExternalNodes();
  }

  /**
   * 本地文件监视：本地 RULE-SET（以及打开 watchLocalPolicyPaths 时的本地 policy-path）在文件内容与已加载内容不同、
   * 且距第一次看到变化已过 localWatchLatencyMs 时，只重新加载该资源（不是配置重载，临时规则与选择不变）。
   */
  private runWatchers(): void {
    const t = this.now().getTime();
    let nodesChanged = false;
    for (const res of this.resources.values()) {
      if (!res.local || (res.type === 'policy-group' && !this.watchLocalPolicyPaths)) continue;
      const current = readOrNull(res.location);
      if (current === res.content) {
        res.changeSeenAt = null;
        continue;
      }
      if (res.changeSeenAt === null) res.changeSeenAt = t;
      if (t - res.changeSeenAt < this.localWatchLatencyMs) continue;
      this.loadResource(res);
      this.watcherReloads.push({ key: res.key, at: new Date(t) });
      if (res.type === 'policy-group') nodesChanged = true;
    }
    if (nodesChanged) this.rebuildExternalNodes();
  }

  /**
   * 模拟一次请求：模块规则 → 临时规则 → 配置规则（RULE-SET 展开）求值，记录命中的规则、策略与叶节点。
   * longLived 的请求保留在活动列表中，直到被结束。
   */
  simulateRequest(req: { processPath: string | null; host: string; protocol: 'tcp' | 'udp'; longLived?: boolean }): SimulatedRequest {
    this.checkFileChanges();
    let evaluated: { rule: string; policy: string };
    try {
      evaluated = this.evaluate({ processPath: req.processPath, host: req.host, protocol: req.protocol });
    } catch (e) {
      if (!(e instanceof DnsLookupFailure)) throw e;
      // 求值中止：请求以 DNS 错误失败，没有命中规则也没有策略
      const failed: SimulatedRequest = {
        id: String(this.nextId++),
        processPath: req.processPath,
        remoteHost: req.host,
        policyName: null,
        leafPolicyName: null,
        rule: null,
        protocol: req.protocol,
        startedAt: this.now(),
        completed: true,
        failed: true,
        chain: [],
        frontMissing: false,
      };
      this.recent.push(failed);
      if (this.recent.length > 500) this.recent.shift();
      return { ...failed, chain: [] };
    }
    const { rule: matchedRule, policy } = evaluated;
    const resolved = this.resolvePolicy(policy, 0);
    const rec: SimulatedRequest = {
      id: String(this.nextId++),
      processPath: req.processPath,
      remoteHost: req.host,
      policyName: policy,
      leafPolicyName: this.groups.has(policy) ? resolved.leaf : null,
      rule: matchedRule,
      protocol: req.protocol,
      startedAt: this.now(),
      completed: !req.longLived,
      failed: resolved.rejected,
      chain: resolved.chain,
      frontMissing: resolved.frontMissing,
    };
    this.recent.push(rec);
    if (this.recent.length > 500) this.recent.shift();
    if (req.longLived && !resolved.rejected) this.active.set(rec.id, rec);
    return { ...rec, chain: [...rec.chain] };
  }

  /** 假 DNS 查询（每次求值最多一次，见 evaluate）：失败抛出 DnsLookupFailure。 */
  private resolveHost(host: string): ResolvedAddresses {
    const h = host.toLowerCase().replace(/\.$/, '');
    this.dnsQueries.push(h);
    if (this.dnsFailures.has(h)) throw new DnsLookupFailure(h);
    const answer = this.dnsRecords.get(h) ?? syntheticAddresses(h);
    if (answer === null || (answer.v4 === null && answer.v6 === null)) throw new DnsLookupFailure(h);
    return { ...answer };
  }

  /**
   * 规则求值：模块规则 → 临时规则 → 配置规则（RULE-SET 用已加载的内容），第一条命中的规则决定策略。文档只写临时规则
   * “precede all profile rules”（https://manual.nssurge.com/tools/cli.html），模块规则与临时规则谁先求值没有写明——这里的
   * “模块先于临时规则”是假设（TODO(P0)：测试 Mac 上核对），测试不能依赖它证明真实 Surge 上的行为。目标是域名时，第一条需要
   * 地址的 IP 规则触发一次假 DNS 查询，之后的 IP 规则沿用结果（rules/ip.html）；IP 字面量从不查询。查询失败时：生效的 FINAL
   * （最后一条）带 dns-failed 则用它的策略（“With the dns-failed option, Surge uses the FINAL rule's policy instead”，
   * rules/final.html），否则抛出 DnsLookupFailure（求值中止）。
   */
  private evaluate(facts: { processPath: string | null; host: string; protocol: 'tcp' | 'udp' }): { rule: string; policy: string } {
    let resolved: ResolvedAddresses | null = null;
    const lookup = (host: string, resolve: boolean): ResolvedAddresses | null => {
      if (resolved !== null || !resolve || isIP(host) !== 0) return resolved;
      resolved = this.resolveHost(host);
      return resolved;
    };
    const ruleSet = (value: string): RuleCondition[] | null => {
      const res = this.resources.get(this.resourceKeyFor(value, 'ruleset'));
      if (!res) return null;
      return res.remote ? res.remote.conditions : res.conditions;
    };
    const ctx = { ruleSet, lookup };
    const ordered = [...this.modules.map((m) => m.text), ...this.temps, ...this.profileRules];
    try {
      for (const text of ordered) {
        const r = parseRule(text);
        if (!r || !r.policy) continue;
        const noResolve = r.options.some((o) => o.trim().toLowerCase() === 'no-resolve');
        if (evaluateCondition(r.condition, facts, ctx, noResolve)) return { rule: text, policy: r.policy };
      }
    } catch (e) {
      if (!(e instanceof DnsLookupFailure)) throw e;
      const final = [...this.profileRules].reverse().find((t) => parseRule(t)?.condition.type === 'FINAL');
      const parsed = final ? parseRule(final) : null;
      if (final && parsed?.policy && parsed.options.some((o) => o.trim().toLowerCase() === 'dns-failed')) return { rule: final, policy: parsed.policy };
      throw e;
    }
    return { rule: 'FINAL,DIRECT', policy: 'DIRECT' };
  }

  // ---------- 加载 ----------

  private loadAll(): void {
    const raw = readOrNull(this.profilePath);
    const parsed = parseProfile(raw ?? '');
    this.userProxies.clear();
    this.groups.clear();
    this.profileRules = [];
    this.resources = new Map();
    this.watched = new Map([[this.profilePath, raw]]);
    const linesOf = (name: string): string[] =>
      findSections(parsed, name).flatMap((s) => parsed.lines.slice((s.header ?? s.start) + 1, s.end).map((l) => l.text));

    for (const line of linesOf('Proxy')) {
      if (isCommentLine(line)) continue;
      const p = parseProxyLine(line);
      if (p) this.userProxies.set(p.name, { name: p.name, line, type: p.type, server: p.server, port: p.port, front: p.params['underlying-proxy'] ?? null, frontMissing: false });
    }
    for (const line of linesOf('Proxy Group')) {
      if (isCommentLine(line)) continue;
      const m = /^\s*([^=]+?)\s*=\s*(.+)$/.exec(line);
      if (!m) continue;
      const parts = m[2]!.split(',').map((s) => s.trim());
      const group: LoadedGroup = { name: m[1]!, type: parts[0]!.toLowerCase(), explicit: [], policyPaths: [] };
      for (const part of parts.slice(1)) {
        const eq = part.indexOf('=');
        if (eq < 0) group.explicit.push(part);
        else if (part.slice(0, eq).trim().toLowerCase() === 'policy-path') {
          const value = part.slice(eq + 1).trim();
          group.policyPaths.push(value);
          this.registerResource('policy-group', value);
        }
      }
      this.groups.set(group.name, group);
    }
    for (const line of linesOf('Rule')) {
      if (isCommentLine(line)) continue;
      const r = parseRule(line);
      if (!r) continue;
      this.profileRules.push(line.trim());
      if (r.condition.type === 'RULE-SET') this.registerResource('ruleset', r.condition.value!);
    }
    for (const res of this.resources.values()) this.loadResource(res);
    // 配置中不再引用的远端资源：进行中的下载随之放弃（缓存保留，重新引用同一地址时沿用）
    const referenced = new Set([...this.resources.values()].map((r) => r.remote));
    for (const st of this.remote.values()) if (!referenced.has(st)) st.pending = null;
    // 未就绪的远端资源（从未成功下载）在加载配置时下载一次；已就绪的沿用缓存，不重新下载（假设，TODO(P0)：重启与重载时
    // Surge 是否重新下载由 loopback_resource_restart 记录）
    for (const res of this.resources.values()) {
      if (res.remote && res.remote.content === null && res.remote.pending === null) this.startFetch(res, 'load');
    }
    this.rebuildExternalNodes();
  }

  /**
   * 资源 key 是合成值（真实 Surge 的 key 由它自己生成）：本地资源为 policy-path:<值> 与 ruleset:<值>；远端资源缺省不透明
   * （resourceKeyFor）。远端资源的缓存按 key 跨配置重载保留。
   */
  private registerResource(type: 'policy-group' | 'ruleset', value: string): void {
    const key = this.resourceKeyFor(value, type);
    if (this.resources.has(key)) return;
    if (REMOTE_VALUE_RE.test(value)) {
      let st = this.remote.get(key);
      if (!st) {
        st = this.newRemoteState(value, type);
        this.remote.set(key, st);
      }
      this.resources.set(key, {
        key,
        type,
        value,
        location: redactUrls(value),
        locationHash: sha256Hex(value),
        local: false,
        content: null,
        conditions: [],
        error: null,
        changeSeenAt: null,
        remote: st,
      });
      return;
    }
    const location = isAbsolute(value) ? value : join(this.directory, value);
    this.resources.set(key, {
      key,
      type,
      value,
      location,
      locationHash: sha256Hex(location),
      local: true,
      content: null,
      conditions: [],
      error: null,
      changeSeenAt: null,
      remote: null,
    });
  }

  private newRemoteState(url: string, type: 'policy-group' | 'ruleset'): RemoteState {
    return { url, type, content: null, conditions: [], updatedAt: null, error: null, lastAttemptAt: null, pending: null };
  }

  private contentOf(res: LoadedResource): string | null {
    return res.remote ? res.remote.content : res.content;
  }

  /** 远端资源的更新时间：ms 时严格递增（时钟没走时比上一次多 1 毫秒）；s 时取整到秒（同一秒内的下载更新时间相同）。 */
  private stampUpdatedAt(prev: Date | null): Date {
    const t = this.now().getTime();
    if (this.updatedAtResolution === 's') return new Date(Math.floor(t / 1000) * 1000);
    return prev && t <= prev.getTime() ? new Date(prev.getTime() + 1) : new Date(t);
  }

  /**
   * 开始一次远端下载：slowUpdate 生效时只记下进行中（updating），到时由 runRemote 完成；否则立即下载。fetched 为真时已经下载
   * （调用方负责重建节点），error 为资源错误（成功为 null）。
   */
  private startFetch(
    res: LoadedResource,
    trigger: FakeRemoteFetch['trigger'],
  ): { fetched: true; error: string | null } | { fetched: false; reply: 'downloaded' | 'timeout' } {
    const st = res.remote!;
    const slow = this.slowUpdate;
    if (slow !== null && Number.isFinite(slow.durationMs) && slow.durationMs > 0) {
      const reply = slow.reply ?? 'downloaded';
      st.pending = { trigger, completesAt: this.now().getTime() + slow.durationMs, reply };
      return { fetched: false, reply };
    }
    return { fetched: true, error: this.fetchNow(res, trigger) };
  }

  /**
   * 下载一次（含 Surge 的重试，见 FAKE_REMOTE_ATTEMPTS）并写入缓存：成功时内容换成被接受的行、错误清空、更新时间推进；
   * 失败时只记错误（缓存的内容、就绪状态与更新时间不变）。返回资源错误，成功为 null。不重建节点（调用方负责）。
   */
  private fetchNow(res: LoadedResource, trigger: FakeRemoteFetch['trigger']): string | null {
    const st = res.remote!;
    const at = this.now();
    st.lastAttemptAt = at.getTime();
    let attempts = 0;
    let response: FakeRemoteResponse;
    for (;;) {
      attempts++;
      response = this.remoteSource(st.url);
      const max = FAKE_REMOTE_ATTEMPTS[response?.kind];
      if (max === undefined) throw new Error('FakeSurge: remoteSource returned an unknown response');
      if (attempts >= max) break;
    }
    const outcome = this.acceptRemote(st.type, response);
    if (outcome.ok) {
      st.content = outcome.content;
      st.conditions = outcome.conditions;
      st.error = null;
      st.updatedAt = this.stampUpdatedAt(st.updatedAt);
    } else {
      st.error = outcome.error;
    }
    this.remoteFetches.push({
      key: res.key,
      location: res.location,
      at,
      trigger,
      attempts,
      outcome: outcome.ok ? 'downloaded' : 'failed',
      error: outcome.ok ? null : outcome.error,
      accepted: outcome.ok ? outcome.accepted : 0,
    });
    return outcome.ok ? null : outcome.error;
  }

  /**
   * 下载结果是否被接受（证据文字见 FAKE_REMOTE_ERRORS）：非 2xx 为异常状态码；空内容为“服务器未返回任何数据。”；没有一条
   * 可接受的行（含只有文件头注释的内容）为 Failed to parse remote resource data。节点资源只保留 acceptNodeLine 接受的行、
   * 同名只留第一条；规则集只保留能解析的规则。
   */
  private acceptRemote(
    type: 'policy-group' | 'ruleset',
    response: FakeRemoteResponse,
  ): { ok: true; content: string; conditions: RuleCondition[]; accepted: number } | { ok: false; error: string } {
    switch (response.kind) {
      case 'refused':
        return { ok: false, error: FAKE_REMOTE_ERRORS.refused };
      case 'reset':
      case 'truncated':
        return { ok: false, error: FAKE_REMOTE_ERRORS.interrupted };
      case 'no_response':
        return { ok: false, error: FAKE_REMOTE_ERRORS.timeout };
      case 'http':
        break;
    }
    const status = response.status;
    if (!Number.isInteger(status) || status < 200 || status > 299) return { ok: false, error: FAKE_REMOTE_ERRORS.status(status) };
    const body = typeof response.body === 'string' ? response.body : Buffer.from(response.body).toString('utf8');
    if (body.length === 0) return { ok: false, error: FAKE_REMOTE_ERRORS.empty };
    const lines: string[] = [];
    const conditions: RuleCondition[] = [];
    const names = new Set<string>();
    for (const raw of body.split(/\r?\n/)) {
      const line = raw.trim();
      if (line === '' || isCommentLine(line)) continue;
      if (type === 'ruleset') {
        const c = parseCondition(line);
        if (c === null) continue;
        conditions.push(c);
        lines.push(line);
        continue;
      }
      if (!this.acceptNodeLine(line)) continue;
      const name = parseProxyLine(line)?.name;
      if (name === undefined || names.has(name)) continue;
      names.add(name);
      lines.push(line);
    }
    if (lines.length === 0) return { ok: false, error: FAKE_REMOTE_ERRORS.parse };
    return { ok: true, content: lines.join('\n'), conditions, accepted: lines.length };
  }

  private loadResource(res: LoadedResource): void {
    // 远端资源的内容是 Surge 的缓存（RemoteState），加载配置时不重新读取（未就绪的在 loadAll 中下载一次）
    if (res.remote) return;
    const content = readOrNull(res.location);
    this.watched.set(res.location, content);
    res.content = content;
    res.changeSeenAt = null;
    res.error = content === null ? 'file not found' : null;
    res.conditions =
      res.type === 'ruleset' && content !== null
        ? content
            .split(/\r?\n/)
            .filter((l) => !isCommentLine(l))
            .map((l) => parseCondition(l))
            .filter((c): c is RuleCondition => c !== null)
        : [];
  }

  private rebuildExternalNodes(): void {
    this.externalNodes.clear();
    for (const res of this.resources.values()) {
      const content = this.contentOf(res);
      if (res.type !== 'policy-group' || content === null) continue;
      for (const line of content.split(/\r?\n/)) {
        if (isCommentLine(line)) continue;
        const p = parseProxyLine(line);
        if (!p || this.externalNodes.has(p.name) || this.userProxies.has(p.name)) continue;
        const front = p.params['underlying-proxy'] ?? null;
        const frontMissing = front !== null && !this.userProxies.has(front);
        if (frontMissing && this.frontResolution === 'skip') continue;
        this.externalNodes.set(p.name, { name: p.name, line, type: p.type, server: p.server, port: p.port, front, frontMissing });
      }
    }
    for (const g of this.groups.values()) {
      const members = this.membersOf(g.name);
      const sel = this.selection.get(g.name);
      // select 组的选择失效（节点被删除、坏行被跳过）时回落到首成员：本应用的 SFE-ROUTE 首成员是 REJECT（回环矩阵：删除选中
      // 成员后落到 REJECT 只因为它排在首位）。
      if (sel === undefined || sel === null || !members.includes(sel)) this.selection.set(g.name, members[0] ?? null);
    }
  }

  private membersOf(groupName: string): string[] {
    const g = this.groups.get(groupName);
    if (!g) return [];
    const out = [...g.explicit];
    for (const value of g.policyPaths) {
      const res = this.resources.get(this.resourceKeyFor(value, 'policy-group'));
      const content = res ? this.contentOf(res) : null;
      if (!content) continue;
      for (const line of content.split(/\r?\n/)) {
        if (isCommentLine(line)) continue;
        const p = parseProxyLine(line);
        if (p && this.externalNodes.has(p.name) && !out.includes(p.name)) out.push(p.name);
      }
    }
    return out;
  }

  private resolvePolicy(policy: string, depth: number): { leaf: string; chain: string[]; rejected: boolean; frontMissing: boolean } {
    const up = policy.toUpperCase();
    if (REJECT_POLICIES.has(up)) return { leaf: up, chain: [up], rejected: true, frontMissing: false };
    if (up === 'DIRECT') return { leaf: 'DIRECT', chain: ['DIRECT'], rejected: false, frontMissing: false };
    if (depth > 8) return { leaf: 'REJECT', chain: ['REJECT'], rejected: true, frontMissing: false };
    if (this.groups.has(policy)) {
      const sel = this.selection.get(policy) ?? null;
      if (sel === null) return { leaf: 'REJECT', chain: [policy, 'REJECT'], rejected: true, frontMissing: false };
      const inner = this.resolvePolicy(sel, depth + 1);
      return { ...inner, chain: [policy, ...inner.chain] };
    }
    const node = this.userProxies.get(policy) ?? this.externalNodes.get(policy);
    if (!node) return { leaf: 'REJECT', chain: ['REJECT'], rejected: true, frontMissing: false };
    // `名称 = reject` 一类的节点（例如本应用的占位行 SFE-EMPTY）拒绝连接
    if (REJECT_POLICIES.has(node.type.toUpperCase())) return { leaf: node.name, chain: [node.name], rejected: true, frontMissing: false };
    if (node.front === null) return { leaf: node.name, chain: [node.name], rejected: false, frontMissing: false };
    if (node.frontMissing) return { leaf: node.name, chain: [node.name, 'DIRECT'], rejected: false, frontMissing: true };
    const front = this.resolvePolicy(node.front, depth + 1);
    return { leaf: node.name, chain: [node.name, ...front.chain], rejected: front.rejected, frontMissing: front.frontMissing };
  }

  // ---------- 原语 ----------

  private async invoke<T>(name: string, effect: () => T): Promise<T> {
    this.calls[name] = (this.calls[name] ?? 0) + 1;
    if (!this.reachable) throw new SfeError('SURGE_UNREACHABLE', '连接 Surge 失败：模拟不可达');
    this.checkFileChanges();
    const fault = this.faults.get(name)?.shift();
    if (fault && !fault.afterEffect) throw fault.error;
    const lie = this.lies.get(name)?.shift();
    if (lie) return lie.value as T;
    const result = effect();
    if (fault) throw fault.error;
    return result;
  }

  mechanism(): MechanismMap {
    return Object.fromEntries(SURGE_PRIMITIVES.map((p) => [p, 'fake' as const]));
  }

  /** 整体重载配置：远端资源沿用缓存，只对未就绪的资源下载一次（见 loadAll）。 */
  reloadProfile(): Promise<void> {
    return this.invoke('reloadProfile', () => {
      this.reloadCount++;
      this.loadAll();
      if (this.reloadClearsTempRules) this.temps = [];
    });
  }

  /**
   * 演示与测试用的运行实例（HostInfo.surgeInstance，替代 surge/running-instance.ts 的真实读取）：与真实读取一样
   * 全有或全无——Surge 没在运行为 not_running，缺构建号为 plist_unreadable，格式不对为 version_malformed。
   */
  async runningInstance(): Promise<RunningInstanceResult> {
    this.instanceReads++;
    if (this.instanceFailure !== null) return { ok: false, reason: this.instanceFailure };
    if (!this.reachable) return { ok: false, reason: 'not_running' };
    if (this.build === null) return { ok: false, reason: 'plist_unreadable' };
    if (!SURGE_VERSION_RE.test(this.version) || !SURGE_BUILD_RE.test(this.build)) return { ok: false, reason: 'version_malformed' };
    const startedAt = new Date(Math.floor(this.startedAt.getTime() / 1000) * 1000).toISOString();
    return { ok: true, instance: { pid: 404, startedAt, bundlePath: SURGE_APP_BUNDLE, bundleId: SURGE_BUNDLE_IDS[0]!, version: this.version, build: this.build } };
  }

  /** 与 `surge-cli --raw version` 的解析一致：缺少构建号或格式不对时输出无法识别（失败即关闭）。 */
  getVersion(): Promise<SurgeVersion> {
    return this.invoke('getVersion', () => {
      if (this.build === null || !SURGE_VERSION_RE.test(this.version) || !SURGE_BUILD_RE.test(this.build)) throw unrecognized('Surge 版本');
      return { version: this.version, build: this.build, coreVersion: this.coreVersion, controllerProtocol: this.controllerProtocol };
    });
  }

  getRuntimeInfo(): Promise<SurgeRuntimeInfo> {
    return this.invoke('getRuntimeInfo', () => ({
      startedAt: new Date(this.startedAt),
      uptimeSeconds: Math.max(0, Math.floor((this.now().getTime() - this.startedAt.getTime()) / 1000)),
    }));
  }

  getCurrentProfile(): Promise<SurgeProfileInfo> {
    return this.invoke('getCurrentProfile', () => ({ ...this.currentProfile }));
  }

  getTakeoverState(): Promise<TakeoverState> {
    return this.invoke('getTakeoverState', () => ({ ...this.takeover, checkedAt: this.now().toISOString() }));
  }

  getAutoReloadSetting(): Promise<boolean | null> {
    return this.invoke('getAutoReloadSetting', () => (this.reportedAutoReload === undefined ? this.autoReload : this.reportedAutoReload));
  }

  checkProfile(profilePath: string): Promise<SurgeCheckResult> {
    return this.invoke('checkProfile', () => {
      const override = this.checkResults.get(resolve(profilePath));
      if (override) return { ...override };
      const text = readOrNull(profilePath);
      if (text === null) return { ok: false, message: '配置文件不存在' };
      const parsed = parseProfile(text);
      if (findSections(parsed, 'Rule').length !== 1) return { ok: false, message: '缺少 [Rule] 段' };
      return { ok: true, message: 'OK' };
    });
  }

  listPolicies(): Promise<SurgePolicies> {
    return this.invoke('listPolicies', () => ({
      proxies: [...this.userProxies.keys(), ...this.externalNodes.keys()],
      groups: [...this.groups.keys()],
    }));
  }

  getPolicyDetail(name: string): Promise<SurgePolicyDetail> {
    return this.invoke('getPolicyDetail', () => {
      const node = this.userProxies.get(name) ?? this.externalNodes.get(name);
      if (node) {
        return { name, type: node.type, server: node.server, port: node.port, underlyingProxy: node.front, redactedRaw: redactProxyLine(node.line) };
      }
      const g = this.groups.get(name);
      if (g) return { name, type: g.type, server: null, port: null, underlyingProxy: null, redactedRaw: null };
      if (BUILTIN_POLICIES.has(name.toUpperCase())) return { name, type: 'builtin', server: null, port: null, underlyingProxy: null, redactedRaw: null };
      throw commandFailed('读取策略详情失败：策略不存在');
    });
  }

  getGroupMembers(group: string): Promise<string[]> {
    return this.invoke('getGroupMembers', () => {
      if (!this.groups.has(group)) throw commandFailed('读取策略组失败：组不存在');
      return this.membersOf(group);
    });
  }

  getGroupSelection(group: string): Promise<string | null> {
    return this.invoke('getGroupSelection', () => {
      if (!this.groups.has(group)) throw commandFailed('读取策略组失败：组不存在');
      return this.selection.get(group) ?? null;
    });
  }

  selectGroupPolicy(group: string, policy: string): Promise<void> {
    return this.invoke('selectGroupPolicy', () => {
      if (!this.groups.has(group)) throw commandFailed('选择策略失败：组不存在');
      if (!this.membersOf(group).includes(policy)) throw commandFailed('选择策略失败：不是组成员');
      this.selection.set(group, policy);
    });
  }

  testPolicy(policy: string, _url: string): Promise<SurgePolicyTestResult> {
    return this.invoke('testPolicy', () => {
      const override = this.policyTests.get(policy);
      if (override) return { ...override };
      const known = this.groups.has(policy) || this.userProxies.has(policy) || this.externalNodes.has(policy);
      if (!known) return { ok: false, latencyMs: null, error: '策略不存在' };
      const r = this.resolvePolicy(policy, 0);
      return r.rejected ? { ok: false, latencyMs: null, error: '策略拒绝连接' } : { ok: true, latencyMs: 42, error: null };
    });
  }

  /** 有效规则列表，顺序与 evaluate 相同（模块与临时规则之间的先后是假设，TODO(P0)，见 evaluate）。 */
  listRules(): Promise<SurgeRuleRecord[]> {
    return this.invoke('listRules', () => [
      ...this.modules.map((m) => ({ text: m.text, source: 'module' as const, moduleName: m.moduleName })),
      ...this.temps.map((text) => ({ text, source: 'temp_rule' as const, moduleName: null })),
      ...this.profileRules.map((text) => ({ text, source: 'profile' as const, moduleName: null })),
    ]);
  }

  /** 与 `rule match` 相同：按当前有效规则求值一次，不建立连接、不记录请求。参数校验与 CLI 相同。 */
  matchRule(input: SurgeRuleMatchInput): Promise<SurgeRuleMatchResult> {
    return this.invoke('matchRule', () => {
      this.requireRuleCommands('matchRule');
      ruleMatchArgs(input);
      const protocol = input.protocol === 'UDP' || input.protocol === 'QUIC' ? 'udp' : 'tcp';
      try {
        return this.evaluate({ processPath: input.processPath, host: input.host, protocol });
      } catch (e) {
        // 与 CLI 相同：求值中止的 rule match 以非零退出失败（结果未知），不是 Unknown command
        if (e instanceof DnsLookupFailure) throw fakeRuleMatchDnsError();
        throw e;
      }
    });
  }

  listActiveRequests(): Promise<SurgeRequestRecord[]> {
    return this.invoke('listActiveRequests', () => [...this.active.values()].map(({ chain: _c, frontMissing: _f, ...r }) => ({ ...r })));
  }

  listRecentRequests(): Promise<SurgeRequestRecord[]> {
    return this.invoke('listRecentRequests', () => this.recent.map(({ chain: _c, frontMissing: _f, ...r }) => ({ ...r })));
  }

  killRequest(id: string): Promise<void> {
    return this.invoke('killRequest', () => {
      const r = this.active.get(id);
      if (!r) throw commandFailed('结束请求失败：请求不存在');
      r.completed = true;
      this.active.delete(id);
    });
  }

  /**
   * 与真实解析（parse-output parseExternalResources）相同的字段：location 经 redactUrls 遮盖，locationHash 是原样位置的
   * SHA-256。远端资源：未就绪（从未成功下载）时 error 为 'not_ready'、没有更新时间；就绪后 error 是最近一次下载失败的文字
   * （成功时为 null）；有进行中的下载时 updating 为 true。本地资源没有更新时间、updating 为 false。
   */
  listExternalResources(): Promise<SurgeExternalResource[]> {
    return this.invoke('listExternalResources', () =>
      [...this.resources.values()].map((r) => {
        const st = r.remote;
        const ready = st !== null && st.content !== null;
        return {
          key: r.key,
          type: r.type,
          location: r.location,
          locationHash: r.locationHash,
          lastUpdatedAt: ready && st.updatedAt ? new Date(st.updatedAt) : null,
          error: st === null ? r.error : ready ? st.error : 'not_ready',
          local: st === null,
          updating: st !== null && st.pending !== null,
          fromModule: null,
        };
      }),
    );
  }

  /**
   * 单个 key：本地资源被跳过（不重新读取文件，结果不算刷新）；远端资源只下载这一项（从不重载配置、不碰其他资源），结果与
   * 真实适配器相同地经 parseResourceUpdateText（`<key>: success` 或 `<key>: <错误文字>` → SURGE_COMMAND_FAILED）；不存在的
   * key 失败（HTTP 400）。更新全部资源（'all'、空 key）从不是本应用的调用：拒绝并计入 updateAllAttempts。打开 autoReload 时，
   * 每次原语调用之前的文件变化检查仍会整体重载改过的配置——那是模拟的自动重载，不是这次更新。
   * 进行中的下载（slowUpdate、timeoutNextUpdate 的延迟生效）期间再次更新同一 key：不另起下载，答复与进行中的那次相同（假设，
   * TODO(P0)：loopback_publish_crash 记录真实行为）。
   */
  updateExternalResource(key: string): Promise<SurgeResourceUpdateResult> {
    if (typeof key !== 'string' || key.trim() === '' || key.trim().toLowerCase() === 'all') {
      this.calls.updateExternalResource = (this.calls.updateExternalResource ?? 0) + 1;
      this.updateAllAttempts++;
      return Promise.reject(new SfeError('INTERNAL', '假 Surge 拒绝更新全部外部资源：本应用只对单个 key 执行更新'));
    }
    return this.invoke('updateExternalResource', () => {
      const res = this.resources.get(key);
      if (!res) throw commandFailed('更新外部资源失败：资源不存在');
      if (res.local || !res.remote) return { key, refreshed: false, outcome: 'skipped' as const };
      const st = res.remote;
      if (st.pending !== null) {
        if (st.pending.reply === 'timeout') throw resourceUpdateTimeoutError();
        return { key, refreshed: true, outcome: 'downloaded' as const };
      }
      const timeout = this.updateTimeouts.shift();
      if (timeout) {
        // 适配器等待超时，而 Surge 端的更新照样生效（立即，或 updating 一段时间之后）
        if (timeout.applyAfterMs > 0) {
          st.pending = { trigger: 'update', completesAt: this.now().getTime() + timeout.applyAfterMs, reply: 'timeout' };
        } else {
          this.fetchNow(res, 'update');
          this.rebuildExternalNodes();
        }
        throw resourceUpdateTimeoutError();
      }
      const started = this.startFetch(res, 'update');
      if (!started.fetched) {
        // 慢更新：下载尚未发生就答复
        if (started.reply === 'timeout') throw resourceUpdateTimeoutError();
        return { key, refreshed: true, outcome: 'downloaded' as const };
      }
      this.rebuildExternalNodes();
      // 与真实适配器相同的文字结果解析：成功为 downloaded，资源错误为 SURGE_COMMAND_FAILED（真机上退出 0）
      return parseResourceUpdateText(`${key}: ${started.error ?? 'success'}`, key, (s) => s);
    });
  }

  listTempRules(): Promise<string[]> {
    return this.invoke('listTempRules', () => [...this.temps]);
  }

  addTempRule(rule: string): Promise<void> {
    return this.invoke('addTempRule', () => {
      this.requireRuleCommands('addTempRule');
      if (this.temps.includes(rule)) throw commandFailed('添加临时规则失败：规则已存在');
      if (!parseRule(rule)) throw commandFailed('添加临时规则失败：规则无法解析');
      if (this.tempRuleInsertion === 'head') this.temps.unshift(rule);
      else this.temps.push(rule);
    });
  }

  removeTempRule(rule: string): Promise<void> {
    return this.invoke('removeTempRule', () => {
      this.requireRuleCommands('removeTempRule');
      const i = this.temps.indexOf(rule);
      if (i < 0) throw commandFailed('删除临时规则失败：规则不存在');
      this.temps.splice(i, 1);
    });
  }
}

export interface FakeEnvironmentOptions {
  entryStrategy?: 'ruleset_resource' | 'temp_rule';
  processPaths?: string[];
  verifyHost?: string;
  /** 额外写入 [Rule] 受管理段之后的用户规则（放在 FINAL 之前）。 */
  userRules?: string[];
  /** 用户规则之后、FINAL 之前的 IP 规则（缺省 FAKE_IP_RULE，不带 no-resolve）；null 表示不写。 */
  ipRule?: string | null;
  /**
   * D10：SFE-ROUTE 的 policy-path 指向本机资源服务（loopbackGroupBlockLines(url)，url 须是 nodeResourceUrl 的结果），不写
   * sfe-nodes.list。给出 request（通常是 virtualBinder 的 request）时，返回值的 remoteSource 经它下载（loopbackRemoteSource）。
   */
  resource?: { url: string; request?: LoopbackRequest };
  /**
   * 旧版（D7）的本地文件引用（LEGACY_NODE_GROUP_LINE）与占位的 sfe-nodes.list：迁移（重新合并改用本机资源服务）与旧组行停泊的
   * 测试。与 resource 互斥。两者都不给时同样是旧版环境：只检验入口策略或本地资源语义（skipped、文件监视）的假 Surge 测试
   * 不涉及节点资源模型；引擎夹具（harness）与演示总是给出 resource 或明确的 legacy。
   */
  legacy?: boolean;
}

export interface FakeEnvironment {
  directory: string;
  profileName: string;
  profilePath: string;
  /** 写入的本应用文件（相对配置目录）。回环环境没有 sfe-nodes.list。 */
  files: string[];
  /** 节点资源模型：loopback（给出 resource）或 legacy。 */
  nodeResource: 'loopback' | 'legacy';
  /** 给出 resource.request 时接到它的下载来源（交给 FakeSurgeOptions.remoteSource），否则为 null。 */
  remoteSource: FakeRemoteSource | null;
}

/**
 * 合成工作配置：用户节点（合成占位值）、FINAL 规则与 SFE 受管理段；节点组受管理段按 resource（本机资源服务地址，D10）或
 * legacy（本地 sfe-nodes.list 与占位文件）写入。
 */
export function createFakeSurgeEnvironment(dir: string, opts: FakeEnvironmentOptions = {}): FakeEnvironment {
  if (opts.resource !== undefined && opts.legacy === true) throw new Error('createFakeSurgeEnvironment: resource and legacy are mutually exclusive');
  const loopback = opts.resource !== undefined;
  // 地址不对时 loopbackGroupBlockLines 抛 VALIDATION_FAILED（不带出地址）
  const groupLines = loopback ? loopbackGroupBlockLines(opts.resource!.url) : groupBlockLines();
  const directory = resolve(dir);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const strategy = opts.entryStrategy ?? 'ruleset_resource';
  const entryOpts = { processPaths: opts.processPaths ?? [FAKE_SAFARI_PATH], verifyHost: opts.verifyHost ?? FAKE_VERIFY_HOST };
  const entryLines = strategy === 'ruleset_resource' ? entryRuleSetBlockLines() : [];
  const profile = [
    '[General]',
    'loglevel = notify',
    'skip-proxy = 127.0.0.1, localhost',
    '',
    '[Proxy]',
    'Front-A = socks5, 192.0.2.10, 1080, username=example-user, password=example-pass',
    'Front-B = http, 192.0.2.11, 8080',
    '',
    '[Proxy Group]',
    'Daily = select, Front-A, Front-B, DIRECT',
    '# SFE-BEGIN group v1',
    ...groupLines,
    '# SFE-END group',
    '',
    '[Rule]',
    '# SFE-BEGIN entry v1',
    ...entryLines,
    '# SFE-END entry',
    ...(opts.userRules ?? ['DOMAIN-SUFFIX,daily.example.test,Daily']),
    ...(opts.ipRule === null ? [] : [opts.ipRule ?? FAKE_IP_RULE]),
    'FINAL,DIRECT',
    '',
  ].join('\n');
  const profileName = WORKING_PROFILE_NAME;
  const profilePath = join(directory, `${profileName}.conf`);
  writeFileSync(profilePath, profile, { mode: 0o600 });
  const files: string[] = [];
  if (!loopback) {
    files.push(NODE_RESOURCE_FILE);
    writeFileSync(join(directory, NODE_RESOURCE_FILE), resourceFile(0, []), { mode: 0o600 });
  }
  if (strategy === 'ruleset_resource') {
    for (const bit of ENTRY_BITS_IN_ORDER) {
      writeFileSync(join(directory, ENTRY_RULESET_FILES[bit]), entryRuleSetFileContent(bit, false, entryOpts), { mode: 0o600 });
      files.push(ENTRY_RULESET_FILES[bit]);
    }
  }
  const request = opts.resource?.request;
  return {
    directory,
    profileName,
    profilePath,
    files,
    nodeResource: loopback ? 'loopback' : 'legacy',
    remoteSource: request ? loopbackRemoteSource(request) : null,
  };
}
