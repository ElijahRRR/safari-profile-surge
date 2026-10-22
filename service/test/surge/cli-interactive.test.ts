// surge-cli 交互模式：6.5.0 (10960) 实测，遇到无法识别的参数（例如 --version）时打印提示并进入交互模式，
// stdin 结束时退出 0，输出中带有 Connected to 127.0.0.1。这些测试证明：提示在退出码分类与解析之前识别为
// SURGE_COMMAND_FAILED（reason interactive_mode），且不回显输出；默认执行器关闭 stdin，不会等到超时。
// 合成数据，假的 surge-cli 只是本地脚本。

import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import type { SfeError } from '@sfe/contract';
import { CLI_COMMANDS } from '../../src/surge/cli-commands.js';
import { INTERACTIVE_BANNER_RE, createCliAdapter, defaultExec, type ExecFn } from '../../src/surge/cli-adapter.js';
import { SURGE_PRIMITIVES, type MechanismMap, type SurgePrimitive } from '../../src/surge/primitives.js';

const CLI = '/Applications/Surge.app/Contents/Applications/surge-cli';
const BANNER = 'No command is provided, enter interactive mode.\nTips: Use surge-cli --help to show available commands.\nConnected to 127.0.0.1\n> ';
const MESSAGE = '执行 Surge 命令失败：命令行工具不支持该命令（进入了交互模式）';
const SAMPLE_ARGS: Record<string, unknown[]> = {
  checkProfile: ['/tmp/sfe-candidate/日常-Safari环境.conf'],
  updateExternalResource: ['policy-path:sfe-nodes.list'],
  addTempRule: ['PROCESS-NAME,/Applications/Safari.app/Contents/MacOS/Safari,REJECT'],
  removeTempRule: ['PROCESS-NAME,/Applications/Safari.app/Contents/MacOS/Safari,REJECT'],
};
const allCli: MechanismMap = Object.fromEntries(SURGE_PRIMITIVES.map((p) => [p, 'cli']));
const CLI_PRIMITIVES = Object.keys(CLI_COMMANDS) as SurgePrimitive[];

function adapter(exec: ExecFn, scrub: (s: string) => string = (s) => s) {
  return createCliAdapter({ cliPath: CLI, mechanism: allCli, exec, scrub });
}

function invoke(a: ReturnType<typeof adapter>, p: SurgePrimitive): Promise<unknown> {
  return (a[p] as (...x: unknown[]) => Promise<unknown>)(...(SAMPLE_ARGS[p] ?? []));
}

async function failure(promise: Promise<unknown>): Promise<SfeError> {
  const e = await promise.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e, '应当失败').not.toBeNull();
  return e as SfeError;
}

function expectInteractive(err: SfeError, primitive: SurgePrimitive): void {
  expect(err).toMatchObject({ code: 'SURGE_COMMAND_FAILED', message: MESSAGE, details: { primitive, reason: 'interactive_mode' } });
  expect(JSON.stringify(err.details)).not.toContain('127.0.0.1');
  expect(err.message).not.toContain('127.0.0.1');
}

