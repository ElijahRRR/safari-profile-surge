import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SfeError } from '@sfe/contract';
import { describe, expect, it } from 'vitest';
import { FAKE_CHROME_PATH, FAKE_SAFARI_PATH, FakeSurge, createFakeSurgeEnvironment, isAllowedCliArgv, type SurgeExternalResource } from '../src/deps.js';
import {
  ACTIVE_PRIMITIVES,
  CLI_HELP_TOPICS,
  HTTP_NOT_IMPLEMENTED,
  READ_PRIMITIVES,
  classifyTopicHelp,
  cliArgvsAllowed,
  cliAvailability,
  cliLiteralWords,
  cliSampleArgvs,
  createGuardedAdapter,
  describeLocation,
  emptyGuard,
  helpTopicFile,
  helpWords,
  proposeMechanism,
  readCliVersion,
  resolveLocation,
  resourcesForPath,
  unionHelpWords,
  type CallLogEntry,
  type ProbeOutcome,
  type Primitive,
} from '../src/surge-access.js';
import { TOPIC_HELP_610, TOP_HELP_610 } from './support/help-610.js';

// 合成的帮助片段（形式参照 Surge Mac 6.10 的 `help rule temp`、`help dump`、`help external-resource`）。
const HELP = `Usage: surge-cli [options] <command>
  --check <path>            Check a profile
  --raw                     Output raw JSON
Commands:
  reload                    Reload the profile
  switch-profile <name>     Switch profile
  dump temp-rule            Dump temporary rules
  external-resource list    List external resources
  external-resource update <key>
  rule temp add <rule>      Add a temporary rule with the highest priority`;

