import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { ENTRY_RULESET_FILES } from '@sfe/contract';
import { FAKE_CHROME_PATH, FAKE_SAFARI_PATH, FAKE_VERIFY_HOST, FakeSurge, createFakeSurgeEnvironment } from '../../src/surge/fake.js';
import { entryRuleSetFileContent, nodeLine, resourceFile } from '../../src/surge/generate.js';
import { SURGE_PRIMITIVES } from '../../src/surge/primitives.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sfe-fake-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const OPTS = { processPaths: [FAKE_SAFARI_PATH], verifyHost: FAKE_VERIFY_HOST };
const node = (rev: number, front = 'Front-A') =>
  nodeLine({ name: `SFE-N-E0001-US01-v00${rev}`, host: `203.0.113.${10 + rev}`, port: 1080, username: null, password: null, front });
const writeNodes = (lines: string[], gen = 1) => writeFileSync(join(dir, 'sfe-nodes.list'), resourceFile(gen, lines));

describe('environment and loading', () => {
  test('seeds a synthetic working profile and placeholder files', () => {
    const env = createFakeSurgeEnvironment(dir);
    expect(env.files).toEqual(['sfe-nodes.list', ...Object.values(ENTRY_RULESET_FILES)]);
    const text = readFileSync(env.profilePath, 'utf8');
    expect(text).toContain('# SFE-BEGIN group v1');
    expect(text).toContain('RULE-SET,sfe-entry-udp.list,REJECT');
    expect(text).toContain('FINAL,DIRECT');
  });

  test('temp_rule environments keep an empty entry block', () => {
    const env = createFakeSurgeEnvironment(dir, { entryStrategy: 'temp_rule' });
    expect(readFileSync(env.profilePath, 'utf8')).toContain('# SFE-BEGIN entry v1\n# SFE-END entry');
    expect(env.files).toEqual(['sfe-nodes.list']);
  });

  test('external resources derive from the profile with absolute locations', async () => {
    createFakeSurgeEnvironment(dir);
    const fake = new FakeSurge({ directory: dir });
    const res = await fake.listExternalResources();
    expect(res.map((r) => r.key).sort()).toEqual(
      ['policy-path:sfe-nodes.list', 'ruleset:sfe-entry-active.list', 'ruleset:sfe-entry-block.list', 'ruleset:sfe-entry-udp.list', 'ruleset:sfe-entry-verify.list'].sort(),
    );
    expect(res.every((r) => r.location.startsWith(dir) && r.error === null)).toBe(true);
    expect(fake.mechanism()).toEqual(Object.fromEntries(SURGE_PRIMITIVES.map((p) => [p, 'fake'])));
  });
});

describe('groups and selection', () => {
  test('file changes are not loaded until the resource is updated by key', async () => {
    createFakeSurgeEnvironment(dir);
    const fake = new FakeSurge({ directory: dir });
    writeNodes([node(1)]);
    expect(await fake.getGroupMembers('SFE-ROUTE')).toEqual(['REJECT']);
    await fake.updateExternalResource('policy-path:sfe-nodes.list');
    expect(await fake.getGroupMembers('SFE-ROUTE')).toEqual(['REJECT', 'SFE-N-E0001-US01-v001']);
    expect(fake.calls.reloadProfile).toBeUndefined();
    expect(fake.reloadCount).toBe(0);
  });

  test('select falls back to the first member (REJECT) when the selection disappears', async () => {
    createFakeSurgeEnvironment(dir);
    const fake = new FakeSurge({ directory: dir });
    writeNodes([node(1), node(2)]);
    await fake.updateExternalResource('policy-path:sfe-nodes.list');
    await fake.selectGroupPolicy('SFE-ROUTE', 'SFE-N-E0001-US01-v002');
    writeNodes([node(1)], 2);
    await fake.updateExternalResource('policy-path:sfe-nodes.list');
    expect(await fake.getGroupSelection('SFE-ROUTE')).toBe('REJECT');
    const r = fake.simulateRequest({ processPath: FAKE_SAFARI_PATH, host: FAKE_VERIFY_HOST, protocol: 'tcp' });
    expect(r.policyName).toBe('DIRECT');
  });

  test('selection is kept across updates while the node remains', async () => {
    createFakeSurgeEnvironment(dir);
    const fake = new FakeSurge({ directory: dir });
    writeNodes([node(1)]);
    await fake.updateExternalResource('policy-path:sfe-nodes.list');
    await fake.selectGroupPolicy('SFE-ROUTE', 'SFE-N-E0001-US01-v001');
    writeNodes([node(1), node(2)], 2);
    await fake.updateExternalResource('policy-path:sfe-nodes.list');
    expect(await fake.getGroupSelection('SFE-ROUTE')).toBe('SFE-N-E0001-US01-v001');
    await expect(fake.selectGroupPolicy('SFE-ROUTE', 'Front-A')).rejects.toMatchObject({ code: 'SURGE_COMMAND_FAILED' });
  });

  test('policy detail redacts credentials and reports the front', async () => {
    createFakeSurgeEnvironment(dir);
    const fake = new FakeSurge({ directory: dir });
    const d = await fake.getPolicyDetail('Front-A');
    expect(d.redactedRaw).not.toContain('example-pass');
    writeNodes([node(1)]);
    await fake.updateExternalResource('policy-path:sfe-nodes.list');
    expect(await fake.getPolicyDetail('SFE-N-E0001-US01-v001')).toMatchObject({ server: '203.0.113.11', port: 1080, underlyingProxy: 'Front-A' });
  });
});

