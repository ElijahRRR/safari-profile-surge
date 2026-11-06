// CLI 测试工具：注入假的套接字请求、标准输入、文件读取与 exec，记录全部输出与请求。

import type { AdminRequestEnvelope } from '@sfe/contract';
import type { CliDeps } from '../../src/cli/sfe.js';

export interface FakeCli {
  deps: CliDeps;
  stdout: () => string;
  stderr: () => string;
  requests: Array<{ socketPath: string; envelope: AdminRequestEnvelope }>;
  execs: Array<{ file: string; args: string[] }>;
  sleeps: number[];
}

export type Responder = (args: Record<string, unknown>, socketPath: string) => unknown;

export interface FakeOptions {
  argv: string[];
  /** op → 返回 data（自动包成 { ok: true, data }）；返回 { ok: false, error } 时原样作为应答。 */
  responses?: Record<string, Responder | unknown>;
  stdin?: string;
  files?: Record<string, Buffer | string>;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homedir?: string;
  cwd?: string;
  uid?: number;
  request?: CliDeps['request'];
  exec?: CliDeps['exec'];
  sleep?: CliDeps['sleep'];
  now?: () => number;
}

export function fakeCli(opts: FakeOptions): FakeCli {
  let out = '';
  let err = '';
  const requests: FakeCli['requests'] = [];
  const execs: FakeCli['execs'] = [];
  const sleeps: number[] = [];
  let seq = 0;
  const deps: CliDeps = {
    argv: opts.argv,
    env: opts.env ?? { SFE_DATA_DIR: '/tmp/sfe-cli-test-data' },
    platform: opts.platform ?? 'darwin',
    homedir: opts.homedir ?? '/Users/tester',
    cwd: opts.cwd ?? '/work',
    uid: opts.uid ?? process.getuid?.(),
    stdout: (t) => {
      out += t;
    },
    stderr: (t) => {
      err += t;
    },
    readStdin: async () => {
      if (opts.stdin === undefined) throw new Error('no stdin in test');
      return opts.stdin;
    },
    readFile: async (path) => {
      const f = opts.files?.[path];
      if (f === undefined) throw Object.assign(new Error(`ENOENT ${path}`), { code: 'ENOENT' });
      return Buffer.isBuffer(f) ? f : Buffer.from(f, 'utf8');
    },
    request:
      opts.request ??
      (async (socketPath, envelope) => {
        requests.push({ socketPath, envelope });
        const r = opts.responses?.[envelope.op];
        const value = typeof r === 'function' ? (r as Responder)(envelope.args, socketPath) : r;
        if (value && typeof value === 'object' && (value as { ok?: unknown }).ok === false) return value;
        return { ok: true, data: value ?? null };
      }),
    exec:
      opts.exec ??
      (async (file, args) => {
        execs.push({ file, args });
      }),
    sleep:
      opts.sleep ??
      (async (ms) => {
        sleeps.push(ms);
      }),
    now: opts.now ?? (() => Date.parse('2026-10-21T08:00:00.000Z')),
    newRequestId: () => `cli-test-${++seq}`,
    randomHex: (n) => 'ab'.repeat(n),
  };
  if (opts.request) {
    const inner = opts.request;
    deps.request = async (socketPath, envelope) => {
      requests.push({ socketPath, envelope });
      return inner(socketPath, envelope);
    };
  }
  return { deps, stdout: () => out, stderr: () => err, requests, execs, sleeps };
}

export const apiError = (code: string, message: string, extra: Record<string, unknown> = {}) => ({ ok: false, error: { code, message, ...extra } });
