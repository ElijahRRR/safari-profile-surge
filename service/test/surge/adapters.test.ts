import { describe, expect, test, vi } from 'vitest';
import { SfeError } from '@sfe/contract';
import type { SurgeAdapter } from '../../src/ports.js';
import { CLI_COMMANDS, FORBIDDEN_CLI_WORDS, safeArg, safeResourceKey } from '../../src/surge/cli-commands.js';
import { codesignArgs, createCliAdapter, verifyCliPath, type ExecFn } from '../../src/surge/cli-adapter.js';
import { createHttpAdapter, isLoopbackHost, parseHttpApiLine } from '../../src/surge/http-adapter.js';
import { createCompositeAdapter } from '../../src/surge/composite.js';
import { SURGE_PRIMITIVES, type MechanismMap } from '../../src/surge/primitives.js';

const CLI = '/Applications/Surge.app/Contents/Applications/surge-cli';
const SAMPLE_ARGS: Record<string, unknown[]> = {
  checkProfile: ['/tmp/sfe-candidate/日常-Safari环境.conf'],
  updateExternalResource: ['policy-path:sfe-nodes.list'],
  addTempRule: ['PROCESS-NAME,/Applications/Safari.app/Contents/MacOS/Safari,REJECT'],
  removeTempRule: ['PROCESS-NAME,/Applications/Safari.app/Contents/MacOS/Safari,REJECT'],
};

const allCli: MechanismMap = Object.fromEntries(SURGE_PRIMITIVES.map((p) => [p, 'cli']));
const allHttp: MechanismMap = Object.fromEntries(SURGE_PRIMITIVES.map((p) => [p, 'http']));

describe('CLI command table', () => {
  test('no argv ever contains a forbidden global verb', () => {
    for (const [name, cmd] of Object.entries(CLI_COMMANDS)) {
      const argv = (cmd!.argv as (...a: unknown[]) => string[])(...(SAMPLE_ARGS[name] ?? []));
      for (const word of FORBIDDEN_CLI_WORDS) {
        for (const a of argv) expect(a.toLowerCase().includes(word), `${name}: ${a} contains ${word}`).toBe(false);
      }
    }
  });

  test('only the commands seen in the 6.5 help are marked as seen', () => {
    const seen = Object.entries(CLI_COMMANDS)
      .filter(([, c]) => c!.evidence === 'seen_in_6.5_help')
      .map(([k]) => k)
      .sort();
    expect(seen).toEqual(['checkProfile', 'listExternalResources', 'listTempRules', 'updateExternalResource']);
  });

  test('there is no CLI mapping for killRequest, selection or profile switching', () => {
    expect(CLI_COMMANDS.killRequest).toBeUndefined();
    expect(CLI_COMMANDS.selectGroupPolicy).toBeUndefined();
    expect(Object.keys(CLI_COMMANDS)).not.toContain('switchProfile');
  });

  test.each(['', '-all', '--check', 'a\nb', 'a\0b'])('argument %j is refused', (v) => {
    expect(() => safeArg(v, 'x')).toThrow(SfeError);
  });

  test.each(['all', 'ALL', '*'])('resource key %j is refused', (k) => {
    expect(() => safeResourceKey(k)).toThrow(/单个资源/);
  });

  test('parsers accept the known JSON shapes and refuse other output', () => {
    const ctx = { scrub: (s: string) => s };
    const out = (stdout: string) => ({ stdout, stderr: '', exitCode: 0 });
    expect(CLI_COMMANDS.listExternalResources!.parse(out(JSON.stringify({ resources: [{ key: 'k1', type: 'ruleset', path: '/a/sfe-entry-udp.list', lastUpdated: 1760000000 }] })), ctx)).toEqual([
      { key: 'k1', type: 'ruleset', location: '/a/sfe-entry-udp.list', lastUpdatedAt: new Date(1760000000 * 1000), error: null },
    ]);
    expect(CLI_COMMANDS.listTempRules!.parse(out('[]'), ctx)).toEqual([]);
    expect(CLI_COMMANDS.listTempRules!.parse(out(JSON.stringify(['DOMAIN,a.example.test,REJECT'])), ctx)).toEqual(['DOMAIN,a.example.test,REJECT']);
    // --raw 输出只接受 JSON：人类可读的文本不再按行拆成规则。
    expect(() => CLI_COMMANDS.listTempRules!.parse(out('# temp rules\nDOMAIN,a.example.test,REJECT\n'), ctx)).toThrow(/输出格式无法识别/);
    expect(CLI_COMMANDS.getVersion!.parse(out('Surge Mac 6.5.0 (10960)'), ctx)).toEqual({ version: '6.5.0', build: '10960' });
    expect(() => CLI_COMMANDS.listExternalResources!.parse(out('not json'), ctx)).toThrow(/输出格式无法识别/);
  });
});

