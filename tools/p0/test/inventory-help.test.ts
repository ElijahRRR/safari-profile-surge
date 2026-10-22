// inventory 中唯一直接执行的 Surge 命令是 --help。6.5 遇到无法识别的参数会打印交互模式提示：
// 此时命令词按空处理（不经 CLI 探测任何原语），给出警告，并保留原文作为证据。
// realpath 只对 /Applications/Surge.app 下的路径返回原值，让签名校验在 Linux 上也能走到 codesign（假的 exec）；
// 交互模式下不会执行任何 CLI 原语，所以不会启动真实程序。

import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    realpath: async (p: string) => (String(p).startsWith('/Applications/Surge.app/') ? String(p) : actual.realpath(p)),
  };
});

const { main } = await import('../src/cli.js');
const { EXIT } = await import('../src/errors.js');
const { createMemoryOutput, createScriptedPrompter } = await import('../src/io.js');
type ExecFn = import('../src/system.js').ExecFn;

const CLI = '/Applications/Surge.app/Contents/Applications/surge-cli';
const BANNER = 'No command is provided, enter interactive mode.\nTips: Use surge-cli --help to show available commands.\nConnected to 127.0.0.1\n> ';

function run(helpStdout: string) {
  const calls: Array<{ file: string; args: string[] }> = [];
  const exec: ExecFn = async (file, args) => {
    calls.push({ file, args: [...args] });
    if (file === '/usr/bin/codesign') return { stdout: '', stderr: '', code: 0 };
    if (file === CLI && args.length === 1 && args[0] === '--help') return { stdout: helpStdout, stderr: '', code: 0 };
    return { stdout: '', stderr: '', code: -1 };
  };
  const out = createMemoryOutput();
  const base = join(mkdtempSync(join(tmpdir(), 'sfe-p0-help-')), 'p0');
  const deps = { out, prompt: createScriptedPrompter([], { assumeYes: true }), exec, home: '/nonexistent-home', platform: 'darwin' as const, env: {}, sleep: async () => undefined };
  return { calls, out, base, go: () => main(['inventory', '--raw-dir', base, '--surge-cli', CLI], deps) };
}

function runFiles(base: string): { dir: string; inventory: Record<string, unknown> } {
  const [runId] = readdirSync(base).filter((n) => n !== 'latest');
  const dir = join(base, runId!);
  return { dir, inventory: JSON.parse(readFileSync(join(dir, 'inventory.json'), 'utf8')) };
}

describe('inventory --help', () => {
  it('banner instead of help: empty command list, warning, raw output kept, no CLI primitive executed', async () => {
    const r = run(BANNER);
    expect(await r.go()).toBe(EXIT.OK);
    const { dir, inventory } = runFiles(r.base);
    expect(r.out.text()).toContain('surge-cli --help 进入了交互模式');
    expect(inventory.cliHelpInteractive).toBe(true);
    expect(Object.values(inventory.cliHelp as Record<string, string>).every((v) => v === 'not_in_help' || v === 'not_in_table' || v === 'forbidden')).toBe(true);
    expect(Object.values((inventory.probes as { cli: Record<string, { status: string }> }).cli).some((o) => o.status === 'ok' || o.status === 'error')).toBe(false);
    expect(readFileSync(join(dir, 'inventory', 'surge-cli-help.txt'), 'utf8')).toContain('No command is provided');
    // 只执行了 --help，没有任何其他 surge-cli 调用
    expect(r.calls.filter((c) => c.file === CLI)).toEqual([{ file: CLI, args: ['--help'] }]);
  });

  it('ordinary help without command words: no warning', async () => {
    const r = run('Usage: surge-cli [options] <command>\n');
    expect(await r.go()).toBe(EXIT.OK);
    const { inventory } = runFiles(r.base);
    expect(r.out.text()).not.toContain('交互模式');
    expect(inventory.cliHelpInteractive).toBe(false);
  });
});
