// 运行中 Surge 实例的版本与构建号（docs/ARCHITECTURE.md §5.2），不经 surge-cli（6.5 没有版本命令，--version
// 进入交互模式）。定位当前用户唯一的 Surge 主进程 → 它的 .app 包 → Info.plist 的 CFBundleShortVersionString 与
// CFBundleVersion；只有能证明磁盘上的包就是正在运行的那一份时才接受：
// 1. ps（C 语言环境、UTC）中当前用户、可执行文件在 <包>/Contents/MacOS/ 下、包的真实路径等于 /Applications/Surge.app
//    的进程；先按 Info.plist 的 CFBundleExecutable 过滤，再要求恰好一个（其他位置的 Surge.app 同时在运行也不接受）；
// 2. 启动时间严格按 "%a %b %e %H:%M:%S %Y"（UTC）解析到秒；
// 3. 先 stat Info.plist 与主可执行文件，再用 plutil 读取包标识（必须是实测确认过的）、版本与构建号（A0 的格式）；
// 4. 两个文件的 ctime 与 birthtime 都严格早于启动秒（同一秒内按已修改处理；解包与 cp -p 会保留旧 mtime，不用 mtime）；
// 5. lsof 显示该进程映射的可执行文件与磁盘上的是同一 inode 与路径（整包被改名替换时 ctime 不变，但 inode 不同）；
// 6. 包签名有效（codesign --verify --strict，把 Info.plist 绑定到可执行文件）；
// 7. 读取前后两次 stat 完全相同（读取期间没有被替换）。
// 任一条件不满足 → 版本未知（fail closed，依赖版本的能力按待验证处理）。只在 macOS 上运行；只执行固定绝对路径的
// /bin/ps、/usr/bin/plutil、/usr/sbin/lsof、/usr/bin/codesign，不经 shell，stdin 立即关闭（util/exec-fixed.ts）。
// 只读：从不写 Surge 或它的任何文件。服务与 P0 用同一个工厂（createDefaultSurgeInstanceReader），得到同一结论。

import { realpath as fsRealpath, stat as fsStat } from 'node:fs/promises';
import { execFixed } from '../util/exec-fixed.js';
import { SURGE_BUILD_RE, SURGE_VERSION_RE } from './capability-gate.js';
import { codesignArgs } from './cli-adapter.js';

/** 期望的 Surge.app（与 verifyCliPath 要求的包前缀一致）。 */
export const SURGE_APP_BUNDLE = '/Applications/Surge.app';

/**
 * 接受的 CFBundleIdentifier。
 * TODO(P0): 在测试 Mac 上用 `p0 instance`（P0-RUNBOOK V2）确认直接下载版的包标识后再定稿；Setapp 等其他发行渠道
 * 的包标识未经实测，不在此列（它们的路径也不是 /Applications/Surge.app）。
 */
export const SURGE_BUNDLE_IDS: readonly string[] = ['com.nssurge.surge-mac'];

/** 读取时执行的固定程序。 */
export const RUNNING_INSTANCE_BINARIES = {
  ps: '/bin/ps',
  plutil: '/usr/bin/plutil',
  lsof: '/usr/sbin/lsof',
  codesign: '/usr/bin/codesign',
} as const;

/** ps 的完整环境：英文、UTC 的启动时间，不受用户语言、时区与夏令时影响。 */
export const RUNNING_INSTANCE_PS_ENV: Readonly<Record<string, string>> = { LC_ALL: 'C', LANG: 'C', TZ: 'UTC', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };

export const PS_INSTANCE_ARGS = ['-ww', '-axo', 'pid=,uid=,lstart=,comm='] as const;

export type RunningInstanceFailure =
  | 'not_darwin'
  | 'unavailable'
  | 'read_failed'
  | 'ps_failed'
  | 'not_running'
  | 'multiple_instances'
  | 'translocated'
  | 'bundle_mismatch'
  | 'start_time_unparseable'
  | 'plist_unreadable'
  | 'bundle_id_unrecognized'
  | 'version_malformed'
  | 'modified_after_start'
  | 'running_image_unverifiable'
  | 'running_image_mismatch'
  | 'signature_invalid'
  | 'changed_during_read';

