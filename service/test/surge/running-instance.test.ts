// 运行中 Surge 实例的版本读取（surge/running-instance.ts）：只用合成的 ps/plutil/lsof/codesign 输出与 stat 结果，
// 证明每条规则失败即关闭、子进程只有四个固定程序、离开 macOS 什么都不执行。不证明真实 macOS 的输出格式
// （那由 P0-RUNBOOK 的 V1–V8 在测试 Mac 上核对）。

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import {
  PS_INSTANCE_ARGS,
  RUNNING_INSTANCE_BINARIES,
  RUNNING_INSTANCE_CODESIGN_TIMEOUT_MS,
  RUNNING_INSTANCE_FAILURES,
  RUNNING_INSTANCE_FAILURE_TEXT,
  RUNNING_INSTANCE_PS_ENV,
  SERVICE_CODESIGN_TIMEOUT_MS,
  SURGE_APP_BUNDLE,
  SURGE_BUNDLE_IDS,
  bundleOfMainExecutable,
  createDefaultSurgeInstanceReader,
  createRunningInstanceReader,
  defaultRunningInstanceExec,
  parseLsofTxt,
  parseLstartUtc,
  parsePsInstanceLines,
  predatesStart,
  type RunningInstanceDeps,
  type RunningInstanceExec,
  type RunningInstanceFileId,
  type RunningInstanceOptions,
} from '../../src/surge/running-instance.js';

const APP = '/Applications/Surge.app';
const EXE = `${APP}/Contents/MacOS/Surge`;
const PLIST = `${APP}/Contents/Info.plist`;
const START = 'Wed Oct 21 09:00:00 2026';
const START_SEC = Date.UTC(2026, 9, 21, 9, 0, 0) / 1000;
const UID = 501;
const NS = 1_000_000_000n;

const fid = (ino: bigint, ctimeSec: number, extra: Partial<RunningInstanceFileId> = {}): RunningInstanceFileId => ({
  dev: 16777234n,
  ino,
  size: 1000n,
  // 很早的 mtime：解包、ditto、cp -p 会保留归档中的旧 mtime，所以 mtime 不能作为判断依据
  mtimeNs: 1_600_000_000n * NS,
  ctimeNs: BigInt(ctimeSec) * NS,
  birthtimeNs: BigInt(ctimeSec) * NS,
  ...extra,
});

interface World {
  ps: string;
  psCode: number;
  /** 每个键的值序列（依次返回，最后一个重复）；undefined 表示读不到。 */
  plist: Record<string, Array<string | undefined>>;
  files: Record<string, RunningInstanceFileId[]>;
  lsof: string;
  lsofCode: number;
  codesign: number[];
  realpaths: Record<string, string | null>;
}

function psLines(...lines: string[]): string {
  return lines.join('\n');
}