describe('CLI help analysis', () => {
  it('extracts command words and options', () => {
    const w = helpWords(HELP);
    expect(w.has('--check')).toBe(true);
    expect(w.has('external-resource')).toBe(true);
    expect(w.has('temp-rule')).toBe(true);
    expect(w.has('dump')).toBe(true);
    expect(w.has('temp')).toBe(true);
  });

  it('maps primitives to availability without running anything', () => {
    const w = helpWords(HELP);
    expect(cliAvailability('checkProfile', w)).toBe('in_help');
    expect(cliAvailability('listExternalResources', w)).toBe('in_help');
    expect(cliAvailability('listTempRules', w)).toBe('in_help');
    expect(cliAvailability('addTempRule', w)).toBe('in_help');
    expect(cliAvailability('updateExternalResource', w)).toBe('in_help');
    // 6.10 映射的命令不在这段帮助中：不探测
    expect(cliAvailability('selectGroupPolicy', w)).toBe('not_in_help');
    expect(cliAvailability('killRequest', w)).toBe('not_in_help');
    expect(cliAvailability('getVersion', w)).toBe('not_in_help');
    expect(cliAvailability('matchRule', w)).toBe('not_in_help');
    expect(cliAvailability('removeTempRule', w)).toBe('not_in_help');
    // 没有 CLI 映射的原语
    expect(cliAvailability('getPolicyDetail', w)).toBe('not_in_table');
    expect(cliAvailability('getAutoReloadSetting', w)).toBe('not_in_table');
  });

  it('the literal words of the 6.10 commands come from the documented forms (key=value options by key)', () => {
    expect(cliLiteralWords('addTempRule')).toEqual(['rule', 'temp', 'add']);
    expect(cliLiteralWords('removeTempRule')).toEqual(['rule', 'temp', 'remove']);
    expect(cliLiteralWords('getVersion')).toEqual(['--raw', 'version']);
    expect(cliLiteralWords('getCurrentProfile')).toEqual(['--raw', 'status']);
    expect(cliLiteralWords('getTakeoverState')).toEqual(['--raw', 'feature', 'get', 'enhanced-mode', 'system-proxy', 'mode']);
    expect(cliLiteralWords('matchRule')).toEqual(['--raw', 'rule', 'match', 'process-path', 'protocol', 'dest-port']);
    expect(cliLiteralWords('selectGroupPolicy')).toEqual(['policy-group', 'set']);
    expect(cliLiteralWords('killRequest')).toEqual(['kill']);
    const help610 = `${HELP}\nUsage: rule <match|explain> <host|url> [port] [key=value ...]\n  process-path=<path>       Source process path\n  protocol=<name>           Protocol\n  dest-port=<0-65535>       Destination port\n  rule match example.com port=443`;
    expect(cliAvailability('matchRule', helpWords(help610))).toBe('in_help');
  });

  it('requires raw JSON support before proposing JSON read commands', () => {
    const w = helpWords(HELP);
    w.delete('--raw');
    expect(cliAvailability('listExternalResources', w)).toBe('not_in_help');
    expect(cliAvailability('listTempRules', w)).toBe('not_in_help');
  });

  it('every mapped primitive builds only allowlisted argv; global actions are never allowlisted', () => {
    for (const p of [...READ_PRIMITIVES, ...ACTIVE_PRIMITIVES]) {
      if (cliSampleArgvs(p as Primitive) === null) continue;
      expect(cliArgvsAllowed(p as Primitive), p).toBe(true);
    }
    for (const argv of [['switch-profile', 'x'], ['RELOAD'], ['reload'], ['restart-engine'], ['profile', 'switch', 'x'], ['external-resource', 'update', 'all'], ['rule', 'temp', 'flush']]) {
      expect(isAllowedCliArgv(argv), argv.join(' ')).toBe(false);
    }
  });

  it('tokenises the 6.10 help forms: --check/-c, a sentence-final enhanced-mode. and words inside <a | b>', () => {
    const w = helpWords('  --check/-c <path> - Check whether a profile is valid.\nmacOS also supports system-proxy and enhanced-mode.\nUsage: rule <match|explain> <host|url>\n');
    expect(w.has('--check')).toBe(true);
    expect(w.has('enhanced-mode')).toBe(true);
    expect(w.has('system-proxy')).toBe(true);
    expect(w.has('match')).toBe(true);
    // 路径中的片段不是命令词
    expect(helpWords('process-path=/usr/bin/curl').has('usr')).toBe(false);
  });

  it('6.10 top-level help lists only command groups; the per-command help union maps every CLI primitive to in_help', () => {
    const top = helpWords(TOP_HELP_610);
    // 顶层帮助（6.9.0 起按命令组）：--check/-c 可以识别，子命令与 dump 类型不在其中
    expect(cliAvailability('checkProfile', top)).toBe('in_help');
    for (const p of ['listTempRules', 'listActiveRequests', 'listRecentRequests', 'listPolicies', 'updateExternalResource', 'addTempRule', 'removeTempRule', 'getRuntimeInfo'] as const) {
      expect(cliAvailability(p, top), p).toBe('not_in_help');
    }
    expect(CLI_HELP_TOPICS.map((t) => t.join(' ')).sort()).toEqual(Object.keys(TOPIC_HELP_610).sort());
    const union = unionHelpWords([TOP_HELP_610, ...Object.values(TOPIC_HELP_610)]);
    for (const p of [...READ_PRIMITIVES, ...ACTIVE_PRIMITIVES]) {
      if (cliSampleArgvs(p as Primitive) === null) continue;
      expect(cliAvailability(p as Primitive, union), p).toBe('in_help');
    }
    expect(helpTopicFile(['rule', 'temp'])).toBe('rule-temp.txt');
  });

  it('a per-command help is used only when it exits 0 with output and is neither the interactive banner nor Unknown command', () => {
    expect(classifyTopicHelp({ stdout: TOPIC_HELP_610.kill!, stderr: '', code: 0 })).toBe('ok');
    expect(classifyTopicHelp({ stdout: 'No command is provided, enter interactive mode.\n> ', stderr: '', code: 0 })).toBe('interactive');
    expect(classifyTopicHelp({ stdout: '', stderr: 'Unknown command: help kill\nUse --help to list commands, or --raw to send it to the controller unvalidated.', code: 1 })).toBe('unsupported');
    expect(classifyTopicHelp({ stdout: TOPIC_HELP_610.kill!, stderr: '', code: 1 })).toBe('failed');
    expect(classifyTopicHelp({ stdout: '  ', stderr: '', code: 0 })).toBe('failed');
  });

  it('reads the CLI version for the cross-check: unsupported command, malformed and failing reads are told apart', async () => {
    const v = { version: '6.10.0', build: '12500', coreVersion: 6100, controllerProtocol: 24 };
    expect(await readCliVersion({ getVersion: async () => v })).toEqual(v);
    const unknown = new SfeError('SURGE_COMMAND_FAILED', 'x', { details: { primitive: 'getVersion', reason: 'unsupported_command' } });
    expect(await readCliVersion({ getVersion: async () => Promise.reject(unknown) })).toBe('unsupported');
    const banner = new SfeError('SURGE_COMMAND_FAILED', 'x', { details: { primitive: 'getVersion', reason: 'interactive_mode' } });
    expect(await readCliVersion({ getVersion: async () => Promise.reject(banner) })).toBe('unsupported');
    expect(await readCliVersion({ getVersion: async () => Promise.reject(new SfeError('SURGE_UNREACHABLE', 'x')) })).toBeNull();
    expect(await readCliVersion({ getVersion: async () => ({ ...v, controllerProtocol: '24' }) as never })).toBeNull();
  });

  it('HTTP-unimplemented primitives are the ones without a documented endpoint (6.10 external resources and metrics are implemented)', () => {
    expect([...HTTP_NOT_IMPLEMENTED].sort()).toEqual(['addTempRule', 'checkProfile', 'getAutoReloadSetting', 'getVersion', 'listTempRules', 'matchRule', 'removeTempRule']);
  });
});

