// NDJSON 帧（docs/ARCHITECTURE.md §7.2、§7.3）：一个连接一条请求、一条应答。读取有字节上限与超时；
// 首字节不是 `{` 立即断开（网页向回环端口发的 HTTP 请求行因此得不到任何应答）。

import { connect, type Socket } from 'node:net';

const LF = 0x0a;
const OPEN_BRACE = 0x7b;

export type ReadLineResult =
  | { kind: 'line'; line: string }
  | { kind: 'too_large' }
  | { kind: 'timeout' }
  | { kind: 'closed' }
  | { kind: 'bad_first_byte' }
  | { kind: 'invalid_utf8' };

export interface ReadLineOptions {
  maxBytes: number;
  timeoutMs: number;
  /** 要求首字节是 `{`（服务端读取请求时使用）。 */
  requireJsonObject?: boolean;
}

/**
 * 读取一行（不含换行）。对端在发出换行前半关闭时，已收到的内容也视为一行。
 * 读取结束后暂停套接字，不再消费后续数据。
 */
export function readLine(socket: Socket, opts: ReadLineOptions): Promise<ReadLineResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let checkedFirst = !opts.requireJsonObject;
    let done = false;

    const finish = (result: ReadLineResult): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('end', onEnd);
      socket.off('close', onClose);
      socket.off('error', onClose);
      socket.pause();
      resolve(result);
    };

    const decode = (buf: Buffer): ReadLineResult => {
      try {
        return { kind: 'line', line: new TextDecoder('utf-8', { fatal: true }).decode(buf) };
      } catch {
        return { kind: 'invalid_utf8' };
      }
    };

    const onData = (chunk: Buffer): void => {
      if (!checkedFirst && chunk.length > 0) {
        checkedFirst = true;
        if (chunk[0] !== OPEN_BRACE) {
          finish({ kind: 'bad_first_byte' });
          return;
        }
      }
      const nl = chunk.indexOf(LF);
      if (nl !== -1) {
        if (total + nl > opts.maxBytes) {
          finish({ kind: 'too_large' });
          return;
        }
        chunks.push(chunk.subarray(0, nl));
        total += nl;
        finish(decode(Buffer.concat(chunks, total)));
        return;
      }
      total += chunk.length;
      if (total > opts.maxBytes) {
        finish({ kind: 'too_large' });
        return;
      }
      chunks.push(chunk);
    };

    const onEnd = (): void => {
      if (total === 0) finish({ kind: 'closed' });
      else finish(decode(Buffer.concat(chunks, total)));
    };
    const onClose = (): void => finish({ kind: 'closed' });

    const timer = setTimeout(() => finish({ kind: 'timeout' }), opts.timeoutMs);
    socket.on('data', onData);
    socket.on('end', onEnd);
    socket.on('close', onClose);
    socket.on('error', onClose);
    socket.resume();
  });
}

/** 写一行 JSON 后半关闭；对端已断开时静默放弃。 */
export function writeLineAndClose(socket: Socket, value: unknown): Promise<void> {
  return new Promise((resolve) => {
    if (socket.destroyed || !socket.writable) {
      socket.destroy();
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      socket.destroy();
      resolve();
    }, 30_000);
    socket.once('error', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve();
    });
    socket.end(`${JSON.stringify(value)}\n`, () => {
      clearTimeout(timer);
      // 对端迟迟不关闭读端时（半开连接）不无限占用：给它片刻读取应答，然后断开
      setTimeout(() => socket.destroy(), 2000).unref();
      resolve();
    });
  });
}

/** 立即断开且不回应。 */
export function dropConnection(socket: Socket): void {
  socket.destroy();
}

export type NdjsonEndpoint = { path: string } | { host: string; port: number };

export interface NdjsonRequestOptions {
  maxResponseBytes: number;
  timeoutMs: number;
}

export class NdjsonClientError extends Error {
  constructor(
    readonly kind: 'connect' | 'timeout' | 'closed' | 'too_large' | 'invalid_response',
    readonly errno: string | null,
  ) {
    super(`ndjson ${kind}${errno ? ` (${errno})` : ''}`);
    this.name = 'NdjsonClientError';
  }
}

/** 客户端：连接、写一行请求、读一行应答并解析为 JSON。 */
export function ndjsonRequest(endpoint: NdjsonEndpoint, payload: unknown, opts: NdjsonRequestOptions): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = 'path' in endpoint ? connect(endpoint.path) : connect(endpoint.port, endpoint.host);
    let connected = false;
    const onConnectError = (err: NodeJS.ErrnoException): void => {
      clearTimeout(connectTimer);
      socket.destroy();
      reject(new NdjsonClientError(connected ? 'closed' : 'connect', err.code ?? null));
    };
    socket.once('error', onConnectError);
    // 整体超时：连接、发送与等待应答合计（计时器不能拖住 CLI 进程退出）
    const connectTimer = setTimeout(() => {
      socket.destroy();
      reject(new NdjsonClientError('timeout', null));
    }, opts.timeoutMs);
    socket.once('connect', () => {
      connected = true;
      socket.off('error', onConnectError);
      socket.on('error', () => undefined);
      socket.write(`${JSON.stringify(payload)}\n`);
      void readLine(socket, { maxBytes: opts.maxResponseBytes, timeoutMs: opts.timeoutMs }).then((r) => {
        clearTimeout(connectTimer);
        socket.destroy();
        if (r.kind === 'line') {
          try {
            resolve(JSON.parse(r.line));
          } catch {
            reject(new NdjsonClientError('invalid_response', null));
          }
          return;
        }
        if (r.kind === 'timeout') reject(new NdjsonClientError('timeout', null));
        else if (r.kind === 'too_large') reject(new NdjsonClientError('too_large', null));
        else if (r.kind === 'invalid_utf8') reject(new NdjsonClientError('invalid_response', null));
        else reject(new NdjsonClientError('closed', null));
      });
    });
  });
}
