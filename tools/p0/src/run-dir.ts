// 原始证据目录：默认 ~/Library/Application Support/SafariProfileSurge/p0/<运行编号>/，目录 0700、文件 0600。
// 拒绝 Git 工作树内、iCloud/云盘同步与文稿/桌面/下载等受保护位置。原始输出只写这里，终端只打印脱敏摘要。

import { randomBytes } from 'node:crypto';
import { appendFileSync, chmodSync, closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { P0Error, refused } from './errors.js';

export const RUN_ID_RE = /^\d{8}-\d{6}-[0-9a-f]{6}$/;
const KEY_FILE = 'digest.key';
const LATEST_FILE = 'latest';

export function defaultBaseDir(platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv): string {
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'SafariProfileSurge', 'p0');
  const xdg = env.XDG_DATA_HOME;
  if (xdg && isAbsolute(xdg)) return join(xdg, 'safari-profile-surge', 'p0');
  return join(home, '.local', 'share', 'safari-profile-surge', 'p0');
}

/** 从 path（或最近的已存在祖先）向上查找 .git；返回工作树根目录或 null。 */
export function findGitWorkTree(path: string): string | null {
  let dir = resolve(path);
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export type LocationRisk = 'none' | 'synced' | 'protected';

/** iCloud/云盘同步位置与文稿/桌面/下载（可能触发 TCC 或同步）。 */
export function classifyLocationRisk(path: string, home: string): LocationRisk {
  const p = resolve(path);
  const h = resolve(home);
  const under = (...parts: string[]): boolean => {
    const base = join(h, ...parts);
    return p === base || p.startsWith(base + sep);
  };
  if (under('Library', 'Mobile Documents') || under('Library', 'CloudStorage') || /com~apple~CloudDocs|iCloud Drive/i.test(p)) return 'synced';
  if (under('Desktop') || under('Documents') || under('Downloads')) return 'protected';
  return 'none';
}

export function assertSafeBaseDir(base: string, home: string): void {
  if (!isAbsolute(base)) throw refused('准备证据目录失败：必须是绝对路径');
  const git = findGitWorkTree(base);
  if (git !== null) throw new P0Error('unsafe', '准备证据目录失败：目录位于 Git 工作树内，原始证据可能被提交到仓库');
  const risk = classifyLocationRisk(base, home);
  if (risk !== 'none') {
    throw new P0Error('unsafe', risk === 'synced' ? '准备证据目录失败：目录位于 iCloud 或云盘同步位置' : '准备证据目录失败：目录位于文稿、桌面或下载等受保护位置');
  }
}

export function newRunId(now: Date, random: () => Buffer = () => randomBytes(3)): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  const d = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`;
  const t = `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `${d}-${t}-${random().toString('hex').slice(0, 6)}`;
}

/** 创建或收紧 0700 目录；属主不是当前用户时拒绝。 */
export function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const st = lstatSync(path);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new P0Error('unsafe', '准备证据目录失败：路径不是普通目录');
  const uid = process.getuid?.();
  if (uid !== undefined && st.uid !== uid) throw new P0Error('unsafe', '准备证据目录失败：目录不属于当前用户');
  if ((st.mode & 0o077) !== 0) chmodSync(path, 0o700);
}

function assertRelative(rel: string): void {
  if (!rel || isAbsolute(rel) || rel.split(/[\\/]/).some((s) => s === '..' || s === '') || /[\0\r\n]/.test(rel)) {
    throw new P0Error('unsafe', '写入证据失败：文件名不合法');
  }
}

