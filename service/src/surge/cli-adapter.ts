// CLI 实现：execFile（不经 shell，stdin 立即关闭）、固定 argv、超时与输出上限。未映射到 cli 的原语一律
// CAPABILITY_UNVERIFIED；交互模式提示先于其他分类识别为命令失败；子进程错误与 stderr 先脱敏、截断再进入
// 错误信息。见 docs/ARCHITECTURE.md §5.1。

import { SfeError } from '@sfe/contract';
import type { SurgeAdapter } from '../ports.js';
import { execFixed } from '../util/exec-fixed.js';
import { CLI_COMMANDS, type CliCommand, type CliOutput } from './cli-commands.js';
import { capabilityUnverified, truncate, type MechanismMap, type SurgePrimitive } from './primitives.js';
import { redactFreeText } from './redact-profile.js';

export interface ExecResult {
  stdout: string;
  stderr: string;
}

/** 失败时以带 code（退出码或 ENOENT 等）、killed、signal、stdout、stderr 的错误拒绝。 */
export type ExecFn = (file: string, args: readonly string[], opts: { timeout: number; maxBuffer: number }) => Promise<ExecResult>;

export interface CliAdapterOptions {
  cliPath: string;
  mechanism: MechanismMap;
  exec?: ExecFn;
  timeoutMs?: number;
  maxBuffer?: number;
  scrub: (s: string) => string;
}

// stdin 在启动后立即关闭：6.5 的 surge-cli 遇到无法识别的参数会进入交互模式，stdin 保持打开时一直等到超时，
// 被误报为无法连接。
export const defaultExec: ExecFn = async (file, args, opts) => {
  const r = await execFixed(file, args, { timeout: opts.timeout, maxBuffer: opts.maxBuffer });
  if (r.error) throw Object.assign(r.error, { stdout: r.stdout, stderr: r.stderr });
  return { stdout: r.stdout, stderr: r.stderr };
};

/** 6.5.0 (10960) 实测：没有可识别的命令时 surge-cli 打印该提示并进入交互模式（stdin 结束时退出 0）。 */
export const INTERACTIVE_BANNER_RE = /No command is provided|enter(?:ing)?\s+interactive\s+mode/i;

/** 交互模式说明命令没有执行：不是结果，也不是“无法连接”。输出不进入错误（其中的 Connected to 127.0.0.1 不是版本或结果）。 */
export function interactiveModeError(primitive: SurgePrimitive): SfeError {
  return new SfeError('SURGE_COMMAND_FAILED', '执行 Surge 命令失败：命令行工具不支持该命令（进入了交互模式）', {
    details: { primitive, reason: 'interactive_mode' },
  });
}

function showsInteractiveBanner(stdout: string, stderr: string): boolean {
  return INTERACTIVE_BANNER_RE.test(stdout) || INTERACTIVE_BANNER_RE.test(stderr);
}

interface ExecError {
  code?: unknown;
  killed?: boolean;
  signal?: unknown;
  stdout?: unknown;
  stderr?: unknown;
}

