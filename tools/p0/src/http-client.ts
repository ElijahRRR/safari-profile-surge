// 工具自身作为“其他应用”经 Surge HTTP 代理端口发出的请求（只允许回环代理地址）：短请求、长连接流、
// 经 CONNECT 隧道的 WebSocket。只用于 P0 测试主机；结果只保留状态、耗时与经过的测试节点。

import { request as httpRequest } from 'node:http';
import { isIP, type Socket } from 'node:net';
import { usage } from './errors.js';
import { OPCODE, acceptKey, decodeFrames, encodeFrame, newClientKey } from './servers/websocket.js';

export interface ProxyAddress {
  host: string;
  port: number;
}

export function parseProxyAddress(value: string): ProxyAddress {
  const m = /^(127\.0\.0\.1|localhost|\[::1\]):(\d{1,5})$/.exec(value.trim());
  if (!m) throw usage('参数检查失败：--proxy 只能是本机回环地址，例如 127.0.0.1:6152');
  const port = Number(m[2]);
  if (port < 1 || port > 65535) throw usage('参数检查失败：--proxy 端口不正确');
  return { host: m[1] === '[::1]' ? '::1' : m[1]!, port };
}

export interface GetResult {
  ok: boolean;
  status: number | null;
  json: unknown;
  error: string | null;
  ms: number;
}

const MAX_BODY = 64 * 1024;

function collect(res: import('node:http').IncomingMessage, started: number, resolve: (r: GetResult) => void): void {
  const chunks: Buffer[] = [];
  let total = 0;
  res.on('data', (c: Buffer) => {
    total += c.length;
    if (total <= MAX_BODY) chunks.push(c);
  });
  res.on('end', () => {
    let json: unknown = null;
    try {
      json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      json = null;
    }
    const status = res.statusCode ?? null;
    resolve({ ok: status !== null && status >= 200 && status < 300, status, json, error: null, ms: Date.now() - started });
  });
  res.on('error', () => resolve({ ok: false, status: res.statusCode ?? null, json: null, error: 'response_error', ms: Date.now() - started }));
}

/** 经 Surge HTTP 代理发出 GET（绝对 URI 形式）。 */
export function proxyGet(proxy: ProxyAddress, url: string, timeoutMs = 8000): Promise<GetResult> {
  const started = Date.now();
  const u = new URL(url);
  if (u.protocol !== 'http:') return Promise.resolve({ ok: false, status: null, json: null, error: 'only_http', ms: 0 });
  return new Promise((resolve) => {
    const req = httpRequest({ host: proxy.host, port: proxy.port, method: 'GET', path: u.toString(), headers: { Host: u.host, 'Cache-Control': 'no-store', Connection: 'close' }, timeout: timeoutMs }, (res) => collect(res, started, resolve));
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, status: null, json: null, error: 'timeout', ms: Date.now() - started });
    });
    req.on('error', (e: NodeJS.ErrnoException) => resolve({ ok: false, status: null, json: null, error: e.code ?? 'error', ms: Date.now() - started }));
    req.end();
  });
}

/** 直接请求本机回显服务（健康检查；回环不经 Surge）。 */
export function directGet(port: number, path: string, timeoutMs = 3000): Promise<GetResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const req = httpRequest({ host: '127.0.0.1', port, method: 'GET', path, timeout: timeoutMs, headers: { Connection: 'close' } }, (res) => collect(res, started, resolve));
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, status: null, json: null, error: 'timeout', ms: Date.now() - started });
    });
    req.on('error', (e: NodeJS.ErrnoException) => resolve({ ok: false, status: null, json: null, error: e.code ?? 'error', ms: Date.now() - started }));
    req.end();
  });
}

export interface StreamHandle {
  close(): void;
}

