// P0 读取运行中的 Surge 实例：instance 命令（只读，逐条打印并写证据）、inventory 的「运行中的 Surge」行与
// inventory/surge-instance.json，以及与服务同一读取器的接线（ps 固定参数与 C/UTC 环境、--surge-team-id 只会更严）。
// node:fs/promises 的 realpath/stat 换成合成结果，模拟测试 Mac 上的 /Applications/Surge.app；从不执行 surge-cli。

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const APP = '/Applications/Surge.app';
const EXE = `${APP}/Contents/MacOS/Surge`;
const PLIST = `${APP}/Contents/Info.plist`;
const START = 'Wed Oct 21 09:00:00 2026';
const START_SEC = Date.UTC(2026, 9, 21, 9, 0, 0) / 1000;

const fsState = vi.hoisted(() => ({ installed: true, ctimeSec: 0 }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    realpath: async (p: string) => {
      const s = String(p);
      if (s === '/Applications/Surge.app' || s.startsWith('/Applications/Surge.app/')) {
        if (!fsState.installed) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return s;
      }
      return actual.realpath(p);
    },
    stat: async (p: string, opts?: { bigint?: boolean }) => {
      const s = String(p);
      if (s === '/Applications/Surge.app/Contents/Info.plist' || s === '/Applications/Surge.app/Contents/MacOS/Surge') {
        const t = BigInt(fsState.ctimeSec) * 1_000_000_000n;
        return { dev: 1n, ino: s.endsWith('/Surge') ? 12n : 11n, size: 100n, mtimeNs: 1n, ctimeNs: t, birthtimeNs: t };
      }
      return actual.stat(p, opts as never);
    },
  };
});

const { main } = await import('../src/cli.js');
const { EXIT } = await import('../src/errors.js');
const { createMemoryOutput, createScriptedPrompter } = await import('../src/io.js');
const { PS_INSTANCE_ARGS, RUNNING_INSTANCE_PS_ENV } = await import('../src/deps.js');
type ExecFn = import('../src/system.js').ExecFn;
type Report = import('../src/deps.js').RunningInstanceReport;

const UID = process.getuid?.() ?? 501;

interface Call {
  file: string;
  args: string[];
  env: NodeJS.ProcessEnv | undefined;
}

function darwinExec(over: { codesign?: number; version?: string; onDisk?: [string, string] } = {}): { exec: ExecFn; calls: Call[] } {
  const calls: Call[] = [];
  const plist: Record<string, string> = { CFBundleIdentifier: 'com.nssurge.surge-mac', CFBundleExecutable: 'Surge', CFBundleShortVersionString: over.version ?? '6.5.0', CFBundleVersion: '10960' };
  const exec: ExecFn = async (file, args, opts) => {
    calls.push({ file, args: [...args], env: opts?.env });
    if (file === '/bin/ps') return { stdout: `  404 ${UID} ${START} ${EXE}\n  88 0 ${START} /Library/PrivilegedHelperTools/com.nssurge.surge-mac.helper\n`, stderr: '', code: 0 };
    if (file === '/usr/bin/plutil') return plist[args[1]!] ? { stdout: `${plist[args[1]!]}\n`, stderr: '', code: 0 } : { stdout: '', stderr: '', code: 1 };
    if (file === '/usr/sbin/lsof') return { stdout: `p404\nftxt\ni12\nn${EXE}\n`, stderr: '', code: 0 };
    if (file === '/usr/bin/codesign') return { stdout: '', stderr: '', code: over.codesign ?? 0 };
    if (file === '/usr/bin/defaults' && args[1] === `${APP}/Contents/Info` && over.onDisk) {
      return { stdout: `${args[2] === 'CFBundleVersion' ? over.onDisk[1] : over.onDisk[0]}\n`, stderr: '', code: 0 };
    }
    return { stdout: '', stderr: '', code: -1 };
  };
  return { exec, calls };
}