/** 同目录 O_EXCL 0600 临时文件 + fsync + rename。 */
export function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.tmp-${randomBytes(6).toString('hex')}`;
  const fd = openSync(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, path);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* 已不存在 */
    }
    throw e;
  }
}

export class RunDir {
  private constructor(
    readonly base: string,
    readonly id: string,
    readonly path: string,
  ) {}

  static create(base: string, id: string): RunDir {
    if (!RUN_ID_RE.test(id)) throw new P0Error('unsafe', '创建运行目录失败：运行编号格式不正确');
    ensurePrivateDir(base);
    const path = join(base, id);
    if (existsSync(path)) throw refused('创建运行目录失败：运行编号已存在');
    ensurePrivateDir(path);
    const dir = new RunDir(base, id, path);
    dir.writeNew(KEY_FILE, randomBytes(32).toString('hex'));
    atomicWrite(join(base, LATEST_FILE), id);
    return dir;
  }

  static open(base: string, id: string | null): RunDir {
    let runId = id;
    if (runId === null) {
      try {
        runId = readFileSync(join(base, LATEST_FILE), 'utf8').trim();
      } catch {
        throw refused('打开运行目录失败：还没有运行记录，请先执行 inventory');
      }
    }
    if (!RUN_ID_RE.test(runId)) throw refused('打开运行目录失败：运行编号格式不正确');
    const path = join(base, runId);
    if (!existsSync(path)) throw refused('打开运行目录失败：运行目录不存在');
    ensurePrivateDir(path);
    return new RunDir(base, runId, path);
  }

  file(rel: string): string {
    assertRelative(rel);
    return join(this.path, rel);
  }

  /** 证据摘要与配置文件摘要使用的运行密钥（只在本机限权目录）。 */
  key(): Buffer {
    return Buffer.from(readFileSync(this.file(KEY_FILE), 'utf8').trim(), 'hex');
  }

  ensureSubdir(rel: string): string {
    const p = this.file(rel);
    ensurePrivateDir(p);
    return p;
  }

  /** 新文件（O_EXCL 0600）。 */
  writeNew(rel: string, content: string): string {
    const p = this.file(rel);
    ensurePrivateDir(dirname(p));
    const fd = openSync(p, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try {
      writeSync(fd, content);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return p;
  }

  /** 原子替换（同目录临时文件 + rename），0600。 */
  writeAtomic(rel: string, content: string): string {
    const p = this.file(rel);
    ensurePrivateDir(dirname(p));
    atomicWrite(p, content);
    return p;
  }

  writeJson(rel: string, value: unknown): string {
    return this.writeAtomic(rel, `${JSON.stringify(value, null, 2)}\n`);
  }

  /** 追加一行 JSON（0600）。 */
  appendJsonl(rel: string, value: unknown): void {
    const p = this.file(rel);
    ensurePrivateDir(dirname(p));
    if (!existsSync(p)) {
      const fd = openSync(p, constants.O_CREAT | constants.O_WRONLY | constants.O_APPEND, 0o600);
      closeSync(fd);
    }
    appendFileSync(p, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  }

  readText(rel: string): string | null {
    try {
      return readFileSync(this.file(rel), 'utf8');
    } catch {
      return null;
    }
  }

  readJson<T>(rel: string): T | null {
    const text = this.readText(rel);
    if (text === null) return null;
    try {
      return JSON.parse(text) as T;
    } catch {
      return null;
    }
  }

  /** 读取 JSONL；跳过无法解析的行（服务进程可能正在写最后一行）。 */
  readJsonl<T>(rel: string): T[] {
    const text = this.readText(rel);
    if (text === null) return [];
    const out: T[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as T);
      } catch {
        /* 半行 */
      }
    }
    return out;
  }

  /** 递归列出相对路径（排序）。 */
  listFiles(sub = ''): string[] {
    const root = sub ? this.file(sub) : this.path;
    const out: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir).sort()) {
        const full = join(dir, name);
        const st = lstatSync(full);
        if (st.isSymbolicLink()) continue;
        if (st.isDirectory()) walk(full);
        else if (st.isFile()) out.push(relative(this.path, full).split(sep).join('/'));
      }
    };
    if (existsSync(root) && statSync(root).isDirectory()) walk(root);
    return out;
  }
}

export const RUN_KEY_FILE = KEY_FILE;
