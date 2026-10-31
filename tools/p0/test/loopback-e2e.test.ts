// 回环测试资源（D10）命令的离线端到端测试：真实的本机测试服务 + resource-server（产品的 createResourceHost，同一处理程序同时
// 绑定真实的 127.0.0.1 端口与进程内注册表）+ FakeSurge（经进程内注册表下载，每次下载都经过产品的 host.handle() 与场景包装）
// + 迷你代理端口。证明接入、矩阵、读回、key 安全检查、脱敏与 chain/charset 的发布编排；不证明真实 Surge 的任何行为（那必须在
// 测试 Mac 上实测）。

import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LEGACY_NODE_GROUP_LINE, type CapabilityKey } from '@sfe/contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseArgs } from '../src/args.js';
import { main } from '../src/cli.js';
import type { Ctx, Deps } from '../src/commands/common.js';
import { runResourceServer } from '../src/commands/resource-server.js';
import { runTestServers } from '../src/commands/test-servers.js';
import { EXIT } from '../src/errors.js';
import { createMemoryOutput, createScriptedPrompter, type Prompter } from '../src/io.js';
import { readAuditRecords, readResourceLog, readServed, readServerStatus } from '../src/loopback-state.js';
import type { CapabilityResult } from '../src/results.js';
import { RunDir } from '../src/run-dir.js';
import { loadState, saveState } from '../src/state.js';
import { TEST_NODES, TEST_PROFILE_FILE } from '../src/test-profile.js';
import { dualBinder, loopbackSource } from './support/loopback.js';
import { MiniSurge, startMiniSurgeProxy, type MiniProxy } from './support/mini-surge.js';

const SOURCE = ['[General]', 'loglevel = notify', '', '[Proxy]', 'Front-A = socks5, 192.0.2.10, 1080, username=example-user, password=example-pass', '', '[Proxy Group]', 'Daily = select, Front-A, DIRECT', '', '[Rule]', 'DOMAIN-SUFFIX,daily.example.test,Daily', 'IP-CIDR,203.0.113.0/24,DIRECT', 'FINAL,DIRECT', ''].join('\n');

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
}

/** 真实的短等待（resource-server 在同一进程中按间隔与目录监视应用状态文件）。 */
const shortSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, Math.min(ms, 5)));

interface ResourceProc {
  stop: () => void;
  done: Promise<unknown>;
}

export interface LoopbackEnv {
  base: string;
  profileDir: string;
  surge: MiniSurge;
  proxy: MiniProxy;
  registry: Map<number, unknown>;
  resourcePort: number;
  resource: ResourceProc | null;
  stopServers: () => void;
  serversDone: Promise<unknown>;
  deps: (opts?: { answers?: string[]; onPause?: (message: string) => Promise<void> | void }) => Partial<Deps> & { out: ReturnType<typeof createMemoryOutput>; prompt: Prompter & { asked: string[] } };
  run: () => RunDir;
  startResourceServer: (extra?: string[]) => Promise<ResourceProc>;
  stopResourceServer: () => Promise<void>;
  common: () => string[];
}

let env: LoopbackEnv | null = null;

/** 操作员的手动步骤：重新加载配置 → FakeSurge 整体重载。 */
function operator(surge: MiniSurge, extra?: (message: string) => Promise<void> | void) {
  return async (message: string): Promise<void> => {
    if (message.includes('重新加载配置')) await surge.reloadProfile();
    await extra?.(message);
  };
}