function world(over: Partial<World> = {}): World {
  return {
    ps: psLines(
      `    1     0 Wed Oct 21 08:00:00 2026     /sbin/launchd`,
      `   88     0 Wed Oct 21 08:00:01 2026     /Library/PrivilegedHelperTools/com.nssurge.surge-mac.helper`,
      `  404   ${UID} ${START}     ${EXE}`,
      `  405   ${UID} Wed Oct 21 09:00:02 2026     ${APP}/Contents/Applications/surge-cli`,
      `  406   ${UID} Wed Oct 21 09:00:03 2026     ${APP}/Contents/Library/LoginItems/Surge Helper.app/Contents/MacOS/Surge Helper`,
      `  500   ${UID} Wed Oct 21 09:10:00 2026     /Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
      `  777   502 Wed Oct 21 09:20:00 2026     ${EXE}`,
    ),
    psCode: 0,
    plist: {
      CFBundleIdentifier: ['com.nssurge.surge-mac'],
      CFBundleExecutable: ['Surge'],
      CFBundleShortVersionString: ['6.5.0'],
      CFBundleVersion: ['10960'],
    },
    files: { [PLIST]: [fid(11n, START_SEC - 3600)], [EXE]: [fid(12n, START_SEC - 3600)] },
    lsof: `p404\nftxt\ni12\nn${EXE}\nftxt\ni99\nn/usr/lib/dyld\n`,
    lsofCode: 0,
    codesign: [0],
    realpaths: {},
    ...over,
  };
}

function plistOf(values: Partial<Record<'CFBundleIdentifier' | 'CFBundleExecutable' | 'CFBundleShortVersionString' | 'CFBundleVersion', string | undefined>>): World['plist'] {
  const base = world().plist;
  return Object.fromEntries(Object.entries({ ...Object.fromEntries(Object.entries(base).map(([k, v]) => [k, v[0]])), ...values }).map(([k, v]) => [k, [v]]));
}

type MockDeps = RunningInstanceDeps & { exec: ReturnType<typeof vi.fn<RunningInstanceExec>>; statCalls: string[]; realpathCalls: string[] };

function deps(w: World, platform: NodeJS.Platform = 'darwin'): MockDeps {
  const statCount: Record<string, number> = {};
  const plistCount: Record<string, number> = {};
  const statCalls: string[] = [];
  const realpathCalls: string[] = [];
  const exec = vi.fn<RunningInstanceExec>(async (file, args) => {
    if (file === '/bin/ps') return { stdout: w.ps, stderr: '', code: w.psCode };
    if (file === '/usr/bin/plutil') {
      const key = args[1]!;
      const seq = w.plist[key] ?? [undefined];
      const n = plistCount[key] ?? 0;
      plistCount[key] = n + 1;
      const v = seq[Math.min(n, seq.length - 1)];
      return v === undefined ? { stdout: '', stderr: 'No value at that key path', code: 1 } : { stdout: `${v}\n`, stderr: '', code: 0 };
    }
    if (file === '/usr/sbin/lsof') return { stdout: w.lsof, stderr: '', code: w.lsofCode };
    if (file === '/usr/bin/codesign') return { stdout: '', stderr: '', code: w.codesign.length > 1 ? w.codesign.shift()! : w.codesign[0]! };
    throw new Error(`unexpected ${file}`);
  });
  return {
    platform,
    uid: UID,
    exec,
    statCalls,
    realpathCalls,
    clock: () => 0,
    realpath: async (p) => {
      realpathCalls.push(p);
      if (Object.prototype.hasOwnProperty.call(w.realpaths, p)) {
        const r = w.realpaths[p];
        if (r === null || r === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return r;
      }
      if (p.startsWith('/Applications/') || p.startsWith('/Users/') || p.startsWith('/Volumes/') || p.includes('/AppTranslocation/')) return p;
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
    stat: async (p) => {
      statCalls.push(p);
      const seq = w.files[p];
      if (!seq) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      const n = statCount[p] ?? 0;
      statCount[p] = n + 1;
      return seq[Math.min(n, seq.length - 1)]!;
    },
  };
}

const OPTS: RunningInstanceOptions = { teamId: null };
const read = (w: World, opts: RunningInstanceOptions = OPTS) => createRunningInstanceReader(deps(w), opts).read();
const OK_INSTANCE = { pid: 404, startedAt: '2026-10-21T09:00:00.000Z', bundlePath: APP, bundleId: 'com.nssurge.surge-mac', version: '6.5.0', build: '10960' };

function callsTo(d: MockDeps, file: string): string[][] {
  return d.exec.mock.calls.filter((c) => c[0] === file).map((c) => [...c[1]]);
}

describe('parsing', () => {
  test('lstart in the C locale and UTC, including space-padded days', () => {
    expect(parseLstartUtc(START)).toBe(START_SEC);
    expect(parseLstartUtc('Thu Oct  1 09:00:00 2026')).toBe(Date.UTC(2026, 9, 1, 9) / 1000);
    expect(parseLstartUtc('Sat Feb 28 23:59:59 2026')).toBe(Date.UTC(2026, 1, 28, 23, 59, 59) / 1000);
  });

  test.each([
    ['a localised value', '2026年10月21日 星期三 09时00分00秒'],
    ['a numeric date', '21/10/2026 09:00'],
    ['an impossible date', 'Tue Feb 31 09:00:00 2026'],
    ['a weekday that does not match the date', 'Thu Oct 21 09:00:00 2026'],
    ['a day that is not space-padded', 'Thu Oct 1 09:00:00 2026'],
    ['an extra space before a two-digit day', 'Wed Oct  21 09:00:00 2026'],
    ['hour 24', 'Wed Oct 21 24:00:00 2026'],
    ['trailing text', `${START} UTC`],
    ['empty', ''],
  ])('rejects %s', (_name, text) => {
    expect(parseLstartUtc(text)).toBeNull();
  });

  test('ps lines keep paths with spaces, mark unparseable start times and skip non-path commands', () => {
    const lines = parsePsInstanceLines(
      psLines(
        `  500 501 Wed Oct 21 09:10:00 2026     /Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
        `  404 501 21/10/2026 09:00     ${EXE}`,
        `   99   0 Wed Oct 21 08:00:00 2026     (kernel_task)`,
        `  406 501 Thu Oct  1 09:00:03 2026     /Applications/A b/Surge.app/Contents/MacOS/Surge  `,
      ),
    );
    expect(lines).toEqual([
      { pid: 500, uid: 501, startSec: Date.UTC(2026, 9, 21, 9, 10) / 1000, path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
      { pid: 404, uid: 501, startSec: null, path: EXE },
      { pid: 406, uid: 501, startSec: Date.UTC(2026, 9, 1, 9, 0, 3) / 1000, path: '/Applications/A b/Surge.app/Contents/MacOS/Surge' },
    ]);
  });

  test('main executable paths: nested apps resolve to their own bundle; surge-cli and helpers are not main executables', () => {
    expect(bundleOfMainExecutable(EXE)).toEqual({ bundle: APP, exe: 'Surge' });
    expect(bundleOfMainExecutable(`${APP}/Contents/Library/LoginItems/H.app/Contents/MacOS/H`)).toEqual({ bundle: `${APP}/Contents/Library/LoginItems/H.app`, exe: 'H' });
    expect(bundleOfMainExecutable(`${APP}/Contents/Applications/surge-cli`)).toBeNull();
    expect(bundleOfMainExecutable('/Library/PrivilegedHelperTools/com.nssurge.surge-mac.helper')).toBeNull();
  });

  test('lsof field output', () => {
    expect(parseLsofTxt(`p404\nftxt\ni12\nn${EXE}\nftxt\nn/no/inode\nftxt\ni13\nf5\nn/not/txt/after/reset\n`)).toEqual([{ inode: 12n, name: EXE }]);
    expect(parseLsofTxt('')).toEqual([]);
  });

  test('every failure reason has Chinese text', () => {
    for (const r of RUNNING_INSTANCE_FAILURES) expect(RUNNING_INSTANCE_FAILURE_TEXT[r]).toMatch(/[一-鿿]/);
  });
});

