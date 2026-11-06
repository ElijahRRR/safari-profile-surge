// 启动真实的回环 HTTP 服务（端口 0）并用 node:http 发请求：fetch 不允许自定义 Host，这里需要。

import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { connect } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHttpServer, type HttpServerHandle, type HttpServerOptions } from '../../src/http/server.js';
import type { SessionStore } from '../../src/http/sessions.js';
import { createStubApp, type StubApp } from '../support/stub-app.js';
import { loginToken, recordingLogger, sessionFixture, type TestClock } from './helpers.js';

export interface Harness {
  app: StubApp;
  sessions: SessionStore;
  clock: TestClock;
  logger: ReturnType<typeof recordingLogger>;
  server: HttpServerHandle;
  port: number;
  url: string;
  token: string;
  webRoot: string;
  close(): Promise<void>;
}

export interface HarnessOptions extends Partial<Omit<HttpServerOptions, 'app' | 'sessions' | 'logger' | 'port'>> {
  app?: StubApp;
}

/** 合成的网页构建产物与一个根目录外的“秘密”文件（用于穿越测试）。 */
export function makeWebRoot(): { base: string; webRoot: string; outsideSecret: string } {
  const base = mkdtempSync(join(tmpdir(), 'sfe-http-'));
  const webRoot = join(base, 'web');
  mkdirSync(join(webRoot, 'assets'), { recursive: true });
  writeFileSync(join(webRoot, 'index.html'), '<!doctype html><title>SFE</title><div id="app"></div>');
  writeFileSync(join(webRoot, 'assets', 'index-DMJtotKf.js'), 'console.log("app");');
  writeFileSync(join(webRoot, 'assets', 'index-DTSTiVJR.css'), 'body{}');
  writeFileSync(join(webRoot, 'assets', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  writeFileSync(join(webRoot, '.env'), 'DOTFILE_CONTENT_MARKER');
  writeFileSync(join(webRoot, 'assets', '.hidden.js'), 'DOTFILE_CONTENT_MARKER');
  const outsideSecret = 'OUTSIDE_ROOT_SECRET_MARKER';
  writeFileSync(join(base, 'secret.txt'), outsideSecret);
  return { base, webRoot, outsideSecret };
}

export async function startHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const { sessions, clock } = sessionFixture();
  const app = opts.app ?? createStubApp();
  const logger = recordingLogger();
  const { webRoot } = makeWebRoot();
  const server = createHttpServer({
    app,
    sessions,
    port: 0,
    webRoot: opts.webRoot === undefined ? webRoot : opts.webRoot,
    demo: opts.demo ?? false,
    extensionHarnessRoot: opts.extensionHarnessRoot ?? null,
    logger,
    serviceVersion: '0.1.0-test',
    ...(opts.heartbeatMs !== undefined ? { heartbeatMs: opts.heartbeatMs } : {}),
    ...(opts.maxBodyBytes !== undefined ? { maxBodyBytes: opts.maxBodyBytes } : {}),
  });
  const { url } = await server.listen();
  const port = Number(new URL(url).port);
  const token = loginToken(sessions);
  return { app, sessions, clock, logger, server, port, url, token, webRoot, close: () => server.close() };
}

export interface RawResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

export interface SendOptions {
  method?: string;
  path: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  /** 默认 Host 为 127.0.0.1:<port>；传 null 表示不覆盖。 */
  host?: string | null;
  token?: string | null;
}

export function send(h: Pick<Harness, 'port' | 'token'>, opts: SendOptions): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.host !== null) headers.host = opts.host ?? `127.0.0.1:${h.port}`;
    const token = opts.token === undefined ? h.token : opts.token;
    if (token !== null && headers.authorization === undefined) headers.authorization = `Bearer ${token}`;
    if (opts.body !== undefined && headers['content-type'] === undefined) headers['content-type'] = 'application/json';
    if (opts.body !== undefined && headers['content-length'] === undefined && headers['transfer-encoding'] === undefined) {
      headers['content-length'] = String(Buffer.byteLength(opts.body));
    }
    const req = httpRequest({ host: '127.0.0.1', port: h.port, method: opts.method ?? 'GET', path: opts.path, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

export const json = (r: RawResponse): any => JSON.parse(r.body);

/** 原样发送请求行（不经客户端规范化路径），用于穿越与缺少 Host 的测试。 */
export function rawRequest(port: number, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    const chunks: Buffer[] = [];
    socket.on('data', (c) => chunks.push(c));
    socket.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    socket.on('error', reject);
    socket.write(text);
  });
}

export function rawGet(port: number, path: string): Promise<{ status: number; text: string }> {
  return rawRequest(port, `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`).then((text) => ({
    status: Number(/^HTTP\/1\.1 (\d{3})/.exec(text)?.[1] ?? 0),
    text,
  }));
}

/** 读取事件流：返回已收到的原始文本与关闭函数。 */
export function openStream(h: Pick<Harness, 'port' | 'token'>, path: string, headers: Record<string, string> = {}, token: string | null = h.token) {
  let text = '';
  let ended = false;
  let status = 0;
  const waiters: Array<() => void> = [];
  const notify = () => {
    for (const w of waiters.splice(0)) w();
  };
  const reqHeaders: Record<string, string> = { host: `127.0.0.1:${h.port}`, accept: 'text/event-stream', ...headers };
  if (token !== null) reqHeaders.authorization = `Bearer ${token}`;
  const req = httpRequest({ host: '127.0.0.1', port: h.port, path, headers: reqHeaders, agent: false }, (res) => {
    status = res.statusCode ?? 0;
    res.setEncoding('utf8');
    res.on('data', (c: string) => {
      text += c;
      notify();
    });
    res.on('end', () => {
      ended = true;
      notify();
    });
    res.on('close', () => {
      ended = true;
      notify();
    });
  });
  req.on('error', () => {
    ended = true;
    notify();
  });
  req.end();
  const until = async (pred: () => boolean, timeoutMs = 3000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!pred()) {
      if (Date.now() > deadline) throw new Error(`stream wait timed out; got: ${text}`);
      await new Promise<void>((r) => {
        waiters.push(r);
        setTimeout(r, 20);
      });
    }
  };
  return {
    get text() {
      return text;
    },
    get ended() {
      return ended;
    },
    get status() {
      return status;
    },
    until,
    close: () => req.destroy(),
  };
}

export interface ParsedSse {
  id: string | null;
  event: string | null;
  data: any;
}

export function parseSse(text: string): ParsedSse[] {
  const out: ParsedSse[] = [];
  for (const block of text.split('\n\n')) {
    const lines = block.split('\n').filter((l) => l !== '' && !l.startsWith(':'));
    if (lines.length === 0) continue;
    let id: string | null = null;
    let event: string | null = null;
    let data = '';
    for (const l of lines) {
      if (l.startsWith('id: ')) id = l.slice(4);
      else if (l.startsWith('event: ')) event = l.slice(7);
      else if (l.startsWith('data: ')) data += l.slice(6);
    }
    if (data) out.push({ id, event, data: JSON.parse(data) });
  }
  return out;
}