export async function createLoopbackEnv(opts: { urlKeys?: boolean; mechanism?: Record<string, 'cli' | 'http'> } = {}): Promise<LoopbackEnv> {
  const base = join(mkdtempSync(join(tmpdir(), 'sfe-p0-loop-')), 'p0');
  const profileDir = mkdtempSync(join(tmpdir(), 'sfe-p0-loop-profiles-'));
  const sourcePath = join(profileDir, 'Daily.conf');
  writeFileSync(sourcePath, SOURCE, { mode: 0o600 });
  const registry = new Map<number, unknown>();
  const baseDeps = (answers: string[] = []) => ({
    out: createMemoryOutput(),
    prompt: createScriptedPrompter(answers, { assumeYes: true }),
    exec: async () => ({ stdout: '', stderr: '', code: -1 }),
    home: '/nonexistent-home',
    platform: 'linux' as const,
    env: {},
    sleep: shortSleep,
    resourceBinder: dualBinder(registry),
    resourcePeerProbe: async () => [{ pid: 4242, command: 'Surge', path: '/Applications/Surge.app/Contents/MacOS/Surge' }],
  });
  expect(await main(['inventory', '--raw-dir', base], baseDeps())).toBe(EXIT.OK);
  const dir = RunDir.open(base, null);
  const st = loadState(dir, new Date());
  saveState(dir, { ...st, mechanism: Object.fromEntries(Object.keys(st.mechanism!).map((k) => [k, opts.mechanism?.[k] ?? 'cli'])) as never });

  let stop!: () => void;
  const stopped = new Promise<void>((r) => (stop = r));
  const args = parseArgs(['test-servers', '--raw-dir', base]);
  args.numbers = { 'echo-port': 0, 'exit-port': 0, 'front-port': 0, 'dead-front-port': await freePort() };
  const serversDone = runTestServers({ args, deps: { ...baseDeps(), now: () => new Date() } as Deps }, () => stopped);
  for (let i = 0; i < 100 && !loadState(dir, new Date()).servers; i++) await new Promise((r) => setTimeout(r, 10));
  expect(await main(['make-test-profile', '--raw-dir', base, '--profile', sourcePath, '--no-http-api', '--yes'], baseDeps())).toBe(EXIT.OK);
  const surge = new MiniSurge({ directory: profileDir, profileFileName: TEST_PROFILE_FILE, remoteSource: loopbackSource(registry), urlKeys: opts.urlKeys ?? false });
  const proxy = await startMiniSurgeProxy(surge);
  const resourcePort = await freePort();
  const e: LoopbackEnv = {
    base,
    profileDir,
    surge,
    proxy,
    registry,
    resourcePort,
    resource: null,
    stopServers: stop,
    serversDone,
    deps: ({ answers = [], onPause } = {}) => {
      const d = baseDeps(answers);
      const prompt = d.prompt;
      const pause = operator(surge, onPause);
      return {
        ...d,
        surgeOverride: surge,
        surgeInstance: () => surge.runningInstance(),
        prompt: Object.assign(prompt, {
          async pause(message: string) {
            prompt.asked.push(message);
            await pause(message);
          },
        }),
      };
    },
    run: () => RunDir.open(base, null),
    async startResourceServer(extra = []) {
      let stopRs!: () => void;
      const stoppedRs = new Promise<void>((r) => (stopRs = r));
      const a = parseArgs(['resource-server', '--raw-dir', base, '--port', String(resourcePort), ...extra]);
      const d = { ...e.deps(), now: () => new Date() } as Deps;
      const done = runResourceServer({ args: a, deps: d }, () => stoppedRs);
      const isSquat = extra.includes('--squat');
      for (let i = 0; i < 200; i++) {
        const s = readServerStatus(RunDir.open(base, null), isSquat ? 'squat' : 'server');
        if (s && s.stoppedAt === null && s.pid === process.pid && Date.parse(s.startedAt) >= Date.now() - 5000) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      const proc = { stop: stopRs, done };
      if (!isSquat) e.resource = proc;
      return proc;
    },
    async stopResourceServer() {
      if (!e.resource) return;
      e.resource.stop();
      await e.resource.done;
      e.resource = null;
    },
    common: () => ['--raw-dir', base, '--proxy', `127.0.0.1:${proxy.port}`, '--yes'],
  };
  return e;
}

export async function closeLoopbackEnv(e: LoopbackEnv): Promise<void> {
  await e.stopResourceServer();
  await e.proxy.close();
  e.stopServers();
  await e.serversDone;
}

/** resource-server + loopback --setup（手动重新加载由 operator 模拟）。 */
export async function setupLoopback(e: LoopbackEnv): Promise<void> {
  await e.startResourceServer();
  const d = e.deps();
  expect(await main(['loopback', '--setup', ...e.common()], d), d.out.text()).toBe(EXIT.OK);
}

function result(key: CapabilityKey): CapabilityResult {
  return env!.run().readJson<CapabilityResult>(`results/${key}.json`)!;
}

/** 运行目录中所有文本文件里是否出现了读取令牌（令牌文件本身除外）。 */
function filesContaining(e: LoopbackEnv, needle: string): string[] {
  const run = e.run();
  return run.listFiles().filter((f) => f !== 'resource-token' && (run.readText(f) ?? '').includes(needle));
}

beforeEach(async () => {
  env = await createLoopbackEnv();
});

afterEach(async () => {
  if (env) await closeLoopbackEnv(env);
  env = null;
});

describe('resource-server and loopback --setup / --rollback', () => {
  it('serves through the product handler with a 0600 token file that never appears on the terminal, logs or call records', async () => {
    const e = env!;
    await e.startResourceServer();
    const run = e.run();
    const token = (run.readText('resource-token') ?? '').trim();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(run.file('resource-token')).mode & 0o777).toBe(0o600);
    const d = e.deps();
    expect(await main(['loopback', '--setup', ...e.common()], d)).toBe(EXIT.OK);
    // 只改写了受管理段中的 SFE-ROUTE 一行（其余行逐字节不变），地址带令牌
    const profile = readFileSync(join(e.profileDir, TEST_PROFILE_FILE), 'utf8');
    expect(profile).toContain(`SFE-ROUTE = select, REJECT, policy-path=http://127.0.0.1:${e.resourcePort}/${token}/sfe-nodes.list`);
    expect(profile).not.toContain(LEGACY_NODE_GROUP_LINE);
    expect(d.prompt.asked.some((q) => q.includes('手动「重新加载配置」'))).toBe(true);
    expect(await e.surge.getGroupMembers('SFE-ROUTE')).toEqual(['REJECT', TEST_NODES.a, TEST_NODES.b]);
    // Surge 第一次加载时的下载由产品处理程序答复 200，并完整写出（审计记录完成）
    const served = readResourceLog(run).filter((x) => x.kind === 'request');
    expect(served.length).toBeGreaterThan(0);
    expect(served.every((x) => x.kind === 'request' && x.handler === 'product' && x.status === 200 && x.tokenOk && x.headers.join(',') === 'host,user-agent')).toBe(true);
    expect(readAuditRecords(run).some((r) => r.complete)).toBe(true);
    // 令牌从不打印、从不写入日志、调用记录、动作时间线或快照
    expect(d.out.text()).not.toContain(token);
    expect(filesContaining(e, token)).toEqual([]);
    expect(loadState(run, new Date()).loopback).toMatchObject({ port: e.resourcePort, setupAt: expect.any(String) });
    expect(e.surge.reloadCount).toBe(1);
    expect(e.surge.calls.updateExternalResource ?? 0).toBe(0);
  });

  it('rollback restores the local line after a manual reload, even when the loopback resource never registered', async () => {
    const e = env!;
    await e.startResourceServer();
    const d1 = e.deps();
    expect(await main(['loopback', '--setup', ...e.common()], d1)).toBe(EXIT.OK);
    const d = e.deps();
    expect(await main(['loopback', '--rollback', ...e.common()], d)).toBe(EXIT.OK);
    const profile = readFileSync(join(e.profileDir, TEST_PROFILE_FILE), 'utf8');
    expect(profile).toContain(LEGACY_NODE_GROUP_LINE);
    expect(profile).not.toContain(`127.0.0.1:${e.resourcePort}`);
    expect((await e.surge.listExternalResources()).some((r) => r.location.startsWith('http://127.0.0.1'))).toBe(false);
    expect(loadState(e.run(), new Date()).loopback?.setupAt).toBeNull();
    expect(d.out.text()).toContain('资源端口已空闲');
  });

  it('refuses to start a second resource server on a held port without trying another port', async () => {
    const e = env!;
    e.registry.set(e.resourcePort, 'held');
    const a = parseArgs(['resource-server', '--raw-dir', e.base, '--port', String(e.resourcePort)]);
    const d = e.deps();
    const ctx: Ctx = { args: a, deps: { ...d, now: () => new Date() } as Deps };
    // 进程内注册表被占用（真实端口仍空闲）：绑定失败即拒绝
    await expect(runResourceServer(ctx, () => Promise.resolve())).rejects.toThrow(/已被占用/);
  });
});

