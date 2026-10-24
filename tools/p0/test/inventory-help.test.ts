// inventory 直接执行的 Surge 命令只有帮助：顶层 --help，以及（顶层帮助可用时）CLI_HELP_TOPICS 的逐条 `help <command>`
// （6.9.0 起顶层帮助只列命令组）。顶层帮助是交互模式提示时命令词按空处理（不读逐条帮助、不经 CLI 探测任何原语），
// 给出警告，并保留原文作为证据。
// realpath 只对 /Applications/Surge.app 下的路径返回原值，让签名校验在 Linux 上也能走到 codesign（假的 exec）；
// CLI 原语经假的 execFile 执行（从不启动真实程序），`--raw version` 可按用例返回合成输出，用于版本交叉核对。

import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// 帮助中列出的读原语经服务的 CLI 适配器（execFixed → execFile）探测：换成记录调用、按 ENOENT 失败的假实现，
// 测试机上即使装有 Surge 也不会执行真实的 surge-cli。
const spawned = vi.hoisted(() => [] as Array<{ file: string; args: string[] }>);
/** argv（空格连接）→ 合成的 stdout；没有的 argv 按 ENOENT 失败。 */
const cliStdout = vi.hoisted(() => new Map<string, string>());
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: (file: string, args: readonly string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      spawned.push({ file, args: [...args] });
      const out = cliStdout.get(args.join(' '));
      queueMicrotask(() => (out !== undefined ? cb(null, out, '') : cb(Object.assign(new Error(`spawn ${file} ENOENT`), { code: 'ENOENT' }), '', '')));
      const stdin = { on: () => stdin, end: () => undefined };
      return { stdin };
    },
  };
});

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
const { isAllowedCliArgv } = await import('../src/deps.js');
const { TOPIC_HELP_610, TOP_HELP_610 } = await import('./support/help-610.js');
type ExecFn = import('../src/system.js').ExecFn;
type Report = import('../src/deps.js').RunningInstanceReport;

const CLI = '/Applications/Surge.app/Contents/Applications/surge-cli';
const BANNER = 'No command is provided, enter interactive mode.\nTips: Use surge-cli --help to show available commands.\nConnected to 127.0.0.1\n> ';

function run(helpStdout: string, opts: { topics?: Record<string, string>; instance?: Report } = {}) {
  const calls: Array<{ file: string; args: string[] }> = [];
  const exec: ExecFn = async (file, args) => {
    calls.push({ file, args: [...args] });
    if (file === '/usr/bin/codesign') return { stdout: '', stderr: '', code: 0 };
    if (file === CLI && args.length === 1 && args[0] === '--help') return { stdout: helpStdout, stderr: '', code: 0 };
    if (file === CLI && args[0] === 'help' && opts.topics?.[args.slice(1).join(' ')] !== undefined) return { stdout: opts.topics[args.slice(1).join(' ')]!, stderr: '', code: 0 };
    return { stdout: '', stderr: '', code: -1 };
  };
  const out = createMemoryOutput();
  const base = join(mkdtempSync(join(tmpdir(), 'sfe-p0-help-')), 'p0');
  const deps = {
    out,
    prompt: createScriptedPrompter([], { assumeYes: true }),
    exec,
    home: '/nonexistent-home',
    platform: 'darwin' as const,
    env: {},
    sleep: async () => undefined,
    ...(opts.instance ? { surgeInstance: async () => opts.instance! } : {}),
  };
  return { calls, out, base, go: () => main(['inventory', '--raw-dir', base, '--surge-cli', CLI], deps) };
}

const INSTANCE_6100: Report = {
  result: { ok: true, instance: { pid: 404, startedAt: '2026-10-21T09:00:00.000Z', bundlePath: '/Applications/Surge.app', bundleId: 'com.nssurge.surge-mac', version: '6.10.0', build: '12500' } },
  steps: [],
  cached: false,
};
const versionJson = (over: Record<string, unknown> = {}): string => JSON.stringify({ version: '6.10.0', build: '12500', 'core-version': 6100, 'controller-protocol': 24, ...over });

