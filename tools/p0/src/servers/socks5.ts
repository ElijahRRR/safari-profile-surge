// 最小 SOCKS5 服务（RFC 1928 + RFC 1929 用户名/密码认证），只用于 P0 本机测试：
// 出口服务要求认证，前置服务不认证；目标由调用方的 route 决定（不在允许范围内一律拒绝），
// 因此不会成为开放代理。日志只记长度与判定，不记密码。

import { createServer, connect, type Server, type Socket } from 'node:net';

export type Atyp = 'ipv4' | 'domain' | 'ipv6';

export interface Socks5Target {
  host: string;
  port: number;
  atyp: Atyp;
}

export type Parsed<T> = { kind: 'ok'; value: T; used: number } | { kind: 'incomplete' } | { kind: 'error'; error: string };

export const REP = {
  succeeded: 0x00,
  general: 0x01,
  notAllowed: 0x02,
  netUnreachable: 0x03,
  hostUnreachable: 0x04,
  refused: 0x05,
  cmdNotSupported: 0x07,
  atypNotSupported: 0x08,
} as const;

export function parseGreeting(buf: Buffer): Parsed<{ methods: number[] }> {
  if (buf.length < 2) return { kind: 'incomplete' };
  if (buf[0] !== 0x05) return { kind: 'error', error: 'bad_version' };
  const n = buf[1]!;
  if (n === 0) return { kind: 'error', error: 'no_methods' };
  if (buf.length < 2 + n) return { kind: 'incomplete' };
  return { kind: 'ok', value: { methods: [...buf.subarray(2, 2 + n)] }, used: 2 + n };
}

export function parseUserPass(buf: Buffer): Parsed<{ username: Buffer; password: Buffer }> {
  if (buf.length < 2) return { kind: 'incomplete' };
  if (buf[0] !== 0x01) return { kind: 'error', error: 'bad_auth_version' };
  const ulen = buf[1]!;
  if (buf.length < 2 + ulen + 1) return { kind: 'incomplete' };
  const plen = buf[2 + ulen]!;
  if (buf.length < 3 + ulen + plen) return { kind: 'incomplete' };
  return {
    kind: 'ok',
    value: { username: Buffer.from(buf.subarray(2, 2 + ulen)), password: Buffer.from(buf.subarray(3 + ulen, 3 + ulen + plen)) },
    used: 3 + ulen + plen,
  };
}

export function parseRequest(buf: Buffer): Parsed<{ cmd: number; target: Socks5Target }> {
  if (buf.length < 4) return { kind: 'incomplete' };
  if (buf[0] !== 0x05) return { kind: 'error', error: 'bad_version' };
  const cmd = buf[1]!;
  const atypByte = buf[3]!;
  let host: string;
  let off: number;
  let atyp: Atyp;
  if (atypByte === 0x01) {
    if (buf.length < 10) return { kind: 'incomplete' };
    host = [...buf.subarray(4, 8)].join('.');
    off = 8;
    atyp = 'ipv4';
  } else if (atypByte === 0x03) {
    if (buf.length < 5) return { kind: 'incomplete' };
    const len = buf[4]!;
    if (len === 0) return { kind: 'error', error: 'empty_domain' };
    if (buf.length < 5 + len + 2) return { kind: 'incomplete' };
    host = buf.subarray(5, 5 + len).toString('latin1');
    off = 5 + len;
    atyp = 'domain';
  } else if (atypByte === 0x04) {
    if (buf.length < 22) return { kind: 'incomplete' };
    const parts: string[] = [];
    for (let i = 0; i < 8; i++) parts.push(buf.readUInt16BE(4 + i * 2).toString(16));
    host = parts.join(':');
    off = 20;
    atyp = 'ipv6';
  } else {
    return { kind: 'error', error: 'bad_atyp' };
  }
  const port = buf.readUInt16BE(off);
  return { kind: 'ok', value: { cmd, target: { host, port, atyp } }, used: off + 2 };
}

