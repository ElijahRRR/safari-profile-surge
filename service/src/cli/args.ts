// sfe 命令行参数解析。秘密从不经命令行传入：任何参数看起来像密码、令牌、密钥或 Cookie 时整条命令拒绝，
// 提示改用标准输入 JSON（命令行参数会进入 shell 历史与进程列表）。

import { isAbsolute, join, resolve } from 'node:path';

/** 规格要求的拒绝模式；宁可误拒（例如文件名含 pass），也不让秘密进入 argv。 */
export const SECRET_ARG_RE = /pass|token|secret|key=|--key|cookie/i;

export const SECRET_ARG_MESSAGE =
  '命令被拒绝：命令行参数中不能出现密码、令牌、密钥或 Cookie。请把含秘密的内容写成 JSON 从标准输入传入，例如 sfe env create < env.json；文件名含这类字样时请先改名。';

export const EXIT = { OK: 0, ERROR: 1, USAGE: 2, NEEDS_CONFIRMATION: 3 } as const;
export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export function containsSecretArg(argv: readonly string[]): boolean {
  return argv.some((a) => SECRET_ARG_RE.test(a));
}

export const VALUE_FLAGS = [
  'data-dir',
  'revision',
  'old-windows',
  'confirmed-env',
  'kind',
  'env',
  'format',
  'default-front',
  'default-site',
  'resolve',
  'limit',
  'timeout',
] as const;
export const BOOLEAN_FLAGS = ['json', 'commit', 'wait', 'default', 'help'] as const;
export type ValueFlag = (typeof VALUE_FLAGS)[number];
export type BooleanFlag = (typeof BOOLEAN_FLAGS)[number];
export type Flag = ValueFlag | BooleanFlag;

/** 可以重复出现的参数。 */
const REPEATABLE = new Set<Flag>(['env', 'resolve']);
/** 任何命令都接受的参数。 */
export const GLOBAL_FLAGS: readonly Flag[] = ['json', 'data-dir', 'help'];

export interface ParsedArgs {
  positionals: string[];
  values: Map<ValueFlag, string[]>;
  booleans: Set<BooleanFlag>;
}

const isValueFlag = (f: string): f is ValueFlag => (VALUE_FLAGS as readonly string[]).includes(f);
const isBooleanFlag = (f: string): f is BooleanFlag => (BOOLEAN_FLAGS as readonly string[]).includes(f);

export function parseArgv(argv: readonly string[]): ParsedArgs {
  const out: ParsedArgs = { positionals: [], values: new Map(), booleans: new Set() };
  let flagsDone = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (flagsDone || !arg.startsWith('-') || arg === '-') {
      out.positionals.push(arg);
      continue;
    }
    if (arg === '--') {
      flagsDone = true;
      continue;
    }
    if (arg === '-h') {
      out.booleans.add('help');
      continue;
    }
    if (!arg.startsWith('--')) throw new UsageError(`不支持的参数 ${arg}`);
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    if (isBooleanFlag(name)) {
      if (eq !== -1) throw new UsageError(`参数 --${name} 不接受值`);
      out.booleans.add(name);
      continue;
    }
    if (!isValueFlag(name)) throw new UsageError(`不支持的参数 --${name.slice(0, 40)}`);
    let value: string | undefined;
    if (eq !== -1) value = arg.slice(eq + 1);
    else value = argv[++i];
    if (value === undefined || value === '') throw new UsageError(`参数 --${name} 缺少值`);
    const list = out.values.get(name) ?? [];
    if (list.length > 0 && !REPEATABLE.has(name)) throw new UsageError(`参数 --${name} 只能出现一次`);
    list.push(value);
    out.values.set(name, list);
  }
  return out;
}

export function single(args: ParsedArgs, name: ValueFlag): string | undefined {
  return args.values.get(name)?.[0];
}

export function multi(args: ParsedArgs, name: ValueFlag): string[] {
  return args.values.get(name) ?? [];
}

export function flag(args: ParsedArgs, name: BooleanFlag): boolean {
  return args.booleans.has(name);
}

/** 只允许本命令声明的参数（另加全局参数）。 */
export function assertFlags(args: ParsedArgs, allowed: readonly Flag[], command: string): void {
  const ok = new Set<Flag>([...allowed, ...GLOBAL_FLAGS]);
  for (const f of [...args.values.keys(), ...args.booleans]) {
    if (!ok.has(f)) throw new UsageError(`${command} 不接受参数 --${f}`);
  }
}

export function assertPositionals(args: ParsedArgs, count: number, usage: string): void {
  if (args.positionals.length !== count) throw new UsageError(`用法：${usage}`);
}

export function parsePositiveInt(raw: string, label: string): number {
  if (!/^\d{1,9}$/.test(raw) || Number(raw) < 1) throw new UsageError(`${label} 必须是正整数`);
  return Number(raw);
}

// ---------- 数据目录 ----------

export const APP_DIR_NAME_DARWIN = 'SafariProfileSurge';
export const APP_DIR_NAME_XDG = 'safari-profile-surge';

/** 与服务 config.ts 的默认值一致：--data-dir > SFE_DATA_DIR > 平台默认。 */
export function resolveDataDir(opts: { flag: string | undefined; env: NodeJS.ProcessEnv; platform: NodeJS.Platform; homedir: string; cwd: string }): string {
  if (opts.flag) return resolve(opts.cwd, opts.flag);
  const fromEnv = opts.env.SFE_DATA_DIR;
  if (fromEnv) return resolve(opts.cwd, fromEnv);
  if (opts.platform === 'darwin') return join(opts.homedir, 'Library', 'Application Support', APP_DIR_NAME_DARWIN);
  const xdg = opts.env.XDG_DATA_HOME;
  if (xdg && isAbsolute(xdg)) return join(xdg, APP_DIR_NAME_XDG);
  return join(opts.homedir, '.local', 'share', APP_DIR_NAME_XDG);
}

export function socketPath(dataDir: string, role: 'agent' | 'maintenance'): string {
  return join(dataDir, role === 'agent' ? 'agent.sock' : 'maintenance.sock');
}
