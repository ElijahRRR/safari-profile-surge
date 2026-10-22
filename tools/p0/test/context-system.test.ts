import { describe, expect, it } from 'vitest';
import { STAGED_CRYPTEX_PATH, processPathsDigest as serviceProcessPathsDigest } from '../../../service/src/engine/capabilities.js';
import { measureContextWithInstance, type Ctx, type Deps } from '../src/commands/common.js';
import { autoReloadOf, buildContext, canonicalMechanism, contextDrift, processPathsDigest, takeoverModeOf } from '../src/context.js';
import { parseArgs } from '../src/args.js';
import { emptyState } from '../src/state.js';
import {
  appVersion,
  parsePsOutput,
  parseTeamIdentifier,
  restartPending,
  surgeProcesses,
  surgeStartFingerprint,
  swVers,
  webkitSafariCandidates,
  type ExecFn,
} from '../src/system.js';

describe('processPathsDigest', () => {
  it('is order independent, deduplicated and identical to the service formula', () => {
    const a = processPathsDigest(['/B/x', '/A/y', '/A/y']);
    expect(a).toBe(processPathsDigest(['/A/y', '/B/x']));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(serviceProcessPathsDigest(['/A/y', '/B/x']));
    expect(processPathsDigest([])).toBeNull();
    expect(processPathsDigest(['/A/z'])).not.toBe(a);
  });
});

describe('takeoverModeOf', () => {
  const t = (e: boolean | null, s: boolean | null) => ({ enhancedMode: e, systemProxy: s, outboundMode: 'rule' as const, checkedAt: null });
  it('maps readable states', () => {
    expect(takeoverModeOf(t(true, true))).toBe('both');
    expect(takeoverModeOf(t(true, false))).toBe('enhanced');
    expect(takeoverModeOf(t(false, true))).toBe('system_proxy');
  });
  it('returns null for no takeover or unreadable', () => {
    expect(takeoverModeOf(t(false, false))).toBeNull();
    expect(takeoverModeOf(t(null, null))).toBeNull();
    expect(takeoverModeOf(null)).toBeNull();
  });
});

describe('buildContext', () => {
  const inputs = {
    surgeVersion: { version: '6.5.0', build: '10960' },
    macosBuild: '24A335',
    macosVersionExtra: 'none',
    macosRestartPending: 'no' as const,
    safariVersion: '18.0',
    entryStrategy: 'ruleset_resource' as const,
    processPaths: ['/Applications/Safari.app/Contents/MacOS/Safari'],
    autoReloadSetting: false,
    takeover: { enhancedMode: true, systemProxy: false, outboundMode: 'rule' as const, checkedAt: null },
    signingIdentity: null,
    mechanism: { b: 'cli', a: 'http' },
  };

  it('builds from service-equivalent sources', () => {
    const c = buildContext(inputs);
    expect(c).toMatchObject({ surgeVersion: '6.5.0', surgeBuild: '10960', autoReload: 'off', takeoverMode: 'enhanced', workingProfileId: null });
    expect(c.adapterMechanism).toBe('{"a":"http","b":"cli"}');
    expect(c.processPathsDigest).toBe(processPathsDigest(inputs.processPaths));
  });

  it('applies explicit overrides', () => {
    const c = buildContext(inputs, { workingProfileId: 'any', autoReload: 'any', takeoverMode: 'any', signingIdentity: 'ABCDE12345' });
    expect(c).toMatchObject({ workingProfileId: 'any', autoReload: 'any', takeoverMode: 'any', signingIdentity: 'ABCDE12345' });
  });

  it('records null for unreadable fields', () => {
    const c = buildContext({ ...inputs, surgeVersion: null, autoReloadSetting: null, takeover: null, mechanism: null });
    expect(c.surgeVersion).toBeNull();
    expect(c.autoReload).toBeNull();
    expect(c.takeoverMode).toBeNull();
    expect(c.adapterMechanism).toBeNull();
    expect(autoReloadOf(true)).toBe('on');
    expect(canonicalMechanism(null)).toBeNull();
  });

  it('reports drift only on dependency fields', () => {
    const measured = buildContext(inputs);
    const upgraded = buildContext({ ...inputs, safariVersion: '18.1' });
    expect(contextDrift('safari_process_attribution', measured, upgraded)).toEqual(['safariVersion']);
    expect(contextDrift('external_node_underlying_proxy', measured, upgraded)).toEqual([]);
  });

  it('carries the Background Security Improvement fields; a staged improvement or a new supplemental version is drift for attribution only', () => {
    const measured = buildContext(inputs);
    expect(measured).toMatchObject({ macosVersionExtra: 'none', macosRestartPending: 'no' });
    expect(contextDrift('safari_process_attribution', measured, buildContext({ ...inputs, macosRestartPending: 'yes' }))).toEqual(['macosRestartPending']);
    expect(contextDrift('safari_udp_quic_handling', measured, buildContext({ ...inputs, macosVersionExtra: '(a)' }))).toEqual(['macosVersionExtra']);
    expect(contextDrift('native_bridge_ipc', measured, buildContext({ ...inputs, macosVersionExtra: '(a)', macosRestartPending: 'yes' }))).toEqual([]);
    // 待重启状态没有 any：两次都待重启也不算“一致”
    const pending = buildContext({ ...inputs, macosRestartPending: 'yes' });
    expect(contextDrift('safari_process_attribution', pending, pending)).toEqual(['macosRestartPending']);
  });
});