describe('proposeMechanism', () => {
  const ok: ProbeOutcome = { status: 'ok', code: null };
  const err: ProbeOutcome = { status: 'error', code: 'SURGE_COMMAND_FAILED' };

  it('prefers CLI for readable primitives, then HTTP, else unavailable', () => {
    const p = proposeMechanism({ listExternalResources: ok, listTempRules: ok, listRules: err }, { listRules: ok, getCurrentProfile: ok }, {}, true);
    expect(p.mechanism.listExternalResources).toBe('cli');
    expect(p.mechanism.listRules).toBe('http');
    expect(p.mechanism.getVersion).toBe('unavailable');
  });

  it('assigns active primitives only where implemented and marks them unproven', () => {
    const p = proposeMechanism({}, { getCurrentProfile: ok }, { updateExternalResource: 'in_help', addTempRule: 'not_in_help', selectGroupPolicy: 'not_in_table' }, true);
    expect(p.mechanism.updateExternalResource).toBe('cli');
    expect(p.mechanism.selectGroupPolicy).toBe('http');
    expect(p.mechanism.killRequest).toBe('http');
    expect(p.mechanism.addTempRule).toBe('unavailable');
    expect(p.unproven).toEqual(expect.arrayContaining(['updateExternalResource', 'selectGroupPolicy']));
  });

  it('annotates a readable listTempRules mapping as needing the insertion probe confirmation', () => {
    // 能读取只证明输出可以解析（空白输出也会读成空列表）：内容要由 entry 的插入探测正向确认。
    const p = proposeMechanism({ listTempRules: ok }, {}, {}, false);
    expect(p.mechanism.listTempRules).toBe('cli');
    expect(p.notes.listTempRules).toContain('插入探测正向确认');
    expect(proposeMechanism({}, {}, {}, false).notes.listTempRules).not.toContain('插入探测');
  });

  it('never proposes reloadProfile', () => {
    const p = proposeMechanism({}, {}, {}, true);
    expect(p.mechanism.reloadProfile).toBe('unavailable');
  });

  it('has no HTTP active primitives when HTTP is unusable', () => {
    const p = proposeMechanism({}, {}, {}, false);
    for (const prim of ACTIVE_PRIMITIVES) expect(p.mechanism[prim]).toBe('unavailable');
  });
});

describe('resource locations', () => {
  const dir = '/Users/t/Surge';
  it('resolves relative, absolute and file URLs; URLs are null', () => {
    expect(resolveLocation('sfe-nodes.list', dir)).toBe('/Users/t/Surge/sfe-nodes.list');
    expect(resolveLocation('/x/y.list', dir)).toBe('/x/y.list');
    expect(resolveLocation('file:///Users/t/Surge/a.list', dir)).toBe('/Users/t/Surge/a.list');
    expect(resolveLocation('https://rules.example.test/a.list', dir)).toBeNull();
  });

  it('finds resources pointing at a path', () => {
    const res: SurgeExternalResource[] = [
      { key: 'k1', type: 'policy-group', location: 'sfe-nodes.list', lastUpdatedAt: null, error: null, local: true, updating: false, fromModule: null },
      { key: 'k2', type: 'ruleset', location: 'https://rules.example.test/sfe-nodes.list', lastUpdatedAt: null, error: null, local: false, updating: false, fromModule: null },
      { key: 'k3', type: 'ruleset', location: '/Users/t/Surge/sfe-nodes.list', lastUpdatedAt: null, error: null, local: true, updating: false, fromModule: null },
    ];
    expect(resourcesForPath(res, '/Users/t/Surge/sfe-nodes.list', dir).map((r) => r.key)).toEqual(['k1', 'k3']);
  });

  it('describes locations without paths or URL details', () => {
    expect(describeLocation('/Users/t/Surge/sfe-nodes.list')).toBe('本地 sfe-nodes.list');
    expect(describeLocation('https://rules.example.test/a.list?token=x')).toBe('远端 rules.example.test');
  });
});

