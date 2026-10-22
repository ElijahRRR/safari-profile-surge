// 读不到运行中 Surge 的版本与构建号时（运行实例读取失败，例如包信息缺构建号、启动后包被修改），依赖版本的能力
// 一律待验证：记录为 null 或 any 都不能匹配读不到的当前值（docs/ARCHITECTURE.md §5.2）。最低支持 Surge Mac 6.10.0
// （构建 ≥ 12500、Controller 协议 ≥ 22）：低于它（运行实例或 `surge-cli --raw version` 任一显示）时版本按不接受处理，
// 依赖版本的动作（发布、激活、维护写入）拒绝，即使有在旧版本上测得的记录。进入普通模式始终可用。只用合成数据。

import { afterEach, describe, expect, test } from 'vitest';
import { CAPABILITY_CONTEXT_DEPS, CAPABILITY_KEYS, type ActivateRequest, type CapabilityKey } from '@sfe/contract';
import { versionUnknownMessage } from '../../src/engine/context.js';
import { unsupportedCommandError, interactiveModeError } from '../../src/surge/cli-adapter.js';
import { capabilityUnverified } from '../../src/surge/primitives.js';
import { PROFILE_A, WEB, activeEnv, anyContext, bind, createEnv, createHarness, rid, safariOutcome, type Harness } from './harness.js';

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
    h.fake.build = '12500';
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

/** 按某个 Surge 版本记录全部能力（例如在旧版本上测得的记录）。 */
function grantAt(hh: Harness, version: string, build: string): void {
  for (const key of CAPABILITY_KEYS) {
    hh.repos.capabilities.upsert({ key, status: 'supported', context: { ...anyContext(), surgeVersion: version, surgeBuild: build }, verifiedAt: hh.clock.now().toISOString(), note: '测试记录' });
  }
}

const MINIMUM_TEXT = '低于最低支持版本 6.10.0（构建 12500、Controller 协议 22）';