describe('system parsing', () => {
  it('parses ps output with paths containing spaces', () => {
    const procs = parsePsOutput('  PID COMM\n  101 /Applications/Safari.app/Contents/MacOS/Safari\n  202 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome\n 303 /System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.Networking.xpc/Contents/MacOS/com.apple.WebKit.Networking\n 404 /Applications/Surge.app/Contents/MacOS/Surge\n');
    expect(procs).toHaveLength(4);
    expect(procs[1]).toEqual({ pid: 202, path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
    expect(webkitSafariCandidates(procs)).toEqual([
      '/Applications/Safari.app/Contents/MacOS/Safari',
      '/System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.Networking.xpc/Contents/MacOS/com.apple.WebKit.Networking',
    ]);
    expect(surgeProcesses(procs).map((p) => p.pid)).toEqual([404]);
  });

  it('parses TeamIdentifier from codesign output', () => {
    expect(parseTeamIdentifier('Executable=/x\nTeamIdentifier=ABCDE12345\nSealed Resources=none\n')).toBe('ABCDE12345');
    expect(parseTeamIdentifier('TeamIdentifier=not set\n')).toBeNull();
  });

  it('reads versions through fixed executables and validates output', async () => {
    const calls: string[][] = [];
    const exec: ExecFn = async (file, args) => {
      calls.push([file, ...args]);
      if (file === '/usr/bin/sw_vers') return { stdout: args[0] === '-buildVersion' ? '24A335\n' : args[0] === '-productVersionExtra' ? '(a)\n' : '15.0\n', stderr: '', code: 0 };
      if (file === '/usr/bin/defaults') return { stdout: args[2] === 'CFBundleVersion' ? '20619.1.26\n' : 'bad;value`\n', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 1 };
    };
    expect(await swVers(exec)).toEqual({ productVersion: '15.0', buildVersion: '24A335', productVersionExtra: '(a)' });
    expect(calls).toContainEqual(['/usr/bin/sw_vers', '-productVersionExtra']);
    expect(await appVersion(exec, '/Applications/Safari.app')).toEqual({ version: null, build: '20619.1.26' });
    expect(calls.every((c) => c[0]!.startsWith('/'))).toBe(true);
    expect(calls).toContainEqual(['/usr/bin/defaults', 'read', '/Applications/Safari.app/Contents/Info', 'CFBundleShortVersionString']);
  });

  it('fingerprints Surge process start times', async () => {
    const exec: ExecFn = async (_file, args) => {
      if (args[0] === '-axo') return { stdout: ' 404 /Applications/Surge.app/Contents/MacOS/Surge\n 505 /usr/bin/other\n', stderr: '', code: 0 };
      if (args.includes('lstart=')) return { stdout: 'Wed Oct 21 09:00:00 2026\n', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 1 };
    };
    expect(await surgeStartFingerprint(exec)).toBe('/Applications/Surge.app/Contents/MacOS/Surge@Wed Oct 21 09:00:00 2026');
    const none: ExecFn = async () => ({ stdout: '', stderr: '', code: 0 });
    expect(await surgeStartFingerprint(none)).toBeNull();
  });
});

describe('Background Security Improvement facts (same rules as the service)', () => {
  const swVersExec = (extra: { stdout: string; code: number }): ExecFn => async (file, args) => {
    if (file === '/usr/bin/sw_vers') return args[0] === '-productVersionExtra' ? { ...extra, stderr: '' } : { stdout: args[0] === '-buildVersion' ? '25B78\n' : '26.1\n', stderr: '', code: 0 };
    return { stdout: '', stderr: '', code: 1 };
  };

  it('reads the supplemental version: empty is "none", failure or unknown output is null', async () => {
    expect((await swVers(swVersExec({ stdout: '\n', code: 0 }))).productVersionExtra).toBe('none');
    expect((await swVers(swVersExec({ stdout: '(b)\n', code: 0 }))).productVersionExtra).toBe('(b)');
    expect((await swVers(swVersExec({ stdout: '', code: 1 }))).productVersionExtra).toBeNull();
    expect((await swVers(swVersExec({ stdout: 'usage: sw_vers\n', code: 0 }))).productVersionExtra).toBeNull();
  });

  it('checks only the staged cryptex path for a pending restart', async () => {
    const seen: string[] = [];
    const presence = (r: 'present' | 'absent' | 'unknown') => async (p: string) => {
      seen.push(p);
      return r;
    };
    expect(await restartPending(presence('present'))).toBe('yes');
    expect(await restartPending(presence('absent'))).toBe('no');
    expect(await restartPending(presence('unknown'))).toBeNull();
    expect(new Set(seen)).toEqual(new Set([STAGED_CRYPTEX_PATH]));
  });

  it('measured contexts record both fields from the same sources as the service', async () => {
    const deps = (presence: 'present' | 'absent' | 'unknown'): Deps =>
      ({
        exec: swVersExec({ stdout: '(a)\n', code: 0 }),
        now: () => new Date('2026-10-22T00:00:00Z'),
        home: '/nonexistent-home',
        platform: 'darwin',
        env: {},
        sleep: async () => undefined,
        surgeInstance: async () => ({ ok: false, reason: 'not_running' }),
        pathPresence: async () => presence,
      }) as unknown as Deps;
    const ctx = (presence: 'present' | 'absent' | 'unknown'): Ctx => ({ args: parseArgs(['inventory']), deps: deps(presence) });
    const state = emptyState('run-1', new Date('2026-10-22T00:00:00Z'));
    const pending = await measureContextWithInstance(ctx('present'), null, state);
    expect(pending.context).toMatchObject({ macosBuild: '25B78', macosVersionExtra: '(a)', macosRestartPending: 'yes' });
    expect((await measureContextWithInstance(ctx('absent'), null, state)).context.macosRestartPending).toBe('no');
    expect((await measureContextWithInstance(ctx('unknown'), null, state)).context.macosRestartPending).toBeNull();
  });
});