function setup(platform: NodeJS.Platform, exec: ExecFn, extra: Record<string, unknown> = {}) {
  const out = createMemoryOutput();
  const base = join(mkdtempSync(join(tmpdir(), 'sfe-p0-instance-')), 'p0');
  const deps = { out, prompt: createScriptedPrompter([], { assumeYes: true }), exec, home: '/nonexistent-home', platform, env: {}, sleep: async () => undefined, ...extra };
  return { out, base, deps };
}

function onlyRun(base: string): string {
  const [runId] = readdirSync(base).filter((n) => n !== 'latest');
  return join(base, runId!);
}

function evidenceFiles(runDir: string): Array<Record<string, unknown>> {
  const dir = join(runDir, 'instance');
  return readdirSync(dir).map((n) => JSON.parse(readFileSync(join(dir, n), 'utf8')) as Record<string, unknown>);
}

describe('p0 instance (read-only)', () => {
  it('on macOS: reads the running instance with the shared reader, prints every rule, writes the evidence and exits 0', async () => {
    fsState.installed = true;
    fsState.ctimeSec = START_SEC - 3600;
    const { exec, calls } = darwinExec();
    const t = setup('darwin', exec);
    expect(await main(['instance', '--raw-dir', t.base], t.deps)).toBe(EXIT.OK);
    const text = t.out.text();
    for (const label of ['进程（V1）', '包信息（V2）', '启动后未修改（V3）', '运行映像（V4）', '签名（V5）', '读取期间未变化']) expect(text).toContain(label);
    expect(text).toContain('运行中的 Surge：6.5.0（10960）· pid 404 · 启动于 2026-10-21T09:00:00.000Z');
    expect(text).toContain('codesign 退出码 0（未提供 Team ID，只做 --verify --strict）');
    // 只执行了四个固定程序（外加磁盘版本的 defaults 旁证），从不执行 surge-cli
    expect(new Set(calls.map((c) => c.file))).toEqual(new Set(['/bin/ps', '/usr/bin/plutil', '/usr/sbin/lsof', '/usr/bin/codesign', '/usr/bin/defaults']));
    const ps = calls.find((c) => c.file === '/bin/ps')!;
    expect(ps.args).toEqual([...PS_INSTANCE_ARGS]);
    expect(ps.env).toEqual(RUNNING_INSTANCE_PS_ENV);
    const [ev] = evidenceFiles(onlyRun(t.base));
    expect(ev).toMatchObject({ result: { ok: true, instance: { version: '6.5.0', build: '10960', pid: 404 } }, cached: false, runningDiffersFromOnDisk: null });
    const steps = ev!.steps as Array<{ rule: string; outcome: string; ms: number; detail: Record<string, unknown> }>;
    expect(steps.map((s) => s.rule)).toEqual(['platform', 'process', 'bundle_executable', 'start_time', 'info_plist', 'not_modified', 'running_image', 'signature', 'stable']);
    expect(steps.every((s) => s.outcome === 'pass' && typeof s.ms === 'number')).toBe(true);
    expect(steps.find((s) => s.rule === 'not_modified')!.detail).toMatchObject({ plist: { ctimeMinusStartMs: -3_600_000 } });
    expect(steps.find((s) => s.rule === 'running_image')!.detail).toMatchObject({ inodeMatch: true, pathMatch: true, sameEntry: true });
    expect(steps.find((s) => s.rule === 'signature')!.detail).toEqual({ code: 0, teamRequirement: false });
  });

  it('--surge-team-id only makes the signature check stricter', async () => {
    fsState.installed = true;
    fsState.ctimeSec = START_SEC - 3600;
    const strict = darwinExec();
    const t = setup('darwin', strict.exec);
    expect(await main(['instance', '--raw-dir', t.base, '--surge-team-id', 'ABCDE12345'], t.deps)).toBe(EXIT.OK);
    expect(strict.calls.find((c) => c.file === '/usr/bin/codesign')!.args).toEqual(['--verify', '--strict', '-R=anchor apple generic and certificate leaf[subject.OU] = "ABCDE12345"', APP]);
    const failing = darwinExec({ codesign: 3 });
    const f = setup('darwin', failing.exec);
    expect(await main(['instance', '--raw-dir', f.base, '--surge-team-id', 'ABCDE12345'], f.deps)).toBe(EXIT.REFUSED);
    expect(f.out.text()).toContain('Surge 包签名校验未通过');
  });

  it('a bundle changed after launch exits 3 with the reason and the time difference in the evidence', async () => {
    fsState.installed = true;
    fsState.ctimeSec = START_SEC + 90;
    const { exec, calls } = darwinExec();
    const t = setup('darwin', exec);
    expect(await main(['instance', '--raw-dir', t.base], t.deps)).toBe(EXIT.REFUSED);
    expect(t.out.text()).toContain('无法确认（Surge 启动后包被更新或修改，请重新打开 Surge）');
    const [ev] = evidenceFiles(onlyRun(t.base));
    expect(ev).toMatchObject({ result: { ok: false, reason: 'modified_after_start' } });
    expect((ev!.steps as Array<{ rule: string; detail: Record<string, unknown> }>).at(-1)).toMatchObject({ rule: 'not_modified', detail: { plist: { ctimeMinusStartMs: 90_000 } } });
    // 失败即停止：没有 lsof 与 codesign
    expect(calls.some((c) => c.file === '/usr/sbin/lsof' || c.file === '/usr/bin/codesign')).toBe(false);
  });

  it('flags a difference between the on-disk Surge.app (defaults read) and the running instance', async () => {
    fsState.installed = true;
    fsState.ctimeSec = START_SEC - 3600;
    const { exec } = darwinExec({ onDisk: ['6.4.9', '10900'] });
    const t = setup('darwin', exec);
    expect(await main(['instance', '--raw-dir', t.base], t.deps)).toBe(EXIT.OK);
    expect(t.out.text()).toContain('磁盘上的 Surge.app（defaults read）是 6.4.9（10900），运行实例读取到 6.5.0（10960）');
    expect(evidenceFiles(onlyRun(t.base))[0]).toMatchObject({ runningDiffersFromOnDisk: true, onDisk: { version: '6.4.9', build: '10900' } });
  });

  it('off macOS nothing is executed for the instance and the command exits 3', async () => {
    const exec = vi.fn<ExecFn>(async () => ({ stdout: '', stderr: '', code: -1 }));
    const t = setup('linux', exec);
    expect(await main(['instance', '--raw-dir', t.base], t.deps)).toBe(EXIT.REFUSED);
    expect(t.out.text()).toContain('不是 macOS，无法读取运行中的 Surge');
    expect(exec.mock.calls.map((c) => c[0])).toEqual(['/usr/bin/defaults', '/usr/bin/defaults']);
  });

  it('uses the latest run when one exists, and an injected reader for offline tests', async () => {
    const report: Report = { result: { ok: false, reason: 'translocated' }, steps: [{ rule: 'bundle_executable', outcome: 'fail', detail: { reason: 'translocated', matching: 0 }, ms: 1 }], cached: false };
    const t = setup('linux', async () => ({ stdout: '', stderr: '', code: -1 }), { surgeInstance: async () => report });
    expect(await main(['instance', '--raw-dir', t.base], t.deps)).toBe(EXIT.REFUSED);
    expect(await main(['instance', '--raw-dir', t.base], t.deps)).toBe(EXIT.REFUSED);
    const runs = readdirSync(t.base).filter((n) => n !== 'latest');
    expect(runs).toHaveLength(1);
    expect(t.out.text()).toContain('App Translocation');
  });
});

