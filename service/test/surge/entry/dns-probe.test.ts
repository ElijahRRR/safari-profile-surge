// 回归：rule match 探测不能依赖 DNS。真实配置常有不带 no-resolve 的 IP 规则；求值走到它时，目标是域名就要做 DNS 查询，
// “If the DNS lookup fails, rule evaluation aborts and the request fails with a DNS error”（https://manual.nssurge.com/rules/ip.html）。
// 2026-10-24 测试 Mac（Surge 6.10.0 / 12500）：`rule match p0-inventory.invalid …` 退出 1（DNS 空回答），改用 192.0.2.1 退出 0。
// 假 Surge 按同一文档建模（`.invalid` 名称总是解析失败），这里的配置在入口段之后放一条 IP-CIDR 规则（不带 no-resolve）。

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { ENTRY_MODE_BITS, ENTRY_RULESET_FILES, SfeError, type KnownEntryMode } from '@sfe/contract';
import type { EntryController, SurgeAdapter, SurgeRuleMatchInput } from '../../../src/ports.js';
import { createCliAdapter, type ExecFn } from '../../../src/surge/cli-adapter.js';
import { isAllowedCliArgv, ruleMatchArgs } from '../../../src/surge/cli-commands.js';
import { FAKE_CHROME_PATH, FAKE_SAFARI_PATH, FAKE_VERIFY_HOST, FakeSurge, createFakeSurgeEnvironment, fakeRuleMatchDnsError } from '../../../src/surge/fake.js';
import { createProfileFiles, type ManagedProfileFiles } from '../../../src/surge/files.js';
import { nodeLine, parseEntryRuleSetFile, resourceFile } from '../../../src/surge/generate.js';
import { isRuleMatchUnavailable, probeReadFailure } from '../../../src/surge/entry/common.js';
import { createMemoryEntryOwnership, type MemoryEntryOwnership } from '../../../src/surge/entry/ownership.js';
import { createRulesetStrategy, ownedRulesetRecords } from '../../../src/surge/entry/ruleset-strategy.js';
import { DnsLookupFailure, evaluateCondition, parseCondition, parseRule } from '../../../src/surge/rules.js';
import { createTempRuleStrategy } from '../../../src/surge/entry/temp-rule-strategy.js';
import { SURGE_PRIMITIVES } from '../../../src/surge/primitives.js';

const NODE = 'SFE-N-E0001-US01-v001';
const SITE = 'www.example.test';
/** 用户规则：入口段之后、FINAL 之前一条不带 no-resolve 的 IP 规则（原始失败条件）。 */
const USER_RULES = ['DOMAIN-SUFFIX,daily.example.test,Daily', 'IP-CIDR,203.0.113.0/24,DIRECT'];
const BITS = ['udp', 'verify', 'block', 'active'] as const;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sfe-dns-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function newFake(strategy: 'ruleset_resource' | 'temp_rule', clock?: { t: number }): Promise<FakeSurge> {
  createFakeSurgeEnvironment(dir, { entryStrategy: strategy, userRules: USER_RULES, ipRule: null });
  const fake = new FakeSurge({ directory: dir, watchLocalPolicyPaths: true, ...(clock ? { now: () => new Date(clock.t) } : {}) });
  writeFileSync(
    join(dir, 'sfe-nodes.list'),
    resourceFile(1, [nodeLine({ name: NODE, host: '203.0.113.10', port: 1080, username: null, password: null, front: 'Front-A' })]),
  );
  await fake.selectGroupPolicy('SFE-ROUTE', NODE);
  return fake;
}

