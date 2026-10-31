// chain：证明外部资源中的节点经 underlying-proxy 前置。三种节点：前置可达（A）、前置端口无服务（DEAD）、
// 前置名在配置中不存在（MISSING）。正面证据来自本机前置服务的 CONNECT 日志与出口服务的“是否经过前置”判定；
// 坏前置与缺失前置必须失败或被跳过，出口服务从未收到绕过前置的连接。测试节点经回环测试资源服务发布（D10：一次单 key
// 更新 + 读回，loopback-ops.ts publishGeneration）：读回成员必须含 A、B、DEAD，MISSING 可以被 Surge 跳过（success 与空错误
// 不能说明它被接受，只看读回）。发布读回不一致时结论为不完整，从不靠重载或重放补救。

import { CAPABILITY_CRITERIA, ROUTE_GROUP_NAME } from '@sfe/contract';
import { SERVER_LOGS } from '../constants.js';
import { refused, type ExitCode } from '../errors.js';
import { check, verdictLabel, writeResult } from '../results.js';
import { saveState } from '../state.js';
import { CHAIN_HOST, TEST_NODES, TEST_USERS, testNodeLine } from '../test-profile.js';
import { confirmWrites, measureContext, printResult, printSnapshot, takeSnapshot, tryRead, type Ctx } from './common.js';
import { openLoopback, readbackText } from './loopback-ops.js';
import { requestViaRoute } from './test-ops.js';

interface ExitEvent {
  at?: string;
  kind?: string;
  user?: string | null;
  throughFront?: boolean;
  ok?: boolean;
  target?: string;
}

/** 测试节点没有经读回确认发布：跳过链路测试，直接恢复。 */
class NotPublished extends Error {}

function exitEventsFor(events: readonly ExitEvent[], user: string, since: number): ExitEvent[] {
  return events.filter((e) => e.user === user && typeof e.at === 'string' && Date.parse(e.at) >= since);
}

