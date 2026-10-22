// P0 的子进程执行器：不经 shell、stdin 启动后立即关闭（6.5 的 surge-cli 遇到不支持的参数会进入交互模式，
// 等 stdin 结束才退出）、可传入完整的子进程环境；--help 输出若是交互模式提示，命令词按空处理。

import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { cliAvailability, helpWords, parseCliHelp } from '../src/surge-access.js';
import { defaultExec } from '../src/system.js';

const BANNER = 'No command is provided, enter interactive mode.\nTips: Use surge-cli --help to show available commands.\nConnected to 127.0.0.1\n> ';

function script(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'sfe-p0-exec-'));
  const path = join(dir, 'child.mjs');
  writeFileSync(path, body);
  return path;
}

afterEach(() => {
  delete process.env.SFE_P0_PARENT;
});

describe('defaultExec', () => {
  it('closes stdin: a child that waits for EOF (interactive mode) finishes at once instead of at the timeout', async () => {
    const path = script(`process.stdout.write(${JSON.stringify(BANNER)});process.stdin.resume();process.stdin.on('end',()=>process.exit(0));`);
    const t0 = Date.now();
    const r = await defaultExec(process.execPath, [path], { timeoutMs: 5_000 });
    expect(Date.now() - t0).toBeLessThan(3_000);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('enter interactive mode');
  });

  it('passes env as the complete child environment; without it the child inherits', async () => {
    process.env.SFE_P0_PARENT = 'from-parent';
    const path = script("process.stdout.write(JSON.stringify({lc:process.env.LC_ALL??null,tz:process.env.TZ??null,parent:process.env.SFE_P0_PARENT??null}))");
    const replaced = await defaultExec(process.execPath, [path], { env: { LC_ALL: 'C', TZ: 'UTC' } });
    expect(JSON.parse(replaced.stdout)).toEqual({ lc: 'C', tz: 'UTC', parent: null });
    const inherited = await defaultExec(process.execPath, [path]);
    expect(JSON.parse(inherited.stdout).parent).toBe('from-parent');
  });

  it('reports the exit code, and -1 when the program cannot be started or is not an absolute path', async () => {
    expect(await defaultExec(process.execPath, [script("process.stderr.write('e');process.exit(4)")])).toMatchObject({ code: 4, stderr: 'e' });
    expect((await defaultExec('/nonexistent/sfe-p0-missing', [])).code).toBe(-1);
    expect(await defaultExec('node', ['-e', "process.stdout.write('ran')"])).toMatchObject({ code: -1, stdout: '' });
  });

  it('tools/p0/src starts child processes only through the shared executor', () => {
    const root = fileURLToPath(new URL('../src/', import.meta.url));
    const found: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts') && /child_process/.test(readFileSync(p, 'utf8'))) found.push(relative(root, p));
      }
    };
    walk(root);
    expect(found).toEqual([]);
  });
});

describe('parseCliHelp', () => {
  it('treats the interactive-mode banner as an empty command list', () => {
    const r = parseCliHelp(BANNER);
    expect(r.interactive).toBe(true);
    expect([...r.words]).toEqual([]);
    expect(cliAvailability('listTempRules', r.words)).toBe('not_in_help');
    expect(cliAvailability('checkProfile', r.words)).toBe('not_in_help');
  });

  it('help text that lists commands and also documents interactive mode is still help', () => {
    for (const note of ['Run without a command to enter interactive mode.', '  -i, --interactive   Enter interactive mode', 'If no command is provided, surge-cli enters interactive mode.']) {
      const help = `Usage: surge-cli [options] <command>\n${note}\n  --raw  machine readable output\n  --check <path>\nCommands:\n  dump policy\n  dump temp-rule\n  external-resource list\n  external-resource update <key>\n  rule temp add <rule>\n  rule temp remove <rule>`;
      const r = parseCliHelp(help);
      expect(r.interactive, note).toBe(false);
      expect(r.words).toEqual(helpWords(help));
      for (const p of ['listTempRules', 'listExternalResources', 'updateExternalResource', 'addTempRule', 'removeTempRule', 'checkProfile', 'listPolicies'] as const) {
        expect(cliAvailability(p, r.words), `${note} ${p}`).toBe('in_help');
      }
    }
  });

  it('banner wording without any listed command is still the banner (words that complete no command do not count)', () => {
    const r = parseCliHelp(`${BANNER}\nUse list or update after connecting.`);
    expect(r.interactive).toBe(true);
    expect([...r.words]).toEqual([]);
  });

  it('reads ordinary help text as before', () => {
    const help = 'Usage: surge-cli [options] <command>\n  --raw  machine readable output\n  --check <path>\nCommands:\n  dump temp-rule\n  external-resource list';
    const r = parseCliHelp(help);
    expect(r.interactive).toBe(false);
    expect(r.words).toEqual(helpWords(help));
    expect(cliAvailability('listTempRules', r.words)).toBe('in_help');
  });
});