describe('Surge below the minimum supported version (6.10.0 / 12500 / Controller protocol 22)', () => {
  test.each([
    ['6.5.0', '10960'],
    ['6.9.1', '12290'],
    ['6.10.0', '12499'],
  ])('running instance %s (%s): version refused even with records measured on it; getVersion not consulted', async (version, build) => {
    h = await createHarness();
    h.fake.version = version;
    h.fake.build = build;
    grantAt(h, version, build);
    const versionReads = h.fake.calls.getVersion ?? 0;
    const st = await h.app.refreshSurge(WEB);
    expect(st).toMatchObject({ reachable: true, version: null, build: null, onWorkingProfile: true });
    expect(st.message).toBe(versionUnknownMessage('surge_version_unsupported', { version, build }));
    expect(st.message).toContain(`运行中的 Surge 为 ${version}（${build}）`);
    expect(st.message).toContain(MINIMUM_TEXT);
    // 不声称普通模式不受影响：低于 6.9 时入口撤销无法用 rule match 确认（ARCHITECTURE §0 的冲突）
    expect(st.message).toContain('进入普通模式仍可用');
    expect(st.message).toContain('入口规则未能读回确认');
    expect(st.message).not.toContain('不受影响');
    expect(h.app.engine.facts.versionIssue).toBe('surge_version_unsupported');
    expect(h.app.engine.facts.controllerProtocol).toBeNull();
    expect(h.fake.calls.getVersion ?? 0).toBe(versionReads);
    expect(h.app.engine.capabilityContext()).toMatchObject({ surgeVersion: null, surgeBuild: null });
    for (const v of await h.app.listCapabilities()) expect(v.effectiveStatus, v.key).toBe(VERSION_KEYS.includes(v.key) ? 'unverified' : 'supported');
  });

  test.each([
    ['Controller protocol 21', (hh: Harness) => void (hh.fake.controllerProtocol = 21)],
    ['Unknown command', (hh: Harness) => void (hh.fake.getVersion = async () => { throw unsupportedCommandError('getVersion'); })],
    ['the interactive-mode banner', (hh: Harness) => void (hh.fake.getVersion = async () => { throw interactiveModeError('getVersion'); })],
  ])('surge-cli version reporting %s → surge_version_unsupported', async (_name, arrange) => {
    h = await createHarness();
    arrange(h);
    const st = await h.app.refreshSurge(WEB);
    expect(st).toMatchObject({ reachable: true, version: null, build: null });
    expect(h.app.engine.facts.versionIssue).toBe('surge_version_unsupported');
    expect(st.message).toContain(MINIMUM_TEXT);
    expect(st.message).toContain('运行中的 Surge 为 6.10.0（12500）');
  });

  test('a supported version records the Controller protocol and gives no message', async () => {
    h = await createHarness();
    h.fake.controllerProtocol = 22;
    const versionReads = h.fake.calls.getVersion ?? 0;
    const st = await h.app.refreshSurge(WEB);
    expect(st).toMatchObject({ reachable: true, version: '6.10.0', build: '12500', message: null });
    expect(h.app.engine.facts).toMatchObject({ versionIssue: null, controllerProtocol: 22 });
    expect((h.fake.calls.getVersion ?? 0) - versionReads).toBe(1);
  });

  test('publish parks with the version reason; nothing written', async () => {
    h = await createHarness();
    h.fake.version = '6.5.0';
    h.fake.build = '10960';
    grantAt(h, '6.5.0', '10960');
    const a = await createEnv(h, 'US-Buyer-A', '203.0.113.10');
    const op = h.repos.operations.get(a.operation_id)!;
    expect(op.phase).toBe('WAITING_DEPLOYMENT');
    expect(op.error?.code).toBe('CAPABILITY_UNVERIFIED');
    expect(op.error?.message).toContain(MINIMUM_TEXT);
    expect(op.error?.message).toContain('新版本保持待部署，已部署的节点不受影响');
    expect(h.repos.deployments.list()).toEqual([]);
    expect(h.fake.calls.updateExternalResource ?? 0).toBe(0);
  });

  test('activation and maintenance writes are refused with the version reason before touching anything', async () => {
    h = await createHarness();
    const env = (await createEnv(h, 'US-Buyer-A', '203.0.113.10')).environment_id!;
    await bind(h, PROFILE_A, env);
    h.fake.version = '6.9.1';
    h.fake.build = '12290';
    grantAt(h, '6.9.1', '12290');
    await h.app.refreshSurge(WEB);
    const selects = h.fake.calls.selectGroupPolicy ?? 0;
    const err = await h.app.activate(env, { request_id: rid('act') }, WEB).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'CAPABILITY_UNVERIFIED' });
    expect(h.repos.routeState.get()).toMatchObject({ entryMode: 'NORMAL', activeEnvironmentId: null });
    expect((h.fake.calls.selectGroupPolicy ?? 0) - selects).toBe(0);
    const preview = await h.app.remergePreview(WEB);
    expect(preview.checks.find((c) => c.name === 'gate')!.ok).toBe(false);
    await expect(h.app.remergeCommit({ request_id: rid('remerge'), preview_digest: preview.preview_digest }, WEB)).rejects.toMatchObject({ code: 'CAPABILITY_UNVERIFIED' });
    expect(h.fake.calls.reloadProfile ?? 0).toBe(0);
  });

  test('requireCapabilities names the version as the reason (version-dependent gates only)', async () => {
    h = await createHarness();
    h.fake.version = '6.5.0';
    h.fake.build = '10960';
    await h.app.refreshSurge(WEB);
    const engine = h.app.engine;
    const keys: CapabilityKey[] = ['independent_node_preflight'];
    expect(() => engine.requireCapabilities(keys, '预检')).toThrow(MINIMUM_TEXT);
    // 不依赖 Surge 版本的门槛不受影响
    expect(() => engine.requireCapabilities(['native_bridge_ipc'], '关联场景')).not.toThrow();
  });

  /** 激活后入口不是 NORMAL（停在 BLOCKED 或等待实测的 VERIFY_ONLY 都可以）。 */
  async function activated(strategy: 'temp_rule' | 'ruleset_resource'): Promise<void> {
    h = await createHarness({ entryStrategy: strategy });
    const envId = (await createEnv(h, 'US-Buyer-A', '203.0.113.10')).environment_id!;
    await bind(h, PROFILE_A, envId);
    await h.app.activate(envId, { request_id: rid('act') }, WEB);
    await h.idle();
    expect(['BLOCKED', 'VERIFY_ONLY']).toContain(h.repos.routeState.get().entryMode);
  }

  async function normal(): Promise<string> {
    const active = h.repos.routeState.get().activeEnvironmentId;
    const n = await h.app.enterNormal(active ? { request_id: rid('normal'), old_session_policy: 'closed_confirmed', confirmed_environment_id: active } : { request_id: rid('normal') }, WEB);
    await h.idle();
    return n.operation_id;
  }

  // 降级需要退出并重新打开 Surge（FakeSurge.changeVersion = restart）：6.9 以下的 Surge 回答 Unknown command 给
  // `rule match` 与 `rule temp add/remove`（随包技能：“An older core answers `Unknown command`”）。只改版本字段而不重启
  // 的旧写法让假 Surge 继续回答这些命令、保留临时规则，与真实情形不符（之前的测试因此通过）。
  test('temp_rule: after a downgrade (a restart discards the temp rules) normal mode completes without any rule command', async () => {
    await activated('temp_rule');
    expect(h.fake.tempRules.length).toBeGreaterThan(0);
    h.fake.changeVersion({ version: '6.5.0', build: '10960', controllerProtocol: 18 });
    expect(h.fake.tempRules).toEqual([]);
    await h.app.refreshSurge(WEB);
    expect(h.app.engine.facts.versionIssue).toBe('surge_version_unsupported');
    await expect(h.fake.matchRule({ host: 'x.example.test', processPath: '/usr/bin/true', protocol: 'TCP' })).rejects.toMatchObject({ details: { reason: 'unsupported_command' } });
    const writes = { add: h.fake.calls.addTempRule ?? 0, remove: h.fake.calls.removeTempRule ?? 0 };
    const op = await normal();
    expect(h.repos.operations.get(op)!.error ?? null, JSON.stringify(h.repos.operations.get(op)!.error)).toBeNull();
    expect(h.repos.operations.get(op)!.phase).toBe('NORMAL_RESTORED');
    expect(h.repos.routeState.get()).toMatchObject({ entryMode: 'NORMAL', phase: 'idle' });
    expect(h.repos.routeState.get().warnings).not.toContain('entry_unverified');
    expect({ add: h.fake.calls.addTempRule ?? 0, remove: h.fake.calls.removeTempRule ?? 0 }).toEqual(writes);
    // 返回普通模式是撤销本应用的入口，Safari 继续原规则；从不重载配置
    expect(safariOutcome(h).rule).toBe('FINAL,DIRECT');
    expect(h.fake.calls.reloadProfile ?? 0).toBe(0);
  });

  test('ruleset_resource: after a downgrade (entry files survive; rule match answers Unknown command) normal mode still completes, reported as not runtime-confirmed', async () => {
    await activated('ruleset_resource');
    expect(safariOutcome(h).rule).toMatch(/^RULE-SET,sfe-entry-/);
    h.fake.changeVersion({ version: '6.8.1', build: '12030', controllerProtocol: 18 });
    // 入口文件在重启后照样加载：Safari 仍被本应用入口规则拦下
    expect(safariOutcome(h).rule).toMatch(/^RULE-SET,sfe-entry-/);
    await h.app.refreshSurge(WEB);
    expect(h.app.engine.facts.versionIssue).toBe('surge_version_unsupported');
    const op = await normal();
    const rec = h.repos.operations.get(op)!;
    expect(rec.phase).toBe('NORMAL_RESTORED');
    expect(h.repos.routeState.get()).toMatchObject({ entryMode: 'NORMAL', phase: 'idle' });
    // 未经运行时确认：路由状态带 entry_unverified，操作步骤写明
    expect(h.repos.routeState.get().warnings).toContain('entry_unverified');
    expect(h.repos.operations.listSteps(op).map((st) => st.message).join(' ')).toContain('未经运行时求值确认');
    expect(safariOutcome(h).rule).toBe('FINAL,DIRECT');
    expect(safariOutcome(h, 'www.example.test', 'udp').rule).toBe('FINAL,DIRECT');
    expect(h.fake.calls.reloadProfile ?? 0).toBe(0);
    expect(h.fake.calls.updateExternalResource ?? 0).toBe(0);
  });
});

