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
import type { RestartObservation } from '../src/commands/loopback-restart.js';
import { runResourceServer } from '../src/commands/resource-server.js';
import { runTestServers } from '../src/commands/test-servers.js';
import { EXIT } from '../src/errors.js';
import { createMemoryOutput, createScriptedPrompter, type Prompter } from '../src/io.js';
import { readAuditRecords, readResourceLog, readServed, readServerStatus, requestsBetween } from '../src/loopback-state.js';
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

/** lsof 实测监听地址的替身：资源服务（同一进程）只监听 127.0.0.1:<端口>；其他命令读不到。 */
function lsofListen(e: LoopbackEnv, names?: string[]) {
  return async (file: string, args: readonly string[]) =>
    file === '/usr/sbin/lsof' && args.includes('-sTCP:LISTEN') && args.includes(String(process.pid))
      ? { stdout: `p${process.pid}\nf12\n${(names ?? [`127.0.0.1:${e.resourcePort}`]).map((n) => `n${n}`).join('\n')}\n`, stderr: '', code: 0 }
      : { stdout: '', stderr: '', code: -1 };
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
    // 同名替换的服务器、端口与前置都由 getPolicyDetail 读到新值
    expect((evidence.rows.find((x) => x.id === 'paramReplaceC') as unknown as { detailC: unknown }).detailC).toEqual({ server: '192.0.2.33', port: 9, underlyingProxy: 'P0-Front-Dead' });
    // 阳性对照与改回原编号各一次手动重新加载（加上接入时的一次）
    expect(e.surge.reloadCount).toBe(3);
    expect(await e.surge.getGroupMembers('SFE-ROUTE')).toEqual(['REJECT', TEST_NODES.a, TEST_NODES.b]);
    expect(await e.surge.getGroupSelection('SFE-ROUTE')).toBe('REJECT');
    expect(readServed(e.run())!.scenario).toBe('ok');
  }, 60_000);

  it('regression: other resources changed by the manual reloads of the positive control are recorded, not blamed on the single-key updates', async () => {
    const e = env!;
    await setupLoopback(e);
    // 另一个外部资源（例如用户配置中的远端规则集）在每次整体重新加载时被刷新
    const reloadsBefore = e.surge.reloadCount;
    const list = e.surge.listExternalResources.bind(e.surge);
    e.surge.listExternalResources = async () => {
      const other = { key: 'ffffffffffffffffffffffffffffffff', type: 'ruleset', location: 'https://rules.example.test/x.list', locationHash: 'h', lastUpdatedAt: new Date(1_000 + (e.surge.reloadCount - reloadsBefore) * 1000), error: null, local: false, updating: false, fromModule: null };
      return [...(await list()), other] as never;
    };
    const d = e.deps();
    expect(await main(['loopback', ...e.common()], d)).toBe(EXIT.OK);
    const r = result('loopback_resource_update');
    expect(e.surge.reloadCount - reloadsBefore).toBe(2);
    expect(r.checks.find((c) => c.name === '其他外部资源不变')?.ok).toBe(true);
    expect(r.summary.join('\n')).toContain('重新加载的影响');
    expect(r.verdict).toBe('pass');
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
    const firstSquat = new Set<string>();
    const onPause = async (m: string): Promise<void> => {
      const mode = /--squat (squat200|squat404|squatHang)/.exec(m)?.[1];
      if (mode) {
        await stopSquat();
        await e.stopResourceServer();
        squat = await e.startResourceServer(['--squat', mode]);
        // Surge 的定时刷新随时可能发生：每种占用者第一次启动后立即来一次（在工具开始等待之前）。工具的起点必须在占用之前读，
        // 否则这一次下载会被当作起点的一部分而核对不出来
        if (!firstSquat.has(mode)) {
          firstSquat.add(mode);
          e.surge.remoteRefreshIntervalMs = 1;
          await new Promise((r) => setTimeout(r, 5));
          await e.surge.listExternalResources();
          e.surge.remoteRefreshIntervalMs = null;
        }
      } else if (m.includes('重新启动 resource-server')) {
        await stopSquat();
        e.surge.remoteRefreshIntervalMs = null;
        await e.startResourceServer();
      }
    };
    const answers = ['yes', 'uid 502：127.0.0.1 绑定失败', 'y', 'n', 'yes', '1', '1', '1', '~/Library/Caches/example（0600）', 'y'];
    const d = { ...e.deps({ answers, onPause }), exec: lsofListen(e) };
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
    type Obs = { verdict: string; tokenReceived: boolean; error: string };
    const evidence = e.run().readJson<{ probes: Array<{ id: string; status: number }>; listen: string[]; phases: Array<{ mode: string; explicit: Obs; scheduled: { observed: boolean; result: Obs }; between: { recovered: boolean } }> }>(ev)!;
    expect(evidence.probes.filter((p) => p.id !== 'valid').every((p) => p.status === 404)).toBe(true);
    expect(evidence.listen).toEqual([`127.0.0.1:${e.resourcePort}`]);
    expect(evidence.phases.map((p) => [p.mode, p.explicit.verdict])).toEqual([
      ['squat200', 'unexplained_fetch'],
      ['squat404', 'unexplained_error'],
      ['squatHang', 'unexplained_error'],
    ]);
    // 定时刷新先于显式更新、从占用之前的状态核对：每一种都必须被核对发现（只“观察到下载”不算）
    expect(evidence.phases.map((p) => [p.mode, p.scheduled.observed, p.scheduled.result.verdict])).toEqual([
      ['squat200', true, 'unexplained_fetch'],
      ['squat404', true, 'unexplained_error'],
      ['squatHang', true, 'unexplained_error'],
    ]);
    expect(evidence.phases.every((p) => p.between.recovered)).toBe(true);
    // 不答复的占用者让 Surge 等到请求超时（服务没有在监听：按无法解释处理）
    expect(evidence.phases.find((p) => p.mode === 'squatHang')!.explicit.error).toBe('超时（-1001）');
    // 占用者拿到了读取令牌（令牌不认证服务端）：这正是要记录的后果
    expect(evidence.phases.every((p) => p.explicit.tokenReceived && p.scheduled.result.tokenReceived)).toBe(true);
    const token = (e.run().readText('resource-token') ?? '').trim();
    expect(d.out.text()).not.toContain(token);
    expect(filesContaining(e, token)).toEqual([]);
    expect(e.surge.updateAllAttempts).toBe(0);
    expect(readServed(e.run())!.probePeers).toBe(false);
  }, 60_000);

  it('regression: a Surge download answered by the previous squatter (before the operator swaps squatters) is not counted as the next mode\'s observation', async () => {
    const e = env!;
    await setupLoopback(e);
    let squat: ResourceProc | null = null;
    let currentMode: string | null = null;
    const stopSquat = async (): Promise<void> => {
      if (!squat) return;
      squat.stop();
      await squat.done;
      squat = null;
    };
    const refreshNow = async (): Promise<void> => {
      e.surge.remoteRefreshIntervalMs = 1;
      await new Promise((r) => setTimeout(r, 5));
      await e.surge.listExternalResources();
      e.surge.remoteRefreshIntervalMs = null;
    };
    const started = new Set<string>();
    const onPause = async (m: string): Promise<void> => {
      const mode = /--squat (squat200|squat404|squatHang)/.exec(m)?.[1];
      if (mode) {
        currentMode = mode;
        // 换到 squatHang 之前：Surge 的刷新落在还没停止的 squat404 占用者上
        if (mode === 'squatHang' && squat && !started.has(mode)) await refreshNow();
        await stopSquat();
        await e.stopResourceServer();
        squat = await e.startResourceServer(['--squat', mode]);
        if (!started.has(mode)) {
          started.add(mode);
          if (mode !== 'squatHang') await refreshNow();
        }
      } else if (m.includes('重新启动 resource-server')) {
        await stopSquat();
        e.surge.remoteRefreshIntervalMs = null;
        await e.startResourceServer();
      }
    };
    const answers = ['yes', 'uid 502：127.0.0.1 绑定失败', 'y', 'n', 'yes', '1', '1', '1', '~/Library/Caches/example（0600）', 'y'];
    const d = { ...e.deps({ answers, onPause }), exec: lsofListen(e) };
    const ask = d.prompt.ask.bind(d.prompt);
    d.prompt.ask = async (q: string) => {
      // squatHang 的等待期间 Surge 没有再刷新：这一种占用者在显式更新之前没有收到任何请求
      if (q.includes('定时刷新') && currentMode !== 'squatHang') e.surge.remoteRefreshIntervalMs = 1;
      return ask(q);
    };
    const pause = d.prompt.pause.bind(d.prompt);
    d.prompt.pause = async (m: string) => {
      e.surge.remoteRefreshIntervalMs = null;
      return pause(m);
    };
    expect(await main(['loopback-auth', ...e.common()], d)).toBe(EXIT.OK);
    const squatLog = readResourceLog(e.run()).filter((x) => x.kind === 'request' && x.role === 'squat') as Array<{ scenario: string }>;
    // 前提：squatHang 开始之前确实有一次下载落在了 squat404 占用者上
    expect(squatLog.filter((x) => x.scenario === 'squat404').length).toBeGreaterThanOrEqual(3);
    const r = result('loopback_resource_auth');
    const scheduled = r.checks.find((c) => c.name.startsWith('服务停止时端口被占用（定时刷新）'))!;
    const explicit = r.checks.find((c) => c.name.startsWith('服务停止时端口被占用（显式更新）'))!;
    // squatHang 的定时刷新没有观察到（只算这一种占用者的请求），显式更新被上一种占用者的下载污染：都记为未测，从不判为不通过
    expect(scheduled.ok).toBeNull();
    expect(explicit.ok).toBeNull();
    const ev = e.run().listFiles('loopback-auth')[0]!;
    const evidence = e.run().readJson<{ phases: Array<{ mode: string; scheduled: { observed: boolean } | null; explicit: { earlierRequests: number } | null }> }>(ev)!;
    const hang = evidence.phases.find((p) => p.mode === 'squatHang')!;
    expect(hang.scheduled?.observed).toBe(false);
    expect(hang.explicit!.earlierRequests).toBeGreaterThan(0);
    expect(r.verdict).not.toBe('fail');
  }, 60_000);

  it('regression: an "other user" whose copied uid is ours is not a pass, and a listen address other than 127.0.0.1 fails the measured listen check', async () => {
    const e = env!;
    await setupLoopback(e);
    const own = process.getuid?.() ?? 0;
    const d = { ...e.deps({ answers: ['yes', `uid ${own}：127.0.0.1 绑定失败`, 'y', 'n'] }), exec: lsofListen(e, [`127.0.0.1:${e.resourcePort}`, `*:${e.resourcePort}`]) };
    expect(await main(['loopback-auth', ...e.common()], d)).toBe(EXIT.OK);
    const r = result('loopback_resource_auth');
    const other = r.checks.find((c) => c.name.startsWith('服务运行时另一系统用户'))!;
    expect(other.ok).toBe(false);
    expect(other.note).toContain('与本工具相同');
    expect(other.note).toContain('操作员照抄');
    const listen = r.checks.find((c) => c.name.startsWith('资源服务只监听 127.0.0.1'))!;
    expect(listen.ok).toBe(false);
    expect(listen.note).toContain(`*:${e.resourcePort}`);
    expect(r.checks.find((c) => c.name.startsWith('Surge 资源缓存'))!.name).toContain('（操作员记录）');
    expect(r.verdict).toBe('fail');
  });

  it('regression: a same-user squatter that wrote to the run directory during the other-user step is not a pass', async () => {
    const e = env!;
    await setupLoopback(e);
    let squat: ResourceProc | null = null;
    const d = { ...e.deps({ answers: ['uid 502：127.0.0.1 绑定失败', 'y', 'n'] }), exec: lsofListen(e) };
    const ask = d.prompt.ask.bind(d.prompt);
    d.prompt.ask = async (q: string) => {
      if (!q.includes('另一系统用户的占用程序已在运行吗')) return ask(q);
      // 操作员误用同一用户运行占用者：它绑定 127.0.0.1 失败，但能写本运行目录
      squat = await e.startResourceServer(['--squat', 'squat404']);
      return 'yes';
    };
    expect(await main(['loopback-auth', ...e.common()], d)).toBe(EXIT.OK);
    if (squat) {
      (squat as ResourceProc).stop();
      await (squat as ResourceProc).done;
    }
    const other = result('loopback_resource_auth').checks.find((c) => c.name.startsWith('服务运行时另一系统用户'))!;
    expect(other.ok).toBe(false);
    expect(other.note).toContain('同一用户');
  });

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

  it('regression: an observation spanning a Surge update is recorded but not counted, and older observations stop counting under the new version', async () => {
    const e = env!;
    await setupLoopback(e);
    const exec = async (file: string, args: readonly string[]) => {
      if (file === '/bin/ps' && args[0] === '-axo') return { stdout: '  404 /Applications/Surge.app/Contents/MacOS/Surge\n', stderr: '', code: 0 };
      if (file === '/bin/ps' && args[0] === '-o') return { stdout: `${e.surge.startedAt.toISOString()}\n`, stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: -1 };
    };
    const round = async (variant: string, restart: () => void): Promise<void> => {
      const p = e.deps({ answers: [variant] });
      expect(await main(['loopback-restart', '--phase', 'prepare', ...e.common()], { ...p, exec }), p.out.text()).toBe(EXIT.OK);
      restart();
      const a = e.deps({ onPause: async (m) => void (m.includes('运行 resource-server') && (await e.startResourceServer())) });
      expect(await main(['loopback-restart', '--phase', 'after-surge-restart', ...e.common()], { ...a, exec }), a.out.text()).toBe(EXIT.OK);
    };
    await round('server-before', () => e.surge.restart());
    expect(result('loopback_resource_restart').checks[0]!.ok).toBe(true);
    // 退出重开时装上了 Surge 更新（Sparkle）：这一轮跨了两个版本，照样记录但不计入
    await round('down', () => e.surge.changeVersion({ version: '6.10.1', build: '12600' }));
    const r = result('loopback_resource_restart');
    expect(r.context.surgeBuild).toBe('12600');
    const obs = e.run().readJson<RestartObservation[]>('loopback-restart/observations.json')!;
    expect(obs.at(-1)!.contextChanged).toEqual(['surgeVersion', 'surgeBuild']);
    const down = r.checks.find((c) => c.name.startsWith('Surge 退出重开 · 服务不可用'))!;
    expect(down.ok).toBeNull();
    expect(down.note).toContain('重启前后上下文不同');
    // 在旧版本上测得的 server-before 也不再计入（结论按现在的版本）
    const before = r.checks.find((c) => c.name.startsWith('Surge 退出重开 · 服务先于'))!;
    expect(before.ok).toBeNull();
    expect(before.note).toContain('上下文与当前不同');
    expect(r.summary.join('\n')).toContain('不计入');
  }, 60_000);

  it('regression: an operator-confirmed restart is marked as such, and a Mac "down" round with the server running is not counted', async () => {
    const e = env!;
    await setupLoopback(e);
    // 读不到任何启动时间：操作员确认
    const prep = e.deps({ answers: ['down'] });
    expect(await main(['loopback-restart', '--phase', 'prepare', ...e.common()], prep)).toBe(EXIT.OK);
    await e.stopResourceServer();
    e.surge.restart();
    // 操作员没有照提示做：重启后先启动了 resource-server（变体要求不运行）
    await e.startResourceServer();
    const a = e.deps({ answers: ['yes'] });
    expect(await main(['loopback-restart', '--phase', 'after-mac-restart', ...e.common()], a), a.out.text()).toBe(EXIT.ERROR);
    expect(a.out.text()).toContain('变体与实际不符');
    const obs = e.run().readJson<RestartObservation[]>('loopback-restart/observations.json')!.at(-1)!;
    expect(obs.restartEvidence).toBe('operator');
    expect(obs.variantCheck?.ok).toBe(false);
    expect(obs.note).toContain('重启由操作员确认');
    expect(e.run().readJsonl<{ action: string }>('actions.jsonl').some((x) => x.action === 'operator_confirmed_restart')).toBe(true);
    const r = result('loopback_resource_restart');
    const down = r.checks.find((c) => c.name.startsWith('Mac 重启 · 服务不可用'))!;
    expect(down.ok).toBeNull();
    expect(down.note).toContain('变体与实际不符');
  });

  it('regression: Surge hiding a failed download behind not_ready on an empty cache fails the not_ready-exemption premise (a visible error passes)', async () => {
    const e = env!;
    await setupLoopback(e);
    e.surge.remoteCacheOnRestart = 'drop';
    const exec = async (file: string, args: readonly string[]) => {
      if (file === '/bin/ps' && args[0] === '-axo') return { stdout: '  404 /Applications/Surge.app/Contents/MacOS/Surge\n', stderr: '', code: 0 };
      if (file === '/bin/ps' && args[0] === '-o') return { stdout: `${e.surge.startedAt.toISOString()}\n`, stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: -1 };
    };
    const round = async (): Promise<RestartObservation> => {
      const p = e.deps({ answers: ['503'] });
      expect(await main(['loopback-restart', '--phase', 'prepare', ...e.common()], { ...p, exec }), p.out.text()).toBe(EXIT.OK);
      // 缓存被丢弃：Surge 启动时下载，服务只返回 503
      e.surge.restart();
      const a = e.deps();
      expect(await main(['loopback-restart', '--phase', 'after-surge-restart', ...e.common()], { ...a, exec }), a.out.text()).toBe(EXIT.OK);
      return e.run().readJson<RestartObservation[]>('loopback-restart/observations.json')!.at(-1)!;
    };
    const premise = () => result('loopback_resource_restart').checks.find((c) => c.name.startsWith('重开后缓存不存在时'))!;
    // 对照：失败的文字可见
    expect((await round()).emptyCache).toBe('visible');
    expect(premise().ok).toBe(true);
    // Surge 把这次 503 藏在未就绪之后
    e.surge.notReadyHidesDownloadErrors = true;
    const hidden = await round();
    expect(hidden.emptyCache).toBe('hidden');
    expect(hidden.downloads.statuses).toContain(503);
    expect(premise().ok).toBe(false);
    expect(result('loopback_resource_restart').verdict).toBe('fail');
  }, 60_000);

  it('regression: a Mac "503" round counts only requests after the boot; 503 answers from before the reboot with no server afterwards are not a "503" round', async () => {
    const e = env!;
    await setupLoopback(e);
    let boot = Math.floor(Date.now() / 1000) - 3600;
    const exec = async (file: string, args: readonly string[]) => {
      if (file === '/usr/sbin/sysctl') return { stdout: `{ sec = ${boot}, usec = 0 } Sat Oct 31 00:00:00 2026\n`, stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: -1 };
    };
    const p = e.deps({ answers: ['503'] });
    expect(await main(['loopback-restart', '--phase', 'prepare', ...e.common()], { ...p, exec }), p.out.text()).toBe(EXIT.OK);
    // 重启之前 Surge 自己刷新了一次：服务（restartUninitialized）答复 503
    const tRefresh = Date.now();
    e.surge.runScheduledRefresh();
    for (let i = 0; i < 200 && !requestsBetween(e.run(), tRefresh, Date.now() + 1000, 'server').some((r) => r.status === 503); i++) {
      await e.surge.listExternalResources();
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(requestsBetween(e.run(), tRefresh, Date.now() + 1000, 'server').map((r) => r.status)).toContain(503);
    // 重启；操作员忘了运行 resource-server --scenario restartUninitialized
    await e.stopResourceServer();
    await new Promise((r) => setTimeout(r, 1100));
    boot = Math.floor(Date.now() / 1000);
    e.surge.restart();
    const a = e.deps({ onPause: async (m) => void (m.includes('运行 resource-server') && (await e.startResourceServer())) });
    expect(await main(['loopback-restart', '--phase', 'after-mac-restart', ...e.common()], { ...a, exec }), a.out.text()).toBe(EXIT.ERROR);
    const obs = e.run().readJson<RestartObservation[]>('loopback-restart/observations.json')!.at(-1)!;
    expect(obs.variantCheck?.ok).toBe(false);
    expect(obs.downloads.statuses).toEqual([]);
    const r = result('loopback_resource_restart');
    expect(r.checks.find((c) => c.name.startsWith('Mac 重启 · 服务只返回 503'))!.ok).toBeNull();
  }, 60_000);

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
