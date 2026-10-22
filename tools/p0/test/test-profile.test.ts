import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ENTRY_RULESET_FILES, NODE_RESOURCE_FILE } from '@sfe/contract';
import { describe, expect, it } from 'vitest';
import {
  FAKE_CHROME_PATH,
  FAKE_SAFARI_PATH,
  FakeSurge,
  createMemoryEntryOwnership,
  createProfileFiles,
  createRulesetStrategy,
  entryBlockIsFirstRule,
  findManagedBlock,
  ownedRulesetRecords,
  parseHttpApiLine,
  parseProfile,
} from '../src/deps.js';
import { P0Error } from '../src/errors.js';
import {
  CANARY_FILE,
  CHAIN_HOST,
  ECHO_HOST,
  PRECEDENCE_MODULE_FILE,
  TEST_NODES,
  TEST_PROFILE_FILE,
  buildTestProfile,
  bypassWarnings,
  canaryHost,
  profileRuleLines,
  testNodeResource,
} from '../src/test-profile.js';

const PORTS = { echo: 18080, exit: 18081, front: 18082, deadFront: 18083 };
const PW = 'Synthetic0Test0Pass';
const KEY = '0123456789abcdef0123456789abcdef';

const SOURCE = [
  '[General]',
  'loglevel = notify',
  'skip-proxy = 127.0.0.1, localhost',
  '',
  '[Proxy]',
  'Front-A = socks5, 192.0.2.10, 1080, username=example-user, password=example-pass',
  '',
  '[Proxy Group]',
  'Daily = select, Front-A, DIRECT',
  '',
  '[Rule]',
  'DOMAIN-SUFFIX,daily.example.test,Daily',
  'FINAL,DIRECT',
  '',
].join('\n');

const opts = { ports: PORTS, password: PW, verifyHost: 'api.ipify.org', httpApi: { key: KEY, port: 6171 } };

function refusal(fn: () => unknown): P0Error {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(P0Error);
    return e as P0Error;
  }
  throw new Error('expected refusal');
}

