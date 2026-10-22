import { describe, expect, test, vi } from 'vitest';
import { SfeError } from '@sfe/contract';
import type { SurgeAdapter } from '../../src/ports.js';
import {
  CLI_ARGV_ALLOWLIST,
  CLI_COMMANDS,
  cliArgvs,
  isAllowedCliArgv,
  ruleMatchArgs,
  safeArg,
  safeConnectionId,
  safeResourceKey,
  safeRouteSelection,
  type CliCommand,
} from '../../src/surge/cli-commands.js';
import { codesignArgs, createCliAdapter, isUnsupportedCommandError, verifyCliPath, type ExecFn } from '../../src/surge/cli-adapter.js';
import { createHttpAdapter, isLoopbackHost, parseHttpApiLine } from '../../src/surge/http-adapter.js';
import { createCompositeAdapter } from '../../src/surge/composite.js';
import { SURGE_PRIMITIVES, type MechanismMap, type SurgePrimitive } from '../../src/surge/primitives.js';
import { FAKE_CHROME_PATH, FAKE_SAFARI_PATH, FAKE_VERIFY_HOST } from '../../src/surge/fake.js';
import { CLI_PATH as CLI, CLI_SAMPLE_ARGS as SAMPLE_ARGS, SAMPLE_RULE } from './cli-samples.js';

const allCli: MechanismMap = Object.fromEntries(SURGE_PRIMITIVES.map((p) => [p, 'cli']));
const allHttp: MechanismMap = Object.fromEntries(SURGE_PRIMITIVES.map((p) => [p, 'http']));
const CLI_PRIMITIVES = Object.keys(CLI_COMMANDS) as SurgePrimitive[];

/** 文档列出的全局动作（手册、随包技能、6.10 内置帮助），以及会扩大作用范围的参数：允许清单必须一个都不放行。 */
const FORBIDDEN_ARGVS: string[][] = [
  ['reload'],
  ['restart-engine'],
  ['switch-profile', '日常-Safari环境.conf'],
  ['profile', 'switch', '日常-Safari环境.conf'],
  ['profile', 'check', '日常-Safari环境.conf'],
  ['mode', 'set', 'direct'],
  ['mode', 'set', 'rule'],
  ['global-policy', 'set', 'DIRECT'],
  ['feature', 'set', 'enhanced-mode', 'off'],
  ['feature', 'set', 'system-proxy', 'off'],
  ['module', 'enable', 'M'],
  ['module', 'disable', 'M'],
  ['set', 'ProxyMode=0'],
  ['set', 'ProxyGroupSelection.SFE-ROUTE=DIRECT'],
  ['stop'],
  ['managed-profile', 'update'],
  ['update-profile', 'AAAA'],
  ['unattended-upgrade'],
  ['external-resource', 'update', 'all'],
  ['external-resource', 'update', 'ALL'],
  ['external-resource', 'update'],
  ['rule', 'temp', 'flush'],
  ['rule', 'temp', 'set-policy', SAMPLE_RULE, 'DIRECT'],
  ['flush-temp-rule'],
  ['add-temp-rule', SAMPLE_RULE],
  ['del-temp-rule', SAMPLE_RULE],
  ['flush', 'dns'],
  ['kill'],
  ['kill', 'all'],
  ['kill', '1', '2'],
  ['policy-group', 'set', 'SFE-ROUTE', 'auto'],
  ['policy-group', 'set', 'SFE-ROUTE', 'AUTO'],
  ['policy-group', 'set', 'Daily', 'DIRECT'],
  ['policy-group', 'set', 'sfe-route', 'DIRECT'],
  ['security', 'ban', 'clear'],
  ['script', 'run', 'job'],
  ['plugin', 'enable', 'x'],
  ['--remote', '192.0.2.1:6170', 'status'],
  ['--version'],
  [],
];

