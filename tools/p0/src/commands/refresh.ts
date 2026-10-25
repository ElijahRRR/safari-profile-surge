// refresh：在测试配置上测量 Surge Mac 6.10 对本地文件的重新读取。外部资源更新不是刷新机制：HTTP API 文档（Mac 6.10.0+）
// “Download remote external resources immediately. … Local resources are skipped.”；规则集文档“External rule sets are
// downloaded and cached. Local files are watched and reloaded automatically when they change.”；本地 policy-path 是否被
// 监视没有写入文档（TODO(P0)：本命令测量它）。
//  A. 自动重载与原子替换：先布置配置 canary（原子替换测试配置中的一行，记录主配置被替换后是否触发重载），再原子替换被
//     引用的规则集 canary（不调用 update），用 rule match 有界轮询测量文件监视的重新读取延迟，并检查没有发生整份配置
//     重载（配置 canary）、引擎或 Surge 重启（引擎运行时长、进程启动时间、临时规则）、其他资源与其他应用连接不受影响；
//     最后对规则集 canary 的 key 调用一次 update，只记录 Surge 报告的结果（本地资源应被跳过）；
//  B. 固定配置日常不切换：SFE-ROUTE 在 A/B 之间切换，读回选择、经过的节点、配置名与重载/重启信号；
//  C. 节点资源（本地 policy-path）：加入节点 C → 原子替换 → 不调用 update，有界轮询组成员直到与清单相等（记录延迟）→
//     读回成员/选择/详情/错误，其他资源不变，没有重载或重启；选择 C 实际经过 p0-c。时限内没有重新读取时另调用一次
//     update，只记录结果与成员是否随之变化（与文档不符时写明），从不算通过；
//  D. 选择失效回落：选中 C 后从资源移除，等待重新读取，选择必须回落到首成员 REJECT；
//  E. 恢复资源与原选择（等待重新读取；从不重载）。
// 全程运行“其他应用”流量并检查 Chrome 测试页上报。工具从不重载配置、从不更新全部资源。

import { CAPABILITY_CRITERIA, NODE_RESOURCE_FILE, ROUTE_GROUP_NAME } from '@sfe/contract';
import { compareSignals, type ReloadSignals, type SignalComparison } from '../analysis/reload.js';
import type { SurgeExternalResource } from '../deps.js';
import { refused, type ExitCode } from '../errors.js';
import { check, writeResult, type CheckItem } from '../results.js';
import { saveState } from '../state.js';
import { CANARY_FILE, TEST_NODES, TEST_USERS, testNodeResource, type TestPorts } from '../test-profile.js';
import { describeImpact, startOtherAppTraffic, trafficImpact, trafficUnaffected } from '../traffic.js';
import { resourcesForPath } from '../surge-access.js';
import { allowRefreshFor, confirmWrites, loadCredentials, measureContext, openRun, openSession, printResult, printSnapshot, proxyOf, requireServers, takeSnapshot, tryRead, type Ctx } from './common.js';
import { TestOps, chromeImpact, nextCanaryIndex, probeCanary, probeProfileCanary, requestViaRoute, type UpdateRecord, type WaitResult } from './test-ops.js';

function sameList(a: readonly string[] | null, b: readonly string[]): boolean {
  return a !== null && a.length === b.length && a.every((x, i) => x === b[i]);
}

/** 资源健康状态（只写分类，不写 Surge 返回的错误原文）。 */
export function resourceHealth(found: readonly SurgeExternalResource[]): string {
  if (found.length !== 1) return found.length === 0 ? '读不到' : '多个 key';
  const r = found[0]!;
  if (r.updating === true) return '正在更新';
  const e = r.error;
  return e === null ? '正常' : e === 'not_ready' ? '未就绪' : '有错误';
}

/** 除 except 之外，更新时间或错误状态发生变化（或消失）的外部资源 key。 */
export function changedResources(before: readonly SurgeExternalResource[], after: readonly SurgeExternalResource[], except: readonly string[]): string[] {
  const now = new Map(after.map((r) => [r.key, r] as const));
  return before
    .filter((r) => !except.includes(r.key))
    .filter((r) => {
      const a = now.get(r.key);
      return !a || (a.lastUpdatedAt?.getTime() ?? null) !== (r.lastUpdatedAt?.getTime() ?? null) || (a.error === null) !== (r.error === null);
    })
    .map((r) => r.key);
}

