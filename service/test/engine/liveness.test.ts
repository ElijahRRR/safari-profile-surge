// Surge 可达性不再经 getVersion（Surge 6.5 的 surge-cli 没有版本命令，--version 进入交互模式）：引擎按 mechanism()
// 静态选定一个只读检测原语，只有它解析成功才算可达，其余一律不可达（失败即关闭）。版本与可达性无关：只来自运行中的
// Surge 实例（HostInfo.surgeInstance，夹具中是 FakeSurge.runningInstance），无法证明时为 null。
// 见 docs/ARCHITECTURE.md §5.2、§6.6。只用合成数据。

import { symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { CAPABILITY_CONTEXT_DEPS, CAPABILITY_KEYS, SfeError, WORKING_PROFILE_NAME } from '@sfe/contract';
import {
  LIVENESS_FAILURE_TEXT,
  LIVENESS_PRIMITIVES,
  chooseLivenessPrimitive,
  versionUnknownMessage,
} from '../../src/engine/context.js';
import { createCliAdapter, type ExecFn } from '../../src/surge/cli-adapter.js';
import { createCompositeAdapter } from '../../src/surge/composite.js';
import type { RunningInstanceFailure } from '../../src/surge/running-instance.js';
import { SURGE_PRIMITIVES, capabilityUnverified, type MechanismMap } from '../../src/surge/primitives.js';
import { PROFILE_A, WEB, activeEnv, bind, createEnv, createHarness, rid, safariOutcome, type Harness } from './harness.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const CLI = '/Applications/Surge.app/Contents/Applications/surge-cli';
// Surge Mac 6.5.0 (10960) 实测：没有可识别的命令时打印的提示（stdin 结束时退出 0）。
const BANNER = 'No command is provided, enter interactive mode.\nTips: Use surge-cli --help to show available commands.\nConnected to 127.0.0.1\n> ';
const VERSION_KEYS = CAPABILITY_KEYS.filter((k) => CAPABILITY_CONTEXT_DEPS[k].includes('surgeVersion') || CAPABILITY_CONTEXT_DEPS[k].includes('surgeBuild'));
/** 检测失败后不应再读取的基础事实原语。 */
const FACT_READS = ['getVersion', 'getRuntimeInfo', 'getCurrentProfile', 'getTakeoverState', 'getAutoReloadSetting'] as const;
const WRITES = ['updateExternalResource', 'selectGroupPolicy', 'killRequest', 'addTempRule', 'removeTempRule', 'reloadProfile'] as const;

function counts(hh: Harness, keys: readonly string[]): Record<string, number> {
  return Object.fromEntries(keys.map((k) => [k, hh.fake.calls[k] ?? 0]));
}

function allCalls(hh: Harness): Record<string, number> {
  return counts(hh, [...SURGE_PRIMITIVES, 'reloadProfile']);
}

/** 运行实例读取失败（缺省 unavailable：没有可用的运行实例读取）。 */
function instanceUnreadable(hh: Harness, reason: RunningInstanceFailure = 'unavailable'): void {
  hh.fake.instanceFailure = reason;
}

/** getVersion 原语即使“能用”也从不被调用（6.5 的 CLI 原语表与 HTTP 实现都没有它）。 */
function versionPrimitiveWorks(hh: Harness): void {
  hh.fake.getVersion = async () => ({ version: '9.9.9', build: '99999' });
}

function logEntries(hh: Harness): Array<Record<string, unknown>> {
  return hh.logs.map((l) => JSON.parse(l) as Record<string, unknown>);
}

function logsNamed(hh: Harness, msg: string): Array<Record<string, unknown>> {
  return logEntries(hh).filter((e) => e.msg === msg);
}

describe('choosing the liveness primitive', () => {
  test('takes the first read primitive mapped to cli, http or fake, in a fixed order, and never getVersion', () => {
    expect(LIVENESS_PRIMITIVES).toEqual(['listExternalResources', 'listTempRules', 'getCurrentProfile', 'listPolicies']);
    expect(LIVENESS_PRIMITIVES).not.toContain('getVersion');
    const all = (m: string) => Object.fromEntries(SURGE_PRIMITIVES.map((p) => [p, m]));
    expect(chooseLivenessPrimitive(all('fake'))).toBe('listExternalResources');
    expect(chooseLivenessPrimitive(all('cli'))).toBe('listExternalResources');
    // Surge 6.5 只有命令行工具：external-resource list 与 dump temp-rule 在帮助中出现过
    expect(chooseLivenessPrimitive({ ...all('unavailable'), listExternalResources: 'cli', listTempRules: 'cli' })).toBe('listExternalResources');
    expect(chooseLivenessPrimitive({ ...all('unavailable'), listTempRules: 'cli' })).toBe('listTempRules');
    // 只配置 HTTP API
    expect(chooseLivenessPrimitive({ ...all('unavailable'), getCurrentProfile: 'http', listPolicies: 'http' })).toBe('getCurrentProfile');
    expect(chooseLivenessPrimitive({ ...all('unavailable'), listPolicies: 'http' })).toBe('listPolicies');
    // 只映射了 getVersion（旧安装配置）或什么都没映射：没有检测原语
    expect(chooseLivenessPrimitive({ ...all('unavailable'), getVersion: 'cli' })).toBeNull();
    expect(chooseLivenessPrimitive(all('unavailable'))).toBeNull();
    expect(chooseLivenessPrimitive({})).toBeNull();
    // 无法识别的实现名不算映射
    expect(chooseLivenessPrimitive({ listExternalResources: 'shell', listTempRules: 'CLI' })).toBeNull();
  });

  test('the engine picks it from mechanism() once and does not switch to another primitive when it fails', async () => {
    h = await createHarness({ livenessPrimitive: 'auto' });
    expect(h.app.engine.livenessPrimitive).toBe('listExternalResources');
    const before = counts(h, ['listTempRules', 'getCurrentProfile', 'listPolicies']);
    h.fake.listExternalResources = async () => {
      throw new SfeError('SURGE_COMMAND_FAILED', '执行 Surge 命令失败：模拟失败');
    };
    const st = await h.app.refreshSurge(WEB);
    expect(st.reachable).toBe(false);
    expect(h.app.engine.livenessPrimitive).toBe('listExternalResources');
    expect(counts(h, ['listTempRules', 'getCurrentProfile', 'listPolicies'])).toEqual(before);
  });

  test('HTTP API only: the engine checks liveness with getCurrentProfile', async () => {
    const mechanism: MechanismMap = Object.fromEntries(SURGE_PRIMITIVES.map((p) => [p, 'http' as const]));
    mechanism.listExternalResources = 'unavailable';
    mechanism.listTempRules = 'unavailable';
    h = await createHarness({ livenessPrimitive: 'auto', surge: (fake) => createCompositeAdapter({ mechanism, http: fake }) });
    expect(h.app.engine.livenessPrimitive).toBe('getCurrentProfile');
    const st = await h.app.refreshSurge(WEB);
    expect(st.reachable).toBe(true);
  });
});

describe('reachability without getVersion', () => {
  test('running instance unreadable: reachable through the liveness read; version null with a clear message; other facts still read', async () => {
    h = await createHarness({ livenessPrimitive: 'auto' });
    instanceUnreadable(h);
    const live = h.fake.calls.listExternalResources ?? 0;
    const st = await h.app.refreshSurge(WEB);
    expect(st).toMatchObject({
      reachable: true,
      version: null,
      build: null,
      currentProfileName: WORKING_PROFILE_NAME,
      onWorkingProfile: true,
      takeover: { enhancedMode: true, systemProxy: true, outboundMode: 'rule' },
      message: versionUnknownMessage('unavailable'),
    });
    expect(st.message).toBe('无法确认运行中的 Surge 版本（没有可用的运行实例读取）：依赖 Surge 版本的能力按待验证处理');
    expect(h.app.engine.facts.versionIssue).toBe('unavailable');
    expect((h.fake.calls.listExternalResources ?? 0) - live).toBeGreaterThanOrEqual(1);
    expect(h.fake.calls.getVersion ?? 0).toBe(0);
    // 失败即关闭：依赖版本的能力全部待验证，其余保持
    expect(h.app.engine.capabilityContext()).toMatchObject({ surgeVersion: null, surgeBuild: null });
    for (const v of await h.app.listCapabilities()) expect(v.effectiveStatus, v.key).toBe(VERSION_KEYS.includes(v.key) ? 'unverified' : 'supported');
  });

  test.each([
    ['SURGE_UNREACHABLE', new SfeError('SURGE_UNREACHABLE', '连接 Surge 失败：模拟不可达')],
    ['SURGE_COMMAND_FAILED', new SfeError('SURGE_COMMAND_FAILED', '执行 Surge 命令失败：模拟失败')],
    ['CAPABILITY_UNVERIFIED', capabilityUnverified('getVersion')],
    ['a plain error', new Error('boom')],
  ] as const)('getVersion failing with %s is never called and decides neither reachability nor the version', async (_name, error) => {
    h = await createHarness();
    h.fake.getVersion = async () => {
      throw error;
    };
    const st = await h.app.refreshSurge(WEB);
    expect(st).toMatchObject({ reachable: true, version: '6.5.0', build: '10960', onWorkingProfile: true, message: null });
    expect(h.app.engine.facts.versionIssue).toBeNull();
    expect(h.fake.calls.getVersion ?? 0).toBe(0);
  });

  test('a working getVersion is not a version source: an unreadable running instance still gives version null', async () => {
    h = await createHarness();
    versionPrimitiveWorks(h);
    instanceUnreadable(h, 'modified_after_start');
    const st = await h.app.refreshSurge(WEB);
    expect(st).toMatchObject({ reachable: true, version: null, build: null, message: versionUnknownMessage('modified_after_start') });
    expect(st.message).toBe('无法确认运行中的 Surge 版本（Surge 启动后包被更新或修改，请重新打开 Surge）：依赖 Surge 版本的能力按待验证处理');
    expect(h.fake.calls.getVersion ?? 0).toBe(0);
  });

  test('a running-instance reader that throws gives read_failed, without echoing the error', async () => {
    h = await createHarness();
    h.fake.runningInstance = async () => {
      throw new Error('Connected to 127.0.0.1');
    };
    const st = await h.app.refreshSurge(WEB);
    expect(st).toMatchObject({ reachable: true, version: null, build: null, message: versionUnknownMessage('read_failed') });
    expect(h.app.engine.facts.versionIssue).toBe('read_failed');
    expect(JSON.stringify(st)).not.toContain('127.0.0.1');
    expect(h.logs.join('\n')).not.toContain('127.0.0.1');
  });

  test.each([
    ['an unknown failure reason', { ok: false, reason: 'something_else' }, 'read_failed'],
    ['a malformed version from an injected reader', { ok: true, instance: { pid: 1, startedAt: '2026-10-21T00:00:00.000Z', bundlePath: '/Applications/Surge.app', bundleId: 'com.nssurge.surge-mac', version: '127.0.0.1', build: '10960' } }, 'version_malformed'],
    ['a missing build from an injected reader', { ok: true, instance: { pid: 1, startedAt: '2026-10-21T00:00:00.000Z', bundlePath: '/Applications/Surge.app', bundleId: 'com.nssurge.surge-mac', version: '6.5.0' } }, 'version_malformed'],
    ['not an object', null, 'read_failed'],
    ['ok that is not literally true', { ok: 'yes', instance: { pid: 1, startedAt: '2026-10-21T00:00:00.000Z', bundlePath: '/Applications/Surge.app', bundleId: 'com.nssurge.surge-mac', version: '6.5.0', build: '10960' } }, 'read_failed'],
  ] as const)('the engine re-checks what the instance reader returns: %s → %s, version and build both null', async (_name, value, issue) => {
    h = await createHarness();
    h.fake.runningInstance = async () => value as never;
    const st = await h.app.refreshSurge(WEB);
    expect(st).toMatchObject({ reachable: true, version: null, build: null, message: versionUnknownMessage(issue) });
    expect(h.app.engine.facts.versionIssue).toBe(issue);
  });

  test('a readable running instance and a working getVersion do not make Surge reachable when the liveness read fails (no fail-open), and nothing else is read', async () => {
    h = await createHarness({ livenessPrimitive: 'auto' });
    versionPrimitiveWorks(h);
    h.fake.listExternalResources = async () => {
      throw new SfeError('SURGE_COMMAND_FAILED', '读取失败：Surge 输出格式无法识别');
    };
    const before = counts(h, FACT_READS);
    const reads = h.fake.instanceReads;
    const st = await h.app.refreshSurge(WEB);
    expect(st).toMatchObject({ reachable: false, version: null, build: null, currentProfileName: null, onWorkingProfile: null, message: LIVENESS_FAILURE_TEXT.unconfirmed });
    expect(st.message).toBe('无法确认 Surge 连接：只读检测失败或输出无法识别');
    expect(counts(h, FACT_READS)).toEqual(before);
    expect(h.fake.instanceReads).toBe(reads);
  });

  test.each([
    ['SURGE_UNREACHABLE', () => new SfeError('SURGE_UNREACHABLE', '连接 Surge 失败：模拟不可达'), '无法连接 Surge'],
    ['CAPABILITY_UNVERIFIED (CLI failed the signature check, HTTP not loopback)', () => capabilityUnverified('listExternalResources'), '无法连接 Surge：尚未配置可用的命令行工具或 HTTP API'],
    ['SURGE_COMMAND_FAILED', () => new SfeError('SURGE_COMMAND_FAILED', '执行 Surge 命令失败：退出码 1'), '无法确认 Surge 连接：只读检测失败或输出无法识别'],
    ['UNAUTHORIZED-like HTTP failure', () => new SfeError('SURGE_COMMAND_FAILED', '调用 Surge HTTP API 失败：401'), '无法确认 Surge 连接：只读检测失败或输出无法识别'],
    ['a plain error', () => new Error('boom'), '无法确认 Surge 连接：只读检测失败或输出无法识别'],
  ] as const)('liveness read failing with %s → not reachable with the matching message; no further reads', async (_name, make, message) => {
    h = await createHarness({ livenessPrimitive: 'auto' });
    h.fake.listExternalResources = async () => {
      throw make();
    };
    const before = counts(h, FACT_READS);
    const st = await h.app.refreshSurge(WEB);
    expect(st.reachable).toBe(false);
    expect(st.message).toBe(message);
    expect(counts(h, FACT_READS)).toEqual(before);
  });

  test('liveness read returning something that is not a parsed list → not reachable', async () => {
    h = await createHarness({ livenessPrimitive: 'auto' });
    h.fake.lieOnNext('listExternalResources', undefined);
    const st = await h.app.refreshSurge(WEB);
    expect(st).toMatchObject({ reachable: false, message: LIVENESS_FAILURE_TEXT.unconfirmed });
    // 下一次正常读取 → 可达
    expect((await h.app.refreshSurge(WEB)).reachable).toBe(true);
  });

  test('interactive-mode banner on the CLI liveness read → not reachable, Surge output never echoed', async () => {
    const mechanism: MechanismMap = Object.fromEntries(SURGE_PRIMITIVES.map((p) => [p, 'fake' as const]));
    mechanism.listExternalResources = 'cli';
    const argvs: string[][] = [];
    const exec: ExecFn = async (_file, args) => {
      argvs.push([...args]);
      return { stdout: BANNER, stderr: '' };
    };
    const cli = createCliAdapter({ cliPath: CLI, mechanism, exec, scrub: (s) => s });
    h = await createHarness({ livenessPrimitive: 'auto', surge: (fake) => createCompositeAdapter({ mechanism, cli, fake }) });
    expect(h.app.engine.livenessPrimitive).toBe('listExternalResources');
    const st = await h.app.refreshSurge(WEB);
    expect(st).toMatchObject({ reachable: false, version: null, message: LIVENESS_FAILURE_TEXT.unconfirmed });
    expect(argvs[0]).toEqual(['--raw', 'external-resource', 'list']);
    expect(argvs.flat()).not.toContain('--version');
    expect(JSON.stringify(st)).not.toContain('127.0.0.1');
    expect(h.logs.join('\n')).not.toContain('127.0.0.1');
    expect(h.logs.join('\n')).not.toMatch(/interactive mode/i);
  });

  test('no liveness primitive → not reachable without any Surge call', async () => {
    h = await createHarness({ livenessPrimitive: null });
    const before = allCalls(h);
    const st = await h.app.refreshSurge(WEB);
    expect(st).toMatchObject({ reachable: false, version: null, message: '无法连接 Surge：尚未配置可用的命令行工具或 HTTP API' });
    expect(allCalls(h)).toEqual(before);
  });

  test('liveness primitive mapped to cli but the CLI adapter is missing (signature check failed) → not reachable, no fallback to HTTP', async () => {
    const mechanism: MechanismMap = Object.fromEntries(SURGE_PRIMITIVES.map((p) => [p, 'http' as const]));
    mechanism.listExternalResources = 'cli';
    // 旧安装配置把 getVersion 映射到 HTTP：它也不能让 Surge 算作可达
    mechanism.getVersion = 'http';
    h = await createHarness({ livenessPrimitive: 'auto', surge: (fake) => createCompositeAdapter({ mechanism, http: fake }) });
    expect(h.app.engine.livenessPrimitive).toBe('listExternalResources');
    const before = allCalls(h);
    const st = await h.app.refreshSurge(WEB);
    expect(st).toMatchObject({ reachable: false, message: '无法连接 Surge：尚未配置可用的命令行工具或 HTTP API' });
    expect(allCalls(h)).toEqual(before);
  });
});

describe('version facts', () => {
  test('a malformed bundle version (127.0.0.1) makes the running instance unreadable: version and build both unknown', async () => {
    h = await createHarness();
    h.fake.version = '127.0.0.1';
    const st = await h.app.refreshSurge(WEB);
    expect(st).toMatchObject({ reachable: true, version: null, build: null, message: versionUnknownMessage('version_malformed') });
    expect(h.app.engine.facts.versionIssue).toBe('version_malformed');
    expect(h.app.engine.capabilityContext()).toMatchObject({ surgeVersion: null, surgeBuild: null });
    expect((await h.app.listCapabilities()).find((c) => c.key === 'runtime_entry_modes')).toMatchObject({ effectiveStatus: 'unverified', staleReasons: ['surgeVersion', 'surgeBuild'] });
  });

  test('a missing build is reported; a readable instance gives no message and a capability context equal to the instance version', async () => {
    h = await createHarness();
    h.fake.build = null;
    let st = await h.app.refreshSurge(WEB);
    expect(st).toMatchObject({ reachable: true, version: null, build: null, message: versionUnknownMessage('plist_unreadable') });
    expect(h.app.engine.facts.versionIssue).toBe('plist_unreadable');
    h.fake.version = '6.5.1';
    h.fake.build = '10999';
    st = await h.app.refreshSurge(WEB);
    expect(st).toMatchObject({ reachable: true, version: '6.5.1', build: '10999', message: null });
    expect(h.app.engine.facts.versionIssue).toBeNull();
    expect(h.app.engine.capabilityContext()).toMatchObject({ surgeVersion: '6.5.1', surgeBuild: '10999' });
    expect(h.fake.calls.getVersion ?? 0).toBe(0);
  });

  test('message order: not on the working profile > version unknown > profile directory unknown', async () => {
    h = await createHarness();
    instanceUnreadable(h);
    const working = { ...h.fake.currentProfile };
    h.fake.currentProfile = { name: 'Other', path: join(h.surgeDir, 'Other.conf') };
    expect((await h.app.refreshSurge(WEB)).message).toBe('Surge 当前配置不是固定工作配置');
    expect(h.app.engine.facts.versionIssue).toBe('unavailable');
    h.fake.currentProfile = working;
    const home = join(h.dir, 'home');
    symlinkSync(home, home); // realpath → ELOOP：目录位置无法确认
    let st = await h.app.refreshSurge(WEB);
    expect(st.profileDirectoryRisk).toBeNull();
    expect(st.message).toBe(versionUnknownMessage('unavailable'));
    // 版本重新读到 → 显示目录提示
    h.fake.instanceFailure = null;
    st = await h.app.refreshSurge(WEB);
    expect(st.message).toContain('无法确认固定工作配置所在目录的真实位置');
  });
});

describe('logging', () => {
  test('liveness and version state changes are logged once each, without Surge output', async () => {
    h = await createHarness({ livenessPrimitive: 'auto' });
    const original = h.fake.listExternalResources.bind(h.fake);
    h.fake.listExternalResources = async () => {
      throw new SfeError('SURGE_COMMAND_FAILED', '执行 Surge 命令失败：Connected to 127.0.0.1');
    };
    await h.app.refreshSurge(WEB);
    await h.app.refreshSurge(WEB);
    expect(logsNamed(h, 'surge.liveness_failed')).toEqual([expect.objectContaining({ level: 'warn', primitive: 'listExternalResources', reason: 'unconfirmed' })]);
    h.fake.listExternalResources = original;
    await h.app.refreshSurge(WEB);
    await h.app.refreshSurge(WEB);
    expect(logsNamed(h, 'surge.liveness_restored')).toHaveLength(1);
    expect(h.logs.join('\n')).not.toContain('127.0.0.1');

    instanceUnreadable(h);
    await h.app.refreshSurge(WEB);
    await h.app.refreshSurge(WEB);
    expect(logsNamed(h, 'surge.version_unknown')).toEqual([expect.objectContaining({ level: 'warn', reason: 'unavailable' })]);
    h.fake.instanceFailure = null;
    await h.app.refreshSurge(WEB);
    await h.app.refreshSurge(WEB);
    expect(logsNamed(h, 'surge.version_known')).toHaveLength(1);
    expect(logsNamed(h, 'surge.liveness_failed')).toHaveLength(1);
  });
});

describe('consumers of the facts fail closed', () => {
  test('managed route: a failing liveness read raises surge_unreachable and attention, writes nothing, blocks orders; entering normal mode still restores the original rules', async () => {
    h = await createHarness({ livenessPrimitive: 'listPolicies' });
    const { envId } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    expect(h.repos.routeState.get()).toMatchObject({ entryMode: 'ACTIVE', phase: 'active_verified' });
    // 运行实例仍可读、getVersion 仍可用：旧实现会因后者把 Surge 当作可达
    versionPrimitiveWorks(h);
    h.fake.listPolicies = async () => {
      throw new SfeError('SURGE_COMMAND_FAILED', '执行 Surge 命令失败：命令行工具不支持该命令（进入了交互模式）');
    };
    const writes = counts(h, WRITES);
    await h.app.runPeriodicReconcile();
    const route = h.repos.routeState.get();
    expect(route.warnings).toContain('surge_unreachable');
    expect(route.phase).toBe('attention');
    expect(h.app.engine.facts).toMatchObject({ reachable: false, message: LIVENESS_FAILURE_TEXT.unconfirmed });
    expect(counts(h, WRITES)).toEqual(writes);
    const state = (await h.native(PROFILE_A, { type: 'getCurrentState' })) as { ok: boolean; data: { ordersAllowed: boolean; ordersBlockedReason: string | null } };
    expect(state.data.ordersAllowed).toBe(false);
    expect(state.data.ordersBlockedReason).toBe('无法连接 Surge');

    const n = await h.app.enterNormal({ request_id: rid('normal'), old_session_policy: 'closed_confirmed', confirmed_environment_id: envId }, WEB);
    await h.idle();
    expect(h.repos.operations.get(n.operation_id)!.phase).toBe('NORMAL_RESTORED');
    expect(h.repos.routeState.get()).toMatchObject({ entryMode: 'NORMAL', phase: 'idle', activeEnvironmentId: null });
    // 返回普通模式是撤销本应用的入口，Safari 继续原规则；从不重载配置
    expect(safariOutcome(h).rule).toBe('FINAL,DIRECT');
    expect(h.fake.calls.reloadProfile ?? 0).toBe(0);
    expect(h.app.engine.facts.reachable).toBe(false);
  });

  test('temp_rule: a failing liveness read does not stop entering normal mode from undoing the entry', async () => {
    h = await createHarness({ entryStrategy: 'temp_rule', livenessPrimitive: 'listPolicies' });
    // 夹具的临时规则插在末尾：激活停在 BLOCKED（受管理、非 NORMAL 的入口状态）
    const envId = (await createEnv(h, 'US-Buyer-A', '203.0.113.10')).environment_id!;
    await bind(h, PROFILE_A, envId);
    await h.app.activate(envId, { request_id: rid('act') }, WEB);
    await h.idle();
    expect(h.repos.routeState.get().entryMode).toBe('BLOCKED');
    expect(h.fake.tempRules.length).toBeGreaterThan(0);
    h.fake.listPolicies = async () => {
      throw new SfeError('SURGE_UNREACHABLE', '连接 Surge 失败：模拟不可达');
    };
    await h.app.runPeriodicReconcile();
    expect(h.repos.routeState.get().warnings).toContain('surge_unreachable');
    const active = h.repos.routeState.get().activeEnvironmentId;
    const n = await h.app.enterNormal(active ? { request_id: rid('normal'), old_session_policy: 'closed_confirmed', confirmed_environment_id: active } : { request_id: rid('normal') }, WEB);
    await h.idle();
    expect(h.repos.operations.get(n.operation_id)!.phase).toBe('NORMAL_RESTORED');
    expect(h.repos.routeState.get()).toMatchObject({ entryMode: 'NORMAL', phase: 'idle', activeEnvironmentId: null });
    expect(h.fake.tempRules).toEqual([]);
    expect(safariOutcome(h).rule).toBe('FINAL,DIRECT');
    expect(h.fake.calls.reloadProfile ?? 0).toBe(0);
  });
});
