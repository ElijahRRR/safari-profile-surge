// refresh：在测试配置上测量 Surge Mac 6.10 的自动重载与本地规则集的重新读取。外部资源更新不是规则集的刷新机制：HTTP API
// 文档（Mac 6.10.0+）“Download remote external resources immediately. … Local resources are skipped.”；规则集文档“External
// rule sets are downloaded and cached. Local files are watched and reloaded automatically when they change.”。
//  A. 自动重载与原子替换：先布置配置 canary（原子替换测试配置中的一行，记录主配置被替换后是否触发重载），再原子替换被
//     引用的规则集 canary（不调用 update），用 rule match 有界轮询测量文件监视的重新读取延迟，并检查没有发生整份配置
//     重载（配置 canary）、引擎或 Surge 重启（引擎运行时长、进程启动时间、临时规则）、其他资源与其他应用连接不受影响；
//     最后对规则集 canary 的 key 调用一次 update，只记录 Surge 报告的结果（本地资源应被跳过）；
//  B. 固定配置日常不切换：SFE-ROUTE 在 A/B 之间切换，读回选择、经过的节点、配置名与重载/重启信号。
// 测试节点的发布（D10，本机回环资源）由 loopback 系列命令测量；本地 policy-path 的旧对照实验（2026-10-24 实测自动重载关闭时
// 不被重新读取）已移除，证据见 docs/verification。全程运行“其他应用”流量并检查 Chrome 测试页上报。工具从不重载配置、从不
// 更新全部资源。

import { CAPABILITY_CRITERIA, ROUTE_GROUP_NAME } from '@sfe/contract';
import { compareSignals, type ReloadSignals, type SignalComparison } from '../analysis/reload.js';
import type { SurgeExternalResource } from '../deps.js';
import { refused, type ExitCode } from '../errors.js';
import { check, writeResult, type CheckItem } from '../results.js';
import { saveState } from '../state.js';
import { CANARY_FILE, TEST_NODES, TEST_USERS } from '../test-profile.js';
import { describeImpact, startOtherAppTraffic, trafficImpact, trafficUnaffected } from '../traffic.js';
import { allowRefreshFor, confirmWrites, measureContext, openRun, openSession, printResult, printSnapshot, proxyOf, requireServers, takeSnapshot, tryRead, type Ctx } from './common.js';
import { TestOps, chromeImpact, nextCanaryIndex, probeCanary, probeProfileCanary, requestViaRoute, type UpdateRecord } from './test-ops.js';

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
export function restartReasons(c: SignalComparison): string[] {
  return c.reasons.filter((r) => !r.startsWith('配置 canary'));
}

/** 没有引擎重启或 Surge 重启：有任一重启信号为 false；运行时长读不到且没有其他信号为 null。 */
export function noRestart(c: SignalComparison): boolean | null {
  if (restartReasons(c).length > 0) return false;
  return c.engineRestarted === null ? null : true;
}

export function uptimeNote(before: ReloadSignals, after: ReloadSignals): string {
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
  const session = await openSession(ctx, dir, state, { needTestProfile: true });
  const readSetting = await tryRead(() => session.adapter.getAutoReloadSetting());
  if (readSetting !== null && (readSetting ? 'on' : 'off') !== declared) throw refused('前置条件不满足：声明的自动重载设置与 Surge 读回不一致');
  for (const p of ['listExternalResources', 'getGroupMembers', 'getGroupSelection', 'selectGroupPolicy'] as const) {
    if (session.mechanism[p] === 'unavailable') throw refused(`前置条件不满足：原语 ${p} 没有可用实现`);
  }
  const ops = new TestOps(ctx, dir, session, state);
  const keys = await allowRefreshFor(session, ops.state, [CANARY_FILE]);
  const proxy = proxyOf(ctx);
  const canaryKey = keys[CANARY_FILE] ?? null;

  const snap = await takeSnapshot(ctx, session, dir, 'refresh-before');
  printSnapshot(out, snap);
  const originalSelection = snap.routeSelection;
  const ok = await confirmWrites(
    ctx,
    '本地规则集重新读取与自动重载测试',
    [
      `原子替换测试配置中的配置 canary 行（只用于检测配置重载；自动重载开时这一步本身可能触发 Surge 重载测试配置，6.9.0 起可能升级为完整引擎重启并关闭全部连接），等待 ${waitMs / 1000} 秒`,
      `原子替换测试 canary 规则集 ${CANARY_FILE}（不调用 external-resource update），用 rule match 轮询至多 ${waitMs / 1000} 秒，测量 Surge 文件监视的重新读取；之后对它的 key 调用一次 external-resource update，只记录结果（本地资源应被跳过）`,
      `SFE-ROUTE 依次选择 ${TEST_NODES.a}、${TEST_NODES.b}、${TEST_NODES.a}，最后恢复原选择`,
    ],
    [
      `SFE-ROUTE 选择恢复为 ${originalSelection ?? 'REJECT'}（只在测试配置中存在）`,
      '配置 canary 行与 canary 规则集只影响测试主机；切回原配置后按 rollback 列出的文件删除',
      '本命令不写测试节点、不添加临时规则，不重载配置，不改变接管、出站模式或当前配置',
    ],
  );
  if (!ok) throw refused('已取消：没有写入任何东西');

  const traffic = startOtherAppTraffic({ proxy, echoPort: servers.echoPort, intervalMs: 1000, label: 'refresh' });
  const t0 = now().getTime();
  const checks: Record<string, CheckItem[]> = { auto: [], fixed: [] };
  const notes: string[] = [];
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
  } finally {
    // 恢复原选择（失败也执行）；从不重载
    try {
      const members = await tryRead(() => session.adapter.getGroupMembers(ROUTE_GROUP_NAME));
      const restoreTo = originalSelection && members?.includes(originalSelection) ? originalSelection : 'REJECT';
      await ops.select(restoreTo).catch(() => undefined);
    } catch {
      out.warn('恢复 SFE-ROUTE 选择失败：请按上面的回退方式手动处理');
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
  ];
  out.heading('本地规则集重新读取与自动重载测试结果');
  for (const n of notes) out.line(n);
  for (const r of results) printResult(out, r);
  out.line('请在 Surge 自动重载设置为另一个值时再运行一次（--auto-reload 相应改变），两次结论都要记录。');
  return 0;
}