describe('loopback (loopback_resource_update)', () => {
  it('runs the matrix with one single-key update per step, the main-config witness and a positive control, and passes on the fake', async () => {
    const e = env!;
    await setupLoopback(e);
    const d = e.deps();
    const before = e.surge.calls.updateExternalResource ?? 0;
    expect(await main(['loopback', ...e.common()], d)).toBe(EXIT.OK);
    const r = result('loopback_resource_update');
    expect(r.criteria).toBe(r.summary[0]!.replace(/^通过条件：/, ''));
    const failing = r.checks.filter((c) => c.ok !== true);
    expect(failing, JSON.stringify(failing, null, 1)).toEqual([]);
    expect(r.verdict).toBe('pass');
    // 从不 update all；每一步只有一次单 key 更新
    expect(e.surge.updateAllAttempts).toBe(0);
    const updates = (e.surge.calls.updateExternalResource ?? 0) - before;
    const ev = e.run().listFiles('loopback').find((f) => f.startsWith('loopback/update-'))!;
    const evidence = e.run().readJson<{ rows: Array<{ id: string; ok: boolean | null; readback: { failed: string[] } }>; restores: boolean[] }>(ev)!;
    expect(updates).toBe(evidence.rows.length + evidence.restores.length + 2);
    expect(evidence.rows.map((x) => x.id)).toContain('headerOnly');
    expect(evidence.rows.find((x) => x.id === 'validAbBadC')!.readback.failed).toContain('members');
    expect(evidence.rows.find((x) => x.id === 'paramReplaceC')!.readback.failed).toContain('detail:SFE-N-P0-C');
    // 阳性对照与改回原编号各一次手动重新加载（加上接入时的一次）
    expect(e.surge.reloadCount).toBe(3);
    expect(await e.surge.getGroupMembers('SFE-ROUTE')).toEqual(['REJECT', TEST_NODES.a, TEST_NODES.b]);
    expect(await e.surge.getGroupSelection('SFE-ROUTE')).toBe('REJECT');
    expect(readServed(e.run())!.scenario).toBe('ok');
  }, 60_000);

  it('fails the kept-on-failure check when Surge drops the old resource after a failed download', async () => {
    const e = env!;
    await setupLoopback(e);
    const surge = e.surge;
    const real = surge.remoteSource;
    // 模拟“下载失败时清空资源”的 Surge：503 之后返回不含 C 的内容
    surge.remoteSource = (url) => {
      const r = real(url);
      return r.kind === 'http' && r.status === 503 ? { kind: 'http', status: 200, body: `# x\n${(surge.loadedContent(surge.resourceKeyFor(url)) ?? '').split('\n').filter((l) => !l.startsWith(TEST_NODES.c)).join('\n')}\n` } : r;
    };
    expect(await main(['loopback', ...e.common()], e.deps())).toBe(EXIT.OK);
    const r = result('loopback_resource_update');
    expect(r.checks.find((c) => c.name.startsWith('下载失败时保留旧资源'))?.ok).toBe(false);
    expect(r.verdict).toBe('fail');
  }, 60_000);

  it('refuses before any update when the resource key may carry the token and the update primitive is mapped to the CLI', async () => {
    await closeLoopbackEnv(env!);
    env = await createLoopbackEnv({ urlKeys: true });
    const e = env;
    await setupLoopback(e);
    const d = e.deps();
    expect(await main(['loopback', ...e.common()], d)).toBe(EXIT.REFUSED);
    expect(d.out.text()).toContain('更新本机节点资源必须经 Surge HTTP API');
    expect(e.surge.calls.updateExternalResource ?? 0).toBe(0);
  });

  it('masks a token-bearing resource key in call records, the action timeline and snapshots (update through HTTP)', async () => {
    await closeLoopbackEnv(env!);
    env = await createLoopbackEnv({ urlKeys: true, mechanism: { updateExternalResource: 'http' } });
    const e = env;
    await setupLoopback(e);
    expect(await main(['chain', ...e.common()], e.deps())).toBe(EXIT.OK);
    const token = (e.run().readText('resource-token') ?? '').trim();
    expect(e.surge.calls.updateExternalResource ?? 0).toBeGreaterThan(0);
    expect(filesContaining(e, token)).toEqual([]);
    expect(e.run().readText('surge-calls.jsonl')).toContain('<resource-key:masked>');
    expect(e.run().readText('actions.jsonl')).toContain('<resource-key:masked>');
  });
});