describe('buildTestProfile', () => {
  it('adds managed blocks, test proxies and test rules after the entry block', () => {
    const r = buildTestProfile(SOURCE, opts);
    const parsed = parseProfile(r.profileText);
    expect(entryBlockIsFirstRule(parsed)).toBe(true);
    const group = findManagedBlock(parsed, 'group');
    expect(typeof group === 'object' && group.lines).toEqual(['SFE-ROUTE = select, REJECT, policy-path=sfe-nodes.list']);
    const entry = findManagedBlock(parsed, 'entry');
    expect(typeof entry === 'object' && entry.lines).toEqual([
      'RULE-SET,sfe-entry-udp.list,REJECT',
      'RULE-SET,sfe-entry-verify.list,SFE-ROUTE',
      'RULE-SET,sfe-entry-block.list,REJECT',
      'RULE-SET,sfe-entry-active.list,SFE-ROUTE',
    ]);
    const lines = r.profileText.split('\n');
    const endEntry = lines.indexOf('# SFE-END entry');
    expect(lines.slice(endEntry + 1, endEntry + 6)).toEqual([
      '# P0-TEST-BEGIN rule',
      `RULE-SET,${CANARY_FILE},P0-Canary`,
      `DOMAIN,${CHAIN_HOST},SFE-ROUTE`,
      'DOMAIN-SUFFIX,p0.example.test,P0-Plain',
      '# P0-TEST-END rule',
    ]);
    expect(lines).toContain('P0-Front = socks5, 127.0.0.1, 18082');
    expect(lines).toContain('P0-Front-Dead = socks5, 127.0.0.1, 18083');
    // 用户原有内容保留
    expect(lines).toContain('Daily = select, Front-A, DIRECT');
    expect(lines).toContain('DOMAIN-SUFFIX,daily.example.test,Daily');
  });

  it('adds a loopback http-api when the source has none', () => {
    const r = buildTestProfile(SOURCE, opts);
    expect(parseHttpApiLine(r.profileText)).toEqual({ key: KEY, host: '127.0.0.1', port: 6171, loopbackOnly: true });
    expect(r.httpApi).toEqual({ configured: true, loopbackOnly: true, added: true });
    expect(r.profileText).toContain('http-api-web-dashboard = false');
  });

  it('keeps an existing loopback http-api', () => {
    const src = SOURCE.replace('loglevel = notify', `loglevel = notify\nhttp-api = ${'f'.repeat(8)}@127.0.0.1:6170`);
    const r = buildTestProfile(src, opts);
    expect(parseHttpApiLine(r.profileText)?.port).toBe(6170);
    expect(r.httpApi.added).toBe(false);
  });

  it('rebinds a non-loopback http-api in the copy, or refuses without one', () => {
    const src = SOURCE.replace('loglevel = notify', `loglevel = notify\nhttp-api = ${'f'.repeat(8)}@0.0.0.0:6170`);
    const r = buildTestProfile(src, opts);
    expect(parseHttpApiLine(r.profileText)).toMatchObject({ host: '127.0.0.1', loopbackOnly: true });
    expect(r.notes.some((n) => n.includes('非回环'))).toBe(true);
    expect(refusal(() => buildTestProfile(src, { ...opts, httpApi: null })).code).toBe('refused');
  });

  it('notes when http-api is not added', () => {
    const r = buildTestProfile(SOURCE, { ...opts, httpApi: null });
    expect(parseHttpApiLine(r.profileText)).toBeNull();
    expect(r.notes.some((n) => n.includes('未加入 http-api'))).toBe(true);
  });

  it('strips a remote managed-config header', () => {
    const r = buildTestProfile(`#!MANAGED-CONFIG https://sub.example.test/x?token=abc interval=86400\n${SOURCE}`, opts);
    expect(r.profileText).not.toContain('MANAGED-CONFIG');
    expect(r.notes[0]).toContain('MANAGED-CONFIG');
  });

  it('replaces existing managed blocks instead of referencing real environment nodes', () => {
    // 初始化之后的工作配置（受管理段已存在，http-api 在 general 段中）。
    const initialized = [
      '[General]',
      'loglevel = notify',
      '# SFE-BEGIN general v1',
      `http-api = ${'e'.repeat(8)}@127.0.0.1:6172`,
      '# SFE-END general',
      '',
      '[Proxy]',
      'Front-A = socks5, 192.0.2.10, 1080',
      '',
      '[Proxy Group]',
      '# SFE-BEGIN group v3',
      'SFE-ROUTE = select, REJECT, policy-path=sfe-nodes.list',
      '# SFE-END group',
      '',
      '[Rule]',
      '# SFE-BEGIN entry v2',
      'RULE-SET,sfe-entry-udp.list,REJECT',
      '# SFE-END entry',
      'FINAL,DIRECT',
      '',
    ].join('\n');
    const r = buildTestProfile(initialized, opts);
    expect(r.sourceHadManagedBlocks).toBe(true);
    expect(r.notes.some((n) => n.includes('整段替换'))).toBe(true);
    const parsed = parseProfile(r.profileText);
    expect(entryBlockIsFirstRule(parsed)).toBe(true);
    const entry = findManagedBlock(parsed, 'entry');
    expect(typeof entry === 'object' && entry.lines).toHaveLength(4);
    expect(parseHttpApiLine(r.profileText)?.port).toBe(6172);
    expect(r.httpApi.added).toBe(false);
  });

  it('refuses foreign SFE objects outside managed blocks', () => {
    const src = SOURCE.replace('[Proxy]\n', '[Proxy]\nSFE-N-E0001-US01-v001 = socks5, 192.0.2.20, 1080\n');
    expect(refusal(() => buildTestProfile(src, opts)).message).toContain('SFE- 对象');
  });

  it('refuses partial or ambiguous managed blocks', () => {
    const partial = SOURCE.replace('[Rule]\n', '[Rule]\n# SFE-BEGIN entry v1\n# SFE-END entry\n');
    expect(refusal(() => buildTestProfile(partial, opts)).message).toContain('部分');
  });

  it('refuses test proxy name collisions', () => {
    const src = SOURCE.replace('[Proxy]\n', '[Proxy]\nP0-Front = socks5, 192.0.2.30, 1080\n');
    expect(refusal(() => buildTestProfile(src, opts)).message).toContain('P0-Front');
  });

  it('creates a [Proxy] section when missing', () => {
    const src = SOURCE.replace(/\[Proxy\]\n.*\n\n/, '').replace('Daily = select, Front-A, DIRECT', 'Daily = select, DIRECT');
    const r = buildTestProfile(src, opts);
    const lines = r.profileText.split('\n');
    expect(lines.indexOf('[Proxy]')).toBeGreaterThan(-1);
    expect(lines.indexOf('[Proxy]')).toBeLessThan(lines.indexOf('[Proxy Group]'));
  });

  it('preserves CRLF line endings', () => {
    const r = buildTestProfile(SOURCE.replace(/\n/g, '\r\n'), opts);
    expect(r.profileText.includes('\r\n# SFE-BEGIN entry v1\r\n')).toBe(true);
    expect(/[^\r]\n/.test(r.profileText)).toBe(false);
  });

  it('produces test files with synthetic nodes, placeholders and the precedence module', () => {
    const r = buildTestProfile(SOURCE, opts);
    expect(Object.keys(r.files).sort()).toEqual([CANARY_FILE, ...Object.values(ENTRY_RULESET_FILES), NODE_RESOURCE_FILE].sort());
    expect(r.files[NODE_RESOURCE_FILE]).toContain(`${TEST_NODES.a} = socks5, 127.0.0.1, 18081, username=p0-a`);
    expect(r.files[NODE_RESOURCE_FILE]).toContain('underlying-proxy=P0-Front');
    for (const f of Object.values(ENTRY_RULESET_FILES)) expect(r.files[f]).toContain('DOMAIN,sfe-disabled.invalid');
    expect(r.moduleText).toContain('DOMAIN,api.ipify.org,DIRECT');
    expect(PRECEDENCE_MODULE_FILE.endsWith('.sgmodule')).toBe(true);
  });

  it('warns when skip-proxy covers test hosts', () => {
    expect(bypassWarnings('[General]\nskip-proxy = *.example.test, localhost\n', [ECHO_HOST])).toHaveLength(1);
    expect(bypassWarnings('[General]\nskip-proxy = 127.0.0.1\n', [ECHO_HOST])).toHaveLength(0);
  });
});

