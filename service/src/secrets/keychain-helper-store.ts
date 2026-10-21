// 钥匙串实现：调用 App 内打包的 sfe-keychain 小工具（docs/ARCHITECTURE.md §2、§10）。
// argv 只有 ['--stdin-json']；请求是 stdin 上的一行 JSON，响应是 stdout 上的一行 JSON。秘密值只经
// stdin/stdout 传递，从不进入命令行参数、环境变量、日志或错误信息；stderr 读出后直接丢弃。
// 等待用户授权提示时可能较慢：30 秒超时后结束子进程，按可恢复失败处理（reason: timeout）。

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import type { SecretStore } from '../ports.js';
import type { SecretKind } from '../db/repos/secret-refs.js';
import { secretStoreError, type SecretStoreFailureReason } from './errors.js';

export const KEYCHAIN_HELPER_ARGS: readonly string[] = ['--stdin-json'];
export const DEFAULT_KEYCHAIN_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
/** 已给出结果但仍未退出的工具，在此宽限期后结束。 */
const EXIT_GRACE_MS = 5_000;
const REF_RE = /^[A-Za-z0-9._:-]{1,256}$/;
const REASONS: ReadonlySet<string> = new Set(['denied', 'locked', 'acl', 'not_found', 'other']);

export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export interface KeychainHelperStoreOptions {
  helperPath: string;
  timeoutMs?: number;
  /** 测试注入（默认 node:child_process.spawn，不经 shell）。 */
  spawn?: SpawnFn;
  /** 查询引用种类（例如 secret_refs 表）；用于在本地拒绝读取账号密码。 */
  kindOf?: (ref: string) => SecretKind | null;
}

type Op = 'set' | 'get' | 'delete';
type StoreOp = 'put' | 'get' | 'delete';

interface HelperRequest {
  op: Op;
  ref: string;
  kind: SecretKind;
  value?: string;
}

type HelperResponse = { ok: true; value?: string } | { ok: false; reason: SecretStoreFailureReason };

/** 系统秘密（例如 pepper）使用 `sfe.` 前缀的固定引用。 */
function isSystemRef(ref: string): boolean {
  return ref.startsWith('sfe.');
}

function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'PATH']) {
    const v = process.env[key];
    if (v !== undefined) env[key] = v;
  }
  return env;
}

export class KeychainHelperStore implements SecretStore {
  private readonly helperPath: string;
  private readonly timeoutMs: number;
  private readonly spawnFn: SpawnFn;
  private readonly kindOf: ((ref: string) => SecretKind | null) | undefined;
  /** 本进程写入过的引用种类（重启后由 kindOf 补充）。 */
  private readonly knownKinds = new Map<string, SecretKind>();

  constructor(opts: KeychainHelperStoreOptions) {
    this.helperPath = opts.helperPath;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_KEYCHAIN_TIMEOUT_MS;
    this.spawnFn = opts.spawn ?? ((cmd, args, o) => nodeSpawn(cmd, [...args], o));
    this.kindOf = opts.kindOf;
  }

  async put(ref: string, value: string, kind: SecretKind): Promise<void> {
    this.assertRef('put', ref);
    if (typeof value !== 'string') throw secretStoreError('put', 'other', '秘密值格式不正确');
    const res = await this.request('put', { op: 'set', ref, kind, value });
    if (!res.ok) throw secretStoreError('put', res.reason);
    this.knownKinds.set(ref, kind);
  }

  async get(ref: string): Promise<string | null> {
    this.assertRef('get', ref);
    const kind = this.resolveKind(ref);
    // 账号密码只由签名的原生桥读取；服务端连请求都不发
    if (kind === 'account') return null;
    const res = await this.request('get', { op: 'get', ref, kind });
    if (!res.ok) {
      if (res.reason === 'not_found') return null;
      throw secretStoreError('get', res.reason);
    }
    if (res.value === undefined) return null;
    if (typeof res.value !== 'string') throw secretStoreError('get', 'other', '钥匙串工具返回格式不正确');
    return res.value;
  }

