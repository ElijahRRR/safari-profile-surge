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
import { runTestServers } from '../src/commands/test-servers.js';
import { EXIT } from '../src/errors.js';
import { createMemoryOutput, createScriptedPrompter } from '../src/io.js';
import type { CapabilityResult } from '../src/results.js';
import { RunDir } from '../src/run-dir.js';
import { loadState, saveState } from '../src/state.js';
import { TEST_NODES, TEST_PROFILE_FILE } from '../src/test-profile.js';
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
    const auto = result('auto_reload_atomic_replace');
    expect(auto.verdict).toBe('pass');
    expect(auto.summary.join('\n')).toContain('重新读取了该文件');
    expect(result('targeted_resource_refresh').verdict).not.toBe('pass');
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
