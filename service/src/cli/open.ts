// sfe open：经维护套接字取得一次性登录地址，写入 0700 数据目录中的 0600 .webloc 文件，再交给
// /usr/bin/open 打开该文件——登录码因此从不出现在任何进程的命令行参数里；10 秒后删除文件。
// 非 macOS 只告诉用户文件位置，不在终端打印登录码。

import { closeSync, constants as fsConstants, fchmodSync, fstatSync, lstatSync, openSync, readdirSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';

export const WEBLOC_PREFIX = 'login-';
export const WEBLOC_SUFFIX = '.webloc';
export const WEBLOC_DELETE_AFTER_MS = 10_000;
/** 清理上次异常退出留下的旧文件（登录码 60 秒即失效）。 */
export const WEBLOC_STALE_MS = 120_000;
export const OPEN_BINARY = '/usr/bin/open';

export class OpenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenError';
  }
}

function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
}

export function weblocContent(url: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>URL</key>',
    `  <string>${escapeXml(url)}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

/** 数据目录必须存在、是目录、属于当前用户且权限无组与其他用户位。 */
export function assertPrivateDataDir(dataDir: string, uid: number | undefined): void {
  let st;
  try {
    st = lstatSync(dataDir);
  } catch {
    throw new OpenError('打开管理后台失败：数据目录不存在，服务可能尚未安装');
  }
  if (!st.isDirectory()) throw new OpenError('打开管理后台失败：数据目录不是目录');
  if (uid !== undefined && st.uid !== uid) throw new OpenError('打开管理后台失败：数据目录不属于当前用户');
  if ((st.mode & 0o077) !== 0) throw new OpenError('打开管理后台失败：数据目录权限不是 0700');
}

/** 以 O_CREAT|O_EXCL|O_NOFOLLOW 新建 0600 文件；文件名带随机部分，已存在即失败。 */
export function writeWebloc(dataDir: string, randomHex: string, url: string): string {
  if (!/^[0-9a-f]{16,64}$/.test(randomHex)) throw new OpenError('打开管理后台失败：无法生成文件名');
  const path = join(dataDir, `${WEBLOC_PREFIX}${randomHex}${WEBLOC_SUFFIX}`);
  const fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
  try {
    fchmodSync(fd, 0o600);
    writeSync(fd, weblocContent(url));
    if ((fstatSync(fd).mode & 0o777) !== 0o600) throw new OpenError('打开管理后台失败：无法把登录文件设为 0600');
  } catch (err) {
    closeSync(fd);
    safeUnlink(path);
    throw err;
  }
  closeSync(fd);
  return path;
}

export function safeUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // 已删除
  }
}

/** 删除数据目录中超过 WEBLOC_STALE_MS 的旧登录文件（只匹配本工具的命名）。 */
export function cleanupStaleWeblocs(dataDir: string, nowMs: number): number {
  let removed = 0;
  let names: string[];
  try {
    names = readdirSync(dataDir);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!name.startsWith(WEBLOC_PREFIX) || !name.endsWith(WEBLOC_SUFFIX)) continue;
    const p = join(dataDir, name);
    try {
      const st = lstatSync(p);
      if (st.isFile() && nowMs - st.mtimeMs > WEBLOC_STALE_MS) {
        unlinkSync(p);
        removed++;
      }
    } catch {
      // 并发删除
    }
  }
  return removed;
}