describe('interactive banner is never a result', () => {
  test('the pattern matches the observed 6.5 banner and close variants, not ordinary output', () => {
    expect(INTERACTIVE_BANNER_RE.test(BANNER)).toBe(true);
    expect(INTERACTIVE_BANNER_RE.test('Entering interactive mode')).toBe(true);
    expect(INTERACTIVE_BANNER_RE.test('enter  INTERACTIVE\tmode')).toBe(true);
    expect(INTERACTIVE_BANNER_RE.test('{"defines":[]}')).toBe(false);
    expect(INTERACTIVE_BANNER_RE.test('["DOMAIN,a.example.test,REJECT"]')).toBe(false);
    expect(INTERACTIVE_BANNER_RE.test('Profile check passed')).toBe(false);
  });

  test.each(CLI_PRIMITIVES)('%s: exit 0 with the banner is SURGE_COMMAND_FAILED (interactive_mode) without echoing output', async (p) => {
    const scrub = vi.fn((s: string) => s);
    const err = await failure(invoke(adapter(async () => ({ stdout: BANNER, stderr: '' }), scrub), p));
    expectInteractive(err, p);
    // 输出从不进入错误信息，所以也不需要脱敏
    expect(scrub).not.toHaveBeenCalled();
  });

  test('--check: a banner with exit 0 is not a passed check, and a banner with a non-zero exit is not a failed check result', async () => {
    expectInteractive(await failure(adapter(async () => ({ stdout: BANNER, stderr: '' })).checkProfile('/tmp/c.conf')), 'checkProfile');
    const nonzero: ExecFn = async () => Promise.reject(Object.assign(new Error('x'), { code: 1, stdout: BANNER, stderr: '' }));
    expectInteractive(await failure(adapter(nonzero).checkProfile('/tmp/c.conf')), 'checkProfile');
  });

  test('banner only on stderr with exit 0 is still detected', async () => {
    expectInteractive(await failure(adapter(async () => ({ stdout: '[]', stderr: BANNER })).listTempRules()), 'listTempRules');
  });

  test('banner on stderr with a non-zero exit is an unsupported command, not unreachable, even next to connection-failure text', async () => {
    const exec: ExecFn = async () => Promise.reject(Object.assign(new Error('x'), { code: 1, stdout: '', stderr: `${BANNER}\nCould not connect to Surge` }));
    expectInteractive(await failure(adapter(exec).listExternalResources()), 'listExternalResources');
  });

  test('banner before a kill (timeout) or an output overflow is detected before those classifications', async () => {
    const killed: ExecFn = async () => Promise.reject(Object.assign(new Error('x'), { killed: true, signal: 'SIGTERM', code: null, stdout: BANNER, stderr: '' }));
    const overflow: ExecFn = async () => Promise.reject(Object.assign(new Error('x'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', stdout: BANNER, stderr: '' }));
    expectInteractive(await failure(adapter(killed).addTempRule(SAMPLE_ARGS.addTempRule![0] as string)), 'addTempRule');
    expectInteractive(await failure(adapter(overflow).updateExternalResource('policy-path:sfe-nodes.list')), 'updateExternalResource');
  });

  test('without the banner the existing classification is unchanged', async () => {
    const killed: ExecFn = async () => Promise.reject(Object.assign(new Error('x'), { killed: true, signal: 'SIGTERM', code: null, stdout: '', stderr: '' }));
    await expect(adapter(killed).listTempRules()).rejects.toMatchObject({ code: 'SURGE_UNREACHABLE', message: '连接 Surge 失败：命令超时' });
    await expect(adapter(async () => ({ stdout: '[]', stderr: '' })).listTempRules()).resolves.toEqual([]);
    const failedCheck: ExecFn = async () => Promise.reject(Object.assign(new Error('x'), { code: 1, stdout: 'Line 3: invalid', stderr: '' }));
    await expect(adapter(failedCheck).checkProfile('/tmp/c.conf')).resolves.toMatchObject({ ok: false });
  });
});

describe('exit 0 with connection-failure text is never a result', () => {
  const COULD_NOT = 'Could not connect to Surge\n';

  test.each(CLI_PRIMITIVES)('%s: exit 0, empty stdout and "Could not connect" on stderr is SURGE_UNREACHABLE', async (p) => {
    const err = await failure(invoke(adapter(async () => ({ stdout: '', stderr: COULD_NOT })), p));
    expect(err).toMatchObject({ code: 'SURGE_UNREACHABLE', message: '连接 Surge 失败：Could not connect to Surge' });
  });

  test('--check: exit 0 with the text on stderr or as plain stdout is not a passed check', async () => {
    await expect(adapter(async () => ({ stdout: '', stderr: COULD_NOT })).checkProfile('/tmp/c.conf')).rejects.toMatchObject({ code: 'SURGE_UNREACHABLE' });
    await expect(adapter(async () => ({ stdout: 'Surge is not running', stderr: '' })).checkProfile('/tmp/c.conf')).rejects.toMatchObject({ code: 'SURGE_UNREACHABLE' });
    // 没有这些文字的退出 0 仍是通过
    await expect(adapter(async () => ({ stdout: 'Profile check passed', stderr: '' })).checkProfile('/tmp/c.conf')).resolves.toMatchObject({ ok: true });
  });

  test('write commands: exit 0 with the text is not a successful write', async () => {
    await expect(adapter(async () => ({ stdout: '无法连接 Surge', stderr: '' })).updateExternalResource('policy-path:sfe-nodes.list')).rejects.toMatchObject({ code: 'SURGE_UNREACHABLE' });
    await expect(adapter(async () => ({ stdout: '', stderr: 'connect ECONNREFUSED 127.0.0.1:6171' })).addTempRule(SAMPLE_ARGS.addTempRule![0] as string)).rejects.toMatchObject({ code: 'SURGE_UNREACHABLE' });
  });

  test('the text inside a JSON result on stdout is data, not a connection failure', async () => {
    const stdout = JSON.stringify(['DOMAIN,not running.example.test,REJECT']);
    await expect(adapter(async () => ({ stdout, stderr: '' })).listTempRules()).resolves.toEqual(['DOMAIN,not running.example.test,REJECT']);
  });

  test('the echoed text is scrubbed and truncated like other errors', async () => {
    const stderr = `Could not connect: password=exampleP0 ${'x'.repeat(500)}`;
    const scrub = (s: string) => s.replace(/exampleP0/g, '***');
    const err = await failure(adapter(async () => ({ stdout: '', stderr }), scrub).listTempRules());
    expect(err.code).toBe('SURGE_UNREACHABLE');
    expect(err.message).not.toContain('exampleP0');
    expect(err.message.length).toBeLessThan(400);
  });
});

describe('CLI argv shape', () => {
  test('every command names a subcommand (only --check is a bare flag) and never asks for --version', () => {
    const BARE_FLAG_COMMANDS = new Set(['--check']);
    for (const p of CLI_PRIMITIVES) {
      const cmd = CLI_COMMANDS[p] as { argv: (...a: unknown[]) => string[] };
      const argv = cmd.argv(...(SAMPLE_ARGS[p] ?? []));
      const args = SAMPLE_ARGS[p] ?? [];
      const words = argv.filter((w) => !args.includes(w));
      const flags = words.filter((w) => w.startsWith('-'));
      const verbs = words.filter((w) => !w.startsWith('-'));
      expect(argv, p).not.toContain('--version');
      expect(argv, p).not.toContain('-v');
      if (flags.some((f) => BARE_FLAG_COMMANDS.has(f))) {
        expect(flags, p).toEqual(['--check']);
      } else {
        expect(verbs.length, `${p}: ${argv.join(' ')}`).toBeGreaterThan(0);
        expect(flags.every((f) => f === '--raw'), `${p}: ${argv.join(' ')}`).toBe(true);
      }
    }
  });
});

describe('defaultExec closes stdin', () => {
  // 模拟 6.5 的交互模式：打印提示后一直读 stdin，直到 EOF 才退出 0。stdin 不关闭时只能等到超时。
  function interactiveCli(): string {
    const dir = mkdtempSync(join(tmpdir(), 'sfe-cli-interactive-'));
    const path = join(dir, 'surge-cli');
    writeFileSync(path, `#!/bin/sh\nprintf '%s' 'No command is provided, enter interactive mode.\nConnected to 127.0.0.1\n> '\nwhile IFS= read -r line; do printf '> '; done\nexit 0\n`);
    chmodSync(path, 0o700);
    return path;
  }

  test('a child that waits for EOF exits immediately instead of running into the timeout', async () => {
    const t0 = Date.now();
    const r = await defaultExec(interactiveCli(), ['--version'], { timeout: 5_000, maxBuffer: 1 << 20 });
    expect(Date.now() - t0).toBeLessThan(3_000);
    expect(r.stdout).toContain('enter interactive mode');
  });

  test('through the adapter the result is interactive_mode, not a timeout reported as unreachable', async () => {
    const a = createCliAdapter({ cliPath: interactiveCli(), mechanism: { addTempRule: 'cli' }, exec: defaultExec, timeoutMs: 5_000, scrub: (s) => s });
    const t0 = Date.now();
    expectInteractive(await failure(a.addTempRule('DOMAIN,a.example.test,REJECT')), 'addTempRule');
    expect(Date.now() - t0).toBeLessThan(3_000);
  });
});