/** 失败原因的说明（简体中文，不含任何输出原文）。 */
export const RUNNING_INSTANCE_FAILURE_TEXT: Readonly<Record<RunningInstanceFailure, string>> = {
  not_darwin: '不是 macOS，无法读取运行中的 Surge',
  unavailable: '没有可用的运行实例读取',
  read_failed: '读取运行中的 Surge 时出错',
  ps_failed: '无法读取进程列表',
  not_running: '没有找到当前用户运行中的 /Applications/Surge.app',
  multiple_instances: '有多个运行中的 Surge',
  translocated: 'Surge 从系统隔离位置运行（App Translocation），请把它移到“应用程序”文件夹后重新打开',
  bundle_mismatch: '运行中的 Surge 不是 /Applications/Surge.app',
  start_time_unparseable: '无法识别 Surge 的启动时间',
  plist_unreadable: '无法读取 Surge 包信息',
  bundle_id_unrecognized: 'Surge 包标识未经实测确认',
  version_malformed: 'Surge 包中的版本或构建号格式无法识别',
  modified_after_start: 'Surge 启动后包被更新或修改，请重新打开 Surge',
  running_image_unverifiable: '无法确认运行中的 Surge 主程序',
  running_image_mismatch: '运行中的 Surge 与磁盘上的包不是同一份，请重新打开 Surge',
  signature_invalid: 'Surge 包签名校验未通过',
  changed_during_read: '读取期间 Surge 包被修改',
};

export const RUNNING_INSTANCE_FAILURES = Object.keys(RUNNING_INSTANCE_FAILURE_TEXT) as RunningInstanceFailure[];

export function isRunningInstanceFailure(v: unknown): v is RunningInstanceFailure {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(RUNNING_INSTANCE_FAILURE_TEXT, v);
}

export interface RunningSurgeInstance {
  pid: number;
  /** 进程启动时间（UTC，秒精度）。 */
  startedAt: string;
  /** 包的真实路径。 */
  bundlePath: string;
  bundleId: string;
  version: string;
  build: string;
}

export type RunningInstanceResult = { ok: true; instance: RunningSurgeInstance } | { ok: false; reason: RunningInstanceFailure };

export interface RunningInstanceExecResult {
  stdout: string;
  stderr: string;
  /** 退出码；无法启动、超时或被信号结束时为 -1。 */
  code: number;
}

/** 与 P0 system.ts 的 ExecFn 同形（P0 可以直接传入自己的执行器）。 */
export type RunningInstanceExec = (
  file: string,
  args: readonly string[],
  opts: { timeoutMs: number; maxBuffer?: number; env?: NodeJS.ProcessEnv },
) => Promise<RunningInstanceExecResult>;

export interface RunningInstanceFileId {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  birthtimeNs: bigint;
}

export interface RunningInstanceDeps {
  platform: NodeJS.Platform;
  /** 当前用户 uid；只接受该用户的进程。 */
  uid: number;
  exec: RunningInstanceExec;
  realpath: (p: string) => Promise<string>;
  stat: (p: string) => Promise<RunningInstanceFileId>;
  /** 计时（毫秒，只用于证据）；缺省 performance.now。 */
  clock?: () => number;
}

export interface RunningInstanceOptions {
  /** 期望的 Surge.app（缺省 SURGE_APP_BUNDLE）。 */
  expectedBundle?: string;
  /** 接受的 CFBundleIdentifier（缺省 SURGE_BUNDLE_IDS）。 */
  bundleIds?: readonly string[];
  /** 记录的 Team ID；null 时只做 --verify --strict（与 CLI 路径校验一致）。只能让校验更严。 */
  teamId: string | null;
}

/** 规则编号对应设计 B 的步骤；证据（P0 inventory/instance）逐条记录结果与耗时。 */
export type RunningInstanceRule =
  | 'platform'
  | 'process'
  | 'bundle_executable'
  | 'start_time'
  | 'info_plist'
  | 'not_modified'
  | 'running_image'
  | 'signature'
  | 'stable';

