// 启动三台本机测试服务（全部只监听 127.0.0.1）：回显（HTTP + WebSocket + 测试页）、SOCKS5 出口（必须认证）、
// SOCKS5 前置（只允许连到出口服务）。日志写入运行目录 servers/*.jsonl（0600），只记长度、判定、目标与经过的节点。

import { timingSafeEqual } from 'node:crypto';
import { createServer as createNetServer, type Server } from 'node:net';
import { CHARSET_EXPECT_FILE } from '../constants.js';
import { charsetIndexOf, compareCredentials, type CharsetExpectation } from '../charset.js';
import type { RunDir } from '../run-dir.js';
import { TEST_DOMAIN, TEST_USERS } from '../test-profile.js';
import { createEchoServer } from './echo.js';
import { ConnectionRegistry } from './registry.js';
import { createSocks5Server, type Socks5Target } from './socks5.js';

export interface TestServerPorts {
  echo: number;
  exit: number;
  front: number;
  deadFront: number;
}

export interface TestServerOptions {
  ports: TestServerPorts;
  password: string;
  /** 出口允许转发到的公网测试主机（只限 80/443）。 */
  allowUpstream: readonly string[];
  h3Host: string;
  ipv6Host: string;
  /** 读取 charset 期望（每次认证时读取，charset 命令运行时写入）。 */
  charsetExpectations: () => CharsetExpectation[];
  log: (file: 'echo' | 'exit' | 'front' | 'page', event: Record<string, unknown>) => void;
  now?: () => Date;
  /** 测试用：回显流与 WebSocket 心跳间隔。 */
  tickMs?: number;
}

export interface RunningServers {
  registry: ConnectionRegistry;
  ports: TestServerPorts;
  close(): Promise<void>;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '0:0:0:0:0:0:0:1']);

export function isTestHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return h === TEST_DOMAIN || h.endsWith(`.${TEST_DOMAIN}`);
}

/** 出口服务的转发规则（纯函数）：测试域名 → 本机回显；允许的公网测试主机（80/443）→ 原样；其他拒绝。 */
export function exitRoute(target: Socks5Target, ports: TestServerPorts, allowUpstream: readonly string[]): { host: string; port: number } | null {
  const host = target.host.toLowerCase().replace(/\.$/, '');
  if (target.atyp === 'domain' && isTestHost(host)) return { host: '127.0.0.1', port: ports.echo };
  if (target.atyp === 'ipv4' && host === '127.0.0.1' && target.port === ports.echo) return { host: '127.0.0.1', port: ports.echo };
  if (target.atyp === 'domain' && allowUpstream.map((h) => h.toLowerCase()).includes(host) && (target.port === 443 || target.port === 80)) {
    return { host, port: target.port };
  }
  return null;
}

/** 前置服务只允许连到本机出口服务端口。 */
export function frontRoute(target: Socks5Target, ports: TestServerPorts): { host: string; port: number } | null {
  return LOOPBACK.has(target.host.toLowerCase()) && target.port === ports.exit ? { host: '127.0.0.1', port: ports.exit } : null;
}

function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : port);
    });
  });
}

function close(server: Server, sockets: Set<import('node:net').Socket>): Promise<void> {
  // 浏览器的长连接、WebSocket 与转发中的隧道会让 close 一直等待：停止时主动断开。
  for (const s of sockets) s.destroy();
  return new Promise((resolve) => server.close(() => resolve()));
}

function track(server: Server): Set<import('node:net').Socket> {
  const sockets = new Set<import('node:net').Socket>();
  server.on('connection', (s) => {
    sockets.add(s);
    s.once('close', () => sockets.delete(s));
  });
  return sockets;
}

/** 检查端口上没有服务（坏前置必须连不上）。 */
export function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createNetServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

export async function startTestServers(opts: TestServerOptions): Promise<RunningServers> {
  const registry = new ConnectionRegistry();
  const now = opts.now ?? (() => new Date());
  // 实际端口（传入 0 时由系统分配）；转发规则在连接时读取它。
  const ports: TestServerPorts = { ...opts.ports };
  const expectedPassword = Buffer.from(opts.password, 'utf8');
  const knownUsers = new Set<string>(Object.values(TEST_USERS));

  const echo = createEchoServer({
    registry,
    now,
    log: (e) => opts.log('echo', e),
    report: (app, events) => opts.log('page', { at: now().toISOString(), app, events }),
    ipv6Url: `https://${opts.ipv6Host}/?format=json`,
    h3Url: `https://${opts.h3Host}/cdn-cgi/trace`,
    streamIntervalMs: opts.tickMs,
    wsTickMs: opts.tickMs,
  });

  const exit = createSocks5Server({
    requireAuth: true,
    authenticate: (username, password, session) => {
      const fromFront = registry.isFromFront(session.remotePort);
      const csIndex = charsetIndexOf(username);
      if (csIndex !== null) {
        const e = opts.charsetExpectations().find((x) => x.index === csIndex);
        if (!e) return { ok: false, user: null };
        const verdict = compareCredentials(e, username, password);
        opts.log('exit', {
          kind: 'charset_auth',
          at: now().toISOString(),
          index: csIndex,
          id: e.id,
          verdict,
          throughFront: fromFront,
          usernameLength: username.length,
          passwordLength: password.length,
          expectedUsernameLength: Buffer.byteLength(e.username),
          expectedPasswordLength: Buffer.byteLength(e.password),
        });
        return { ok: true, user: `charset-${e.id}` };
      }
      const user = username.toString('utf8');
      const ok = knownUsers.has(user) && safeEqual(password, expectedPassword);
      return { ok, user: ok ? user : null };
    },
    route: (target) => exitRoute(target, ports, opts.allowUpstream),
    onOutbound: (session, out, target) => {
      const hop = { user: session.user, throughFront: registry.isFromFront(session.remotePort), target: `${target.host}:${target.port}`, at: Date.now() };
      registry.addExitOutbound(out.localPort, hop);
      const lp = out.localPort;
      out.once('close', () => registry.removeExitOutbound(lp));
    },
    onEvent: (e) => opts.log('exit', { ...e, at: now().toISOString(), throughFront: registry.isFromFront(e.remotePort as number) }),
  });

  const front = createSocks5Server({
    requireAuth: false,
    route: (target) => frontRoute(target, ports),
    onOutbound: (_session, out) => {
      registry.addFrontOutbound(out.localPort);
      const lp = out.localPort;
      out.once('close', () => setTimeout(() => registry.removeFrontOutbound(lp), 1000));
    },
    onEvent: (e) => opts.log('front', { ...e, at: now().toISOString() }),
  });

  const tracked = new Map<Server, Set<import('node:net').Socket>>([echo, exit, front].map((srv) => [srv, track(srv)]));
  const started: Server[] = [];
  const closeAll = (): Promise<void[]> => Promise.all(started.map((srv) => close(srv, tracked.get(srv)!)));
  try {
    ports.echo = await listen(echo, opts.ports.echo);
    started.push(echo);
    ports.exit = await listen(exit, opts.ports.exit);
    started.push(exit);
    ports.front = await listen(front, opts.ports.front);
    started.push(front);
  } catch (e) {
    await closeAll();
    throw e;
  }
  return {
    registry,
    ports,
    async close() {
      await closeAll();
    },
  };
}

export function readCharsetExpectations(dir: RunDir): CharsetExpectation[] {
  const data = dir.readJson<{ classes?: CharsetExpectation[] }>(CHARSET_EXPECT_FILE);
  return Array.isArray(data?.classes) ? data.classes : [];
}