describe('profileRuleLines', () => {
  it('lists the [Rule] texts in file order (entry block first), without comments, markers or blank lines', () => {
    const lines = profileRuleLines(buildTestProfile(SOURCE, opts).profileText);
    expect(lines[0]).toBe(`RULE-SET,${ENTRY_RULESET_FILES.udp},REJECT`);
    expect(lines).toContain(`DOMAIN,${CHAIN_HOST},SFE-ROUTE`);
    expect(lines.slice(-2)).toEqual(['DOMAIN-SUFFIX,daily.example.test,Daily', 'FINAL,DIRECT']);
    expect(lines.some((l) => l.startsWith('#') || l.trim() === '')).toBe(false);
  });
});

describe('generated test profile on FakeSurge', () => {
  function setup() {
    const dir = mkdtempSync(join(tmpdir(), 'sfe-p0-tp-'));
    const r = buildTestProfile(SOURCE, opts);
    writeFileSync(join(dir, TEST_PROFILE_FILE), r.profileText, { mode: 0o600 });
    for (const [name, content] of Object.entries(r.files)) writeFileSync(join(dir, name), content, { mode: 0o600 });
    const surge = new FakeSurge({ directory: dir, profileFileName: TEST_PROFILE_FILE });
    return { dir, surge };
  }

  it('loads SFE-ROUTE with REJECT first and the two test nodes', async () => {
    const { surge } = setup();
    expect(await surge.getGroupMembers('SFE-ROUTE')).toEqual(['REJECT', TEST_NODES.a, TEST_NODES.b]);
    expect(await surge.getGroupSelection('SFE-ROUTE')).toBe('REJECT');
  });

  it('routes other apps to the plain test exit and the canary host to the canary exit', () => {
    const { surge } = setup();
    expect(surge.simulateRequest({ processPath: FAKE_CHROME_PATH, host: ECHO_HOST, protocol: 'tcp' }).policyName).toBe('P0-Plain');
    expect(surge.simulateRequest({ processPath: FAKE_CHROME_PATH, host: canaryHost(0), protocol: 'tcp' }).policyName).toBe('P0-Canary');
    expect(surge.simulateRequest({ processPath: FAKE_CHROME_PATH, host: canaryHost(1), protocol: 'tcp' }).policyName).toBe('P0-Plain');
    expect(surge.simulateRequest({ processPath: FAKE_SAFARI_PATH, host: CHAIN_HOST, protocol: 'tcp' }).policyName).toBe('SFE-ROUTE');
  });

  it('is readable as NORMAL by the service ruleset strategy and a refresh adds members', async () => {
    const { dir, surge } = setup();
    const files = createProfileFiles({ directory: dir, hmacKey: Buffer.alloc(32, 1) });
    const ownership = createMemoryEntryOwnership(await ownedRulesetRecords(files));
    const controller = createRulesetStrategy({
      adapter: surge,
      files,
      ownership,
      config: () => ({ processPaths: [FAKE_SAFARI_PATH], verifyHost: 'api.ipify.org', siteHosts: [ECHO_HOST] }),
      operationId: () => 'p0-test',
      autoReloadCondition: () => 'off',
    });
    expect((await controller.read()).mode).toBe('NORMAL');
    writeFileSync(join(dir, NODE_RESOURCE_FILE), testNodeResource(['a', 'b', 'c'], PORTS, PW, 2));
    const key = (await surge.listExternalResources()).find((x) => x.location.endsWith(NODE_RESOURCE_FILE))!.key;
    expect(await surge.getGroupMembers('SFE-ROUTE')).toHaveLength(3);
    await surge.updateExternalResource(key);
    expect(await surge.getGroupMembers('SFE-ROUTE')).toEqual(['REJECT', TEST_NODES.a, TEST_NODES.b, TEST_NODES.c]);
    expect(surge.reloadCount).toBe(0);
  });
});