describe('CLI command table and argv allowlist', () => {
  test('every argv the table can build is allowlisted (all primitives, sample arguments)', () => {
    for (const p of CLI_PRIMITIVES) {
      const argvs = cliArgvs(p, SAMPLE_ARGS[p] ?? [])!;
      expect(argvs.length, p).toBeGreaterThan(0);
      for (const argv of argvs) expect(isAllowedCliArgv(argv), `${p}: ${argv.join(' ')}`).toBe(true);
    }
  });

  test('no documented global action is reachable, with or without --raw, in any letter case', () => {
    for (const argv of FORBIDDEN_ARGVS) {
      for (const variant of [argv, ['--raw', ...argv], argv.map((w) => w.toUpperCase())]) {
        expect(isAllowedCliArgv(variant), variant.join(' ')).toBe(false);
      }
    }
  });

  test('the only writes are the four single-object ones; every read carries --raw', () => {
    const writes = CLI_ARGV_ALLOWLIST.filter((r) => r.prefix[0] !== '--raw' && r.prefix[0] !== '--check').map((r) => r.prefix.join(' '));
    expect(writes.sort()).toEqual(['external-resource update', 'kill', 'policy-group set SFE-ROUTE', 'rule temp add', 'rule temp remove']);
    for (const rule of CLI_ARGV_ALLOWLIST) {
      expect(rule.prefix.join(' ')).not.toMatch(/reload|restart|switch|flush|stop|managed|module|upgrade|global-policy|feature set|mode set/);
    }
  });

  test('extra, missing or unsafe arguments are refused even after an allowed prefix', () => {
    expect(isAllowedCliArgv(['--raw', 'dump', 'rule', 'extra'])).toBe(false);
    expect(isAllowedCliArgv(['rule', 'temp', 'add'])).toBe(false);
    expect(isAllowedCliArgv(['rule', 'temp', 'add', '--raw'])).toBe(false);
    expect(isAllowedCliArgv(['--check', 'relative.conf'])).toBe(false);
    expect(isAllowedCliArgv(['--raw', 'rule', 'match', 'a b', `process-path=${FAKE_SAFARI_PATH}`, 'protocol=TCP', 'dest-port=443'])).toBe(false);
    expect(isAllowedCliArgv(['--raw', 'rule', 'match', FAKE_VERIFY_HOST, 'process-path=Safari', 'protocol=TCP', 'dest-port=443'])).toBe(false);
    expect(isAllowedCliArgv(['--raw', 'rule', 'match', FAKE_VERIFY_HOST, `process-path=${FAKE_SAFARI_PATH}`, 'protocol=STUN', 'dest-port=443'])).toBe(false);
    expect(isAllowedCliArgv(['--raw', 'rule', 'match', FAKE_VERIFY_HOST, `process-path=${FAKE_SAFARI_PATH}`, 'protocol=TCP', 'dest-port=70000'])).toBe(false);
  });

  test('a table argv outside the allowlist is never executed', async () => {
    const cmd = CLI_COMMANDS.listRules as CliCommand<[], unknown>;
    const original = cmd.argv;
    cmd.argv = () => ['reload'];
    try {
      const exec = vi.fn(async () => ({ stdout: '[]', stderr: '' }));
      await expect(createCliAdapter({ cliPath: CLI, mechanism: allCli, exec, scrub: (s) => s }).listRules()).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      expect(exec).not.toHaveBeenCalled();
    } finally {
      cmd.argv = original;
    }
  });

  test('evidence: only the writes whose syntax and exit-status success are documented are marked documented', () => {
    const documented = Object.entries(CLI_COMMANDS)
      .filter(([, c]) => c!.evidence === 'documented')
      .map(([k]) => k)
      .sort();
    expect(documented).toEqual(['addTempRule', 'removeTempRule', 'selectGroupPolicy']);
  });

  test('documented 6.10 argv forms: temp rule verbs without --raw, reads with --raw', () => {
    const argv = (p: SurgePrimitive) => cliArgvs(p, SAMPLE_ARGS[p] ?? []);
    expect(argv('addTempRule')).toEqual([['rule', 'temp', 'add', SAMPLE_RULE]]);
    expect(argv('removeTempRule')).toEqual([['rule', 'temp', 'remove', SAMPLE_RULE]]);
    expect(argv('listTempRules')).toEqual([['--raw', 'dump', 'temp-rule']]);
    expect(argv('getVersion')).toEqual([['--raw', 'version']]);
    expect(argv('getCurrentProfile')).toEqual([['--raw', 'status']]);
    expect(argv('getRuntimeInfo')).toEqual([['--raw', 'dump', 'performance']]);
    expect(argv('getTakeoverState')).toEqual([
      ['--raw', 'feature', 'get', 'enhanced-mode'],
      ['--raw', 'feature', 'get', 'system-proxy'],
      ['--raw', 'mode', 'get'],
    ]);
    expect(argv('getGroupSelection')).toEqual([['--raw', 'policy-group', 'get', 'SFE-ROUTE']]);
    expect(argv('getGroupMembers')).toEqual([['--raw', 'policy-group', 'list']]);
    expect(argv('selectGroupPolicy')).toEqual([['policy-group', 'set', 'SFE-ROUTE', 'SFE-N-E0001-US01-v001']]);
    expect(argv('killRequest')).toEqual([['kill', '42']]);
    expect(argv('updateExternalResource')).toEqual([['external-resource', 'update', 'policy-path:sfe-nodes.list']]);
    expect(argv('matchRule')).toEqual([['--raw', 'rule', 'match', FAKE_VERIFY_HOST, `process-path=${FAKE_SAFARI_PATH}`, 'protocol=UDP', 'dest-port=443']]);
    // 没有文档化读取命令的原语保持不映射
    expect(cliArgvs('getAutoReloadSetting', [])).toBeNull();
    expect(cliArgvs('getPolicyDetail', ['x'])).toBeNull();
    expect(cliArgvs('testPolicy', ['x', 'https://verify.example.test/'])).toBeNull();
    expect(Object.keys(CLI_COMMANDS)).not.toContain('switchProfile');
  });

  test.each(['', '-all', '--check', 'a\nb', 'a\0b'])('argument %j is refused', (v) => {
    expect(() => safeArg(v, 'x')).toThrow(SfeError);
  });

  test.each(['all', 'ALL', '*', ' all '])('resource key %j is refused', (k) => {
    expect(() => safeResourceKey(k)).toThrow(/单个资源/);
  });

  test('selection is restricted to SFE-ROUTE and never auto; kills take one numeric id', () => {
    expect(safeRouteSelection('SFE-ROUTE', 'SFE-N-E0001-US01-v001')).toEqual(['SFE-ROUTE', 'SFE-N-E0001-US01-v001']);
    expect(() => safeRouteSelection('Daily', 'DIRECT')).toThrow(/只能选择 SFE-ROUTE/);
    expect(() => safeRouteSelection('SFE-ROUTE', 'auto')).toThrow(/auto/);
    expect(() => safeRouteSelection('SFE-ROUTE', ' Auto ')).toThrow(/auto/);
    expect(safeConnectionId('12345')).toBe('12345');
    for (const bad of ['', 'all', '-1', '1 2', '1\n2', '0x10']) expect(() => safeConnectionId(bad), bad).toThrow(/连接编号/);
  });

  test('rule match arguments: hostname, absolute process path, documented protocol, port; defaults TCP 443', () => {
    expect(ruleMatchArgs({ host: FAKE_VERIFY_HOST, processPath: FAKE_CHROME_PATH })).toEqual([FAKE_VERIFY_HOST, `process-path=${FAKE_CHROME_PATH}`, 'protocol=TCP', 'dest-port=443']);
    expect(ruleMatchArgs({ host: FAKE_VERIFY_HOST, processPath: FAKE_SAFARI_PATH, protocol: 'QUIC', port: 8443 })).toEqual([FAKE_VERIFY_HOST, `process-path=${FAKE_SAFARI_PATH}`, 'protocol=QUIC', 'dest-port=8443']);
    for (const bad of [
      { host: 'https://verify.example.test/', processPath: FAKE_SAFARI_PATH },
      { host: '-x', processPath: FAKE_SAFARI_PATH },
      { host: FAKE_VERIFY_HOST, processPath: 'Safari' },
      { host: FAKE_VERIFY_HOST, processPath: `${FAKE_SAFARI_PATH}\nx` },
      { host: FAKE_VERIFY_HOST, processPath: FAKE_SAFARI_PATH, protocol: 'STUN' },
      { host: FAKE_VERIFY_HOST, processPath: FAKE_SAFARI_PATH, port: 70000 },
    ]) {
      expect(() => ruleMatchArgs(bad as never), JSON.stringify(bad)).toThrow(SfeError);
    }
  });

  test('parsers accept the known JSON shapes and refuse other output', () => {
    const ctx = { scrub: (s: string) => s, now: () => new Date('2026-10-22T00:00:00Z') };
    const out = (stdout: string) => ({ stdout, stderr: '', exitCode: 0 });
    const list = CLI_COMMANDS.listExternalResources as CliCommand<[], unknown>;
    const temps = CLI_COMMANDS.listTempRules as CliCommand<[], unknown>;
    expect(list.parse(out(JSON.stringify({ resources: [{ key: 'k1', type: 'ruleset', path: 'https://rules.example.test/a.list', lastUpdated: 1760000000 }] })), ctx, [])).toEqual([
      { key: 'k1', type: 'ruleset', location: 'https://rules.example.test/a.list', lastUpdatedAt: new Date(1760000000 * 1000), error: null, local: null, updating: null, fromModule: null },
    ]);
    expect(temps.parse(out('[]'), ctx, [])).toEqual([]);
    expect(temps.parse(out(JSON.stringify(['DOMAIN,a.example.test,REJECT'])), ctx, [])).toEqual(['DOMAIN,a.example.test,REJECT']);
    // --raw 输出只接受 JSON：人类可读的文本不再按行拆成规则。
    expect(() => temps.parse(out('# temp rules\nDOMAIN,a.example.test,REJECT\n'), ctx, [])).toThrow(/输出格式无法识别/);
    expect(() => list.parse(out('not json'), ctx, [])).toThrow(/输出格式无法识别/);
  });
});

