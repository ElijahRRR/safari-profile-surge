// 引擎的 Surge 版本只来自运行中的 Surge 实例（HostInfo.surgeInstance；夹具中是 FakeSurge.runningInstance）：
// 能力上下文等于实例的版本；实例在托管状态下变得无法证明（例如启动后包被更新）时，依赖版本的能力过期，
// 对账附加 entry_unverified 且不写 Surge；进入普通模式仍然可用。只用合成数据。

import { afterEach, describe, expect, test } from 'vitest';
import { CAPABILITY_CONTEXT_DEPS, CAPABILITY_KEYS } from '@sfe/contract';
import { DEFAULT_INSTANCE_READ_BUDGET_MS, versionUnknownMessage } from '../../src/engine/context.js';
import type { RunningInstanceResult } from '../../src/surge/running-instance.js';
import { PROFILE_A, WEB, activeEnv, anyContext, createHarness, rid, safariOutcome, type Harness } from './harness.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const VERSION_KEYS = CAPABILITY_KEYS.filter((k) => CAPABILITY_CONTEXT_DEPS[k].includes('surgeVersion') || CAPABILITY_CONTEXT_DEPS[k].includes('surgeBuild'));
const WRITES = ['updateExternalResource', 'selectGroupPolicy', 'killRequest', 'addTempRule', 'removeTempRule', 'reloadProfile'] as const;

function writes(hh: Harness): Record<string, number> {
  return Object.fromEntries(WRITES.map((k) => [k, hh.fake.calls[k] ?? 0]));
}

describe('version from the running Surge instance', () => {
  test('the capability context equals the running instance version; getVersion is never called', async () => {
    h = await createHarness();
    h.fake.version = '6.6.1';
    h.fake.build = '11234';
    const reads = h.fake.instanceReads;
    const st = await h.app.refreshSurge(WEB);
    expect(st).toMatchObject({ reachable: true, version: '6.6.1', build: '11234', message: null });
    expect(h.app.engine.capabilityContext()).toMatchObject({ surgeVersion: '6.6.1', surgeBuild: '11234' });
    expect(h.fake.instanceReads).toBeGreaterThan(reads);
    expect(h.fake.calls.getVersion ?? 0).toBe(0);
  });

  test('a capability recorded for one version goes stale after the running instance reports another', async () => {
    h = await createHarness();
    h.repos.capabilities.upsert({
      key: 'runtime_entry_modes',
      status: 'supported',
      context: { ...anyContext(), surgeVersion: '6.5.0', surgeBuild: '10960' },
      verifiedAt: h.clock.now().toISOString(),
      note: '测试记录',
    });
    await h.app.refreshSurge(WEB);
    expect((await h.app.listCapabilities()).find((c) => c.key === 'runtime_entry_modes')!.effectiveStatus).toBe('supported');
    h.fake.version = '6.6.0';
    h.fake.build = '11000';
    await h.app.refreshSurge(WEB);
    expect((await h.app.listCapabilities()).find((c) => c.key === 'runtime_entry_modes')).toMatchObject({ effectiveStatus: 'unverified', staleReasons: ['surgeVersion', 'surgeBuild'] });
  });

  test('without a host instance reader the engine defaults to not_darwin (or unavailable on macOS): version null', async () => {
    h = await createHarness({ surgeInstance: false });
    const reason = process.platform === 'darwin' ? 'unavailable' : 'not_darwin';
    const st = await h.app.refreshSurge(WEB);
    expect(st).toMatchObject({ reachable: true, version: null, build: null, message: versionUnknownMessage(reason) });
    expect(h.app.engine.facts.versionIssue).toBe(reason);
    expect(h.fake.instanceReads).toBe(0);
    for (const v of await h.app.listCapabilities()) expect(v.effectiveStatus, v.key).toBe(VERSION_KEYS.includes(v.key) ? 'unverified' : 'supported');
  });

  test('Surge not running: the liveness read fails first and the instance is not read', async () => {
    h = await createHarness();
    h.fake.reachable = false;
    const reads = h.fake.instanceReads;
    const st = await h.app.refreshSurge(WEB);
    expect(st).toMatchObject({ reachable: false, version: null, build: null, message: '无法连接 Surge' });
    expect(h.fake.instanceReads).toBe(reads);
  });
});