/** 包装适配器：记录每一次 rule match 的输入与结果（或错误）。 */
function spy(fake: FakeSurge, log: Array<{ input: SurgeRuleMatchInput; rule?: string; error?: unknown }>, override?: (input: SurgeRuleMatchInput) => void): SurgeAdapter {
  return new Proxy(fake, {
    get(target, prop) {
      if (prop === 'matchRule') {
        return async (input: SurgeRuleMatchInput) => {
          try {
            override?.(input);
            const r = await target.matchRule(input);
            log.push({ input, rule: r.rule });
            return r;
          } catch (e) {
            log.push({ input, error: e });
            throw e;
          }
        };
      }
      const v: unknown = Reflect.get(target, prop, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  }) as unknown as SurgeAdapter;
}

interface RulesetHarness {
  fake: FakeSurge;
  files: ManagedProfileFiles;
  ownership: MemoryEntryOwnership;
  ctrl: EntryController;
  clock: { t: number };
  log: Array<{ input: SurgeRuleMatchInput; rule?: string; error?: unknown }>;
}

async function setupRuleset(opts: { latencyMs?: number; siteHosts?: string[]; override?: (input: SurgeRuleMatchInput) => void } = {}): Promise<RulesetHarness> {
  const clock = { t: 1_700_000_000_000 };
  const fake = await newFake('ruleset_resource', clock);
  fake.localWatchLatencyMs = opts.latencyMs ?? 0;
  const files = createProfileFiles({ directory: dir, hmacKey: 'example-hmac-key' });
  const ownership = createMemoryEntryOwnership(await ownedRulesetRecords(files));
  const log: RulesetHarness['log'] = [];
  let n = 0;
  const ctrl = createRulesetStrategy({
    adapter: spy(fake, log, opts.override),
    files,
    ownership,
    config: () => ({ processPaths: [FAKE_SAFARI_PATH], verifyHost: FAKE_VERIFY_HOST, siteHosts: opts.siteHosts ?? [SITE] }),
    operationId: () => 'op_test',
    autoReloadCondition: () => 'off',
    watch: { timeoutMs: 2000, pollMs: 100 },
    now: () => clock.t,
    sleep: async (ms) => {
      clock.t += ms;
    },
    witnessToken: () => `d${(++n).toString(16).padStart(6, '0')}`,
  });
  return { fake, files, ownership, ctrl, clock, log };
}

/** Safari 与 Chrome 的实际结果（经假 Surge 的已加载规则求值）。 */
function observe(fake: FakeSurge, other = SITE): { tcpVerify: string; tcpOther: string; udpOther: string; chrome: Array<string | null> } {
  const policy = (processPath: string, host: string, protocol: 'tcp' | 'udp'): string => fake.simulateRequest({ processPath, host, protocol }).policyName ?? 'DNS-FAILED';
  return {
    tcpVerify: policy(FAKE_SAFARI_PATH, FAKE_VERIFY_HOST, 'tcp'),
    tcpOther: policy(FAKE_SAFARI_PATH, other, 'tcp'),
    udpOther: policy(FAKE_SAFARI_PATH, other, 'udp'),
    chrome: [fake.simulateRequest({ processPath: FAKE_CHROME_PATH, host: other, protocol: 'tcp' }).policyName, fake.simulateRequest({ processPath: FAKE_CHROME_PATH, host: FAKE_VERIFY_HOST, protocol: 'udp' }).policyName],
  };
}

const EXPECT: Record<KnownEntryMode, { tcpVerify: string; tcpOther: string; udpOther: string }> = {
  NORMAL: { tcpVerify: 'DIRECT', tcpOther: 'DIRECT', udpOther: 'DIRECT' },
  BLOCKED: { tcpVerify: 'REJECT', tcpOther: 'REJECT', udpOther: 'REJECT' },
  VERIFY_ONLY: { tcpVerify: 'SFE-ROUTE', tcpOther: 'REJECT', udpOther: 'REJECT' },
  ACTIVE: { tcpVerify: 'SFE-ROUTE', tcpOther: 'SFE-ROUTE', udpOther: 'REJECT' },
};

const CYCLE: Array<{ to: KnownEntryMode; undo?: true }> = [{ to: 'BLOCKED' }, { to: 'VERIFY_ONLY' }, { to: 'ACTIVE' }, { to: 'BLOCKED', undo: true }, { to: 'NORMAL', undo: true }];

describe('the fake models the documented DNS behaviour of IP rules', () => {
  test('a domain that cannot resolve fails rule match once evaluation reaches an IP rule; an IP literal never resolves; domain rules before it never look up', async () => {
    const fake = await newFake('ruleset_resource');
    // .invalid（RFC 6761）走到 IP 规则：与 CLI 退出 1 相同的错误
    const err = (await fake.matchRule({ host: 'p0-inventory.invalid', processPath: '/usr/bin/true', protocol: 'TCP' }).catch((e: unknown) => e)) as SfeError;
    expect(err).toBeInstanceOf(SfeError);
    expect(err.code).toBe('SURGE_COMMAND_FAILED');
    expect(err.details).toEqual({ primitive: 'matchRule', exitCode: 1 });
    // 文档地址 IP 字面量：退出 0，返回 rule 与 policy，不查询 DNS
    const before = fake.dnsQueries.length;
    expect(await fake.matchRule({ host: '192.0.2.1', processPath: '/usr/bin/true', protocol: 'TCP' })).toEqual({ rule: 'FINAL,DIRECT', policy: 'DIRECT' });
    expect(await fake.matchRule({ host: '203.0.113.7', processPath: '/usr/bin/true', protocol: 'TCP' })).toEqual({ rule: 'IP-CIDR,203.0.113.0/24,DIRECT', policy: 'DIRECT' });
    expect(fake.dnsQueries.length).toBe(before);
    // 在 IP 规则之前命中的 DOMAIN 规则不查询（“never trigger a DNS lookup”）
    expect((await fake.matchRule({ host: 'a.daily.example.test', processPath: '/usr/bin/true', protocol: 'TCP' })).policy).toBe('Daily');
    expect(fake.dnsQueries.length).toBe(before);
    // 可解析的域名：查询一次，按第一条 A 记录比较
    fake.dnsRecords.set('mapped.example.test', { v4: '203.0.113.9', v6: null });
    expect((await fake.matchRule({ host: 'mapped.example.test', processPath: '/usr/bin/true', protocol: 'TCP' })).rule).toBe('IP-CIDR,203.0.113.0/24,DIRECT');
    expect(fake.dnsQueries.slice(before)).toEqual(['mapped.example.test']);
    // 模拟请求：同样的求值，DNS 失败的请求失败，没有命中的规则
    const r = fake.simulateRequest({ processPath: FAKE_CHROME_PATH, host: 'sfe-disabled.invalid', protocol: 'tcp' });
    expect(r).toMatchObject({ rule: null, policyName: null, failed: true });
  });

  test('no-resolve skips the lookup (on the rule or on the RULE-SET line), and FINAL with dns-failed answers instead of failing', async () => {
    createFakeSurgeEnvironment(dir, { entryStrategy: 'temp_rule', userRules: ['IP-CIDR,203.0.113.0/24,DIRECT,no-resolve', 'RULE-SET,ip-set.list,REJECT,no-resolve'], ipRule: null });
    writeFileSync(join(dir, 'ip-set.list'), 'IP-CIDR,198.51.100.0/24\nGEOIP,UNKNOWN\n');
    const fake = new FakeSurge({ directory: dir });
    expect(await fake.matchRule({ host: 'x.invalid', processPath: '/usr/bin/true', protocol: 'TCP' })).toEqual({ rule: 'FINAL,DIRECT', policy: 'DIRECT' });
    expect(fake.dnsQueries).toEqual([]);
    // IP 字面量照样匹配 no-resolve 的规则（“The rule still matches requests that target IP literals.”）；GEOIP,UNKNOWN 匹配空结果
    expect((await fake.matchRule({ host: '192.0.2.1', processPath: '/usr/bin/true', protocol: 'TCP' })).rule).toBe('RULE-SET,ip-set.list,REJECT,no-resolve');
    rmSync(join(dir, 'ip-set.list'));
    createFakeSurgeEnvironment(dir, { entryStrategy: 'temp_rule', userRules: [], ipRule: 'GEOIP,US,DIRECT' });
    const profile = join(dir, '日常-Safari环境.conf');
    writeFileSync(profile, readFileSync(profile, 'utf8').replace('FINAL,DIRECT', 'FINAL,Daily,dns-failed'));
    const withFinal = new FakeSurge({ directory: dir });
    expect(await withFinal.matchRule({ host: 'x.invalid', processPath: '/usr/bin/true', protocol: 'TCP' })).toEqual({ rule: 'FINAL,Daily,dns-failed', policy: 'Daily' });
  });
});

describe('IP rule evaluation (rules/ip.html) and the probe argv', () => {
  const facts = (host: string) => ({ processPath: '/usr/bin/true', host, protocol: 'tcp' as const });
  test('IP literals match directly; domains look up once through the context; no-resolve skips an unresolved domain', () => {
    const cidr = parseCondition('IP-CIDR,203.0.113.0/24')!;
    expect(evaluateCondition(cidr, facts('203.0.113.200'))).toBe(true);
    expect(evaluateCondition(cidr, facts('192.0.2.1'))).toBe(false);
    expect(evaluateCondition(parseCondition('IP-CIDR,192.0.2.1')!, facts('192.0.2.1'))).toBe(true);
    expect(evaluateCondition(parseCondition('IP-CIDR6,2001:db8::/32')!, facts('2001:db8::5'))).toBe(true);
    expect(evaluateCondition(parseCondition('GEOIP,UNKNOWN')!, facts('192.0.2.1'))).toBe(true);
    expect(evaluateCondition(parseCondition('GEOIP,US')!, facts('192.0.2.1'))).toBe(false);
    // 子规则的选项被保留（规则集文件中的 no-resolve）
    expect(parseCondition('IP-CIDR,203.0.113.0/24,no-resolve')).toEqual({ type: 'IP-CIDR', value: '203.0.113.0/24', operands: null, options: ['no-resolve'] });
    const lookups: string[] = [];
    const ctx = {
      lookup: (host: string, resolve: boolean) => {
        if (!resolve) return null;
        lookups.push(host);
        if (host.endsWith('.invalid')) throw new DnsLookupFailure(host);
        return { v4: '203.0.113.9', v6: null };
      },
    };
    expect(evaluateCondition(cidr, facts('a.example.test'), ctx)).toBe(true);
    expect(() => evaluateCondition(cidr, facts('x.invalid'), ctx)).toThrow(DnsLookupFailure);
    expect(evaluateCondition(parseCondition('IP-CIDR,203.0.113.0/24,no-resolve')!, facts('y.invalid'), ctx)).toBe(false);
    expect(evaluateCondition(cidr, facts('z.invalid'), ctx, true)).toBe(false);
    // 进程与域名规则从不查询
    expect(evaluateCondition(parseRule('AND,((PROCESS-NAME,/var/empty/sfe-entry-disabled),(DOMAIN,w.invalid)),REJECT')!.condition, facts('w.invalid'), ctx)).toBe(false);
    expect(lookups).toEqual(['a.example.test', 'x.invalid']);
  });

  test('rule match argv accepts the documentation IP and the witness path (CLI allowlist unchanged)', () => {
    const argv = ruleMatchArgs({ host: '192.0.2.1', processPath: '/var/empty/sfe-entry-witness-active-0a1b2c3d', protocol: 'TCP', port: 443 });
    expect(argv).toEqual(['192.0.2.1', 'process-path=/var/empty/sfe-entry-witness-active-0a1b2c3d', 'protocol=TCP', 'dest-port=443']);
    expect(isAllowedCliArgv(['--raw', 'rule', 'match', ...argv])).toBe(true);
    expect(isAllowedCliArgv(['--raw', 'rule', 'match', ...ruleMatchArgs({ host: '192.0.2.1', processPath: FAKE_CHROME_PATH, protocol: 'UDP', port: 443 })])).toBe(true);
  });
});

describe('a rule match DNS failure is a read failure that fails closed, never "rule match unavailable"', () => {
  // TODO(P0)：P0 第 1 项记录测试 Mac 上 DNS 失败时 rule match 的实际输出（stderr 文字或 JSON {error}）后，用脱敏后的原文替换这些合成文字。
  const outputs: Array<{ label: string; err: Record<string, unknown> | null; ok?: { stdout: string; stderr: string } }> = [
    { label: 'stderr text, exit 1', err: { code: 1, stdout: '', stderr: 'Error: DNS lookup failed (empty answer)\n' } },
    { label: 'JSON error envelope, exit 1', err: { code: 1, stdout: '{"error":"DNS resolve failed: no answer"}', stderr: '' } },
    { label: 'JSON error envelope, exit 0', err: null, ok: { stdout: '{"error":"DNS resolve failed: no answer"}', stderr: '' } },
  ];
  for (const o of outputs) {
    test(`CLI adapter: ${o.label} → SURGE_COMMAND_FAILED without a reason (not unreachable, not unsupported)`, async () => {
      const exec: ExecFn = async () => {
        if (o.err) throw Object.assign(new Error('exit'), o.err);
        return o.ok!;
      };
      const mechanism = Object.fromEntries(SURGE_PRIMITIVES.map((p) => [p, 'cli' as const]));
      const adapter = createCliAdapter({ cliPath: '/Applications/Surge.app/Contents/Applications/surge-cli', mechanism, exec, scrub: (s) => s });
      const e = (await adapter.matchRule({ host: 'p0-inventory.invalid', processPath: '/usr/bin/true', protocol: 'TCP', port: 443 }).catch((x: unknown) => x)) as SfeError;
      expect(e).toBeInstanceOf(SfeError);
      expect(e.code).toBe('SURGE_COMMAND_FAILED');
      expect(e.details?.primitive).toBe('matchRule');
      expect(e.details?.reason).toBeUndefined();
      expect(isRuleMatchUnavailable(e)).toBe(false);
      expect(probeReadFailure(e)).toMatchObject({ ok: false, readFailed: true });
      expect(probeReadFailure(e).ruleMatchUnavailable).toBeUndefined();
    });
  }

  test('the fake raises the same shape as the CLI adapter for exit 1', () => {
    const e = fakeRuleMatchDnsError();
    expect(e.code).toBe('SURGE_COMMAND_FAILED');
    expect(e.details).toEqual({ primitive: 'matchRule', exitCode: 1 });
    expect(isRuleMatchUnavailable(e)).toBe(false);
  });

  test('ruleset_resource: a DNS failure while reading the witness during normal mode stops the step (no unwitnessed fallback, nothing claimed)', async () => {
    let failWitness = false;
    const h = await setupRuleset({
      override: (input) => {
        if (failWitness && input.processPath.startsWith('/var/empty/')) throw fakeRuleMatchDnsError();
      },
    });
    expect((await h.ctrl.transition('ACTIVE')).mode).toBe('ACTIVE');
    failWitness = true;
    const err = (await h.ctrl.transition('BLOCKED', undefined, { undo: true, towardNormal: true }).catch((e: unknown) => e)) as SfeError;
    expect(err).toBeInstanceOf(SfeError);
    expect(err.code).toBe('SURGE_COMMAND_FAILED');
    expect(err.details).toMatchObject({ lastConfirmedBits: null });
    expect(err.details?.runtimeConfirmed).toBeUndefined();
    // 退路（rule match 不可用时等满上限）没有被采用：读回不是未经运行时确认的 BLOCKED
    const rb = await h.ctrl.read();
    expect(rb.mode).toBe('UNKNOWN');
    expect(rb.runtimeConfirmed).toBeUndefined();
  });

  // ARCHITECTURE §0「DNS 失败（待用户决定，现按失败即关闭）」：撤销入口时真实主机（检测主机）的探测因 DNS 失败。
  // 固定当前行为；用户对 D5、D6 作出不同决定时一并修改这两条测试。
  test('ruleset_resource: a DNS failure of the verify host while undoing the entry stops the step (READBACK_MISMATCH, nothing confirmed, reads UNKNOWN)', async () => {
    const h = await setupRuleset();
    expect((await h.ctrl.transition('ACTIVE')).mode).toBe('ACTIVE');
    h.fake.dnsFailures.add(FAKE_VERIFY_HOST);
    const err = (await h.ctrl.transition('BLOCKED', undefined, { undo: true, towardNormal: true }).catch((e: unknown) => e)) as SfeError;
    expect(err).toBeInstanceOf(SfeError);
    expect(err.code).toBe('READBACK_MISMATCH');
    expect(err.details).toMatchObject({ lastConfirmedBits: null });
    expect(err.details?.runtimeConfirmed).toBeUndefined();
    // 失败的确实是真实主机的 DNS（见证探测的目标是 IP 字面量，照常回答）
    expect(h.log.some((x) => x.input.host === FAKE_VERIFY_HOST && x.error instanceof SfeError && x.error.code === 'SURGE_COMMAND_FAILED')).toBe(true);
    expect(h.log.filter((x) => x.input.processPath.startsWith('/var/empty/')).every((x) => x.error === undefined)).toBe(true);
    const rb = await h.ctrl.read();
    expect(rb.mode).toBe('UNKNOWN');
    expect(rb.runtimeConfirmed).toBeUndefined();
  });

  test('temp_rule: a DNS failure of the verify host while undoing the entry ends BLOCKED unconfirmed, then NORMAL from the temp-rule list', async () => {
    const fake = await newFake('temp_rule');
    const log: RulesetHarness['log'] = [];
    const ctrl = createTempRuleStrategy({
      adapter: spy(fake, log),
      ownership: createMemoryEntryOwnership(),
      config: () => ({ processPaths: [FAKE_SAFARI_PATH], verifyHost: FAKE_VERIFY_HOST, siteHosts: [SITE] }),
      operationId: () => 'op_test',
      insertion: 'head',
    });
    expect((await ctrl.transition('ACTIVE')).mode).toBe('ACTIVE');
    fake.dnsFailures.add(FAKE_VERIFY_HOST);
    const blocked = await ctrl.transition('BLOCKED', undefined, { undo: true, towardNormal: true });
    expect(blocked).toMatchObject({ mode: 'BLOCKED', runtimeConfirmed: false });
    expect(log.some((x) => x.input.host === FAKE_VERIFY_HOST && x.error instanceof SfeError && x.error.code === 'SURGE_COMMAND_FAILED')).toBe(true);
    // 普通模式按临时规则列表读回（没有本应用的临时规则），不经过依赖 DNS 的探测
    const normal = await ctrl.transition('NORMAL', undefined, { undo: true });
    expect(normal.mode).toBe('NORMAL');
    expect(normal.evidence).toEqual(['临时规则：无', '有效规则顺序：无']);
    expect(fake.tempRules).toEqual([]);
  });
});

describe('ruleset_resource on a profile with an IP rule after the entry', () => {
  test('full cycle NORMAL → BLOCKED → VERIFY_ONLY → ACTIVE → BLOCKED → NORMAL: every step confirmed by its witness and the readback', async () => {
    // 监视延迟 300 ms：每一步的第一次见证轮询都发生在 Surge 加载这一版之前
    const h = await setupRuleset({ latencyMs: 300 });
    expect((await h.ctrl.read()).mode).toBe('NORMAL');
    for (const { to, undo } of CYCLE) {
      const steps: string[] = [];
      const rb = await h.ctrl.transition(to, (st) => steps.push(`${st.bit}${st.value ? '+' : '-'}`), undo ? { undo } : undefined);
      expect(rb.mode, to).toBe(to);
      expect(rb.bits).toEqual(ENTRY_MODE_BITS[to]);
      expect(rb.evidence.filter((e) => e.includes('见证一致'))).toHaveLength(4);
      const o = observe(h.fake);
      expect({ tcpVerify: o.tcpVerify, tcpOther: o.tcpOther, udpOther: o.udpOther }, to).toEqual(EXPECT[to]);
      expect(o.chrome).toEqual(['DIRECT', 'DIRECT']);
      expect((await h.ctrl.read()).mode).toBe(to);
    }
    // 没有一次 rule match 失败；见证探测的目标都是文档地址 IP 字面量，没有任何探测用 `.invalid` 主机
    expect(h.log.filter((x) => x.error !== undefined)).toEqual([]);
    expect(h.log.some((x) => x.input.host.endsWith('.invalid'))).toBe(false);
    // 尚未加载的见证得到的是正常回答（用户规则或 FINAL），不是读取失败
    const witnessPolls = h.log.filter((x) => x.input.processPath.startsWith('/var/empty/'));
    expect(witnessPolls.every((x) => x.input.host === '192.0.2.1')).toBe(true);
    expect(witnessPolls.some((x) => x.rule === 'FINAL,DIRECT')).toBe(true);
  });

  test('a witness of a version not loaded yet is reported as not loaded (a normal answer), not as a read failure', async () => {
    const h = await setupRuleset();
    h.fake.localWatchLatencyMs = 60_000;
    const err = (await h.ctrl.transition('BLOCKED').catch((e: unknown) => e)) as SfeError;
    // 等满时限：结果未知，但原因是监视超时，而不是 rule match 读取失败
    expect(err.code).toBe('READBACK_MISMATCH');
    expect(err.details).toMatchObject({ reason: 'watch_timeout', failedStep: { bit: 'block', value: true } });
    const rb = await h.ctrl.read();
    expect(rb.mode).toBe('UNKNOWN');
    expect(rb.evidence).toContain('规则集 block：已加载的不是文件中的这一版');
    expect(rb.evidence).toContain('异常：not_loaded_block');
    expect(rb.evidence.join(' ')).not.toContain('读回失败');
    // 监视赶上之后：同一版见证一致，下一次切换按事实确认归属并完成
    h.clock.t += 120_000;
    h.fake.localWatchLatencyMs = 0;
    expect((await h.ctrl.transition('BLOCKED')).mode).toBe('BLOCKED');
  });

  test('no site host configured: the "other host" probes are the documentation IP and the cycle still completes', async () => {
    const h = await setupRuleset({ siteHosts: [] });
    for (const { to, undo } of CYCLE) expect((await h.ctrl.transition(to, undefined, undo ? { undo } : undefined)).mode).toBe(to);
    expect(h.log.filter((x) => x.error !== undefined)).toEqual([]);
    expect(h.log.filter((x) => x.input.processPath === FAKE_SAFARI_PATH).map((x) => x.input.host)).toContain('192.0.2.1');
  });
});

describe('temp_rule with no site host configured, on a profile with an IP rule after the entry', () => {
  test('readback works in every mode; the IP-literal "other host" probe hits blockOther in VERIFY_ONLY and active in ACTIVE', async () => {
    const fake = await newFake('temp_rule');
    const log: RulesetHarness['log'] = [];
    const ctrl = createTempRuleStrategy({
      adapter: spy(fake, log),
      ownership: createMemoryEntryOwnership(),
      config: () => ({ processPaths: [FAKE_SAFARI_PATH], verifyHost: FAKE_VERIFY_HOST, siteHosts: [] }),
      operationId: () => 'op_test',
      insertion: 'head',
    });
    for (const { to, undo } of CYCLE) {
      const start = log.length;
      const rb = await ctrl.transition(to, undefined, undo ? { undo } : undefined);
      expect(rb.mode, to).toBe(to);
      expect((await ctrl.read()).mode).toBe(to);
      const o = observe(fake, '192.0.2.1');
      expect({ tcpVerify: o.tcpVerify, tcpOther: o.tcpOther, udpOther: o.udpOther }, to).toEqual(EXPECT[to]);
      expect(o.chrome).toEqual(['DIRECT', 'DIRECT']);
      const other = log.slice(start).filter((x) => x.input.processPath === FAKE_SAFARI_PATH && x.input.host === '192.0.2.1' && x.input.protocol === 'TCP');
      if (to === 'VERIFY_ONLY') expect(other.at(-1)?.rule).toMatch(/\(NOT,\(\(DOMAIN,verify\.example\.test\)\)\)\),REJECT$/);
      if (to === 'ACTIVE') expect(other.at(-1)?.rule).toMatch(/^AND,\(\(PROCESS-NAME,[^)]+\),\(NOT,\(\(PROTOCOL,UDP\)\)\)\),SFE-ROUTE$/);
    }
    expect(log.filter((x) => x.error !== undefined)).toEqual([]);
    expect(log.some((x) => x.input.host.endsWith('.invalid'))).toBe(false);
  });
});