describe('chain and charset publish through the loopback resource', () => {
  it('chain proves the front hop with one single-key update per publish and restores A/B', async () => {
    const e = env!;
    await setupLoopback(e);
    expect(await main(['chain', ...e.common()], e.deps())).toBe(EXIT.OK);
    const r = result('external_node_underlying_proxy');
    expect(r.checks.map((c) => c.ok)).toEqual([true, true, true]);
    expect(r.summary.join('\n')).toContain('测试节点经回环测试资源发布');
    expect(await e.surge.getGroupMembers('SFE-ROUTE')).toEqual(['REJECT', TEST_NODES.a, TEST_NODES.b]);
    // 发布与恢复各一次单 key 更新；从不重载
    expect(e.surge.calls.updateExternalResource).toBe(2);
    expect(e.surge.reloadCount).toBe(1);
    const actions = e.run().readJsonl<{ action: string; detail?: { resource?: string } }>('actions.jsonl');
    expect(actions.filter((a) => a.action === 'node_publication_verified' && a.detail?.resource === 'loopback')).toHaveLength(2);
  });

  it('chain is incomplete (never forced by update replay or reload) when the publish readback does not match', async () => {
    const e = env!;
    await setupLoopback(e);
    // Surge 跳过 DEAD（例如解析规则不同）：读回成员不含 DEAD，发布撤回
    e.surge.acceptNodeLine = (line) => !line.startsWith(TEST_NODES.dead) && line.includes('=');
    const d = e.deps();
    expect(await main(['chain', ...e.common()], d)).toBe(EXIT.OK);
    const r = result('external_node_underlying_proxy');
    expect(r.verdict).toBe('incomplete');
    expect(d.out.text()).toContain('没有经读回确认发布');
    expect(e.surge.reloadCount).toBe(1);
    expect(readServed(e.run())!.candidate).toBeNull();
  });

  it('charset proves the baseline, detects altered characters and restores A/B', async () => {
    const e = env!;
    await setupLoopback(e);
    const d = e.deps();
    expect(await main(['charset', '--classes', 'baseline,comma', ...e.common()], d)).toBe(EXIT.OK);
    const res = e.run().readJson<{ published: boolean; outcome: Array<{ id: string; result: string }> }>('charset/result.json')!;
    expect(res.published).toBe(true);
    expect(res.outcome.find((o) => o.id === 'baseline')?.result).toBe('safe');
    expect(res.outcome.find((o) => o.id === 'comma')?.result).not.toBe('safe');
    expect(await e.surge.getGroupMembers('SFE-ROUTE')).toEqual(['REJECT', TEST_NODES.a, TEST_NODES.b]);
    expect(e.surge.calls.updateExternalResource).toBe(2);
  });

  it('chain refuses before setup (no loopback line in the test profile)', async () => {
    const e = env!;
    await e.startResourceServer();
    const d = e.deps();
    expect(await main(['chain', ...e.common()], d)).toBe(EXIT.REFUSED);
    expect(d.out.text()).toContain('loopback --setup');
    expect(e.surge.calls.updateExternalResource ?? 0).toBe(0);
  });
});

