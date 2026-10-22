// 命令编排的离线端到端测试：真实的本机测试服务（回显、SOCKS5 出口与前置）+ FakeSurge 规则求值 +
// 迷你代理端口。证明 refresh / chain / preflight / charset / entry --to 的写入守卫、恢复与结论推导；
// 不证明真实 Surge 的任何行为（那必须在测试 Mac 上实测）。

import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NODE_RESOURCE_FILE } from '@sfe/contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseArgs } from '../src/args.js';
import { main } from '../src/cli.js';
import type { Ctx, Deps } from '../src/commands/common.js';
import { runContinuity } from '../src/commands/continuity.js';
import { resourceHealth } from '../src/commands/refresh.js';
import { runTestServers } from '../src/commands/test-servers.js';
import { EXIT } from '../src/errors.js';
import { createMemoryOutput, createScriptedPrompter } from '../src/io.js';
import type { CapabilityResult } from '../src/results.js';
import { RunDir } from '../src/run-dir.js';
import { loadState, recordTempRuleIntent, saveState } from '../src/state.js';
import { TEST_NODES, TEST_PROFILE_FILE, TEST_USERS } from '../src/test-profile.js';
import { MiniSurge, startMiniSurgeProxy, type MiniProxy } from './support/mini-surge.js';

const SOURCE = [
  '[General]',
  'loglevel = notify',
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

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
}

interface Env {
  base: string;
  profileDir: string;
  surge: MiniSurge;
  proxy: MiniProxy;
  stopServers: () => void;
  serversDone: Promise<unknown>;
  deps: (answers?: string[]) => Partial<Deps> & { out: ReturnType<typeof createMemoryOutput> };
  run: () => RunDir;
}

let env: Env | null = null;

beforeEach(async () => {
  const base = join(mkdtempSync(join(tmpdir(), 'sfe-p0-e2e-')), 'p0');
  const profileDir = mkdtempSync(join(tmpdir(), 'sfe-p0-profiles-'));
  const sourcePath = join(profileDir, 'Daily.conf');
  writeFileSync(sourcePath, SOURCE, { mode: 0o600 });
  const baseDeps = (answers: string[] = []) => ({
    out: createMemoryOutput(),
    prompt: createScriptedPrompter(answers, { assumeYes: true }),
    exec: async () => ({ stdout: '', stderr: '', code: -1 }),
    home: '/nonexistent-home',
    platform: 'linux' as const,
    env: {},
    sleep: async () => undefined,
  });
  expect(await main(['inventory', '--raw-dir', base], baseDeps())).toBe(EXIT.OK);
  // 离线测试中所有原语都由 FakeSurge 提供：映射记为 cli（实际调用走注入的适配器）。
  const dir = RunDir.open(base, null);
  const st = loadState(dir, new Date());
  saveState(dir, { ...st, mechanism: Object.fromEntries(Object.keys(st.mechanism!).map((k) => [k, 'cli'])) as never });

  let stop!: () => void;
  const stopped = new Promise<void>((r) => (stop = r));
  const args = parseArgs(['test-servers', '--raw-dir', base]);
  args.numbers = { 'echo-port': 0, 'exit-port': 0, 'front-port': 0, 'dead-front-port': await freePort() };
  const d = baseDeps();
  const ctx: Ctx = { args, deps: { ...d, now: () => new Date() } as Deps };
  const serversDone = runTestServers(ctx, () => stopped);
  for (let i = 0; i < 100 && !loadState(dir, new Date()).servers; i++) await new Promise((r) => setTimeout(r, 10));
  expect(await main(['make-test-profile', '--raw-dir', base, '--profile', sourcePath, '--no-http-api', '--yes'], baseDeps())).toBe(EXIT.OK);
  const surge = new MiniSurge({ directory: profileDir, profileFileName: TEST_PROFILE_FILE });
  const proxy = await startMiniSurgeProxy(surge);
  env = {
    base,
    profileDir,
    surge,
    proxy,
    stopServers: stop,
    serversDone,
    // 版本来源：FakeSurge 模拟的运行实例（与服务同一形状的结果；真实读取需要 macOS）
    deps: (answers = []) => ({ ...baseDeps(answers), surgeOverride: surge, surgeInstance: () => surge.runningInstance() }),
    run: () => RunDir.open(base, null),
  };
});

