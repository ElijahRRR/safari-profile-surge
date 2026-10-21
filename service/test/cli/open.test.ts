import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { cleanupStaleWeblocs, weblocContent, writeWebloc } from '../../src/cli/open.js';
import { runCli } from '../../src/cli/sfe.js';
import { apiError, fakeCli } from './helpers.js';

const CODE = 'SyntheticLoginCode_abcdefghijklmnopqrstuvwxyz0';
const LOGIN = { url: `http://127.0.0.1:61847/auth/exchange?code=${CODE}`, expiresAt: '2026-10-21T08:01:00.000Z' };

function dataDir(mode = 0o700): string {
  const d = mkdtempSync(join(tmpdir(), 'sfe-cli-'));
  chmodSync(d, mode);
  return d;
}

describe('sfe open (darwin)', () => {
  test('writes a 0600 .webloc in the data dir, opens it with /usr/bin/open, deletes it after 10 s', async () => {
    const dir = dataDir();
    let seenDuringExec: { mode: number; content: string; files: string[] } | null = null;
    const cli = fakeCli({
      argv: ['open', '--data-dir', dir],
      platform: 'darwin',
      responses: { issueLoginCode: LOGIN },
      exec: async (_file, args) => {
        const p = args[0]!;
        seenDuringExec = { mode: statSync(p).mode & 0o777, content: readFileSync(p, 'utf8'), files: readdirSync(dir) };
      },
    });
    expect(await runCli(cli.deps)).toBe(0);
    expect(cli.requests[0]!.socketPath).toBe(join(dir, 'maintenance.sock'));
    expect(cli.requests[0]!.envelope).toEqual({ v: 1, op: 'issueLoginCode', args: {} });
    expect(seenDuringExec).not.toBeNull();
    expect(seenDuringExec!.mode).toBe(0o600);
    expect(seenDuringExec!.content).toContain(`<string>${LOGIN.url}</string>`);
    expect(seenDuringExec!.files).toHaveLength(1);
    expect(cli.sleeps).toEqual([10_000]);
    expect(readdirSync(dir)).toEqual([]);
    expect(cli.stdout()).toContain('已在浏览器中打开管理后台');
    expect(cli.stdout()).not.toContain(CODE);
    expect(cli.stderr()).not.toContain(CODE);
  });

  test('the login code never appears in argv: exec gets exactly [/usr/bin/open, [weblocPath]]', async () => {
    const dir = dataDir();
    const cli = fakeCli({ argv: ['open', '--data-dir', dir], platform: 'darwin', responses: { issueLoginCode: LOGIN } });
    expect(await runCli(cli.deps)).toBe(0);
    expect(cli.execs).toHaveLength(1);
    expect(cli.execs[0]!.file).toBe('/usr/bin/open');
    expect(cli.execs[0]!.args).toEqual([join(dir, `login-${'ab'.repeat(16)}.webloc`)]);
    expect(JSON.stringify(cli.execs)).not.toContain(CODE);
    expect(JSON.stringify(cli.execs)).not.toContain('auth/exchange');
  });

  test('exec failure removes the file and exits 1', async () => {
    const dir = dataDir();
    const cli = fakeCli({
      argv: ['open', '--data-dir', dir],
      responses: { issueLoginCode: LOGIN },
      exec: async () => {
        throw new Error('spawn failed');
      },
    });
    expect(await runCli(cli.deps)).toBe(1);
    expect(readdirSync(dir)).toEqual([]);
    expect(cli.stderr()).toContain('打开管理后台失败');
  });

  test('refuses a data dir that is not 0700 before asking for a login code', async () => {
    const dir = dataDir(0o755);
    const cli = fakeCli({ argv: ['open', '--data-dir', dir], responses: { issueLoginCode: LOGIN } });
    expect(await runCli(cli.deps)).toBe(1);
    expect(cli.requests).toHaveLength(0);
    expect(cli.stderr()).toContain('数据目录权限不是 0700');
  });

  test('missing data dir → 1', async () => {
    const cli = fakeCli({ argv: ['open', '--data-dir', join(tmpdir(), 'sfe-does-not-exist-xyz')] });
    expect(await runCli(cli.deps)).toBe(1);
    expect(cli.requests).toHaveLength(0);
  });

  test('an unexpected login URL is not opened', async () => {
    const dir = dataDir();
    const cli = fakeCli({ argv: ['open', '--data-dir', dir], responses: { issueLoginCode: { url: 'https://evil.example.test/?code=x', expiresAt: 'x' } } });
    expect(await runCli(cli.deps)).toBe(1);
    expect(cli.execs).toHaveLength(0);
    expect(readdirSync(dir)).toEqual([]);
  });

  test('service refusal (HTTP not bound) → 1', async () => {
    const dir = dataDir();
    const cli = fakeCli({ argv: ['open', '--data-dir', dir], responses: { issueLoginCode: apiError('SURGE_UNREACHABLE', '签发登录码失败：网页服务未启动') } });
    expect(await runCli(cli.deps)).toBe(1);
    expect(cli.stderr()).toContain('网页服务未启动');
  });

  test('--json does not print the URL', async () => {
    const dir = dataDir();
    const cli = fakeCli({ argv: ['open', '--json', '--data-dir', dir], responses: { issueLoginCode: LOGIN } });
    expect(await runCli(cli.deps)).toBe(0);
    expect(JSON.parse(cli.stdout())).toEqual({ opened: true, expiresAt: LOGIN.expiresAt });
  });
});

describe('sfe open (non-darwin)', () => {
  test('prints where the URL is without printing the code and does not exec', async () => {
    const dir = dataDir();
    const cli = fakeCli({ argv: ['open', '--data-dir', dir], platform: 'linux', responses: { issueLoginCode: LOGIN } });
    expect(await runCli(cli.deps)).toBe(0);
    expect(cli.execs).toHaveLength(0);
    const file = join(dir, `login-${'ab'.repeat(16)}.webloc`);
    expect(cli.stdout()).toContain(file);
    expect(cli.stdout()).not.toContain(CODE);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});

describe('webloc helpers', () => {
  test('content escapes XML', () => {
    expect(weblocContent('http://127.0.0.1:1/auth/exchange?code=a&b=<c>')).toContain('<string>http://127.0.0.1:1/auth/exchange?code=a&amp;b=&lt;c&gt;</string>');
  });

  test('writeWebloc refuses to overwrite', () => {
    const dir = dataDir();
    writeWebloc(dir, 'cd'.repeat(8), 'http://127.0.0.1:1/x');
    expect(() => writeWebloc(dir, 'cd'.repeat(8), 'http://127.0.0.1:1/x')).toThrow();
  });

  test('cleanupStaleWeblocs removes only old login-*.webloc files', () => {
    const dir = dataDir();
    const old = join(dir, 'login-0011.webloc');
    const fresh = join(dir, 'login-0022.webloc');
    const other = join(dir, 'install.json');
    for (const p of [old, fresh, other]) writeFileSync(p, 'x');
    const past = new Date(Date.now() - 10 * 60_000);
    utimesSync(old, past, past);
    utimesSync(other, past, past);
    expect(cleanupStaleWeblocs(dir, Date.now())).toBe(1);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(other)).toBe(true);
  });
});
