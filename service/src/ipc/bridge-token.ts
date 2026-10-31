// 原生桥令牌文件（<数据目录>/bridge.token，由宿主 App 写入；docs/ARCHITECTURE.md §2）。
// 宿主 App 可能在服务运行期间改写它（App Group 中的令牌丢失或容器变化后重新生成，见 InstallSetup），
// 因此每个连接都重新打开并检查：不跟随符号链接、是普通文件、属于当前用户、组与其他用户无权限（0600）；
// 内容按 (mtimeMs, size, ino) 缓存，文件没变时不重读。令牌从不记录，也不放进错误信息。

import { closeSync, constants as fsConstants, fstatSync, openSync, readFileSync, type Stats } from 'node:fs';
import { SfeError } from '@sfe/contract';

/** 令牌文件大小上限（正常为 43 字符加换行）。 */
export const BRIDGE_TOKEN_MAX_BYTES = 4096;

export type BridgeTokenIssue = 'missing' | 'unsafe' | 'invalid' | 'unreadable';
export type BridgeTokenRead = { kind: 'ok'; token: string } | { kind: 'missing' } | { kind: 'invalid' };

const UNSAFE_MESSAGE = '读取原生桥令牌失败：令牌文件是符号链接、不是普通文件、权限不是 0600 或不属于当前用户';

// O_NONBLOCK：路径被换成 FIFO 时 open 不会阻塞事件循环（随后按“不是普通文件”拒绝）。
const OPEN_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);

function isSafe(st: Stats): boolean {
  const uid = process.getuid?.();
  return st.isFile() && (uid === undefined || st.uid === uid) && (st.mode & 0o077) === 0;
}

/** 打开并检查；不存在时返回 null，不安全时抛出 UNSAFE_LOCATION。调用方负责关闭 fd。 */
function openChecked(path: string): { fd: number; st: Stats } | null {
  let fd: number;
  try {
    fd = openSync(path, OPEN_FLAGS);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    // O_NOFOLLOW 遇到符号链接：macOS 与 Linux 为 ELOOP（部分系统为 EMLINK）
    if (code === 'ELOOP' || code === 'EMLINK') throw new SfeError('UNSAFE_LOCATION', UNSAFE_MESSAGE);
    throw err;
  }
  try {
    const st = fstatSync(fd);
    if (!isSafe(st)) throw new SfeError('UNSAFE_LOCATION', UNSAFE_MESSAGE);
    return { fd, st };
  } catch (err) {
    closeSync(fd);
    throw err;
  }
}

function readToken(fd: number, st: Stats): string | null {
  if (st.size > BRIDGE_TOKEN_MAX_BYTES) return null;
  const token = readFileSync(fd, 'utf8').trim();
  return token.length > 0 && token.length <= BRIDGE_TOKEN_MAX_BYTES ? token : null;
}

/** 启动时读取：不安全时抛出 UNSAFE_LOCATION；不存在或内容为空时如实返回（由调用方决定是否新建）。 */
export function readBridgeTokenFile(path: string): BridgeTokenRead {
  const opened = openChecked(path);
  if (!opened) return { kind: 'missing' };
  try {
    const token = readToken(opened.fd, opened.st);
    return token === null ? { kind: 'invalid' } : { kind: 'ok', token };
  } finally {
    closeSync(opened.fd);
  }
}

export interface BridgeTokenSourceOptions {
  /** 状态变化时回调（只传状态，从不传令牌）：'loaded' 表示读到了新的令牌内容。 */
  onChange?: (state: 'loaded' | BridgeTokenIssue) => void;
}

/**
 * 每次调用都重新检查令牌文件；文件没变时返回缓存的令牌。任何问题都返回 ''（原生桥因此拒绝一切连接），
 * 从不继续使用旧令牌：文件被改成不安全的状态时立即停止接受。
 */
export function createBridgeTokenSource(path: string, opts: BridgeTokenSourceOptions = {}): () => string {
  let cached: { ino: number; size: number; mtimeMs: number; token: string } | null = null;
  let lastIssue: BridgeTokenIssue | null = null;

  const fail = (issue: BridgeTokenIssue): string => {
    cached = null;
    if (issue !== lastIssue) {
      lastIssue = issue;
      opts.onChange?.(issue);
    }
    return '';
  };

  return () => {
    let opened: { fd: number; st: Stats } | null;
    try {
      opened = openChecked(path);
    } catch (err) {
      return fail(err instanceof SfeError ? 'unsafe' : 'unreadable');
    }
    if (!opened) return fail('missing');
    const { fd, st } = opened;
    try {
      if (cached && cached.ino === st.ino && cached.size === st.size && cached.mtimeMs === st.mtimeMs) return cached.token;
      const token = readToken(fd, st);
      if (token === null) return fail('invalid');
      cached = { ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, token };
      lastIssue = null;
      opts.onChange?.('loaded');
      return token;
    } catch {
      return fail('unreadable');
    } finally {
      closeSync(fd);
    }
  };
}