describe('loopback-auth (loopback_resource_auth)', () => {
  it('rejects every probe with the same 404 through the product handler, records Surge downloads, binds, squatters and recovery', async () => {
    const e = env!;
    await setupLoopback(e);
    let squat: ResourceProc | null = null;
    const stopSquat = async (): Promise<void> => {
      if (!squat) return;
      squat.stop();
      await squat.done;
      squat = null;
    };
    const onPause = async (m: string): Promise<void> => {
      const mode = /--squat (squat200|squat404)/.exec(m)?.[1];
      if (mode) {
        await stopSquat();
        await e.stopResourceServer();
        squat = await e.startResourceServer(['--squat', mode]);
      } else if (m.includes('重新启动 resource-server')) {
        await stopSquat();
        e.surge.remoteRefreshIntervalMs = null;
        await e.startResourceServer();
      }
    };
    const answers = ['yes', 'uid 502：127.0.0.1 绑定失败', 'y', 'n', 'yes', '1', '1', '~/Library/Caches/example（0600）', 'y'];
    const d = e.deps({ answers, onPause });
    const ask = d.prompt.ask.bind(d.prompt);
    d.prompt.ask = async (q: string) => {
      // 等待定时刷新时打开 Surge 自己的刷新（下一次调用即刷新）；显式更新之前保持关闭
      if (q.includes('定时刷新')) e.surge.remoteRefreshIntervalMs = 1;
      return ask(q);
    };
    const pause = d.prompt.pause.bind(d.prompt);
    d.prompt.pause = async (m: string) => {
      e.surge.remoteRefreshIntervalMs = null;
      return pause(m);
    };
    expect(await main(['loopback-auth', ...e.common()], d)).toBe(EXIT.OK);
    const r = result('loopback_resource_auth');
    const failing = r.checks.filter((c) => c.ok !== true);
    expect(failing, JSON.stringify(failing, null, 1)).toEqual([]);
    expect(r.verdict).toBe('pass');
    const ev = e.run().listFiles('loopback-auth')[0]!;
    const evidence = e.run().readJson<{ probes: Array<{ id: string; status: number }>; phases: Array<{ mode: string; explicit: { verdict: string; tokenReceived: boolean } }> }>(ev)!;
    expect(evidence.probes.filter((p) => p.id !== 'valid').every((p) => p.status === 404)).toBe(true);
    expect(evidence.phases.map((p) => [p.mode, p.explicit.verdict])).toEqual([
      ['squat200', 'unexplained_fetch'],
      ['squat404', 'unexplained_error'],
    ]);
    // 占用者拿到了读取令牌（令牌不认证服务端）：这正是要记录的后果
    expect(evidence.phases.every((p) => p.explicit.tokenReceived)).toBe(true);
    const token = (e.run().readText('resource-token') ?? '').trim();
    expect(d.out.text()).not.toContain(token);
    expect(filesContaining(e, token)).toEqual([]);
    expect(e.surge.updateAllAttempts).toBe(0);
    expect(readServed(e.run())!.probePeers).toBe(false);
  }, 60_000);

  it('is incomplete when the operator skips the second user and the server-down squatting', async () => {
    const e = env!;
    await setupLoopback(e);
    expect(await main(['loopback-auth', ...e.common()], e.deps())).toBe(EXIT.OK);
    const r = result('loopback_resource_auth');
    expect(r.verdict).toBe('incomplete');
    expect(r.checks.find((c) => c.name.startsWith('令牌错误或缺失'))?.ok).toBe(true);
    expect(r.checks.find((c) => c.name.startsWith('服务停止时端口被占用（显式更新）'))?.ok).toBeNull();
  });
});

