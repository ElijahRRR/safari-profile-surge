// 离线测试用的“迷你 Surge”：用 FakeSurge 的规则求值决定策略链，再经真实的本机 SOCKS5 测试服务
// （前置 → 出口）把请求送到回显服务，模拟 Surge 的 HTTP 代理端口与 testPolicy。只用于验证 P0 命令的编排，
// 不代表真实 Surge 的任何行为。

import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import { connect, type Socket } from 'node:net';
import { join } from 'node:path';
import { NODE_RESOURCE_FILE } from '@sfe/contract';
import { FakeSurge, findSections, isCommentLine, parseProfile, parseProxyLine } from '../../src/deps.js';

interface NodeDef {
  name: string;
  server: string;
  port: number;
  username: string | null;
  password: string | null;
}

function loadNodes(dir: string, profileFile: string): Map<string, NodeDef> {
  const out = new Map<string, NodeDef>();
  const add = (line: string): void => {
    if (isCommentLine(line)) return;
    const p = parseProxyLine(line);
    if (!p || !p.server || !p.port) return;
    out.set(p.name, { name: p.name, server: p.server, port: p.port, username: p.params.username ?? null, password: p.params.password ?? null });
  };
  const parsed = parseProfile(readFileSync(join(dir, profileFile), 'utf8'));
  for (const s of findSections(parsed, 'Proxy')) for (let i = (s.header ?? s.start) + 1; i < s.end; i++) add(parsed.lines[i]!.text);
  for (const line of readFileSync(join(dir, NODE_RESOURCE_FILE), 'utf8').split('\n')) add(line);
  return out;
}

function read(sock: Socket, n: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const onData = (c: Buffer): void => {
      buf = Buffer.concat([buf, c]);
      if (buf.length >= n) {
        sock.off('data', onData);
        sock.off('close', onClose);
        if (buf.length > n) sock.unshift(buf.subarray(n));
        resolve(buf.subarray(0, n));
      }
    };
    const onClose = (): void => reject(new Error('closed'));
    sock.on('data', onData);
    sock.once('close', onClose);
    sock.once('error', onClose);
  });
}

async function socksThrough(sock: Socket, host: string, port: number, user: string | null, pass: string | null): Promise<void> {
  sock.write(Buffer.from([5, 1, user !== null ? 2 : 0]));
  const m = await read(sock, 2);
  if (m[1] === 2) {
    const u = Buffer.from(user ?? '');
    const p = Buffer.from(pass ?? '');
    sock.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([p.length]), p]));
    const a = await read(sock, 2);
    if (a[1] !== 0) throw new Error('auth failed');
  } else if (m[1] !== 0) throw new Error('no method');
  const h = Buffer.from(host);
  sock.write(Buffer.concat([Buffer.from([5, 1, 0, 3, h.length]), h, Buffer.from([port >> 8, port & 0xff])]));
  const r = await read(sock, 10);
  if (r[1] !== 0) throw new Error(`connect refused ${r[1]}`);
}

/** chain 为 [组…, 节点, 前置]：从最外层（前置）开始逐跳建立 SOCKS5 隧道。 */
async function openChain(nodes: Map<string, NodeDef>, chain: readonly string[], host: string, port: number): Promise<Socket> {
  const hops = chain.filter((n) => nodes.has(n)).map((n) => nodes.get(n)!).reverse();
  if (hops.length === 0) throw new Error('no proxy hop (DIRECT or REJECT)');
  const first = hops[0]!;
  const sock = connect(first.port, first.server);
  await new Promise<void>((resolve, reject) => {
    sock.once('connect', () => resolve());
    sock.once('error', reject);
  });
  for (let i = 0; i < hops.length; i++) {
    const next = hops[i + 1];
    await socksThrough(sock, next ? next.server : host, next ? next.port : port, hops[i]!.username, hops[i]!.password);
  }
  return sock;
}

export class MiniSurge extends FakeSurge {
  readonly nodes = (): Map<string, NodeDef> => loadNodes(this.directory, this.profileFileName);

  /** 真正经过节点链访问给定地址（FakeSurge 本身不发网络请求）。 */
  override async testPolicy(policy: string, url: string): Promise<{ ok: boolean; latencyMs: number | null; error: string | null }> {
    const base = await super.testPolicy(policy, url);
    if (!base.ok) return base;
    const groups = (await this.listPolicies()).groups;
    const node = groups.includes(policy) ? await this.getGroupSelection(policy) : policy;
    if (!node) return { ok: false, latencyMs: null, error: 'no selection' };
    const detail = await this.getPolicyDetail(node);
    const u = new URL(url);
    const t0 = Date.now();
    try {
      const sock = await openChain(this.nodes(), [node, ...(detail.underlyingProxy ? [detail.underlyingProxy] : [])], u.hostname, Number(u.port || 80));
      sock.write(`GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.host}\r\nConnection: close\r\n\r\n`);
      await new Promise((r) => sock.once('close', r));
      return { ok: true, latencyMs: Date.now() - t0, error: null };
    } catch (e) {
      return { ok: false, latencyMs: null, error: String((e as Error).message) };
    }
  }
}

export interface MiniProxy {
  port: number;
  close(): Promise<void>;
}

/** Surge HTTP 代理端口的替身：绝对 URI 的 GET 与 CONNECT。 */
export async function startMiniSurgeProxy(surge: MiniSurge, processPath = '/usr/local/bin/p0-tool'): Promise<MiniProxy> {
  const sockets = new Set<Socket>();
  const route = (host: string): { chain: string[]; failed: boolean } => {
    const r = surge.simulateRequest({ processPath, host, protocol: 'tcp' });
    return { chain: r.chain, failed: r.failed };
  };
  const server = createServer(async (req: IncomingMessage, res) => {
    let u: URL;
    try {
      u = new URL(req.url ?? '');
    } catch {
      res.writeHead(400).end();
      return;
    }
    const r = route(u.hostname);
    if (r.failed) {
      res.writeHead(502).end();
      return;
    }
    let tunnel: Socket;
    try {
      tunnel = await openChain(surge.nodes(), r.chain, u.hostname, Number(u.port || 80));
    } catch {
      res.writeHead(502).end();
      return;
    }
    sockets.add(tunnel);
    tunnel.write(`GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.host}\r\nConnection: close\r\n\r\n`);
    const client = req.socket;
    tunnel.pipe(client);
    tunnel.on('close', () => client.destroy());
    client.on('close', () => tunnel.destroy());
  });
  server.on('connect', async (req: IncomingMessage, client: Socket) => {
    sockets.add(client);
    const [host, portText] = (req.url ?? '').split(':');
    const r = route(host ?? '');
    if (r.failed) {
      client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      return;
    }
    try {
      const tunnel = await openChain(surge.nodes(), r.chain, host!, Number(portText));
      sockets.add(tunnel);
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      tunnel.pipe(client);
      client.pipe(tunnel);
      tunnel.on('close', () => client.destroy());
      client.on('close', () => tunnel.destroy());
    } catch {
      client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    }
  });
  server.on('connection', (s) => sockets.add(s));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return {
    port: (server.address() as { port: number }).port,
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
