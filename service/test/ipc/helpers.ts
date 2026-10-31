// IPC 测试工具：私有临时目录（0700，路径短以满足 Unix 套接字长度限制）、原始套接字收发、原生桥握手参考客户端。

import { spawnSync } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { chmodSync, lstatSync, mkdtempSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function privateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sfe-ipc-'));
  chmodSync(dir, 0o700);
  return dir;
}

export type Endpoint = { path: string } | { port: number };

export function open(endpoint: Endpoint): Socket {
  return 'path' in endpoint ? connect(endpoint.path) : connect(endpoint.port, '127.0.0.1');
}

/** 写入原始字节，收集全部应答直到对端关闭。返回应答文本与是否被重置。 */
export function exchangeRaw(endpoint: Endpoint, data: string | Buffer, opts: { endAfterWrite?: boolean; timeoutMs?: number } = {}): Promise<{ text: string; reset: boolean }> {
  return new Promise((resolve, reject) => {
    const socket = open(endpoint);
    const chunks: Buffer[] = [];
    let reset = false;
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`timed out; got ${Buffer.concat(chunks).toString('utf8')}`));
    }, opts.timeoutMs ?? 5000);
    socket.on('data', (c) => chunks.push(c));
    socket.on('error', () => {
      reset = true;
    });
    socket.on('close', () => {
      clearTimeout(timer);
      resolve({ text: Buffer.concat(chunks).toString('utf8'), reset });
    });
    socket.on('connect', () => {
      socket.write(data, () => {
        if (opts.endAfterWrite) socket.end();
      });
    });
  });
}

export async function requestJson(endpoint: Endpoint, payload: unknown): Promise<any> {
  const { text } = await exchangeRaw(endpoint, `${JSON.stringify(payload)}\n`);
  const line = text.split('\n')[0]!;
  return JSON.parse(line);
}

/** 制造崩溃残留的套接字文件：子进程监听后被 SIGKILL，文件留下但无人监听。 */
export function makeStaleSocket(path: string): void {
  spawnSync(process.execPath, ['-e', "require('node:net').createServer().listen(process.argv[1], () => process.kill(process.pid, 'SIGKILL'))", path]);
  if (!lstatSync(path).isSocket()) throw new Error('stale socket fixture failed');
}

/** 按行读写的测试连接：next() 依次返回对端发来的每一行；对端关闭且没有剩余内容时返回 null。 */
export class LineConn {
  readonly socket: Socket;
  private buffer = '';
  private closed = false;
  private waiter: (() => void) | null = null;

  constructor(endpoint: Endpoint) {
    this.socket = open(endpoint);
    this.socket.setEncoding('utf8');
    this.socket.on('data', (d: string) => {
      this.buffer += d;
      this.wake();
    });
    this.socket.on('close', () => {
      this.closed = true;
      this.wake();
    });
    this.socket.on('error', () => undefined);
  }

  private wake(): void {
    const w = this.waiter;
    this.waiter = null;
    w?.();
  }

  /** 字符串原样写出；其他值写成一行 JSON。 */
  send(value: unknown): void {
    this.socket.write(typeof value === 'string' ? value : `${JSON.stringify(value)}\n`);
  }

  async next(timeoutMs = 5000): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const nl = this.buffer.indexOf('\n');
      if (nl !== -1) {
        const line = this.buffer.slice(0, nl);
        this.buffer = this.buffer.slice(nl + 1);
        return line;
      }
      if (this.closed) {
        const rest = this.buffer;
        this.buffer = '';
        return rest.length > 0 ? rest : null;
      }
      const left = deadline - Date.now();
      if (left <= 0) throw new Error('timed out waiting for a line');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.waiter = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  }

  destroy(): void {
    this.socket.destroy();
  }
}

export const randomNonce = (): string => randomBytes(32).toString('hex');
const hmacHex = (token: string, text: string): string => createHmac('sha256', Buffer.from(token, 'utf8')).update(text, 'utf8').digest('hex');
const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

export interface BridgeCallOptions {
  token: string;
  /** BridgePayload 的 JSON 文本。 */
  payload: string;
  clientNonce?: string;
  /** 改写或替换要发送的 request（返回字符串时原样写出）。 */
  request?: (request: Record<string, unknown>, nonces: { clientNonce: string; serverNonce: string }) => unknown;
  /** 发送 request 后半关闭写端。 */
  endAfterRequest?: boolean;
  timeoutMs?: number;
}

export type BridgeCallResult =
  | { kind: 'closed_after_hello' }
  | { kind: 'server_unauthenticated'; challenge: unknown }
  | { kind: 'closed_after_request'; challenge: Record<string, unknown>; request: Record<string, unknown> }
  | { kind: 'response'; response: any; challenge: Record<string, unknown>; request: Record<string, unknown> };

/**
 * 参考客户端，步骤与 apps/macos/Shared/BridgeHandshake.swift 的 BridgeConversation 相同：hello → 验证服务证明
 * （不符就不发送任何请求内容）→ 带客户端证明的 request → 读一行应答。证明用 node:crypto 独立计算。
 */
export async function bridgeCall(endpoint: Endpoint, opts: BridgeCallOptions): Promise<BridgeCallResult> {
  const conn = new LineConn(endpoint);
  try {
    const clientNonce = opts.clientNonce ?? randomNonce();
    conn.send({ v: 1, type: 'hello', clientNonce });
    const line = await conn.next(opts.timeoutMs);
    if (line === null) return { kind: 'closed_after_hello' };
    const challenge = JSON.parse(line) as Record<string, unknown>;
    const serverNonce = String(challenge.serverNonce);
    if (challenge.v !== 1 || challenge.type !== 'challenge' || challenge.serverProof !== hmacHex(opts.token, `sfe-bridge-server\n${clientNonce}\n${serverNonce}`)) {
      return { kind: 'server_unauthenticated', challenge };
    }
    const clientProof = hmacHex(opts.token, `sfe-bridge-client\n${serverNonce}\n${clientNonce}\n${sha256Hex(opts.payload)}`);
    const request: Record<string, unknown> = { v: 1, type: 'request', clientProof, payload: opts.payload };
    const out = opts.request ? opts.request(request, { clientNonce, serverNonce }) : request;
    if (opts.endAfterRequest) conn.socket.end(typeof out === 'string' ? out : JSON.stringify(out));
    else conn.send(out);
    const reply = await conn.next(opts.timeoutMs);
    if (reply === null) return { kind: 'closed_after_request', challenge, request };
    return { kind: 'response', response: JSON.parse(reply), challenge, request };
  } finally {
    conn.destroy();
  }
}