export interface RunningInstanceStep {
  rule: RunningInstanceRule;
  outcome: 'pass' | 'fail' | 'cached';
  /** 计数、代码、时间差与路径；从不含 ps/lsof/codesign 的输出原文。 */
  detail: Record<string, unknown>;
  ms: number;
}

export interface RunningInstanceReport {
  result: RunningInstanceResult;
  steps: RunningInstanceStep[];
  /** 包信息与签名结果是否来自缓存。 */
  cached: boolean;
}

export interface RunningInstanceReader {
  read(): Promise<RunningInstanceResult>;
  /** 与 read 相同，另带逐条规则的证据（P0 用）。 */
  inspect(): Promise<RunningInstanceReport>;
}

// ---------- 解析（纯函数） ----------

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// %a %b %e %H:%M:%S %Y：%e 是空格补齐的日（" 1" 或 "21"）
const LSTART_RE = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ( [1-9]|[12]\d|3[01]) ([01]\d|2[0-3]):([0-5]\d):([0-5]\d) (\d{4})$/;

/** C 语言环境、TZ=UTC 下 ps 的 lstart → 自纪元起的整秒；格式、日期或星期不一致时为 null。 */
export function parseLstartUtc(text: string): number | null {
  const m = LSTART_RE.exec(text);
  if (!m) return null;
  const [, wd, mon, d, hh, mm, ss, yyyy] = m;
  const day = Number(d!.trim());
  const ms = Date.UTC(Number(yyyy), MONTHS.indexOf(mon!), day, Number(hh), Number(mm), Number(ss));
  const back = new Date(ms);
  // 拒绝 Feb 31 之类会被 Date.UTC 进位的日期，以及星期与日期不一致的值
  if (back.getUTCDate() !== day || back.getUTCMonth() !== MONTHS.indexOf(mon!) || WEEKDAYS[back.getUTCDay()] !== wd) return null;
  return ms / 1000;
}

export interface PsInstanceLine {
  pid: number;
  uid: number;
  /** null：该行的启动时间无法识别。 */
  startSec: number | null;
  path: string;
}

/** `ps -ww -axo pid=,uid=,lstart=,comm=` 的输出：comm 是最后一列（允许含空格）；只保留可执行文件为绝对路径的行。 */
export function parsePsInstanceLines(text: string): PsInstanceLine[] {
  const out: PsInstanceLine[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\d{1,10})\s+(\d{1,10})\s+(.+?)\s+(\/.*?)\s*$/.exec(line);
    if (!m) continue;
    out.push({ pid: Number(m[1]), uid: Number(m[2]), startSec: parseLstartUtc(m[3]!), path: m[4]! });
  }
  return out;
}

const MAIN_EXE_RE = /^(\/.+\.app)\/Contents\/MacOS\/([^/]+)$/;

/** <包>.app/Contents/MacOS/<程序> → 包路径与程序名；其他路径（surge-cli、特权助手、插件等）为 null。 */
export function bundleOfMainExecutable(path: string): { bundle: string; exe: string } | null {
  const m = MAIN_EXE_RE.exec(path);
  return m ? { bundle: m[1]!, exe: m[2]! } : null;
}

/** `lsof -nP -a -p <pid> -d txt -F in` 的字段输出：进程映射的文件（i inode、n 名称）。 */
export function parseLsofTxt(text: string): Array<{ inode: bigint; name: string }> {
  const out: Array<{ inode: bigint; name: string }> = [];
  let inode: bigint | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('p') || line.startsWith('f')) inode = null;
    else if (/^i\d{1,20}$/.test(line)) inode = BigInt(line.slice(1));
    else if (line.startsWith('n') && inode !== null) {
      out.push({ inode, name: line.slice(1) });
      inode = null;
    }
  }
  return out;
}

const NS_PER_S = 1_000_000_000n;