export function buildReply(rep: number): Buffer {
  return Buffer.from([0x05, rep, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
}

export interface AuthDecision {
  ok: boolean;
  /** 认证通过时的用户标签（写入日志与连接登记）。 */
  user: string | null;
}

export interface Socks5Session {
  user: string | null;
  remotePort: number;
}

export interface Socks5ServerOptions {
  requireAuth: boolean;
  authenticate?: (username: Buffer, password: Buffer, session: Socks5Session) => AuthDecision;
  route: (target: Socks5Target, session: Socks5Session) => { host: string; port: number } | null;
  /** 出站连接建立后（回复成功之前）调用，用于登记本地端口。 */
  onOutbound?: (session: Socks5Session, outbound: Socket, target: Socks5Target) => void;
  onEvent?: (event: Record<string, unknown>) => void;
  handshakeTimeoutMs?: number;
}

const MAX_HANDSHAKE_BYTES = 1024;

export function handleSocks5Connection(socket: Socket, opts: Socks5ServerOptions): void {
  const session: Socks5Session = { user: null, remotePort: socket.remotePort ?? 0 };
  const emit = (e: Record<string, unknown>): void => opts.onEvent?.({ ...e, remotePort: session.remotePort });
  let stage: 'greeting' | 'auth' | 'request' | 'connecting' | 'piping' = 'greeting';
  let buf: Buffer = Buffer.alloc(0);
  const timer = setTimeout(() => {
    emit({ kind: 'timeout', stage });
    socket.destroy();
  }, opts.handshakeTimeoutMs ?? 10_000);
  const fail = (rep: number | null, reason: string): void => {
    clearTimeout(timer);
    emit({ kind: 'refused', reason, user: session.user });
    if (rep !== null && socket.writable) socket.end(buildReply(rep));
    else socket.destroy();
  };
  socket.on('error', () => socket.destroy());

  const onData = (chunk: Buffer): void => {
    buf = Buffer.concat([buf, chunk]);
    if (buf.length > MAX_HANDSHAKE_BYTES && stage !== 'connecting') {
      fail(null, 'handshake_too_large');
      return;
    }
    for (;;) {
      if (stage === 'greeting') {
        const g = parseGreeting(buf);
        if (g.kind === 'incomplete') return;
        if (g.kind === 'error') return fail(null, g.error);
        buf = buf.subarray(g.used);
        const wanted = opts.requireAuth ? 0x02 : 0x00;
        // 不要求认证的前置服务也接受只提供用户名/密码方式的客户端（凭据不检查、不记录）。
        const method = g.value.methods.includes(wanted) ? wanted : !opts.requireAuth && g.value.methods.includes(0x02) ? 0x02 : 0xff;
        socket.write(Buffer.from([0x05, method]));
        if (method === 0xff) return fail(null, opts.requireAuth ? 'auth_required' : 'no_acceptable_method');
        stage = method === 0x02 ? 'auth' : 'request';
        continue;
      }
      if (stage === 'auth') {
        const a = parseUserPass(buf);
        if (a.kind === 'incomplete') return;
        if (a.kind === 'error') return fail(null, a.error);
        buf = buf.subarray(a.used);
        const decision = opts.requireAuth ? (opts.authenticate?.(a.value.username, a.value.password, session) ?? { ok: false, user: null }) : { ok: true, user: null };
        if (opts.requireAuth) emit({ kind: 'auth', ok: decision.ok, user: decision.user, usernameLength: a.value.username.length, passwordLength: a.value.password.length });
        socket.write(Buffer.from([0x01, decision.ok ? 0x00 : 0x01]));
        if (!decision.ok) {
          clearTimeout(timer);
          socket.end();
          return;
        }
        session.user = decision.user;
        stage = 'request';
        continue;
      }
      if (stage === 'request') {
        const r = parseRequest(buf);
        if (r.kind === 'incomplete') return;
        if (r.kind === 'error') return fail(r.error === 'bad_atyp' ? REP.atypNotSupported : REP.general, r.error);
        buf = buf.subarray(r.used);
        const { cmd, target } = r.value;
        emit({ kind: 'connect', user: session.user, target: `${target.host}:${target.port}`, atyp: target.atyp, cmd });
        if (cmd !== 0x01) return fail(REP.cmdNotSupported, 'cmd_not_supported');
        const dest = opts.route(target, session);
        if (!dest) return fail(REP.notAllowed, 'target_not_allowed');
        stage = 'connecting';
        const out = connect({ host: dest.host, port: dest.port });
        out.once('connect', () => {
          clearTimeout(timer);
          opts.onOutbound?.(session, out, target);
          emit({ kind: 'connected', user: session.user, target: `${target.host}:${target.port}`, localPort: out.localPort });
          socket.write(buildReply(REP.succeeded));
          stage = 'piping';
          socket.off('data', onData);
          if (buf.length > 0) out.write(buf);
          buf = Buffer.alloc(0);
          socket.pipe(out);
          out.pipe(socket);
          const closeBoth = (): void => {
            socket.destroy();
            out.destroy();
          };
          out.on('error', closeBoth);
          out.on('close', closeBoth);
          socket.on('close', closeBoth);
        });
        out.once('error', () => {
          if (stage === 'connecting') fail(REP.refused, 'upstream_unreachable');
        });
        return;
      }
      return;
    }
  };
  socket.on('data', onData);
}

export function createSocks5Server(opts: Socks5ServerOptions): Server {
  return createServer((socket) => handleSocks5Connection(socket, opts));
}