describe('running Surge instance', () => {
  test('accepts the single main process of /Applications/Surge.app and reads its Info.plist with fixed binaries', async () => {
    const d = deps(world());
    const r = await createRunningInstanceReader(d, OPTS).read();
    expect(r).toEqual({ ok: true, instance: OK_INSTANCE });
    const ps = d.exec.mock.calls.find((c) => c[0] === '/bin/ps')!;
    expect(ps[1]).toEqual(['-ww', '-axo', 'pid=,uid=,lstart=,comm=']);
    expect(ps[2].env).toEqual({ LC_ALL: 'C', LANG: 'C', TZ: 'UTC', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' });
    expect(PS_INSTANCE_ARGS).toEqual(['-ww', '-axo', 'pid=,uid=,lstart=,comm=']);
    expect(RUNNING_INSTANCE_PS_ENV).toMatchObject({ LC_ALL: 'C', TZ: 'UTC' });
    for (const [file] of d.exec.mock.calls) expect(Object.values(RUNNING_INSTANCE_BINARIES)).toContain(file);
    expect(callsTo(d, '/usr/bin/plutil')).toContainEqual(['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', PLIST]);
    expect(callsTo(d, '/usr/sbin/lsof')).toEqual([['-nP', '-a', '-p', '404', '-d', 'txt', '-F', 'in']]);
    expect(callsTo(d, '/usr/bin/codesign')).toEqual([['--verify', '--strict', APP]]);
    expect(SURGE_APP_BUNDLE).toBe(APP);
    expect(SURGE_BUNDLE_IDS).toEqual(['com.nssurge.surge-mac']);
    // 真实路径只对期望的包、同名的包与主程序求（不对 Chrome 等其他 App 求）
    expect(d.realpathCalls).toEqual([APP, APP, EXE]);
  });

  test('never runs anything off macOS', async () => {
    for (const platform of ['linux', 'win32'] as const) {
      const d = deps(world(), platform);
      expect(await createRunningInstanceReader(d, OPTS).read()).toEqual({ ok: false, reason: 'not_darwin' });
      expect(d.exec).not.toHaveBeenCalled();
      expect(d.statCalls).toEqual([]);
    }
  });

  test.each([
    ['ps failing', { psCode: 1 }, 'ps_failed'],
    ['not running', { ps: `  1 0 Wed Oct 21 08:00:00 2026 /sbin/launchd` }, 'not_running'],
    ['only another user runs Surge', { ps: `  777 502 ${START} ${EXE}` }, 'not_running'],
    ['only the root helper and surge-cli', { ps: psLines(`  88 0 ${START} /Library/PrivilegedHelperTools/com.nssurge.surge-mac.helper`, `  405 ${UID} ${START} ${APP}/Contents/Applications/surge-cli`) }, 'not_running'],
    ['/Applications/Surge.app is not installed and nothing runs', { realpaths: { [APP]: null }, ps: `  1 0 Wed Oct 21 08:00:00 2026 /sbin/launchd` }, 'not_running'],
    ['/Applications/Surge.app removed or moved while Surge runs', { realpaths: { [APP]: null } }, 'running_image_mismatch'],
    ['two main processes for this user', { ps: psLines(`  404 ${UID} ${START} ${EXE}`, `  405 ${UID} ${START} ${EXE}`) }, 'multiple_instances'],
    ['a copy elsewhere', { ps: `  404 ${UID} ${START} /Users/u/Downloads/Surge.app/Contents/MacOS/Surge` }, 'bundle_mismatch'],
    ['a Setapp build', { ps: `  404 ${UID} ${START} /Applications/Setapp/Surge.app/Contents/MacOS/Surge` }, 'bundle_mismatch'],
    ['translocated', { ps: `  404 ${UID} ${START} /private/var/folders/x/T/AppTranslocation/ABC/d/Surge.app/Contents/MacOS/Surge` }, 'translocated'],
    ['/Applications/Surge.app plus a copy elsewhere', { ps: psLines(`  404 ${UID} ${START} ${EXE}`, `  410 ${UID} ${START} /Users/u/Downloads/Surge.app/Contents/MacOS/Surge`) }, 'multiple_instances'],
    ['localised lstart', { ps: `  404 ${UID} 21/10/2026 09:00 ${EXE}` }, 'start_time_unparseable'],
  ] as const)('%s → %s', async (_n, over, reason) => {
    expect(await read(world(over as Partial<World>))).toEqual({ ok: false, reason });
  });

  test('/Applications/Surge.app re-pointed (symlink) to another bundle while Surge runs from it: the running image differs', async () => {
    const NEW = '/Volumes/New/Surge.app';
    const w = world({
      realpaths: { [APP]: NEW },
      files: { [`${NEW}/Contents/Info.plist`]: [fid(61n, START_SEC - 86_400)], [`${NEW}/Contents/MacOS/Surge`]: [fid(62n, START_SEC - 86_400)] },
      // 进程映射的仍是启动时的旧可执行文件（inode 12）
      lsof: `p404\nftxt\ni12\nn${EXE}\n`,
    });
    expect(await read(w)).toEqual({ ok: false, reason: 'running_image_mismatch' });
  });

  test('a nested login-item app inside the bundle is excluded and does not count as another Surge', async () => {
    const w = world({ ps: psLines(`  404 ${UID} ${START} ${EXE}`, `  406 ${UID} ${START} ${APP}/Contents/Library/LoginItems/Surge.app/Contents/MacOS/Surge`) });
    expect(await read(w)).toEqual({ ok: true, instance: OK_INSTANCE });
  });

  test('CFBundleExecutable filters the processes before exactly one is required (two executables in Contents/MacOS)', async () => {
    const both = world({ ps: psLines(`  404 ${UID} ${START} ${EXE}`, `  420 ${UID} Wed Oct 21 09:00:05 2026 ${APP}/Contents/MacOS/SurgeHelper`) });
    expect(await read(both)).toEqual({ ok: true, instance: OK_INSTANCE });
    const helperOnly = world({ ps: `  420 ${UID} ${START} ${APP}/Contents/MacOS/SurgeHelper` });
    expect(await read(helperOnly)).toEqual({ ok: false, reason: 'not_running' });
    const twoMains = world({ ps: psLines(`  404 ${UID} ${START} ${EXE}`, `  405 ${UID} ${START} ${EXE}`, `  420 ${UID} ${START} ${APP}/Contents/MacOS/SurgeHelper`) });
    expect(await read(twoMains)).toEqual({ ok: false, reason: 'multiple_instances' });
  });

  test('follows a symlinked /Applications/Surge.app by real path (ps and lsof may show either path)', async () => {
    const REAL = '/Volumes/Apps/Surge.app';
    const files = { [`${REAL}/Contents/Info.plist`]: [fid(11n, START_SEC - 10)], [`${REAL}/Contents/MacOS/Surge`]: [fid(12n, START_SEC - 10)] };
    for (const [psPath, lsofPath] of [
      [EXE, `${REAL}/Contents/MacOS/Surge`],
      [`${REAL}/Contents/MacOS/Surge`, `${REAL}/Contents/MacOS/Surge`],
    ] as const) {
      const w = world({ realpaths: { [APP]: REAL }, ps: `  404 ${UID} ${START} ${psPath}`, files, lsof: `p404\nftxt\ni12\nn${lsofPath}\n` });
      const d = deps(w);
      expect(await createRunningInstanceReader(d, OPTS).read()).toEqual({ ok: true, instance: { ...OK_INSTANCE, bundlePath: REAL } });
      expect(callsTo(d, '/usr/bin/codesign')).toEqual([['--verify', '--strict', REAL]]);
    }
  });

  test.each([
    ['unknown bundle id', plistOf({ CFBundleIdentifier: 'com.example.other' }), 'bundle_id_unrecognized'],
    ['address-shaped version', plistOf({ CFBundleShortVersionString: '127.0.0.1' }), 'version_malformed'],
    ['non-numeric build', plistOf({ CFBundleVersion: '10960a' }), 'version_malformed'],
    ['missing build', plistOf({ CFBundleVersion: undefined }), 'plist_unreadable'],
    ['missing bundle id', plistOf({ CFBundleIdentifier: undefined }), 'plist_unreadable'],
    ['unreadable CFBundleExecutable', plistOf({ CFBundleExecutable: undefined }), 'plist_unreadable'],
    ['CFBundleExecutable with a path separator', plistOf({ CFBundleExecutable: '../Surge' }), 'plist_unreadable'],
    ['CFBundleExecutable changing between the selection and the read', { ...plistOf({}), CFBundleExecutable: ['Surge', 'Other'] }, 'changed_during_read'],
  ] as const)('%s → %s', async (_n, plist, reason) => {
    expect(await read(world({ plist: plist as World['plist'] }))).toEqual({ ok: false, reason });
  });

  test('Info.plist replaced after launch with a preserved (old) mtime is rejected by ctime', async () => {
    const w = world();
    w.files[PLIST] = [fid(21n, START_SEC + 120)];
    expect(await read(w)).toEqual({ ok: false, reason: 'modified_after_start' });
  });

  test('an executable created after launch (birthtime) is rejected even with an old ctime', async () => {
    const w = world();
    w.files[EXE] = [fid(12n, START_SEC - 3600, { birthtimeNs: BigInt(START_SEC + 5) * NS })];
    expect(await read(w)).toEqual({ ok: false, reason: 'modified_after_start' });
  });

  test('a change within the start second is ambiguous and rejected; unknown (zero) file times are rejected', async () => {
    const w = world();
    w.files[EXE] = [fid(12n, START_SEC)];
    expect(await read(w)).toEqual({ ok: false, reason: 'modified_after_start' });
    expect(predatesStart(fid(1n, START_SEC - 1), START_SEC)).toBe(true);
    expect(predatesStart(fid(1n, START_SEC - 1, { ctimeNs: BigInt(START_SEC) * NS - 1n }), START_SEC)).toBe(true);
    expect(predatesStart(fid(1n, START_SEC - 1, { birthtimeNs: 0n }), START_SEC)).toBe(false);
    expect(predatesStart(fid(1n, START_SEC - 1, { ctimeNs: 0n }), START_SEC)).toBe(false);
  });

  test('bundle swapped by rename keeps old ctimes but the running image inode differs', async () => {
    const w = world();
    w.files[EXE] = [fid(55n, START_SEC - 7200)];
    expect(await read(w)).toEqual({ ok: false, reason: 'running_image_mismatch' });
  });

  test('same inode under another path (the running bundle moved away) is a mismatch', async () => {
    expect(await read(world({ lsof: `p404\nftxt\ni12\nn/Users/u/.Trash/Surge.app/Contents/MacOS/Surge\n` }))).toEqual({ ok: false, reason: 'running_image_mismatch' });
  });

  test.each([
    ['lsof failing', { lsofCode: 1 }],
    ['lsof with no mapped files', { lsof: 'p404\n' }],
  ] as const)('%s fails closed (running_image_unverifiable)', async (_n, over) => {
    expect(await read(world(over))).toEqual({ ok: false, reason: 'running_image_unverifiable' });
  });

  test.each([
    ['Info.plist replaced (new inode)', PLIST, fid(31n, START_SEC - 10)],
    ['executable rewritten in place (size)', EXE, fid(12n, START_SEC - 3600, { size: 2000n })],
    ['executable metadata changed (ctime)', EXE, fid(12n, START_SEC - 3000)],
  ] as const)('files changed while reading are rejected: %s', async (_n, path, second) => {
    const w = world();
    w.files[path] = [w.files[path]![0]!, second];
    expect(await read(w)).toEqual({ ok: false, reason: 'changed_during_read' });
  });

  test('an invalid signature fails; a known Team ID adds the requirement; a malformed Team ID never runs codesign', async () => {
    expect(await read(world({ codesign: [1] }))).toEqual({ ok: false, reason: 'signature_invalid' });
    const d = deps(world());
    expect((await createRunningInstanceReader(d, { teamId: 'ABCDE12345' }).read()).ok).toBe(true);
    expect(callsTo(d, '/usr/bin/codesign')).toEqual([['--verify', '--strict', '-R=anchor apple generic and certificate leaf[subject.OU] = "ABCDE12345"', APP]]);
    const bad = deps(world());
    expect(await createRunningInstanceReader(bad, { teamId: 'X" or true' }).read()).toEqual({ ok: false, reason: 'signature_invalid' });
    expect(callsTo(bad, '/usr/bin/codesign')).toEqual([]);
  });

  test('caches Info.plist values and the signature result while pid, start time and file identities are unchanged; ps, stat and lsof run every time', async () => {
    const d = deps(world());
    const reader = createRunningInstanceReader(d, OPTS);
    await reader.read();
    const count = (f: string) => callsTo(d, f).length;
    const first = { plutil: count('/usr/bin/plutil'), codesign: count('/usr/bin/codesign'), ps: count('/bin/ps'), lsof: count('/usr/sbin/lsof'), stat: d.statCalls.length };
    const report = await reader.inspect();
    expect(report.result).toEqual({ ok: true, instance: OK_INSTANCE });
    expect(report.cached).toBe(true);
    // CFBundleExecutable 每次都读（选择进程用），其余键与签名来自缓存
    expect(count('/usr/bin/plutil')).toBe(first.plutil + 1);
    expect(count('/usr/bin/codesign')).toBe(first.codesign);
    expect(count('/bin/ps')).toBe(first.ps + 1);
    expect(count('/usr/sbin/lsof')).toBe(first.lsof + 1);
    expect(d.statCalls.length).toBe(first.stat * 2);
    expect(report.steps.find((s) => s.rule === 'signature')?.outcome).toBe('cached');
  });

  test('the cache never hides a change: a relaunch (new pid) or a replaced file reads and verifies again', async () => {
    const w = world();
    const d = deps(w);
    const reader = createRunningInstanceReader(d, OPTS);
    expect((await reader.read()).ok).toBe(true);
    w.ps = `  900 ${UID} Wed Oct 21 10:00:00 2026 ${EXE}`;
    w.lsof = `p900\nftxt\ni12\nn${EXE}\n`;
    expect(await reader.read()).toEqual({ ok: true, instance: { ...OK_INSTANCE, pid: 900, startedAt: '2026-10-21T10:00:00.000Z' } });
    expect(callsTo(d, '/usr/bin/codesign')).toHaveLength(2);
    // 新的包信息（例如已更新但还没有重启）：缓存不命中，按 ctime 拒绝
    w.files[PLIST] = [fid(77n, START_SEC + 7200)];
    expect(await reader.read()).toEqual({ ok: false, reason: 'modified_after_start' });
  });

  test('the cache key includes the file identities: an Info.plist replaced by rename with pre-start times (new inode) is read and verified again', async () => {
    const w = world();
    const d = deps(w);
    const reader = createRunningInstanceReader(d, OPTS);
    expect((await reader.read()).ok).toBe(true);
    const count = (f: string) => callsTo(d, f).length;
    const before = { plutil: count('/usr/bin/plutil'), codesign: count('/usr/bin/codesign') };
    // 同一进程、同一启动时间；新文件的 ctime 与 birthtime 仍早于启动（APFS 上改名替换是否更新 ctime 待 V6 记录），只有 inode 不同
    w.files[PLIST] = [fid(31n, START_SEC - 10)];
    w.codesign = [1];
    const report = await reader.inspect();
    expect(report.result).toEqual({ ok: false, reason: 'signature_invalid' });
    expect(report.cached).toBe(false);
    expect(report.steps.some((s) => s.outcome === 'cached')).toBe(false);
    // 四个键重新读取（CFBundleExecutable 每次都读，另三个键与再读一次的 CFBundleExecutable 来自 plutil），签名重新校验
    expect(count('/usr/bin/plutil')).toBe(before.plutil + 5);
    expect(count('/usr/bin/codesign')).toBe(before.codesign + 1);
  });

  test('codesign timeout: 60 s by default (P0 evidence), the shorter service value when given', async () => {
    expect(SERVICE_CODESIGN_TIMEOUT_MS).toBeLessThan(RUNNING_INSTANCE_CODESIGN_TIMEOUT_MS);
    expect(SERVICE_CODESIGN_TIMEOUT_MS).toBeLessThanOrEqual(15_000);
    const timeoutOf = (d: MockDeps) => d.exec.mock.calls.filter((c) => c[0] === '/usr/bin/codesign').map((c) => c[2].timeoutMs);
    const p0 = deps(world());
    expect((await createRunningInstanceReader(p0, OPTS).read()).ok).toBe(true);
    expect(timeoutOf(p0)).toEqual([RUNNING_INSTANCE_CODESIGN_TIMEOUT_MS]);
    const svc = deps(world());
    expect((await createRunningInstanceReader(svc, { ...OPTS, codesignTimeoutMs: SERVICE_CODESIGN_TIMEOUT_MS }).read()).ok).toBe(true);
    expect(timeoutOf(svc)).toEqual([SERVICE_CODESIGN_TIMEOUT_MS]);
    // 工厂同样传递
    const exec = vi.fn<RunningInstanceExec>(async () => ({ stdout: '', stderr: '', code: 0 }));
    const factory = createDefaultSurgeInstanceReader({ platform: 'linux', uid: UID, exec, teamId: null, codesignTimeoutMs: SERVICE_CODESIGN_TIMEOUT_MS });
    expect(await factory.read()).toEqual({ ok: false, reason: 'not_darwin' });
  });

  test('concurrent reads share one in-flight read (a caller that stopped waiting does not stack another codesign); the next read starts fresh', async () => {
    const d = deps(world());
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const real = d.exec.getMockImplementation()!;
    d.exec.mockImplementation(async (file, args, o) => {
      if (file === '/usr/bin/codesign') await gate;
      return real(file, args, o);
    });
    const reader = createRunningInstanceReader(d, OPTS);
    const a = reader.read();
    const b = reader.read();
    await new Promise((r) => setImmediate(r));
    release();
    expect(await a).toEqual({ ok: true, instance: OK_INSTANCE });
    expect(await b).toEqual({ ok: true, instance: OK_INSTANCE });
    expect(callsTo(d, '/bin/ps')).toHaveLength(1);
    expect(callsTo(d, '/usr/bin/codesign')).toHaveLength(1);
    expect((await reader.read()).ok).toBe(true);
    expect(callsTo(d, '/bin/ps')).toHaveLength(2);
  });

  test('failures are not cached: a failed signature check runs again on the next read', async () => {
    const d = deps(world({ codesign: [1, 0] }));
    const reader = createRunningInstanceReader(d, OPTS);
    expect(await reader.read()).toEqual({ ok: false, reason: 'signature_invalid' });
    expect(await reader.read()).toEqual({ ok: true, instance: OK_INSTANCE });
    expect(callsTo(d, '/usr/bin/codesign')).toHaveLength(2);
  });

  test('inspect() records each rule, time differences, the lsof match and the codesign exit code, never raw tool output', async () => {
    const w = world();
    const report = await createRunningInstanceReader(deps(w), OPTS).inspect();
    expect(report.steps.map((s) => [s.rule, s.outcome])).toEqual([
      ['platform', 'pass'],
      ['process', 'pass'],
      ['bundle_executable', 'pass'],
      ['start_time', 'pass'],
      ['info_plist', 'pass'],
      ['not_modified', 'pass'],
      ['running_image', 'pass'],
      ['signature', 'pass'],
      ['stable', 'pass'],
    ]);
    const by = Object.fromEntries(report.steps.map((s) => [s.rule, s.detail]));
    expect(by.not_modified).toMatchObject({ plist: { ctimeMinusStartMs: -3_600_000 }, executable: { birthtimeMinusStartMs: -3_600_000 } });
    expect(by.running_image).toEqual({ code: 0, entries: 2, inodeMatch: true, pathMatch: true, sameEntry: true });
    expect(by.signature).toEqual({ code: 0, teamRequirement: false });
    const others = (by.process as { others: Array<{ pid: number; excluded: string }> }).others;
    expect(others.map((o) => [o.pid, o.excluded])).toEqual([
      [88, 'other_user'],
      [405, 'not_main_executable'],
      [406, 'nested_app'],
      [777, 'other_user'],
    ]);
    expect(JSON.stringify(report)).not.toContain('/usr/lib/dyld');

    const failed = await createRunningInstanceReader(deps(world({ lsof: `p404\nftxt\ni55\nn${EXE}\n` })), OPTS).inspect();
    expect(failed.result).toEqual({ ok: false, reason: 'running_image_mismatch' });
    expect(failed.steps.at(-1)).toMatchObject({ rule: 'running_image', outcome: 'fail', detail: { reason: 'running_image_mismatch', inodeMatch: false, pathMatch: true, sameEntry: false } });
  });

  test('an injected dependency that throws gives read_failed', async () => {
    const d = deps(world());
    d.stat = async () => {
      throw new Error('boom');
    };
    d.exec.mockImplementationOnce(async () => {
      throw new Error('spawn failed');
    });
    expect(await createRunningInstanceReader(d, OPTS).read()).toEqual({ ok: false, reason: 'read_failed' });
    expect((await createRunningInstanceReader(d, OPTS).inspect()).result).toEqual({ ok: false, reason: 'plist_unreadable' });
  });
});

describe('default reader shared by the service and P0', () => {
  test('off macOS the factory runs nothing', async () => {
    const exec = vi.fn<RunningInstanceExec>();
    const reader = createDefaultSurgeInstanceReader({ platform: 'linux', uid: UID, exec, teamId: null });
    expect(await reader.read()).toEqual({ ok: false, reason: 'not_darwin' });
    expect(exec).not.toHaveBeenCalled();
  });

  test('on macOS the factory uses the fixed ps argv and environment through the injected executor', async () => {
    const exec = vi.fn<RunningInstanceExec>(async () => ({ stdout: '', stderr: '', code: 0 }));
    const reader = createDefaultSurgeInstanceReader({ platform: 'darwin', uid: UID, exec, teamId: null });
    // 本机没有 /Applications/Surge.app（或没有运行）：只执行了 ps
    expect(await reader.read()).toEqual({ ok: false, reason: 'not_running' });
    expect(exec.mock.calls.map((c) => [c[0], [...c[1]], c[2].env])).toEqual([['/bin/ps', [...PS_INSTANCE_ARGS], RUNNING_INSTANCE_PS_ENV]]);
  });

  test('the default executor closes stdin, passes the fixed environment and maps exit codes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sfe-instance-exec-'));
    const script = join(dir, 'child.mjs');
    writeFileSync(
      script,
      "let n=0;process.stdin.on('data',(c)=>{n+=c.length});process.stdin.on('end',()=>{process.stdout.write(JSON.stringify({n,lc:process.env.LC_ALL??null,tz:process.env.TZ??null,home:process.env.HOME??null}));process.exit(Number(process.argv[2]??0))});",
    );
    const t0 = Date.now();
    const ok = await defaultRunningInstanceExec(process.execPath, [script, '0'], { timeoutMs: 5_000, env: { ...RUNNING_INSTANCE_PS_ENV } });
    expect(Date.now() - t0).toBeLessThan(3_000);
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.stdout)).toEqual({ n: 0, lc: 'C', tz: 'UTC', home: null });
    expect((await defaultRunningInstanceExec(process.execPath, [script, '4'], { timeoutMs: 5_000 })).code).toBe(4);
    expect((await defaultRunningInstanceExec('ps', ['-ww'], { timeoutMs: 5_000 })).code).toBe(-1);
  });
});