/** update 对本地资源的结果说明（只写分类）。 */
export function describeUpdate(u: UpdateRecord | null): string {
  if (u === null) return '未调用';
  if (!u.ok || u.result === null) return `失败（${u.code ?? 'ERROR'}）`;
  return u.result.outcome === 'skipped'
    ? '报告跳过（与文档“Local resources are skipped.”一致；不算刷新）'
    : '报告已下载（与文档“Local resources are skipped.”不符，记录交给开发者核对；仍不算刷新）';
}

/** 重载/重启信号中“重启”一类的原因（配置 canary 之外的信号）。 */
function restartReasons(c: SignalComparison): string[] {
  return c.reasons.filter((r) => !r.startsWith('配置 canary'));
}

/** 没有引擎重启或 Surge 重启：有任一重启信号为 false；运行时长读不到且没有其他信号为 null。 */
function noRestart(c: SignalComparison): boolean | null {
  if (restartReasons(c).length > 0) return false;
  return c.engineRestarted === null ? null : true;
}

function uptimeNote(before: ReloadSignals, after: ReloadSignals): string {
  const u = (s: ReloadSignals): string => (s.engineUptimeSeconds === null ? '读不到' : `${s.engineUptimeSeconds} 秒`);
  const reasons = restartReasons(compareSignals(before, after));
  return `引擎运行时长 ${u(before)} → ${u(after)}${reasons.length > 0 ? `；${reasons.join('、')}` : ''}`;
}

/** 没有整份配置重载：配置 canary 可用时它必须仍未被读取。 */
function noProfileReload(detectorUsable: boolean, after: ReloadSignals): boolean | null {
  if (!detectorUsable || after.profileCanaryLoaded === null) return null;
  return !after.profileCanaryLoaded;
}

const DETECTOR_UNUSABLE_NOTE = '配置 canary 不可用（主配置被替换后已触发重载或结果未知）：无法区分文件监视与整份配置重载';

