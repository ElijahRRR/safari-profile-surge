// 命令编排的离线端到端测试：真实的本机测试服务（回显、SOCKS5 出口与前置）+ FakeSurge 规则求值 +
// 迷你代理端口。证明 refresh / chain / preflight / charset / entry --to 的写入守卫、恢复与结论推导；
// 不证明真实 Surge 的任何行为（那必须在测试 Mac 上实测）。

import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NODE_RESOURCE_FILE } from '@sfe/contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseArgs } from '../src/args.js';
import { main } from '../src/cli.js';
import type { Ctx, Deps } from '../src/commands/common.js';
import { runContinuity } from '../src/commands/continuity.js';
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
    deps: (answers = []) => ({ ...baseDeps(answers), surgeOverride: surge }),
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
    saveState(dir, recordTempRuleIntent(loadState(dir, new Date()), rule, 'entry', new Date()));
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