/** ctime 与 birthtime 都必须已知且严格早于启动秒；同一秒内无法判断先后，按已修改处理。 */
export function predatesStart(id: RunningInstanceFileId, startSec: number): boolean {
  const limit = BigInt(startSec) * NS_PER_S;
  return id.ctimeNs > 0n && id.ctimeNs < limit && id.birthtimeNs > 0n && id.birthtimeNs < limit;
}

function sameIdentity(a: RunningInstanceFileId, b: RunningInstanceFileId): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.birthtimeNs === b.birthtimeNs;
}

function msBefore(ns: bigint, startSec: number): number {
  return Number((ns - BigInt(startSec) * NS_PER_S) / 1_000_000n);
}

// plist 字符串值：可打印 ASCII，首尾不是空格
const PLIST_VALUE_RE = /^[\x21-\x7e](?:[\x20-\x7e]{0,126}[\x21-\x7e])?$/;
const TEAM_ID_RE = /^[A-Z0-9]{10}$/;
const SURGE_LIKE_RE = /surge|nssurge/i;

// ---------- 读取 ----------

export function createRunningInstanceReader(deps: RunningInstanceDeps, opts: RunningInstanceOptions): RunningInstanceReader {
  const expectedBundle = opts.expectedBundle ?? SURGE_APP_BUNDLE;
  const bundleIds = opts.bundleIds ?? SURGE_BUNDLE_IDS;
  const bundleName = expectedBundle.slice(expectedBundle.lastIndexOf('/') + 1);
  const clock = deps.clock ?? (() => performance.now());
  let cache: { key: string; instance: Omit<RunningSurgeInstance, 'pid' | 'startedAt'> } | null = null;

  async function plistValue(plistPath: string, key: string): Promise<string | null> {
    const r = await deps.exec(RUNNING_INSTANCE_BINARIES.plutil, ['-extract', key, 'raw', '-o', '-', plistPath], { timeoutMs: 10_000 });
    const v = r.stdout.endsWith('\n') ? r.stdout.slice(0, -1) : r.stdout;
    return r.code === 0 && PLIST_VALUE_RE.test(v) ? v : null;
  }

  async function inspect(): Promise<RunningInstanceReport> {
    const steps: RunningInstanceStep[] = [];
    let cached = false;
    let t = clock();
    const step = (rule: RunningInstanceRule, outcome: RunningInstanceStep['outcome'], detail: Record<string, unknown> = {}): void => {
      const now = clock();
      steps.push({ rule, outcome, detail, ms: Math.round(now - t) });
      t = now;
    };
    const fail = (rule: RunningInstanceRule, reason: RunningInstanceFailure, detail: Record<string, unknown> = {}): RunningInstanceReport => {
      step(rule, 'fail', { reason, ...detail });
      return { result: { ok: false, reason }, steps, cached };
    };

    if (deps.platform !== 'darwin') return fail('platform', 'not_darwin');
    step('platform', 'pass');

    // 1. 进程
    let expectedReal: string | null;
    try {
      expectedReal = await deps.realpath(expectedBundle);
    } catch {
      expectedReal = null;
    }
    const ps = await deps.exec(RUNNING_INSTANCE_BINARIES.ps, PS_INSTANCE_ARGS, { timeoutMs: 10_000, maxBuffer: 16 * 1024 * 1024, env: { ...RUNNING_INSTANCE_PS_ENV } });
    if (ps.code !== 0) return fail('process', 'ps_failed', { code: ps.code });
    const lines = parsePsInstanceLines(ps.stdout);
    const inBundle: Array<PsInstanceLine & { exe: string }> = [];
    const others: Array<{ pid: number; uid: number; path: string; excluded: string }> = [];
    const realName = expectedReal === null ? null : expectedReal.slice(expectedReal.lastIndexOf('/') + 1);
    const insideExpected = (p: string | null): boolean =>
      p !== null && (p.startsWith(`${expectedBundle}/`) || (expectedReal !== null && p.startsWith(`${expectedReal}/`)));
    for (const l of lines) {
      const main = bundleOfMainExecutable(l.path);
      const record = (excluded: string): void => {
        others.push({ pid: l.pid, uid: l.uid, path: l.path, excluded });
      };
      // 与期望的包无关的进程只在路径像 Surge 时记入证据
      const recordIfSurgeLike = (excluded: string): void => {
        if (SURGE_LIKE_RE.test(l.path)) record(excluded);
      };
      // 其他用户的 Surge、root 特权助手
      if (l.uid !== deps.uid) {
        recordIfSurgeLike('other_user');
        continue;
      }
      // Contents/Applications/surge-cli 等不是 <包>/Contents/MacOS/ 下的主程序
      if (!main) {
        recordIfSurgeLike('not_main_executable');
        continue;
      }
      // 包内嵌套的登录项等助手 App
      if (insideExpected(main.bundle)) {
        record('nested_app');
        continue;
      }
      // 只对同名的包求真实路径（每次读取都要做，不对全部 App 做）
      const name = main.bundle.slice(main.bundle.lastIndexOf('/') + 1);
      if (name !== bundleName && name !== realName) {
        recordIfSurgeLike('other_app');
        continue;
      }
      let real: string | null;
      try {
        real = await deps.realpath(main.bundle);
      } catch {
        real = null;
      }
      if (expectedReal !== null && real === expectedReal) inBundle.push({ ...l, exe: main.exe });
      // 从 /Applications/Surge.app 启动，但该路径现在不存在或指向别处（运行中被移走、删除或替换）
      else if (main.bundle === expectedBundle) record('expected_path_changed');
      else if (insideExpected(real)) record('nested_app');
      else if (main.bundle.includes('/AppTranslocation/')) record('translocated');
      // 下载目录中的副本、Setapp 等其他位置的 Surge.app
      else record('other_bundle');
    }
    const otherSurgeApps = others.filter((o) => o.excluded === 'translocated' || o.excluded === 'other_bundle');
    // 没有可接受的进程时的原因：期望的路径在运行中被移走或替换 > 隔离位置 > 其他位置的副本 > 没有运行
    const noneFound = (): RunningInstanceFailure =>
      others.some((o) => o.excluded === 'expected_path_changed')
        ? 'running_image_mismatch'
        : otherSurgeApps.some((o) => o.excluded === 'translocated')
          ? 'translocated'
          : otherSurgeApps.length > 0
            ? 'bundle_mismatch'
            : 'not_running';
    const processDetail = { expectedBundle, expectedReal, lines: lines.length, inBundle: inBundle.length, others };
    if (expectedReal === null || inBundle.length === 0) return fail('process', noneFound(), processDetail);
    step('process', 'pass', processDetail);

    // 2. 先读 CFBundleExecutable，只保留可执行文件名与之相同的进程，再要求恰好一个
    const bundlePath = expectedReal;
    const exeName = await plistValue(`${bundlePath}/Contents/Info.plist`, 'CFBundleExecutable');
    if (exeName === null || exeName.includes('/')) return fail('bundle_executable', 'plist_unreadable', { missing: ['CFBundleExecutable'] });
    const executable = exeName;
    const mains = inBundle.filter((l) => l.exe === executable);
    const exeDetail = { executable, candidates: inBundle.map((l) => ({ pid: l.pid, exe: l.exe })), matching: mains.length, otherSurgeApps: otherSurgeApps.length };
    if (mains.length === 0) return fail('bundle_executable', noneFound(), exeDetail);
    if (mains.length > 1) return fail('bundle_executable', 'multiple_instances', exeDetail);
    // 另一份 Surge.app（其他位置或隔离位置）也在当前用户下运行：无法确定 CLI/HTTP 连接的是哪一份
    if (otherSurgeApps.length > 0) return fail('bundle_executable', 'multiple_instances', exeDetail);
    const proc = mains[0]!;
    step('bundle_executable', 'pass', exeDetail);

    // 3. 启动时间
    if (proc.startSec === null) return fail('start_time', 'start_time_unparseable', { pid: proc.pid });
    const startSec = proc.startSec;
    const startedAt = new Date(startSec * 1000).toISOString();
    step('start_time', 'pass', { pid: proc.pid, startedAt });

    // 4. 包信息：先 stat 两个文件，再读键（缓存按 pid、启动秒与两次 stat 结果）
    const plistPath = `${bundlePath}/Contents/Info.plist`;
    const exePath = `${bundlePath}/Contents/MacOS/${executable}`;
    let before: [RunningInstanceFileId, RunningInstanceFileId];
    try {
      before = [await deps.stat(plistPath), await deps.stat(exePath)];
    } catch {
      return fail('info_plist', 'plist_unreadable', { stat: false });
    }
    const key = [proc.pid, startSec, bundlePath, executable, ...before.flatMap((s) => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs, s.birthtimeNs])].join(':');
    let info: Omit<RunningSurgeInstance, 'pid' | 'startedAt'>;
    if (cache && cache.key === key) {
      info = cache.instance;
      cached = true;
      step('info_plist', 'cached', { bundleId: info.bundleId, version: info.version, build: info.build });
    } else {
      const bundleId = await plistValue(plistPath, 'CFBundleIdentifier');
      const exeAgain = await plistValue(plistPath, 'CFBundleExecutable');
      const version = await plistValue(plistPath, 'CFBundleShortVersionString');
      const build = await plistValue(plistPath, 'CFBundleVersion');
      const missing = Object.entries({ CFBundleIdentifier: bundleId, CFBundleExecutable: exeAgain, CFBundleShortVersionString: version, CFBundleVersion: build })
        .filter(([, v]) => v === null)
        .map(([k]) => k);
      if (missing.length > 0) return fail('info_plist', 'plist_unreadable', { missing });
      if (exeAgain !== executable) return fail('info_plist', 'changed_during_read', { key: 'CFBundleExecutable' });
      if (!bundleIds.includes(bundleId!)) return fail('info_plist', 'bundle_id_unrecognized', { bundleId });
      if (!SURGE_VERSION_RE.test(version!) || !SURGE_BUILD_RE.test(build!)) return fail('info_plist', 'version_malformed');
      info = { bundlePath, bundleId: bundleId!, version: version!, build: build! };
      step('info_plist', 'pass', { bundleId, version, build });
    }

    // 5. 启动后没有被修改
    const timing = {
      startedAt,
      plist: { ctimeMinusStartMs: msBefore(before[0].ctimeNs, startSec), birthtimeMinusStartMs: msBefore(before[0].birthtimeNs, startSec) },
      executable: { ctimeMinusStartMs: msBefore(before[1].ctimeNs, startSec), birthtimeMinusStartMs: msBefore(before[1].birthtimeNs, startSec) },
    };
    if (!before.every((s) => predatesStart(s, startSec))) return fail('not_modified', 'modified_after_start', timing);
    step('not_modified', 'pass', timing);

    // 6. 正在运行的就是这个文件
    const lsof = await deps.exec(RUNNING_INSTANCE_BINARIES.lsof, ['-nP', '-a', '-p', String(proc.pid), '-d', 'txt', '-F', 'in'], { timeoutMs: 10_000 });
    const mapped = lsof.code === 0 ? parseLsofTxt(lsof.stdout) : [];
    if (mapped.length === 0) return fail('running_image', 'running_image_unverifiable', { code: lsof.code, entries: 0 });
    let exeReal: string | null;
    try {
      exeReal = await deps.realpath(exePath);
    } catch {
      exeReal = null;
    }
    const samePath = (name: string): boolean => name === exePath || (exeReal !== null && name === exeReal);
    // 同一项的 inode 与路径都要一致（分别记录，便于 V4 核对哪一项不同）
    const lsofDetail = {
      code: lsof.code,
      entries: mapped.length,
      inodeMatch: mapped.some((m) => m.inode === before[1].ino),
      pathMatch: mapped.some((m) => samePath(m.name)),
      sameEntry: mapped.some((m) => m.inode === before[1].ino && samePath(m.name)),
    };
    if (!lsofDetail.sameEntry) return fail('running_image', 'running_image_mismatch', lsofDetail);
    step('running_image', 'pass', lsofDetail);

    // 7. 签名（与包信息一起缓存）
    if (cached) step('signature', 'cached');
    else {
      if (opts.teamId !== null && !TEAM_ID_RE.test(opts.teamId)) return fail('signature', 'signature_invalid', { invalidTeamId: true });
      const sig = await deps.exec(RUNNING_INSTANCE_BINARIES.codesign, codesignArgs(bundlePath, opts.teamId), { timeoutMs: 60_000 });
      const sigDetail = { code: sig.code, teamRequirement: opts.teamId !== null };
      if (sig.code !== 0) return fail('signature', 'signature_invalid', sigDetail);
      step('signature', 'pass', sigDetail);
    }

    // 8. 读取期间没有变化
    let after: [RunningInstanceFileId, RunningInstanceFileId];
    try {
      after = [await deps.stat(plistPath), await deps.stat(exePath)];
    } catch {
      return fail('stable', 'changed_during_read', { stat: false });
    }
    if (!sameIdentity(before[0], after[0]) || !sameIdentity(before[1], after[1])) return fail('stable', 'changed_during_read');
    step('stable', 'pass');
    cache = { key, instance: info };
    return { result: { ok: true, instance: { pid: proc.pid, startedAt, ...info } }, steps, cached };
  }

  return {
    inspect: async () => {
      try {
        return await inspect();
      } catch {
        // 注入的依赖意外抛出：按读取失败处理（不带原文）
        return { result: { ok: false, reason: 'read_failed' }, steps: [], cached: false };
      }
    },
    read: async () => {
      try {
        return (await inspect()).result;
      } catch {
        return { ok: false, reason: 'read_failed' };
      }
    },
  };
}

