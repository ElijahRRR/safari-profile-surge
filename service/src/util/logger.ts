// 结构化日志：每行一个 JSON 对象 {ts, level, scope, msg, ...fields}，写出前整体经 scrubDeep。
// 只记路由、id、结果与错误码，从不记录请求/响应体；日志写失败不影响业务。

import { closeSync, constants as fsConstants, fchmodSync, fstatSync, openSync, writeSync } from 'node:fs';
import type { LogLevel, Logger, Scrubber } from '../ports.js';
import { createScrubber } from './scrubber.js';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const RESERVED = new Set(['ts', 'level', 'scope', 'msg']);
const MAX_CAUSE_DEPTH = 3;

export interface LoggerOptions {
  sink: (line: string) => void;
  level?: LogLevel;
  /** 缺省时使用只按规则脱敏的实例；日志从不绕过脱敏。 */
  scrubber?: Scrubber;
  scope?: string;
  /** 测试注入时间。 */
  now?: () => Date;
}

export function createLogger(opts: LoggerOptions): Logger {
  const scrubber = opts.scrubber ?? createScrubber();
  const min = LEVEL_ORDER[opts.level ?? 'info'];
  const now = opts.now ?? (() => new Date());

  function make(scope: string): Logger {
    return {
      log(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
        if ((LEVEL_ORDER[level] ?? LEVEL_ORDER.error) < min) return;
        try {
          const entry: Record<string, unknown> = { ts: now().toISOString(), level, scope, msg: String(msg) };
          if (fields) {
            for (const [k, v] of Object.entries(fields)) {
              entry[RESERVED.has(k) ? `field_${k}` : k] = v instanceof Error ? serializeError(v, 0) : v;
            }
          }
          const safe = scrubber.scrubDeep(entry);
          opts.sink(JSON.stringify(safe, jsonReplacer));
        } catch {
          // 日志失败不影响业务；也不能把失败原因（可能含未脱敏内容）写到别处
        }
      },
      child(childScope: string): Logger {
        return make(scope ? `${scope}.${childScope}` : childScope);
      },
    };
  }
  return make(opts.scope ?? 'service');
}

function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

/** 错误转为可记录的普通对象（之后仍会整体脱敏）。 */
export function serializeError(err: unknown, depth = 0): Record<string, unknown> {
  if (!(err instanceof Error)) return { message: String(err) };
  const extra = err as Error & { code?: unknown; details?: unknown; cause?: unknown };
  const out: Record<string, unknown> = { name: err.name, message: err.message };
  if (extra.code !== undefined) out.code = extra.code;
  if (extra.details !== undefined) out.details = extra.details;
  if (err.stack) out.stack = err.stack;
  if (extra.cause !== undefined && depth < MAX_CAUSE_DEPTH) out.cause = serializeError(extra.cause, depth + 1);
  return out;
}

/** 丢弃一切的日志器。 */
export const nullLogger: Logger = {
  log(): void {},
  child(): Logger {
    return nullLogger;
  },
};

export type FileSink = ((line: string) => void) & { close(): void; readonly path: string };

/**
 * 追加写入日志文件：O_APPEND|O_CREAT|O_NOFOLLOW，新建为 0600；已有文件权限过宽且属于当前用户时收紧。
 * 拒绝符号链接（防止日志被重定向到别处）。
 */
export function fileSink(path: string): FileSink {
  const flags = fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | (fsConstants.O_NOFOLLOW ?? 0);
  const fd = openSync(path, flags, 0o600);
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error('log path is not a regular file');
    const uid = process.getuid?.();
    if (uid !== undefined && st.uid !== uid) throw new Error('log file is not owned by the current user');
    if ((st.mode & 0o077) !== 0) fchmodSync(fd, 0o600);
  } catch (err) {
    closeSync(fd);
    throw err;
  }
  let open = true;
  const sink = ((line: string) => {
    if (!open) return;
    writeSync(fd, line.endsWith('\n') ? line : `${line}\n`);
  }) as FileSink;
  sink.close = () => {
    if (!open) return;
    open = false;
    closeSync(fd);
  };
  Object.defineProperty(sink, 'path', { value: path, enumerable: true });
  return sink;
}

/** 测试与演示用：把日志行收集在内存里。 */
export function createMemorySink(): { sink: (line: string) => void; lines: string[]; entries(): Array<Record<string, unknown>> } {
  const lines: string[] = [];
  return {
    sink: (line: string) => {
      lines.push(line);
    },
    lines,
    entries: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}
