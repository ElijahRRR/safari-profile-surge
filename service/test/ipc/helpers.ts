// IPC 测试工具：私有临时目录（0700，路径短以满足 Unix 套接字长度限制）、原始套接字收发。

import { spawnSync } from 'node:child_process';
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