  async delete(ref: string): Promise<void> {
    this.assertRef('delete', ref);
    const res = await this.request('delete', { op: 'delete', ref, kind: this.resolveKind(ref) });
    if (!res.ok && res.reason !== 'not_found') throw secretStoreError('delete', res.reason);
    this.knownKinds.delete(ref);
  }

  private resolveKind(ref: string): SecretKind {
    let looked: SecretKind | null = null;
    try {
      looked = this.kindOf?.(ref) ?? null;
    } catch {
      looked = null;
    }
    const known = this.knownKinds.get(ref) ?? looked;
    if (known) return known;
    // 未知种类按代理凭据查询：钥匙串工具按种类分命名空间，查不到账号项
    return isSystemRef(ref) ? 'system' : 'proxy';
  }

  private assertRef(op: StoreOp, ref: string): void {
    if (typeof ref !== 'string' || !REF_RE.test(ref)) throw secretStoreError(op, 'other', '引用格式不正确');
  }

  private request(op: StoreOp, req: HelperRequest): Promise<HelperResponse> {
    return new Promise<HelperResponse>((resolve, reject) => {
      let settled = false;
      let child: ChildProcess;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (child && child.exitCode === null && child.signalCode === null) {
          const grace = setTimeout(() => child.kill('SIGKILL'), EXIT_GRACE_MS);
          grace.unref?.();
          child.once('exit', () => clearTimeout(grace));
        }
        fn();
      };
      const fail = (reason: SecretStoreFailureReason, message?: string) => finish(() => reject(secretStoreError(op, reason, message)));

      try {
        child = this.spawnFn(this.helperPath, KEYCHAIN_HELPER_ARGS, {
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: false,
          env: childEnv(),
          windowsHide: true,
        });
      } catch {
        reject(secretStoreError(op, 'other', '无法启动钥匙串工具'));
        return;
      }

      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        fail('timeout');
      }, this.timeoutMs);
      timer.unref?.();

      const chunks: Buffer[] = [];
      let size = 0;
      const tryParse = (final: boolean) => {
        const text = Buffer.concat(chunks).toString('utf8');
        const nl = text.indexOf('\n');
        if (nl === -1 && !final) return;
        const line = (nl === -1 ? text : text.slice(0, nl)).trim();
        if (line.length === 0) {
          if (final) fail('other', '钥匙串工具没有返回结果');
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          fail('other', '钥匙串工具返回格式不正确');
          return;
        }
        const res = normalizeResponse(parsed);
        if (!res) {
          fail('other', '钥匙串工具返回格式不正确');
          return;
        }
        finish(() => resolve(res));
      };

      child.on('error', (err: NodeJS.ErrnoException) => {
        const code = err.code;
        fail('other', code === 'ENOENT' ? '找不到钥匙串工具' : code === 'EACCES' ? '钥匙串工具不可执行' : '无法启动钥匙串工具');
      });
      child.stdout?.on('data', (chunk: Buffer) => {
        if (settled) return;
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          child.kill('SIGKILL');
          fail('other', '钥匙串工具返回内容过长');
          return;
        }
        chunks.push(chunk);
        tryParse(false);
      });
      // stderr 可能含有工具的诊断信息：读出并丢弃，从不写入日志或错误
      child.stderr?.on('data', () => undefined);
      child.on('close', () => {
        if (!settled) tryParse(true);
      });
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(`${JSON.stringify(req)}\n`);
    });
  }
}

function normalizeResponse(parsed: unknown): HelperResponse | null {
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  if (obj.ok === true) {
    if (obj.value !== undefined && typeof obj.value !== 'string') return null;
    return obj.value === undefined ? { ok: true } : { ok: true, value: obj.value as string };
  }
  if (obj.ok === false) {
    const reason = typeof obj.reason === 'string' && REASONS.has(obj.reason) ? (obj.reason as SecretStoreFailureReason) : 'other';
    return { ok: false, reason };
  }
  return null;
}
