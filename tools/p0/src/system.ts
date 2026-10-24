// 只读系统信息：sw_vers、Info.plist（defaults read）、进程列表（ps -axo pid,comm）、codesign、后台安全改进的暂存位置。
// 子进程一律经服务的 execFixed：execFile（不经 shell）、固定绝对路径与参数、stdin 启动后立即关闭。

import { execFixed } from './deps.js';
import {
  STAGED_CRYPTEX_PATH,
  pathPresence as servicePathPresence,
  restartPendingFrom,
  versionExtraFromSwVers,
  type PathPresence,
} from '../../../service/src/engine/capabilities.js';

export interface ExecResult {
  stdout: string;
  stderr: string;
  /** 退出码；无法启动（含非绝对路径）、超时被结束时为 -1。 */
  code: number;
}

export interface ExecOptions {
  timeoutMs?: number;
  maxBuffer?: number;
  /** 子进程的完整环境（不与本进程合并），例如固定 LC_ALL/TZ；缺省继承本进程。 */
  env?: NodeJS.ProcessEnv;
}

export type ExecFn = (file: string, args: readonly string[], opts?: ExecOptions) => Promise<ExecResult>;

export const defaultExec: ExecFn = async (file, args, opts = {}) => {
  const r = await execFixed(file, args, {
    timeout: opts.timeoutMs ?? 15_000,
    maxBuffer: opts.maxBuffer ?? 8 * 1024 * 1024,
    ...(opts.env !== undefined ? { env: opts.env } : {}),
  });
  if (!r.error) return { stdout: r.stdout, stderr: r.stderr, code: 0 };
  return { stdout: r.stdout, stderr: r.stderr, code: typeof r.error.code === 'number' ? r.error.code : -1 };
};

export const SAFARI_APP = '/Applications/Safari.app';
export const SURGE_APP = '/Applications/Surge.app';
export const DEFAULT_SURGE_CLI = '/Applications/Surge.app/Contents/Applications/surge-cli';
export const DEFAULT_HOST_APP = '/Applications/SafariProfileSurge.app';

export async function swVers(exec: ExecFn): Promise<{ productVersion: string | null; buildVersion: string | null; productVersionExtra: string | null }> {
  const read = async (flag: string): Promise<string | null> => {
    const r = await exec('/usr/bin/sw_vers', [flag]);
    const v = r.stdout.trim();
    return r.code === 0 && /^[A-Za-z0-9.]{1,32}$/.test(v) ? v : null;
  };
  const productVersion = await read('-productVersion');
  const buildVersion = await read('-buildVersion');
  // 补充版本（后台安全改进）与服务同一规则：没有安装为 'none'，不认识的输出为 null
  const productVersionExtra = versionExtraFromSwVers(await exec('/usr/bin/sw_vers', ['-productVersionExtra']));
  return { productVersion, buildVersion, productVersionExtra };
}

/**
 * 是否有已安装、要重启 Mac 才完全生效的后台安全改进（与服务同一规则：暂存位置存在为 'yes'，不存在为 'no'，无法确认为
 * null）。TODO(P0)：暂存位置是测试 Mac 上的观察，按 P0-RUNBOOK §1.6 核对。presence 只供离线测试替换。
 */
export async function restartPending(presence: (path: string) => Promise<PathPresence> = servicePathPresence): Promise<'yes' | 'no' | null> {
  return restartPendingFrom(await presence(STAGED_CRYPTEX_PATH));
}

/** 读取 App 包 Info.plist 的字符串键（defaults read 需要去掉 .plist 扩展名的路径）。 */
export async function plistValue(exec: ExecFn, appPath: string, key: string): Promise<string | null> {
  const r = await exec('/usr/bin/defaults', ['read', `${appPath}/Contents/Info`, key]);
  const v = r.stdout.trim();
  return r.code === 0 && /^[A-Za-z0-9._ ()-]{1,64}$/.test(v) ? v : null;
}

export async function appVersion(exec: ExecFn, appPath: string): Promise<{ version: string | null; build: string | null }> {
  return { version: await plistValue(exec, appPath, 'CFBundleShortVersionString'), build: await plistValue(exec, appPath, 'CFBundleVersion') };
}

export interface ProcessEntry {
  pid: number;
  path: string;
}

/**
 * 解析 `ps -axo pid,comm` 输出。comm 是进程自己提供的 argv[0]，不是内核给出的可执行文件路径（ps(1)：“a process is
 * entitled to destroy this information”；adv_cmds 的 print.c 读 KERN_PROCARGS2 时跳过 exec_path），只作候选、未经核对。
 * 需要确认是哪个文件时以 lsof txt 的 inode 与路径为准（服务的运行实例读取就是这样做的）。
 */
export function parsePsOutput(text: string): ProcessEntry[] {
  const out: ProcessEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    out.push({ pid: Number(m[1]), path: m[2]! });
  }
  return out;
}

/** 路径中含 WebKit 或 Safari 的进程候选（去重排序）。只是候选、未经核对（路径来自 argv[0]）：归属以 Surge 请求记录为准。 */
export function webkitSafariCandidates(procs: readonly ProcessEntry[]): string[] {
  return [...new Set(procs.map((p) => p.path).filter((p) => p.startsWith('/') && /webkit|safari/i.test(p)))].sort();
}

export function surgeProcesses(procs: readonly ProcessEntry[]): ProcessEntry[] {
  return procs.filter((p) => /\/Surge\.app\//.test(p.path) || /\/com\.nssurge\./i.test(p.path));
}

export async function listProcesses(exec: ExecFn): Promise<ProcessEntry[]> {
  const r = await exec('/bin/ps', ['-axo', 'pid,comm']);
  return r.code === 0 ? parsePsOutput(r.stdout) : [];
}

/** 进程启动时间（ps -o lstart=）；用于识别 Surge 是否重启。 */
export async function processStartTime(exec: ExecFn, pid: number): Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const r = await exec('/bin/ps', ['-o', 'lstart=', '-p', String(pid)]);
  const v = r.stdout.trim();
  return r.code === 0 && v ? v : null;
}

/** Surge 主进程（及网络扩展）的启动时间指纹：任何一个变化都说明 Surge 重启过。 */
export async function surgeStartFingerprint(exec: ExecFn): Promise<string | null> {
  const procs = surgeProcesses(await listProcesses(exec));
  if (procs.length === 0) return null;
  const parts: string[] = [];
  for (const p of procs.sort((a, b) => a.path.localeCompare(b.path))) {
    parts.push(`${p.path}@${(await processStartTime(exec, p.pid)) ?? '?'}`);
  }
  return parts.join('|');
}

/** codesign -dv 输出中的 TeamIdentifier。 */
export function parseTeamIdentifier(text: string): string | null {
  const m = /^TeamIdentifier=([A-Z0-9]{10})\s*$/m.exec(text);
  return m ? m[1]! : null;
}

export async function codesignTeamId(exec: ExecFn, appPath: string): Promise<string | null> {
  const r = await exec('/usr/bin/codesign', ['-dv', '--verbose=2', appPath]);
  return parseTeamIdentifier(`${r.stdout}\n${r.stderr}`);
}