// ---------- 服务与 P0 共用的默认实现 ----------

/** 经 execFixed 执行（绝对路径、不经 shell、stdin 立即关闭）；与 P0 defaultExec 的退出码规则相同。 */
export const defaultRunningInstanceExec: RunningInstanceExec = async (file, args, opts) => {
  const r = await execFixed(file, args, {
    timeout: opts.timeoutMs,
    maxBuffer: opts.maxBuffer ?? 8 * 1024 * 1024,
    ...(opts.env !== undefined ? { env: opts.env } : {}),
  });
  if (!r.error) return { stdout: r.stdout, stderr: r.stderr, code: 0 };
  return { stdout: r.stdout, stderr: r.stderr, code: typeof r.error.code === 'number' ? r.error.code : -1 };
};

export async function defaultRunningInstanceStat(p: string): Promise<RunningInstanceFileId> {
  const s = await fsStat(p, { bigint: true });
  return { dev: s.dev, ino: s.ino, size: s.size, mtimeNs: s.mtimeNs, ctimeNs: s.ctimeNs, birthtimeNs: s.birthtimeNs };
}

export interface DefaultSurgeInstanceReaderOptions {
  platform: NodeJS.Platform;
  uid: number;
  /** 缺省 defaultRunningInstanceExec；P0 传入自己的执行器（同一 execFixed）。 */
  exec?: RunningInstanceExec;
  teamId: string | null;
}

/** 真实的读取依赖：真实路径、bigint stat 与固定执行方式（P0 的自测 App 核对也用它，只换期望的包）。 */
export function defaultRunningInstanceDeps(opts: Omit<DefaultSurgeInstanceReaderOptions, 'teamId'>): RunningInstanceDeps {
  return {
    platform: opts.platform,
    uid: opts.uid,
    exec: opts.exec ?? defaultRunningInstanceExec,
    realpath: (p) => fsRealpath(p),
    stat: defaultRunningInstanceStat,
  };
}

/** 服务与 P0 共用的工厂：同一常量（/Applications/Surge.app、SURGE_BUNDLE_IDS）、同一 stat(bigint)、同一执行方式（stdin 关闭、ps 固定环境）。 */
export function createDefaultSurgeInstanceReader(opts: DefaultSurgeInstanceReaderOptions): RunningInstanceReader {
  return createRunningInstanceReader(defaultRunningInstanceDeps(opts), { expectedBundle: SURGE_APP_BUNDLE, bundleIds: SURGE_BUNDLE_IDS, teamId: opts.teamId });
}
