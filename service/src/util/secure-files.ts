// 文件安全（docs/ARCHITECTURE.md §5.6）：含秘密的文件一律 O_CREAT|O_EXCL 0600 新建、fsync、
// 原子改名并 fsync 目录；私有目录 0700 且属于当前用户；启动时清扫本应用遗留的临时文件。

import { constants as fsConstants, existsSync, lstatSync, mkdirSync, chmodSync, realpathSync } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve, sep } from 'node:path';
import { SfeError } from '@sfe/contract';

/** macOS sockaddr_un.sun_path 为 104 字节（含结尾 NUL），可用 103 字节。 */
export const MAX_UNIX_SOCKET_PATH_BYTES = 103;

/** 本应用临时文件名：`.<目标名>.<16 位十六进制>.tmp`。 */
const TEMP_RE = /^\.(.+)\.[0-9a-f]{16}\.tmp$/;

function currentUid(): number | undefined {
  return process.getuid?.();
}

function unsafe(message: string, details?: Record<string, unknown>): SfeError {
  return new SfeError('UNSAFE_LOCATION', message, details ? { details } : undefined);
}

function checkPrivateDirStat(path: string, st: { isDirectory(): boolean; isSymbolicLink(): boolean; uid: number; mode: number }): boolean {
  if (st.isSymbolicLink()) throw unsafe('使用私有目录失败：目录是符号链接', { path });
  if (!st.isDirectory()) throw unsafe('使用私有目录失败：路径不是目录', { path });
  const uid = currentUid();
  if (uid !== undefined && st.uid !== uid) throw unsafe('使用私有目录失败：目录不属于当前用户', { path });
  return (st.mode & 0o077) !== 0;
}

/** mkdir -p（新建为 0700）；确认是属于当前用户的真实目录，组/其他用户有权限时收紧为 0700。 */
export async function ensurePrivateDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const st = await lstat(path);
  if (checkPrivateDirStat(path, st)) await chmod(path, 0o700);
}

/** ensurePrivateDir 的同步版本（启动早期、打开数据库前使用）。 */
export function ensurePrivateDirSync(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const st = lstatSync(path);
  if (checkPrivateDirStat(path, st)) chmodSync(path, 0o700);
}

function assertPlainFileName(name: string): void {
  if (typeof name !== 'string' || name.length === 0 || name === '.' || name === '..' || name.includes('/') || name.includes('\\') || name.includes('\0')) {
    throw new SfeError('BAD_REQUEST', '写入文件失败：文件名不合法');
  }
}

/**
 * 以 O_CREAT|O_EXCL|O_NOFOLLOW 新建 0600 文件并写入、fsync。文件（含悬空符号链接）已存在时失败（EEXIST），
 * 从不覆盖或跟随链接。失败时删除自己创建的半成品。
 */
export async function createExclusivePrivateFile(path: string, content: string | Buffer): Promise<void> {
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0);
  const fh = await open(path, flags, 0o600);
  try {
    // umask 只会收紧；这里显式设为 0600，确保结果与预期一致
    await fh.chmod(0o600);
    await fh.writeFile(content);
    await fh.sync();
  } catch (err) {
    await fh.close().catch(() => undefined);
    await unlink(path).catch(() => undefined);
    throw err;
  }
  await fh.close();
}

async function fsyncDir(dir: string): Promise<void> {
  let fh;
  try {
    fh = await open(dir, fsConstants.O_RDONLY);
    await fh.sync();
  } catch (err) {
    // 部分文件系统不支持目录 fsync；改名本身已完成，不因此失败
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EISDIR' && code !== 'EBADF') throw err;
  } finally {
    await fh?.close().catch(() => undefined);
  }
}

export interface AtomicWriteOptions {
  /** 测试注入：临时文件名中的随机部分（16 位十六进制）。 */
  randomSuffix?: () => string;
}