describe('loopback-restart (loopback_resource_restart)', () => {
  it('records every required variant across phases and passes only when each recovered without loading an uncommitted version', async () => {
    const e = env!;
    await setupLoopback(e);
    let boot = 1_700_000_000;
    const exec = async (file: string, args: readonly string[]) => {
      if (file === '/bin/ps' && args[0] === '-axo') return { stdout: '  404 /Applications/Surge.app/Contents/MacOS/Surge\n', stderr: '', code: 0 };
      if (file === '/bin/ps' && args[0] === '-o') return { stdout: `${e.surge.startedAt.toISOString()}\n`, stderr: '', code: 0 };
      if (file === '/usr/sbin/sysctl') return { stdout: `{ sec = ${boot}, usec = 0 } Sat Oct 31 00:00:00 2026\n`, stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: -1 };
    };
    const step = async (kind: 'surge' | 'mac', variant: string): Promise<void> => {
      const p = e.deps({ answers: [variant] });
      expect(await main(['loopback-restart', '--phase', 'prepare', ...e.common()], { ...p, exec }), p.out.text()).toBe(EXIT.OK);
      if (kind === 'surge') {
        e.surge.restart();
      } else {
        // Mac 重启：资源服务进程也结束；按变体在 Surge 之前或之后（由暂停提示）启动它
        await e.stopResourceServer();
        boot++;
        e.surge.restart();
        if (variant === 'server-before') await e.startResourceServer();
        if (variant === '503') await e.startResourceServer(['--scenario', 'restartUninitialized']);
      }
      const a = e.deps({ onPause: async (m) => void (m.includes('运行 resource-server') && (await e.startResourceServer())) });
      expect(await main(['loopback-restart', '--phase', kind === 'surge' ? 'after-surge-restart' : 'after-mac-restart', ...e.common()], { ...a, exec }), a.out.text()).toBe(EXIT.OK);
    };
    for (const v of ['server-before', 'server-after', 'down', '503', 'candidate']) await step('surge', v);
    expect(result('loopback_resource_restart').verdict).toBe('incomplete');
    for (const v of ['server-after', 'down', '503']) await step('mac', v);
    const r = result('loopback_resource_restart');
    const failing = r.checks.filter((c) => c.ok !== true);
    expect(failing, JSON.stringify(failing, null, 1)).toEqual([]);
    expect(r.verdict).toBe('pass');
    expect(e.surge.updateAllAttempts).toBe(0);
    expect(e.surge.reloadCount).toBe(1);
  }, 60_000);

  it('fails when Surge downloads at launch while an uncommitted candidate is being served', async () => {
    const e = env!;
    await setupLoopback(e);
    e.surge.remoteCacheOnRestart = 'drop';
    const exec = async (file: string, args: readonly string[]) => {
      if (file === '/bin/ps' && args[0] === '-axo') return { stdout: '  404 /Applications/Surge.app/Contents/MacOS/Surge\n', stderr: '', code: 0 };
      if (file === '/bin/ps' && args[0] === '-o') return { stdout: `${e.surge.startedAt.toISOString()}\n`, stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: -1 };
    };
    const p = e.deps({ answers: ['candidate'] });
    expect(await main(['loopback-restart', '--phase', 'prepare', ...e.common()], { ...p, exec })).toBe(EXIT.OK);
    e.surge.restart();
    const a = e.deps();
    expect(await main(['loopback-restart', '--phase', 'after-surge-restart', ...e.common()], { ...a, exec })).toBe(EXIT.OK);
    const r = result('loopback_resource_restart');
    expect(r.checks.find((c) => c.name.startsWith('任何情况下都不会载入'))?.ok).toBe(false);
    expect(r.verdict).toBe('fail');
  });

  it('refuses the after phase when nothing restarted', async () => {
    const e = env!;
    await setupLoopback(e);
    const exec = async (file: string, args: readonly string[]) => {
      if (file === '/bin/ps' && args[0] === '-axo') return { stdout: '  404 /Applications/Surge.app/Contents/MacOS/Surge\n', stderr: '', code: 0 };
      if (file === '/bin/ps' && args[0] === '-o') return { stdout: `${e.surge.startedAt.toISOString()}\n`, stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: -1 };
    };
    expect(await main(['loopback-restart', '--phase', 'prepare', ...e.common()], { ...e.deps({ answers: ['server-before'] }), exec })).toBe(EXIT.OK);
    const a = e.deps();
    expect(await main(['loopback-restart', '--phase', 'after-surge-restart', ...e.common()], { ...a, exec })).toBe(EXIT.REFUSED);
    expect(a.out.text()).toContain('没有重启');
  });
});

