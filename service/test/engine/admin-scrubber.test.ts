// 最低权限通道（agent.sock）送来的超长“秘密”不会让脱敏器失效：请求按校验拒绝，之后的受理、
// 回到普通模式与日志都照常工作（脱敏器从不抛异常，合法长度的秘密仍被遮盖）。
// 请求只在已知的秘密位置登记值：任意嵌套键下的大量 password 不会被登记，不会让之后的日志变慢。
import { afterEach, describe, expect, test } from 'vitest';
import { dispatchAdminRequest } from '../../src/ipc/admin-server.js';
import { SCRUB_MASK } from '../../src/util/scrubber.js';
import { PROFILE_A, WEB, activeEnv, createEnv, createHarness, rid, type Harness } from './harness.js';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

describe('oversized secrets from the agent socket', () => {
  test('a rejected request with 80 000-character credentials does not break later operations or logging', async () => {
    h = await createHarness();
    const { envId } = await activeEnv(h, 'US-Buyer-01', '203.0.113.10', PROFILE_A);
    const huge = (c: string) => c.repeat(80_000);
    const res = await dispatchAdminRequest(h.app, 'agent', {
      v: 1,
      op: 'createEnvironment',
      args: { request_id: rid('x'), environment: { proxy: { username: huge('u'), password: huge('p') }, account: { password: { action: 'replace', value: huge('a') } } } },
    });
    expect(res).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });

    // 之后的受理、执行器步骤与回到普通模式照常
    const b = await createEnv(h, 'US-Buyer-02', '203.0.113.11', { password: 'synthpass02' });
    expect(h.repos.operations.get(b.operation_id)!.phase).toBe('READY_FOR_NEXT_OPEN');
    const normal = await h.app.enterNormal({ request_id: rid(), old_session_policy: 'closed_confirmed', confirmed_environment_id: envId }, WEB);
    await h.idle();
    expect(h.repos.operations.get(normal.operation_id)!.status).not.toBe('failed');
    expect(h.repos.routeState.get().entryMode).toBe('NORMAL');

    // 日志没有静默停止，合法秘密仍被遮盖
    const logsBefore = h.logs.length;
    h.app.engine.log('info', 'test.after_oversized', { detail: 'auth rejected synthpass02' });
    expect(h.logs.length).toBe(logsBefore + 1);
    expect(h.logs.at(-1)).not.toContain('synthpass02');
  });
  test('only the known secret fields of a request are registered, not arbitrarily nested password keys', async () => {
    h = await createHarness();
    const junk = Array.from({ length: 20_000 }, (_, i) => ({ password: `op_${i.toString(36).padStart(6, '0')}Junk${(i * 7919).toString(36)}` }));
    const proxySecret = 'Synth-proxy-pw-77';
    const accountSecret = '账号-synth-pw-88';
    const res = await dispatchAdminRequest(h.app, 'agent', {
      v: 1,
      op: 'createEnvironment',
      args: {
        request_id: rid('x'),
        environment: { junk, proxy: { password: { action: 'replace', value: proxySecret } }, account: { password: { action: 'replace', value: accountSecret } } },
      },
    });
    expect(res).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
    const scrubber = h.app.engine.scrubber;
    // 已知位置的秘密在校验之前就已登记
    expect(scrubber.scrub(`auth rejected ${proxySecret} / ${accountSecret}`)).toBe(`auth rejected ${SCRUB_MASK} / ${SCRUB_MASK}`);
    // 任意键下的值没有登记：含 op_ 的日志照常输出，也不会因登记表膨胀而变慢
    for (const j of [junk[0]!, junk[9_999]!, junk.at(-1)!]) expect(scrubber.scrub(`step ${j.password}`)).toBe(`step ${j.password}`);
    const before = h.logs.length;
    for (let i = 0; i < 20; i++) h.app.engine.log('info', 'test.after_junk', { operation: `op_${i}`, detail: `auth rejected ${proxySecret}` });
    expect(h.logs.length).toBe(before + 20);
    expect(h.logs.slice(before).join('\n')).not.toContain(proxySecret);
  });
});