/**
 * 同目录临时文件 `.name.<rand>.tmp`（O_EXCL 0600）→ 写入 → fsync → 关闭 → rename → fsync 目录。
 * 返回最终路径。临时文件已存在时失败且不触碰它与目标文件。
 */
export async function writeFileAtomicPrivate(dir: string, name: string, content: string | Buffer, opts: AtomicWriteOptions = {}): Promise<string> {
  assertPlainFileName(name);
  const suffix = opts.randomSuffix ? opts.randomSuffix() : randomBytes(8).toString('hex');
  if (!/^[0-9a-f]{16}$/.test(suffix)) throw new RangeError('temp suffix must be 16 hex chars');
  const tempPath = join(dir, `.${name}.${suffix}.tmp`);
  const finalPath = join(dir, name);
  await createExclusivePrivateFile(tempPath, content);
  try {
    await rename(tempPath, finalPath);
  } catch (err) {
    await unlink(tempPath).catch(() => undefined);
    throw err;
  }
  await fsyncDir(dir);
  return finalPath;
}

/**
 * 删除目录中本应用遗留的 `.*.<16hex>.tmp` 临时文件（只删普通文件与符号链接本身）。
 * olderThanMs 用于避免误删正在写入的文件；启动时（无写入进行）用 0。返回删除的文件名。
 */
export async function sweepTempFiles(dir: string, opts: { olderThanMs?: number; now?: Date } = {}): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const cutoff = (opts.now ?? new Date()).getTime() - (opts.olderThanMs ?? 0);
  const removed: string[] = [];
  for (const name of names) {
    if (!TEMP_RE.test(name)) continue;
    const full = join(dir, name);
    try {
      const st = await lstat(full);
      if (!st.isFile() && !st.isSymbolicLink()) continue;
      if ((opts.olderThanMs ?? 0) > 0 && st.mtimeMs > cutoff) continue;
      await unlink(full);
      removed.push(name);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  return removed;
}

/** 从 path（可以尚不存在）向上查找 `.git`（目录或 worktree/子模块使用的文件）。 */
export function isInsideGitWorkTree(path: string): boolean {
  let current = resolve(path);
  for (;;) {
    if (existsSync(join(current, '.git'))) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

function isUnder(path: string, base: string): boolean {
  const p = path.toLowerCase();
  const b = base.toLowerCase().replace(/[/\\]+$/, '');
  return p === b || p.startsWith(b + sep) || p.startsWith(`${b}/`);
}

/**
 * 目录风险：iCloud/云盘同步位置为 synced；文稿、桌面、下载（TCC 保护）为 protected。
 * 同时检查给定路径与其真实路径（存在时），并按 macOS 默认的大小写不敏感比较。
 */
export function classifyDirectoryRisk(path: string, home: string): 'none' | 'synced' | 'protected' {
  const candidates = [resolve(path)];
  try {
    candidates.push(realpathSync(path));
  } catch {
    // 不存在时只看给定路径
  }
  const h = resolve(home);
  const synced = [join(h, 'Library', 'Mobile Documents'), join(h, 'Library', 'CloudStorage')];
  const protectedDirs = [join(h, 'Documents'), join(h, 'Desktop'), join(h, 'Downloads')];
  if (candidates.some((c) => synced.some((s) => isUnder(c, s)))) return 'synced';
  if (candidates.some((c) => protectedDirs.some((s) => isUnder(c, s)))) return 'protected';
  return 'none';
}

/** Unix 套接字路径不得超过 103 字节（UTF-8）。 */
export function assertUnixSocketPathLength(path: string): void {
  const bytes = Buffer.byteLength(path, 'utf8');
  if (bytes > MAX_UNIX_SOCKET_PATH_BYTES) {
    throw unsafe(`创建本机套接字失败：路径长度 ${bytes} 字节，超过 ${MAX_UNIX_SOCKET_PATH_BYTES} 字节上限`, { bytes, limit: MAX_UNIX_SOCKET_PATH_BYTES });
  }
}