function runFiles(base: string): { dir: string; inventory: Record<string, unknown> } {
  const [runId] = readdirSync(base).filter((n) => n !== 'latest');
  const dir = join(base, runId!);
  return { dir, inventory: JSON.parse(readFileSync(join(dir, 'inventory.json'), 'utf8')) };
}

describe('inventory --help', () => {
  it('banner instead of help: empty command list, warning, raw output kept, no CLI primitive executed', async () => {
    spawned.length = 0;
    const r = run(BANNER);
    expect(await r.go()).toBe(EXIT.OK);
    const { dir, inventory } = runFiles(r.base);
    expect(r.out.text()).toContain('surge-cli --help 进入了交互模式');
    expect(inventory.cliHelpInteractive).toBe(true);
    expect(Object.values(inventory.cliHelp as Record<string, string>).every((v) => v === 'not_in_help' || v === 'not_in_table' || v === 'forbidden')).toBe(true);
    expect(Object.values((inventory.probes as { cli: Record<string, { status: string }> }).cli).some((o) => o.status === 'ok' || o.status === 'error')).toBe(false);
    expect(readFileSync(join(dir, 'inventory', 'surge-cli-help.txt'), 'utf8')).toContain('No command is provided');
    // 只执行了 --help，没有逐条帮助，也没有任何其他 surge-cli 调用
    expect(r.calls.filter((c) => c.file === CLI)).toEqual([{ file: CLI, args: ['--help'] }]);
    expect(spawned).toEqual([]);
    expect(inventory.cliHelpTopics).toEqual({});
  });

  it('help that lists commands and mentions interactive mode: commands are in help, no warning', async () => {
    const r = run(
      'Usage: surge-cli [options] <command>\nRun without a command to enter interactive mode.\n  --raw  machine readable output\n  --check <path>\nCommands:\n  dump temp-rule\n  external-resource list\n  external-resource update <key>\n  rule temp add <rule>\n  rule temp remove <rule>\n',
    );
    expect(await r.go()).toBe(EXIT.OK);
    const { inventory } = runFiles(r.base);
    expect(r.out.text()).not.toContain('进入了交互模式');
    expect(inventory.cliHelpInteractive).toBe(false);
    expect(inventory.cliHelp).toMatchObject({ listTempRules: 'in_help', listExternalResources: 'in_help', updateExternalResource: 'in_help', addTempRule: 'in_help', checkProfile: 'in_help' });
    // 读原语按帮助经 CLI 探测（假的 execFile 让它们以 ENOENT 失败，但确实尝试了）
    expect(spawned.filter((c) => c.file === CLI).map((c) => c.args)).toEqual(expect.arrayContaining([['--raw', 'dump', 'temp-rule'], ['--raw', 'external-resource', 'list']]));
    expect((inventory.probes as { cli: Record<string, { status: string }> }).cli.listTempRules!.status).toBe('error');
  });

  it('ordinary help without command words: no warning', async () => {
    const r = run('Usage: surge-cli [options] <command>\n');
    expect(await r.go()).toBe(EXIT.OK);
    const { inventory } = runFiles(r.base);
    expect(r.out.text()).not.toContain('交互模式');
    expect(inventory.cliHelpInteractive).toBe(false);
  });

  it('6.10: reads every per-command help, keeps the originals, and the union maps the primitives; only allowlisted read argv run', async () => {
    spawned.length = 0;
    cliStdout.clear();
    const r = run(TOP_HELP_610, { topics: TOPIC_HELP_610 });
    expect(await r.go()).toBe(EXIT.OK);
    const { dir, inventory } = runFiles(r.base);
    // 逐条帮助都执行了，原文保存在 inventory/surge-cli-help/
    const helpCalls = r.calls.filter((c) => c.file === CLI && c.args[0] === 'help').map((c) => c.args.slice(1).join(' '));
    expect(helpCalls.sort()).toEqual(Object.keys(TOPIC_HELP_610).sort());
    expect(Object.values(inventory.cliHelpTopics as Record<string, string>).every((v) => v === 'ok')).toBe(true);
    expect(readFileSync(join(dir, 'inventory', 'surge-cli-help', 'rule-temp.txt'), 'utf8')).toContain('Add a temporary rule with the highest priority');
    const cliHelp = inventory.cliHelp as Record<string, string>;
    for (const p of ['checkProfile', 'getVersion', 'getRuntimeInfo', 'getCurrentProfile', 'getTakeoverState', 'listTempRules', 'listRecentRequests', 'matchRule', 'updateExternalResource', 'addTempRule', 'removeTempRule', 'selectGroupPolicy', 'killRequest']) {
      expect(cliHelp[p], p).toBe('in_help');
    }
    const cliArgvs = spawned.filter((c) => c.file === CLI).map((c) => c.args);
    expect(cliArgvs).toEqual(expect.arrayContaining([['--raw', 'version'], ['--raw', 'dump', 'temp-rule'], ['--raw', 'rule', 'match', 'p0-inventory.invalid', 'process-path=/usr/bin/true', 'protocol=TCP', 'dest-port=443']]));
    // 盘点只执行允许清单中的只读命令：没有任何写命令（update、rule temp add/remove、policy-group set、kill）
    for (const argv of cliArgvs) {
      expect(isAllowedCliArgv(argv), argv.join(' ')).toBe(true);
      expect(argv[0], argv.join(' ')).toBe('--raw');
    }
  });

  it('a per-command help that is unavailable is reported and its words are not used', async () => {
    const topics = { ...TOPIC_HELP_610 };
    delete topics.dump;
    const r = run(TOP_HELP_610, { topics });
    expect(await r.go()).toBe(EXIT.OK);
    const { inventory } = runFiles(r.base);
    expect((inventory.cliHelpTopics as Record<string, string>).dump).toBe('failed');
    expect(r.out.text()).toContain('help dump（失败或没有输出（不采用））');
    expect((inventory.cliHelp as Record<string, string>).listTempRules).toBe('not_in_help');
  });

  it('cross-checks surge-cli --raw version with the running instance (6.10.0 / 12500, Controller protocol ≥ 22)', async () => {
    cliStdout.clear();
    cliStdout.set('--raw version', versionJson());
    const ok = run(TOP_HELP_610, { topics: TOPIC_HELP_610, instance: INSTANCE_6100 });
    expect(await ok.go()).toBe(EXIT.OK);
    const a = runFiles(ok.base);
    expect((a.inventory.summary as Record<string, unknown>).surgeVersionCheck).toEqual({ ok: true, reason: null, controllerProtocol: 24, coreVersion: 6100 });
    expect(ok.out.text()).toContain('通过：6.10.0（12500）· Controller 协议 24 · Core 6100');
    const ev = JSON.parse(readFileSync(join(a.dir, 'inventory', 'surge-version.json'), 'utf8'));
    expect(ev).toMatchObject({ minimum: { version: '6.10.0', build: 12500, controllerProtocol: 22 }, instance: { version: '6.10.0', build: '12500' }, check: { ok: true } });
    // 设备与系统字段从不进入证据
    expect(JSON.stringify(ev)).not.toMatch(/device|system-version/);

    const cases: Array<{ out: string; reason: string; text: string }> = [
      { out: versionJson({ version: '6.10.1', build: '12510' }), reason: 'cli_bundle_mismatch', text: 'surge-cli 报告的 Surge 版本与运行中的 Surge.app 不一致' },
      { out: versionJson({ 'controller-protocol': 21 }), reason: 'surge_version_unsupported', text: 'Surge 版本低于最低支持版本 6.10.0' },
    ];
    for (const c of cases) {
      cliStdout.set('--raw version', c.out);
      const r = run(TOP_HELP_610, { topics: TOPIC_HELP_610, instance: INSTANCE_6100 });
      expect(await r.go()).toBe(EXIT.OK);
      const f = runFiles(r.base);
      expect((f.inventory.summary as Record<string, unknown>).surgeVersionCheck, c.reason).toMatchObject({ ok: false, reason: c.reason });
      expect(r.out.text()).toContain(`版本交叉核对未通过（${c.text}`);
      // 能力上下文不记录版本：依赖版本的能力不能提议
      expect(JSON.parse(readFileSync(join(f.dir, 'results', 'takeover_state_readable.json'), 'utf8')).context).toMatchObject({ surgeVersion: null, surgeBuild: null });
    }
    cliStdout.clear();
  });
});