describe('front resolution', () => {
  test("'skip' drops nodes whose front is missing", async () => {
    createFakeSurgeEnvironment(dir);
    const fake = new FakeSurge({ directory: dir, frontResolution: 'skip' });
    writeNodes([node(1, 'Missing-Front')]);
    await fake.updateExternalResource('policy-path:sfe-nodes.list');
    expect(await fake.getGroupMembers('SFE-ROUTE')).toEqual(['REJECT']);
  });

  test("'direct' keeps the node and its traffic bypasses the front (the dangerous case)", async () => {
    createFakeSurgeEnvironment(dir, { userRules: ['DOMAIN-SUFFIX,example.test,SFE-ROUTE'] });
    const fake = new FakeSurge({ directory: dir, frontResolution: 'direct' });
    writeNodes([node(1, 'Missing-Front')]);
    await fake.updateExternalResource('policy-path:sfe-nodes.list');
    await fake.selectGroupPolicy('SFE-ROUTE', 'SFE-N-E0001-US01-v001');
    const r = fake.simulateRequest({ processPath: FAKE_CHROME_PATH, host: 'www.example.test', protocol: 'tcp' });
    expect(r.frontMissing).toBe(true);
    expect(r.chain).toEqual(['SFE-ROUTE', 'SFE-N-E0001-US01-v001', 'DIRECT']);
    expect((await fake.testPolicy('SFE-ROUTE', 'https://verify.example.test/')).ok).toBe(true);
  });

  test('with the front present the chain goes through it', async () => {
    createFakeSurgeEnvironment(dir, { userRules: ['DOMAIN-SUFFIX,example.test,SFE-ROUTE'] });
    const fake = new FakeSurge({ directory: dir });
    writeNodes([node(1)]);
    await fake.updateExternalResource('policy-path:sfe-nodes.list');
    await fake.selectGroupPolicy('SFE-ROUTE', 'SFE-N-E0001-US01-v001');
    const r = fake.simulateRequest({ processPath: FAKE_CHROME_PATH, host: 'www.example.test', protocol: 'tcp' });
    expect(r).toMatchObject({ policyName: 'SFE-ROUTE', leafPolicyName: 'SFE-N-E0001-US01-v001', frontMissing: false, chain: ['SFE-ROUTE', 'SFE-N-E0001-US01-v001', 'Front-A'] });
  });
});