describe('loopback-crash (loopback_publish_crash)', () => {
  it('records Surge after each interruption, a second update while updating, and recovery to the committed version', async () => {
    const e = env!;
    await setupLoopback(e);
    e.surge.slowUpdate = { durationMs: 100 };
    const d = e.deps({ answers: ['y'] });
    expect(await main(['loopback-crash', ...e.common()], d)).toBe(EXIT.OK);
    const r = result('loopback_publish_crash');
    const failing = r.checks.filter((c) => c.ok !== true);
    expect(failing, JSON.stringify(failing, null, 1)).toEqual([]);
    expect(r.verdict).toBe('pass');
    const ev = e.run().listFiles('loopback-crash')[0]!;
    const obs = e.run().readJson<{ observations: Array<{ case: string; version: string; recovered: boolean }> }>(ev)!.observations;
    // 中断之后 Surge 都保留了已提交版本（假 Surge：失败的下载保留旧资源）
    expect(obs.map((o) => [o.case, o.version])).toEqual([
      ['after_candidate', 'committed'],
      ['during_update', 'committed'],
      ['mid_response', 'committed'],
      ['second_update', 'committed'],
    ]);
    expect(e.surge.updateAllAttempts).toBe(0);
    expect(await e.surge.getGroupMembers('SFE-ROUTE')).toEqual(['REJECT', TEST_NODES.a, TEST_NODES.b]);
    expect(readServed(e.run())!.candidate).toBeNull();
  }, 60_000);

  it('leaves the during-update cases incomplete when Surge never reports updating', async () => {
    const e = env!;
    await setupLoopback(e);
    expect(await main(['loopback-crash', ...e.common()], e.deps({ answers: ['y'] }))).toBe(EXIT.OK);
    const r = result('loopback_publish_crash');
    expect(r.verdict).toBe('incomplete');
    expect(r.checks.find((c) => c.name.startsWith('更新进行中中断'))?.ok).toBeNull();
    expect(r.checks.find((c) => c.name.startsWith('服务重启后'))?.ok).toBe(true);
  }, 60_000);
});