afterEach(async () => {
  if (!env) return;
  await env.proxy.close();
  env.stopServers();
  await env.serversDone;
  env = null;
});

function result(key: string): CapabilityResult {
  return env!.run().readJson<CapabilityResult>(`results/${key}.json`)!;
}

function common(): string[] {
  return ['--raw-dir', env!.base, '--proxy', `127.0.0.1:${env!.proxy.port}`, '--yes'];
}

describe('P0 commands end to end (offline harness)', () => {
  it('refresh measures targeted refresh, re-read and fallback, then restores everything', async () => {
    const d = env!.deps();
    expect(await main(['refresh', '--auto-reload', 'off', ...common()], d)).toBe(EXIT.OK);
    expect(result('auto_reload_atomic_replace').verdict).toBe('pass');
    expect(result('targeted_resource_refresh').verdict).toBe('pass');
    // 刷新前、刚刷新后与 1 秒后各记录一次资源状态（ready=false 解析为未就绪）。
    expect(result('targeted_resource_refresh').checks.find((c) => c.name === '资源没有错误')?.note).toBe('刷新前 正常，刷新后立即 正常，1 秒后 正常');
    expect(result('policy_path_reread').verdict).toBe('pass');
    const fixed = result('fixed_profile_no_switch');
    expect(fixed.checks.find((c) => c.name.includes('实际经过'))?.ok).toBe(true);
    // Chrome 测试页没有上报 → 不完整，而不是通过
    expect(fixed.verdict).toBe('incomplete');
    expect(await env!.surge.getGroupMembers('SFE-ROUTE')).toEqual(['REJECT', TEST_NODES.a, TEST_NODES.b]);
    expect(await env!.surge.getGroupSelection('SFE-ROUTE')).toBe('REJECT');
    expect(env!.surge.reloadCount).toBe(0);
    expect(env!.surge.calls.reloadProfile ?? 0).toBe(0);
  });

  it('refresh fails targeted refresh when an atomic replace reloads the profile', async () => {
    env!.surge.autoReload = true;
    expect(await main(['refresh', '--auto-reload', 'on', ...common()], env!.deps())).toBe(EXIT.OK);
    // 原子替换触发重新读取：该设置下结论为“不通过”，不能被提议为 supported，也不能作为 any 的证据。
    const auto = result('auto_reload_atomic_replace');
    expect(auto.verdict).toBe('fail');
    expect(auto.checks.find((c) => c.name === '原子替换不触发重新读取')?.ok).toBe(false);
    expect(auto.summary.join('\n')).toContain('重新读取了该文件');
    expect(result('targeted_resource_refresh').verdict).not.toBe('pass');
  });

  it('auto-reload any cannot be proposed when atomic replace reloads with auto-reload on', async () => {
    const propose = async (...extra: string[]) => {
      const d = env!.deps();
      const code = await main(['propose', 'auto_reload_atomic_replace', ...extra, '--working-profile', 'any', '--dry-run', '--raw-dir', env!.base], d);
      return { code, text: d.out.text() };
    };
    expect(await main(['refresh', '--auto-reload', 'off', ...common()], env!.deps())).toBe(EXIT.OK);
    env!.surge.autoReload = true;
    expect(await main(['refresh', '--auto-reload', 'on', ...common()], env!.deps())).toBe(EXIT.OK);
    // 如实记录：开时原子替换会重新读取 → 只能提议不支持。
    expect((await propose('supported', '--auto-reload', 'on')).code).toBe(EXIT.REFUSED);
    expect((await propose('unsupported', '--auto-reload', 'on')).code).toBe(EXIT.OK);
    // 切回关并重测后：关可以提议支持，any 不可以（开时没有通过的证据）。
    env!.surge.autoReload = false;
    // canary 编号按秒取：时钟前移，避免与上一次（已被重新读取的）canary 同号。
    expect(await main(['refresh', '--auto-reload', 'off', ...common()], { ...env!.deps(), now: () => new Date(Date.now() + 5_000) })).toBe(EXIT.OK);
    expect(result('auto_reload_atomic_replace').verdict).toBe('pass');
    const any = await propose('supported', '--auto-reload', 'any');
    expect(any.code).toBe(EXIT.REFUSED);
    expect(any.text).toContain('缺少：自动重载开');
    expect((await propose('supported', '--auto-reload', 'off')).code).toBe(EXIT.OK);
  });

  it('propose refuses version-dependent capabilities when the running Surge version cannot be read', async () => {
    // 运行实例无法证明（例如 Surge 已在磁盘上更新但还没有重新打开）：测量与提议时都读不到版本。
    env!.surge.instanceFailure = 'modified_after_start';
    expect(await main(['refresh', '--auto-reload', 'off', ...common()], env!.deps())).toBe(EXIT.OK);
    expect(result('auto_reload_atomic_replace')).toMatchObject({ verdict: 'pass', context: { surgeVersion: null, surgeBuild: null } });
    for (const status of ['supported', 'unsupported']) {
      const d = env!.deps();
      const code = await main(['propose', 'auto_reload_atomic_replace', status, '--working-profile', 'any', '--auto-reload', 'off', '--dry-run', '--raw-dir', env!.base], d);
      expect(code, status).toBe(EXIT.REFUSED);
      expect(d.out.text()).toContain('该能力依赖 Surge 版本，但读不到');
      expect(d.out.text()).toContain('运行中的 Surge 无法确认：Surge 启动后包被更新或修改，请重新打开 Surge');
    }
    expect(existsSync(join(env!.run().path, 'proposals'))).toBe(false);
  });

  it('propose refuses version-dependent capabilities when the version was read only because P0 waits longer than the service', async () => {
    // codesign 用了 20 秒：P0 读到 6.5.0（10960），服务的 15 秒超时内读不到（signature_invalid）
    const slow = async () => {
      const r = await env!.surge.runningInstance();
      return { result: r, steps: [{ rule: 'signature' as const, outcome: 'pass' as const, detail: { code: 0 }, ms: 20_000 }], cached: false };
    };
    expect(await main(['refresh', '--auto-reload', 'off', ...common()], { ...env!.deps(), surgeInstance: slow })).toBe(EXIT.OK);
    expect(result('auto_reload_atomic_replace')).toMatchObject({ verdict: 'pass', context: { surgeVersion: null, surgeBuild: null } });
    const d = { ...env!.deps(), surgeInstance: slow };
    const code = await main(['propose', 'auto_reload_atomic_replace', 'supported', '--working-profile', 'any', '--auto-reload', 'off', '--dry-run', '--raw-dir', env!.base], d);
    expect(code).toBe(EXIT.REFUSED);
    expect(d.out.text()).toContain('该能力依赖 Surge 版本，但读不到');
    expect(d.out.text()).toContain('读到了运行中 Surge 的版本，但服务在它的时限内读不到：签名校验耗时 20.000 秒');
    expect(existsSync(join(env!.run().path, 'proposals'))).toBe(false);
  });

  it('the measured context takes the Surge version from the running instance, never from getVersion', async () => {
    env!.surge.version = '6.5.2';
    env!.surge.build = '10970';
    let versionCalls = 0;
    env!.surge.getVersion = async () => {
      versionCalls++;
      return { version: '9.9.9', build: '99999' };
    };
    const before = env!.surge.instanceReads;
    expect(await main(['refresh', '--auto-reload', 'off', ...common()], env!.deps())).toBe(EXIT.OK);
    expect(result('auto_reload_atomic_replace').context).toMatchObject({ surgeVersion: '6.5.2', surgeBuild: '10970' });
    expect(env!.surge.instanceReads).toBeGreaterThan(before);
    expect(versionCalls).toBe(0);
  });

  it('continuity --reload-test arms the canary and never reports a reload it did not see', async () => {
    const args = parseArgs(['continuity', '--reload-test', ...common()]);
    const d = env!.deps();
    const ctx: Ctx = { args, deps: { ...d, now: () => new Date() } as Deps };
    expect(await runContinuity(ctx, () => new Promise((r) => setTimeout(r, 300)))).toBe(EXIT.OK);
    expect(d.out.text()).not.toContain('canary 在没有刷新时已被读取');
    const r = result('same_profile_reload_impact');
    expect(r.verdict).toBe('incomplete');
    expect(r.checks.find((c) => c.name === '确实发生了同一配置重载')?.ok).toBeNull();
    expect(r.checks.find((c) => c.name.startsWith('其他应用不受影响'))?.ok).toBeNull();
    expect(env!.run().readJsonl<{ action: string }>('actions.jsonl').some((a) => a.action === 'canary_armed')).toBe(true);
    expect(env!.surge.reloadCount).toBe(0);
  });

  it('chain proves the front hop and that dead or missing fronts never connect', async () => {
    expect(await main(['chain', ...common()], env!.deps())).toBe(EXIT.OK);
    const r = result('external_node_underlying_proxy');
    expect(r.checks.map((c) => c.ok)).toEqual([true, true, true]);
    expect(r.verdict).toBe('pass');
    const resource = await env!.run().readText('state.json');
    expect(resource).toBeTruthy();
    expect(await env!.surge.getGroupMembers('SFE-ROUTE')).toEqual(['REJECT', TEST_NODES.a, TEST_NODES.b]);
  });

  it('preflight shows testPolicy reached the unselected node without changing the selection', async () => {
    expect(await main(['preflight', ...common()], env!.deps())).toBe(EXIT.OK);
    const r = result('independent_node_preflight');
    expect(r.verdict).toBe('pass');
    expect(r.summary.join('\n')).toContain('测的是当前选择');
  });

  it('charset proves the baseline and detects altered characters', async () => {
    const d = env!.deps();
    expect(await main(['charset', '--classes', 'baseline,comma', ...common()], d)).toBe(EXIT.OK);
    const outcome = env!.run().readJson<{ outcome: Array<{ id: string; result: string }> }>('charset/result.json')!.outcome;
    expect(outcome.find((o) => o.id === 'baseline')?.result).toBe('safe');
    expect(outcome.find((o) => o.id === 'comma')?.result).not.toBe('safe');
    expect(d.out.text()).toContain('已证明安全的类别');
    const files = await import('node:fs').then((fs) => fs.readFileSync(join(env!.profileDir, NODE_RESOURCE_FILE), 'utf8'));
    expect(files).not.toContain('p0cs');
  });

  it('entry --to switches the ruleset entry with readback and back to NORMAL', async () => {
    const safari = join(env!.profileDir, 'Safari');
    writeFileSync(safari, '');
    const args = ['entry', '--strategy', 'ruleset_resource', '--process-path', safari, '--auto-reload-condition', 'off', ...common()];
    const d1 = env!.deps();
    expect(await main([...args, '--to', 'BLOCKED'], d1)).toBe(EXIT.OK);
    expect(d1.out.text()).toContain('已切换到 BLOCKED');
    expect(env!.surge.simulateRequest({ processPath: safari, host: 'shop.example.test', protocol: 'tcp' }).policyName).toBe('REJECT');
    const d2 = env!.deps();
    expect(await main([...args, '--to', 'NORMAL'], d2)).toBe(EXIT.OK);
    expect(env!.surge.simulateRequest({ processPath: safari, host: 'shop.example.test', protocol: 'tcp' }).policyName).toBe('DIRECT');
    expect(env!.surge.reloadCount).toBe(0);
  });

  it('entry never injects (or later rolls back) a temp rule the user already has, and derives UDP coverage from evidence', async () => {
    const safari = join(env!.profileDir, 'Safari');
    writeFileSync(safari, '');
    const userRule = 'DOMAIN, api.ipify.org, DIRECT';
    await env!.surge.addTempRule(userRule);
    // 同一进程路径、结论为通过的归属结果：非 UDP 门槛项可由它补足（记为 limitation 并写明来源）。
    const attrCoverage = Object.fromEntries(['ipv4', 'ipv6', 'http1', 'http2', 'http3_quic', 'websocket', 'extension_page_fetch'].map((i) => [i, { result: 'pass', note: null }]));
    const run = env!.run();
    run.writeJson('results/safari_process_attribution.json', { key: 'safari_process_attribution', command: 'attribution', at: new Date().toISOString(), verdict: 'pass', checks: [], summary: [], context: {}, coverage: attrCoverage, processPaths: [safari] });
    const args = ['entry', '--strategy', 'ruleset_resource', '--process-path', safari, '--auto-reload-condition', 'off', '--precedence-test', 'temp', '--dwell', '0', '--no-kill-test', ...common()];
    // 旧版本在 BLOCKED 与 VERIFY_ONLY 下各问一次弹窗「重新检测」的结果；那是服务执行的检测，不是扩展页面请求。
    // 即使操作员两次都回答“成功”，也不能被当作扩展页面请求不经入口的证据（工具不再询问）。
    const prompter = createScriptedPrompter(['', 'y', 'y'], { assumeYes: true });
    expect(await main(args, { ...env!.deps(), prompt: prompter })).toBe(EXIT.OK);
    expect(prompter.asked.filter((q) => q.includes('重新检测'))).toEqual([]);
    const entry = result('runtime_entry_modes');
    const temp = entry.checks.find((c) => c.name.startsWith('入口优先于用户临时规则'))!;
    expect(temp.ok).toBeNull();
    expect(temp.note).toContain('已存在相同的用户临时规则');
    expect(env!.surge.tempRules).toEqual([userRule]);
    expect(loadState(env!.run(), new Date()).tempRules.some((r) => r.purpose === 'precedence-test')).toBe(false);
    const d = env!.deps();
    expect(await main(['rollback', '--raw-dir', env!.base], d)).toBe(EXIT.OK);
    expect(d.out.text()).not.toContain('api.ipify.org');
    const cov = result('safari_udp_quic_handling').coverage!;
    for (const item of ['ipv6', 'websocket', 'extension_page_fetch'] as const) {
      expect(cov[item]!.result).toBe('limitation');
      expect(cov[item]!.note).toContain('由 safari_process_attribution 覆盖');
    }
  });

  it('entry counts the first ACTIVE WebSocket open that lands right after the readback confirmation', async () => {
    const safari = join(env!.profileDir, 'Safari');
    writeFileSync(safari, '');
    // 真实时序：VERIFY_ONLY 下 REJECT 让测试页每 2 秒重试，ACTIVE 生效后的第一次重试就在读回确认后 2 秒内建立并一直保持。
    // 在 ACTIVE 读回确认后（停留开始时）上报这一次建立与首条消息。
    const d = env!.deps();
    let wrote = false;
    d.sleep = async () => {
      if (wrote || !d.out.text().includes('ACTIVE：读回 ACTIVE')) return;
      wrote = true;
      const t = Date.now();
      env!.run().appendJsonl('servers/page.jsonl', { app: 'safari', events: [{ t, kind: 'ws_open', ok: true }, { t: t + 1, kind: 'ws_first', ok: true, via: TEST_USERS.a }] });
      await new Promise((r) => setTimeout(r, 20));
    };
    const args = ['entry', '--strategy', 'ruleset_resource', '--process-path', safari, '--auto-reload-condition', 'off', '--dwell', '0', '--no-kill-test', ...common()];
    expect(await main(args, d)).toBe(EXIT.OK);
    expect(wrote).toBe(true);
    // 没有归属结果可借：只有入口运行自己测到这次建立，WebSocket 才会是 pass（旧版本加了 2 秒稳定时间，会把它滤掉而记为 not_tested）。
    expect(result('safari_udp_quic_handling').coverage!.websocket).toEqual({ result: 'pass', note: expect.stringContaining(`经过 ${TEST_USERS.a}`) });
  });

  it('rollback confirms removal with the same normalisation as the plan', async () => {
    // Surge 列出时改变了逗号周围的空格；按原文删除没有删掉它，读回必须仍判定为存在。
    const rule = 'DOMAIN,p0-rollback.invalid,REJECT';
    const listed = 'DOMAIN, p0-rollback.invalid, REJECT';
    const dir = env!.run();
    // listTempRules 已由插入探测正向确认：读回才会被当作删除的证据。
    saveState(dir, recordTempRuleIntent({ ...loadState(dir, new Date()), tempListConfirmed: true }, rule, 'entry', new Date()));
    await env!.surge.addTempRule(listed);
    const d = env!.deps();
    expect(await main(['rollback', '--execute', '--raw-dir', env!.base, '--yes'], d)).toBe(1);
    expect(d.out.text()).toContain('读回仍存在');
    expect(d.out.text()).not.toContain('已删除');
    expect(loadState(env!.run(), new Date()).tempRules.find((r) => r.rule === rule)?.state).toBe('intent');
  });

  it('entry records its temp rules as present even when Surge lists them reformatted', async () => {
    const safari = join(env!.profileDir, 'Safari');
    writeFileSync(safari, '');
    const surge = env!.surge;
    const list = surge.listTempRules.bind(surge);
    surge.listTempRules = async () => (await list()).map((r) => r.replace(/,/g, ', '));
    const d = env!.deps();
    expect(await main(['entry', '--strategy', 'temp_rule', '--process-path', safari, '--temp-insertion', 'tail', '--to', 'BLOCKED', ...common()], d)).toBe(EXIT.OK);
    const ours = loadState(env!.run(), new Date()).tempRules.filter((r) => r.purpose === 'entry');
    const present = ours.filter((r) => r.state === 'present');
    expect(present.length).toBeGreaterThan(0);
    expect((await list()).length).toBe(present.length);
    const r = env!.deps();
    expect(await main(['rollback', '--raw-dir', env!.base], r)).toBe(EXIT.OK);
    expect(r.out.text()).toContain(`删除本工具添加的 ${present.length} 条`);
  });

  it('the temp_rule sequence always probes and stops before any entry write when listTempRules does not list the probe rules', async () => {
    const safari = join(env!.profileDir, 'Safari');
    writeFileSync(safari, '');
    const surge = env!.surge;
    const list = surge.listTempRules.bind(surge);
    // 输出格式可以识别，内容却不含刚添加的规则（例如映射到了别的列表，或空白输出被读成空列表）。
    surge.listTempRules = async () => [];
    const d = env!.deps();
    // 没有 --probe-insertion：temp_rule 主序列也必须先正向确认 listTempRules。
    const args = ['entry', '--strategy', 'temp_rule', '--process-path', safari, '--temp-insertion', 'tail', '--dwell', '0', '--no-kill-test', ...common()];
    expect(await main(args, d)).toBe(EXIT.REFUSED);
    expect(d.out.text()).toContain('没有列出刚添加的探测规则（有效规则中能看到它们）：该原语映射不可用');
    expect(d.out.text()).not.toContain('BLOCKED：读回');
    // 确认提示中不再承诺 --to NORMAL 永远可用。
    expect(d.out.text()).not.toContain('永远可用');
    expect(d.out.text()).toContain('改用 rollback --execute');
    // 探测规则已删除，入口规则从未写入，也不登记从未写入的规则。
    expect(surge.tempRules).toEqual([]);
    const st = loadState(env!.run(), new Date());
    expect(st.tempListConfirmed).toBe(false);
    expect(st.tempRules.filter((r) => r.purpose === 'entry')).toEqual([]);
    const r = env!.deps();
    expect(await main(['rollback', '--raw-dir', env!.base], r)).toBe(EXIT.OK);
    expect(r.out.text()).toContain('当前临时规则列表不可信');
    expect(r.out.text()).toContain('没有需要删除的本工具规则');
    // 读回不可信时 --to 也无法确认 NORMAL：指向 rollback，而不是报告“已切换”。
    const n = env!.deps();
    expect(await main(['entry', '--strategy', 'temp_rule', '--process-path', safari, '--to', 'NORMAL', ...common()], n)).toBe(EXIT.REFUSED);
    expect(n.out.text()).toContain('rollback --execute');
    expect(n.out.text()).not.toContain('已切换到');
    // 列表修好后，--to 先重新探测；确认成功覆盖“不可用”的结论后才切换。
    surge.listTempRules = list;
    const again = env!.deps();
    expect(await main(['entry', '--strategy', 'temp_rule', '--process-path', safari, '--temp-insertion', 'tail', '--to', 'BLOCKED', ...common()], again)).toBe(EXIT.OK);
    expect(again.out.text()).toContain('列出了刚添加的探测规则');
    expect(again.out.text()).toContain('已切换到 BLOCKED');
    expect(loadState(env!.run(), new Date()).tempListConfirmed).toBe(true);
  });

  it('entry --to refuses temp_rule targets other than NORMAL until listTempRules is positively confirmed', async () => {
    const safari = join(env!.profileDir, 'Safari');
    writeFileSync(safari, '');
    const surge = env!.surge;
    const list = surge.listTempRules.bind(surge);
    // 添加后读取失败（例如超时）：本次无法确认，但不等于映射不可用，也不写入入口规则。
    let reads = 0;
    surge.listTempRules = async () => {
      if (reads++ === 1) throw Object.assign(new Error('读取临时规则失败：Surge 没有响应'), { code: 'SURGE_UNREACHABLE' });
      return list();
    };
    const d = env!.deps();
    expect(await main(['entry', '--strategy', 'temp_rule', '--process-path', safari, '--temp-insertion', 'tail', '--to', 'BLOCKED', ...common()], d)).toBe(EXIT.REFUSED);
    expect(d.out.text()).toContain('listTempRules 没有经过正向确认');
    expect(d.out.text()).not.toContain('已切换到');
    expect(surge.tempRules).toEqual([]);
    // 读取失败不记为“不可用”：之后 --to NORMAL 仍可用，再次探测成功即可切换。
    const st = loadState(env!.run(), new Date());
    expect(st.tempListConfirmed).toBeNull();
    expect(st.tempRules.filter((r) => r.purpose === 'entry')).toEqual([]);
    const ok = env!.deps();
    expect(await main(['entry', '--strategy', 'temp_rule', '--process-path', safari, '--temp-insertion', 'tail', '--to', 'BLOCKED', ...common()], ok)).toBe(EXIT.OK);
    expect(ok.out.text()).toContain('列出了刚添加的探测规则');
    expect(ok.out.text()).toContain('已切换到 BLOCKED');
    expect(loadState(env!.run(), new Date()).tempListConfirmed).toBe(true);
  });

  it('never records a temp rule as gone from an unconfirmed list, so rollback still removes it', async () => {
    const safari = join(env!.profileDir, 'Safari');
    writeFileSync(safari, '');
    const surge = env!.surge;
    const args = ['entry', '--strategy', 'temp_rule', '--process-path', safari, '--temp-insertion', 'tail'];
    expect(await main([...args, '--to', 'BLOCKED', ...common()], env!.deps())).toBe(EXIT.OK);
    const block = surge.tempRules.slice();
    expect(block.length).toBeGreaterThan(0);
    // 运行目录来自没有正向确认的旧版本；之后 --raw dump temp-rule 输出空白，被读成空列表。
    const dir = env!.run();
    saveState(dir, { ...loadState(dir, new Date()), tempListConfirmed: null });
    const list = surge.listTempRules.bind(surge);
    surge.listTempRules = async () => [];
    const n = env!.deps();
    expect(await main([...args, '--to', 'NORMAL', ...common()], n)).toBe(EXIT.OK);
    expect(n.out.text()).toContain('读回不能证明本工具的临时规则已删除');
    // 规则仍在 Surge 中，运行状态也没有把它记为已删除。
    expect(await list()).toEqual(block);
    const latest = new Map(loadState(env!.run(), new Date()).tempRules.map((r) => [r.rule, r.state] as const));
    for (const rule of block) expect(latest.get(rule)).not.toBe('removed');
    const plan = env!.deps();
    expect(await main(['rollback', '--raw-dir', env!.base], plan)).toBe(EXIT.OK);
    expect(plan.out.text()).not.toContain('没有需要删除的本工具规则');
    expect(plan.out.text()).toContain('没有经过正向确认');
    const ex = env!.deps();
    // 删除后无法用未确认的列表读回确认：如实报告未确认（退出码 1），但规则确实被删除了。
    expect(await main(['rollback', '--execute', '--raw-dir', env!.base, '--yes'], ex)).toBe(1);
    expect(ex.out.text()).toContain('无法读回确认');
    expect(await list()).toEqual([]);
  });

  it('entry --probe-insertion measures the profile boundary from the test profile rule texts', async () => {
    const safari = join(env!.profileDir, 'Safari');
    writeFileSync(safari, '');
    const surge = env!.surge;
    // 真实解析不报告规则来源。
    const listRules = surge.listRules.bind(surge);
    surge.listRules = async () => (await listRules()).map((x) => ({ ...x, source: x.source === 'module' ? ('module' as const) : ('unknown' as const) }));
    const d = env!.deps();
    const args = ['entry', '--strategy', 'ruleset_resource', '--process-path', safari, '--auto-reload-condition', 'off', '--probe-insertion', '--dwell', '0', '--no-kill-test', ...common()];
    expect(await main(args, d)).toBe(EXIT.OK);
    expect(d.out.text()).toContain('临时规则排在测试配置规则之前');
    expect(d.out.text()).toContain('列出了刚添加的探测规则');
    expect(loadState(env!.run(), new Date()).tempListConfirmed).toBe(true);
    expect(surge.tempRules).toEqual([]);
  });

  it('entry refuses without a valid Safari process path', async () => {
    const d = env!.deps();
    expect(await main(['entry', '--strategy', 'ruleset_resource', '--to', 'BLOCKED', ...common()], d)).toBe(EXIT.REFUSED);
    expect(d.out.text()).toContain('Safari 进程路径');
  });

  it('refuses writes when Surge is not on the test profile', async () => {
    env!.surge.currentProfile = { name: '我的配置', path: null };
    const d = env!.deps();
    expect(await main(['chain', ...common()], d)).toBe(EXIT.REFUSED);
    expect(d.out.text()).toContain('SFE-P0-测试');
    expect(env!.surge.calls.selectGroupPolicy ?? 0).toBe(0);
    expect(env!.surge.calls.updateExternalResource ?? 0).toBe(0);
  });
});

describe('resourceHealth', () => {
  const res = (error: string | null) => ({ key: 'k', type: 'policy-path', location: '/x/sfe-nodes.list', lastUpdatedAt: null, error });
  it('classifies without echoing Surge error text', () => {
    expect(resourceHealth([res(null)])).toBe('正常');
    expect(resourceHealth([res('not_ready')])).toBe('未就绪');
    expect(resourceHealth([res('fetch https://x.example.test/a failed')])).toBe('有错误');
    expect(resourceHealth([])).toBe('读不到');
    expect(resourceHealth([res(null), res(null)])).toBe('多个 key');
  });
});