describe('rule evaluation', () => {
  const loadEntry = async (fake: FakeSurge, bits: Partial<Record<keyof typeof ENTRY_RULESET_FILES, boolean>>) => {
    for (const [bit, on] of Object.entries(bits)) {
      const b = bit as keyof typeof ENTRY_RULESET_FILES;
      writeFileSync(join(dir, ENTRY_RULESET_FILES[b]), entryRuleSetFileContent(b, Boolean(on), OPTS));
      await fake.updateExternalResource(`ruleset:${ENTRY_RULESET_FILES[b]}`);
    }
  };

  test('UDP rule rejects Safari UDP while TCP continues to user rules', async () => {
    createFakeSurgeEnvironment(dir);
    const fake = new FakeSurge({ directory: dir });
    await loadEntry(fake, { udp: true });
    expect(fake.simulateRequest({ processPath: FAKE_SAFARI_PATH, host: 'www.example.test', protocol: 'udp' })).toMatchObject({ policyName: 'REJECT', failed: true, rule: 'RULE-SET,sfe-entry-udp.list,REJECT' });
    expect(fake.simulateRequest({ processPath: FAKE_SAFARI_PATH, host: 'www.example.test', protocol: 'tcp' })).toMatchObject({ policyName: 'DIRECT', rule: 'FINAL,DIRECT' });
    expect(fake.simulateRequest({ processPath: FAKE_CHROME_PATH, host: 'www.example.test', protocol: 'udp' }).policyName).toBe('DIRECT');
  });

  test('ruleset content changes take effect only after updateExternalResource', async () => {
    createFakeSurgeEnvironment(dir);
    const fake = new FakeSurge({ directory: dir });
    writeFileSync(join(dir, ENTRY_RULESET_FILES.block), entryRuleSetFileContent('block', true, OPTS));
    expect(fake.simulateRequest({ processPath: FAKE_SAFARI_PATH, host: 'www.example.test', protocol: 'tcp' }).policyName).toBe('DIRECT');
    await fake.updateExternalResource('ruleset:sfe-entry-block.list');
    expect(fake.simulateRequest({ processPath: FAKE_SAFARI_PATH, host: 'www.example.test', protocol: 'tcp' }).policyName).toBe('REJECT');
  });

  test('module rules precede temp rules, which precede profile rules', async () => {
    createFakeSurgeEnvironment(dir);
    const fake = new FakeSurge({ directory: dir });
    await loadEntry(fake, { block: true });
    await fake.addTempRule(`PROCESS-NAME,${FAKE_SAFARI_PATH},REJECT-DROP`);
    expect(fake.simulateRequest({ processPath: FAKE_SAFARI_PATH, host: 'www.example.test', protocol: 'tcp' }).rule).toBe(`PROCESS-NAME,${FAKE_SAFARI_PATH},REJECT-DROP`);
    fake.setModuleRules([{ text: 'PROCESS-NAME,Safari,DIRECT', moduleName: 'Mod' }]);
    expect(fake.simulateRequest({ processPath: FAKE_SAFARI_PATH, host: 'www.example.test', protocol: 'tcp' })).toMatchObject({ policyName: 'DIRECT', rule: 'PROCESS-NAME,Safari,DIRECT' });
    expect((await fake.listRules()).map((r) => r.source).slice(0, 3)).toEqual(['module', 'temp_rule', 'profile']);
  });

  test('temp rule insertion position is configurable', async () => {
    createFakeSurgeEnvironment(dir, { entryStrategy: 'temp_rule' });
    const head = new FakeSurge({ directory: dir, tempRuleInsertion: 'head' });
    await head.addTempRule('DOMAIN,a.example.test,REJECT');
    await head.addTempRule('DOMAIN,b.example.test,REJECT');
    expect(head.tempRules).toEqual(['DOMAIN,b.example.test,REJECT', 'DOMAIN,a.example.test,REJECT']);
    const tail = new FakeSurge({ directory: dir });
    await tail.addTempRule('DOMAIN,a.example.test,REJECT');
    await tail.addTempRule('DOMAIN,b.example.test,REJECT');
    expect(tail.tempRules).toEqual(['DOMAIN,a.example.test,REJECT', 'DOMAIN,b.example.test,REJECT']);
    await expect(tail.addTempRule('DOMAIN,a.example.test,REJECT')).rejects.toMatchObject({ code: 'SURGE_COMMAND_FAILED' });
    await expect(tail.removeTempRule('DOMAIN,c.example.test,REJECT')).rejects.toMatchObject({ code: 'SURGE_COMMAND_FAILED' });
  });
});

