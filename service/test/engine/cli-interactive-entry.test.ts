// 临时规则入口的写命令经 CLI 时进入交互模式（6.5 实测的提示，退出 0）：写入从不被当作已完成。
// 激活不成功且失败原因是交互模式；返回普通模式如实报告失败、入口保持已确认的阻断，不重载、不换用其他实现。
// 只把指定原语接到真实的 CLI 适配器（假的 exec），其余仍由 FakeSurge 提供。合成数据。

import { afterEach, describe, expect, test } from 'vitest';
import { createCliAdapter, type ExecFn } from '../../src/surge/cli-adapter.js';
import type { FakeSurge } from '../../src/surge/fake.js';
import { SURGE_PRIMITIVES, type SurgePrimitive } from '../../src/surge/primitives.js';
import { PROFILE_A, WEB, bind, createEnv, createHarness, rid, type Harness } from './harness.js';

const CLI = '/Applications/Surge.app/Contents/Applications/surge-cli';
const BANNER = 'No command is provided, enter interactive mode.\nTips: Use surge-cli --help to show available commands.\nConnected to 127.0.0.1\n> ';
const INTERACTIVE_MESSAGE = '执行 Surge 命令失败：命令行工具不支持该命令（进入了交互模式）';

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

/** `--raw dump temp-rule` 按 FakeSurge 的状态回答 JSON；其他命令都打印交互模式提示并退出 0。 */
function surge65Exec(fake: FakeSurge, calls: string[][]): ExecFn {
  const listTemp = fake.listTempRules.bind(fake);
  return async (_file, args) => {
    calls.push([...args]);
    if (args.join(' ') === '--raw dump temp-rule') return { stdout: JSON.stringify(await listTemp()), stderr: '' };
    return { stdout: BANNER, stderr: '' };
  };
}

function routeThroughCli(hh: Harness, prims: SurgePrimitive[]): string[][] {
  const calls: string[][] = [];
  const mechanism = Object.fromEntries(SURGE_PRIMITIVES.map((p) => [p, prims.includes(p) ? 'cli' : 'fake'])) as Record<string, 'cli' | 'fake'>;
  const cli = createCliAdapter({ cliPath: CLI, mechanism, exec: surge65Exec(hh.fake, calls), scrub: (s) => s });
  const f = hh.fake as unknown as Record<string, unknown>;
  for (const p of prims) f[p] = (...a: unknown[]) => (cli[p] as (...x: unknown[]) => Promise<unknown>)(...a);
  f.mechanism = () => ({ ...mechanism });
  return calls;
}

describe('temp_rule entry when the CLI write enters interactive mode', () => {
  test('activation never treats the banner as an added rule', async () => {
    h = await createHarness({ entryStrategy: 'temp_rule' });
    const envId = (await createEnv(h, 'US-Buyer-A', '203.0.113.10')).environment_id!;
    await bind(h, PROFILE_A, envId);
    const calls = routeThroughCli(h, ['addTempRule', 'listTempRules']);
    const a = await h.app.activate(envId, { request_id: rid('act') }, WEB);
    await h.idle();
    const op = h.repos.operations.get(a.operation_id)!;
    expect(calls.some((c) => c[0] === 'temp-rule' && c[1] === 'add')).toBe(true);
    expect(op.status).not.toBe('succeeded');
    expect(op.error?.details).toMatchObject({ cause: 'SURGE_COMMAND_FAILED' });
    const steps = h.repos.operations.listSteps(a.operation_id).map((s) => s.message);
    expect(steps.some((m) => m.includes(INTERACTIVE_MESSAGE))).toBe(true);
    expect(JSON.stringify([op.error, steps])).not.toContain('127.0.0.1');
    expect(h.fake.tempRules).toEqual([]);
    expect(h.repos.routeState.get().entryMode).not.toBe('ACTIVE');
    expect(h.fake.calls.reloadProfile ?? 0).toBe(0);
  });

  test('normal mode reports the interactive-mode failure and keeps the confirmed block instead of claiming it was removed', async () => {
    h = await createHarness({ entryStrategy: 'temp_rule' });
    const envId = (await createEnv(h, 'US-Buyer-A', '203.0.113.10')).environment_id!;
    await bind(h, PROFILE_A, envId);
    await h.app.activate(envId, { request_id: rid('act') }, WEB);
    await h.idle();
    expect(h.repos.routeState.get().entryMode).toBe('BLOCKED');
    const rulesBefore = [...h.fake.tempRules];
    expect(rulesBefore.length).toBeGreaterThan(0);

    const calls = routeThroughCli(h, ['removeTempRule', 'listTempRules']);
    const active = h.repos.routeState.get().activeEnvironmentId;
    const n = await h.app.enterNormal(active ? { request_id: rid('normal'), old_session_policy: 'closed_confirmed', confirmed_environment_id: active } : { request_id: rid('normal') }, WEB);
    await h.idle();
    const op = h.repos.operations.get(n.operation_id)!;
    expect(calls.some((c) => c[0] === 'temp-rule' && c[1] === 'remove')).toBe(true);
    expect(op.status).toBe('failed');
    expect(op.error).toMatchObject({ code: 'SURGE_COMMAND_FAILED', message: INTERACTIVE_MESSAGE, details: { primitive: 'removeTempRule', reason: 'interactive_mode' } });
    expect(h.repos.routeState.get().entryMode).toBe('BLOCKED');
    expect(h.fake.tempRules).toEqual(rulesBefore);
    expect(h.fake.calls.reloadProfile ?? 0).toBe(0);
  });
});
