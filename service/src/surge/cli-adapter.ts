// CLI 实现：execFile（不经 shell，stdin 立即关闭）、固定 argv、超时与输出上限。未映射到 cli 的原语一律
// CAPABILITY_UNVERIFIED；argv 不在允许清单（cli-commands.ts CLI_ARGV_ALLOWLIST）中时不执行。分类顺序：交互模式提示 →
// 不支持的命令（“Unknown command”）→ 退出码/超时 → 无法连接的文字；退出 0 但输出说无法连接或命令不被支持时同样不是
// 结果，不进入解析；子进程错误与 stderr 先脱敏、截断再进入错误信息。见 docs/ARCHITECTURE.md §5.1。

import { SfeError } from '@sfe/contract';
import type { SurgeAdapter } from '../ports.js';
import { execFixed } from '../util/exec-fixed.js';
import { CLI_COMMANDS, isAllowedCliArgv, type CliCommand, type CliOutput, type CliParseContext, type CliSequence } from './cli-commands.js';
import { parseJsonLoose } from './parse-output.js';
import { SURGE_PRIMITIVES, capabilityUnverified, truncate, type MechanismMap, type SurgePrimitive } from './primitives.js';
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
  now?: () => Date;
}

// stdin 在启动后立即关闭：没有可识别的命令时 surge-cli 进入交互模式（随包技能：“If no command is provided, it enters
// interactive mode.”），stdin 保持打开时一直等到超时，被误报为无法连接。
export const defaultExec: ExecFn = async (file, args, opts) => {
  const r = await execFixed(file, args, { timeout: opts.timeout, maxBuffer: opts.maxBuffer });
  if (r.error) throw Object.assign(r.error, { stdout: r.stdout, stderr: r.stderr });
  return { stdout: r.stdout, stderr: r.stderr };
};

/** 没有可识别的命令时 surge-cli 打印的交互模式提示（6.5.0 实测；6.10 包内仍有 “No command is provided, enter interactive mode.”）。 */
export const INTERACTIVE_BANNER_RE = /No command is provided|enter(?:ing)?\s+interactive\s+mode/i;

/** 交互模式说明命令没有执行：不是结果，也不是“无法连接”。输出不进入错误（其中的 Connected to 127.0.0.1 不是版本或结果）。 */
export function interactiveModeError(primitive: SurgePrimitive): SfeError {
  return new SfeError('SURGE_COMMAND_FAILED', '执行 Surge 命令失败：命令行工具不支持该命令（进入了交互模式）', {
    details: { primitive, reason: 'interactive_mode' },
  });
}

/**
 * 命令不被支持：命令行工具在客户端拒绝未知命令（“Unknown command: %@ / Use --help to list commands, or --raw to send it
 * to the controller unvalidated.”），或旧的 Surge 核心回答 “Unknown command”（随包技能：“An older core answers
 * `Unknown command`”）。失败即关闭；输出不进入错误。
 */
export const UNSUPPORTED_COMMAND_RE = /Unknown command/i;

export function unsupportedCommandError(primitive: SurgePrimitive): SfeError {
  return new SfeError('SURGE_COMMAND_FAILED', '执行 Surge 命令失败：当前 Surge 不支持该命令（Unknown command）', {
    details: { primitive, reason: 'unsupported_command' },
  });
}

/**
 * 命令不被支持（客户端或核心回答 Unknown command，或进入了交互模式）：例如 `version` 是 Mac 6.8.0 才有的命令，
 * 调用方据此判断 Surge 低于最低支持版本（crossCheckSurgeVersion 的 'unsupported'）。
 */
export function isUnsupportedCommandError(e: unknown): boolean {
  const reason = e instanceof SfeError && e.code === 'SURGE_COMMAND_FAILED' ? e.details?.reason : undefined;
  return reason === 'unsupported_command' || reason === 'interactive_mode';
}

/**
 * 命令以非零退出、输出既不是不支持的命令也不是无法连接：一次结果未知的命令失败（SURGE_COMMAND_FAILED，details 只有原语与
 * 退出码，没有 reason）。例如 `rule match <域名>` 在求值走到 IP 规则时 DNS 查询失败（2026-10-24 测试 Mac：退出 1，DNS 空回答；
 * IP 规则文档：“If the DNS lookup fails, rule evaluation aborts and the request fails with a DNS error”）——它不是“rule match
 * 不可用”（entry/common.ts isRuleMatchUnavailable 为 false），调用方失败即关闭。detail 已脱敏截断。假 Surge 用同一形状。
 */