export async function runRefresh(ctx: Ctx): Promise<ExitCode> {
  const { out, now } = ctx.deps;
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
  for (const p of ['listExternalResources', 'getGroupMembers', 'getGroupSelection', 'selectGroupPolicy'] as const) {
    if (session.mechanism[p] === 'unavailable') throw refused(`前置条件不满足：原语 ${p} 没有可用实现`);
  }
  const ops = new TestOps(ctx, dir, session, state);
  const keys = await allowRefreshFor(session, ops.state, [NODE_RESOURCE_FILE, CANARY_FILE]);
  if (!keys[NODE_RESOURCE_FILE]) throw refused('前置条件不满足：Surge 中找不到指向测试节点资源的外部资源（请确认已切换到测试配置）');
  const ports: TestPorts = { echo: servers.echoPort, exit: servers.exitPort, front: servers.frontPort, deadFront: servers.deadFrontPort };
  const proxy = proxyOf(ctx);
  const nodeKey = keys[NODE_RESOURCE_FILE];
  const canaryKey = keys[CANARY_FILE] ?? null;
  const nodePath = `${ops.state.testDirectory}/${NODE_RESOURCE_FILE}`;

  const snap = await takeSnapshot(ctx, session, dir, 'refresh-before');
  printSnapshot(out, snap);
  const originalSelection = snap.routeSelection;
  const ok = await confirmWrites(
    ctx,
    '本地文件重新读取与自动重载测试',
    [
      `原子替换测试配置中的配置 canary 行（只用于检测配置重载；自动重载开时这一步本身可能触发 Surge 重载测试配置，6.9.0 起可能升级为完整引擎重启并关闭全部连接），等待 ${waitMs / 1000} 秒`,
      `原子替换测试 canary 规则集 ${CANARY_FILE}（不调用 external-resource update），用 rule match 轮询至多 ${waitMs / 1000} 秒，测量 Surge 文件监视的重新读取；之后对它的 key 调用一次 external-resource update，只记录结果（本地资源应被跳过）`,
      `SFE-ROUTE 依次选择 ${TEST_NODES.a}、${TEST_NODES.b}、${TEST_NODES.a}`,
      `测试节点资源加入 ${TEST_NODES.c}（原子替换，不调用 update），等待 Surge 自动重新读取（时限内没有读取时调用一次 update，只记录结果）；选择 ${TEST_NODES.c} 后再选回 ${TEST_NODES.a}`,
      ctx.args.booleans['skip-removal-fallback'] ? '（跳过移除回落测试）' : `选择 ${TEST_NODES.c} 后从资源移除并等待重新读取，检查回落到 REJECT`,
      '恢复测试节点资源（A、B）并等待重新读取，恢复原选择',
    ],
    [
      `测试节点资源恢复为只含 ${TEST_NODES.a}、${TEST_NODES.b}：重新运行本命令最后一步，或切回原配置后删除测试文件`,
      `SFE-ROUTE 选择恢复为 ${originalSelection ?? 'REJECT'}（只在测试配置中存在）`,
      '配置 canary 行与 canary 规则集只影响测试主机；切回原配置后按 rollback 列出的文件删除',
      '本命令不添加临时规则，不重载配置，不改变接管、出站模式或当前配置',
    ],
  );
  if (!ok) throw refused('已取消：没有写入任何东西');

  const traffic = startOtherAppTraffic({ proxy, echoPort: servers.echoPort, intervalMs: 1000, label: 'refresh' });
  const t0 = now().getTime();
  const checks: Record<string, CheckItem[]> = { auto: [], fixed: [], targeted: [], reread: [] };
  const notes: string[] = [];
  let updateChangedMembers = false;
  let rereadWorks = false;
  try {
    // A1. 配置 canary：主配置被原子替换后是否触发重载（自动重载关时应不触发）。
    const profileIdx = nextCanaryIndex(now());
    await ops.armProfileCanary(profileIdx);
    await ctx.deps.sleep(waitMs);
    const profileOnArm = await probeProfileCanary(proxy, servers.echoPort, profileIdx);
    const detectorUsable = profileOnArm === false;
    const pc = detectorUsable ? profileIdx : null;
    notes.push(
      `自动重载设置（声明）=${declared === 'on' ? '开' : '关'}：原子替换主配置后 Surge ${profileOnArm === null ? '是否重载未知' : profileOnArm ? '重新读取了主配置（发生了配置重载）' : '没有重新读取主配置'}`,
    );
    if (!detectorUsable) notes.push(`${DETECTOR_UNUSABLE_NOTE}；后续只用引擎运行时长、进程启动时间、临时规则与连接影响判断`);

    // A2. 规则集 canary：原子替换后由文件监视重新读取（不调用 update），测量延迟与影响。
    const tA = now().getTime();
    const sigA0 = await ops.signals(proxy, servers.echoPort, pc);
    const resA0 = await tryRead(() => session.adapter.listExternalResources());
    const rsIdx = nextCanaryIndex(now(), profileIdx);
    const pre = await ops.ruleSetCanaryLoaded(proxy, servers.echoPort, rsIdx);
    await ops.writeRuleSetCanary(rsIdx);
    const watch = await ops.waitForRuleSetCanary(proxy, servers.echoPort, rsIdx, waitMs);
    const viaRequest = await probeCanary(proxy, servers.echoPort, rsIdx);
    const sigA1 = await ops.signals(proxy, servers.echoPort, pc);
    const cmpA = compareSignals(sigA0, sigA1);
    const resA1 = await tryRead(() => session.adapter.listExternalResources());
    const othersA = resA0 && resA1 ? changedResources(resA0, resA1, canaryKey ? [canaryKey] : []) : null;
    const impA = trafficImpact(traffic.samples, tA, now().getTime());
    const updA = canaryKey ? await ops.recordUpdate(canaryKey, 'ruleset-canary') : null;
    const reread = pre.loaded !== false ? null : !watch.ok ? false : viaRequest === null ? null : viaRequest;
    checks.auto!.push(
      check('原子替换主配置后的行为已测得', profileOnArm !== null, profileOnArm === null ? '配置 canary 请求未返回可判断的结果' : profileOnArm ? '触发了配置重载' : '没有触发配置重载'),
      check(
        '原子替换的规则集由文件监视重新读取（不调用 update）',
        reread,
        pre.loaded !== false
          ? '写入前无法确认新内容尚未生效'
          : watch.ok
            ? `${watch.ms} ms 后经${watch.via === 'rule_match' ? ' rule match ' : '实际请求'}读到新内容（轮询 ${watch.polls} 次）；实际请求${viaRequest === true ? '同样命中新内容' : viaRequest === false ? '仍按旧内容' : '无法判断'}`
            : `${waitMs / 1000} 秒内没有读到新内容（可用 --wait 加长等待后重测）`,
      ),
      check('规则集重新读取没有触发整份配置重载', noProfileReload(detectorUsable, sigA1), detectorUsable ? '' : DETECTOR_UNUSABLE_NOTE),
      check('没有引擎重启或 Surge 重启', noRestart(cmpA), uptimeNote(sigA0, sigA1)),
      check('其他外部资源未受影响', othersA === null ? null : othersA.length === 0, othersA && othersA.length > 0 ? `${othersA.length} 个资源的更新时间或错误状态变化` : ''),
      check('其他应用连接不受影响', trafficUnaffected(impA), describeImpact(impA)),
    );
    notes.push(`规则集 canary：${watch.ok ? `文件监视在 ${watch.ms} ms 内重新读取` : `${waitMs / 1000} 秒内没有重新读取`}；对它的 key 调用 external-resource update：${describeUpdate(updA)}`);

    // B. 选择切换
    const tB = now().getTime();
    const sigB0 = await ops.signals(proxy, servers.echoPort, pc);
    const selA1 = await ops.select(TEST_NODES.a);
    const viaA1 = await requestViaRoute(proxy, servers.echoPort, 'refresh-a1');
    const selB = await ops.select(TEST_NODES.b);
    const viaB = await requestViaRoute(proxy, servers.echoPort, 'refresh-b');
    const selA2 = await ops.select(TEST_NODES.a);
    const viaA2 = await requestViaRoute(proxy, servers.echoPort, 'refresh-a2');
    const sigB1 = await ops.signals(proxy, servers.echoPort, pc);
    const cmpB = compareSignals(sigB0, sigB1);
    const impB = trafficImpact(traffic.samples, tB, now().getTime());
    const chromeB = chromeImpact(dir, tB, now().getTime());
    checks.fixed!.push(
      check('选择读回正确', selA1 === TEST_NODES.a && selB === TEST_NODES.b && selA2 === TEST_NODES.a),
      check('请求实际经过所选节点', viaA1.via === TEST_USERS.a && viaB.via === TEST_USERS.b && viaA2.via === TEST_USERS.a, `经过 ${viaA1.via ?? '无'} → ${viaB.via ?? '无'} → ${viaA2.via ?? '无'}`),
      check('工作配置身份不变', sigB0.profileName !== null && sigB0.profileName === sigB1.profileName ? true : sigB0.profileName === null ? null : false),
      check('没有发生配置重载', noProfileReload(detectorUsable, sigB1), detectorUsable ? '' : DETECTOR_UNUSABLE_NOTE),
      check('没有引擎重启或 Surge 重启', noRestart(cmpB), uptimeNote(sigB0, sigB1)),
      check('其他应用长连接与新请求不受影响', trafficUnaffected(impB), describeImpact(impB)),
      check('Chrome 长连接与新请求不受影响', chromeB === null ? null : chromeB.failures === 0 && chromeB.wsCloses === 0, chromeB === null ? 'Chrome 测试页没有上报（请保持 Chrome 轮询页打开）' : `Chrome 失败 ${chromeB.failures}，WebSocket 断开 ${chromeB.wsCloses}`),
    );

    // C. 节点资源：原子替换，不调用 update，等待 Surge 自动重新读取。
    const tC = now().getTime();
    const resBefore = await tryRead(() => session.adapter.listExternalResources());
    const sigC0 = await ops.signals(proxy, servers.echoPort, pc);
    const expectedMembers = ['REJECT', TEST_NODES.a, TEST_NODES.b, TEST_NODES.c];
    await ops.writeTestFile(NODE_RESOURCE_FILE, testNodeResource(['a', 'b', 'c'], ports, creds.password, 2));
    const nodeWait = await ops.waitForMembers((m) => sameList(m, expectedMembers), waitMs);
    rereadWorks = nodeWait.ok;
    let updC: UpdateRecord | null = null;
    let afterUpdate: WaitResult<string[]> | null = null;
    if (!nodeWait.ok) {
      // 只记录：时限内没有自动重新读取时，update 对本地资源报告什么、成员是否随之变化（与文档不符时写明）。从不算通过。
      updC = await ops.recordUpdate(nodeKey, 'node-resource');
      afterUpdate = await ops.waitForMembers((m) => sameList(m, expectedMembers), Math.min(waitMs, 3000));
      updateChangedMembers = afterUpdate.ok;
    }
    const resRightAfter = await tryRead(() => session.adapter.listExternalResources());
    await ctx.deps.sleep(1000);
    const resAfter = await tryRead(() => session.adapter.listExternalResources());
    const members = nodeWait.ok ? nodeWait.value : null;
    const selection = await tryRead(() => session.adapter.getGroupSelection(ROUTE_GROUP_NAME));
    const detail = await tryRead(() => session.adapter.getPolicyDetail(TEST_NODES.c));
    const sigC1 = await ops.signals(proxy, servers.echoPort, pc);
    const cmpC = compareSignals(sigC0, sigC1);
    const ourBefore = resBefore ? resourcesForPath(resBefore, nodePath, ops.state.testDirectory!) : [];
    const ourAfter = resAfter ? resourcesForPath(resAfter, nodePath, ops.state.testDirectory!) : [];
    const ourRightAfter = resRightAfter ? resourcesForPath(resRightAfter, nodePath, ops.state.testDirectory!) : [];
    const othersChanged = resBefore && resAfter ? changedResources(resBefore, resAfter, [nodeKey]) : null;
    const local = ourAfter.length === 1 ? ourAfter[0]!.local : null;
    const rereadNote = nodeWait.ok
      ? `${nodeWait.ms} ms 后成员与清单相等（轮询 ${nodeWait.polls} 次）`
      : `${waitMs / 1000} 秒内成员仍为 ${nodeWait.value?.join('、') ?? '读不到'}；随后调用一次 update：${describeUpdate(updC)}，之后成员${afterUpdate?.ok ? '变为清单（与文档“Local resources are skipped.”不符，不作为刷新机制）' : '仍未变化'}`;
    checks.targeted!.push(
      check(
        '恰好一个 key 指向测试节点资源，且是来自配置的本地资源',
        ourBefore.length === 1 && ourAfter.length === 1 && ourAfter[0]!.key === nodeKey ? (ourAfter[0]!.fromModule !== null || local === false ? false : local === true ? true : null) : false,
        ourAfter.length === 1 ? `local=${String(local)}，来自${ourAfter[0]!.fromModule === null ? '配置' : '模块'}` : `找到 ${ourAfter.length} 个`,
      ),
      check('不调用 update，组成员与清单完全相等', nodeWait.ok, `${rereadNote}；读回 ${members?.join('、') ?? nodeWait.value?.join('、') ?? '读不到'}`),
      check('资源没有错误', ourAfter.length === 1 ? ourAfter[0]!.error === null && ourAfter[0]!.updating !== true : null, `写入前 ${resourceHealth(ourBefore)}，读回成员后 ${resourceHealth(ourRightAfter)}，1 秒后 ${resourceHealth(ourAfter)}`),
      check('选择保持不变', selection === TEST_NODES.a, `读回 ${selection ?? '读不到'}`),
      check('其他外部资源未受影响', othersChanged === null ? null : othersChanged.length === 0, othersChanged && othersChanged.length > 0 ? `${othersChanged.length} 个资源的更新时间或错误状态变化` : ''),
      check('没有发生整份配置重载', noProfileReload(detectorUsable, sigC1), detectorUsable ? '' : DETECTOR_UNUSABLE_NOTE),
      check('没有引擎重启或 Surge 重启', noRestart(cmpC), uptimeNote(sigC0, sigC1)),
      check(
        '新节点详情可核对（地址、端口、前置）',
        !nodeWait.ok ? null : detail === null ? null : detail.server === '127.0.0.1' && detail.port === servers.exitPort && detail.underlyingProxy === 'P0-Front',
        !nodeWait.ok ? '新节点没有被自动读取' : detail === null ? 'getPolicyDetail 不可用：读回级别为 partial' : '',
      ),
    );
    if (nodeWait.ok) {
      const selC = await ops.select(TEST_NODES.c);
      const viaC = await requestViaRoute(proxy, servers.echoPort, 'refresh-c');
      // 文件落盘不是发布成功；连续性测量必须看到新成员被读取且真实请求经过它。
      if (selC === TEST_NODES.c && viaC.ok && viaC.via === TEST_USERS.c) {
        ops.action('node_publication_verified', { file: NODE_RESOURCE_FILE });
      }
      await ops.select(TEST_NODES.a);
      checks.reread!.push(
        check('不调用 update，本地 policy-path 修改后在时限内被自动重新读取', true, rereadNote),
        check('新增成员可选且实际生效', selC === TEST_NODES.c && viaC.via === TEST_USERS.c, `经过 ${viaC.via ?? '无'}`),
        check('旧成员与选择保留', sameList(members, expectedMembers) && selection === TEST_NODES.a),
      );
    } else {
      checks.reread!.push(
        check('不调用 update，本地 policy-path 修改后在时限内被自动重新读取', false, rereadNote),
        check('新增成员可选且实际生效', null, '没有自动重新读取，未测'),
        check('旧成员与选择保留', null, '没有自动重新读取，未测'),
      );
    }
    const impC = trafficImpact(traffic.samples, tC, now().getTime());
    checks.targeted!.push(check('其他应用连接不受影响', trafficUnaffected(impC), describeImpact(impC)));
    notes.push(`节点资源（本地 policy-path）：${rereadNote}`);

    // D. 移除回落
    if (ctx.args.booleans['skip-removal-fallback']) {
      checks.reread!.push(check('选中节点被移除后回落到 REJECT（不落到其他节点）', null, '已跳过'));
    } else if (!nodeWait.ok) {
      checks.reread!.push(check('选中节点被移除后回落到 REJECT（不落到其他节点）', null, '没有自动重新读取，未测'));
    } else {
      await ops.select(TEST_NODES.c);
      await ops.writeTestFile(NODE_RESOURCE_FILE, testNodeResource(['a', 'b'], ports, creds.password, 3));
      const w = await ops.waitForMembers((m) => sameList(m, ['REJECT', TEST_NODES.a, TEST_NODES.b]), waitMs);
      const sel = await tryRead(() => session.adapter.getGroupSelection(ROUTE_GROUP_NAME));
      checks.reread!.push(
        check('移除后成员与清单相等', w.ok, `读回 ${w.value?.join('、') ?? '读不到'}${w.ok ? `（${w.ms} ms）` : ''}`),
        check('选中节点被移除后回落到 REJECT（不落到其他节点）', w.ok ? sel === 'REJECT' : null, `读回 ${sel ?? '读不到'}`),
      );
    }
  } finally {
    // E. 恢复（失败也执行）：写回只含 A、B 的资源并等待重新读取；从不重载。
    try {
      await ops.writeTestFile(NODE_RESOURCE_FILE, testNodeResource(['a', 'b'], ports, creds.password, 4));
      const restoreList = ['REJECT', TEST_NODES.a, TEST_NODES.b];
      let restored = await ops.waitForMembers((m) => sameList(m, restoreList), waitMs);
      // update 曾改变成员（与文档不符）时，已加载的成员只能同样恢复：只按这一个测试 key 再调用一次。
      if (!restored.ok && updateChangedMembers) {
        await ops.recordUpdate(nodeKey, 'restore');
        restored = await ops.waitForMembers((m) => sameList(m, restoreList), Math.min(waitMs, 3000));
      }
      if (!restored.ok && rereadWorks) out.warn(`恢复后 SFE-ROUTE 成员读回为 ${restored.value?.join('、') ?? '读不到'}：请按上面的回退方式处理`);
      const membersNow = restored.value;
      const restoreTo = originalSelection && membersNow?.includes(originalSelection) ? originalSelection : null;
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
  out.heading('本地文件重新读取测试结果');
  for (const n of notes) out.line(n);
  for (const r of results) printResult(out, r);
  out.line('请在 Surge 自动重载设置为另一个值时再运行一次（--auto-reload 相应改变），两次结论都要记录。');
  return 0;
}