describe('createCliAdapter', () => {
  const okExec = (stdout: string): ExecFn => vi.fn(async () => ({ stdout, stderr: '' }));
  const cli = (exec: ExecFn, extra: Partial<Parameters<typeof createCliAdapter>[0]> = {}) => createCliAdapter({ cliPath: CLI, mechanism: allCli, exec, scrub: (s) => s, ...extra });
  const reject = (code: number, stderr: string, stdout = ''): ExecFn => async () => Promise.reject(Object.assign(new Error('x'), { code, stdout, stderr }));

  test('reads recent requests without using the combined request dump envelope', async () => {
    // 合成记录；`dump recent` 的 { requests: [...] } 外层见随包技能 §1.2（requests 载荷）。
    const record = { id: 42, remoteHost: 'verify.example.test', processPath: '/Applications/Safari.app/Contents/MacOS/Safari', method: 'HTTPS', startDate: 1760000000, completed: true, failed: false };
    const exec: ExecFn = vi.fn(async (_file, args) => ({
      stdout: JSON.stringify(args.join(' ') === '--raw dump recent'
        ? { requests: [record] }
        : { 'active-requests': [], 'recent-requests': [record], replica: 0, 'persistent-store': null }),
      stderr: '',
    }));
    const adapter = createCliAdapter({ cliPath: CLI, mechanism: { listRecentRequests: 'cli' }, exec, scrub: (s) => s });
    await expect(adapter.listRecentRequests()).resolves.toMatchObject([{ id: '42', remoteHost: 'verify.example.test', completed: true }]);
  });

  test('getVersion reads `--raw version` and keeps only app version, build, core version and controller protocol', async () => {
    const raw = { version: '6.10.0', build: '12500', 'core-version': 6100, 'controller-protocol': 24, 'system-version': '26.0.1', 'device-name': 'Example Mac', 'device-identifier': 'EXAMPLE-DEVICE-ID' };
    const exec = okExec(JSON.stringify(raw));
    const v = await cli(exec).getVersion();
    expect(v).toEqual({ version: '6.10.0', build: '12500', coreVersion: 6100, controllerProtocol: 24 });
    expect(JSON.stringify(v)).not.toMatch(/26\.0\.1|Example Mac|EXAMPLE-DEVICE-ID/);
    expect(exec).toHaveBeenCalledWith(CLI, ['--raw', 'version'], expect.anything());
    // 数字构建号也接受
    await expect(cli(okExec(JSON.stringify({ ...raw, build: 12500 }))).getVersion()).resolves.toMatchObject({ build: '12500' });
  });

  test.each([
    ['a non-numeric controller protocol', { version: '6.10.0', build: '12500', 'core-version': 6100, 'controller-protocol': '24' }],
    ['a missing core version', { version: '6.10.0', build: '12500', 'controller-protocol': 24 }],
    ['a missing build', { version: '6.10.0', 'core-version': 6100, 'controller-protocol': 24 }],
    ['a connection address instead of a version', { version: '127.0.0.1', build: '12500', 'core-version': 6100, 'controller-protocol': 24 }],
    ['the rendered form', 'Surge 6.10.0 (12500)\nCore: 6100\nController Protocol: 24'],
  ])('getVersion fails closed on %s without echoing the output', async (_name, raw) => {
    const err = (await cli(okExec(typeof raw === 'string' ? raw : JSON.stringify({ ...raw, 'device-name': 'Example Mac' }))).getVersion().catch((e: unknown) => e)) as SfeError;
    expect(err).toMatchObject({ code: 'SURGE_COMMAND_FAILED', message: '读取Surge 版本失败：Surge 输出格式无法识别' });
    expect(JSON.stringify(err.details ?? {})).not.toContain('Example Mac');
  });

  test('version on a CLI without the command (6.5 interactive banner, or Unknown command) is an unsupported command', async () => {
    const banner = okExec('No command is provided, enter interactive mode.\nTips: Use surge-cli --help to show available commands.\nConnected to 127.0.0.1\n> ');
    const e1 = await cli(banner).getVersion().catch((e: unknown) => e);
    expect(isUnsupportedCommandError(e1)).toBe(true);
    const e2 = await cli(reject(1, 'Unknown command: version\nUse --help to list commands, or --raw to send it to the controller unvalidated.\n')).getVersion().catch((e: unknown) => e);
    expect(e2).toMatchObject({ code: 'SURGE_COMMAND_FAILED', message: '执行 Surge 命令失败：当前 Surge 不支持该命令（Unknown command）', details: { primitive: 'getVersion', reason: 'unsupported_command' } });
    expect(isUnsupportedCommandError(e2)).toBe(true);
    expect(isUnsupportedCommandError(new SfeError('SURGE_UNREACHABLE', 'x'))).toBe(false);
  });

  test('current profile comes from `--raw status`: name and the absolute profile-path; no path means null', async () => {
    const status = { profile: '日常-Safari环境', 'profile-path': '/Users/example/Library/Application Support/Surge/Profiles/日常-Safari环境.conf', mode: 'rule', 'start-time': 1760000000 };
    await expect(cli(okExec(JSON.stringify(status))).getCurrentProfile()).resolves.toEqual({ name: '日常-Safari环境', path: status['profile-path'] });
    await expect(cli(okExec(JSON.stringify({ profile: 'Managed' }))).getCurrentProfile()).resolves.toEqual({ name: 'Managed', path: null });
    for (const bad of [{ 'profile-path': '/x.conf' }, { profile: '', 'profile-path': '/x.conf' }, { profile: 'x', 'profile-path': 'relative.conf' }, { profile: 'x', 'profile-path': 3 }]) {
      await expect(cli(okExec(JSON.stringify(bad))).getCurrentProfile(), JSON.stringify(bad)).rejects.toMatchObject({ code: 'SURGE_COMMAND_FAILED' });
    }
  });

  test('takeover state reads feature get enhanced-mode, feature get system-proxy and mode get in order; any failure fails the whole read', async () => {
    const replies: Record<string, string> = {
      '--raw feature get enhanced-mode': JSON.stringify({ feature: 'enhanced-mode', enabled: true }),
      '--raw feature get system-proxy': JSON.stringify({ enabled: false }),
      '--raw mode get': JSON.stringify({ mode: 'rule' }),
    };
    const calls: string[] = [];
    const exec: ExecFn = async (_f, args) => {
      calls.push(args.join(' '));
      return { stdout: replies[args.join(' ')] ?? '', stderr: '' };
    };
    const a = cli(exec, { now: () => new Date('2026-10-22T01:02:03Z') });
    expect(await a.getTakeoverState()).toEqual({ enhancedMode: true, systemProxy: false, outboundMode: 'rule', checkedAt: '2026-10-22T01:02:03.000Z' });
    expect(calls).toEqual(Object.keys(replies));
    // 名称不符、缺少 enabled、命令失败：整体失败（引擎把读取失败当作接管状态未知）
    replies['--raw feature get enhanced-mode'] = JSON.stringify({ feature: 'system-proxy', enabled: true });
    await expect(a.getTakeoverState()).rejects.toMatchObject({ code: 'SURGE_COMMAND_FAILED' });
    replies['--raw feature get enhanced-mode'] = JSON.stringify({ state: 'on' });
    await expect(a.getTakeoverState()).rejects.toMatchObject({ code: 'SURGE_COMMAND_FAILED' });
    replies['--raw feature get enhanced-mode'] = JSON.stringify({ enabled: true });
    replies['--raw mode get'] = JSON.stringify({ mode: 'gateway' });
    await expect(a.getTakeoverState()).resolves.toMatchObject({ outboundMode: null });
    const failing: ExecFn = async (_f, args) => {
      if (args.includes('system-proxy')) throw Object.assign(new Error('x'), { code: 1, stdout: '', stderr: "Surge isn't running on the local machine. Use --remote to specify a remote target." });
      return { stdout: replies[args.join(' ')] ?? '', stderr: '' };
    };
    await expect(cli(failing).getTakeoverState()).rejects.toMatchObject({ code: 'SURGE_UNREACHABLE' });
  });

  test('runtime info: engine uptime from `--raw dump performance`, start time = now − uptime to the second', async () => {
    const exec = okExec(JSON.stringify({ 'memory-bytes': 1, uptime: 3725, 'dns-cache-entries': 2, 'virtual-ip-entries': 0, 'temporary-rules': 1, 'active-bans': 0 }));
    const info = await cli(exec, { now: () => new Date('2026-10-22T10:00:00.700Z') }).getRuntimeInfo();
    expect(info).toEqual({ uptimeSeconds: 3725, startedAt: new Date('2026-10-22T08:57:55.000Z') });
    for (const bad of [{}, { uptime: -1 }, { uptime: '1h' }]) {
      await expect(cli(okExec(JSON.stringify(bad))).getRuntimeInfo()).rejects.toMatchObject({ code: 'SURGE_COMMAND_FAILED' });
    }
  });

  test('policy groups: selection from `policy-group get`, members from `policy-group list`', async () => {
    const group = { name: 'SFE-ROUTE', type: 'select', selected: 'SFE-N-E0001-US01-v001', options: [{ name: 'REJECT', typeDescription: 'Reject' }, { name: 'SFE-N-E0001-US01-v001', typeDescription: 'SOCKS5', lineHash: 'POLICY::x' }] };
    const exec: ExecFn = async (_f, args) => ({
      stdout: JSON.stringify(args.includes('list') ? { groups: [{ name: 'Daily', selected: 'Front-A', options: [{ name: 'Front-A' }] }, group] } : { group }),
      stderr: '',
    });
    const a = cli(exec);
    expect(await a.getGroupSelection('SFE-ROUTE')).toBe('SFE-N-E0001-US01-v001');
    expect(await a.getGroupMembers('SFE-ROUTE')).toEqual(['REJECT', 'SFE-N-E0001-US01-v001']);
    await expect(a.getGroupMembers('Missing')).rejects.toMatchObject({ code: 'SURGE_COMMAND_FAILED', message: '读取策略组失败：组不存在' });
    // 自动组没有覆盖：selected 为 null
    await expect(cli(okExec(JSON.stringify({ group: { ...group, selected: null } }))).getGroupSelection('SFE-ROUTE')).resolves.toBeNull();
    // 另一组的回答、无法识别的成员、没有名称的组都失败即关闭
    await expect(cli(okExec(JSON.stringify({ group: { ...group, name: 'Daily' } }))).getGroupSelection('SFE-ROUTE')).rejects.toMatchObject({ code: 'SURGE_COMMAND_FAILED' });
    await expect(cli(okExec(JSON.stringify({ groups: [{ ...group, options: [{ name: 'REJECT' }, { policy: 'x' }] }] }))).getGroupMembers('SFE-ROUTE')).rejects.toThrow(/无法识别/);
    await expect(cli(okExec(JSON.stringify({ groups: [{ options: [] }] }))).getGroupMembers('SFE-ROUTE')).rejects.toThrow(/无法识别/);
  });

  test('selecting a policy runs `policy-group set SFE-ROUTE <node>` without --raw; other groups and auto never run', async () => {
    const exec = okExec('New selected policy: SFE-N-E0001-US01-v001\n');
    const a = cli(exec);
    await a.selectGroupPolicy('SFE-ROUTE', 'SFE-N-E0001-US01-v001');
    expect(exec).toHaveBeenCalledWith(CLI, ['policy-group', 'set', 'SFE-ROUTE', 'SFE-N-E0001-US01-v001'], expect.anything());
    await expect(a.selectGroupPolicy('Daily', 'DIRECT')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(a.selectGroupPolicy('SFE-ROUTE', 'auto')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(exec).toHaveBeenCalledTimes(1);
  });

  test('temp rule writes use `rule temp add|remove <rule>` without --raw; exit 0 is success', async () => {
    const exec = okExec('success\n');
    const a = cli(exec);
    await a.addTempRule(SAMPLE_RULE);
    await a.removeTempRule(SAMPLE_RULE);
    expect((exec as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1])).toEqual([
      ['rule', 'temp', 'add', SAMPLE_RULE],
      ['rule', 'temp', 'remove', SAMPLE_RULE],
    ]);
  });

  test('kill ends one connection by numeric id', async () => {
    const exec = okExec('');
    const a = cli(exec);
    await a.killRequest('42');
    expect(exec).toHaveBeenCalledWith(CLI, ['kill', '42'], expect.anything());
    await expect(a.killRequest('all')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(exec).toHaveBeenCalledTimes(1);
  });

  test('rule match returns the matched rule and final policy (rule text scrubbed)', async () => {
    const exec = okExec(JSON.stringify({ rule: 'RULE-SET,sfe-entry-udp.list,REJECT', policy: 'REJECT' }));
    const a = createCliAdapter({ cliPath: CLI, mechanism: allCli, exec, scrub: (s) => s.replace('udp', '***') });
    expect(await a.matchRule({ host: FAKE_VERIFY_HOST, processPath: FAKE_SAFARI_PATH, protocol: 'UDP' })).toEqual({ rule: 'RULE-SET,sfe-entry-***.list,REJECT', policy: 'REJECT' });
    expect(exec).toHaveBeenCalledWith(CLI, ['--raw', 'rule', 'match', FAKE_VERIFY_HOST, `process-path=${FAKE_SAFARI_PATH}`, 'protocol=UDP', 'dest-port=443'], expect.anything());
    for (const bad of [{ rule: 'FINAL,DIRECT' }, { policy: 'DIRECT' }, { rule: null, policy: 'DIRECT' }]) {
      await expect(cli(okExec(JSON.stringify(bad))).matchRule({ host: FAKE_VERIFY_HOST, processPath: FAKE_SAFARI_PATH })).rejects.toMatchObject({ code: 'SURGE_COMMAND_FAILED' });
    }
  });

  test('external resource update distinguishes downloaded from skipped; local resources are never a refresh', async () => {
    const key = 'policy-path:sfe-nodes.list';
    await expect(cli(okExec(`${key}: success\n`)).updateExternalResource(key)).resolves.toEqual({ key, refreshed: true, outcome: 'downloaded' });
    await expect(cli(okExec('No remote external resource needed updating.\n')).updateExternalResource(key)).resolves.toEqual({ key, refreshed: false, outcome: 'skipped' });
    const failed = (await cli(okExec(`${key}: fetch https://u:p@rules.example.test/a?token=zz failed`)).updateExternalResource(key).catch((e: unknown) => e)) as SfeError;
    expect(failed.code).toBe('SURGE_COMMAND_FAILED');
    expect(failed.message).not.toContain('token=zz');
    // 其他 key 的结果、多行、空输出、旧的“退出 0 即成功”都不是刷新
    for (const stdout of ['other-key: success', `${key}: success\nother-key: success`, '', 'Updated.']) {
      await expect(cli(okExec(stdout)).updateExternalResource(key), stdout).rejects.toThrow(/读取外部资源更新结果失败/);
    }
  });

  test('uses execFile with fixed argv and returns parsed output', async () => {
    const exec = okExec('[]');
    const a = cli(exec);
    expect(await a.listTempRules()).toEqual([]);
    expect(exec).toHaveBeenCalledWith(CLI, ['--raw', 'dump', 'temp-rule'], expect.objectContaining({ timeout: 15000 }));
  });

  test('primitives not mapped to cli are CAPABILITY_UNVERIFIED and never executed', async () => {
    const exec = okExec('');
    const a = createCliAdapter({ cliPath: CLI, mechanism: { ...allCli, addTempRule: 'http' }, exec, scrub: (s) => s });
    await expect(a.addTempRule('DOMAIN,a.example.test,REJECT')).rejects.toMatchObject({ code: 'CAPABILITY_UNVERIFIED' });
    await expect(a.getAutoReloadSetting()).rejects.toMatchObject({ code: 'CAPABILITY_UNVERIFIED' });
    await expect(a.getPolicyDetail('x')).rejects.toMatchObject({ code: 'CAPABILITY_UNVERIFIED' });
    expect(exec).not.toHaveBeenCalled();
  });

  test('ENOENT and timeouts are SURGE_UNREACHABLE', async () => {
    const enoent: ExecFn = async () => Promise.reject(Object.assign(new Error('spawn x ENOENT'), { code: 'ENOENT' }));
    const timeout: ExecFn = async () => Promise.reject(Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM', code: null }));
    await expect(cli(enoent).listTempRules()).rejects.toMatchObject({ code: 'SURGE_UNREACHABLE' });
    await expect(cli(timeout).listTempRules()).rejects.toMatchObject({ code: 'SURGE_UNREACHABLE' });
  });

  test('non-zero exit is SURGE_COMMAND_FAILED with scrubbed, truncated stderr', async () => {
    const stderr = `error: Front-A = socks5, 192.0.2.10, 1080, username=exampleU, password=exampleP0 at https://u:p@x.example.test/a?token=zz ${'x'.repeat(500)}`;
    const exec: ExecFn = async () => Promise.reject(Object.assign(new Error('Command failed'), { code: 2, stdout: '', stderr }));
    const scrub = vi.fn((s: string) => s.replace(/MARK/g, '***'));
    const err = (await createCliAdapter({ cliPath: CLI, mechanism: allCli, exec, scrub }).updateExternalResource('policy-path:sfe-nodes.list').catch((e: unknown) => e)) as SfeError;
    expect(err.code).toBe('SURGE_COMMAND_FAILED');
    expect(err.message).not.toContain('exampleP0');
    expect(err.message).not.toContain('exampleU');
    expect(err.message).not.toContain('token=zz');
    expect(err.message.length).toBeLessThan(300);
    expect(scrub).toHaveBeenCalled();
  });

  test.each([
    'Surge is not running',
    "Surge isn't running on the local machine. Use --remote to specify a remote target.",
    'Surge isn’t running on the local machine.',
    'The controller connection timed out after 60 seconds.',
    'The controller command timed out after 60 seconds without progress.',
    'The controller connection was closed',
    'The connection interrupted unexpectedly: EOF',
    'Surge CLI is not connected.',
  ])('connection failure text %j maps to SURGE_UNREACHABLE (non-zero exit and exit 0)', async (text) => {
    await expect(cli(reject(1, `${text}\n`)).listTempRules()).rejects.toMatchObject({ code: 'SURGE_UNREACHABLE' });
    await expect(cli(async () => ({ stdout: '', stderr: text })).listTempRules()).rejects.toMatchObject({ code: 'SURGE_UNREACHABLE' });
  });

  test('Unknown command is an unsupported command (fail closed), never unreachable and never a check result or a write', async () => {
    const unknown = 'Unknown command: rule\nUse --help to list commands, or --raw to send it to the controller unvalidated.\n';
    const expected = { code: 'SURGE_COMMAND_FAILED', details: { reason: 'unsupported_command' } };
    await expect(cli(reject(1, unknown)).addTempRule(SAMPLE_RULE)).rejects.toMatchObject(expected);
    await expect(cli(reject(1, unknown)).checkProfile('/tmp/c.conf')).rejects.toMatchObject(expected);
    await expect(cli(async () => ({ stdout: '', stderr: unknown })).addTempRule(SAMPLE_RULE)).rejects.toMatchObject(expected);
    await expect(cli(async () => ({ stdout: 'Unknown command: rule', stderr: '' })).checkProfile('/tmp/c.conf')).rejects.toMatchObject(expected);
    // 旧核心经 --raw 回答的错误外层
    await expect(cli(okExec(JSON.stringify({ error: 'Unknown command' }))).listTempRules()).rejects.toMatchObject(expected);
    // 数据中恰好含有这些词不是错误
    await expect(cli(okExec(JSON.stringify(['DOMAIN,unknown command.example.test,REJECT']))).listTempRules()).resolves.toEqual(['DOMAIN,unknown command.example.test,REJECT']);
  });

  test('exit 0 with an error envelope is a command failure, not a result', async () => {
    await expect(cli(okExec(JSON.stringify({ error: 'Invalid parameter' }))).listRules()).rejects.toMatchObject({ code: 'SURGE_COMMAND_FAILED', message: '执行 Surge 命令失败：Invalid parameter' });
  });

  test('--check non-zero exit is a normal failed check result', async () => {
    const exec: ExecFn = async () => Promise.reject(Object.assign(new Error('x'), { code: 1, stdout: 'Line 3: password=exampleP0 invalid', stderr: '' }));
    const r = await cli(exec).checkProfile('/tmp/c.conf');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('password=***');
  });

  test('argv injection is refused before executing', async () => {
    const exec = okExec('');
    const a = cli(exec);
    await expect(a.updateExternalResource('--all')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(a.updateExternalResource('all')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(a.addTempRule('DOMAIN,a\nFINAL,DIRECT')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(a.getGroupSelection('--raw')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('verifyCliPath', () => {
  const realpath = async (p: string) => p;
  test('non-darwin is unverifiable', async () => {
    expect(await verifyCliPath(CLI, { realpath, runCodesign: async () => ({ code: 0, stderr: '' }), teamId: null, platform: 'linux' })).toEqual({ ok: false, reason: 'unverifiable' });
  });
  test('path outside the Surge bundle is refused', async () => {
    const r = await verifyCliPath('/usr/local/bin/surge-cli', { realpath, runCodesign: async () => ({ code: 0, stderr: '' }), teamId: null, platform: 'darwin' });
    expect(r).toEqual({ ok: false, reason: 'outside_bundle' });
  });
  test('symlink resolving outside the bundle is refused', async () => {
    const r = await verifyCliPath(CLI, { realpath: async () => '/tmp/evil', runCodesign: async () => ({ code: 0, stderr: '' }), teamId: null, platform: 'darwin' });
    expect(r.reason).toBe('outside_bundle');
  });
  test('codesign with team requirement', async () => {
    const run = vi.fn(async () => ({ code: 0, stderr: '' }));
    expect(await verifyCliPath(CLI, { realpath, runCodesign: run, teamId: 'ABCDE12345', platform: 'darwin' })).toEqual({ ok: true, reason: 'verified' });
    expect(run).toHaveBeenCalledWith(codesignArgs(CLI, 'ABCDE12345'));
    expect(codesignArgs(CLI, 'ABCDE12345')).toEqual(['--verify', '--strict', '-R=anchor apple generic and certificate leaf[subject.OU] = "ABCDE12345"', CLI]);
  });
  test('failed signature or bad team id is refused', async () => {
    expect((await verifyCliPath(CLI, { realpath, runCodesign: async () => ({ code: 1, stderr: 'x' }), teamId: null, platform: 'darwin' })).reason).toBe('signature_invalid');
    expect((await verifyCliPath(CLI, { realpath, runCodesign: async () => ({ code: 0, stderr: '' }), teamId: 'x" or 1', platform: 'darwin' })).reason).toBe('invalid_team_id');
  });
});

describe('createHttpAdapter', () => {
  const KEY = 'example-http-key';
  type Call = { url: string; init: RequestInit };
  const fakeFetch = (routes: Record<string, unknown>, calls: Call[] = [], status = 200) =>
    (async (url: URL | string, init?: RequestInit) => {
      const u = new URL(String(url));
      calls.push({ url: `${u.pathname}${u.search}`, init: init ?? {} });
      const key = `${init?.method ?? 'GET'} ${u.pathname}`;
      const body = routes[key];
      return new Response(body === undefined ? '{}' : typeof body === 'string' ? body : JSON.stringify(body), { status });
    }) as unknown as typeof fetch;

  test.each(['http://192.0.2.1:6171', 'http://example.test:6171', 'http://0.0.0.0:6171', 'http://u:p@127.0.0.1:6171', 'ftp://127.0.0.1', 'not a url'])(
    'refuses non-loopback base %s at construction',
    (baseUrl) => {
      expect(() => createHttpAdapter({ baseUrl, getKey: async () => KEY, mechanism: allHttp, scrub: (s) => s })).toThrow(/回环|地址不正确/);
    },
  );

  test('loopback detection', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('127.1.2.3')).toBe(true);
    expect(isLoopbackHost('[::1]')).toBe(true);
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isLoopbackHost('192.0.2.1')).toBe(false);
  });

  test('sends X-Key, never in the URL', async () => {
    const calls: Call[] = [];
    const a = createHttpAdapter({ baseUrl: 'http://127.0.0.1:6171', getKey: async () => KEY, mechanism: allHttp, fetch: fakeFetch({ 'GET /v1/policy_groups/select': { policy: 'REJECT' } }, calls), scrub: (s) => s });
    expect(await a.getGroupSelection('SFE-ROUTE')).toBe('REJECT');
    expect(calls[0]!.url).toBe('/v1/policy_groups/select?group_name=SFE-ROUTE');
    expect((calls[0]!.init.headers as Record<string, string>)['X-Key']).toBe(KEY);
    expect(calls[0]!.url).not.toContain(KEY);
  });

  test('current profile returns the name only', async () => {
    const a = createHttpAdapter({
      baseUrl: 'http://127.0.0.1:6171',
      getKey: async () => KEY,
      mechanism: allHttp,
      fetch: fakeFetch({ 'GET /v1/profiles/current': { name: '日常-Safari环境', profile: '[Proxy]\nA = socks5, 192.0.2.1, 1080, password=exampleP1' } }),
      scrub: (s) => s,
    });
    expect(await a.getCurrentProfile()).toEqual({ name: '日常-Safari环境', path: null });
  });

  test('policy detail is parsed in memory and only a redacted line is returned', async () => {
    const line = 'SFE-N-E0001-US01-v001 = socks5, 203.0.113.10, 1080, username=exampleU1, password=exampleP1, underlying-proxy=Front-A';
    const a = createHttpAdapter({ baseUrl: 'http://127.0.0.1:6171', getKey: async () => KEY, mechanism: allHttp, fetch: fakeFetch({ 'GET /v1/policies/detail': { 'SFE-N-E0001-US01-v001': line } }), scrub: (s) => s });
    const d = await a.getPolicyDetail('SFE-N-E0001-US01-v001');
    expect(d).toMatchObject({ type: 'socks5', server: '203.0.113.10', port: 1080, underlyingProxy: 'Front-A' });
    expect(JSON.stringify(d)).not.toContain('exampleP1');
    expect(JSON.stringify(d)).not.toContain('exampleU1');
  });

  test('takeover state, members, rules, requests and kill', async () => {
    const calls: Call[] = [];
    const a = createHttpAdapter({
      baseUrl: 'http://127.0.0.1:6171',
      getKey: async () => KEY,
      mechanism: allHttp,
      now: () => new Date('2026-10-21T00:00:00Z'),
      fetch: fakeFetch(
        {
          'GET /v1/features/enhanced_mode': { enabled: true },
          'GET /v1/features/system_proxy': { enabled: false },
          'GET /v1/outbound': { mode: 'rule' },
          'GET /v1/policy_groups': { 'SFE-ROUTE': [{ name: 'REJECT' }, { name: 'SFE-N-E0001-US01-v001' }] },
          'GET /v1/rules': { rules: ['RULE-SET,sfe-entry-udp.list,REJECT', 'FINAL,DIRECT'] },
          'GET /v1/requests/active': {
            requests: [{ id: 12, processPath: '/Applications/Safari.app/Contents/MacOS/Safari', remoteHost: 'verify.example.test:443', policyName: 'SFE-ROUTE', rule: 'x', startDate: 1760000000.5, completed: false, failed: false, method: 'HTTPS', URL: 'https://verify.example.test/?sfe_test=abc' }],
          },
          'POST /v1/policies/test': { 'SFE-ROUTE': { tcp: 35, receive: 80 } },
        },
        calls,
      ),
      scrub: (s) => s,
    });
    expect(await a.getTakeoverState()).toEqual({ enhancedMode: true, systemProxy: false, outboundMode: 'rule', checkedAt: '2026-10-21T00:00:00.000Z' });
    expect(await a.getGroupMembers('SFE-ROUTE')).toEqual(['REJECT', 'SFE-N-E0001-US01-v001']);
    expect((await a.listRules()).map((r) => r.text)).toEqual(['RULE-SET,sfe-entry-udp.list,REJECT', 'FINAL,DIRECT']);
    const reqs = await a.listActiveRequests();
    expect(reqs[0]).toMatchObject({ id: '12', remoteHost: 'verify.example.test', protocol: 'tcp', completed: false });
    expect(JSON.stringify(reqs)).not.toContain('sfe_test');
    await a.killRequest('12');
    expect(JSON.parse(String(calls.at(-1)!.init.body))).toEqual({ id: 12 });
    expect(await a.testPolicy('SFE-ROUTE', 'https://verify.example.test/')).toEqual({ ok: true, latencyMs: 80, error: null });
  });

  test.each([
    ['an unrecognised rule item', { 'GET /v1/rules': { rules: ['FINAL,DIRECT', { ruleString: 'DOMAIN,a.example.test,DIRECT' }] } }, 'listRules'],
    ['an empty rule list', { 'GET /v1/rules': { rules: [] } }, 'listRules'],
    ['an unrecognised group member', { 'GET /v1/policy_groups': { 'SFE-ROUTE': [{ name: 'REJECT' }, { policy: 'SFE-N-E0001-US01-v001' }] } }, 'getGroupMembers'],
  ] as const)('HTTP lists fail closed on %s instead of dropping it', async (_name, routes, primitive) => {
    const a = createHttpAdapter({
      baseUrl: 'http://127.0.0.1:6171',
      getKey: async () => KEY,
      mechanism: allHttp,
      fetch: fakeFetch(routes as Record<string, unknown>, []),
      scrub: (s) => s,
    });
    const run = primitive === 'listRules' ? a.listRules() : a.getGroupMembers('SFE-ROUTE');
    await expect(run).rejects.toMatchObject({ code: 'SURGE_COMMAND_FAILED' });
  });

  test('temp rules, rule match and the version have no HTTP endpoint: unverified without a request', async () => {
    const fetchSpy = vi.fn();
    const a = createHttpAdapter({ baseUrl: 'http://127.0.0.1:6171', getKey: async () => KEY, mechanism: allHttp, fetch: fetchSpy as unknown as typeof fetch, scrub: (s) => s });
    for (const p of ['listTempRules', 'addTempRule', 'removeTempRule', 'matchRule', 'getVersion', 'getAutoReloadSetting', 'checkProfile'] as const) {
      await expect((a[p] as (...x: unknown[]) => Promise<unknown>)('x')).rejects.toMatchObject({ code: 'CAPABILITY_UNVERIFIED' });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('external resources (Mac 6.10.0+): list with local/updating/fromModule, update one key with a structured result', async () => {
    const calls: Call[] = [];
    const defines = [
      { path: '/Users/example/Surge/sfe-nodes.list', type: 'policy-group', key: 'k-local', local: true, ready: true, updating: false, fromModule: null },
      { path: 'https://rules.example.test/a.list', type: 'ruleset', key: 'k-remote', local: false, ready: true, updatedAt: 1759800000, updating: true, fromModule: 'Mod' },
    ];
    const a = createHttpAdapter({
      baseUrl: 'http://127.0.0.1:6171',
      getKey: async () => KEY,
      mechanism: allHttp,
      fetch: fakeFetch({ 'GET /v1/external_resources': { defines }, 'POST /v1/external_resources/update': { 'k-remote': 'success' } }, calls),
      scrub: (s) => s,
    });
    expect(await a.listExternalResources()).toEqual([
      { key: 'k-local', type: 'policy-group', location: '/Users/example/Surge/sfe-nodes.list', lastUpdatedAt: null, error: null, local: true, updating: false, fromModule: null },
      { key: 'k-remote', type: 'ruleset', location: 'https://rules.example.test/a.list', lastUpdatedAt: new Date(1759800000 * 1000), error: null, local: false, updating: true, fromModule: 'Mod' },
    ]);
    expect(await a.updateExternalResource('k-remote')).toEqual({ key: 'k-remote', refreshed: true, outcome: 'downloaded' });
    expect(JSON.parse(String(calls.at(-1)!.init.body))).toEqual({ key: 'k-remote' });
    await expect(a.updateExternalResource('all')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(calls).toHaveLength(2);
  });

  test.each([
    ['an empty map (local resources are skipped)', {}, 200, { refreshed: false, outcome: 'skipped' }],
    ['an error message for the key', { k: 'download failed: https://u:p@rules.example.test/a?token=zz' }, 200, 'SURGE_COMMAND_FAILED'],
    ['a map for another key', { other: 'success' }, 200, 'SURGE_COMMAND_FAILED'],
    ['a 400 for an unknown key', { error: 'not found' }, 400, 'SURGE_COMMAND_FAILED'],
  ] as const)('HTTP update result: %s', async (_name, body, status, expected) => {
    const a = createHttpAdapter({ baseUrl: 'http://127.0.0.1:6171', getKey: async () => KEY, mechanism: allHttp, fetch: fakeFetch({ 'POST /v1/external_resources/update': body }, [], status), scrub: (s) => s });
    if (typeof expected === 'string') {
      const err = (await a.updateExternalResource('k').catch((e: unknown) => e)) as SfeError;
      expect(err.code).toBe(expected);
      expect(err.message).not.toContain('token=zz');
    } else {
      await expect(a.updateExternalResource('k')).resolves.toEqual({ key: 'k', ...expected });
    }
  });

  test('engine uptime from /v1/metrics surge_uptime_seconds (plain text)', async () => {
    const metrics = '# HELP surge_uptime_seconds Engine uptime\n# TYPE surge_uptime_seconds gauge\nsurge_build_info{version="6.10.0",build="12500"} 1\nsurge_uptime_seconds 3600\n';
    const a = createHttpAdapter({ baseUrl: 'http://127.0.0.1:6171', getKey: async () => KEY, mechanism: allHttp, now: () => new Date('2026-10-22T10:00:00.400Z'), fetch: fakeFetch({ 'GET /v1/metrics': metrics }), scrub: (s) => s });
    expect(await a.getRuntimeInfo()).toEqual({ uptimeSeconds: 3600, startedAt: new Date('2026-10-22T09:00:00.000Z') });
    const missing = createHttpAdapter({ baseUrl: 'http://127.0.0.1:6171', getKey: async () => KEY, mechanism: allHttp, fetch: fakeFetch({ 'GET /v1/metrics': '# nothing\n' }), scrub: (s) => s });
    await expect(missing.getRuntimeInfo()).rejects.toMatchObject({ code: 'SURGE_COMMAND_FAILED' });
  });

  test('HTTP writes are limited like the CLI: SFE-ROUTE only, never auto; kill by one numeric id', async () => {
    const fetchSpy = vi.fn();
    const a = createHttpAdapter({ baseUrl: 'http://127.0.0.1:6171', getKey: async () => KEY, mechanism: allHttp, fetch: fetchSpy as unknown as typeof fetch, scrub: (s) => s });
    await expect(a.selectGroupPolicy('Daily', 'DIRECT')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(a.selectGroupPolicy('SFE-ROUTE', 'auto')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(a.killRequest('abc')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('errors never echo the key and bodies are scrubbed', async () => {
    const body = `bad key ${KEY} password=exampleP2`;
    const a = createHttpAdapter({ baseUrl: 'http://127.0.0.1:6171', getKey: async () => KEY, mechanism: allHttp, fetch: fakeFetch({ 'GET /v1/policies': body }, [], 500), scrub: (s) => s });
    const err = (await a.listPolicies().catch((e: unknown) => e)) as SfeError;
    expect(err.code).toBe('SURGE_COMMAND_FAILED');
    expect(err.message).not.toContain(KEY);
    expect(err.message).not.toContain('exampleP2');
  });

  test('network failures are SURGE_UNREACHABLE; 401 is a command failure without details', async () => {
    const boom = (async () => {
      throw new Error(`connect ECONNREFUSED ${KEY}`);
    }) as unknown as typeof fetch;
    const a = createHttpAdapter({ baseUrl: 'http://127.0.0.1:6171', getKey: async () => KEY, mechanism: allHttp, fetch: boom, scrub: (s) => s });
    const err = (await a.listPolicies().catch((e: unknown) => e)) as SfeError;
    expect(err.code).toBe('SURGE_UNREACHABLE');
    expect(err.message).not.toContain(KEY);
    const b = createHttpAdapter({ baseUrl: 'http://127.0.0.1:6171', getKey: async () => KEY, mechanism: allHttp, fetch: fakeFetch({}, [], 401), scrub: (s) => s });
    await expect(b.listPolicies()).rejects.toMatchObject({ code: 'SURGE_COMMAND_FAILED', message: '调用 Surge HTTP API 失败：认证被拒绝' });
  });

  test('primitives not mapped to http are refused without a request', async () => {
    const fetchSpy = vi.fn();
    const a = createHttpAdapter({ baseUrl: 'http://127.0.0.1:6171', getKey: async () => KEY, mechanism: { ...allHttp, selectGroupPolicy: 'cli' }, fetch: fetchSpy as unknown as typeof fetch, scrub: (s) => s });
    await expect(a.selectGroupPolicy('SFE-ROUTE', 'REJECT')).rejects.toMatchObject({ code: 'CAPABILITY_UNVERIFIED' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('parseHttpApiLine', () => {
  test('reads key, host, port and loopback flag from [General]', () => {
    expect(parseHttpApiLine('[General]\nhttp-api = example-key@127.0.0.1:6171\n')).toEqual({ key: 'example-key', host: '127.0.0.1', port: 6171, loopbackOnly: true });
    expect(parseHttpApiLine('[General]\nhttp-api = example-key@0.0.0.0:6171\n')?.loopbackOnly).toBe(false);
    expect(parseHttpApiLine('[General]\nhttp-api = my-key@part@[::1]:6171\n')).toEqual({ key: 'my-key@part', host: '::1', port: 6171, loopbackOnly: true });
  });
  test('ignores other sections and malformed values', () => {
    expect(parseHttpApiLine('[Rule]\nhttp-api = example-key@127.0.0.1:6171\n')).toBeNull();
    expect(parseHttpApiLine('[General]\nhttp-api = 127.0.0.1:6171\n')).toBeNull();
    expect(parseHttpApiLine('[General]\nhttp-api = example-key@127.0.0.1:99999\n')).toBeNull();
    expect(parseHttpApiLine('[General]\n')).toBeNull();
  });
});

describe('createCompositeAdapter', () => {
  const stub = (tag: string): SurgeAdapter =>
    Object.fromEntries([['mechanism', () => ({})], ...SURGE_PRIMITIVES.map((p) => [p, vi.fn(async () => tag)])]) as unknown as SurgeAdapter;

  test('routes each primitive statically and never falls back', async () => {
    const cli = stub('cli');
    const http = stub('http');
    const mechanism: MechanismMap = { listTempRules: 'cli', listRules: 'http', getVersion: 'unavailable' };
    const c = createCompositeAdapter({ cli, http, mechanism });
    expect(await c.listTempRules()).toBe('cli');
    expect(await c.listRules()).toBe('http');
    await expect(c.getVersion()).rejects.toMatchObject({ code: 'CAPABILITY_UNVERIFIED' });
    await expect(c.listPolicies()).rejects.toMatchObject({ code: 'CAPABILITY_UNVERIFIED' });
    expect(c.mechanism()).toEqual(mechanism);
  });

  test('a failure in the chosen implementation is not retried elsewhere', async () => {
    const cli = stub('cli');
    (cli.listTempRules as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new SfeError('SURGE_COMMAND_FAILED', 'x'));
    const http = stub('http');
    const c = createCompositeAdapter({ cli, http, mechanism: { listTempRules: 'cli' } });
    await expect(c.listTempRules()).rejects.toMatchObject({ code: 'SURGE_COMMAND_FAILED' });
    expect(http.listTempRules).not.toHaveBeenCalled();
  });

  test('missing implementation for a mapped mechanism is unverified', async () => {
    const c = createCompositeAdapter({ mechanism: { listTempRules: 'cli' } });
    await expect(c.listTempRules()).rejects.toMatchObject({ code: 'CAPABILITY_UNVERIFIED' });
  });
});
