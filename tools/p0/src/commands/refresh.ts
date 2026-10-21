// refresh：在测试配置上测量
//  A. 自动重载与原子替换：原子替换被引用的 canary 规则集（不刷新），等待后检查 Surge 是否已重新读取；
//  B. 固定配置日常不切换：SFE-ROUTE 在 A/B 之间切换，读回选择、经过的节点、配置名与重载信号；
//  C. 定向刷新与重新读取：资源加入节点 C → 按唯一 key 刷新 → 读回成员/选择/详情/错误/更新时间，
//     其他资源不变；选择 C 实际经过 p0-c；
//  D. 选择失效回落：选中 C 后从资源移除并刷新，选择必须回落到首成员 REJECT；
//  E. 恢复资源与原选择。
// 全程运行“其他应用”流量并检查 Chrome 测试页上报。工具从不重载配置或更新全部资源。

import { CAPABILITY_CRITERIA, NODE_RESOURCE_FILE, ROUTE_GROUP_NAME } from '@sfe/contract';
import { compareSignals } from '../analysis/reload.js';
import type { SurgeExternalResource } from '../deps.js';
import { refused, type ExitCode } from '../errors.js';
import { check, writeResult, type CheckItem } from '../results.js';
import { saveState } from '../state.js';
import { CANARY_FILE, TEST_NODES, TEST_USERS, testNodeResource, type TestPorts } from '../test-profile.js';
import { startOtherAppTraffic, trafficImpact } from '../traffic.js';
import { resourcesForPath } from '../surge-access.js';
import { allowRefreshFor, confirmWrites, loadCredentials, measureContext, openRun, openSession, printResult, printSnapshot, proxyOf, requireServers, takeSnapshot, tryRead, type Ctx } from './common.js';
import { TestOps, chromeImpact, requestViaRoute } from './test-ops.js';

function sameList(a: readonly string[] | null, b: readonly string[]): boolean {
  return a !== null && a.length === b.length && a.every((x, i) => x === b[i]);
}

function lastUpdated(resources: readonly SurgeExternalResource[] | null, key: string): number | null {
  const r = resources?.find((x) => x.key === key);
  return r?.lastUpdatedAt ? r.lastUpdatedAt.getTime() : null;
}

