// 各子进程调用点都经 execFixed：不经 shell、固定可执行文件、stdin 在启动后立即关闭。
// node:child_process 的 execFile 换成记录调用的假实现，不启动任何真实程序。

import { describe, expect, test, vi } from 'vitest';

interface Rec {
  file: string;
  args: string[];
  opts: Record<string, unknown>;
  stdinEnded: boolean;
  stdinErrorHandled: boolean;
}

const state = vi.hoisted(() => ({ calls: [] as Rec[], readerOptions: [] as unknown[] }));

// 记录服务创建运行实例读取器时的选项（实现不变）
vi.mock('../../src/surge/running-instance.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/surge/running-instance.js')>();
  return {
    ...actual,
    createDefaultSurgeInstanceReader: (opts: Parameters<typeof actual.createDefaultSurgeInstanceReader>[0]) => {
      state.readerOptions.push(opts);
      return actual.createDefaultSurgeInstanceReader(opts);
    },
  };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: (file: string, args: readonly string[], opts: Record<string, unknown>, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      const rec: Rec = { file, args: [...args], opts, stdinEnded: false, stdinErrorHandled: false };
      state.calls.push(rec);
      const stdin = {
        on(event: string) {
          if (event === 'error') rec.stdinErrorHandled = true;
          return stdin;
        },
        end() {
          rec.stdinEnded = true;
        },
      };
      queueMicrotask(() => cb(null, 'ok\n', ''));
      return { stdin };
    },
  };
});

const { defaultCodesignRunner, defaultExec } = await import('../../src/surge/cli-adapter.js');
const { defaultDeps } = await import('../../src/cli/sfe.js');
const { defaultRunningInstanceExec, PS_INSTANCE_ARGS, RUNNING_INSTANCE_PS_ENV, SERVICE_CODESIGN_TIMEOUT_MS } = await import('../../src/surge/running-instance.js');
const { macHost } = await import('../../src/main.js');

function last(): Rec {
  const r = state.calls.at(-1);
  expect(r).toBeDefined();
  return r!;
}

function expectClosedStdin(r: Rec, file: string): void {
  expect(r.file).toBe(file);
  expect(r.opts).toMatchObject({ shell: false });
  expect(r.stdinErrorHandled).toBe(true);
  expect(r.stdinEnded).toBe(true);
}

describe('child process call sites close stdin', () => {
  test('surge-cli executor', async () => {
    const cli = '/Applications/Surge.app/Contents/Applications/surge-cli';
    await expect(defaultExec(cli, ['--raw', 'dump', 'temp-rule'], { timeout: 15_000, maxBuffer: 1 << 20 })).resolves.toEqual({ stdout: 'ok\n', stderr: '' });
    expectClosedStdin(last(), cli);
    expect(last().args).toEqual(['--raw', 'dump', 'temp-rule']);
    expect(last().opts).toMatchObject({ timeout: 15_000, maxBuffer: 1 << 20 });
  });

  test('codesign runner', async () => {
    await expect(defaultCodesignRunner(['--verify', '--strict', '/Applications/Surge.app'])).resolves.toEqual({ code: 0, stderr: '' });
    expectClosedStdin(last(), '/usr/bin/codesign');
    expect(last().opts).toMatchObject({ timeout: 30_000 });
  });

  test('sfe open', async () => {
    await defaultDeps([]).exec('/usr/bin/open', ['http://127.0.0.1:1/']);
    expectClosedStdin(last(), '/usr/bin/open');
  });

  test('running-instance executor (ps, plutil, lsof, codesign)', async () => {
    await expect(defaultRunningInstanceExec('/usr/sbin/lsof', ['-nP'], { timeoutMs: 10_000 })).resolves.toEqual({ stdout: 'ok\n', stderr: '', code: 0 });
    expectClosedStdin(last(), '/usr/sbin/lsof');
    expect(last().opts).toMatchObject({ timeout: 10_000 });
    expect(last().opts.env).toBeUndefined();
  });

  test('service host: the darwin running-instance reader runs ps with the fixed argv and C/UTC environment, stdin closed', async () => {
    const host = macHost('darwin');
    const n = state.calls.length;
    // 合成的 ps 输出里没有 Surge 进程：只执行了 ps
    await expect(host.surgeInstance!()).resolves.toEqual({ ok: false, reason: 'not_running' });
    const calls = state.calls.slice(n);
    expect(calls).toHaveLength(1);
    expectClosedStdin(calls[0]!, '/bin/ps');
    expect(calls[0]!.args).toEqual([...PS_INSTANCE_ARGS]);
    expect(calls[0]!.opts.env).toEqual(RUNNING_INSTANCE_PS_ENV);
  });

  test('service host: the darwin reader uses the shorter service codesign timeout and no Team ID', () => {
    const n = state.readerOptions.length;
    macHost('darwin');
    expect(state.readerOptions.slice(n)).toEqual([expect.objectContaining({ platform: 'darwin', teamId: null, codesignTimeoutMs: SERVICE_CODESIGN_TIMEOUT_MS })]);
  });

  test('service host off macOS: no child process for the running instance', async () => {
    const n = state.calls.length;
    await expect(macHost('linux').surgeInstance!()).resolves.toEqual({ ok: false, reason: 'not_darwin' });
    expect(state.calls.length).toBe(n);
  });

  test('service host: the supplemental version (Background Security Improvement) runs sw_vers -productVersionExtra, stdin closed', async () => {
    const n = state.calls.length;
    await expect(macHost('darwin').macosVersionExtra!()).resolves.toBe('ok');
    const calls = state.calls.slice(n);
    expect(calls).toHaveLength(1);
    expectClosedStdin(calls[0]!, '/usr/bin/sw_vers');
    expect(calls[0]!.args).toEqual(['-productVersionExtra']);
  });

  test('service host: the restart-pending check only looks at the staged cryptex path (no child process)', async () => {
    const n = state.calls.length;
    expect(['yes', 'no', null]).toContain(await macHost('darwin').macosRestartPending!());
    expect(state.calls.length).toBe(n);
  });

  test('service host off macOS: the Background Security Improvement facts are "unknown" without a child process', async () => {
    const n = state.calls.length;
    const host = macHost('linux');
    await expect(host.macosVersionExtra!()).resolves.toBe('unknown');
    await expect(host.macosRestartPending!()).resolves.toBe('unknown');
    expect(state.calls.length).toBe(n);
  });
});
