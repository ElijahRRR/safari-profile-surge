// Unix 套接字文件的准备与清理（docs/ARCHITECTURE.md §2、§7.3）：套接字 0600；agent/maintenance 套接字所在
// 目录必须是当前用户所有的 0700 目录；已存在的路径只有确认是无人监听的套接字才删除，其他文件一律拒绝。

import { lstatSync, statSync, unlinkSync, chmodSync } from 'node:fs';
import { connect, type Server } from 'node:net';
import { dirname } from 'node:path';
import { SfeError } from '@sfe/contract';

export async function isSocketListening(path: string, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect(path);
    const done = (v: boolean): void => {
      clearTimeout(timer);
      s.destroy();
      resolve(v);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

/** 检查父目录：当前用户所有、权限无组与其他用户位。 */
export function assertPrivateDirectory(dir: string): void {
  let st;
  try {
    st = statSync(dir);
  } catch {
    throw new SfeError('UNSAFE_LOCATION', '启动本机套接字失败：所在目录不存在');
  }
  if (!st.isDirectory()) throw new SfeError('UNSAFE_LOCATION', '启动本机套接字失败：所在路径不是目录');
  const uid = process.getuid?.();
  if (uid !== undefined && st.uid !== uid) throw new SfeError('UNSAFE_LOCATION', '启动本机套接字失败：所在目录不属于当前用户');
  if ((st.mode & 0o077) !== 0) throw new SfeError('UNSAFE_LOCATION', '启动本机套接字失败：所在目录权限不是 0700');
}

/** 清理残留：不存在则无事；是无人监听的套接字则删除；有服务在监听或不是套接字则拒绝。 */
export async function clearStaleSocket(path: string): Promise<void> {
  let st;
  try {
    st = lstatSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new SfeError('UNSAFE_LOCATION', '启动本机套接字失败：无法检查套接字路径');
  }
  if (!st.isSocket()) throw new SfeError('UNSAFE_LOCATION', '启动本机套接字失败：套接字路径已被其他文件占用');
  if (await isSocketListening(path)) throw new SfeError('BAD_REQUEST', '启动本机套接字失败：另一个服务实例正在使用该套接字');
  unlinkSync(path);
}

/** 以 0600 创建并监听；创建期间临时收紧 umask，监听后再显式 chmod。 */
export async function listenUnixSocket(server: Server, path: string, opts: { requirePrivateParent: boolean }): Promise<void> {
  if (opts.requirePrivateParent) assertPrivateDirectory(dirname(path));
  await clearStaleSocket(path);
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    server.once('error', onError);
    let previous: number | null = null;
    try {
      previous = process.umask(0o177);
    } catch {
      previous = null;
    }
    try {
      server.listen(path, () => {
        server.off('error', onError);
        resolve();
      });
    } finally {
      if (previous !== null) process.umask(previous);
    }
  });
  chmodSync(path, 0o600);
}

/** 关闭时只删除仍是套接字的路径（不会误删被替换成普通文件的路径）。 */
export function removeSocketFile(path: string): void {
  try {
    if (lstatSync(path).isSocket()) unlinkSync(path);
  } catch {
    // 已不存在
  }
}
