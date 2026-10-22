import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SfeError } from '@sfe/contract';
import { describe, expect, it } from 'vitest';
import { FAKE_CHROME_PATH, FAKE_SAFARI_PATH, FakeSurge, createFakeSurgeEnvironment, type SurgeExternalResource } from '../src/deps.js';
import {
  ACTIVE_PRIMITIVES,
  READ_PRIMITIVES,
  argvHasForbiddenWord,
  cliAvailability,
  cliLiteralWords,
  createGuardedAdapter,
  describeLocation,
  emptyGuard,
  helpWords,
  proposeMechanism,
  resolveLocation,
  resourcesForPath,
  type CallLogEntry,
  type ProbeOutcome,
  type Primitive,
} from '../src/surge-access.js';

const HELP = `Usage: surge-cli [options] <command>
  --check <path>            Check a profile
  --raw                     Output raw JSON
Commands:
  reload                    Reload the profile
  switch-profile <name>     Switch profile
  dump temp-rule            Dump temporary rules
  external-resource list    List external resources
  external-resource update <key>
  temp-rule add <rule>`;

describe('CLI help analysis', () => {
  it('extracts command words and options', () => {
    const w = helpWords(HELP);
    expect(w.has('--check')).toBe(true);
    expect(w.has('external-resource')).toBe(true);
    expect(w.has('temp-rule')).toBe(true);
    expect(w.has('dump')).toBe(true);
  });

  it('maps primitives to availability without running anything', () => {
    const w = helpWords(HELP);
    expect(cliAvailability('checkProfile', w)).toBe('in_help');
    expect(cliAvailability('listExternalResources', w)).toBe('in_help');
    expect(cliAvailability('listTempRules', w)).toBe('in_help');
    expect(cliAvailability('selectGroupPolicy', w)).toBe('not_in_table');
    expect(cliAvailability('killRequest', w)).toBe('not_in_table');
    expect(cliAvailability('removeTempRule', w)).toBe('not_in_help');
  });

  it('requires raw JSON support before proposing JSON read commands', () => {
    const w = helpWords(HELP);
    w.delete('--raw');
    expect(cliAvailability('listExternalResources', w)).toBe('not_in_help');
    expect(cliAvailability('listTempRules', w)).toBe('not_in_help');
  });

  it('literal words never contain global actions', () => {
    for (const p of [...READ_PRIMITIVES, ...ACTIVE_PRIMITIVES]) {
      const lit = cliLiteralWords(p as Primitive);
      if (lit) expect(argvHasForbiddenWord(lit)).toBe(false);
    }
    expect(argvHasForbiddenWord(['switch-profile', 'x'])).toBe(true);
    expect(argvHasForbiddenWord(['RELOAD'])).toBe(true);
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
      { key: 'k1', type: 'policy-path', location: 'sfe-nodes.list', lastUpdatedAt: null, error: null },
      { key: 'k2', type: 'ruleset', location: 'https://rules.example.test/sfe-nodes.list', lastUpdatedAt: null, error: null },
      { key: 'k3', type: 'ruleset', location: '/Users/t/Surge/sfe-nodes.list', lastUpdatedAt: null, error: null },
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
    await adapter.updateExternalResource('policy-path:sfe-nodes.list');
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

  it('only allows testPolicy on test nodes', async () => {
    const { adapter, guard } = setup();
    await expect(adapter.testPolicy('Front-A', 'http://echo.p0.example.test/')).rejects.toThrow();
    guard.testablePolicies.add('SFE-ROUTE');
    expect((await adapter.testPolicy('SFE-ROUTE', 'http://echo.p0.example.test/')).ok).toBe(false);
  });
});
