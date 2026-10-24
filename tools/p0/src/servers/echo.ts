// IP 回显 / 测试 HTTP + WebSocket 服务（只监听 127.0.0.1）。经测试出口转发来的连接可以按对端端口在
// 连接登记中查到“经过哪个测试节点、是否经过前置”。回答不含请求头；日志只记路径、测试编号与经过的节点。

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { VERIFY_ENDPOINTS } from '@sfe/contract';
import { testPageHtml, type PageConfig } from './page.js';
import type { ConnectionRegistry } from './registry.js';
import { OPCODE, acceptKey, decodeFrames, encodeFrame } from './websocket.js';

export interface EchoServerOptions {
  registry: ConnectionRegistry;
  log: (event: Record<string, unknown>) => void;
  report: (app: string, events: unknown[]) => void;
  ipv6Url?: string;
  h3Url?: string;
  now?: () => Date;
  maxReportBytes?: number;
  streamIntervalMs?: number;
  wsTickMs?: number;
}

const ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const APP_RE = /^[a-z0-9-]{1,32}$/;

function param(url: URL, name: string, re: RegExp): string | null {
  const v = url.searchParams.get(name);
  return v !== null && re.test(v) ? v : null;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

export function createEchoServer(opts: EchoServerOptions): Server {
  const now = opts.now ?? (() => new Date());
  const identify = (socket: Socket): { via: string | null; throughFront: boolean | null } => {
    const hop = opts.registry.lookupExit(socket.remotePort);
    return hop ? { via: hop.user, throughFront: hop.throughFront } : { via: null, throughFront: null };
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://p0.invalid');
    const who = identify(req.socket);
    const testId = param(url, 't', ID_RE);
    const app = param(url, 'app', APP_RE);
    opts.log({ kind: 'http', at: now().toISOString(), method: req.method, path: url.pathname, testId, app, via: who.via, throughFront: who.throughFront, httpVersion: req.httpVersion });

    if (req.method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, { ok: true, service: 'sfe-p0-echo' });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/ip') {
      sendJson(res, 200, {
        testId,
        app,
        via: who.via,
        throughFront: who.throughFront,
        source: `${req.socket.remoteAddress ?? '?'}:${req.socket.remotePort ?? '?'}`,
        at: now().toISOString(),
        httpVersion: req.httpVersion,
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/stream') {
      const max = Math.min(Number(url.searchParams.get('n') ?? '3600') || 3600, 86_400);
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      let seq = 0;
      const timer = setInterval(() => {
        seq++;
        res.write(`${JSON.stringify({ seq, at: now().toISOString(), via: who.via })}\n`);
        if (seq >= max) {
          clearInterval(timer);
          res.end();
        }
      }, opts.streamIntervalMs ?? 1000);
      res.on('close', () => clearInterval(timer));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/report') {
      const limit = opts.maxReportBytes ?? 256 * 1024;
      const chunks: Buffer[] = [];
      let total = 0;
      let aborted = false;
      req.on('data', (c: Buffer) => {
        total += c.length;
        if (total > limit) {
          aborted = true;
          sendJson(res, 413, { ok: false });
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        if (aborted) return;
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { app?: unknown; events?: unknown };
          const a = typeof body.app === 'string' && APP_RE.test(body.app) ? body.app : 'unknown';
          const events = Array.isArray(body.events) ? body.events.slice(0, 1000) : [];
          opts.report(a, events);
          sendJson(res, 200, { ok: true, accepted: events.length });
        } catch {
          sendJson(res, 400, { ok: false });
        }
      });
      return;
    }
    // 测试页：/app/<标签>（轮询）与 /attr/<标签>（归属测试）；终端打印的地址不带查询参数，避免被脱敏。
    const pathApp = /^\/(app|attr)\/([a-z0-9-]{1,32})$/.exec(url.pathname);
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/attr' || pathApp)) {
      const attr = url.pathname === '/attr' || pathApp?.[1] === 'attr' || url.searchParams.get('mode') === 'attr';
      const cfg: PageConfig = {
        app: pathApp?.[2] ?? app ?? 'safari',
        mode: attr ? 'attr' : 'poll',
        verifyUrl: VERIFY_ENDPOINTS[0]!.url,
        ipv6Url: opts.ipv6Url ?? 'https://api6.ipify.org/?format=json',
        h3Url: opts.h3Url ?? 'https://cloudflare-quic.com/cdn-cgi/trace',
        intervalMs: 1000,
      };
      const html = testPageHtml(cfg);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(html) });
      res.end(html);
      return;
    }
    sendJson(res, 404, { ok: false });
  });

  server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://p0.invalid');
    const key = req.headers['sec-websocket-key'];
    if (url.pathname !== '/ws' || typeof key !== 'string' || (req.headers.upgrade ?? '').toLowerCase() !== 'websocket') {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      return;
    }
    const who = identify(socket);
    const app = param(url, 'app', APP_RE);
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`);
    const openedAt = now();
    opts.log({ kind: 'ws_open', at: openedAt.toISOString(), app, via: who.via, throughFront: who.throughFront });
    let seq = 0;
    const send = (obj: unknown): void => {
      if (socket.writable) socket.write(encodeFrame(OPCODE.text, Buffer.from(JSON.stringify(obj)), false));
    };
    send({ hello: true, via: who.via, throughFront: who.throughFront });
    const tick = setInterval(() => send({ seq: ++seq, at: now().toISOString(), via: who.via }), opts.wsTickMs ?? 1000);
    let buf: Buffer = Buffer.from(head);
    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk]);
      let decoded;
      try {
        decoded = decodeFrames(buf);
      } catch {
        socket.destroy();
        return;
      }
      buf = decoded.rest;
      for (const f of decoded.frames) {
        if (f.opcode === OPCODE.close) {
          if (socket.writable) socket.end(encodeFrame(OPCODE.close, Buffer.alloc(0), false));
          return;
        }
        if (f.opcode === OPCODE.ping) socket.write(encodeFrame(OPCODE.pong, f.payload, false));
        else if (f.opcode === OPCODE.text) send({ echo: f.payload.toString('utf8').slice(0, 200), via: who.via });
      }
    };
    socket.on('data', onData);
    socket.on('error', () => socket.destroy());
    socket.on('close', () => {
      clearInterval(tick);
      opts.log({ kind: 'ws_close', at: now().toISOString(), app, via: who.via, openMs: now().getTime() - openedAt.getTime(), sent: seq });
    });
    if (buf.length > 0) onData(Buffer.alloc(0));
  });
  return server;
}