describe('the running instance becomes unprovable while an environment is active', () => {
  test('modified_after_start (Surge updated on disk, not relaunched) → entry_unverified, version-dependent capabilities stale, no Surge writes; normal mode still works', async () => {
    h = await createHarness();
    const { envId } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    expect(h.repos.routeState.get()).toMatchObject({ entryMode: 'ACTIVE', phase: 'active_verified' });
    expect(h.repos.routeState.get().warnings).not.toContain('entry_unverified');
    const before = writes(h);
    h.fake.instanceFailure = 'modified_after_start';
    await h.app.runPeriodicReconcile();
    const route = h.repos.routeState.get();
    expect(route.warnings).toContain('entry_unverified');
    expect(route.warnings).not.toContain('surge_unreachable');
    expect(h.app.engine.facts).toMatchObject({ reachable: true, version: null, build: null, versionIssue: 'modified_after_start' });
    expect(h.app.engine.facts.message).toBe(versionUnknownMessage('modified_after_start'));
    expect((await h.app.listCapabilities()).find((c) => c.key === 'runtime_entry_modes')).toMatchObject({ effectiveStatus: 'unverified', staleReasons: ['surgeVersion', 'surgeBuild'] });
    // 对账从不写 Surge、从不抢回控制
    expect(writes(h)).toEqual(before);
    // 订单与填充需要“受控”：entry_unverified 破坏受控
    const state = (await h.native(PROFILE_A, { type: 'getCurrentState' })) as { ok: boolean; data: { ordersAllowed: boolean } };
    expect(state.data.ordersAllowed).toBe(false);

    const n = await h.app.enterNormal({ request_id: rid('normal'), old_session_policy: 'closed_confirmed', confirmed_environment_id: envId }, WEB);
    await h.idle();
    expect(h.repos.operations.get(n.operation_id)!.phase).toBe('NORMAL_RESTORED');
    expect(h.repos.routeState.get()).toMatchObject({ entryMode: 'NORMAL', phase: 'idle', activeEnvironmentId: null });
    expect(safariOutcome(h).rule).toBe('FINAL,DIRECT');
    expect(h.fake.calls.reloadProfile ?? 0).toBe(0);
  });

  test('re-activation is refused with CAPABILITY_UNVERIFIED while the instance cannot be proven', async () => {
    h = await createHarness();
    const { envId } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    await h.app.enterNormal({ request_id: rid('normal'), old_session_policy: 'closed_confirmed', confirmed_environment_id: envId }, WEB);
    await h.idle();
    h.fake.instanceFailure = 'running_image_mismatch';
    await h.app.refreshSurge(WEB);
    const before = writes(h);
    const err = await h.app.activate(envId, { request_id: rid('act') }, WEB).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'CAPABILITY_UNVERIFIED' });
    await h.idle();
    expect(writes(h)).toEqual(before);
    expect(h.repos.routeState.get()).toMatchObject({ entryMode: 'NORMAL', activeEnvironmentId: null });
  });
});

describe('a running-instance read that never finishes', () => {
  test('is cut off at the engine budget (read_failed, version null) and a queued normal-mode request still finishes within a bounded time', async () => {
    h = await createHarness();
    const { envId } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    expect(h.repos.routeState.get()).toMatchObject({ entryMode: 'ACTIVE', phase: 'active_verified' });
    // 例如 codesign 卡在 trustd/syspolicyd：读取一直不返回
    let started = 0;
    h.fake.runningInstance = () => {
      started++;
      return new Promise<RunningInstanceResult>(() => undefined);
    };
    const t0 = h.clock.now().getTime();
    // 周期对账在执行器通道上读取事实，进入普通模式的操作排在它后面
    const reconcile = h.app.runPeriodicReconcile();
    await new Promise((r) => setImmediate(r));
    expect(started).toBe(1);
    const n = await h.app.enterNormal({ request_id: rid('normal'), old_session_policy: 'closed_confirmed', confirmed_environment_id: envId }, WEB);
    const phase = () => h!.repos.operations.get(n.operation_id)!.phase;
    // 假时钟按 0.5 秒推进；每一步给真实的文件读写留出时间（只有假时钟决定是否超过时限）
    for (let i = 0; i < 60 && phase() !== 'NORMAL_RESTORED'; i++) {
      await h.clock.advanceAsync(500);
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(phase()).toBe('NORMAL_RESTORED');
    await reconcile;
    // 每次读取最多等一个总时限（对账一次，普通模式本身也可能读一次）
    expect(h.clock.now().getTime() - t0).toBeLessThanOrEqual(3 * DEFAULT_INSTANCE_READ_BUDGET_MS);
    expect(h.repos.routeState.get()).toMatchObject({ entryMode: 'NORMAL', phase: 'idle', activeEnvironmentId: null });
    expect(safariOutcome(h).rule).toBe('FINAL,DIRECT');
    expect(h.app.engine.facts).toMatchObject({ reachable: true, version: null, build: null, versionIssue: 'read_failed' });
    expect(h.app.engine.facts.message).toBe(versionUnknownMessage('read_failed'));
  });

  test('a read that finishes inside the budget is used as is', async () => {
    h = await createHarness({ capabilities: [] });
    const original = h.fake.runningInstance.bind(h.fake);
    h.fake.runningInstance = () =>
      new Promise<RunningInstanceResult>((resolve) => {
        h!.clock.setTimeout(() => void original().then(resolve), DEFAULT_INSTANCE_READ_BUDGET_MS - 1_000);
      });
    const timers = h.clock.pendingTimers();
    const st = h.app.refreshSurge(WEB);
    await h.clock.advanceAsync(DEFAULT_INSTANCE_READ_BUDGET_MS - 1_000);
    await expect(st).resolves.toMatchObject({ reachable: true, version: '6.5.0', build: '10960', message: null });
    // 时限定时器已取消
    expect(h.clock.pendingTimers()).toBe(timers);
  });
});