describe('guarded adapter on FakeSurge', () => {
  function setup() {
    const env = createFakeSurgeEnvironment(mkdtempSync(join(tmpdir(), 'sfe-p0-guard-')));
    const fake = new FakeSurge({ directory: env.directory });
    const log: CallLogEntry[] = [];
    const guard = emptyGuard();
    const adapter = createGuardedAdapter(fake, guard, (e) => log.push(e));
    return { fake, guard, adapter, log };
  }

  it('refuses writes until the test profile is confirmed and the target is allowed', async () => {
    const { adapter, guard, fake, log } = setup();
    await expect(adapter.selectGroupPolicy('SFE-ROUTE', 'REJECT')).rejects.toBeInstanceOf(SfeError);
    guard.onTestProfile = true;
    await expect(adapter.selectGroupPolicy('Daily', 'DIRECT')).rejects.toThrow(/SFE-ROUTE/);
    await adapter.selectGroupPolicy('SFE-ROUTE', 'REJECT');
    await expect(adapter.updateExternalResource('policy-path:sfe-nodes.list')).rejects.toThrow(/测试资源/);
    guard.refreshableKeys.add('policy-path:sfe-nodes.list');
    // 本地资源被跳过（Surge 6.10 文档：“Local resources are skipped.”）：结果不算刷新
    await expect(adapter.updateExternalResource('policy-path:sfe-nodes.list')).resolves.toEqual({ key: 'policy-path:sfe-nodes.list', refreshed: false, outcome: 'skipped' });
    expect(fake.calls.selectGroupPolicy).toBe(1);
    expect(fake.calls.updateExternalResource).toBe(1);
    expect(log.filter((l) => l.code === 'P0_GUARD')).toHaveLength(3);
  });

  it('only adds registered temp rules; removal of registered rules is allowed on any profile', async () => {
    const { adapter, guard, fake } = setup();
    const rule = 'DOMAIN,p0-guard.invalid,REJECT';
    guard.onTestProfile = true;
    await expect(adapter.addTempRule(rule)).rejects.toThrow(/登记/);
    guard.tempRules.add(rule);
    await adapter.addTempRule(rule);
    guard.onTestProfile = false;
    await expect(adapter.addTempRule('DOMAIN,other.invalid,REJECT')).rejects.toThrow();
    await adapter.removeTempRule(rule);
    expect(fake.tempRules).toEqual([]);
    await expect(adapter.removeTempRule('DOMAIN,user-rule.invalid,DIRECT')).rejects.toThrow(/登记/);
  });

  it('kills only requests listed with an allowed Safari path', async () => {
    const { adapter, guard, fake } = setup();
    const safari = fake.simulateRequest({ processPath: FAKE_SAFARI_PATH, host: 'daily.example.test', protocol: 'tcp', longLived: true });
    const chrome = fake.simulateRequest({ processPath: FAKE_CHROME_PATH, host: 'daily.example.test', protocol: 'tcp', longLived: true });
    guard.killablePaths.add(FAKE_SAFARI_PATH);
    await expect(adapter.killRequest(safari.id)).rejects.toThrow();
    await adapter.listActiveRequests();
    await adapter.killRequest(safari.id);
    await expect(adapter.killRequest(chrome.id)).rejects.toThrow(/Safari/);
    expect((await fake.listActiveRequests()).map((r) => r.id)).toEqual([chrome.id]);
  });

  it('logs reads with durations and never blocks them', async () => {
    const { adapter, log } = setup();
    await adapter.listRules();
    await adapter.checkProfile('/some/where/profile.conf');
    expect(log.map((l) => l.primitive)).toEqual(['listRules', 'checkProfile']);
    expect(log[1]!.args).toEqual(['profile.conf']);
    expect(log.every((l) => l.ok)).toBe(true);
  });

  it('rule match is a read: never guarded, logged with its inputs', async () => {
    const { adapter, log } = setup();
    expect(await adapter.matchRule({ host: 'daily.example.test', processPath: FAKE_SAFARI_PATH })).toEqual({ rule: 'DOMAIN-SUFFIX,daily.example.test,Daily', policy: 'Daily' });
    expect(log[0]).toMatchObject({ primitive: 'matchRule', ok: true, args: ['daily.example.test', FAKE_SAFARI_PATH, 'TCP', '443'] });
  });

  it('only allows testPolicy on test nodes', async () => {
    const { adapter, guard } = setup();
    await expect(adapter.testPolicy('Front-A', 'http://echo.p0.example.test/')).rejects.toThrow();
    guard.testablePolicies.add('SFE-ROUTE');
    expect((await adapter.testPolicy('SFE-ROUTE', 'http://echo.p0.example.test/')).ok).toBe(false);
  });
});