describe('files written by earlier versions', () => {
  const LEGACY_WITNESS = (bit: string, token: string): string => `AND,((PROCESS-NAME,/var/empty/sfe-entry-witness),(DOMAIN,sfe-entry-${bit}-${token}.invalid))`;
  const PREVIOUS_PLACEHOLDER = 'AND,((PROCESS-NAME,/var/empty/sfe-entry-witness),(DOMAIN,sfe-disabled.invalid))';

  async function writeLegacy(h: RulesetHarness, body: (bit: (typeof BITS)[number]) => string): Promise<void> {
    for (const bit of BITS) {
      const name = ENTRY_RULESET_FILES[bit];
      await h.files.writeAtomic(name, `# SFE managed entry rule set · ${bit}\n${body(bit)}\n`, await h.files.digest(name));
      await h.ownership.confirm('entry_ruleset_file', name, 'present', await h.files.digest(name));
    }
    h.clock.t += 1; // 监视加载旧格式文件（延迟 0：下一次调用即加载）
  }

  test('the previous witness format (synthetic process + .invalid host) is recognised but never taken as proof; the next switch rewrites the files', async () => {
    const h = await setupRuleset();
    await writeLegacy(h, (bit) => `${LEGACY_WITNESS(bit, 'off')}\n${PREVIOUS_PLACEHOLDER}`);
    const rb = await h.ctrl.read();
    // 全部为占位规则：只由 Safari/对照探测核对，读作 NORMAL，但不声称见证一致
    expect(rb.mode).toBe('NORMAL');
    expect(rb.witnessConfirmed).toBe(false);
    for (const bit of BITS) {
      expect(rb.evidence).toContain(`规则集 ${bit}：文件没有见证规则`);
      expect(rb.evidence).toContain(`规则集 ${bit}：旧格式见证规则（按 .invalid 主机），不作为已加载的证明，下一次切换时改写`);
    }
    // 旧格式见证从不探测：没有任何 rule match 用 `.invalid` 主机或旧的合成进程
    expect(h.log.some((x) => x.input.host.endsWith('.invalid') || x.input.processPath === '/var/empty/sfe-entry-witness')).toBe(false);
    expect(h.log.filter((x) => x.error !== undefined)).toEqual([]);
    expect((await h.ctrl.transition('BLOCKED')).mode).toBe('BLOCKED');
    expect((await h.ctrl.transition('NORMAL', undefined, { undo: true })).mode).toBe('NORMAL');
    const after = await h.ctrl.read();
    expect(after.witnessConfirmed).toBeUndefined();
    expect(after.evidence.filter((e) => e.includes('见证一致'))).toHaveLength(4);
    for (const bit of BITS) {
      const parsed = parseEntryRuleSetFile(bit, (await h.files.read(ENTRY_RULESET_FILES[bit]))!);
      expect(parsed.legacyWitness).toBe(false);
      expect(parsed.witness).not.toBeNull();
      expect(readFileSync(join(dir, ENTRY_RULESET_FILES[bit]), 'utf8')).not.toContain('.invalid');
    }
  });

  test('both older placeholder forms read as off; a legacy witness in an ACTIVE-looking file reads UNKNOWN (no proof) and normal mode rewrites it', async () => {
    const h = await setupRuleset();
    await writeLegacy(h, (bit) =>
      bit === 'udp' ? 'DOMAIN,sfe-disabled.invalid' : bit === 'active' ? `${LEGACY_WITNESS('active', 'ab12')}\nPROCESS-NAME,${FAKE_SAFARI_PATH}` : `${LEGACY_WITNESS(bit, 'off')}\n${PREVIOUS_PLACEHOLDER}`,
    );
    const rb = await h.ctrl.read();
    expect(rb.bits).toEqual({ udp: false, verify: false, block: false, active: true });
    expect(rb.mode).toBe('UNKNOWN');
    expect(rb.evidence).toContain('规则集 active：文件没有见证规则');
    // 撤销入口照常完成，改写全部文件（按未知规划：先开 block）
    expect((await h.ctrl.transition('BLOCKED', undefined, { undo: true, towardNormal: true })).mode).toBe('BLOCKED');
    expect((await h.ctrl.transition('NORMAL', undefined, { undo: true })).mode).toBe('NORMAL');
    for (const bit of BITS) expect(parseEntryRuleSetFile(bit, (await h.files.read(ENTRY_RULESET_FILES[bit]))!).witness).not.toBeNull();
    expect(h.log.filter((x) => x.error !== undefined)).toEqual([]);
  });

  test('a file mixing the legacy and the current witness is unrecognised (fails closed)', async () => {
    const h = await setupRuleset();
    const name = ENTRY_RULESET_FILES.verify;
    await h.files.writeAtomic(
      name,
      `# SFE managed entry rule set · verify\nPROCESS-NAME,/var/empty/sfe-entry-witness-verify-ab12\n${LEGACY_WITNESS('verify', 'cd34')}\nPROCESS-NAME,/var/empty/sfe-entry-disabled\n`,
      await h.files.digest(name),
    );
    await h.ownership.confirm('entry_ruleset_file', name, 'present', await h.files.digest(name));
    const rb = await h.ctrl.read();
    expect(rb.mode).toBe('UNKNOWN');
    expect(rb.evidence).toContain('异常：file_unrecognized_verify');
  });
});