describe('lifecycle and fault injection', () => {
  test('restart clears temp rules and changes the start time', async () => {
    createFakeSurgeEnvironment(dir, { entryStrategy: 'temp_rule' });
    let t = 1_000;
    const fake = new FakeSurge({ directory: dir, now: () => new Date(t) });
    await fake.addTempRule('DOMAIN,a.example.test,REJECT');
    const before = (await fake.getRuntimeInfo()).startedAt!;
    t = 5_000;
    fake.restart();
    expect(fake.tempRules).toEqual([]);
    expect((await fake.getRuntimeInfo()).startedAt!.getTime()).toBeGreaterThan(before.getTime());
  });

  test('autoReload reloads the whole profile on file change and counts it', async () => {
    createFakeSurgeEnvironment(dir);
    const fake = new FakeSurge({ directory: dir, autoReload: true });
    expect(await fake.getAutoReloadSetting()).toBe(true);
    writeNodes([node(1)]);
    expect(await fake.getGroupMembers('SFE-ROUTE')).toEqual(['REJECT', 'SFE-N-E0001-US01-v001']);
    expect(fake.reloadCount).toBe(1);
    expect(fake.autoReloadCount).toBe(1);
    expect(fake.calls.reloadProfile).toBeUndefined();
  });

  test('reportedAutoReload can differ from the simulated behaviour', async () => {
    createFakeSurgeEnvironment(dir);
    const fake = new FakeSurge({ directory: dir, autoReload: true, reportedAutoReload: null });
    expect(await fake.getAutoReloadSetting()).toBeNull();
  });

  test('reloadProfile is counted separately and reloads everything', async () => {
    createFakeSurgeEnvironment(dir);
    const fake = new FakeSurge({ directory: dir });
    writeNodes([node(1)]);
    await fake.reloadProfile();
    expect(fake.calls.reloadProfile).toBe(1);
    expect(await fake.getGroupMembers('SFE-ROUTE')).toContain('SFE-N-E0001-US01-v001');
  });

  test('failNext throws once; afterEffect applies then throws', async () => {
    createFakeSurgeEnvironment(dir, { entryStrategy: 'temp_rule' });
    const fake = new FakeSurge({ directory: dir });
    fake.failNext('addTempRule');
    await expect(fake.addTempRule('DOMAIN,a.example.test,REJECT')).rejects.toMatchObject({ code: 'SURGE_COMMAND_FAILED' });
    expect(fake.tempRules).toEqual([]);
    fake.failNext('addTempRule', new Error('timeout'), { afterEffect: true });
    await expect(fake.addTempRule('DOMAIN,a.example.test,REJECT')).rejects.toThrow('timeout');
    expect(fake.tempRules).toEqual(['DOMAIN,a.example.test,REJECT']);
    expect(fake.calls.addTempRule).toBe(2);
  });

  test('lieOnNext returns a value for reads and skips writes', async () => {
    createFakeSurgeEnvironment(dir, { entryStrategy: 'temp_rule' });
    const fake = new FakeSurge({ directory: dir });
    fake.lieOnNext('getGroupSelection', 'SFE-N-FAKE');
    expect(await fake.getGroupSelection('SFE-ROUTE')).toBe('SFE-N-FAKE');
    expect(await fake.getGroupSelection('SFE-ROUTE')).toBe('REJECT');
    fake.lieOnNext('addTempRule');
    await fake.addTempRule('DOMAIN,a.example.test,REJECT');
    expect(fake.tempRules).toEqual([]);
  });

  test('unreachable Surge fails every primitive', async () => {
    createFakeSurgeEnvironment(dir);
    const fake = new FakeSurge({ directory: dir });
    fake.reachable = false;
    await expect(fake.getVersion()).rejects.toMatchObject({ code: 'SURGE_UNREACHABLE' });
  });

  test('long-lived requests stay active until killed', async () => {
    createFakeSurgeEnvironment(dir);
    const fake = new FakeSurge({ directory: dir });
    const r = fake.simulateRequest({ processPath: FAKE_CHROME_PATH, host: 'www.example.test', protocol: 'tcp', longLived: true });
    expect((await fake.listActiveRequests()).map((x) => x.id)).toEqual([r.id]);
    await fake.killRequest(r.id);
    expect(await fake.listActiveRequests()).toEqual([]);
    expect((await fake.listRecentRequests()).length).toBe(1);
  });

  test('the simulated running instance reports version and build all-or-nothing and is not a Surge primitive call', async () => {
    createFakeSurgeEnvironment(dir);
    const fake = new FakeSurge({ directory: dir, version: '6.5.0', build: '10960', now: () => new Date('2026-10-21T09:00:00.700Z') });
    expect(await fake.runningInstance()).toEqual({
      ok: true,
      instance: { pid: 404, startedAt: '2026-10-21T09:00:00.000Z', bundlePath: '/Applications/Surge.app', bundleId: 'com.nssurge.surge-mac', version: '6.5.0', build: '10960' },
    });
    fake.build = null;
    expect(await fake.runningInstance()).toEqual({ ok: false, reason: 'plist_unreadable' });
    fake.build = '10960';
    fake.version = '127.0.0.1';
    expect(await fake.runningInstance()).toEqual({ ok: false, reason: 'version_malformed' });
    fake.version = '6.5.0';
    fake.instanceFailure = 'modified_after_start';
    expect(await fake.runningInstance()).toEqual({ ok: false, reason: 'modified_after_start' });
    fake.instanceFailure = null;
    fake.reachable = false;
    expect(await fake.runningInstance()).toEqual({ ok: false, reason: 'not_running' });
    expect(fake.instanceReads).toBe(5);
    expect(fake.calls).toEqual({});
  });

  test('version, profile and takeover state are settable', async () => {
    createFakeSurgeEnvironment(dir);
    const fake = new FakeSurge({ directory: dir, version: '6.5.0', build: '10960' });
    expect(await fake.getVersion()).toEqual({ version: '6.5.0', build: '10960' });
    expect((await fake.getCurrentProfile()).name).toBe('日常-Safari环境');
    fake.takeover = { enhancedMode: false, systemProxy: true, outboundMode: 'direct', checkedAt: null };
    expect(await fake.getTakeoverState()).toMatchObject({ enhancedMode: false, outboundMode: 'direct' });
    expect((await fake.checkProfile(join(dir, '日常-Safari环境.conf'))).ok).toBe(true);
  });
});
