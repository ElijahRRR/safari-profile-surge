// chain：证明外部资源中的节点经 underlying-proxy 前置。三种节点：前置可达（A）、前置端口无服务（DEAD）、
// 前置名在配置中不存在（MISSING）。正面证据来自本机前置服务的 CONNECT 日志与出口服务的“是否经过前置”判定；
// 坏前置与缺失前置必须失败或被跳过，出口服务从未收到绕过前置的连接。

import { CAPABILITY_CRITERIA, NODE_RESOURCE_FILE, ROUTE_GROUP_NAME } from '@sfe/contract';
import { SERVER_LOGS } from '../constants.js';
import { refused, type ExitCode } from '../errors.js';
import { check, verdictLabel, writeResult } from '../results.js';
import { saveState } from '../state.js';
import { CHAIN_HOST, TEST_NODES, TEST_USERS, testNodeResource, type TestPorts } from '../test-profile.js';
import { allowRefreshFor, confirmWrites, loadCredentials, measureContext, openRun, openSession, printResult, printSnapshot, proxyOf, requireServers, takeSnapshot, tryRead, type Ctx } from './common.js';
import { TestOps, requestViaRoute } from './test-ops.js';

interface ExitEvent {
  at?: string;
  kind?: string;
  user?: string | null;
  throughFront?: boolean;
  ok?: boolean;
  target?: string;
}

function exitEventsFor(events: readonly ExitEvent[], user: string, since: number): ExitEvent[] {
  return events.filter((e) => e.user === user && typeof e.at === 'string' && Date.parse(e.at) >= since);
}

export async function runChain(ctx: Ctx): Promise<ExitCode> {
  const { out, now, sleep } = ctx.deps;
  const waitMs = (ctx.args.numbers.wait ?? 2) * 1000;
  const { dir, state } = openRun(ctx);
  const servers = await requireServers(ctx, state);
  const creds = loadCredentials(dir);
  if (!creds) throw refused('前置条件不满足：缺少合成测试凭据，请先运行 test-servers');
  const session = await openSession(ctx, dir, state, { needTestProfile: true });
  const ops = new TestOps(ctx, dir, session, state);
  const keys = await allowRefreshFor(session, ops.state, [NODE_RESOURCE_FILE]);
  const key = keys[NODE_RESOURCE_FILE];
  if (!key) throw refused('前置条件不满足：Surge 中找不到指向测试节点资源的外部资源');
  const ports: TestPorts = { echo: servers.echoPort, exit: servers.exitPort, front: servers.frontPort, deadFront: servers.deadFrontPort };
  const proxy = proxyOf(ctx);
  const snap = await takeSnapshot(ctx, session, dir, 'chain-before');
  printSnapshot(out, snap);
  const ok = await confirmWrites(
    ctx,
    '前置链路测试',
    [`测试节点资源加入 ${TEST_NODES.dead}（前置端口无服务）与 ${TEST_NODES.missing}（前置名不存在）并定向刷新`, `SFE-ROUTE 依次选择 ${TEST_NODES.a}、${TEST_NODES.dead}、${TEST_NODES.missing}，各发一次测试请求`, '恢复测试节点资源与原选择'],
    ['测试节点资源恢复为只含 A、B 并刷新；SFE-ROUTE 选择恢复', '本命令不添加临时规则，不改变当前配置'],
  );
  if (!ok) throw refused('已取消：没有写入任何东西');

  const t0 = now().getTime();
  let a = { ok: false, via: null as string | null, throughFront: null as boolean | null };
  type Probe = { member: boolean; ok: boolean | null; reachedExit: number; bypassed: number; directRecords: number | null };
  let dead: Probe = { member: false, ok: null, reachedExit: 0, bypassed: 0, directRecords: null };
  let missing: Probe = { member: false, ok: null, reachedExit: 0, bypassed: 0, directRecords: null };
  let frontConnects = 0;
  try {
    await ops.writeTestFile(NODE_RESOURCE_FILE, testNodeResource(['a', 'b', 'dead', 'missing'], ports, creds.password, 5));
    const r = await ops.refresh(key, 'chain-nodes');
    if (!r.ok) throw refused(`前置链路测试失败：刷新测试资源失败（${r.code}）`);
    await sleep(1000);
    const members = (await tryRead(() => session.adapter.getGroupMembers(ROUTE_GROUP_NAME))) ?? [];

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
  } finally {
    try {
      await ops.writeTestFile(NODE_RESOURCE_FILE, testNodeResource(['a', 'b'], ports, creds.password, 6));
      await ops.refresh(key, 'chain-restore');
      const restoreTo = snap.routeSelection ?? 'REJECT';
      await ops.select(restoreTo).catch(() => undefined);
    } catch {
      out.warn('恢复测试资源或选择失败：请按回退方式处理');
    }
    saveState(dir, ops.state);
  }

  const context = await measureContext(ctx, session, ops.state);
  const result = writeResult(dir, {
    key: 'external_node_underlying_proxy',
    command: 'chain',
    at: now().toISOString(),
    checks: [
      check('经前置到达出口（正面链路证据）', a.ok && a.via === TEST_USERS.a && a.throughFront === true && frontConnects > 0, `经过 ${a.via ?? '无'}，经前置 ${a.throughFront === null ? '未知' : a.throughFront ? '是' : '否'}，前置 CONNECT ${frontConnects} 次`),
      check(
        '前置不可达时连接失败而非直连',
        !dead.member ? null : dead.ok === false && dead.reachedExit === 0 && dead.directRecords !== null && dead.directRecords === 0 ? true : dead.ok === false && dead.reachedExit === 0 && dead.directRecords === null ? null : false,
        !dead.member ? '坏前置节点不在组成员中，无法测试' : `请求${dead.ok ? '成功' : '失败'}，到达出口 ${dead.reachedExit} 次（绕过前置 ${dead.bypassed}），Surge 记录中 DIRECT ${dead.directRecords ?? '读不到'} 条`,
      ),
      check(
        '前置名缺失时节点被跳过或失败而非直连',
        !missing.member ? true : missing.ok === false && missing.reachedExit === 0 && missing.directRecords === 0 ? true : missing.ok === false && missing.reachedExit === 0 && missing.directRecords === null ? null : false,
        !missing.member ? '节点被跳过（不在组成员中）' : `请求${missing.ok ? '成功' : '失败'}，到达出口 ${missing.reachedExit} 次（绕过前置 ${missing.bypassed}），Surge 记录中 DIRECT ${missing.directRecords ?? '读不到'} 条`,
      ),
    ],
    summary: [`通过条件：${CAPABILITY_CRITERIA.external_node_underlying_proxy}`, `测试用时 ${Math.round((now().getTime() - t0) / 1000)} 秒`],
    context,
  });
  out.heading(`前置链路结论：${verdictLabel(result.verdict)}`);
  printResult(out, result);
  return 0;
}