/** 经代理打开长连接流：每收到一行调用 onLine；结束或出错时调用 onEnd（只调用一次）。 */
export function proxyStream(proxy: ProxyAddress, url: string, onLine: (line: string) => void, onEnd: (reason: string) => void): StreamHandle {
  const u = new URL(url);
  let ended = false;
  const end = (reason: string): void => {
    if (ended) return;
    ended = true;
    onEnd(reason);
  };
  const req = httpRequest({ host: proxy.host, port: proxy.port, method: 'GET', path: u.toString(), headers: { Host: u.host, 'Cache-Control': 'no-store' } }, (res) => {
    if ((res.statusCode ?? 0) !== 200) {
      res.resume();
      end(`status_${res.statusCode ?? 0}`);
      return;
    }
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (c: string) => {
      buf += c;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        onLine(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
      if (buf.length > MAX_BODY) buf = '';
    });
    res.on('end', () => end('ended'));
    res.on('error', () => end('reset'));
    res.on('close', () => end('closed'));
  });
  req.on('error', (e: NodeJS.ErrnoException) => end(e.code ?? 'error'));
  req.end();
  return {
    close() {
      ended = true;
      req.destroy();
    },
  };
}

/** 经代理 CONNECT 建立隧道。 */
export function proxyConnect(proxy: ProxyAddress, host: string, port: number, timeoutMs = 8000): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const target = isIP(host) === 6 ? `[${host}]:${port}` : `${host}:${port}`;
    const req = httpRequest({ host: proxy.host, port: proxy.port, method: 'CONNECT', path: target, headers: { Host: target }, timeout: timeoutMs });
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`connect_status_${res.statusCode ?? 0}`));
        return;
      }
      resolve(socket);
    });
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('connect_timeout'));
    });
    req.on('error', (e: NodeJS.ErrnoException) => reject(new Error(e.code ?? 'connect_error')));
    req.end();
  });
}

export interface WsHandle {
  send(text: string): void;
  close(): void;
}

/**
 * 在已建立的套接字上做 WebSocket 握手（客户端帧加掩码）。握手失败（非 101、超时、握手中断开）只 reject，
 * 不调用 onClose；onClose 只用于握手成功之后的连接结束，且最多一次。调用方因此对每次失败只安排一次重连。
 */
export function websocketOverSocket(
  socket: Socket,
  hostHeader: string,
  path: string,
  onMessage: (text: string) => void,
  onClose: (reason: string) => void,
  handshakeTimeoutMs = 8000,
): Promise<WsHandle> {
  return new Promise((resolve, reject) => {
    const key = newClientKey();
    let handshake = true;
    let buf: Buffer = Buffer.alloc(0);
    let closed = false;
    const done = (reason: string): void => {
      if (closed || handshake) return;
      closed = true;
      onClose(reason);
    };
    const fail = (reason: string): void => {
      clearTimeout(timer);
      socket.destroy();
      reject(new Error(reason));
    };
    const timer = setTimeout(() => {
      if (handshake) fail('ws_handshake_timeout');
    }, handshakeTimeoutMs);
    socket.write(`GET ${path} HTTP/1.1\r\nHost: ${hostHeader}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    const handle: WsHandle = {
      send: (text) => {
        if (socket.writable) socket.write(encodeFrame(OPCODE.text, Buffer.from(text), true));
      },
      close: () => {
        closed = true;
        if (socket.writable) socket.end(encodeFrame(OPCODE.close, Buffer.alloc(0), true));
        socket.destroy();
      },
    };
    socket.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (handshake) {
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) {
          if (buf.length > 8192) fail('ws_handshake_too_large');
          return;
        }
        const head = buf.subarray(0, end).toString('latin1');
        buf = buf.subarray(end + 4);
        const accept = /^sec-websocket-accept:\s*(\S+)\s*$/im.exec(head)?.[1];
        if (!/^HTTP\/1\.1 101/.test(head) || accept !== acceptKey(key)) {
          fail('ws_handshake_failed');
          return;
        }
        handshake = false;
        clearTimeout(timer);
        resolve(handle);
      }
      try {
        const decoded = decodeFrames(buf);
        buf = decoded.rest;
        for (const f of decoded.frames) {
          if (f.opcode === OPCODE.text) onMessage(f.payload.toString('utf8'));
          else if (f.opcode === OPCODE.ping) socket.write(encodeFrame(OPCODE.pong, f.payload, true));
          else if (f.opcode === OPCODE.close) {
            done('closed_by_server');
            socket.destroy();
          }
        }
      } catch {
        done('bad_frame');
        socket.destroy();
      }
    });
    socket.on('error', () => {
      if (handshake) {
        fail('ws_socket_error');
        return;
      }
      done('reset');
    });
    socket.on('close', () => {
      if (handshake) {
        fail('ws_closed_during_handshake');
        return;
      }
      done('closed');
    });
  });
}