describe('createCliAdapter', () => {
  const okExec = (stdout: string): ExecFn => vi.fn(async () => ({ stdout, stderr: '' }));

  test('reads the Surge 6.5 defines envelope through machine-readable CLI output', async () => {
    // Synthetic resource values; the envelope matches a read-only 6.5 CLI observation.
    const response = {
      defines: [
        { key: 'local-resource', type: 'policy-group', path: '/tmp/sfe-fixture/sfe-nodes.list', local: true, ready: true },
        { key: 'remote-resource', type: 'ruleset', path: 'https://rules.example.test/list', local: false, ready: true, updatedAt: 1760000000 },
      ],
    };
    const exec: ExecFn = vi.fn(async (_file, args) => ({
      stdout: args.includes('--raw') ? JSON.stringify(response) : 'External resources (human-readable output)',
      stderr: '',
    }));
    const adapter = createCliAdapter({ cliPath: CLI, mechanism: allCli, exec, scrub: (s) => s });
    await expect(adapter.listExternalResources()).resolves.toEqual([
      { key: 'local-resource', type: 'policy-group', location: '/tmp/sfe-fixture/sfe-nodes.list', lastUpdatedAt: null, error: null },
      { key: 'remote-resource', type: 'ruleset', location: 'https://rules.example.test/list', lastUpdatedAt: new Date(1760000000 * 1000), error: null },
    ]);
  });

  test('uses execFile with fixed argv and returns parsed output', async () => {
    const exec = okExec('[]');
    const a = createCliAdapter({ cliPath: CLI, mechanism: allCli, exec, scrub: (s) => s });
    expect(await a.listTempRules()).toEqual([]);
    expect(exec).toHaveBeenCalledWith(CLI, ['--raw', 'dump', 'temp-rule'], expect.objectContaining({ timeout: 15000 }));
  });

  test('primitives not mapped to cli are CAPABILITY_UNVERIFIED and never executed', async () => {
    const exec = okExec('');
    const a = createCliAdapter({ cliPath: CLI, mechanism: { ...allCli, addTempRule: 'http' }, exec, scrub: (s) => s });
    await expect(a.addTempRule('DOMAIN,a.example.test,REJECT')).rejects.toMatchObject({ code: 'CAPABILITY_UNVERIFIED' });
    await expect(a.selectGroupPolicy('SFE-ROUTE', 'REJECT')).rejects.toMatchObject({ code: 'CAPABILITY_UNVERIFIED' });
    expect(exec).not.toHaveBeenCalled();
  });

  test('ENOENT and timeouts are SURGE_UNREACHABLE', async () => {
    const enoent: ExecFn = async () => Promise.reject(Object.assign(new Error('spawn x ENOENT'), { code: 'ENOENT' }));
    const timeout: ExecFn = async () => Promise.reject(Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM', code: null }));
    await expect(createCliAdapter({ cliPath: CLI, mechanism: allCli, exec: enoent, scrub: (s) => s }).listTempRules()).rejects.toMatchObject({ code: 'SURGE_UNREACHABLE' });
    await expect(createCliAdapter({ cliPath: CLI, mechanism: allCli, exec: timeout, scrub: (s) => s }).listTempRules()).rejects.toMatchObject({ code: 'SURGE_UNREACHABLE' });
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

  test('connection refused text maps to SURGE_UNREACHABLE', async () => {
    const exec: ExecFn = async () => Promise.reject(Object.assign(new Error('x'), { code: 1, stdout: '', stderr: 'Surge is not running' }));
    await expect(createCliAdapter({ cliPath: CLI, mechanism: allCli, exec, scrub: (s) => s }).listTempRules()).rejects.toMatchObject({ code: 'SURGE_UNREACHABLE' });
  });

  test('--check non-zero exit is a normal failed check result', async () => {
    const exec: ExecFn = async () => Promise.reject(Object.assign(new Error('x'), { code: 1, stdout: 'Line 3: password=exampleP0 invalid', stderr: '' }));
    const r = await createCliAdapter({ cliPath: CLI, mechanism: allCli, exec, scrub: (s) => s }).checkProfile('/tmp/c.conf');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('password=***');
  });

  test('argv injection is refused before executing', async () => {
    const exec = okExec('');
    const a = createCliAdapter({ cliPath: CLI, mechanism: allCli, exec, scrub: (s) => s });
    await expect(a.updateExternalResource('--all')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(a.addTempRule('DOMAIN,a\nFINAL,DIRECT')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
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

  test('external resources and temp rules over HTTP are unverified on 6.5', async () => {
    const fetchSpy = vi.fn();
    const a = createHttpAdapter({ baseUrl: 'http://127.0.0.1:6171', getKey: async () => KEY, mechanism: allHttp, fetch: fetchSpy as unknown as typeof fetch, scrub: (s) => s });
    for (const p of ['listExternalResources', 'updateExternalResource', 'listTempRules', 'addTempRule', 'removeTempRule'] as const) {
      await expect((a[p] as (...x: unknown[]) => Promise<unknown>)('x')).rejects.toMatchObject({ code: 'CAPABILITY_UNVERIFIED' });
    }
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