export function commandExitError(primitive: SurgePrimitive, exitCode: number, detail: string): SfeError {
  return new SfeError('SURGE_COMMAND_FAILED', `执行 Surge 命令失败：${detail || `退出码 ${exitCode}`}`, {
    details: { primitive, exitCode },
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

/**
 * 无法连接 Surge 的文字。6.10 包内 surge-cli 的原文：“Surge isn't running on the local machine. Use --remote to specify a
 * remote target.”、“The controller connection timed out after %.0f seconds.”、“The controller command timed out after
 * %.0f seconds without progress.”、“The controller connection was closed”、“The connection interrupted unexpectedly: %@”、
 * “Surge CLI is not connected.”。TODO(P0)：P0-RUNBOOK V7 在测试 Mac 上记录 Surge 未运行时的实际输出与退出码。
 */
export const UNREACHABLE_TEXT_RE =
  /not running|isn['’]?t running|connection refused|ECONNREFUSED|could ?n[o'’]t connect|unable to connect|无法连接|controller (?:connection|command|event stream) timed out|controller connection was closed|connection (?:was )?interrupted|Surge CLI is not connected/i;

/**
 * 退出 0（或 --check 的非零结果）时输出里的某类文字：stderr 总是检查；stdout 只在不是 JSON 时检查（JSON 结果中的
 * 名称或规则可能恰好含有这些词）。返回匹配的那一段，没有时为 null。
 */
function textMatching(re: RegExp, stdout: string, stderr: string): string | null {
  if (re.test(stderr)) return stderr;
  if (parseJsonLoose(stdout) === undefined && re.test(stdout)) return stdout;
  return null;
}

/** 随包技能 §1.2 的响应外层：“`error`: error text”。退出 0 但外层带非空 error 的 JSON 不是结果。 */
function envelopeError(stdout: string): string | null {
  const json = parseJsonLoose(stdout);
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return null;
  const e = (json as Record<string, unknown>).error;
  return typeof e === 'string' && e.trim() !== '' ? e : null;
}

type AnyCommand = CliCommand<unknown[], unknown> | CliSequence<unknown[], unknown>;

export function createCliAdapter(opts: CliAdapterOptions): SurgeAdapter {
  const exec = opts.exec ?? defaultExec;
  const timeout = opts.timeoutMs ?? 15_000;
  const maxBuffer = opts.maxBuffer ?? 8 * 1024 * 1024;
  const mechanism = { ...opts.mechanism };
  const now = opts.now ?? (() => new Date());
  const scrubAll = (s: string): string => opts.scrub(redactFreeText(s));

  async function execOne(primitive: SurgePrimitive, argv: string[], nonZeroExitIsResult: boolean): Promise<CliOutput> {
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
      // 先于 --check 的“非零即校验未通过”：不支持的命令不是校验结果。
      if (UNSUPPORTED_COMMAND_RE.test(stderr) || UNSUPPORTED_COMMAND_RE.test(stdout)) throw unsupportedCommandError(primitive);
      if (nonZeroExitIsResult) {
        out = { stdout, stderr, exitCode: err.code };
      } else {
        const detail = truncate(scrubAll(stderr || stdout));
        if (UNREACHABLE_TEXT_RE.test(stderr || stdout)) throw new SfeError('SURGE_UNREACHABLE', `连接 Surge 失败：${detail}`);
        throw commandExitError(primitive, err.code, detail);
      }
    }
    // 先于解析：退出 0 加提示不是成功（--check 会被当作通过，写命令会被当作已写入）。
    if (showsInteractiveBanner(out.stdout, out.stderr)) throw interactiveModeError(primitive);
    if (textMatching(UNSUPPORTED_COMMAND_RE, out.stdout, out.stderr) !== null) throw unsupportedCommandError(primitive);
    // 同样先于解析：退出 0 但输出说无法连接，不是结果（空输出会被当作“没有临时规则”，--check 会被当作通过，
    // 写命令会被当作已写入）。
    const unreachable = textMatching(UNREACHABLE_TEXT_RE, out.stdout, out.stderr);
    if (unreachable !== null) throw new SfeError('SURGE_UNREACHABLE', `连接 Surge 失败：${truncate(scrubAll(unreachable))}`);
    const envelope = out.exitCode === 0 ? envelopeError(out.stdout) : null;
    if (envelope !== null) {
      if (UNSUPPORTED_COMMAND_RE.test(envelope)) throw unsupportedCommandError(primitive);
      throw new SfeError('SURGE_COMMAND_FAILED', `执行 Surge 命令失败：${truncate(scrubAll(envelope))}`, { details: { primitive } });
    }
    return out;
  }

  async function run(primitive: SurgePrimitive, args: unknown[]): Promise<unknown> {
    const cmd = CLI_COMMANDS[primitive] as AnyCommand | undefined;
    if (mechanism[primitive] !== 'cli' || !cmd) throw capabilityUnverified(primitive);
    const argvs = 'argvs' in cmd ? cmd.argvs(...args) : [cmd.argv(...args)];
    // 纵深防御：表中每条 argv 都应在允许清单中（测试逐条断言）；不在时不执行。
    if (argvs.length === 0 || !argvs.every((argv) => isAllowedCliArgv(argv))) {
      throw new SfeError('VALIDATION_FAILED', '执行 Surge 命令失败：命令不在允许清单中', { details: { primitive } });
    }
    const ctx: CliParseContext = { scrub: scrubAll, now };
    if (!('argvs' in cmd)) return cmd.parse(await execOne(primitive, argvs[0]!, cmd.nonZeroExitIsResult === true), ctx, args);
    const outs: CliOutput[] = [];
    for (const argv of argvs) outs.push(await execOne(primitive, argv, false));
    return cmd.parseAll(outs, ctx, args);
  }

  const adapter = { mechanism: () => ({ ...mechanism }) } as Record<string, unknown>;
  for (const p of SURGE_PRIMITIVES) adapter[p] = (...args: unknown[]) => run(p, args);
  return adapter as unknown as SurgeAdapter;
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