function lstartOf(d: Date): string {
  const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const two = (n: number) => String(n).padStart(2, '0');
  const day = d.getUTCDate();
  return `${WD[d.getUTCDay()]} ${MON[d.getUTCMonth()]} ${day < 10 ? ` ${day}` : day} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())} ${d.getUTCFullYear()}`;
}

describe('p0 instance --self-test-bundle (V6, never Surge)', () => {
  async function scratch(startOffsetSec: number) {
    // 先建运行目录，再在其中做临时 App（真实文件与真实 bigint stat；ps/plutil/lsof/codesign 为合成输出）
    const created = setup('linux', async () => ({ stdout: '', stderr: '', code: -1 }));
    await main(['instance', '--raw-dir', created.base], created.deps);
    const runDir = onlyRun(created.base);
    const bundle = join(runDir, 'selftest', 'SFE-P0-Selftest.app');
    mkdirSync(join(bundle, 'Contents', 'MacOS'), { recursive: true });
    writeFileSync(join(bundle, 'Contents', 'Info.plist'), '<plist/>');
    const exePath = join(bundle, 'Contents', 'MacOS', 'selftest');
    writeFileSync(exePath, 'synthetic');
    const ino = statSync(exePath, { bigint: true }).ino;
    const start = new Date(Math.floor(Date.now() / 1000) * 1000 + startOffsetSec * 1000);
    const calls: Call[] = [];
    const plist: Record<string, string> = { CFBundleIdentifier: 'test.sfe.p0.instance-selftest', CFBundleExecutable: 'selftest', CFBundleShortVersionString: '1.0.0', CFBundleVersion: '1' };
    const exec: ExecFn = async (file, args, opts) => {
      calls.push({ file, args: [...args], env: opts?.env });
      if (file === '/bin/ps') return { stdout: `  999 ${UID} ${lstartOf(start)} ${exePath}\n  404 ${UID} ${START} ${EXE}\n`, stderr: '', code: 0 };
      if (file === '/usr/bin/plutil') return { stdout: `${plist[args[1]!]}\n`, stderr: '', code: 0 };
      if (file === '/usr/sbin/lsof') return { stdout: `p999\nftxt\ni${ino}\nn${exePath}\n`, stderr: '', code: 0 };
      if (file === '/usr/bin/codesign') return { stdout: '', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: -1 };
    };
    const t = setup('darwin', exec);
    return { t: { ...t, base: created.base }, bundle, runDir, calls };
  }

  it('a scratch app launched after its files were written passes with the same rules and its own bundle id', async () => {
    const { t, bundle, runDir, calls } = await scratch(120);
    expect(await main(['instance', '--raw-dir', t.base, '--self-test-bundle', bundle], t.deps)).toBe(EXIT.OK);
    expect(t.out.text()).toContain('自测结果：通过（1.0.0（1））');
    expect(calls.find((c) => c.file === '/usr/bin/codesign')!.args).toEqual(['--verify', '--strict', bundle]);
    const ev = JSON.parse(readFileSync(join(runDir, 'instance', readdirSync(join(runDir, 'instance')).find((n) => n.startsWith('selftest-'))!), 'utf8'));
    expect(ev).toMatchObject({ result: { ok: true, instance: { pid: 999, bundleId: 'test.sfe.p0.instance-selftest' } }, selfTest: { bundle } });
  });

  it('files written after the scratch app started → modified_after_start', async () => {
    const { t, bundle } = await scratch(-120);
    expect(await main(['instance', '--raw-dir', t.base, '--self-test-bundle', bundle], t.deps)).toBe(EXIT.REFUSED);
    expect(t.out.text()).toContain('自测结果：modified_after_start');
  });

  it('a bundle outside the run directory (for example Surge itself) is refused', async () => {
    const { t } = await scratch(120);
    expect(await main(['instance', '--raw-dir', t.base, '--self-test-bundle', APP], t.deps)).toBe(EXIT.REFUSED);
    expect(t.out.text()).toContain('自测失败');
    expect(await main(['instance', '--raw-dir', t.base, '--self-test-bundle', 'relative/X.app'], t.deps)).toBe(EXIT.REFUSED);
  });
});

