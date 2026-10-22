// 读不到运行中 Surge 的版本与构建号时（运行实例读取失败，例如包信息缺构建号、启动后包被修改），依赖版本的能力
// 一律待验证：记录为 null 或 any 都不能匹配读不到的当前值（docs/ARCHITECTURE.md §5.2）。进入普通模式始终可用。
// 只用合成数据。

import { afterEach, describe, expect, test } from 'vitest';
import { CAPABILITY_CONTEXT_DEPS, CAPABILITY_KEYS, type ActivateRequest } from '@sfe/contract';
import { PROFILE_A, WEB, activeEnv, bind, createEnv, createHarness, rid, safariOutcome, type Harness } from './harness.js';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

const VERSION_KEYS = CAPABILITY_KEYS.filter((k) => CAPABILITY_CONTEXT_DEPS[k].includes('surgeVersion') || CAPABILITY_CONTEXT_DEPS[k].includes('surgeBuild'));

describe('unreadable running Surge version', () => {
  test('version-dependent capabilities recorded for the running version become unverified; others keep their status', async () => {
    h = await createHarness();
    // 测试工具按 FakeSurge 运行实例的版本（其余字段 any）记录全部能力：读得到同一版本时都有效
    expect((await h.app.listCapabilities()).every((c) => c.effectiveStatus === 'supported')).toBe(true);
    // 运行实例的包信息缺构建号：版本与构建号一起读不到
    h.fake.build = null;
    const st = await h.app.refreshSurge(WEB);
    expect(st).toMatchObject({ reachable: true, version: null, build: null });
    expect(h.app.engine.capabilityContext()).toMatchObject({ surgeVersion: null, surgeBuild: null });
    const views = await h.app.listCapabilities();
    for (const v of views) {
      if (VERSION_KEYS.includes(v.key)) {
        expect(v.effectiveStatus, v.key).toBe('unverified');
        expect(v.staleReasons, v.key).toEqual(['surgeVersion', 'surgeBuild'].filter((f) => CAPABILITY_CONTEXT_DEPS[v.key].includes(f as never)));
      } else {
        expect(v.effectiveStatus, v.key).toBe('supported');
      }
    }
    // 构建号重新读到 → 记录重新生效（记录本身没有被改动）
    h.fake.build = '10960';
    await h.app.refreshSurge(WEB);
    expect((await h.app.listCapabilities()).every((c) => c.effectiveStatus === 'supported')).toBe(true);
  });

  test('activation is refused with CAPABILITY_UNVERIFIED before touching the route', async () => {
    h = await createHarness();
    const env = (await createEnv(h, 'US-Buyer-A', '203.0.113.10')).environment_id!;
    await bind(h, PROFILE_A, env);
    h.fake.build = null;
    await h.app.refreshSurge(WEB);
    const updates = h.fake.calls.updateExternalResource ?? 0;
    const selects = h.fake.calls.selectGroupPolicy ?? 0;
    const ops = h.repos.operations.listRecent(100).length;
    const req: ActivateRequest = { request_id: rid('act') };
    const err = await h.app.activate(env, req, WEB).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'CAPABILITY_UNVERIFIED' });
    expect((err as { details: { missing: Array<{ key: string; staleReasons: string[] }> } }).details.missing).toContainEqual({ key: 'safari_process_attribution', staleReasons: ['surgeVersion', 'surgeBuild'] });
    await h.idle();
    expect(h.repos.operations.listRecent(100)).toHaveLength(ops);
    expect(h.repos.routeState.get()).toMatchObject({ entryMode: 'NORMAL', activeEnvironmentId: null });
    expect((h.fake.calls.updateExternalResource ?? 0) - updates).toBe(0);
    expect((h.fake.calls.selectGroupPolicy ?? 0) - selects).toBe(0);
  });

  test('entering normal mode still works from an active environment', async () => {
    h = await createHarness();
    const { envId } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    h.fake.build = null;
    await h.app.refreshSurge(WEB);
    expect((await h.app.listCapabilities()).find((c) => c.key === 'runtime_entry_modes')!.effectiveStatus).toBe('unverified');
    const n = await h.app.enterNormal({ request_id: rid('normal'), old_session_policy: 'closed_confirmed', confirmed_environment_id: envId }, WEB);
    await h.idle();
    const op = h.repos.operations.get(n.operation_id)!;
    expect(op.phase).toBe('NORMAL_RESTORED');
    expect(h.repos.routeState.get()).toMatchObject({ entryMode: 'NORMAL', phase: 'idle', activeEnvironmentId: null });
    // 返回普通模式是撤销本应用的入口，Safari 继续原规则；从不重载配置
    expect(safariOutcome(h).rule).toBe('FINAL,DIRECT');
    expect(h.fake.calls.reloadProfile ?? 0).toBe(0);
  });
});