export async function runChain(ctx: Ctx): Promise<ExitCode> {
  const { out, now, sleep } = ctx.deps;
  const waitMs = (ctx.args.numbers.wait ?? 2) * 1000;
  const { dir, session, ops, lb, servers, creds, ports, proxy } = await openLoopback(ctx, { requireSetup: true });
  if (session.mechanism.selectGroupPolicy === 'unavailable') throw refused('前置条件不满足：原语 selectGroupPolicy 没有可用实现');
  await lb.ensureKey();
  const snap = await takeSnapshot(ctx, session, dir, 'chain-before');
  printSnapshot(out, snap);
  const ok = await confirmWrites(
    ctx,
    '前置链路测试',
    [
      `测试资源服务提供加入 ${TEST_NODES.dead}（前置端口无服务）与 ${TEST_NODES.missing}（前置名不存在）的新版本，对测试资源执行一次单 key 更新并读回`,
      `SFE-ROUTE 依次选择 ${TEST_NODES.a}、${TEST_NODES.dead}、${TEST_NODES.missing}，各发一次测试请求`,
      '恢复只含 A、B 的版本（一次单 key 更新并读回）与原选择',
    ],
    ['测试资源服务恢复提供只含 A、B 的版本，一次单 key 更新并读回；SFE-ROUTE 选择恢复', '本命令不添加临时规则，不重载配置，不改变当前配置'],
  );
  if (!ok) throw refused('已取消：没有写入任何东西');

  const t0 = now().getTime();
  let a = { ok: false, via: null as string | null, throughFront: null as boolean | null };
  type Probe = { member: boolean; ok: boolean | null; reachedExit: number; bypassed: number; directRecords: number | null };
  let dead: Probe = { member: false, ok: null, reachedExit: 0, bypassed: 0, directRecords: null };
  let missing: Probe = { member: false, ok: null, reachedExit: 0, bypassed: 0, directRecords: null };
  let frontConnects = 0;
  let published: { ok: boolean; note: string } = { ok: false, note: '未发布' };
  try {
    const lines = (['a', 'b', 'dead', 'missing'] as const).map((k) => testNodeLine(k, ports, creds.password));
    // DEAD 的前置名存在，读回成员必须含它；MISSING 的前置名不存在，Surge 可以跳过它
    const pub = await lb.publishGeneration(lines, { label: 'chain', required: [TEST_NODES.a, TEST_NODES.b, TEST_NODES.dead] });
    published = { ok: pub.committed, note: `第 ${pub.generation} 代：${readbackText(pub.assessment)}` };
    if (!pub.committed) throw new NotPublished();
    const members = pub.after?.members ?? [];

    const tA = now().getTime();
    await ops.select(TEST_NODES.a);
    const ra = await requestViaRoute(proxy, servers.echoPort, 'chain-a');
    a = { ok: ra.ok, via: ra.via, throughFront: ra.throughFront };
    await sleep(500);
    frontConnects = dir.readJsonl<ExitEvent>(SERVER_LOGS.front).filter((e) => e.kind === 'connected' && typeof e.at === 'string' && Date.parse(e.at) >= tA && e.target === `127.0.0.1:${servers.exitPort}`).length;

    for (const which of ['dead', 'missing'] as const) {
      const node = TEST_NODES[which];
      const user = TEST_USERS[which];
      const rec: Probe = { member: members.includes(node), ok: null, reachedExit: 0, bypassed: 0, directRecords: null };
      if (rec.member) {
        const t = now().getTime();
        await ops.select(node);
        const res = await requestViaRoute(proxy, servers.echoPort, `chain-${which}`);
        await sleep(waitMs);
        const evs = exitEventsFor(dir.readJsonl<ExitEvent>(SERVER_LOGS.exit), user, t);
        rec.ok = res.ok;
        rec.reachedExit = evs.filter((e) => e.kind === 'auth' && e.ok).length;
        rec.bypassed = evs.filter((e) => e.kind === 'auth' && e.ok && e.throughFront === false).length;
        // Surge 侧：这次请求是否被按 DIRECT 发出。
        const recent = await tryRead(() => session.adapter.listRecentRequests());
        rec.directRecords =
          recent === null
            ? null
            : recent.filter((x) => (x.remoteHost ?? '').toLowerCase() === CHAIN_HOST && x.startedAt !== null && x.startedAt.getTime() >= t - 1000 && (x.policyName ?? '').toUpperCase() === 'DIRECT').length;
      }
      if (which === 'dead') dead = rec;
      else missing = rec;
    }
  } catch (e) {
    if (!(e instanceof NotPublished)) throw e;
    out.warn(`测试节点没有经读回确认发布（${published.note}）：无法测试前置链路`);
  } finally {
    try {
      // 先选回不受影响的选择，再恢复 A、B（被删除的选中节点不会落到其他节点）
      const restoreTo = snap.routeSelection === TEST_NODES.a || snap.routeSelection === TEST_NODES.b ? snap.routeSelection : 'REJECT';
      await ops.select(restoreTo).catch(() => undefined);
      const back = await lb.publishGeneration([testNodeLine('a', ports, creds.password), testNodeLine('b', ports, creds.password)], { label: 'chain-restore' });
      if (!back.committed) out.warn(`恢复只含 A、B 的版本没有经读回确认（${readbackText(back.assessment)}）：请按回退方式处理`);
    } catch {
      out.warn('恢复测试资源或选择失败：请按回退方式处理');
    }
    saveState(dir, ops.state);
  }
  const notPublished = `测试节点没有经读回确认发布（${published.note}），未测：先查明回环测试资源（loopback）的问题`;
  const membersNow = await tryRead(() => session.adapter.getGroupMembers(ROUTE_GROUP_NAME));

  const context = await measureContext(ctx, session, ops.state);
  const result = writeResult(dir, {
    key: 'external_node_underlying_proxy',
    command: 'chain',
    at: now().toISOString(),
    checks: [
      check(
        '经前置到达出口（正面链路证据）',
        !published.ok ? null : a.ok && a.via === TEST_USERS.a && a.throughFront === true && frontConnects > 0,
        !published.ok ? notPublished : `经过 ${a.via ?? '无'}，经前置 ${a.throughFront === null ? '未知' : a.throughFront ? '是' : '否'}，前置 CONNECT ${frontConnects} 次`,
      ),
      check(
        '前置不可达时连接失败而非直连',
        !dead.member ? null : dead.ok === false && dead.reachedExit === 0 && dead.directRecords !== null && dead.directRecords === 0 ? true : dead.ok === false && dead.reachedExit === 0 && dead.directRecords === null ? null : false,
        !published.ok ? notPublished : !dead.member ? '坏前置节点不在组成员中，无法测试' : `请求${dead.ok ? '成功' : '失败'}，到达出口 ${dead.reachedExit} 次（绕过前置 ${dead.bypassed}），Surge 记录中 DIRECT ${dead.directRecords ?? '读不到'} 条`,
      ),
      check(
        '前置名缺失时节点被跳过或失败而非直连',
        !published.ok ? null : !missing.member ? true : missing.ok === false && missing.reachedExit === 0 && missing.directRecords === 0 ? true : missing.ok === false && missing.reachedExit === 0 && missing.directRecords === null ? null : false,
        !published.ok ? notPublished : !missing.member ? '节点被跳过（不在读回的组成员中）' : `请求${missing.ok ? '成功' : '失败'}，到达出口 ${missing.reachedExit} 次（绕过前置 ${missing.bypassed}），Surge 记录中 DIRECT ${missing.directRecords ?? '读不到'} 条`,
      ),
    ],
    summary: [
      `通过条件：${CAPABILITY_CRITERIA.external_node_underlying_proxy}`,
      `测试用时 ${Math.round((now().getTime() - t0) / 1000)} 秒`,
      published.ok ? `测试节点经回环测试资源发布（一次单 key 更新，${published.note}）` : notPublished,
      `结束时 SFE-ROUTE 成员：${membersNow?.join('、') ?? '读不到'}`,
    ],
    context,
  });
  out.heading(`前置链路结论：${verdictLabel(result.verdict)}`);
  printResult(out, result);
  return 0;
}