const UNREACHABLE_TEXT_RE = /not running|connection refused|ECONNREFUSED|could ?n[o']t connect|unable to connect|无法连接/i;

export function createCliAdapter(opts: CliAdapterOptions): SurgeAdapter {
  const exec = opts.exec ?? defaultExec;
  const timeout = opts.timeoutMs ?? 15_000;
  const maxBuffer = opts.maxBuffer ?? 8 * 1024 * 1024;
  const mechanism = { ...opts.mechanism };
  const scrubAll = (s: string): string => opts.scrub(redactFreeText(s));

  async function run<P extends SurgePrimitive>(primitive: P, args: unknown[]): Promise<unknown> {
    const cmd = CLI_COMMANDS[primitive] as CliCommand<unknown[], unknown> | undefined;
    if (mechanism[primitive] !== 'cli' || !cmd) throw capabilityUnverified(primitive);
    const argv = cmd.argv(...args);
    let out: CliOutput;
    try {
      const r = await exec(opts.cliPath, argv, { timeout, maxBuffer });
      out = { stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? ''), exitCode: 0 };
    } catch (raw) {
      const err = (raw ?? {}) as ExecError;
      const stdout = typeof err.stdout === 'string' ? err.stdout : '';
      const stderr = typeof err.stderr === 'string' ? err.stderr : '';
      // 先于退出码、超时、无法连接文字等一切分类：提示出现在被结束或非零退出前的输出里也一样。
      if (showsInteractiveBanner(stdout, stderr)) throw interactiveModeError(primitive);
      if (err.code === 'ENOENT' || err.code === 'EACCES' || err.code === 'EPERM') {
        throw new SfeError('SURGE_UNREACHABLE', '连接 Surge 失败：命令行工具不可用');
      }
      if (err.killed || (err.signal !== undefined && err.signal !== null)) {
        throw new SfeError('SURGE_UNREACHABLE', '连接 Surge 失败：命令超时');
      }
      if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        throw new SfeError('SURGE_COMMAND_FAILED', '执行 Surge 命令失败：输出超过上限');
      }
      if (typeof err.code !== 'number') throw new SfeError('SURGE_UNREACHABLE', '连接 Surge 失败：无法启动命令');
      if (cmd.nonZeroExitIsResult) {
        out = { stdout, stderr, exitCode: err.code };
      } else {
        const detail = truncate(scrubAll(stderr || stdout));
        if (UNREACHABLE_TEXT_RE.test(stderr || stdout)) throw new SfeError('SURGE_UNREACHABLE', `连接 Surge 失败：${detail}`);
        throw new SfeError('SURGE_COMMAND_FAILED', `执行 Surge 命令失败：${detail || `退出码 ${err.code}`}`, {
          details: { primitive, exitCode: err.code },
        });
      }
    }
    // 先于解析：退出 0 加提示不是成功（--check 会被当作通过，写命令解析为 undefined 会被当作已写入）。
    if (showsInteractiveBanner(out.stdout, out.stderr)) throw interactiveModeError(primitive);
    return cmd.parse(out, { scrub: scrubAll });
  }

  const call =
    <P extends SurgePrimitive>(p: P) =>
    (...args: unknown[]) =>
      run(p, args);

  return {
    mechanism: () => ({ ...mechanism }),
    getVersion: call('getVersion'),
    getRuntimeInfo: call('getRuntimeInfo'),
    getCurrentProfile: call('getCurrentProfile'),
    getTakeoverState: call('getTakeoverState'),
    getAutoReloadSetting: call('getAutoReloadSetting'),
    checkProfile: call('checkProfile'),
    listPolicies: call('listPolicies'),
    getPolicyDetail: call('getPolicyDetail'),
    getGroupMembers: call('getGroupMembers'),
    getGroupSelection: call('getGroupSelection'),
    selectGroupPolicy: call('selectGroupPolicy'),
    testPolicy: call('testPolicy'),
    listRules: call('listRules'),
    listActiveRequests: call('listActiveRequests'),
    listRecentRequests: call('listRecentRequests'),
    killRequest: call('killRequest'),
    listExternalResources: call('listExternalResources'),
    updateExternalResource: call('updateExternalResource'),
    listTempRules: call('listTempRules'),
    addTempRule: call('addTempRule'),
    removeTempRule: call('removeTempRule'),
  } as SurgeAdapter;
}

// ---------- CLI 路径校验 ----------

export interface VerifyCliPathOptions {
  realpath: (path: string) => Promise<string>;
  /** 运行 /usr/bin/codesign，传入的是 codesign 之后的参数。 */
  runCodesign: (args: readonly string[]) => Promise<{ code: number; stderr: string }>;
  bundlePrefix?: string;
  /** 记录的 Surge 签名 Team ID；未知时只做 --verify --strict。 */
  teamId: string | null;
  platform?: NodeJS.Platform;
}

export function codesignArgs(path: string, teamId: string | null): string[] {
  const args = ['--verify', '--strict'];
  if (teamId !== null) args.push(`-R=anchor apple generic and certificate leaf[subject.OU] = "${teamId}"`);
  args.push(path);
  return args;
}

/**
 * CLI 路径只来自安装配置：必须解析到 Surge.app 包内并通过 codesign 校验。
 * 非 macOS 无法校验，返回 unverifiable（调用方据此拒绝启用 CLI）。
 */
export async function verifyCliPath(path: string, opts: VerifyCliPathOptions): Promise<{ ok: boolean; reason: string }> {
  if ((opts.platform ?? process.platform) !== 'darwin') return { ok: false, reason: 'unverifiable' };
  const prefix = opts.bundlePrefix ?? '/Applications/Surge.app/';
  if (typeof path !== 'string' || !path.startsWith('/')) return { ok: false, reason: 'not_absolute' };
  if (opts.teamId !== null && !/^[A-Z0-9]{10}$/.test(opts.teamId)) return { ok: false, reason: 'invalid_team_id' };
  let real: string;
  try {
    real = await opts.realpath(path);
  } catch {
    return { ok: false, reason: 'not_found' };
  }
  if (!real.startsWith(prefix)) return { ok: false, reason: 'outside_bundle' };
  let result: { code: number; stderr: string };
  try {
    result = await opts.runCodesign(codesignArgs(real, opts.teamId));
  } catch {
    return { ok: false, reason: 'codesign_unavailable' };
  }
  if (result.code !== 0) return { ok: false, reason: 'signature_invalid' };
  return { ok: true, reason: opts.teamId === null ? 'verified_without_team' : 'verified' };
}

/** 默认的 codesign 运行器（固定 /usr/bin/codesign，不经 shell，stdin 关闭）。 */
export async function defaultCodesignRunner(args: readonly string[]): Promise<{ code: number; stderr: string }> {
  const r = await execFixed('/usr/bin/codesign', args, { timeout: 30_000 });
  const code = r.error ? (typeof r.error.code === 'number' ? r.error.code : 1) : 0;
  return { code, stderr: r.stderr };
}
