// 本应用写入 Surge 配置目录的文件：同目录 O_EXCL 0600 临时文件 + fsync + rename + 目录 fsync。
// 写入前按带密钥摘要核对归属：当前摘要必须等于调用方记录的上次摘要；期望为 null 时文件必须不存在。

import { createHmac, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readFile, readdir, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { SfeError } from '@sfe/contract';
import type { ProfileFiles } from '../ports.js';

export interface ManagedProfileFiles extends ProfileFiles {
  /** 对将要写入的内容计算同一种带密钥摘要（写入前记录意图用）。 */
  digestContent(content: string): string;
}

function assertFileName(name: string): void {
  if (
    typeof name !== 'string' ||
    name.length === 0 ||
    name.length > 255 ||
    name.includes('/') ||
    name.includes('\\') ||
    name.includes('\0') ||
    name === '.' ||
    name === '..' ||
    name.startsWith('.')
  ) {
    throw new SfeError('UNSAFE_LOCATION', '访问文件失败：文件名不合法');
  }
}

/** writeAtomic 的临时文件名：`.<文件名>.sfe-tmp-<16 位十六进制>`（同目录，0600）。 */
const PROFILE_TEMP_RE = /^\.(.+)\.sfe-tmp-[0-9a-f]{16}$/;

/**
 * 启动时（执行器开始之前，没有写入在进行）删除 Surge 配置目录中 writeAtomic 遗留的临时文件。进程在写入临时文件与 rename 之间
 * 被终止（kill -9、崩溃、断电、强制重启、launchd 超时后 SIGKILL）时临时文件留在 Surge 配置目录里：`sfe-nodes.list` 的临时文件含
 * 全部已发布买家代理的明文用户名与密码，工作配置的含用户自己节点的凭据与 http-api 密钥——之后这些凭据被替换或 retired、从
 * secret_values 与 sfe-nodes.list 删除，这份副本仍在（点开头，Finder 默认隐藏）。只删除名称恰好是 managedNames 中某个文件的
 * 临时文件名、lstat 为普通文件（不是符号链接）且属于当前用户的条目；其他点文件与不符合的名称一概不碰。返回删除的文件名。
 */
export async function sweepProfileTempFiles(directory: string, managedNames: readonly string[]): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (e) {
    if (isNotFound(e)) return [];
    throw e;
  }
  const managed = new Set(managedNames);
  const uid = process.getuid?.();
  const removed: string[] = [];
  for (const name of names) {
    const m = PROFILE_TEMP_RE.exec(name);
    if (!m || !managed.has(m[1]!)) continue;
    const full = join(directory, name);
    try {
      const st = await lstat(full);
      if (!st.isFile() || st.isSymbolicLink()) continue;
      if (uid !== undefined && st.uid !== uid) continue;
      await unlink(full);
      removed.push(name);
    } catch (e) {
      if (!isNotFound(e)) throw e;
    }
  }
  return removed;
}

function isNotFound(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'ENOENT';
}

export function createProfileFiles(opts: { directory: string; hmacKey: string | Buffer }): ManagedProfileFiles {
  const dir = opts.directory;
  const digestContent = (content: string | Buffer): string =>
    createHmac('sha256', opts.hmacKey).update('sfe-file\0').update(content).digest('hex');

  async function readRaw(name: string): Promise<Buffer | null> {
    assertFileName(name);
    try {
      return await readFile(join(dir, name));
    } catch (e) {
      if (isNotFound(e)) return null;
      throw new SfeError('UNSAFE_LOCATION', '读取文件失败：无法访问配置目录');
    }
  }

  return {
    directory: dir,
    async read(name) {
      const buf = await readRaw(name);
      return buf === null ? null : buf.toString('utf8');
    },
    async exists(name) {
      assertFileName(name);
      try {
        await stat(join(dir, name));
        return true;
      } catch (e) {
        if (isNotFound(e)) return false;
        throw new SfeError('UNSAFE_LOCATION', '读取文件失败：无法访问配置目录');
      }
    },
    async digest(name) {
      const buf = await readRaw(name);
      return buf === null ? null : digestContent(buf);
    },
    digestContent: (content) => digestContent(content),
    async writeAtomic(name, content, expectedPreviousDigest) {
      assertFileName(name);
      const current = await readRaw(name);
      if (expectedPreviousDigest === null) {
        if (current !== null) throw new SfeError('BASELINE_CHANGED', '写入文件失败：目标文件已存在', { details: { file: name } });
      } else if (current === null || digestContent(current) !== expectedPreviousDigest) {
        throw new SfeError('BASELINE_CHANGED', '写入文件失败：文件已被外部修改或缺失', { details: { file: name } });
      }
      const tmp = join(dir, `.${name}.sfe-tmp-${randomBytes(8).toString('hex')}`);
      let handle;
      try {
        handle = await open(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      } catch {
        throw new SfeError('UNSAFE_LOCATION', '写入文件失败：无法在配置目录创建临时文件');
      }
      try {
        await handle.writeFile(content, 'utf8');
        await handle.sync();
        await handle.close();
        handle = undefined;
        await rename(tmp, join(dir, name));
      } catch {
        await handle?.close().catch(() => undefined);
        await unlink(tmp).catch(() => undefined);
        throw new SfeError('UNSAFE_LOCATION', '写入文件失败：原子替换未完成');
      }
      // 目录 fsync 让 rename 持久化；部分文件系统不支持时忽略。
      try {
        const d = await open(dir, constants.O_RDONLY);
        try {
          await d.sync();
        } finally {
          await d.close();
        }
      } catch {
        /* 不支持目录 fsync 的文件系统 */
      }
    },
  };
}
