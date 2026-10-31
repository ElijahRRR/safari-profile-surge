// preflight：SFE-ROUTE 选中 A 时，用 testPolicy 测试未选中的 B。回显服务按经过的测试节点给出正面证据：
// 测试请求确实经过 B（而不是当前选择 A），且测试前后选择不变。另记录对 SFE-ROUTE 本身做 testPolicy 时
// 测的是不是当前选择（激活流程第 8 步依赖这一点）。

import { CAPABILITY_CRITERIA, ROUTE_GROUP_NAME } from '@sfe/contract';
import { SERVER_LOGS } from '../constants.js';
import { refused, type ExitCode } from '../errors.js';
import { check, verdictLabel, writeResult } from '../results.js';
import { saveState } from '../state.js';
import { ECHO_HOST, TEST_NODES, TEST_USERS } from '../test-profile.js';
import { confirmWrites, measureContext, openRun, openSession, printResult, requireServers, tryRead, type Ctx } from './common.js';
import { TestOps } from './test-ops.js';

interface EchoEvent {
  at?: string;
  kind?: string;
  testId?: string | null;
  via?: string | null;
}

export async function runPreflight(ctx: Ctx): Promise<ExitCode> {
  const { out, now, sleep } = ctx.deps;
  const { dir, state } = openRun(ctx);
  const servers = await requireServers(ctx, state);
  const session = await openSession(ctx, dir, state, { needTestProfile: true });
  if (session.mechanism.testPolicy === 'unavailable') throw refused('前置条件不满足：testPolicy 没有可用实现');
  const ops = new TestOps(ctx, dir, session, state);
  const before = await tryRead(() => session.adapter.getGroupSelection(ROUTE_GROUP_NAME));
  const ok = await confirmWrites(
    ctx,
    '候选节点独立预检',
    [`SFE-ROUTE 选择 ${TEST_NODES.a}`, `对 ${TEST_NODES.b} 与 ${ROUTE_GROUP_NAME} 各执行一次 testPolicy（访问本机测试回显）`],
    [`SFE-ROUTE 选择恢复为 ${before ?? 'REJECT'}`],
  );
  if (!ok) throw refused('已取消：没有写入任何东西');

  const runTag = `${now().getTime()}`;
  const urlFor = (tag: string): string => `http://${ECHO_HOST}:${servers.echoPort}/ip?t=preflight-${tag}-${runTag}`;
  await ops.select(TEST_NODES.a);
  const t0 = now().getTime();
  let resB: { ok: boolean; latencyMs: number | null; error: string | null } | null = null;
  let resRoute: { ok: boolean; latencyMs: number | null; error: string | null } | null = null;
  try {
    resB = await session.adapter.testPolicy(TEST_NODES.b, urlFor('b'));
  } catch (e) {
    out.warn(`testPolicy 失败：${(e as { code?: string }).code ?? 'ERROR'}`);
  }
  const selAfterB = await tryRead(() => session.adapter.getGroupSelection(ROUTE_GROUP_NAME));
  try {
    resRoute = await session.adapter.testPolicy(ROUTE_GROUP_NAME, urlFor('route'));
  } catch {
    /* 记录为未知 */
  }
  await sleep(1000);
  const events = dir.readJsonl<EchoEvent>(SERVER_LOGS.echo).filter((e) => typeof e.at === 'string' && Date.parse(e.at) >= t0);
  const viaOf = (tag: string): string[] => [...new Set(events.filter((e) => e.testId === `preflight-${tag}-${runTag}`).map((e) => e.via ?? '未知'))];
  const viaB = viaOf('b');
  const viaRoute = viaOf('route');
  if (before && before !== TEST_NODES.a) await ops.select(before).catch(() => undefined);
  saveState(dir, ops.state);

  const context = await measureContext(ctx, session, ops.state);
  const result = writeResult(dir, {
    key: 'independent_node_preflight',
    command: 'preflight',
    at: now().toISOString(),
    checks: [
      check('对未选中节点的 testPolicy 成功', resB === null ? false : resB.ok, resB ? `延迟 ${resB.latencyMs ?? '-'} ms${resB.error ? `，错误 ${resB.error}` : ''}` : '调用失败'),
      check('测试请求确实经过未选中的节点（不是当前选择）', viaB.length === 0 ? null : viaB.length === 1 && viaB[0] === TEST_USERS.b, `回显看到 ${viaB.join('、') || '无请求（testPolicy 可能不访问给定地址）'}`),
      check('测试前后选择不变', selAfterB === TEST_NODES.a, `测试后读回 ${selAfterB ?? '读不到'}`),
    ],
    summary: [
      `通过条件：${CAPABILITY_CRITERIA.independent_node_preflight}`,
      `对 ${ROUTE_GROUP_NAME} 执行 testPolicy：${resRoute ? (resRoute.ok ? '成功' : '失败') : '调用失败'}，回显看到 ${viaRoute.join('、') || '无请求'}（${viaRoute.length === 1 && viaRoute[0] === TEST_USERS.a ? '测的是当前选择' : '无法确认测的是当前选择'}）`,
    ],
    context,
  });
  out.heading(`独立预检结论：${verdictLabel(result.verdict)}`);
  printResult(out, result);
  for (const l of result.summary.slice(1)) out.line(l);
  return 0;
}