describe('inventory: running Surge instance', () => {
  function inventoryWith(report: Report | null, onDisk: [string, string] | null) {
    const exec: ExecFn = async (file, args) => {
      if (file === '/usr/bin/defaults' && args[1] === `${APP}/Contents/Info` && onDisk) return { stdout: `${args[2] === 'CFBundleVersion' ? onDisk[1] : onDisk[0]}\n`, stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: -1 };
    };
    return setup('linux', exec, report ? { surgeInstance: async () => report } : {});
  }

  const OK: Report = {
    result: { ok: true, instance: { pid: 404, startedAt: '2026-10-21T09:00:00.000Z', bundlePath: APP, bundleId: 'com.nssurge.surge-mac', version: '6.5.0', build: '10960' } },
    steps: [{ rule: 'platform', outcome: 'pass', detail: {}, ms: 0 }],
    cached: false,
  };

  it('the version row and summary come from the running instance; evidence in inventory/surge-instance.json', async () => {
    const t = inventoryWith(OK, ['6.5.0', '10960']);
    expect(await main(['inventory', '--raw-dir', t.base], t.deps)).toBe(EXIT.OK);
    const runDir = onlyRun(t.base);
    const inventory = JSON.parse(readFileSync(join(runDir, 'inventory.json'), 'utf8')) as Record<string, any>;
    expect(inventory.summary.surgeVersion).toEqual({ version: '6.5.0', build: '10960' });
    expect(inventory.summary.surgeInstance).toEqual({ ok: true, reason: null });
    expect(inventory.surgeInstance).toMatchObject({ ok: true, evidence: 'inventory/surge-instance.json' });
    const ev = JSON.parse(readFileSync(join(runDir, 'inventory', 'surge-instance.json'), 'utf8'));
    expect(ev).toMatchObject({ result: OK.result, runningDiffersFromOnDisk: false, onDisk: { version: '6.5.0', build: '10960' } });
    const text = t.out.text();
    expect(text).toContain('运行中的 Surge');
    expect(text).toContain('6.5.0（10960）· pid 404');
    expect(text).toContain('Surge.app（磁盘，旁证）');
    expect(text).not.toContain('Surge getVersion');
    // 能力上下文（takeover_state_readable 的结果）用同一次读取的版本
    expect(JSON.parse(readFileSync(join(runDir, 'results', 'takeover_state_readable.json'), 'utf8')).context).toMatchObject({ surgeVersion: '6.5.0', surgeBuild: '10960' });
  });

  it('an unreadable instance gives a null version with a warning; a different on-disk version is flagged', async () => {
    const t = inventoryWith({ result: { ok: false, reason: 'running_image_mismatch' }, steps: [], cached: false }, ['6.5.0', '10960']);
    expect(await main(['inventory', '--raw-dir', t.base], t.deps)).toBe(EXIT.OK);
    const inventory = JSON.parse(readFileSync(join(onlyRun(t.base), 'inventory.json'), 'utf8')) as Record<string, any>;
    expect(inventory.summary.surgeVersion).toEqual({ version: null, build: null });
    expect(inventory.summary.surgeInstance).toEqual({ ok: false, reason: 'running_image_mismatch' });
    expect(t.out.text()).toContain('无法确认（运行中的 Surge 与磁盘上的包不是同一份，请重新打开 Surge）');
    expect(t.out.text()).toContain('无法确认运行中 Surge 的版本');

    const d = inventoryWith(OK, ['6.6.0', '11000']);
    expect(await main(['inventory', '--raw-dir', d.base], d.deps)).toBe(EXIT.OK);
    expect(d.out.text()).toContain('两者不一致，以运行实例为准');
    expect(JSON.parse(readFileSync(join(onlyRun(d.base), 'inventory', 'surge-instance.json'), 'utf8')).runningDiffersFromOnDisk).toBe(true);
  });
});