describe('matchRule not mapped (an install.json written before the primitive existed)', () => {
  const unmapped = () => {
    h.fake.matchRule = async () => {
      throw capabilityUnverified('matchRule');
    };
  };

  test('activation is refused before any write when the recorded mapping had matchRule and install.json no longer maps it', async () => {
    h = await createHarness();
    const envId = (await createEnv(h, 'US-Buyer-A', '203.0.113.10')).environment_id!;
    await bind(h, PROFILE_A, envId);
    await h.app.refreshSurge(WEB);
    // 按完整的当前上下文（含 adapterMechanism）记录入口能力
    const recorded = h.app.engine.capabilityContext();
    for (const key of ['runtime_entry_modes', 'auto_reload_atomic_replace'] as const) {
      h.repos.capabilities.upsert({ key, status: 'supported', context: recorded, verifiedAt: h.clock.now().toISOString(), note: '测试记录' });
    }
    const orig = h.fake.mechanism.bind(h.fake);
    h.fake.mechanism = () => ({ ...orig(), matchRule: 'unavailable' });
    await h.app.refreshSurge(WEB);
    const before = { ...h.fake.calls };
    const err = await h.app.activate(envId, { request_id: rid('act') }, WEB).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'CAPABILITY_UNVERIFIED' });
    expect((err as { details: { missing: Array<{ key: string; staleReasons: string[] }> } }).details.missing).toContainEqual({ key: 'runtime_entry_modes', staleReasons: ['adapterMechanism'] });
    await h.idle();
    expect(h.repos.routeState.get()).toMatchObject({ entryMode: 'NORMAL', activeEnvironmentId: null });
    for (const w of ['selectGroupPolicy', 'addTempRule', 'removeTempRule']) expect(h.fake.calls[w] ?? 0, w).toBe(before[w] ?? 0);
    expect(h.fake.watcherReloads.filter((r) => r.key.startsWith('ruleset:sfe-entry-'))).toEqual([]);
    // 只改 updateExternalResource 的映射：没有任何能力过期（发布与入口从不调用它）
    h.fake.mechanism = () => ({ ...orig(), updateExternalResource: 'unavailable' });
    await h.app.refreshSurge(WEB);
    expect((await h.app.listCapabilities()).filter((c) => c.staleReasons.includes('adapterMechanism'))).toEqual([]);
  });

  test('ruleset_resource: normal mode completes from an activated route, reported as not runtime-confirmed', async () => {
    h = await createHarness();
    const envId = (await createEnv(h, 'US-Buyer-A', '203.0.113.10')).environment_id!;
    await bind(h, PROFILE_A, envId);
    await h.app.activate(envId, { request_id: rid('act') }, WEB);
    await h.idle();
    unmapped();
    const active = h.repos.routeState.get().activeEnvironmentId;
    const n = await h.app.enterNormal(active ? { request_id: rid('normal'), old_session_policy: 'closed_confirmed', confirmed_environment_id: active } : { request_id: rid('normal') }, WEB);
    await h.idle();
    expect(h.repos.operations.get(n.operation_id)!.phase).toBe('NORMAL_RESTORED');
    expect(h.repos.routeState.get()).toMatchObject({ entryMode: 'NORMAL', phase: 'idle' });
    expect(h.repos.routeState.get().warnings).toContain('entry_unverified');
    expect(safariOutcome(h).rule).toBe('FINAL,DIRECT');
  });

  test('temp_rule: normal mode from VERIFY_ONLY completes (structural readback), the block step is reported unconfirmed', async () => {
    h = await createHarness({ entryStrategy: 'temp_rule' });
    const envId = (await createEnv(h, 'US-Buyer-A', '203.0.113.10')).environment_id!;
    await bind(h, PROFILE_A, envId);
    await h.app.activate(envId, { request_id: rid('act') }, WEB);
    await h.idle();
    expect(h.fake.tempRules.length).toBeGreaterThan(0);
    unmapped();
    const active = h.repos.routeState.get().activeEnvironmentId;
    const n = await h.app.enterNormal(active ? { request_id: rid('normal'), old_session_policy: 'closed_confirmed', confirmed_environment_id: active } : { request_id: rid('normal') }, WEB);
    await h.idle();
    const rec = h.repos.operations.get(n.operation_id)!;
    expect(rec.phase).toBe('NORMAL_RESTORED');
    expect(h.fake.tempRules).toEqual([]);
    expect(h.repos.operations.listSteps(n.operation_id).map((st) => st.message).join(' ')).toContain('未经运行时求值确认');
    // NORMAL 没有本应用规则：按临时规则列表确认，不带入口未确认警告
    expect(h.repos.routeState.get().warnings).not.toContain('entry_unverified');
    expect(safariOutcome(h).rule).toBe('FINAL,DIRECT');
  });
});