export async function runRefresh(ctx: Ctx): Promise<ExitCode> {
  const { out, now, sleep } = ctx.deps;
  const declared = ctx.args.strings['auto-reload'] as 'on' | 'off' | undefined;
  if (!declared) throw refused('参数检查失败：请用 --auto-reload on|off 声明 Surge 设置中当前的自动重载开关（工具不修改它）');
  const waitMs = (ctx.args.numbers.wait ?? 8) * 1000;
  const { dir, state } = openRun(ctx);
  const servers = await requireServers(ctx, state);
  const creds = loadCredentials(dir);
  if (!creds) throw refused('前置条件不满足：缺少合成测试凭据，请先运行 test-servers');
  const session = await openSession(ctx, dir, state, { needTestProfile: true });
  const readSetting = await tryRead(() => session.adapter.getAutoReloadSetting());
  if (readSetting !== null && (readSetting ? 'on' : 'off') !== declared) throw refused('前置条件不满足：声明的自动重载设置与 Surge 读回不一致');
  for (const p of ['listExternalResources', 'updateExternalResource', 'getGroupMembers', 'getGroupSelection', 'selectGroupPolicy'] as const) {
    if (session.mechanism[p] === 'unavailable') throw refused(`前置条件不满足：原语 ${p} 没有可用实现`);
  }
  const ops = new TestOps(ctx, dir, session, state);
  const keys = await allowRefreshFor(session, ops.state, [NODE_RESOURCE_FILE, CANARY_FILE]);
  if (!keys[NODE_RESOURCE_FILE]) throw refused('前置条件不满足：Surge 中找不到指向测试节点资源的外部资源（请确认已切换到测试配置）');
  const ports: TestPorts = { echo: servers.echoPort, exit: servers.exitPort, front: servers.frontPort, deadFront: servers.deadFrontPort };
  const proxy = proxyOf(ctx);
  const nodeKey = keys[NODE_RESOURCE_FILE];

  const snap = await takeSnapshot(ctx, session, dir, 'refresh-before');
  printSnapshot(out, snap);
  const originalSelection = snap.routeSelection;
  const ok = await confirmWrites(
    ctx,
    '定向刷新与自动重载测试',
    [
      `原子替换测试 canary 规则集 ${CANARY_FILE}（不刷新），等待 ${waitMs / 1000} 秒`,
      `SFE-ROUTE 依次选择 ${TEST_NODES.a}、${TEST_NODES.b}、${TEST_NODES.a}`,
      `测试节点资源加入 ${TEST_NODES.c} 并按 key 定向刷新；选择 ${TEST_NODES.c} 后再选回 ${TEST_NODES.a}`,
      ctx.args.booleans['skip-removal-fallback'] ? '（跳过移除回落测试）' : `选择 ${TEST_NODES.c} 后从资源移除并刷新，检查回落到 REJECT`,
      '恢复测试节点资源（A、B）并刷新，恢复原选择',
    ],
    [
      `测试节点资源恢复为只含 ${TEST_NODES.a}、${TEST_NODES.b}：重新运行本命令最后一步，或切回原配置后删除测试文件`,
      `SFE-ROUTE 选择恢复为 ${originalSelection ?? 'REJECT'}（只在测试配置中存在）`,
      '本命令不添加临时规则，不改变接管、出站模式或当前配置',
    ],
  );
  if (!ok) throw refused('已取消：没有写入任何东西');

  const traffic = startOtherAppTraffic({ proxy, echoPort: servers.echoPort, intervalMs: 1000, label: 'refresh' });
  const t0 = now().getTime();
  const checks: Record<string, CheckItem[]> = { auto: [], fixed: [], targeted: [], reread: [] };
  const notes: string[] = [];
  try {
    // A. 原子替换被引用文件（不刷新）
    const canaryIndex = Math.floor(now().getTime() / 1000) % 1_000_000;
    const sigBefore = await ops.signals(proxy, servers.echoPort, null);
    await ops.armCanary(canaryIndex);
    await sleep(waitMs);
    const sigA = await ops.signals(proxy, servers.echoPort, canaryIndex);
    const reloadOnReplace = sigA.canaryLoaded;
    const cmpA = compareSignals(sigBefore, sigA);
    const detectorUsable = reloadOnReplace === false;
    checks.auto!.push(check('原子替换被引用文件后的行为已测得', reloadOnReplace !== null, reloadOnReplace === null ? 'canary 请求未返回可判断的结果' : reloadOnReplace ? '触发了重新读取' : '未触发重新读取'));
    notes.push(`自动重载设置（声明）=${declared === 'on' ? '开' : '关'}：原子替换被引用的规则集后 Surge ${reloadOnReplace === null ? '结果未知' : reloadOnReplace ? '重新读取了该文件（整体或文件监视）' : '没有重新读取'}${cmpA.reasons.length ? `；其他信号：${cmpA.reasons.join('、')}` : ''}`);
    if (!detectorUsable) notes.push('canary 不能作为后续重载检测（原子替换本身会触发读取或结果未知），后续只用连接重置、启动时间与临时规则判断');

    // B. 选择切换
    const tB = now().getTime();
    const sigB0 = await ops.signals(proxy, servers.echoPort, detectorUsable ? canaryIndex : null);
    const selA1 = await ops.select(TEST_NODES.a);
    const viaA1 = await requestViaRoute(proxy, servers.echoPort, 'refresh-a1');
    const selB = await ops.select(TEST_NODES.b);
    const viaB = await requestViaRoute(proxy, servers.echoPort, 'refresh-b');
    const selA2 = await ops.select(TEST_NODES.a);
    const viaA2 = await requestViaRoute(proxy, servers.echoPort, 'refresh-a2');
    const sigB1 = await ops.signals(proxy, servers.echoPort, detectorUsable ? canaryIndex : null);
    const cmpB = compareSignals(sigB0, sigB1);
    const impB = trafficImpact(traffic.samples, tB, now().getTime());
    const chromeB = chromeImpact(dir, tB, now().getTime());
    checks.fixed!.push(
      check('选择读回正确', selA1 === TEST_NODES.a && selB === TEST_NODES.b && selA2 === TEST_NODES.a),
      check('请求实际经过所选节点', viaA1.via === TEST_USERS.a && viaB.via === TEST_USERS.b && viaA2.via === TEST_USERS.a, `经过 ${viaA1.via ?? '无'} → ${viaB.via ?? '无'} → ${viaA2.via ?? '无'}`),
      check('工作配置身份不变', sigB0.profileName !== null && sigB0.profileName === sigB1.profileName ? true : sigB0.profileName === null ? null : false),
      check('没有发生配置重载', cmpB.reloaded === null ? null : !cmpB.reloaded, cmpB.reasons.join('、')),
      check('其他应用长连接与新请求不受影响', impB.streamResets === 0 && impB.wsResets === 0 && impB.shortFailures === 0, `流重置 ${impB.streamResets}，WebSocket 重置 ${impB.wsResets}，短请求失败 ${impB.shortFailures}/${impB.shortTotal}`),
      check('Chrome 长连接与新请求不受影响', chromeB === null ? null : chromeB.failures === 0 && chromeB.wsCloses === 0, chromeB === null ? 'Chrome 测试页没有上报（请保持 Chrome 轮询页打开）' : `Chrome 失败 ${chromeB.failures}，WebSocket 断开 ${chromeB.wsCloses}`),
    );

    // C. 定向刷新
    const tC = now().getTime();
    const resBefore = await tryRead(() => session.adapter.listExternalResources());
    const membersBefore = await tryRead(() => session.adapter.getGroupMembers(ROUTE_GROUP_NAME));
    const sigC0 = await ops.signals(proxy, servers.echoPort, detectorUsable ? canaryIndex : null);
    await ops.writeTestFile(NODE_RESOURCE_FILE, testNodeResource(['a', 'b', 'c'], ports, creds.password, 2));
    await sleep(waitMs);
    const sigC1 = await ops.signals(proxy, servers.echoPort, detectorUsable ? canaryIndex : null);
    const cmpWrite = compareSignals(sigC0, sigC1);
    const membersAfterWrite = await tryRead(() => session.adapter.getGroupMembers(ROUTE_GROUP_NAME));
    const refreshed = await ops.refresh(nodeKey, 'add-node-c');
    await sleep(1000);
    const resAfter = await tryRead(() => session.adapter.listExternalResources());
    const members = await tryRead(() => session.adapter.getGroupMembers(ROUTE_GROUP_NAME));
    const selection = await tryRead(() => session.adapter.getGroupSelection(ROUTE_GROUP_NAME));
    const detail = await tryRead(() => session.adapter.getPolicyDetail(TEST_NODES.c));
    const sigC2 = await ops.signals(proxy, servers.echoPort, detectorUsable ? canaryIndex : null);
    const cmpRefresh = compareSignals(sigC1, sigC2);
    const ourBefore = resBefore ? resourcesForPath(resBefore, `${ops.state.testDirectory}/${NODE_RESOURCE_FILE}`, ops.state.testDirectory!) : [];
    const ourAfter = resAfter ? resourcesForPath(resAfter, `${ops.state.testDirectory}/${NODE_RESOURCE_FILE}`, ops.state.testDirectory!) : [];
    const before = lastUpdated(resBefore, nodeKey);
    const after = lastUpdated(resAfter, nodeKey);
    const othersChanged = (resBefore ?? []).filter((r) => r.key !== nodeKey && lastUpdated(resAfter, r.key) !== (r.lastUpdatedAt?.getTime() ?? null));
    const expectedMembers = ['REJECT', TEST_NODES.a, TEST_NODES.b, TEST_NODES.c];
    checks.targeted!.push(
      check('恰好一个 key 指向测试节点资源（刷新前后相同）', ourBefore.length === 1 && ourAfter.length === 1 && ourAfter[0]!.key === nodeKey),
      check('按 key 定向刷新成功', refreshed.ok, refreshed.ok ? `${refreshed.ms} ms` : `错误 ${refreshed.code}`),
      check('资源没有错误', ourAfter.length === 1 ? ourAfter[0]!.error === null : null),
      check('资源更新时间前进', after === null ? null : before === null || after > before, after === null ? '6.5 没有提供更新时间：入口 ruleset 策略将无法确认刷新' : ''),
      check('组成员与清单完全相等', sameList(members, expectedMembers), `读回 ${members?.join('、') ?? '读不到'}`),
      check('选择保持不变', selection === TEST_NODES.a, `读回 ${selection ?? '读不到'}`),
      check('其他外部资源未被更新', resBefore === null || resAfter === null ? null : othersChanged.length === 0, othersChanged.length ? `${othersChanged.length} 个资源的更新时间变化` : ''),
      check('写入文件本身未改变已加载成员', membersAfterWrite === null ? null : sameList(membersAfterWrite, membersBefore ?? []), cmpWrite.reasons.join('、')),
      check('刷新没有触发配置重载', cmpRefresh.reloaded === null ? null : !cmpRefresh.reloaded, cmpRefresh.reasons.join('、')),
      check('新节点详情可核对（地址、端口、前置）', detail === null ? null : detail.server === '127.0.0.1' && detail.port === servers.exitPort && detail.underlyingProxy === 'P0-Front', detail === null ? 'getPolicyDetail 不可用：读回级别为 partial' : ''),
    );
    const selC = await ops.select(TEST_NODES.c);
    const viaC = await requestViaRoute(proxy, servers.echoPort, 'refresh-c');
    await ops.select(TEST_NODES.a);
    checks.reread!.push(
      check('新增成员可选且实际生效', selC === TEST_NODES.c && viaC.via === TEST_USERS.c, `经过 ${viaC.via ?? '无'}`),
      check('旧成员与选择保留', sameList(members, expectedMembers) && selection === TEST_NODES.a),
    );
    const impC = trafficImpact(traffic.samples, tC, now().getTime());
    checks.targeted!.push(check('其他应用连接不受影响', impC.streamResets === 0 && impC.wsResets === 0 && impC.shortFailures === 0, `流重置 ${impC.streamResets}，WebSocket 重置 ${impC.wsResets}，短请求失败 ${impC.shortFailures}/${impC.shortTotal}`));

    // D. 移除回落
    if (!ctx.args.booleans['skip-removal-fallback']) {
      await ops.select(TEST_NODES.c);
      await ops.writeTestFile(NODE_RESOURCE_FILE, testNodeResource(['a', 'b'], ports, creds.password, 3));
      const r = await ops.refresh(nodeKey, 'remove-node-c');
      await sleep(1000);
      const m = await tryRead(() => session.adapter.getGroupMembers(ROUTE_GROUP_NAME));
      const sel = await tryRead(() => session.adapter.getGroupSelection(ROUTE_GROUP_NAME));
      checks.reread!.push(
        check('移除后成员与清单相等', r.ok && sameList(m, ['REJECT', TEST_NODES.a, TEST_NODES.b]), `读回 ${m?.join('、') ?? '读不到'}`),
        check('选中节点被移除后回落到 REJECT（不落到其他节点）', sel === 'REJECT', `读回 ${sel ?? '读不到'}`),
      );
    } else {
      checks.reread!.push(check('选中节点被移除后回落到 REJECT（不落到其他节点）', null, '已跳过'));
    }
  } finally {
    // E. 恢复（失败也执行）
    try {
      await ops.writeTestFile(NODE_RESOURCE_FILE, testNodeResource(['a', 'b'], ports, creds.password, 4));
      await ops.refresh(nodeKey, 'restore');
      const members = await tryRead(() => session.adapter.getGroupMembers(ROUTE_GROUP_NAME));
      const restoreTo = originalSelection && members?.includes(originalSelection) ? originalSelection : null;
      if (restoreTo && restoreTo !== 'REJECT') await ops.select(restoreTo);
      else if (restoreTo === 'REJECT') await ops.select('REJECT').catch(() => undefined);
    } catch {
      out.warn('恢复测试节点资源或选择失败：请按上面的回退方式手动处理');
    }
    await traffic.stop();
  }
  saveState(dir, ops.state);
  dir.writeJson(`refresh/traffic-${t0}.json`, traffic.samples);

  const context = await measureContext(ctx, session, ops.state);
  const at = now().toISOString();
  const common = [`测量于测试配置（${declared === 'on' ? '自动重载开' : '自动重载关'}）`, ...notes];
  const results = [
    writeResult(dir, { key: 'auto_reload_atomic_replace', command: 'refresh', at, checks: checks.auto!, summary: [`通过条件：${CAPABILITY_CRITERIA.auto_reload_atomic_replace}`, ...common], context, declaredAutoReload: declared }),
    writeResult(dir, { key: 'fixed_profile_no_switch', command: 'refresh', at, checks: checks.fixed!, summary: [`通过条件：${CAPABILITY_CRITERIA.fixed_profile_no_switch}`, ...common], context, declaredAutoReload: declared }),
    writeResult(dir, { key: 'targeted_resource_refresh', command: 'refresh', at, checks: checks.targeted!, summary: [`通过条件：${CAPABILITY_CRITERIA.targeted_resource_refresh}`, ...common], context, declaredAutoReload: declared }),
    writeResult(dir, { key: 'policy_path_reread', command: 'refresh', at, checks: checks.reread!, summary: [`通过条件：${CAPABILITY_CRITERIA.policy_path_reread}`, ...common], context, declaredAutoReload: declared }),
  ];
  out.heading('刷新测试结果');
  for (const n of notes) out.line(n);
  for (const r of results) printResult(out, r);
  out.line('请在 Surge 自动重载设置为另一个值时再运行一次（--auto-reload 相应改变），两次结论都要记录。');
  return 0;
}
